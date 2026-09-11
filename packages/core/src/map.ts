/**
 * Map data structures. See PLAN.md 5.4.
 *
 * The authoritative map is a flat row-major array of terrain ids — compact,
 * JSON-friendly, and self-consistent (x/y are derived rather than duplicated,
 * so they cannot drift out of sync). Typed-array layouts remain available as a
 * derived optimisation layer if the M7 perf budgets demand it.
 */

import { asTileIndex, type TerrainId, type TileIndex } from './ids.js';
// Type-only, so the import is erased at runtime and cannot create a runtime
// cycle with `units.ts` (which reads this module's `RulesetView` the same way).
import type { BuildingDef } from './cities.js';
import type { ImprovementDef } from './improvements.js';
import type { UnitDef } from './units.js';

export const TERRAIN_ROLES = [
  'ocean',
  'coast',
  'grassland',
  'plains',
  'hills',
  'mountains',
] as const;

export type TerrainRole = (typeof TERRAIN_ROLES)[number];

export interface TerrainYields {
  readonly food: number;
  readonly shields: number;
  readonly commerce: number;
}

/** The engine's structural view of a terrain. `@civts/rules` satisfies this. */
export interface TerrainDef {
  readonly id: TerrainId;
  readonly role: TerrainRole;
  readonly name: string;
  readonly moveCost: number;
  readonly defenseBonusPct: number;
  readonly yields: TerrainYields;
  readonly impassable: boolean;
}

/**
 * The engine's structural view of a validated ruleset.
 *
 * Both catalogs are **required**, mirroring the `@civts/rules` `Ruleset` that
 * satisfies this interface: a view without a unit catalog is not a view the
 * engine can run a game from (`applyCommand` needs each unit type's `movement`
 * to refill `movementLeft` on `EndTurn`, and `newGame` needs a settler to
 * place), so the type requires what the engine actually reads rather than
 * leaving a field optional and failing at runtime. A ruleset that genuinely has
 * no units says so with `units: []`, which is a catalog, not a missing field.
 */
export interface RulesetView {
  readonly terrains: readonly TerrainDef[];
  /** The unit catalog, in data order. See `units.ts`' `UnitDef`. */
  readonly units: readonly UnitDef[];
  /**
   * The building catalog, in data order. See `cities.ts`' `BuildingDef`.
   *
   * **Optional**, unlike `units`, and deliberately so: buildings arrived in M3,
   * so a view written before them (a test's structural stand-in, an old save's
   * ruleset) is still a valid view the engine can run a game from — it simply
   * has nothing to build, and `buildingCatalog` in `cities.ts` is the one place
   * that decides what "no buildings" means. `units` is required because the M2
   * amendment made it so: `EndTurn` cannot refill a unit whose type is missing,
   * whereas a game without buildings is a game, only a shorter one. A validated
   * `@civts/rules` `Ruleset` always carries the field, so content-driven games
   * cannot end up accidentally building-less.
   */
  readonly buildings?: readonly BuildingDef[];
  /**
   * The improvement catalog, in data order. See `improvements.ts`' `ImprovementDef`.
   *
   * **Required**, like `units` and unlike `buildings`, because M4a's `cityYields`
   * reads it on every call for every worked tile: a view without it is not a view
   * the engine can compute a city's output from, so the type requires what the
   * engine actually reads. A ruleset that ships no improvements says so with
   * `improvements: []` — a catalog, not a missing field — and then every worked
   * tile yields exactly its terrain, which is what a game with no improvements in
   * it means.
   */
  readonly improvements: readonly ImprovementDef[];
  readonly fidelity: 'tuned' | 'cited-only';
}

export interface GameMap {
  readonly width: number;
  readonly height: number;
  /** Row-major terrain ids; length === width * height. */
  readonly terrain: readonly TerrainId[];
  /**
   * Goody huts, **ascending** by tile index (M3, "Goody huts").
   *
   * A hut belongs to the map rather than to the state's entity arrays because it
   * is a property of the terrain it sits on: `generateWorld` places huts on land
   * only and never on a start tile. The list is exactly "the huts still there" —
   * a land unit entering a hut consumes it (M3's hut rewards), so a consumed hut
   * leaves this array.
   */
  readonly huts: readonly TileIndex[];
}

export const tileIndex = (width: number, x: number, y: number): TileIndex =>
  asTileIndex(y * width + x);

export const indexToX = (map: Pick<GameMap, 'width'>, index: number): number => index % map.width;

export const indexToY = (map: Pick<GameMap, 'width'>, index: number): number =>
  Math.floor(index / map.width);

export const inBounds = (map: Pick<GameMap, 'width' | 'height'>, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < map.width && y < map.height;

export const terrainAtIndex = (map: GameMap, index: number): TerrainId | undefined =>
  map.terrain[index];

export const terrainAt = (map: GameMap, x: number, y: number): TerrainId | undefined =>
  inBounds(map, x, y) ? map.terrain[tileIndex(map.width, x, y)] : undefined;

/** Orthogonal neighbours (Civ 3 allows diagonal movement; added in M2). */
export const neighbors4 = (map: GameMap, index: number): readonly TileIndex[] => {
  const x = indexToX(map, index);
  const y = indexToY(map, index);
  const out: TileIndex[] = [];
  if (inBounds(map, x - 1, y)) out.push(tileIndex(map.width, x - 1, y));
  if (inBounds(map, x + 1, y)) out.push(tileIndex(map.width, x + 1, y));
  if (inBounds(map, x, y - 1)) out.push(tileIndex(map.width, x, y - 1));
  if (inBounds(map, x, y + 1)) out.push(tileIndex(map.width, x, y + 1));
  return out;
};

export const neighbors8 = (map: GameMap, index: number): readonly TileIndex[] => {
  const x = indexToX(map, index);
  const y = indexToY(map, index);
  const out: TileIndex[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (inBounds(map, x + dx, y + dy)) out.push(tileIndex(map.width, x + dx, y + dy));
    }
  }
  return out;
};

/** Chebyshev distance — "how many tiles away" on a square grid. */
export const distance8 = (map: Pick<GameMap, 'width'>, a: number, b: number): number => {
  const ax = indexToX(map, a);
  const ay = indexToY(map, a);
  const bx = indexToX(map, b);
  const by = indexToY(map, b);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
};

export const TERRAIN_BY_ROLE = (ruleset: RulesetView, role: TerrainRole): TerrainDef | undefined =>
  ruleset.terrains.find((t) => t.role === role);
