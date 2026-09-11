/**
 * Buildings — effects, maintenance, and the wonder rules (docs/INTERFACES.md M4c,
 * "Building maintenance and effects" and "Wonders v1").
 *
 * The board is hand-built for the same reason `economy.test.ts` builds one: every
 * number below is meant to be checkable by reading it. A 4×4 grassland board gives
 * each tile 2 food, 1 shield and 1 commerce, so a city's own output is a count of
 * tiles and "3 commerce becomes 4 under a +50% marketplace" is arithmetic a reader
 * can do in their head rather than a hash they have to trust.
 *
 * What this file is *for*, in the milestone's terms:
 *
 * - **the effect totals and the compound rule** — several multipliers of the same
 *   kind sum their percentages *first* and are floored *once*, which is a different
 *   number from flooring each building's contribution in turn (3 commerce under two
 *   25% multipliers is 4, not 3), pinned here because the two readings are otherwise
 *   indistinguishable in a review;
 * - **whose city an effect reaches** — its own, and only its own;
 * - **the granary** — a reduced growth requirement, floored at 1 so a city can
 *   always eventually grow and a consumer cannot divide by zero;
 * - **maintenance** — read, summed per city and per player, and total on a row this
 *   engine cannot read;
 * - **wonders** — globally unique (no other city may start one), and lost only to
 *   bankruptcy, after which the row is startable again. M4c has no destruction, so
 *   "unique" and "never rebuilt" are one rule here rather than two;
 * - and the **shipped catalog's own wonder**, so the rules above are shown to be
 *   reachable from real content and not only from a fixture.
 *
 * Every number this file declares is a **placeholder** of ours, chosen to be
 * playable: the effect magnitudes a fixture row carries, the maintenance it bills,
 * and `MIN_GROWTH_FOOD` (which is the engine's own, see `buildings.ts`). None of it
 * is claimed to be Civ 3's, and the shipped catalog's values are `placeholder(...)`
 * in `@civts/rules`.
 */

import { describe, expect, it } from 'vitest';
// The shipped catalog, read by the last describe block only, which pins the wonder
// rules against real content. Nothing in `packages/core/src` reads this package;
// this is evidence about the content, not a dependency of the engine on it.
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';
import { cityProductionOptions } from '../src/actions.js';
import {
  MIN_GROWTH_FOOD,
  applyEffectPct,
  availableBuildings,
  buildingHolder,
  cityBuildingEffects,
  cityGrowthTarget,
  cityMaintenance,
  disbandBuildings,
  effectTotals,
  growthFoodNeeded,
  isWonder,
  maintenanceOf,
  mayStartBuilding,
  playerMaintenance,
} from '../src/buildings.js';
import { cityYields, type BuildingDef, type City, type ProductionItem } from '../src/cities.js';
// The command layer's planner, read by one test in the wonders block: M4c's wonder
// rule has one implementation (`mayStartBuilding` below) and two askers, and the
// assertion that they agree is the point of that test. Importing it here is what
// makes the agreement testable rather than asserted in a comment.
import { planSetProduction } from '../src/commands.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTechId,
  asTerrainId,
  asTileIndex,
  asUnitTypeId,
  type BuildingId,
  type TechId,
} from '../src/ids.js';
import type { BuildingEffect, GameMap, RulesetView, TerrainDef } from '../src/map.js';
import { applyProduction } from '../src/production.js';
import { productionGate } from '../src/resources.js';
import type { TechDef } from '../src/tech.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { DEFAULT_RATES, SCHEMA_VERSION, type GameState, type PlayerState } from '../src/state.js';
import type { UnitDef } from '../src/units.js';
import { applyEconomy } from '../src/economy.js';

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

const GRASSLAND = asTerrainId('grassland');

/** Every tile yields the same, so a city's output is a count of tiles. */
const TERRAIN: TerrainDef = {
  id: GRASSLAND,
  role: 'grassland',
  name: 'Grassland',
  moveCost: 1,
  defenseBonusPct: 10,
  yields: { food: 2, shields: 1, commerce: 1 },
  impassable: false,
};

const MAP: GameMap = {
  width: 4,
  height: 4,
  terrain: Array.from({ length: 16 }, () => GRASSLAND),
  huts: [],
  resources: [],
};

const WARRIOR: UnitDef = {
  id: asUnitTypeId('warrior'),
  role: 'military',
  name: 'Warrior',
  attack: 0,
  defense: 0,
  movement: 1,
  cost: 1,
  domain: 'land',
};

/**
 * The fixture rows. Each one declares exactly what the test it belongs to reads, so
 * a failure names one effect rather than a pile of them:
 *
 * - `marketplace` and `bank` are two **commerce** multipliers (25% each), which is
 *   the compound case: summed first they give 50%, and two applications of 25%
 *   would give a different number;
 * - `factory` is a **shield** multiplier, `library` a **beaker** one;
 * - `granary` is a **growth-food** row with no maintenance, so the "free to keep"
 *   case is a row rather than an absence;
 * - `pyramids` is the **wonder**.
 */
const MARKETPLACE: BuildingDef = {
  id: asBuildingId('marketplace'),
  name: 'Marketplace',
  cost: 12,
  maintenance: 1,
  effects: [{ kind: 'commerce-multiplier', pct: 25 }],
};
const BANK: BuildingDef = {
  id: asBuildingId('bank'),
  name: 'Bank',
  cost: 16,
  maintenance: 2,
  effects: [{ kind: 'commerce-multiplier', pct: 25 }],
};
const FACTORY: BuildingDef = {
  id: asBuildingId('factory'),
  name: 'Factory',
  cost: 25,
  maintenance: 3,
  effects: [{ kind: 'shield-multiplier', pct: 50 }],
};
const LIBRARY: BuildingDef = {
  id: asBuildingId('library'),
  name: 'Library',
  cost: 20,
  maintenance: 1,
  effects: [{ kind: 'beaker-multiplier', pct: 50 }],
};
const GRANARY: BuildingDef = {
  id: asBuildingId('granary'),
  name: 'Granary',
  cost: 10,
  maintenance: 0,
  effects: [{ kind: 'growth-food', amount: 1 }],
};
const PYRAMIDS: BuildingDef = {
  id: asBuildingId('pyramids'),
  name: 'Pyramids',
  cost: 30,
  maintenance: 2,
  effects: [{ kind: 'growth-food', amount: 1 }],
  wonder: true,
};

/** A row nothing can read: a fractional percentage and an unknown kind. */
const FRACTIONAL: BuildingDef = {
  id: asBuildingId('fractional'),
  name: 'Fractional',
  cost: 1,
  maintenance: 0.5,
  effects: [{ kind: 'commerce-multiplier', pct: 2.5 }],
};

const CATALOG_ROWS: readonly BuildingDef[] = [
  MARKETPLACE,
  BANK,
  FACTORY,
  LIBRARY,
  GRANARY,
  PYRAMIDS,
  FRACTIONAL,
];

const RULESET: RulesetView = {
  terrains: [TERRAIN],
  units: [WARRIOR],
  buildings: CATALOG_ROWS,
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
  treasury: 0,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: `techs` is required on every player and is never absent — "knows nothing" is
  // an empty list, unlike `researching`, which is *absent* when nothing is being
  // researched. This file is about effects and wonders, so its fixture players know
  // no techs; the section that asks about a tech-gated building row supplies them
  // through `overrides`.
  techs: [],
  ...overrides,
});

const city = (id: number, owner: number, tile: number, overrides: Partial<City> = {}): City => ({
  id: asCityId(id),
  owner: asPlayerId(owner),
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
  nextCityId: 100,
  cities: [],
  improvements: [],
  ...overrides,
});

/** City 0's two worked tiles on the 4x4 board (centre tile 5, i.e. (1,1)). */
const WORKED: readonly ReturnType<typeof asTileIndex>[] = [asTileIndex(4), asTileIndex(6)];

/**
 * The city the yield assertions below use: three citizens, two grassland tiles
 * worked, so the centre (1/1/1 here, because grassland yields at least that) plus
 * the two tiles give **food 6, shields 3, commerce 3** before any building.
 */
const yieldingCity = (buildings: readonly BuildingId[] = []): City =>
  city(0, 0, 5, { population: 3, workedTiles: [...WORKED], buildings: [...buildings] });

const ids = (...names: readonly string[]): readonly BuildingId[] => names.map(asBuildingId);

/* ------------------------------------------------------------------ *
 * The effect totals — summed first, floored once
 * ------------------------------------------------------------------ */

describe('effectTotals — the percentages are summed, never applied one by one', () => {
  it('sums several multipliers of the same kind into one percentage', () => {
    const totals = effectTotals([
      { kind: 'commerce-multiplier', pct: 25 },
      { kind: 'commerce-multiplier', pct: 25 },
    ]);
    // 50, not "two applications of 25%": the floor happens later, once, in
    // `applyEffectPct`. The test below is the one that can tell the two apart.
    expect(totals.commercePct).toBe(50);
    expect(totals).toEqual({ commercePct: 50, beakerPct: 0, shieldPct: 0, growthFood: 0 });
  });

  it('keeps the four kinds apart', () => {
    expect(
      effectTotals([
        { kind: 'commerce-multiplier', pct: 25 },
        { kind: 'beaker-multiplier', pct: 50 },
        { kind: 'shield-multiplier', pct: 75 },
        { kind: 'growth-food', amount: 2 },
        { kind: 'growth-food', amount: 1 },
      ]),
    ).toEqual({ commercePct: 25, beakerPct: 50, shieldPct: 75, growthFood: 3 });
  });

  it('reads an effect it cannot use as no effect, rather than as a negative or a fraction', () => {
    // `validateRuleset` rejects all three of these, so the only way to hold one is a
    // hand-built view or a foreign ruleset — exactly the case the guard exists for.
    // Reading them as bonus would put a negative or a fractional number into a
    // city's yields, which are part of every state hash.
    const unknownKind = { kind: 'happiness', pct: 5 } as unknown as BuildingEffect;
    expect(
      effectTotals([
        { kind: 'commerce-multiplier', pct: -10 },
        { kind: 'shield-multiplier', pct: 2.5 },
        { kind: 'growth-food', amount: -3 },
        unknownKind,
      ]),
    ).toEqual({ commercePct: 0, beakerPct: 0, shieldPct: 0, growthFood: 0 });
  });

  it('is zero for a building that declares nothing', () => {
    expect(effectTotals([])).toEqual({ commercePct: 0, beakerPct: 0, shieldPct: 0, growthFood: 0 });
  });
});

describe('applyEffectPct — one floor, and only one', () => {
  it('adds the percentage and floors the result', () => {
    // 3 commerce under +50%: 4.5 floors to 4.
    expect(applyEffectPct(3, 50)).toBe(4);
    // The identity, and the empty case.
    expect(applyEffectPct(3, 0)).toBe(3);
    expect(applyEffectPct(0, 100)).toBe(0);
    // Whole results are not disturbed by the floor.
    expect(applyEffectPct(7, 100)).toBe(14);
  });

  it('is total on a value or a percentage this engine cannot use', () => {
    // A percentage it cannot read is no bonus; a value it cannot read scales to 0
    // (a scaled negative would be a yield no city can produce).
    expect(applyEffectPct(5, 2.5)).toBe(5);
    expect(applyEffectPct(5, -50)).toBe(5);
    expect(applyEffectPct(Number.NaN, 50)).toBe(0);
    expect(applyEffectPct(-4, 50)).toBe(0);
    expect(applyEffectPct(Number.POSITIVE_INFINITY, 50)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Before and after — the milestone's exact numbers
 * ------------------------------------------------------------------ */

describe('city output before and after a building', () => {
  it('scales commerce, shields and beakers by the city’s own buildings', () => {
    const bare = board({ cities: [yieldingCity()] });
    const built = board({ cities: [yieldingCity(ids('marketplace', 'factory', 'library'))] });

    // Before: the centre (1/1/1) plus two grassland tiles.
    expect(cityYields(bare, RULESET, asCityId(0))).toEqual({
      food: 6,
      shields: 3,
      commerce: 3,
      foodSurplus: 0,
    });

    // After: a +25% marketplace gives floor(3 * 125 / 100) = 3 — deliberately a
    // *visible* no-op, which is why the tile count alone is not the story — and the
    // +50% factory gives floor(3 * 150 / 100) = 4. Food is untouched: no member of
    // M4c's union multiplies food.
    expect(cityYields(built, RULESET, asCityId(0))).toEqual({
      food: 6,
      shields: 4,
      commerce: 3,
      foodSurplus: 0,
    });

    // The library is a *beaker* effect, so it shows up in the money loop's science
    // channel and nowhere else: 3 commerce all to science at 0/10/0.
    expect(
      cityYields(
        board({ cities: [yieldingCity(ids('marketplace', 'factory'))] }),
        RULESET,
        asCityId(0),
      ),
    ).toEqual(cityYields(built, RULESET, asCityId(0)));
  });

  it('compounds two multipliers by summing their percentages first', () => {
    // **The compound case, and the reason it is pinned.** A marketplace (25%) and a
    // bank (25%) on 3 commerce:
    //   summed first, floored once: floor(3 * 150 / 100) = floor(4.5) = 4
    //   applied one after the other: floor(floor(3 * 125 / 100) * 125 / 100)
    //                              = floor(floor(3.75) * 1.25) = floor(3 * 1.25) = 3
    // The contract's rule is the first; a "simplification" to the second is a
    // one-line change that would silently move every state hash with two such
    // buildings in one city.
    const one = board({ cities: [yieldingCity(ids('marketplace'))] });
    const both = board({ cities: [yieldingCity(ids('marketplace', 'bank'))] });

    expect(cityYields(one, RULESET, asCityId(0)).commerce).toBe(3);
    expect(cityYields(both, RULESET, asCityId(0)).commerce).toBe(4);
  });

  it('applies an effect to its own city only, never to another city of the same player', () => {
    const bare = city(0, 0, 5, { population: 3, workedTiles: [...WORKED] });
    const other = city(1, 0, 10, { population: 1, workedTiles: [] });
    const without = board({ cities: [bare, other] });
    const withBuilt = board({ cities: [{ ...bare, buildings: [...ids('factory')] }, other] });

    const before = cityYields(without, RULESET, asCityId(1));
    expect(cityYields(withBuilt, RULESET, asCityId(1))).toEqual(before);
    // Non-vacuity: the building really does change the city that holds it.
    expect(cityYields(withBuilt, RULESET, asCityId(0)).shields).toBe(4);
  });

  it('reads a city’s totals from what it holds, never from what the catalog describes', () => {
    // The catalog alone is not an effect: a city that holds nothing has nothing,
    // whichever rows its ruleset happens to describe.
    expect(cityBuildingEffects(CATALOG_ROWS, yieldingCity())).toEqual({
      commercePct: 0,
      beakerPct: 0,
      shieldPct: 0,
      growthFood: 0,
    });
    expect(cityBuildingEffects(CATALOG_ROWS, yieldingCity(ids('marketplace', 'bank')))).toEqual({
      commercePct: 50,
      beakerPct: 0,
      shieldPct: 0,
      growthFood: 0,
    });
    // An id the catalog does not describe contributes nothing rather than throwing.
    expect(cityBuildingEffects(CATALOG_ROWS, yieldingCity(ids('spaceship')))).toEqual({
      commercePct: 0,
      beakerPct: 0,
      shieldPct: 0,
      growthFood: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Growth food — the granary
 * ------------------------------------------------------------------ */

describe('growth food — the granary shrinks the requirement, floored at 1', () => {
  it('reduces the requirement by the city’s own growth-food total', () => {
    const effects = effectTotals([{ kind: 'growth-food', amount: 1 }]);
    // `growth.ts`' box size for population 3 is 10 + 5*3 = 25 in the shipped curve;
    // the number itself is the caller's, which is the point of this signature.
    expect(growthFoodNeeded(25, effects)).toBe(24);
    expect(growthFoodNeeded(10, effectTotals([{ kind: 'growth-food', amount: 3 }]))).toBe(7);
  });

  it('never goes below 1, however much growth food a city’s buildings declare', () => {
    // The floor is why a city can always eventually grow (a threshold of 0 would let
    // a growth loop add citizens forever inside one turn) and why a consumer that
    // divides by the requirement cannot divide by zero.
    expect(MIN_GROWTH_FOOD).toBe(1);
    const huge = effectTotals([{ kind: 'growth-food', amount: 1000 }]);
    expect(growthFoodNeeded(10, huge)).toBe(1);
    expect(growthFoodNeeded(1, huge)).toBe(1);
    // Totality: a requirement this engine cannot read is read as the floor.
    expect(growthFoodNeeded(Number.NaN, huge)).toBe(1);
    expect(growthFoodNeeded(10.5, effectTotals([]))).toBe(10);
  });

  it('composes the requirement from the city that holds the granary, and no other', () => {
    const holder = city(0, 0, 5, { population: 3, buildings: [...ids('granary')] });
    const bare = city(1, 0, 10, { population: 3 });
    const both = city(2, 0, 12, { population: 3, buildings: [...ids('granary', 'pyramids')] });

    // The granary is worth 1 food in the requirement, and it is worth it only to the
    // city that holds it — the other city's own copy of the same ruleset gives it
    // nothing.
    expect(cityGrowthTarget(CATALOG_ROWS, holder, 25)).toBe(24);
    expect(cityGrowthTarget(CATALOG_ROWS, bare, 25)).toBe(25);
    // Two growth-food rows in one city reduce by 2, which is the sum-first rule seen
    // from the growth side.
    expect(cityGrowthTarget(CATALOG_ROWS, both, 25)).toBe(23);
  });
});

/* ------------------------------------------------------------------ *
 * Maintenance
 * ------------------------------------------------------------------ */

describe('maintenance — what a building costs to keep', () => {
  it('reads a declared maintenance, and nothing from a row it cannot read', () => {
    expect(maintenanceOf(MARKETPLACE)).toBe(1);
    expect(maintenanceOf(GRANARY)).toBe(0);
    // A fractional maintenance is not a fractional bill, and a negative one is not a
    // credit: both are read as "declares nothing".
    expect(maintenanceOf(FRACTIONAL)).toBe(0);
    expect(maintenanceOf({ ...BANK, maintenance: -4 })).toBe(0);
  });

  it('sums a city’s buildings, and a player’s cities, and nobody else’s', () => {
    const first = city(0, 0, 5, { buildings: ids('marketplace', 'bank', 'granary') });
    const second = city(1, 0, 10, { buildings: ids('factory') });
    const theirs = city(2, 1, 12, { buildings: ids('library') });
    const state = board({ cities: [first, second, theirs] });

    // 1 + 2 + 0 in one city, 3 in the other; the other player's library is not here.
    expect(cityMaintenance(CATALOG_ROWS, first)).toBe(3);
    expect(cityMaintenance(CATALOG_ROWS, second)).toBe(3);
    expect(playerMaintenance(state, CATALOG_ROWS, asPlayerId(0))).toBe(6);
    expect(playerMaintenance(state, CATALOG_ROWS, asPlayerId(1))).toBe(1);
    // A player with no cities, and an id nothing describes, both cost nothing.
    expect(playerMaintenance(board(), CATALOG_ROWS, asPlayerId(0))).toBe(0);
    expect(cityMaintenance(CATALOG_ROWS, city(9, 0, 5, { buildings: ids('spaceship') }))).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Wonders — globally unique, and the one way one is lost
 * ------------------------------------------------------------------ */

describe('wonders are globally unique', () => {
  it('marks only the rows the catalog marks, and treats an absent key as “not a wonder”', () => {
    expect(isWonder(PYRAMIDS)).toBe(true);
    expect(isWonder(MARKETPLACE)).toBe(false);
    // The absence of the key is the whole of "ordinary building": a present `false`
    // is not a spelling this project uses, and `validateRuleset` rejects it.
    expect('wonder' in MARKETPLACE).toBe(false);
  });

  it('disappears from every other city’s options once any city anywhere holds it', () => {
    const holder = city(0, 0, 5);
    const otherPlayerCity = city(1, 1, 10);
    const before = board({ cities: [holder, otherPlayerCity] });

    // Before anybody builds it, both cities may start it.
    expect(mayStartBuilding(before, CATALOG_ROWS, holder, PYRAMIDS.id)).toBe(true);
    expect(mayStartBuilding(before, CATALOG_ROWS, otherPlayerCity, PYRAMIDS.id)).toBe(true);
    expect(
      availableBuildings(before, CATALOG_ROWS, otherPlayerCity).map((def) => def.id),
    ).toContain(PYRAMIDS.id);

    // Once city 0 of player 0 holds it, no other city may start it — not another
    // player's, and not the holder's own (which is M3's "already built").
    const built = board({
      cities: [{ ...holder, buildings: [...ids('pyramids')] }, otherPlayerCity],
    });
    expect(buildingHolder(built, PYRAMIDS.id)?.id).toBe(asCityId(0));
    expect(mayStartBuilding(built, CATALOG_ROWS, otherPlayerCity, PYRAMIDS.id)).toBe(false);
    expect(mayStartBuilding(built, CATALOG_ROWS, holder, PYRAMIDS.id)).toBe(false);
    expect(
      availableBuildings(built, CATALOG_ROWS, otherPlayerCity).map((def) => def.id),
    ).not.toContain(PYRAMIDS.id);

    // The ordinary rows are unaffected: uniqueness is the wonder's rule, not a rule
    // about buildings in general — the other city may still start a marketplace.
    expect(mayStartBuilding(built, CATALOG_ROWS, otherPlayerCity, MARKETPLACE.id)).toBe(true);
  });

  it('offers exactly the rows the applier accepts, and never a row the city already holds', () => {
    const two = city(0, 0, 5, { buildings: ids('marketplace') });
    const state = board({ cities: [two] });
    const offered = availableBuildings(state, CATALOG_ROWS, two).map((def) => def.id);

    expect(offered).not.toContain(MARKETPLACE.id);
    expect(offered).toContain(BANK.id);
    for (const def of CATALOG_ROWS) {
      expect(offered.includes(def.id)).toBe(mayStartBuilding(state, CATALOG_ROWS, two, def.id));
    }
    // Catalog order is the menu's order: a property of the data, not of this filter.
    expect(offered).toEqual(
      CATALOG_ROWS.filter((def) => def.id !== MARKETPLACE.id).map((d) => d.id),
    );
  });

  it('is refused by the planner through this same predicate, naming who holds it', () => {
    // **The rule has one implementation and two askers**, and this is the assertion
    // that they still agree: `commands.ts`' planner (*may this city be told to build
    // this* — the half a player can reach) and `production.ts`' completion pass both
    // read `mayStartBuilding` rather than each carrying a copy of the wonder rule.
    // Two writers of one rule is the M2 bug class this project names, and a wonder is
    // exactly where a divergence would stay invisible until two cities held one.
    const state = board({
      cities: [city(0, 0, 5, { buildings: [...ids('pyramids')] }), city(1, 1, 10)],
    });
    const rival = state.cities[1];
    if (rival === undefined) throw new Error('the fixture lost its second city');

    const refused = planSetProduction(state, RULESET, asPlayerId(1), asCityId(1), {
      kind: 'building',
      id: PYRAMIDS.id,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('the planner accepted a wonder another city holds');
    // The refusal names the holder, so the player learns *why* the option is gone.
    expect(refused.error).toEqual({
      kind: 'wonder-already-built',
      cityId: asCityId(1),
      building: PYRAMIDS.id,
      holder: asCityId(0),
    });

    // …and the planner's answer is the predicate's answer for every row of the
    // catalog, which is what "the menu never offers what the applier refuses" means.
    for (const def of CATALOG_ROWS) {
      const item: ProductionItem = { kind: 'building', id: def.id };
      expect(planSetProduction(state, RULESET, asPlayerId(1), asCityId(1), item).ok).toBe(
        mayStartBuilding(state, CATALOG_ROWS, rival, def.id),
      );
    }
    expect(availableBuildings(state, CATALOG_ROWS, rival).map((def) => def.id)).not.toContain(
      PYRAMIDS.id,
    );
  });
});

describe('losing a building — bankruptcy, the only destruction in M4c', () => {
  it('takes the most recently completed buildings, and only the billed ones', () => {
    // The granary is free to keep, so it is skipped even though it is the most
    // recent: losing it would cost the player an asset and buy nothing, which is the
    // rule M4b states for *free* units.
    const state = board({
      cities: [city(0, 0, 5, { buildings: ids('marketplace', 'granary', 'bank', 'factory') })],
    });

    const one = disbandBuildings(state, CATALOG_ROWS, asPlayerId(0), 1);
    expect(one.lost.map((loss) => String(loss.building))).toEqual(['factory']);
    expect(one.lost.map((loss) => loss.maintenance)).toEqual([3]);
    expect(one.state.cities[0]?.buildings.map(String)).toEqual(['marketplace', 'granary', 'bank']);

    // One gold more than the factory alone covers: the factory's 3 leaves 1 owed, so
    // the bank (2) goes too — an overshoot, because a partial building is not a
    // thing — and then it stops. Nothing further is taken once the amount is covered.
    const four = disbandBuildings(state, CATALOG_ROWS, asPlayerId(0), 4);
    expect(four.lost.map((loss) => String(loss.building))).toEqual(['factory', 'bank']);
    expect(four.state.cities[0]?.buildings.map(String)).toEqual(['marketplace', 'granary']);

    // Purity: the state it was handed is untouched, and both calls agree.
    expect(state.cities[0]?.buildings.map(String)).toEqual([
      'marketplace',
      'granary',
      'bank',
      'factory',
    ]);
    const before = hashValue(state);
    disbandBuildings(state, CATALOG_ROWS, asPlayerId(0), 9);
    expect(hashValue(state)).toBe(before);
  });

  it('visits cities in descending id order, so the last-founded city pays first', () => {
    const state = board({
      cities: [
        city(0, 0, 5, { buildings: ids('marketplace') }),
        city(1, 0, 10, { buildings: ids('bank') }),
        city(2, 1, 12, { buildings: ids('factory') }),
      ],
    });

    const taken = disbandBuildings(state, CATALOG_ROWS, asPlayerId(0), 2);
    expect(taken.lost).toEqual([
      { cityId: asCityId(1), building: asBuildingId('bank'), maintenance: 2 },
    ]);
    expect(taken.state.cities[0]?.buildings.map(String)).toEqual(['marketplace']);
    expect(taken.state.cities[1]?.buildings).toEqual([]);
    // The other player's factory is not on this player's bill and is not touched.
    expect(taken.state.cities[2]?.buildings.map(String)).toEqual(['factory']);
  });

  it('takes nothing for an amount that is not a positive whole number', () => {
    const state = board({ cities: [city(0, 0, 5, { buildings: ids('factory') })] });

    for (const amount of [0, -5, 1.5, Number.NaN]) {
      const outcome = disbandBuildings(state, CATALOG_ROWS, asPlayerId(0), amount);
      expect(outcome.lost).toEqual([]);
      // The *same* state, not a copy: nothing was owed, so nothing happened.
      expect(outcome.state).toBe(state);
    }
  });

  it('leaves a city with nothing billable exactly as it was', () => {
    const state = board({ cities: [city(0, 0, 5, { buildings: ids('granary') })] });
    const outcome = disbandBuildings(state, CATALOG_ROWS, asPlayerId(0), 5);

    expect(outcome.lost).toEqual([]);
    expect(outcome.state).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 * Bankruptcy, end to end: the wonder is lost and becomes buildable again
 * ------------------------------------------------------------------ */

describe('a bankrupted wonder leaves the world, and is buildable again', () => {
  /**
   * A player whose only building is the wonder and whose income is nothing: every
   * coin of commerce goes to luxuries, so the wonder's maintenance is a shortfall no
   * unit can cover (there are no units at all). This is the shape `@civts/rules`'
   * catalog makes reachable in a real game.
   */
  const bankruptWonder = (buildings: readonly BuildingId[]): GameState =>
    board({
      players: [
        player(0, { treasury: 0, rates: { tax: 0, science: 0, luxury: 10 } }),
        player(1, { treasury: 0, rates: { tax: 0, science: 0, luxury: 10 } }),
      ],
      cities: [city(0, 0, 5, { buildings: [...buildings] }), city(1, 1, 10)],
    });

  it('costs the player the wonder it could not pay for, and says so in the shortfall', () => {
    const state = bankruptWonder(ids('pyramids'));
    const outcome = applyEconomy(state, RULESET);

    const shortfalls = outcome.events.filter((event) => event.type === 'TreasuryShortfall');
    expect(shortfalls).toEqual([
      { type: 'TreasuryShortfall', playerId: asPlayerId(0), unpaid: PYRAMIDS.maintenance },
    ]);
    expect(outcome.state.players[0]?.treasury).toBe(0);
    // The wonder is gone from the only city that held it…
    expect(outcome.state.cities[0]?.buildings).toEqual([]);
    expect(buildingHolder(outcome.state, PYRAMIDS.id)).toBeUndefined();
    // …and the shortfall was *not* reduced by its demolition: the player lost the
    // wonder, it did not pay with it. Crediting it would make this branch
    // unreachable, which is the debt M4c exists to close.
    expect(playerMaintenance(outcome.state, CATALOG_ROWS, asPlayerId(0))).toBe(0);
  });

  it('makes the row startable again for every city, the moment it is lost', () => {
    const state = bankruptWonder(ids('pyramids'));
    const after = applyEconomy(state, RULESET).state;
    const otherPlayerCity = after.cities[1];
    if (otherPlayerCity === undefined) throw new Error('the fixture lost its second city');

    // "Globally unique" and "never rebuilt" are the same rule here: M4c has no
    // destruction other than this, so a city may hold a wonder again as soon as
    // nobody holds it — which is exactly what "buildable again" means.
    expect(mayStartBuilding(after, CATALOG_ROWS, otherPlayerCity, PYRAMIDS.id)).toBe(true);
    expect(availableBuildings(after, CATALOG_ROWS, otherPlayerCity).map((def) => def.id)).toContain(
      PYRAMIDS.id,
    );
    // And the city that lost it may start it again too.
    const loser = after.cities[0];
    if (loser === undefined) throw new Error('the fixture lost its first city');
    expect(mayStartBuilding(after, CATALOG_ROWS, loser, PYRAMIDS.id)).toBe(true);
  });

  it('does not take a wonder nobody is billed for, and changes nothing else', () => {
    // The falsification of the pair above: same board, and the city holds the free
    // building instead. Nothing is owed, so nothing is lost and no shortfall exists.
    const state = bankruptWonder(ids('granary'));
    const outcome = applyEconomy(state, RULESET);

    expect(outcome.events.filter((event) => event.type === 'TreasuryShortfall')).toEqual([]);
    expect(outcome.state.cities[0]?.buildings.map(String)).toEqual(['granary']);
    expect(outcome.state.cities[1]?.buildings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The shipped catalog's own wonder
 * ------------------------------------------------------------------ */

describe('the shipped catalog’s wonder obeys the same rules', () => {
  const SHIPPED: RulesetView = (() => {
    const validated = validateRuleset(CATALOG, 'tuned');
    if (!validated.ok) {
      throw new Error(
        `the shipped catalog must validate at fidelity "tuned": ${JSON.stringify(validated.error)}`,
      );
    }
    return validated.value;
  })();

  const shippedWonder = SHIPPED.buildings?.find((def) => isWonder(def));

  it('ships exactly one wonder row, so the rule is reachable from real content', () => {
    // Non-vacuity for everything below: the shipped catalog really does carry a
    // wonder, and it really does cost gold to keep — otherwise "a bankrupted wonder
    // becomes buildable again" would be a statement about a fixture only.
    expect(shippedWonder).toBeDefined();
    if (shippedWonder === undefined) throw new Error('the shipped catalog ships no wonder');
    expect(maintenanceOf(shippedWonder)).toBeGreaterThan(0);
  });

  it('is unique worldwide, and is lost and rebuildable after a real bankruptcy', () => {
    if (shippedWonder === undefined) throw new Error('the shipped catalog ships no wonder');
    const wonder = shippedWonder.id;
    const rows = SHIPPED.buildings ?? [];

    const held = board({
      players: [player(0, { treasury: 0, rates: { tax: 0, science: 0, luxury: 10 } }), player(1)],
      cities: [city(0, 0, 5, { buildings: [wonder] }), city(1, 1, 10)],
    });

    // One city holds it: nobody else may start it.
    expect(buildingHolder(held, wonder)?.id).toBe(asCityId(0));
    const rival = held.cities[1];
    if (rival === undefined) throw new Error('the fixture lost its second city');
    expect(mayStartBuilding(held, rows, rival, wonder)).toBe(false);

    // Its maintenance against no gold: the real bankruptcy path takes it.
    const after = applyEconomy(held, SHIPPED).state;
    expect(buildingHolder(after, wonder)).toBeUndefined();
    expect(after.cities[0]?.buildings.map(String) ?? []).not.toContain(String(wonder));

    // …and the same rival city may now start it, through the same predicate the
    // planner and the production pass use.
    const rivalAfter = after.cities[1];
    if (rivalAfter === undefined) throw new Error('the pass lost the second city');
    expect(mayStartBuilding(after, rows, rivalAfter, wonder)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * M5 gating — a tech-gated building, in the menu and in the pass
 * ------------------------------------------------------------------ */

/**
 * The M5 fixture tech rows: two **placeholder** rows of ours (the costs are arbitrary —
 * no rule here reads one, because a requirement is a membership test on
 * `player.techs`). `BRONZE` gates the row below; `UNUSED_TECH` gates nothing, which is
 * the control the contract asks for.
 */
const BRONZE = asTechId('bronze-working');
const UNUSED_TECH = asTechId('ceremonial-burial');

const TECHS: readonly TechDef[] = [
  { id: BRONZE, name: 'Bronze Working', era: 'ancient', cost: 6, requires: [] },
  { id: UNUSED_TECH, name: 'Ceremonial Burial', era: 'ancient', cost: 6, requires: [] },
];

/**
 * The one gated building row, and it has an id of its own rather than being a second
 * `library`: an id is the key a catalog is looked up by, so two rows sharing one would
 * make "the row for `library`" depend on catalog order. Its cost, maintenance and
 * effects are the library's, so a difference between the two rows below is the tech
 * and nothing else.
 */
const OBSERVATORY: BuildingDef & { readonly requiresTech: TechId } = {
  ...LIBRARY,
  id: asBuildingId('observatory'),
  name: 'Observatory',
  requiresTech: BRONZE,
};

/** `RULESET` plus a place for the tech catalog to live, and the one gated row. */
const TECH_RULESET: RulesetView & { readonly techs: readonly TechDef[] } = {
  ...RULESET,
  buildings: [...CATALOG_ROWS, OBSERVATORY],
  techs: TECHS,
};

describe('M5 gating — the pass and the menu ask the same gate for a building', () => {
  const P0 = asPlayerId(0);
  const CITY = asCityId(0);

  /**
   * A player who knows exactly `techs`, with one city queueing `row` and 25 shields
   * banked. The city is the yield tests' own — centre tile 5, two worked grassland
   * tiles, so **3 shields a turn** — and 40 + 3 covers even the wonder's cost of 30,
   * so nothing in this section is waiting on affordability rather than on the tech.
   */
  const queueing = (row: BuildingDef, techs: readonly TechId[] = []): GameState =>
    board({
      players: [player(0, { techs: [...techs] }), player(1)],
      cities: [
        city(0, 0, 5, {
          population: 3,
          workedTiles: [...WORKED],
          shields: 40,
          production: { kind: 'building', id: row.id },
        }),
      ],
    });

  it('names the missing tech, and neither the menu nor the pass will have the building', () => {
    const state = queueing(OBSERVATORY);

    // The typed verdict names the tech — the row's own `requiresTech`, read through the
    // same gate the menu and the completion pass ask.
    expect(
      productionGate(state, TECH_RULESET, P0, { kind: 'building', id: OBSERVATORY.id }),
    ).toEqual({ kind: 'tech-required', tech: BRONZE });

    // Generator: not offered.
    const offered = cityProductionOptions(state, TECH_RULESET, CITY).map(
      (item) => `${item.kind}:${item.id}`,
    );
    expect(offered).not.toContain(`building:${OBSERVATORY.id}`);

    // Applier: the item waits — no event, no building, the pool keeps every shield
    // (40 banked + 3 earned), and the city is still building it.
    const outcome = applyProduction(state, TECH_RULESET);
    expect(outcome.events).toEqual([]);
    expect(outcome.state.cities[0]?.buildings).toEqual([]);
    expect(outcome.state.cities[0]?.shields).toBe(43);
    expect(outcome.state.cities[0]?.production).toEqual({
      kind: 'building',
      id: OBSERVATORY.id,
    });
  });

  it('builds the same building, for the same city, once the tech is known', () => {
    const after = queueing(OBSERVATORY, [BRONZE]);

    // Control: one field of the player differs. The verdict is open, the menu offers
    // it, and the pass builds it and charges the row's cost.
    expect(
      productionGate(after, TECH_RULESET, P0, { kind: 'building', id: OBSERVATORY.id }),
    ).toEqual({ kind: 'open' });
    const offered = cityProductionOptions(after, TECH_RULESET, CITY).map(
      (item) => `${item.kind}:${item.id}`,
    );
    expect(offered).toContain(`building:${OBSERVATORY.id}`);

    const outcome = applyProduction(after, TECH_RULESET);
    expect(outcome.events).toEqual([
      {
        type: 'CityProduced',
        cityId: CITY,
        owner: P0,
        item: { kind: 'building', id: OBSERVATORY.id },
        shields: 43 - OBSERVATORY.cost,
      },
    ]);
    expect(outcome.state.cities[0]?.buildings.map(String)).toEqual([String(OBSERVATORY.id)]);
    expect(outcome.state.cities[0]?.shields).toBe(43 - OBSERVATORY.cost);
    expect(outcome.state.cities[0]?.production).toBeUndefined();
  });

  it('gates nothing on a tech no row declares', () => {
    // Knowing a tech no row mentions changes no verdict and completes nothing…
    const unused = queueing(OBSERVATORY, [UNUSED_TECH]);
    expect(
      productionGate(unused, TECH_RULESET, P0, { kind: 'building', id: OBSERVATORY.id }),
    ).toEqual({ kind: 'tech-required', tech: BRONZE });
    expect(applyProduction(unused, TECH_RULESET).events).toEqual([]);

    // …while a row that declares nothing is offered and built by a player who knows
    // nothing at all.
    const plain = queueing(GRANARY);
    expect(productionGate(plain, TECH_RULESET, P0, { kind: 'building', id: GRANARY.id })).toEqual({
      kind: 'open',
    });
    expect(applyProduction(plain, TECH_RULESET).events.map((event) => event.type)).toEqual([
      'CityProduced',
    ]);
  });

  it('agrees row by row: every building the menu offers is one the pass completes', () => {
    // The keystone property, read over the whole catalog rather than one row: a
    // know-nothing player, an affordable queue holding each row in turn. Every row
    // except the gated one is offered *and* completed; the gated one is neither, on
    // exactly the same board.
    const rows = [...CATALOG_ROWS, OBSERVATORY];
    expect(rows.length).toBe(8);

    let gated = 0;
    for (const row of rows) {
      const state = queueing(row);
      const item: ProductionItem = { kind: 'building', id: row.id };
      const offered = cityProductionOptions(state, TECH_RULESET, CITY).some(
        (option) => option.kind === item.kind && option.id === item.id,
      );
      const outcome = applyProduction(state, TECH_RULESET);
      const built = outcome.state.cities[0]?.buildings.some((id) => id === row.id) ?? false;

      expect([row.id, offered, built]).toEqual([
        row.id,
        !(row === OBSERVATORY),
        !(row === OBSERVATORY),
      ]);
      if (row === OBSERVATORY) gated += 1;
    }

    // The sweep really did contain the gated row — a catalog with none would pass this
    // test vacuously.
    expect(gated).toBe(1);
  });
});
