/**
 * Map data structures. See PLAN.md 5.4.
 *
 * The authoritative map is a flat row-major array of terrain ids — compact,
 * JSON-friendly, and self-consistent (x/y are derived rather than duplicated,
 * so they cannot drift out of sync). Typed-array layouts remain available as a
 * derived optimisation layer if the M7 perf budgets demand it.
 */

import { asTileIndex, type ResourceId, type TerrainId, type TileIndex } from './ids.js';
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

/* ------------------------------------------------------------------ *
 * M4c — the engine's structural view of a ruleset's *content* beyond
 * terrain and units: what a building does to its own city, and what a
 * resource on a tile is.
 * ------------------------------------------------------------------ */

/**
 * One thing a building does to the city that holds it (INTERFACES.md M4c,
 * "Building maintenance and effects").
 *
 * The union is closed and tiny on purpose: every member is read by *some*
 * system that exists today (city output, growth), and a member nothing reads
 * would be a promise the engine does not keep — the M3 `BuildingSpec` doc says
 * the same thing about the field's absence, and this is what replaced it.
 *
 * The rules, stated once here because every consumer must agree:
 *
 * - A **multiplier** is an integer percentage applied with a **floor**. Effects
 *   apply only to the city that holds the building.
 * - Several multipliers of the same kind in one city **compound by summing the
 *   percentages first and flooring once** — not by flooring each building's
 *   contribution and adding the results, which is a different (and smaller)
 *   number. Stated explicitly because "simplify" would silently change it.
 * - `growth-food` reduces the food the city needs to grow, floored at a minimum
 *   of 1 (the granary): a city can always eventually grow, and no consumer can
 *   divide by zero.
 * - `pct` is `>= 0` and `amount` is a non-negative integer; `validateRuleset`
 *   rejects a negative, fractional or unknown effect.
 *
 * **Why the union lives here rather than in the content package.** `core` cannot
 * depend on `@civts/rules`, and the same union must be one declaration for both
 * sides: `BuildingSpec` in `@civts/rules` types its `effects` field with this,
 * and the engine's own readers (`BuildingDef`, the yield and growth paths) read
 * the same type — so a kind added on one side cannot be missing on the other.
 * It sits beside `TerrainYields` and `ResourceDef`, which are the other shapes
 * `RulesetView` publishes for exactly that reason.
 */
export type BuildingEffect =
  | { readonly kind: 'commerce-multiplier'; readonly pct: number } // marketplace
  | { readonly kind: 'beaker-multiplier'; readonly pct: number } // library
  | { readonly kind: 'shield-multiplier'; readonly pct: number } // factory
  | { readonly kind: 'growth-food'; readonly amount: number }; // granary

/**
 * The effect kinds the engine understands, in canonical order (the order a
 * report or an audit walks, so a listing of them is stable across runs,
 * mirroring `TERRAIN_ROLES`, `UNIT_ROLES` and `IMPROVEMENT_KINDS`).
 *
 * This is the *engine's* list and the only one: `@civts/rules` re-exports it and
 * `validateRuleset` rejects an effect whose kind is not in it, so a row the
 * engine cannot interpret cannot be written down and a kind the engine gains
 * cannot be silently absent from validation.
 */
export const BUILDING_EFFECT_KINDS = [
  'commerce-multiplier',
  'beaker-multiplier',
  'shield-multiplier',
  'growth-food',
] as const;

export type BuildingEffectKind = (typeof BUILDING_EFFECT_KINDS)[number];

/**
 * The resource kinds the engine understands, in canonical order (the order the
 * improvement kinds and the roles are listed in, so a report about them is
 * stable across runs).
 *
 * The three kinds are *not* three mechanics in M4c, and saying so is the point:
 *
 * - **strategic** — gates a unit that declares `requiresResource` (M4c).
 * - **luxury** — placed, connected and counted, and **nothing reads it for
 *   happiness until M9**. Saying "luxuries do nothing yet" out loud is better
 *   than a name that implies contentment is modelled.
 * - **bonus** — adds its `yields` to the tile it sits on, on top of terrain and
 *   improvements, and is **not** gated or connected: it is just terrain.
 *
 * This is the *engine's* list and the only one: `@civts/rules` re-exports it and
 * types `ResourceSpec['kind']` with it.
 */
export const RESOURCE_KINDS = ['strategic', 'luxury', 'bonus'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * The engine's structural view of a resource *type*. A validated
 * `@civts/rules` `ResourceSpec` satisfies this — it carries every field below
 * plus `provenance`, which the engine never reads.
 *
 * `yields` is meaningful for `kind: 'bonus'` only, where it is added to the tile
 * the resource sits on; every other kind declares zeros, and `validateRuleset`
 * rejects a non-bonus row that declares a non-zero delta (INTERFACES.md M4c:
 * "`yields: TerrainYields; // bonus only; zeros otherwise`").
 *
 * `allowedRoles` is where a resource may be *placed* at generation, and is a
 * placement rule only: nothing in M4c requires a resource's own tile to be
 * workable, and an improvement is not required to sit on it either.
 */
export interface ResourceDef {
  readonly id: ResourceId;
  readonly name: string;
  readonly kind: ResourceKind;
  /** Bonus only: the delta added to the tile. Zeros for every other kind. */
  readonly yields: TerrainYields;
  /** Where generation may place it. Empty is a data error, not "anywhere". */
  readonly allowedRoles: readonly TerrainRole[];
}

/**
 * One resource on one tile — the same **sparse `(tile, resource)` pair**
 * convention M4a's `TileImprovement` uses, and sparse for the same reason: most
 * tiles carry nothing, and a dense array over the largest map would be 32 400
 * entries of almost entirely nothing. Absence of a pair *is* "nothing here";
 * there is deliberately no sentinel resource id.
 *
 * A resource belongs to the **map**, not to `GameState.resources`: it is what
 * generation put on the terrain, like a goody hut, and a regenerated map must
 * therefore bring its own resources with it rather than inheriting the ones a
 * played game had (INTERFACES.md M4c, "Resources").
 */
export interface TileResource {
  /** The tile it stands on. */
  readonly tile: TileIndex;
  /** What is there. A tile carries at most one resource; see `gen.ts`. */
  readonly resource: ResourceId;
}

/**
 * The order `GameMap.resources` is stored in: **tile first (ascending index),
 * then the resource id in UTF-16 code-unit order**.
 *
 * The order is part of the contract because the list is hashed: "the same world"
 * must serialise identically however the pairs were assembled. It is stated here,
 * once, so the generator that writes the list and every future writer (and every
 * test) order it the same way — a second comparison somewhere else is a second
 * answer to "which of these two pairs comes first".
 *
 * Ids rather than a catalog index, unlike `improvements.ts`' kind rank: a
 * resource is placed *on a tile*, at most one per tile, so this comparison only
 * ever breaks a tie between two rows a hand-built state put on one tile — and
 * for that case the id itself is the only total order available without a
 * catalog in hand.
 */
export const compareTileResources = (a: TileResource, b: TileResource): number => {
  if (a.tile !== b.tile) return Number(a.tile) - Number(b.tile);
  if (a.resource < b.resource) return -1;
  return a.resource > b.resource ? 1 : 0;
};

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
  /**
   * The resource catalog, in data order. See `ResourceDef`.
   *
   * **Optional**, like `buildings` and unlike `units` and `improvements`, and
   * deliberately so — this is the third time the same judgement has been made,
   * and the reason does not change with the milestone: a view written before
   * resources existed is still a view the engine can run a game from. It simply
   * has no resources, `generateWorld` places none, no unit is gated, and every
   * tile yields exactly what terrain and improvements say. A view that genuinely
   * ships no resources says so with `resources: []`; `resourceCatalog` below is
   * the one place that decides what "no catalog" means, exactly as
   * `buildingCatalog` in `cities.ts` does for buildings.
   *
   * The ordering judgement is the mirror image of `improvements`: that field is
   * *required* because `cityYields` reads it on every call for every worked tile,
   * so a view without it is not a view the engine can compute a city's output
   * from. Nothing computes a city's output from a resource catalog — a resource
   * is content that *may* be on the map — so a missing catalog is a game without
   * resources rather than an unanswerable question.
   */
  readonly resources?: readonly ResourceDef[];
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
  /**
   * Resources on the map (M4c, "Resources"): a **sparse** list of
   * `(tile, resource)` pairs, sorted by `(tile, resource)` with no duplicates and
   * at most one resource per tile (see `TileResource` and `compareTileResources`).
   *
   * A resource is part of what the *world* is, not of what a civilization did to
   * it, which is why it lives on `GameMap` beside the huts while M4a's
   * improvements live on `GameState`: `generateWorld` places resources, so a
   * regenerated map and a played world cannot be confused for one another.
   *
   * Placement guarantees, all of them the generator's and all of them testable:
   * a tile's role is one of its row's `allowedRoles`, the tile is never a start
   * tile of any civilization, and the tile never carries a goody hut. Bonus
   * resources need no connection at all — they are terrain — so `huts` and
   * `resources` are independent lists that only ever *avoid* each other.
   */
  readonly resources: readonly TileResource[];
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

/**
 * The resource catalog of a ruleset, in catalog order. Data order, never RNG
 * order, so any "first match" derived from it is deterministic.
 *
 * This is the **one** place that decides what a missing resource catalog means:
 * a view that predates resources (or a structural stand-in in a test) has none,
 * and "none" is the honest reading — `generateWorld` then places no resources and
 * no unit is gated. Spelling it here rather than as `ruleset.resources ?? []` at
 * each call site is what keeps "no catalog" from meaning two different things in
 * two modules, which is the M2 lesson about two writers of one layer.
 */
export const resourceCatalog = (ruleset: RulesetView): readonly ResourceDef[] =>
  ruleset.resources ?? [];

/** The resource type `id`, or `undefined` when the ruleset does not define it. */
export const resourceDef = (ruleset: RulesetView, id: ResourceId): ResourceDef | undefined =>
  resourceCatalog(ruleset).find((def) => def.id === id);
