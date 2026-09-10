/**
 * `applyCommand` — movement, the M3 city commands, the turn pipeline, purity and
 * the turn advance (docs/INTERFACES.md M2, "Core — commands, errors, legal
 * actions"; M3, "Commands", "Growth", "Production", "Turn pipeline").
 *
 * The board is hand-built rather than generated so every assertion reads as "on
 * this map, that command gives this answer": tile indices are `y * 4 + x`, and
 * the terrain costs, yields and blockers are visible at the top of the file.
 *
 * The fixture's `explored` rows are entirely `false` on purpose: M2 leaves fog
 * out of the legality rule, so every movement assertion below is also evidence
 * that legality does not consult what a player has seen.
 *
 * The M3 sections live here rather than in a `growth.test.ts`/`production.test.ts`
 * of their own because this test file is the one the workstream owns; they are
 * sectioned by module, and every number they assert is a **placeholder** rule of
 * ours (the 10 + 5·(pop−1) food box, the food-first auto-assignment, the shield
 * carry-over) pinned so that an intentional retune has to change a test on
 * purpose. None of it is claimed to be Civ 3's, and the Civ IV growth formula is
 * explicitly asserted *against* (`foodBoxSize`).
 */

import { describe, expect, it } from 'vitest';
import { hashValue } from '@civts/testing';
import { MIN_CITY_DISTANCE, cityById, type City, type ProductionItem } from '../src/cities.js';
import {
  applyCommand,
  planFoundCity,
  planMove,
  planSetProduction,
  planSetWorkedTiles,
  type Command,
  type CommandOutcome,
  type GameError,
  type GameEvent,
} from '../src/commands.js';
import { isExplored } from '../src/fog.js';
import { FOOD_BOX_BASE, FOOD_BOX_PER_CITIZEN, applyGrowth, foodBoxSize } from '../src/growth.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type PlayerId,
} from '../src/ids.js';
import type { GameMap, RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { applyProduction, itemCost, itemCostOf } from '../src/production.js';
import { isOk, type Result } from '../src/result.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { SCHEMA_VERSION, type GameState, type PlayerState } from '../src/state.js';
import { advanceTurn } from '../src/turn.js';
import { spawnUnit, type Unit, type UnitDef, type UnitRole } from '../src/units.js';

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

/** Building costs (shields), as placeholder rows of ours. */
const GRANARY_COST = 10;
const LIBRARY_COST = 20;

const BUILDINGS = [
  { id: asBuildingId('granary'), name: 'Granary', cost: GRANARY_COST },
  { id: asBuildingId('library'), name: 'Library', cost: LIBRARY_COST },
];

/** The engine's view of a ruleset: terrain, a unit catalog, and buildings. */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, SCOUT, WARRIOR],
  buildings: BUILDINGS,
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

const END_TURN: Command = { type: 'EndTurn' };

/** `applyCommand` with the ruleset the engine is evaluated against. */
const apply = (
  state: GameState,
  playerId: PlayerId,
  cmd: Command,
): Result<CommandOutcome, GameError> => applyCommand(state, playerId, cmd, RULESET);

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
    expect(outcome.events).toEqual([{ type: 'TurnEnded', playerId: P0, turn: 2 }]);
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
    expect(outcome.events).toEqual([{ type: 'TurnEnded', playerId: P0, turn: 2 }]);
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
 * M3 — the plan evaluators are the appliers' decisions
 * ------------------------------------------------------------------ */

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
  it('runs growth, then production, then the refill, then turn += 1 — in that order', () => {
    // One board that makes the order observable. Growth first: population 1 with a
    // box of 8 grows to 2 on a surplus of 2, and the new citizen is assigned tile
    // 5, so the city's shields for this turn are 1 (centre) + 1 (tile 4) + 1
    // (tile 5) = 3. Production second: 1 stored + 3 = 4 buys the 2-shield scout and
    // leaves 2. Had production run first it would have seen 1 + 2 = 3 and left 1 —
    // the leftover is the fingerprint of the order.
    const board = withCities(STATE, [
      city(0, 0, 13, {
        population: 1,
        workedTiles: [asTileIndex(4)],
        foodBox: 8,
        shields: 1,
        production: unitItem('scout'),
      }),
    ]);

    const outcome = advanceTurn(board, RULESET);
    const assigned = cityOf(outcome.state, 0);

    expect(assigned.population).toBe(2);
    expect(assigned.foodBox).toBe(0);
    expect(assigned.shields).toBe(2);
    expect(assigned.production).toBeUndefined();
    expect(assigned.workedTiles.map(Number)).toEqual([4, 5]);

    // Movement is refilled for every unit, the produced one included.
    expect(outcome.state.units.map((u) => u.movementLeft)).toEqual([
      SETTLER.movement,
      SCOUT.movement,
      WARRIOR.movement,
      SCOUT.movement,
    ]);
    expect(outcome.state.turn).toBe(board.turn + 1);

    // Events follow the pipeline: growth, then production.
    expect(outcome.events).toStrictEqual([
      { type: 'CityGrew', cityId: asCityId(0), owner: P0, population: 2, foodBox: 0 },
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: P0,
        item: unitItem('scout'),
        shields: 2,
        unitId: asUnitId(3),
        tile: asTileIndex(13),
      },
    ]);
  });

  it('does not touch revision: a turn is part of a command, and the command counts it', () => {
    const outcome = advanceTurn(STATE, RULESET);
    expect(outcome.state.revision).toBe(STATE.revision);
    expect(outcome.state.turn).toBe(STATE.turn + 1);
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
 * M3 — purity of the new commands together
 * ------------------------------------------------------------------ */

describe('applyCommand — M3 purity and revision', () => {
  it('never mutates a deeply frozen state, and bumps revision exactly once per command', () => {
    const board: GameState = structuredClone(CITY_STATE);
    const snapshot = structuredClone(board);
    deepFreeze(board);

    const founding = withCities(board, []);
    const commands: readonly Command[] = [
      foundCity(0),
      setWorkedTiles(0, [4, 8]),
      setProduction(0, unitItem('warrior')),
      END_TURN,
    ];

    for (const cmd of commands) {
      const target = cmd.type === 'FoundCity' ? founding : board;
      const outcome = mustOk(apply(target, P0, cmd));
      expect(outcome.state).not.toBe(target);
      expect(outcome.state.revision).toBe(target.revision + 1);
    }

    expect(board).toEqual(snapshot);
  });
});
