/**
 * `runBatch` — many games, and the aggregates a balance decision is made from.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" ("Batch running
 * and aggregation") and its acceptance line "a batch of 50+ games runs headlessly in
 * a bounded time and reports aggregates".
 *
 * ## What it does
 *
 * One whole game per seed through `runSimulation`, all in-process and headless, then
 * `mean`/`median`/`min`/`max` for every measured metric across every row of every
 * run. Nothing here plays a game itself: this module is a fold, and the engine, the
 * policies and the invariant registry are the same objects a single run uses — a
 * batch that took a different path through the engine would be measuring a different
 * game.
 *
 * ## The two order-independence guarantees, stated rather than hoped for
 *
 * The contract requires that aggregation "never depend on object key order or on
 * floating-point summation order". Those are two separate properties with two
 * separate mechanisms:
 *
 * 1. **Object key order** never enters. The metric list is
 *    `MEASURED_METRIC_FIELDS` — an *array*, in the contract's reading order — never
 *    `Object.keys` of a row, whose order is insertion order. Rows are folded in
 *    **canonical order**: runs sorted by ascending seed (a stable sort, so two runs of
 *    one seed keep the order they were given, which is immaterial because two runs of
 *    one seed with one policy list are equal), then within a run the metrics array in
 *    the order `sampleTurn` produced it, which is turn ascending and player-id
 *    ascending. Two batches that agree on the data therefore agree on the report byte
 *    for byte, and `batch.test.ts` proves it by running one batch's seeds in two
 *    different orders and comparing the whole `BatchResult`.
 * 2. **Floating-point summation order** never enters, because there is no
 *    floating-point summation. Every aggregated value is an **integer** — every
 *    measured field is an integer count, total or pool, and integers are exact in
 *    IEEE-754 doubles below 2^53 — so the sum is a whole number whatever order the
 *    terms are folded in; the code still folds them in canonical order rather than
 *    relying on that. `sum` is carried beside `mean` so a reader can check
 *    `mean === sum / count` and see that the sum is whole, instead of trusting an
 *    accumulated average (which *would* be order-dependent, and is exactly what this
 *    module does not do). `mean` is the only non-integer field in the report, and it
 *    is a division of two exact quantities.
 *
 * `median` has one remaining degree of freedom — which value is "the middle" on an
 * even count — and it is pinned: the **lower middle** value of an ascending copy,
 * which is a value that really occurred. `min`/`max` are folds; on an empty batch every
 * aggregate is `0` with `count: 0`, which is the type's own documented reading rather
 * than an invented sentinel.
 *
 * ## Wins
 *
 * `BatchResult.wins` is **absent** — the key omitted, never written as an empty list —
 * when no game in the batch ended. M5 wrote that rule when the engine had no victory
 * condition at all and said what would change it: "when a victory condition exists, the
 * counts go here ordered by outcome name". M10 is that milestone. A batch in which some
 * games reached a condition now reports them, **ordered by condition id** so the list is
 * independent of the order the seeds were supplied in (the same reason the runs are
 * sorted), and `wins` stays absent when nothing ended, because a batch that played twenty
 * games to the turn limit has no outcome distribution to report and `wins: []` would
 * claim one had been measured.
 *
 * Counted from each run's own `outcome`, which the runner derives from that run's final
 * state — so a win count here and the `outcome` on the run it came from are the same
 * fact, never two.
 *
 * ## The planner-failure channel: carried verbatim, never summarised away (M7d)
 *
 * Each run's `plannerFailures` travels out of `runSimulation` on the run itself, and
 * that is deliberate: a batch's job is to fold *metric rows*, and a planner failure is
 * not a row — it is a fact about the run's **evidence**. Turning it into a rate ("2 % of
 * turns had a planner failure") would be exactly the averaging-away the contract forbids
 * of a violation, and folding it into the aggregate table would put a non-metric column
 * in a table whose every other column is an integer the engine measured.
 *
 * So nothing here filters, caps, deduplicates or summarises it; `runs` is handed back
 * whole, which is the only mechanism that *cannot* drop a field. `BatchResult` gains no
 * top-level `plannerFailures`: the frozen contract puts that aggregate on
 * `TournamentResult` (where a single pass/fail verdict needs it), and inventing a second
 * place for it here would be a second answer to the same question. A caller that wants
 * the flat list over a batch writes the same one line the tournament does —
 * `batch.runs.flatMap((run) => run.plannerFailures)` — and `sim-cli.ts` does.
 *
 * **The horizon rule is untouched by any of this.** `aggregateRuns` still folds only the
 * rows it is given, in canonical `(seed, turn, playerId)` order, and a planner failure
 * still does not truncate a run (`runner.ts` states why), so a batch whose policies
 * throw produces the same rows, the same aggregates and the same horizon as one whose
 * policies do not — with the failure visible beside them instead of hidden by them.
 */

import { MEASURED_METRIC_FIELDS, type MeasuredMetricField } from './metrics.js';
import { runSimulation } from './runner.js';
import type {
  BatchOptions,
  BatchResult,
  MetricAggregate,
  SimulationOptions,
  SimulationResult,
  TurnMetrics,
  WinCount,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Canonical order
 * ------------------------------------------------------------------ */

/**
 * The runs in the canonical order aggregation folds them in: **ascending seed**.
 *
 * A copy is sorted, never the caller's array: `runBatch` has already produced its
 * runs in this order, but `aggregateRuns` is exported so a report can aggregate a
 * set of runs it assembled itself, and an aggregator whose answer depends on the
 * order it was handed its input would be the bug this module exists to rule out.
 */
const canonicalRuns = (runs: readonly SimulationResult[]): readonly SimulationResult[] =>
  [...runs].sort((a, b) => a.seed - b.seed);

/** Every row of every run, in canonical order: seed, then turn, then player id. */
const canonicalRows = (runs: readonly SimulationResult[]): readonly TurnMetrics[] =>
  canonicalRuns(runs).flatMap((run) => run.metrics);

/* ------------------------------------------------------------------ *
 * One metric's aggregate
 * ------------------------------------------------------------------ */

/**
 * `count`, `sum`, `mean`, `median`, `min` and `max` of one metric over a row
 * sequence, in that sequence's order.
 *
 * The fold is a plain loop rather than `reduce` so that "the terms are added in the
 * order they were given" is visible: the caller has already put them in canonical
 * order, and this function adds nothing of its own to the question.
 */
const aggregateMetric = (
  metric: MeasuredMetricField,
  rows: readonly TurnMetrics[],
): MetricAggregate => {
  const values = rows.map((row) => row[metric]);

  let sum = 0;
  let min = 0;
  let max = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    sum += value;
    if (index === 0) {
      min = value;
      max = value;
      continue;
    }
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const count = values.length;
  // A copy, ascending, numeric: `[...values].sort()` on strings would order `10`
  // before `9`, and sorting the caller's array in place would make this function's
  // result depend on whether it was the last to read it.
  const sorted = [...values].sort((a, b) => a - b);
  const median = count === 0 ? 0 : (sorted[Math.floor((count - 1) / 2)] ?? 0);

  return {
    metric,
    count,
    sum,
    mean: count === 0 ? 0 : sum / count,
    median,
    min,
    max,
  };
};

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/**
 * One aggregate row per measured metric, in `MEASURED_METRIC_FIELDS` order.
 *
 * Exported because the aggregate is a *report* over runs a caller may already have —
 * a sweep that ran its games itself, a re-aggregation of a saved batch — and because
 * separating it from `runBatch` is what lets a test aggregate the same runs in two
 * different input orders and compare.
 */
export const aggregateRuns = (runs: readonly SimulationResult[]): readonly MetricAggregate[] => {
  const rows = canonicalRows(runs);
  return MEASURED_METRIC_FIELDS.map((metric) => aggregateMetric(metric, rows));
};

/**
 * The options one seed of a batch runs under.
 *
 * Written out field by field rather than by spreading the batch options, for two
 * reasons: a spread would carry `seeds` into a `SimulationOptions` that has no such
 * field, and the optional fields must be **omitted** when the caller omitted them —
 * never present holding `undefined`, which the runner would then have to treat as
 * "absent" and which no canonical JSON would survive.
 */
const optionsForSeed = (options: BatchOptions, seed: number): SimulationOptions => ({
  seed,
  settings: options.settings,
  ruleset: options.ruleset,
  policies: options.policies,
  maxTurns: options.maxTurns,
  ...(options.invariants === undefined ? {} : { invariants: options.invariants }),
  ...(options.sampleEvery === undefined ? {} : { sampleEvery: options.sampleEvery }),
});

/**
 * Run every seed and aggregate the result.
 *
 * **Seeds are sorted ascending and each entry is run**, duplicates included: a caller
 * that lists a seed twice asked for two games, and silently de-duplicating would
 * change the batch (and its `count`) behind its back. Sorting is what makes the
 * result independent of the order the seeds were supplied in — the requirement the
 * batch half of the contract is checked on — and the runs come back in that same
 * ascending order.
 *
 * A seed that cannot start a game (a ruleset missing a terrain role, a map with no
 * valid start) throws from `runSimulation`, naming the seed and the reason: there is
 * no field in `BatchResult` for a game that never existed, and a batch that quietly
 * dropped such a seed would report an aggregate over a set the caller did not ask
 * for.
 *
 * A **planner failure does not throw and is not a dropped seed**: the game was played,
 * its rows are in the aggregate like any other game's, and the typed record rides on the
 * run (`plannerFailures`) so that the caller can see that one of the games it just
 * averaged was not a measurement of the AI. See the module note.
 */
export const runBatch = (options: BatchOptions): BatchResult => {
  const seeds = [...options.seeds].sort((a, b) => a - b);
  const runs = seeds.map((seed) => runSimulation(optionsForSeed(options, seed)));

  const aggregates = aggregateRuns(runs);
  const wins = countWins(runs);
  // The key is omitted rather than written as `[]`: see the module note on what an empty
  // list would claim.
  return wins.length === 0 ? { runs, aggregates } : { runs, aggregates, wins };
};

/**
 * How many games reached each victory condition, ordered by condition id.
 *
 * A `draw` is counted under its condition like any other ending — "the score condition
 * ended level" is a result a reader needs to see, and dropping it would make the counts
 * sum to fewer games than `stoppedBecause: 'game-over'` reports. `winner` is `null` for
 * those, and `null` is written rather than a placeholder id: the type says a draw has no
 * winner, and inventing seat 0 would be a lie about who won.
 */
const countWins = (runs: readonly SimulationResult[]): readonly WinCount[] => {
  const counts = new Map<string, WinCount>();
  for (const run of runs) {
    const outcome = run.outcome;
    if (outcome === undefined) continue;
    const existing = counts.get(outcome.condition);
    counts.set(outcome.condition, {
      outcome: outcome.condition,
      count: (existing?.count ?? 0) + 1,
      winner: existing === undefined ? outcome.winner : existing.winner,
    });
  }
  return [...counts.values()].sort((a, b) => (a.outcome < b.outcome ? -1 : 1));
};
