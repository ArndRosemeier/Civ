/**
 * Units — the entities a player commands — and the lookups the engine performs
 * on them. See docs/INTERFACES.md, M2 ("Core — units, movement, fog"),
 * PLAN.md §5.3 (determinism) and §5.4 (data layout).
 *
 * Design notes:
 *
 * - **Units are an array, not a record.** `GameState.units` is a
 *   `readonly Unit[]` kept sorted by `id`. A `Record<UnitId, Unit>` would claim
 *   numeric keys that JSON turns into strings — a lie in the type — and its
 *   iteration order would be a property of the key set rather than of the game.
 *   An array states creation order outright, which is what makes state hashes
 *   stable, and it round-trips through JSON honestly.
 * - **Ids are dense and monotonic.** `GameState.nextUnitId` holds the id the
 *   next created unit will take, so an id is a function of creation order alone:
 *   nothing ambient to store and nothing to renumber. `newGame` hands out
 *   `0..civCount-1` and sets `nextUnitId` past them.
 * - **Lookups, not indexes.** `unitById` / `unitsOnTile` / `unitDef` cover every
 *   read the engine makes. An index cached by `revision` is the escape hatch if
 *   M7's perf budgets demand one (PLAN.md §5.4); until then a linear scan over
 *   small N is honest and cannot go stale.
 * - **`UnitDef` mirrors `UnitSpec`.** `core` cannot depend on the content
 *   package, so it declares the structural view it reads, exactly as
 *   `TerrainDef`/`TerrainSpec` do for terrain. `packages/rules` checks at compile
 *   time that its `UnitSpec` still satisfies this view.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O. Every function is
 * a pure read of the state or the ruleset it is handed.
 */

import {
  type PlayerId,
  type ResourceId,
  type TileIndex,
  type UnitId,
  type UnitTypeId,
} from './ids.js';
import type { RulesetView } from './map.js';
import type { GameState } from './state.js';

/**
 * The roles the engine needs a unit for. Ordered canonically — this is the order
 * a role audit walks, so a report about a catalog full of holes is stable across
 * runs (mirroring `TERRAIN_ROLES` in `map.ts`).
 */
export const UNIT_ROLES = ['settler', 'worker', 'scout', 'military'] as const;

export type UnitRole = (typeof UNIT_ROLES)[number];

/** Where a unit may stand: land units need land, sea units need water (M4+). */
export type UnitDomain = 'land' | 'sea';

/**
 * The engine's structural view of a unit *type*. A validated `@civts/rules`
 * `UnitSpec` satisfies this — it carries every field below plus `provenance`,
 * which the engine never reads.
 */
export interface UnitDef {
  readonly id: UnitTypeId;
  readonly role: UnitRole;
  readonly name: string;
  /** Offensive strength. Unused in M2: combat arrives in M6. */
  readonly attack: number;
  /** Defensive strength. Unused in M2. */
  readonly defense: number;
  /** Movement points per turn; `EndTurn` refills `movementLeft` to this. */
  readonly movement: number;
  /** Production cost in shields. Unused in M2: production arrives in M3+. */
  readonly cost: number;
  readonly domain: UnitDomain;
  /** M4; omitted by every M2 row. */
  readonly requiresResource?: ResourceId;
}

/**
 * A unit as it exists in the world.
 *
 * This is plain data inside `GameState`, so it is part of every state hash:
 * changing it changes the persisted shape and requires a `SCHEMA_VERSION` bump
 * and an intentional golden rehash.
 */
export interface Unit {
  /** Dense, assigned in creation order; `units` is sorted by it. */
  readonly id: UnitId;
  /** The unit type, resolved through `unitDef`. */
  readonly type: UnitTypeId;
  readonly owner: PlayerId;
  readonly tile: TileIndex;
  /** Movement points left this turn; spent by movement, refilled by `EndTurn`. */
  readonly movementLeft: number;
}

/**
 * The unit catalog of a ruleset, in catalog order. Data order, never RNG order,
 * so any "first match" derived from it is deterministic.
 *
 * A ruleset with no units states that with `units: []` — the catalog is a
 * required field of `RulesetView` (see `map.ts`), so "no catalog at all" is no
 * longer a shape a view can have, and there is nothing to defend against here.
 */
export const unitCatalog = (ruleset: RulesetView): readonly UnitDef[] => ruleset.units;

/** The unit type `type`, or `undefined` when the ruleset does not define it. */
export const unitDef = (ruleset: RulesetView, type: UnitTypeId): UnitDef | undefined =>
  ruleset.units.find((def) => def.id === type);

/**
 * The unit with this id, or `undefined`.
 *
 * `units` is sorted by id, so a binary search would be legal; a linear scan is
 * used instead because it stays correct if that invariant is ever violated and
 * because unit counts are small by design (PLAN.md §5.4).
 */
export const unitById = (state: GameState, id: UnitId): Unit | undefined =>
  state.units.find((unit) => unit.id === id);

/**
 * Every unit standing on `tile`, in id order (the order of `state.units`, which
 * is sorted by id). Empty when the tile is unoccupied — callers ask this of
 * every candidate destination tile, so "no units" is the common answer and not
 * an error.
 */
export const unitsOnTile = (state: GameState, tile: TileIndex): readonly Unit[] =>
  state.units.filter((unit) => unit.tile === tile);
