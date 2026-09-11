/**
 * Production — M4c's half of it: the wonder rule at the moment of completion, and
 * a building's shield effect as it reaches the shield pool.
 *
 * M3's production rules (a single shield pool, one completion per city per turn,
 * placement, queue promotion) are pinned where they have always been — this file
 * adds the two things M4c changes about a completion and nothing else:
 *
 * - **a wonder is completed at most once in the world.** `mayStartBuilding` is the
 *   one statement of that rule; `applyProduction` is one of its two callers, and the
 *   test that matters is the one a planner cannot fake: a queue that already names a
 *   wonder another city holds is dropped **at completion time**, with nothing
 *   charged and no `CityProduced` event, so no second copy can appear however the
 *   entry got there (a hand-built state, a save, or a queue decided before the wonder
 *   was finished elsewhere).
 * - **a city that builds a factory banks more shields.** The multiplier is applied
 *   inside `cityYields`, so this file's assertion is about a *city's* output
 *   reaching the pool rather than about a second implementation here — and it is the
 *   end-to-end reading of "the +50% shows up in what the city produces".
 *
 * Every number below is a **placeholder** of this fixture's own (see
 * `buildings.test.ts`): the effect magnitudes, the costs and the maintenance. None
 * of it is claimed to be Civ 3's; the shipped catalog's rows are `placeholder(...)`
 * in `@civts/rules` and are exercised end to end in `buildings.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { hashValue } from '@civts/testing';
import { availableBuildings, mayStartBuilding } from '../src/buildings.js';
import type { BuildingDef, City, ProductionItem } from '../src/cities.js';
import { applyEconomy } from '../src/economy.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitTypeId,
  type BuildingId,
} from '../src/ids.js';
import type { GameMap, RulesetView, TerrainDef } from '../src/map.js';
import { applyProduction, itemCostOf } from '../src/production.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { DEFAULT_RATES, SCHEMA_VERSION, type GameState, type PlayerState } from '../src/state.js';
import type { UnitDef } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

const GRASSLAND = asTerrainId('grassland');

/** One shield a tile, so a city's shields are a count of tiles and easy to read. */
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
  cost: 4,
  domain: 'land',
};

const WONDER: BuildingDef = {
  id: asBuildingId('pyramids'),
  name: 'Pyramids',
  cost: 10,
  maintenance: 2,
  effects: [{ kind: 'growth-food', amount: 1 }],
  wonder: true,
};
const TEMPLE: BuildingDef = {
  id: asBuildingId('temple'),
  name: 'Temple',
  cost: 4,
  maintenance: 1,
  effects: [],
};
const FACTORY: BuildingDef = {
  id: asBuildingId('factory'),
  name: 'Factory',
  cost: 20,
  maintenance: 3,
  effects: [{ kind: 'shield-multiplier', pct: 50 }],
};

const BUILDINGS: readonly BuildingDef[] = [WONDER, TEMPLE, FACTORY];

const RULESET: RulesetView = {
  terrains: [TERRAIN],
  units: [WARRIOR],
  buildings: BUILDINGS,
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

/**
 * The two players, each with one city. City 0 (player 0) works two grassland tiles
 * — three citizens, so **3 shields a turn**; city 1 (player 1) works none, so 1.
 */
const board = (cities: readonly City[], overrides: Partial<GameState> = {}): GameState => ({
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
  cities,
  improvements: [],
  ...overrides,
});

const WORKED = [asTileIndex(4), asTileIndex(6)];

/** A city of three citizens on two worked tiles: 3 shields, 3 commerce a turn. */
const bigCity = (id: number, owner: number, tile: number, overrides: Partial<City> = {}): City =>
  city(id, owner, tile, { population: 3, workedTiles: [...WORKED], ...overrides });

const building = (name: string): ProductionItem => ({ kind: 'building', id: asBuildingId(name) });
const ids = (...names: readonly string[]): readonly BuildingId[] => names.map(asBuildingId);

const produced = (events: readonly { readonly type: string }[], type: string): number =>
  events.filter((event) => event.type === type).length;

/* ------------------------------------------------------------------ *
 * A wonder is completed at most once in the world
 * ------------------------------------------------------------------ */

describe('a wonder is completed at most once in the world', () => {
  it('completes a wonder for the city whose queue holds it, and charges its cost', () => {
    const state = board([
      bigCity(0, 0, 5, { shields: 8, production: building('pyramids'), queue: [] }),
    ]);
    const outcome = applyProduction(state, RULESET);

    // 8 banked + 3 from the tiles covers the cost of 10: the wonder joins the city,
    // the cost leaves the pool, and the item leaves the queue.
    expect(outcome.state.cities[0]?.buildings.map(String)).toEqual(['pyramids']);
    expect(outcome.state.cities[0]?.shields).toBe(8 + 3 - WONDER.cost);
    expect(outcome.state.cities[0]?.production).toBeUndefined();
    expect(outcome.events).toEqual([
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: asPlayerId(0),
        item: building('pyramids'),
        shields: 8 + 3 - WONDER.cost,
      },
    ]);
  });

  it('drops a queued wonder another city already holds, and charges nothing', () => {
    // The state the command layer cannot reach — a queue decided before the wonder
    // was finished elsewhere, or a hand-built state. Completing it would put a second
    // copy on the map, so the entry is dropped *at completion time* rather than
    // trusted; and because nothing was produced, nothing is charged: the pool keeps
    // every shield it had, including this turn's. The item is affordable — 11 against
    // a cost of 10 — so it is the *uniqueness* rule that refuses it and not the price.
    const state = board([
      bigCity(0, 0, 5, { buildings: [...ids('pyramids')] }),
      bigCity(1, 1, 10, {
        shields: 8,
        production: building('pyramids'),
        queue: [building('temple')],
      }),
    ]);
    const outcome = applyProduction(state, RULESET);

    expect(outcome.state.cities[1]?.buildings).toEqual([]);
    expect(outcome.state.cities[1]?.shields).toBe(8 + 3);
    // The redundant entry is gone and the queue moved on, exactly as the
    // already-built case does.
    expect(outcome.state.cities[1]?.production).toEqual(building('temple'));
    expect(outcome.state.cities[1]?.queue).toEqual([]);
    // No completion was reported for it — there is no second copy to report.
    expect(outcome.events).toEqual([]);
    // And the world still holds exactly one.
    expect(outcome.state.cities.flatMap((each) => each.buildings.map(String))).toEqual([
      'pyramids',
    ]);
  });

  it('asks the same predicate the menu asks, so the two cannot disagree', () => {
    // The rule this file pins twice — "may this city start this item" — has exactly
    // one implementation, and both callers read it: the option list a city is offered
    // and the pass that completes an item it already holds.
    const state = board([bigCity(0, 0, 5, { buildings: [...ids('pyramids')] }), bigCity(1, 1, 10)]);
    const other = state.cities[1];
    if (other === undefined) throw new Error('the fixture lost its second city');

    expect(availableBuildings(state, BUILDINGS, other).map((def) => def.id)).not.toContain(
      WONDER.id,
    );
    expect(mayStartBuilding(state, BUILDINGS, other, WONDER.id)).toBe(false);
    // Non-vacuity: an ordinary row is still offered, so the menu is not simply empty.
    expect(availableBuildings(state, BUILDINGS, other).map((def) => def.id)).toContain(TEMPLE.id);
  });

  it('completes the wonder again for the city whose queue holds it, once it is lost', () => {
    // "A bankrupted wonder becomes buildable again", read through both real passes:
    // bankruptcy takes the wonder (`applyEconomy`), and the very same queue then
    // completes it (`applyProduction`) — the row was never marked as used, because
    // uniqueness and "never rebuilt" are one rule in M4c rather than two.
    const state = board([
      city(0, 0, 5, { buildings: [...ids('pyramids')] }),
      bigCity(1, 1, 10, { shields: 8, production: building('pyramids') }),
    ]);
    // The same board with no income in coin at all (every commerce to luxuries), so
    // the wonder's maintenance is a shortfall that costs the player the wonder itself.
    const poor = board(
      [
        city(0, 0, 5, { buildings: [...ids('pyramids')] }),
        bigCity(1, 1, 10, { shields: 8, production: building('pyramids') }),
      ],
      {
        players: [
          player(0, { rates: { tax: 0, science: 0, luxury: 10 } }),
          player(1, { rates: { tax: 0, science: 0, luxury: 10 } }),
        ],
      },
    );

    // The wonder is real before bankruptcy: player 1's queue entry is refused.
    expect(applyProduction(state, RULESET).state.cities[1]?.buildings).toEqual([]);

    // Player 0 goes bankrupt on the wonder's maintenance and loses it.
    const afterEconomy = applyEconomy(poor, RULESET);
    expect(afterEconomy.events.map((event) => event.type)).toContain('TreasuryShortfall');
    expect(afterEconomy.state.cities[0]?.buildings).toEqual([]);

    // Now the same queue entry is accepted — the same city, the same item, one turn
    // later, with nothing but the state changed.
    const afterProduction = applyProduction(afterEconomy.state, RULESET);
    expect(afterProduction.state.cities[1]?.buildings.map(String)).toEqual(['pyramids']);
    expect(afterProduction.state.cities[1]?.shields).toBe(8 + 3 - WONDER.cost);
    expect(produced(afterProduction.events, 'CityProduced')).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * A building's effect reaches what the city produces
 * ------------------------------------------------------------------ */

describe('a shield effect reaches the shield pool', () => {
  it('banks more shields per turn for a city that holds a factory', () => {
    // An unaffordable item, so nothing completes and the pool *is* the observable:
    // a city of three citizens on two worked tiles yields 3 shields, and a +50%
    // factory turns that into floor(3 * 150 / 100) = 4.
    const queued = building('pyramids');
    const bare = board([bigCity(0, 0, 5, { production: queued })]);
    const built = board([bigCity(0, 0, 5, { production: queued, buildings: [...ids('factory')] })]);

    expect(applyProduction(bare, RULESET).state.cities[0]?.shields).toBe(3);
    expect(applyProduction(built, RULESET).state.cities[0]?.shields).toBe(4);

    // Three turns of the same queue: 9 shields against a cost of 10 is not enough,
    // and 12 is — so the factory finishes the wonder a turn earlier than the city
    // without one, and its leftover is what the cost left behind (12 - 10 = 2).
    let bareState = bare;
    let builtState = built;
    for (let turn = 0; turn < 3; turn += 1) {
      bareState = applyProduction(bareState, RULESET).state;
      builtState = applyProduction(builtState, RULESET).state;
    }
    expect(bareState.cities[0]?.shields).toBe(9);
    expect(bareState.cities[0]?.buildings).toEqual([]);
    expect(builtState.cities[0]?.buildings.map(String)).toEqual(['factory', 'pyramids']);
    expect(builtState.cities[0]?.shields).toBe(4 * 3 - WONDER.cost);
  });

  it('prices a building and a unit from the ruleset, and an unknown row as nothing', () => {
    // The read the completion path decides with, unchanged by M4c except that a
    // building row now carries a cost *and* the fields below it.
    expect(itemCostOf(RULESET, building('factory'))).toBe(FACTORY.cost);
    expect(itemCostOf(RULESET, { kind: 'unit', id: WARRIOR.id })).toBe(WARRIOR.cost);
    expect(itemCostOf(RULESET, building('spaceship'))).toBeUndefined();
  });

  it('does not mutate its input and stays hashable across a completion', () => {
    const state = board([bigCity(0, 0, 5, { shields: 5, production: building('temple') })]);
    const before = hashValue(state);

    const first = applyProduction(state, RULESET);
    const second = applyProduction(state, RULESET);

    expect(hashValue(state)).toBe(before);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    for (const each of first.state.cities) {
      expect(Number.isInteger(each.shields)).toBe(true);
    }
  });
});
