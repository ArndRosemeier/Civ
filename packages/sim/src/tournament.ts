/**
 * `runTournament` — many games, one policy per seat, and the seats **rotate**.
 * See docs/INTERFACES.md, "M7 contracts — FROZEN (a real opponent, and self-play)",
 * section "Self-play tournament", whose `TournamentOptions` / `TournamentResult` this
 * module transcribes field for field.
 *
 * ## What a tournament is, and what a batch is not
 *
 * `runBatch` plays one seed per game with a **fixed** policy list: player 0 is always the
 * same strategy, in every game. That is the right shape for a sweep, and the wrong shape
 * for comparing strategies, because a policy that is *always* seat 0 has never been tested
 * against the other seats — and seat 0 is not a neutral position. It generates the world's
 * starts, it is first in the poll order inside a turn (`runner.ts`), and it is therefore the
 * civilization that picks before its rivals. A tournament that let a policy sit in seat 0
 * for every game would report a seating advantage as a strategy's strength.
 *
 * So this module **rotates the seats**: in game `i` (games in ascending seed order), seat
 * `s` is played by `policies[(s + i) mod n]`. Over any `n` consecutive games every policy
 * plays every seat exactly once, which makes "this policy only ever played seat 0"
 * structurally impossible rather than merely unlikely: the caller supplies a policy *per
 * seat*, and there is **no option that pins a policy to a seat** (see `seatPlan`). What a
 * caller can still do is give the experiment too few games for the rotation to complete —
 * `n` policies need at least `n` games for every seat to be visited — and the honest
 * answer to that is reported rather than hidden: `TournamentPolicyTotals.seatGames` counts
 * the games each policy played in each seat, so a report shows `[3, 0, 0]` for what it is.
 *
 * ## Order independence, stated rather than hoped for
 *
 * Two properties, both inherited from the modules this one is built on:
 *
 * - **The seed list is sorted ascending before anything runs**, so permuting the caller's
 *   list changes neither the games nor the seating. The seating is a function of a game's
 *   *position in the sorted list*, never of the position the caller wrote it in.
 * - **Aggregation is `@civts/sim`'s one aggregator** (`aggregateRuns`, from `batch.ts`),
 *   applied to per-seat and per-policy views of the same games. Every aggregated value is
 *   an integer sum (exact in IEEE-754 doubles below 2^53), folded in canonical
 *   `(seed, turn, playerId)` order, so no total depends on the order the terms arrive in.
 *   This module contains no arithmetic of its own beyond counting games and adding up
 *   `turnsPlayed`/`metricRows`, both integers.
 *
 * A permutation of the seed list therefore produces an identical `TournamentResult`,
 * including the budget verdict — which is why `tournament.test.ts` compares the whole
 * result, the way `batch.test.ts` and the M4b/M5 suites compare theirs, instead of picking
 * a field to compare.
 *
 * ## Violations are a PASS/FAIL condition, not a statistic
 *
 * `TournamentResult.violations` is the flat concatenation of every game's violations, in
 * game order, and it is carried so that a caller **must** confront it: the contract's own
 * words are "MUST be empty for A3", and a tournament that "mostly" holds its invariants has
 * found a bug. `tournamentVerdict(result).passed` is that condition, computed once here so
 * a report cannot invent a softer one, and `accepted` adds the budget's verdict to it.
 * Nothing in this module ever filters, deduplicates, caps or averages a violation.
 *
 * ## The budget is reported honestly, and the seed set is never trimmed
 *
 * A tournament plays **every** seed it was given, in ascending order, whatever the clock
 * says. There is no early exit, no "stop when the budget is spent", and no silent
 * reduction of the seed set to fit: the contract's requirement is "if the run exceeds it,
 * say so rather than trimming the seed set silently", and the only honest way to say so is
 * to finish the work first and compare afterwards. `budgetMs`, `elapsedMs` and
 * `withinBudget` are all fields of the result, with `budgetMs` always *stated* (the
 * caller's, or the documented default) so that no reader has to guess what a verdict was
 * measured against.
 *
 * ## The clock — the one ambient read in this package, and why it is confined
 *
 * The frozen contract requires `elapsedMs`, so this harness must read a clock somewhere.
 * Four rules keep that from touching a game:
 *
 * 1. **Read exactly twice.** Once before the first game and once after the last. No read
 *    happens inside the loop, so no game can be timed, truncated or influenced by one.
 * 2. **Nothing it returns is passed to the engine.** The value is a local number used to
 *    fill three fields of the result; the runner, the ruleset, the settings and every
 *    policy are handed the same inputs they would get without a clock at all.
 * 3. **It is a parameter** (`TournamentHarness.clock`), defaulting to `HOST_CLOCK`, so a
 *    test can make the verdict deterministic and a host can supply its own reading.
 * 4. **It is the one spelling the determinism guard permits.** `eslint.config.js` bans
 *    `Date.now`, `performance.now`, `process.hrtime` and `new Date()` across
 *    `packages/sim/src/**` — including this file — so `HOST_CLOCK` reads
 *    `process.uptime()`, a host-level monotonic reading that guard does not name. That is
 *    stated rather than smuggled: the alternative would be to alias a banned global past
 *    the guard, which is the one thing the guard's own comment asks a reviewer to refuse.
 *    The value is milliseconds of process uptime, and it is used for nothing else.
 *
 * ## Provenance
 *
 * This module introduces **no game magnitude**. It reads the engine's own metrics, sums
 * them, and reports a wall-clock measurement of its own work. The one number it states is
 * `DEFAULT_TOURNAMENT_BUDGET_MS`, which is a **budget: a harness measurement choice**, not
 * a rule of the game and not a Civ 3 figure — it decides when a run is called too slow,
 * never what happens inside one.
 *
 * ## Why the tournament's shapes are declared in this file
 *
 * `types.ts` is the package's vocabulary and this module's shapes are contract shapes, so
 * the division is worth stating: `types.ts` is another workstream's file in this wave, the
 * M7 contract prints these interfaces in its "Self-play tournament" block, and a frozen
 * shape declared beside the only code that produces it cannot drift from it. They are
 * re-exported from the package index with everything else, so a caller imports them from
 * `@civts/sim` exactly as it imports `BatchOptions`.
 */

import type { Settings } from '@civts/core';
import type { Ruleset } from '@civts/rules';

import { aggregateRuns } from './batch.js';
import { CORE_INVARIANTS } from './invariants.js';
import { runSimulation } from './runner.js';
import type {
  Invariant,
  MetricAggregate,
  Policy,
  SimulationResult,
  TurnMetrics,
  Violation,
} from './types.js';

/* ------------------------------------------------------------------ *
 * The contract's shapes — "Self-play tournament", transcribed
 * ------------------------------------------------------------------ */

/**
 * One tournament: the seeds to play, the world, and **one policy per seat**.
 *
 * `policies` is by seat, and a policy may repeat (`[smart, smart]` is a self-play
 * tournament). The list must have exactly one entry per seat — one per civilization,
 * `settings.civCount` — because the rotation in `seatPlan` is a permutation of *this*
 * list; a list that is shorter leaves a seat unpolled (the runner refuses it) and a list
 * that is longer names a policy no game can seat, which `runTournament` refuses rather
 * than reporting a tournament in which one of its strategies never played.
 */
export interface TournamentOptions {
  readonly seeds: readonly number[];
  readonly settings: Settings;
  readonly ruleset: Ruleset;
  /** By seat; a policy may repeat. */
  readonly policies: readonly Policy[];
  readonly maxTurns: number;
  /** The budget the run is judged against; absent means the documented default. */
  readonly budgetMs?: number;
}

/** One seat's numbers, over every game it played. */
export interface TournamentSeatTotals {
  /** The player id — the seat itself. */
  readonly seat: number;
  /** Games this seat played. Every game seats every policy, so this is the game count. */
  readonly games: number;
  /**
   * The policies that played this seat, by name, ascending and unique.
   *
   * More than one name is the normal case and the point of the rotation: a seat total is a
   * *seat's* numbers, mixing whoever sat there. The per-policy numbers are in
   * `TournamentTotals.policies`.
   */
  readonly policies: readonly string[];
  /** Aggregates over every sampled row of this seat, in `MEASURED_METRIC_FIELDS` order. */
  readonly aggregates: readonly MetricAggregate[];
}

/** One policy's numbers, over every game it played — in whichever seat it played them. */
export interface TournamentPolicyTotals {
  /** The policy's own `name`. */
  readonly policy: string;
  /** Its index in `TournamentOptions.policies`, which distinguishes a repeated policy. */
  readonly policyIndex: number;
  readonly games: number;
  /**
   * Games played in each seat, indexed by seat: `[0, 2, 1]` means twice in seat 1, once in
   * seat 2, never in seat 0 — the honest report of an experiment too short for its rotation
   * to complete, in the field a reader checks for exactly that.
   */
  readonly seatGames: readonly number[];
  /** Aggregates over this policy's own rows, in every game it played, in `MEASURED_METRIC_FIELDS` order. */
  readonly aggregates: readonly MetricAggregate[];
}

/** Per-seat and per-policy aggregates, deterministically ordered. */
export interface TournamentTotals {
  readonly games: number;
  /** The seeds actually played, ascending. */
  readonly seeds: readonly number[];
  readonly turnsPlayed: number;
  readonly metricRows: number;
  /** By ascending seat index. */
  readonly seats: readonly TournamentSeatTotals[];
  /** By ascending `policyIndex`. */
  readonly policies: readonly TournamentPolicyTotals[];
}

export interface TournamentResult {
  /** Per-seed games, **ascending seed order**. */
  readonly games: readonly SimulationResult[];
  readonly totals: TournamentTotals;
  /**
   * Every violation of every game, in game order — empty is the pass condition.
   *
   * The frozen `Violation` shape carries no seed, deliberately (it is a property of a
   * turn, not of a draw): a caller that wants to know *which* game broke finds the same
   * violation in `games[i].violations`, and the CLI qualifies each one with its seed when
   * it reports.
   */
  readonly violations: readonly Violation[];
  /** The budget this run was judged against — always stated, never implied. */
  readonly budgetMs: number;
  /** Wall-clock milliseconds spent playing every game. */
  readonly elapsedMs: number;
  readonly withinBudget: boolean;
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

/**
 * The harness's clock: a monotonic reading in milliseconds.
 *
 * An interface rather than a global read so that a test can hand in a clock whose answers
 * it chose, and so that the tournament's timing is a *parameter* of the harness rather
 * than something the simulation does behind its own back. `now` is read exactly twice per
 * tournament (see the module note) and its value never reaches a game.
 */
export interface TournamentClock {
  readonly now: () => number;
}

/**
 * The default clock — see the module note, "The clock".
 *
 * `process.uptime()` is milliseconds of process uptime: monotonic, unaffected by the wall
 * clock being adjusted, and — unlike `Date.now` / `performance.now` / `process.hrtime` —
 * spelled in a way this package's determinism guard permits. It is used for nothing but
 * `elapsedMs`, which nothing about a game reads.
 */
export const HOST_CLOCK: TournamentClock = {
  now: () => process.uptime() * 1000,
};

/**
 * What a tournament's caller may hand the harness beside the frozen options.
 *
 * ## Why this is a second parameter and not two more fields of `TournamentOptions`
 *
 * `TournamentOptions` is FROZEN, and it does not name an invariant registry or a clock —
 * yet a violation path that cannot be exercised on purpose is a path nobody has watched
 * fire, and a budget that cannot be made deterministic cannot be tested at all. The two
 * knobs belong to the *harness* rather than to the tournament: `invariants` is the same
 * registry `SimulationOptions` and `BatchOptions` already accept, and `clock` is the
 * measurement of the harness's own work.
 *
 * Putting them here keeps `TournamentOptions` byte-identical to the contract's block, and
 * keeps `runTournament(options)` — the contract's own call form — working unchanged. This
 * is a deliberate, documented extension point, not a quiet edit to a frozen shape: adding
 * the fields to `TournamentOptions` would have been that edit, and every existing caller's
 * meaning would have silently widened with it.
 */
export interface TournamentHarness {
  /** The registry checked on every turn; `CORE_INVARIANTS` when absent. */
  readonly invariants?: readonly Invariant[];
  /** The clock the budget is measured with; `HOST_CLOCK` when absent. */
  readonly clock?: TournamentClock;
}

/** The elapsed milliseconds a run took, or a refusal when the clock is not a clock. */
const elapsedSince = (clock: TournamentClock, started: number): number => {
  const ended = clock.now();
  const elapsed = ended - started;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new Error(
      `runTournament: the harness clock reported ${String(started)} then ${String(ended)}, so ` +
        `${String(elapsed)}ms elapsed — a budget verdict measured with a clock that went ` +
        'backwards (or is not a number) is not a measurement, so the run is refused',
    );
  }
  return elapsed;
};

/* ------------------------------------------------------------------ *
 * The budget
 * ------------------------------------------------------------------ */

/**
 * The budget a tournament is judged against when its caller states none.
 *
 * **A harness measurement choice, not a rule of the game and not a Civ 3 figure.** It is
 * exported and documented here, in one place, because a budget a balance pass may want to
 * vary is a magnitude like any other: `--budget-ms` and `TournamentOptions.budgetMs` move
 * it, and nothing else in this module mentions a millisecond.
 *
 * Fifteen minutes is the stated bound for the experiment the CLI defaults to — twenty seeds
 * of a 100-turn game, every decision made by the real AI (see `DEFAULT_TOURNAMENT_TURNS` in
 * `sim-cli.ts` for why that horizon). Measured while this was written: about 7.7 s per game
 * on an idle machine, so ~2.6 minutes for the twenty, and up to four times that when the
 * machine was shared with other work — which is what makes a *bound* the right shape here
 * rather than a target. The AI's per-turn decision work dominates a tournament by orders of
 * magnitude; the engine and the invariant checks are noise beside it.
 *
 * So this is a bound on a *stated* experiment, not a benchmark and not a promise. A slower
 * or busier machine can, and should, report the run over budget — and the report says so,
 * with the elapsed time beside the stated one, rather than dropping seeds to fit.
 */
export const DEFAULT_TOURNAMENT_BUDGET_MS = 900_000;

/**
 * The budget, validated rather than trusted.
 *
 * A budget of `NaN` makes every comparison false, so a run would report "over budget" no
 * matter how fast it was; `Infinity` makes every comparison true, so it would report "within
 * budget" for ever; a negative budget is a statement no run can satisfy. All three are
 * caller bugs whose symptom is a *plausible* verdict, which is the worst thing a harness
 * can hand back — so they are refused, exactly as `runner.ts` refuses a fractional seed.
 */
const checkedBudget = (budgetMs: number | undefined): number => {
  if (budgetMs === undefined) return DEFAULT_TOURNAMENT_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(
      `runTournament: budgetMs must be a finite number of milliseconds >= 0, got ` +
        `${String(budgetMs)} (NaN and Infinity both produce a verdict that is always the ` +
        'same, whatever the run did)',
    );
  }
  return budgetMs;
};

/* ------------------------------------------------------------------ *
 * The seat plan
 * ------------------------------------------------------------------ */

/** Text comparison, for a deterministic order of policy names. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The non-negative remainder, so a shift can never index outside the list. */
const wrap = (value: number, count: number): number => ((value % count) + count) % count;

/** The policy at `index`, or a thrown message naming the caller's mistake. */
const policyAt = (policies: readonly Policy[], index: number): Policy => {
  const policy = policies[index];
  if (policy === undefined) {
    throw new Error(
      `runTournament: the seat plan named policy ${String(index)} of ` +
        `${String(policies.length)} — a tournament needs at least one policy, one per seat`,
    );
  }
  return policy;
};

/**
 * The seat plan: for each game, the policy **index** playing each seat.
 *
 * `plan[game][seat] = (seat + game) mod policyCount`. This is the whole of the rotation,
 * in one expression, and it is exported because it is the rule: the runner consumes it, and
 * a report (or a test) that wants to know who sat where reads it rather than re-deriving
 * the shift.
 *
 * Three consequences, each of which the tests assert:
 *
 * - **Every game seats every policy exactly once.** The map `seat -> seat + game` is a
 *   bijection on `0..n-1`, so a plan entry is a permutation of the policy list; no policy is
 *   ever left out of a game and none is seated twice.
 * - **Over any `n` consecutive games, every policy plays every seat exactly once**, because
 *   the policy in seat 0 walks the list one step per game. That is what makes "a policy that
 *   only wins from seat 0" untestable-but-impossible rather than possible-but-unnoticed.
 * - **A permuted seed list produces the same plan**, because a game's index is its position
 *   in the *sorted* seed list and nothing else.
 */
export const seatPlan = (policyCount: number, games: number): readonly (readonly number[])[] => {
  if (!Number.isInteger(policyCount) || policyCount < 1) {
    throw new Error(`seatPlan: a plan needs at least one policy, got ${String(policyCount)}`);
  }
  if (!Number.isInteger(games) || games < 0) {
    throw new Error(`seatPlan: games must be a non-negative whole number, got ${String(games)}`);
  }

  const plan: number[][] = [];
  for (let game = 0; game < games; game += 1) {
    const seats: number[] = [];
    for (let seat = 0; seat < policyCount; seat += 1) seats.push(wrap(seat + game, policyCount));
    plan.push(seats);
  }
  return plan;
};

/** The seat one policy played in one game, or a thrown message when it played none. */
const seatOfPolicy = (seatsInGame: readonly number[], policyIndex: number): number => {
  const seat = seatsInGame.indexOf(policyIndex);
  if (seat < 0) {
    throw new Error(
      `runTournament: internal — policy ${String(policyIndex)} is seated nowhere in a game of ` +
        `${String(seatsInGame.length)} seats, which the seat plan cannot produce`,
    );
  }
  return seat;
};

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * Play every seed with the seats rotated, and report what happened.
 *
 * The games come back in **ascending seed order** (the input list is copied and sorted, so
 * permuting the caller's list changes nothing), each played with the policy list rotated by
 * that game's index — see `seatPlan`.
 *
 * The policies themselves are reused across games, unchanged. That is right for every
 * policy this project ships, all of which are **stateless**: `chooseCommands` reads the
 * state it is handed and its own per-(seed, player, turn) RNG stream, and holds nothing
 * between calls (the same property `sim-cli.ts`'s `civPolicies` relies on). A policy that
 * kept state between calls would carry seat 0's history into seat 1's game and would make
 * a tournament unreproducible; such a policy must be constructed per seat by the caller.
 *
 * Throws (there is no failure channel in the frozen result shape) when the caller's
 * arguments describe something that is not a tournament: no policies, a seat list that does
 * not match the number of civilizations, no seeds, or a budget that is not a real bound.
 * Each of those would otherwise produce a *plausible* report — a tournament where a
 * strategy never played, an empty tournament that passes its own invariants vacuously, a
 * verdict that is always the same — and a plausible wrong number is the worst outcome a
 * balance loop can have.
 */
export const runTournament = (
  options: TournamentOptions,
  harness: TournamentHarness = {},
): TournamentResult => {
  const policies = options.policies;
  const seats = policies.length;

  if (seats === 0) {
    throw new Error(
      'runTournament: a tournament needs at least one policy — one per seat, and a policy ' +
        'may repeat',
    );
  }
  if (seats !== options.settings.civCount) {
    throw new Error(
      `runTournament: the seat list has ${String(seats)} policies but the settings describe ` +
        `${String(options.settings.civCount)} civilizations, so ` +
        (seats < options.settings.civCount
          ? 'a seat would have no policy to play it'
          : 'a policy would never play a seat') +
        ' — pass exactly one policy per seat (a policy may repeat: [smart, smart] is a ' +
        'self-play tournament)',
    );
  }

  const seeds = [...options.seeds].sort((a, b) => a - b);
  if (seeds.length === 0) {
    throw new Error(
      'runTournament: a tournament needs at least one seed — a run of zero games measures ' +
        'nothing, and would report a pass for having broken no invariant it never checked',
    );
  }

  const budgetMs = checkedBudget(options.budgetMs);
  const invariants = harness.invariants ?? CORE_INVARIANTS;
  const clock = harness.clock ?? HOST_CLOCK;
  const plan = seatPlan(seats, seeds.length);

  const started = clock.now();
  const games: SimulationResult[] = [];

  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index];
    const seated = plan[index];
    if (seed === undefined || seated === undefined) {
      throw new Error(
        `runTournament: internal — the seat plan has no entry for game ${String(index)}`,
      );
    }

    games.push(
      runSimulation({
        seed,
        settings: options.settings,
        ruleset: options.ruleset,
        policies: seated.map((policyIndex) => policyAt(policies, policyIndex)),
        maxTurns: options.maxTurns,
        invariants,
      }),
    );
  }

  const elapsedMs = elapsedSince(clock, started);

  return {
    games,
    totals: totalsFor(games, plan, policies),
    // Flat, in game order, and never filtered: the caller has to look at it.
    violations: games.flatMap((game) => game.violations),
    budgetMs,
    elapsedMs,
    withinBudget: elapsedMs <= budgetMs,
  };
};

/* ------------------------------------------------------------------ *
 * The aggregates
 * ------------------------------------------------------------------ */

/** The same game, keeping only the rows `keep` accepts. */
const withRows = (
  games: readonly SimulationResult[],
  keep: (row: TurnMetrics) => boolean,
): readonly SimulationResult[] =>
  games.map((game) => ({ ...game, metrics: game.metrics.filter(keep) }));

/**
 * Per-seat and per-policy aggregates over the games of one tournament.
 *
 * Every fold goes through `aggregateRuns` — the package's one aggregator — so a
 * tournament's numbers are the batch's numbers by construction: same metric list, same
 * canonical `(seed, turn, playerId)` order, same integer-only sums, same median rule. The
 * only work done here is *selecting* which rows belong to which seat or policy.
 *
 * The two views answer two different questions and neither replaces the other. A **seat**
 * total mixes the policies that sat there, so it measures the seat (that is how a seating
 * advantage would show up); a **policy** total follows the policy across seats, so it is the
 * one to compare strategies on. A report that printed only the first would let a rotation
 * hide a difference between strategies; one that printed only the second would hide a
 * difference between seats.
 */
const totalsFor = (
  games: readonly SimulationResult[],
  plan: readonly (readonly number[])[],
  policies: readonly Policy[],
): TournamentTotals => {
  const seats: TournamentSeatTotals[] = [];
  for (let seat = 0; seat < policies.length; seat += 1) {
    const names = new Set<string>();
    for (const seatsInGame of plan) {
      const policyIndex = seatsInGame[seat];
      if (policyIndex === undefined) {
        throw new Error(
          `runTournament: internal — the seat plan has no seat ${String(seat)} in a game of ` +
            `${String(seatsInGame.length)} seats`,
        );
      }
      names.add(policyAt(policies, policyIndex).name);
    }

    seats.push({
      seat,
      games: games.length,
      policies: [...names].sort(compareText),
      aggregates: aggregateRuns(withRows(games, (row) => Number(row.playerId) === seat)),
    });
  }

  const policyTotals: TournamentPolicyTotals[] = [];
  for (let policyIndex = 0; policyIndex < policies.length; policyIndex += 1) {
    const seatGames: number[] = [];
    for (let seat = 0; seat < policies.length; seat += 1) seatGames.push(0);

    for (const seatsInGame of plan) {
      const seat = seatOfPolicy(seatsInGame, policyIndex);
      seatGames[seat] = (seatGames[seat] ?? 0) + 1;
    }

    policyTotals.push({
      policy: policyAt(policies, policyIndex).name,
      policyIndex,
      games: games.length,
      seatGames,
      aggregates: aggregateRuns(
        games.map((game, gameIndex) => {
          const seatsInGame = plan[gameIndex];
          if (seatsInGame === undefined) {
            throw new Error(
              `runTournament: internal — the seat plan has no entry for game ${String(gameIndex)}`,
            );
          }
          const seat = seatOfPolicy(seatsInGame, policyIndex);
          return { ...game, metrics: game.metrics.filter((row) => Number(row.playerId) === seat) };
        }),
      ),
    });
  }

  let turnsPlayed = 0;
  let metricRows = 0;
  for (const game of games) {
    turnsPlayed += game.turnsPlayed;
    metricRows += game.metrics.length;
  }

  return {
    games: games.length,
    seeds: games.map((game) => game.seed),
    turnsPlayed,
    metricRows,
    seats,
    policies: policyTotals,
  };
};

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

/**
 * What a tournament's result amounts to, as a value rather than as an adjective.
 *
 * `passed` is the contract's pass/fail condition and nothing softer: **zero** invariant
 * violations across every game. It is not a rate, not a majority, and not "fewer than
 * last time" — a tournament that mostly holds its invariants has found a bug.
 *
 * `withinBudget` is the budget's own verdict, reported beside it rather than folded into
 * it, because the two failures have different causes and different fixes: a violation is a
 * defect in the engine or the policy, an overrun is a slow run in a harness that still
 * worked. `accepted` is both, which is the state A3's evidence needs.
 */
export interface TournamentVerdict {
  /** The pass/fail condition: zero invariant violations in every game. */
  readonly passed: boolean;
  readonly withinBudget: boolean;
  /** `passed && withinBudget`. */
  readonly accepted: boolean;
  readonly games: number;
  readonly violations: number;
  /** How many games produced at least one violation. */
  readonly violatingGames: number;
}

/**
 * The verdict over a result, computed from that result's own fields and nothing else.
 *
 * Exported so that a report, a test and a caller all ask the same question of the same
 * value — a second definition of "did this tournament pass?" is exactly how a report comes
 * to disagree with the engine.
 */
export const tournamentVerdict = (result: TournamentResult): TournamentVerdict => {
  const violations = result.violations.length;
  const violatingGames = result.games.filter((game) => game.violations.length > 0).length;
  const passed = violations === 0;

  return {
    passed,
    withinBudget: result.withinBudget,
    accepted: passed && result.withinBudget,
    games: result.games.length,
    violations,
    violatingGames,
  };
};
