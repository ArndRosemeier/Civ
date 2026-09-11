/**
 * Tile improvements — what a worker has built on a tile, and the ruleset's
 * catalog of them. See docs/INTERFACES.md M4a ("Where improvements live",
 * "Rules — improvement catalog", "Yields with improvements"), PLAN.md §5.3
 * (determinism) and §5.4 (data layout).
 *
 * Design notes:
 *
 * - **Improvements live on `GameState`, not on `GameMap`.** `GameMap` stays what
 *   generation produced (terrain and huts); an improvement is gameplay state,
 *   exactly like a unit or a city. A regenerated map and a played map therefore
 *   cannot be confused for one another — `{ ...state, map: generateWorld(...) }`
 *   changes the terrain and leaves every improvement where it was, which is the
 *   only reading that makes sense of "the map is what the world is, the
 *   improvements are what a civilization did to it".
 * - **A sparse list of `(tile, kind)` pairs, not a dense array.** Most tiles
 *   never carry an improvement, and a dense array over the largest map would be
 *   32 400 entries of almost entirely nothing. There is deliberately **no
 *   sentinel "none" id**: an absent pair *is* "nothing here", and an id that
 *   meant "no improvement" would be a value every consumer had to special-case.
 * - **A tile may hold several improvements.** A road *and* a mine is a normal
 *   Civ 3 tile, which is why one tile maps to a *list* of kinds rather than one
 *   value. `improvementsAt` is therefore the read that matters, and
 *   `hasImprovement` is the sugar over it.
 * - **The order is part of the contract, because it is hashed.** The list is
 *   sorted by `(tile, kind)`, tile first (ascending integer) and kind second by its
 *   index in `IMPROVEMENT_KINDS` — the catalog's editorial order, which for the
 *   shipped catalog is road, mine, irrigation and is therefore *not* code-unit
 *   order (that would be irrigation, mine, road). The difference is observable in
 *   every state hash, so `rankOfStoredId` below is the one statement of it; a reader
 *   who "corrects" the comparison to code units would move every golden. Duplicate
 *   pairs never appear. `withImprovement` establishes that order, never depends on
 *   the caller's insertion order, and is idempotent: adding a pair that is already
 *   there returns an equal state. A hash that moved when a worker re-built a road
 *   would make every save and every golden depend on how the player happened to
 *   play, not on what happened.
 * - **The state stores an improvement *id*, and this module can only rank ids.** An
 *   id is a name for a *row*; its `kind` is a field of that row, and reading the field
 *   needs the ruleset — which the frozen helper signatures (`withImprovement(state,
 *   tile, kind)`) do not take, because the state layer must be able to order its own
 *   pairs without one. So the stored order is an order **on ids**, and
 *   `IMPROVEMENT_KINDS` supplies the rank of an id that names a kind. That identity
 *   (`id === kind`) is the shipped catalog's convention and is *not* a rule the type
 *   system enforces (`ImprovementSpec` allows an id that spells something else), so
 *   `rankOfStoredId` derives the kind where it can, says so, and gives every other id
 *   a total order by spelling rather than a tie. A consumer that *does* have the
 *   ruleset should read the row's own `kind` field instead
 *   (`improvementDef(ruleset, id)?.kind` — the reading `packages/sim`'s worker-job
 *   ranking takes), which is the proper derivation and the one this module cannot do.
 * - **Nothing here validates a tile index against the map.** These are the state
 *   layer's primitives, and the *rules* — an improvement must be allowed on the
 *   tile's terrain role, a worker must stand on the tile, work starts only where
 *   the catalog allows it — belong to the command layer that will call them
 *   (`StartWork`, M4a's fifth generator). Placing them here would give the
 *   engine two statements of one rule.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O, no transcendentals.
 * Every function is pure — `withImprovement` and `withoutImprovement` return a
 * rebuilt state and never modify the one they are handed.
 */

import type { TileIndex } from './ids.js';
// Type-only: `improvements.ts` needs the *shape* of a ruleset view, not anything
// from `map.ts` at runtime. `GameState` comes in the same way, and `map.ts`
// imports `ImprovementDef` from here type-only in turn — so this module sits in
// the type graph without adding a single runtime edge.
import type { RulesetView, TerrainRole, TerrainYields } from './map.js';
import type { GameState } from './state.js';

/**
 * The nominal identity of one improvement kind. A branded string with the same
 * shape as every other id in `ids.ts`: an `ImprovementId` can never be passed
 * where a `TerrainId` or a `BuildingId` is expected, and a bare string is not one.
 *
 * It is declared here rather than in `ids.ts` because an improvement is a type
 * *this* module owns end to end, and because the whole improvement catalog —
 * `ImprovementKind` and `ImprovementDef` below — belongs in one reading. The
 * constructor is `asImprovementId`.
 */
export type ImprovementId = string & { readonly __improvementId: unique symbol };

/**
 * The nominal constructor for an `ImprovementId` (the pattern every other id in
 * `ids.ts` follows: a brand plus an `as*` function, so a bare string is not an id).
 */
export const asImprovementId = (id: string): ImprovementId => id as ImprovementId;

/**
 * The improvement kinds the engine understands, in the canonical order (the order
 * a report or an audit walks, so a listing of them is stable across runs,
 * mirroring `UNIT_ROLES` and `TERRAIN_ROLES`).
 *
 * This is the *engine's* list and the only one: `@civts/rules` re-exports it and
 * types `ImprovementSpec['kind']` with it, so a row whose kind the engine does
 * not understand cannot be written down, and a kind the engine gains cannot be
 * silently absent from validation.
 */
export const IMPROVEMENT_KINDS = ['road', 'mine', 'irrigation'] as const;

export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];

/**
 * One improvement built on one tile.
 *
 * Plain data inside `GameState`, and therefore part of every state hash:
 * changing this shape changes the persisted shape and needs a `SCHEMA_VERSION`
 * bump and an intentional golden rehash (see `state.ts`).
 */
export interface TileImprovement {
  /** The tile it stands on. */
  readonly tile: TileIndex;
  /** What was built there. Several kinds may share a tile. */
  readonly kind: ImprovementId;
}

/**
 * The engine's structural view of an improvement *type*. A validated
 * `@civts/rules` `ImprovementSpec` satisfies this — it carries every field below
 * plus `provenance`, which the engine never reads.
 *
 * `yields` is the **delta** the improvement adds to whatever tile it sits on, not
 * a replacement for the terrain's yields: a mine adds shields to a hill rather
 * than turning it into something else, which is what makes `cityYields` a sum of
 * the terrain's yields and each improvement's delta.
 */
export interface ImprovementDef {
  readonly id: ImprovementId;
  readonly kind: ImprovementKind;
  readonly name: string;
  /** Worker turns to complete; `validateRuleset` guarantees an integer >= 1. */
  readonly turns: number;
  /** The delta applied to the tile it sits on, per yield component. */
  readonly yields: TerrainYields;
  /** Where it may be built. Empty is a data error, not "anywhere". */
  readonly allowedRoles: readonly TerrainRole[];
}

/**
 * The improvement catalog of a ruleset, in catalog order. Data order, never RNG
 * order, so any "first match" derived from it is deterministic.
 *
 * A ruleset that ships no improvements states that with `improvements: []` — the
 * field is required on `RulesetView` (see `map.ts`), so "no catalog at all" is
 * not a shape a view can have, and there is nothing to defend against here.
 */
export const improvementCatalog = (ruleset: RulesetView): readonly ImprovementDef[] =>
  ruleset.improvements;

/** The improvement type `id`, or `undefined` when the ruleset does not define it. */
export const improvementDef = (
  ruleset: RulesetView,
  id: ImprovementId,
): ImprovementDef | undefined => improvementCatalog(ruleset).find((def) => def.id === id);

/**
 * The improvement KIND a stored id names, or `undefined` for an id that names none.
 *
 * The stored value is an **id** (`TileImprovement.kind` is an `ImprovementId`) and
 * the sort needs a **kind**, so this is the one place the two are related — and it is
 * a derivation, not an assertion: an id is read as the kind it spells, and an id that
 * spells no kind is honestly reported as unknown rather than being mistaken for one.
 * It is the best a module without a ruleset can do (see the module doc), and it is
 * exactly right for the shipped catalog, whose rows are named after their kinds.
 *
 * The parameter is widened to `string` because `IMPROVEMENT_KINDS` is a literal tuple
 * and `ImprovementId` is a *branded* string: neither is assignable to the other, and
 * the membership test is about the characters, which is what both values are at
 * runtime. That is a widening for a comparison, not a cast around the type system —
 * no `as` is used, and the result is typed as the union of real kinds.
 */
const kindNamedBy = (id: ImprovementId): ImprovementKind | undefined => {
  const name: string = id;
  return IMPROVEMENT_KINDS.find((kind) => kind === name);
};

/**
 * Where a stored improvement id sorts: the position of the **kind it names** in
 * `IMPROVEMENT_KINDS`, or `-1` for an id that names no kind.
 *
 * An index rather than a string comparison, because the order is then the statement of
 * `IMPROVEMENT_KINDS` (editorial, readable, and stable) rather than a property of the
 * character encoding — and because the shipped order (road, mine, irrigation) is
 * deliberately not code-unit order.
 *
 * An id outside the vocabulary sorts before every one inside it, which is arbitrary
 * but *fixed*: it is the same answer on every engine for every such id, so a foreign
 * save's order cannot move between runs. Two ids outside the vocabulary are separated
 * by `comparePairs`' spelling tie-break below, never by insertion order.
 */
const rankOfStoredId = (id: ImprovementId): number => {
  const kind = kindNamedBy(id);
  return kind === undefined ? -1 : IMPROVEMENT_KINDS.indexOf(kind);
};

/**
 * The stored order of a pair: tile first (ascending), then the rank of the id's kind,
 * then the id's own spelling. This is the one comparison the module sorts and inserts
 * by, so the stored order cannot depend on which helper wrote an entry — nor, because
 * of the tie-break, on the order the entries were added in.
 *
 * The tie-break exists for ids that name no kind, which all rank `-1`: without it, two
 * such ids on one tile compare equal in both directions and the list keeps whichever
 * order they arrived in. That would make the stored order — and therefore every state
 * hash — a function of insertion order for exactly the states this module is most
 * careful about (a save written by another build, a hand-built fixture). With it, the
 * order is a function of the pair *set*, which is what the module claims everywhere
 * else. On the shipped catalog it changes nothing: every id names a kind, so no two
 * entries on one tile ever reach the tie-break.
 *
 * The spelling comparison is `String` code-unit order, never `localeCompare`: a
 * collator would order by the environment's locale and make a hash depend on where the
 * game was run.
 */
const comparePairs = (a: TileImprovement, b: TileImprovement): number => {
  if (a.tile !== b.tile) return Number(a.tile) - Number(b.tile);
  const byKind = rankOfStoredId(a.kind) - rankOfStoredId(b.kind);
  if (byKind !== 0) return byKind;
  const left = String(a.kind);
  const right = String(b.kind);
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

/**
 * Is this entry a `(tile, kind)` pair? The shape half of the read below: a
 * hand-edited save or a foreign object can carry an array of anything, and an
 * entry that is not a pair names no tile, so it cannot be read as an improvement.
 */
const isPair = (entry: unknown): entry is TileImprovement => {
  if (typeof entry !== 'object' || entry === null) return false;
  const { tile, kind } = entry as { readonly tile?: unknown; readonly kind?: unknown };
  return typeof tile === 'number' && typeof kind === 'string';
};

/**
 * The pair list a state carries, and the one place this module reads the field.
 *
 * On every state the engine built this is `state.improvements`, unchanged and
 * uncopied: `newGame` writes the field, every helper below writes it back, and the
 * type requires it. The surrounding checks are for a state that did **not** come
 * from this build — a hand-built literal, a foreign object, a save written before
 * M4a — and they exist because of where a missing array would be noticed: in the
 * middle of a yield calculation. `FoundCity`'s auto-assignment ranks tiles through
 * `cityYields`, so a state without the field would produce a `TypeError` inside a
 * *read* of a city's output, which is a far worse answer than "nothing is built
 * here" — and much worse to debug, because the stack points at a worker rule that
 * is not involved at all.
 *
 * Reading such a state as having no improvements is the only true thing to say
 * about it, and it is the same reading this module already applies to an
 * improvement kind the ruleset does not describe: read what is there. The type
 * says the engine always writes the field, and `improvements.test.ts` pins that a
 * key genuinely absent at runtime reads as none, so this tolerance cannot be
 * removed without a test failing.
 */
const storedPairs = (state: GameState): readonly TileImprovement[] => {
  const field: unknown = state.improvements;
  if (!Array.isArray(field)) return [];
  // `Array.isArray` narrows to `any[]`, which would leak `any` into every read
  // below; `Array.from<unknown>` re-types it without a cast, and `filter(isPair)`
  // then narrows each entry honestly. So this is one shape check and one element
  // check, and neither of them is a claim to the compiler that it could not verify.
  return Array.from<unknown>(field).filter(isPair);
};

/** Is this pair already in the list? */
const contains = (
  improvements: readonly TileImprovement[],
  tile: TileIndex,
  kind: ImprovementId,
): boolean => improvements.some((entry) => entry.tile === tile && entry.kind === kind);

/**
 * Every improvement on `tile`, in the state's order (ascending kind), or `[]`.
 *
 * A pure read of the state that never consults a ruleset: the state says what is
 * built, the catalog says what a kind *does*, and keeping those apart is why an
 * unknown kind still appears here (it was built, whatever this build of the
 * ruleset thinks of it) while contributing no yields.
 */
export const improvementsAt = (state: GameState, tile: TileIndex): readonly ImprovementId[] =>
  storedPairs(state)
    .filter((entry) => entry.tile === tile)
    .map((entry) => entry.kind);

/** Is `kind` built on `tile`? The membership question, stated once. */
export const hasImprovement = (state: GameState, tile: TileIndex, kind: ImprovementId): boolean =>
  contains(storedPairs(state), tile, kind);

/**
 * `state` with `kind` built on `tile`.
 *
 * - **Idempotent.** Adding a pair that is already there returns a state *equal*
 *   to the input (the entry is not duplicated and nothing else changes) — so a
 *   caller that repeats a request cannot change a hash, which is what makes
 *   "improve the tile" safe to re-issue.
 * - **Ordered by construction.** The entry is inserted at its catalog position
 *   (`(tile, kind)`), so the list is sorted whatever order the pairs were added
 *   in. It never re-sorts the array, so a list a caller kept sorted stays
 *   untouched, entry for entry.
 * - **Pure.** The input state is not modified. On a genuine insertion the
 *   returned state has a fresh array; on a no-op the input object itself comes
 *   back, which is the cheapest true statement of "nothing changed".
 */
export const withImprovement = (
  state: GameState,
  tile: TileIndex,
  kind: ImprovementId,
): GameState => {
  const pairs = storedPairs(state);
  if (contains(pairs, tile, kind)) return state;

  const entry: TileImprovement = { tile, kind };
  const at = pairs.findIndex((existing) => comparePairs(existing, entry) > 0);
  const improvements: readonly TileImprovement[] =
    at === -1 ? [...pairs, entry] : [...pairs.slice(0, at), entry, ...pairs.slice(at)];

  return { ...state, improvements };
};

/**
 * `state` with `kind` removed from `tile`.
 *
 * Removing a pair that is not there returns an equal state (a fresh array, so the
 * call is uniform), and removing one that is there leaves every other entry —
 * including the other kinds on that same tile, and the same kind on other tiles —
 * exactly as it was. Pure: the input state is not modified.
 */
export const withoutImprovement = (
  state: GameState,
  tile: TileIndex,
  kind: ImprovementId,
): GameState => ({
  ...state,
  improvements: storedPairs(state).filter((entry) => !(entry.tile === tile && entry.kind === kind)),
});

/**
 * Apply every known improvement on `tile` to `terrain`, clamped at zero per
 * component — the one statement of "what does an improvement do to a tile", and
 * the function `cityYields` reaches through `tileYields`.
 *
 * - **Only known kinds contribute.** A pair whose kind no row defines adds
 *   nothing rather than throwing: the state is read as it is, and a ruleset that
 *   cannot describe what was built cannot claim it produces anything.
 * - **Clamped at zero, per component.** An improvement may never make a tile
 *   yield a negative amount (M4a, "Yields with improvements"): a delta that would
 *   push a component below zero leaves it at zero. The clamp is here, once, so
 *   the centre floor in `cities.ts` and this floor cannot be confused — they are
 *   different rules, and only one of them is about improvements.
 * - **Integer addition only** (PLAN.md §5.3): no floats, no rounding, no
 *   multiplication.
 * - **Not exported.** The public read is `tileYields`, below; this takes the
 *   terrain's yields as an argument because its caller has already resolved them,
 *   and a second public entry point that answered "what does this improvement do"
 *   would be a second thing to keep in step.
 */
const applyImprovements = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
  terrain: TerrainYields,
): TerrainYields => {
  let food = 0;
  let shields = 0;
  let commerce = 0;

  for (const kind of improvementsAt(state, tile)) {
    const def = improvementDef(ruleset, kind);
    if (def === undefined) continue;
    food += def.yields.food;
    shields += def.yields.shields;
    commerce += def.yields.commerce;
  }

  return {
    food: Math.max(0, terrain.food + food),
    shields: Math.max(0, terrain.shields + shields),
    commerce: Math.max(0, terrain.commerce + commerce),
  };
};

/**
 * The yields `tile` actually produces in `state`: its terrain yields plus every
 * known improvement's delta, clamped at zero per component — or `undefined` when
 * the tile is off the map or its terrain id is not in this ruleset.
 *
 * Exported because this is the question `cityYields` asks of a *worked* tile, and
 * a caller that wants "what is this tile worth now?" — a citizen-assignment
 * ranking, a tooltip, a test — must not re-derive it from a second reading of the
 * catalog. An unworked tile is worth exactly this and contributes nothing to a
 * city.
 *
 * This is deliberately **not** the centre's floored reading: the 1/1/1 centre
 * floor is a *city* rule and lives in `cities.ts`, because a city centre is not a
 * worked tile and is unaffected by improvements.
 */
export const tileYields = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): TerrainYields | undefined => {
  const id = state.map.terrain[tile];
  if (id === undefined) return undefined;
  const terrain = ruleset.terrains.find((def) => def.id === id)?.yields;
  if (terrain === undefined) return undefined;
  return applyImprovements(state, ruleset, tile, terrain);
};
