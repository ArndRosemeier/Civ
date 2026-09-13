/**
 * Evidence for `runBatch` and `aggregateRuns` — the batch half of the standing
 * requirement ("a batch of 50+ games runs headlessly in a bounded time and reports
 * aggregates").
 *
 * The two properties the contract names are the two this file exists to prove:
 *
 * 1. **Order independence.** The same seeds supplied in a different order give an
 *    identical `BatchResult` — runs *and* aggregates — and `aggregateRuns` gives the
 *    same answer for runs handed to it in any order or with their rows rearranged. The
 *    aggregate is folded over a **sorted key set** (runs by ascending seed, rows in the
 *    order `sampleTurn` produced them) and over an **array of metric names**, never
 *    over `Object.keys` of a row.
 * 2. **Floating point cannot creep in.** Every value the aggregate folds is an integer,
 *    the sum is carried beside the mean so `mean === sum / count` is checkable, and the
 *    median is a value that really occurred. `sum` being whole is the property that
 *    makes summation order irrelevant; the code still folds in canonical order rather
 *    than relying on it.
 *
 * A third, structural claim is checked too: the aggregate list covers **every** measured
 * field of a row, exactly once. A field added to `TurnMetrics` and forgotten here would
 * otherwise be a column silently missing from every balance report — the failure mode
 * "the structured value does not contain the figure the summary shows" is the M2
 * provenance bug, and this is its guard on the batch side.
 */

import {
  DEFAULT_SETTINGS,
  asPlayerId,
  civPlayers,
  newGame,
  type GameEvent,
  type GameState,
  type RulesetView,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { describe, expect, it } from 'vitest';
// The **test tier** predicate: this file's long sweeps are `it.skipIf(!FULL_TIER)` —
// they run under `pnpm verify:full` and are reported as skipped by `pnpm verify`. The
// boundary and its reasoning live in `@civts/testing`'s `tier.ts`, once.
import { FULL_TIER } from '@civts/testing';

import {
  DO_NOTHING_POLICY,
  MEASURED_METRIC_FIELDS,
  SIMPLE_POLICY,
  aggregateRuns,
  playerMetrics,
  runBatch,
  smartPolicy,
  type BatchOptions,
  type BatchResult,
  type DiagnosedPolicy,
  type MetricAggregate,
  type TurnMetrics,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

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

const settingsFor = (seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  seed,
  mapSize: 'duel',
  civCount: 2,
});

/** A short batch: enough turns for cities to appear, small enough to run in a test. */
const batchOf = (
  seeds: readonly number[],
  maxTurns: number,
  policies: BatchOptions['policies'] = [SIMPLE_POLICY, SIMPLE_POLICY],
): BatchResult =>
  runBatch({
    seeds,
    // `settings.seed` is stored verbatim in each state; the batch's per-seed seed is
    // what drives generation, so the settings' own seed is irrelevant here.
    settings: settingsFor(1),
    ruleset: RULESET,
    policies,
    maxTurns,
  });

const NO_EVENTS: readonly GameEvent[] = [];

/**
 * A policy that throws on every turn it is polled: the real AI, handed a board it cannot read.
 *
 * The same fixture `runner.test.ts` and `tournament.test.ts` use, and deliberately a **single**
 * instance handed to both seats of both runs: that is what a real batch does, and it is what
 * makes the record's own rule visible — one first failure per planning pass, recorded in the run
 * where it happened, which is why the two runs below do not report the same failure twice.
 */
const boardBlindBatchPolicy = (): DiagnosedPolicy => {
  const inner = smartPolicy();
  return {
    name: inner.name,
    chooseCommands: (ctx) =>
      inner.chooseCommands({ ...ctx, state: boardWithoutAReadableMap(ctx.state) }),
    report: () => inner.report(),
  };
};

/** The same state with an unreadable map — a getter, so the throw happens inside the planner. */
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

const rowsOf = (batch: BatchResult): readonly TurnMetrics[] =>
  batch.runs.flatMap((run) => run.metrics);

const aggregateOf = (aggregates: readonly MetricAggregate[], metric: string): MetricAggregate => {
  const found = aggregates.find((aggregate) => aggregate.metric === metric);
  if (found === undefined) throw new Error(`no aggregate for ${metric}`);
  return found;
};

/** What the 50-game batch is called, so the bound below reads beside its name. */
const BATCH_TEST_NAME = 'runs 50 games and reports aggregates over every row of every one';

/**
 * The bound on the 50-game batch, in milliseconds.
 *
 * "A batch of 50+ games runs headlessly in a **bounded time**" is enforced by the test
 * runner rather than measured with a clock, and deliberately so: this package is
 * forbidden to read one — `performance.now`, `Date.now` and `process.hrtime` are banned
 * in every file of it, tests included, because the standing requirement's determinism
 * rule is total. Twenty seconds against a measured ~1.5 is a bound, not a benchmark; a
 * batch that stopped being bounded fails here instead of being reported as a number
 * nobody watches.
 */
const BATCH_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ *
 * Order independence
 * ------------------------------------------------------------------ */

describe('runBatch — deterministic order', () => {
  it('runs the seeds it was given in ascending order', () => {
    const batch = batchOf([3, 1, 2], 4);
    expect(batch.runs.map((run) => run.seed)).toEqual([1, 2, 3]);
  });

  it('reports an identical batch when the seeds arrive in a different order', () => {
    const ascending = batchOf([1, 2, 3], 6);
    const shuffled = batchOf([3, 1, 2], 6);
    const reversed = batchOf([3, 2, 1], 6);

    expect(shuffled).toEqual(ascending);
    expect(reversed).toEqual(ascending);
  });

  it('aggregates identically however the runs are handed in', () => {
    const batch = batchOf([4, 5, 6], 5);
    const [first, second, third] = batch.runs;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('the batch produced fewer runs than it was given seeds');
    }

    expect(aggregateRuns([third, first, second])).toEqual(batch.aggregates);
    expect(aggregateRuns([...batch.runs].reverse())).toEqual(batch.aggregates);
    // Reordering the *rows* inside a run changes nothing either: the values are whole
    // numbers, so the fold cannot depend on the order the terms arrive in.
    const rearranged = batch.runs.map((run) => ({ ...run, metrics: [...run.metrics].reverse() }));
    expect(aggregateRuns(rearranged)).toEqual(batch.aggregates);
  });

  it('runs a repeated seed twice, because the caller asked for two games', () => {
    const batch = batchOf([7, 7], 3);

    expect(batch.runs).toHaveLength(2);
    expect(batch.runs[0]?.finalHash).toBe(batch.runs[1]?.finalHash);
    // The aggregate follows the runs: the same game counted twice.
    const cities = aggregateOf(batch.aggregates, 'cities');
    expect(cities.count).toBe(2 * 3 * 2);
  });
});

/* ------------------------------------------------------------------ *
 * The arithmetic
 * ------------------------------------------------------------------ */

describe('aggregateRuns — the arithmetic, checked against its own rows', () => {
  it('reports count, sum, mean, median, min and max of a metric over every row', () => {
    const batch = batchOf([11, 12, 13], 8);
    const rows = rowsOf(batch);
    const population = aggregateOf(batch.aggregates, 'population');

    const values = rows.map((row) => row.population);
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((total, value) => total + value, 0);

    expect(population.count).toBe(rows.length);
    expect(population.sum).toBe(sum);
    expect(population.mean).toBe(sum / rows.length);
    expect(population.min).toBe(sorted[0]);
    expect(population.max).toBe(sorted[sorted.length - 1]);
    // The lower middle of an ascending copy: a value that really occurred, and the one
    // degree of freedom "median" has on an even count, pinned.
    expect(population.median).toBe(sorted[Math.floor((sorted.length - 1) / 2)]);

    // Whole numbers in, whole numbers out — the property that makes the sum's order
    // irrelevant — and the mean is the only non-integer in the report.
    expect(Number.isInteger(population.sum)).toBe(true);
    expect(population.min).toBeLessThanOrEqual(population.median);
    expect(population.median).toBeLessThanOrEqual(population.max);
  });

  it('covers every measured field of a row exactly once, in a fixed order', () => {
    const batch = batchOf([14], 3);
    expect(batch.aggregates.map((aggregate) => aggregate.metric)).toEqual(MEASURED_METRIC_FIELDS);

    // Completeness, checked against a real row rather than against the list: a field
    // that is measured but not aggregated would be a column missing from every report.
    const created = newGame(14, settingsFor(14), VIEW);
    if (!created.ok) throw new Error('newGame failed');
    const player = civPlayers(created.value)[0];
    if (player === undefined) throw new Error('the fixture has no civilizations');
    const row = playerMetrics(created.value, player.id, VIEW, NO_EVENTS);
    const measured = Object.keys(row)
      .filter((key) => key !== 'turn' && key !== 'playerId' && key !== 'hash')
      .sort();

    expect(measured).toEqual([...MEASURED_METRIC_FIELDS].sort());
    expect(measured).toHaveLength(MEASURED_METRIC_FIELDS.length);
    // The identity fields and the hash are deliberately not aggregated.
    expect(MEASURED_METRIC_FIELDS).not.toContain('turn');
    expect(MEASURED_METRIC_FIELDS).not.toContain('playerId');
    expect(MEASURED_METRIC_FIELDS).not.toContain('hash');
  });

  it('is an empty, zero-count report for a batch of no games', () => {
    const batch = batchOf([], 5);

    expect(batch.runs).toEqual([]);
    expect(batch.aggregates).toHaveLength(MEASURED_METRIC_FIELDS.length);
    for (const aggregate of batch.aggregates) {
      expect(aggregate.count).toBe(0);
      expect(aggregate.sum).toBe(0);
      expect(aggregate.mean).toBe(0);
      expect(aggregate.median).toBe(0);
      expect(aggregate.min).toBe(0);
      expect(aggregate.max).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Honestly absent fields, and a serialisable report
 * ------------------------------------------------------------------ */

describe('BatchResult — what it does not claim', () => {
  it('omits wins, because the engine has no victory condition to count', () => {
    const batch = batchOf([15, 16], 3);

    // Omitted, never a key holding `undefined` — and not `wins: []` either, which would
    // claim victories were counted and that none happened.
    expect('wins' in batch).toBe(false);
    expect(Object.keys(batch).sort()).toEqual(['aggregates', 'runs']);
  });

  it('holds no undefined keys anywhere: the report survives a JSON round trip', () => {
    const batch = batchOf([17], 3);

    // `JSON.stringify` drops a key holding `undefined`, so an unequal round trip is
    // exactly the "unhashable key" bug `canonicalize` refuses, caught here as well.
    expect(JSON.parse(JSON.stringify(batch))).toEqual(batch);
    for (const run of batch.runs) {
      for (const row of run.metrics) {
        expect(Object.values(row).some((value) => value === undefined)).toBe(false);
      }
    }
  });

  it('reports a batch of runs that commanded nothing as no-commands, per run', () => {
    const batch = batchOf([18, 19], 4, [DO_NOTHING_POLICY, DO_NOTHING_POLICY]);

    expect(batch.runs.map((run) => run.stoppedBecause)).toEqual(['no-commands', 'no-commands']);
    expect(batch.runs.every((run) => run.turnsPlayed === 4)).toBe(true);
  });

  it('carries a planner failure per run, without inventing a batch-level one (M7d)', () => {
    // A batch has no aggregate for the failure channel and must not grow one: the records are
    // the runs' own (`BatchResult` stays `runs` + `aggregates`, asserted above), which is what
    // makes the CLI's aggregation over them a *read* rather than a second statement of the rule.
    //
    // The other half is the horizon rule. A planner failure does not stop a run — only a
    // violation does — so a batch in which every planner threw still folds every aggregate over
    // one horizon, and that is asserted here rather than assumed: a truncating failure would make
    // the rows of one batch end on different turns, and a mean over games of different lengths is
    // the arithmetic the M4b/M5 rule forbids.
    const broken = boardBlindBatchPolicy();
    const batch = batchOf([31, 32], 3, [broken, broken]);

    expect(batch.runs.map((run) => run.plannerFailures.length > 0)).toEqual([true, false]);
    // Nothing the invariants saw was wrong, and nothing stopped early.
    expect(batch.runs.every((run) => run.violations.length === 0)).toBe(true);
    expect(batch.runs.every((run) => run.turnsPlayed === 3)).toBe(true);
    expect(batch.runs.every((run) => run.stoppedBecause !== 'violation')).toBe(true);
    // One row per civilization per turn, for every run: one horizon, folded whole.
    const cities = aggregateOf(batch.aggregates, 'cities');
    expect(cities.count).toBe(2 * 3 * 2);
    expect(aggregateOf(batch.aggregates, 'units').count).toBe(2 * 3 * 2);
  });
});

/* ------------------------------------------------------------------ *
 * Scale
 * ------------------------------------------------------------------ */

describe('runBatch — at scale, headlessly', () => {
  // Full tier: a 50-game batch on real content was 2.6 s of the fast tier, and it is a *batch* —
  // the thing the standing requirement sends here. It is the only test that runs the shipped
  // registry at that width, so it is what catches an aggregate that only breaks at scale
  // (per-civilization rows, ordering, the stop-reason histogram).
  it.skipIf(!FULL_TIER)(
    BATCH_TEST_NAME,
    () => {
      const seeds = Array.from({ length: 50 }, (_, index) => 100 + index);

      const batch = runBatch({
        seeds,
        settings: settingsFor(1),
        ruleset: RULESET,
        policies: [SIMPLE_POLICY, SIMPLE_POLICY],
        maxTurns: 5,
        // Hashing the whole state every turn is the expensive half of a run; hashing
        // every turn is what a full report does, and a sweep that only wants aggregates
        // asks for every row anyway.
        sampleEvery: 1,
      });

      expect(batch.runs).toHaveLength(50);
      expect(batch.runs.every((run) => run.turnsPlayed === 5)).toBe(true);
      const cities = aggregateOf(batch.aggregates, 'cities');
      const population = aggregateOf(batch.aggregates, 'population');
      expect(cities.count).toBe(50 * 5 * 2);
      // Non-vacuous: the games really did grow cities within their five turns.
      expect(cities.sum).toBeGreaterThan(0);
      expect(population.max).toBeGreaterThan(0);
    },
    BATCH_TIMEOUT_MS,
  );

  it('measures the same civilization count the state does, for every run', () => {
    const batch = batchOf([21, 22], 3);
    for (const run of batch.runs) {
      expect(run.metrics).toHaveLength(run.turnsPlayed * civPlayers(run.finalState).length);
      // Barbarians are a player but not a civilization: no row may name them.
      const barbarian = run.finalState.players.find((player) => player.kind === 'barbarian');
      expect(barbarian).toBeDefined();
      expect(run.metrics.some((row) => row.playerId === asPlayerId(Number(barbarian?.id)))).toBe(
        false,
      );
    }
  });
});
