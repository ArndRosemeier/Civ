/**
 * Growth — the food box, and M4c's `growth-food` effect on the threshold a city's
 * box is compared against (docs/INTERFACES.md M3 "Growth (food box)", M4c
 * "Building maintenance and effects"; PLAN.md §5.3 determinism).
 *
 * **What this file exists for.** M4c shipped `cityGrowthTarget`/`growthFoodNeeded`
 * (the functions that apply the `growth-food` reduction, floored at
 * `MIN_GROWTH_FOOD`) and a catalog that declares the effect on **both** the granary
 * and the Pyramids — and `applyGrowth` compared the box against the bare
 * `foodBoxSize(population)` anyway. So the effect was a read with no consumer, and
 * M4c's only wonder did nothing at all: a contract violation rather than a tuning
 * question. Every test below is written to **fail against that old behaviour**, and
 * the last group is the regression guard for the other half of the claim — that a
 * city with no `growth-food` building is *unchanged* by the wiring, because only
 * the threshold moved (not the loop, not the carry-over, not the starvation rule).
 *
 * The arithmetic is exact and stated, so a failure names the number that moved
 * rather than "some growth happened":
 *
 * - The fixture terrain yields **5 food** from the city centre, so a one-citizen
 *   city runs a surplus of exactly `5 - FOOD_PER_CITIZEN * 1 = 3`, and a
 *   two-citizen city a surplus of `5 - 4 = 1`. `FOOD_BOX_BASE` is 10 and
 *   `FOOD_BOX_PER_CITIZEN` is 5, so `foodBoxSize(1)` is 10 and the granary's
 *   reduction of 1 makes the one-citizen requirement **9**.
 * - A surplus of 3 therefore reaches 9 on the **third** turn of the run and 10 on
 *   the **fourth**: the granary city grows a turn earlier, carrying `9 - 9 = 0`
 *   over where the plain city carries `12 - 10 = 2`. (A surplus of 2 would *not*
 *   discriminate — 9 and 10 both land on the fifth turn — which is why the fixture
 *   is tuned to 3 and why the two remainders differ.)
 *
 * Every number in this file is a **placeholder of ours**: `FOOD_BOX_BASE`,
 * `FOOD_BOX_PER_CITIZEN`, `MIN_GROWTH_FOOD` and the effect magnitudes all say so
 * where they are declared, and nothing here is claimed to be Civ 3's (Civ 3's
 * granary keeps a food reserve; this engine's placeholder reading shrinks the
 * requirement instead).
 */

import { describe, expect, it } from 'vitest';
import { hashValue } from '@civts/testing';
import {
  MIN_GROWTH_FOOD,
  cityBuildingEffects,
  cityGrowthTarget,
  growthFoodNeeded,
} from '../src/buildings.js';
import { type BuildingDef, type City, cityById, cityYields } from '../src/cities.js';
import type { GameEvent } from '../src/commands.js';
import { FOOD_BOX_BASE, FOOD_BOX_PER_CITIZEN, applyGrowth, foodBoxSize } from '../src/growth.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  type CityId,
} from '../src/ids.js';
import type { GameMap, RulesetView, TerrainDef } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import { advanceTurn } from '../src/turn.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const RICH = asTerrainId('growth-test-grassland');

/**
 * 5 food / 1 shield / 1 commerce. The 5 is **a fixture, not content**: it is chosen
 * so a one-citizen city's surplus is exactly 3 — the value that makes the granary's
 * single-food reduction cross one turn earlier — without a second worked tile, an
 * improvement or a resource standing between the test and what it measures.
 */
const TERRAIN: TerrainDef = {
  id: RICH,
  role: 'grassland',
  name: 'Growth-test grassland',
  moveCost: 1,
  defenseBonusPct: 0,
  yields: { food: 5, shields: 1, commerce: 1 },
  impassable: false,
};

const MAP: GameMap = {
  width: 4,
  height: 4,
  terrain: Array.from({ length: 16 }, () => RICH),
  huts: [],
  resources: [],
};

const GRANARY: BuildingDef = {
  id: asBuildingId('granary'),
  name: 'Granary',
  cost: 10,
  maintenance: 0,
  effects: [{ kind: 'growth-food', amount: 1 }],
};

/** The wonder: the same effect, `wonder: true`, and a maintenance it has to pay. */
const PYRAMIDS: BuildingDef = {
  id: asBuildingId('pyramids'),
  name: 'Pyramids',
  cost: 30,
  maintenance: 2,
  effects: [{ kind: 'growth-food', amount: 1 }],
  wonder: true,
};

/** Declares nothing: the regression guard's "a building that is not a granary". */
const TEMPLE: BuildingDef = {
  id: asBuildingId('temple'),
  name: 'Temple',
  cost: 10,
  maintenance: 1,
  effects: [],
};

/** A multiplier, so an effect *is* read — just not the growth one. */
const MARKET: BuildingDef = {
  id: asBuildingId('marketplace'),
  name: 'Marketplace',
  cost: 12,
  maintenance: 1,
  effects: [{ kind: 'commerce-multiplier', pct: 50 }],
};

/** A reduction of exactly `foodBoxSize(1)`: the case that would reach zero unfloored. */
const EXACTLY_THE_BOX: BuildingDef = {
  id: asBuildingId('exactly-the-box'),
  name: 'Exactly the box',
  cost: 1,
  maintenance: 0,
  effects: [{ kind: 'growth-food', amount: FOOD_BOX_BASE }],
};

/** A reduction far past the box: the case that would go negative unfloored. */
const PAST_THE_BOX: BuildingDef = {
  id: asBuildingId('past-the-box'),
  name: 'Past the box',
  cost: 1,
  maintenance: 0,
  effects: [{ kind: 'growth-food', amount: 100 }],
};

const RULESET: RulesetView = {
  terrains: [TERRAIN],
  units: [],
  buildings: [GRANARY, PYRAMIDS, TEMPLE, MARKET, EXACTLY_THE_BOX, PAST_THE_BOX],
  improvements: [],
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (index: number, overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(0),
  kind: 'civ',
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  ...overrides,
});

const city = (id: number, tile: number, overrides: Partial<City> = {}): City => ({
  id: asCityId(id),
  owner: asPlayerId(0),
  name: `City ${String(id + 1)}`,
  tile: asTileIndex(tile),
  population: 1,
  foodBox: 0,
  shields: 0,
  queue: [],
  buildings: [],
  workedTiles: [],
  ...overrides,
});

const board = (overrides: Partial<GameState> = {}): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0), player(1)],
  nextUnitId: 0,
  units: [],
  explored: [Array.from({ length: 16 }, () => false), Array.from({ length: 16 }, () => false)],
  nextCityId: 2,
  cities: [],
  improvements: [],
  ...overrides,
});

const CITY_A = asCityId(0);
const CITY_B = asCityId(1);

/** One city of one player, on its own tile, holding the buildings asked for. */
const oneCity = (buildings: readonly BuildingDef[], overrides: Partial<City> = {}): GameState =>
  board({ cities: [city(0, 5, { buildings: buildings.map((def) => def.id), ...overrides })] });

const cityIn = (state: GameState, id: CityId): City => {
  const found = cityById(state, id);
  if (found === undefined) throw new Error(`city ${String(id)} is not in the state`);
  return found;
};

type CityGrew = Extract<GameEvent, { readonly type: 'CityGrew' }>;

const cityGrewEvents = (events: readonly GameEvent[], id: CityId): readonly CityGrew[] =>
  events.filter((event): event is CityGrew => event.type === 'CityGrew' && event.cityId === id);

/** The catalog this file's cities are measured against, as `cityGrowthTarget` wants it. */
const CATALOG = RULESET.buildings ?? [];

/* ------------------------------------------------------------------ *
 * The shape of a run: population and box, turn by turn
 * ------------------------------------------------------------------ */

interface GrowthStep {
  /** `state.turn` after the advance — one more than the number of turns run. */
  readonly turn: number;
  readonly population: number;
  readonly foodBox: number;
  readonly grew: CityGrew | undefined;
}

/** `turns` world turns of the pipeline, recording only the city that matters. */
const growthTrace = (state: GameState, turns: number, id: CityId): readonly GrowthStep[] => {
  const steps: GrowthStep[] = [];
  let current = state;
  for (let index = 0; index < turns; index += 1) {
    const outcome = advanceTurn(current, RULESET);
    current = outcome.state;
    const after = cityIn(current, id);
    steps.push({
      turn: current.turn,
      population: after.population,
      foodBox: after.foodBox,
      grew: cityGrewEvents(outcome.events, id)[0],
    });
  }
  return steps;
};

/** `[turn, population, foodBox, grew]` per turn — the whole trace as one comparable value. */
const traceShape = (steps: readonly GrowthStep[]): readonly (readonly number[])[] =>
  steps.map((step) => [step.turn, step.population, step.foodBox, step.grew === undefined ? 0 : 1]);

const firstGrowth = (steps: readonly GrowthStep[]): GrowthStep | undefined =>
  steps.find((step) => step.grew !== undefined);

/* ------------------------------------------------------------------ *
 * 1. The granary grows a turn earlier — the defect this file pins
 * ------------------------------------------------------------------ */

describe('growth-food: a granary grows the city one turn earlier', () => {
  const granarySteps = growthTrace(oneCity([GRANARY]), 4, CITY_A);
  const plainSteps = growthTrace(oneCity([]), 4, CITY_A);

  it('pins both whole traces, and pins that they differ by exactly one turn', () => {
    // Turn 2 is one turn of surplus 3 (box 3), turn 3 the next (box 6), and turn 4
    // the granary city's requirement of 9 — where the plain city, at 9 of 10, is
    // one food short. Turn 5 continues: the granary city is at two citizens.
    expect(traceShape(granarySteps)).toEqual([
      [2, 1, 3, 0],
      [3, 1, 6, 0],
      [4, 2, 0, 1],
      [5, 2, 6, 0],
    ]);
    expect(traceShape(plainSteps)).toEqual([
      [2, 1, 3, 0],
      [3, 1, 6, 0],
      [4, 1, 9, 0],
      [5, 2, 2, 1],
    ]);

    const granaryGrowth = firstGrowth(granarySteps);
    const plainGrowth = firstGrowth(plainSteps);
    expect(granaryGrowth?.turn).toBe(4);
    expect(plainGrowth?.turn).toBe(5);
    expect((plainGrowth?.turn ?? 0) - (granaryGrowth?.turn ?? 0)).toBe(1);
  });

  it('carries the exact remainder over on both sides', () => {
    const granaryGrowth = firstGrowth(granarySteps);
    const plainGrowth = firstGrowth(plainSteps);

    // 9 of 9 for the granary (remainder 0) against 12 of 10 for the plain city
    // (remainder 2): the reduction moves the *threshold*, and the carry-over rule is
    // M3's, untouched — food above the requirement is still kept.
    expect(granaryGrowth?.grew).toEqual({
      type: 'CityGrew',
      cityId: CITY_A,
      owner: asPlayerId(0),
      population: 2,
      foodBox: 0,
    });
    expect(plainGrowth?.grew).toEqual({
      type: 'CityGrew',
      cityId: CITY_A,
      owner: asPlayerId(0),
      population: 2,
      foodBox: 2,
    });
  });

  it('moved the threshold, not the food a city makes', () => {
    // The food side of the world is identical: same terrain, same surplus, same
    // `foodBoxSize(1)`. Only the requirement the box is compared against is reduced,
    // which is what makes the one-turn difference the effect's doing.
    const granaryState = oneCity([GRANARY]);
    const plainState = oneCity([]);

    expect(cityYields(granaryState, RULESET, CITY_A)).toEqual(
      cityYields(plainState, RULESET, CITY_A),
    );
    expect(cityYields(plainState, RULESET, CITY_A)).toEqual({
      food: 5,
      shields: 1,
      commerce: 1,
      foodSurplus: 3,
    });
    expect(foodBoxSize(1)).toBe(FOOD_BOX_BASE);
    expect(FOOD_BOX_PER_CITIZEN).toBe(5);
    expect(cityGrowthTarget(CATALOG, cityIn(granaryState, CITY_A), foodBoxSize(1))).toBe(9);
    expect(cityGrowthTarget(CATALOG, cityIn(plainState, CITY_A), foodBoxSize(1))).toBe(10);
  });

  it('applies inside the growth loop, at every population it walks through', () => {
    // The requirement is re-asked after each citizen, so the reduction applies at
    // population 2 as well: the granary city's requirements are 9 then 14, the plain
    // city's 10 then 15. Same starting box (21) and the same 3 food of surplus, and
    // the two end the single pass with different populations *and* different boxes.
    const granary = applyGrowth(oneCity([GRANARY], { foodBox: 21 }), RULESET);
    const plain = applyGrowth(oneCity([], { foodBox: 21 }), RULESET);

    // 21 + 3 = 24: minus 9 = 15 at two citizens, minus 14 = 1 at three.
    expect(cityIn(granary.state, CITY_A)).toMatchObject({ population: 3, foodBox: 24 - 9 - 14 });
    // 24 - 10 = 14, which is one short of the 15 a third citizen needs.
    expect(cityIn(plain.state, CITY_A)).toMatchObject({ population: 2, foodBox: 24 - 10 });
    expect(cityIn(granary.state, CITY_A).population).toBe(
      cityIn(plain.state, CITY_A).population + 1,
    );
  });

  it('moves the state hash, because the population it produces differs', () => {
    const granary = applyGrowth(oneCity([GRANARY], { foodBox: 6 }), RULESET);
    const plain = applyGrowth(oneCity([], { foodBox: 6 }), RULESET);

    expect(cityIn(granary.state, CITY_A).population).toBe(2);
    expect(cityIn(plain.state, CITY_A).population).toBe(1);
    expect(hashValue(granary.state)).not.toBe(hashValue(plain.state));
  });
});

/* ------------------------------------------------------------------ *
 * 2. The Pyramids — M4c's only wonder, which used to do nothing
 * ------------------------------------------------------------------ */

describe('growth-food: the Pyramids reduce the same requirement', () => {
  it('gives its holder exactly the granary’s reduction', () => {
    const wonderSteps = growthTrace(oneCity([PYRAMIDS]), 4, CITY_A);
    const granarySteps = growthTrace(oneCity([GRANARY]), 4, CITY_A);

    expect(traceShape(wonderSteps)).toEqual(traceShape(granarySteps));
    expect(traceShape(wonderSteps)).toEqual([
      [2, 1, 3, 0],
      [3, 1, 6, 0],
      [4, 2, 0, 1],
      [5, 2, 6, 0],
    ]);

    const growth = firstGrowth(wonderSteps);
    expect(growth?.turn).toBe(4);
    expect(growth?.grew).toMatchObject({ population: 2, foodBox: 0 });
  });

  it('owes the reduction to the wonder’s own row, and only to its holder', () => {
    const holder = cityIn(oneCity([PYRAMIDS]), CITY_A);
    const neighbour = cityIn(oneCity([]), CITY_A);

    expect(cityGrowthTarget(CATALOG, holder, foodBoxSize(1))).toBe(9);
    // A wonder is not a global effect: a city that does not hold it still needs the
    // full 10, even though the Pyramids stand somewhere in the same world (M4c:
    // "a building's effects apply only to its own city").
    expect(cityGrowthTarget(CATALOG, neighbour, foodBoxSize(1))).toBe(10);
    expect(cityBuildingEffects(CATALOG, holder).growthFood).toBe(1);
    expect(cityBuildingEffects(CATALOG, neighbour).growthFood).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. One pass, one reduction per city
 * ------------------------------------------------------------------ */

describe('growth: each city is measured against its own buildings', () => {
  it('grows the granary city and leaves the plain one, in the same pass', () => {
    const state = board({
      cities: [
        city(0, 5, { buildings: [GRANARY.id], foodBox: 6 }),
        city(1, 10, { buildings: [], foodBox: 6 }),
      ],
    });

    const outcome = applyGrowth(state, RULESET);

    // Both reach 9 this turn; only the reduced requirement of 9 is met.
    expect(cityIn(outcome.state, CITY_A)).toMatchObject({ population: 2, foodBox: 0 });
    expect(cityIn(outcome.state, CITY_B)).toMatchObject({ population: 1, foodBox: 9 });
    expect(cityGrewEvents(outcome.events, CITY_A)).toHaveLength(1);
    expect(cityGrewEvents(outcome.events, CITY_B)).toHaveLength(0);
  });

  it('is pure: the input is untouched and the same call twice is the same state', () => {
    const state = board({
      cities: [city(0, 5, { buildings: [GRANARY.id], foodBox: 6 }), city(1, 10, { foodBox: 6 })],
    });
    const before = hashValue(state);

    const first = applyGrowth(state, RULESET);
    const second = applyGrowth(state, RULESET);

    expect(hashValue(state)).toBe(before);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toEqual(second.events);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The floor — a reduction can never make growth impossible
 * ------------------------------------------------------------------ */

describe('growth-food: the requirement floors at MIN_GROWTH_FOOD', () => {
  it('floors a reduction that would reach zero or go negative', () => {
    const exactly = cityIn(oneCity([EXACTLY_THE_BOX]), CITY_A);
    const past = cityIn(oneCity([PAST_THE_BOX]), CITY_A);

    // The unfloored arithmetic the floor exists for: `EXACTLY_THE_BOX` reduces by
    // `foodBoxSize(1)` itself, so the subtraction reaches exactly 0, and
    // `PAST_THE_BOX` takes it to -90. Both are floored to `MIN_GROWTH_FOOD`.
    expect(cityBuildingEffects(CATALOG, exactly).growthFood).toBe(FOOD_BOX_BASE);
    expect(cityBuildingEffects(CATALOG, past).growthFood).toBe(100);
    expect(foodBoxSize(1) - cityBuildingEffects(CATALOG, exactly).growthFood).toBe(0);
    expect(foodBoxSize(1) - cityBuildingEffects(CATALOG, past).growthFood).toBe(-90);
    expect(growthFoodNeeded(foodBoxSize(1), cityBuildingEffects(CATALOG, exactly))).toBe(
      MIN_GROWTH_FOOD,
    );
    expect(growthFoodNeeded(foodBoxSize(1), cityBuildingEffects(CATALOG, past))).toBe(
      MIN_GROWTH_FOOD,
    );
    expect(cityGrowthTarget(CATALOG, exactly, foodBoxSize(1))).toBe(MIN_GROWTH_FOOD);
    expect(cityGrowthTarget(CATALOG, past, foodBoxSize(1))).toBe(MIN_GROWTH_FOOD);
    expect(MIN_GROWTH_FOOD).toBe(1);
  });

  it('still grows — and still terminates — with a requirement of one food', () => {
    // One turn of surplus 3 against a requirement of 1 buys exactly three citizens
    // (3 -> 2 -> 1 -> 0 food for populations 1, 2 and 3) and then stops, because
    // 0 < 1. A requirement allowed to reach 0 would never stop: `foodBox >= 0` holds
    // at every step, so the loop would add citizens forever.
    const outcome = applyGrowth(oneCity([PAST_THE_BOX]), RULESET);

    expect(cityIn(outcome.state, CITY_A)).toMatchObject({ population: 4, foodBox: 0 });
    expect(cityGrewEvents(outcome.events, CITY_A)).toEqual([
      { type: 'CityGrew', cityId: CITY_A, owner: asPlayerId(0), population: 4, foodBox: 0 },
    ]);
  });

  it('bounds a long spurt by the floor rather than by a guess', () => {
    // A hand-built box of 12 plus this turn's 3 food is 15 thresholds of 1 food:
    // fifteen further citizens, no more and no fewer. The exact number is the point
    // — a threshold of 0 would have produced an unbounded loop instead.
    const outcome = applyGrowth(oneCity([PAST_THE_BOX], { foodBox: 12 }), RULESET);

    expect(cityIn(outcome.state, CITY_A)).toMatchObject({ population: 1 + 12 + 3, foodBox: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * 5. What did NOT change
 * ------------------------------------------------------------------ */

/**
 * The pre-M4c rule, written out: compare the box against the **bare** curve.
 *
 * This is the oracle the regression guard measures the engine against, and it is
 * spelled the way the old code was spelled (`while (foodBox >= foodBoxSize(pop))`)
 * on purpose: the claim under test is that a city with no `growth-food` building
 * behaves exactly as it did before the effect was wired in, and the only honest way
 * to check that is to implement the old behaviour and compare against it.
 */
const bareThresholdGrowth = (
  population: number,
  foodBox: number,
  surplus: number,
): readonly [number, number] => {
  let box = foodBox + surplus;
  let citizens = population;
  while (box >= foodBoxSize(citizens)) {
    box -= foodBoxSize(citizens);
    citizens += 1;
  }
  return [citizens, box];
};

describe('growth: a city with no growth-food building is unchanged', () => {
  it('matches the old bare-threshold rule across the whole grid of boxes', () => {
    // The fixture expresses exactly two surpluses: 3 at one citizen and 1 at two
    // (5 food from the centre minus the 2 each citizen eats). Both are checked
    // against the oracle at every box a growth can land on.
    const boxes = [0, 1, 3, 6, 7, 9, 10, 11, 14, 15, 16, 23, 40];
    const cases: readonly (readonly [number, number])[] = [
      [1, 3],
      [2, 1],
    ];
    let checked = 0;

    for (const [population, surplus] of cases) {
      for (const foodBox of boxes) {
        const state = oneCity([], { population, foodBox });
        // The surplus the engine computes is the surplus the oracle is fed: without
        // this the comparison could be against a number the fixture never makes.
        expect(cityYields(state, RULESET, CITY_A).foodSurplus).toBe(surplus);

        const expected = bareThresholdGrowth(population, foodBox, surplus);
        const after = cityIn(applyGrowth(state, RULESET).state, CITY_A);

        expect([after.population, after.foodBox]).toEqual([...expected]);
        checked += 1;
      }
    }

    // A guard on the guard: the grid must actually have run, or this proves nothing.
    expect(checked).toBe(cases.length * boxes.length);
  });

  it('grows identically with buildings that declare no growth-food', () => {
    // A temple (effects: []) and a marketplace (a commerce multiplier) are both read
    // by the engine — the multiplier moves commerce — and neither may touch the
    // growth threshold. One citizen, one food short of growing: nothing grows.
    const bare = applyGrowth(oneCity([], { foodBox: 6 }), RULESET);
    const temple = applyGrowth(oneCity([TEMPLE], { foodBox: 6 }), RULESET);
    const market = applyGrowth(oneCity([MARKET], { foodBox: 6 }), RULESET);

    for (const outcome of [bare, temple, market]) {
      expect(cityIn(outcome.state, CITY_A)).toMatchObject({ population: 1, foodBox: 9 });
      expect(cityGrewEvents(outcome.events, CITY_A)).toHaveLength(0);
    }

    // And one more food grows all three on the same turn, so "unchanged" is not
    // "nothing ever grows".
    for (const buildings of [[], [TEMPLE], [MARKET]] as const) {
      expect(
        cityIn(applyGrowth(oneCity(buildings, { foodBox: 7 }), RULESET).state, CITY_A),
      ).toMatchObject({ population: 2, foodBox: 0 });
    }
  });

  it('leaves the old boundary exactly where it was', () => {
    // Box 7 + surplus 3 is the requirement of 10 exactly: grows, remainder 0.
    expect(
      cityIn(applyGrowth(oneCity([TEMPLE], { foodBox: 7 }), RULESET).state, CITY_A),
    ).toMatchObject({ population: 2, foodBox: 0 });
    // Box 6 + 3 = 9 is one food short of 10, and two buildings that are not granaries
    // do not move that line. (The same 9 *is* enough for a granary city — that is the
    // whole of the effect, and section 3 pins it.)
    expect(
      cityIn(applyGrowth(oneCity([TEMPLE, MARKET], { foodBox: 6 }), RULESET).state, CITY_A),
    ).toMatchObject({ population: 1, foodBox: 9 });
  });

  it('leaves the starvation rule alone, granary or not', () => {
    // Three citizens eat 6 of the 5 food the centre makes: a deficit of 1 against an
    // empty box. The starvation branch never consults the growth threshold, so a
    // granary cannot change the outcome — the citizen is lost, the box restarts at
    // 0, and the events are identical.
    const starving = oneCity([GRANARY], { population: 3, foodBox: 0 });
    const plain = oneCity([], { population: 3, foodBox: 0 });

    expect(cityYields(starving, RULESET, CITY_A).foodSurplus).toBe(-1);

    const withGranary = applyGrowth(starving, RULESET);
    const without = applyGrowth(plain, RULESET);

    expect(cityIn(withGranary.state, CITY_A)).toMatchObject({ population: 2, foodBox: 0 });
    expect(cityIn(without.state, CITY_A)).toMatchObject({ population: 2, foodBox: 0 });
    expect(withGranary.events).toEqual(without.events);
    expect(withGranary.events).toEqual([
      { type: 'CityStarved', cityId: CITY_A, owner: asPlayerId(0), population: 2, foodBox: 0 },
    ]);
  });
});
