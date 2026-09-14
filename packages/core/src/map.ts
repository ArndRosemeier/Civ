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
  | { readonly kind: 'growth-food'; readonly amount: number } // granary
  /**
   * M9: one citizen's worth of contentment, from a building in **its own city**.
   *
   * A **signed** integer, and that is the design of the member rather than a
   * convenience: `happiness.ts` counts *unhappy* citizens down (a temple, a
   * colosseum — the contract's own examples: "unhappy citizens … reduced by
   * `BuildingSpec.happiness` (temple, colosseum)") while a *happy* citizen is a
   * different count that the same union has to be able to raise. Two members
   * (`unhappiness` and `happy-citizens`) would be two fields saying one thing and
   * two halves of one subtraction; one signed amount *is* the subtraction, and
   * `happiness.ts` reads the sign.
   *
   * **Why an effect rather than a fifth `BuildingSpec` field.** The contract's M9
   * section names `BuildingSpec.happiness` directly, and the magnitude is the
   * building row's either way — but the engine's one reader of "what does a
   * building do to its own city" is `buildings.ts`' `cityBuildingEffects`, which
   * walks `effects`. A separate field would be a second path into that one
   * computation, which is the defect class this project has found repeatedly.
   * `BuildingSpec.happiness` is therefore a readable *projection* onto this
   * effect, applied in one place in `@civts/rules`, so nothing downstream can see
   * two numbers for one fact.
   *
   * `amount` must be a whole number; `validateRuleset` rejects a fractional or
   * non-finite one, because it ends up in a count of citizens.
   */
  | { readonly kind: 'city-happiness'; readonly amount: number }; // temple, colosseum

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
  'city-happiness',
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
/**
 * **One government row as this struct** (M9).
 *
 * Declared here rather than imported from `governments.ts` because `governments.ts`
 * imports *this* module — the dependency runs one way, and a field type that ran the other
 * way would be a cycle the runtime never needs. The shape is the engine's own
 * `GovernmentDef` (a `governmentDef()` read returns exactly this), and it is the name-free
 * subset of `@civts/rules`' `GovernmentSpec` that the engine reads; `provenance` and
 * `requiresTech` are deliberately absent, because the engine resolves those through the
 * gating module (`governments.ts`' `governmentTechRequirement`) rather than from the view.
 */
export interface GovernmentRow {
  /** The id a command spells. */
  readonly id: string;
  readonly name: string;
  /** The highest each slider may reach; `>= 0`, `<= RATE_TOTAL`. */
  readonly rateCaps: { readonly tax: number; readonly science: number; readonly luxury: number };
  /** Units supported for free per city owned (integer `>= 0`). */
  readonly freeUnitsPerCity: number;
  /** Gold per turn for each unit beyond the free allowance (integer `>= 0`). */
  readonly unitSupportCost: number;
  /** Added to a city's unhappy count (signed integer). */
  readonly happinessModifier: number;
}

/**
 * **M9's culture section as a view may state it**, read *structurally* and field by field.
 *
 * Every field is optional and **may hold anything**: `borders.ts`' `cultureRulesOf` and
 * `happiness.ts`' `happinessRulesOf` reach the section through `unknown` and keep whatever
 * they can read, so a view that states `borderRadius2Culture: "ten"` gets the degenerate
 * border rule rather than a crash. The type is therefore a *convenience for a hand-built
 * fixture*, not a constraint the engine relies on — which is why it is a loose shape here
 * and a validated one in `@civts/rules`.
 */
export interface CultureSection {
  readonly borderRadius2Culture?: unknown;
  readonly borderRadius3Culture?: unknown;
  readonly unhappyThresholds?: unknown;
  readonly luxuriesPerHappyCitizen?: unknown;
  readonly happyPerLuxuryResource?: unknown;
}

/**
 * **M9's happiness ladder as a view may state it**: rows of `{ minPopulation, unhappy }`,
 * read structurally by `happinessRulesOf` (a row whose `minPopulation` is not a whole number
 * `>= 1` is dropped rather than defaulted, so one malformed entry cannot make every city in
 * the world riot).
 */
export interface UnhappyThresholdRow {
  readonly minPopulation: number;
  readonly unhappy: number;
}

/**
 * **M10's score weights as a view may state them** (see `score.ts`' `ScoreDef`).
 *
 * Declared here for the same one-way-dependency reason `GovernmentRow` is: `score.ts`
 * imports this module, so the field's type cannot come from there. All optional and
 * `unknown`, because `scoreRulesOf` reads a section structurally and treats an unreadable
 * weight as 0 — the type is a fixture's convenience, not a constraint.
 */
export interface ScoreSection {
  readonly perPopulation?: unknown;
  readonly perCity?: unknown;
  readonly perTech?: unknown;
  readonly perCulture?: unknown;
  readonly perWonder?: unknown;
}

/**
 * **M10's victory thresholds as a view may state them** (see `victory-rules.ts`'
 * `VictoryRules`). Same one-way-dependency reason as `GovernmentRow` and `ScoreSection`,
 * and the same looseness: `victoryRulesOf` reads the section structurally, and an
 * unreadable threshold becomes one no condition can reach rather than a crash.
 */
export interface VictorySection {
  readonly dominationLandPct?: unknown;
  readonly dominationPopPct?: unknown;
  readonly culturalVictoryCulture?: unknown;
  readonly scoreVictoryTurn?: unknown;
}

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
  /**
   * M9's government rows. **Optional**, like `buildings` and `resources`, and for the
   * same reason: a view written before governments existed (a structural stand-in, an
   * M2-era fixture) is still a view the engine can run a game from — every player is
   * simply under `governments.ts`' `NO_GOVERNMENT`, whose numbers reproduce M4b's flat
   * allowance and cost exactly, so a pre-M9 fixture plays identically. A view that ships
   * governments but none the current player's id names falls back the same way, which is
   * what makes `governmentOf` total.
   *
   * `governmentCatalog` in `governments.ts` is the one place that decides what "no
   * section" means, exactly as `buildingCatalog` does for buildings.
   */
  readonly governments?: readonly GovernmentRow[];
  /**
   * M9's culture section: the two border thresholds and the happiness table. **Optional**
   * and read *structurally* by `borders.ts`' `cultureRulesOf` and `happiness.ts`'
   * `happinessRulesOf`, so the field is declared here only to give a hand-built view a
   * typed place to put it — the engine never assumes it exists, and both readers fall back
   * to deliberately degenerate rules rather than to a second copy of the shipped numbers.
   *
   * One section for both halves rather than two, because `@civts/rules`' `CultureSpec` is
   * one row: borders and contentment are two readings of the same idea ("what a city's
   * culture buys it"), and splitting them here would let a view state one without the other.
   */
  readonly culture?: CultureSection;
  /** M10's score weights. Optional; absent means every player scores 0 (`NO_SCORE_RULES`). */
  readonly score?: ScoreSection;
  /** M10's victory thresholds. Optional; absent means no condition can fire. */
  readonly victory?: VictorySection;
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

/**
 * **The terrain roles a land unit cannot enter**, and the one statement of it.
 *
 * Two modules had grown their own copy of this two-element list — `hut.ts` when it decided
 * where a goody hut may sit, and `commands.ts` when it refused `FoundCity` on water — and
 * M10 needed a third reader (the domination land share divides by the map's *land*). Three
 * copies of a rule about the world is the drift this project's discipline exists to
 * prevent, so the list and the predicate over it live here, where the terrain roles are
 * declared, and the two older readers now call it.
 *
 * A role rather than a terrain id because the question is about *kinds* of ground, and a
 * ruleset may declare any number of ocean and coast terrains: a per-id list would have to
 * be maintained beside every terrain row a content pack adds.
 */
export const WATER_ROLES: readonly TerrainRole[] = ['ocean', 'coast'];

/** Is this terrain role water — ground no land unit may enter? See `WATER_ROLES`. */
export const isWaterRole = (role: TerrainRole): boolean => WATER_ROLES.includes(role);

/**
 * **Is the tile at `index` land?** — and the one statement of what ground counts as land.
 *
 * Read through the ruleset's terrain rows rather than guessed from an id or a role name, so a
 * terrain a content pack adds counts as land unless its own row says it is water. A tile whose
 * terrain the ruleset does not describe counts as **not** land — the map and the ruleset disagree
 * about that tile, and calling it land would inflate a denominator with ground nobody can
 * describe, which is the reading `landTileCount` and the domination numerator both take.
 *
 * It is exported because it had grown a second copy: `borders.ts` carried a private `isLandAt`
 * (`Q3-VERIFICATION.md` §B4, R2's R2-F3) that re-derived exactly this three-line rule beside a doc
 * comment naming `landTileCount` as its source. Two implementations of "is this ground land?" is
 * the drift this project's one-statement discipline exists to prevent — the M2 lesson about two
 * writers of one layer, applied to a predicate — so the copy is deleted and the readers call this.
 */
export const isLandAt = (map: GameMap, ruleset: RulesetView, index: number): boolean => {
  const terrain = terrainAtIndex(map, index);
  if (terrain === undefined) return false;
  const def = ruleset.terrains.find((row) => row.id === terrain);
  return def !== undefined && !isWaterRole(def.role);
};

/**
 * **How many tiles of this map are land** — the denominator M10's domination rule uses.
 *
 * One pass over the map's terrain, each tile decided by `isLandAt` — the single predicate, so
 * this count and every other "is this tile land?" question in the engine cannot disagree.
 */
export const landTileCount = (map: GameMap, ruleset: RulesetView): number => {
  let total = 0;
  for (let index = 0; index < map.terrain.length; index += 1) {
    if (isLandAt(map, ruleset, index)) total += 1;
  }
  return total;
};

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
