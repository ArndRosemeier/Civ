/**
 * City geometry and yields tests (INTERFACES.md M3, "City geometry and yields").
 *
 * The rules under test are geometric and arithmetic, so the board is a synthetic
 * state built by hand rather than a generated world: a 5x5 map with known terrain
 * makes "which 21 tiles" and "what does that sum to" directly checkable. The
 * ruleset is a local stand-in — `cities.ts` reads only the structural
 * `RulesetView`, so these tests do not depend on another workstream's content
 * package.
 *
 * The numbers this file asserts are *the placeholder rules themselves* (21 tiles,
 * a 1/1/1 centre floor, 2 food per citizen): pinning them here is how a later
 * intentional retune becomes a visible test change rather than a silent one. None
 * of them is claimed to be Civ 3-accurate, and the tests say so where it matters.
 */

import { describe, expect, it } from 'vitest';
import {
  CITY_RADIUS,
  FOOD_PER_CITIZEN,
  MIN_CITY_DISTANCE,
  autoAssignWorkedTiles,
  buildingCatalog,
  buildingDef,
  citiesOf,
  cityAt,
  cityById,
  cityRadius,
  cityYields,
  type City,
  type CityYields,
  type ProductionItem,
} from '../src/cities.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitTypeId,
} from '../src/ids.js';
import { indexToX, indexToY, tileIndex, type RulesetView, type TerrainDef } from '../src/map.js';
import { asImprovementId, type TileImprovement } from '../src/improvements.js';
import { seedRng } from '../src/rng.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';

/* ------------------------------------------------------------------ *
 * The synthetic board
 * ------------------------------------------------------------------ */

const WIDTH = 5;
const HEIGHT = 5;

/**
 * A 5x5 map, rows top to bottom. Every tile is grassland except two, so a yield
 * sum is easy to attribute: `hills` at (0,2) is the "better shields, worse food"
 * tile the auto-assignment ordering is measured against, and `mountains` at
 * (2,2) — the centre used below — yields 0/0/0, which makes the centre's 1/1/1
 * floor visible.
 */
const GRID: readonly string[] = [
  // y = 0
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  // y = 1
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  // y = 2
  'hills', // (0,2)
  'grassland',
  'mountains', // (2,2) — CENTRE
  'grassland',
  'grassland',
  // y = 3
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  // y = 4
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
];

const YIELDS_BY_ROLE: Readonly<
  Record<string, { food: number; shields: number; commerce: number }>
> = {
  grassland: { food: 2, shields: 1, commerce: 1 },
  hills: { food: 1, shields: 2, commerce: 1 },
  // Deliberately 0/0/0: the centre of a city on this tile still yields 1/1/1.
  mountains: { food: 0, shields: 0, commerce: 0 },
};

const TERRAINS: readonly TerrainDef[] = Object.entries(YIELDS_BY_ROLE).map(([role, yields]) => ({
  id: asTerrainId(role),
  role: role === 'hills' ? 'hills' : role === 'mountains' ? 'mountains' : 'grassland',
  name: role,
  moveCost: 1,
  defenseBonusPct: 0,
  yields,
  impassable: role === 'mountains',
}));

/**
 * A ruleset with no building catalog at all — the "no buildings" view.
 *
 * `improvements: []` is spelled out because M4a made the improvement catalog a
 * required part of a `RulesetView`: `cityYields` reads it for every worked tile,
 * so a view without it is not a view the engine can compute city output from.
 * An empty catalog is a catalog — it means "nothing is buildable", which is a
 * different claim from a missing field.
 */
const NO_BUILDINGS: RulesetView = {
  terrains: TERRAINS,
  units: [],
  improvements: [],
  fidelity: 'tuned',
};

/** The same view with a building catalog, as `@civts/rules` would supply. */
const WITH_BUILDINGS: RulesetView = {
  terrains: TERRAINS,
  units: [],
  buildings: [
    {
      id: asBuildingId('granary'),
      name: 'Granary',
      cost: 10,
      maintenance: 0,
      effects: [{ kind: 'growth-food', amount: 1 }],
    },
    {
      id: asBuildingId('library'),
      name: 'Library',
      cost: 20,
      maintenance: 1,
      effects: [{ kind: 'beaker-multiplier', pct: 50 }],
    },
  ],
  improvements: [],
  fidelity: 'tuned',
};

/**
 * M4c's two city-output effects, in one view: a marketplace that scales commerce
 * and a factory that scales shields. Kept separate from `WITH_BUILDINGS` so the
 * lookup test above pins the catalog it was written for, and so the numbers below
 * are the only buildings in play.
 *
 * The percentages and maintenances are this file's own stand-ins — the shipped
 * catalog's values are pinned in `@civts/rules`' test and exercised end to end in
 * `buildings.test.ts`. Nothing here is claimed to be Civ 3's.
 */
const YIELD_RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [],
  buildings: [
    {
      id: asBuildingId('marketplace'),
      name: 'Marketplace',
      cost: 12,
      maintenance: 1,
      effects: [{ kind: 'commerce-multiplier', pct: 50 }],
    },
    {
      id: asBuildingId('factory'),
      name: 'Factory',
      cost: 25,
      maintenance: 3,
      effects: [{ kind: 'shield-multiplier', pct: 50 }],
    },
  ],
  improvements: [],
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const terrainIds = (): readonly ReturnType<typeof asTerrainId>[] => {
  const out: ReturnType<typeof asTerrainId>[] = [];
  for (const role of GRID) out.push(asTerrainId(role));
  return out;
};

const player = (index: number, tile: number, kind: 'civ' | 'barbarian' = 'civ'): PlayerState => ({
  id: asPlayerId(index),
  name: kind === 'barbarian' ? 'Barbarians' : `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind,
  // M4b: every player carries the money fields, barbarians included (they hold 0
  // and never move, because they have no economy). A civilization's fixture starts
  // with the engine's own `STARTING_TREASURY` at `DEFAULT_RATES` so a fixture can
  // never drift from what `newGame` builds.
  treasury: kind === 'barbarian' ? 0 : STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: knowledge is a required field on `PlayerState` — "knows nothing" is an empty
  // array, never an absent key — so a hand-built player literal states it, barbarians
  // included: they can never research, and the empty list is what says so.
  techs: [],
});

const at = (x: number, y: number): number => tileIndex(WIDTH, x, y);

/**
 * A city with M3's shape and playable defaults: population 1, an empty food box,
 * nothing being built. Every field is spelled out (rather than left to a helper's
 * opinion) so a test that changes one reads as a change to one.
 */
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

/** Two civilizations and the barbarian player, as `newGame` assembles them. */
const PLAYERS: readonly PlayerState[] = [
  player(0, at(1, 1)),
  player(1, at(3, 3)),
  player(2, at(2, 2), 'barbarian'),
];

/**
 * The same view with two improvement rows, so this file can assert that
 * `cityYields` consults them. A single component each (+1 food, +1 shields) keeps
 * the arithmetic in the test above readable: the delta *is* the difference. The
 * shipped catalog's placeholder values are pinned in `@civts/rules`' test.
 */
const IMPROVEMENT_RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [],
  improvements: [
    {
      id: asImprovementId('irrigation'),
      kind: 'irrigation',
      name: 'Irrigation',
      turns: 2,
      yields: { food: 1, shields: 0, commerce: 0 },
      allowedRoles: ['grassland', 'plains'],
    },
    {
      id: asImprovementId('mine'),
      kind: 'mine',
      name: 'Mine',
      turns: 3,
      yields: { food: 0, shields: 1, commerce: 0 },
      allowedRoles: ['hills', 'mountains'],
    },
  ],
  fidelity: 'tuned',
};

/**
 * A hand-built board. `improvements` defaults to nothing built and can be given
 * pairs outright, so an improvement test reads as one line rather than as a
 * builder call — the M4a yield rules are asserted in `improvements.test.ts`, and
 * what this file pins is that `cityYields` *consults* them for a worked tile.
 */
const state = (
  cities: readonly City[],
  improvements: readonly TileImprovement[] = [],
): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: seedRng(7),
  map: {
    width: WIDTH,
    height: HEIGHT,
    terrain: terrainIds(),
    huts: [],
    // M4c: the map carries the resources `generateWorld` placed. Empty here, so a
    // bonus resource cannot be the hidden reason a yield in this file moved.
    resources: [],
  },
  players: PLAYERS,
  nextUnitId: 0,
  units: [],
  explored: PLAYERS.map(() => new Array<boolean>(WIDTH * HEIGHT).fill(false)),
  nextCityId: cities.length,
  cities,
  improvements,
});

/** A city on the middle tile (2,2) — mountains, so the centre floor is visible. */
const CENTRE = at(2, 2);

/* ------------------------------------------------------------------ *
 * The constants and the 21-tile shape
 * ------------------------------------------------------------------ */

describe('city radius', () => {
  it('exposes M3 placeholder constants', () => {
    // These are the contract's numbers, not sourced Civ 3 ones: 2 tiles of
    // Chebyshev reach, cities at least 2 apart, 2 food per citizen. Pinned here
    // so an intentional retune has to change this test on purpose.
    expect(CITY_RADIUS).toBe(2);
    expect(MIN_CITY_DISTANCE).toBe(2);
    expect(FOOD_PER_CITIZEN).toBe(2);
  });

  it('returns exactly 21 in-bounds tiles for an interior tile', () => {
    // An interior tile: all 25 tiles of the 5x5 box exist, minus its four
    // corners, is 21. 5x5 is the smallest board on which "interior" exists at
    // all, which is why the synthetic map is 5x5.
    const board = state([]);
    const radius = cityRadius(board, asTileIndex(CENTRE));

    expect(radius).toHaveLength(21);
    expect(new Set(radius).size).toBe(21);
    // Ascending by tile index — the order is a property of the loop, not of a
    // comparison function, which is what makes it stable in a hash.
    expect([...radius]).toEqual([...radius].sort((a, b) => a - b));

    const corners = [at(0, 0), at(4, 0), at(0, 4), at(4, 4)];
    for (const corner of corners) expect(radius).not.toContain(corner);

    // Every tile in the box except the corners is included, and the centre is
    // one of them (it is worked, and free).
    const expected: number[] = [];
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;
        expected.push(at(2 + dx, 2 + dy));
      }
    }
    expect([...radius]).toEqual(expected);
    expect(radius).toContain(asTileIndex(CENTRE));
  });

  it('returns fewer tiles at a map corner and at a map edge, clipped to the map', () => {
    const board = state([]);

    // A corner (0,0): the 3x3 block that fits, minus the one box corner, is 8.
    const corner = cityRadius(board, asTileIndex(at(0, 0)));
    expect(corner).toHaveLength(8);
    for (const tile of corner) {
      expect(indexToX(board.map, tile)).toBeGreaterThanOrEqual(0);
      expect(indexToY(board.map, tile)).toBeGreaterThanOrEqual(0);
      expect(indexToX(board.map, tile)).toBeLessThan(WIDTH);
      expect(indexToY(board.map, tile)).toBeLessThan(HEIGHT);
    }

    // An edge but not a corner (0,2): three columns by five rows, minus the two
    // box corners that survive clipping, is 15 - 2 = 13.
    const edge = cityRadius(board, asTileIndex(at(0, 2)));
    expect(edge).toHaveLength(13);

    // Clipping never invents a tile: the result is still distinct and inside.
    expect(new Set(edge).size).toBe(edge.length);
    expect(new Set(corner).size).toBe(corner.length);
  });

  it('is empty for a centre that is not on the map', () => {
    const board = state([]);
    expect(cityRadius(board, asTileIndex(-1))).toEqual([]);
    expect(cityRadius(board, asTileIndex(WIDTH * HEIGHT))).toEqual([]);
    expect(cityRadius(board, asTileIndex(WIDTH * HEIGHT + 3))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

describe('lookups', () => {
  const cities = [city(0, 0, at(0, 0)), city(1, 1, at(4, 4)), city(2, 0, at(2, 3))];

  it('finds a city by id, and says so when there is none', () => {
    const board = state(cities);
    expect(cityById(board, asCityId(1))?.tile).toBe(at(4, 4));
    expect(cityById(board, asCityId(9))).toBeUndefined();
  });

  it('lists a player’s cities in id order', () => {
    const board = state(cities);
    expect(citiesOf(board, asPlayerId(0)).map((c) => Number(c.id))).toEqual([0, 2]);
    expect(citiesOf(board, asPlayerId(1)).map((c) => Number(c.id))).toEqual([1]);
    // The barbarian player owns no city; "none" is an empty list, not an error.
    expect(citiesOf(board, asPlayerId(2))).toEqual([]);
  });

  it('finds the city on a tile by its centre only', () => {
    const board = state(cities);
    expect(cityAt(board, asTileIndex(at(2, 3)))?.id).toBe(asCityId(2));
    // A tile inside a radius but not a centre is not "in" the city.
    expect(cityAt(board, asTileIndex(at(2, 2)))).toBeUndefined();
    expect(cityAt(board, asTileIndex(-1))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Yields
 * ------------------------------------------------------------------ */

describe('cityYields', () => {
  const GRASSLAND = { food: 2, shields: 1, commerce: 1 };

  it('floors the centre’s yields at 1/1/1 and charges its citizens food', () => {
    // The centre is mountains (0/0/0) in this ruleset, so what comes back is the
    // placeholder floor and nothing else.
    const board = state([city(0, 0, CENTRE)]);
    const yields = cityYields(board, NO_BUILDINGS, asCityId(0));

    expect(yields).toEqual({ food: 1, shields: 1, commerce: 1, foodSurplus: 1 - FOOD_PER_CITIZEN });
  });

  it('adds a worked tile’s terrain yields to the centre’s', () => {
    const tile = at(3, 2); // grassland, right of the centre
    const board = state([city(1, 0, CENTRE, { population: 2, workedTiles: [asTileIndex(tile)] })]);
    const yields = cityYields(board, NO_BUILDINGS, asCityId(1));

    // Centre floor 1/1/1 plus one grassland tile.
    expect(yields.food).toBe(1 + GRASSLAND.food);
    expect(yields.shields).toBe(1 + GRASSLAND.shields);
    expect(yields.commerce).toBe(1 + GRASSLAND.commerce);
    expect(yields.foodSurplus).toBe(yields.food - FOOD_PER_CITIZEN * 2);
  });

  it('counts at most `population` tiles, in the stored order', () => {
    const first = at(3, 2);
    const second = at(1, 2);
    const board = state([
      city(0, 0, CENTRE, {
        population: 1,
        workedTiles: [asTileIndex(first), asTileIndex(second)],
      }),
    ]);

    // One citizen, one tile: the second entry is ignored, not summed. (A longer
    // list is rejected by `SetWorkedTiles`; this read stays total.)
    const yields = cityYields(board, NO_BUILDINGS, asCityId(0));
    expect(yields.food).toBe(1 + GRASSLAND.food);
  });

  it('ignores entries a city could not legally work', () => {
    const outside = tileIndex(WIDTH, 0, 0); // |dx| == 2 and |dy| == 2 from (2,2)
    const board = state([
      city(0, 0, CENTRE, {
        population: 4,
        workedTiles: [
          asTileIndex(CENTRE), // the centre itself: already counted, and free
          asTileIndex(outside), // a box corner: outside the 21-tile radius
          asTileIndex(at(3, 2)),
          asTileIndex(at(3, 2)), // a duplicate: one tile, one citizen
          asTileIndex(-3), // not on the map at all
        ],
      }),
    ]);

    const yields = cityYields(board, NO_BUILDINGS, asCityId(0));
    expect(yields.food).toBe(1 + GRASSLAND.food);
    expect(yields.shields).toBe(1 + GRASSLAND.shields);
    expect(yields.commerce).toBe(1 + GRASSLAND.commerce);
  });

  it('produces integers for every combination of worked tiles', () => {
    const board = state([
      city(0, 0, CENTRE, {
        population: 3,
        workedTiles: [asTileIndex(at(3, 2)), asTileIndex(at(2, 1)), asTileIndex(at(1, 2))],
      }),
    ]);
    const yields = cityYields(board, NO_BUILDINGS, asCityId(0));

    for (const value of [yields.food, yields.shields, yields.commerce, yields.foodSurplus]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('is zero for a city that does not exist, rather than throwing', () => {
    const board = state([]);
    const yields: CityYields = cityYields(board, NO_BUILDINGS, asCityId(4));
    expect(yields).toEqual({ food: 0, shields: 0, commerce: 0, foodSurplus: 0 });
  });

  it('is unchanged by a catalog of buildings nobody has built', () => {
    // M4c changed *why* this holds, and the change is the point: a building's
    // effects apply only to the city that **holds** it, so a ruleset that ships
    // buildings — a library with a beaker effect, a granary with a growth-food one —
    // still produces exactly the output of a ruleset that ships none, as long as no
    // city has built anything. The assertion is the same one M3 pinned (the two
    // reads are equal); what moved is the reason it is true.
    const board = state([
      city(0, 0, CENTRE, { population: 2, workedTiles: [asTileIndex(at(3, 2))] }),
    ]);
    expect(cityYields(board, WITH_BUILDINGS, asCityId(0))).toEqual(
      cityYields(board, NO_BUILDINGS, asCityId(0)),
    );
    // Non-vacuity: the catalog really does carry effects, so the equality above is
    // about *unbuilt* rows rather than about an empty catalog.
    expect(WITH_BUILDINGS.buildings?.flatMap((def) => def.effects).length).toBeGreaterThan(0);
  });

  it('scales a city’s commerce and shields by the buildings that city holds', () => {
    // A city of three citizens: the centre (mountains, so its 0/0/0 terrain is
    // floored to 1/1/1) plus two worked grassland tiles (2/1/1 each) give
    //   food 1 + 2 + 2 = 5, shields 1 + 1 + 1 = 3, commerce 1 + 1 + 1 = 3.
    // Holding a marketplace (+50% commerce) and a factory (+50% shields):
    //   commerce floor(3 * 150 / 100) = 4, shields floor(3 * 150 / 100) = 4,
    //   food untouched (M4c's union has no food multiplier; the granary shrinks the
    //   growth requirement instead — see `buildings.test.ts`).
    const base = city(0, 0, CENTRE, {
      population: 3,
      workedTiles: [asTileIndex(at(3, 2)), asTileIndex(at(2, 1))],
    });
    const plain = state([base]);
    const built = state([
      { ...base, buildings: [asBuildingId('marketplace'), asBuildingId('factory')] },
    ]);

    expect(cityYields(plain, YIELD_RULESET, asCityId(0))).toEqual({
      food: 5,
      shields: 3,
      commerce: 3,
      foodSurplus: 5 - FOOD_PER_CITIZEN * 3,
    });
    expect(cityYields(built, YIELD_RULESET, asCityId(0))).toEqual({
      food: 5,
      shields: 4,
      commerce: 4,
      foodSurplus: 5 - FOOD_PER_CITIZEN * 3,
    });
  });

  it('applies a building only to its own city, never to another city — even its owner’s', () => {
    // The whole of "effects apply only to the city that holds the building": city 1
    // is the same player's, four tiles away, and its yields are the untouched ones.
    const bare = city(0, 0, CENTRE, { population: 2, workedTiles: [asTileIndex(at(3, 2))] });
    const other = city(1, 0, at(0, 0), { population: 2, workedTiles: [asTileIndex(at(1, 0))] });
    const stateWithout = state([bare, other]);
    const stateWith = state([
      { ...bare, buildings: [asBuildingId('marketplace'), asBuildingId('factory')] },
      other,
    ]);

    expect(cityYields(stateWith, YIELD_RULESET, asCityId(1))).toEqual(
      cityYields(stateWithout, YIELD_RULESET, asCityId(1)),
    );
    // …and the holding city really did change, so the equality is about the
    // *other* city rather than about a multiplier that does nothing.
    expect(cityYields(stateWith, YIELD_RULESET, asCityId(0))).not.toEqual(
      cityYields(stateWithout, YIELD_RULESET, asCityId(0)),
    );
  });

  it('reads only the stored assignment: unassigned citizens work nothing', () => {
    // Deliberate: the getter does not invent an assignment. A city whose citizens
    // have not been assigned produces what its centre produces, which is the
    // honest reading of the state — `autoAssignWorkedTiles` is how a caller
    // writes an assignment.
    const board = state([city(0, 0, CENTRE, { population: 3, workedTiles: [] })]);
    const yields = cityYields(board, NO_BUILDINGS, asCityId(0));

    expect(yields.food).toBe(1);
    expect(yields.foodSurplus).toBe(1 - FOOD_PER_CITIZEN * 3);
  });

  /**
   * M4a's half of this file. The improvement *rules* — the catalog, the pair
   * order, the idempotence of `withImprovement`, the clamp — are asserted in
   * `improvements.test.ts`; these two tests pin the one thing this module owns:
   * `cityYields` adds an improvement's delta for a **worked** tile and for no
   * other tile, including the centre.
   */
  it('adds a worked tile’s improvements to the city’s output', () => {
    const tile = at(3, 2);
    const worked = city(1, 0, CENTRE, { population: 2, workedTiles: [asTileIndex(tile)] });
    const plain = state([worked]);
    // An irrigation, whose only delta in this file's ruleset is +1 food.
    const irrigated = state(
      [worked],
      [{ tile: asTileIndex(tile), kind: asImprovementId('irrigation') }],
    );

    const before = cityYields(plain, IMPROVEMENT_RULESET, asCityId(1));
    const after = cityYields(irrigated, IMPROVEMENT_RULESET, asCityId(1));

    expect(after.food - before.food).toBe(1);
    expect(after.shields).toBe(before.shields);
    expect(after.commerce).toBe(before.commerce);
    expect(after.foodSurplus).toBe(before.foodSurplus + 1);
  });

  it('ignores an improvement on a tile no citizen works, and on the centre', () => {
    const tile = at(3, 2);
    const other = at(1, 2); // inside the radius, but unassigned
    const worked = city(1, 0, CENTRE, { population: 2, workedTiles: [asTileIndex(tile)] });

    const plain = state([worked]);
    const improvedElsewhere = state(
      [worked],
      [
        { tile: asTileIndex(other), kind: asImprovementId('irrigation') },
        // The centre is not a worked tile, so an improvement on it does nothing —
        // not even lifting its 1/1/1 floor, which is read from the terrain alone.
        { tile: asTileIndex(CENTRE), kind: asImprovementId('mine') },
      ],
    );

    expect(cityYields(improvedElsewhere, IMPROVEMENT_RULESET, asCityId(1))).toEqual(
      cityYields(plain, IMPROVEMENT_RULESET, asCityId(1)),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Auto-assignment (the helper founding/growth code writes into state)
 * ------------------------------------------------------------------ */

describe('autoAssignWorkedTiles', () => {
  it('ranks food first, then shields, then commerce, then the lowest index', () => {
    // City centre (1,1). Its radius holds the hills tile (0,2) — 1 food but 2
    // shields — and the mountains tile (2,2) — 0/0/0 — among many 2-food
    // grasslands. Food leads the ordering (placeholder), so the four lowest-index
    // 2-food tiles win and the shields-rich hills tile does not, which is the
    // whole point: a brand-new city must not starve chasing shields.
    const board = state([city(0, 0, at(1, 1), { population: 4 })]);
    const picked = autoAssignWorkedTiles(board, NO_BUILDINGS, asCityId(0));

    expect(picked.map(Number)).toEqual([at(0, 0), at(1, 0), at(2, 0), at(3, 0)]);
    expect(picked).not.toContain(asTileIndex(at(0, 2))); // hills
    expect(picked).not.toContain(asTileIndex(at(2, 2))); // mountains
    expect(picked).not.toContain(asTileIndex(at(1, 1))); // the centre, which is free
    expect(new Set(picked).size).toBe(picked.length); // never the same tile twice
  });

  it('never hands out a tile another city already works', () => {
    const centre = at(3, 3); // city 1, whose radius reaches (2,1)

    const unclaimed = state([city(0, 0, at(1, 1)), city(1, 1, centre, { population: 1 })]);
    // Free of a rival claim, (2,1) is exactly what city 1 would take.
    expect(autoAssignWorkedTiles(unclaimed, NO_BUILDINGS, asCityId(1))).toEqual([
      asTileIndex(at(2, 1)),
    ]);

    const claimed = state([
      city(0, 0, at(1, 1), { population: 1, workedTiles: [asTileIndex(at(2, 1))] }),
      city(1, 1, centre, { population: 1 }),
    ]);
    const forSecond = autoAssignWorkedTiles(claimed, NO_BUILDINGS, asCityId(1));

    // A tile worked by one city may not be worked by another, so the helper must
    // look past the claim rather than hand out a contested tile.
    expect(forSecond).not.toContain(asTileIndex(at(2, 1)));
    expect(forSecond).toHaveLength(1);
  });

  it('is deterministic, and defaults to the city’s population', () => {
    const board = state([city(0, 0, at(2, 1), { population: 4 })]);
    const first = autoAssignWorkedTiles(board, NO_BUILDINGS, asCityId(0));
    const second = autoAssignWorkedTiles(board, NO_BUILDINGS, asCityId(0));

    expect(first).toHaveLength(4);
    expect(second).toEqual(first);
  });

  it('returns nothing for an unknown city or a non-positive count', () => {
    const board = state([city(0, 0, at(2, 1))]);
    expect(autoAssignWorkedTiles(board, NO_BUILDINGS, asCityId(9))).toEqual([]);
    expect(autoAssignWorkedTiles(board, NO_BUILDINGS, asCityId(0), 0)).toEqual([]);
    expect(autoAssignWorkedTiles(board, NO_BUILDINGS, asCityId(0), -1)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The building catalog, as the engine sees it
 * ------------------------------------------------------------------ */

describe('building catalog', () => {
  it('is empty when a ruleset carries none', () => {
    // `RulesetView.buildings` is optional because M2-era views predate buildings;
    // "no buildings" is then an empty catalog, decided in exactly one place.
    expect(buildingCatalog(NO_BUILDINGS)).toEqual([]);
    expect(buildingDef(NO_BUILDINGS, asBuildingId('granary'))).toBeUndefined();
  });

  it('resolves a building id to its row, and says so when it cannot', () => {
    expect(buildingDef(WITH_BUILDINGS, asBuildingId('library'))?.cost).toBe(20);
    expect(buildingDef(WITH_BUILDINGS, asBuildingId('spaceship'))).toBeUndefined();
    expect(buildingCatalog(WITH_BUILDINGS).map((def) => def.id)).toEqual([
      asBuildingId('granary'),
      asBuildingId('library'),
    ]);
  });

  it('types a production item by kind, so a unit and a building cannot be confused', () => {
    const item: ProductionItem = { kind: 'building', id: asBuildingId('granary') };
    const other: ProductionItem = { kind: 'unit', id: asUnitTypeId('warrior') };
    expect(item.kind).toBe('building');
    expect(other.kind).toBe('unit');
  });
});
