/**
 * Resources — the M4c connection rule, the production gate and the yields a bonus
 * resource adds to a tile (docs/INTERFACES.md M4c, "Resources").
 *
 * The rule under test, verbatim from the contract:
 *
 * > a resource is connected for a player if some **city of that player** reaches
 * > the resource tile through a path of road-improved tiles (8-way, endpoints
 * > inclusive). Deterministic BFS; no path length limit.
 *
 * This file owns the *connectivity* half of M4c's evidence: a road chain, a
 * missing link, one resource reachable by two paths, the 8-way and
 * endpoint-inclusive readings, and the two places connection is *not* asked
 * (bonus yields, which are terrain). The production gate's own evidence — the
 * typed refusal through `applyCommand` and the catalog options the generator
 * offers — lives in `commands.test.ts` and `actions.test.ts`, next to the
 * evaluators it is decided by.
 *
 * Every board here is hand-built rather than generated: connectivity is a
 * property of a *specific* road layout, and a generated map would make each
 * assertion an accident of the seed. The fixture rows (terrain yields,
 * improvement deltas, resource yields) are **placeholder** numbers of ours,
 * chosen so every sum below is attributable to one named row — none of them is
 * presented as Civ 3's.
 */

import { describe, expect, it } from 'vitest';
import { cityById, type BuildingDef, type City, type ProductionItem } from '../src/cities.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asResourceId,
  asTerrainId,
  asTileIndex,
  asUnitTypeId,
} from '../src/ids.js';
import {
  IMPROVEMENT_KINDS,
  asImprovementId,
  tileYields,
  type ImprovementDef,
  type ImprovementId,
  type TileImprovement,
} from '../src/improvements.js';
import {
  compareTileResources,
  neighbors4,
  neighbors8,
  type GameMap,
  type ResourceDef,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
  type TerrainYields,
  type TileResource,
} from '../src/map.js';
import {
  bonusYieldsAt,
  connected,
  isConnected,
  requiredResourceOf,
  resourceGate,
  tileYieldsWithResources,
  type ResourceGate,
} from '../src/resources.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import type { UnitDef, UnitRole } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * Terrain, improvements and resources — fixture rows
 * ------------------------------------------------------------------ */

/**
 * Yields per role, so that a sum below names its parts: grassland is the food
 * tile, hills the shield tile, water the commerce tile. **Placeholder** numbers
 * of ours; the contract's provenance rule applies to every row in this file.
 */
const YIELDS_BY_ROLE: Readonly<Record<TerrainRole, TerrainYields>> = {
  ocean: { food: 1, shields: 0, commerce: 2 },
  coast: { food: 1, shields: 0, commerce: 2 },
  grassland: { food: 2, shields: 1, commerce: 1 },
  plains: { food: 1, shields: 1, commerce: 1 },
  hills: { food: 1, shields: 2, commerce: 1 },
  mountains: { food: 0, shields: 1, commerce: 0 },
};

const TERRAIN_ROWS: readonly (readonly [TerrainRole, number, boolean])[] = [
  ['ocean', 1, true],
  ['coast', 1, true],
  ['grassland', 1, false],
  ['plains', 1, false],
  ['hills', 2, false],
  ['mountains', 3, true],
];

const TERRAINS: readonly TerrainDef[] = TERRAIN_ROWS.map(([role, moveCost, impassable]) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost,
  defenseBonusPct: 0,
  yields: YIELDS_BY_ROLE[role],
  impassable,
}));

const LAND_ROLES: readonly TerrainRole[] = ['grassland', 'plains', 'hills', 'mountains'];
const FLAT_ROLES: readonly TerrainRole[] = ['grassland', 'plains'];
const WATER_ROLES: readonly TerrainRole[] = ['ocean', 'coast'];

/** A road: the only improvement this file needs *by kind* (see `connected`). */
const ROAD: ImprovementDef = {
  id: asImprovementId('road'),
  kind: 'road',
  name: 'Road',
  turns: 2,
  yields: { food: 0, shields: 0, commerce: 1 },
  allowedRoles: LAND_ROLES,
};

const MINE: ImprovementDef = {
  id: asImprovementId('mine'),
  kind: 'mine',
  name: 'Mine',
  turns: 3,
  yields: { food: 0, shields: 1, commerce: 0 },
  allowedRoles: ['hills', 'mountains'],
};

const IRRIGATION: ImprovementDef = {
  id: asImprovementId('irrigation'),
  kind: 'irrigation',
  name: 'Irrigation',
  turns: 2,
  yields: { food: 1, shields: 0, commerce: 0 },
  allowedRoles: FLAT_ROLES,
};

const IMPROVEMENTS: readonly ImprovementDef[] = [ROAD, MINE, IRRIGATION];

/**
 * The resource catalog, one row per kind, with the **placeholder** yields the
 * contract fixes for each: strategic and luxury rows declare zeros because their
 * only effect is a gate and a count, and the two bonus rows carry what they add
 * to a tile. `iron` requires nothing of itself — it is what a *unit* row demands.
 */
const IRON: ResourceDef = {
  id: asResourceId('iron'),
  name: 'Iron',
  kind: 'strategic',
  yields: { food: 0, shields: 0, commerce: 0 },
  allowedRoles: LAND_ROLES,
};

const GEMS: ResourceDef = {
  id: asResourceId('gems'),
  name: 'Gems',
  kind: 'luxury',
  yields: { food: 0, shields: 0, commerce: 0 },
  allowedRoles: LAND_ROLES,
};

const WHEAT: ResourceDef = {
  id: asResourceId('wheat'),
  name: 'Wheat',
  kind: 'bonus',
  yields: { food: 2, shields: 0, commerce: 0 },
  allowedRoles: FLAT_ROLES,
};

const FISH: ResourceDef = {
  id: asResourceId('fish'),
  name: 'Fish',
  kind: 'bonus',
  yields: { food: 3, shields: 0, commerce: 0 },
  allowedRoles: WATER_ROLES,
};

const RESOURCES: readonly ResourceDef[] = [IRON, GEMS, WHEAT, FISH];

const makeDef = (id: string, role: UnitRole, requiresResource?: ResourceDef): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 1,
  defense: 1,
  movement: 1,
  cost: 2,
  domain: 'land',
  ...(requiresResource === undefined ? {} : { requiresResource: requiresResource.id }),
});

const SETTLER = makeDef('settler', 'settler');
const WARRIOR = makeDef('warrior', 'military');
/** The one gated row: it demands iron, and nothing else in the catalog does. */
const SWORDSMAN = makeDef('swordsman', 'military', IRON);

/**
 * A building row, with the three fields M4c gave `BuildingDef`: `cost` (M3),
 * `maintenance` and `effects` (M4c). Maintenance is **0** and the effects list is
 * **empty** on purpose — this file is about resource connection and tile worth, so
 * "free to keep and currently does nothing" is the fixture that leaves every other
 * number in these tests attributable to the row being tested. (Both are values
 * `validateRuleset` accepts, and X2's building tests are where effects are pinned.)
 */
const GRANARY: BuildingDef = {
  id: asBuildingId('granary'),
  name: 'Granary',
  cost: 10,
  maintenance: 0,
  effects: [],
};

const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, WARRIOR, SWORDSMAN],
  buildings: [GRANARY],
  improvements: IMPROVEMENTS,
  resources: RESOURCES,
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/* ------------------------------------------------------------------ *
 * The boards
 * ------------------------------------------------------------------ */

/** 7x5 — room for a two-path road network around a city in the middle. */
const MAIN_WIDTH = 7;
const MAIN_HEIGHT = 5;

/**
 * The main board's coordinate helper: `at(x, y)` is the row-major tile index, so
 * every tile below reads as a position rather than as an arithmetic puzzle.
 */
const at = (x: number, y: number): number => y * MAIN_WIDTH + x;

/**
 * A map of one role, with the resource pairs given — stored through
 * `compareTileResources`, the one statement of `(tile, resource)` order, so these
 * fixtures are shaped exactly like a generated map rather than merely close to one.
 */
const mapOf = (
  width: number,
  height: number,
  role: TerrainRole,
  resources: readonly TileResource[],
): GameMap => ({
  width,
  height,
  terrain: Array.from({ length: width * height }, () => asTerrainId(role)),
  huts: [],
  resources: [...resources].sort(compareTileResources),
});

/** A resource pair, with the tile computed from `(x, y)` on the main board. */
const pair = (x: number, y: number, resource: ResourceDef): TileResource => ({
  tile: asTileIndex(at(x, y)),
  resource: resource.id,
});

/**
 * Improvement kinds in catalog order, so a fixture's list carries the same
 * ordering invariant a state built by the engine does: `(tile, kind)` ascending,
 * with the kind ordered by its index in `IMPROVEMENT_KINDS` — the *editorial*
 * order (`road`, `mine`, `irrigation`), which is not code-unit order. The branded
 * `ImprovementId` is not assignable to the literal tuple's element type, so the
 * membership test runs against the plain strings, exactly as `improvements.ts`
 * does it.
 */
const KIND_NAMES: readonly string[] = IMPROVEMENT_KINDS;

const kindRank = (kind: ImprovementId): number => KIND_NAMES.indexOf(kind);

const tileImprovement = (tile: number, def: ImprovementDef): TileImprovement => ({
  tile: asTileIndex(tile),
  kind: def.id,
});

const civPlayer = (index: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: '#d12f2f',
  startingTile: asTileIndex(17),
  kind: 'civ',
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
});

/** The barbarians: a player with units and a colour, and no economy at all. */
const barbarianPlayer = (index: number): PlayerState => ({
  ...civPlayer(index),
  name: 'Barbarians',
  color: '#3f3f46',
  kind: 'barbarian',
  treasury: 0,
});

const city = (id: number, owner: number, tile: number, population = 1): City => ({
  id: asCityId(id),
  owner: asPlayerId(owner),
  name: `City ${String(id + 1)}`,
  tile: asTileIndex(tile),
  population,
  foodBox: 0,
  shields: 0,
  queue: [],
  buildings: [],
  workedTiles: [],
});

interface BoardOptions {
  readonly map: GameMap;
  /** Tiles carrying a road — the only thing a connection path is made of. */
  readonly roads?: readonly number[];
  /** Any other improvement, so "a chain of mines is not a chain of roads" is testable. */
  readonly other?: readonly TileImprovement[];
  readonly cities?: readonly City[];
  readonly players?: readonly PlayerState[];
}

/**
 * A complete `GameState` over `options.map`. Every field is spelled out — a
 * partial literal would typecheck only through a cast, and the cast would hide
 * exactly the drift that a new field on `GameState` is.
 *
 * `explored` is one all-false row per player of the map's size: no test here
 * asserts anything about fog, and `connected` must not read it (M4c's rule is
 * about roads, not about what a player has seen).
 */
const board = (options: BoardOptions): GameState => {
  const players = options.players ?? [civPlayer(0), barbarianPlayer(1)];
  const improvements: TileImprovement[] = [
    ...(options.roads ?? []).map((tile) => tileImprovement(tile, ROAD)),
    ...(options.other ?? []),
  ].sort((a, b) =>
    a.tile === b.tile ? kindRank(a.kind) - kindRank(b.kind) : Number(a.tile) - Number(b.tile),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    turn: 1,
    seed: 7,
    settings: SETTINGS,
    rng: { a: 1, b: 2, c: 3, d: 4 },
    map: options.map,
    players,
    nextUnitId: 0,
    units: [],
    explored: players.map(() =>
      Array.from({ length: options.map.width * options.map.height }, () => false),
    ),
    nextCityId: options.cities?.length ?? 0,
    cities: options.cities ?? [],
    improvements,
  };
};

/** The city centre every main-board layout starts from: `(3, 2)` on a 7x5 map. */
const CENTRE = at(3, 2);

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);

/**
 * The plain main board: grassland everywhere, one city of player 0 at the centre,
 * no roads and no resources. Every `connected` test below is this board plus one
 * named change, so a failure names its cause.
 */
const EMPTY_MAP = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', []);

const PLAIN = board({ map: EMPTY_MAP, cities: [city(0, 0, CENTRE)] });

/* ------------------------------------------------------------------ *
 * connected — the one connection rule
 * ------------------------------------------------------------------ */

describe('connected — a road chain from a city centre to a resource', () => {
  /**
   * Iron on `(1, 0)` — tile 1 — reached from the centre `(3, 2)` by a road on
   * `(3, 1)` and a road on `(2, 0)`. Neither endpoint carries a road: the centre
   * because a centre *is* a node of the network, the resource because a chain that
   * ends next to it has reached it.
   */
  const IRON_AT = at(1, 0);
  const CHAIN_ROADS = [at(3, 1), at(2, 0)];
  const IRON_MAP = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(1, 0, IRON)]);

  const connectedBoard = board({
    map: IRON_MAP,
    roads: CHAIN_ROADS,
    cities: [city(0, 0, CENTRE)],
  });

  it('connects a resource the road chain reaches, endpoints inclusive', () => {
    const set = connected(connectedBoard, RULESET, P0);

    expect([...set]).toEqual([IRON.id]);
    expect(isConnected(connectedBoard, RULESET, P0, IRON.id)).toBe(true);

    // Neither endpoint of the path is road-improved, which is the half of the rule
    // that "endpoints inclusive" states: if either needed a road, this board —
    // deliberately built with roads only on the two interior tiles — would fail.
    const improvements = connectedBoard.improvements.map((entry) => Number(entry.tile));
    expect(improvements).not.toContain(CENTRE);
    expect(improvements).not.toContain(IRON_AT);
  });

  it('connects nothing when there is no road at all', () => {
    const noRoads = board({ map: IRON_MAP, cities: [city(0, 0, CENTRE)] });

    expect([...connected(noRoads, RULESET, P0)]).toEqual([]);
    expect(isConnected(noRoads, RULESET, P0, IRON.id)).toBe(false);
  });

  it('breaks the connection at a missing link in the middle of the chain', () => {
    // The centre is still adjacent to the first road, so the walk starts; the
    // second road is gone, and the resource is two tiles beyond it.
    const broken = board({
      map: IRON_MAP,
      roads: [at(3, 1)],
      cities: [city(0, 0, CENTRE)],
    });

    expect([...connected(broken, RULESET, P0)]).toEqual([]);
  });

  it('refuses to accept a chain of mines as a chain of roads', () => {
    // The same two tiles, carrying the same *number* of improvements — but of the
    // wrong kind. "Road-improved" is a kind, not "has an improvement on it".
    const mined = board({
      map: IRON_MAP,
      other: CHAIN_ROADS.map((tile) => tileImprovement(tile, MINE)),
      cities: [city(0, 0, CENTRE)],
    });

    expect(mined.improvements).toHaveLength(2);
    expect([...connected(mined, RULESET, P0)]).toEqual([]);
  });

  it('takes 8-way steps: the chain above is connected *only* through a diagonal one', () => {
    // Tile `(2, 0)` is diagonal from `(3, 1)` and orthogonal from nothing else on
    // the path, so a 4-way walk could not reach it — and the resource is adjacent
    // to it and to nothing the walk did reach.
    expect(neighbors4(IRON_MAP, at(2, 0))).not.toContain(asTileIndex(at(3, 1)));
    expect(neighbors4(IRON_MAP, at(3, 1))).not.toContain(asTileIndex(at(2, 0)));
    expect([...connected(connectedBoard, RULESET, P0)]).toEqual([IRON.id]);
  });

  it('connects a resource that shares a tile with a city centre', () => {
    // A city founded on iron has iron: the centre is where the walk starts, so the
    // resource tile is reached at distance zero, with no road anywhere.
    const onTheCentre = board({
      map: mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
        { tile: asTileIndex(CENTRE), resource: IRON.id },
      ]),
      cities: [city(0, 0, CENTRE)],
    });

    expect([...connected(onTheCentre, RULESET, P0)]).toEqual([IRON.id]);
  });

  it('connects a resource whose own tile carries the road', () => {
    const roaded = board({
      map: IRON_MAP,
      roads: [...CHAIN_ROADS, IRON_AT],
      cities: [city(0, 0, CENTRE)],
    });

    expect([...connected(roaded, RULESET, P0)]).toEqual([IRON.id]);
  });

  it('connects a resource merely next to a city centre, with no road anywhere', () => {
    // The shortest path of all: the centre is one 8-way step from the resource, so
    // there is no *interior* tile to be road-improved. "Endpoints inclusive" is what
    // says so, and this is the case that makes the rule's shortest reading visible
    // rather than implied — a walk that required a road on every tile after the
    // centre would disconnect iron the city is standing beside.
    const beside = board({
      map: mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
        { tile: asTileIndex(at(2, 1)), resource: IRON.id },
      ]),
      cities: [city(0, 0, CENTRE)],
    });

    expect(beside.improvements).toEqual([]);
    expect(neighbors8(beside.map, asTileIndex(CENTRE))).toContain(asTileIndex(at(2, 1)));
    expect([...connected(beside, RULESET, P0)]).toEqual([IRON.id]);

    // …and one step further away with the same absence of roads, it is *not*
    // connected: the "no road at all" case above, one tile closer.
    const twoStepsAway = board({
      map: mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
        { tile: asTileIndex(at(1, 3)), resource: IRON.id },
      ]),
      cities: [city(0, 0, CENTRE)],
    });

    expect(neighbors8(twoStepsAway.map, asTileIndex(CENTRE))).not.toContain(asTileIndex(at(1, 3)));
    expect([...connected(twoStepsAway, RULESET, P0)]).toEqual([]);
  });

  it('does not need the resource to be inside any city radius', () => {
    // Tile 1 is Chebyshev distance 4 from the centre — far outside the 21-tile
    // radius. M4c's rule is a *path* rule, and this pins that it is not a radius
    // rule wearing a road's clothes.
    expect(Number(cityById(connectedBoard, asCityId(0))?.tile)).toBe(CENTRE);
    expect([...connected(connectedBoard, RULESET, P0)]).toEqual([IRON.id]);
  });
});

describe('connected — the same resource reachable by two paths', () => {
  /**
   * Gems on `(6, 3)`, with two three-tile road chains to them: one along the row
   * above (`(4, 2)`, `(5, 2)`, `(6, 2)`) and one along the row beside
   * (`(3, 3)`, `(4, 3)`, `(5, 3)`). Both end adjacent to the gems.
   */
  const GEMS_MAP = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(6, 3, GEMS)]);
  const PATH_A = [at(4, 2), at(5, 2), at(6, 2)];
  const PATH_B = [at(3, 3), at(4, 3), at(5, 3)];

  const withRoads = (roads: readonly number[]): GameState =>
    board({ map: GEMS_MAP, roads, cities: [city(0, 0, CENTRE)] });

  it('reports one connection, not two, when both paths reach it', () => {
    const set = connected(withRoads([...PATH_A, ...PATH_B]), RULESET, P0);

    // A set, so the two paths cannot double-count: availability is a membership
    // question, and "connected twice" is not a thing a player can have.
    expect([...set]).toEqual([GEMS.id]);
    expect(set.size).toBe(1);
  });

  it('stays connected when either path alone is cut, and only breaks when both are', () => {
    const viaA = withRoads(PATH_A);
    const viaB = withRoads(PATH_B);
    const cutA = withRoads(PATH_B); // the A chain is gone
    const cutB = withRoads(PATH_A); // the B chain is gone
    const cutBoth = withRoads([at(4, 2), at(3, 3)]); // one link of each chain removed

    // Each single chain connects the gems on its own, which is what makes the two
    // paths genuinely redundant rather than one path counted twice.
    expect([...connected(viaA, RULESET, P0)]).toEqual([GEMS.id]);
    expect([...connected(viaB, RULESET, P0)]).toEqual([GEMS.id]);
    // Cutting one chain leaves the other, so nothing changes.
    expect([...connected(cutA, RULESET, P0)]).toEqual([GEMS.id]);
    expect([...connected(cutB, RULESET, P0)]).toEqual([GEMS.id]);
    // Cutting both does.
    expect(cutBoth.improvements).toHaveLength(2);
    expect([...connected(cutBoth, RULESET, P0)]).toEqual([]);
  });

  it('reads the whole map, not just the first resource pair', () => {
    // Two resources, one connected and one not: the set is exact in both
    // directions rather than merely non-empty.
    const twoResources = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
      pair(6, 3, GEMS),
      pair(0, 4, IRON),
    ]);
    const partially = board({
      map: twoResources,
      roads: PATH_A,
      cities: [city(0, 0, CENTRE)],
    });

    const set = connected(partially, RULESET, P0);
    expect([...set]).toEqual([GEMS.id]);
    expect(isConnected(partially, RULESET, P0, GEMS.id)).toBe(true);
    expect(isConnected(partially, RULESET, P0, IRON.id)).toBe(false);
  });
});

describe('connected — no path length limit, and no player without an economy', () => {
  it('walks a chain far longer than any city radius', () => {
    // A 20x2 board: the city centre is `(0, 0)`, every tile of the bottom row is a
    // road, and the resource sits at the far end. The chain is ~20 steps long —
    // the contract says there is no limit, and this board is long enough that a
    // hidden cap would show up as "not connected".
    const width = 20;
    const height = 2;
    const roads: number[] = [];
    for (let x = 0; x < width - 1; x += 1) roads.push(width + x); // the bottom row
    const far = width * height - 1; // `(19, 1)`, beside the last road

    const long = board({
      map: mapOf(width, height, 'grassland', [{ tile: asTileIndex(far), resource: IRON.id }]),
      roads,
      cities: [city(0, 0, 0)],
    });

    expect(long.improvements).toHaveLength(width - 1);
    expect([...connected(long, RULESET, P0)]).toEqual([IRON.id]);
  });

  it('gives barbarians no connections at all, on a board that would connect for a civ', () => {
    const ironMap = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(1, 0, IRON)]);
    const roads = [at(3, 1), at(2, 0)];

    // The identical board, owned by a civilization: connected.
    const civBoard = board({ map: ironMap, roads, cities: [city(0, 0, CENTRE)] });
    expect([...connected(civBoard, RULESET, P0)]).toEqual([IRON.id]);
    // The other player in that state is the barbarian one, and it owns no city.
    expect([...connected(civBoard, RULESET, P1)]).toEqual([]);

    // Owned by the barbarians — same roads, same city, no economy: nothing.
    const barbarians: PlayerState = barbarianPlayer(0);
    const barbarianBoard = board({
      map: ironMap,
      roads,
      cities: [city(0, 0, CENTRE)],
      players: [barbarians],
    });
    expect(barbarianBoard.cities[0]?.owner).toBe(P0);
    expect([...connected(barbarianBoard, RULESET, P0)]).toEqual([]);
    expect(isConnected(barbarianBoard, RULESET, P0, IRON.id)).toBe(false);
  });

  it('answers nothing for an actor the state does not hold, and for a player with no city', () => {
    const ironMap = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(1, 0, IRON)]);
    const roads = [at(3, 1), at(2, 0)];
    const citiless = board({ map: ironMap, roads });

    expect([...connected(citiless, RULESET, asPlayerId(99))]).toEqual([]);
    expect([...connected(citiless, RULESET, P0)]).toEqual([]);
  });

  it('connects nothing in a ruleset with no road row', () => {
    // Not a special case in the code, but worth pinning: without a road row there
    // is no tile a path could be made of, so the walk cannot leave its centres.
    const noRoads: RulesetView = { ...RULESET, improvements: [MINE, IRRIGATION] };
    const ironMap = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(1, 0, IRON)]);
    const roaded = board({
      map: ironMap,
      roads: [at(3, 1), at(2, 0)],
      cities: [city(0, 0, CENTRE)],
    });

    expect([...connected(roaded, RULESET, P0)]).toEqual([IRON.id]);
    expect([...connected(roaded, noRoads, P0)]).toEqual([]);
  });

  it('is deterministic: the same state gives the same set, element for element', () => {
    const ironMap = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
      pair(1, 0, IRON),
      pair(6, 3, GEMS),
    ]);
    const roaded = board({
      map: ironMap,
      roads: [at(3, 1), at(2, 0), at(4, 2), at(5, 2), at(6, 2)],
      cities: [city(0, 0, CENTRE)],
    });

    const first = connected(roaded, RULESET, P0);
    const second = connected(roaded, RULESET, P0);
    expect([...first]).toEqual([...second]);
    // Element order follows `map.resources`, which `map.ts` fixes as
    // `(tile, resource)` ascending — iron on tile 1, gems on tile 27 — so even the
    // *iteration* order of the set is a property of the state, not of the walk.
    expect([...first]).toEqual([IRON.id, GEMS.id]);
  });

  it('reads a map whose resource field is missing as carrying no resources', () => {
    // A save written before M4c, or a hand-built map: the honest read is "this
    // world holds none", because the alternative is a `TypeError` raised inside a
    // production-legality check. `improvements.ts` takes the same reading of its
    // own sparse list.
    const withoutKey = { ...EMPTY_MAP };
    // A deliberate `delete` on a copy, because the point is the *absent* key: no
    // literal spelling of `GameMap` can produce one, which is exactly why the read
    // has to tolerate it rather than trust the type.
    delete (withoutKey as { resources?: readonly TileResource[] }).resources;

    const state = board({
      map: withoutKey,
      roads: [at(3, 1), at(2, 0)],
      cities: [city(0, 0, CENTRE)],
    });

    expect('resources' in withoutKey).toBe(false);
    expect([...connected(state, RULESET, P0)]).toEqual([]);
    expect(bonusYieldsAt(state, RULESET, asTileIndex(at(3, 1)))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * ResourceGate — the verdict `planSetProduction` refuses with
 * ------------------------------------------------------------------ */

describe('resourceGate — is an item’s requirement satisfied?', () => {
  const IRON_MAP = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(1, 0, IRON)]);
  const CONNECTED = board({
    map: IRON_MAP,
    roads: [at(3, 1), at(2, 0)],
    cities: [city(0, 0, CENTRE)],
  });
  const DISCONNECTED = board({ map: IRON_MAP, cities: [city(0, 0, CENTRE)] });

  const unitItem = (def: UnitDef): ProductionItem => ({ kind: 'unit', id: def.id });
  const buildingItem: ProductionItem = { kind: 'building', id: GRANARY.id };

  it('reads the requirement off the unit row, and off nothing else', () => {
    expect(requiredResourceOf(RULESET, unitItem(SWORDSMAN))).toBe(IRON.id);
    expect(requiredResourceOf(RULESET, unitItem(WARRIOR))).toBeUndefined();
    expect(requiredResourceOf(RULESET, buildingItem)).toBeUndefined();
    // An item no catalog row defines demands nothing *here*: "this row cannot be
    // built" is `planSetProduction`'s `unknown-production-item`, not the gate's.
    expect(requiredResourceOf(RULESET, { kind: 'unit', id: asUnitTypeId('spaceship') })).toBe(
      undefined,
    );
  });

  it('opens for an item that demands nothing, and for a building', () => {
    for (const state of [CONNECTED, DISCONNECTED]) {
      expect(resourceGate(state, RULESET, P0, unitItem(WARRIOR))).toEqual({ kind: 'open' });
      expect(resourceGate(state, RULESET, P0, buildingItem)).toEqual({ kind: 'open' });
    }
  });

  it('blocks the gated unit while the road is missing, naming the resource', () => {
    const gate: ResourceGate = resourceGate(DISCONNECTED, RULESET, P0, unitItem(SWORDSMAN));
    expect(gate).toEqual({ kind: 'blocked', resource: IRON.id });
  });

  it('opens once the owner has the resource connected', () => {
    expect(resourceGate(CONNECTED, RULESET, P0, unitItem(SWORDSMAN))).toEqual({ kind: 'open' });
  });

  it('asks about the player’s whole network, not about the city next to the resource', () => {
    // The gate takes a player, not a city: M4c's connection is "some city of that
    // player", so a second city far from any road is still a city of a player who
    // has iron. `commands.test.ts` pins that this reaches `planSetProduction`.
    const twoCities = board({
      map: IRON_MAP,
      roads: [at(3, 1), at(2, 0)],
      cities: [city(0, 0, CENTRE), city(1, 0, at(0, 2))],
    });

    expect(resourceGate(twoCities, RULESET, P0, unitItem(SWORDSMAN))).toEqual({ kind: 'open' });
  });

  it('blocks for a barbarian owner even when the resource is right there', () => {
    const barbarianOwner = barbarianPlayer(0);
    const barbarianCity = board({
      map: IRON_MAP,
      roads: [at(3, 1), at(2, 0)],
      cities: [city(0, 0, CENTRE)],
      players: [barbarianOwner],
    });

    expect(resourceGate(barbarianCity, RULESET, P0, unitItem(SWORDSMAN))).toEqual({
      kind: 'blocked',
      resource: IRON.id,
    });
  });

  it('blocks a requirement naming a resource no row defines', () => {
    // `validateRuleset` rejects such a row outright (`packages/rules`), so this is
    // a state only a foreign or hand-built view can reach. The gate is total
    // anyway: the id is not connected, so the item is refused rather than assumed
    // buildable.
    const stranger: UnitDef = { ...SWORDSMAN, requiresResource: asResourceId('mithril') };
    const ruleset: RulesetView = { ...RULESET, units: [SETTLER, WARRIOR, stranger] };

    expect(resourceGate(CONNECTED, ruleset, P0, unitItem(stranger))).toEqual({
      kind: 'blocked',
      resource: asResourceId('mithril'),
    });
  });
});

/* ------------------------------------------------------------------ *
 * Bonus resources — terrain, on top of terrain and improvements
 * ------------------------------------------------------------------ */

describe('bonus resources add their yields to the tile', () => {
  /** A flat tile inside the plain board, with whatever the test puts on it. */
  const TILE = at(2, 4);

  const withTile = (
    resources: readonly TileResource[],
    other: readonly TileImprovement[] = [],
    roads: readonly number[] = [],
  ): GameState =>
    board({
      map: mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', resources),
      roads,
      other,
      cities: [city(0, 0, CENTRE)],
    });

  it('stacks wheat on top of grassland and an irrigation, and on top of nothing else', () => {
    const plain = withTile([{ tile: asTileIndex(TILE), resource: WHEAT.id }]);
    const irrigated = withTile(
      [{ tile: asTileIndex(TILE), resource: WHEAT.id }],
      [tileImprovement(TILE, IRRIGATION)],
    );
    const bare = withTile([]);

    // Grassland is 2 food / 1 shield / 1 commerce — the terrain half.
    expect(tileYields(bare, RULESET, asTileIndex(TILE))).toEqual({
      food: 2,
      shields: 1,
      commerce: 1,
    });
    // …plus the irrigation's +1 food, from the improvement half.
    expect(tileYields(irrigated, RULESET, asTileIndex(TILE))).toEqual({
      food: 3,
      shields: 1,
      commerce: 1,
    });
    // …plus the wheat's +2 food. Three rows, three contributions, one sum.
    expect(tileYieldsWithResources(irrigated, RULESET, asTileIndex(TILE))).toEqual({
      food: 5,
      shields: 1,
      commerce: 1,
    });
    // With no improvement, the wheat alone is added to the terrain.
    expect(tileYieldsWithResources(plain, RULESET, asTileIndex(TILE))).toEqual({
      food: 4,
      shields: 1,
      commerce: 1,
    });
  });

  it('adds the bonus with no road anywhere, because a bonus is not connected', () => {
    // "Bonus resources … are not gated or connected — they are just terrain": the
    // board below has no improvements at all, so nothing is connected, and the
    // wheat still feeds the tile.
    const state = withTile([{ tile: asTileIndex(TILE), resource: WHEAT.id }]);

    expect(state.improvements).toEqual([]);
    expect([...connected(state, RULESET, P0)]).toEqual([]);
    expect(bonusYieldsAt(state, RULESET, asTileIndex(TILE))).toEqual({
      food: 2,
      shields: 0,
      commerce: 0,
    });
  });

  it('adds nothing for a strategic or a luxury resource', () => {
    const iron = withTile([{ tile: asTileIndex(TILE), resource: IRON.id }]);
    const gems = withTile([{ tile: asTileIndex(TILE), resource: GEMS.id }]);

    for (const state of [iron, gems]) {
      expect(bonusYieldsAt(state, RULESET, asTileIndex(TILE))).toEqual({
        food: 0,
        shields: 0,
        commerce: 0,
      });
      // A strategic resource is a gate and a luxury is a count; neither is a
      // number on the ground, so the tile is worth exactly what it was.
      expect(tileYieldsWithResources(state, RULESET, asTileIndex(TILE))).toEqual({
        food: 2,
        shields: 1,
        commerce: 1,
      });
    }
  });

  it('does not read a luxury for happiness, because nothing in M4c does', () => {
    // The contract's warning, as an assertion: gems are placed, connected and
    // counted — and their only observable effect in M4c is that they appear in
    // `connected`. There is no happiness value anywhere in the engine for them to
    // move, and this test exists so that a future change which *did* read them
    // would have to come here and say so out loud.
    const gemMap = mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [pair(2, 4, GEMS)]);
    const state = board({
      map: gemMap,
      roads: [at(3, 3), at(3, 4)],
      cities: [city(0, 0, CENTRE)],
    });

    expect(isConnected(state, RULESET, P0, GEMS.id)).toBe(true); // counted
    expect(bonusYieldsAt(state, RULESET, asTileIndex(TILE))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });
    // Every player field is exactly the shape M4b left it in: M4c added no
    // contentment, so there is nothing on a player for a luxury to change.
    expect(Object.keys(state.players[0] ?? {})).toEqual([
      'id',
      'name',
      'color',
      'startingTile',
      'kind',
      'treasury',
      'rates',
      'beakers',
      'luxuries',
    ]);
  });

  it('adds a water bonus to a water tile', () => {
    const fishMap: GameMap = {
      width: MAIN_WIDTH,
      height: MAIN_HEIGHT,
      terrain: EMPTY_MAP.terrain.map((id, index) => (index === TILE ? asTerrainId('coast') : id)),
      huts: [],
      resources: [{ tile: asTileIndex(TILE), resource: FISH.id }],
    };
    const state = board({ map: fishMap, cities: [city(0, 0, CENTRE)] });

    // Coast is 1 food / 0 shields / 2 commerce; fish add 3 food.
    expect(tileYieldsWithResources(state, RULESET, asTileIndex(TILE))).toEqual({
      food: 4,
      shields: 0,
      commerce: 2,
    });
  });

  it('contributes nothing for a resource id no catalog row defines', () => {
    const unknown = withTile([{ tile: asTileIndex(TILE), resource: asResourceId('mithril') }]);

    expect(bonusYieldsAt(unknown, RULESET, asTileIndex(TILE))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });
  });

  it('sums two bonus rows on one tile, which only a hand-built map can produce', () => {
    const doubled = withTile([
      { tile: asTileIndex(TILE), resource: WHEAT.id },
      { tile: asTileIndex(TILE), resource: FISH.id },
    ]);

    expect(bonusYieldsAt(doubled, RULESET, asTileIndex(TILE))).toEqual({
      food: 5,
      shields: 0,
      commerce: 0,
    });
  });

  it('will not let a foreign negative delta push a component below zero', () => {
    // The shipped validator rejects a negative `yields` on any row, so this is
    // defence against an undescribed catalog rather than a resource rule — and it
    // mirrors the clamp `improvements.ts` applies to its own deltas, because a
    // negative yield would reach a hashed city output.
    const broken: ResourceDef = {
      ...WHEAT,
      id: asResourceId('blight'),
      yields: { food: -5, shields: -5, commerce: -5 },
    };
    const ruleset: RulesetView = { ...RULESET, resources: [...RESOURCES, broken] };
    const state = board({
      map: mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
        { tile: asTileIndex(TILE), resource: broken.id },
      ]),
      cities: [city(0, 0, CENTRE)],
    });

    expect(tileYieldsWithResources(state, ruleset, asTileIndex(TILE))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });
  });

  it('ignores a non-bonus row’s yields even when a foreign view carries some', () => {
    // A strategic row with `+4 food` is a row `checkResource` rejects (only a bonus
    // row yields). Read defensively, it still feeds nothing: a tile cannot be fed
    // by a resource whose whole meaning is a gate.
    const greedy: ResourceDef = { ...IRON, yields: { food: 4, shields: 0, commerce: 0 } };
    const ruleset: RulesetView = { ...RULESET, resources: [greedy, GEMS] };
    const state = board({
      map: mapOf(MAIN_WIDTH, MAIN_HEIGHT, 'grassland', [
        { tile: asTileIndex(TILE), resource: greedy.id },
      ]),
      cities: [city(0, 0, CENTRE)],
    });

    expect(bonusYieldsAt(state, ruleset, asTileIndex(TILE))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });
  });

  it('is undefined off the map, and adds nothing to an unimproved empty tile', () => {
    expect(tileYieldsWithResources(PLAIN, RULESET, asTileIndex(999))).toBeUndefined();
    expect(tileYieldsWithResources(PLAIN, RULESET, asTileIndex(TILE))).toEqual({
      food: 2,
      shields: 1,
      commerce: 1,
    });
  });
});
