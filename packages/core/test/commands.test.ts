/**
 * `applyCommand` — movement, the M3 city commands, the M4a worker commands, the
 * turn pipeline, purity and the turn advance (docs/INTERFACES.md M2, "Core —
 * commands, errors, legal actions"; M3, "Commands", "Growth", "Production",
 * "Turn pipeline"; M4a, "Workers", "Commands", "advanceTurn order").
 *
 * The board is hand-built rather than generated so every assertion reads as "on
 * this map, that command gives this answer": tile indices are `y * 4 + x`, and
 * the terrain costs, yields and blockers are visible at the top of the file.
 *
 * The fixture's `explored` rows are entirely `false` on purpose: M2 leaves fog
 * out of the legality rule, so every movement assertion below is also evidence
 * that legality does not consult what a player has seen.
 *
 * The M3 and M4a sections live here rather than in a
 * `growth.test.ts`/`production.test.ts`/`work.test.ts` of their own because this
 * test file is the one the workstream owns; they are sectioned by module, and
 * every number they assert is a **placeholder** rule of ours (the 10 + 5·(pop−1)
 * food box, the food-first auto-assignment, the shield carry-over, the worker turn
 * counts and where each improvement may be built) pinned so that an intentional
 * retune has to change a test on purpose. None of it is claimed to be Civ 3's, and
 * the Civ IV growth formula is explicitly asserted *against* (`foodBoxSize`).
 */

import { describe, expect, it } from 'vitest';
import { canonicalize, hashValue } from '@civts/testing';
// M6b: the battle sections below assert the odds `combat.ts` computes, and those odds are
// now a function of the **ruleset's** `combat` section rather than of a module constant —
// so this file states the section its battles are fought under (`M6_COMBAT`, below) and
// asks the engine's own reader for it. The fixture carries the shipped catalog's nine
// values, which is why every hand-computed expectation in this file still holds; a
// retune of the shipped table is felt here as a *failed odds assertion* rather than as a
// silently changed import.
import { combatRulesOf, type CombatDef } from '../src/combat.js';
import {
  MIN_CITY_DISTANCE,
  captureRulesOf,
  cityById,
  type BuildingDef,
  type CaptureDef,
  type City,
  type ProductionItem,
} from '../src/cities.js';
import {
  applyCommand,
  planAttackUnit,
  planCancelWork,
  planFortifyUnit,
  planFoundCity,
  planMove,
  planSetProduction,
  planSetResearch,
  planSetWorkedTiles,
  planStartWork,
  type Command,
  type CommandOutcome,
  type GameError,
  type GameEvent,
} from '../src/commands.js';
import { isExplored } from '../src/fog.js';
import { FOOD_BOX_BASE, FOOD_BOX_PER_CITIZEN, applyGrowth, foodBoxSize } from '../src/growth.js';
import { HUT_REWARD_KINDS } from '../src/hut.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type BuildingId,
  type PlayerId,
} from '../src/ids.js';
import {
  asImprovementId,
  hasImprovement,
  improvementsAt,
  withImprovement,
  type ImprovementDef,
  type ImprovementId,
} from '../src/improvements.js';
import type { GameMap, ResourceDef, RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { applyProduction, itemCost, itemCostOf } from '../src/production.js';
import { isOk, type Result } from '../src/result.js';
import { nextBelow, seedRng, type RngState } from '../src/rng.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
// M5's research *rule*, asked directly in the agreement sweep at the bottom of this
// file: the applier must accept exactly what `planSetResearch` accepts, and the
// surest way to check that is to ask the same question both ways.
import { researchProblem, researchingOf, type TechDef } from '../src/tech.js';
import { advanceTurn } from '../src/turn.js';
import {
  experienceOf,
  fullHitPoints,
  hitPointsLeftOf,
  isFortified,
  spawnUnit,
  unitById,
  withWork,
  withoutWork,
  type Unit,
  type UnitDef,
  type UnitRole,
  type UnitWork,
} from '../src/units.js';

/** Move cost per role; ocean/coast/mountains are impassable. */
const TERRAIN_ROWS: readonly (readonly [TerrainRole, number, boolean])[] = [
  ['ocean', 1, true],
  ['coast', 1, true],
  ['grassland', 1, false],
  ['plains', 1, false],
  ['hills', 2, false],
  ['mountains', 3, true],
];

/**
 * Yields per role. These are fixture numbers standing in for the content
 * package's placeholder rows: what matters here is that they *differ*, so a
 * worked-tile choice, an auto-assignment and a food surplus are all attributable
 * to a specific tile. Grassland is the food tile, hills the shield tile,
 * mountains the barren one (its 0 food still leaves a city centre's 1-food floor).
 */
const YIELDS_BY_ROLE: Readonly<
  Record<TerrainRole, { food: number; shields: number; commerce: number }>
> = {
  ocean: { food: 1, shields: 0, commerce: 2 },
  coast: { food: 1, shields: 0, commerce: 2 },
  grassland: { food: 2, shields: 1, commerce: 1 },
  plains: { food: 1, shields: 1, commerce: 1 },
  hills: { food: 1, shields: 2, commerce: 1 },
  mountains: { food: 0, shields: 1, commerce: 0 },
};

const TERRAINS: readonly TerrainDef[] = TERRAIN_ROWS.map(([role, moveCost, impassable]) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost,
  defenseBonusPct: 0,
  yields: YIELDS_BY_ROLE[role],
  impassable,
}));

/**
 * The board (row-major, width 4):
 *
 * ```text
 *   y=0  ocean      hills      mountains  coast       0  1  2  3
 *   y=1  grassland  grassland  grassland  plains      4  5  6  7
 *   y=2  grassland  hills      grassland  grassland   8  9 10 11
 *   y=3  coast      grassland  grassland  mountains  12 13 14 15
 * ```
 *
 * Unit 0 (player 0's settler) stands on 5, so its neighbours exercise every
 * movement refusal at once: 0 and 2 are impassable, 6 holds player 1's warrior, 1
 * and 9 are hills (cost 2), and 4, 8 and 10 are affordable grassland — 10 being
 * occupied by player 0's own scout.
 *
 * Tile 5 is also the M3 founding site: it is land, and the board has no city on
 * it, so `FoundCity` is legal there for player 0's settler. Tile 5's radius is
 * tiles 0..14 — every tile in the 5x5 box that exists on a 4x4 map except the
 * bottom-right box corner (15) — and among them the best tile by the placeholder
 * food-first ordering is 4 (grassland, the lowest-index 2-food tile), which is
 * what a founded city auto-assigns.
 */
const TERRAIN_GRID: readonly TerrainRole[] = [
  'ocean',
  'hills',
  'mountains',
  'coast',
  'grassland',
  'grassland',
  'grassland',
  'plains',
  'grassland',
  'hills',
  'grassland',
  'grassland',
  'coast',
  'grassland',
  'grassland',
  'mountains',
];

const MAP: GameMap = {
  width: 4,
  height: 4,
  terrain: TERRAIN_GRID.map((role) => asTerrainId(role)),
  // M3: the map carries its goody huts; this fixture has none, so no move below
  // can be affected by one (hut rewards are another workstream's).
  huts: [],
  // M4c: the map also carries its resources, as sparse `(tile, resource)` pairs.
  // This shared fixture holds none — the resource-gate section below is where a
  // board gains an iron — so no earlier assertion on this board changes meaning.
  resources: [],
};

const makeDef = (id: string, role: UnitRole, movement: number, cost: number): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 1,
  defense: 1,
  movement,
  cost,
  domain: 'land',
});

const SETTLER = makeDef('settler', 'settler', 2, 3);
const SCOUT = makeDef('scout', 'scout', 3, 2);
const WARRIOR = makeDef('warrior', 'military', 2, 2);
/** Movement 1: enough to start a job or take one step, never both. */
const WORKER = makeDef('worker', 'worker', 1, 2);

/** The three resource ids this fixture's catalog defines, named once. */
const IRON = asResourceId('iron');
const GEMS = asResourceId('gems');
const WHEAT = asResourceId('wheat');

/**
 * M4c's gated row: the one unit type in this fixture that declares
 * `requiresResource`, appended **after** the warrior so anything that takes "the
 * first `military` land unit in catalog order" (hut rewards, `hut.ts`) still gets
 * the warrior. Its requirement is the whole subject of the gate section below.
 */
const SWORDSMAN: UnitDef = { ...makeDef('swordsman', 'military', 1, 3), requiresResource: IRON };

/**
 * The resource catalog, one row per kind, as **placeholder** rows of ours: iron
 * is what a unit row may demand, gems are placed and counted and read by nothing
 * (M4c: "no happiness effect until M9"), and wheat adds `+2 food` to its tile.
 */
const RESOURCES: readonly ResourceDef[] = [
  {
    id: IRON,
    name: 'Iron',
    kind: 'strategic',
    yields: { food: 0, shields: 0, commerce: 0 },
    allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
  },
  {
    id: GEMS,
    name: 'Gems',
    kind: 'luxury',
    yields: { food: 0, shields: 0, commerce: 0 },
    allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
  },
  {
    id: WHEAT,
    name: 'Wheat',
    kind: 'bonus',
    yields: { food: 2, shields: 0, commerce: 0 },
    allowedRoles: ['grassland', 'plains'],
  },
];

/** Building costs (shields), as placeholder rows of ours. */
const GRANARY_COST = 10;
const LIBRARY_COST = 20;

/**
 * Building rows, with M4c's three fields spelled out: `maintenance` **0** ("free to
 * keep" — the money-loop assertions in this file are measured against M4b's
 * unit-support formula and must not move) and `effects: []` ("costs shields and
 * nothing else"). Both are legal rows; upkeep-declaring and effect-declaring
 * buildings are pinned in the files that own those systems.
 */
const BUILDINGS: readonly BuildingDef[] = [
  { id: asBuildingId('granary'), name: 'Granary', cost: GRANARY_COST, maintenance: 0, effects: [] },
  { id: asBuildingId('library'), name: 'Library', cost: LIBRARY_COST, maintenance: 0, effects: [] },
];

/**
 * Tile improvements, as **placeholder** rows of ours (M4a, "Rules — improvement
 * catalog"): every `turns` count here is a fixture number chosen to make a job's
 * progress observable in three turns, and the `yields` deltas are single +1s so
 * that a change in a city's output is attributable to exactly one completed
 * improvement. None of these numbers is Civ 3's, and the `allowedRoles` lists are
 * our reading of which terrain suits which improvement (a mine needs rock,
 * irrigation needs flat land), not a sourced rule.
 *
 * Catalog order (`road`, `mine`, `irrigation`) matches the shipped content
 * package's, because a generator enumerates the catalog in order and the tests
 * below assert the resulting command order.
 */
const ROAD_TURNS = 2;
const MINE_TURNS = 3;
const IRRIGATION_TURNS = 2;

const ROAD: ImprovementDef = {
  id: asImprovementId('road'),
  kind: 'road',
  name: 'Road',
  turns: ROAD_TURNS,
  yields: { food: 0, shields: 0, commerce: 1 },
  allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
};
const MINE: ImprovementDef = {
  id: asImprovementId('mine'),
  kind: 'mine',
  name: 'Mine',
  turns: MINE_TURNS,
  yields: { food: 0, shields: 1, commerce: 0 },
  allowedRoles: ['hills', 'mountains'],
};
const IRRIGATION: ImprovementDef = {
  id: asImprovementId('irrigation'),
  kind: 'irrigation',
  name: 'Irrigation',
  turns: IRRIGATION_TURNS,
  yields: { food: 1, shields: 0, commerce: 0 },
  allowedRoles: ['grassland', 'plains'],
};

const IMPROVEMENTS: readonly ImprovementDef[] = [ROAD, MINE, IRRIGATION];

/**
 * Four rows of a tech tree, enough for every `SetResearch` answer: two roots
 * (`pottery`, `bronze-working`), a second tier (`masonry`, behind `bronze-working`)
 * and a join (`literature`, needing both `pottery` and `masonry`, so its refusal
 * lists *two* missing prerequisites and the answer is not a single-string special
 * case).
 *
 * The costs are distinct and the catalog order is not the id order, so an assertion
 * that mixes two rows up fails instead of passing by coincidence.
 */
const POTTERY: TechDef = {
  id: asTechId('pottery'),
  name: 'Pottery',
  era: 'ancient',
  cost: 5,
  requires: [],
};

const BRONZE_WORKING: TechDef = {
  id: asTechId('bronze-working'),
  name: 'Bronze Working',
  era: 'ancient',
  cost: 6,
  requires: [],
};

const MASONRY: TechDef = {
  id: asTechId('masonry'),
  name: 'Masonry',
  era: 'ancient',
  cost: 9,
  requires: [asTechId('bronze-working')],
};

const LITERATURE: TechDef = {
  id: asTechId('literature'),
  name: 'Literature',
  era: 'medieval',
  cost: 15,
  requires: [asTechId('pottery'), asTechId('masonry')],
};

const TECHS: readonly TechDef[] = [POTTERY, BRONZE_WORKING, MASONRY, LITERATURE];

/**
 * The engine's view of a ruleset: terrain, a unit catalog, buildings, improvements,
 * a resource catalog (M4c) and — M5 — a tech tree. `SWORDSMAN` is the one gated row
 * and is **appended**, so catalog order for everything before it is unchanged.
 *
 * `RulesetView` does not declare `techs` (M5's gating workstream owns that field and
 * `map.ts` is not this workstream's file), so the tree arrives as a local extension
 * of the view — the shape the field will take when it is declared, and the shape
 * `tech.ts` reads structurally.
 */
interface TechView extends RulesetView {
  readonly techs: readonly TechDef[];
}

const RULESET: TechView = {
  terrains: TERRAINS,
  units: [SETTLER, SCOUT, WARRIOR, WORKER, SWORDSMAN],
  buildings: BUILDINGS,
  improvements: IMPROVEMENTS,
  resources: RESOURCES,
  techs: TECHS,
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (
  index: number,
  startingTile: number,
  kind: 'civ' | 'barbarian' = 'civ',
): PlayerState => ({
  id: asPlayerId(index),
  name: kind === 'barbarian' ? 'Barbarians' : `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(startingTile),
  kind,
  // M4b: every fixture spells its money fields out, like every other field. These
  // are the values `newGame` uses; a board that cares about income, upkeep or a
  // shortfall overrides them where it is built (see the economy sections below).
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: a fixture player knows no techs. `techs` is required and `[]` is how the
  // state says "knows nothing"; `researching` is **absent** on purpose, which is the
  // only way this state spells "not researching anything" (see `PlayerState`). The
  // M5 sections below set both where they care.
  techs: [],
});

const unit = (
  id: number,
  type: UnitDef,
  owner: number,
  tile: number,
  movementLeft: number,
): Unit => ({
  id: asUnitId(id),
  type: type.id,
  owner: asPlayerId(owner),
  tile: asTileIndex(tile),
  movementLeft,
});

/**
 * The same unit as `unit()`, plus the M6 field `spawnUnit` writes: a unit that enters
 * play is at full health, which for a fixture row that declares no `hitPoints` is one
 * point (`fullHitPoints`). Spelled as a helper because three different tests assert what
 * a spawn produced, and all three have to agree with `units.ts` about it.
 */
const freshUnit = (
  id: number,
  type: UnitDef,
  owner: number,
  tile: number,
  movementLeft: number,
): Unit => ({
  ...unit(id, type, owner, tile, movementLeft),
  hitPointsLeft: fullHitPoints(type),
});

/** A city with M3's shape and playable defaults; every field is spelled out. */
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

/** Nothing explored anywhere: legality must not care (see the file header). */
const UNSEEN: readonly boolean[] = Array.from({ length: 16 }, () => false);

/** Player 0's settler on 5 (movement 2), its scout on 10 (spent), player 1's warrior on 6 (spent). */
const STATE: GameState = {
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0, 5), player(1, 6)],
  nextUnitId: 3,
  units: [
    unit(0, SETTLER, 0, 5, SETTLER.movement),
    unit(1, SCOUT, 0, 10, 0),
    unit(2, WARRIOR, 1, 6, 0),
  ],
  explored: [UNSEEN, UNSEEN],
  nextCityId: 0,
  cities: [],
  improvements: [],
};

/**
 * `state` with `cities`, and `nextCityId` past the highest id present — the
 * invariant `FoundCity` maintains, so a fixture cannot accidentally ask the
 * engine to reuse a city id.
 */
const withCities = (state: GameState, cities: readonly City[]): GameState => ({
  ...state,
  cities: [...cities],
  nextCityId: cities.reduce((next, existing) => Math.max(next, Number(existing.id) + 1), 0),
});

/**
 * A city of player 0 on tile 13 ((1,3), grassland), population 2, working tile 4.
 *
 * Its radius is tiles {4,5,6,8,9,10,11,12,13,14,15}: three rows of the 5x5 box
 * that fit on a 4x4 map, minus the box corner 7. Tile 3 and everything on row 0
 * are *outside* it, which is what the "not workable" refusals are measured
 * against. Working tile 4 (grassland) plus the centre gives 4 food and 2 shields
 * a turn — a surplus of 2 for one citizen, and of 0 for two.
 */
const CITY = city(0, 0, 13, { population: 2, workedTiles: [asTileIndex(4)] });

/** The same board, with player 0's city on it. */
const CITY_STATE: GameState = withCities(STATE, [CITY]);

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);

/**
 * The money events (M4b) the pipeline emits for one civilization, with the amounts
 * spelled out: income as `[gold, beakers, luxuries]` and upkeep as
 * `[gold, maintenance, unitSupport, units, freeUnits]`.
 *
 * Every civilization gets both events every turn, zeros included, in player-id
 * order — that is what makes a turn's event list a ledger a consumer can rebuild a
 * treasury from (`economy.ts`), and it is why the tests below name a second
 * player's pair rather than asserting "and nothing else".
 */
const ledger = (
  index: number,
  income: readonly [number, number, number],
  upkeep: readonly [number, number, number, number, number],
): readonly GameEvent[] => [
  {
    type: 'IncomeCollected',
    playerId: asPlayerId(index),
    gold: income[0],
    beakers: income[1],
    luxuries: income[2],
  },
  {
    type: 'UpkeepPaid',
    playerId: asPlayerId(index),
    gold: upkeep[0],
    maintenance: upkeep[1],
    unitSupport: upkeep[2],
    units: upkeep[3],
    freeUnits: upkeep[4],
  },
];

/** A civilization that collected nothing and owed nothing, with `units` units. */
const idleLedger = (index: number, units: number): readonly GameEvent[] =>
  ledger(index, [0, 0, 0], [0, 0, 0, units, 4]);

const move = (unitId: number, to: number): Command => ({
  type: 'MoveUnit',
  unitId: asUnitId(unitId),
  to: asTileIndex(to),
});

const foundCity = (unitId: number): Command => ({ type: 'FoundCity', unitId: asUnitId(unitId) });

const setWorkedTiles = (cityId: number, tiles: readonly number[]): Command => ({
  type: 'SetWorkedTiles',
  cityId: asCityId(cityId),
  tiles: tiles.map((tile) => asTileIndex(tile)),
});

const setProduction = (cityId: number, item: ProductionItem): Command => ({
  type: 'SetProduction',
  cityId: asCityId(cityId),
  item,
});

const unitItem = (id: string): ProductionItem => ({ kind: 'unit', id: asUnitTypeId(id) });
const buildingItem = (id: string): ProductionItem => ({ kind: 'building', id: asBuildingId(id) });

const setRates = (tax: number, science: number, luxury: number): Command => ({
  type: 'SetRates',
  rates: { tax, science, luxury },
});

const END_TURN: Command = { type: 'EndTurn' };

/** `applyCommand` with the ruleset the engine is evaluated against by default. */
const apply = (
  state: GameState,
  playerId: PlayerId,
  cmd: Command,
  ruleset: RulesetView = RULESET,
): Result<CommandOutcome, GameError> => applyCommand(state, playerId, cmd, ruleset);

const mustOk = (result: Result<CommandOutcome, GameError>): CommandOutcome => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const errorOf = <T>(result: Result<T, GameError>): GameError => {
  if (result.ok) throw new Error('expected the command to be refused');
  return result.error;
};

const refusedAs = <T>(result: Result<T, GameError>, kind: GameError['kind']): GameError => {
  const error = errorOf(result);
  expect(error.kind).toBe(kind);
  return error;
};

/** The detail of an `invalid-argument` refusal, with the kind asserted first. */
const detailOf = <T>(result: Result<T, GameError>): string => {
  const error = refusedAs(result, 'invalid-argument');
  if (error.kind !== 'invalid-argument') throw new Error('unreachable');
  return error.detail;
};

/** A player that must be there: a fixture that lacks it is a broken test, not a case. */
const playerOf = (state: GameState, index: number): PlayerState => {
  const found = state.players.find((each) => each.id === asPlayerId(index));
  if (found === undefined) throw new Error(`the fixture has no player ${String(index)}`);
  return found;
};

const withMovement = (state: GameState, unitId: number, movementLeft: number): GameState => ({
  ...state,
  units: state.units.map((u) => (u.id === asUnitId(unitId) ? { ...u, movementLeft } : u)),
});

const movementLeftOf = (state: GameState, unitId: number): number | undefined =>
  state.units.find((u) => u.id === asUnitId(unitId))?.movementLeft;

const tileOf = (state: GameState, unitId: number): number | undefined => {
  const found = state.units.find((u) => u.id === asUnitId(unitId));
  return found === undefined ? undefined : Number(found.tile);
};

/** The city `id`, with the id asserted first so a missing city reads clearly. */
const cityOf = (state: GameState, id: number): City => {
  const found = cityById(state, asCityId(id));
  if (found === undefined) throw new Error(`no city ${String(id)} in state`);
  return found;
};

/** Ascending tile indices a row has marked explored. */
const exploredIndices = (row: readonly boolean[] | undefined): number[] =>
  row === undefined ? [] : row.map((isSeen, index) => (isSeen ? index : -1)).filter((i) => i >= 0);

/** An explored row of this 4x4 board with `tiles` marked. */
const markedExplored = (tiles: readonly number[]): readonly boolean[] =>
  Array.from({ length: 16 }, (_, index) => tiles.includes(index));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Freeze a state graph so any mutation throws (ESM is strict mode). */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/* ------------------------------------------------------------------ *
 * M4a — the worker fixture
 * ------------------------------------------------------------------ */

const startWork = (unitId: number, kind: string): Command => ({
  type: 'StartWork',
  unitId: asUnitId(unitId),
  kind: asImprovementId(kind),
});

const cancelWork = (unitId: number): Command => ({ type: 'CancelWork', unitId: asUnitId(unitId) });

/** The job `unitId` is doing, or `undefined` — never a key that is present and empty. */
const workOf = (state: GameState, unitId: number): UnitWork | undefined =>
  state.units.find((u) => u.id === asUnitId(unitId))?.work;

/** `state` with `units`, keeping `nextUnitId` past the highest id present. */
const withUnits = (state: GameState, units: readonly Unit[]): GameState => ({
  ...state,
  units: [...units].sort((a, b) => Number(a.id) - Number(b.id)),
  nextUnitId: units.reduce((next, existing) => Math.max(next, Number(existing.id) + 1), 0),
});

/**
 * Player 0's worker, standing on tile 1 (hills) at full movement.
 *
 * Tile 1 is the interesting tile: a `mine` and a `road` are allowed there, an
 * `irrigation` is not (irrigation is flat-land work), and its neighbours are 0
 * (ocean, impassable), 2 (mountains, impassable), 4 (grassland, cost 1), 5
 * (grassland, cost 1 — and player 0's settler stands there, which is legal to
 * stack on), 6 (grassland, held by player 1's warrior, so not enterable). So the
 * worker offers exactly two jobs and two steps, which is small enough to assert
 * action by action.
 */
const WORKER_TILE = 1;
const worker = (movementLeft: number): Unit => unit(3, WORKER, 0, WORKER_TILE, movementLeft);

/** `STATE` plus player 0's worker on the hills — the board every M4a test starts from. */
const WORK_STATE: GameState = withUnits(STATE, [...STATE.units, worker(WORKER.movement)]);

/** The same board with player 0's city on 13, so a mine's effect on yields is visible. */
const WORK_CITY_STATE: GameState = withCities(WORK_STATE, [CITY]);

/** A job, in the shape the engine stores: `turnsLeft` is the count still owed. */
const mineWork = (turnsLeft: number): UnitWork => ({
  kind: MINE.id,
  tile: asTileIndex(WORKER_TILE),
  turnsLeft,
});

/** `state` with the worker (unit 3) already working on its own tile. */
const digging = (state: GameState, work: UnitWork): GameState => ({
  ...state,
  units: state.units.map((u) => (u.id === asUnitId(3) ? withWork(u, work) : u)),
});

describe('applyCommand — MoveUnit', () => {
  it('moves a unit one step onto adjacent grassland and pays its cost', () => {
    const outcome = mustOk(apply(STATE, P0, move(0, 4)));

    expect(tileOf(outcome.state, 0)).toBe(4);
    expect(movementLeftOf(outcome.state, 0)).toBe(SETTLER.movement - 1);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    expect(outcome.state.turn).toBe(STATE.turn);
    expect(outcome.events).toEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: asTileIndex(5),
        to: asTileIndex(4),
        cost: 1,
        movementLeft: 1,
      },
    ]);
  });

  it("pays the destination tile's cost, not the origin's", () => {
    // Origin (5) and destination (1) differ by design: grassland costs 1, hills 2.
    const outcome = mustOk(apply(STATE, P0, move(0, 1)));

    expect(tileOf(outcome.state, 0)).toBe(1);
    expect(movementLeftOf(outcome.state, 0)).toBe(0);
    expect(outcome.events[0]).toMatchObject({ cost: 2, movementLeft: 0 });
  });

  it('touches nothing but the mover, the revision and the explored layer', () => {
    const outcome = mustOk(apply(STATE, P0, move(0, 4)));

    expect(outcome.state.map).toBe(STATE.map);
    expect(outcome.state.players).toBe(STATE.players);
    expect(outcome.state.settings).toBe(STATE.settings);
    expect(outcome.state.rng).toBe(STATE.rng);
    expect(outcome.state.seed).toBe(STATE.seed);
    expect(outcome.state.nextUnitId).toBe(STATE.nextUnitId);
    expect(outcome.state.units).not.toBe(STATE.units);
    expect(outcome.state.units.slice(1)).toEqual(STATE.units.slice(1));
  });

  it("folds what the mover can now see into its explored row, and nobody else's", () => {
    // One unit on the board, so the folded sight is exactly the mover's own.
    const solo: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 5, 2)] };
    const outcome = mustOk(apply(solo, P0, move(0, 4)));

    // Tile 4 is (0, 1): the radius-2 box covers x in {0, 1, 2} (x = -2 and -1 are
    // off the board) and every y, i.e. these twelve tiles.
    expect(exploredIndices(outcome.state.explored[0])).toEqual([
      0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14,
    ]);
    expect(outcome.state.explored[1]).toBe(UNSEEN);
    // The input's rows are untouched: explored is folded into the new state only.
    expect(solo.explored[0]?.some(Boolean)).toBe(false);
    // Visibility is derived from every unit the player owns, so the scout's
    // sight (radius 2 around tile 10, i.e. the whole 4x4 board) joins memory too.
    expect(exploredIndices(mustOk(apply(STATE, P0, move(0, 4))).state.explored[0])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('makes the destination visible to the mover, seen through fog.isExplored', () => {
    const solo: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 5, 2)] };
    expect(isExplored(solo, P0, asTileIndex(4))).toBe(false);

    const outcome = mustOk(apply(solo, P0, move(0, 4)));

    expect(isExplored(outcome.state, P0, asTileIndex(4))).toBe(true);
    expect(isExplored(outcome.state, P0, asTileIndex(15))).toBe(false);
    // Fog is per player: nothing the mover did is known to anyone else.
    expect(isExplored(outcome.state, P1, asTileIndex(4))).toBe(false);
  });

  it('never un-explores a tile: memory only grows', () => {
    const remembered: GameState = { ...STATE, explored: [markedExplored([15]), UNSEEN] };
    const outcome = mustOk(apply(remembered, P0, move(0, 8)));

    const row = outcome.state.explored[0];
    expect(row?.[15]).toBe(true); // the corner the settler walked away from
    expect(row?.[8]).toBe(true); // where it now stands
    expect(outcome.state.explored[1]).toBe(UNSEEN); // the other player saw nothing
  });

  it("allows stepping onto a tile held by the same player's units (Civ 3 stacks)", () => {
    const outcome = mustOk(apply(STATE, P0, move(0, 10)));

    expect(tileOf(outcome.state, 0)).toBe(10);
    expect(outcome.state.units.filter((u) => u.tile === asTileIndex(10))).toHaveLength(2);
  });
});

describe('applyCommand — refusals', () => {
  it('refuses an impassable destination', () => {
    expect(refusedAs(apply(STATE, P0, move(0, 2)), 'impassable')).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: asTileIndex(2),
    });
    expect(refusedAs(apply(STATE, P0, move(0, 0)), 'impassable')).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: asTileIndex(0),
    });
  });

  it('refuses an unaffordable destination, reporting what is needed and available', () => {
    const poor = withMovement(STATE, 0, 1);
    expect(refusedAs(apply(poor, P0, move(0, 1)), 'not-enough-movement')).toEqual({
      kind: 'not-enough-movement',
      unitId: asUnitId(0),
      needed: 2,
      available: 1,
    });
    // A unit that has spent everything cannot enter even a cost-1 tile.
    expect(refusedAs(apply(STATE, P0, move(1, 13)), 'not-enough-movement')).toEqual({
      kind: 'not-enough-movement',
      unitId: asUnitId(1),
      needed: 1,
      available: 0,
    });
  });

  it('refuses a tile held by another player, without resolving combat', () => {
    expect(refusedAs(apply(STATE, P0, move(0, 6)), 'occupied-by-enemy')).toEqual({
      kind: 'occupied-by-enemy',
      unitId: asUnitId(0),
      to: asTileIndex(6),
    });
    // The blocker is a wall, not a target: nothing about it changes, and M2
    // never half-implements an attack (combat is M6).
    expect(tileOf(STATE, 2)).toBe(6);
    expect(movementLeftOf(STATE, 2)).toBe(0);
  });

  it('refuses a unit id that does not exist', () => {
    expect(refusedAs(apply(STATE, P0, move(99, 4)), 'unknown-unit')).toEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(99),
    });
  });

  it('refuses a player id that does not exist', () => {
    const ghost = asPlayerId(7);
    expect(refusedAs(apply(STATE, ghost, move(0, 4)), 'unknown-player')).toEqual({
      kind: 'unknown-player',
      playerId: ghost,
    });
    expect(refusedAs(apply(STATE, ghost, END_TURN), 'unknown-player')).toEqual({
      kind: 'unknown-player',
      playerId: ghost,
    });
  });

  it("refuses another player's unit rather than applying it quietly", () => {
    expect(refusedAs(apply(STATE, P1, move(0, 4)), 'not-your-unit')).toEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(0),
      owner: P0,
    });
    expect(tileOf(STATE, 0)).toBe(5);
  });

  it('refuses a destination off the map', () => {
    expect(refusedAs(apply(STATE, P0, move(0, 16)), 'out-of-bounds')).toEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(16),
    });
    expect(refusedAs(apply(STATE, P0, move(0, -1)), 'out-of-bounds')).toEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(-1),
    });
  });

  it('refuses a non-adjacent destination instead of finding a path (M2 is single-step)', () => {
    // Tile 15 is two tiles away from 5: reachable only by chaining steps, and
    // the refusal must say so rather than silently expanding a path.
    expect(detailOf(apply(STATE, P0, move(0, 15)))).toContain('adjacent');
    expect(tileOf(STATE, 0)).toBe(5);
  });

  it('refuses a destination that is not a tile at all', () => {
    expect(detailOf(apply(STATE, P0, move(0, 5)))).toContain('adjacent'); // staying put
    expect(detailOf(apply(STATE, P0, move(0, 1.5)))).toContain('integer');
    expect(detailOf(apply(STATE, P0, move(0, Number.NaN)))).toContain('integer');
  });
});

describe('applyCommand — the RulesetView argument is required', () => {
  /**
   * The amended contract (INTERFACES.md M2, "Amendment (post-review, binding)"):
   * `applyCommand` takes its ruleset as a **required** fourth parameter.
   *
   * This is the whole point of the amendment, so the assertion is a *type* one.
   * The directive below suppresses a real error — a four-parameter function is
   * not callable as a three-argument one — and if that parameter ever became
   * optional again, the directive would suppress nothing and `pnpm typecheck`
   * would fail with "Unused '@ts-expect-error' directive". An optional parameter
   * that refuses at runtime is the trap: the typechecker cannot catch it and
   * every command silently fails.
   */
  // @ts-expect-error applyCommand requires the ruleset as its fourth argument
  const applyWithThreeArguments: (state: GameState, playerId: PlayerId, cmd: Command) => unknown =
    applyCommand;

  it('is enforced by the compiler, not by a runtime refusal', () => {
    // The old implementation shipped a `missing-ruleset` refusal path that could
    // only ever fire on a call the compiler now rejects outright. Nothing about
    // the arity is left to runtime: `applyCommand` is the same function, and the
    // three-argument spelling above does not typecheck.
    expect(typeof applyWithThreeArguments).toBe('function');
    expect(applyCommand.length).toBe(4);
  });
});

describe('applyCommand — purity and revision', () => {
  it('never mutates a deeply frozen state and bumps revision exactly once', () => {
    const snapshot = structuredClone(STATE);
    deepFreeze(STATE);

    for (const cmd of [move(0, 4), move(0, 1), END_TURN]) {
      const outcome = mustOk(apply(STATE, P0, cmd));
      expect(outcome.state).not.toBe(STATE);
      expect(outcome.state.revision).toBe(STATE.revision + 1);
    }

    expect(STATE).toEqual(snapshot);
  });

  it('increases revision by one per applied command', () => {
    const first = mustOk(apply(STATE, P0, move(0, 4)));
    const second = mustOk(apply(first.state, P0, move(0, 8)));

    expect(STATE.revision).toBe(0);
    expect(first.state.revision).toBe(1);
    expect(second.state.revision).toBe(2);
  });

  it('leaves the state untouched when a command is refused', () => {
    const snapshot = structuredClone(STATE);
    deepFreeze(STATE);

    const refusals: readonly Command[] = [
      move(99, 4),
      move(2, 4),
      move(0, 2),
      move(0, 16),
      move(0, 15),
      move(0, 1.5),
      move(0, 6),
    ];
    for (const cmd of refusals) {
      expect(apply(STATE, P0, cmd).ok).toBe(false);
      expect(STATE.revision).toBe(0);
      expect(STATE).toEqual(snapshot);
    }

    expect(apply(STATE, asPlayerId(7), END_TURN).ok).toBe(false);
    expect(STATE.turn).toBe(1);
    expect(STATE).toEqual(snapshot);
  });
});

describe('applyCommand — EndTurn', () => {
  it("refills every unit to its type's movement and advances the turn", () => {
    const outcome = mustOk(apply(STATE, P0, END_TURN));

    expect(outcome.state.turn).toBe(STATE.turn + 1);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    expect(movementLeftOf(outcome.state, 0)).toBe(SETTLER.movement);
    expect(movementLeftOf(outcome.state, 1)).toBe(SCOUT.movement);
    expect(movementLeftOf(outcome.state, 2)).toBe(WARRIOR.movement);
    expect(outcome.events).toEqual([
      // Two units of player 0's and one of player 1's, all inside the free
      // allowance, and no cities: the ledger is two pairs of zeros. It is emitted
      // anyway, for the reason the helper above gives.
      ...ledger(0, [0, 0, 0], [0, 0, 0, 2, 4]),
      ...ledger(1, [0, 0, 0], [0, 0, 0, 1, 4]),
      { type: 'TurnEnded', playerId: P0, turn: 2 },
    ]);
  });

  it('restores movement that a move spent, keeping the unit where it stands', () => {
    const moved = mustOk(apply(STATE, P0, move(0, 1))).state;
    expect(movementLeftOf(moved, 0)).toBe(0);

    const next = mustOk(apply(moved, P0, END_TURN)).state;
    expect(movementLeftOf(next, 0)).toBe(SETTLER.movement);
    expect(tileOf(next, 0)).toBe(1);
  });

  it('is total: a unit type the ruleset does not define does not block the turn', () => {
    // A hand-built state (or a save, or a foreign view) can hold a unit type no
    // ruleset defines. There is no honest movement budget to guess for it, and
    // refusing the whole turn would contradict `legalActions`, which yields
    // `EndTurn` for every real player — so the unit is carried over untouched and
    // the turn still advances.
    const ghost = { ...SETTLER, id: asUnitTypeId('ghost') };
    const withGhost: GameState = {
      ...STATE,
      nextUnitId: 2,
      units: [unit(0, ghost, 0, 5, 0), unit(1, SCOUT, 0, 10, 1)],
    };

    const outcome = mustOk(apply(withGhost, P0, END_TURN));

    expect(outcome.state.turn).toBe(withGhost.turn + 1);
    expect(outcome.state.revision).toBe(withGhost.revision + 1);
    expect(movementLeftOf(outcome.state, 0)).toBe(0); // unresolvable: left alone
    expect(tileOf(outcome.state, 0)).toBe(5);
    expect(movementLeftOf(outcome.state, 1)).toBe(SCOUT.movement); // resolvable: refilled
    // The ghost is *counted* by the money loop — it is a unit its owner has, and
    // support is about the unit, not about a catalog row it might not match (the
    // refill's totality and this count are the same idea applied twice).
    expect(outcome.events).toEqual([
      ...idleLedger(0, 2),
      ...idleLedger(1, 0),
      { type: 'TurnEnded', playerId: P0, turn: 2 },
    ]);
    // Nothing was mutated in place: the input keeps its spent movement.
    expect(movementLeftOf(withGhost, 1)).toBe(1);
  });

  it('refills a resolvable unit even when an unresolvable one is present', () => {
    const ghost = { ...SCOUT, id: asUnitTypeId('ghost') };
    const withGhost: GameState = {
      ...STATE,
      units: [...STATE.units, unit(3, ghost, 1, 10, 0)],
      nextUnitId: 4,
    };

    const outcome = mustOk(apply(withGhost, P1, END_TURN));

    expect(outcome.state.units.map((u) => u.movementLeft)).toEqual([
      SETTLER.movement,
      SCOUT.movement,
      WARRIOR.movement,
      0, // the ghost keeps what it had
    ]);
  });

  it('is not blocked by fog: an unlit board still ends its turn', () => {
    const outcome = mustOk(apply(STATE, P0, END_TURN));
    expect(outcome.state.explored[0]?.some(Boolean)).toBe(false);
    expect(outcome.state.turn).toBe(2);
  });
});

describe('planMove', () => {
  it('reports the unit and the cost of a legal step', () => {
    const plan = planMove(STATE, RULESET, P0, asUnitId(0), asTileIndex(1));
    expect(isOk(plan)).toBe(true);
    if (!plan.ok) throw new Error('unreachable');

    expect(plan.value.cost).toBe(2);
    expect(plan.value.unit.id).toBe(asUnitId(0));
    expect(plan.value.to).toBe(asTileIndex(1));
    // The doc's four-argument form names the cost and the movement left over.
    expect(plan.value.movementLeft).toBe(SETTLER.movement - 2);
  });

  it('publishes the documented four-argument form, acting as the unit owner', () => {
    // `planMove(state, ruleset, unitId, to)` — INTERFACES.md M2's signature. The
    // acting player is the unit's owner, so it agrees with the explicit-actor
    // form the engine uses internally, and it is the same evaluator either way.
    const documented = planMove(STATE, RULESET, asUnitId(0), asTileIndex(1));
    const explicit = planMove(STATE, RULESET, P0, asUnitId(0), asTileIndex(1));

    expect(documented).toEqual(explicit);
    expect(documented.ok).toBe(true);

    // An unknown unit is a refusal, not a crash, whichever form asks.
    expect(errorOf(planMove(STATE, RULESET, asUnitId(99), asTileIndex(1)))).toEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(99),
    });
    // A unit whose owner is not a player in the state has no acting player, so
    // the documented form refuses exactly as the command layer would.
    const orphaned: GameState = { ...STATE, players: [player(1, 6)] };
    expect(errorOf(planMove(orphaned, RULESET, asUnitId(0), asTileIndex(1)))).toEqual({
      kind: 'unknown-player',
      playerId: P0,
    });
  });

  it('refuses with the same reasons applyCommand refuses with', () => {
    expect(errorOf(planMove(STATE, RULESET, P0, asUnitId(0), asTileIndex(2)))).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: asTileIndex(2),
    });
    expect(errorOf(planMove(STATE, RULESET, P1, asUnitId(0), asTileIndex(2)))).toEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(0),
      owner: P0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * M3 — FoundCity
 * ------------------------------------------------------------------ */

describe('applyCommand — FoundCity', () => {
  it('founds a city at the settler, consumes it, and auto-assigns the best radius tile', () => {
    const outcome = mustOk(apply(STATE, P0, foundCity(0)));

    expect(outcome.state.cities).toStrictEqual([
      {
        id: asCityId(0),
        owner: P0,
        name: 'City 1',
        tile: asTileIndex(5),
        population: 1,
        foodBox: 0,
        shields: 0,
        // No `production` key at all: a freshly founded city is building nothing,
        // and "nothing" is spelled by *omitting* the optional `City.production`,
        // never by `production: undefined`. `undefined` is not representable in
        // canonical JSON, so that spelling made `hashValue` throw on the city this
        // command had just founded. `toStrictEqual` does not treat the two
        // spellings as equal, so the key is simply absent here; the two facts that
        // matter are then asserted directly below.
        queue: [],
        buildings: [],
        // The centre (5) is worked for free and is *not* in this list; 4 is the
        // best tile the placeholder food-first ordering offers (grassland, and the
        // lowest-index 2-food tile in 5's radius).
        workedTiles: [asTileIndex(4)],
      },
    ]);

    const founded = outcome.state.cities[0];
    expect(founded).toBeDefined();
    expect(Object.hasOwn(founded ?? {}, 'production')).toBe(false);
    expect(() => hashValue(outcome.state)).not.toThrow();

    // The settler is consumed — that is what "a used settler" means in M3 — and
    // nothing else about the units changes.
    expect(outcome.state.units.map((u) => Number(u.id))).toEqual([1, 2]);
    expect(outcome.state.nextCityId).toBe(1);
    expect(outcome.state.nextUnitId).toBe(STATE.nextUnitId);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    expect(outcome.state.turn).toBe(STATE.turn);
    expect(outcome.events).toStrictEqual([
      {
        type: 'CityFounded',
        cityId: asCityId(0),
        owner: P0,
        name: 'City 1',
        tile: asTileIndex(5),
      },
    ]);

    // Pure: the input still has its settler and no cities.
    expect(STATE.units).toHaveLength(3);
    expect(STATE.cities).toEqual([]);
    expect(STATE.nextCityId).toBe(0);
  });

  it('is deterministic: the same state and command give the same city twice', () => {
    const first = mustOk(apply(STATE, P0, foundCity(0)));
    const second = mustOk(apply(STATE, P0, foundCity(0)));
    expect(second.state).toStrictEqual(first.state);
    expect(second.events).toStrictEqual(first.events);
  });

  it('names and numbers cities by creation order, and keeps the new city off another city’s tile', () => {
    // Two settlers of player 0 on land, 2 tiles apart (the minimum), plus a
    // neutral warrior so the units array is not trivially small.
    const two: GameState = {
      ...STATE,
      nextUnitId: 4,
      units: [unit(0, SETTLER, 0, 5, 2), unit(2, WARRIOR, 1, 6, 0), unit(3, SETTLER, 0, 13, 2)],
    };

    const afterFirst = mustOk(apply(two, P0, foundCity(0)));
    const afterSecond = mustOk(apply(afterFirst.state, P0, foundCity(3)));

    expect(afterSecond.state.cities.map((c) => [Number(c.id), c.name, Number(c.tile)])).toEqual([
      [0, 'City 1', 5],
      [1, 'City 2', 13],
    ]);
    expect(afterSecond.state.nextCityId).toBe(2);

    // City 2's first citizen takes the best free tile in its radius: 4 is claimed
    // by city 1 (it is in that city's `workedTiles`), and 5 — the tile the
    // *neighbour city centre* stands on — is not a claim in this model, because
    // what a city claims is exactly its `workedTiles` and a centre is never in
    // that list (it is worked for free). So the answer is 5. The claim rule that
    // does bind is exercised by the next test.
    expect(cityOf(afterSecond.state, 1).workedTiles.map(Number)).toEqual([5]);
    expect(afterSecond.state.units.map((u) => Number(u.id))).toEqual([2]);
  });

  it('skips a tile another city already works when auto-assigning', () => {
    // Player 1's city on 13 works tile 4 — the tile player 0's new city on 5 would
    // otherwise take first. The founder must look past the claim, not take it.
    const claimed = withCities(STATE, [
      city(0, 1, 13, { population: 1, workedTiles: [asTileIndex(4)] }),
    ]);

    const founded = mustOk(apply(claimed, P0, foundCity(0)));

    expect(cityOf(founded.state, 1).workedTiles.map(Number)).toEqual([6]);
  });

  it('refuses a unit that is not a settler, and one whose type the ruleset cannot resolve', () => {
    expect(refusedAs(apply(STATE, P0, foundCity(1)), 'not-a-settler')).toStrictEqual({
      kind: 'not-a-settler',
      unitId: asUnitId(1),
    });

    const ghost = { ...SETTLER, id: asUnitTypeId('ghost') };
    const ghostBoard: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, ghost, 0, 5, 2)] };
    expect(refusedAs(apply(ghostBoard, P0, foundCity(0)), 'not-a-settler')).toStrictEqual({
      kind: 'not-a-settler',
      unitId: asUnitId(0),
    });
  });

  it('refuses a site that is not on land', () => {
    for (const tile of [0, 3]) {
      const atSea: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, tile, 2)] };
      expect(refusedAs(apply(atSea, P0, foundCity(0)), 'not-on-land')).toStrictEqual({
        kind: 'not-on-land',
        unitId: asUnitId(0),
        tile: asTileIndex(tile),
      });
    }
  });

  it('refuses a site too close to another city, naming the nearest and the rule', () => {
    const near = withCities(STATE, [city(0, 1, 4, { population: 1 })]);
    expect(refusedAs(apply(near, P0, foundCity(0)), 'city-too-close')).toStrictEqual({
      kind: 'city-too-close',
      unitId: asUnitId(0),
      tile: asTileIndex(5),
      cityId: asCityId(0),
      distance: 1,
      minDistance: MIN_CITY_DISTANCE,
    });

    // A city already standing on the settler's own tile is distance 0: "one city
    // per tile" is the same rule, not a special case.
    const onTop = withCities(STATE, [city(0, 1, 5, { population: 1 })]);
    const error = refusedAs(apply(onTop, P0, foundCity(0)), 'city-too-close');
    if (error.kind !== 'city-too-close') throw new Error('unreachable');
    expect(error.distance).toBe(0);
  });

  it('allows a site exactly MIN_CITY_DISTANCE away, in either direction', () => {
    // 13 = (1,3) is two rows away from 5 = (1,1): Chebyshev distance 2 = the rule.
    const far = withCities(STATE, [city(0, 1, 13, { population: 1 })]);
    expect(apply(far, P0, foundCity(0)).ok).toBe(true);

    // 14 = (2,3): one column and two rows away — distance 2 again.
    const diagonal = withCities(STATE, [city(0, 1, 14, { population: 1 })]);
    expect(apply(diagonal, P0, foundCity(0)).ok).toBe(true);

    // 9 = (1,2) is adjacent: refused.
    const adjacent = withCities(STATE, [city(0, 1, 9, { population: 1 })]);
    expect(refusedAs(apply(adjacent, P0, foundCity(0)), 'city-too-close').kind).toBe(
      'city-too-close',
    );
  });

  it('lets a barbarian settler found a city — a stated reading, not an oversight', () => {
    // M3 makes barbarians an ordinary player with ordinary units, and the frozen
    // `GameError` union has no member for "barbarians do not build cities". So the
    // same rules apply to them as to anyone: land, no city too close. Pinned here
    // because the alternative — refusing — would need an error kind the contract
    // does not define.
    const barbarians: GameState = {
      ...STATE,
      nextUnitId: 1,
      players: [player(0, 5), player(1, 6, 'barbarian')],
      units: [unit(0, SETTLER, 1, 5, 2)],
    };

    const outcome = mustOk(apply(barbarians, P1, foundCity(0)));

    expect(outcome.state.cities).toStrictEqual([
      {
        id: asCityId(0),
        owner: P1,
        name: 'City 1',
        tile: asTileIndex(5),
        population: 1,
        foodBox: 0,
        shields: 0,
        // Absent, not present-and-`undefined` — see the note on the founding test
        // above; a barbarian's city is hashed like anyone else's.
        queue: [],
        buildings: [],
        workedTiles: [asTileIndex(4)],
      },
    ]);
    expect(outcome.events).toStrictEqual([
      {
        type: 'CityFounded',
        cityId: asCityId(0),
        owner: P1,
        name: 'City 1',
        tile: asTileIndex(5),
      },
    ]);
  });

  it('refuses another player’s settler, an unknown unit and an unknown player', () => {
    expect(refusedAs(apply(STATE, P1, foundCity(0)), 'not-your-unit')).toStrictEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(0),
      owner: P0,
    });
    expect(refusedAs(apply(STATE, P0, foundCity(99)), 'unknown-unit')).toStrictEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(99),
    });
    expect(refusedAs(apply(STATE, asPlayerId(7), foundCity(0)), 'unknown-player')).toStrictEqual({
      kind: 'unknown-player',
      playerId: asPlayerId(7),
    });
  });

  it('leaves a used settler with nothing to found: the unit is gone, so the id is unknown', () => {
    const founded = mustOk(apply(STATE, P0, foundCity(0))).state;
    expect(refusedAs(apply(founded, P0, foundCity(0)), 'unknown-unit')).toStrictEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(0),
    });
  });

  it('works on a deeply frozen state', () => {
    const frozen: GameState = structuredClone(STATE);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    expect(apply(frozen, P0, foundCity(0)).ok).toBe(true);
    expect(frozen).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — SetWorkedTiles
 * ------------------------------------------------------------------ */

describe('applyCommand — SetWorkedTiles', () => {
  it('stores the assignment in the order given, and touches nothing else', () => {
    const outcome = mustOk(apply(CITY_STATE, P0, setWorkedTiles(0, [4, 8])));

    const assigned = cityOf(outcome.state, 0);
    expect(assigned.workedTiles.map(Number)).toEqual([4, 8]);
    expect(assigned.shields).toBe(CITY.shields);
    expect(assigned.foodBox).toBe(CITY.foodBox);
    expect(assigned.production).toBeUndefined();
    expect(assigned.queue).toEqual([]);
    expect(assigned.buildings).toEqual([]);
    expect(outcome.state.revision).toBe(CITY_STATE.revision + 1);
    expect(outcome.state.units).toBe(CITY_STATE.units);
    // No event: the contract's M3 event list has no member for an assignment, and
    // the command's payload is the record of the change (see `commands.ts`).
    expect(outcome.events).toEqual([]);

    // The order is meaningful — `cityYields` counts the first `population`
    // entries — so it is preserved rather than sorted.
    const reversed = mustOk(apply(CITY_STATE, P0, setWorkedTiles(0, [8, 4])));
    expect(cityOf(reversed.state, 0).workedTiles.map(Number)).toEqual([8, 4]);
  });

  it('accepts fewer tiles than the city has citizens, and none at all', () => {
    expect(
      cityOf(mustOk(apply(CITY_STATE, P0, setWorkedTiles(0, [8]))).state, 0).workedTiles,
    ).toEqual([asTileIndex(8)]);
    expect(
      cityOf(mustOk(apply(CITY_STATE, P0, setWorkedTiles(0, []))).state, 0).workedTiles,
    ).toEqual([]);
  });

  it('refuses more tiles than the city has citizens', () => {
    // City 0 has two citizens (the fixture), so three tiles is one too many.
    expect(
      refusedAs(apply(CITY_STATE, P0, setWorkedTiles(0, [4, 8, 5])), 'too-many-worked-tiles'),
    ).toStrictEqual({
      kind: 'too-many-worked-tiles',
      cityId: asCityId(0),
      requested: 3,
      allowed: 2,
    });
  });

  it('refuses a tile outside the radius, off the map, or the centre itself', () => {
    // 7 = (3,1) is the box corner of 13's radius; 3 and the whole of row 0 are out
    // of reach; -1 and 16 are not tiles; 13 is the centre, which is always worked
    // and costs no citizen.
    for (const tile of [7, 3, 1, -1, 16, 13]) {
      expect(
        refusedAs(apply(CITY_STATE, P0, setWorkedTiles(0, [tile])), 'tile-not-workable'),
      ).toStrictEqual({ kind: 'tile-not-workable', cityId: asCityId(0), tile: asTileIndex(tile) });
    }
  });

  it('refuses a tile that is not a tile at all', () => {
    expect(detailOf(apply(CITY_STATE, P0, setWorkedTiles(0, [1.5])))).toContain('integer');
  });

  it('refuses a tile another city works, naming that city', () => {
    const shared = withCities(STATE, [
      CITY,
      city(1, 1, 5, { population: 1, workedTiles: [asTileIndex(8)] }),
    ]);

    expect(
      refusedAs(apply(shared, P0, setWorkedTiles(0, [8])), 'tile-worked-by-another-city'),
    ).toStrictEqual({
      kind: 'tile-worked-by-another-city',
      cityId: asCityId(0),
      tile: asTileIndex(8),
      byCityId: asCityId(1),
    });
  });

  it('allows re-listing a tile the same city already works', () => {
    // City 0 works 4 already; asking for it again is the same claim, not a clash.
    const outcome = mustOk(apply(CITY_STATE, P0, setWorkedTiles(0, [4, 5])));
    expect(cityOf(outcome.state, 0).workedTiles.map(Number)).toEqual([4, 5]);
  });

  it('refuses the same tile twice', () => {
    expect(
      refusedAs(apply(CITY_STATE, P0, setWorkedTiles(0, [4, 4])), 'duplicate-worked-tile'),
    ).toStrictEqual({ kind: 'duplicate-worked-tile', cityId: asCityId(0), tile: asTileIndex(4) });
  });

  it('refuses an unknown city, another player’s city, and an unknown player', () => {
    expect(refusedAs(apply(CITY_STATE, P0, setWorkedTiles(9, [4])), 'unknown-city')).toStrictEqual({
      kind: 'unknown-city',
      cityId: asCityId(9),
    });
    expect(refusedAs(apply(CITY_STATE, P1, setWorkedTiles(0, [4])), 'not-your-city')).toStrictEqual(
      {
        kind: 'not-your-city',
        cityId: asCityId(0),
        owner: P0,
      },
    );
    expect(
      refusedAs(apply(CITY_STATE, asPlayerId(7), setWorkedTiles(0, [4])), 'unknown-player'),
    ).toStrictEqual({ kind: 'unknown-player', playerId: asPlayerId(7) });
  });

  it('never mutates its input', () => {
    const frozen: GameState = structuredClone(CITY_STATE);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    expect(apply(frozen, P0, setWorkedTiles(0, [8])).ok).toBe(true);
    expect(apply(frozen, P0, setWorkedTiles(0, [7])).ok).toBe(false);
    expect(frozen).toEqual(snapshot);
    expect(cityOf(frozen, 0).workedTiles.map(Number)).toEqual([4]);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — SetProduction
 * ------------------------------------------------------------------ */

describe('applyCommand — SetProduction', () => {
  it('sets the head of the queue, leaving the rest of the queue and the shields alone', () => {
    const queued = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        shields: 7,
        production: unitItem('scout'),
        queue: [buildingItem('granary')],
      }),
    ]);

    const outcome = mustOk(apply(queued, P0, setProduction(0, unitItem('warrior'))));

    const assigned = cityOf(outcome.state, 0);
    expect(assigned.production).toEqual(unitItem('warrior'));
    // The queue is preserved: "set" replaces the head, and the city's stored
    // shields are the city's investment, not the item's.
    expect(assigned.queue).toEqual([buildingItem('granary')]);
    expect(assigned.shields).toBe(7);
    expect(outcome.state.revision).toBe(queued.revision + 1);
    expect(outcome.events).toEqual([]);
    expect(cityOf(queued, 0).production).toEqual(unitItem('scout'));
  });

  it('accepts a building the city does not have, and a unit type it does', () => {
    expect(
      cityOf(mustOk(apply(CITY_STATE, P0, setProduction(0, buildingItem('granary')))).state, 0)
        .production,
    ).toEqual(buildingItem('granary'));
    expect(
      cityOf(mustOk(apply(CITY_STATE, P0, setProduction(0, unitItem('scout')))).state, 0)
        .production,
    ).toEqual(unitItem('scout'));
  });

  it('accepts setting the item the city is already building', () => {
    // Redundant but legal: `applyCommand` must accept everything the plan
    // evaluator accepts, and refusing this would make the two disagree.
    const building = withCities(STATE, [city(0, 0, 13, { production: unitItem('scout') })]);
    expect(
      cityOf(mustOk(apply(building, P0, setProduction(0, unitItem('scout')))).state, 0).production,
    ).toEqual(unitItem('scout'));
  });

  it('refuses an item this ruleset cannot build', () => {
    expect(
      refusedAs(
        apply(CITY_STATE, P0, setProduction(0, unitItem('spaceship'))),
        'unknown-production-item',
      ),
    ).toStrictEqual({ kind: 'unknown-production-item', item: unitItem('spaceship') });
    expect(
      refusedAs(
        apply(CITY_STATE, P0, setProduction(0, buildingItem('spaceship'))),
        'unknown-production-item',
      ),
    ).toStrictEqual({ kind: 'unknown-production-item', item: buildingItem('spaceship') });
  });

  it('refuses a building the city already has', () => {
    const built = withCities(STATE, [city(0, 0, 13, { buildings: [asBuildingId('granary')] })]);

    expect(
      refusedAs(apply(built, P0, setProduction(0, buildingItem('granary'))), 'already-built'),
    ).toStrictEqual({
      kind: 'already-built',
      cityId: asCityId(0),
      building: asBuildingId('granary'),
    });
    // A *different* building is fine, and so is a unit.
    expect(apply(built, P0, setProduction(0, buildingItem('library'))).ok).toBe(true);
    expect(apply(built, P0, setProduction(0, unitItem('scout'))).ok).toBe(true);
  });

  it('refuses an unknown city, another player’s city, and an unknown player', () => {
    expect(
      refusedAs(apply(CITY_STATE, P0, setProduction(9, unitItem('scout'))), 'unknown-city'),
    ).toStrictEqual({ kind: 'unknown-city', cityId: asCityId(9) });
    expect(
      refusedAs(apply(CITY_STATE, P1, setProduction(0, unitItem('scout'))), 'not-your-city'),
    ).toStrictEqual({ kind: 'not-your-city', cityId: asCityId(0), owner: P0 });
    expect(
      refusedAs(
        apply(CITY_STATE, asPlayerId(7), setProduction(0, unitItem('scout'))),
        'unknown-player',
      ),
    ).toStrictEqual({ kind: 'unknown-player', playerId: asPlayerId(7) });
  });

  it('never mutates its input', () => {
    const frozen: GameState = structuredClone(CITY_STATE);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    expect(apply(frozen, P0, setProduction(0, unitItem('warrior'))).ok).toBe(true);
    expect(apply(frozen, P0, setProduction(0, unitItem('spaceship'))).ok).toBe(false);
    expect(frozen).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M4c — the resource gate on production
 * ------------------------------------------------------------------ */

/**
 * The two boards the gate section differs by: player 0's city on 13 (the M3
 * fixture) on a map carrying **iron on 15**, and the same board with a **road on
 * 14**. Tile 13 is `(1,3)` and tile 15 is `(3,3)`, so 14 is the one tile between
 * them: with the road the city centre reaches the iron, without it nothing does.
 *
 * Iron on a mountain is deliberate — the connection rule is a path of *road*
 * tiles and asks nothing about terrain (M4c names no terrain rule), so a
 * mountain resource is the case that would break if someone "improved" the walk
 * with a passability check.
 */
const IRON_TILE = 15;
const ROAD_TO_IRON = 14;
const IRON_MAP: GameMap = {
  ...MAP,
  resources: [{ tile: asTileIndex(IRON_TILE), resource: IRON }],
};

/** Player 0's city with iron on the map and no road: the gate is shut. */
const GATED_STATE: GameState = withCities({ ...STATE, map: IRON_MAP }, [CITY]);

/** The same board with the one road that connects the iron: the gate is open. */
const CONNECTED_STATE: GameState = {
  ...GATED_STATE,
  improvements: [{ tile: asTileIndex(ROAD_TO_IRON), kind: ROAD.id }],
};

const swordsman = unitItem('swordsman');

/**
 * A **wonder** row (M4c): `wonder: true` is what turns on global uniqueness, and
 * the key is present-and-`true`, never present-and-`false` (which
 * `validateRuleset` rejects). It lives in its own ruleset below, so the shared
 * `RULESET` — and every count asserted against it earlier in this file — is
 * unchanged by it.
 */
const PYRAMIDS: BuildingDef = {
  id: asBuildingId('pyramids'),
  name: 'Pyramids',
  cost: 40,
  maintenance: 0,
  effects: [],
  wonder: true,
};

const WONDER_RULESET: RulesetView = { ...RULESET, buildings: [...BUILDINGS, PYRAMIDS] };

const pyramids = buildingItem('pyramids');

describe('applyCommand — SetProduction resource gating (M4c)', () => {
  it('accepts the gated unit once the owner has the resource connected', () => {
    const outcome = mustOk(apply(CONNECTED_STATE, P0, setProduction(0, swordsman)));

    expect(cityOf(outcome.state, 0).production).toEqual(swordsman);
    expect(outcome.state.revision).toBe(CONNECTED_STATE.revision + 1);
    // A setter emits no event, on M3's precedent: the payload is the record.
    expect(outcome.events).toEqual([]);
  });

  it('lays the road and the very same command becomes legal — nothing else differs', () => {
    // The two boards differ by exactly one `(tile, kind)` pair, so this is a test
    // of the gate rather than of a board that happens to be different.
    expect(GATED_STATE.improvements).toEqual([]);
    expect(CONNECTED_STATE.improvements).toEqual([
      { tile: asTileIndex(ROAD_TO_IRON), kind: ROAD.id },
    ]);
    expect(planSetProduction(GATED_STATE, RULESET, P0, asCityId(0), swordsman).ok).toBe(false);
    expect(planSetProduction(CONNECTED_STATE, RULESET, P0, asCityId(0), swordsman).ok).toBe(true);
  });

  it('refuses it with the typed error while the road is missing', () => {
    const expected: GameError = {
      kind: 'resource-not-connected',
      cityId: asCityId(0),
      owner: P0,
      item: swordsman,
      resource: IRON,
    };

    expect(
      refusedAs(apply(GATED_STATE, P0, setProduction(0, swordsman)), 'resource-not-connected'),
    ).toStrictEqual(expected);

    // The plan evaluator — the applier's *own* decision, and the one `actions.ts`'
    // production options are filtered through — refuses identically, field for
    // field. A generator and an applier that disagreed here is the bug the
    // keystone invariant exists to catch.
    const plan = planSetProduction(GATED_STATE, RULESET, P0, asCityId(0), swordsman);
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable: the gate is shut on this board');
    expect(plan.error).toStrictEqual(expected);
  });

  it('refuses a requirement naming a resource no catalog row defines', () => {
    // `validateRuleset` rejects such a unit row outright, so this is reachable only
    // through a foreign or hand-built view. The gate is total on it: the id is not
    // connected, so the item is refused with the same typed error that names it.
    const champion: UnitDef = {
      ...SWORDSMAN,
      id: asUnitTypeId('champion'),
      requiresResource: asResourceId('mithril'),
    };
    const ruleset: RulesetView = { ...RULESET, units: [...RULESET.units, champion] };
    const item: ProductionItem = { kind: 'unit', id: champion.id };

    expect(planSetProduction(CONNECTED_STATE, ruleset, P0, asCityId(0), item).ok).toBe(false);
    expect(
      refusedAs(
        apply(CONNECTED_STATE, P0, setProduction(0, item), ruleset),
        'resource-not-connected',
      ),
    ).toStrictEqual({
      kind: 'resource-not-connected',
      cityId: asCityId(0),
      owner: P0,
      item,
      resource: asResourceId('mithril'),
    });
  });

  it('gates nothing that demands nothing, on the very same disconnected board', () => {
    // The check is the gate, not "units are suspicious": a warrior, a settler and a
    // building are all fine with iron unconconnected and no road anywhere.
    expect(apply(GATED_STATE, P0, setProduction(0, unitItem('warrior'))).ok).toBe(true);
    expect(apply(GATED_STATE, P0, setProduction(0, unitItem('settler'))).ok).toBe(true);
    expect(apply(GATED_STATE, P0, setProduction(0, buildingItem('granary'))).ok).toBe(true);
  });

  it('is the player’s connection, not the building city’s own road', () => {
    // M4c connects a resource for a *player* when "some city of that player" reaches
    // it, so a second city far from the road network may still build the swordsman…
    const twoCities = withCities(CONNECTED_STATE, [CITY, city(1, 0, 4)]);
    expect(cityOf(twoCities, 1).tile).toBe(asTileIndex(4));

    const outcome = mustOk(apply(twoCities, P0, setProduction(1, swordsman)));
    expect(cityOf(outcome.state, 1).production).toEqual(swordsman);

    // …while that same city, alone with no city of its owner reaching any iron,
    // is refused. The connection is the player's, not a property of the city.
    const lonely = withCities(GATED_STATE, [city(1, 0, 4)]);
    expect(
      refusedAs(apply(lonely, P0, setProduction(1, swordsman)), 'resource-not-connected').kind,
    ).toBe('resource-not-connected');
  });

  it('refuses a barbarian owner even with a road right up to the resource', () => {
    // A board that connects for a civilization — same roads, same iron, same city
    // tile — owned by the barbarians: "no economy and therefore no connections".
    const barbarianCity = city(0, 1, 13, { population: 2, workedTiles: [asTileIndex(4)] });
    const barbarians = withCities(
      { ...CONNECTED_STATE, players: [player(0, 5), player(1, 6, 'barbarian')] },
      [barbarianCity],
    );

    expect(barbarians.cities[0]?.owner).toBe(P1);
    expect(
      refusedAs(apply(barbarians, P1, setProduction(0, swordsman)), 'resource-not-connected'),
    ).toStrictEqual({
      kind: 'resource-not-connected',
      cityId: asCityId(0),
      owner: P1,
      item: swordsman,
      resource: IRON,
    });
  });

  it('leaves the state, the city and the revision untouched when the gate refuses', () => {
    const frozen: GameState = structuredClone(GATED_STATE);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    expect(apply(frozen, P0, setProduction(0, swordsman)).ok).toBe(false);
    expect(frozen).toEqual(snapshot);
    // The city is still building *nothing* — and by absence, not by a key holding
    // `undefined`, which is the spelling that cannot survive a JSON round trip.
    expect(cityOf(frozen, 0).production).toBeUndefined();
    expect('production' in cityOf(frozen, 0)).toBe(false);
    expect(frozen.revision).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * M4c — wonders are globally unique (the building half of the same decision)
 * ------------------------------------------------------------------ */

describe('applyCommand — SetProduction and the wonder rule (M4c)', () => {
  /** Player 0's city 0 on 13 holds the wonder; its city 1 on 4 does not. */
  const oneHolder = (): GameState =>
    withCities({ ...GATED_STATE, players: [player(0, 5), player(1, 6)] }, [
      city(0, 0, 13, { population: 2, buildings: [PYRAMIDS.id] }),
      city(1, 0, 4),
    ]);

  it('refuses a wonder another city holds, naming the holder', () => {
    const state = oneHolder();

    expect(
      refusedAs(
        apply(state, P0, setProduction(1, pyramids), WONDER_RULESET),
        'wonder-already-built',
      ),
    ).toStrictEqual({
      kind: 'wonder-already-built',
      cityId: asCityId(1),
      building: PYRAMIDS.id,
      holder: asCityId(0),
    });

    // The holder itself gets the *other* refusal, because its situation is
    // different: it has the wonder, so `already-built` is the honest reason.
    expect(
      refusedAs(apply(state, P0, setProduction(0, pyramids), WONDER_RULESET), 'already-built'),
    ).toStrictEqual({ kind: 'already-built', cityId: asCityId(0), building: PYRAMIDS.id });

    // …and the plan evaluator, which `actions.ts`' option list filters through,
    // refuses for the same two reasons. One rule, asked here and by
    // `production.ts`' completion pass (`buildings.ts`' `mayStartBuilding`).
    const plan = planSetProduction(state, WONDER_RULESET, P0, asCityId(1), pyramids);
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable: another city holds the wonder');
    expect(plan.error).toStrictEqual({
      kind: 'wonder-already-built',
      cityId: asCityId(1),
      building: PYRAMIDS.id,
      holder: asCityId(0),
    });
  });

  it('accepts an unheld wonder, and accepts it again once the holder loses it', () => {
    const unheld = withCities({ ...GATED_STATE, players: [player(0, 5), player(1, 6)] }, [
      city(0, 0, 13, { population: 2 }),
      city(1, 0, 4),
    ]);

    const built = mustOk(apply(unheld, P0, setProduction(1, pyramids), WONDER_RULESET));
    expect(cityOf(built.state, 1).production).toEqual(pyramids);

    // Bankruptcy takes the buildings a player can no longer pay for (`economy.ts`),
    // leaving `city.buildings` everywhere — which is what makes the wonder startable
    // again. `disbandBuildings` is not called here because this test is about the
    // *rule*, not about the money loop; dropping the building is exactly the state
    // that loop produces.
    const state = oneHolder();
    expect(cityOf(state, 0).buildings).toEqual([PYRAMIDS.id]);
    const lost: GameState = {
      ...state,
      cities: state.cities.map((existing) =>
        existing.id === asCityId(0) ? { ...existing, buildings: [] } : existing,
      ),
    };

    expect(cityOf(lost, 0).buildings).toEqual([]);
    const again = mustOk(apply(lost, P0, setProduction(1, pyramids), WONDER_RULESET));
    expect(cityOf(again.state, 1).production).toEqual(pyramids);
  });

  it('leaves the ordinary buildings untouched by the wonder rule', () => {
    // The rule is about `wonder: true` rows only: two cities may each build a
    // granary, and the second city's granary is not "already built" because the
    // first city has one.
    const state = oneHolder();

    expect(apply(state, P0, setProduction(1, buildingItem('granary')), WONDER_RULESET).ok).toBe(
      true,
    );
    expect(
      planSetProduction(state, WONDER_RULESET, P0, asCityId(1), buildingItem('granary')).ok,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — the plan evaluators are the appliers' decisions
 * ------------------------------------------------------------------ */

describe('applyCommand — SetRates', () => {
  it('stores the three rates and touches nothing else', () => {
    const outcome = mustOk(apply(STATE, P0, setRates(2, 5, 3)));

    expect(playerOf(outcome.state, 0).rates).toEqual({ tax: 2, science: 5, luxury: 3 });
    // Every other field of the actor is carried over untouched — including the
    // money pools: a rate is a setting, and setting it collects nothing.
    const before = playerOf(STATE, 0);
    const after = playerOf(outcome.state, 0);
    expect(after.treasury).toBe(before.treasury);
    expect(after.beakers).toBe(before.beakers);
    expect(after.luxuries).toBe(before.luxuries);
    expect(after.name).toBe(before.name);
    expect(after.color).toBe(before.color);
    expect(after.startingTile).toBe(before.startingTile);
    expect(after.kind).toBe(before.kind);
    // The other player is not the actor and is not touched.
    expect(playerOf(outcome.state, 1).rates).toEqual(playerOf(STATE, 1).rates);
    expect(outcome.state.units).toBe(STATE.units);
    expect(outcome.state.cities).toBe(STATE.cities);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    // No event: M3's setter precedent — the payload is the record of the change,
    // and M4b's frozen event list has no member for a rate.
    expect(outcome.events).toEqual([]);
  });

  it('accepts every triple of non-negative integers summing to RATE_TOTAL', () => {
    // The whole legal space, which is also what `planSetRates` must accept: the
    // enumerating generators do not yield rates (see `actions.ts`), so the plan
    // evaluator is where legality is stated, and it is stated for all 66.
    let seen = 0;
    for (let tax = 0; tax <= RATE_TOTAL; tax += 1) {
      for (let science = 0; tax + science <= RATE_TOTAL; science += 1) {
        const outcome = apply(STATE, P0, setRates(tax, science, RATE_TOTAL - tax - science));
        expect(outcome.ok, `${String(tax)}/${String(science)}`).toBe(true);
        seen += 1;
      }
    }
    expect(seen).toBe(((RATE_TOTAL + 1) * (RATE_TOTAL + 2)) / 2);
  });

  it('is idempotent: setting the rates a player already has is still a legal command', () => {
    // Unlike `SetWorkedTiles`, which refuses "the same set" as a no-op, a rate is a
    // slider: the value the player already has is a value the player may ask for,
    // and refusing it would make a UI's "apply" button wrong. It is still a command,
    // so it still costs a revision.
    const outcome = mustOk(
      apply(STATE, P0, setRates(DEFAULT_RATES.tax, DEFAULT_RATES.science, DEFAULT_RATES.luxury)),
    );

    expect(playerOf(outcome.state, 0).rates).toEqual(DEFAULT_RATES);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
  });

  it('refuses a rate that is not an integer >= 0, naming the field and the rule', () => {
    for (const [cmd, field] of [
      [setRates(-1, 5, 6), 'tax'],
      [setRates(1.5, 4, 4.5), 'tax'],
      [setRates(5, -1, 6), 'science'],
      [setRates(5, 4.5, 0.5), 'science'],
      [setRates(6, 4, -1), 'luxury'],
      [setRates(0.5, 4.5, 5), 'tax'],
    ] as readonly (readonly [Command, string])[]) {
      expect(refusedAs(apply(STATE, P0, cmd), 'invalid-argument').kind).toBe('invalid-argument');
      const detail = detailOf(apply(STATE, P0, cmd));
      expect(detail, field).toContain(field);
      expect(detail, field).toMatch(/integer|>= 0/);
    }
  });

  it('refuses rates that do not sum to RATE_TOTAL, with the actual sum in the message', () => {
    // Three parts of three is nine, not ten: the message has to say so, because the
    // caller (a slider UI, an AI) is the thing that got it wrong.
    const nine = detailOf(apply(STATE, P0, setRates(3, 3, 3)));
    expect(nine).toContain(`exactly ${String(RATE_TOTAL)}`);
    expect(nine).toContain('= 9');
    expect(nine).toContain('tax 3');
    expect(nine).toContain('science 3');
    expect(nine).toContain('luxury 3');

    expect(detailOf(apply(STATE, P0, setRates(0, 0, 0)))).toContain('= 0');
    expect(detailOf(apply(STATE, P0, setRates(4, 4, 4)))).toContain('= 12');
  });

  it('refuses an actor the state does not have, and leaves the state alone', () => {
    expect(refusedAs(apply(STATE, asPlayerId(7), setRates(1, 1, 8)), 'unknown-player')).toEqual({
      kind: 'unknown-player',
      playerId: asPlayerId(7),
    });
    expect(STATE.revision).toBe(0);
    // Another player's rates are still its own to set: the command is not "yours
    // only", it is "the actor's only", which is why the *actor* is what it writes.
    expect(playerOf(mustOk(apply(STATE, P1, setRates(1, 1, 8))).state, 1).rates).toEqual({
      tax: 1,
      science: 1,
      luxury: 8,
    });
  });

  it('is legal for a barbarian actor too, whose rates nothing reads', () => {
    // The command writes a setting on whoever acts; barbarians have no economy, so
    // their rates are inert (their treasury is not even collected into). Refusing
    // would be a rule the frozen contract does not state.
    const withBarbarians: GameState = {
      ...STATE,
      players: [...STATE.players, player(2, 8, 'barbarian')],
    };

    const outcome = mustOk(apply(withBarbarians, asPlayerId(2), setRates(1, 1, 8)));
    expect(playerOf(outcome.state, 2).rates).toEqual({ tax: 1, science: 1, luxury: 8 });
  });

  it('never rewrites money already banked — a rate is read, not recomputed', () => {
    // "Changing rates affects future turns only, never the current one." This engine
    // has no moment *after* a turn's collection: the money loop is the last step of
    // the turn (`turn.ts`), and the state carries no pending-rates field to defer
    // with. What the rule can and does mean here is that a rate change collects
    // nothing, refunds nothing and recomputes nothing: every pool is exactly what it
    // was, and the *next* money loop reads the new rates.
    const rich: GameState = {
      ...STATE,
      players: [
        { ...playerOf(STATE, 0), treasury: 12, beakers: 7, luxuries: 3 },
        playerOf(STATE, 1),
      ],
    };

    const changed = mustOk(apply(rich, P0, setRates(0, 10, 0))).state;
    const actor = playerOf(changed, 0);
    expect(actor.treasury).toBe(12);
    expect(actor.beakers).toBe(7);
    expect(actor.luxuries).toBe(3);

    // And the change is read by the collection that comes next: the same board with
    // a city, closed under the new rates, banks nothing but beakers. The fixture city
    // has 2 commerce (its centre plus the one tile it works), so an all-science rate
    // turns all of it into beakers — against the 2 gold and 1 beaker the default
    // 6/4/0 rates would have given it.
    const withCity = withCities(changed, [CITY]);
    const closed = advanceTurn(withCity, RULESET);
    expect(closed.events).toContainEqual({
      type: 'IncomeCollected',
      playerId: P0,
      gold: 0,
      beakers: 2,
      luxuries: 0,
    });
    // The 12 gold of the past is still 12 gold: only the new collection moved.
    expect(playerOf(closed.state, 0).treasury).toBe(12);
    expect(playerOf(closed.state, 0).beakers).toBe(7 + 2);
  });
});

describe('the city plan evaluators agree with applyCommand', () => {
  /**
   * The keystone property's local half: everything the applier accepts, the shared
   * evaluator accepts (and vice versa), with the same refusal when it refuses.
   * `actions.test.ts` runs the exhaustive sweep, including the commands'
   * legality from the generators' side.
   */
  const boards: readonly GameState[] = [
    STATE,
    CITY_STATE,
    withCities(STATE, [city(0, 1, 4, { population: 1 })]),
    withCities(STATE, [city(0, 1, 13, { population: 1, workedTiles: [asTileIndex(4)] })]),
    { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 3, 2)] },
    { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 2, 2)] },
  ];

  it('FoundCity: the plan’s verdict is the applier’s, on every board', () => {
    for (const board of boards) {
      const planned = planFoundCity(board, RULESET, P0, asUnitId(0));
      const applied = apply(board, P0, foundCity(0));

      expect(applied.ok).toBe(planned.ok);
      if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);
      if (applied.ok && planned.ok) {
        // The plan carries the city that will exist, assignment included — and the
        // founded city is that one, wherever the existing cities sort around it.
        expect(cityById(applied.value.state, planned.value.city.id)).toStrictEqual(
          planned.value.city,
        );
      }
    }
  });

  it('SetWorkedTiles: the plan’s verdict is the applier’s, for every shape of request', () => {
    const shared = withCities(STATE, [
      CITY,
      city(1, 1, 5, { population: 1, workedTiles: [asTileIndex(8)] }),
    ]);

    const requests: readonly (readonly number[])[] = [
      [4],
      [4, 8],
      [],
      [8, 4],
      [4, 4],
      [7],
      [13],
      [8],
      [4, 8, 5],
      [1.5],
      [-1],
    ];

    for (const tiles of requests) {
      const planned = planSetWorkedTiles(shared, P0, asCityId(0), tiles.map(asTileIndex));
      const applied = apply(shared, P0, setWorkedTiles(0, tiles));

      expect(applied.ok).toBe(planned.ok);
      if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);
      if (applied.ok && planned.ok) {
        expect(cityOf(applied.value.state, 0).workedTiles).toStrictEqual(planned.value.tiles);
      }
    }
  });

  it('SetProduction: the plan’s verdict is the applier’s, for every item shape', () => {
    const built = withCities(STATE, [city(0, 0, 13, { buildings: [asBuildingId('granary')] })]);

    const items: readonly ProductionItem[] = [
      unitItem('scout'),
      unitItem('warrior'),
      unitItem('ghost'),
      buildingItem('granary'),
      buildingItem('library'),
      buildingItem('spaceship'),
    ];

    for (const item of items) {
      const planned = planSetProduction(built, RULESET, P0, asCityId(0), item);
      const applied = apply(built, P0, setProduction(0, item));

      expect(applied.ok).toBe(planned.ok);
      if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);
      if (applied.ok && planned.ok) {
        expect(cityOf(applied.value.state, 0).production).toStrictEqual(planned.value.item);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * M4a — applyCommand: StartWork
 * ------------------------------------------------------------------ */

describe('applyCommand — StartWork', () => {
  it('starts a job on the unit’s own tile, spends its whole turn, and says so in one event', () => {
    const outcome = mustOk(apply(WORK_STATE, P0, startWork(3, 'mine')));

    const started = outcome.state.units.find((u) => u.id === asUnitId(3));
    if (started === undefined) throw new Error('the worker disappeared');
    expect(started.work).toStrictEqual({
      kind: MINE.id,
      tile: asTileIndex(WORKER_TILE),
      turnsLeft: MINE_TURNS,
    });
    // The job costs the unit's remaining movement — *all* of it (M4a: "it costs the
    // unit's remaining movement for the turn"). The worker had 1, so it has 0.
    expect(movementLeftOf(outcome.state, 3)).toBe(0);

    expect(outcome.state.revision).toBe(WORK_STATE.revision + 1);
    expect(outcome.state.turn).toBe(WORK_STATE.turn);
    expect(outcome.events).toStrictEqual([
      {
        type: 'WorkStarted',
        unitId: asUnitId(3),
        kind: MINE.id,
        tile: asTileIndex(WORKER_TILE),
        turnsLeft: MINE_TURNS,
      },
    ]);

    // Nothing is built yet: the pair lands when the job completes (turn.ts).
    expect(outcome.state.improvements).toEqual([]);
    expect(improvementsAt(outcome.state, asTileIndex(WORKER_TILE))).toEqual([]);
    expect(hasImprovement(outcome.state, asTileIndex(WORKER_TILE), MINE.id)).toBe(false);

    // …and nothing else in the state moved: every other unit is the same object.
    for (const unit of STATE.units) {
      expect(outcome.state.units.find((u) => u.id === unit.id)).toBe(unit);
    }
    expect(outcome.state.map).toBe(WORK_STATE.map);
    expect(outcome.state.cities).toBe(WORK_STATE.cities);

    // Hashable: `work` is a real value, never a key holding `undefined`.
    expect(() => canonicalize(outcome.state)).not.toThrow();
    expect(hashValue(outcome.state)).not.toBe(hashValue(WORK_STATE));
  });

  it('takes the job length from the catalog row, not from a constant here', () => {
    const outcome = mustOk(apply(WORK_STATE, P0, startWork(3, 'road')));
    const started = outcome.state.units.find((u) => u.id === asUnitId(3));

    expect(started?.work).toStrictEqual({
      kind: ROAD.id,
      tile: asTileIndex(WORKER_TILE),
      turnsLeft: ROAD_TURNS,
    });
    expect(ROAD_TURNS).not.toBe(MINE_TURNS); // so the two rows are told apart
  });

  it('refuses a unit that is not a worker, including one whose type the ruleset cannot resolve', () => {
    // 0 is a settler, 1 a scout: neither can improve a tile however it stands.
    for (const unitId of [0, 1]) {
      expect(refusedAs(apply(WORK_STATE, P0, startWork(unitId, 'mine')), 'not-a-worker')).toEqual({
        kind: 'not-a-worker',
        unitId: asUnitId(unitId),
      });
    }

    // A type the view does not describe cannot be *shown* to be a worker, so it is
    // refused as `not-a-worker` rather than assumed to be one — the same reading
    // `planFoundCity` applies to an undescribed settler.
    const ghost = makeDef('ghost-worker', 'worker', 1, 2);
    const board = withUnits(WORK_STATE, [...STATE.units, unit(3, ghost, 0, WORKER_TILE, 1)]);
    expect(refusedAs(apply(board, P0, startWork(3, 'mine')), 'not-a-worker')).toStrictEqual({
      kind: 'not-a-worker',
      unitId: asUnitId(3),
    });
  });

  it('refuses an unknown unit, an unknown player, and another player’s worker', () => {
    refusedAs(apply(WORK_STATE, P0, startWork(99, 'mine')), 'unknown-unit');
    refusedAs(apply(WORK_STATE, asPlayerId(9), startWork(3, 'mine')), 'unknown-player');

    const rival = withUnits(WORK_STATE, [...STATE.units, unit(4, WORKER, 1, WORKER_TILE, 1)]);
    expect(refusedAs(apply(rival, P0, startWork(4, 'mine')), 'not-your-unit')).toStrictEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(4),
      owner: P1,
    });
    // …while its own owner may start it: the refusal is ownership, not the tile.
    expect(apply(rival, P1, startWork(4, 'mine')).ok).toBe(true);
  });

  it('refuses a unit that is already working, naming the job in progress', () => {
    const busy = digging(WORK_STATE, mineWork(2));

    expect(refusedAs(apply(busy, P0, startWork(3, 'road')), 'already-working')).toStrictEqual({
      kind: 'already-working',
      unitId: asUnitId(3),
      improvement: MINE.id,
    });
    // Asking again for the *same* job is refused the same way: one job at a time,
    // and "start over" is a cancel first.
    expect(refusedAs(apply(busy, P0, startWork(3, 'mine')), 'already-working').kind).toBe(
      'already-working',
    );
  });

  it('refuses an improvement this ruleset does not describe', () => {
    expect(
      refusedAs(apply(WORK_STATE, P0, startWork(3, 'space-elevator')), 'unknown-improvement'),
    ).toStrictEqual({
      kind: 'unknown-improvement',
      improvement: asImprovementId('space-elevator'),
    });
  });

  it('refuses a catalog row whose turn count is not a usable number of turns', () => {
    // `validateRuleset` guarantees an integer >= 1, but a foreign or hand-built view
    // can carry anything, and `turnsLeft` is written into the state — a fractional
    // or NaN count would put a value into the state that cannot be hashed. Such a
    // row is an improvement this ruleset cannot build, exactly as an unusable
    // `cost` is an item it cannot build.
    for (const turns of [0, -1, 1.5, Number.NaN]) {
      const broken: RulesetView = {
        ...RULESET,
        improvements: [{ ...MINE, turns }, ROAD],
      };
      const refused = refusedAs(
        apply(WORK_STATE, P0, startWork(3, 'mine'), broken),
        'unknown-improvement',
      );
      expect(refused).toStrictEqual({ kind: 'unknown-improvement', improvement: MINE.id });
      // The usable row beside it is untouched by its neighbour's problem.
      expect(apply(WORK_STATE, P0, startWork(3, 'road'), broken).ok).toBe(true);
    }
  });

  it('refuses an improvement the tile’s terrain does not allow, naming the role', () => {
    // The worker stands on hills: a mine is allowed there, irrigation is not
    // (irrigation is flat-land work — a placeholder reading of ours).
    const before = hashValue(WORK_STATE);
    expect(
      refusedAs(apply(WORK_STATE, P0, startWork(3, 'irrigation')), 'improvement-not-allowed'),
    ).toStrictEqual({
      kind: 'improvement-not-allowed',
      unitId: asUnitId(3),
      tile: asTileIndex(WORKER_TILE),
      improvement: IRRIGATION.id,
      role: 'hills',
    });
    // M4a's acceptance evidence: an illegal `StartWork` leaves the state hash
    // unchanged — a refusal is not a partial application.
    expect(hashValue(WORK_STATE)).toBe(before);

    // …and the mirror image: on grassland the same worker cannot dig a mine.
    const flat = withUnits(STATE, [unit(3, WORKER, 0, 4, 1)]);
    expect(
      refusedAs(apply(flat, P0, startWork(3, 'mine')), 'improvement-not-allowed'),
    ).toStrictEqual({
      kind: 'improvement-not-allowed',
      unitId: asUnitId(3),
      tile: asTileIndex(4),
      improvement: MINE.id,
      role: 'grassland',
    });
    expect(apply(flat, P0, startWork(3, 'irrigation')).ok).toBe(true);
  });

  it('refuses an improvement the tile already carries, while allowing a different one there', () => {
    // Written through the state helper, so the pair list under test is the shape
    // `turn.ts` actually writes when a job completes.
    const mined: GameState = withImprovement(WORK_STATE, asTileIndex(WORKER_TILE), MINE.id);
    const before = hashValue(mined);

    expect(refusedAs(apply(mined, P0, startWork(3, 'mine')), 'already-improved')).toStrictEqual({
      kind: 'already-improved',
      tile: asTileIndex(WORKER_TILE),
      improvement: MINE.id,
    });
    // A tile may hold several improvements (a road *and* a mine), so the second
    // kind is still buildable — this is what the pair list exists for.
    expect(apply(mined, P0, startWork(3, 'road')).ok).toBe(true);
    // …and the refusal above changed nothing, the hash included.
    expect(hashValue(mined)).toBe(before);
  });

  it('refuses a worker with no movement left, reporting what it needed and what it had', () => {
    const spent = withUnits(STATE, [unit(3, WORKER, 0, WORKER_TILE, 0)]);

    expect(refusedAs(apply(spent, P0, startWork(3, 'mine')), 'not-enough-movement')).toStrictEqual({
      kind: 'not-enough-movement',
      unitId: asUnitId(3),
      needed: 1,
      available: 0,
    });
  });

  it('refuses a tile that is off the map, not a tile, or not in the terrain catalog', () => {
    const away = withUnits(STATE, [unit(3, WORKER, 0, 99, 1)]);
    refusedAs(apply(away, P0, startWork(3, 'mine')), 'out-of-bounds');

    const fractional = withUnits(STATE, [unit(3, WORKER, 0, 1.5, 1)]);
    expect(detailOf(apply(fractional, P0, startWork(3, 'mine')))).toContain('integer tile index');

    // The tile exists and the worker is on it; the view simply cannot say what is
    // there, so the role rule cannot be checked and the command is refused rather
    // than assumed to be legal.
    const noHills: RulesetView = {
      ...RULESET,
      terrains: TERRAINS.filter((terrain) => terrain.role !== 'hills'),
    };
    expect(detailOf(apply(WORK_STATE, P0, startWork(3, 'mine'), noHills))).toContain(
      'defines no terrain',
    );
  });

  it('never mutates a deeply frozen board, and a refusal changes nothing at all', () => {
    const board: GameState = structuredClone(WORK_STATE);
    const snapshot = structuredClone(board);
    deepFreeze(board);

    const started = mustOk(apply(board, P0, startWork(3, 'mine')));
    expect(started.state.revision).toBe(board.revision + 1);
    expect(() => canonicalize(started.state)).not.toThrow();

    const refused = apply(board, P0, startWork(3, 'irrigation'));
    expect(refused.ok).toBe(false);
    expect(board).toEqual(snapshot);
    expect(hashValue(board)).toBe(hashValue(snapshot));
  });
});

/* ------------------------------------------------------------------ *
 * M4a — applyCommand: CancelWork
 * ------------------------------------------------------------------ */

describe('applyCommand — CancelWork', () => {
  it('clears the job, refunds nothing, and reports the job it dropped', () => {
    // A worker mid-job that has already spent its turn: the job was started this
    // turn, which is what took the movement.
    const busy = digging(withUnits(STATE, [unit(3, WORKER, 0, WORKER_TILE, 0)]), mineWork(2));
    const outcome = mustOk(apply(busy, P0, cancelWork(3)));

    const idle = outcome.state.units.find((u) => u.id === asUnitId(3));
    const before = busy.units.find((u) => u.id === asUnitId(3));
    if (idle === undefined || before === undefined) throw new Error('the worker disappeared');
    expect('work' in idle).toBe(false);
    expect(workOf(outcome.state, 3)).toBeUndefined();
    // The unit afterwards is exactly the unit before, with the job taken off it.
    expect(idle).toStrictEqual(withoutWork(before));
    // Cancelling is free but refunds nothing: the movement the job spent is gone.
    expect(idle.movementLeft).toBe(0);
    // A job never added an improvement before completing, so cancelling cannot
    // leave a half-built one behind.
    expect(outcome.state.improvements).toEqual([]);

    expect(outcome.state.revision).toBe(busy.revision + 1);
    expect(outcome.events).toStrictEqual([
      {
        type: 'WorkCancelled',
        unitId: asUnitId(3),
        kind: MINE.id,
        tile: asTileIndex(WORKER_TILE),
        turnsLeft: 2,
        reason: 'cancelled',
      },
    ]);
    expect(() => canonicalize(outcome.state)).not.toThrow();
    expect(hashValue(outcome.state)).not.toBe(hashValue(busy));
  });

  it('lets the worker start a different job afterwards, without a turn in between', () => {
    // Cancelling does not spend movement, so a worker that still has some may
    // immediately start something else — which is the point of a cancel that costs
    // nothing.
    const busy = digging(WORK_STATE, mineWork(2));
    const cancelled = mustOk(apply(busy, P0, cancelWork(3))).state;

    const restarted = mustOk(apply(cancelled, P0, startWork(3, 'road')));
    expect(workOf(restarted.state, 3)).toStrictEqual({
      kind: ROAD.id,
      tile: asTileIndex(WORKER_TILE),
      turnsLeft: ROAD_TURNS,
    });
  });

  it('refuses an idle unit, an unknown unit, an unknown player, and another player’s worker', () => {
    expect(refusedAs(apply(WORK_STATE, P0, cancelWork(3)), 'not-working')).toStrictEqual({
      kind: 'not-working',
      unitId: asUnitId(3),
    });
    refusedAs(apply(WORK_STATE, P0, cancelWork(99)), 'unknown-unit');
    refusedAs(apply(WORK_STATE, asPlayerId(9), cancelWork(3)), 'unknown-player');

    const rival = withUnits(WORK_STATE, [
      ...STATE.units,
      withWork(unit(4, WORKER, 1, WORKER_TILE, 1), mineWork(2)),
    ]);
    expect(refusedAs(apply(rival, P0, cancelWork(4)), 'not-your-unit')).toStrictEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(4),
      owner: P1,
    });
    expect(apply(rival, P1, cancelWork(4)).ok).toBe(true);
  });

  it('never mutates its input', () => {
    const board: GameState = structuredClone(digging(WORK_STATE, mineWork(2)));
    const snapshot = structuredClone(board);
    deepFreeze(board);

    mustOk(apply(board, P0, cancelWork(3)));
    expect(board).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M4a — relocation cancels a job
 * ------------------------------------------------------------------ */

describe('applyCommand — relocation cancels work', () => {
  it('a step by a working unit drops the job and says so, right after the move', () => {
    const busy = digging(WORK_STATE, mineWork(2));
    const outcome = mustOk(apply(busy, P0, move(3, 4)));

    expect(outcome.events).toStrictEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(3),
        from: asTileIndex(WORKER_TILE),
        to: asTileIndex(4),
        cost: 1,
        movementLeft: 0,
      },
      // The same fact `CancelWork` reports, with the reason that says it was the
      // step that ended the job. A consumer that had to diff the unit to notice
      // would be reading exactly what events exist to avoid.
      {
        type: 'WorkCancelled',
        unitId: asUnitId(3),
        kind: MINE.id,
        tile: asTileIndex(WORKER_TILE),
        turnsLeft: 2,
        reason: 'moved',
      },
    ]);

    const moved = outcome.state.units.find((u) => u.id === asUnitId(3));
    if (moved === undefined) throw new Error('the worker disappeared');
    expect('work' in moved).toBe(false);
    expect(moved.tile).toBe(asTileIndex(4));
    // Work is *not* carried along the way a stack would be: it happened on tile 1
    // and nothing was built there.
    expect(outcome.state.improvements).toEqual([]);
    expect(() => canonicalize(outcome.state)).not.toThrow();
  });

  it('says nothing about work when the unit that steps was idle', () => {
    const outcome = mustOk(apply(WORK_STATE, P0, move(3, 4)));

    expect(outcome.events.map((event) => event.type)).toEqual(['UnitMoved']);
  });

  it('cancels the job before the hut the mover steps onto is resolved', () => {
    // A hut on the destination tile makes the event order observable: the step, the
    // job it ended, then what the hut paid.
    const board: GameState = {
      ...digging(WORK_STATE, mineWork(2)),
      map: { ...WORK_STATE.map, huts: [asTileIndex(4)] },
    };
    const outcome = mustOk(apply(board, P0, move(3, 4)));

    expect(outcome.events.slice(0, 2).map((event) => event.type)).toEqual([
      'UnitMoved',
      'WorkCancelled',
    ]);
    expect(outcome.events.some((event) => event.type === 'HutEntered')).toBe(true);
    expect(workOf(outcome.state, 3)).toBeUndefined();
  });

  it('is reproducible: the same step twice gives the same state and the same events', () => {
    const busy = digging(WORK_STATE, mineWork(2));
    const first = mustOk(apply(busy, P0, move(3, 4)));
    const second = mustOk(apply(busy, P0, move(3, 4)));

    expect(second.state).toStrictEqual(first.state);
    expect(second.events).toStrictEqual(first.events);
    expect(hashValue(second.state)).toBe(hashValue(first.state));
    // …and a cancellation is a real change: the state is not the input.
    expect(hashValue(first.state)).not.toBe(hashValue(busy));
    expect(apply(busy, P0, move(3, 4)).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * M4a — the work plan evaluators agree with applyCommand
 * ------------------------------------------------------------------ */

describe('the work plan evaluators agree with applyCommand', () => {
  /**
   * The keystone property's local half for M4a, mirroring the city section below:
   * everything the applier accepts, the shared evaluator accepts (and vice versa),
   * with the same typed refusal when it refuses. `actions.test.ts` runs the
   * exhaustive sweep, including the commands' legality from the generators' side.
   */
  const boards: readonly GameState[] = [
    WORK_STATE,
    digging(WORK_STATE, mineWork(2)),
    withUnits(STATE, [unit(3, WORKER, 0, WORKER_TILE, 0)]),
    withUnits(STATE, [unit(3, WORKER, 0, 4, 1)]),
    { ...WORK_STATE, improvements: [{ tile: asTileIndex(WORKER_TILE), kind: MINE.id }] },
    WORK_CITY_STATE,
  ];

  const kinds: readonly ImprovementId[] = [
    MINE.id,
    ROAD.id,
    IRRIGATION.id,
    asImprovementId('space-elevator'),
  ];

  it('StartWork: the plan’s verdict is the applier’s, for every board and every kind', () => {
    for (const board of boards) {
      for (const kind of kinds) {
        const planned = planStartWork(board, RULESET, P0, asUnitId(3), kind);
        const applied = apply(board, P0, startWork(3, kind));

        expect(applied.ok).toBe(planned.ok);
        if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);
        if (applied.ok && planned.ok) {
          // The plan carries the tile, the kind and the count the state will hold.
          expect(workOf(applied.value.state, 3)).toStrictEqual({
            kind: planned.value.kind,
            tile: planned.value.tile,
            turnsLeft: planned.value.turnsLeft,
          });
        }
      }
    }
  });

  it('CancelWork: the plan’s verdict is the applier’s, on every board', () => {
    for (const board of boards) {
      const planned = planCancelWork(board, P0, asUnitId(3));
      const applied = apply(board, P0, cancelWork(3));

      expect(applied.ok).toBe(planned.ok);
      if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);
      if (applied.ok && planned.ok) expect(workOf(applied.value.state, 3)).toBeUndefined();
    }
  });

  it('is not vacuous: the boards above both accept and refuse, in both evaluators', () => {
    const startable = boards.filter(
      (board) => planStartWork(board, RULESET, P0, asUnitId(3), MINE.id).ok,
    );
    const unstartable = boards.filter(
      (board) => !planStartWork(board, RULESET, P0, asUnitId(3), MINE.id).ok,
    );
    const cancellable = boards.filter((board) => planCancelWork(board, P0, asUnitId(3)).ok);
    const uncancellable = boards.filter((board) => !planCancelWork(board, P0, asUnitId(3)).ok);

    // Both verdicts occur on both commands, so the agreement assertions above are
    // comparing real acceptances and real refusals rather than a constant.
    for (const group of [startable, unstartable, cancellable, uncancellable]) {
      expect(group.length).toBeGreaterThan(0);
    }
    expect(startable.length + unstartable.length).toBe(boards.length);
    expect(cancellable.length + uncancellable.length).toBe(boards.length);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — growth.ts: the food box
 * ------------------------------------------------------------------ */

describe('growth.ts — the food box', () => {
  it('pins the placeholder thresholds, and is not Civ IV’s formula', () => {
    // These are the contract's *placeholder* numbers: ours, chosen to be playable
    // (an early city grows in about five turns), not traced to Civ 3.
    expect(FOOD_BOX_BASE).toBe(10);
    expect(FOOD_BOX_PER_CITIZEN).toBe(5);
    expect(foodBoxSize(1)).toBe(10);
    expect(foodBoxSize(2)).toBe(15);
    expect(foodBoxSize(3)).toBe(20);
    expect(foodBoxSize(4)).toBe(25);

    // `20 + 2*pop` is Civ IV's city-growth rule — the trap INTERFACES.md's M3
    // provenance warning names — and it is explicitly not what this engine does.
    // Stated as the two constants it is made of as well as pointwise: the curves
    // happen to coincide at population 5 (10 + 5·4 = 30 = 20 + 2·5), so a test
    // that only sampled 5 would be checking nothing.
    expect(FOOD_BOX_BASE).not.toBe(20);
    expect(FOOD_BOX_PER_CITIZEN).not.toBe(2);
    expect(foodBoxSize(5)).toBe(20 + 2 * 5); // the one population where they agree
    for (const population of [1, 2, 3, 4, 6, 10]) {
      expect(foodBoxSize(population)).not.toBe(20 + 2 * population);
    }
  });

  it('is total: whole numbers for every input, never below the base', () => {
    for (const population of [0, -5, 2.7, Number.NaN, Number.POSITIVE_INFINITY]) {
      const size = foodBoxSize(population);
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThanOrEqual(FOOD_BOX_BASE);
    }
    expect(foodBoxSize(Number.NaN)).toBe(FOOD_BOX_BASE);
    expect(foodBoxSize(0)).toBe(FOOD_BOX_BASE);
  });

  it('adds the surplus, and carries the remainder over when a citizen is born', () => {
    // Population 1 on grassland working tile 4: 2 food from the centre plus 2 from
    // the tile, against 2 eaten = a surplus of 2.
    const board = withCities(STATE, [
      city(0, 0, 13, { population: 1, workedTiles: [asTileIndex(4)], foodBox: 9 }),
    ]);

    const outcome = applyGrowth(board, RULESET);
    const grown = cityOf(outcome.state, 0);

    expect(grown.population).toBe(2);
    // 9 + 2 = 11; the threshold was 10, so 1 carries over rather than resetting.
    expect(grown.foodBox).toBe(1);
    // The new citizen is assigned the best free tile — 5, the next grassland.
    expect(grown.workedTiles.map(Number)).toEqual([4, 5]);
    expect(outcome.events).toStrictEqual([
      { type: 'CityGrew', cityId: asCityId(0), owner: P0, population: 2, foodBox: 1 },
    ]);

    // Pure: the input keeps its box and its assignment.
    expect(cityOf(board, 0).foodBox).toBe(9);
    expect(cityOf(board, 0).workedTiles.map(Number)).toEqual([4]);
  });

  it('grows only when the box is full, and adds nothing on a zero surplus', () => {
    const nearly = withCities(STATE, [
      city(0, 0, 13, { population: 1, workedTiles: [asTileIndex(4)], foodBox: 7 }),
    ]);
    const first = applyGrowth(nearly, RULESET);
    expect(cityOf(first.state, 0).population).toBe(1);
    expect(cityOf(first.state, 0).foodBox).toBe(9); // 7 + 2, one short of 10
    expect(first.events).toEqual([]);

    // Two citizens on the same single tile: 4 food against 4 eaten is exactly 0,
    // which is "a surplus >= 0 never starves" — the box does not move.
    const steady = withCities(STATE, [
      city(0, 0, 13, { population: 2, workedTiles: [asTileIndex(4)], foodBox: 7 }),
    ]);
    const second = applyGrowth(steady, RULESET);
    expect(cityOf(second.state, 0).foodBox).toBe(7);
    expect(second.events).toEqual([]);
  });

  it('can grow more than once in a turn when the surplus is enormous', () => {
    // A box of 100 is not reachable through commands; it exists so the carry-over
    // loop's behaviour is pinned rather than assumed to stop after one citizen.
    const board = withCities(STATE, [
      city(0, 0, 13, { population: 1, workedTiles: [asTileIndex(4)], foodBox: 100 }),
    ]);

    const outcome = applyGrowth(board, RULESET);
    const grown = cityOf(outcome.state, 0);

    // 100 + 2 = 102, spent as 10, 15, 20, 25, 30 for populations 1..5, leaving 2.
    expect(grown.population).toBe(6);
    expect(grown.foodBox).toBe(2);
    // Each new citizen took the best tile still free: 5, 6, 8, 10, 11.
    expect(grown.workedTiles.map(Number)).toEqual([4, 5, 6, 8, 10, 11]);
    // One event per city per turn, carrying where the city came out — not one per
    // citizen (five events for one growth spurt would repeat the same story).
    expect(outcome.events).toStrictEqual([
      { type: 'CityGrew', cityId: asCityId(0), owner: P0, population: 6, foodBox: 2 },
    ]);
  });

  it('draws the box down on a deficit, and starves only when it would go below zero', () => {
    // Population 3 with one worked tile eats 6 and makes 4: a deficit of 2.
    const boardFor = (foodBox: number): GameState =>
      withCities(STATE, [
        city(0, 0, 13, { population: 3, workedTiles: [asTileIndex(4)], foodBox }),
      ]);

    // 3 - 2 = 1: the box is drawn down, no citizen is lost.
    const drawn = applyGrowth(boardFor(3), RULESET);
    expect(cityOf(drawn.state, 0).foodBox).toBe(1);
    expect(cityOf(drawn.state, 0).population).toBe(3);
    expect(drawn.events).toEqual([]);

    // 1 - 2 = -1: a citizen is lost, the box restarts at 0, and the assignment is
    // trimmed to the new population. Four citizens working four tiles (grassland,
    // hills, coast and a barren mountain) make 6 food against 8 eaten: a deficit
    // of 2, and the last-listed tile — the mountain — is the one given up.
    const starving = applyGrowth(
      withCities(STATE, [
        city(0, 0, 13, {
          population: 4,
          workedTiles: [asTileIndex(4), asTileIndex(9), asTileIndex(12), asTileIndex(15)],
          foodBox: 1,
        }),
      ]),
      RULESET,
    );
    const shrunk = cityOf(starving.state, 0);
    expect(shrunk.population).toBe(3);
    expect(shrunk.foodBox).toBe(0);
    expect(shrunk.workedTiles.map(Number)).toEqual([4, 9, 12]);
    expect(starving.events).toStrictEqual([
      { type: 'CityStarved', cityId: asCityId(0), owner: P0, population: 3, foodBox: 0 },
    ]);
  });

  it('never takes a city below population 1, however deep the deficit', () => {
    // A city on tile 2 (mountains) has a 1-food centre floor because mountain
    // terrain yields 0 food: 1 food against 2 eaten is a deficit of 1 every turn,
    // and there is no citizen left to lose — the box simply restarts at 0 each
    // turn, and the event says so.
    const board = withCities(STATE, [city(0, 0, 2, { population: 1 })]);

    const outcome = applyGrowth(board, RULESET);

    expect(cityOf(outcome.state, 0).population).toBe(1);
    expect(cityOf(outcome.state, 0).foodBox).toBe(0);
    expect(outcome.events).toStrictEqual([
      { type: 'CityStarved', cityId: asCityId(0), owner: P0, population: 1, foodBox: 0 },
    ]);
  });

  it('visits cities in city-id order, whatever order the array is in', () => {
    const first = city(0, 0, 13, { population: 1, workedTiles: [asTileIndex(4)], foodBox: 9 });
    const second = city(1, 1, 5, { population: 1, workedTiles: [asTileIndex(8)], foodBox: 9 });

    const forward = applyGrowth(withCities(STATE, [first, second]), RULESET);
    const reversed = applyGrowth(withCities(STATE, [second, first]), RULESET);

    // The events are emitted in city-id order either way, and each city grows the
    // same amount: the pass is a function of the state, not of array order.
    const orderOf = (state: GameState): readonly number[] =>
      applyGrowth(state, RULESET).events.map((event) =>
        event.type === 'CityGrew' ? Number(event.cityId) : -1,
      );
    expect(orderOf(withCities(STATE, [first, second]))).toEqual([0, 1]);
    expect(orderOf(withCities(STATE, [second, first]))).toEqual([0, 1]);
    expect(reversed.events).toStrictEqual(forward.events);
    for (const id of [0, 1]) {
      expect(cityOf(reversed.state, id).population).toBe(cityOf(forward.state, id).population);
      expect(cityOf(reversed.state, id).foodBox).toBe(cityOf(forward.state, id).foodBox);
    }
  });

  it('does not mutate its input', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, { population: 1, workedTiles: [asTileIndex(4)], foodBox: 9 }),
    ]);
    const frozen: GameState = structuredClone(board);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    applyGrowth(frozen, RULESET);
    expect(frozen).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — production.ts: shields, completion, placement
 * ------------------------------------------------------------------ */

describe('production.ts — shields and completion', () => {
  it('prices items from the catalogs, and says when it cannot price one', () => {
    expect(itemCost(RULESET, unitItem('warrior'))).toBe(WARRIOR.cost);
    expect(itemCost(RULESET, unitItem('settler'))).toBe(SETTLER.cost);
    expect(itemCost(RULESET, buildingItem('granary'))).toBe(GRANARY_COST);
    expect(itemCost(RULESET, buildingItem('library'))).toBe(LIBRARY_COST);

    // "Cannot be built by this ruleset" has no number: `itemCost` answers 0 (the
    // contract's plain `number`), and `itemCostOf` — the form the planner uses —
    // says so outright.
    expect(itemCost(RULESET, unitItem('spaceship'))).toBe(0);
    expect(itemCostOf(RULESET, unitItem('spaceship'))).toBeUndefined();
    expect(itemCostOf(RULESET, buildingItem('spaceship'))).toBeUndefined();

    // A cost that is not a usable number of shields is not a cost: fractional or
    // zero-cost rows are refused rather than banked or given away.
    const broken: RulesetView = {
      ...RULESET,
      units: [
        { ...WARRIOR, cost: 0 },
        { ...SCOUT, cost: 1.5 },
      ],
    };
    expect(itemCostOf(broken, unitItem('warrior'))).toBeUndefined();
    expect(itemCostOf(broken, unitItem('scout'))).toBeUndefined();
  });

  it('accumulates shields for a city that is building nothing', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, { population: 2, workedTiles: [asTileIndex(4)], shields: 3 }),
    ]);

    const outcome = applyProduction(board, RULESET);

    // Centre (1 shield) + tile 4 (1 shield) = 2 a turn, and nothing spends it.
    expect(cityOf(outcome.state, 0).shields).toBe(5);
    expect(outcome.events).toEqual([]);
  });

  it('completes an item, carries the remainder, and promotes the next queue entry', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, {
        population: 2,
        workedTiles: [asTileIndex(4)],
        shields: 5,
        production: unitItem('scout'),
        queue: [buildingItem('granary')],
      }),
    ]);

    const outcome = applyProduction(board, RULESET);
    const assigned = cityOf(outcome.state, 0);

    // 5 + 2 shields = 7; the scout costs 2, so 5 stays stored for the granary.
    expect(assigned.shields).toBe(5);
    expect(assigned.production).toEqual(buildingItem('granary'));
    expect(assigned.queue).toEqual([]);
    expect(outcome.events).toStrictEqual([
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: P0,
        item: unitItem('scout'),
        shields: 5,
        unitId: asUnitId(3),
        tile: asTileIndex(13),
      },
    ]);
  });

  it('places a produced unit on the city centre, at full movement, with a fresh id', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        shields: 2,
        production: unitItem('scout'),
      }),
    ]);

    const outcome = applyProduction(board, RULESET);
    const spawned = outcome.state.units.find((u) => u.id === asUnitId(3));

    expect(spawned).toStrictEqual({
      id: asUnitId(3),
      type: SCOUT.id,
      owner: P0,
      tile: asTileIndex(13),
      movementLeft: SCOUT.movement,
      // M6: a unit leaves the slipway at full health, and a row that declares no
      // `hitPoints` (this fixture's every military row) is one point
      // (`fullHitPoints`).
      hitPointsLeft: fullHitPoints(SCOUT),
    });
    expect(outcome.state.nextUnitId).toBe(4);
    // Units stay sorted by id, and nothing else about them moved.
    expect(outcome.state.units.map((u) => Number(u.id))).toEqual([0, 1, 2, 3]);
  });

  it('falls back to the first free adjacent tile when another player holds the centre', () => {
    // Only reachable from a hand-built state: through the command layer a unit
    // cannot enter an enemy-occupied tile, so nothing can stand on a foreign city
    // centre. The function still has to be total, and the fallback is the first
    // adjacent tile in ascending index order that holds no enemy unit.
    const board = withCities(
      { ...STATE, nextUnitId: 4, units: [...STATE.units, unit(3, WARRIOR, 1, 13, 0)] },
      [
        city(0, 0, 13, {
          population: 1,
          workedTiles: [asTileIndex(4)],
          shields: 2,
          production: unitItem('scout'),
        }),
      ],
    );

    const outcome = applyProduction(board, RULESET);
    const spawned = outcome.state.units.find((u) => u.id === asUnitId(4));

    // Neighbours of 13 are 8, 9, 10, 12, 14, 15: 8 is the first.
    expect(spawned?.tile).toBe(asTileIndex(8));
    expect(spawned?.movementLeft).toBe(SCOUT.movement);
    // The blocker is untouched.
    expect(outcome.state.units.find((u) => u.id === asUnitId(3))?.tile).toBe(asTileIndex(13));
  });

  it('adds a completed building to `buildings`, and never completes one twice', () => {
    const ready = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        shields: 9,
        production: buildingItem('granary'),
      }),
    ]);

    const built = applyProduction(ready, RULESET);
    expect(cityOf(built.state, 0).buildings).toEqual([asBuildingId('granary')]);
    expect(cityOf(built.state, 0).shields).toBe(1); // 9 + 2 = 11, minus 10
    expect(cityOf(built.state, 0).production).toBeUndefined();
    expect(built.events).toStrictEqual([
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: P0,
        item: buildingItem('granary'),
        shields: 1,
      },
    ]);

    // A second entry for a building the city already has is dropped, and *nothing
    // is charged*: no item was produced, so taking its cost would burn shields on
    // a no-op. (Through `SetProduction` this state is unreachable — a duplicate is
    // refused as `already-built` — this keeps the pass total.)
    const redundant = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        shields: 50,
        buildings: [asBuildingId('granary')],
        production: buildingItem('granary'),
        queue: [buildingItem('library')],
      }),
    ]);

    const dropped = applyProduction(redundant, RULESET);
    expect(cityOf(dropped.state, 0).shields).toBe(52);
    expect(cityOf(dropped.state, 0).buildings).toEqual([asBuildingId('granary')]);
    expect(cityOf(dropped.state, 0).production).toEqual(buildingItem('library'));
    expect(dropped.events).toEqual([]);
  });

  it('never completes an item the ruleset cannot price, and banks the shields', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        shields: 100,
        production: unitItem('spaceship'),
      }),
    ]);

    const outcome = applyProduction(board, RULESET);

    expect(cityOf(outcome.state, 0).shields).toBe(102);
    expect(cityOf(outcome.state, 0).production).toEqual(unitItem('spaceship'));
    expect(outcome.state.units).toHaveLength(STATE.units.length);
    expect(outcome.events).toEqual([]);
  });

  it('works through cities in city-id order, whatever order the array is in', () => {
    const first = city(0, 0, 13, {
      population: 1,
      workedTiles: [asTileIndex(4)],
      shields: 1,
      production: unitItem('scout'),
    });
    const second = city(1, 1, 5, {
      population: 1,
      workedTiles: [asTileIndex(8)],
      shields: 1,
      production: unitItem('warrior'),
    });

    const forward = applyProduction(withCities(STATE, [first, second]), RULESET);
    const reversed = applyProduction(withCities(STATE, [second, first]), RULESET);

    const producedCities = (events: readonly GameEvent[]): readonly number[] =>
      events.map((event) => (event.type === 'CityProduced' ? Number(event.cityId) : -1));

    expect(producedCities(forward.events)).toEqual([0, 1]);
    expect(producedCities(reversed.events)).toEqual([0, 1]);

    // Unit ids follow creation order, which follows city-id order — not the order
    // the cities happen to be stored in.
    const ownerOf = (state: GameState, id: number): PlayerId | undefined =>
      state.units.find((u) => u.id === asUnitId(id))?.owner;
    expect(ownerOf(forward.state, 3)).toBe(P0);
    expect(ownerOf(forward.state, 4)).toBe(P1);
    expect(ownerOf(reversed.state, 3)).toBe(P0);
    expect(ownerOf(reversed.state, 4)).toBe(P1);
  });

  it('does not mutate its input', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        shields: 2,
        production: unitItem('scout'),
      }),
    ]);
    const frozen: GameState = structuredClone(board);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    applyProduction(frozen, RULESET);
    expect(frozen).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — turn.ts: the single definition of a turn
 * ------------------------------------------------------------------ */

describe('turn.ts — the single definition of a turn', () => {
  /**
   * The M4a order board: player 0's city on the hills at 9, population 2, working
   * the hills at 1 (where the worker stands) and the grassland at 4, building
   * nothing.
   *
   * Its numbers, from the fixture's terrain rows:
   *
   * - food: centre 1 (hills, floored at 1) + 1 (tile 1) + 2 (tile 4) = 4, against
   *   2·2 = 4 eaten — a surplus of 0, so the city neither grows nor starves and the
   *   growth step contributes no event and no yield change. That quietness is what
   *   makes the *work* step's effect the only thing moving in the assertions below.
   * - shields: centre 2 (hills) + 2 (tile 1) + 1 (tile 4) = 5, and 6 once the mine
   *   on tile 1 is built — the single shield that tells the two orders apart.
   */
  const ORDER_BOARD: GameState = withCities(WORK_STATE, [
    city(0, 0, 9, {
      population: 2,
      workedTiles: [asTileIndex(WORKER_TILE), asTileIndex(4)],
    }),
  ]);

  it('runs work, then growth, then production, then the refill, then turn += 1 — in that order', () => {
    // One board that makes every step of the order observable, M4a's step included.
    //
    // Work first: the worker on tile 1 owes its last turn of a mine, so the mine is
    // built *before* anything counts yields. Growth second: population 1 with a box
    // of 8 grows to 2 on a surplus of 2, and the new citizen is assigned tile 5, so
    // the city's shields for this turn are 1 (centre) + 1 (tile 4) + 1 (tile 5) =
    // 3. Production third: 1 stored + 3 = 4 buys the 2-shield scout and leaves 2.
    //
    // Had production run before growth it would have seen 1 + 2 = 3 and left 1; had
    // work run after growth and production the mine's shield would arrive a turn
    // late. The leftovers are the fingerprint of the order.
    const board = withUnits(
      withCities(STATE, [
        city(0, 0, 13, {
          population: 1,
          workedTiles: [asTileIndex(4)],
          foodBox: 8,
          shields: 1,
          production: unitItem('scout'),
        }),
      ]),
      [...STATE.units, withWork(worker(WORKER.movement), mineWork(1))],
    );

    const outcome = advanceTurn(board, RULESET);
    const assigned = cityOf(outcome.state, 0);

    expect(assigned.population).toBe(2);
    expect(assigned.foodBox).toBe(0);
    expect(assigned.shields).toBe(2);
    expect(assigned.production).toBeUndefined();
    expect(assigned.workedTiles.map(Number)).toEqual([4, 5]);

    // The job finished and the mine is on the map — added by step 1, before the
    // growth and production that just consumed it.
    expect(workOf(outcome.state, 3)).toBeUndefined();
    expect(outcome.state.improvements).toStrictEqual([{ tile: asTileIndex(1), kind: MINE.id }]);

    // Movement is refilled for every unit, the produced one included.
    expect(outcome.state.units.map((u) => u.movementLeft)).toEqual([
      SETTLER.movement,
      SCOUT.movement,
      WARRIOR.movement,
      WORKER.movement,
      SCOUT.movement,
    ]);
    expect(outcome.state.turn).toBe(board.turn + 1);

    // Events follow the pipeline: work, then growth, then production, then the
    // money loop — whose two pairs sit last, after the unit the city just built is
    // already on the board (four units, and the income of a three-commerce city at
    // the default 6/4/0 rates: two gold and one beaker, the remainder to gold).
    expect(outcome.events).toStrictEqual([
      {
        type: 'WorkCompleted',
        unitId: asUnitId(3),
        kind: MINE.id,
        tile: asTileIndex(1),
      },
      { type: 'CityGrew', cityId: asCityId(0), owner: P0, population: 2, foodBox: 0 },
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: P0,
        item: unitItem('scout'),
        shields: 2,
        unitId: asUnitId(4),
        tile: asTileIndex(13),
      },
      ...ledger(0, [2, 1, 0], [0, 0, 0, 4, 6]),
      ...idleLedger(1, 1),
    ]);
  });

  it('pays a finished improvement into this turn’s yields — the reason work is step 1', () => {
    const completing = digging(ORDER_BOARD, mineWork(1));
    const outcome = advanceTurn(completing, RULESET);

    // The mine is on tile 1, it is built, and the city that works that tile counts
    // its shield *this* turn: centre 2 + hills 2 + mine 1 + grassland 1 = 6. With
    // growth and production running first (the order this contract rejects) the same
    // board would store 5 and the mine would pay out a turn late — so 6 is not a
    // detail, it is the order.
    expect(outcome.state.improvements).toStrictEqual([{ tile: asTileIndex(1), kind: MINE.id }]);
    expect(hasImprovement(outcome.state, asTileIndex(1), MINE.id)).toBe(true);
    expect(cityOf(outcome.state, 0).shields).toBe(6);

    expect(outcome.events).toStrictEqual([
      { type: 'WorkCompleted', unitId: asUnitId(3), kind: MINE.id, tile: asTileIndex(1) },
      // The city's commerce is unchanged by the work step (a mine adds shields), so
      // the ledger is the same three-commerce split as the order board's.
      ...ledger(0, [2, 1, 0], [0, 0, 0, 3, 6]),
      ...idleLedger(1, 1),
    ]);

    // The worker is idle again and refilled, so it can start the next job next turn
    // (or this turn, if its owner ends the turn and moves again).
    expect(workOf(outcome.state, 3)).toBeUndefined();
    expect(movementLeftOf(outcome.state, 3)).toBe(WORKER.movement);
    expect(outcome.state.turn).toBe(completing.turn + 1);
  });

  it('leaves a job that still owes a turn alone, and its improvement is not in this turn’s yields', () => {
    const pending = digging(ORDER_BOARD, mineWork(2));
    const outcome = advanceTurn(pending, RULESET);

    // The counterfactual to the test above, one turn of work short: nothing
    // completes, nothing is built, and the city stores one shield less. The only
    // events are the money loop's — which is the point: a step that changes nothing
    // says nothing, and the *ledger* still reports both civilizations.
    expect(outcome.events).toEqual([...ledger(0, [2, 1, 0], [0, 0, 0, 3, 6]), ...idleLedger(1, 1)]);
    expect(workOf(outcome.state, 3)).toStrictEqual({
      kind: MINE.id,
      tile: asTileIndex(WORKER_TILE),
      turnsLeft: 1,
    });
    expect(outcome.state.improvements).toEqual([]);
    expect(cityOf(outcome.state, 0).shields).toBe(5);
    expect(outcome.state.turn).toBe(pending.turn + 1);
  });

  it('pays jobs in unit-id order, whatever order the units array is in', () => {
    // Two workers finish on this turn. Unit 4's irrigation is on the *lower* tile
    // index and a shorter job, so an implementation that walked the array or sorted
    // by tile would report a different order — the contract names unit id.
    const board = digging(
      withUnits(ORDER_BOARD, [
        ...ORDER_BOARD.units,
        withWork(unit(4, WORKER, 0, 4, 1), {
          kind: IRRIGATION.id,
          tile: asTileIndex(4),
          turnsLeft: 1,
        }),
      ]),
      mineWork(1),
    );
    const reversed: GameState = { ...board, units: [...board.units].reverse() };

    const outcome = advanceTurn(reversed, RULESET);

    expect(
      outcome.events.flatMap((event) =>
        event.type === 'WorkCompleted' ? [Number(event.unitId)] : [],
      ),
    ).toEqual([3, 4]);
    // Work first, then the ledger — the money loop never runs in the middle of
    // another step.
    expect(outcome.events.map((event) => event.type)).toEqual([
      'WorkCompleted',
      'WorkCompleted',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
    ]);
    expect(outcome.events.slice(2)).toStrictEqual([
      ...ledger(0, [2, 1, 0], [0, 0, 0, 4, 6]),
      ...idleLedger(1, 1),
    ]);
    // Both improvements landed, in the state's own `(tile, kind)` order rather than
    // in completion order — the hash must be a function of the pairs, not of who
    // finished first.
    expect(outcome.state.improvements).toStrictEqual([
      { tile: asTileIndex(1), kind: MINE.id },
      { tile: asTileIndex(4), kind: IRRIGATION.id },
    ]);
    // And the units array comes back sorted by id, as the state invariant requires.
    expect(outcome.state.units.map((u) => Number(u.id))).toEqual([0, 1, 2, 3, 4]);
  });

  it('is total: a job completes however its unit’s type or its kind is described', () => {
    // A worker whose type the ruleset does not define still owes its turns and still
    // pays the last one: a job is a property of the *unit*, not of its catalog row,
    // and the refill's totality (M2) has the same shape. The pair is recorded even
    // though no row describes the kind, because the state says what was built — the
    // catalog only says what it yields.
    const ghost = makeDef('ghost-worker', 'worker', 1, 2);
    const board = withUnits(STATE, [
      withWork(unit(3, ghost, 0, WORKER_TILE, 0), { ...mineWork(1), kind: IRRIGATION.id }),
    ]);

    const outcome = advanceTurn(board, RULESET);

    expect(outcome.events).toStrictEqual([
      { type: 'WorkCompleted', unitId: asUnitId(3), kind: IRRIGATION.id, tile: asTileIndex(1) },
      // This board holds one unit — the ghost — and no cities, so nothing is owed
      // and nothing is collected. The pair is still emitted, with zeros.
      ...idleLedger(0, 1),
      ...idleLedger(1, 0),
    ]);
    expect(outcome.state.improvements).toStrictEqual([
      { tile: asTileIndex(1), kind: IRRIGATION.id },
    ]);
    expect(workOf(outcome.state, 3)).toBeUndefined();
    // Its movement is left alone, for the reason the refill is total.
    expect(movementLeftOf(outcome.state, 3)).toBe(0);
    expect(outcome.state.turn).toBe(board.turn + 1);
    expect(() => canonicalize(outcome.state)).not.toThrow();
  });

  it('treats a job whose count is not a positive whole number as due, and never writes one back', () => {
    // `planStartWork` refuses a catalog row with an unusable count, so the engine
    // never creates such a job; a hand-built state can still carry one, and the
    // pipeline must not copy a NaN or a fraction into the state it returns (that
    // would make the state unhashable). Such a job finishes this turn instead.
    for (const turnsLeft of [0, -2, 0.5, Number.NaN]) {
      const board = withUnits(STATE, [
        withWork(worker(1), { kind: MINE.id, tile: asTileIndex(WORKER_TILE), turnsLeft }),
      ]);

      const outcome = advanceTurn(board, RULESET);

      expect(workOf(outcome.state, 3)).toBeUndefined();
      expect(outcome.state.improvements).toStrictEqual([{ tile: asTileIndex(1), kind: MINE.id }]);
      expect(() => canonicalize(outcome.state)).not.toThrow();
      expect(hashValue(outcome.state)).toBe(hashValue(advanceTurn(board, RULESET).state));
    }
  });

  it('does not touch revision: a turn is part of a command, and the command counts it', () => {
    const outcome = advanceTurn(STATE, RULESET);
    expect(outcome.state.revision).toBe(STATE.revision);
    expect(outcome.state.turn).toBe(STATE.turn + 1);
  });

  it('carries over a job that names a tile which is not a whole index, rather than inventing one', () => {
    // `planStartWork` requires the unit's tile to be a whole index on the map, so no
    // command can create this job; a hand-built state can. Completion writes the pair
    // into `state.improvements`, and the pipeline must not put a tile nothing could
    // stand on into the state — nor silently drop the job, which is what a
    // cancellation looks like. So the worker keeps its job, exactly as it was.
    const job: UnitWork = { kind: MINE.id, tile: asTileIndex(1.5), turnsLeft: 1 };
    const board = withUnits(STATE, [withWork(worker(1), job)]);

    const outcome = advanceTurn(board, RULESET);

    expect(outcome.events).toEqual([...idleLedger(0, 1), ...idleLedger(1, 0)]);
    expect(workOf(outcome.state, 3)).toStrictEqual(job);
    expect(outcome.state.improvements).toEqual([]);
    expect(outcome.state.turn).toBe(board.turn + 1);
  });

  it('is exactly what EndTurn does — plus the actor’s event and one revision bump', () => {
    // "`EndTurn` calls it and nothing else may reimplement the order": the applied
    // command is the pipeline's state, one revision higher, with `TurnEnded`
    // appended. If `EndTurn` ever grew a step of its own, this equality would fail.
    const board = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        foodBox: 9,
        shields: 2,
        production: unitItem('scout'),
      }),
    ]);

    const pipeline = advanceTurn(board, RULESET);
    const applied = mustOk(apply(board, P0, END_TURN));

    expect(applied.state).toStrictEqual({ ...pipeline.state, revision: board.revision + 1 });
    expect(applied.events).toStrictEqual([
      ...pipeline.events,
      { type: 'TurnEnded', playerId: P0, turn: pipeline.state.turn },
    ]);
  });

  it('is total: an unresolvable unit type neither blocks the turn nor gains movement', () => {
    const ghost = { ...SETTLER, id: asUnitTypeId('ghost') };
    const board: GameState = {
      ...STATE,
      nextUnitId: 2,
      units: [unit(0, ghost, 0, 5, 0), unit(1, SCOUT, 0, 10, 1)],
    };

    const outcome = advanceTurn(board, RULESET);

    expect(outcome.state.turn).toBe(board.turn + 1);
    expect(outcome.state.units.map((u) => u.movementLeft)).toEqual([0, SCOUT.movement]);
  });

  it('does not mutate its input', () => {
    const board = withCities(STATE, [
      city(0, 0, 13, { population: 1, workedTiles: [asTileIndex(4)], foodBox: 9 }),
    ]);
    const frozen: GameState = structuredClone(board);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    advanceTurn(frozen, RULESET);
    expect(frozen).toEqual(snapshot);
  });

  it('grows a newly founded city on the fifth turn, to the exact box', () => {
    // The M3 acceptance's "growth-timing" property, through the command layer
    // alone: found the city, end turns, and check the turn it grows. A brand-new
    // city at population 1 on this grassland makes 2 food a turn against 2 eaten,
    // so the 10-food box fills after five turns and the remainder carries over.
    let state = mustOk(apply(STATE, P0, foundCity(0))).state;

    for (let turn = 0; turn < 4; turn += 1) {
      state = mustOk(apply(state, P0, END_TURN)).state;
      expect(cityOf(state, 0).population).toBe(1);
    }
    expect(cityOf(state, 0).foodBox).toBe(8);

    state = mustOk(apply(state, P0, END_TURN)).state;

    expect(cityOf(state, 0).population).toBe(2);
    expect(cityOf(state, 0).foodBox).toBe(0);
    expect(state.turn).toBe(STATE.turn + 5);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — units.ts: spawnUnit
 * ------------------------------------------------------------------ */

describe('units.ts — spawnUnit', () => {
  it('appends a unit with the state’s next id, at full movement, and advances it', () => {
    const spawned = spawnUnit(STATE, SCOUT, P0, asTileIndex(8));

    expect(spawned.unit).toStrictEqual({
      id: asUnitId(STATE.nextUnitId),
      type: SCOUT.id,
      owner: P0,
      tile: asTileIndex(8),
      movementLeft: SCOUT.movement,
      // M6: "full movement" comes with full hit points, and `hitPointsLeft` is written
      // rather than left absent, so a spawned unit is complete on arrival.
      hitPointsLeft: fullHitPoints(SCOUT),
    });
    expect(spawned.state.nextUnitId).toBe(STATE.nextUnitId + 1);
    expect(spawned.state.units).toHaveLength(STATE.units.length + 1);
    // Sorted by id, and it does not touch anything a command layer owns.
    expect(spawned.state.units.map((u) => Number(u.id))).toEqual([0, 1, 2, 3]);
    expect(spawned.state.revision).toBe(STATE.revision);
    expect(spawned.state.turn).toBe(STATE.turn);
    expect(spawned.state.rng).toBe(STATE.rng);
    expect(spawned.state.cities).toBe(STATE.cities);
  });

  it('never hands out an id the state already uses, even from a stale counter', () => {
    // `nextUnitId` is monotonic on every state the engine builds; a hand-built one
    // (or an edited save) can carry a stale counter, and reusing an id would make
    // two units indistinguishable to every lookup.
    const stale: GameState = { ...STATE, nextUnitId: 0 };
    const spawned = spawnUnit(stale, SCOUT, P0, asTileIndex(8));

    expect(spawned.unit.id).toBe(asUnitId(3)); // one past the highest id (2)
    expect(new Set(spawned.state.units.map((u) => Number(u.id))).size).toBe(4);
  });

  it('grants no movement when the definition’s movement is not a usable number', () => {
    for (const movement of [Number.NaN, 0, -1, 1.5]) {
      const spawned = spawnUnit(STATE, { ...SCOUT, movement }, P0, asTileIndex(8));
      expect(spawned.unit.movementLeft).toBe(0);
      expect(Number.isInteger(spawned.unit.movementLeft)).toBe(true);
    }
  });

  it('does not mutate the state it was handed', () => {
    const frozen: GameState = structuredClone(STATE);
    const snapshot = structuredClone(frozen);
    deepFreeze(frozen);

    expect(() => spawnUnit(frozen, SCOUT, P0, asTileIndex(8))).not.toThrow();
    expect(frozen).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — hut.ts through the command layer: MoveUnit consumes a hut
 * ------------------------------------------------------------------ */

/**
 * `state` with goody huts on the map (M3's `GameMap.huts`, ascending tile index).
 * `MAP` itself carries none, so every other test in this file is unchanged by the
 * hut rule — which is worth stating: a move onto a hut-free tile emits exactly the
 * events it always did.
 */
const withHuts = (state: GameState, huts: readonly number[]): GameState => ({
  ...state,
  map: { ...state.map, huts: huts.map((tile) => asTileIndex(tile)) },
});

/**
 * The board the hut tests move on: `STATE` plus the barbarian player `newGame`
 * appends (M3 — a player identity whose `startingTile` is the hut the band comes
 * out of), with a hut on tile 4, the grassland west of the settler's tile 5.
 *
 * The band's tiles are therefore 1 and 5 (`1, 5, 8, 9` minus tile 5, which the
 * settler has just left): 0 is ocean, 2 is mountains, and 6 and 10 hold another
 * player's units.
 */
const HUT_TILE = 4;
const HUT_STATE: GameState = withHuts(
  {
    ...STATE,
    players: [player(0, 5), player(1, 6), player(2, HUT_TILE, 'barbarian')],
    explored: [UNSEEN, UNSEEN, UNSEEN],
  },
  [HUT_TILE],
);

/**
 * An RNG state whose first hut draw selects `unit` rather than `barbarians`:
 * `seedRng(1)`'s first `nextBelow(rng, 3)` is 0. Spelled out as a helper with the
 * assertion in the test below, so the fixture cannot quietly stop meaning that.
 */
const HUT_UNIT_RNG = seedRng(1);

/** The barbarian player on the hut board. */
const BARBARIANS = asPlayerId(2);

describe('applyCommand — M3 goody huts', () => {
  it('consumes a hut the mover enters, and says so in the move’s own events', () => {
    const outcome = mustOk(apply(HUT_STATE, P0, move(0, HUT_TILE)));

    // The move first, then the hut it entered, then the band that came out of it:
    // the order in which they happened. The draw from `STATE.rng` (a=1,b=2,c=3,d=4)
    // is 1, and `HUT_REWARD_KINDS[1]` is `barbarians`.
    expect(outcome.events).toStrictEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: asTileIndex(5),
        to: asTileIndex(HUT_TILE),
        cost: 1,
        movementLeft: 1,
      },
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: P0,
        tile: asTileIndex(HUT_TILE),
        reward: 'barbarians',
      },
      {
        type: 'BarbariansSpawned',
        owner: BARBARIANS,
        tile: asTileIndex(HUT_TILE),
        unitIds: [asUnitId(3), asUnitId(4)],
        tiles: [asTileIndex(1), asTileIndex(5)],
      },
    ]);

    // The hut is off the map and the mover is on the tile it stood on.
    expect(outcome.state.map.huts).toEqual([]);
    expect(tileOf(outcome.state, 0)).toBe(HUT_TILE);
    // The band are ordinary units of an ordinary player: barbarians, on land tiles
    // next to the hut, at full movement and full health, and the ids continue the
    // state's sequence.
    expect(outcome.state.nextUnitId).toBe(5);
    expect(outcome.state.units.slice(3)).toStrictEqual([
      freshUnit(3, WARRIOR, 2, 1, WARRIOR.movement),
      freshUnit(4, WARRIOR, 2, 5, WARRIOR.movement),
    ]);

    // The input is untouched — map, RNG and unit list alike.
    expect(HUT_STATE.map.huts).toEqual([asTileIndex(HUT_TILE)]);
    expect(HUT_STATE.rng).toStrictEqual({ a: 1, b: 2, c: 3, d: 4 });
    expect(HUT_STATE.units).toHaveLength(3);
  });

  it('gives a free unit on the draw that says unit, beside the mover on the hut tile', () => {
    const state: GameState = { ...HUT_STATE, rng: HUT_UNIT_RNG };
    expect(nextBelow(HUT_UNIT_RNG, HUT_REWARD_KINDS.length)[0]).toBe(0);
    expect(HUT_REWARD_KINDS[0]).toBe('unit');

    const outcome = mustOk(apply(state, P0, move(0, HUT_TILE)));

    expect(outcome.events).toStrictEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: asTileIndex(5),
        to: asTileIndex(HUT_TILE),
        cost: 1,
        movementLeft: 1,
      },
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: P0,
        tile: asTileIndex(HUT_TILE),
        reward: 'unit',
        unitGiven: asUnitId(3),
      },
    ]);

    // The first `military`-role land row of the catalog is the free unit, and it
    // stands on the hut tile with the mover: M2 lets one player's units stack.
    expect(outcome.state.units.slice(2)).toStrictEqual([
      unit(2, WARRIOR, 1, 6, 0),
      freshUnit(3, WARRIOR, 0, HUT_TILE, WARRIOR.movement),
    ]);
    expect(
      outcome.state.units.filter((candidate) => candidate.tile === asTileIndex(HUT_TILE)),
    ).toHaveLength(2);
  });

  it('leaves a hut the mover does not enter alone, and draws nothing for it', () => {
    const state = withHuts(HUT_STATE, [9]);

    const outcome = mustOk(apply(state, P0, move(0, HUT_TILE)));

    // Only the move: the hut on 9 is not on the path, and nothing drew from the RNG.
    expect(outcome.events.map((event) => event.type)).toEqual(['UnitMoved']);
    expect(outcome.state.map.huts).toEqual([asTileIndex(9)]);
    expect(outcome.state.rng).toStrictEqual(state.rng);
    expect(outcome.state.units).toHaveLength(3);
  });

  it('never lets a sea unit or a city consume a hut', () => {
    // A galley is a unit the ruleset describes, with a domain of its own: M2's
    // movement rule does not look at domains (M4 owns them), so the step onto the
    // hut tile is legal and the *hut* is what must refuse.
    const GALLEY: UnitDef = { ...makeDef('galley', 'military', 3, 2), domain: 'sea' };
    const NAVAL: RulesetView = { ...RULESET, units: [...RULESET.units, GALLEY] };
    const atSea: GameState = {
      ...HUT_STATE,
      units: [unit(0, GALLEY, 0, 5, GALLEY.movement), ...HUT_STATE.units.slice(1)],
    };

    const sailed = mustOk(apply(atSea, P0, move(0, HUT_TILE), NAVAL));
    expect(sailed.events.map((event) => event.type)).toEqual(['UnitMoved']);
    expect(sailed.state.map.huts).toEqual([asTileIndex(HUT_TILE)]);
    expect(sailed.state.rng).toStrictEqual(HUT_STATE.rng);

    // A city on the hut tile consumes it permanently instead: the tile can still
    // be walked into, and still gives nothing.
    const capitalised = withCities(HUT_STATE, [
      city(0, 0, HUT_TILE, { population: 2, workedTiles: [asTileIndex(5)] }),
    ]);
    const arrived = mustOk(apply(capitalised, P0, move(0, HUT_TILE)));

    expect(arrived.events.map((event) => event.type)).toEqual(['UnitMoved']);
    expect(arrived.state.map.huts).toEqual([asTileIndex(HUT_TILE)]);
    expect(arrived.state.rng).toStrictEqual(HUT_STATE.rng);
    // The move itself still folded the mover's sight into its explored row.
    expect(exploredIndices(arrived.state.explored[0])).toContain(HUT_TILE);
  });

  it('is one applied command that is reproducible and stays hashable', () => {
    const first = mustOk(apply(HUT_STATE, P0, move(0, HUT_TILE)));
    const second = mustOk(apply(HUT_STATE, P0, move(0, HUT_TILE)));

    // One bump for one command, even though it emitted three events and changed
    // the map, the RNG and the unit list: `revision` counts applied commands.
    expect(first.state.revision).toBe(HUT_STATE.revision + 1);
    expect(first.state.turn).toBe(HUT_STATE.turn);
    // Same state in, same state out — including the reward the RNG chose.
    expect(second.state).toStrictEqual(first.state);
    expect(second.events).toStrictEqual(first.events);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    // A consumed hut, a spawned band and an advanced RNG are all part of the
    // persisted shape, so the hash must move and the state must still canonicalize.
    expect(hashValue(first.state)).not.toBe(hashValue(HUT_STATE));
    expect(() => canonicalize(first.state)).not.toThrow();
  });

  it('never mutates a deeply frozen hut board', () => {
    const board: GameState = structuredClone(HUT_STATE);
    const snapshot = structuredClone(board);
    deepFreeze(board);

    const outcome = mustOk(apply(board, P0, move(0, HUT_TILE)));

    expect(outcome.state.map.huts).toEqual([]);
    expect(board).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M3 — purity of the new commands together
 * ------------------------------------------------------------------ */

describe('applyCommand — M3 purity and revision', () => {
  it('never mutates a deeply frozen state, and bumps revision exactly once per command', () => {
    const board: GameState = structuredClone(WORK_CITY_STATE);
    const snapshot = structuredClone(board);
    deepFreeze(board);

    const founding = withCities(board, []);
    /** Each command with the board it is legal on, so every one of them applies. */
    const commands: readonly (readonly [Command, GameState])[] = [
      [foundCity(0), founding],
      [setWorkedTiles(0, [4, 8]), board],
      [setProduction(0, unitItem('warrior')), board],
      // M4a: attaching a job and, on the board where one exists, dropping it.
      [startWork(3, 'mine'), board],
      [cancelWork(3), digging(board, mineWork(2))],
      [END_TURN, board],
    ];

    for (const [cmd, target] of commands) {
      const outcome = mustOk(apply(target, P0, cmd));
      expect(outcome.state).not.toBe(target);
      expect(outcome.state.revision).toBe(target.revision + 1);
    }

    expect(board).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * M5 — SetResearch
 * ------------------------------------------------------------------ */

/** The command under test, spelled once. */
const setResearch = (tech: string): Command => ({ type: 'SetResearch', tech: asTechId(tech) });

/** `STATE` with one player's tech list and beaker pool set, for the M5 sections. */
const researching = (
  state: GameState,
  index: number,
  overrides: Partial<PlayerState>,
): GameState => ({
  ...state,
  players: state.players.map((each) =>
    each.id === asPlayerId(index) ? { ...each, ...overrides } : each,
  ),
});

describe('applyCommand — SetResearch', () => {
  it('stores the choice and touches nothing else', () => {
    const outcome = mustOk(apply(STATE, P0, setResearch('pottery')));
    const after = playerOf(outcome.state, 0);

    expect(researchingOf(after)).toBe('pottery');
    // The key is *present*: a selection is a real value, and only "not researching"
    // is an absent key.
    expect(Object.hasOwn(after, 'researching')).toBe(true);
    // Nothing else moves. `techs` grows when a tech *completes* (the pipeline's job),
    // never when it is selected, and the beaker pool is untouched — choosing what to
    // research is not progress toward it.
    expect([...after.techs]).toEqual([]);
    expect(after.beakers).toBe(playerOf(STATE, 0).beakers);
    expect(after.treasury).toBe(playerOf(STATE, 0).treasury);
    expect(after.rates).toEqual(playerOf(STATE, 0).rates);
    expect(after.luxuries).toBe(playerOf(STATE, 0).luxuries);
    // The other player is not the actor and is not touched.
    expect(playerOf(outcome.state, 1)).toBe(playerOf(STATE, 1));
    expect(outcome.state.units).toBe(STATE.units);
    expect(outcome.state.cities).toBe(STATE.cities);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    // No event: M3's setter precedent. The `TechResearched` event belongs to the
    // pipeline step that finishes a tech, not to the command that selects one.
    expect(outcome.events).toEqual([]);
  });

  it('is idempotent: selecting the tech a player is already researching is legal', () => {
    // Like `SetRates`, and unlike a "no-op" refusal: a UI's confirm button must not
    // be wrong because the choice was already made. It is still a command, so it
    // still costs a revision.
    const once = mustOk(apply(STATE, P0, setResearch('pottery')));
    const twice = mustOk(apply(once.state, P0, setResearch('pottery')));

    expect(researchingOf(playerOf(twice.state, 0))).toBe('pottery');
    expect(twice.state.revision).toBe(once.state.revision + 1);
  });

  it('overwrites a selection that can no longer be researched, without reading it', () => {
    // The player is never trapped by a stale or impossible choice: the applier writes
    // the new tech and does not consult the old one at all. (Which is why
    // `applyResearch` can afford to *report* a stuck selection rather than repair it.)
    const stuck = researching(STATE, 0, { researching: asTechId('literature') });
    const outcome = mustOk(apply(stuck, P0, setResearch('pottery')));

    expect(researchingOf(playerOf(outcome.state, 0))).toBe('pottery');
  });

  it('refuses a tech this ruleset does not define', () => {
    expect(refusedAs(apply(STATE, P0, setResearch('mithril')), 'unknown-tech')).toEqual({
      kind: 'unknown-tech',
      tech: 'mithril',
    });
    // The refusal is a *decision*, not a mutation: the state is exactly as it was.
    expect(STATE.revision).toBe(0);
    expect(researchingOf(playerOf(STATE, 0))).toBeUndefined();
  });

  it('refuses a tech the player already knows', () => {
    const knows = researching(STATE, 0, { techs: [asTechId('pottery')] });

    expect(refusedAs(apply(knows, P0, setResearch('pottery')), 'tech-already-known')).toEqual({
      kind: 'tech-already-known',
      tech: 'pottery',
    });
  });

  it('refuses a tech whose prerequisite is not known, naming every missing one', () => {
    // `literature` needs `pottery` and `masonry`, and this player has neither — so the
    // refusal carries *both*, sorted, rather than making a UI ask again. A refusal
    // that named nothing would be a refusal with no reason in it.
    expect(
      refusedAs(apply(STATE, P0, setResearch('literature')), 'tech-prerequisites-unmet'),
    ).toEqual({
      kind: 'tech-prerequisites-unmet',
      tech: 'literature',
      missing: [asTechId('masonry'), asTechId('pottery')],
    });

    // With one of the two known, the answer narrows to the other.
    const half = researching(STATE, 0, { techs: [asTechId('pottery')] });
    expect(
      refusedAs(apply(half, P0, setResearch('literature')), 'tech-prerequisites-unmet'),
    ).toEqual({
      kind: 'tech-prerequisites-unmet',
      tech: 'literature',
      missing: [asTechId('masonry')],
    });

    // And with both known the command is legal: the refusal above was about the
    // prerequisites and about nothing else.
    const ready = researching(STATE, 0, {
      techs: [asTechId('pottery'), asTechId('masonry')],
    });
    expect(apply(ready, P0, setResearch('literature')).ok).toBe(true);
  });

  it('refuses an actor the state does not have', () => {
    expect(
      refusedAs(apply(STATE, asPlayerId(7), setResearch('pottery')), 'unknown-player'),
    ).toEqual({
      kind: 'unknown-player',
      playerId: asPlayerId(7),
    });
  });

  it('is legal for a barbarian actor too, whose choice nothing advances', () => {
    // The contract's rule has no `kind` in it, and `applyResearch` skips barbarians
    // exactly as the money loop does — so the command is legal, writes the setting,
    // and nothing about the game changes. Refusing would be a rule the frozen
    // contract does not state.
    const withBarbarians: GameState = {
      ...STATE,
      players: [...STATE.players, player(2, 8, 'barbarian')],
    };

    const outcome = mustOk(apply(withBarbarians, asPlayerId(2), setResearch('pottery')));
    expect(researchingOf(playerOf(outcome.state, 2))).toBe('pottery');

    // A turn passes; the barbarian's choice is inert, and its pool (which nothing
    // credits) is untouched.
    const afterTurn = advanceTurn(outcome.state, RULESET);
    expect(playerOf(afterTurn.state, 2).beakers).toBe(0);
    expect([...playerOf(afterTurn.state, 2).techs]).toEqual([]);
    expect(researchingOf(playerOf(afterTurn.state, 2))).toBe('pottery');
  });

  it('wires the command to the pipeline: a selected tech completes when the pool covers it', () => {
    // The end-to-end check that the two halves are one rule: the command writes what
    // the research step reads, and the step completes it from banked beakers.
    const funded = researching(STATE, 0, { beakers: 5 });
    const selected = mustOk(apply(funded, P0, setResearch('pottery')));
    const turn = mustOk(apply(selected.state, P0, END_TURN));

    expect(turn.events).toContainEqual({
      type: 'TechResearched',
      playerId: P0,
      tech: asTechId('pottery'),
      cost: 5,
      beakers: 0,
    });
    expect([...playerOf(turn.state, 0).techs]).toEqual([asTechId('pottery')]);
    expect(Object.hasOwn(playerOf(turn.state, 0), 'researching')).toBe(false);
  });

  it('leaves the resulting state hashable, with no key holding undefined', () => {
    // The M3 bug class this milestone's optional field could have reintroduced: a
    // `researching: undefined` key would compile against a looser type and make
    // `canonicalize` throw. It cannot here — `withResearching` never writes
    // `undefined` and `exactOptionalPropertyTypes` makes that a compile error — and
    // this asserts the runtime consequence.
    const outcome = mustOk(apply(STATE, P0, setResearch('pottery')));

    expect(() => canonicalize(outcome.state)).not.toThrow();
    expect(() => hashValue(outcome.state)).not.toThrow();
    expect(canonicalize(outcome.state)).toContain('"researching":"pottery"');
  });

  it('is pure: the input state is not modified, by the planner or the applier', () => {
    const before = hashValue(STATE);

    planSetResearch(STATE, RULESET, P0, asTechId('pottery'));
    planSetResearch(STATE, RULESET, P0, asTechId('mithril'));
    apply(STATE, P0, setResearch('pottery'));

    expect(hashValue(STATE)).toBe(before);
    expect(STATE.revision).toBe(0);
  });
});

describe('planSetResearch agrees with the applier, over the whole catalog and beyond', () => {
  /** The tech ids a caller might name: every real row, plus ids no row defines. */
  const CANDIDATES: readonly string[] = [
    ...TECHS.map((tech) => String(tech.id)),
    'mithril',
    '',
    'Pottery', // case matters: ids are exact, and a near miss is not a tech
    'pottery ',
  ];

  /** Players worth sweeping: an empty one, one with a tech, one with several. */
  const BOARDS: readonly GameState[] = [
    STATE,
    researching(STATE, 0, { techs: [asTechId('pottery')] }),
    researching(STATE, 0, { techs: [asTechId('bronze-working'), asTechId('masonry')] }),
    researching(STATE, 0, {
      techs: [asTechId('pottery'), asTechId('masonry'), asTechId('literature')],
    }),
    researching(STATE, 0, { beakers: 40 }),
  ];

  it('accepts exactly what it refuses, for every candidate on every board', () => {
    // The keystone property for this command, in both directions: the planner is what
    // a UI greys a tech out with and `applyCommand` is what refuses it, so a
    // disagreement is either a button that fails or a refusal nobody can predict.
    for (const board of BOARDS) {
      for (const candidate of CANDIDATES) {
        const tech = asTechId(candidate);
        const plan = planSetResearch(board, RULESET, P0, tech);
        const applied = apply(board, P0, { type: 'SetResearch', tech });

        expect(applied.ok, `plan/applier disagree on "${candidate}"`).toBe(plan.ok);
        if (!plan.ok && !applied.ok) expect(applied.error).toEqual(plan.error);
      }
    }
  });

  it('is the same question as tech.ts’ researchProblem, mapped onto GameError', () => {
    // The mapping stated as a property rather than as a table: `undefined` from the
    // rule means the plan succeeds, and each problem kind means its own refusal.
    for (const board of BOARDS) {
      for (const candidate of CANDIDATES) {
        const tech = asTechId(candidate);
        const problem = researchProblem(RULESET, playerOf(board, 0), tech);
        const plan = planSetResearch(board, RULESET, P0, tech);

        if (problem === undefined) {
          expect(plan.ok, `"${candidate}" is researchable but the planner refused`).toBe(true);
          continue;
        }
        expect(plan.ok).toBe(false);
        if (plan.ok) continue;
        switch (problem.kind) {
          case 'unknown-tech':
            expect(plan.error.kind).toBe('unknown-tech');
            break;
          case 'already-known':
            expect(plan.error.kind).toBe('tech-already-known');
            break;
          case 'unmet-prerequisite':
            expect(plan.error.kind).toBe('tech-prerequisites-unmet');
            if (plan.error.kind === 'tech-prerequisites-unmet') {
              expect(plan.error.missing).toEqual(problem.missing);
            }
            break;
          case 'nothing-being-researched':
            throw new Error('researchProblem must not answer a question about a candidate');
        }
      }
    }
  });

  it('never lets the applier accept something the planner refused, for another actor', () => {
    // The same sweep from player 1's seat, so "the actor’s own row is the only row in
    // reach" is checked rather than assumed: player 1 knows nothing, whatever player 0
    // knows.
    const board = researching(STATE, 0, { techs: [asTechId('pottery')] });
    for (const candidate of CANDIDATES) {
      const tech = asTechId(candidate);
      const plan = planSetResearch(board, RULESET, P1, tech);
      const applied = apply(board, P1, { type: 'SetResearch', tech });
      expect(applied.ok, `plan/applier disagree for player 1 on "${candidate}"`).toBe(plan.ok);
    }
  });

  it('carries the tech through on success, and only on success', () => {
    const ok = planSetResearch(STATE, RULESET, P0, asTechId('masonry'));
    // `masonry` needs `bronze-working`, so this one is the refusal — and the *legal*
    // one is a root.
    expect(ok.ok).toBe(false);

    const plan = planSetResearch(STATE, RULESET, P0, asTechId('pottery'));
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.value.tech).toBe('pottery');
      expect(plan.value.player.id).toBe(P0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * M6 — attacking, fortifying and city capture
 *
 * The fixture below is the M2 board with a combat catalog bolted on, and the shared
 * `RULESET` above is deliberately untouched: nothing in the M2–M5 sections may move
 * because M6 arrived, and a battle needs statistics (`attack`, `defense`,
 * `hitPoints`) those fixture rows do not pin.
 *
 * Every number asserted here is either a **placeholder** of ours (the halved, floored,
 * minimum-1 capture population; which buildings a sack takes and in what order) or a
 * magnitude the *ruleset* declares and this file states as a fixture rather than
 * re-deriving (`M6_COMBAT`: the veteran, fortify, city and wall percentages and the
 * promotion cap). None of it is Civ 3's, and the odds quoted in
 * the comments are the *engine's* arithmetic — `floor(attack * 100 / (attack + defense))`
 * with the defender's summed modifiers floored once — not a claim about the real game.
 * ------------------------------------------------------------------ */

/** Attack 3, defence 1, **one** hit point: cheap enough to script every battle exactly. */
const LEGION: UnitDef = {
  id: asUnitTypeId('legion'),
  role: 'military',
  name: 'Legion',
  attack: 3,
  defense: 1,
  hitPoints: 1,
  movement: 2,
  cost: 3,
  domain: 'land',
};

/** Defence 4, attack 1, one hit point: the wall the modifier chain is measured against. */
const PHALANX: UnitDef = {
  id: asUnitTypeId('phalanx'),
  role: 'military',
  name: 'Phalanx',
  attack: 1,
  defense: 4,
  hitPoints: 1,
  movement: 2,
  cost: 3,
  domain: 'land',
};

/** `attack: 0`: M6's "may not attack" row — "a legality rule, not a footnote". */
const CIVILIAN: UnitDef = {
  id: asUnitTypeId('civilian'),
  role: 'military',
  name: 'Civilian',
  attack: 0,
  defense: 1,
  hitPoints: 1,
  movement: 2,
  cost: 1,
  domain: 'land',
};

/**
 * M6's building rows, with distinct maintenance values and one wonder, so both claims
 * of the capture rule are visible at once: the destruction order (maintenance
 * descending, ties to the most recently completed) and the wonder exemption — the
 * Pyramids carry the *highest* maintenance in this catalog and are still kept, so
 * "destroy the expensive ones first" cannot pass these tests by accident.
 */
const M6_BUILDINGS: readonly BuildingDef[] = [
  { id: asBuildingId('granary'), name: 'Granary', cost: 10, maintenance: 0, effects: [] },
  { id: asBuildingId('library'), name: 'Library', cost: 20, maintenance: 1, effects: [] },
  { id: asBuildingId('walls'), name: 'City Walls', cost: 15, maintenance: 1, effects: [] },
  { id: asBuildingId('marketplace'), name: 'Marketplace', cost: 12, maintenance: 2, effects: [] },
  {
    id: asBuildingId('pyramids'),
    name: 'Pyramids',
    cost: 30,
    maintenance: 3,
    effects: [],
    wonder: true,
  },
];

/**
 * **The combat magnitudes this file's battles are fought under** — the nine values the
 * shipped `@civts/rules` catalog declares, written out here because `@civts/core` cannot
 * depend on the content package (`rules` depends on `core`).
 *
 * They are a *fixture*, not an import: M6b moved these numbers out of `combat.ts`, and a
 * test that read them back from the engine would assert nothing about what the engine
 * does with them. Every hand-computed odds figure below (42 / 33 / 27 / 25) is the
 * arithmetic of *these* numbers, and the last test in the M6 block asserts that
 * `combatRulesOf(M6_RULESET)` really is this section — so a change to either side shows up
 * as a failure rather than as two answers quietly agreeing to disagree.
 */
const M6_COMBAT: CombatDef = {
  fortifyBonusPct: 25,
  cityDefenseBonusPct: 50,
  wallsBonusPct: 50,
  veteranAttackPct: 25,
  maxExperience: 3,
  rollBound: 100,
  damagePerRound: 1,
  minWinPct: 1,
  maxWinPct: 99,
};

/**
 * **The capture rule this file's sacks are applied under** (M7) — the divisor the shipped
 * `@civts/rules` catalog declares, written out here for the same reason `M6_COMBAT` is:
 * `@civts/core` cannot depend on the content package, and a fixture that read the number
 * back from the engine would assert nothing about what the engine does with it.
 *
 * M7 moved it out of `cities.ts`, where it was `CAPTURE_POPULATION_DIVISOR = 2`. A capture
 * now reads the section off the ruleset it is played under, and a view that declares none
 * gets the *degenerate* rule (`NO_CAPTURE_RULES`: divisor 1, "a sack costs the city no
 * citizens") rather than a copy of the shipped 2 — which is why this fixture has to say
 * what its divisor is, and why the M7 block below asserts that moving it moves the
 * population the engine leaves.
 */
const M7_CAPTURE: CaptureDef = { populationDivisor: 2 };

/**
 * The same escape hatch `TechView` above uses, for the same reason: `RulesetView` (the
 * engine's structural view) does not declare `combat`, so a fixture that carries one says
 * so in its own type rather than casting the section in. M7's `capture` section is declared
 * the same way.
 */
interface CombatView extends TechView {
  readonly combat: CombatDef;
  readonly capture: CaptureDef;
}

/** The M2 fixture view plus M6's unit and building rows and M6b's combat section. */
const M6_RULESET: CombatView = {
  ...RULESET,
  units: [...RULESET.units, LEGION, PHALANX, CIVILIAN],
  buildings: M6_BUILDINGS,
  combat: M6_COMBAT,
  capture: M7_CAPTURE,
};

/**
 * A seed whose **first** `nextBelow(state, 100)` draw is exactly `roll`.
 *
 * A one-hit-point battle is decided by that single draw, so this is how a test states
 * *what the dice were* instead of hoping a seed produces the branch it wants: with
 * `roll = 0` the attacker wins the first round (`0 < threshold` always), and with
 * `roll = 99` the defender does (`99 >= threshold` for every threshold the resolver can
 * produce, since `MAX_WIN_PCT` is 99). The search is over seeds, integer-only and
 * terminates on the first match, so it is as deterministic as a literal — the same
 * device `combat.test.ts` uses, for the same reason.
 */
const seedWithFirstRoll = (roll: number): RngState => {
  for (let seed = 0; seed < 100000; seed += 1) {
    const candidate = seedRng(seed);
    if (nextBelow(candidate, 100)[0] === roll) return candidate;
  }
  throw new Error(`no seed in range draws ${String(roll)} first`);
};

const ATTACKER = 0;
const DEFENDER = 1;

/** The unit with this id, or a thrown error — a test's own `unitById`, without a cast. */
const mustUnit = (state: GameState, id: number): Unit => {
  const found = unitById(state, asUnitId(id));
  if (found === undefined) throw new Error(`the board has no unit ${String(id)}`);
  return found;
};

/**
 * A battle board: player 0's legion on tile 5 with a full turn, player 1's phalanx on
 * tile 6 (adjacent grassland; every terrain in this fixture has a zero defence bonus,
 * so nothing is attributed to the ground).
 *
 * `defenderCity` puts a city of the defender's owner on the defender's tile — the
 * arrangement that produces the city and wall bonuses — and `hitPoints` overrides both
 * units' current health, so a multi-round battle needs no new catalog row
 * (`hitPointsLeftOf` reads the unit's field, not the row's maximum).
 */
const battleBoard = (options: {
  readonly roll: number;
  readonly fortified?: boolean;
  readonly hitPoints?: number;
  readonly defenderCity?: readonly BuildingId[];
  readonly defenderOwner?: number;
  readonly defenderType?: UnitDef;
  readonly attackerType?: UnitDef;
  readonly attackerMovement?: number;
  readonly extraEnemy?: boolean;
}): GameState => {
  const hp = options.hitPoints ?? 1;
  const attackerType = options.attackerType ?? LEGION;
  const defenderType = options.defenderType ?? PHALANX;
  const attacker: Unit = {
    ...unit(ATTACKER, attackerType, 0, 5, options.attackerMovement ?? 2),
    hitPointsLeft: hp,
  };
  const defender: Unit = {
    ...unit(DEFENDER, defenderType, options.defenderOwner ?? 1, 6, defenderType.movement),
    hitPointsLeft: hp,
    ...(options.fortified === true ? { fortified: true } : {}),
  };
  const units: readonly Unit[] =
    options.extraEnemy === true
      ? [attacker, defender, { ...unit(2, PHALANX, 1, 6, 0), hitPointsLeft: hp }]
      : [attacker, defender];

  const base = withUnits({ ...STATE, rng: seedWithFirstRoll(options.roll) }, units);
  if (options.defenderCity === undefined) return base;

  return withCities(base, [
    city(0, options.defenderOwner ?? 1, 6, { buildings: [...options.defenderCity] }),
  ]);
};

/**
 * The capture board: player 0's legion on tile 5 and player 1's city on tile 6, with one
 * phalanx standing in it when `defended`. `city` overrides the city's fields, so a
 * capture test states the city it is capturing in one line.
 */
const siegeBoard = (
  options: { readonly defended?: boolean; readonly city?: Partial<City> } = {},
): GameState => {
  const units: readonly Unit[] =
    options.defended === true
      ? [unit(ATTACKER, LEGION, 0, 5, LEGION.movement), unit(DEFENDER, PHALANX, 1, 6, 0)]
      : [unit(ATTACKER, LEGION, 0, 5, LEGION.movement)];
  const base = withUnits({ ...STATE, rng: seedWithFirstRoll(0) }, units);
  return withCities(base, [city(0, 1, 6, { name: 'City 1', population: 5, ...options.city })]);
};

/** The whole `UnitDestroyed` payload for a unit, so a death is asserted in full. */
const destroyedEvent = (each: Unit, killer: Unit): GameEvent => ({
  type: 'UnitDestroyed',
  unitId: each.id,
  owner: each.owner,
  unitType: each.type,
  tile: each.tile,
  reason: 'combat',
  byUnitId: killer.id,
  byOwner: killer.owner,
});

const attack = (unitId: number, target: number): Command => ({
  type: 'AttackUnit',
  unitId: asUnitId(unitId),
  target: asTileIndex(target),
});

const fortify = (unitId: number): Command => ({ type: 'FortifyUnit', unitId: asUnitId(unitId) });

/** The one `CombatResolved` event of an outcome, or a thrown error naming what happened. */
const combatEvent = (
  events: readonly GameEvent[],
): Extract<GameEvent, { type: 'CombatResolved' }> => {
  const found = events.find(
    (event): event is Extract<GameEvent, { type: 'CombatResolved' }> =>
      event.type === 'CombatResolved',
  );
  if (found === undefined)
    throw new Error(`expected a CombatResolved event: ${JSON.stringify(events)}`);
  return found;
};

/** The one `CityCaptured` event of an outcome, or a thrown error naming what happened. */
const captureEvent = (
  events: readonly GameEvent[],
): Extract<GameEvent, { type: 'CityCaptured' }> => {
  const found = events.find(
    (event): event is Extract<GameEvent, { type: 'CityCaptured' }> => event.type === 'CityCaptured',
  );
  if (found === undefined)
    throw new Error(`expected a CityCaptured event: ${JSON.stringify(events)}`);
  return found;
};

/** Every player whose city holds `building`, in player-id order. */
const holdersOf = (state: GameState, building: BuildingId): readonly PlayerId[] =>
  [
    ...new Set(
      state.cities.filter((each) => each.buildings.includes(building)).map((each) => each.owner),
    ),
  ].sort((a, b) => Number(a) - Number(b));

describe('applyCommand — AttackUnit resolves a battle through combat.ts', () => {
  it('destroys the defender, leaves the attacker standing, and reports every number once', () => {
    // Attack 3 against defence 4: floor(3 * 100 / (3 + 4)) = 42% a round. A draw of 0
    // wins the round for the attacker, and one hit point each means one round is the
    // whole battle — so every number below is hand-checkable.
    const outcome = mustOk(apply(battleBoard({ roll: 0 }), P0, attack(ATTACKER, 6), M6_RULESET));

    expect(outcome.events).toEqual([
      {
        type: 'CombatResolved',
        attackerId: asUnitId(ATTACKER),
        attackerOwner: P0,
        defenderId: asUnitId(DEFENDER),
        defenderOwner: P1,
        target: asTileIndex(6),
        outcome: 'attacker-wins',
        rounds: 1,
        attackerLost: 0,
        defenderLost: 1,
        attackerWinPct: 42,
        attackerSurvives: true,
        defenderSurvives: false,
      },
      destroyedEvent(unit(DEFENDER, PHALANX, 1, 6, 0), unit(ATTACKER, LEGION, 0, 5, 2)),
      {
        type: 'UnitPromoted',
        unitId: asUnitId(ATTACKER),
        owner: P0,
        tile: asTileIndex(5),
        experience: 1,
        maxExperience: M6_COMBAT.maxExperience,
      },
    ]);

    // The world: the defender is gone, the attacker holds its ground, and its turn is
    // spent — an attack costs the whole turn whether or not it succeeds.
    expect(outcome.state.units.map((each) => Number(each.id))).toEqual([ATTACKER]);
    const survivor = mustUnit(outcome.state, ATTACKER);
    expect(survivor.tile).toBe(5);
    expect(survivor.movementLeft).toBe(0);
    expect(hitPointsLeftOf(survivor)).toBe(1);
    expect(experienceOf(survivor)).toBe(1);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
  });

  it('hands the round to the defender at a draw of 99, and destroys the attacker', () => {
    const outcome = mustOk(apply(battleBoard({ roll: 99 }), P0, attack(ATTACKER, 6), M6_RULESET));

    expect(combatEvent(outcome.events)).toEqual({
      type: 'CombatResolved',
      attackerId: asUnitId(ATTACKER),
      attackerOwner: P0,
      defenderId: asUnitId(DEFENDER),
      defenderOwner: P1,
      target: asTileIndex(6),
      outcome: 'defender-wins',
      rounds: 1,
      attackerLost: 1,
      defenderLost: 0,
      attackerWinPct: 42,
      attackerSurvives: false,
      defenderSurvives: true,
    });

    // The *defender* won that combat, so the defender is the unit that earns the level:
    // "a unit that wins a combat" is whichever side is left standing, not the attacker.
    expect(outcome.events).toContainEqual({
      type: 'UnitPromoted',
      unitId: asUnitId(DEFENDER),
      owner: P1,
      tile: asTileIndex(6),
      experience: 1,
      maxExperience: M6_COMBAT.maxExperience,
    });
    expect(outcome.state.units.map((each) => Number(each.id))).toEqual([DEFENDER]);
    // Being attacked costs the defender nothing but hit points: M6 makes an attack spend
    // the *attacker's* whole turn, and a defender's movement is its own to spend on its
    // own turn.
    expect(mustUnit(outcome.state, DEFENDER).movementLeft).toBe(PHALANX.movement);
  });

  it('reads the defender’s modifiers through combat.ts, and floors the sum exactly once', () => {
    // The same attacker against the same defender (attack 3 against defence 4) in four
    // arrangements. Each modifier is a *summed* percentage with one floor at the end, so
    // the odds walk 42 -> 33 -> 27 -> 25 and every step is asserted exactly:
    //
    //   in the open              floor(3 * 100 / (3 + 4))         = 42
    //   the defender's own city  defence floor(4 * 150 / 100) = 6  -> floor(300 / 9)  = 33
    //   …and it holds walls      defence floor(4 * 200 / 100) = 8  -> floor(300 / 11) = 27
    //   …and it is fortified     defence floor(4 * 225 / 100) = 9  -> floor(300 / 12) = 25
    //
    // The last step is the compounding rule doing real work: 50 + 50 + 25 summed and
    // floored once gives 9, where flooring each modifier on the way in would give
    // floor(floor(floor(4*1.5)=6 *1.5)=9 *1.25) = 11 and different odds. A command layer
    // that scaled the defence itself, or handed the resolver a pre-floored number, fails
    // one of these four assertions.
    const open = mustOk(apply(battleBoard({ roll: 0 }), P0, attack(ATTACKER, 6), M6_RULESET));
    const inCity = mustOk(
      apply(battleBoard({ roll: 0, defenderCity: [] }), P0, attack(ATTACKER, 6), M6_RULESET),
    );
    const withWalls = mustOk(
      apply(
        battleBoard({ roll: 0, defenderCity: [asBuildingId('walls')] }),
        P0,
        attack(ATTACKER, 6),
        M6_RULESET,
      ),
    );
    const dugIn = mustOk(
      apply(
        battleBoard({ roll: 0, defenderCity: [asBuildingId('walls')], fortified: true }),
        P0,
        attack(ATTACKER, 6),
        M6_RULESET,
      ),
    );

    expect(combatEvent(open.events).attackerWinPct).toBe(42);
    expect(combatEvent(inCity.events).attackerWinPct).toBe(33);
    expect(combatEvent(withWalls.events).attackerWinPct).toBe(27);
    expect(combatEvent(dugIn.events).attackerWinPct).toBe(25);

    // The same four steps against the *ruleset* rather than the arithmetic, so a fixture
    // whose section is not the one the odds came from fails here instead of convincing a
    // reader that the engine read it: this is the engine's own reader, on this file's own
    // view, and the numbers are the ones the four assertions above were computed from.
    expect(combatRulesOf(M6_RULESET)).toStrictEqual(M6_COMBAT);
    expect(M6_COMBAT.cityDefenseBonusPct).toBe(50);
    expect(M6_COMBAT.wallsBonusPct).toBe(50);
    expect(M6_COMBAT.fortifyBonusPct).toBe(25);
  });

  it('gives the city and wall bonuses only to the city’s own defender', () => {
    // A third player's unit standing in somebody else's walled city is not defending
    // those walls. This states the reading rather than leaving it to the code: the
    // defender gets the open-ground odds, not the city's.
    const third = {
      ...battleBoard({ roll: 0, defenderOwner: 2 }),
      players: [...STATE.players, player(2, 7)],
    };
    const board = withCities(third, [city(0, 1, 6, { buildings: [asBuildingId('walls')] })]);
    const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));

    expect(combatEvent(outcome.events).attackerWinPct).toBe(42);
  });

  it('spends the attacker’s whole turn even in a battle it does not win outright', () => {
    // Three hit points each and a first draw of 99: the attacker loses the opening round
    // (3 -> 2) and the battle runs on. Whatever the rest of the stream does, the attack
    // has cost the unit its turn, and the damage it took is written into the state.
    const outcome = mustOk(
      apply(battleBoard({ roll: 99, hitPoints: 3 }), P0, attack(ATTACKER, 6), M6_RULESET),
    );
    const result = combatEvent(outcome.events);

    expect(result.rounds).toBeGreaterThan(1);
    expect(result.attackerLost).toBeGreaterThan(0);
    const attacker = unitById(outcome.state, asUnitId(ATTACKER));
    if (attacker === undefined) {
      // It died — and then the loss is the resolver's own answer, with no movement left
      // to spend because there is no unit to spend it.
      expect(result.attackerSurvives).toBe(false);
    } else {
      expect(attacker.movementLeft).toBe(0);
      expect(hitPointsLeftOf(attacker)).toBe(3 - result.attackerLost);
    }
  });

  it('is reproducible from the seed, and consumes the battle’s draws from the state’s RNG', () => {
    // One hit point each means one round, one roll, one draw from the world's stream —
    // so the RNG the battle returns can be checked against the stream position after
    // *exactly one* draw, rather than against "something different".
    const board = battleBoard({ roll: 0 });
    const [drawn, afterOneDraw] = nextBelow(board.rng, 100);
    expect(drawn).toBe(0); // the dice this board was built to throw

    const first = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));
    const second = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));

    expect(combatEvent(second.events)).toEqual(combatEvent(first.events));
    expect(second.state).toEqual(first.state);
    expect(hashValue(second.state)).toBe(hashValue(first.state));
    expect(first.state.rng).toEqual(afterOneDraw);

    // A longer battle consumes one draw per round, in order: the same board at three hit
    // points a side is decided after `rounds` rolls, and the state must have moved down
    // the stream by exactly that many. This is the reproducibility claim stated as
    // arithmetic — the state is the whole source of randomness, and nothing is dropped.
    const long = battleBoard({ roll: 99, hitPoints: 3 });
    const played = mustOk(apply(long, P0, attack(ATTACKER, 6), M6_RULESET));
    let expected = long.rng;
    for (let round = 0; round < combatEvent(played.events).rounds; round += 1) {
      expected = nextBelow(expected, 100)[1];
    }
    expect(played.state.rng).toEqual(expected);
  });

  it('never leaves a live unit at zero hit points, and destroys exactly one side per battle', () => {
    // The structural claims behind the event list, swept rather than sampled: a battle
    // resolved by this command kills exactly one of the two units (the loop runs until a
    // side has nothing left, and a round costs one hit point), and no unit in the
    // resulting state is at or below zero.
    for (let roll = 0; roll < 100; roll += 1) {
      const board = battleBoard({ roll, hitPoints: 3 });
      const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));
      const result = combatEvent(outcome.events);
      const deaths = outcome.events.filter((event) => event.type === 'UnitDestroyed');

      expect(deaths).toHaveLength(1);
      expect(result.attackerSurvives).toBe(!result.defenderSurvives);
      expect(outcome.state.units).toHaveLength(1);
      for (const each of outcome.state.units) expect(hitPointsLeftOf(each)).toBeGreaterThan(0);

      // "Losing a combat the unit survives grants nothing" is therefore *vacuously* true
      // in this engine — the loser never survives — and the stronger claim that is
      // testable holds instead: a promotion always names a unit the state still holds.
      for (const event of outcome.events) {
        if (event.type !== 'UnitPromoted') continue;
        expect(outcome.state.units.some((each) => each.id === event.unitId)).toBe(true);
        expect(experienceOf(mustUnit(outcome.state, Number(event.unitId)))).toBe(event.experience);
      }
    }
  });

  it('leaves no trace of a unit it destroys', () => {
    const board = battleBoard({ roll: 0 });
    const before = hashValue(board);
    const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));
    const dead = unit(DEFENDER, PHALANX, 1, 6, 0);

    // Gone, by every read the engine offers.
    expect(outcome.state.units.some((each) => each.id === dead.id)).toBe(false);
    expect(unitById(outcome.state, dead.id)).toBeUndefined();
    // …and the id is not handed out again: `nextUnitId` is untouched, so a unit produced
    // later takes a fresh id rather than the dead one's (M2's counter rule).
    expect(outcome.state.nextUnitId).toBe(board.nextUnitId);
    // The death is stated, with its reason and its killer. A unit vanishing with no event
    // would be indistinguishable from a bug, which is why `UnitDestroyed` has a `reason`
    // at all.
    expect(outcome.events).toContainEqual(destroyedEvent(dead, unit(ATTACKER, LEGION, 0, 5, 2)));
    // The state is still canonical — no key holds `undefined` — and it hashes.
    expect(() => canonicalize(outcome.state)).not.toThrow();
    expect(hashValue(outcome.state)).not.toBe(before);
  });

  it('never touches the state it is handed, and a refused attack changes nothing', () => {
    const board = battleBoard({ roll: 0 });
    const before = hashValue(board);

    apply(board, P0, attack(ATTACKER, 6), M6_RULESET);
    apply(board, P0, attack(ATTACKER, 4), M6_RULESET);

    expect(hashValue(board)).toBe(before);
    expect(board.revision).toBe(0);
  });
});

describe('applyCommand — AttackUnit refusals, each named', () => {
  it('refuses a unit whose type declares no attack, and reports the attack it saw', () => {
    const board = battleBoard({ roll: 0, attackerType: CIVILIAN });

    expect(
      refusedAs(apply(board, P0, attack(ATTACKER, 6), M6_RULESET), 'unit-cannot-attack'),
    ).toEqual({ kind: 'unit-cannot-attack', unitId: asUnitId(ATTACKER), attack: 0 });
  });

  it('refuses a unit whose type the ruleset does not describe at all', () => {
    // The same refusal for the same reason: a type nothing describes has no attack the
    // engine can see, which is reported as 0. The row is in the state, not in this view.
    const board = battleBoard({ roll: 0, attackerType: makeDef('ghost', 'military', 2, 1) });
    const error = refusedAs(
      apply(board, P0, attack(ATTACKER, 6), M6_RULESET),
      'unit-cannot-attack',
    );

    expect(error.kind === 'unit-cannot-attack' && error.attack).toBe(0);
  });

  it('refuses an attack with no movement left to spend, saying what it needed and had', () => {
    const board = battleBoard({ roll: 0, attackerMovement: 0 });

    expect(
      refusedAs(apply(board, P0, attack(ATTACKER, 6), M6_RULESET), 'not-enough-movement'),
    ).toEqual({ kind: 'not-enough-movement', unitId: asUnitId(ATTACKER), needed: 1, available: 0 });
  });

  it('refuses a tile with nothing on it, and one holding only the actor’s own side', () => {
    // Tiles 4, 9 and 10 are the attacker's other neighbours: empty grassland, a hill, and
    // more grassland, all of them with nothing to fight.
    for (const target of [4, 9, 10]) {
      expect(
        refusedAs(
          apply(battleBoard({ roll: 0 }), P0, attack(ATTACKER, target), M6_RULESET),
          'nothing-to-attack',
        ),
      ).toEqual({
        kind: 'nothing-to-attack',
        unitId: asUnitId(ATTACKER),
        target: asTileIndex(target),
      });
    }

    // A city the actor already owns is not a target either: there is nothing there to
    // take, and the tile would otherwise be a legal step for its own units.
    refusedAs(
      apply(siegeBoard({ city: { owner: P0 } }), P0, attack(ATTACKER, 6), M6_RULESET),
      'nothing-to-attack',
    );
  });

  it('refuses a tile holding two enemy units rather than choosing a victim', () => {
    // Two enemy units on one tile is legal stacking (M2 sets no stacking limit), and M6's
    // rule is "exactly one enemy-occupied thing" — so this refuses with the count found
    // rather than inventing "attack the lowest id", which would decide every stacked
    // battle in the game invisibly.
    expect(
      refusedAs(
        apply(battleBoard({ roll: 0, extraEnemy: true }), P0, attack(ATTACKER, 6), M6_RULESET),
        'target-stacked',
      ),
    ).toEqual({
      kind: 'target-stacked',
      unitId: asUnitId(ATTACKER),
      target: asTileIndex(6),
      defenders: 2,
    });
  });

  it('refuses a non-adjacent target, an off-map one and one that is not a tile', () => {
    const board = battleBoard({ roll: 0 });

    // Tile 15 is two steps away (tile 5 is (1,1) and tile 15 is (3,3)), and path movement
    // is not in the engine: an attack is a single adjacent strike, so this is an argument
    // error rather than a silently expanded path.
    const far = refusedAs(apply(board, P0, attack(ATTACKER, 15), M6_RULESET), 'invalid-argument');
    expect(far.kind === 'invalid-argument' && far.detail).toContain('adjacent');

    refusedAs(apply(board, P0, attack(ATTACKER, 16), M6_RULESET), 'out-of-bounds');
    refusedAs(apply(board, P0, attack(ATTACKER, -1), M6_RULESET), 'out-of-bounds');
    refusedAs(apply(board, P0, attack(ATTACKER, 1.5), M6_RULESET), 'invalid-argument');
  });

  it("refuses another player's unit, an unknown unit and an unknown actor", () => {
    const board = battleBoard({ roll: 0 });

    refusedAs(apply(board, P1, attack(ATTACKER, 6), M6_RULESET), 'not-your-unit');
    refusedAs(apply(board, P0, attack(77, 6), M6_RULESET), 'unknown-unit');
    refusedAs(apply(board, asPlayerId(9), attack(ATTACKER, 6), M6_RULESET), 'unknown-player');
  });

  it('refuses to walk onto a city of another player — the other half of M2’s enemy rule', () => {
    // M6's invariant "no unit inside an enemy city it does not own" has to be unreachable
    // by legal play, and this is the rule that makes it so: the step is refused with the
    // same error an enemy unit's tile gets, and attacking is the way to take the tile.
    const board = siegeBoard();
    expect(refusedAs(apply(board, P0, move(ATTACKER, 6), M6_RULESET), 'occupied-by-enemy')).toEqual(
      { kind: 'occupied-by-enemy', unitId: asUnitId(ATTACKER), to: asTileIndex(6) },
    );

    // …and once the city is the mover's own, the same step is legal. The turn has to be
    // refilled first: the capture itself spent the attacker's movement.
    const captured = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));
    const refilled = withMovement(captured.state, ATTACKER, LEGION.movement);
    const stepped = mustOk(apply(refilled, P0, move(ATTACKER, 6), M6_RULESET));

    expect(mustUnit(stepped.state, ATTACKER).tile).toBe(6);
  });
});

describe('applyCommand — FortifyUnit', () => {
  it('digs in, spends the whole turn, emits nothing, and bumps the revision once', () => {
    const board = battleBoard({ roll: 0 });
    const outcome = mustOk(apply(board, P0, fortify(ATTACKER), M6_RULESET));
    const dug = mustUnit(outcome.state, ATTACKER);

    expect(isFortified(dug)).toBe(true);
    expect(dug.movementLeft).toBe(0);
    // The command's only effect is the flag, so it emits no event — which is exactly why
    // `legalActions` does not advertise it (`actions.ts` states the decision).
    expect(outcome.events).toEqual([]);
    expect(outcome.state.revision).toBe(board.revision + 1);
    // The other player's unit is untouched, and the state stays canonical.
    expect(mustUnit(outcome.state, DEFENDER).movementLeft).toBe(PHALANX.movement);
    expect(() => canonicalize(outcome.state)).not.toThrow();
  });

  it('refuses a second fortification in the same turn, through the movement rule', () => {
    // No "already fortified" special case exists: the first fortification spends the
    // movement, so the second simply has none to spend.
    const dug = mustOk(apply(battleBoard({ roll: 0 }), P0, fortify(ATTACKER), M6_RULESET));

    refusedAs(apply(dug.state, P0, fortify(ATTACKER), M6_RULESET), 'not-enough-movement');
  });

  it('refuses an unknown unit, an unknown actor and another player’s unit', () => {
    const board = battleBoard({ roll: 0 });

    refusedAs(apply(board, P0, fortify(77), M6_RULESET), 'unknown-unit');
    refusedAs(apply(board, asPlayerId(9), fortify(ATTACKER), M6_RULESET), 'unknown-player');
    refusedAs(apply(board, P1, fortify(ATTACKER), M6_RULESET), 'not-your-unit');
  });

  it('is cleared by a move, and survives a turn the unit spends standing still', () => {
    const dug = mustOk(apply(battleBoard({ roll: 0 }), P0, fortify(ATTACKER), M6_RULESET));

    // Ending the turn refills the movement and leaves the flag alone: being fortified is
    // where the unit is dug in, not a per-turn resource.
    const next = mustOk(apply(dug.state, P0, END_TURN, M6_RULESET));
    const still = mustUnit(next.state, ATTACKER);
    expect(isFortified(still)).toBe(true);
    expect(still.movementLeft).toBe(LEGION.movement);

    // …and the step out of the trench drops it, through `clearFortified`: the key is
    // *absent*, never present-and-undefined.
    const stepped = mustOk(apply(next.state, P0, move(ATTACKER, 4), M6_RULESET));
    const gone = mustUnit(stepped.state, ATTACKER);
    expect(gone.tile).toBe(4);
    expect(isFortified(gone)).toBe(false);
    expect(Object.hasOwn(gone, 'fortified')).toBe(false);
    expect(() => canonicalize(stepped.state)).not.toThrow();
  });

  it('makes the defender harder to hit, because the command layer reads the flag', () => {
    // Attack 3 against defence 4 in the open: floor(3 * 100 / (3 + 4)) = 42%. Fortified:
    // defence floor(4 * 125 / 100) = 5, so floor(300 / 8) = 37%.
    const plain = mustOk(apply(battleBoard({ roll: 0 }), P0, attack(ATTACKER, 6), M6_RULESET));
    const dugIn = mustOk(
      apply(battleBoard({ roll: 0, fortified: true }), P0, attack(ATTACKER, 6), M6_RULESET),
    );

    expect(combatEvent(plain.events).attackerWinPct).toBe(42);
    expect(combatEvent(dugIn.events).attackerWinPct).toBe(37);
  });
});

describe('applyCommand — an attack on an undefended city captures it', () => {
  it('expends the attacker’s whole turn, leaves it where it stood, and promotes nobody', () => {
    const board = siegeBoard();
    const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));

    // No `CombatResolved` and no `UnitPromoted`: no shot was fired, and M6 grants a level
    // for winning a *combat*.
    expect(outcome.events.map((event) => event.type)).toEqual(['CityCaptured']);
    const attacker = mustUnit(outcome.state, ATTACKER);
    expect(attacker.tile).toBe(5);
    expect(attacker.movementLeft).toBe(0);
    expect(experienceOf(attacker)).toBe(0);
    // A capture is not random, so it draws nothing from the world's stream.
    expect(outcome.state.rng).toEqual(board.rng);
  });

  it('bumps the revision by EXACTLY one, and folds the conqueror’s fog', () => {
    // M6b's repair, pinned at the command layer. M6 bumped the revision in `applyCapture`
    // and folded no fog at all; a capture is a state change of the same rank as a move, so
    // it bumps once (not twice — the double bump a command layer that also bumped would
    // produce) and folds what the new owner's units can see, through `fog.ts`' one writer.
    // `cities.test.ts` pins the rule itself; this pins what a player's `AttackUnit` does
    // with it, which is the path a save, a replay and a golden hash all see.
    const board = siegeBoard();
    const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));

    expect(outcome.state.revision).toBe(board.revision + 1);
    // Fog: the legion stands on tile 5 and the city it took is tile 6, one step away, so
    // the tile it conquered is now in its owner's memory — and it was not before.
    expect(isExplored(board, P0, asTileIndex(6))).toBe(false);
    expect(isExplored(outcome.state, P0, asTileIndex(6))).toBe(true);
    expect(isExplored(outcome.state, P0, asTileIndex(5))).toBe(true);
    // The defeated owner learns nothing: the fold is the conqueror's sight.
    expect(isExplored(outcome.state, P1, asTileIndex(5))).toBe(false);
  });

  it('turns a defended city into a battle, and the city stays its owner’s when the guard dies', () => {
    // "Attacking a city with a defender resolves against that defender", and the capture
    // is the *undefended* case — so killing the guard is not a capture, and the city
    // changes hands only to an attack that finds nobody home.
    const outcome = mustOk(
      apply(siegeBoard({ defended: true }), P0, attack(ATTACKER, 6), M6_RULESET),
    );

    expect(outcome.events.some((event) => event.type === 'CombatResolved')).toBe(true);
    expect(outcome.events.some((event) => event.type === 'UnitDestroyed')).toBe(true);
    expect(outcome.events.some((event) => event.type === 'CityCaptured')).toBe(false);
    expect(cityById(outcome.state, asCityId(0))?.owner).toBe(P1);
    expect(cityById(outcome.state, asCityId(0))?.population).toBe(5);
  });

  it('refuses a city that is not adjacent, and one that is already the actor’s', () => {
    // Tile 15 is two steps from the attacker, so a city there is out of reach: M6 has no
    // siege machinery and no ranged strike.
    refusedAs(apply(siegeBoard(), P0, attack(ATTACKER, 15), M6_RULESET), 'invalid-argument');

    // The same undefended city, already owned by the attacker: there is nothing to take.
    refusedAs(
      apply(siegeBoard({ city: { owner: P0 } }), P0, attack(ATTACKER, 6), M6_RULESET),
      'nothing-to-attack',
    );
  });
});

describe('applyCommand — capture changes exactly what M6 says it changes', () => {
  /**
   * A city whose every field the capture rule touches is set to a value a default would
   * hide: population 5 (so halving *and* flooring are visible), four buildings of
   * distinct maintenance including a wonder, a production head *and* a queue, one worked
   * tile, stored food and stored shields.
   */
  const TARGET: Partial<City> = {
    name: 'City 1',
    population: 5,
    foodBox: 7,
    shields: 3,
    production: buildingItem('marketplace'),
    queue: [unitItem('legion')],
    buildings: [
      asBuildingId('granary'),
      asBuildingId('library'),
      asBuildingId('walls'),
      asBuildingId('pyramids'),
    ],
    workedTiles: [asTileIndex(5)],
  };

  const targetBoard = (overrides: Partial<City> = {}): GameState =>
    siegeBoard({ city: { ...TARGET, ...overrides } });

  it('hands the city over, halves and floors its population, and keeps it on the map', () => {
    const board = targetBoard();
    const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));
    const after = cityById(outcome.state, asCityId(0));

    expect(after?.owner).toBe(P0);
    expect(after?.population).toBe(2); // floor(5 / 2): the placeholder capture rule
    // Not razed: same id, same name, same tile, still in `state.cities`, and the id
    // counter is untouched because nothing was created.
    expect(after?.name).toBe('City 1');
    expect(after?.tile).toBe(6);
    expect(outcome.state.cities).toHaveLength(1);
    expect(outcome.state.nextCityId).toBe(board.nextCityId);
  });

  it('destroys every non-wonder building, maintenance-descending, and keeps the wonder', () => {
    const outcome = mustOk(apply(targetBoard(), P0, attack(ATTACKER, 6), M6_RULESET));
    const after = cityById(outcome.state, asCityId(0));
    const event = captureEvent(outcome.events);

    // The library and the walls both cost 1 to keep and the walls come *second* in the
    // list, so the tie breaks to the most recently completed; the granary costs nothing
    // and is destroyed anyway — which is where a capture differs from the bankruptcy
    // demolition, whose rule is a *stopping* rule ("take rows until their maintenance
    // covers what went unpaid") and which therefore skips a free row.
    expect(event.destroyed).toEqual([
      asBuildingId('walls'),
      asBuildingId('library'),
      asBuildingId('granary'),
    ]);
    expect(after?.buildings).toEqual([asBuildingId('pyramids')]);

    // The wonder carries the *highest* maintenance in this catalog, so an order that
    // simply took the expensive rows first would have destroyed it. It is globally unique
    // (M4c), and a wonder destroyed by capture would silently become buildable again —
    // the whole reason the exemption exists.
    expect(event.destroyed).not.toContain(asBuildingId('pyramids'));
    // …and it is now the new owner's, so nothing anywhere may start another one.
    expect(after?.owner).toBe(P0);
    expect(holdersOf(outcome.state, asBuildingId('pyramids'))).toEqual([P0]);
  });

  it('clears the production head and the queue, and leaves the stored food and shields', () => {
    const outcome = mustOk(apply(targetBoard(), P0, attack(ATTACKER, 6), M6_RULESET));
    const after = cityById(outcome.state, asCityId(0));

    // The key is **absent**, never present-and-undefined: the one spelling this state
    // cannot represent, and the reason `captureCity` rebuilds the city rather than
    // spreading a `production: undefined` over it.
    expect(after).toBeDefined();
    if (after === undefined) return;
    expect(Object.hasOwn(after, 'production')).toBe(false);
    expect(after.queue).toEqual([]);
    // The contract's list of what a capture changes does not mention the stored food or
    // the stored shields, so both survive — stated here rather than discovered later.
    expect(after.foodBox).toBe(7);
    expect(after.shields).toBe(3);
    expect(() => canonicalize(outcome.state)).not.toThrow();
  });

  it('clears the worked tiles, freeing them for whoever claims them next', () => {
    const outcome = mustOk(apply(targetBoard(), P0, attack(ATTACKER, 6), M6_RULESET));

    expect(cityById(outcome.state, asCityId(0))?.workedTiles).toEqual([]);
  });

  it('leaves every tile improvement and road exactly where it was', () => {
    // A mine on the captured city's own tile and a road under the attacker's feet:
    // sacking a city is not a reason for the countryside to change, as M6 says outright.
    const roads: GameState = {
      ...targetBoard(),
      improvements: [
        { tile: asTileIndex(6), kind: asImprovementId('mine') },
        { tile: asTileIndex(5), kind: asImprovementId('road') },
      ],
    };
    const outcome = mustOk(apply(roads, P0, attack(ATTACKER, 6), M6_RULESET));

    expect(outcome.state.improvements).toBe(roads.improvements);
  });

  it('reports the capture with the old owner, the new one and the population after it', () => {
    const board = targetBoard();
    const outcome = mustOk(apply(board, P0, attack(ATTACKER, 6), M6_RULESET));

    expect(captureEvent(outcome.events)).toEqual({
      type: 'CityCaptured',
      cityId: asCityId(0),
      from: P1,
      to: P0,
      tile: asTileIndex(6),
      name: 'City 1',
      population: 2,
      destroyed: [asBuildingId('walls'), asBuildingId('library'), asBuildingId('granary')],
    });
    expect(outcome.state.revision).toBe(board.revision + 1);
  });

  it('never takes a captured city below population 1', () => {
    for (const population of [1, 2, 3, 4, 5, 6]) {
      const outcome = mustOk(
        apply(targetBoard({ population }), P0, attack(ATTACKER, 6), M6_RULESET),
      );
      // Halved and floored, with the minimum stated as the rule it is rather than as a
      // side effect of the divisor.
      expect(cityById(outcome.state, asCityId(0))?.population).toBe(
        Math.max(1, Math.floor(population / 2)),
      );
    }
  });

  it('applies the divisor the ruleset declares, and reads it through the engine’s own reader', () => {
    // **M7's own claim, through the command layer.** The first half says the fixture's
    // section is the one the applier reads (`captureRulesOf`, the same reader
    // `applyCapture` asks) — so the numbers in this block are the arithmetic of *this*
    // section and not of two answers quietly agreeing. The second half is the knob: the
    // same board, the same attack, three rulesets, three populations, which is what makes
    // the divisor sweepable rather than a constant with a section-shaped shadow.
    expect(captureRulesOf(M6_RULESET)).toEqual(M7_CAPTURE);

    const capturedUnder = (populationDivisor: number): number | undefined => {
      const rules = { ...M6_RULESET, capture: { populationDivisor } };
      const outcome = mustOk(apply(targetBoard(), P0, attack(ATTACKER, 6), rules));
      return cityById(outcome.state, asCityId(0))?.population;
    };

    expect(capturedUnder(1)).toBe(5); // "a sack costs the city no citizens"
    expect(capturedUnder(2)).toBe(2); // the shipped placeholder: floor(5 / 2)
    expect(capturedUnder(5)).toBe(1); // floor(5 / 5) = 1, and the minimum agrees

    // …and a view that declares no capture section is the *degenerate* rule, not the
    // shipped one: absent must change what a sack does, or a literal would be hiding here.
    // The section is dropped by a rest pattern, and the drop is *asserted* rather than
    // trusted (the same discipline the M6 terrain and unit fixtures use for a key they
    // really remove — a removal that silently failed would leave this assertion vacuous).
    const { capture: declared, ...withoutCapture } = M6_RULESET;
    expect(declared).toEqual(M7_CAPTURE);
    expect('capture' in withoutCapture).toBe(false);
    expect(captureRulesOf(withoutCapture).populationDivisor).toBe(1);
    const outcome = mustOk(apply(targetBoard(), P0, attack(ATTACKER, 6), withoutCapture));
    expect(cityById(outcome.state, asCityId(0))?.population).toBe(5);
  });

  it('lets a barbarian take a city too — ownership is ownership', () => {
    // The rule is "an adjacent undefended enemy city", with no `kind` check — the same
    // reading `planFoundCity` takes of a barbarian settler.
    const barbarians: GameState = {
      ...siegeBoard(),
      players: [...STATE.players, player(2, 7, 'barbarian')],
    };
    const horde = withUnits(barbarians, [unit(ATTACKER, LEGION, 2, 5, LEGION.movement)]);
    const outcome = mustOk(apply(horde, asPlayerId(2), attack(ATTACKER, 6), M6_RULESET));

    expect(cityById(outcome.state, asCityId(0))?.owner).toBe(asPlayerId(2));
    // Taken *from* player 1, the city's owner: a barbarian capture is the same rule with
    // different players, not a third code path.
    expect(captureEvent(outcome.events).from).toBe(P1);
  });
});

describe('planAttackUnit agrees with the applier, over every unit and every tile', () => {
  /**
   * The eighth generator's half of the keystone property, in both directions and over a
   * deliberately wider universe than the generator's output: **every** tile index from
   * one before the board to one past it (plus a half-step, since a `TileIndex` is a
   * number at runtime), for every unit of every actor, plus an actor the state does not
   * hold.
   */
  const BOARDS: readonly (readonly [string, GameState])[] = [
    ['a plain battle', battleBoard({ roll: 0 })],
    ['a defended city', siegeBoard({ defended: true })],
    ['an undefended city', siegeBoard()],
    ['a stacked tile', battleBoard({ roll: 0, extraEnemy: true })],
    ['a spent attacker', battleBoard({ roll: 0, attackerMovement: 0 })],
    ['a civilian', battleBoard({ roll: 0, attackerType: CIVILIAN })],
    [
      'a fortified defender in a walled city',
      battleBoard({ roll: 0, fortified: true, defenderCity: [asBuildingId('walls')] }),
    ],
    ['the M2 board with no combat units at all', STATE],
  ];

  it('accepts exactly what the applier accepts, with the same typed refusal', () => {
    let accepted = 0;

    for (const [label, board] of BOARDS) {
      const size = board.map.width * board.map.height;
      for (const actor of [P0, P1, asPlayerId(9)]) {
        for (const each of board.units) {
          for (let target = -1; target <= size; target += 1) {
            for (const tile of [asTileIndex(target), asTileIndex(target + 0.5)]) {
              const plan = planAttackUnit(board, M6_RULESET, actor, each.id, tile);
              const applied = apply(
                board,
                actor,
                { type: 'AttackUnit', unitId: each.id, target: tile },
                M6_RULESET,
              );

              expect(applied.ok, `${label}: plan/applier disagree on tile ${String(tile)}`).toBe(
                plan.ok,
              );
              if (!plan.ok && !applied.ok) expect(applied.error).toEqual(plan.error);
              if (applied.ok) accepted += 1;
            }
          }
        }
      }
    }

    // Non-vacuity: the sweep has to have found attacks the engine accepts, or "the two
    // agree" would be a statement about two functions that both only ever say no.
    expect(accepted).toBeGreaterThan(0);
  });

  it('publishes the shape the applier acts on, for both a battle and a capture', () => {
    const battle = planAttackUnit(
      battleBoard({ roll: 0 }),
      M6_RULESET,
      P0,
      asUnitId(ATTACKER),
      asTileIndex(6),
    );
    expect(battle.ok).toBe(true);
    if (battle.ok && battle.value.kind === 'battle') {
      expect(battle.value.unit.id).toBe(asUnitId(ATTACKER));
      expect(battle.value.defender.id).toBe(asUnitId(DEFENDER));
      expect(battle.value.target).toBe(6);
    } else {
      throw new Error('the defended board must plan a battle');
    }

    const capture = planAttackUnit(
      siegeBoard(),
      M6_RULESET,
      P0,
      asUnitId(ATTACKER),
      asTileIndex(6),
    );
    expect(capture.ok).toBe(true);
    if (capture.ok && capture.value.kind === 'capture') {
      expect(capture.value.city.id).toBe(asCityId(0));
      expect(capture.value.target).toBe(6);
    } else {
      throw new Error('the undefended board must plan a capture');
    }
  });

  it('is a pure read: planning a battle neither mutates the state nor draws from its RNG', () => {
    const board = battleBoard({ roll: 0 });
    const before = hashValue(board);
    const rng = board.rng;

    planAttackUnit(board, M6_RULESET, P0, asUnitId(ATTACKER), asTileIndex(6));
    planAttackUnit(board, M6_RULESET, P0, asUnitId(ATTACKER), asTileIndex(4));

    expect(hashValue(board)).toBe(before);
    // The plan is a legality question, and legality must never consume the world's
    // randomness: a generator the AI calls per unit per frame would otherwise change the
    // game by asking about it.
    expect(board.rng).toEqual(rng);
  });
});

describe('planFortifyUnit agrees with the applier', () => {
  it('accepts exactly what the applier accepts, for every unit and every actor', () => {
    let accepted = 0;

    for (const board of [battleBoard({ roll: 0 }), siegeBoard(), STATE]) {
      for (const actor of [P0, P1, asPlayerId(9)]) {
        for (let id = 0; id <= board.nextUnitId; id += 1) {
          const unitId = asUnitId(id);
          const plan = planFortifyUnit(board, actor, unitId);
          const applied = apply(board, actor, { type: 'FortifyUnit', unitId }, M6_RULESET);

          expect(applied.ok).toBe(plan.ok);
          if (!plan.ok && !applied.ok) expect(applied.error).toEqual(plan.error);
          if (applied.ok) accepted += 1;
        }
      }
    }

    expect(accepted).toBeGreaterThan(0);
  });
});
