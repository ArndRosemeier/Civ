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
  CORE_INVARIANTS,
  DO_NOTHING_POLICY,
  MEASURED_METRIC_FIELDS,
  SIMPLE_POLICY,
  aggregateRuns,
  applyOverrides,
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

/**
 * The shipped catalog with the score condition's horizon moved to turn 1.
 *
 * The real applier (`applyOverrides`) plus validation, exactly as a sweep would do it: the
 * engine's own rule with one catalog number changed, rather than a second rule. It is what makes
 * a **decided** batch affordable in the fast tier — the score condition is the only one that
 * fires on a horizon of a couple of turns.
 */
const DECIDED_RULESET: Ruleset = (() => {
  const validated = validateRuleset(
    applyOverrides(CATALOG, { victory: { scoreVictoryTurn: 1 } }),
    'tuned',
  );
  if (!validated.ok) {
    throw new Error(
      `the patched catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

/** A batch whose games really end — see `DECIDED_RULESET`. */
const decidedBatchOf = (
  seeds: readonly number[],
  policies: BatchOptions['policies'],
): BatchResult =>
  runBatch({
    seeds,
    settings: settingsFor(1),
    ruleset: DECIDED_RULESET,
    policies,
    maxTurns: 3,
  });

const NO_EVENTS: readonly GameEvent[] = [];

/**
 * A policy that throws on every turn it is polled: the real AI, handed a board it cannot read.
 *
 * The same fixture `runner.test.ts` and `tournament.test.ts` use, and deliberately a **single**
 * instance handed to both seats of both runs: that is what a real batch does, and it is what makes
 * the record's own rule visible — one first failure per planning pass, recorded in the run where
 * it happened — while the runner's own rule (`failureCount`, not record identity) is what keeps
 * the *second* run's throw from being mistaken for a clean one. See the expectation below, which
 * was re-decided for exactly that reason.
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
  it('omits wins when no game in the batch ended', () => {
    const batch = batchOf([15, 16], 3);

    // Omitted, never a key holding `undefined` — and not `wins: []` either, which would
    // claim victories were counted and that none happened. The name of this test used to say
    // "because the engine has no victory condition to count", which stopped being true at M10:
    // what is asserted is the *absence of endings* in this batch, not the absence of the rule
    // (`decidedBatchOf` below is the same command with a batch that does end).
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

  it('counts a decided batch by condition, and names every player that won one', () => {
    // **The wins list was never tested with a win in it** — this test exists because a fold that
    // only ever returned `[]` (or was omitted) looked identical to one that worked. The fixture is
    // the shipped catalog with the score condition's horizon moved to turn 1 through the real
    // applier: one seat founds a city and the other does nothing, so the score condition decides
    // every game at the first turn it is evaluated.
    //
    // A batch does **not** rotate its policies (that is the tournament's job), so the same player
    // wins every game here — which is exactly why the row must count wins *per player* rather than
    // keep one: the old field kept the first winner and dropped the rest, so a row could read
    // `count: 5, winner: 0` while three of those games were won by player 1.
    const batch = decidedBatchOf([1, 2], [SIMPLE_POLICY, DO_NOTHING_POLICY]);

    expect(batch.runs.map((run) => run.outcome?.condition)).toStrictEqual(['score', 'score']);
    expect(batch.wins).toStrictEqual([
      { outcome: 'score', count: 2, byPlayer: [{ playerId: 0, wins: 2 }], draws: 0 },
    ]);
    // The identities the row carries: the count is the winners plus the drawn games, and the
    // winners are exactly the runs' own outcomes rather than a second count of them.
    for (const win of batch.wins ?? []) {
      const won = win.byPlayer.reduce((total, row) => total + row.wins, 0);
      expect(win.count).toBe(won + win.draws);
      expect(win.count).toBe(
        batch.runs.filter((run) => run.outcome?.condition === win.outcome).length,
      );
    }
  });

  it('carries a counted check total per run, and sampling does not thin it out (Q1/F2)', () => {
    // **A run's `invariantChecks` is a count of the predicate invocations, not a function of
    // anything else in the row.** Two properties are asserted together because either alone
    // would be weak: the metric sample can be thinned by `sampleEvery` (so the aggregates really
    // do shrink — a fixture where they did not would make the second half vacuous), while the
    // registry runs on every **turn**, sampled or not. A figure tied to sampled rows, or derived
    // from the horizon by a reader, would fail here.
    const dense = batchOf([1, 2], 4);
    const sparse = runBatch({
      seeds: [1, 2],
      settings: settingsFor(1),
      ruleset: RULESET,
      policies: [SIMPLE_POLICY, SIMPLE_POLICY],
      maxTurns: 4,
      sampleEvery: 4,
    });

    const turns = [4, 4]; // four turns each, nothing decided at this horizon
    expect(dense.runs.map((run) => run.turnsPlayed)).toStrictEqual(turns);
    expect(sparse.runs.map((run) => run.turnsPlayed)).toStrictEqual(turns);

    // Non-vacuity: sampling really did thin the rows the aggregates fold.
    const denseRows = dense.aggregates.find((row) => row.metric === 'treasury')?.count ?? 0;
    const sparseRows = sparse.aggregates.find((row) => row.metric === 'treasury')?.count ?? 0;
    expect(denseRows).toBeGreaterThan(sparseRows);
    expect(sparseRows).toBeGreaterThan(0);

    // ...and every run of both, decided or not, sampled or not, reports one check per turn per
    // registry entry — the number the batch report sums. A run whose deciding turn was skipped
    // would report `turnsPlayed - 1` here.
    for (const run of [...dense.runs, ...sparse.runs]) {
      expect(run.invariantChecks).toBe(run.turnsPlayed * CORE_INVARIANTS.length);
    }
    // The decided fixture too, since that is the case F2 was about.
    const decided = decidedBatchOf([1, 2], [SIMPLE_POLICY, DO_NOTHING_POLICY]);
    expect(decided.runs.map((run) => run.outcome?.condition)).toStrictEqual(['score', 'score']);
    for (const run of decided.runs) {
      expect(run.invariantChecks).toBe(run.turnsPlayed * CORE_INVARIANTS.length);
    }
  });

  it('orders the wins by condition id, whatever order the seeds arrived in', () => {
    // Two conditions in one batch is not reachable on this catalog at a test's horizon, so the
    // ordering rule is checked on the one row a batch can produce plus the *seed permutation*
    // property the whole file is built on: the same games in a different order give the same
    // wins, field for field.
    const forwards = decidedBatchOf([1, 2, 3], [SIMPLE_POLICY, DO_NOTHING_POLICY]);
    const backwards = decidedBatchOf([3, 2, 1], [SIMPLE_POLICY, DO_NOTHING_POLICY]);

    expect(backwards.wins).toStrictEqual(forwards.wins);
    expect(forwards.wins?.map((win) => win.outcome)).toStrictEqual(['score']);
    expect(forwards.wins?.[0]?.count).toBe(3);
    expect(forwards.wins?.[0]?.byPlayer).toStrictEqual([{ playerId: 0, wins: 3 }]);
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

    // **Re-decided twice, and both decisions are recorded rather than deleted.**
    //
    // M7e's follow-up (F2-1) re-decided this from `[true, false]`. That pinned a *silent pass*: the
    // fixture hands ONE policy instance to both runs, and the planner throws on every turn of both,
    // while the runner then baselined the log on record *identity* — and `PolicyReport.failures`
    // keeps only the first failure per pass for the life of the instance, so run 2 re-threw in a
    // pass run 1 had already recorded, was handed the same record object, and reported *nothing*.
    // The count is now the baseline, so the second run reports its own throw.
    //
    // H1/G2-1 re-decided the **number** from `[1, 1]` to `[2, 2]`. One entry per run was not a
    // property of the seam: it was an artefact of the record the runner read. Both seats share this
    // instance and **both** threw, on every turn of every run, and the pass they threw in is the
    // same for both (`research` — the map is the first thing the city pass reads, so a board that
    // cannot be read at all fails there). A record frozen per pass therefore collapsed two seats
    // into one line, and the run reported one seat's throw while silently dropping the other's.
    // What a run reports is now one entry per (seat, pass) it saw throw, so two seats are two
    // entries — and the count is still not one per turn: both threw on all three turns of both
    // runs and each run carries two, not twelve.
    //
    // Still true, and deliberately: the record is attributed to the run that produced it (run 1
    // is not handed run 2's), a re-throw inside one run is not nagged once per turn, and a game is
    // never accused of a failure it did not cause.
    expect(batch.runs.map((run) => run.plannerFailures.length)).toEqual([2, 2]);
    expect(batch.runs.map((run) => run.plannerFailures.map((failure) => failure.error))).toEqual([
      ['Error: the board is unreadable', 'Error: the board is unreadable'],
      ['Error: the board is unreadable', 'Error: the board is unreadable'],
    ]);
    // Two seats, so the two entries of one run are two players' throws and not one throw twice.
    expect(batch.runs[0]?.plannerFailures.map((failure) => failure.playerId)).toEqual([0, 1]);
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
