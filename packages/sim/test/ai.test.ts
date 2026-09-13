/**
 * Evidence for **M7's real AI** — `SMART_POLICY`.
 * See docs/INTERFACES.md, "M7 contracts — FROZEN (a real opponent, and self-play)".
 *
 * What is checked here, and why each item is the thing that matters rather than a
 * convenient thing to assert:
 *
 * 1. **Determinism.** Two runs of one seed produce the same hash, and — the M5 property that
 *    makes policy comparison valid at all — the **world's RNG trajectory is identical**
 *    whatever policy is plugged in. This AI draws no randomness at all, so an AI that "played
 *    better" while also moving `state.rng` would be an AI that changed the world, and no
 *    comparison on that seed would mean anything.
 * 2. **Totality.** An empty state, a state with no units, a state with no cities, a state with
 *    no gold and a **fully blocked board** each produce a legal (possibly empty) command list
 *    and never throw. A throw here would not be a bad decision but a broken run, and since M7d
 *    it would be a *visible* one: the runner carries a caught planner failure on the result
 *    (`SimulationResult.plannerFailures`) and a tournament containing one fails. What this
 *    section checks is stronger than "the failure is reported" — it is that there is none.
 * 3. **Legality — the keystone invariant, applied to the AI.** Every command the policy
 *    returns is folded through the real `applyCommand` over several seeds and many turns with
 *    **zero refusals**, and the count is non-vacuous (the same driver counts the commands).
 * 4. **It decisively beats doing nothing.** M7's core claim. Per seed, by stated metrics —
 *    cities founded, population, techs known, units — the AI is compared against
 *    `DO_NOTHING_POLICY` on the same world, and the actual numbers are printed by the test so
 *    a reader sees the evidence rather than a summary of it. An AI that returns commands and
 *    produces the same game as doing nothing is worse than no AI, because it looks like an
 *    opponent.
 * 5. **Its weights are the only home for its magnitudes, and they are sweepable**: the knob
 *    list is complete, a patch moves exactly the field it names, and moving one weight
 *    **changes the game** — which is what "Tunable" has to mean for the AI half of the
 *    standing requirement.
 * 6. **The walls measurement.** M7's second task is to re-run the walls sweep with a real AI
 *    and report whether `wallsBonusPct` now has an effect. That question is only answerable
 *    with counts: cities holding walls, battles, battles **into** cities and into walled
 *    ones. This suite produces those counts and reports them, and asserts only what is
 *    actually true of this AI — see the comment at the assertion for what it does *not* yet
 *    do, because a claim about a sweep that the measurement does not support is the one
 *    thing this section must not write down.
 * 7. **The engine's combat maths is not restated.** The AI's battle-odds accumulation is
 *    pinned against an exact `BigInt` rational model of the same race, so its "should I
 *    attack?" is a derivation from `combat.ts`' own per-round number rather than a second
 *    opinion about it.
 *
 * ## The tier split (M7b — the gate budget, re-drawn)
 *
 * Every claim above is still checked on every run; what changed is *which* run. M7b's bound
 * is on `time pnpm verify` (≤ 70 s wall), and this file was the whole gate: measured with
 * vitest's per-file reporter it cost **54.4 s of wall on its own**, against a 37 s floor for
 * `typecheck` + `lint` + `format:check` — one file cannot leave room for M8's browser suite.
 *
 * So the tests that play *whole games* moved behind `it.skipIf(!FULL_TIER)`, and each one's
 * comment records the milliseconds it was measured at. What the fast tier keeps is the part
 * that proves the AI *plays*: three command-tally/walk tests over 20-25 turns (~4 s total),
 * the totality suite, the weight-catalog suite, the pure-function and attack-odds checks, and
 * the fixtures — every one of them sub-100 ms or a single short game. `pnpm verify:full` runs
 * the moved tests; the fast run prints each of them by name as skipped.
 */

import {
  DEFAULT_SETTINGS,
  RATE_TOTAL,
  WALLS_BUILDING,
  advanceTurn,
  applyCommand,
  asBuildingId,
  asCityId,
  asPlayerId,
  asUnitId,
  asUnitTypeId,
  citiesOf,
  cityById,
  hitPointsLeftOf,
  neighbors8,
  newGame,
  tileIndex,
  unitById,
  unitDef,
  type City,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RngState,
  type Settings,
  type Unit,
  type UnitTypeId,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { FULL_TIER, canonicalize, createScenarioBuilder, fnv1a64 } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  DO_NOTHING_POLICY,
  SMART_POLICY,
  SMART_POLICY_NAME,
  SMART_WEIGHT_GROUPS,
  SMART_WEIGHTS,
  mergeSmartWeights,
  policyRngFor,
  runSimulation,
  smartPolicy,
  type Policy,
  type PolicyContext,
  type SimulationResult,
} from '@civts/sim';
// The failure channel is read from the AI's own module, one import away from the surface: the
// names are re-exported by `policies.ts`, `ai/index.ts` and now `index.ts` itself, and this
// suite keeps the direct path because it is the module under test. **Where the channel is read
// by something other than a test** is, since M7d, the package itself — `runner.ts` reads it into
// `SimulationResult.plannerFailures`, `batch.ts` hands it through and `tournament.ts` aggregates
// it into `TournamentResult.plannerFailures` and the verdict — and then
// `@civts/headless`'s `sim-cli.ts`, which renders the *report's* field to stderr and fails the
// run (`sim-cli.test.ts` drives that end to end through the CLI's exit code). `runner.test.ts`
// and `tournament.test.ts` cover the carrier from this side; this suite covers the record.
import {
  describePlannerFailures,
  plannerFailuresOf,
  type PlannerFailure,
  type PlannerPhase,
} from '../src/ai/smart.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The real, validated content every game in this file is played on. */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

/**
 * A small map and a short horizon: enough turns for cities, improvements, research and
 * contact, at test speed. Two civilizations and a barbarian player, which is the smallest
 * world in which "does it expand and does it fight" is a question at all.
 */
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 };

/**
 * The map and size `scripts/combat-balance-sweep.ts` itself measures on — `duel`, two
 * civilizations — so the walls exposure this file reports is read off the same fixture the
 * sweep's flat table comes from rather than off a friendlier one.
 */
const DUEL_SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** How many turns a measured run plays. */
const TURNS = 45;

/** The seeds the comparison and legality sections run over. Ascending, and shared. */
const SEEDS: readonly number[] = [7, 11, 23];

/** One measured run's final numbers, for the comparison table. */
interface Seat {
  readonly seed: number;
  readonly cities: number;
  readonly population: number;
  readonly techs: number;
  readonly units: number;
  readonly treasury: number;
  readonly buildings: number;
  readonly stoppedBecause: string;
  readonly violations: number;
}

/** Everything the comparison table is built from, read off a finished state. */
const seatOf = (seed: number, result: SimulationResult): Seat => {
  const player = asPlayerId(0);
  const cities = citiesOf(result.finalState, player);
  const row = result.finalState.players.find((entry) => entry.id === player);
  return {
    seed,
    cities: cities.length,
    population: cities.reduce((total, city) => total + city.population, 0),
    techs: row?.techs.length ?? 0,
    units: result.finalState.units.filter((unit) => unit.owner === player).length,
    treasury: row?.treasury ?? 0,
    buildings: cities.reduce((total, city) => total + city.buildings.length, 0),
    stoppedBecause: result.stoppedBecause,
    violations: result.violations.length,
  };
};

/** One row of the evidence table, as a line a failing run prints. */
const line = (label: string, seat: Seat): string =>
  `${label} seed ${String(seat.seed)}: cities=${String(seat.cities)} pop=${String(seat.population)} ` +
  `techs=${String(seat.techs)} units=${String(seat.units)} buildings=${String(seat.buildings)} ` +
  `gold=${String(seat.treasury)} stopped=${seat.stoppedBecause} violations=${String(seat.violations)}`;

/** What a hand-driven run saw. */
interface Drive {
  readonly state: GameState;
  readonly turnsPlayed: number;
  readonly refusals: readonly string[];
  readonly applied: number;
  readonly proposed: number;
  /** The world's RNG state after each turn, as `canonicalize` spells it. */
  readonly rngTrajectory: readonly string[];
}

/**
 * Play `turns` turns of `seed` by hand, through the **real** `applyCommand` and the real
 * `advanceTurn`, with the policies polled exactly as `runSimulation` polls them.
 *
 * A hand driver rather than `runSimulation` for the two things a `SimulationResult` cannot
 * report: every **refusal** (the runner drops a refused command silently by design — the
 * frozen `SimulationResult` has no field for one), and the world's RNG state **at every
 * turn** rather than only in a final hash.
 */
const drive = (seed: number, policies: readonly Policy[], turns: number): Drive => {
  const started = newGame(seed, SETTINGS, RULESET);
  if (!started.ok) throw new Error(`newGame refused seed ${String(seed)}: ${started.error.kind}`);

  let state = started.value;
  const refusals: string[] = [];
  const rngTrajectory: string[] = [canonicalize(state.rng)];
  let applied = 0;
  let proposed = 0;

  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of state.players) {
      if (player.kind !== 'civ') continue;
      const index = Number(player.id) % Math.max(1, policies.length);
      const policy = policies[index];
      if (policy === undefined) continue;
      const ctx: PolicyContext = {
        state,
        playerId: player.id,
        ruleset: RULESET,
        rng: policyRngFor(seed, player.id, state.turn),
      };
      for (const command of policy.chooseCommands(ctx)) {
        proposed += 1;
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, RULESET);
        if (!outcome.ok) {
          refusals.push(`${command.type} refused: ${outcome.error.kind}`);
          continue;
        }
        state = outcome.value.state;
        applied += 1;
      }
    }
    state = advanceTurn(state, RULESET).state;
    rngTrajectory.push(canonicalize(state.rng));
  }

  return { state, turnsPlayed: turns, refusals, applied, proposed, rngTrajectory };
};

/** The context a state is polled with — the same shape the runner hands a policy. */
const ctxFor = (state: GameState, playerId: PlayerId, rng?: RngState): PolicyContext => ({
  state,
  playerId,
  ruleset: RULESET,
  rng: rng ?? policyRngFor(1, playerId, state.turn),
});

/** How many commands of `commands` the applier refuses, folded in order. */
const refusalCount = (
  state: GameState,
  playerId: PlayerId,
  commands: readonly Command[],
): number => {
  let current = state;
  let refused = 0;
  for (const command of commands) {
    const outcome = applyCommand(current, playerId, command, RULESET);
    if (!outcome.ok) {
      refused += 1;
      continue;
    }
    current = outcome.value.state;
  }
  return refused;
};

/** A deliberately degenerate but well-formed state: nothing, nowhere, nobody. */
const emptyState = (): GameState => ({
  schemaVersion: 0,
  revision: 0,
  turn: 1,
  seed: 0,
  settings: SETTINGS,
  rng: policyRngFor(0, asPlayerId(0), 1),
  map: { width: 0, height: 0, terrain: [], huts: [], resources: [] },
  players: [],
  nextUnitId: 0,
  units: [],
  explored: [],
  nextCityId: 0,
  cities: [],
  improvements: [],
});

/* ------------------------------------------------------------------ *
 * 1. Determinism, and the world's stream
 * ------------------------------------------------------------------ */

describe('M7 — the real AI is deterministic and cannot move the world', () => {
  // Full tier: two 25-turn games of the real AI, twice each. Measured at 8.8 s with vitest's
  // per-file reporter, which is the largest single item in the file and pure wall time in the
  // fast gate. Determinism is the property M7 rests on, so it is not dropped — `pnpm verify:full`
  // runs it, and this run reports it as skipped by name.
  it.skipIf(!FULL_TIER)('plays a seed identically twice', () => {
    for (const seed of [7, 23]) {
      const options = {
        seed,
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: 25,
      };
      const first = runSimulation(options);
      const second = runSimulation(options);
      expect(second.finalHash).toBe(first.finalHash);
      expect(canonicalize(second.metrics)).toBe(canonicalize(first.metrics));
      expect(second.stoppedBecause).toBe(first.stoppedBecause);
    }
  });

  it('is a pure function of its context: the same state gives the same commands', () => {
    const started = newGame(11, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const ctx = ctxFor(started.value, asPlayerId(0));
    expect(SMART_POLICY.chooseCommands(ctx)).toEqual(SMART_POLICY.chooseCommands(ctx));
  });

  // Full tier: 2.6 s — three 20-turn drives plus three more games advanced turn by turn.
  it.skipIf(!FULL_TIER)('takes its own stream and never reads the world RNG while deciding', () => {
    // **What the property is, stated exactly.** M5's requirement is that a policy consumes
    // *only* its own stream, so that two policies on one seed leave the **world's** trajectory
    // comparable. It is not that the trajectory is *identical* under any two policies: the
    // world's stream is consumed by events the policy causes — a hut entered, a barbarian band
    // spawned near a new city, a battle resolved — so an AI that plays and a policy that does
    // nothing **cannot** have the same trajectory, and asserting that they do would be
    // asserting that the AI changed nothing. What must hold, and does:
    //
    //   (a) the trajectory is a function of the *game*, not of the policy implementation:
    //       play the same policy twice, or swap which player runs it, and the world's stream is
    //       the same sequence; and
    //   (b) the policy's decisions do not depend on the world's stream *or* its own: hand it
    //       any stream at all and it answers identically.
    const seed = 23;
    const first = drive(seed, [SMART_POLICY, SMART_POLICY], 20);
    const again = drive(seed, [SMART_POLICY, SMART_POLICY], 20);
    expect(again.rngTrajectory).toEqual(first.rngTrajectory);
    expect(first.rngTrajectory.length).toBe(21);

    // **(a), the sharp form: the world's stream is a function of the game and not of the
    // policy.** A policy that never draws from `state.rng` cannot move the world's trajectory
    // off the value it would have had anyway, so the trajectory under the AI must be the
    // trajectory under the do-nothing control — *not* merely deterministic, but the **same
    // value**. That is what makes a cross-policy comparison meaningful, and it is a stronger
    // claim than "the AI is deterministic twice".
    //
    // Note what is deliberately *not* asserted here: that the AI causes the world's stream to
    // advance. An earlier draft did assert it, on the theory that founding cities or entering a
    // hut must consume a world draw — and it failed, honestly, once the AI's play changed:
    // whether a particular action draws from `state.rng` is a property of the *engine*, not of
    // the policy, and pinning it here would make this test a claim about the engine's internals
    // that the M5 property does not rest on. What the property rests on is that the policy
    // cannot *read* the stream, and that is what is asserted.
    const idle = drive(seed, [DO_NOTHING_POLICY, DO_NOTHING_POLICY], 20);
    expect(first.state.cities.length).toBeGreaterThan(idle.state.cities.length);
    expect(first.rngTrajectory).toEqual(idle.rngTrajectory);

    // (b) — the strongest form: a policy given six different streams, in four different
    // states of the same game, answers identically every time.
    for (const turn of [1, 5, 12]) {
      const started = newGame(seed, SETTINGS, RULESET);
      if (!started.ok) throw new Error('newGame refused');
      let state = started.value;
      for (let step = 1; step < turn; step += 1) state = advanceTurn(state, RULESET).state;
      const answers = [0, 1, 17, 40].map((offset) =>
        SMART_POLICY.chooseCommands(
          ctxFor(state, asPlayerId(0), policyRngFor(seed + offset, asPlayerId(0), turn)),
        ),
      );
      for (const answer of answers) expect(answer).toEqual(answers[0]);
    }
  });

  it('never reads the world RNG, whether or not the read changes a decision', () => {
    // **(c) — the direct form, and E3 added it because (a) and (b) cannot catch every read.**
    //
    // The tests above hold the two properties that a read *usually* breaks: the world's
    // trajectory is unchanged, and the answer does not depend on the stream the runner hands
    // over. Both are properties of a policy's *effect*, and a policy can read `state.rng` and
    // still satisfy both — E3 measured exactly that. A mutation that consumed the world's
    // stream on every turn and folded the draw into a comparison that came out the same way
    // every time passed the whole of this file, full tier included, while breaking the rule
    // M7 states in the first person: the AI must never draw from `state.rng`, because the
    // point is that the AI cannot *change* the world's stream, and a read is the step before
    // a write.
    //
    // So the state handed to the policy carries a **sentinel** world stream: an accessor that
    // answers with words no real stream has. Two things follow, and between them they are the
    // property:
    //
    //  * a planner that reads `state.rng` — for a cache key, for a tie-break, for anything —
    //    reads the sentinel, so its decisions move and the command list differs from the one
    //    the same state with its real stream produces. E3 checked this guard against exactly
    //    that mutation before trusting it: a planner that drew from the world's stream on every
    //    turn was caught here while the two tests above still passed;
    //  * the count is *not* asserted to be zero, because it cannot be. `attempt` folds each
    //    candidate through the engine's own `applyCommand`, and combat reads `state.rng` when it
    //    resolves a battle (measured: one read for a turn's four commands, the read being the
    //    CombatResolved path). That read is the engine's, on a state the AI merely carries —
    //    forbidding it would be forbidding the AI to ask the engine whether an attack is legal.
    const started = newGame(11, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const real = started.value;

    // **Every read of the world's stream, counted.** The accessor is on the state the AI is
    // handed, and the AI reaches the stream only through it — so a read by the planner, by a
    // cache key, by anything in the decision path, lands here as a number.
    let reads = 0;
    const watched = { ...real };
    Object.defineProperty(watched, 'rng', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return real.rng;
      },
    });

    const commands = SMART_POLICY.chooseCommands(ctxFor(watched, asPlayerId(0)));
    const commandsAgain = SMART_POLICY.chooseCommands(ctxFor(real, asPlayerId(0)));
    // More than one, so the engine's single read is not merely "the first fold": the assertion
    // below is about a policy that decided several things while touching the world's stream
    // exactly once — and about a mutation that touches it once more.
    expect(commands.length).toBeGreaterThan(1);
    // The decisions are the same ones the real stream produces — so nothing in the decision
    // path has been fed the world's stream in a way that reached an answer.
    expect(commands).toEqual(commandsAgain);

    // And the reads are **the engine's, not the planner's**, which is one read in total and not
    // one per command: the planner starts holding the state it was given, folds its first
    // candidate through `applyCommand`, and every fold after that is on a state the *engine*
    // built (`attempt` rebinds `state` to the outcome). `applyCommand` reads `state.rng` once
    // per call — at its top, not inside the attack branch, so a `FoundCity` reads it too — and
    // that single read is the whole count on a clean build. Measured (E3): 1.
    //
    // So one is the honest ceiling, and a second read is the planner holding a stream it is
    // forbidden to hold. This is the assertion the two above cannot make: they ask whether a
    // read *changed an answer*, and a read that does not change one — a cache key, a dead
    // branch — is exactly the case E3 measured passing this whole file, full tier included.
    expect(
      reads,
      'the AI read the world RNG more often than the engine did while applying its commands — ' +
        'the planner is touching `state.rng`, which M7 forbids, so that changing the AI cannot ' +
        'change the world',
    ).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 1b. The planner got cheap without moving a decision
 * ------------------------------------------------------------------ */

/**
 * The **whole command sequence** of a game, one line per command, as `canonicalize` spells
 * it: `t{turn} p{player} {Type} {json}`.
 *
 * This is the strong form of "the same decisions". A final hash proves two games *ended* in
 * the same place; the sequence proves every decision on the way there was the same one, and
 * a planner that moved one tie-break deep inside can leave a thirty-turn game's final state
 * identical while being a different AI. It is the measurement a caching change has to be
 * held to, because a cache *is* a claim — "the answer I skipped would have been the same
 * one" — and that is the shape of claim that holds until it does not.
 *
 * The driver is deliberately the same shape as `drive` above and as `runSimulation`: poll
 * each civilization in player order, fold every command through the real `applyCommand`,
 * advance the real turn. A refusal throws here rather than being counted, because a trail
 * that needs a refused command to line up is not a trail two builds can be compared on.
 */
const commandTrail = (seed: number, turns: number, policy: Policy): readonly string[] => {
  const started = newGame(seed, SETTINGS, RULESET);
  if (!started.ok) throw new Error(`newGame refused seed ${String(seed)}`);
  let state = started.value;
  const trail: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of state.players) {
      if (player.kind !== 'civ') continue;
      const ctx = ctxFor(state, player.id, policyRngFor(seed, player.id, state.turn));
      for (const command of policy.chooseCommands(ctx)) {
        trail.push(
          `t${String(state.turn)} p${String(Number(player.id))} ${command.type} ${canonicalize(command)}`,
        );
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, RULESET);
        if (!outcome.ok) throw new Error(`${command.type} refused: ${outcome.error.kind}`);
        state = outcome.value.state;
      }
    }
    state = advanceTurn(state, RULESET).state;
  }
  return trail;
};

describe('M7b — the planner got cheap without moving a decision', () => {
  /**
   * Seed 3, thirty turns, both civilizations: **607 commands**, in this order, none refused.
   *
   * The count, the digest and the twelve lines below were all taken from the
   * **pre-optimisation** build (`8e9ea21`, checked out in a worktree of its own) with this
   * exact driver, and the two builds were then compared line by line: 1 379 lines over seeds
   * 2 and 3, byte-for-byte identical. The optimised build is measurably about five times
   * faster on this shape of game; what this test says is that it is not one decision
   * different.
   *
   * If it fails, the fix is **not** to re-pin the digest. The digest is what turns "this
   * refactor changed the AI" from something nobody notices into a deliberate act with a
   * diff — find the decision that moved, and decide there whether it should have.
   */
  it('proposes the same sequence of commands on seed 3, turn for turn', () => {
    const trail = commandTrail(3, 30, smartPolicy());
    expect(trail.length).toBe(607);
    expect(fnv1a64(trail.join('\n'))).toBe('91f3c655297e0fcb');
    // The head of it verbatim, so a failure reports *what* moved rather than only that
    // something did: a digest can only ever say "somewhere in these 607 commands".
    expect(trail.slice(0, 12)).toEqual([
      't1 p0 SetResearch {"tech":"ceremonial-burial","type":"SetResearch"}',
      't1 p0 SetRates {"rates":{"luxury":0,"science":10,"tax":0},"type":"SetRates"}',
      't1 p0 FoundCity {"type":"FoundCity","unitId":0}',
      't1 p0 StartWork {"kind":"irrigation","type":"StartWork","unitId":1}',
      't1 p1 SetResearch {"tech":"ceremonial-burial","type":"SetResearch"}',
      't1 p1 SetRates {"rates":{"luxury":0,"science":10,"tax":0},"type":"SetRates"}',
      't1 p1 FoundCity {"type":"FoundCity","unitId":2}',
      't1 p1 StartWork {"kind":"irrigation","type":"StartWork","unitId":3}',
      't2 p0 SetProduction {"cityId":0,"item":{"id":"galley","kind":"unit"},"type":"SetProduction"}',
      't2 p1 SetProduction {"cityId":1,"item":{"id":"galley","kind":"unit"},"type":"SetProduction"}',
      't3 p0 SetWorkedTiles {"cityId":0,"tiles":[684],"type":"SetWorkedTiles"}',
      't3 p0 SetProduction {"cityId":0,"item":{"id":"settler","kind":"unit"},"type":"SetProduction"}',
    ]);
  });

  // Full tier: four hundred-turn games, measured at about 15 s with vitest's per-file
  // reporter. The long horizon is where the caching shows up and where a cache that
  // outlived the board it describes would first show a difference, so the end state is
  // pinned too — and those four hashes are the same four the pre-optimisation build
  // produced (`8e9ea21`), which is also what the seed-by-seed replay compared.
  it.skipIf(!FULL_TIER)('ends a hundred-turn game on the hash the old build ended on', () => {
    const pins: readonly (readonly [number, string])[] = [
      [1, '49118125b0f5d85e'],
      [2, 'ce0274371db9c4c7'],
      [3, '8078a1d07995d486'],
      [6, '8947e9f3488fd0ef'],
    ];
    const report: string[] = [];
    for (const [seed, pinned] of pins) {
      const result = runSimulation({
        seed,
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [smartPolicy(), smartPolicy()],
        maxTurns: 100,
      });
      report.push(`seed ${String(seed)}: ${result.finalHash} (pinned ${pinned})`);
      expect(result.finalHash, report.join('\n')).toBe(pinned);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Totality
 * ------------------------------------------------------------------ */

describe('M7 — the real AI is total: it never throws and never proposes the illegal', () => {
  it('answers an empty state with a legal, possibly empty list', () => {
    const state = emptyState();
    for (const policy of [SMART_POLICY, smartPolicy({ settlement: { targetCities: 9 } })]) {
      const commands = policy.chooseCommands(ctxFor(state, asPlayerId(0)));
      expect(Array.isArray(commands)).toBe(true);
      expect(refusalCount(state, asPlayerId(0), commands)).toBe(0);
    }
  });

  it('answers a state with no cities and no units at all', () => {
    const started = newGame(7, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const bare: GameState = { ...started.value, cities: [], units: [] };
    const commands = SMART_POLICY.chooseCommands(ctxFor(bare, asPlayerId(0)));
    expect(refusalCount(bare, asPlayerId(0), commands)).toBe(0);
  });

  it('answers a player with no cities, no units and no gold', () => {
    const started = newGame(7, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const broke: GameState = {
      ...started.value,
      cities: [],
      units: [],
      players: started.value.players.map((player) =>
        player.id === asPlayerId(0) ? { ...player, treasury: 0, beakers: 0 } : player,
      ),
    };
    const commands = SMART_POLICY.chooseCommands(ctxFor(broke, asPlayerId(0)));
    expect(refusalCount(broke, asPlayerId(0), commands)).toBe(0);
  });

  it('answers an unknown player id with an empty list', () => {
    const started = newGame(7, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    expect(SMART_POLICY.chooseCommands(ctxFor(started.value, asPlayerId(99)))).toEqual([]);
  });

  it('answers a fully blocked board without throwing or proposing the illegal', () => {
    const started = newGame(19, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');

    // A rival unit on **every** neighbour of this player's settler: nothing it can step to,
    // and nothing it can legally do but sit there. This is the board where a policy that
    // assumed "there is always a move" reads a tile it never checked or divides by zero.
    const mine = started.value.units.find((unit) => unit.owner === asPlayerId(0));
    if (mine === undefined) throw new Error('the fixture has no starting unit');
    const blockers: Unit[] = [...neighbors8(started.value.map, mine.tile)].map((tile, index) => ({
      ...mine,
      id: asUnitId(Number(mine.id) + 1000 + index),
      owner: asPlayerId(1),
      tile,
      movementLeft: 0,
    }));
    const walled: GameState = { ...started.value, units: [...started.value.units, ...blockers] };

    const commands = SMART_POLICY.chooseCommands(ctxFor(walled, asPlayerId(0)));
    expect(Array.isArray(commands)).toBe(true);
    expect(refusalCount(walled, asPlayerId(0), commands)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. A thrown planner error is a value, not a silence
 * ------------------------------------------------------------------ */

/**
 * **A board the engine would never make: one whose goody-hut list cannot be read.**
 *
 * The fault is injected deliberately, and as a throwing accessor rather than as a corrupt
 * value, for one reason: a policy that swallows a throw and returns fewer commands produces
 * a turn that looks exactly like a turn in which the AI had nothing to say. Nothing
 * downstream can tell those apart — not the final hash, not the metrics, not the invariant
 * checks — which is why the failure has to be a thing the policy *says*, and why this suite
 * has to be able to make it happen on purpose.
 *
 * This is a good fault to inject because it fires **late**: the hut list is read by the
 * settler and explorer rankers, so the city, research and rate passes have already decided
 * their commands by the time it throws. That is what "the turn is still a turn" can be
 * measured on.
 */
const withUnreadableHuts = (state: GameState): GameState => ({
  ...state,
  map: {
    ...state.map,
    get huts(): never {
      throw new Error('the hut list is unreadable');
    },
  },
});

/** The same idea in the **first** pass: the board itself cannot be read at all. */
const withUnreadableMap = (state: GameState): GameState => ({
  ...state,
  get map(): never {
    throw new Error('the board is unreadable');
  },
});

describe('M7b — a thrown planner error comes back typed instead of vanishing', () => {
  it('records nothing at all while it plays a real game', () => {
    // The control for every other test here: a healthy policy must be silent, or "it
    // recorded a failure" says nothing about the run it recorded it in. Two civilizations,
    // eight turns, through the real applier — the same driver the legality section uses.
    const policy = smartPolicy();
    const ran = drive(3, [policy, policy], 8);
    expect(ran.refusals).toEqual([]);
    expect(ran.proposed).toBeGreaterThan(10);
    expect(plannerFailuresOf(policy)).toEqual([]);
    expect(policy.report().failureCount).toBe(0);

    // The singleton every other test in this file plays with, for the same reason: if it
    // had ever failed, the games those tests called healthy were not.
    expect(plannerFailuresOf(SMART_POLICY)).toEqual([]);
  });

  it('keeps the turn a turn, and names the pass the throw came from', () => {
    const started = newGame(23, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    let state = started.value;
    for (let turn = 0; turn < 6; turn += 1) state = advanceTurn(state, RULESET).state;

    const broken = withUnreadableHuts(state);
    const playerId = asPlayerId(0);
    const policy = smartPolicy();
    // The whole point: **no throw escapes**, and the caller still gets a command list.
    const commands = policy.chooseCommands(ctxFor(broken, playerId));

    const failures = plannerFailuresOf(policy);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (failure === undefined) throw new Error('the failure was not recorded');
    expect(failure.policy).toBe(SMART_POLICY_NAME);
    expect(failure.playerId).toBe(Number(playerId));
    expect(failure.turn).toBe(state.turn);
    // Where, exactly: the pass and the thing being planned when it threw. This is the part
    // that turns "the AI failed on turn 7" into something a person can act on.
    expect(failure.phase).toBe('units');
    expect(failure.detail).toContain('unit ');
    expect(failure.error).toContain('the hut list is unreadable');

    // The commands decided **before** the failure are still returned — a partial turn, and
    // every one of them legal. A policy that answered a fault with `[]` would end the game
    // (`no-commands`) instead of losing the rest of one turn.
    expect(commands.length).toBeGreaterThan(0);
    expect(refusalCount(broken, playerId, commands)).toBe(0);

    // And the printable form says the same things, because a record nobody can read is only
    // marginally better than no record.
    const lines = describePlannerFailures(policy);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(SMART_POLICY_NAME);
    expect(lines[0]).toContain(`turn ${String(state.turn)}`);
    expect(lines[0]).toContain('the hut list is unreadable');
  });

  it('survives a fault in the first pass, with the phase it happened in', () => {
    const started = newGame(23, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const broken = withUnreadableMap(started.value);
    const playerId = asPlayerId(0);
    const policy = smartPolicy();

    const commands = policy.chooseCommands(ctxFor(broken, playerId));
    // Nothing was decidable from a board that cannot be read, so the list is empty — and it
    // is still a *list*, still legal, and the reason it is empty is recorded rather than
    // inferred.
    expect(Array.isArray(commands)).toBe(true);
    expect(refusalCount(broken, playerId, commands)).toBe(0);

    const failure = plannerFailuresOf(policy)[0];
    if (failure === undefined) throw new Error('the failure was not recorded');
    const phases: readonly PlannerPhase[] = ['assembly', 'cities', 'research', 'rates', 'units'];
    expect(phases).toContain(failure.phase);
    expect(failure.error).toContain('the board is unreadable');
  });

  it('keeps the first failure of each pass, counts the rest, and hands out copies', () => {
    // A policy that has started throwing usually throws on **every** turn: twenty seeds of a
    // hundred turns would store twenty thousand identical records that say nothing the first
    // one did not, and a cap chosen to hold them would itself be a magnitude. What a reader
    // needs is *which passes* have failed and how often — bounded by the passes rather than
    // by a number somebody picked — and `failureCount` is what stops the short list being
    // mistaken for the whole story.
    const started = newGame(23, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const broken = withUnreadableMap(started.value);
    const policy = smartPolicy();
    const attempts = 8;

    for (let call = 0; call < attempts; call += 1) {
      policy.chooseCommands(ctxFor(broken, asPlayerId(0)));
    }

    const report = policy.report();
    expect(report.failureCount).toBe(attempts);
    expect(report.failures.length).toBe(1);
    // A copy per call, so a reporter cannot watch the list change under it or append to it.
    expect(plannerFailuresOf(policy)).not.toBe(plannerFailuresOf(policy));
  });

  it('answers for a policy that cannot report, so a reporter needs no branch', () => {
    expect(plannerFailuresOf(DO_NOTHING_POLICY)).toEqual([]);
    expect(describePlannerFailures(DO_NOTHING_POLICY)).toEqual([]);
    // And the record type is what the runner would read: flat, and JSON-round-trippable —
    // the same shape rule `Violation` follows, for the same reason (evidence has to survive
    // being written to a file and read back by another process).
    const failure: PlannerFailure = {
      policy: SMART_POLICY_NAME,
      turn: 1,
      playerId: 0,
      phase: 'units',
      detail: 'unit 0 (settler)',
      error: 'TypeError: x',
    };
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Legality, over many seeds and turns
 * ------------------------------------------------------------------ */

describe('M7 — every command the AI proposes is one the applier accepts', () => {
  // Full tier: 7.9 s. Folds every command the AI returns through the real applier over several
  // seeds and turns — the M2 keystone applied to the AI, and the most expensive thing in the
  // file after the baseline comparison. `pnpm verify:full` runs it.
  it.skipIf(!FULL_TIER)('has zero refusals over several seeds and turns, non-vacuously', () => {
    let totalApplied = 0;
    let totalProposed = 0;
    const report: string[] = [];

    for (const seed of [3, 7, 23, 41, 59, 97]) {
      const ran = drive(seed, [SMART_POLICY, SMART_POLICY], 20);
      expect(ran.refusals, `seed ${String(seed)}`).toEqual([]);
      totalApplied += ran.applied;
      totalProposed += ran.proposed;
      report.push(
        `seed ${String(seed)}: applied=${String(ran.applied)} proposed=${String(ran.proposed)}`,
      );
    }

    // Non-vacuous: a policy that proposed nothing would pass every refusal assertion.
    expect(totalProposed, report.join('\n')).toBeGreaterThan(50);
    expect(totalApplied).toBe(totalProposed);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The core claim — it beats doing nothing
 * ------------------------------------------------------------------ */

describe('M7 — the real AI decisively beats the do-nothing baseline', () => {
  // Full tier: 16.8 s — the single most expensive test in the fast tier before M7b re-drew the
  // boundary, and the one that made `time pnpm verify` exceed its bound on its own. This is
  // M7's core claim (the AI is an opponent, not a stub), so it is kept and moved rather than
  // trimmed: three seeds x 45 turns x two policies, against the do-nothing control on the same
  // world. `pnpm verify:full` runs it; the fast run reports it as skipped by name.
  it.skipIf(!FULL_TIER)(
    'founds cities, grows people, learns techs and builds units where the baseline does not',
    () => {
      const aiSeats: Seat[] = [];
      const idleSeats: Seat[] = [];

      for (const seed of SEEDS) {
        aiSeats.push(
          seatOf(
            seed,
            runSimulation({
              seed,
              settings: SETTINGS,
              ruleset: RULESET,
              policies: [SMART_POLICY, SMART_POLICY],
              maxTurns: TURNS,
            }),
          ),
        );
        idleSeats.push(
          seatOf(
            seed,
            runSimulation({
              seed,
              settings: SETTINGS,
              ruleset: RULESET,
              policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
              maxTurns: TURNS,
            }),
          ),
        );
      }

      // The evidence, printed: a reader sees the numbers rather than a claim about them.
      const table = [
        `M7 AI vs do-nothing (tiny map, 2 civs, ${String(TURNS)} turns, player 0):`,
        ...aiSeats.map((seat) => line('  ai  ', seat)),
        ...idleSeats.map((seat) => line('  idle', seat)),
      ].join('\n');

      // Printed rather than only attached to a failure: these numbers are the deliverable of
      // the comparison, and a reader of a green run should be able to see them without
      // breaking the test to get them.
      console.log(table);

      for (const seat of [...aiSeats, ...idleSeats]) {
        expect(seat.violations, `run ${String(seat.seed)} reported invariant violations`).toBe(0);
      }

      const wins = (pick: (seat: Seat) => number): number =>
        aiSeats.filter((seat, index) => {
          const other = idleSeats[index];
          return other !== undefined && pick(seat) > pick(other);
        }).length;

      const majority = Math.floor(SEEDS.length / 2) + 1;
      expect(
        wins((seat) => seat.cities),
        table,
      ).toBeGreaterThanOrEqual(majority);
      expect(
        wins((seat) => seat.population),
        table,
      ).toBeGreaterThanOrEqual(majority);
      expect(
        wins((seat) => seat.techs),
        table,
      ).toBeGreaterThanOrEqual(majority);
      expect(
        wins((seat) => seat.units),
        table,
      ).toBeGreaterThanOrEqual(majority);

      // "Decisively", not "by one citizen". The baseline founds nothing at all by construction —
      // `DO_NOTHING_POLICY` returns an empty list, so its settler never moves — which is what
      // makes its zero population a floor rather than a coincidence. These are the absolute
      // numbers the claim rests on, asserted per seed so one lucky seed cannot carry the row.
      const idleTotal = idleSeats.reduce((total, seat) => total + seat.population, 0);
      expect(idleTotal).toBe(0);
      expect(idleSeats.every((seat) => seat.cities === 0)).toBe(true);
      for (const seat of aiSeats) {
        expect(seat.cities, table).toBeGreaterThanOrEqual(1);
        expect(seat.population, table).toBeGreaterThanOrEqual(1);
      }
      // Research is asserted in total rather than per seed: a short game on a small map can end
      // before a single 6-beaker tech completes on one seed and not another, and the claim being
      // made here is that this AI *does* research, which the sum answers without pretending a
      // single slow seed is a failure.
      expect(
        aiSeats.reduce((total, seat) => total + seat.techs, 0),
        table,
      ).toBeGreaterThanOrEqual(SEEDS.length);
    },
  );
});

/* ------------------------------------------------------------------ *
 * 5. Sweepability
 * ------------------------------------------------------------------ */

describe('M7 — the AI magnitudes live in one named, sweepable place', () => {
  it('names every group of weights, complete and in reading order', () => {
    expect([...SMART_WEIGHT_GROUPS]).toEqual([
      'settlement',
      'city',
      'production',
      'research',
      'economy',
      'military',
      'exploration',
    ]);
    // Every group named is really a group of the defaults: the list cannot name a group the
    // interface does not have (the type would refuse) or omit one it does (this does).
    for (const group of SMART_WEIGHT_GROUPS) expect(SMART_WEIGHTS[group]).toBeDefined();
  });

  it('is a complete patch: the defaults and the merge agree group for group', () => {
    expect(canonicalize(mergeSmartWeights())).toBe(canonicalize(SMART_WEIGHTS));
    expect(canonicalize(mergeSmartWeights({}))).toBe(canonicalize(SMART_WEIGHTS));
    // And a patch that names nothing in a group leaves the whole group alone, field by field.
    const empty = mergeSmartWeights({ military: {} });
    expect(canonicalize(empty.military)).toBe(canonicalize(SMART_WEIGHTS.military));
  });

  it('names exactly one field: a patch moves what it names and nothing else', () => {
    const patched = mergeSmartWeights({ military: { attackWinFloorPct: 91 } });
    expect(patched.military.attackWinFloorPct).toBe(91);
    expect(patched.military.attackWinFloorVsCityPct).toBe(
      SMART_WEIGHTS.military.attackWinFloorVsCityPct,
    );
    expect(patched.economy.runwayTurns).toBe(SMART_WEIGHTS.economy.runwayTurns);
    expect(patched.settlement.targetCities).toBe(SMART_WEIGHTS.settlement.targetCities);
  });

  it('keeps the rate triple legal: the luxury ceiling is inside RATE_TOTAL', () => {
    const { luxuryShareWhenRich } = SMART_WEIGHTS.economy;
    expect(Number.isInteger(luxuryShareWhenRich)).toBe(true);
    expect(luxuryShareWhenRich).toBeGreaterThanOrEqual(0);
    expect(luxuryShareWhenRich).toBeLessThanOrEqual(RATE_TOTAL);
  });

  // Full tier: 3.0 s — two full games per weight value, because the claim is that moving one
  // weight moves the *game*, not that a function returns a different number.
  it.skipIf(!FULL_TIER)('changes the game when a weight moves — the sweep is measurable', () => {
    const seed = 11;
    const size = (targetCities: number): number => {
      const policy = smartPolicy({ settlement: { targetCities } });
      const result = runSimulation({
        seed,
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [policy, policy],
        maxTurns: 30,
      });
      const cities = citiesOf(result.finalState, asPlayerId(0));
      return cities.reduce((total, city) => total + city.population, 0);
    };
    const few = size(1);
    const many = size(4);
    // A target of one stops this AI expanding as soon as it has a city; a target of four keeps
    // it working settlers, which is population it does not spend on buildings. If the two ever
    // agree, the weight has become decoration.
    expect(many).not.toBe(few);
  });
});

/* ------------------------------------------------------------------ *
 * 6. The walls measurement
 * ------------------------------------------------------------------ */

/** What the walk observed about walls and about where the fighting happened. */
interface WallsRead {
  readonly seeds: number;
  /** Cities holding walls at the end of the games, summed over the seeds. */
  readonly citiesWithWalls: number;
  /** Battles resolved during the games. */
  readonly battles: number;
  /** Battles whose target tile was a walled city at the time. */
  readonly battlesIntoWalledCities: number;
  /** Battles whose target tile was a city of any kind. */
  readonly battlesIntoCities: number;
  /** Battles whose **target** was a barbarian unit. */
  readonly battlesAgainstBarbarians: number;
  /**
   * Cities that changed hands. The counter that separates "this AI never reaches the enemy"
   * from "this AI reaches the enemy and the fighting there happens to be elsewhere".
   */
  readonly citiesCaptured: number;
  readonly refusals: number;
}

/**
 * Walk whole games through the real applier, counting walls and where the fighting happened.
 *
 * The event stream is the right source for the fighting half rather than a guess from the
 * final state: `CombatResolved` names the target tile and both units, and a battle is resolved
 * *inside* a turn — so the wall that was defended behind is the one the state held when the
 * command was applied. The wall set is therefore rebuilt from `state` before each fold and read
 * from the state the battle was fought in, not from the end of the game.
 */
const walkWalls = (
  seeds: readonly number[],
  turns: number,
  settings: Settings = SETTINGS,
): WallsRead => {
  let citiesWithWalls = 0;
  let battles = 0;
  let battlesIntoWalledCities = 0;
  let battlesIntoCities = 0;
  let battlesAgainstBarbarians = 0;
  let citiesCaptured = 0;
  let refusals = 0;

  for (const seed of seeds) {
    const started = newGame(seed, settings, RULESET);
    if (!started.ok) throw new Error(`newGame refused seed ${String(seed)}`);
    let state = started.value;

    const walledTiles = (from: GameState): ReadonlySet<number> =>
      new Set(
        from.cities
          .filter((city) => city.buildings.some((id) => String(id) === String(WALLS_BUILDING)))
          .map((city) => Number(city.tile)),
      );

    for (let turn = 0; turn < turns; turn += 1) {
      for (const player of state.players) {
        if (player.kind !== 'civ') continue;
        const ctx = ctxFor(state, player.id, policyRngFor(seed, player.id, state.turn));
        for (const command of SMART_POLICY.chooseCommands(ctx)) {
          if (command.type === 'EndTurn') continue;
          const outcome = applyCommand(state, player.id, command, RULESET);
          if (!outcome.ok) {
            refusals += 1;
            continue;
          }
          const walls = walledTiles(state);
          const cityTiles = new Set(state.cities.map((city) => Number(city.tile)));
          for (const event of outcome.value.events) {
            if (event.type === 'CityCaptured') {
              citiesCaptured += 1;
              continue;
            }
            if (event.type !== 'CombatResolved') continue;
            battles += 1;
            const target = Number(event.target);
            if (walls.has(target)) battlesIntoWalledCities += 1;
            else if (cityTiles.has(target)) battlesIntoCities += 1;
            const defender = state.units.find((unit) => unit.id === event.defenderId);
            if (defender === undefined) continue;
            const kind = state.players.find((row) => row.id === defender.owner)?.kind;
            if (kind === 'barbarian') battlesAgainstBarbarians += 1;
          }
          state = outcome.value.state;
        }
      }
      state = advanceTurn(state, RULESET).state;
    }

    citiesWithWalls += walledTiles(state).size;
  }

  return {
    seeds: seeds.length,
    citiesWithWalls,
    battles,
    battlesIntoWalledCities,
    battlesIntoCities,
    battlesAgainstBarbarians,
    citiesCaptured,
    refusals,
  };
};

describe('M7 — the walls sweep now has something to measure', () => {
  // Full tier: 6.0 s — the walls measurement (M7's second task): it walks several seeds and
  // counts the battles, and the battles *into* walled cities, that decide whether the walls
  // bonus has anything to move at all.
  it.skipIf(!FULL_TIER)(
    'builds walls, and fights often enough for a walls bonus to move something',
    () => {
      // Two fixtures, and the second one is the point. `tiny` is the M7 fixture this test was
      // written against (the AI rarely meets anybody there); `duel` is the sweep's own map, where
      // the rival is reachable and the fighting happens. Reporting only the first was how a
      // measurement limitation came to look like a finding about the AI.
      const read = walkWalls([7, 23], 40);
      const duel = walkWalls([1, 2, 3], 60, DUEL_SETTINGS);
      const render = (label: string, one: WallsRead): string =>
        `${label}: seeds=${String(one.seeds)} citiesWithWalls=${String(one.citiesWithWalls)} ` +
        `battles=${String(one.battles)} intoCities=${String(one.battlesIntoCities)} ` +
        `intoWalledCities=${String(one.battlesIntoWalledCities)} ` +
        `captures=${String(one.citiesCaptured)} ` +
        `vsBarbarians=${String(one.battlesAgainstBarbarians)} refusals=${String(one.refusals)}`;
      const summary = `walls ${render('tiny', read)}\nwalls ${render('duel', duel)}`;

      // Printed, because `intoWalledCities` is the number this whole section is about and a
      // reader of a green run should not have to break the test to see it.
      console.log(summary);

      for (const one of [read, duel]) {
        expect(one.refusals, summary).toBe(0);
        // The AI builds walls, and it fights. Both are load-bearing, and the first is the half
        // the M1–M6 placeholder never did: it produced no wall in any game, so `wallsBonusPct`
        // had no walled city anywhere to defend and sweeping it could not have changed one battle.
        expect(one.citiesWithWalls, summary).toBeGreaterThan(0);
        expect(one.battles, summary).toBeGreaterThan(0);
      }

      // **The improvement this milestone is about, asserted on the sweep's own fixture.** Before
      // it, the sweep's `duel` runs ended with `captures=0` on every seed: no city changed hands,
      // no battle was fought anywhere near one, and the walls knob had nothing to enter. Now the
      // AI assaults a city it has the force for and takes it — so the counters that say "the
      // measurement had a subject" are non-zero rather than merely reported.
      expect(duel.citiesCaptured, summary).toBeGreaterThan(0);

      // **What is still NOT asserted, and why — this is the answer to M7's walls question.**
      //
      // `summary` reports how many battles were fought on a city tile, and how many of those
      // cities held the walls row. Both are **zero on both fixtures**, and pinning a floor they do
      // not meet would be a lie dressed as a guarantee. What changed in M7 is *why* they are zero,
      // and the two reasons are now distinguishable from the counters themselves:
      //
      // 1. (before) the AI never reached a city at all — `citiesCaptured` was 0 on every fixture,
      //    so the sweep's exposure counter had nothing to count on any playing.
      // 2. (now) the AI reaches cities and takes them (`citiesCaptured` above zero), but the ones
      //    it takes are **undefended**: an undefended city is taken by a single command that
      //    emits `CityCaptured` **and no `CombatResolved` at all**. No battle, no odds, no walls
      //    bonus. The garrison is simply elsewhere — which is what a city-holding AI with
      //    `fieldArmySharePct` does with an over-extended empire.
      //
      // So the honest verdict on the flat `wallsBonusPct` table is **measurement, not the knob**,
      // and it is proven three ways rather than asserted:
      //
      // - the knob is wired into the odds and the AI's decision: the test below moves
      //   `wallsBonusPct` over the sweep's own grid on a world where a defender **is** inside its
      //   own walled city, and the engine's per-round odds go 42% → 37% → 33% → 30% while the
      //   pair's assault flips from STORM to decline;
      // - the AI does besiege, and a group assault takes a walled city: section 9's fixture takes
      //   a walled, fortified city with five archers and asserts the capture exactly;
      // - the sweep itself now names the exposure (`0 of 232` battles at a walled city) instead
      //   of printing a flat table, and `--policy smart` is what produces that number.
      //
      // What would close it is not a tuning change but more war: a defended city, a longer
      // horizon, or a rival that garrisons what it walls. The number to watch is
      // `intoWalledCities`, and the second number to watch beside it is `captures` — a zero there
      // means the army never arrived, which is the limitation that was mistaken for a finding.
      expect(summary).toContain('intoWalledCities=');
    },
  );
});

/* ------------------------------------------------------------------ *
 * 7. The combat arithmetic the AI decides with
 * ------------------------------------------------------------------ */

/** Every per-round/hit-point combination the shipped catalog can produce, plus the edges. */
const BATTLE_GRID: readonly (readonly [number, number, number])[] = (() => {
  const cells: (readonly [number, number, number])[] = [];
  for (const perRound of [0, 10, 25, 40, 50, 60, 75, 90, 100]) {
    for (const attacker of [1, 2, 3, 4]) {
      for (const defender of [1, 2, 3, 4]) cells.push([perRound, attacker, defender]);
    }
  }
  return cells;
})();

/**
 * The battle-win probability, computed **exactly** in rational arithmetic.
 *
 * `combat.ts` resolves one round per hit: the winner of the round's draw lands
 * `damagePerRound` and the loser lands nothing, and the battle goes to whoever empties the
 * other's hit points first. So `P(attacker wins) = sum over r of C(a-1+r, r) p^d q^r`, with
 * `p = perRound / 100`, `q` its complement, and `d` the defender's hit points — every term a
 * product, every product exact in `BigInt`, and the final percentage **truncated** rather than
 * rounded so that a hopeless attack is never talked up to a threshold it does not clear.
 *
 * This is the independent oracle for the accumulation the AI decides with: the AI's own
 * `battleWinPctOf` is a floating-point negative-binomial sum, and the two must agree. If they
 * ever disagree, the AI is deciding on a number that is not the race `combat.ts` resolves.
 */
const exactBattleWinPct = (
  perRound: number,
  attackerHitPoints: number,
  defenderHitPoints: number,
): number => {
  const hundred = 100n;
  const p = BigInt(Math.max(0, Math.min(100, Math.floor(perRound))));
  const q = hundred - p;
  /** How many hits the attacker has to land: the defender's hit points. */
  const d = BigInt(Math.max(1, defenderHitPoints));
  /** How many hits the attacker can take: its own hit points. */
  const a = BigInt(Math.max(1, attackerHitPoints));

  const choose = (n: bigint, k: bigint): bigint => {
    let result = 1n;
    for (let i = 0n; i < k; i += 1n) result = (result * (n - i)) / (i + 1n);
    return result;
  };

  // The race, summed as the negative binomial it is: the attacker wins by landing its `d`-th
  // hit on the round where the defender has landed `r` of the `a` hits it needs, for any
  // `r <= a - 1`, and every such path has exactly `d + r` rounds:
  //
  //   P(win) = sum over r of  C(d - 1 + r, r) * p^d * q^r,   r = 0 .. a - 1
  //
  // Every term is `an integer / 100^(d + r)`, so the sum has the exact common denominator
  // `100^(a + d - 1)` and can be accumulated in `BigInt` with no rounding anywhere until the
  // final truncation to whole percent. **Nothing here is recomputed state by state**: an
  // earlier draft used the equivalent recurrence `win(x, y) = p*win(x, y-1) + q*win(x-1, y)`
  // with an integer division at every node, and those sixteen truncations compounded into a
  // three-point error — it answered 96 where the truth is 99.7 for an overwhelming attacker
  // at 90% per round. The engine's arithmetic is exact; a model of it must be too.
  const terms = a;
  const denominator = hundred ** (d + terms - 1n);
  let numerator = 0n;
  for (let r = 0n; r < terms; r += 1n) {
    const term = choose(d - 1n + r, r) * p ** d * q ** r;
    numerator += term * hundred ** (terms - 1n - r);
  }
  // Truncated, not rounded: a battle at 99.6% is not a certainty, and the final clamp keeps
  // `p = 0` — where the sum is the whole pie scaled down — from reading as a certainty.
  const scaled = (numerator * hundred) / denominator;
  return Number(scaled > hundred ? hundred : scaled);
};

describe('M7 — the attack decision is derived from the engine, not restated', () => {
  it('prices a battle exactly over a grid of odds and hit points', () => {
    // **This test used to check the policy against a copy of the policy's own arithmetic**,
    // written out here and compared term by term. The copy was more correct than the original:
    // it raised `p` to the defender's hit points where `battleWinPctOf` multiplied by `p`
    // alone, so the two agreed on the one-hit-point rows that a hand-checked example uses and
    // the copy silently *excused* the original where it was wrong. A model of the policy is not
    // evidence about the policy, and this one hid a real defect for a whole milestone.
    //
    // So the policy's arithmetic is no longer restated here. What is left is what an oracle is
    // for — the exact rational model, checked for the properties a probability has — and the
    // policy itself is pinned **behaviourally** in section 9, on worlds whose battle this model
    // prices: the attack has to be made if and only if the exact answer clears the floor. That
    // test fails on the old expression and passes on this one.
    for (const [perRound, attacker, defender] of BATTLE_GRID) {
      const exact = exactBattleWinPct(perRound, attacker, defender);
      expect(exact).toBeGreaterThanOrEqual(0);
      expect(exact).toBeLessThanOrEqual(100);
      if (perRound === 0) expect(exact).toBe(0);
      if (perRound === 100) expect(exact).toBe(100);
      // A defender with more hit points is never easier to kill than one with fewer, at the
      // same per-round odds.
      if (defender > 1) {
        expect(exact).toBeLessThanOrEqual(exactBattleWinPct(perRound, attacker, defender - 1));
      }
      // And the shape of the defect above, stated as a property: a one-hit-point attacker
      // cannot afford a single lost round, so its battle is the run of `defender` wins and
      // nothing else — `p ** defender`, strictly below the per-round chance. An accumulation
      // that multiplies by `p` alone reads `p` here and cannot be below it.
      if (attacker === 1 && defender > 1 && perRound > 0 && perRound < 100) {
        expect(exact).toBeLessThan(perRound);
      }
    }
  });

  it('prices hit points: a bigger stack wins a battle a thinner one loses at the same odds', () => {
    const even = exactBattleWinPct(50, 3, 1);
    const uphill = exactBattleWinPct(50, 1, 3);
    expect(even).toBeGreaterThan(uphill);
    expect(even).toBeGreaterThan(50);
    expect(uphill).toBeLessThan(50);
  });

  it('is monotone in the per-round chance, so a better unit is never priced worse', () => {
    for (const [perRound, attacker, defender] of BATTLE_GRID) {
      const here = exactBattleWinPct(perRound, attacker, defender);
      const better = exactBattleWinPct(Math.min(100, perRound + 10), attacker, defender);
      expect(
        better,
        `p=${String(perRound)} a=${String(attacker)} d=${String(defender)}`,
      ).toBeGreaterThanOrEqual(here);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 8. The AI actually spends its decisions
 * ------------------------------------------------------------------ */

/** Play `turns` turns of a seed, tallying the command types the applier accepted. */
const commandTally = (seed: number, turns: number): ReadonlyMap<string, number> => {
  const started = newGame(seed, SETTINGS, RULESET);
  if (!started.ok) throw new Error('newGame refused');
  let state = started.value;
  const kinds = new Map<string, number>();

  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of state.players) {
      if (player.kind !== 'civ') continue;
      const ctx = ctxFor(state, player.id, policyRngFor(seed, player.id, state.turn));
      for (const command of SMART_POLICY.chooseCommands(ctx)) {
        const outcome = applyCommand(state, player.id, command, RULESET);
        if (!outcome.ok) throw new Error(`${command.type} was refused: ${outcome.error.kind}`);
        kinds.set(command.type, (kinds.get(command.type) ?? 0) + 1);
        state = outcome.value.state;
      }
    }
    state = advanceTurn(state, RULESET).state;
  }
  return kinds;
};

describe('M7 — the AI plays rather than merely returning legal commands', () => {
  it('issues settlement, research, production and unit commands over a game', () => {
    const kinds = commandTally(41, 25);
    const report = [...kinds.entries()]
      .map(([kind, count]) => `${kind}=${String(count)}`)
      .sort()
      .join(' ');

    for (const essential of [
      'FoundCity',
      'SetProduction',
      'SetWorkedTiles',
      'SetResearch',
      'MoveUnit',
    ]) {
      expect(report, `the AI never issued ${essential} in 25 turns: ${report}`).toContain(
        essential,
      );
    }
    // And the game really advanced rather than being reported as one.
    expect([...kinds.values()].reduce((total, count) => total + count, 0)).toBeGreaterThan(20);
  });

  // Full tier: 4.9 s — a 45-turn game (`TURNS`), asserting the worked tiles, the research and
  // the treasury of the finished game rather than of one turn of it. The three cheaper
  // `commandTally`/`drive` tests below stay in the fast tier: they are the ones that prove the
  // AI *plays* at gate speed.
  it.skipIf(!FULL_TIER)(
    'works its cities’ tiles, builds in them, and researches continuously',
    () => {
      const result = runSimulation({
        seed: 23,
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: TURNS,
      });
      const cities: readonly City[] = citiesOf(result.finalState, asPlayerId(0));
      expect(cities.length).toBeGreaterThanOrEqual(1);
      for (const city of cities) {
        // A city with nothing queued is legal (a fresh city, or one whose item was completed
        // that turn), so the assertion is on the **worked tiles**, which every city of this AI
        // assigns on the turn it is founded and never leaves empty.
        expect(city.workedTiles.length).toBeGreaterThan(0);
        // One citizen works one tile: the assignment is the engine's own rule and never more
        // than the city can staff.
        expect(city.workedTiles.length).toBeLessThanOrEqual(city.population);
        expect(new Set(city.workedTiles.map(Number)).size).toBe(city.workedTiles.length);
      }
      const player = result.finalState.players.find((row) => row.id === asPlayerId(0));
      expect(player?.techs.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(player?.treasury ?? -1).toBeGreaterThanOrEqual(0);
    },
  );

  it('moves a unit to the tile it said it would, and only to a tile it may hold', () => {
    const seed = 97;
    const started = newGame(seed, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    let state = started.value;
    for (let turn = 0; turn < 20; turn += 1) {
      for (const player of state.players) {
        if (player.kind !== 'civ') continue;
        const ctx = ctxFor(state, player.id, policyRngFor(seed, player.id, state.turn));
        for (const command of SMART_POLICY.chooseCommands(ctx)) {
          const outcome = applyCommand(state, player.id, command, RULESET);
          if (!outcome.ok) throw new Error(`${command.type} refused: ${outcome.error.kind}`);
          state = outcome.value.state;
          if (command.type === 'MoveUnit') {
            const mover = unitById(state, command.unitId);
            if (mover !== undefined) expect(Number(mover.tile)).toBe(Number(command.to));
          }
        }
      }
      state = advanceTurn(state, RULESET).state;
    }
  });

  it('never proposes a command for a unit that no longer exists', () => {
    // The unit pass re-reads each id from the fold, so a settler consumed by `FoundCity`
    // earlier in the same pass cannot be moved afterwards: a policy that kept the snapshot
    // would propose a `MoveUnit` for a dead id, and the applier would refuse it.
    const ran = drive(59, [SMART_POLICY, SMART_POLICY], 20);
    expect(ran.refusals).toEqual([]);
    expect(ran.applied).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 9. The siege — a city the army has the force for, and one it has not
 * ------------------------------------------------------------------ */

/**
 * The two halves of M7b's siege task, on worlds small enough to read: **the AI storms a
 * walled city when the stack has the force for it, and refuses the same city when it has
 * not.** Same city, same defender, same walls; the only thing that changes is how many
 * archers are standing beside it.
 *
 * Why a hand-built world and not a played-out game: on a `duel` map this AI's two
 * civilizations spend forty turns finding each other, and the question "does it storm a city"
 * would be answered by "it never arrived" — a measurement of the map, not of the decision.
 * These worlds put the army where the decision is, and the decision is what is being
 * measured. The end-to-end numbers (an actual game, against an actual opponent) are in
 * section 6 above and in `scripts/combat-balance-sweep.ts`; these are the mechanism.
 */

/** `Ostia`, the city under siege: four citizens, a granary, walls, and the Pyramids. */
const OSTIA: readonly [number, number] = [20, 20];
const OSTIA_NAME = 'Ostia';
/** The tiles the besiegers stand on — the five beside `OSTIA`, nearest first. */
const SIEGE_POSTS: readonly (readonly [number, number])[] = [
  [21, 20],
  [21, 21],
  [20, 21],
  [19, 21],
  [19, 20],
];

const GRANARY = asBuildingId('granary');
const WALLS = asBuildingId(WALLS_BUILDING);
const PYRAMIDS = asBuildingId('pyramids');
const ARCHER = asUnitTypeId('archer');
const SPEARMAN = asUnitTypeId('spearman');
const WARRIOR = asUnitTypeId('warrior');
const SETTLER = asUnitTypeId('settler');

/** Which world to build: how many besiegers, and what is standing inside the city. */
interface SiegeSpec {
  readonly attackers: number;
  /** The garrison's remaining hit points; `0` leaves the city undefended. */
  readonly garrisonHitPoints: number;
  readonly fortified: boolean;
  /** The garrison's unit type — `spearman` (defence 3) unless a case wants another. */
  readonly defenderType?: UnitTypeId;
  /** The besiegers' type — `archer` (attack 3) unless a case wants another. */
  readonly attackerType?: UnitTypeId;
}

/**
 * Build the siege world: Rome's archers beside Carthage's `Ostia`.
 *
 * Both civilizations get a settler far away so the world is one `newGame` could have
 * produced, and Carthage's settler is parked in a corner where it cannot interfere.
 */
const siegeWorld = (spec: SiegeSpec, ruleset: Ruleset = RULESET): GameState => {
  let builder = createScenarioBuilder(ruleset, { mapSize: 'tiny', civCount: 2, seed: 5 })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .addUnit(0, SETTLER, [2, 2])
    .addUnit(1, SETTLER, [40, 40])
    .addCity(1, OSTIA, {
      name: OSTIA_NAME,
      population: 4,
      foodBox: 5,
      shields: 3,
      buildings: [GRANARY, WALLS, PYRAMIDS],
    });

  if (spec.garrisonHitPoints > 0) {
    builder = builder.addUnit(1, spec.defenderType ?? SPEARMAN, OSTIA, {
      hitPointsLeft: spec.garrisonHitPoints,
      ...(spec.fortified ? { fortified: true } : {}),
    });
  }
  for (let index = 0; index < spec.attackers; index += 1) {
    const post = SIEGE_POSTS[index];
    if (post === undefined) throw new Error(`no siege post ${String(index)}`);
    builder = builder.addUnit(0, spec.attackerType ?? ARCHER, post);
  }

  const built = builder.build();
  if (!built.ok) throw new Error(`the siege world did not build: ${built.error.kind}`);
  return built.value;
};

/** What a siege run saw. */
interface SiegeRun {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly commands: readonly Command[];
  /** The start state, so a revision delta can be stated exactly. */
  readonly start: GameState;
  /**
   * The fold that captured the city: the state before it, the state after it, and the
   * engine's own event. Kept because the city an assault leaves behind is not the city the
   * AI is running three turns later — it re-builds what it lost, which is the AI working,
   * not the capture un-happening.
   */
  readonly capture:
    | {
        readonly event: Extract<GameEvent, { readonly type: 'CityCaptured' }>;
        readonly before: GameState;
        readonly after: GameState;
      }
    | undefined;
}

/**
 * Play `turns` turns of the **shipped policy** for Rome — Carthage does nothing, so every
 * event is this AI's doing. Returns the events, because the evidence for "it attacked the
 * city" is the engine's own `CombatResolved`/`CityCaptured` and not the absence of an error.
 */
const playSiege = (start: GameState, turns: number, ruleset: Ruleset = RULESET): SiegeRun => {
  let state = start;
  const events: GameEvent[] = [];
  const commands: Command[] = [];
  let capture: SiegeRun['capture'];
  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of state.players) {
      if (player.kind !== 'civ') continue;
      const policy = player.id === asPlayerId(0) ? SMART_POLICY : DO_NOTHING_POLICY;
      // The context is built here rather than through `ctxFor` because a siege may be played
      // on a *patched* ruleset (the walls sweep below), and a context that quietly used the
      // shipped one would measure the wrong engine.
      const commandsThisTurn = policy.chooseCommands({
        state,
        playerId: player.id,
        ruleset,
        rng: policyRngFor(5, player.id, state.turn),
      });
      for (const command of commandsThisTurn) {
        const before = state;
        const outcome = applyCommand(state, player.id, command, ruleset);
        if (!outcome.ok) continue;
        commands.push(command);
        events.push(...outcome.value.events);
        state = outcome.value.state;
        const taken = outcome.value.events.find(
          (event): event is Extract<GameEvent, { readonly type: 'CityCaptured' }> =>
            event.type === 'CityCaptured',
        );
        if (taken !== undefined) capture = { event: taken, before, after: state };
      }
    }
    state = advanceTurn(state, RULESET).state;
  }
  return { state, events, commands, start, capture };
};

/**
 * The shipped catalog with **one** combat magnitude moved — the same shape the sweep's
 * `RulesetPatch` produces, validated the same way, so a case that is not a legal ruleset fails
 * here rather than measuring a world the engine could never hold.
 */
const rulesetWithWallsBonus = (wallsBonusPct: number): Ruleset => {
  const validated = validateRuleset(
    { ...CATALOG, combat: { ...CATALOG.combat, wallsBonusPct } },
    'tuned',
  );
  if (!validated.ok) {
    throw new Error(`wallsBonusPct ${String(wallsBonusPct)} did not validate`);
  }
  return validated.value;
};

/** The engine's own per-round odds for one attack that is *not* taken, read off a fold. */
const perRoundOddsAgainst = (spec: SiegeSpec, ruleset: Ruleset = RULESET): number => {
  const world = siegeWorld(spec, ruleset);
  const attacker = world.units.find(
    (unit) =>
      unit.owner === asPlayerId(0) && String(unit.type) === String(spec.attackerType ?? ARCHER),
  );
  if (attacker === undefined) throw new Error('no attacker in the world');
  const outcome = applyCommand(
    world,
    asPlayerId(0),
    {
      type: 'AttackUnit',
      unitId: attacker.id,
      target: tileIndex(world.map.width, OSTIA[0], OSTIA[1]),
    },
    ruleset,
  );
  if (!outcome.ok) return 0;
  const resolved = outcome.value.events.find((event) => event.type === 'CombatResolved');
  return resolved === undefined ? 0 : resolved.attackerWinPct;
};

/** The chance that **at least one** of a group's attacks wins — the siege's own number. */
const groupChance = (chances: readonly number[]): number =>
  100 * (1 - chances.reduce((missed, chance) => missed * (1 - chance / 100), 1));

/**
 * The AI storms a walled city when the **stack** has the force, and the engine takes it.
 *
 * The numbers are printed rather than asserted, because they are the point: a lone archer's
 * true chance against a fortified, walled spearman is well under its own floor, and the same
 * archer in a group of five is not.
 */
it('storms a walled city the stack has the force for, and the city falls', () => {
  const spec: SiegeSpec = { attackers: 5, garrisonHitPoints: 3, fortified: true };
  const perRound = perRoundOddsAgainst(spec);
  const each = exactBattleWinPct(perRound, 3, 3);
  const group = groupChance([each, each, each, each, each]);
  const weights = SMART_WEIGHTS.military;
  console.log(
    `siege (5 archers beside a walled, fortified spearman):\n` +
      `  engine per-round odds ${String(perRound)}% -> each archer's battle win ${String(each)}% ` +
      `(exact rational model), the group of five ${group.toFixed(1)}%\n` +
      `  floors: a soldier attacking alone needs ${String(weights.attackWinFloorVsWalledCityPct)}% ` +
      `(walled city), the group needs ${String(weights.siegeAssaultFloorPct)}%\n` +
      `  force: 5 archers x 3 hit points = 15 against a 3-hit-point garrison ` +
      `(ratio ${String((15 * 100) / 3)}%, needing ${String(weights.siegeForceRatioPct)}%)`,
  );

  const run = playSiege(siegeWorld(spec), 4);
  const battles = run.events.filter((event) => event.type === 'CombatResolved');
  const tile = tileIndex(siegeWorld(spec).map.width, OSTIA[0], OSTIA[1]);

  const outcome =
    run.capture === undefined
      ? 'no capture'
      : `a capture on turn ${String(run.capture.before.turn)}`;
  console.log(`  the assault: ${String(battles.length)} battle(s), then ${outcome}`);

  // The assault happened, it happened at the city, and the engine resolved it as a battle
  // (taking an undefended city would be a capture with no `CombatResolved` at all).
  expect(battles.length).toBeGreaterThanOrEqual(1);
  for (const battle of battles) {
    expect(Number(battle.target)).toBe(Number(tile));
    // The engine's own per-round number for a walled, fortified defender, which is the whole
    // reason a lone archer may not attack and a stack may.
    expect(battle.attackerWinPct).toBe(perRound);
  }

  // The exact outcome, off the engine's own event, at the moment it happened.
  const capture = run.capture;
  expect(capture).toBeDefined();
  if (capture === undefined) return;
  expect(Number(capture.event.cityId)).toBe(0);
  expect(Number(capture.event.tile)).toBe(Number(tile));
  expect(capture.event.name).toBe(OSTIA_NAME);
  expect(capture.event.from).toBe(asPlayerId(1));
  expect(capture.event.to).toBe(asPlayerId(0));
  expect(capture.event.population).toBe(2);
  // Non-wonders destroyed, the wonder not — the engine's own list.
  expect([...capture.event.destroyed].sort()).toEqual(['granary', 'walls'].sort());
  // The revision moves by exactly one for the command that took the city, and by exactly one
  // for every other command that applied: nothing here is a state change outside a command.
  expect(capture.after.revision).toBe(capture.before.revision + 1);
  expect(run.state.revision).toBe(run.start.revision + run.commands.length);

  // And the city the capture left behind: the new owner, half the citizens, the wonder alone,
  // the queue and the worked tiles cleared and the stores the engine says it keeps.
  const after = cityById(capture.after, asCityId(0));
  expect(after?.owner).toBe(asPlayerId(0));
  expect(after?.population).toBe(2);
  expect(after?.buildings).toEqual([PYRAMIDS]);
  expect(after?.name).toBe(OSTIA_NAME);
  expect(after?.tile).toBe(tile);
  expect(after?.foodBox).toBe(5);
  expect(after?.shields).toBe(3);
  expect(after?.queue).toEqual([]);
  expect(after?.workedTiles).toEqual([]);
  expect(after?.production).toBeUndefined();
});

/** The same city, the same walls — and not enough force to take it. */
it('refuses that city when the force is not there, and loses no unit doing it', () => {
  const weights = SMART_WEIGHTS.military;
  const lines: string[] = [];
  for (const attackers of [1, 2]) {
    const spec: SiegeSpec = { attackers, garrisonHitPoints: 3, fortified: true };
    const perRound = perRoundOddsAgainst(spec);
    const each = exactBattleWinPct(perRound, 3, 3);
    const chances = Array.from({ length: attackers }, () => each);
    const group = groupChance(chances);
    lines.push(
      `  ${String(attackers)} archer(s): each ${String(each)}% -> group ${group.toFixed(1)}% ` +
        `(the group floor is ${String(weights.siegeAssaultFloorPct)}%), ` +
        `a soldier alone needs ${String(weights.attackWinFloorVsWalledCityPct)}%`,
    );

    const run = playSiege(siegeWorld(spec), 4);
    // No battle, no capture, and every attacker still standing: the AI declined, and the
    // evidence is the absence of the engine's events rather than the absence of an error.
    expect(run.events.filter((event) => event.type === 'CombatResolved')).toEqual([]);
    expect(run.events.filter((event) => event.type === 'CityCaptured')).toEqual([]);
    expect(
      run.state.units.filter(
        (unit) => unit.owner === asPlayerId(0) && String(unit.type) === String(ARCHER),
      ),
    ).toHaveLength(attackers);

    const city = cityById(run.state, asCityId(0));
    expect(city?.owner).toBe(asPlayerId(1));
    expect(city?.population).toBe(4);
    expect(city?.buildings).toEqual([GRANARY, WALLS, PYRAMIDS]);
  }
  console.log(`refusal (the same walled, fortified spearman, fewer archers):\n${lines.join('\n')}`);
});

/**
 * **The `p`-versus-`p ** needed` bug, pinned where it lived.**
 *
 * `battleWinPctOf` multiplies `p ** needed` into the negative-binomial sum, and an earlier
 * version of it multiplied by `p` — the last hit's probability instead of the whole run of
 * them. The two spellings agree only when the defender has **one** hit point, which is
 * exactly the case a hand-checked example uses, and they diverge violently otherwise: at 30 %
 * per round against three hit points the truth is **16 %** and the old expression answered
 * `181 %`, clamped to `100`. The AI therefore cleared its own floor with units it was about
 * to lose — the one thing this policy is supposed to refuse.
 *
 * The check below is behavioural on purpose. The suite's own oracle used to re-state the
 * policy's accumulator instead of exercising it, and a restatement that is more correct than
 * the original passes while the original is wrong. So the policy is **run** on worlds whose
 * battle the exact rational model prices, and the attack has to be made if and only if that
 * model clears the floor. On the old expression this table fails on every row with a
 * multi-hit-point defender; on this one it holds on all of them, and it would have held on
 * the old code only by accident.
 */
it('attacks exactly when the exact rational model clears the floor, not when its own sum says so', () => {
  const cases: (readonly [UnitTypeId, UnitTypeId, number])[] = [];
  for (const attacker of [WARRIOR, ARCHER]) {
    for (const defender of [WARRIOR, SPEARMAN, ARCHER]) {
      for (const hitPointsLeft of [1, 2, 3]) cases.push([attacker, defender, hitPointsLeft]);
    }
  }

  const floor = SMART_WEIGHTS.military.attackWinFloorPct;
  const rows: string[] = [];
  const wrong: string[] = [];

  for (const [attackerType, defenderType, garrisonHitPoints] of cases) {
    const spec: SiegeSpec = {
      attackers: 1,
      garrisonHitPoints,
      fortified: false,
      attackerType,
      defenderType,
    };
    // The world already puts the one attacker on `SIEGE_POSTS[0]`, beside the one defender,
    // on open grassland with no city anywhere: what is being priced is the open-field floor
    // of `attackWinFloorPct` and nothing else about the map.
    const world = siegeWorld(spec);
    const defender = world.units.find(
      (unit) => unit.owner === asPlayerId(1) && String(unit.type) === String(defenderType),
    );
    if (defender === undefined) throw new Error('the case did not build a defender');
    const attacker = world.units.find(
      (unit) => unit.owner === asPlayerId(0) && String(unit.type) === String(attackerType),
    );
    if (attacker === undefined) throw new Error('the case did not build an attacker');

    const perRound = perRoundOddsAgainst(spec);
    const exact = exactBattleWinPct(perRound, hitPointsLeftOf(attacker), garrisonHitPoints);
    const shouldAttack = exact >= floor;

    const run = playSiege(world, 1);
    const attacked = run.events.some(
      (event) => event.type === 'CombatResolved' && Number(event.target) === Number(defender.tile),
    );
    rows.push(
      `  ${attackerType} (${String(perRound)}%/round) vs ${defenderType} at ` +
        `${String(garrisonHitPoints)} hp: exact ${String(exact)}% -> ` +
        `${shouldAttack ? 'attack' : 'decline'}; the policy ${attacked ? 'attacked' : 'declined'}`,
    );
    if (attacked !== shouldAttack) {
      wrong.push(
        `${attackerType}/${defenderType}/${String(garrisonHitPoints)}: exact=${String(exact)} attacked=${String(attacked)}`,
      );
    }
  }

  console.log(
    `attack floor = ${String(floor)}% (open field), over ${String(cases.length)} worlds:`,
  );
  console.log(rows.join('\n'));
  expect(wrong).toEqual([]);
});

/**
 * **The walls knob is not inert — the sweep's fixture never puts a defender behind a wall.**
 *
 * `scripts/combat-balance-sweep.ts --knob walls-bonus --policy smart` prints a flat table and
 * `NOT EXERCISED — the walls bonus never entered a single odds computation in these runs`, and
 * that sentence is the whole finding: it is a statement about the run set, not about the knob.
 * This is the other half of the proof, and it is the half the flat table cannot give. The same
 * knob, moved over the sweep's own grid, on a world where a defender *is* standing inside its
 * own walled city: the engine's per-round odds move, the AI's own battle maths moves with them,
 * and the **decision flips** — two archers storm at `wallsBonusPct = 0` and decline at the
 * shipped `50`.
 *
 * So the answer to M7's walls question is neither "the knob does nothing" nor "the sweep is
 * broken": the knob works, and it is exercised exactly where a walled city is attacked, which
 * this AI does not reach inside 60 turns of a `duel` map — the sweep reports **0 of 232**
 * battles at a walled city under `--policy smart` (measured 2026-09-12, `--seeds 1..3 --turns
 * 60`: 58 battles per value summed over the four values, and the five cities it takes are all
 * undefended, so no odds are computed for them at all). That number is a **timestamp on the
 * AI's capability, not a constant**: it moves whenever the AI learns to reach a garrisoned,
 * walled city, and the sentence to re-read beside it is the sweep's own EXPOSURE block, which
 * prints the count rather than claiming it here.
 * Measurement, not knob — and here is the measurement that says so.
 */
it('moves the AI\u2019s own battle maths and its decision when the walls knob moves', () => {
  const rows: string[] = [];
  const decisions = new Map<number, boolean>();
  const perRounds: number[] = [];

  for (const wallsBonusPct of [0, 25, 50, 100]) {
    const ruleset = rulesetWithWallsBonus(wallsBonusPct);
    const spec: SiegeSpec = { attackers: 2, garrisonHitPoints: 3, fortified: false };
    const perRound = perRoundOddsAgainst(spec, ruleset);
    const each = exactBattleWinPct(perRound, 3, 3);
    const group = groupChance([each, each]);
    const run = playSiege(siegeWorld(spec, ruleset), 4, ruleset);
    const attacked = run.events.some((event) => event.type === 'CombatResolved');
    decisions.set(wallsBonusPct, attacked);
    perRounds.push(perRound);
    rows.push(
      `  wallsBonusPct=${String(wallsBonusPct).padStart(3)} -> engine per-round ${String(perRound)}%, ` +
        `each archer ${String(each)}%, the pair ${group.toFixed(1)}% ` +
        `(group floor ${String(SMART_WEIGHTS.military.siegeAssaultFloorPct)}%) -> ` +
        (attacked ? 'STORM' : 'decline'),
    );
  }
  console.log(
    `the walls knob, on a world where a defender stands inside its own walls:\n${rows.join('\n')}`,
  );

  // The knob is wired into the engine's odds: four values, and the odds are not all the same.
  expect(new Set(perRounds).size).toBeGreaterThan(1);
  // It is wired into the **decision** too: the pair storms at one value and declines at another.
  expect(new Set([...decisions.values()]).size).toBe(2);
});

/* ------------------------------------------------------------------ *
 * 10. Identity, and the control
 * ------------------------------------------------------------------ */

describe('M7 — the policy identifies itself and the control stays silent', () => {
  it('keeps a stable name, and a patched copy is the same policy', () => {
    expect(SMART_POLICY.name).toBe(SMART_POLICY_NAME);
    expect(SMART_POLICY.name).not.toBe(DO_NOTHING_POLICY.name);
    expect(smartPolicy({}).name).toBe(SMART_POLICY.name);
    expect(smartPolicy().chooseCommands).toBeTypeOf('function');
  });

  it('leaves the baseline silent, so the comparison has a control', () => {
    const started = newGame(7, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    expect(DO_NOTHING_POLICY.chooseCommands(ctxFor(started.value, asPlayerId(0)))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 11. Fixture sanity, so a rename upstream fails loudly here
 * ------------------------------------------------------------------ */

describe('M7 — the fixtures still describe the shipped content', () => {
  it('has the walls row, a settler and a real start tile', () => {
    expect(CATALOG.buildings.some((row) => String(row.id) === String(WALLS_BUILDING))).toBe(true);
    const started = newGame(7, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const settler = started.value.units.find(
      (unit) => unit.owner === asPlayerId(0) && unitDef(RULESET, unit.type)?.role === 'settler',
    );
    expect(settler).toBeDefined();
    const start = started.value.players.find((player) => player.id === asPlayerId(0))?.startingTile;
    expect(start).toBeDefined();
    if (start !== undefined) {
      expect(Number(start)).toBeGreaterThanOrEqual(0);
      expect(Number(start)).toBeLessThan(started.value.map.terrain.length);
    }
  });

  it('can build a blocked board, so that totality fixture is real', () => {
    const started = newGame(19, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const mine = started.value.units.find((unit) => unit.owner === asPlayerId(0));
    if (mine === undefined) throw new Error('no starting unit');
    expect([...neighbors8(started.value.map, mine.tile)].length).toBeGreaterThan(0);
    // The city lookup the walls walk uses is the engine's, and it answers `undefined` for a
    // tile nobody settled — which is the branch a battle in the open takes.
    expect(cityById(started.value, asCityId(0))).toBeUndefined();
  });
});
