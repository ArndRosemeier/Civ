/**
 * M7 adversarial review (A4: integration owner, then adversarial verification) — an
 * attempt to **falsify** the frozen M7 contracts in docs/INTERFACES.md ("M7 contracts —
 * FROZEN (a real opponent, and self-play)"), not to confirm them.
 *
 * It starts from the code on disk rather than from the prose, and it is deliberately
 * independent of `packages/sim/test/ai.test.ts` and
 * `packages/sim/test/tournament.test.ts`: those two are the *authors'* evidence, and a
 * review that re-runs the author's own helpers has verified nothing but the helpers. Every
 * number below is measured here, by code written here, and printed — so a reader sees the
 * evidence rather than a claim about it.
 *
 * ## What this file attacks, and what it found
 *
 * 1. **THE AI PLAYS A LEGAL GAME.** Over three seeds and sixteen turns, every command the
 *    real policy returns is folded through the real `applyCommand` and the refusal list must
 *    be **empty** — the M2 keystone property, applied to the AI. A second, sharper layer is
 *    audited at the same time: every command must also be one the engine's legality
 *    advertises (`legalActions`) or one whose own planner accepts it, so "the applier
 *    happened to take it" is not the whole story. **NO FINDING**: zero refusals, zero
 *    unadvertised commands, and the commands outside `legalActions` are exactly the four
 *    planner-only setters M3/M4b/M5 established — pinned by name, so a fifth is a failure
 *    rather than a footnote.
 *
 * 2. **THE AI IS ACTUALLY PLAYING.** The do-nothing baseline is reproduced here, the AI is
 *    compared against it per seed on stated metrics, and the AI's own pathologies are
 *    hunted: a seed where it settles nowhere, builds nothing, starves every city, or
 *    bankrupts itself by choice. **NO FINDING** on any of the four: it beats the baseline on
 *    every seed by every stated metric, and no seed in the hunted set showed any pathology.
 *    The counts are printed, because "no pathology found" is worth something only beside the
 *    numbers it was looked for in. The hunt was then widened — twelve more seeds, and a
 *    longer horizon on the seeds that look worst — and the wider hunt found something the
 *    first one could not see: **FINDING F**, an expansion that ignores the AI's own city
 *    target. It is a defect in the *opposite* direction from the four above (not a passive
 *    AI, an unbounded one), it breaks no invariant, and it is the root cause of FINDING E's
 *    runtime, so it is recorded as an expected failure rather than buried.
 *
 * 3. **AI INDEPENDENCE FROM THE WORLD RNG.** The M5 property proved directly rather than by
 *    inspection: the real policy is handed six differently-advanced copies of the world's
 *    RNG and four unrelated streams of its own, and must answer identically; and a whole
 *    game is replayed with **every policy's context scrambled** and must be byte-identical
 *    (hash and world-RNG trail). The **converse** is proved non-vacuous: a twin that reads
 *    `state.rng` is caught by the same probe and changes the game when it is played. **NO
 *    FINDING** on the AI; the detector fires on the twin, which is the point. Two things the
 *    measurement refused to support are recorded instead of asserted: the world's RNG trail
 *    is *not* a usable detector (the stream only moves when the engine has a reason to draw,
 *    so a quiet game's trail is constant whoever is playing), and the milestone's own
 *    independence check is blind to a read of the world's stream — **FINDING D**.
 *
 * 4. **DETERMINISM.** Identical seeds and policies give identical hashes and identical
 *    aggregates in-process (and, full tier, in a fresh process); aggregates are unchanged
 *    when the seed list is permuted; the seat rotation is real — `seatPlan`'s rule, and a
 *    tournament whose two seatings of the *same* seed produce different games, which is what
 *    "a policy that only wins from seat 0 has not been tested" means.
 *
 * 5. **ZERO VIOLATIONS IS REAL.** The twenty-seed tournament (full tier) must report zero
 *    violations — and the violation path must actually FAIL a tournament when one occurs,
 *    checked twice: by injecting a broken invariant into the harness, and by driving the real
 *    CLI's `--fault` self-test end to end. A pass condition that has never failed is
 *    decoration.
 *
 * 6. **BUDGET HONESTY.** The clock is read exactly twice, `elapsedMs` is what the clock said,
 *    a run judged against a budget it exceeds says so, the **seed set is never trimmed to
 *    fit**, and a clock that goes backwards is refused rather than turned into a plausible
 *    verdict. `HOST_CLOCK`'s reading is compared against wall time measured independently.
 *
 * 7. **SWEEPABILITY.** One AI weight is swept with a measured effect on outcomes, and the
 *    "magnitudes live in one place" claim is checked **mechanically**: the AI's decision code
 *    is scanned for bare numeric literals and for `process.*` reads, and the weights module is
 *    checked field for field for every weight being reachable from a patch. **TWO FINDINGS,
 *    both in the AI's own files** — FINDING B and FINDING C below.
 *
 * 8. **TOURNAMENT SCALE.** The twenty seeds A3 names are run, and the wall time, invariant
 *    count and budget verdict are reported (full tier). The alpha-scale *CLI* run at A3's own
 *    size (twenty seeds, a hundred turns — asked for with `--seeds 1..20 --turns 100`, since
 *    M7b made the CLI's plain default a two-game smoke run; see `scripts/tournament-evidence.ts`)
 *    was measured outside the suite, and its figures are kept in **one** place: the exported
 *    `A3_TOURNAMENT_EVIDENCE` record in `@civts/sim`'s `tournament.ts`, which this file imports
 *    and section 8's second test validates. The measurement that raised FINDING E (*"3.4× the
 *    per-game time its own comment documents"*) is the reason that record exists: the same figure
 *    had been copied into five files, went stale in all five when the AI got slower, and was
 *    re-recorded once instead of five times.
 *
 * 9. **MUTATION-CHECK THE GATE.** Both mutations were run against the shipped `smart.ts` and
 *    both were watched: the illegal-command mutant turned this file's refusal counter and
 *    `ai.test.ts` RED; the world-stream-reading mutant turned this file's probe RED and left
 *    `ai.test.ts` green, which is FINDING D. The mutant policy in section 1 makes the
 *    legality detector permanently non-vacuous, the restoration was proved by SHA-256, and the
 *    transcript is in section 9's comment.
 *
 * ## The findings, stated once
 *
 * **FINDING A — the CLI's `tournament` command was implemented and unreachable, and is now
 * wired.** `sim-cli.ts` shipped `runTournamentCommand` with its own tests, the M7 contract
 * requires "a `tournament` command alongside `sim`", and `cli.ts`'s dispatcher had no case for
 * it: `civts tournament …` answered `unknown command: tournament` and exited 2, while
 * `civts run` (PLAN.md §8.1's name for the same self-play game) still printed "the M7
 * self-play harness is not built yet". The command was reachable only by importing it in a
 * test. This review wired it (`cli.ts`: `commandTournament`, the `tournament` case, `run`
 * routed to the same handler, both documented in `USAGE`), and section 5's CLI check is the
 * regression test that would have caught it. It is the milestone's only *integration* defect,
 * and exactly the kind a suite that only tests the command function cannot see.
 *
 * **FINDING B — a leftover debug hook in the AI's hot decision path; it is GONE.**
 * `packages/sim/src/ai/smart.ts:1009-1014` read `process.env['DSH_AI_TRACE']` inside
 * `chooseProduction` and, when an undocumented environment variable happened to be set, wrote a
 * trace line to stdout — the file's only `eslint-disable`, and an *unused* one, which is how it
 * announced itself in `pnpm lint`'s warning stream (`warning Unused eslint-disable directive`).
 * Two rules this milestone is held to say it should not be there: the AI's decisions must be a
 * pure function of `(state, ruleset, its own stream)`, and an environment read is an ambient
 * input nobody declared; and `src/` may carry no `eslint-disable`. It is removed here, together
 * with the `trace` accumulator that existed only to feed it (dead code once the hook was gone),
 * and section 7 now fails if any `process.*` read returns to the AI's decision code. The removal
 * is behaviour-preserving: the hook printed and returned nothing, and every AI test is green
 * afterwards without a single edited expectation.
 *
 * **FINDING C — a documented mechanism that does not exist, PINNED rather than repaired.**
 * `packages/sim/src/ai/weights.ts:43-47` says *"`SMART_WEIGHT_PATHS` lists every knob as a dotted
 * path, and `ai.test.ts` asserts it is **complete**"*. No such export exists anywhere in the
 * repository — the identifier appears exactly once, inside that comment — so the completeness
 * guarantee the standing requirement asks for ("sweepability is only checkable if the set of
 * knobs is enumerable") is documented and unimplemented. Section 7 supplies the missing check
 * (`mergeSmartWeights` must name every field of every group, asserted field for field against
 * the defaults) and pins the documentation claim, so that implementing the real thing fails a
 * test and forces the comment to be corrected with it. A fabricated finding would be worse
 * than an empty report, so this one is stated for what it is: a comment promising a mechanism
 * the code does not have.
 *
 * **FINDING D — the milestone's own independence test does not test what its comment says, and
 * a mutation proves it.** `ai.test.ts` ("takes its own stream and never reads the world RNG
 * while deciding", part (b), `packages/sim/test/ai.test.ts:297-298` and the loop at 323-336) says
 * it hands the policy *"any stream at all"* and concludes *"what the property rests on is that
 * the policy cannot read the stream, and that is what is asserted"* — but the code varies only
 * `policyRngFor(seed + offset, …)`, the policy's **own** stream, and passes `state` through
 * untouched, so the **world** stream inside that state never moves. This review's mutation check
 * found the gap the hard way: `smart.ts` was edited to `if (ctx.state.rng.a % 2 !== 0) return []`
 * — a policy that reads the world's stream and acts on it — and `ai.test.ts` stayed **GREEN**,
 * while this file's probe (section 3a) and the reproduction in section 3d went RED. The test is
 * not false: own-stream independence really is proven by the code that runs. What is false is the
 * comment's claim to have covered the world's stream, and an assertion that cannot fail on the
 * failure it names is the kind of evidence this review exists to catch. Two smaller prose/code
 * mismatches sit in the same comment — it says "six different streams, in four different states
 * of the same game" where the loop uses four own-stream offsets over three turns — which is the
 * same drift seen from the outside. The fix is one line in that loop (vary
 * `state: { ...state, rng: advanced(state.rng, offset) }` as well as the policy's stream);
 * section 3 proves the property properly, and section 3d prints the author-style probe's blind
 * spot beside this file's, so the gap is visible in the log rather than merely described.
 *
 * **FINDING E — the tournament's own runtime figure is stale.** The
 * experiment this measures is A3's — twenty seeds of a hundred turns, which was the CLI's
 * default when this review ran and is now asked for with `--seeds 1..20 --turns 100` (M7b;
 * `scripts/tournament-evidence.ts` is the reproducible home for it) — and `tournament.ts`
 * (lines 293-294) recorded it as *"about 7.7 s per game on an idle machine, so ~2.6 minutes for
 * the twenty"* when this review measured 527.3 s wall / 26.4 s per game / 8.8 minutes for the
 * twenty: **3.4× stale**, with the run itself reporting its time honestly to 0.1 % of an
 * external clock and exiting 0.
 *
 * **The finding's sequel is the one worth keeping.** M7b corrected that arithmetic in the
 * module comment — and then the AI got smarter and 1.66× slower, and the same figure was stale
 * again, in five files at once, all of which had copied it by hand. So the wave that follows
 * fixed the *class* rather than the instances: the measured cost, the bound and the headroom
 * now live in one exported value, `A3_TOURNAMENT_EVIDENCE`, which this file imports — see
 * section 8, whose guard test fails if any of those sites starts restating a figure again.
 * Nothing about the *behaviour* was ever wrong, which is what FINDING F below is about.
 *
 * **FINDING F — the AI's city target is a rank demotion, not a cap, and it expands without
 * bound.** `weights.ts:368-375` says the AI *"builds settlers to reach `settlement.targetCities`
 * and no further, because the expensive failure it is guarding against is a settler that cannot
 * found anywhere"*, and `smart.ts:889-901` implements the cap by demoting a settler to
 * `fillerPriority` once `empire.cities + empire.settlers + settlersUnderConstruction ≥ wanted`.
 * Filler priority is a **rank, not a veto**: when a city has nothing better on offer it still
 * produces the settler, the settler founds a city, and the new city does the same thing on the
 * next turn. Measured through the real engine with the real policy in both seats:
 *
 *   seed 20, tiny, 2 civs, `targetCities = 5`, both seats `smart`
 *     turn 21:  civ0 5 cities, civ1 5 cities
 *     turn 31:  civ0 5 cities, civ1 12 cities
 *     turn 41:  civ0 5 cities, civ1 28 cities
 *     turn 100: civ0 3 cities, civ1 54 cities — `CityFounded` events owned by civ 1: **77**
 *
 *   and the instrumented decision path at turn 30 (a temporary edit, reverted, SHA-256 verified)
 *   shows what civ 1's cities were deciding: `cities=12 wanted=5 expanding=false priorityUsed=1
 *   supportRoom=false` — the settler is ranked as *filler* in every one of twelve cities that
 *   already hold more than the target. Nine of the twenty alpha seeds do this; my independent
 *   100-turn survey reproduces the CLI report's own seat totals exactly (114 cities for seat 0
 *   against 297 for seat 1, a factor of 2.6), so that asymmetry is this defect and not a seat
 *   advantage.
 *
 * Consequences, in order of how much they matter: those games cost 20-40× a capped game (seed 8
 * took 170 s of the 527 s alpha run, against 3-9 s for a normal 100-turn game — figures from the
 * M7-wave run, quoted here as the *shape* of the cost; the current cost of the whole experiment
 * is in `A3_TOURNAMENT_EVIDENCE`), which is the root
 * cause of FINDING E; the AI's own documented weight semantics are not achieved at any horizon
 * longer than about twenty turns; and a tournament's per-seat aggregates are dominated by
 * whichever seat happened to run away. None of it breaks an invariant, an engine rule or a
 * determinism property — the milestone's own pass conditions are genuinely met — which is exactly
 * why it took a wider hunt and an instrumented run to see it. Section 2 records it as an
 * **expected failure** in both tiers, so it is visible in every run of the gate and flips to red
 * the moment someone fixes it.
 *
 * ## What is deliberately NOT claimed
 *
 * Nothing here claims the AI plays *well*: it claims the AI plays, legally, deterministically,
 * without touching the world's randomness, measurably better than doing nothing, and that its
 * preferences are all in one place. Whether its preferences are *good* is a balance question
 * and its answer is a sweep, not a test. Nor is any of this a Civ 3 figure: every magnitude
 * the AI reads is a `placeholder`, and this file treats them as such.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  advanceTurn,
  applyCommand,
  asPlayerId,
  citiesOf,
  civPlayers,
  legalActions,
  newGame,
  nextUint32,
  planSetProduction,
  planSetRates,
  planSetResearch,
  planSetWorkedTiles,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Result,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { FULL_TIER, canonicalize, hashValue } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  A3_TOURNAMENT_EVIDENCE,
  CORE_INVARIANTS,
  DEFAULT_TOURNAMENT_BUDGET_MS,
  DO_NOTHING_POLICY,
  HOST_CLOCK,
  SMART_POLICY,
  SMART_POLICY_NAME,
  SMART_WEIGHTS,
  SMART_WEIGHT_GROUPS,
  mergeSmartWeights,
  policyRngFor,
  runBatch,
  runSimulation,
  runTournament,
  seatPlan,
  smartPolicy,
  tournamentVerdict,
  type Invariant,
  type Policy,
  type PolicyContext,
  type TournamentClock,
  type TournamentOptions,
  type TournamentResult,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * Fixtures — the shipped content, one world shape for every measurement
 * ------------------------------------------------------------------ */

/** The real, validated content every game in this file is played on. */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error
        .map((issue) => issue.kind)
        .join(', ')}`,
    );
  }
  return validated.value;
})();

/**
 * One world shape for every measurement here: the smallest map the AI has room to expand on,
 * with the smallest legal civilization count. A review that measured different claims on
 * different worlds could not compare them.
 */
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 };

/** `rows[i]`, or a loud failure rather than a `!` (`noUncheckedIndexedAccess` in tests too). */
const at = <T>(rows: readonly T[], index: number): T => {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`the fixture has no row ${String(index)} of ${String(rows.length)}`);
  }
  return row;
};

/** The civilization at `playerId`, or a loud failure. */
const playerRow = (state: GameState, playerId: PlayerId): GameState['players'][number] => {
  const row = state.players.find((player) => player.id === playerId);
  if (row === undefined) {
    throw new Error(`player ${String(playerId)} is not in this state`);
  }
  return row;
};

/* ------------------------------------------------------------------ *
 * The walk — one game, played by hand through the real engine
 * ------------------------------------------------------------------ */

/** What one hand-driven game saw. */
interface Walk {
  readonly label: string;
  readonly seed: number;
  readonly turns: number;
  readonly state: GameState;
  readonly hash: string;
  /** Commands the policy returned, `EndTurn` included. */
  readonly proposed: number;
  /** Commands the applier accepted. */
  readonly applied: number;
  /** `EndTurn` commands the policy returned, which the runner drops by design. */
  readonly endTurns: number;
  /** Every refusal, rendered — **one entry here is the headline finding of section 1**. */
  readonly refusals: readonly string[];
  /** Commands neither advertised by `legalActions` nor accepted by their own planner. */
  readonly unadvertised: readonly string[];
  /** Planner-only setters the policy issued, by type, ascending (never a `Record`). */
  readonly plannerOnly: readonly (readonly [string, number])[];
  /** The world's RNG state after each turn, as `canonicalize` spells it. */
  readonly trail: readonly string[];
  /** Player 0's treasury at the start of the game and after every turn. */
  readonly treasuryTrail: readonly number[];
  /** Player 0's city count at the start of the game and after every turn. */
  readonly cityTrail: readonly number[];
  readonly events: readonly GameEvent[];
}

/**
 * Play `turns` turns of `seed` with `policy` in every civilization's seat, through the
 * **real** `applyCommand` and the real `advanceTurn`, polling exactly the way
 * `runSimulation` does (`player-id` order, one turn of world time per iteration).
 *
 * A hand driver rather than `runSimulation` because the frozen `SimulationResult` has no
 * field for a refusal, no per-turn world-RNG trail, and no record of *which* legality the
 * policy used — and those three are what sections 1 and 3 are about. `audit` adds the
 * legality layer; the advertised set is rebuilt from the state **before each command**,
 * because the policy chains steps (a settler's second step is legal only after its first has
 * landed, so auditing against the turn's opening state would flag the AI's normal behaviour
 * as illegal).
 */
const walk = (seed: number, policy: Policy, turns: number, audit: boolean): Walk => {
  const started = newGame(seed, SETTINGS, RULESET);
  if (!started.ok) {
    throw new Error(`newGame refused seed ${String(seed)}: ${started.error.kind}`);
  }

  let state = started.value;
  const refusals: string[] = [];
  const unadvertised: string[] = [];
  const plannerOnly = new Map<string, number>();
  const trail: string[] = [canonicalize(state.rng)];
  const treasuryTrail: number[] = [playerRow(state, asPlayerId(0)).treasury];
  const cityTrail: number[] = [citiesOf(state, asPlayerId(0)).length];
  const events: GameEvent[] = [];
  let proposed = 0;
  let applied = 0;
  let endTurns = 0;

  for (let step = 0; step < turns; step += 1) {
    for (const player of civPlayers(state)) {
      const ctx: PolicyContext = {
        state,
        playerId: player.id,
        ruleset: RULESET,
        rng: policyRngFor(seed, player.id, state.turn),
      };

      for (const command of policy.chooseCommands(ctx)) {
        proposed += 1;
        // The runner owns the turn boundary and drops a policy's `EndTurn` (runner.ts,
        // decision 3). This driver does the same, and counts the drop so it is visible.
        if (command.type === 'EndTurn') {
          endTurns += 1;
          continue;
        }

        if (audit) {
          const advertised = new Set(
            [...legalActions(state, RULESET, player.id)].map((action) => canonicalize(action)),
          );
          if (!advertised.has(canonicalize(command))) {
            const planner = plannerVerdict(state, player.id, command);
            if (planner === undefined) {
              unadvertised.push(`${command.type}: not advertised, and no planner owns it`);
            } else if (!planner.ok) {
              unadvertised.push(
                `${command.type}: advertised nowhere, planner refused (${planner.kind})`,
              );
            } else {
              plannerOnly.set(command.type, (plannerOnly.get(command.type) ?? 0) + 1);
            }
          }
        }

        const outcome = applyCommand(state, player.id, command, RULESET);
        if (!outcome.ok) {
          refusals.push(`${command.type} refused: ${canonicalize(outcome.error)}`);
          continue;
        }
        state = outcome.value.state;
        events.push(...outcome.value.events);
        applied += 1;
      }
    }

    const advanced = advanceTurn(state, RULESET);
    state = advanced.state;
    events.push(...advanced.events);
    trail.push(canonicalize(state.rng));
    treasuryTrail.push(playerRow(state, asPlayerId(0)).treasury);
    cityTrail.push(citiesOf(state, asPlayerId(0)).length);
  }

  return {
    label: `${policy.name}@${String(seed)}`,
    seed,
    turns,
    state,
    hash: hashValue(state),
    proposed,
    applied,
    endTurns,
    refusals,
    unadvertised,
    plannerOnly: [...plannerOnly.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    ),
    trail,
    treasuryTrail,
    cityTrail,
    events,
  };
};

/**
 * The verdict of the planner that owns a setter command, or `undefined` when no planner owns
 * it.
 *
 * The four setters are **planner-only** by an established, documented decision — M3 for
 * `SetWorkedTiles`/`SetProduction`, M4b for `SetRates`, M5 for `SetResearch` — and the
 * project's rule is that legality is stated once, in the planner, with the generator left
 * silent. So the honest audit is not "is it in `legalActions`" but "is it in `legalActions`
 * **or** does the planner that owns it accept it". Anything else is a command the AI
 * invented, which is the finding this function exists to produce.
 */
const plannerVerdict = (
  state: GameState,
  playerId: PlayerId,
  command: Command,
): { readonly ok: boolean; readonly kind: string } | undefined => {
  switch (command.type) {
    case 'SetWorkedTiles':
      return normalizePlan(planSetWorkedTiles(state, playerId, command.cityId, command.tiles));
    case 'SetProduction':
      return normalizePlan(
        planSetProduction(state, RULESET, playerId, command.cityId, command.item),
      );
    case 'SetRates':
      return normalizePlan(planSetRates(state, RULESET, playerId, command.rates));
    case 'SetResearch':
      return normalizePlan(planSetResearch(state, RULESET, playerId, command.tech));
    default:
      return undefined;
  }
};

/**
 * A planner's `Result` reduced to the two things this audit reports: did it accept, and if not,
 * why. Normalised here rather than returned as a `Result`, because the four planners have four
 * different success payloads and the payload is not what is being checked — the *verdict* is.
 */
const normalizePlan = (outcome: Result<unknown, GameError>): { ok: boolean; kind: string } =>
  outcome.ok ? { ok: true, kind: 'accepted' } : { ok: false, kind: outcome.error.kind };

/* ------------------------------------------------------------------ *
 * The shared evidence table — three walks, reused by four sections
 * ------------------------------------------------------------------ */

/**
 * How many turns the shared AI walks play.
 *
 * Measured, not guessed: one `tiny`/2-civ game of AI play costs roughly 0.1 s per turn in
 * this process, so three seeds × sixteen turns is a few seconds of the fast tier, and the
 * horizon is long enough for settlement, tile assignment, production, research and the money
 * loop to have all run — sections 1 and 2 assert that each of those *happened*, so a shorter
 * horizon would make the claims vacuous rather than cheap.
 */
const WALK_TURNS = 16;

/** The seeds the shared walks use, ascending. Reused rather than re-run. */
const SEEDS: readonly number[] = [7, 23, 41];

let aiWalksCache: readonly Walk[] | undefined;
let idleWalksCache: readonly Walk[] | undefined;

/** The real AI's walks — computed once, used by sections 1, 2 and 3. */
const aiWalks = (): readonly Walk[] => {
  aiWalksCache ??= SEEDS.map((seed) => walk(seed, SMART_POLICY, WALK_TURNS, true));
  return aiWalksCache;
};

/** The control's walks — a policy that returns nothing at all, so it can only advance turns. */
const idleWalks = (): readonly Walk[] => {
  idleWalksCache ??= SEEDS.map((seed) => walk(seed, DO_NOTHING_POLICY, WALK_TURNS, false));
  return idleWalksCache;
};

/** The AI's walk of `seed`, or a loud failure. */
const aiWalkOf = (seed: number): Walk => {
  const found = aiWalks().find((run) => run.seed === seed);
  if (found === undefined) throw new Error(`no shared walk for seed ${String(seed)}`);
  return found;
};

/** What a finished game looks like from one seat, read straight off the final state. */
interface Standing {
  readonly cities: number;
  readonly population: number;
  readonly techs: number;
  readonly units: number;
  readonly buildings: number;
  readonly treasury: number;
}

const standingOf = (state: GameState, playerId: PlayerId): Standing => {
  const cities = citiesOf(state, playerId);
  const mine = state.units.filter((unit) => unit.owner === playerId);
  return {
    cities: cities.length,
    population: cities.reduce((total, city) => total + city.population, 0),
    techs: playerRow(state, playerId).techs.length,
    units: mine.length,
    buildings: cities.reduce((total, city) => total + city.buildings.length, 0),
    treasury: playerRow(state, playerId).treasury,
  };
};

const standingLine = (label: string, seed: number, seat: Standing): string =>
  `${label} seed ${String(seed)}: cities=${String(seat.cities)} pop=${String(seat.population)} ` +
  `techs=${String(seat.techs)} units=${String(seat.units)} buildings=${String(seat.buildings)} ` +
  `gold=${String(seat.treasury)}`;

/** Events of one kind, optionally owned by `playerId`. */
const countEvents = (
  events: readonly GameEvent[],
  kind: GameEvent['type'],
  owner?: PlayerId,
): number =>
  events.filter((event) => {
    if (event.type !== kind) return false;
    if (owner === undefined) return true;
    return 'owner' in event && event.owner === owner;
  }).length;

/* ------------------------------------------------------------------ *
 * 1. THE AI PLAYS A LEGAL GAME
 * ------------------------------------------------------------------ */

describe('1. every command the real AI issues is one the engine accepts', () => {
  // Full tier (M7b): measured at 5.6 s by vitest's per-file reporter — a walk of three seeds
  // for `WALK_TURNS` turns with `legalActions` audited on every command. The keystone claim is
  // kept, not dropped: `pnpm verify:full` runs it and the fast run names it as skipped.
  it.skipIf(!FULL_TIER)(
    'has zero refusals and zero unadvertised commands, over seeds and turns',
    () => {
      const walks = aiWalks();
      const refusals = walks.flatMap((run) => run.refusals.map((line) => `${run.label}: ${line}`));
      const unadvertised = walks.flatMap((run) =>
        run.unadvertised.map((line) => `${run.label}: ${line}`),
      );
      const proposed = walks.reduce((total, run) => total + run.proposed, 0);
      const applied = walks.reduce((total, run) => total + run.applied, 0);
      const plannerOnly = new Map<string, number>();
      for (const run of walks) {
        for (const [kind, count] of run.plannerOnly) {
          plannerOnly.set(kind, (plannerOnly.get(kind) ?? 0) + count);
        }
      }

      console.log(
        `1. legality: seeds=${SEEDS.join(',')} turns=${String(WALK_TURNS)} proposed=${String(
          proposed,
        )} applied=${String(applied)} refusals=${String(refusals.length)} unadvertised=${String(
          unadvertised.length,
        )} planner-only=${JSON.stringify([...plannerOnly.entries()].sort())}`,
      );

      // **The headline claim.** A refusal means the AI issued an order the engine rejects.
      expect(
        refusals,
        `the AI issued commands the applier refused:\n${refusals.join('\n')}`,
      ).toEqual([]);
      expect(
        unadvertised,
        `the AI issued commands no legality advertises:\n${unadvertised.join('\n')}`,
      ).toEqual([]);

      // Non-vacuity: a policy that proposed nothing would pass both assertions above.
      expect(
        proposed,
        'the AI proposed nothing at all, so the checks above proved nothing',
      ).toBeGreaterThan(100);
      expect(applied).toBe(proposed);

      // The commands outside `legalActions` are exactly the four planner-only setters, by
      // name. A fifth would be a **new** class of unadvertised command, which is the thing this
      // assertion exists to refuse to overlook.
      expect([...plannerOnly.keys()].sort()).toEqual([
        'SetProduction',
        'SetRates',
        'SetResearch',
        'SetWorkedTiles',
      ]);
      // And each one really was issued: a pinned list that was always empty would be a promise
      // about code paths nobody ran.
      for (const [kind, count] of plannerOnly) {
        expect(
          count,
          `the AI never issued ${kind}, so its planner check is untested`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it('is the same game the shipped runner plays, so this driver measures the shipped loop', () => {
    // The driver above is this file's own code. If it differed from `runSimulation` — a
    // different poll order, a different `EndTurn` rule, a command applied twice — every other
    // claim in this file would be about the driver rather than about the engine.
    const seed = at(SEEDS, 0);
    const mine = aiWalkOf(seed);
    const theirs = runSimulation({
      seed,
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: WALK_TURNS,
    });
    console.log(`1. driver vs runner: hand ${mine.hash} vs runSimulation ${theirs.finalHash}`);
    expect(mine.hash).toBe(theirs.finalHash);
    expect(mine.turns).toBe(theirs.turnsPlayed);
    expect(mine.applied).toBeGreaterThan(0);
  });

  it('catches a policy that issues one illegal command — the counter is not vacuous', () => {
    // The in-suite half of the mutation check: a twin of the real policy that appends one
    // illegal `MoveUnit`. If the refusal counter above could not see this, "zero refusals"
    // would be an empty claim.
    const started = newGame(at(SEEDS, 0), SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const doomed = at(started.value.units, 0);
    const mutant: Policy = {
      name: 'mutant-one-illegal-command',
      chooseCommands: (ctx: PolicyContext): readonly Command[] => [
        ...SMART_POLICY.chooseCommands(ctx),
        // A step to the tile it already stands on: `distance8` is 0, so `planMove` refuses
        // it, and for the other player it is not even that player's unit. Either refusal is
        // enough — the point is that the command is not legal.
        { type: 'MoveUnit', unitId: doomed.id, to: doomed.tile },
      ],
    };
    const ran = walk(at(SEEDS, 0), mutant, 3, false);
    console.log(
      `1. mutant: ${String(ran.refusals.length)} refusals, first: ${ran.refusals[0] ?? '—'}`,
    );
    expect(ran.refusals.length).toBeGreaterThan(0);
    expect(ran.refusals.join('\n')).toContain('MoveUnit refused');
  });

  // The fast tier's three seeds exercise settlement, production, research and combat. The
  // full tier adds a five-civilization crowd, which is where a policy that assumes room to
  // move breaks.
  it.skipIf(!FULL_TIER)('stays legal on a crowded map with five civilizations (full tier)', () => {
    const crowded: Settings = { ...DEFAULT_SETTINGS, mapSize: 'small', civCount: 5 };
    const policies = Array.from({ length: 5 }, () => SMART_POLICY);
    let refusals = 0;
    let proposed = 0;
    for (const seed of [3, 11, 29, 57]) {
      const started = newGame(seed, crowded, RULESET);
      if (!started.ok) throw new Error('newGame refused');
      let state = started.value;
      for (let step = 0; step < 12; step += 1) {
        for (const player of civPlayers(state)) {
          const ctx: PolicyContext = {
            state,
            playerId: player.id,
            ruleset: RULESET,
            rng: policyRngFor(seed, player.id, state.turn),
          };
          const policy = at(policies, Number(player.id) % policies.length);
          for (const command of policy.chooseCommands(ctx)) {
            proposed += 1;
            if (command.type === 'EndTurn') continue;
            const outcome = applyCommand(state, player.id, command, RULESET);
            if (!outcome.ok) {
              refusals += 1;
              continue;
            }
            state = outcome.value.state;
          }
        }
        state = advanceTurn(state, RULESET).state;
      }
    }
    console.log(
      `1. crowded legality (full tier): ${String(proposed)} proposed, ${String(refusals)} refused`,
    );
    expect(refusals).toBe(0);
    expect(proposed).toBeGreaterThan(200);
  });
});

/* ------------------------------------------------------------------ *
 * 2. THE AI IS ACTUALLY PLAYING
 * ------------------------------------------------------------------ */

describe('2. the AI beats doing nothing, and shows no pathological game', () => {
  it('beats the do-nothing baseline on every seed by every stated metric', () => {
    const lines: string[] = [];
    const wins = { cities: 0, population: 0, techs: 0, units: 0, buildings: 0, treasury: 0 };
    const total = { ai: 0, idle: 0 };

    for (const ai of aiWalks()) {
      const idle = idleWalks().find((run) => run.seed === ai.seed);
      if (idle === undefined) throw new Error(`no idle control for seed ${String(ai.seed)}`);
      const mine = standingOf(ai.state, asPlayerId(0));
      const theirs = standingOf(idle.state, asPlayerId(0));
      lines.push(standingLine('  ai  ', ai.seed, mine));
      lines.push(standingLine('  idle', idle.seed, theirs));

      if (mine.cities > theirs.cities) wins.cities += 1;
      if (mine.population > theirs.population) wins.population += 1;
      if (mine.techs > theirs.techs) wins.techs += 1;
      if (mine.units > theirs.units) wins.units += 1;
      if (mine.buildings > theirs.buildings) wins.buildings += 1;
      if (mine.treasury > theirs.treasury) wins.treasury += 1;
      total.ai += mine.population;
      total.idle += theirs.population;
    }

    const table = [
      `2. AI vs do-nothing (tiny, 2 civs, ${String(WALK_TURNS)} turns, player 0):`,
      ...lines,
      `  wins: ${JSON.stringify(wins)} of ${String(SEEDS.length)} seeds`,
      `  total population: ai=${String(total.ai)} idle=${String(total.idle)}`,
    ].join('\n');
    console.log(table);

    // The control is a control: it founds nothing, by construction.
    for (const idle of idleWalks()) {
      expect(standingOf(idle.state, asPlayerId(0)).cities, table).toBe(0);
    }
    // The claim, per seed: the contract asks for a majority, and this AI wins every seed on
    // the metrics that mean "it has an empire".
    for (const metric of ['cities', 'population', 'techs'] as const) {
      expect(wins[metric], table).toBe(SEEDS.length);
    }
    // `treasury` is deliberately **not** in that list, and the table above is why it is worth
    // saying so rather than quietly omitting it: the AI ends with *less* gold than the control
    // (7 against 10) on every seed, because it spends its income on settlers, buildings and
    // units while the control banks a fixed stipend and buys nothing. More gold is not more
    // play, and a test that demanded it would be asking the AI to hoard. `units` and
    // `buildings` are printed and not asserted either: they are the AI's business, not the
    // baseline comparison the contract asks for.
    // "Decisively", not "by one citizen": the baseline's total is zero.
    expect(total.idle).toBe(0);
    expect(total.ai).toBeGreaterThan(0);
    // And the AI's own floor: every seed produced a city and citizens, so the comparison is
    // not "one city versus zero" repeated by luck.
    for (const ai of aiWalks()) {
      const mine = standingOf(ai.state, asPlayerId(0));
      expect(mine.cities, table).toBeGreaterThanOrEqual(1);
      expect(mine.population, table).toBeGreaterThanOrEqual(2);
    }
  });

  it('hunts for a pathological seed — settles, builds, feeds and funds its empire', () => {
    // The four pathologies the contract is worried about, each measured rather than asserted
    // about:
    //
    //   * settles nowhere     — no city founded in the whole game;
    //   * builds nothing      — no item ever completed in any city;
    //   * starves every city  — starvation is the normal mode rather than the exception;
    //   * bankrupt by choice  — the AI's owner was billed a shortfall it could not pay,
    //     i.e. it spent itself into upkeep it could not cover.
    //
    // A seed showing any of the four would be a finding, not a flake. The counts are printed
    // so "none found" has a denominator, and the walks are the *shared* ones, so this section
    // costs no extra games.
    interface Pathology {
      readonly seed: number;
      readonly cities: number;
      readonly founded: number;
      readonly produced: number;
      readonly starved: number;
      readonly grew: number;
      readonly cityTurns: number;
      readonly disbands: number;
      readonly shortfalls: number;
      readonly treasuryAtEnd: number;
      readonly minTreasury: number;
    }

    const hunt = aiWalks().map((ran): Pathology => {
      const player = asPlayerId(0);
      // City-turns, so "starved every city" has a denominator. The city count and the treasury
      // come from walking the *same* game — the trail the driver recorded after each turn — so
      // this section costs no second run and cannot disagree with the game it describes.
      const cityTurns = ran.cityTrail.reduce((total, cities) => total + cities, 0);
      return {
        seed: ran.seed,
        cities: citiesOf(ran.state, player).length,
        founded: countEvents(ran.events, 'CityFounded', player),
        produced: countEvents(ran.events, 'CityProduced', player),
        starved: countEvents(ran.events, 'CityStarved', player),
        grew: countEvents(ran.events, 'CityGrew', player),
        cityTurns,
        disbands: countEvents(ran.events, 'UnitDisbanded', player),
        shortfalls: countEvents(ran.events, 'TreasuryShortfall', player),
        treasuryAtEnd: playerRow(ran.state, player).treasury,
        minTreasury: Math.min(...ran.treasuryTrail),
      };
    });

    const table = hunt
      .map(
        (row) =>
          `  seed ${String(row.seed)}: founded=${String(row.founded)} cities=${String(
            row.cities,
          )} produced=${String(row.produced)} grew=${String(row.grew)} starved=${String(
            row.starved,
          )} cityTurns=${String(row.cityTurns)} disbands=${String(row.disbands)} shortfalls=${String(
            row.shortfalls,
          )} gold(min/end)=${String(row.minTreasury)}/${String(row.treasuryAtEnd)}`,
      )
      .join('\n');
    console.log(`2. pathology hunt (tiny, 2 civs, ${String(WALK_TURNS)} turns):\n${table}`);

    for (const row of hunt) {
      // Settles: it founds cities, and still holds them at the end.
      expect(row.founded, `seed ${String(row.seed)} settled nowhere:\n${table}`).toBeGreaterThan(0);
      expect(row.cities).toBeGreaterThan(0);
      // Builds: something was actually completed, not merely queued.
      expect(row.produced, `seed ${String(row.seed)} built nothing:\n${table}`).toBeGreaterThan(0);
      // Feeds: a city that starves sometimes is a real city on a real site — the AI is not
      // handed a perfect map — but starvation must not be the normal mode.
      expect(row.starved, `seed ${String(row.seed)} starved every city:\n${table}`).toBeLessThan(
        row.cityTurns,
      );
      // Funds: the honest reading of "bankrupt by choice" is a run whose owner was billed a
      // shortfall it could not pay, and it is pinned at zero rather than at "few".
      expect(row.shortfalls, `seed ${String(row.seed)} could not pay its bills:\n${table}`).toBe(0);
      expect(row.treasuryAtEnd).toBeGreaterThanOrEqual(0);
      expect(row.minTreasury).toBeGreaterThanOrEqual(0);
    }

    // Non-vacuity: the horizon really saw growth and production, so "no pathology" is a
    // statement about a game that happened.
    expect(hunt.reduce((total, row) => total + row.grew, 0)).toBeGreaterThan(0);
    expect(hunt.reduce((total, row) => total + row.produced, 0)).toBeGreaterThan(0);
  });

  it.skipIf(!FULL_TIER)('hunts twelve more seeds (full tier)', () => {
    // The wider hunt: three seeds cannot rule out a seed-specific pathology, and a pathology
    // that shows on one seed in twelve is exactly what a twenty-seed tournament would
    // eventually hit. Same driver, more seeds.
    const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
    let founded = 0;
    let produced = 0;
    let grew = 0;
    let shortfalls = 0;
    let disbands = 0;
    let worstTreasury = Number.MAX_SAFE_INTEGER;
    const barren: number[] = [];

    for (const seed of seeds) {
      const ran = walk(seed, SMART_POLICY, WALK_TURNS, false);
      const player = asPlayerId(0);
      const cities = citiesOf(ran.state, player).length;
      const built = countEvents(ran.events, 'CityProduced', player);
      founded += countEvents(ran.events, 'CityFounded', player);
      produced += built;
      grew += countEvents(ran.events, 'CityGrew', player);
      shortfalls += countEvents(ran.events, 'TreasuryShortfall', player);
      disbands += countEvents(ran.events, 'UnitDisbanded', player);
      worstTreasury = Math.min(worstTreasury, playerRow(ran.state, player).treasury);
      if (cities === 0 || built === 0) barren.push(seed);
    }

    console.log(
      `2. wider pathology hunt (full tier): ${String(seeds.length)} seeds, founded=${String(
        founded,
      )} produced=${String(produced)} grew=${String(grew)} disbands=${String(disbands)} ` +
        `shortfalls=${String(shortfalls)} worstTreasury=${String(worstTreasury)} barren=${JSON.stringify(
          barren,
        )}`,
    );
    expect(barren, 'these seeds settled nowhere or built nothing').toEqual([]);
    expect(founded).toBeGreaterThanOrEqual(seeds.length);
    expect(produced).toBeGreaterThanOrEqual(seeds.length);
    expect(grew).toBeGreaterThan(0);
    expect(shortfalls).toBe(0);
    expect(worstTreasury).toBeGreaterThanOrEqual(0);
  });

  /**
   * How long the runaway hunt plays. Measured: at thirty turns the defect is already unmistakable
   * and each game still costs a few seconds (seeds 8, 14 and 20: 7.2 s, 3.6 s, 7.2 s) — 18 s of
   * work for the hunt as a whole. **M7b moved that hunt to the full tier** (measured at 21.0 s
   * for the test, 45% of this file's fast-tier wall), because the bound is now on
   * `time pnpm verify` (≤ 70 s) and this one test was most of the difference. The horizon is
   * deliberately *before* the games that cost 170 s: the defect is visible long before it is
   * expensive.
   */
  const RUNAWAY_TURNS = 31;

  // **FINDING F, recorded as an expected failure.**
  //
  // `weights.ts:368-375` says the AI "builds settlers to reach `settlement.targetCities` and no
  // further". It does not. `smart.ts:889-901` implements the cap by demoting the settler to
  // `fillerPriority`, and filler priority is a rank a city can still choose when nothing better is
  // on offer — so an empire that has run out of useful buildings keeps turning shields into
  // settlers, and each settler becomes a city that does the same. Measured here: the second
  // civilization reaches 11-13 cities by turn 31 where its own weight asks for 5, and 77 foundings
  // by turn 100 on seed 20, while its neighbour in the *same game*, running the *same policy with
  // the same weights*, stays at 5. The header states the full evidence, including the instrumented
  // decision path and the 2.6× seat asymmetry this produces in the CLI's own report.
  //
  // `it.fails` rather than prose, because a defect that lives only in a comment is a defect nobody
  // runs: this is visible in every full-tier run, and when the AI stops running away the test
  // reports an *unexpected pass* and fails — which is the signal to promote it to an ordinary
  // `it` and delete this comment. It asserts the property that *should* hold, never the defect.
  // Full tier (M7b): measured at 21.0 s — the single most expensive test in the whole fast
  // tier, and 45% of this file's wall time. It is the FINDING F hunt (three seeds x
  // `RUNAWAY_TURNS`), recorded as `it.fails` because the AI does not hold the property today.
  // Moving it does not soften FINDING F: `pnpm verify:full` still reports the expected failure
  // on every full run, and the fast run names it as skipped. `it.skipIf(...).fails(...)` — the
  // two chain, so the skip cannot silently turn the expected failure into a pass.
  it.skipIf(!FULL_TIER).fails(
    'keeps each empire near the city count its own weight asks for (FINDING F)',
    () => {
      const target = SMART_WEIGHTS.settlement.targetCities;
      const rows: string[] = [];
      const seats: { seed: number; cities: number }[] = [];

      for (const seed of [8, 14, 20]) {
        const ran = walk(seed, SMART_POLICY, RUNAWAY_TURNS, false);
        const counts = civPlayers(ran.state).map((player) => ({
          name: `civ ${String(player.id)}`,
          cities: citiesOf(ran.state, player.id).length,
        }));
        rows.push(
          `  seed ${String(seed)} (turn ${String(ran.state.turn)}): ` +
            counts.map((row) => `${row.name}=${String(row.cities)}`).join(' ') +
            `, its own target is ${String(target)}`,
        );
        for (const row of counts) seats.push({ seed, cities: row.cities });
      }

      console.log(
        `2. runaway-expansion hunt (FINDING F — an expected failure, because the AI does not hold ` +
          `this):\n${rows.join('\n')}`,
      );

      // The property `weights.ts:368-375` documents: no empire grows past the city count its own
      // weight asks for. Today the second civilization in each of these three games is 2-3× past it.
      for (const seat of seats) {
        expect(
          seat.cities,
          `seed ${String(seat.seed)} has an empire of ${String(
            seat.cities,
          )} cities where its own weight asks for ${String(target)}`,
        ).toBeLessThanOrEqual(target);
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 3. INDEPENDENCE FROM THE WORLD'S RNG
 * ------------------------------------------------------------------ */

/** The same state with its world stream advanced `draws` times. */
const withAdvancedWorld = (state: GameState, draws: number): GameState => {
  let rng = state.rng;
  for (let draw = 0; draw < draws; draw += 1) rng = nextUint32(rng)[1];
  return { ...state, rng };
};

/**
 * A policy that hands `inner` a **different** world stream and a **different** own stream.
 *
 * This is the direct form of the M5 property. The runner hands a policy its own
 * per-(seed, player, turn) stream and the state as it stands; if the policy's answer is a
 * function of the game's *position* rather than of the streams it was handed, then scrambling
 * both must change nothing at all — not "little", nothing, byte for byte. A policy that read
 * either stream would produce a different game here, and could therefore move the world (or
 * be moved by it).
 */
const scrambled = (inner: Policy, salt: number, worldDraws: number): Policy => ({
  name: `${inner.name}+scrambled`,
  chooseCommands: (ctx: PolicyContext): readonly Command[] =>
    inner.chooseCommands({
      state: withAdvancedWorld(ctx.state, worldDraws),
      playerId: ctx.playerId,
      ruleset: ctx.ruleset,
      rng: policyRngFor(ctx.state.seed + salt, ctx.playerId, ctx.state.turn),
    }),
});

/**
 * A twin that **reads the world's stream** and acts on what it saw.
 *
 * The read has to be observable to be detectable: an odd draw drops the last command the real
 * policy proposed. Dropping is chosen over reordering because the real policy's list is
 * order-sensitive (a settler's first command consumes the settler), so a reorder could be
 * refused for a reason that has nothing to do with the stream — and the point of this twin is
 * to be *detected*, not to be broken.
 */
const worldPeekingTwin = (inner: Policy): Policy => ({
  name: `${inner.name}+peeks-at-the-world-stream`,
  chooseCommands: (ctx: PolicyContext): readonly Command[] => {
    const [draw] = nextUint32(ctx.state.rng);
    const commands = inner.chooseCommands(ctx);
    return draw % 2 === 0 ? commands : commands.slice(0, Math.max(0, commands.length - 1));
  },
});

/**
 * How many of `probes` differently-advanced worlds make `policy` answer differently.
 *
 * This is the detector: hold the game still, move **only** the world's stream, and see whether
 * the answer moves with it. Zero means the policy is not reading the world's randomness; a
 * world-peeking policy scores one or more, which is what makes the property falsifiable
 * rather than merely asserted.
 */
const streamSensitivity = (
  policy: Policy,
  state: GameState,
  playerId: PlayerId,
  probes: readonly number[],
): number => {
  const own = policyRngFor(state.seed, playerId, state.turn);
  const answers = probes.map((draws) =>
    canonicalize(
      policy.chooseCommands({
        state: withAdvancedWorld(state, draws),
        playerId,
        ruleset: RULESET,
        rng: own,
      }),
    ),
  );
  const first = at(answers, 0);
  return answers.filter((answer) => answer !== first).length;
};

describe('3. the AI cannot read, and cannot move, the world’s randomness', () => {
  it('answers identically for six shifted world streams and four unrelated own streams', () => {
    // A mid-game board, where the most decisions are live: cities to assign, tiles to work,
    // production to set, research to pick, units to move. It is the end of a shared walk, so
    // the board costs no extra game.
    const mid = aiWalkOf(at(SEEDS, 0)).state;
    const player = asPlayerId(0);
    const probes = [0, 1, 2, 3, 5, 8];

    // (a) The world's stream moves under it; the answer must not.
    expect(streamSensitivity(SMART_POLICY, mid, player, probes)).toBe(0);

    // (b) Its own stream moves under it; the answer must not either — this AI draws no
    // randomness at all, which is why neither stream can be a channel.
    const baseline = canonicalize(
      SMART_POLICY.chooseCommands({
        state: mid,
        playerId: player,
        ruleset: RULESET,
        rng: policyRngFor(mid.seed, player, mid.turn),
      }),
    );
    for (const salt of [1, 17, 40, 9999]) {
      const answer = canonicalize(
        SMART_POLICY.chooseCommands({
          state: mid,
          playerId: player,
          ruleset: RULESET,
          rng: policyRngFor(mid.seed + salt, player, mid.turn),
        }),
      );
      expect(answer, `own stream ${String(salt)} changed the AI's answer`).toBe(baseline);
    }
    // Non-vacuity: the board really is a board, not an empty state answering `[]`.
    expect(baseline.length).toBeGreaterThan(2);

    // (c) The detector is not dead: the same probe catches a twin that reads the stream.
    const caught = streamSensitivity(worldPeekingTwin(SMART_POLICY), mid, player, probes);

    // (d) **FINDING D, measured.** The milestone's own independence check — `ai.test.ts`, "takes
    // its own stream and never reads the world RNG while deciding", part (b) — varies the
    // policy's *own* stream over four offsets and leaves `state` untouched, so the world stream
    // inside that state never moves. A policy that reads it is invisible to that shape of probe,
    // and the mutation this review ran against `smart.ts` proves it: making the AI return `[]`
    // whenever `ctx.state.rng.a` is odd left `ai.test.ts` GREEN while turning the probe below
    // RED. Replicated here: the twin answers identically under four own-stream offsets, which is
    // exactly why an own-stream-only probe cannot see it.
    const authorStyle = new Set(
      [0, 1, 17, 40].map((offset) =>
        canonicalize(
          worldPeekingTwin(SMART_POLICY).chooseCommands({
            state: mid,
            playerId: player,
            ruleset: RULESET,
            rng: policyRngFor(mid.seed + offset, player, mid.turn),
          }),
        ),
      ),
    ).size;
    console.log(
      `3. stream sensitivity: real policy 0, peeking twin ${String(caught)} of ${String(
        probes.length,
      )} world-stream probes; the same twin answers identically for all 4 own-stream offsets, ` +
        `which is why an own-stream-only probe finds ${String(authorStyle - 1)} of 4 (FINDING D)`,
    );
    expect(caught, 'the probe could not see a policy that reads state.rng').toBeGreaterThan(0);
    // The twin is not merely noisy: it ignores its own stream entirely, so the difference the
    // probe did find is attributable to the world's stream and to nothing else.
    expect(authorStyle).toBe(1);
  });

  it('plays a byte-identical game when every policy context is scrambled', () => {
    // The end-to-end form: the runner builds the contexts and a wrapper scrambles both streams
    // inside them before the real policy sees them. If the real policy were entangled with
    // either stream, the game itself would move — so this compares the whole game (hash, world
    // RNG trail, command count) and not just the last state.
    const seed = at(SEEDS, 0);
    const plain = aiWalkOf(seed);
    const scram = walk(seed, scrambled(SMART_POLICY, 4242, 7), WALK_TURNS, false);
    console.log(
      `3. scrambled contexts: plain ${plain.hash} vs scrambled ${scram.hash}; world trails ` +
        `identical: ${String(plain.trail.join() === scram.trail.join())}`,
    );
    expect(scram.hash).toBe(plain.hash);
    expect(scram.trail).toEqual(plain.trail);
    expect(scram.proposed).toBe(plain.proposed);
    // Non-vacuity: the game really was played.
    expect(plain.state.cities.length).toBeGreaterThan(0);
  });

  // Full tier (M7b): measured at 4.3 s — twelve six-turn games (a plain walk and a
  // world-reading twin on each of six seeds). The in-suite half that stays fast is the probe
  // test above, which catches the twin directly; this one measures how often it is visible in
  // real games, which is a measurement rather than a contract.
  it.skipIf(!FULL_TIER)(
    'detects a policy that DOES read the world stream — and measures how visible it is',
    () => {
      // The converse, and the honest form of it. A policy that reads `state.rng` is detectable,
      // but **not by comparing the world's RNG trail**, which is what a first attempt at this
      // check compared and what the measurement below refused to support: the world's stream
      // advances only when the *engine* has a reason to draw (a hut entered, a barbarian band
      // spawned, a battle resolved), so in a quiet game its state is a constant and its trail is
      // identical no matter who is playing. The detector that does work varies the stream and
      // watches the answer (the probe above); the measurement here says how often the twin is
      // visible in a real game, and why.
      //
      // Six seeds at six turns, because the twin drops commands from turn one — a shorter horizon
      // shows the difference in fewer games, and the claim is about detectability, not about a
      // particular game's shape.
      const huntSeeds = [1, 2, 3, 5, 7, 11];
      const huntTurns = 6;
      const rows = huntSeeds.map((seed) => {
        const plain = walk(seed, SMART_POLICY, huntTurns, false);
        const peeking = walk(seed, worldPeekingTwin(SMART_POLICY), huntTurns, false);
        // How many distinct world-RNG states the game passed through: 1 means the world never
        // drew, so nothing a policy reads from the stream could change between turns.
        const draws = new Set(plain.trail).size;
        return {
          seed,
          draws,
          visible: plain.hash !== peeking.hash || plain.proposed !== peeking.proposed,
          plainHash: plain.hash,
          twinHash: peeking.hash,
        };
      });
      const visible = rows.filter((row) => row.visible).length;
      console.log(
        `3. world-reading twin over ${String(huntSeeds.length)} seeds × ${String(huntTurns)} turns: ` +
          `visible in ${String(visible)}; per seed ` +
          rows
            .map(
              (row) =>
                `${String(row.seed)}:${row.visible ? 'caught' : 'invisible'}/rngStates=${String(
                  row.draws,
                )}`,
            )
            .join(' '),
      );

      // The claim that matters: an entangled policy is caught, in real games, on seeds this test
      // did not choose by hand. If this ever reports zero, the honest reading is that the game
      // comparison is not a detector at all on these seeds — the probe above still is, and this
      // section's comment says why.
      expect(
        visible,
        'no seed in the hunted set showed a world-reading policy changing the game',
      ).toBeGreaterThan(0);
      // And the non-vacuity of the explanation: at least one of these games never drew from the
      // world's stream at all, which is why "the trail moved" cannot be the detector.
      expect(rows.filter((row) => row.draws === 1).length).toBeGreaterThan(0);
      // A caught seed is caught by the game moving, not by the refusal list (the twin drops
      // commands, it does not invent them).
      for (const row of rows) {
        if (row.visible) expect(row.twinHash).not.toBe(row.plainHash);
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 4. DETERMINISM, AGGREGATES AND SEAT ROTATION
 * ------------------------------------------------------------------ */

describe('4. determinism: same seeds, same policies, same numbers', () => {
  it('gives one hash and one metrics sequence for the same seed, in-process', () => {
    const options = {
      seed: 11,
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: 8,
    };
    const first = runSimulation(options);
    const second = runSimulation(options);
    expect(second.finalHash).toBe(first.finalHash);
    expect(canonicalize(second.metrics)).toBe(canonicalize(first.metrics));
    expect(second.violations).toEqual(first.violations);
    expect(second.turnsPlayed).toBe(first.turnsPlayed);
    expect(second.stoppedBecause).toBe(first.stoppedBecause);
    // Non-vacuity: a deterministic run of nothing is deterministic.
    expect(first.finalState.cities.length).toBeGreaterThan(0);
    // And the hash is not accidentally constant across worlds.
    expect(runSimulation({ ...options, seed: 12 }).finalHash).not.toBe(first.finalHash);
  });

  it('reports identical aggregates when the seed list is permuted', () => {
    const options = {
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: 6,
    };
    const ascending = runBatch({ ...options, seeds: [5, 9] });
    const permuted = runBatch({ ...options, seeds: [9, 5] });
    expect(canonicalize(permuted)).toBe(canonicalize(ascending));
    expect(ascending.runs.map((run) => run.seed)).toEqual([5, 9]);
    // Non-vacuity: the batch really aggregated rows.
    expect(ascending.aggregates.length).toBeGreaterThan(0);
    expect(at(ascending.aggregates, 0).count).toBeGreaterThan(0);
  });

  it('rotates the seats, so no policy is ever tested from one position only', () => {
    // The rule, as a value.
    expect(seatPlan(2, 4)).toEqual([
      [0, 1],
      [1, 0],
      [0, 1],
      [1, 0],
    ]);
    for (const games of [1, 2, 3, 4, 5]) {
      for (const seats of seatPlan(3, games)) {
        // Every game seats every policy exactly once — the plan is a bijection per game.
        expect([...seats].sort((a, b) => a - b)).toEqual([0, 1, 2]);
      }
    }
    // Over any n consecutive games each policy plays each seat exactly once.
    const seatGames = new Map<string, number>();
    for (const seats of seatPlan(3, 3)) {
      seats.forEach((policyIndex, seat) => {
        const key = `${String(policyIndex)}@${String(seat)}`;
        seatGames.set(key, (seatGames.get(key) ?? 0) + 1);
      });
    }
    expect([...seatGames.entries()].sort()).toEqual([
      ['0@0', 1],
      ['0@1', 1],
      ['0@2', 1],
      ['1@0', 1],
      ['1@1', 1],
      ['1@2', 1],
      ['2@0', 1],
      ['2@1', 1],
      ['2@2', 1],
    ]);

    // And the rotation is real, not nominal: the **same seed** with the policies in the other
    // order is a different game, because the AI is now in the other seat. A tournament that
    // reported the same hashes for swapped seats would be seating nobody.
    const base = { seeds: [5], settings: SETTINGS, ruleset: RULESET, maxTurns: 4 };
    const aiFirst = runTournament({ ...base, policies: [SMART_POLICY, DO_NOTHING_POLICY] });
    const aiSecond = runTournament({ ...base, policies: [DO_NOTHING_POLICY, SMART_POLICY] });
    const firstGame = at(aiFirst.games, 0);
    const secondGame = at(aiSecond.games, 0);
    console.log(
      `4. seat swap on seed 5: smart-in-seat-0 ${firstGame.finalHash} vs smart-in-seat-1 ${secondGame.finalHash}`,
    );
    expect(secondGame.finalHash).not.toBe(firstGame.finalHash);
    expect(at(aiFirst.totals.policies, 0).seatGames).toEqual([1, 0]);
    expect(at(aiSecond.totals.policies, 1).seatGames).toEqual([0, 1]);
    // A seat total names whoever sat there: with one game, seat 0 holds the policy that was
    // listed first — and the two tournaments list different policies first, which is the
    // rotation being real rather than nominal.
    expect(at(aiFirst.totals.seats, 0).policies).toEqual([SMART_POLICY_NAME]);
    expect(at(aiSecond.totals.seats, 0).policies).toEqual([DO_NOTHING_POLICY.name]);
    // With two games the same seat really does mix: that is the field's documented meaning
    // ("more than one name is the normal case and the point of the rotation").
    const twoGames = runTournament({
      seeds: [5, 6],
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, DO_NOTHING_POLICY],
      maxTurns: 3,
    });
    expect(at(twoGames.totals.policies, 0).seatGames).toEqual([1, 1]);
    expect(at(twoGames.totals.policies, 1).seatGames).toEqual([1, 1]);
    const mixed = [SMART_POLICY_NAME, DO_NOTHING_POLICY.name].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    expect(at(twoGames.totals.seats, 0).policies).toEqual(mixed);
    expect(at(twoGames.totals.seats, 1).policies).toEqual(mixed);
  });

  it.skipIf(!FULL_TIER)('gives the same hash in a fresh process (full tier)', () => {
    // In-process agreement can hide shared module state; a second process cannot. The program
    // prints the hash twice, and both must match this process's answer.
    const options = {
      seed: 23,
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: 10,
    };
    const here = runSimulation(options).finalHash;
    const program = [
      "import { DEFAULT_SETTINGS } from '@civts/core';",
      "import { CATALOG, validateRuleset } from '@civts/rules';",
      "import { SMART_POLICY, runSimulation } from '@civts/sim';",
      'const validated = validateRuleset(CATALOG, "tuned");',
      'if (!validated.ok) throw new Error("catalog");',
      'const runs = [1, 2].map(() => runSimulation({',
      '  seed: 23,',
      '  settings: { ...DEFAULT_SETTINGS, mapSize: "tiny", civCount: 2 },',
      '  ruleset: validated.value,',
      '  policies: [SMART_POLICY, SMART_POLICY],',
      '  maxTurns: 10,',
      '}).finalHash);',
      'process.stdout.write(runs.join("\\n"));',
    ].join('\n');

    const printed = runInFreshProcess(program);
    console.log(`4. fresh process: ${printed.join(' ')} | in-process: ${here}`);
    expect(at(printed, 0)).toBe(here);
    expect(at(printed, 1)).toBe(here);
  });
});

/* ------------------------------------------------------------------ *
 * 5 + 8. ZERO VIOLATIONS IS REAL, AND SCALE
 * ------------------------------------------------------------------ */

/** An invariant that always reports one violation — the fault sections 5 and 9 inject. */
const brokenProbe: Invariant = {
  name: 'a4-deliberately-broken-probe',
  description: 'Always reports a violation, so a pass condition can be seen to fail.',
  check: () => ['this tournament was supposed to fail, and did not'],
};

/** Twenty ascending seeds: A3's own size, so the big run is the size alpha names. */
const A3_SEEDS: readonly number[] = Array.from({ length: 20 }, (_, index) => index + 1);

/**
 * The twenty-seed tournament, at a horizon the full tier can afford.
 *
 * The turns are stated rather than implied, and the horizon is the one thing here that differs
 * from A3's own experiment (100 turns, measured separately — see section 8, and reproducible
 * with `pnpm tournament:evidence`). Twenty turns is
 * long enough for every civilization to have settled, worked tiles, produced and researched,
 * and short enough that the review does not double the gate's runtime for a claim the horizon
 * does not change.
 */
const BIG_TOURNAMENT_TURNS = 20;

const bigTournamentOptions = (): TournamentOptions => ({
  seeds: A3_SEEDS,
  settings: SETTINGS,
  ruleset: RULESET,
  policies: [SMART_POLICY, SMART_POLICY],
  maxTurns: BIG_TOURNAMENT_TURNS,
});

let bigCache: TournamentResult | undefined;
const twentySeedTournament = (): TournamentResult => {
  bigCache ??= runTournament(bigTournamentOptions());
  return bigCache;
};

/** A two-turn tournament of one or two seeds: the cheapest real run the harness can make. */
const microTournament = (seeds: readonly number[]): TournamentResult =>
  runTournament({
    seeds,
    settings: SETTINGS,
    ruleset: RULESET,
    policies: [SMART_POLICY, SMART_POLICY],
    maxTurns: 2,
  });

describe('5. a pass condition that has never failed is decoration', () => {
  it('fails a tournament when an invariant fires — by name, and it stops the game', () => {
    const base = {
      seeds: [3],
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: 3,
    };
    const control = runTournament(base);
    const injected = runTournament(base, { invariants: [...CORE_INVARIANTS, brokenProbe] });

    expect(control.violations).toEqual([]);
    expect(tournamentVerdict(control).passed).toBe(true);

    // The same tournament, one invariant different, must now fail — and by name.
    expect(injected.violations.length).toBeGreaterThan(0);
    expect(injected.violations.map((violation) => violation.invariant)).toContain(brokenProbe.name);
    const verdict = tournamentVerdict(injected);
    expect(verdict.passed).toBe(false);
    expect(verdict.accepted).toBe(false);
    expect(verdict.violatingGames).toBe(1);
    // It stops on the turn that broke, so the game is shorter than its horizon: a violation
    // that did not truncate the run could not be inspected where it happened.
    expect(at(injected.games, 0).stoppedBecause).toBe('violation');
    expect(at(injected.games, 0).turnsPlayed).toBeLessThan(at(control.games, 0).turnsPlayed);
    console.log(
      `5. injected violation: control ${String(at(control.games, 0).turnsPlayed)} turns / ` +
        `${String(control.violations.length)} violations vs injected ${String(
          at(injected.games, 0).turnsPlayed,
        )} turns / ${String(injected.violations.length)} violations (${brokenProbe.name})`,
    );
  });

  it('drives the same failure end to end through the real CLI — and the command exists', () => {
    // Two spawns, both with a reason this review added:
    //
    //  * FINDING A: `civts tournament` had no dispatcher case, so it answered "unknown command"
    //    and exited 2. A command that is implemented, unit-tested and unreachable is not
    //    shipped, and only a spawn of the real binary can tell the difference.
    //  * The violation path, watched firing end to end rather than inferred from a function's
    //    return value: `--fault` injects an always-failing invariant, and the process must exit
    //    non-zero with the invariant named.
    const clean = spawnCli([
      'tournament',
      '--seeds',
      '1',
      '--turns',
      '1',
      '--map-size',
      'duel',
      '--json',
    ]);
    console.log(`5. cli tournament: exit ${String(clean.status)}`);
    expect(clean.status, clean.stderr).toBe(0);
    const report: unknown = JSON.parse(clean.stdout);
    expect(canonicalize(report)).toContain('civts-tournament-report');

    const faulty = spawnCli([
      'tournament',
      '--seeds',
      '1',
      '--turns',
      '1',
      '--map-size',
      'duel',
      '--fault',
      'a4-cli-probe',
    ]);
    console.log(`5. cli tournament --fault: exit ${String(faulty.status)}`);
    expect(faulty.status, 'a tournament with a firing invariant must exit non-zero').not.toBe(0);
    expect(`${faulty.stdout}${faulty.stderr}`).toContain('a4-cli-probe');

    // PLAN.md §8.1's name for the same run, kept working by the wiring this review added.
    const alias = spawnCli(['run', '--seeds', '1', '--turns', '1', '--map-size', 'duel']);
    console.log(`5. cli run (alias): exit ${String(alias.status)}`);
    expect(alias.status, alias.stderr).toBe(0);
    expect(alias.stdout).toContain('invariants');
  });

  it.skipIf(!FULL_TIER)('plays twenty seeds with zero violations (full tier)', () => {
    const result = twentySeedTournament();
    const verdict = tournamentVerdict(result);
    console.log(
      `5. twenty-seed tournament: games=${String(result.games.length)} turns/game=${String(
        BIG_TOURNAMENT_TURNS,
      )} violations=${String(result.violations.length)} elapsedMs=${String(
        result.elapsedMs,
      )} budgetMs=${String(result.budgetMs)} withinBudget=${String(result.withinBudget)}`,
    );

    // The contract's pass/fail condition, and nothing softer: ZERO.
    expect(result.violations).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(result.games.length).toBe(A3_SEEDS.length);
    // Every game played its whole horizon and was cut short by nothing.
    for (const game of result.games) {
      expect(game.turnsPlayed).toBe(BIG_TOURNAMENT_TURNS);
      expect(game.stoppedBecause).toBe('max-turns');
    }
    expect(result.totals.seeds).toEqual([...A3_SEEDS]);
    // Rotation completed: each of the two seat-entries played both seats ten times.
    expect(at(result.totals.policies, 0).seatGames).toEqual([10, 10]);
    expect(at(result.totals.policies, 1).seatGames).toEqual([10, 10]);
    // And the games are not a constant: twenty seeds gave more than one final state.
    expect(new Set(result.games.map((game) => game.finalHash)).size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * 6. BUDGET HONESTY
 * ------------------------------------------------------------------ */

/** A clock whose answers this test chose, and which counts how often it was read. */
const scriptedClock = (
  answers: readonly number[],
): { clock: TournamentClock; reads: () => number } => {
  let reads = 0;
  return {
    clock: {
      now: () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return answer ?? 0;
      },
    },
    reads: () => reads,
  };
};

describe('6. the budget is reported honestly, or not at all', () => {
  it('reads its clock exactly twice, and reports exactly what it read', () => {
    const scripted = scriptedClock([5_000, 5_250]);
    const result = runTournament(
      {
        seeds: [1],
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: 2,
      },
      { clock: scripted.clock },
    );
    expect(scripted.reads()).toBe(2);
    expect(result.elapsedMs).toBe(250);
    // The verdict follows from the stated budget and nothing else: the same run, one
    // millisecond of budget either side of the measured time.
    expect(result.budgetMs).toBe(DEFAULT_TOURNAMENT_BUDGET_MS);
    expect(result.withinBudget).toBe(true);

    const tight = runTournament(
      {
        seeds: [1],
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: 2,
        budgetMs: 249,
      },
      { clock: scriptedClock([5_000, 5_250]).clock },
    );
    expect(tight.elapsedMs).toBe(250);
    expect(tight.withinBudget).toBe(false);
    expect(tournamentVerdict(tight).withinBudget).toBe(false);
    // It is *reported*, not trimmed: the seed was played anyway.
    expect(tight.games.length).toBe(1);
  });

  it('reports an overrun instead of hiding it, and never trims the seed set', () => {
    const result = runTournament({
      seeds: [1, 2],
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: 2,
      budgetMs: 0,
    });
    console.log(
      `6. over-budget run: elapsedMs=${String(result.elapsedMs)} budgetMs=0 withinBudget=${String(
        result.withinBudget,
      )} games=${String(result.games.length)}`,
    );
    // A budget of zero is honest and impossible: the run is over it, and says so.
    expect(result.withinBudget).toBe(false);
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.budgetMs).toBe(0);
    // Both seeds played. "Trimming the seed set silently" is the failure this pins.
    expect(result.games.map((game) => game.seed)).toEqual([1, 2]);
    // Passing invariants with an overrun is not "accepted".
    expect(tournamentVerdict(result).passed).toBe(true);
    expect(tournamentVerdict(result).accepted).toBe(false);
  });

  it('refuses a clock that goes backwards, and a budget that is not a number', () => {
    // `NaN` and `Infinity` produce a verdict that is always the same, whatever the run did; a
    // backwards clock is the third shape of the same mistake — a measurement that is not a
    // measurement, whose symptom is a *plausible* verdict.
    expect(() =>
      runTournament(
        {
          seeds: [1],
          settings: SETTINGS,
          ruleset: RULESET,
          policies: [SMART_POLICY, SMART_POLICY],
          maxTurns: 2,
        },
        { clock: scriptedClock([5_000, 4_000]).clock },
      ),
    ).toThrow(/budget verdict/);
    expect(() =>
      runTournament({
        seeds: [1],
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: 2,
        budgetMs: Number.NaN,
      }),
    ).toThrow(/budgetMs/);
  });

  it('reports an elapsed time that matches reality, measured independently', () => {
    // The honest reading of "the reported elapsed time matches reality": a second,
    // independent measurement of the same wall time. `HOST_CLOCK` reads
    // `process.uptime() * 1000`, so this test brackets the call with the same source — the
    // strongest check available in-process, and it is stated as such rather than dressed up
    // as a comparison against the wall clock.
    const before = process.uptime() * 1000;
    const result = microTournament([4]);
    const measured = process.uptime() * 1000 - before;
    console.log(
      `6. elapsed honesty: reported=${String(result.elapsedMs)}ms independently measured=${String(
        Math.round(measured),
      )}ms`,
    );
    expect(Number.isFinite(result.elapsedMs)).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    // Both readings bracket the same work, so the reported time cannot be far above the
    // measured window or far below it.
    expect(result.elapsedMs).toBeLessThanOrEqual(measured + 50);
    expect(result.elapsedMs).toBeGreaterThan(measured - 500);
    expect(HOST_CLOCK.now()).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7. SWEEPABILITY
 * ------------------------------------------------------------------ */

/**
 * The AI's own sources, read from disk, so the scan is of the shipped bytes rather than of a
 * copy this review made.
 */
const aiSource = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim/src/ai/${name}`, import.meta.url)), 'utf8');

/**
 * Source with comments and string literals blanked out, line by line.
 *
 * Blanked rather than deleted so every reported line number is the real one. A scan that
 * counted numbers in the AI's prose would be pure noise: the module comments quote measured
 * figures (a 45-turn game, tile 665, 396 expanded tiles) that are *evidence about the AI*,
 * not magnitudes the AI reads.
 */
const codeLines = (source: string): readonly string[] => {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  return withoutBlocks.split('\n').map((line) =>
    (line.split('//')[0] ?? '')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"[^"\n]*"/g, '""')
      .replace(/`[^`\n]*`/g, '``'),
  );
};

/** Every bare numeric literal in code (comments and strings removed), with its line. */
const numericLiterals = (lines: readonly string[]): readonly { line: number; value: string }[] => {
  const pattern = /(?<![\w.$])(\d+\.?\d*(?:[eE]-?\d+)?)(?![\w.])/g;
  const found: { line: number; value: string }[] = [];
  lines.forEach((code, index) => {
    for (const match of code.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined) found.push({ line: index + 1, value });
    }
  });
  return found;
};

describe('7. the AI’s preferences are sweepable, and its decision code carries no magnitudes', () => {
  it('has no bare magnitude in its decision logic — only structural literals', () => {
    const literals = numericLiterals(codeLines(aiSource('smart.ts')));
    const counts = new Map<string, number>();
    const firstLine = new Map<string, number>();
    for (const literal of literals) {
      counts.set(literal.value, (counts.get(literal.value) ?? 0) + 1);
      if (!firstLine.has(literal.value)) firstLine.set(literal.value, literal.line);
    }
    const sorted = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    console.log(
      `7. literals in smart.ts: ${sorted
        .map(
          ([value, count]) =>
            `${value}×${String(count)} (first at line ${String(firstLine.get(value) ?? 0)})`,
        )
        .join(', ')}`,
    );

    // Non-vacuity: the scan really scanned code — the zeroes and ones are the counting and
    // identity literals every loop and every fold has.
    expect(counts.get('0') ?? 0).toBeGreaterThan(20);
    expect(counts.get('1') ?? 0).toBeGreaterThan(10);

    // **The claim.** Every literal in the AI's decision code is structural, and there are
    // exactly four kinds:
    //
    //   `0` / `1` — counts, identities, "the first", loop bounds, and the `?? 0` / `?? 1`
    //               seeds of a fold;
    //   `100`     — the percent scale, paired with a `weights.*Pct` field on every use;
    //   `1e-300`  — the underflow guard in the battle-win series: a numerical necessity rather
    //               than a preference, which stops a hopeless attack from summing for ever.
    //
    // A NEW literal here is either a magnitude that belongs in `weights.ts` (where a sweep can
    // vary it) or a structural constant that should be named and added to this list
    // deliberately. Both are fine; arriving silently is not — which is what this asserts, and
    // the failure message names the line, because that is the whole point of the scan.
    const unexpected = literals.filter(
      (literal) => !['0', '1', '100', '1e-300'].includes(literal.value),
    );
    expect(
      unexpected.map((literal) => `line ${String(literal.line)}: ${literal.value}`),
      'a bare magnitude appeared in the AI’s decision code: move it to weights.ts, or name it',
    ).toEqual([]);
  });

  it('names every weight field in the merge, field for field', () => {
    // The mechanism FINDING C records as missing. A patch reads `mergeSmartWeights`, so a field
    // the merge does not name is a field no sweep can move — the M6b defect (`mergeUnit` dropped
    // `hitPoints`, `mergeTerrain` dropped `defenseBonus`) in a new place. This is the check that
    // makes "the knob set is enumerable" true rather than merely documented.
    const merge = codeLines(aiSource('weights.ts')).join('\n');
    const named = new Set<string>();
    for (const match of merge.matchAll(/patch\.(\w+)\?\.(\w+)/g)) {
      const group = match[1];
      const field = match[2];
      if (group !== undefined && field !== undefined) named.add(`${group}.${field}`);
    }

    const declared = new Set<string>();
    for (const group of SMART_WEIGHT_GROUPS) {
      for (const field of Object.keys(SMART_WEIGHTS[group])) declared.add(`${group}.${field}`);
    }

    const unreachable = [...declared].filter((path) => !named.has(path)).sort();
    const phantom = [...named].filter((path) => !declared.has(path)).sort();
    console.log(
      `7. weight fields: ${String(declared.size)} declared, ${String(named.size)} named in the merge`,
    );
    expect(unreachable, 'these weight fields exist but no patch can move them').toEqual([]);
    expect(phantom, 'the merge names fields the weights interface does not have').toEqual([]);
    // Non-vacuity: the sets are not both empty.
    expect(declared.size).toBeGreaterThan(40);
    expect([...declared].sort()).toEqual([...named].sort());
  });

  it('pins the documented-but-missing knob enumeration, and the debug hook’s absence', () => {
    const weights = aiSource('weights.ts');

    // FINDING C, pinned. `weights.ts`' header claims "`SMART_WEIGHT_PATHS` lists every knob as
    // a dotted path, and `ai.test.ts` asserts it is complete". The identifier appears nowhere
    // else in the repository, so the mechanism does not exist. If someone implements it, this
    // test FAILS ON PURPOSE: delete these two assertions, replace them with a completeness
    // check over the real export, and correct the comment that promises it.
    expect(
      weights.includes('SMART_WEIGHT_PATHS'),
      'the weights note no longer mentions SMART_WEIGHT_PATHS — update this pin',
    ).toBe(true);
    expect(
      /export[^\n]*SMART_WEIGHT_PATHS/.test(weights),
      'SMART_WEIGHT_PATHS is now exported: replace this pin with a real assertion over it',
    ).toBe(false);

    // FINDING B, pinned as a guard. The AI's decisions must be a pure function of
    // `(state, ruleset, its own stream)`; an ambient read is a fourth input nobody declared.
    // The debug hook that read `process.env['DSH_AI_TRACE']` in `chooseProduction` was found
    // here and removed; this is the line that keeps it out.
    for (const name of ['smart.ts', 'weights.ts']) {
      const code = codeLines(aiSource(name)).join('\n');
      expect(
        code.includes('process.'),
        `${name} reads ambient process state, so the AI is no longer a pure function`,
      ).toBe(false);
      expect(code.includes('Math.random'), `${name} reads ambient randomness`).toBe(false);
    }
  });

  // Full tier (M7b): measured at 8.2 s — four 14-turn games per swept value, and the sweep is
  // run twice (once for the table, once for the assertion). `pnpm verify:full` runs it; the fast
  // tier's cheap half of this section (the no-bare-magnitude and field-name checks) stays.
  it.skipIf(!FULL_TIER)('changes the game when one weight moves — the sweep is measurable', () => {
    // The measurement M7 asks for: vary ONE named weight and show a measured effect on
    // outcomes. `targetCities` is the expansion appetite, and the outcome it should move is how
    // much empire exists.
    const sweepSeeds = [7, 23];
    const sweep = (targetCities: number): readonly Standing[] =>
      sweepSeeds.map((seed) => {
        const policy = smartPolicy({ settlement: { targetCities } });
        const result = runSimulation({
          seed,
          settings: SETTINGS,
          ruleset: RULESET,
          policies: [policy, policy],
          maxTurns: 14,
        });
        return standingOf(result.finalState, asPlayerId(0));
      });

    const rows = [1, 6].map((targetCities) => ({ targetCities, seats: sweep(targetCities) }));
    const table = rows
      .map(
        (row) =>
          `  targetCities=${String(row.targetCities)}: ` +
          row.seats
            .map(
              (seat, index) =>
                `seed ${String(at(sweepSeeds, index))} cities=${String(seat.cities)} pop=${String(
                  seat.population,
                )}`,
            )
            .join(' | '),
      )
      .join('\n');
    console.log(`7. weight sweep (settlement.targetCities, tiny, 2 civs, 14 turns):\n${table}`);

    const citiesFor = (targetCities: number): number =>
      sweep(targetCities).reduce((total, seat) => total + seat.cities, 0);
    // A greedy AI builds more cities than a stay-at-home one. If these ever agree, the weight has
    // become decoration and the sweep measures nothing.
    expect(citiesFor(6), table).toBeGreaterThan(citiesFor(1));
    // And the swept value really is the one the patch named: a merge that dropped it would make
    // the two rows the same policy.
    expect(mergeSmartWeights({ settlement: { targetCities: 6 } }).settlement.targetCities).toBe(6);
    expect(SMART_WEIGHTS.settlement.targetCities).not.toBe(6);
  });
});

/* ------------------------------------------------------------------ *
 * 8. TOURNAMENT SCALE
 * ------------------------------------------------------------------ */

describe('8. the tournament at the size alpha names', () => {
  it.skipIf(!FULL_TIER)('plays twenty seeds and reports wall time, invariants and budget', () => {
    // **The alpha-scale CLI run, measured outside this suite** (it is twenty seeds at a hundred
    // turns, and running that inside the gate would spend the gate's own budget measuring it;
    // M7b then took that size off the CLI's default and made it explicit). The command line,
    // corrected for M7b — the old `tournament --json` with no flags now runs the two-game smoke
    // default, so a reader copying it would no longer reproduce these numbers:
    //
    //   npx tsx packages/headless/src/cli.ts tournament --seeds 1..20 --turns 100 --json
    //   pnpm tournament:evidence        # the same run, plus the wall time and the two-clock check
    //
    // **The figures this run produces are NOT written here.** They live in exactly one place —
    // `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE`, imported by this file — together with the
    // wall time, the harness's own reading, the twenty per-game final hashes, the budget it was
    // measured against (restored to 900 s by M7d, in `tournament.ts`, with the reasoning and the
    // re-measured headroom), and the timestamp and load average the measurement was taken under.
    // Every site that used to restate them (this comment, `tournament.ts`, `tier.ts`, the CLI's
    // `--help`, the evidence script) now references that record instead, and the test below this
    // one checks that they still do.
    //
    // Why that matters, as this file's own history: FINDING E was raised against `tournament.ts`
    // claiming *"about 7.7 s per game on an idle machine, so ~2.6 minutes for the twenty"* when
    // the measured figure was 26.4 s per game / 8.8 minutes for the twenty — **3.4× stale**. M7b
    // corrected it to 519.4 s / 26.0 s per game. Then the AI got smarter and **1.66× slower**,
    // and the same figure was stale again — in *five* files at once, all of which had copied it
    // — with the run measuring 861.8 s = 43.09 s per game against the then-900 s bound: 4.2 % of
    // headroom, and a second run that went 503 ms over budget on a busy box and exited 3. The
    // conclusion was structural rather than arithmetic: a number copied into five files goes
    // stale five times, so the number now has one home and the budget is a stated decision
    // (recorded in `tournament.ts` with its reasoning, which is how it went to 1800 s and how
    // M7d brought it back to 900 s) rather than a value tuned to fit whichever machine last ran
    // the thing.
    //
    // The five hashes below were re-recorded from the shipped code with the rest of the record —
    // `A3_TOURNAMENT_EVIDENCE.games` carries all twenty. They are a **timestamp, not a
    // guarantee**: they match the `runSimulation` driver on the same seeds only while the AI and
    // the catalog are unchanged, so a mismatch after an AI edit means the record is stale (fix:
    // re-run `pnpm tournament:evidence` and re-record), not that anything regressed. What is
    // pinned *as a property* is that the driver and the tournament agree on the same seed — which
    // section 3 asserts against live output, at a horizon the gate can afford, rather than
    // against a stored hash.
    //
    // What the suite asserts here is the same twenty seeds at a horizon the gate can afford,
    // plus the CLI wiring check in section 5, plus the one-record guard below.
    const result = twentySeedTournament();
    const invariants = CORE_INVARIANTS.length;
    console.log(
      `8. scale: seeds=${String(result.games.length)} turns=${String(BIG_TOURNAMENT_TURNS)} ` +
        `invariants=${String(invariants)} checks=${String(
          invariants * result.games.length * BIG_TOURNAMENT_TURNS,
        )} elapsedMs=${String(result.elapsedMs)} budgetMs=${String(result.budgetMs)} ` +
        `withinBudget=${String(result.withinBudget)} violations=${String(result.violations.length)}`,
    );
    expect(result.budgetMs).toBe(DEFAULT_TOURNAMENT_BUDGET_MS);
    expect(result.withinBudget).toBe(true);
    expect(result.violations).toEqual([]);
    expect(tournamentVerdict(result).accepted).toBe(true);
    // The invariant registry is not empty: "zero violations" over zero checks is free.
    expect(invariants).toBeGreaterThan(20);
    // And the count of checks really was the product above: every invariant, every turn, every
    // game — the in-flight property the standing requirement asks for.
    expect(invariants * result.games.length * BIG_TOURNAMENT_TURNS).toBeGreaterThan(5_000);
  });

  it('keeps the recorded figures in ONE place, and fails when a site starts restating one', () => {
    // **This is the class fix, checked rather than asserted.** The tournament's cost was
    // recorded independently in five files and all five went stale by 1.66× at once, because a
    // number copied by hand goes stale once per copy. The record is `A3_TOURNAMENT_EVIDENCE`,
    // and this test holds two ends of it:
    //
    //  (1) the record is internally consistent and current — every derived figure is computed
    //      from the raw measurement (so a summary cannot disagree with its own detail), it
    //      describes A3's actual experiment shape, it was measured against the bound the code
    //      enforces, and it carries the provenance a timing needs (when, and under what load);
    //  (2) every site that used to restate the figure *names the record* and states no cost of
    //      its own — scanned in the shipped bytes, not in a copy this test keeps.
    //
    // The second half is a text scan on purpose. A type cannot prevent a comment from quoting a
    // number, and a comment is exactly where all five copies lived.
    expect(A3_TOURNAMENT_EVIDENCE.budgetMs).toBe(DEFAULT_TOURNAMENT_BUDGET_MS);
    expect(A3_TOURNAMENT_EVIDENCE.games.length).toBe(A3_TOURNAMENT_EVIDENCE.seeds.length);
    expect(A3_TOURNAMENT_EVIDENCE.seeds).toEqual([...A3_SEEDS]);
    expect(A3_TOURNAMENT_EVIDENCE.turns).toBe(100);
    expect(A3_TOURNAMENT_EVIDENCE.violations).toBe(0);
    // M7d's *other* half of the same claim, and the one that has no substitute: A3 says the AI
    // plays a complete game unaided, so a non-zero count here would be a record of the wrong
    // thing — twenty games that "reported zero violations" while the planner was throwing
    // mid-turn, leaving partial turns whose metrics look exactly like quiet ones'.
    expect(A3_TOURNAMENT_EVIDENCE.plannerFailures).toBe(0);
    // Derived, not typed: recomputing them from the raw measurement must give the stored value.
    const games = A3_TOURNAMENT_EVIDENCE.games.length;
    expect(A3_TOURNAMENT_EVIDENCE.perGameMs).toBeCloseTo(A3_TOURNAMENT_EVIDENCE.wallMs / games, 9);
    expect(A3_TOURNAMENT_EVIDENCE.headroomMs).toBe(
      A3_TOURNAMENT_EVIDENCE.budgetMs - A3_TOURNAMENT_EVIDENCE.wallMs,
    );
    expect(A3_TOURNAMENT_EVIDENCE.headroomPct).toBeCloseTo(
      (A3_TOURNAMENT_EVIDENCE.headroomMs / A3_TOURNAMENT_EVIDENCE.budgetMs) * 100,
      9,
    );
    // The margin the record has to leave under the bound the code enforces: not 4.2 %, and not
    // negative. A record whose run overran its own bound is a record somebody has to re-measure
    // or re-decide — which is exactly what happened to it twice, once upward and once back down.
    expect(A3_TOURNAMENT_EVIDENCE.headroomPct).toBeGreaterThan(10);
    // A timing without these is not evidence: it cannot be told from a stale figure. And the
    // three clocks are three different numbers, each labelled: the call's own bracket, the
    // harness's reading the verdict uses, and `time`'s end-to-end figure for the command. M7b's
    // A5 failure was comparing one of them against a bound written for another.
    expect(A3_TOURNAMENT_EVIDENCE.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /);
    expect(A3_TOURNAMENT_EVIDENCE.loadAverage).toMatch(/^\d+\.\d+/);
    expect(A3_TOURNAMENT_EVIDENCE.commit).toMatch(/^[0-9a-f]{7}/);
    expect(A3_TOURNAMENT_EVIDENCE.commandWallMs).toBeGreaterThanOrEqual(
      A3_TOURNAMENT_EVIDENCE.wallMs,
    );
    expect(A3_TOURNAMENT_EVIDENCE.harnessElapsedMs).toBeGreaterThan(0);
    // Twenty distinct games, so "the same games" is checkable: the hashes are the receipt.
    const hashes = A3_TOURNAMENT_EVIDENCE.games.map((game) => game.finalHash);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(hashes).size).toBe(games);

    // The scan, read from disk — and **recursive**, because the hand-written version of this
    // check is exactly the failure it exists to prevent. It named four files while
    // `packages/headless/src/cli.ts` still carried its own copy of the number — "about nine
    // minutes (26.0 s per game, 519 s for the twenty)", printed into `civts --help` — in a file
    // the list did not name, so the text scan never read it. A guard that only checks the sites
    // somebody remembered guards against forgetting, not against not knowing.
    //
    // So every shipped source file is walked: `packages/**` and `scripts/**`, minus `test/`
    // directories (a test may construct a figure on purpose, and a test's prose is not a
    // document a reader relies on), plus the repo-root config a reader runs. What survives is a
    // short allowlist, and every entry in it is a file that **explains what replaced** the old
    // figure rather than one that quietly kept it.
    const historyQuoters = new Set([
      'packages/sim/src/tournament.ts', // the record's home: it names the superseded figures
      'packages/testing/test/m7-adversarial.test.ts', // this review's narrative, dated
    ]);
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const sourceFiles = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test') {
            continue;
          }
          sourceFiles(full, out);
          continue;
        }
        if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const scanned: readonly string[] = [
      ...sourceFiles(`${root}packages`),
      ...sourceFiles(`${root}scripts`),
      `${root}vitest.config.ts`,
    ].map((path) => path.slice(root.length));

    // The figures that used to be copied around, plus the prose each copy came wrapped in. Each
    // one is a *claim about the tournament's cost*; none of them belongs in a site that has the
    // record available, because a stale sentence is how a stale number gets re-published.
    const restated = [
      '519.4',
      '527.3',
      '861.8',
      '43.09',
      '26.0 s per game',
      '26.4 s per game',
      '7.7 s per game',
      '2.6 minutes for the twenty',
      '8.8 minutes for the twenty',
      'nine minutes',
      'fifteen-minute budget',
    ];
    // Non-vacuous: the walk has to have found the tree, or "no file restates the figure" is a
    // statement about nothing.
    expect(scanned.length, 'the source walk found no files').toBeGreaterThan(20);
    expect(scanned).toContain('packages/headless/src/cli.ts');
    expect(scanned).toContain('packages/sim/src/tournament.ts');
    expect(scanned).toContain('vitest.config.ts');

    for (const relative of scanned) {
      if (historyQuoters.has(relative)) continue;
      const text = readFileSync(`${root}${relative}`, 'utf8');
      for (const figure of restated) {
        expect(text, `${relative} restates the tournament cost "${figure}"`).not.toContain(figure);
      }
    }
    // And every file allowed to quote history names the record, so a reader who lands on a
    // superseded figure is one line away from the current one — the half of the rule a broken
    // allowlist would quietly drop.
    for (const quoter of historyQuoters) {
      const text = readFileSync(`${root}${quoter}`, 'utf8');
      expect(text, `${quoter} quotes history without naming the record`).toContain(
        'A3_TOURNAMENT_EVIDENCE',
      );
    }
    // The sites the hand-written list used to name are still held to the stronger rule: they
    // must name the one record they take their figures from. `cli.ts` is here because it was the
    // one that was missing — it carried a copy of the number into the usage text.
    const sites: readonly { readonly file: string; readonly path: string }[] = [
      { file: 'tier.ts', path: '../src/tier.ts' },
      { file: 'sim-cli.ts', path: '../../headless/src/sim-cli.ts' },
      { file: 'tournament-evidence.ts', path: '../../../scripts/tournament-evidence.ts' },
      { file: 'vitest.config.ts', path: '../../../vitest.config.ts' },
      { file: 'cli.ts', path: '../../headless/src/cli.ts' },
    ];
    for (const site of sites) {
      const text = readFileSync(fileURLToPath(new URL(site.path, import.meta.url)), 'utf8');
      expect(text, `${site.file} must name the one record it takes its figures from`).toContain(
        'A3_TOURNAMENT_EVIDENCE',
      );
    }

    // **The property the five recorded hashes used to illustrate, asserted live.** A stored
    // hash cannot check this: it goes stale the moment the AI moves, which is exactly what
    // happened to the five literals this test replaced (four of them no longer matched the
    // shipped code, and nothing could tell that from a regression). Two computed values can:
    // the tournament's per-game `finalHash` for a seed is the `runSimulation` hash for that same
    // seed, settings and policies — so a timing taken through the CLI is a timing of the same
    // games as the driver, which is what made the recorded timing a comparison of one experiment
    // rather than of two similar-looking ones.
    //
    // Five seeds, three turns: the property is about *which games* are played, not about how
    // long they are, and the fast tier is where this belongs. The record's own hashes stay in
    // `A3_TOURNAMENT_EVIDENCE` as the timestamp they are.
    const agreementSeeds = [1, 2, 3, 4, 5];
    const agreementTurns = 3;
    const agreeing = runTournament({
      seeds: agreementSeeds,
      settings: SETTINGS,
      ruleset: RULESET,
      policies: [SMART_POLICY, SMART_POLICY],
      maxTurns: agreementTurns,
    });
    expect(agreeing.games.map((game) => game.seed)).toEqual(agreementSeeds);
    for (const game of agreeing.games) {
      const direct = runSimulation({
        seed: game.seed,
        settings: SETTINGS,
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: agreementTurns,
      });
      expect(
        game.finalHash,
        `seed ${String(game.seed)}: the tournament and the driver played different games`,
      ).toBe(direct.finalHash);
      expect(game.turnsPlayed).toBe(direct.turnsPlayed);
    }
    console.log(
      `8. driver/tournament agreement over ${String(agreementSeeds.length)} seeds × ` +
        `${String(agreementTurns)} turns: ${agreeing.games.map((game) => game.finalHash).join(' ')}`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 9. MUTATION-CHECK THE GATE
 * ------------------------------------------------------------------ */

/**
 * **The operational mutation check, recorded.**
 *
 * Two mutations were applied to the shipped `ai/smart.ts`, one at a time, and both were watched
 * to completion. The file's SHA-256 before the first mutation and after the last restoration is
 * `bdb2194788885c71491be20a780c4aef167619ccdf3b025c70cc15283cf6d391`; the two mutated
 * incarnations hashed `c6da745620f9f1e5fd3a5841cf748449cf43f5a9dc6d488e8c4160b0b1e22bd2` and
 * `7e900cc59192c35ff7ca60f0d9fae22f18a1cca1102fa394e330937e5c89477b`, and the restore was
 * byte-identical.
 *
 * **Mutation 1 — make the AI issue an illegal command.** One line was added before `planTurn`'s
 * `return planned`: the player's first unit receives a `MoveUnit` to the tile it already stands
 * on, which `planMove` refuses. Result: **RED**, in two files that share no code —
 * `ai.test.ts` ("has zero refusals over several seeds and turns, non-vacuously": *"seed 3:
 * expected [ …(14) ] to deeply equal []"*, 14 refusals) and this file's section 1 (*"the AI
 * issued commands the applier refused"*). Both counts include the refusal the AI's own
 * `attempt` fold never sees, because the mutant pushes past the fold.
 *
 * **Mutation 2 — make the AI read the world's stream.** `planTurn` was made to
 * `return []` whenever `ctx.state.rng.a` was odd: a policy whose *answers* depend on the world's
 * stream, which is the exact thing the M5 property forbids. Result: this file's section 3a went
 * **RED** (*"expected 2 to be +0"* — two of six shifted world streams changed the answer), and
 * **`ai.test.ts` stayed GREEN**. That green is FINDING D: the author's part (b) varies only the
 * policy's own stream and passes `state` through unchanged, so it cannot see a read of the
 * world's stream. The mutation check is what turned a plausible-looking assertion into a
 * demonstration of a blind spot, and it is the reason this file's probe — not a game
 * comparison, not a trail comparison — is the detector this review relies on.
 *
 * The reason this is recorded in prose rather than asserted here: an assertion about a file's
 * hash would fail the next time the AI is legitimately edited, which is noise rather than a
 * check, and an assertion that `ai.test.ts` is blind would fail the moment A1 fixes it. What
 * *is* asserted, permanently, is that both detectors fire on a mutant — the property the
 * operational check relies on.
 */
describe('9. the gate’s two mutation detectors both fire', () => {
  it('catches the illegal-command mutant and the world-reading mutant', () => {
    const seed = at(SEEDS, 2);
    const started = newGame(seed, SETTINGS, RULESET);
    if (!started.ok) throw new Error('newGame refused');
    const doomed = at(started.value.units, 0);

    // (1) The legality detector: one illegal command is enough.
    const illegalMutant: Policy = {
      name: 'mutation-illegal-command',
      chooseCommands: (ctx: PolicyContext): readonly Command[] => [
        ...SMART_POLICY.chooseCommands(ctx),
        { type: 'MoveUnit', unitId: doomed.id, to: doomed.tile },
      ],
    };
    const illegal = walk(seed, illegalMutant, 2, false);
    expect(illegal.refusals.length, 'the illegal-command mutant went undetected').toBeGreaterThan(
      0,
    );

    // (2) The world-stream detector: a read that changes the answer is a read that is caught.
    const board = aiWalkOf(seed).state;
    const player = asPlayerId(0);
    const probes = [0, 1, 2, 3, 5, 8, 13, 21];
    expect(streamSensitivity(SMART_POLICY, board, player, probes)).toBe(0);
    expect(
      streamSensitivity(worldPeekingTwin(SMART_POLICY), board, player, probes),
      'the world-reading mutant went undetected',
    ).toBeGreaterThan(0);

    console.log(
      `9. mutation detectors: illegal-command refusals=${String(illegal.refusals.length)}, ` +
        `stream-sensitivity real=0 twin>0`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Spawning the real CLI, and a fresh process
 * ------------------------------------------------------------------ */

/** `tsx`'s CLI entry point, resolved or reported as the missing devDependency it would be. */
const tsxCli = (): string => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch (cause) {
    throw new Error(
      'this check needs the `tsx` devDependency (resolved as "tsx/cli"): ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
};

/** The repository root, from this file's own location. */
const repoRoot = (): string => fileURLToPath(new URL('../../../', import.meta.url));

/** What a spawned CLI run produced. */
interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `civts <args…>` in a fresh process, through the real entry point.
 *
 * A spawn rather than an import, because the defect FINDING A records — a command whose
 * function works and whose dispatcher case is missing — is invisible to an import. The same
 * reason `packages/testing/test/m2-adversarial.test.ts` spawns for its REPL transcripts.
 */
const spawnCli = (args: readonly string[]): CliRun => {
  const child = spawnSync(process.execPath, [tsxCli(), 'packages/headless/src/cli.ts', ...args], {
    cwd: repoRoot(),
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
};

/** Run a TypeScript program in a fresh process and return its non-empty stdout lines. */
const runInFreshProcess = (program: string): readonly string[] => {
  const child = spawnSync(process.execPath, [tsxCli(), '-e', program], {
    cwd: repoRoot(),
    encoding: 'utf8',
    timeout: 180_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '');
};
