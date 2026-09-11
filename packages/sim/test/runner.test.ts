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
  policyRngFor,
  runSimulation,
  type Invariant,
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
