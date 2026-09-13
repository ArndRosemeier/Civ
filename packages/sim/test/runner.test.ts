/**
 * Evidence for `runSimulation` — the simulation loop.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (point 1) and its
 * "`@civts/sim` contract".
 *
 * The file is organised so that each claim the loop makes is *tested*, not asserted in
 * prose:
 *
 * 1. **Determinism** — twice, in-process, the same seed and policies give the same
 *    final hash and the same metrics sequence.
 * 2. **A violation fires and stops the run** — an invariant that always fails, and one
 *    that fails on a named turn, both caught *by name*, with the state that broke kept
 *    for inspection and nothing played past it. (A registry that has never failed is
 *    evidence of nothing; `invariants.test.ts` covers the shipped registry's own
 *    firing, this file covers the loop's handling of it.)
 * 3. **The policy seam** — policies are polled per civilization in player-id order,
 *    barbarians are never polled, changing a policy changes the game and **not** the
 *    world's RNG stream, and the stream each policy gets is derived from the seed.
 * 4. **The plumbing the contract leaves implicit** — the turn boundary belongs to the
 *    runner (`EndTurn` from a policy is dropped), a refused command cannot move the
 *    state, metrics are structurally keyed and JSON-round-trippable, and the last row's
 *    hash is the run's `finalHash`.
 */

import {
  DEFAULT_SETTINGS,
  asBuildingId,
  asCityId,
  asPlayerId,
  asTileIndex,
  asUnitId,
  newGame,
  nextBelow,
  nextUint32,
  seedRng,
  unitActions,
  type Command,
  type GameState,
  type RngState,
  type RulesetView,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { hashValue } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  CORE_INVARIANTS,
  DO_NOTHING_POLICY,
  METRIC_KEY_ORDER,
  SIMPLE_POLICY,
  plannerFailuresOf,
  plannerReportOf,
  policyRngFor,
  runSimulation,
  smartPolicy,
  type DiagnosedPolicy,
  type Invariant,
  type PlannerFailure,
  type PlannerPhase,
  type Policy,
  type PolicyContext,
  type SimulationOptions,
  type SimulationResult,
  type TurnMetrics,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The real, validated content the CLI runs on — never a hand-made view. */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

const VIEW: RulesetView = RULESET;

const settingsFor = (seed: number, civCount: number = 2): Settings => ({
  ...DEFAULT_SETTINGS,
  seed,
  mapSize: 'duel',
  civCount,
});

/** Options for a run of the shipped policies, with the fields a test varies. */
const optionsFor = (
  seed: number,
  policies: readonly Policy[],
  maxTurns: number,
  extra: { readonly invariants?: readonly Invariant[]; readonly sampleEvery?: number } = {},
): SimulationOptions => ({
  seed,
  settings: settingsFor(seed),
  ruleset: RULESET,
  policies,
  maxTurns,
  ...(extra.invariants === undefined ? {} : { invariants: extra.invariants }),
  ...(extra.sampleEvery === undefined ? {} : { sampleEvery: extra.sampleEvery }),
});

const shipped = (seed: number, maxTurns: number): SimulationResult =>
  runSimulation(optionsFor(seed, [SIMPLE_POLICY, SIMPLE_POLICY], maxTurns));

/** A trace of what the loop handed each policy, so a claim about it can be checked. */
interface Trace {
  readonly polls: { readonly turn: number; readonly playerId: number }[];
  readonly worldRng: RngState[];
  readonly ownRng: RngState[];
  readonly ownDraws: number[];
}

const makeTrace = (): Trace => ({ polls: [], worldRng: [], ownRng: [], ownDraws: [] });

/**
 * A policy that records the context it is handed **and draws from its own stream**.
 *
 * The draw is the point: a policy that consumes randomness must move nothing but its
 * own stream, and this wrapper is what lets a test prove that the world's trajectory is
 * identical under a policy that draws and one that does not.
 */
const recording = (inner: Policy, trace: Trace): Policy => ({
  name: `${inner.name}+recorded`,
  chooseCommands: (ctx: PolicyContext) => {
    trace.polls.push({ turn: ctx.state.turn, playerId: Number(ctx.playerId) });
    trace.worldRng.push(ctx.state.rng);
    trace.ownRng.push(ctx.rng);
    const draw = nextBelow(ctx.rng, 1024);
    trace.ownDraws.push(draw[0]);
    return inner.chooseCommands(ctx);
  },
});

/**
 * A test-only policy: found a city with any settler that may, and do nothing else.
 *
 * Deliberately does **not** move a unit. A step can enter a goody hut, and a hut draws
 * from `state.rng` — so a moving policy would legitimately change the world's stream,
 * and the RNG-independence claim below could not be made cleanly. Founding a city is a
 * real, visible decision that touches no randomness at all.
 */
const FOUND_ONLY: Policy = {
  name: 'test-found-only',
  chooseCommands: (ctx: PolicyContext) => {
    const commands: Command[] = [];
    for (const unit of ctx.state.units) {
      if (unit.owner !== ctx.playerId) continue;
      const found = [...unitActions(ctx.state, ctx.ruleset, unit.id)].find(
        (command) => command.type === 'FoundCity',
      );
      if (found !== undefined) commands.push(found);
    }
    return commands;
  },
};

/** An invariant that reports one violation on every check it is given. */
const ALWAYS_FAILS: Invariant = {
  name: 'always-fails',
  description: 'a deliberately broken property, used to prove the loop stops on a breach',
  check: () => ['this invariant always fails'],
};

/** An invariant that reports nothing until the state's turn reaches four. */
const FAILS_ON_TURN_FOUR: Invariant = {
  name: 'fails-on-turn-four',
  description: 'a scheduled breach, used to prove violations are attributed to a turn',
  check: (ctx) => (ctx.turn === 4 ? ['the world reached turn four'] : []),
};

/** The keys of a metrics row that are not measurements. */
const ROW_KEY_EXTRAS: readonly (keyof TurnMetrics)[] = ['turn', 'playerId', 'hash'];

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('runSimulation — determinism', () => {
  it('gives the same final hash and the same metrics sequence on a repeated run', () => {
    const first = shipped(11, 50);
    const second = shipped(11, 50);

    expect(second.finalHash).toBe(first.finalHash);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.finalState).toEqual(first.finalState);
  });

  it('plays exactly maxTurns turns and reports no violations on a clean run', () => {
    const result = shipped(11, 50);

    expect(result.turnsPlayed).toBe(50);
    expect(result.stoppedBecause).toBe('max-turns');
    expect(result.violations).toEqual([]);
    expect(result.seed).toBe(11);
  });

  it('checks the shipped registry every turn by default, and a run of 50 turns holds', () => {
    // No `invariants` passed: the loop must default to `CORE_INVARIANTS`, not to an
    // empty registry — the difference between "nothing broke" and "nothing was checked".
    const defaulted = shipped(4, 50);
    const explicit = runSimulation(
      optionsFor(4, [SIMPLE_POLICY, SIMPLE_POLICY], 50, { invariants: CORE_INVARIANTS }),
    );

    expect(defaulted.violations).toEqual([]);
    expect(defaulted.finalHash).toBe(explicit.finalHash);

    // ...and an explicitly empty registry really does run nothing: the option is
    // `??`-defaulted, so `[]` means "check nothing" rather than "use the default".
    const unchecked = runSimulation(
      optionsFor(4, [SIMPLE_POLICY, SIMPLE_POLICY], 3, { invariants: [] }),
    );
    expect(unchecked.violations).toEqual([]);
    expect(unchecked.turnsPlayed).toBe(3);
  });

  it('reports a policy that commands nothing as no-commands, over the full horizon', () => {
    const result = runSimulation(optionsFor(9, [DO_NOTHING_POLICY, DO_NOTHING_POLICY], 5));

    // Not an early exit: the run plays every turn it was asked for, and reports that
    // no decision was ever made in them. (Asserted because the distinction is a choice:
    // see the module note on why a quiet turn is not a reason to truncate a run.)
    expect(result.stoppedBecause).toBe('no-commands');
    expect(result.turnsPlayed).toBe(5);
    expect(result.finalState.cities).toEqual([]);
    expect(result.metrics).toHaveLength(10);
  });
});

/* ------------------------------------------------------------------ *
 * Invariants in flight
 * ------------------------------------------------------------------ */

describe('runSimulation — a violation stops the run', () => {
  it('records the named violation and stops on the first violating turn', () => {
    const result = runSimulation(
      optionsFor(3, [SIMPLE_POLICY, SIMPLE_POLICY], 5, {
        invariants: [...CORE_INVARIANTS, ALWAYS_FAILS],
      }),
    );

    expect(result.stoppedBecause).toBe('violation');
    expect(result.turnsPlayed).toBe(1);

    const named = result.violations.filter((violation) => violation.invariant === 'always-fails');
    expect(named).toHaveLength(1);
    expect(named[0]?.message).toBe('this invariant always fails');
    expect(named[0]?.turn).toBe(2);
    // The shipped registry is clean on the same turn: the violation is the injected
    // one, and the loop reported *every* broken property rather than dying on the first.
    expect(result.violations.filter((violation) => violation.invariant !== 'always-fails')).toEqual(
      [],
    );

    // Stopped where it broke: the state that broke is what a caller can inspect, and
    // nothing was played past it.
    expect(result.finalState.turn).toBe(2);
    expect(result.metrics.map((row) => row.turn)).toEqual([2, 2]);
  });

  it('attributes a violation to the turn that produced it', () => {
    const result = runSimulation(
      optionsFor(17, [SIMPLE_POLICY, SIMPLE_POLICY], 10, {
        invariants: [FAILS_ON_TURN_FOUR],
      }),
    );

    expect(result.stoppedBecause).toBe('violation');
    expect(result.turnsPlayed).toBe(3);
    expect(result.violations).toEqual([
      { invariant: 'fails-on-turn-four', turn: 4, message: 'the world reached turn four' },
    ]);
    expect(result.finalState.turn).toBe(4);
  });

  it('runs every invariant of a turn, so one turn can report several broken properties', () => {
    const alsoFails: Invariant = {
      name: 'also-fails',
      description: 'a second broken property',
      check: () => ['and so does this one'],
    };
    const result = runSimulation(
      optionsFor(3, [SIMPLE_POLICY, SIMPLE_POLICY], 5, {
        invariants: [ALWAYS_FAILS, alsoFails],
      }),
    );

    expect(result.violations.map((violation) => violation.invariant).sort()).toEqual([
      'also-fails',
      'always-fails',
    ]);
    expect(result.turnsPlayed).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The policy seam
 * ------------------------------------------------------------------ */

describe('runSimulation — the policy seam', () => {
  it('polls each civilization in player-id order and never polls the barbarian player', () => {
    let barbarianCalls = 0;
    const seen: number[] = [];
    const spy = (inner: Policy): Policy => ({
      name: inner.name,
      chooseCommands: (ctx: PolicyContext) => {
        seen.push(Number(ctx.playerId));
        return inner.chooseCommands(ctx);
      },
    });
    const barbarianSpy: Policy = {
      name: 'barbarian-spy',
      chooseCommands: () => {
        barbarianCalls += 1;
        return [];
      },
    };

    const result = runSimulation(
      optionsFor(
        5,
        // The barbarian player is appended after the civilizations, so its id is the
        // index just past them — the slot a loop over `players` would have polled.
        [spy(SIMPLE_POLICY), spy(SIMPLE_POLICY), barbarianSpy],
        3,
      ),
    );

    expect(barbarianCalls).toBe(0);
    expect(seen).toEqual([0, 1, 0, 1, 0, 1]);
    expect(result.finalState.players.some((player) => player.kind === 'barbarian')).toBe(true);
  });

  it('changes the game when the policy changes, and never the world RNG stream', () => {
    const seed = 21;
    const settings = settingsFor(seed);
    const created = newGame(seed, settings, RULESET);
    if (!created.ok) throw new Error(`newGame(${String(seed)}) failed: ${created.error.kind}`);

    const idleTrace = makeTrace();
    const activeTrace = makeTrace();
    const idle = runSimulation(
      optionsFor(
        seed,
        [recording(DO_NOTHING_POLICY, idleTrace), recording(DO_NOTHING_POLICY, idleTrace)],
        6,
      ),
    );
    const active = runSimulation(
      optionsFor(seed, [recording(FOUND_ONLY, activeTrace), recording(FOUND_ONLY, activeTrace)], 6),
    );

    // The game changed: a policy that founds a city produces a different world...
    expect(active.finalHash).not.toBe(idle.finalHash);
    expect(active.finalState.cities.length).toBeGreaterThan(0);
    expect(idle.finalState.cities).toEqual([]);

    // ...the world's RNG stream did not: the same seed gives the same trajectory of
    // `state.rng` under both policies, and it is exactly the stream generation left
    // behind — no policy drew from it, even though both drew from their own.
    expect(activeTrace.worldRng).toEqual(idleTrace.worldRng);
    expect(idleTrace.worldRng).toHaveLength(12); // 6 turns × 2 civilizations
    for (const rng of idleTrace.worldRng) expect(rng).toEqual(created.value.rng);

    // A policy really did draw — from *its* stream, which is not the world's.
    expect(activeTrace.ownDraws.length).toBeGreaterThan(0);
    expect(activeTrace.ownRng[0]).not.toEqual(activeTrace.worldRng[0]);
    // Per civilization: players 0 and 1 are handed different streams on the same turn.
    expect(activeTrace.ownRng[0]).not.toEqual(activeTrace.ownRng[1]);
    // And the stream is derived from the seed + player index, through sfc32.
    expect(activeTrace.ownRng[0]).toEqual(seedRng(seed));
    expect(activeTrace.ownRng[1]).toEqual(seedRng(seed + 1));
  });

  it('derives one stream per (seed, civilization), advancing one draw per turn', () => {
    expect(policyRngFor(7, asPlayerId(0), 1)).toEqual(seedRng(7));
    expect(policyRngFor(7, asPlayerId(1), 1)).toEqual(seedRng(8));
    expect(policyRngFor(7, asPlayerId(0), 2)).toEqual(nextUint32(seedRng(7))[1]);
    expect(policyRngFor(7, asPlayerId(0), 3)).toEqual(nextUint32(nextUint32(seedRng(7))[1])[1]);
    // Pure: the same arguments always give the same stream, and different players,
    // seeds or turns give different ones.
    expect(policyRngFor(7, asPlayerId(0), 3)).toEqual(policyRngFor(7, asPlayerId(0), 3));
    expect(policyRngFor(7, asPlayerId(0), 1)).not.toEqual(policyRngFor(7, asPlayerId(1), 1));
    expect(policyRngFor(7, asPlayerId(0), 1)).not.toEqual(policyRngFor(8, asPlayerId(0), 1));
    expect(policyRngFor(7, asPlayerId(0), 1)).not.toEqual(policyRngFor(7, asPlayerId(0), 2));
  });

  it('ignores an EndTurn from a policy: the turn boundary is the runner’s', () => {
    let polls = 0;
    const endTurner: Policy = {
      name: 'end-turner',
      chooseCommands: () => {
        polls += 1;
        return [{ type: 'EndTurn' }];
      },
    };

    const result = runSimulation(optionsFor(6, [endTurner, endTurner], 3));

    // Three iterations, three turns: had the command been applied as well, the world
    // would have advanced six times and every metric row would be numbered wrongly.
    expect(result.turnsPlayed).toBe(3);
    expect(result.finalState.turn).toBe(4);
    expect(polls).toBe(6);
    // Nothing was *applied*, so the run honestly reports that it contains no decisions.
    expect(result.stoppedBecause).toBe('no-commands');
  });

  it('cannot be moved by a command the engine refuses', () => {
    const illegal: Policy = {
      name: 'illegal',
      chooseCommands: () => [
        // An unknown unit, and a building id no catalog describes: both are refused
        // with a typed `GameError`, and neither may touch the state.
        { type: 'MoveUnit', unitId: asUnitId(9999), to: asTileIndex(0) },
        {
          type: 'SetProduction',
          cityId: asCityId(9999),
          item: { kind: 'building', id: asBuildingId('nope') },
        },
      ],
    };

    const refused = runSimulation(optionsFor(8, [illegal, illegal], 3));
    const idle = runSimulation(optionsFor(8, [DO_NOTHING_POLICY, DO_NOTHING_POLICY], 3));

    // A refusal returns the input state, so the run is *identical* to one where the
    // policy said nothing — and it continues to the end rather than dying inside a batch.
    expect(refused.finalHash).toBe(idle.finalHash);
    expect(refused.turnsPlayed).toBe(3);
    expect(refused.violations).toEqual([]);
    expect(refused.stoppedBecause).toBe('no-commands');
  });
});

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

describe('runSimulation — metrics', () => {
  it('samples one row per civilization per turn, keyed structurally and JSON-safe', () => {
    const result = shipped(31, 8);

    expect(result.metrics).toHaveLength(8 * 2);
    for (const row of result.metrics) {
      // The declared order, not insertion accident: this is what makes
      // `JSON.stringify(row)` stable for two rows that measure the same thing.
      expect(Object.keys(row)).toEqual([...METRIC_KEY_ORDER]);
      // No key holds `undefined` (canonicalize refuses it, and a JSON round trip
      // would drop it).
      expect(Object.values(row).some((value) => value === undefined)).toBe(false);
      // JSON round-trippable, exactly.
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
      for (const key of METRIC_KEY_ORDER) {
        if (ROW_KEY_EXTRAS.includes(key)) continue;
        const value = row[key];
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }

    // Turn order and player order, ascending and interleaved.
    expect(result.metrics.map((row) => row.turn)).toEqual([
      2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9,
    ]);
    expect(
      result.metrics.filter((row) => row.turn === 5).map((row) => Number(row.playerId)),
    ).toEqual([0, 1]);
    // The last sampled turn is the state the run ended on.
    expect(result.metrics.at(-1)?.hash).toBe(result.finalHash);
  });

  it('measures what the engine says: cities, units and the turn ledger', () => {
    const result = shipped(31, 20);
    const last = result.metrics.at(-1);
    if (last === undefined) throw new Error('the run produced no metrics');
    const finalState = result.finalState;
    const player = finalState.players[Number(last.playerId)];
    if (player === undefined) throw new Error('the row names a player the state does not have');

    const cities = finalState.cities.filter((city) => city.owner === last.playerId);
    expect(last.cities).toBe(cities.length);
    expect(last.population).toBe(cities.reduce((total, city) => total + city.population, 0));
    expect(last.units).toBe(finalState.units.filter((unit) => unit.owner === last.playerId).length);
    expect(last.buildings).toBe(cities.reduce((total, city) => total + city.buildings.length, 0));
    expect(last.treasury).toBe(player.treasury);
    expect(last.beakers).toBe(player.beakers);
    expect(last.luxuries).toBe(player.luxuries);
    // The run really did something: the placeholder policy grows cities and improves
    // the ground, so "no violations" cannot be the result of a game that never moved.
    expect(finalState.cities.length).toBeGreaterThan(0);
    expect(finalState.improvements.length).toBeGreaterThan(0);
    expect(last.population).toBeGreaterThan(0);
  });

  it('samples every Nth turn when asked, starting with the first turn played', () => {
    const every = runSimulation(
      optionsFor(12, [SIMPLE_POLICY, SIMPLE_POLICY], 10, { sampleEvery: 5 }),
    );
    const all = shipped(12, 10);

    expect(every.turnsPlayed).toBe(all.turnsPlayed);
    expect(every.finalHash).toBe(all.finalHash);
    expect(every.metrics.map((row) => row.turn)).toEqual([2, 2, 7, 7]);
    expect(every.metrics).toEqual(all.metrics.filter((row) => row.turn === 2 || row.turn === 7));
  });

  it('plays no turns when maxTurns is zero', () => {
    const created = newGame(13, settingsFor(13), VIEW);
    if (!created.ok) throw new Error('newGame failed');

    const result = shipped(13, 0);

    expect(result.turnsPlayed).toBe(0);
    expect(result.metrics).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.stoppedBecause).toBe('no-commands');
    // Zero turns played is *exactly* the state `newGame` produced: the loop neither
    // advanced the world nor ran a command.
    expect(result.finalState.turn).toBe(1);
    expect(result.finalHash).toBe(hashValue(created.value));
  });
});

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

describe('runSimulation — arguments', () => {
  it('refuses a fractional or negative round count rather than rounding it', () => {
    expect(() => runSimulation(optionsFor(2, [SIMPLE_POLICY, SIMPLE_POLICY], 2.5))).toThrow(
      /maxTurns must be a non-negative whole number/,
    );
    expect(() => runSimulation(optionsFor(2, [SIMPLE_POLICY, SIMPLE_POLICY], -1))).toThrow(
      /maxTurns must be a non-negative whole number/,
    );
  });

  it('refuses a seed that is not a whole number', () => {
    expect(() => runSimulation(optionsFor(0.5, [SIMPLE_POLICY, SIMPLE_POLICY], 2))).toThrow(
      /seed must be a whole number/,
    );
  });

  it('refuses a sampling stride that would sample nothing', () => {
    expect(() =>
      runSimulation(optionsFor(2, [SIMPLE_POLICY, SIMPLE_POLICY], 4, { sampleEvery: 0 })),
    ).toThrow(/sampleEvery must be a positive integer/);
  });

  it('names the civilization whose policy is missing', () => {
    expect(() => runSimulation(optionsFor(2, [SIMPLE_POLICY], 2))).toThrow(/player 1 has none/);
  });

  it('reports an unstartable game instead of returning an empty one', () => {
    // A unit catalog with no settler cannot start a game: `newGame` returns a typed
    // `SetupError`, and the runner has no field in its result to put one in — so it
    // throws rather than returning a plausible, empty run.
    const noUnits: RulesetView = { ...RULESET, units: [] };
    expect(() =>
      runSimulation({
        seed: 2,
        settings: settingsFor(2),
        ruleset: { ...RULESET, units: [] },
        policies: [SIMPLE_POLICY, SIMPLE_POLICY],
        maxTurns: 2,
      }),
    ).toThrow(/no unit for role "settler"/);
    expect(noUnits.units).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * M7d — a planner failure travels in the result
 *
 * The gap M7d closes is one layer above M7c's: a thrown planner error was a *typed* record on
 * the policy, but nothing in the result carried it, so a reader holding only a
 * `SimulationResult` could not tell a **partial turn** from a **quiet one** — same legal
 * command list, same metrics, same invariants, same plausible hash. These tests pin both
 * halves of the distinction and the fact that the carrier is required rather than optional.
 */

/**
 * A policy that throws on every turn it is polled: the real AI, handed a board it cannot read.
 *
 * The fault is the one a policy cannot avoid and cannot be blamed for *choosing* — `state.map`
 * is a throwing getter, so the very first read fails — and it is deliberately injected on the
 * **context** rather than on the run's own state: the runner, its invariants and the final hash
 * must see an ordinary, hashable world, which is exactly the situation the field has to
 * describe. `ai.test.ts` covers the record itself; what this file covers is the *carrier*.
 */
const boardBlindPolicy = (): DiagnosedPolicy => {
  const inner = smartPolicy();
  return {
    name: inner.name,
    chooseCommands: (ctx) =>
      inner.chooseCommands({ ...ctx, state: boardWithoutAReadableMap(ctx.state) }),
    report: () => inner.report(),
  };
};

/**
 * The same state with an unreadable map, built by a getter rather than by a spread field.
 *
 * `Object.defineProperty` rather than an accessor in a literal: an object spread *evaluates*
 * an accessor, so a spread with a throwing getter would throw while building the fixture
 * instead of inside the planner.
 */
const boardWithoutAReadableMap = (state: GameState): GameState => {
  const broken = { ...state };
  Object.defineProperty(broken, 'map', {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new Error('the board is unreadable');
    },
  });
  return broken;
};

const PLANNER_PHASES: readonly PlannerPhase[] = [
  'assembly',
  'cities',
  'research',
  'rates',
  'units',
];

/**
 * **One** policy instance that throws for whichever of its seats are armed, in the pass that seat is
 * given — the shape H2-1 is made of.
 *
 * Modelled on the shipped `smartPolicy` rather than on a convenient fake: `firstByPhase` keeps the
 * first record of each pass, `latestByPhase` is **replaced** by every throw, `failureCount` counts
 * every throw, and the report hands out fresh arrays over those records. That last property is the
 * one the runner reads *through*: a record is a fresh object per throw, as
 * `PolicyReport.latestFailures` promises.
 *
 * It is deliberately **one instance for both seats**, which is the shipped usage — `SMART_POLICY` is
 * a singleton and `batch`, `tournament` and the CLI all hand one instance to every seat — and the
 * whole of H2-1 is that the instance's `latestFailures` list is therefore shared: after a poll it
 * holds the polled seat's record *beside* the records earlier seats' throws left in it. A fixture
 * with one instance per seat could not show the defect at all.
 */
const sharedSeatPolicy = (
  phaseForSeat: (seat: number) => PlannerPhase,
): { readonly policy: DiagnosedPolicy; readonly arm: (seats: readonly number[]) => void } => {
  const firstByPhase = new Map<PlannerPhase, PlannerFailure>();
  const latestByPhase = new Map<PlannerPhase, PlannerFailure>();
  let failureCount = 0;
  let armed: readonly number[] = [];
  const policy: DiagnosedPolicy = {
    name: 'shared-seat',
    chooseCommands: (ctx) => {
      const seat = Number(ctx.playerId);
      if (!armed.includes(seat)) return [];
      const phase = phaseForSeat(seat);
      failureCount += 1;
      const record: PlannerFailure = {
        policy: 'shared-seat',
        turn: ctx.state.turn,
        playerId: seat,
        phase,
        detail: `seat ${String(seat)}`,
        error: `Error: seat ${String(seat)} cannot read the board`,
      };
      if (!firstByPhase.has(phase)) firstByPhase.set(phase, record);
      latestByPhase.set(phase, record);
      return [];
    },
    report: () => ({
      failures: [...firstByPhase.values()],
      latestFailures: [...latestByPhase.values()],
      failureCount,
    }),
  };
  return {
    policy,
    arm: (seats) => {
      armed = seats;
    },
  };
};

describe('runSimulation — M7d: a planner failure is carried in the result', () => {
  it('carries an EMPTY list for a policy that legitimately returns no commands', () => {
    // The control, and half of the distinction the field exists to make. `DO_NOTHING_POLICY`
    // returns an empty list every turn *by design*: it must produce no failures, and the field
    // must still be there — a reader must not be able to confuse "there were none" with
    // "nobody looked".
    const quiet = runSimulation(optionsFor(11, [DO_NOTHING_POLICY, DO_NOTHING_POLICY], 4));

    expect(Object.keys(quiet)).toContain('plannerFailures');
    expect(quiet.plannerFailures).toEqual([]);
    // Never a key holding `undefined`: `canonicalize` refuses one, so a report carrying it
    // could not be written to a file at all.
    expect(JSON.parse(JSON.stringify(quiet.plannerFailures))).toEqual([]);
    expect(quiet.stoppedBecause).toBe('no-commands');
    expect(quiet.turnsPlayed).toBe(4);
  });

  it('carries the typed record, with the turn and the pass, for a policy that throws', () => {
    const broken = boardBlindPolicy();
    const result = runSimulation(optionsFor(11, [broken, broken], 3));

    expect(result.plannerFailures.length).toBeGreaterThan(0);
    const first = result.plannerFailures[0];
    if (first === undefined) throw new Error('the run carried no failure');
    expect(first.policy).toBe(broken.name);
    expect(first.error).toContain('the board is unreadable');
    // The planner always knows where it was: `phase` and `detail` are optional on the record only
    // so that a reporter which cannot say *omits* them, and this one can. Guarded rather than
    // loosened, so a record that came back without them fails here instead of passing a weaker
    // assertion.
    if (first.detail === undefined) throw new Error('the record lost the detail of the pass');
    expect(first.detail.length).toBeGreaterThan(0);
    expect(first.turn).toBeGreaterThanOrEqual(1);
    expect(PLANNER_PHASES).toContain(first.phase);
    expect(Number.isInteger(first.playerId)).toBe(true);

    // The result carries the policy's **own** records — the same objects, not a second shape
    // derived from them — so a reader never has to reconcile two accounts of one throw. There is
    // one entry per seat here, because both seats were polled and both threw: the bound is one
    // entry per (seat, pass) per run, not one per run (see `runner.ts`'s collector, and the
    // reused-instance test at the end of this block for what the entries must name).
    expect(result.plannerFailures).toHaveLength(2);

    // The entries are the report's **own** records — the objects it holds, not a second shape derived
    // from them — which is checked on the run whose policy this is: two seats share `broken`, so
    // `broken`'s report is what the run read and `latestFailures` is the list it read from. The
    // record a run takes is the one that *explains* its throw (the first it saw for that pass), and
    // the policy's list moves on with every later throw, so the run's entry is checked against the
    // report rather than assumed to be its current contents.
    // One seat, so the run's entry is the only thing the report will ever be asked for: the record
    // the run took is a record the policy itself holds, object for object, and the policy's
    // first-per-pass list is the one it was taken from (`latestFailures` moves on with every later
    // throw of the same pass, so the run's entry is the pass's *first* record — the throw the run
    // started failing at — and the report still holds it in `failures`).
    const oneSeat = boardBlindPolicy();
    const solo = runSimulation(optionsFor(11, [oneSeat, DO_NOTHING_POLICY], 3));
    expect(solo.plannerFailures).toHaveLength(1);
    const soloReport = plannerReportOf(oneSeat);
    if (soloReport === undefined) throw new Error('the policy cannot report at all');
    expect(soloReport.failures).toContain(solo.plannerFailures[0]);
    expect(soloReport.failures).toEqual(plannerFailuresOf(oneSeat));
  });

  it('still plays the whole horizon, so the batch’s aggregates keep one horizon', () => {
    // A planner failure is *not* a violation and does not stop the run. That is a decision
    // with a reason: a partial turn leaves a valid, hashable game, while a violated state is
    // one that broke — and truncating here would make the runs of one batch end on different
    // turns, which is the mixed-horizon aggregate the M4b/M5 rule forbids.
    const broken = boardBlindPolicy();
    const result = runSimulation(optionsFor(11, [broken, broken], 4));

    expect(result.turnsPlayed).toBe(4);
    expect(result.metrics.at(-1)?.turn).toBe(5);
    expect(result.violations).toEqual([]);
    expect(result.plannerFailures.length).toBeGreaterThan(0);
  });

  it('is the ONLY difference between such a run and a silent one', () => {
    // The thesis of M7d in one comparison. The AI could decide nothing on a board it cannot
    // read, so the world it produced is byte-for-byte the world a do-nothing policy produces —
    // same final hash, same turns, same metrics — and the only thing in the result that says a
    // planner threw is the field this wave added. Before it, the two were indistinguishable.
    const broken = boardBlindPolicy();
    const withThrow = runSimulation(optionsFor(13, [broken, broken], 3));
    const quiet = runSimulation(optionsFor(13, [DO_NOTHING_POLICY, DO_NOTHING_POLICY], 3));

    expect(withThrow.finalHash).toBe(quiet.finalHash);
    expect(withThrow.turnsPlayed).toBe(quiet.turnsPlayed);
    expect(withThrow.metrics).toEqual(quiet.metrics);
    expect(quiet.plannerFailures).toEqual([]);
    expect(withThrow.plannerFailures.length).toBeGreaterThan(0);
  });

  it('reports only the failures that happened after the run started', () => {
    // The record is cumulative **for the policy instance** — `PolicyReport` keeps the first
    // failure of each pass, and `SMART_POLICY` is a module-level singleton — so a run must
    // claim only what happened during it. This drives the seam directly (`plannerFailuresOf`
    // reads `report()`), which is the only way to tell a stale record from a fresh one
    // without depending on which pass a corrupted board happens to fail in.
    //
    // The two records are the same pass on purpose, which is the case that matters: `cities`
    // already failed before this run began, so `failures` holds `stale` for the rest of the
    // instance's life, and `latestFailures` holds it too — until this run's own throw in that pass
    // replaces it. The count is what says a throw happened during the run; the record it reports is
    // the one `latestFailures` holds *after* that, which is `fresh`. Reading the frozen list instead
    // would name the record of a run that has finished.
    const stale: PlannerFailure = {
      policy: 'driven',
      turn: 1,
      playerId: 0,
      phase: 'cities',
      detail: 'a run that finished before this one',
      error: 'Error: stale',
    };
    const fresh: PlannerFailure = {
      policy: 'driven',
      turn: 2,
      playerId: 0,
      phase: 'cities',
      detail: 'this run',
      error: 'Error: fresh',
    };
    let recorded: readonly PlannerFailure[] = [stale];
    let latest: readonly PlannerFailure[] = [stale];
    let polls = 0;
    const driven: DiagnosedPolicy = {
      name: 'driven',
      chooseCommands: () => {
        polls += 1;
        // This run's throw in a pass that has already failed: the first-per-pass list cannot move,
        // and the latest-per-pass list moves to the record this throw minted.
        if (polls === 1) {
          recorded = [stale];
          latest = [fresh];
        }
        return [];
      },
      // Fresh arrays per call, holding the same records — the shape `PolicyReport` promises.
      report: () => ({
        failures: [...recorded],
        latestFailures: [...latest],
        failureCount: polls,
      }),
    };

    const result = runSimulation(optionsFor(14, [driven, driven], 2));

    // **Re-decided by H2-1: this expectation was `['Error: fresh', 'Error: fresh']` — two entries —
    // and it is one now, because the old value was not a property of the seam at all: it was the
    // *same* `fresh` object named twice.** This fixture hands one record object to both seats (it
    // moves `latest` to `fresh` on the first poll and afterwards only grows the count), while a
    // `PolicyReport` mints a fresh object per throw and never mutates one. A run now takes only the
    // records a poll **minted**, so seat 0's poll names `fresh`, and seat 1's poll — which minted
    // nothing — is named nothing rather than being handed seat 0's record under its own key. That
    // duplicate-record shape is exactly what H2-1 removes. Nothing is silent about the throw: the
    // count still moved for both polls, and the run reports what it can prove. The fixture is left
    // as it is on purpose — this test is about *which* record is read, the run's own `fresh` rather
    // than the frozen `stale`, and the case where both seats really do mint a record (different
    // passes, and a reused instance whose seats are swapped between runs) is pinned by the H2-1
    // tests at the end of this block.
    expect(result.plannerFailures.map((failure) => failure.error)).toEqual(['Error: fresh']);
    expect(result.plannerFailures).not.toContain(stale);
    // The surviving entry is the object this run's poll minted, and it names this run's own turn.
    expect(result.plannerFailures).toContain(fresh);
    expect(result.plannerFailures.map((failure) => failure.turn)).toEqual([2]);
  });

  it('reports a re-throw that the record list cannot show, because the count can (F2-1 and H1)', () => {
    // **Two findings, one fixture, and the fixture's shape is what separates them.**
    //
    // F2-1 (why the baseline is the count): a policy keeps ONE record per pass for the whole life of
    // the instance — `firstByPhase`, exactly like the shipped `smartPolicy` — so a second run that
    // throws in a pass the first run already recorded is handed *the same frozen record object*.
    // Baselining on the identity of the records in `failures` calls that second run clean, which is
    // a silent pass.
    //
    // H1/G2-1 (why the *record* comes from `latestFailures`): the record that made the run visible
    // was the last entry of the frozen list, so the second run reported the FIRST run's turn, player
    // and detail — a throw that did not happen in it. The record it reports now is the policy's
    // **current** record for the pass, which is why the fixture keeps `latestByPhase` beside
    // `firstByPhase`, and why the assertions below pin the throw of the run being described.
    //
    // The fixture is frozen on purpose: `firstByPhase` holds the record minted on the very first
    // throw of each pass and `report()` hands that same object back forever. That is precisely the
    // property that made the old baseline blind to a re-throw, so a test whose fixture minted a
    // fresh record per throw would pass under the old baseline too — it would be decoration. Every
    // assertion here fails on the pre-M7e identity baseline (both runs then report `[]`, because no
    // record in the list is new to the second run) and on the pre-H1 record choice (run 2 then
    // reports turn 1, the record of the run before it).
    const driven = (playerId: number): DiagnosedPolicy => {
      const firstByPhase = new Map<PlannerPhase, PlannerFailure>();
      const latestByPhase = new Map<PlannerPhase, PlannerFailure>();
      let count = 0;
      // The phase's throw ledger: a snapshot per throw, never mutated afterwards, so a run that has
      // taken one keeps the values that throw had (`PolicyReport.latestFailures`).
      const throwRecord = (phase: PlannerPhase, turn: number, detail: string): PlannerFailure => {
        count += 1;
        const record: PlannerFailure = {
          policy: 'driven',
          turn,
          playerId,
          phase,
          detail,
          error: `Error: the board is unreadable for seat ${String(playerId)} (turn ${String(turn)})`,
        };
        if (!firstByPhase.has(phase)) firstByPhase.set(phase, record);
        latestByPhase.set(phase, record);
        return record;
      };
      return {
        name: 'driven',
        chooseCommands: (ctx) => {
          // The turn the state is really on, so "run 2 borrowed run 1's turn" is testable: 1 and 4
          // cannot be confused, and both are turns this fixture was genuinely handed.
          throwRecord('units', ctx.state.turn, 'the units');
          return [];
        },
        // One record per pass, ever — fresh arrays holding the same records, like `firstByPhase`.
        report: () => ({
          failures: [...firstByPhase.values()],
          latestFailures: [...latestByPhase.values()],
          failureCount: count,
        }),
      };
    };
    const seats = [driven(0), driven(1)];

    // Run 1: both seats' records are new to the run, so both are collected — and they name run 1's
    // own turn.
    const first = runSimulation(optionsFor(15, seats, 1));
    expect(first.plannerFailures.map((failure) => failure.turn)).toEqual([1, 1]);
    expect(first.plannerFailures.map((failure) => failure.detail)).toEqual([
      'the units',
      'the units',
    ]);
    for (const failure of first.plannerFailures) {
      expect(failure.phase).toBe('units');
      expect(failure.error).toContain('(turn 1)');
    }

    // Run 2 re-throws in the pass run 1 already recorded, and the *lists it is handed* are the ones
    // that decide what it can report. `failures` is unchanged — the same frozen objects, one per
    // pass, minted in run 1 — so a baseline taken on that list sees nothing new and reports a clean
    // run. The counts moved, so the run is reported, and what it reports is out of
    // `latestFailures`, which run 2's throws have replaced.
    //
    // Both runs are one turn long, deliberately: the fixture hands the policy the turn it is really
    // planning, so with unequal horizons "run 2 reported run 1's turn" and "run 2 reported a turn of
    // its own that happens to have the same number" would be the same assertion. The unequal-horizon
    // case is the next test, which is the defect as it was reported.
    const second = runSimulation(optionsFor(16, seats, 1));

    // The silent pass this pins: run 2 reported NOTHING before F2-1, and it reports its own throw
    // now — the same number of entries as run 1, from the same two seats.
    expect(first.plannerFailures.length).toBeGreaterThan(0);
    expect(second.plannerFailures).toHaveLength(first.plannerFailures.length);
    for (const failure of second.plannerFailures) {
      expect(failure.phase).toBe('units');
      expect(Number.isInteger(failure.playerId)).toBe(true);
    }
    // The entry is the record object the policy minted for that throw — not one borrowed from the
    // frozen first-per-pass list, which is checked to be a *different* object below.
    const seatOf = (index: number): DiagnosedPolicy => {
      const seat = seats[index];
      if (seat === undefined) throw new Error(`no seat ${String(index)}`);
      return seat;
    };
    expect(second.plannerFailures).toContain(seatOf(0).report().latestFailures?.[0]);
    expect(second.plannerFailures).toContain(seatOf(1).report().latestFailures?.[0]);
    for (const failure of second.plannerFailures) {
      expect(seatOf(0).report().failures).not.toContain(failure);
      expect(seatOf(1).report().failures).not.toContain(failure);
    }
    // Run 1 is not retroactively rewritten by run 2: each run kept the record it read.
    expect(first.plannerFailures.map((failure) => failure.error)).toEqual([
      'Error: the board is unreadable for seat 0 (turn 1)',
      'Error: the board is unreadable for seat 1 (turn 1)',
    ]);
    // ...and the two runs do not report the same objects, even though both are about turn 1.
    expect(first.plannerFailures).not.toContain(second.plannerFailures[0]);

    // The count is exactly why: it grew during each run, while each `failures` list stayed at one
    // record per pass — the frozen record of the very first throw in it.
    for (const seat of seats) {
      expect(seat.report().failures).toHaveLength(1);
      expect(seat.report().failures[0]?.turn).toBe(1);
      expect(seat.report().latestFailures).toHaveLength(1);
      expect(seat.report().latestFailures?.[0]?.turn).toBe(1);
      expect(seat.report().failureCount).toBe(2);
      // The two records are different objects with the same turn: this is the fixture property that
      // makes the test discriminate, so it is asserted rather than assumed.
      expect(seat.report().failures[0]).not.toBe(seat.report().latestFailures?.[0]);
    }
  });

  it('names nothing rather than an earlier run, for a report that carries no records', () => {
    // The H1/G2-1 rule at its limit. A `PolicyReport` written before `latestFailures` existed is
    // still a valid report — the field is optional — and its count can still say that a throw
    // happened during a run. What it cannot say is *which* throw: its only list is the
    // first-per-pass one, which on a reused instance holds a record from a run that has finished.
    //
    // Reaching into that list is exactly the defect this wave closes (run B reporting run A's
    // `turn 4 … cities pass`), so the runner reports nothing and keeps the honest part: the count
    // moved, so the run is not silent about having thrown, and no game is stamped with a location
    // that belongs to another.
    const stale: PlannerFailure = {
      policy: 'silent',
      turn: 4,
      playerId: 0,
      phase: 'cities',
      detail: 'city 0',
      error: 'Error: an earlier run left this here',
    };
    let count = 0;
    const silent: DiagnosedPolicy = {
      name: 'silent',
      chooseCommands: () => {
        count += 1;
        return [];
      },
      // No `latestFailures`, and no other change: the shape a pre-H1 reporter has.
      report: () => ({ failures: [stale], failureCount: count }),
    };

    const first = runSimulation(optionsFor(17, [silent, silent], 1));
    const second = runSimulation(optionsFor(18, [silent, silent], 1));

    expect(first.plannerFailures).toEqual([]);
    expect(second.plannerFailures).toEqual([]);
    // The throw is not hidden — it is counted, and the stale record is still the policy's own
    // answer to "which passes have ever failed". What a run does not do is claim it.
    expect(silent.report().failureCount).toBe(4);
    expect(silent.report().failures).toEqual([stale]);
  });

  it('does not hand a reused instance’s later run the earlier run’s turn (H1/G2-1)', () => {
    // **The reported defect, in the exact shape it was reported in.** One smart policy instance —
    // the singleton the batch, the tournament and the CLI all share across every seat of every run
    // — is handed a board it can read for a while and then cannot. Run A goes blind from turn 4;
    // run B, on the same instance, only from turn 6.
    //
    // Run B's planner threw on turns 6, 7 and 8 and on no other turn. Before this fix its result
    // reported `turn 4 … cities pass (city 0)`: the *first* record of the cities pass, frozen onto
    // the instance by run A, read because the count (honestly) moved in run B. The CLI printed
    // exactly that, seed-qualified — `seed 2, turn 4 — smart, player 0, cities pass (city 0)` — for
    // a turn B never failed on. The WHETHER was right and the WHAT was another game's.
    const inner = smartPolicy();
    // The turn both seats' boards stop being readable from; `Infinity` means "not in this run".
    let blindFromTurn = Number.POSITIVE_INFINITY;
    const shared: DiagnosedPolicy = {
      name: inner.name,
      chooseCommands: (ctx) =>
        inner.chooseCommands(
          ctx.state.turn >= blindFromTurn
            ? { ...ctx, state: boardWithoutAReadableMap(ctx.state) }
            : ctx,
        ),
      report: () => inner.report(),
    };

    blindFromTurn = 4;
    const runA = runSimulation(optionsFor(2, [shared, shared], 8));
    blindFromTurn = 6;
    const runB = runSimulation(optionsFor(2, [shared, shared], 8));

    // Run A failed from its own turn 4, and every entry it reports is a cast this run really made:
    // a phase that threw, on a turn the run was on.
    expect(runA.plannerFailures.length).toBeGreaterThan(0);
    for (const failure of runA.plannerFailures) {
      expect(failure.policy).toBe('smart');
      expect(failure.error).toContain('the board is unreadable');
      expect(failure.turn).toBeGreaterThanOrEqual(4);
    }

    // Run B: every entry is one of run B's OWN turns — never run A's turn 4 — and no entry is the
    // record object run A was handed.
    expect(runB.plannerFailures.length).toBeGreaterThan(0);
    for (const failure of runB.plannerFailures) {
      expect(failure.policy).toBe('smart');
      expect(failure.error).toContain('the board is unreadable');
      expect(failure.turn).toBeGreaterThanOrEqual(6);
      expect(runA.plannerFailures).not.toContain(failure);
    }
    // The frozen first-per-pass list is the thing that made the old reading possible, and it is
    // still there — one record per pass, the first one the instance ever made, at run A's turn 4.
    // A run reports from the other list, so the presence of this record cannot reach a result.
    const frozen = inner.report().failures;
    expect(frozen.length).toBeGreaterThan(0);
    for (const stale of frozen) expect(stale.turn).toBe(4);
    for (const stale of frozen) expect(runB.plannerFailures).not.toContain(stale);
  });

  it('names one entry per (seat, pass) when one instance’s seats threw in DIFFERENT passes (H2-1)', () => {
    // **The defect in the shape it was reported in, and the number it must produce.**
    //
    // One instance serves both seats, and the two seats throw in *different* passes: seat 0 in the
    // cities pass, seat 1 in the units pass. Since `latestFailures` holds one entry per pass for the
    // whole instance, seat 1's poll was handed seat 0's record beside its own — and the
    // `(position, phase)` key, which was new for the position, re-appended it. So one run reported
    // **three entries for two real throws in a one-turn run, and four in this three-turn one**: the
    // same record object twice, under `0:cities` and `1:cities`, and `1:cities` named a throw seat 1
    // never made. (It does not stay at three: each seat keeps re-appending the other seat's record
    // under a key of its own that is still new.) That is what a CLI banner showed as
    // "3 PLANNER FAILURES" with a duplicated line, and what `--json` carried.
    //
    // Two entries is the sound number, and the rule that gives it is "a poll may only take what it
    // minted": seat 0's poll took the record its own throw minted, seat 1's poll took its own, and
    // the record that was already in the list when that poll began is not the later seat's to claim.
    // The rest of the seam's promises are asserted here too, because a count is only worth pinning
    // beside them: both seats named, one entry per (seat, pass) and **not** per turn (the planner
    // threw on all three turns of this run), and every entry the seat's own throw.
    //
    // Both numbers above are measured, not argued: with the snapshot check in `runner.ts` removed —
    // the pre-fix read of the whole shared list under the same `(position, phase)` key — this test
    // reports 4 entries for 2 throws, and the re-decided test above reports the same `fresh` record
    // twice. Both go green again the moment the check is restored, which is what makes this a
    // regression test rather than a description.
    const shared = sharedSeatPolicy((seat) => (seat === 0 ? 'cities' : 'units'));
    shared.arm([0, 1]);

    const result = runSimulation(optionsFor(19, [shared.policy, shared.policy], 3));

    // **2 entries, not 3** — and no record object twice, which is the same claim stated so that a
    // duplicated object cannot hide behind a coincidentally equal count.
    expect(result.plannerFailures).toHaveLength(2);
    expect(new Set(result.plannerFailures).size).toBe(2);
    // Each entry is its own seat's throw, in the pass that seat throws in: no entry is seat 0's
    // record wearing seat 1's key, and no entry is named under a (seat, pass) that never threw.
    expect(result.plannerFailures.map((failure) => failure.phase)).toEqual(['cities', 'units']);
    expect(result.plannerFailures.map((failure) => failure.playerId)).toEqual([0, 1]);
    expect(result.plannerFailures.map((failure) => failure.error)).toEqual([
      'Error: seat 0 cannot read the board',
      'Error: seat 1 cannot read the board',
    ]);
    // The first throw of each pass, kept: three turns, two entries. A re-throw inside the run is
    // counted once rather than nagged once per turn.
    expect(result.plannerFailures.map((failure) => failure.turn)).toEqual([1, 1]);
  });

  it('does not hand a later run the OTHER seat’s pre-existing record (H2-1)', () => {
    // The same shared list across two runs, with the seats swapped — the half of H2-1 that survives a
    // narrower fix and is why the runner snapshots the list instead of keying on the record's own
    // `playerId`.
    //
    // Run 1: only seat 0 throws, in the cities pass, so the instance's list holds seat 0's record.
    // Run 2: only seat 1 throws, in the units pass. Keying the entries on `record.playerId` would look
    // right here — the two seats are two keys — and it would be wrong for exactly the record run 2 was
    // handed: the list still holds **run 1's** seat-0 record, its key `0:cities` is new to run 2's log,
    // and a run-2 poll that read the whole list would append it. That is the H1/G2-1 defect for the
    // other seat — a record attributed to a run that did not produce it — and run 2 would report a
    // seat that did not throw in it at all. Measured, not argued: with the key changed to
    // `${record.playerId}:${record.phase}` and the snapshot removed, this test's second assertion
    // received `[0, 1]` — run 1's record claimed by run 2 — while the different-pass count above still
    // passed, which is why this case is the one that decides between the two candidate fixes. What the
    // run takes is what its own polls minted, so run 2 names seat 1's throw and nothing else.
    const shared = sharedSeatPolicy((seat) => (seat === 0 ? 'cities' : 'units'));

    shared.arm([0]);
    const first = runSimulation(optionsFor(20, [shared.policy, shared.policy], 1));
    expect(first.plannerFailures.map((failure) => failure.playerId)).toEqual([0]);
    const seatZeroRecord = first.plannerFailures[0];
    if (seatZeroRecord === undefined) throw new Error('run 1 reported nothing for seat 0');
    expect(seatZeroRecord.phase).toBe('cities');
    expect(seatZeroRecord.turn).toBe(1);

    shared.arm([1]);
    const second = runSimulation(optionsFor(21, [shared.policy, shared.policy], 1));
    expect(second.plannerFailures.map((failure) => failure.playerId)).toEqual([1]);
    expect(second.plannerFailures.map((failure) => failure.phase)).toEqual(['units']);
    expect(second.plannerFailures).not.toContain(seatZeroRecord);

    // And a run in which nobody threw is clean on the same reused instance whose list still holds both
    // earlier records: a pre-existing record does not make a later run fail. This is the "healthy
    // shared instance reports nothing" half, read on an instance that is no longer healthy-in-the-past.
    shared.arm([]);
    const third = runSimulation(optionsFor(22, [shared.policy, shared.policy], 1));
    expect(third.plannerFailures).toEqual([]);
  });
});
