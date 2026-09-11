/**
 * **The invariant-precision split, asserted in both directions.**
 *
 * `packages/sim/src/invariants.ts` used to give `city-food-box-within-threshold` and
 * `city-food-conservation` **one shared** growth-threshold predicate, which returned
 * `false` (meaning "the threshold is not recoverable — do not claim the reduced bound")
 * whenever the owner reported a `TreasuryShortfall`. Only one of the two checks needed
 * that clause: `city-food-conservation` *recomputes* the growth arithmetic against the
 * after-state's rows, so a demolition in the same turn leaves it genuinely unable to
 * know what growth did — while the food-box check can only ever *suppress a real
 * violation* with it, because demolishing rows can only **raise** the threshold.
 *
 * The two checks no longer share one predicate. `foodBoxThresholdRecoverable` (the
 * completion case alone) is claimed by the box bound, and `thresholdRecoverable` (a
 * completion *or* a shortfall) by conservation. A quieter predicate is not evidence, so
 * this file measures the change rather than restating it:
 *
 * 1. **The escape is closed, by name.** The configuration that previously slipped
 *    through — a city holding a `growth-food` row whose box sits exactly at its reduced
 *    threshold (`bare - growthFood`), with a `TreasuryShortfall` for its owner and no
 *    completion event — is caught, and the violation names
 *    `city-food-box-within-threshold` rather than merely happening. The fixture is built
 *    here from the catalog's own effect lists, so the expected threshold is this file's
 *    arithmetic and not the engine's.
 * 2. **Every paired case is unchanged**, so the new catch is not a blanket one: the same
 *    box with no events is still caught, the completion case is still exempt (the shipped
 *    false positive that exemption exists for — without it, five runs of the first fifty
 *    seeds stop at turn 12), a box one food below the threshold is still legal, the bare
 *    bound is still claimed whatever the events say, and the old clause was player-scoped
 *    rather than a blanket mute (another player's shortfall never exempted this city).
 * 3. **`city-food-conservation` keeps the exemption it needs** — the same bookkeeping
 *    error is caught with no shortfall and skipped when one stands for the demolition the
 *    events cannot name. That is the half a careless narrowing would have broken.
 * 4. **The widened bound stays quiet on real play** — a 200-seed sweep with the *whole*
 *    registry running every turn, on a different configuration from the sweep in
 *    `invariants.test.ts` (so the two are two experiments rather than one repeated), and
 *    the count of city-turns on which the reduced bound was actually live is reported so
 *    "quiet" cannot mean "never asked". A second, smaller sweep runs the seeds long
 *    enough that owners really do report shortfalls, which is the clause that changed.
 *
 * ## Provenance
 *
 * Nothing here introduces a game magnitude: every number is a seed, a turn cap, a map
 * size or a threshold summed out of `@civts/rules`' catalog.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  MIN_GROWTH_FOOD,
  applyCommand,
  asUnitTypeId,
  cityYields,
  foodBoxSize,
  newGame,
  type BuildingId,
  type City,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
// The **test tier** predicate: this file's long sweeps are `it.skipIf(!FULL_TIER)` —
// they run under `pnpm verify:full` and are reported as skipped by `pnpm verify`. The
// boundary and its reasoning live in `@civts/testing`'s `tier.ts`, once.
import { FULL_TIER } from '@civts/testing';
import {
  CORE_INVARIANTS,
  SIMPLE_POLICY,
  checkInvariants,
  runSimulation,
  type Invariant,
  type InvariantContext,
  type SimulationResult,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * The ruleset, validated the way the CLI validates it
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

/* ------------------------------------------------------------------ *
 * The fixture — a real state, corrupted on purpose
 * ------------------------------------------------------------------ */

/** What one catalog row shaves off a requirement, summed out of its own effect list. */
const growthFoodOfRow = (id: BuildingId): number =>
  CATALOG.buildings
    .filter((row) => row.id === id)
    .flatMap((row) => row.effects)
    .reduce((total, effect) => total + (effect.kind === 'growth-food' ? effect.amount : 0), 0);

/**
 * A founded city, taken from a real game rather than hand-assembled: the point of the
 * fixture is a city the engine could have produced, corrupted in exactly one field.
 */
const FOUNDED: { readonly state: GameState; readonly city: City } = (() => {
  const seed = 1;
  const created = newGame(
    seed,
    { ...DEFAULT_SETTINGS, seed, mapSize: 'tiny', civCount: 2 },
    RULESET,
  );
  if (!created.ok) throw new Error(`newGame(${String(seed)}) failed: ${created.error.kind}`);

  const settler = created.value.units.find(
    (unit) => unit.owner === created.value.players[0]?.id && unit.type === asUnitTypeId('settler'),
  );
  if (settler === undefined)
    throw new Error('the opening state has no settler to found a city with');

  const founded = applyCommand(
    created.value,
    settler.owner,
    { type: 'FoundCity', unitId: settler.id },
    RULESET,
  );
  if (!founded.ok) throw new Error(`FoundCity was refused: ${founded.error.kind}`);

  const city = founded.value.state.cities[0];
  if (city === undefined) throw new Error('FoundCity founded no city');
  return { state: founded.value.state, city };
})();

/**
 * The shipped `growth-food` row with the largest reduction, read from the catalog.
 *
 * Read rather than named (`granary`), because the row's id is content the catalog is
 * free to change; what this file needs is a row that genuinely lowers a threshold.
 */
const GROWTH_ROW = CATALOG.buildings
  .map((row) => ({ id: row.id, reduction: growthFoodOfRow(row.id) }))
  .filter((row) => row.reduction > 0)
  .reduce<{ id: BuildingId; reduction: number } | undefined>(
    (best, row) => (best === undefined || row.reduction > best.reduction ? row : best),
    undefined,
  );
if (GROWTH_ROW === undefined) {
  throw new Error('the shipped catalog ships no growth-food building, so this file proves nothing');
}

const OWNER: PlayerId = FOUNDED.city.owner;

/** The city, holding the growth-food row. */
const HOLDING: City = FOUNDED.city.buildings.includes(GROWTH_ROW.id)
  ? FOUNDED.city
  : { ...FOUNDED.city, buildings: [...FOUNDED.city.buildings, GROWTH_ROW.id] };

/** The bare curve, and the reduced threshold this file computes for itself. */
const BARE = foodBoxSize(HOLDING.population);
const REDUCED = Math.max(MIN_GROWTH_FOOD, BARE - GROWTH_ROW.reduction);

const withBox = (box: number): GameState => ({
  ...FOUNDED.state,
  cities: FOUNDED.state.cities.map((city) =>
    city.id === HOLDING.id ? { ...HOLDING, foodBox: box } : city,
  ),
});

const SHORTFALL_EVENTS: readonly GameEvent[] = [
  { type: 'TreasuryShortfall', playerId: OWNER, unpaid: 3 },
];

/** A `CityProduced` line for the growth-food row, as the production pass writes it. */
const COMPLETION_EVENTS: readonly GameEvent[] = [
  {
    type: 'CityProduced',
    cityId: HOLDING.id,
    owner: OWNER,
    item: { kind: 'building', id: GROWTH_ROW.id },
    shields: 0,
  },
];

const ctxFor = (
  state: GameState,
  events: readonly GameEvent[] = [],
  previous?: GameState,
): InvariantContext => ({
  state,
  previous,
  ruleset: RULESET,
  rulesetView: VIEW,
  events,
  turn: state.turn,
});

/** Every violation the whole shipped registry reports for a context, in registry order. */
const registryViolations = (ctx: InvariantContext): readonly string[] =>
  checkInvariants(ctx, CORE_INVARIANTS).map(
    (violation) => `${violation.invariant}: ${violation.message}`,
  );

/** Just the names, for the "by name" claims. */
const namesFired = (ctx: InvariantContext): readonly string[] =>
  checkInvariants(ctx, CORE_INVARIANTS).map((violation) => violation.invariant);

/* ------------------------------------------------------------------ *
 * 1 + 2. The escape, and the cases that must not have moved with it
 * ------------------------------------------------------------------ */

describe('the reduced food-box bound, and the escape it used to allow', () => {
  it('builds a fixture where the two bounds are genuinely different numbers', () => {
    // Non-vacuity: unless the reduction is real, every case below would be about the
    // bare bound and the reduced-bound clause would be untested.
    expect(GROWTH_ROW.reduction).toBeGreaterThan(0);
    expect(REDUCED).toBeLessThan(BARE);
    expect(REDUCED).toBeGreaterThanOrEqual(MIN_GROWTH_FOOD);
    // ...and the fixture city really holds the row that does it.
    expect(HOLDING.buildings).toContain(GROWTH_ROW.id);
  });

  it('CATches BY NAME the box at bare-minus-growthFood whose owner reported a shortfall', () => {
    // **This is the configuration that used to escape.** The shared predicate returned
    // "not recoverable" on any shortfall, so the box bound declined its reduced claim and
    // this state passed with no violation at all.
    const caught = checkInvariants(ctxFor(withBox(REDUCED), SHORTFALL_EVENTS), CORE_INVARIANTS);

    // By NAME, not merely "something fired": the witness is this invariant, and its
    // message names the reduced threshold the box is outside of.
    expect(caught.map((violation) => violation.invariant)).toContain(
      'city-food-box-within-threshold',
    );
    const witness = caught.find(
      (violation) => violation.invariant === 'city-food-box-within-threshold',
    );
    expect(witness).toBeDefined();
    expect(witness?.turn).toBe(withBox(REDUCED).turn);
    expect(witness?.message).toContain(`outside [0, ${String(REDUCED)})`);
    expect(witness?.message).toContain('no growth-food building was completed');

    // And no OTHER invariant claims it, so the catch is attributable rather than a
    // registry-wide alarm on a hand-built state.
    expect(namesFired(ctxFor(withBox(REDUCED), SHORTFALL_EVENTS))).toEqual([
      'city-food-box-within-threshold',
    ]);
  });

  it('keeps every paired case on the right side of the bound', () => {
    const fired = (state: GameState, events: readonly GameEvent[] = []): boolean =>
      namesFired(ctxFor(state, events)).includes('city-food-box-within-threshold');

    // The box with no events at all: caught before the change and after it, which is
    // what makes the shortfall case a *difference* rather than the only thing this
    // clause does.
    expect(fired(withBox(REDUCED))).toBe(true);

    // The shipped false positive, still exempt: a growth-food row completed this turn
    // joined the city AFTER growth ran, so the box it filled was measured against the
    // bare curve. Without this exemption five runs of the first fifty seeds
    // (`sim --map-size tiny --turns 20`) stop at turn 12 on a legal state.
    expect(fired(withBox(REDUCED), COMPLETION_EVENTS)).toBe(false);

    // One food below the reduced threshold is legal in every configuration, so the
    // catch above is about the bound and not about "any hand-built box fires".
    expect(fired(withBox(REDUCED - 1), SHORTFALL_EVENTS)).toBe(false);
    expect(fired(withBox(REDUCED - 1))).toBe(false);

    // The bare bound is claimed whatever the events say — it needs no event, because no
    // reduction can push a requirement above the bare curve.
    expect(fired(withBox(BARE), SHORTFALL_EVENTS)).toBe(true);
    expect(fired(withBox(BARE), COMPLETION_EVENTS)).toBe(true);

    // The old clause was player-scoped, never a blanket mute: ANOTHER player's shortfall
    // left this city caught, before the change and after it.
    const other = FOUNDED.state.players.find(
      (player) => player.kind === 'civ' && player.id !== OWNER,
    );
    expect(other).toBeDefined();
    if (other !== undefined) {
      expect(
        fired(withBox(REDUCED), [{ type: 'TreasuryShortfall', playerId: other.id, unpaid: 3 }]),
      ).toBe(true);
    }

    // The clean fixture — the same city at a legal box — fires nothing at all.
    expect(registryViolations(ctxFor(withBox(REDUCED - 1)))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The exemption conservation genuinely needs
 * ------------------------------------------------------------------ */

describe('city-food-conservation keeps the shortfall exemption it needs', () => {
  it('fires on an unexplained box move, and is silent when a shortfall stands for the demolition', () => {
    // The other half of the split, and the reason the predicate was split rather than
    // narrowed. The check *recomputes* the growth arithmetic against the after-state's
    // rows, so on a turn whose owner went short the rows that left are not knowable from
    // the events — the ledger names the player, never the buildings.
    const quiet: City = { ...HOLDING, workedTiles: [], foodBox: 10 };
    const quietState: GameState = {
      ...FOUNDED.state,
      cities: FOUNDED.state.cities.map((city) => (city.id === quiet.id ? quiet : city)),
    };

    // The surplus this city's own ground yields, read from the engine so the "wrong"
    // box below is wrong by construction: it moves by one food more than any reading of
    // the surplus can explain.
    let surplus: number;
    try {
      surplus = cityYields(quietState, VIEW, quiet.id).foodSurplus;
    } catch {
      surplus = 0;
    }
    const moved: City = { ...quiet, foodBox: quiet.foodBox + surplus + 1 };
    const movedState: GameState = {
      ...FOUNDED.state,
      cities: FOUNDED.state.cities.map((city) => (city.id === moved.id ? moved : city)),
    };
    const income: GameEvent = {
      type: 'IncomeCollected',
      playerId: OWNER,
      gold: 0,
      beakers: 0,
      luxuries: 0,
    };

    // Sensitivity: with nothing in the events to excuse it, the mis-bookkeeping is caught.
    const caught = checkInvariants(
      ctxFor(movedState, [income], quietState),
      CORE_INVARIANTS,
    ).filter((violation) => violation.invariant === 'city-food-conservation');
    expect(caught).toHaveLength(1);
    expect(caught[0]?.message).toContain('food bookkeeping');

    // ...and the same error on a turn whose owner reported a shortfall is exempt, because
    // a demolition this turn would have moved the threshold the check recomputes against.
    // A shared, narrowed predicate would have made this a false alarm on real bankruptcy.
    const exempt = checkInvariants(
      ctxFor(movedState, [income, ...SHORTFALL_EVENTS], quietState),
      CORE_INVARIANTS,
    ).filter((violation) => violation.invariant === 'city-food-conservation');
    expect(exempt).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The widened bound is quiet on real play
 * ------------------------------------------------------------------ */

/**
 * A recorder that counts what the sweep actually exercised, so "no violations" cannot be
 * the result of the registry never being asked.
 *
 * It is an ordinary `Invariant` — it returns no violations — appended to the shipped
 * registry, which is how a probe reads a run through the real runner without a second
 * turn pipeline to trust.
 */
interface SweepCoverage {
  readonly metricRows: number;
  readonly runs: number;
  readonly reducedBoundChecks: number;
  readonly reducedCities: number;
  readonly growthFoodCompletions: number;
  readonly shortfallLines: number;
  readonly allReached: boolean;
}

const sweep = (options: {
  readonly seeds: readonly number[];
  readonly mapSize: 'tiny' | 'duel';
  readonly civCount: number;
  readonly maxTurns: number;
}): { readonly results: readonly SimulationResult[]; readonly coverage: SweepCoverage } => {
  let reducedBoundChecks = 0;
  let reducedCities = 0;
  let growthFoodCompletions = 0;
  let shortfallLines = 0;
  let metricRows = 0;

  const recorder: Invariant = {
    name: 'sweep-coverage',
    description: 'counts what the sweep exercised; reports nothing (a probe, not a property)',
    check: (ctx) => {
      for (const event of ctx.events) {
        if (event.type === 'TreasuryShortfall') shortfallLines += 1;
        if (
          event.type === 'CityProduced' &&
          event.item.kind === 'building' &&
          growthFoodOfRow(event.item.id) > 0
        ) {
          growthFoodCompletions += 1;
        }
      }
      for (const city of ctx.state.cities) {
        const bare = foodBoxSize(city.population);
        const reduction = city.buildings.reduce((total, id) => total + growthFoodOfRow(id), 0);
        const reduced = Math.max(MIN_GROWTH_FOOD, bare - reduction);
        if (reduced >= bare) continue;
        reducedCities += 1;
        // The city-turns on which the reduced bound was *live* — claimed, compared and
        // satisfied. This is the number that makes "quiet" meaningful.
        if (city.foodBox < reduced) reducedBoundChecks += 1;
      }
      return [];
    },
  };

  const results = options.seeds.map((seed) => {
    const result = runSimulation({
      seed,
      settings: { ...DEFAULT_SETTINGS, seed, mapSize: options.mapSize, civCount: options.civCount },
      ruleset: RULESET,
      policies: Array.from({ length: options.civCount }, () => SIMPLE_POLICY),
      maxTurns: options.maxTurns,
      invariants: [...CORE_INVARIANTS, recorder],
    });
    metricRows += result.metrics.length;
    return result;
  });

  return {
    results,
    coverage: {
      metricRows,
      runs: results.length,
      reducedBoundChecks,
      reducedCities,
      growthFoodCompletions,
      shortfallLines,
      allReached: results.every((result) => result.stoppedBecause === 'max-turns'),
    },
  };
};

describe('the widened bound is quiet on real play', () => {
  // Full tier: 44.4 s. A 200-seed sweep with a deliberately reduced threshold live, which is how the
  // bound is shown to be *load-bearing* rather than decorative. A sweep this wide cannot be in a gate
  // anyone runs between edits, and dropping it to ten seeds would weaken the very claim it makes.
  it.skipIf(!FULL_TIER)(
    'holds across 200 seeds with the reduced bound live tens of thousands of times',
    () => {
      // A different configuration from `invariants.test.ts`'s 200-seed sweep (that one is
      // `tiny` with two civilizations; this one is `duel` with three), so the two sweeps
      // are two experiments rather than one repeated.
      const { results, coverage } = sweep({
        seeds: Array.from({ length: 200 }, (_, index) => index + 1),
        mapSize: 'duel',
        civCount: 3,
        maxTurns: 20,
      });

      // Every violation of every turn of every game, by name: the false-positive net.
      expect(
        results.flatMap((result) => result.violations).map((violation) => violation.invariant),
      ).toEqual([]);
      // ...and no run was truncated, so no aggregate folded over this batch is a mean over
      // games of different lengths (the FINDING A consequence).
      expect(coverage.allReached).toBe(true);

      // Non-vacuity, in three parts: the runs really played and reported, the reduced bound
      // was really claimed (not skipped by the exemption), and the growth-food completions
      // the exemption exists for really happened.
      expect(coverage.runs).toBe(200);
      expect(coverage.metricRows).toBe(200 * 20 * 3);
      expect(coverage.reducedCities).toBeGreaterThan(1000);
      expect(coverage.reducedBoundChecks).toBeGreaterThan(1000);
      expect(coverage.growthFoodCompletions).toBeGreaterThan(100);

      console.log(
        `invariant-precision sweep: ${String(coverage.runs)} runs, ${String(coverage.metricRows)} ` +
          `metric rows, ${String(coverage.reducedBoundChecks)} city-turns with the reduced bound live ` +
          `(of ${String(coverage.reducedCities)} on a lowered threshold), ` +
          `${String(coverage.growthFoodCompletions)} growth-food completions, ` +
          `${String(coverage.shortfallLines)} shortfall lines, 0 violations`,
      );
    },
    600_000,
  );

  // Full tier: 5.1 s, and it is not independently runnable — it reads the same 200-seed sweep the test
  // above builds. Leaving it in the fast tier would run that whole sweep here instead, which is the
  // slowest possible way to skip a test.
  it.skipIf(!FULL_TIER)(
    'holds on real turns whose owner actually reported a shortfall',
    () => {
      // The clause that changed, on turns where it can bite: the same seeds run long enough
      // that treasuries really do go short. Without this, the sweep above would be evidence
      // about a branch the shipped play of a 20-turn tiny game never enters.
      const { results, coverage } = sweep({
        seeds: Array.from({ length: 12 }, (_, index) => index + 1),
        mapSize: 'tiny',
        civCount: 2,
        maxTurns: 40,
      });

      expect(
        results.flatMap((result) => result.violations).map((violation) => violation.invariant),
      ).toEqual([]);
      expect(coverage.allReached).toBe(true);

      // Non-vacuity: shortfalls really happened, so the turns the old exemption muted are
      // in this batch. A sweep with no shortfall line would prove nothing about the clause.
      expect(coverage.shortfallLines).toBeGreaterThan(0);
      expect(coverage.reducedBoundChecks).toBeGreaterThan(0);

      console.log(
        `invariant-precision shortfall sweep: ${String(coverage.runs)} runs of ` +
          `${String(40)} turns, ${String(coverage.shortfallLines)} shortfall lines, ` +
          `${String(coverage.reducedBoundChecks)} city-turns with the reduced bound live, ` +
          `0 violations`,
      );
    },
    600_000,
  );
});
