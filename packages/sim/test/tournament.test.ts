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
 *
 * The fast tier keeps the small tournaments (a handful of games, four to six turns), and the
 * full tier keeps one smoke tournament of the *real* policy — four seeds at twenty-five turns.
 * A3's twenty-seed run is **evidence, not a gate test**: it measured 417 s for twenty games at
 * sixty turns (M7b, on a quiet machine), so it lives in `scripts/tournament-evidence.ts` and is
 * asked for explicitly.
 */

import { DEFAULT_SETTINGS, civPlayers, type Settings } from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { FULL_TIER } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  CORE_INVARIANTS,
  DEFAULT_TOURNAMENT_BUDGET_MS,
  DO_NOTHING_POLICY,
  HOST_CLOCK,
  MEASURED_METRIC_FIELDS,
  SIMPLE_POLICY,
  SMART_POLICY,
  runTournament,
  seatPlan,
  tournamentVerdict,
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
}

/** One tournament, with the fixture's own settings. */
const tournamentOf = (fixture: Fixture, harness?: TournamentHarness): TournamentResult =>
  runTournament(
    {
      seeds: fixture.seeds,
      settings: settingsFor(fixture.policies),
      ruleset: RULESET,
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
): Pick<TournamentResult, 'games' | 'totals' | 'violations'> => ({
  games: result.games,
  totals: result.totals,
  violations: result.violations,
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
