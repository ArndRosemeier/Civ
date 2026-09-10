/**
 * Map data structures. See PLAN.md 5.4.
 *
 * The authoritative map is a flat row-major array of terrain ids — compact,
 * JSON-friendly, and self-consistent (x/y are derived rather than duplicated,
 * so they cannot drift out of sync). Typed-array layouts remain available as a
 * derived optimisation layer if the M7 perf budgets demand it.
 */

import { asTileIndex, type TerrainId, type TileIndex } from './ids.js';

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

/** The engine's structural view of a validated ruleset. */
export interface RulesetView {
  readonly terrains: readonly TerrainDef[];
  readonly fidelity: 'tuned' | 'cited-only';
}

export interface GameMap {
  readonly width: number;
  readonly height: number;
  /** Row-major terrain ids; length === width * height. */
  readonly terrain: readonly TerrainId[];
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
