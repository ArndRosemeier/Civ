/**
 * Evidence for `runTournament` — M7's self-play harness, and the five properties the
 * contract's "Self-play tournament" block is written around.
 *
 * 1. **Seats rotate.** A policy that only ever played seat 0 has not been tested, and the
 *    harness makes that impossible rather than unlikely: the plan is a permutation of the
 *    seat list in every game and a rotation across games, so over `n` games every policy
 *    plays every seat. Proved two ways — of the plan itself (`seatPlan`, a pure function),
 *    and of a real run (the same seed played twice gives a policy two different starting
 *    tiles, so the rotation demonstrably reached the world and not only the report).
 * 2. **Aggregates are order-independent.** A permuted seed list produces an identical
 *    `TournamentResult`, compared whole (the M4b/M5 rule), not field by field.
 * 3. **Zero violations is a pass/fail condition.** An injected invariant is surfaced by
 *    name, carried in the result *and* in the game it happened in, and fails
 *    `tournamentVerdict(...).passed` — including when every other game in the tournament
 *    held. The clean control is asserted first, so a verdict that is always `false` cannot
 *    pass this suite.
 * 4. **The budget is honest.** It is read from a clock the caller supplies, read exactly
 *    twice (never between games — a third read throws), and a run that exceeds it says so
 *    while still playing *every* seed: the tests assert the game count survives an overrun.
 * 5. **The clock cannot reach a game.** The same tournament run under two wildly different
 *    clocks produces identical games, totals and violations; only the timing fields move.
 * 6. **A planner failure fails the tournament (M7d).** A policy that threw while planning is
 *    carried as a typed record on the game it happened in and on the tournament's flat list,
 *    and `tournamentVerdict(...).passed` is `false` — with **no** invariant violation anywhere,
 *    which is the case the old behaviour reported as a clean pass. The clean control is
 *    asserted first here too.
 *
 * The fast tier keeps the small tournaments (a handful of games, four to six turns), and the
 * full tier keeps one smoke tournament of the *real* policy — four seeds at twenty-five turns.
 * A3's twenty-seed run is **evidence, not a gate test**: it measured 417 s for twenty games at
 * sixty turns (M7b, on a quiet machine), so it lives in `scripts/tournament-evidence.ts` and is
 * asked for explicitly.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  MAP_DIMENSIONS,
  VICTORY_CONDITIONS,
  civPlayers,
  type GameState,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { FULL_TIER } from '@civts/testing';
import { describe, expect, it } from 'vitest';

/**
 * **The report builder, imported across packages, and why that is the honest way to pin it.**
 *
 * `buildTournamentReport` lives in `@civts/headless` (`sim-cli.ts`), which *depends on* this
 * package — `sim` may never import it, and that direction is not going to be inverted for a
 * test. So the import is a **relative path into a test only**: no file under `src/` here
 * mentions `headless`, the dependency list in `packages/sim/package.json` is untouched, and
 * nothing shipped gains an edge. What it buys is the one property that cannot be checked from
 * this side of the boundary: that the report's `invariants.checks` **counts the games' own
 * counts** rather than deriving `turnsPlayed × registrySize`.
 *
 * A real run cannot tell those two apart (see the test below: after F2's repair every played
 * turn, the deciding one included, reaches the registry, so the product *is* the count for
 * every run the engine can produce), and a spawned CLI can therefore never catch the
 * derivation coming back. The synthetic report input below is what makes the difference
 * observable — the same technique `sim-cli.test.ts` uses for the batch's twin of this pin
 * (its drawn fixture carries `invariantChecks: 7` on a four-turn run).
 */
import { buildTournamentReport } from '../../headless/src/sim-cli.js';

import {
  CORE_INVARIANTS,
  DEFAULT_TOURNAMENT_BUDGET_MS,
  DO_NOTHING_POLICY,
  HOST_CLOCK,
  MEASURED_METRIC_FIELDS,
  SIMPLE_POLICY,
  SMART_POLICY,
  applyOverrides,
  runTournament,
  seatPlan,
  smartPolicy,
  tournamentVerdict,
  type DiagnosedPolicy,
  type Invariant,
  type MetricAggregate,
  type Policy,
  type SimulationResult,
  type TournamentClock,
  type TournamentHarness,
  type TournamentResult,
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

/**
 * The settings every fixture shares: a `duel` map (small, and big enough for several
 * starting positions) and **one civilization per policy**. The seat count is derived from
 * the policy list rather than written down twice, so a fixture cannot accidentally describe
 * a game whose seats and whose policies disagree — the mistake `runTournament` refuses.
 */
const settingsFor = (policies: readonly Policy[]): Settings => ({
  ...DEFAULT_SETTINGS,
  seed: 1,
  mapSize: 'duel',
  civCount: policies.length,
});

interface Fixture {
  readonly seeds: readonly number[];
  readonly policies: readonly Policy[];
  readonly maxTurns: number;
  readonly budgetMs?: number;
  /** The world's rules; the shipped catalog when absent. */
  readonly ruleset?: Ruleset;
}

/** One tournament, with the fixture's own settings. */
const tournamentOf = (fixture: Fixture, harness?: TournamentHarness): TournamentResult =>
  runTournament(
    {
      seeds: fixture.seeds,
      settings: settingsFor(fixture.policies),
      ruleset: fixture.ruleset ?? RULESET,
      policies: fixture.policies,
      maxTurns: fixture.maxTurns,
      // Written with the spread rather than `budgetMs: fixture.budgetMs`: a key holding
      // `undefined` is not a key a canonical JSON can carry, and the frozen options type
      // spells "no budget stated" as the *absence* of the field.
      ...(fixture.budgetMs === undefined ? {} : { budgetMs: fixture.budgetMs }),
    },
    harness,
  );

/**
 * A clock whose answers the test chose.
 *
 * `runTournament` reads its clock exactly twice — once before the first game, once after
 * the last — so a counting clock can make a budget verdict deterministic *and* prove that
 * no game was timed: a third read throws, and the run under test fails with that message
 * instead of quietly measuring something it should not.
 */
interface FakeClock {
  readonly clock: TournamentClock;
  readonly reads: () => number;
}

const fakeClock = (start: number, end: number): FakeClock => {
  let reads = 0;
  return {
    clock: {
      now: () => {
        reads += 1;
        if (reads > 2) {
          throw new Error(
            'the tournament clock was read inside the run: the budget is measured before the ' +
              'first game and after the last, and never between them',
          );
        }
        return reads === 1 ? start : end;
      },
    },
    reads: () => reads,
  };
};

/** Everything a result says about the games, with the timing fields left out. */
const gamesOnly = (
  result: TournamentResult,
): Pick<TournamentResult, 'games' | 'totals' | 'violations' | 'plannerFailures'> => ({
  games: result.games,
  totals: result.totals,
  violations: result.violations,
  plannerFailures: result.plannerFailures,
});

/** The starting tile of one seat of one game — where that seat's civilization began. */
const startTileOf = (game: SimulationResult, seat: number): number => {
  const player = game.finalState.players[seat];
  if (player === undefined) {
    throw new Error(`seed ${String(game.seed)} has no seat ${String(seat)}`);
  }
  return Number(player.startingTile);
};

/** The aggregate for one metric, or a thrown message naming the missing column. */
const aggregateOf = (aggregates: readonly MetricAggregate[], metric: string): MetricAggregate => {
  const found = aggregates.find((aggregate) => aggregate.metric === metric);
  if (found === undefined) throw new Error(`no aggregate for ${metric}`);
  return found;
};

/** The tournament's own naming for the seat list of a fixture's policy list. */
const namesOf = (policies: readonly Policy[]): readonly string[] =>
  policies.map((policy) => policy.name).sort();

/* ------------------------------------------------------------------ *
 * The seat plan
 * ------------------------------------------------------------------ */

describe('the seat plan — no policy can be pinned to a seat', () => {
  it('rotates one seat per game, so the policy in seat 0 walks the list', () => {
    expect(seatPlan(3, 3)).toStrictEqual([
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1],
    ]);
    // Two policies, four games: the two seatings, alternating. A fixture in which a policy
    // sat in one seat for every game would be visible here immediately.
    expect(seatPlan(2, 4)).toStrictEqual([
      [0, 1],
      [1, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(seatPlan(2, 0)).toStrictEqual([]);
  });

  it('seats every policy exactly once in every game', () => {
    for (const seats of seatPlan(4, 3)) {
      // A permutation of the policy list, checked as a sorted copy rather than assumed: a
      // plan that dropped a policy would leave a seat unpolled, and one that repeated a
      // policy would have it play itself without saying so.
      expect([...seats].sort((a, b) => a - b)).toStrictEqual([0, 1, 2, 3]);
    }
  });

  it('gives every policy every seat over n consecutive games', () => {
    const policyCount = 3;
    const plan = seatPlan(policyCount, policyCount);

    for (let seat = 0; seat < policyCount; seat += 1) {
      const played = plan.map((seats) => seats[seat] ?? -1);
      expect([...played].sort((a, b) => a - b)).toStrictEqual([0, 1, 2]);
    }
  });

  it('refuses a plan that is not a plan, rather than returning an empty-looking one', () => {
    expect(() => seatPlan(0, 3)).toThrow(/at least one policy/);
    expect(() => seatPlan(2, -1)).toThrow(/non-negative whole number/);
    expect(() => seatPlan(1.5, 2)).toThrow(/at least one policy/);
  });
});

/* ------------------------------------------------------------------ *
 * A tournament runs
 * ------------------------------------------------------------------ */

describe('a tournament plays every seed, with the seats rotated', () => {
  const TWO_POLICIES: Fixture = {
    seeds: [1, 2],
    policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
    maxTurns: 4,
  };

  it('runs a two-policy tournament and reports it', () => {
    const result = tournamentOf(TWO_POLICIES);

    expect(result.games.map((game) => game.seed)).toStrictEqual([1, 2]);
    expect(result.totals.games).toBe(2);
    expect(result.totals.seeds).toStrictEqual([1, 2]);
    // One metric row per civilization per turn, sampled every turn.
    expect(result.totals.metricRows).toBe(result.totals.turnsPlayed * 2);
    expect(result.totals.turnsPlayed).toBeGreaterThan(0);
    expect(result.violations).toStrictEqual([]);
    expect(tournamentVerdict(result).passed).toBe(true);
  });

  it('follows a policy across the seats, and a seat across the policies', () => {
    const result = tournamentOf({ ...TWO_POLICIES, seeds: [1, 2, 3, 4], maxTurns: 5 });
    const [simple, doNothing] = result.totals.policies;

    if (simple === undefined || doNothing === undefined) {
      throw new Error('the tournament produced fewer policy totals than it was given policies');
    }

    // Rotated, so neither policy sits in one seat for the whole tournament...
    expect(simple.seatGames).toStrictEqual([2, 2]);
    expect(doNothing.seatGames).toStrictEqual([2, 2]);
    // ...and both seats saw both policies.
    for (const seat of result.totals.seats) {
      expect(seat.policies).toStrictEqual(namesOf(TWO_POLICIES.policies));
      expect(seat.games).toBe(4);
    }

    // The per-policy aggregate follows the *policy*, over the seats it played in, rather
    // than the seat it happened to start in. `DO_NOTHING_POLICY` returns no commands at all
    // — that is its whole definition — so its cities are structurally zero whatever else
    // the engine does, while the placeholder policy it is compared against founds cities.
    // That is what makes this an assertion about the aggregation rather than about content.
    expect(aggregateOf(doNothing.aggregates, 'cities').sum).toBe(0);
    expect(aggregateOf(simple.aggregates, 'cities').sum).toBeGreaterThan(0);
    // Every measured metric is carried, once, in the package's own order.
    expect(simple.aggregates.map((aggregate) => aggregate.metric)).toStrictEqual(
      MEASURED_METRIC_FIELDS,
    );
    expect(simple.aggregates.map((aggregate) => aggregate.metric)).toStrictEqual(
      result.totals.seats[0]?.aggregates.map((aggregate) => aggregate.metric),
    );
  });

  it('moves the same policy to a different starting position from one game to the next', () => {
    // One seed, played twice: the *world* is identical, so any difference between the two
    // games is the rotation and nothing else.
    const result = tournamentOf({
      seeds: [7, 7],
      policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
      maxTurns: 3,
    });
    const [first, second] = result.games;
    if (first === undefined || second === undefined) {
      throw new Error('the tournament did not play the seed it was given twice');
    }

    // The seats exist, and they really do begin on different tiles — otherwise "a different
    // starting position" would be an empty claim.
    expect(civPlayers(first.finalState).map((player) => Number(player.id))).toStrictEqual([0, 1]);
    expect(startTileOf(first, 0)).not.toBe(startTileOf(first, 1));
    // Policy 0 played seat 0 in the first game and seat 1 in the second, so it began on a
    // different tile: the rotation reached the world, not only the report.
    expect(startTileOf(first, 0)).not.toBe(startTileOf(second, 1));
    expect(startTileOf(first, 1)).not.toBe(startTileOf(second, 0));
    // And the two games are therefore different games.
    expect(first.finalHash).not.toBe(second.finalHash);
  });

  it('reports the same tournament when the seed list is permuted', () => {
    // A *fresh* clock per run: each one is read exactly twice, and a shared instance would
    // be counting reads across three tournaments rather than within one.
    const ascending = tournamentOf(
      { ...TWO_POLICIES, seeds: [1, 2, 3] },
      { clock: fakeClock(1_000, 4_000).clock },
    );
    const shuffled = tournamentOf(
      { ...TWO_POLICIES, seeds: [3, 1, 2] },
      { clock: fakeClock(1_000, 4_000).clock },
    );
    const reversed = tournamentOf(
      { ...TWO_POLICIES, seeds: [3, 2, 1] },
      { clock: fakeClock(1_000, 4_000).clock },
    );

    // The whole result, not a chosen field: the games, the seating, the aggregates, the
    // violations *and* the budget verdict.
    expect(shuffled).toStrictEqual(ascending);
    expect(reversed).toStrictEqual(ascending);
    expect(shuffled.games.map((game) => game.seed)).toStrictEqual([1, 2, 3]);
    expect(shuffled.totals).toStrictEqual(ascending.totals);
  });

  it('is reproducible: the same options twice give the same result', () => {
    const first = tournamentOf(TWO_POLICIES, { clock: fakeClock(0, 250).clock });
    const second = tournamentOf(TWO_POLICIES, { clock: fakeClock(0, 250).clock });

    expect(second).toStrictEqual(first);
  });

  it('takes its worlds from the seeds it plays, not from the settings’ own seed', () => {
    // The batch makes the same promise. Asserted because a tournament whose worlds came
    // from `settings.seed` would play one map twenty times and call it twenty seeds.
    const result = tournamentOf({ ...TWO_POLICIES, seeds: [11, 12], maxTurns: 3 });

    expect(result.games.map((game) => game.finalState.seed)).toStrictEqual([11, 12]);
    const [first, second] = result.games;
    expect(first?.finalHash).not.toBe(second?.finalHash);
  });
});

/* ------------------------------------------------------------------ *
 * The clock, and the budget
 * ------------------------------------------------------------------ */

describe('the clock is confined to the budget report', () => {
  const FIXTURE: Fixture = {
    seeds: [1, 2, 3],
    policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
    maxTurns: 4,
  };

  it('reads the clock exactly twice — once before the first game, once after the last', () => {
    const fake = fakeClock(1_000, 4_500);
    const result = tournamentOf(FIXTURE, { clock: fake.clock });

    expect(result.elapsedMs).toBe(3_500);
    // Two reads. The fake clock throws on a third, so a timing read inside the game loop
    // fails this test loudly rather than passing unnoticed.
    expect(fake.reads()).toBe(2);
  });

  it('changes nothing about the games, however the clock behaves', () => {
    const slow = tournamentOf(FIXTURE, { clock: fakeClock(0, 5_000_000).clock });
    const quick = tournamentOf(FIXTURE, { clock: fakeClock(0, 1).clock });

    expect(gamesOnly(slow)).toStrictEqual(gamesOnly(quick));
    // The timing fields are the only difference — which is what makes the budget a *report*
    // rather than an input to the game.
    expect(slow.elapsedMs).not.toBe(quick.elapsedMs);
    expect(slow.withinBudget).toBe(false);
    expect(quick.withinBudget).toBe(true);
  });

  it('states the budget it was judged against, defaulting to the documented one', () => {
    const defaulted = tournamentOf(FIXTURE, { clock: fakeClock(0, 10).clock });
    const stated = tournamentOf(
      { ...FIXTURE, budgetMs: 12_345 },
      { clock: fakeClock(0, 10).clock },
    );

    expect(defaulted.budgetMs).toBe(DEFAULT_TOURNAMENT_BUDGET_MS);
    expect(stated.budgetMs).toBe(12_345);
    expect(defaulted.withinBudget).toBe(true);
    expect(stated.withinBudget).toBe(true);
  });

  it('refuses a budget that is not a real bound', () => {
    // A NaN budget makes every comparison false and an infinite one makes every comparison
    // true: both hand back a verdict that says nothing about the run.
    expect(() => tournamentOf({ ...FIXTURE, budgetMs: Number.NaN })).toThrow(/finite number/);
    expect(() => tournamentOf({ ...FIXTURE, budgetMs: Number.POSITIVE_INFINITY })).toThrow(
      /finite number/,
    );
    expect(() => tournamentOf({ ...FIXTURE, budgetMs: -1 })).toThrow(/>= 0/);
  });

  it('refuses a clock that is not a clock', () => {
    expect(() => tournamentOf(FIXTURE, { clock: { now: () => Number.NaN } })).toThrow(
      /not a measurement/,
    );
    expect(() => tournamentOf(FIXTURE, { clock: fakeClock(500, 100).clock })).toThrow(
      /went backwards/,
    );
  });

  it('has a host clock that is a real monotonic reading', () => {
    const first = HOST_CLOCK.now();
    const second = HOST_CLOCK.now();

    // The default clock is never asserted to have a *value* — a wall-clock number in a test
    // is a test that fails on a slow machine. What is asserted is that it is a number and
    // that it does not run backwards, which is all the budget arithmetic asks of it.
    expect(Number.isFinite(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe('the budget verdict is honest, and the seed set is never trimmed', () => {
  const FIXTURE: Fixture = {
    seeds: [1, 2, 3, 4],
    policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
    maxTurns: 4,
  };

  it('says it is over budget, and still plays every seed it was given', () => {
    const result = tournamentOf(FIXTURE, { clock: fakeClock(0, 5_000_000).clock });
    const verdict = tournamentVerdict(result);

    expect(result.elapsedMs).toBe(5_000_000);
    expect(result.budgetMs).toBe(DEFAULT_TOURNAMENT_BUDGET_MS);
    expect(result.withinBudget).toBe(false);
    // The point of the requirement: the run is *reported* over budget, not reshaped to fit.
    expect(result.games.map((game) => game.seed)).toStrictEqual([1, 2, 3, 4]);
    expect(result.totals.games).toBe(FIXTURE.seeds.length);
    // Everything the invariants can say still holds: an overrun is a slow run, not a defect.
    expect(verdict.passed).toBe(true);
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.accepted).toBe(false);
  });

  it('honours a stated budget, in both directions', () => {
    const over = tournamentOf(
      { ...FIXTURE, budgetMs: 10_000 },
      { clock: fakeClock(0, 10_001).clock },
    );
    const exactly = tournamentOf(
      { ...FIXTURE, budgetMs: 10_000 },
      { clock: fakeClock(0, 10_000).clock },
    );

    expect(over.withinBudget).toBe(false);
    // Exactly on the budget is within it: the comparison is `elapsed <= budget`, and a
    // boundary that flipped the other way would call a run late by zero milliseconds.
    expect(exactly.withinBudget).toBe(true);
    expect(exactly.games).toHaveLength(FIXTURE.seeds.length);
  });
});

/* ------------------------------------------------------------------ *
 * Violations: the pass/fail condition
 * ------------------------------------------------------------------ */

/** A deliberately failing invariant, the way the CLI's `--fault` builds one. */
const faultInvariant = (name: string): Invariant => ({
  name,
  description: 'A deliberately failing invariant: a self-test of the tournament violation path.',
  check: () => [`injected fault: the invariant named "${name}" fails on purpose`],
});

/** An invariant that fails on exactly one seed — a tournament that "mostly" holds. */
const faultOnSeed = (name: string, seed: number): Invariant => ({
  name,
  description: `A deliberately failing invariant for seed ${String(seed)} only.`,
  check: (ctx) =>
    ctx.state.seed === seed
      ? [`injected fault: the invariant named "${name}" fails on seed ${String(seed)}`]
      : [],
});

describe('a violation is a pass/fail condition, not a statistic', () => {
  const FIXTURE: Fixture = {
    seeds: [1, 2, 3],
    policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
    maxTurns: 4,
  };

  it('passes the same run with no injected fault, so the failing case is not vacuous', () => {
    const clean = tournamentOf(FIXTURE);

    expect(clean.violations).toStrictEqual([]);
    expect(tournamentVerdict(clean).passed).toBe(true);
    expect(tournamentVerdict(clean).violatingGames).toBe(0);
  });

  it('surfaces an injected invariant by name, and fails the pass condition', () => {
    const harness: TournamentHarness = {
      invariants: [...CORE_INVARIANTS, faultInvariant('tournament-probe')],
    };
    const broken = tournamentOf(FIXTURE, harness);
    const verdict = tournamentVerdict(broken);

    expect(broken.violations.length).toBeGreaterThan(0);
    expect(broken.violations.every((violation) => violation.invariant === 'tournament-probe')).toBe(
      true,
    );
    expect(broken.violations[0]?.message).toContain('injected fault');
    // Carried in the game it happened in as well as in the tournament's flat list, so a
    // caller can tell which seed broke without guessing.
    expect(broken.games.every((game) => game.violations.length > 0)).toBe(true);
    expect(broken.violations).toStrictEqual(broken.games.flatMap((game) => game.violations));
    // The game stops on the violating turn rather than playing on, so the state that broke
    // is the state it ended on.
    expect(broken.games.every((game) => game.stoppedBecause === 'violation')).toBe(true);
    expect(broken.games.every((game) => game.turnsPlayed === 1)).toBe(true);

    expect(verdict.passed).toBe(false);
    expect(verdict.accepted).toBe(false);
    expect(verdict.violations).toBe(broken.violations.length);
    expect(verdict.violatingGames).toBe(broken.games.length);
  });

  it('fails the whole tournament when ONE game of three breaks a property', () => {
    const harness: TournamentHarness = {
      invariants: [...CORE_INVARIANTS, faultOnSeed('one-seed-probe', 2)],
    };
    const result = tournamentOf(FIXTURE, harness);
    const verdict = tournamentVerdict(result);

    // Two of the three games held every invariant — "mostly" — and the tournament fails
    // anyway: that is the requirement, expressed as arithmetic on the verdict.
    expect(verdict.games).toBe(3);
    expect(verdict.violatingGames).toBe(1);
    expect(verdict.passed).toBe(false);
    expect(result.games.filter((game) => game.violations.length === 0)).toHaveLength(2);
    expect(
      result.games.filter((game) => game.violations.length > 0).map((game) => game.seed),
    ).toStrictEqual([2]);
  });
});

/* ------------------------------------------------------------------ *
 * Every turn of every game is checked — the deciding one included (Q1/F2)
 * ------------------------------------------------------------------ */

/**
 * A one-entry registry that records `(seed, turn)` for every context it is handed and never
 * fires. A tournament hands the *same* instance to every game, so the seed has to be part of
 * the record: a bare count could not say which game a turn belonged to.
 */
const checkRecorder = (): {
  readonly invariant: Invariant;
  readonly seen: { readonly seed: number; readonly turn: number }[];
} => {
  const seen: { seed: number; turn: number }[] = [];
  return {
    seen,
    invariant: {
      name: 'records-the-check',
      description: 'Records the seed and turn of every context it is handed, and never fires.',
      check: (ctx) => {
        seen.push({ seed: ctx.state.seed, turn: ctx.turn });
        return [];
      },
    },
  };
};

describe('a tournament checks every turn it played, the deciding one included (Q1/F2)', () => {
  // Two do-nothing civilizations on the catalog's own score horizon: nothing is founded, both
  // scores stay at zero, the condition holds at turn 200 and the tie goes to the lowest player
  // id. Every game therefore ends — which is the case the old `turnsPlayed × count` figure got
  // wrong, and the case that could not be checked at all because the loop broke first.
  const DECIDING: Fixture = {
    seeds: [1, 2],
    policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
    maxTurns: 200,
  };

  it('hands each game every one of its own turns, and the counts are that many checks', () => {
    const recorder = checkRecorder();
    const result = tournamentOf(DECIDING, { invariants: [recorder.invariant] });

    // The control first: if these games did not end, the claims below would be vacuous.
    expect(result.games.map((game) => game.stoppedBecause)).toStrictEqual([
      'game-over',
      'game-over',
    ]);
    expect(result.games.map((game) => game.outcome?.condition)).toStrictEqual(['score', 'score']);

    for (const game of result.games) {
      const seen = recorder.seen.filter((entry) => entry.seed === game.seed);
      // **The claim**: as many checks as turns played. One fewer is exactly F2 — the turn that
      // decided the game was handed to no predicate, and `- 1` is the arithmetic that says so.
      expect(seen).toHaveLength(game.turnsPlayed);
      expect(game.invariantChecks).toBe(game.turnsPlayed);
      // The turns are contiguous and end on the deciding one: turn 2 is the first the loop
      // settles (turn 1 is `newGame`'s state), and the last is the turn the game ended on.
      expect(seen.map((entry) => entry.turn)).toStrictEqual(
        Array.from({ length: game.turnsPlayed }, (_, index) => index + 2),
      );
      expect(Math.max(...seen.map((entry) => entry.turn))).toBe(game.outcome?.turn);
    }

    // The sum the CLI reports is the sum of the games' own counts, and it equals what the
    // registry really saw — the two numbers a report and an instrument have to agree on.
    const summed = result.games.reduce((total, game) => total + game.invariantChecks, 0);
    expect(summed).toBe(recorder.seen.length);
    expect(summed).toBe(result.games.reduce((total, game) => total + game.turnsPlayed, 0));
  });
});

/* ------------------------------------------------------------------ *
 * F6 — the report's total is counted, not derived
 * ------------------------------------------------------------------ */

/**
 * **The one property a real run cannot demonstrate.**
 *
 * After F2's repair, every played turn — the deciding one included — is handed to the registry,
 * so `Σ game.invariantChecks` and `Σ game.turnsPlayed × registrySize` are **equal for every
 * tournament the engine can produce**. That is exactly why P2's mutation `checks = turnsPlayed ×
 * invariantCount` left the whole suite green (Q3's B7, mutation M2b): the two expressions are
 * the same number, so no run, and therefore no spawned CLI, can tell a counted total from a
 * derived one.
 *
 * What can tell them apart is a **game whose count is not the product** — a run the engine
 * cannot make, handed to the report builder directly. That is the same instrument
 * `sim-cli.test.ts` uses for the batch report's twin of this pin (its drawn fixture carries
 * `invariantChecks: 7` on a four-turn run and asserts `280 ≠ 147`), and it is the only shape of
 * test that makes "counted, not derived" falsifiable at this site.
 */
describe('the tournament report counts its checks instead of deriving them (F6)', () => {
  it('sums the games\u2019 own counts — a number the derived product cannot produce', () => {
    const fixture: Fixture = {
      seeds: [1, 2],
      policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
      maxTurns: 4,
    };
    const result = tournamentOf(fixture);

    // The games really ran and really reported counts: without this the fabrication below
    // would be the only number in the test.
    expect(result.games.map((game) => game.turnsPlayed)).toStrictEqual([4, 4]);
    for (const game of result.games) {
      expect(game.invariantChecks).toBe(game.turnsPlayed * CORE_INVARIANTS.length);
    }

    // A count the engine cannot produce: one game credited with **one** check on a four-turn
    // run with a 35-predicate registry. It is not a state the runner can reach (F2's repair
    // makes every turn check the whole registry), which is the point — it is the probe that
    // distinguishes "the report summed the games" from "the report multiplied turns".
    const FABRICATED = 1;
    const games: readonly SimulationResult[] = result.games.map((game, index) =>
      index === 0 ? { ...game, invariantChecks: FABRICATED } : game,
    );
    const counted = games.reduce((total, game) => total + game.invariantChecks, 0);
    const turnsPlayed = games.reduce((total, game) => total + game.turnsPlayed, 0);
    const derived = turnsPlayed * CORE_INVARIANTS.length;
    // Non-vacuity, asserted rather than assumed: if the two figures agreed on this fixture the
    // assertions below would pass under either implementation.
    expect(counted).not.toBe(derived);

    const report = buildTournamentReport({
      result: { ...result, games },
      parameters: {
        mapSize: 'duel',
        width: MAP_DIMENSIONS.duel.width,
        height: MAP_DIMENSIONS.duel.height,
        civCount: fixture.policies.length,
        maxTurns: fixture.maxTurns,
        seats: namesOf(fixture.policies),
        seedSpec: '1..2',
        seeds: [...fixture.seeds],
      },
      ruleset: {
        fidelity: RULESET.fidelity,
        hash: 'f6-report-input',
        overrideCount: 0,
        applied: [],
        patch: {},
      },
      invariantNames: CORE_INVARIANTS.map((invariant) => invariant.name),
    });

    // The pin. `turnsPlayed × count` is 280 here and the games' own counts sum to 141, so a
    // derived total is a failure rather than a coin flip.
    expect(report.invariants.checks).toBe(counted);
    expect(report.invariants.checks).not.toBe(derived);
    expect(report.invariants.count).toBe(CORE_INVARIANTS.length);
    // The fabricated game is in the report the total was summed from, so the assertion above
    // is about *these* games rather than about a copy the builder never saw.
    expect(report.games.map((game) => game.turnsPlayed)).toStrictEqual([4, 4]);
    expect(report.totals.turnsPlayed).toBe(turnsPlayed);
  });
});

/* ------------------------------------------------------------------ *
 * M7d — a planner failure is a pass/fail condition too
 * ------------------------------------------------------------------ */

/**
 * A policy that throws on every turn it is polled: the real AI, handed a board it cannot read.
 *
 * The same fixture `runner.test.ts` uses, and for the same reason: `state.map` is a throwing
 * getter, so the first read inside the planner fails, the AI's own `try`/`catch` records a
 * typed `PlannerFailure`, and the turn it returns is partial. The corrupted board is handed to
 * the **policy** only — the run's own state, its invariants and its final hash see an ordinary
 * world, which is what makes this a test of the carrier rather than of a corrupted game.
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

describe('a planner failure is a pass/fail condition (M7d)', () => {
  it('is empty for a tournament the policies actually played, and the verdict says so', () => {
    // The control, asserted first: a verdict that is always `false` cannot pass this suite.
    const clean = tournamentOf({
      seeds: [1, 2],
      policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
      maxTurns: 4,
    });
    const verdict = tournamentVerdict(clean);

    expect(clean.plannerFailures).toStrictEqual([]);
    expect(verdict.plannerFailures).toBe(0);
    expect(verdict.gamesWithPlannerFailures).toBe(0);
    expect(verdict.passed).toBe(true);
    expect(verdict.accepted).toBe(true);
  });

  it('FAILS a tournament whose planner threw, with no invariant violation at all', () => {
    const broken = boardBlindPolicy();
    const result = tournamentOf({ seeds: [3, 4], policies: [broken, broken], maxTurns: 3 });
    const verdict = tournamentVerdict(result);

    // Nothing the *invariants* saw was wrong: every game is a valid, hashable game that
    // played its whole horizon. That is exactly why the old behaviour was a silence.
    expect(result.violations).toStrictEqual([]);
    expect(result.games.every((game) => game.violations.length === 0)).toBe(true);
    expect(result.games.every((game) => game.stoppedBecause !== 'violation')).toBe(true);

    // And yet the tournament is not evidence, because a policy is required to be total.
    expect(result.plannerFailures.length).toBeGreaterThan(0);
    expect(verdict.plannerFailures).toBeGreaterThan(0);
    expect(verdict.gamesWithPlannerFailures).toBeGreaterThan(0);
    expect(verdict.passed).toBe(false);
    expect(verdict.accepted).toBe(false);

    // Which game, which turn, which pass: the record is carried by the game it happened in,
    // so a reader holding the result can say — without a stderr warning to help it.
    const failing = result.games.filter((game) => game.plannerFailures.length > 0);
    expect(failing.length).toBeGreaterThan(0);
    for (const game of failing) {
      const failure = game.plannerFailures[0];
      if (failure === undefined) throw new Error(`seed ${String(game.seed)} carried no failure`);
      expect(failure.policy).toBe(broken.name);
      expect(failure.turn).toBeGreaterThanOrEqual(1);
      expect(failure.error).toContain('the board is unreadable');
      // Optional on the type, always present from a planner that knows where it was — guarded for
      // the same reason the record above is: a missing detail must fail, not pass quietly.
      if (failure.detail === undefined) {
        throw new Error(`seed ${String(game.seed)} lost the detail of the pass`);
      }
      expect(failure.detail.length).toBeGreaterThan(0);
    }
    // The tournament's flat list is exactly the games' own records, in game order — the same
    // relationship `violations` has, so the two channels are read the same way.
    expect(result.plannerFailures).toStrictEqual(
      result.games.flatMap((game) => game.plannerFailures),
    );
  });

  it('attributes a failure to each game that suffered it, per seat and not per turn', () => {
    // The record lives on the *policy instance* and `PolicyReport` keeps the first failure of each
    // pass, so this test is about the two rules meeting: the pass record is the policy's (one per
    // pass, for the life of the instance), while **whether a game threw at all** is the runner's,
    // read from the monotone `failureCount` (`runner.ts`, "Carrying a planner failure").
    //
    // **Re-decided in M7d's follow-up (F2-1): this expectation was `1` game with a failure, and
    // the assertions below said the first game was the only one that had one.** That was a silent
    // pass, not a reading: all three games throw on every turn, but the old runner baselined the
    // policy's log on record *identity*, and since a pass keeps only its first record, games 2 and
    // 3 were handed the record game 1 had produced and reported nothing — a tournament whose
    // planner threw in every game of every turn could therefore read as clean. Counting the
    // failures instead of the records says what actually happened, and the old value is kept here
    // so the change is auditable rather than a quietly loosened assertion.
    //
    // What must stay true is asserted too: each game carries its own failures rather than one per
    // turn — a policy that throws on every turn of a hundred-turn game must not nag a hundred
    // times — and no game is accused of a failure it did not cause.
    const broken = boardBlindPolicy();
    const result = tournamentOf({ seeds: [5, 6, 7], policies: [broken, broken], maxTurns: 3 });
    const verdict = tournamentVerdict(result);

    expect(result.games).toHaveLength(3);
    expect(verdict.gamesWithPlannerFailures).toBe(3);
    // Every game threw, and each says so **once per seat** — never once per turn. The two entries
    // are the two seats' own throws: both seats share `broken` and both stopped playing, in the same
    // pass (`research`, where the planner first reads the board), and one entry per run would have
    // reported one seat while silently dropping the other's (H1/G2-1 re-decided this from `[1, 1, 1]`
    // for exactly that reason — the old number was an artefact of a record frozen per pass, not a
    // property of the seam). Both threw on all three turns of all three games, so two per game is
    // still a bound rather than a count of turns.
    expect(result.games.map((game) => game.plannerFailures.length)).toStrictEqual([2, 2, 2]);
    for (const game of result.games) {
      expect(game.plannerFailures.map((failure) => failure.playerId)).toStrictEqual([0, 1]);
    }
    // The tournament's flat list is still exactly the games' own records, in game order.
    expect(result.plannerFailures).toStrictEqual(
      result.games.flatMap((game) => game.plannerFailures),
    );
    // ...and one game is enough for the whole tournament to fail: "mostly fine" is not a pass.
    expect(verdict.passed).toBe(false);
  });

  it('reports a re-throw by a REUSED policy instance, in the later run that threw (F2-1)', () => {
    // The finding this pins: a programmatic caller that reuses one instance across two
    // tournaments — exactly what a verification harness does — used to get **passed: true** for
    // the second one even though its planner threw every turn, because the first run had already
    // recorded that pass and the runner baselined on record identity. A thrown planner that looks
    // clean is the silent-pass shape M7d exists to close, so the second run now reports its own
    // throw: the count moved during it, and that is what the baseline is taken against.
    //
    // Note the instance is shared across BOTH runs and is the same object the CLI would hold:
    // nothing here resets a report, and nothing needs to.
    const shared = boardBlindPolicy();
    const first = tournamentOf({ seeds: [1, 2], policies: [shared, shared], maxTurns: 3 });
    const second = tournamentOf({ seeds: [3, 4], policies: [shared, shared], maxTurns: 3 });

    // Both runs are about their own throws, and the later one is not silent.
    expect(tournamentVerdict(first).passed).toBe(false);
    expect(tournamentVerdict(second).passed).toBe(false);
    expect(second.plannerFailures.length).toBeGreaterThan(0);
    expect(tournamentVerdict(second).gamesWithPlannerFailures).toBe(second.games.length);
    // The policy's own report is unchanged in shape by any of this: one record per pass, and a
    // count that grew with every throw — which is the number the baseline reads.
    expect(shared.report().failures).toHaveLength(1);
    expect(shared.report().failureCount).toBeGreaterThan(
      first.plannerFailures.length + second.plannerFailures.length,
    );
    // ...and it stops there: a healthy policy on a reused instance reports nothing in either run,
    // so the fix cannot have made every reused policy look broken. `SIMPLE_POLICY` cannot report
    // at all (no `report()`), so the *diagnosed* control is the real AI at its own weights.
    const healthy = smartPolicy();
    const cleanFirst = tournamentOf({ seeds: [8], policies: [healthy, healthy], maxTurns: 2 });
    const cleanSecond = tournamentOf({ seeds: [9], policies: [healthy, healthy], maxTurns: 2 });
    expect(cleanFirst.plannerFailures).toStrictEqual([]);
    expect(cleanSecond.plannerFailures).toStrictEqual([]);
    expect(healthy.report().failureCount).toBe(0);
  });

  it('reports the same failing tournament when the seed list is permuted', () => {
    // The M4b/M5 order-independence rule, extended to the new field: a permuted seed list must
    // produce the same records, not merely the same count.
    //
    // One instance **per tournament** — the discipline the CLI follows — which is what makes this
    // a comparison of two *equal* experiments rather than of a first run against a second. Since
    // F2-1 the runner would report a reused instance's re-throw correctly either way (the test
    // above pins that), but two fresh instances keep this test about the seed permutation and
    // nothing else: with a shared instance the second run's records would legitimately be about
    // its own throws, which is a different question from whether permutation changes the games.
    const ascending = tournamentOf({
      seeds: [1, 2, 3],
      policies: [boardBlindPolicy(), boardBlindPolicy()],
      maxTurns: 3,
    });
    const shuffled = tournamentOf({
      seeds: [3, 1, 2],
      policies: [boardBlindPolicy(), boardBlindPolicy()],
      maxTurns: 3,
    });

    expect(ascending.plannerFailures.length).toBeGreaterThan(0);
    expect(gamesOnly(shuffled)).toStrictEqual(gamesOnly(ascending));
    expect(shuffled.plannerFailures).toStrictEqual(ascending.plannerFailures);
  });
});

/* ------------------------------------------------------------------ *
 * What a tournament refuses
 * ------------------------------------------------------------------ */

describe('a tournament refuses arguments that would produce a plausible wrong report', () => {
  const FIXTURE: Fixture = {
    seeds: [1],
    policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
    maxTurns: 2,
  };

  it('refuses a seat list that does not match the number of civilizations', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, seed: 1, mapSize: 'duel', civCount: 2 };

    // A seat with no policy: the runner would throw mid-run instead of naming the mistake,
    // and the tournament would report nothing about the games it had already played.
    expect(() =>
      runTournament({
        seeds: [1],
        settings,
        ruleset: RULESET,
        policies: [SIMPLE_POLICY],
        maxTurns: 2,
      }),
    ).toThrow(/a seat would have no policy/);

    // A policy with no seat: it would never play, and the report would silently contain a
    // strategy that was never tested.
    expect(() =>
      runTournament({
        seeds: [1],
        settings,
        ruleset: RULESET,
        policies: [SIMPLE_POLICY, DO_NOTHING_POLICY, SIMPLE_POLICY],
        maxTurns: 2,
      }),
    ).toThrow(/never play a seat/);
  });

  it('refuses a tournament with no seeds, which would pass vacuously', () => {
    expect(() => tournamentOf({ ...FIXTURE, seeds: [] })).toThrow(/at least one seed/);
  });

  it('refuses a tournament with no policies', () => {
    expect(() =>
      runTournament({
        seeds: [1],
        settings: { ...DEFAULT_SETTINGS, seed: 1, mapSize: 'duel', civCount: 0 },
        ruleset: RULESET,
        policies: [],
        maxTurns: 2,
      }),
    ).toThrow(/at least one policy/);
  });
});

/* ------------------------------------------------------------------ *
 * The smoke self-play tournament, on the real AI (FULL tier)
 * ------------------------------------------------------------------ */

describe('a smoke self-play tournament of the real AI', () => {
  // **Why this is four seeds at twenty-five turns and not A3's twenty at a hundred.**
  //
  // It was twenty seeds at sixty turns, documented at "~100 s on an idle machine". M7b measured
  // that same run on a quiet machine at **417 s** — 4.2× the comment — which was 85 % of the
  // entire full tier's 489 s. A gate test that is most of the gate, on a claim that had already
  // gone stale by a factor of four, is the wrong place for the experiment: the twenty-seed
  // tournament is EVIDENCE, and it now runs deliberately in `scripts/tournament-evidence.ts`
  // (`pnpm tournament:evidence`, twenty seeds at A3's hundred turns, ~26 s per game, ~9 min),
  // where its structured result and wall time are printed as evidence.
  //
  // What stays here is what a gate should own: the machinery, end to end, on the *real* policy
  // rather than a stub — every seed played, the seats rotated, the clock read exactly twice, the
  // budget verdict honest, and no invariant violated. The violations-surfacing half of that
  // claim is proved elsewhere in this file by injected faults, which cost nothing.
  const SMOKE_SEEDS = 4;
  const SMOKE_TURNS = 25;
  // Stated, not implied: twelve times the measured cost of the four games, so a contended
  // machine does not turn this red, and a real regression in per-turn cost still trips it.
  const SMOKE_BUDGET_MS = 120_000;

  it.skipIf(!FULL_TIER)(
    'plays four games of self-play with zero violations, inside its budget, every seat played',
    () => {
      const seeds = Array.from({ length: SMOKE_SEEDS }, (_, index) => index + 1);
      const result = runTournament({
        seeds,
        settings: { ...DEFAULT_SETTINGS, seed: 1, mapSize: 'tiny', civCount: 2 },
        ruleset: RULESET,
        policies: [SMART_POLICY, SMART_POLICY],
        maxTurns: SMOKE_TURNS,
        budgetMs: SMOKE_BUDGET_MS,
      });
      const verdict = tournamentVerdict(result);

      expect(result.games.map((game) => game.seed)).toStrictEqual(seeds);
      // The engine held everywhere. This is the pass condition, not an average.
      expect(result.violations).toStrictEqual([]);
      expect(verdict.passed).toBe(true);
      expect(verdict.violatingGames).toBe(0);
      // Every game ran its whole horizon: a tournament whose games stopped early would be
      // measuring a shorter game than the one it reports.
      expect(new Set(result.games.map((game) => game.turnsPlayed))).toStrictEqual(
        new Set([SMOKE_TURNS]),
      );
      expect(new Set(result.games.map((game) => game.stoppedBecause))).toStrictEqual(
        new Set(['max-turns']),
      );
      // The budget, reported honestly: inside a budget it was told about, and the two
      // fields agree with each other.
      expect(result.budgetMs).toBe(SMOKE_BUDGET_MS);
      expect(result.withinBudget).toBe(true);
      expect(result.elapsedMs).toBeLessThanOrEqual(result.budgetMs);
      expect(verdict.accepted).toBe(true);

      // Rotation over four games with two seats: both policies everywhere.
      for (const policy of result.totals.policies) {
        expect(policy.seatGames.filter((games) => games > 0)).toHaveLength(2);
        expect(policy.seatGames.reduce((total, games) => total + games, 0)).toBe(SMOKE_SEEDS);
      }

      // Non-vacuity, and not a content pin: the AI really played, so the tournament is
      // measuring games rather than four idle worlds.
      const first = result.totals.policies[0];
      if (first === undefined) throw new Error('the tournament reported no policy totals');
      expect(aggregateOf(first.aggregates, 'cities').sum).toBeGreaterThan(0);
      expect(result.totals.metricRows).toBeGreaterThan(SMOKE_SEEDS * 10);

      console.log(
        `smoke self-play at ${String(SMOKE_TURNS)} turns: ${result.elapsedMs.toFixed(0)}ms of ` +
          `${String(result.budgetMs)}ms budget, ${String(result.totals.metricRows)} metric rows, ` +
          `seat games ${JSON.stringify(result.totals.policies.map((policy) => policy.seatGames))}`,
      );
    },
    // A backstop only: five minutes, so that a run which is *slow* reports an honest budget
    // verdict instead of being cut off by the runner before it can say anything.
    300_000,
  );
});

/* ------------------------------------------------------------------ *
 * The outcome distribution — did anything actually END?
 * ------------------------------------------------------------------ */

/**
 * The evidence script, started the way a person starts it.
 *
 * `scripts/tournament-evidence.ts` runs its tournament at module scope (its argv *is* the
 * experiment), so it cannot be imported into this process without running one — a test that
 * imported it would play a game as a side effect of collection and, worse, would set
 * `process.exitCode` from this file's own argv. One process, exactly as the sweep tests in
 * `sim-cli.test.ts` start theirs.
 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const EVIDENCE_SCRIPT = join(REPO_ROOT, 'scripts', 'tournament-evidence.ts');

interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
}

const runEvidenceScript = (args: readonly string[]): ScriptRun => {
  const result = spawnSync(process.execPath, [TSX_CLI, EVIDENCE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout };
};

/**
 * **A tournament's averages cannot tell you whether the game can end at all.**
 *
 * Every A3 run up to this wave reported "zero violations, within budget" while *every* one of
 * its twenty games stopped at the horizon, and nothing in the output said so — the timings and
 * the verdict are both silent about endings. A victory condition that has never fired is a
 * condition that does not work, and the counts of endings are the only figures that show it.
 *
 * The counting now lives in `@civts/sim` (`outcomeDistributionOf`, on `TournamentTotals.outcomes`)
 * and the script **renders** it: it used to build its own histogram of stop reasons, which is how
 * a report comes to disagree with the engine — and which answered the wrong question anyway, since
 * `'game-over'` names no condition and no winner.
 *
 * The test drives the real script (one seed, one turn — 0.5 s measured) rather than a copy of
 * its logic, so what is pinned is the printed evidence a reader gets. Both spellings are
 * checked, because the text block is what a person reads and the JSON is what a pipeline reads,
 * and the two must count the same games: the structured `outcomes` in the JSON is asserted to be
 * the report's own value, which is the derived-value agreement this whole wave is about.
 */
describe('the outcome distribution counts endings, not averages', () => {
  it('prints what ended each game, and calls a run in which nothing ended a finding', () => {
    const run = runEvidenceScript(['--seeds', '1', '--turns', '1']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OUTCOME DISTRIBUTION');
    // The census, as printed: one game, no condition held, and the engine's own reason it left
    // the loop.
    expect(run.stdout).toMatch(/no outcome\s+1 of 1 games/);
    expect(run.stdout).toMatch(/max-turns\s+1 of 1 games/);
    // **Every** condition is printed, including the ones that never fired — that is the whole
    // point of the block, and an omitted zero row would hide the finding.
    for (const condition of VICTORY_CONDITIONS) {
      expect(run.stdout).toMatch(new RegExp(`${condition}\\s+0 games, 0 won, 0 drawn`));
    }
    // Wins by seat are printed whether or not anything was won, because the zeros are the
    // honest answer to "is there a seat effect?" when nothing ended.
    expect(run.stdout).toMatch(/seat 0\s+0 of 1 games won/);
    expect(run.stdout).toMatch(/seat 1\s+0 of 1 games won/);
    // And the interpretation, which is only emitted when every game reached the horizon.
    expect(run.stdout).toContain('it is a finding, not a table of outcomes');
  });

  it('carries the census in the structured value the text is rendered from', () => {
    const run = runEvidenceScript(['--seeds', '1', '--turns', '1', '--json']);
    expect(run.status).toBe(0);
    // No JSON parsing here on purpose: the value is canonical (sorted keys), so the fields are
    // asserted as bytes a pipeline would see. `evidenceVersion` is 3 because the census is part
    // of the value's shape — and because version 2 held a *different* shape (`outcomes.counts`),
    // which is exactly what a version number is for.
    expect(run.stdout).toContain('"evidenceVersion":3');
    // One game, no condition, four zero rows in the catalog's order, one seat row per seat, and
    // the engine's own stop reason — the report's `totals.outcomes`, carried through verbatim.
    expect(run.stdout).toContain(
      '"outcomes":{"conditions":[{"condition":"conquest","draws":0,"games":0,"wins":0},' +
        '{"condition":"domination","draws":0,"games":0,"wins":0},' +
        '{"condition":"cultural","draws":0,"games":0,"wins":0},' +
        '{"condition":"score","draws":0,"games":0,"wins":0}],' +
        '"endedGames":0,"games":1,"noOutcomeGames":1,' +
        '"seats":[{"games":1,"policies":["smart"],"seat":0,"wins":0},' +
        '{"games":1,"policies":["smart"],"seat":1,"wins":0}],' +
        '"stopReasons":[{"games":1,"stoppedBecause":"max-turns"}]}',
    );
    // The per-game outcome travels too, and says in words that nothing ended — the condition and
    // the winner are the engine's own read of the final board, not a second opinion about it.
    expect(run.stdout).toContain('"outcome":{"ended":false,"text":"no outcome');
    expect(run.stdout).toContain('"games":[{"finalHash"');
    expect(run.stdout).toContain('"stoppedBecause":"max-turns"');
  });
});

/* ------------------------------------------------------------------ *
 * The outcome census — which condition ended which game, from which seat
 * ------------------------------------------------------------------ */

/**
 * A tournament whose games **really end, by a named condition, at a cost the gate can pay**.
 *
 * `smart` against the do-nothing control on a `duel` map: measured at 35 and 38 turns of
 * conquest, two games in ~1.5 s. It is a real game through the real engine and the real AI — one
 * seat is a policy that does nothing, which is exactly what makes it the cheapest *ending* a
 * gate can afford, and what it demonstrates is stated here rather than implied: it shows the
 * conquest condition firing in a real game, and nothing about two real AIs playing each other.
 */
const ENDING_FIXTURE: Fixture = {
  seeds: [1, 2],
  policies: [SMART_POLICY, DO_NOTHING_POLICY],
  maxTurns: 80,
};

/**
 * The shipped catalog with **one** victory threshold moved, through the real applier.
 *
 * `scoreVictoryTurn: 1` makes the score condition decide every game at the first turn it is
 * evaluated — the only cheap way to reach the ending path from a catalogue horizon that is
 * otherwise turn 200. The bound the condition reads is the catalog's own, moved by the same
 * `applyOverrides` + `validateRuleset` path a sweep uses, so this is the engine's rule with one
 * number changed rather than a second rule.
 */
const DRAW_RULESET: Ruleset = (() => {
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

/** The winner of a game this fixture won, or a thrown message naming the game that did not. */
const winnerOf = (game: SimulationResult): number => {
  const outcome = game.outcome;
  if (outcome === undefined) {
    throw new Error(`seed ${String(game.seed)} did not end, and this fixture says it must`);
  }
  if (outcome.winner === null) {
    throw new Error(`seed ${String(game.seed)} ended level, and this fixture says it must be won`);
  }
  return Number(outcome.winner);
};

describe('the outcome census — what ended each game, read from the engine', () => {
  it('names the condition, the winner and the seat, and agrees with the board', () => {
    const result = tournamentOf(ENDING_FIXTURE);
    const outcomes = result.totals.outcomes;

    // Every game ended, and the census says so in its own fields. This is the figure A3's
    // evidence needs: "13 games ended in game-over" cannot name a condition, and this can.
    expect(result.games.every((game) => game.outcome !== undefined)).toBe(true);
    expect(outcomes.games).toBe(2);
    expect(outcomes.endedGames).toBe(2);
    expect(outcomes.noOutcomeGames).toBe(0);
    // **Every** condition is a row, in the catalog's order, zeros included: a condition that
    // never fired has to be visible as a zero rather than absent, or the gap this milestone is
    // about is invisible again.
    expect(outcomes.conditions.map((row) => row.condition)).toStrictEqual([...VICTORY_CONDITIONS]);
    expect(outcomes.conditions.find((row) => row.condition === 'conquest')).toStrictEqual({
      condition: 'conquest',
      games: 2,
      wins: 2,
      draws: 0,
    });
    for (const row of outcomes.conditions) {
      if (row.condition === 'conquest') continue;
      expect(row).toStrictEqual({ condition: row.condition, games: 0, wins: 0, draws: 0 });
    }

    // The winner is the AI, the rotation seats it differently in each game, and the census
    // credits the seat it actually sat in.
    expect(result.games.map(winnerOf)).toStrictEqual([0, 1]);
    expect(outcomes.seats.map((seat) => seat.wins)).toStrictEqual([1, 1]);
    expect(outcomes.seats.map((seat) => seat.seat)).toStrictEqual([0, 1]);
    expect(outcomes.seats.map((seat) => seat.games)).toStrictEqual([2, 2]);
    for (const seat of outcomes.seats) {
      expect(seat.policies).toStrictEqual(namesOf(ENDING_FIXTURE.policies));
    }

    // The condition is the engine's reading of the board, and this checks the board: a conquest
    // winner is a civilization every other civilization has no city left against.
    for (const game of result.games) {
      const winner = winnerOf(game);
      const citiesHeldByOthers = game.finalState.cities.filter(
        (city) => Number(city.owner) !== winner,
      ).length;
      expect(citiesHeldByOthers).toBe(0);
      expect(game.outcome?.condition).toBe('conquest');
      expect(game.outcome?.turn).toBe(game.finalState.turn);
    }
  });

  it('recounts the same games independently, and every identity holds', () => {
    const result = tournamentOf(ENDING_FIXTURE);
    const outcomes = result.totals.outcomes;

    // An independent recount in the test, from the games themselves: the census is a fold, and
    // a fold that does not agree with what it folded is the bug this checks for.
    const winsBySeat = new Map<number, number>();
    let ended = 0;
    let wins = 0;
    for (const game of result.games) {
      const outcome = game.outcome;
      if (outcome === undefined) continue;
      ended += 1;
      if (outcome.winner === null) continue;
      wins += 1;
      const seat = Number(outcome.winner);
      winsBySeat.set(seat, (winsBySeat.get(seat) ?? 0) + 1);
    }

    expect(outcomes.endedGames).toBe(ended);
    expect(outcomes.noOutcomeGames).toBe(result.games.length - ended);
    expect(outcomes.endedGames + outcomes.noOutcomeGames).toBe(outcomes.games);
    expect(outcomes.conditions.reduce((total, row) => total + row.games, 0)).toBe(ended);
    expect(outcomes.conditions.reduce((total, row) => total + row.wins, 0)).toBe(wins);
    expect(outcomes.seats.reduce((total, seat) => total + seat.wins, 0)).toBe(wins);
    for (const seat of outcomes.seats) {
      expect(seat.wins).toBe(winsBySeat.get(seat.seat) ?? 0);
    }
    for (const row of outcomes.conditions) {
      expect(row.games).toBe(row.wins + row.draws);
    }
    expect(outcomes.stopReasons.reduce((total, row) => total + row.games, 0)).toBe(outcomes.games);
  });

  it("credits a score tie to the lowest player id, because that is the engine's own rule", () => {
    // The score condition with both seats doing nothing: nobody has a city, every score is zero,
    // and the condition **still names a winner** — `highestScore` breaks a tie by lowest player
    // id, explicitly, and `scoreWinner` returns `null` only when there is no civilization to name
    // at all. So the census's `draws` is zero for every shipped condition, and that is a property
    // of the rule rather than of this fold. The test therefore asserts the *win*, not a draw: at
    // the score horizon a tie is a rule-level advantage for seat 0, and a census that reported it
    // as a draw would hide exactly the seat effect the census exists to expose.
    const result = tournamentOf({
      seeds: [1, 2],
      policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
      maxTurns: 2,
      ruleset: DRAW_RULESET,
    });
    const outcomes = result.totals.outcomes;

    expect(result.games.every((game) => game.outcome?.winner === null)).toBe(false);
    expect(result.games.map(winnerOf)).toStrictEqual([0, 0]);
    expect(result.games.every((game) => game.outcome?.condition === 'score')).toBe(true);
    expect(outcomes.endedGames).toBe(2);
    expect(outcomes.noOutcomeGames).toBe(0);
    expect(outcomes.conditions.find((row) => row.condition === 'score')).toStrictEqual({
      condition: 'score',
      games: 2,
      wins: 2,
      draws: 0,
    });
    expect(outcomes.seats.map((seat) => seat.wins)).toStrictEqual([2, 0]);
    // The identity every row carries still holds on a decided tie.
    for (const row of outcomes.conditions) expect(row.games).toBe(row.wins + row.draws);
  });

  it('reports a run in which nothing ended with zeros, not with silence', () => {
    const result = tournamentOf({
      seeds: [1, 2],
      policies: [SIMPLE_POLICY, DO_NOTHING_POLICY],
      maxTurns: 4,
    });

    expect(result.games.every((game) => game.outcome === undefined)).toBe(true);
    expect(result.totals.outcomes).toStrictEqual({
      games: 2,
      endedGames: 0,
      noOutcomeGames: 2,
      conditions: VICTORY_CONDITIONS.map((condition) => ({
        condition,
        games: 0,
        wins: 0,
        draws: 0,
      })),
      seats: [0, 1].map((seat) => ({
        seat,
        games: 2,
        wins: 0,
        policies: namesOf([SIMPLE_POLICY, DO_NOTHING_POLICY]),
      })),
      stopReasons: [{ stoppedBecause: 'max-turns', games: 2 }],
    });
  });

  it('does not change when the seed list is permuted', () => {
    // The census is a count over a *set* of games, and the rotation is a function of a game's
    // position in the **sorted** seed list — so a permuted list must produce an identical
    // census, including wins by seat, which is the aggregate a seat-effect claim is read from.
    // Asserted on a fixture whose games really end, because a distribution of zeros is
    // order-independent for reasons that have nothing to do with the code under test.
    const forwards = tournamentOf(ENDING_FIXTURE);
    const backwards = tournamentOf({ ...ENDING_FIXTURE, seeds: [2, 1] });

    expect(backwards.totals.outcomes).toStrictEqual(forwards.totals.outcomes);
    expect(forwards.totals.outcomes.endedGames).toBe(2);
    expect(backwards.games.map((game) => game.seed)).toStrictEqual(
      forwards.games.map((game) => game.seed),
    );
    // And the same holds for the whole result, which the file already asserts elsewhere — this
    // restates it on a fixture whose games end, so the census cannot be the one field that
    // drifts.
    expect(gamesOnly(backwards)).toStrictEqual(gamesOnly(forwards));
  });
});
