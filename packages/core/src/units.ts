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
 * - **`spawnUnit` is the one place a unit comes into being after setup.** M3
 *   needs it for a produced unit (and M3's huts, and barbarian bands, need the
 *   same thing), so the id allocation, the array insertion and the "full
 *   movement" rule live here once rather than in each caller. It is *not* a
 *   command: it does not touch `revision`, `turn` or the RNG — the caller that
 *   owns the transition does that (see `commands.ts` and the turn pipeline).
 * - **A unit's job is `work`, and it is `undefined` by being *absent*.**
 *   `Unit.work` is an optional field (M4a): an idle unit has no `work` key at
 *   all, never one holding `undefined`. That is not a style preference — a
 *   present-but-`undefined` key cannot survive a JSON round trip, so
 *   `canonicalize` rejects it and the state becomes unhashable. The same trap
 *   cost the project three bug hunts (M2's `Settings.ruleset`, M3's
 *   `City.production`, and the state hashes that moved for it), which is why
 *   `withWork`/`withoutWork` below — the only two writers of the field — rebuild
 *   the unit explicitly instead of spreading a key that might be `undefined`.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O. Every function is
 * a pure read of the state or the ruleset it is handed; `spawnUnit`, `withWork`
 * and `withoutWork` are pure rebuilds of one.
 */

import {
  asUnitId,
  type PlayerId,
  type ResourceId,
  type TileIndex,
  type UnitId,
  type UnitTypeId,
} from './ids.js';
// Type-only, and therefore erased: `UnitWork.kind` *is* an `ImprovementId`, but
// nothing here ever calls into `improvements.ts`, so this module gains no runtime
// edge (and no cycle: `improvements.ts` imports `GameState` type-only in turn).
import type { ImprovementId } from './improvements.js';
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
 * A job a unit is doing on the tile it stands on: which improvement, where, and
 * how many turns are still owed (M4a, "Workers").
 *
 * - **`tile` is stored even though it is always the unit's own tile while the
 *   job runs.** `StartWork` takes no target parameter for exactly that reason
 *   (INTERFACES.md M4a: "do not add a target parameter, it would only invite a
 *   mismatch"), and a job is *cancelled* rather than followed when the unit
 *   relocates — so the two stay in step by construction. It is stored anyway
 *   because completion happens in the turn pipeline, which reads the job off the
 *   unit: recording the tile in the job is what lets completion add the
 *   improvement to the tile the work was *started* on without a second lookup
 *   that could disagree.
 * - **`turnsLeft` is a positive whole number while the job is in progress.** It
 *   is decremented once per turn (step 1 of `advanceTurn`, in unit-id order) and
 *   the improvement is added when it reaches zero. It is part of every state
 *   hash, so a job whose count is not a whole number is never written: the
 *   command that starts one refuses a catalog row whose `turns` is not a usable
 *   count (see `planStartWork` in `commands.ts`).
 */
export interface UnitWork {
  readonly kind: ImprovementId;
  readonly tile: TileIndex;
  /** Turns still owed; `> 0` while the job is in progress. */
  readonly turnsLeft: number;
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
  /**
   * The job this unit is doing, **absent** when it is idle — never a key holding
   * `undefined` (see the module note, and `withWork`/`withoutWork` below, which
   * are the only writers of this field).
   */
  readonly work?: UnitWork;
}

/**
 * `unit` busy with `work` — the only way a job is ever attached.
 *
 * The unit is rebuilt field by field rather than spread, so the result carries
 * exactly the six fields `Unit` declares and `work` is written as a real value.
 * A spread (`{ ...unit, work }`) would also copy any field a *foreign* unit
 * object happened to carry, which is the sort of undeclared key that reaches a
 * state hash and surprises everyone; and, more importantly, the explicit rebuild
 * makes it impossible for this module to write `work: undefined` by accident.
 */
export const withWork = (unit: Unit, work: UnitWork): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
  work,
});

/**
 * `unit` idle — the `work` key is **removed**, not set to `undefined`.
 *
 * Used by `CancelWork`, by the relocation path that cancels a job when a unit
 * moves (M4a: "Moving a working unit … cancels its work"), and by `advanceTurn`
 * when a job completes. In every one of those the job is gone, and "gone" in
 * this state is an absent key: writing `undefined` there would make the state
 * unhashable, which is the failure mode this helper exists to make impossible.
 * Pure: the unit handed in is not modified, and a unit that was already idle
 * comes back equal to the input.
 */
export const withoutWork = (unit: Unit): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
});

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

/** The highest unit id in the state, or `-1` when there are no units at all. */
const highestUnitId = (state: GameState): number =>
  state.units.reduce((highest, unit) => Math.max(highest, Number(unit.id)), -1);

/**
 * The id the next unit created in this state must take.
 *
 * `nextUnitId` is authoritative — it is the state's own statement of "the id the
 * next created unit will take", and on any state `newGame` or `spawnUnit`
 * produced it is already past every existing id. The `max` below is a defence
 * against a *hand-built* state (or a hand-edited save) whose counter is stale: it
 * can only be tighter than `nextUnitId` when the state already uses the id it
 * would hand out, and reusing an id would make two units indistinguishable to
 * `unitById`, `unitsOnTile` and every owner check. Being total here is cheap;
 * discovering a duplicate id three systems later is not.
 */
const nextFreeUnitId = (state: GameState): UnitId =>
  asUnitId(Math.max(state.nextUnitId, highestUnitId(state) + 1));

/**
 * The movement a newly created unit of type `def` gets: the type's `movement`,
 * and only when that is a positive whole number.
 *
 * `validateRuleset` guarantees an integer `movement >= 1`, but a foreign or
 * hand-built view can carry a broken one, and `movementLeft` is part of every
 * state hash: a fractional or NaN budget would put a value into the state that
 * `canonicalize` cannot represent. A definition the engine cannot read therefore
 * grants 0 movement — the unit exists and can be seen, it simply cannot move
 * until the ruleset describes it properly.
 */
const fullMovement = (def: UnitDef): number =>
  Number.isInteger(def.movement) && def.movement > 0 ? def.movement : 0;

/** A unit that `spawnUnit` just created, together with the state that has it. */
export interface SpawnedUnit {
  readonly state: GameState;
  readonly unit: Unit;
}

/**
 * Place a new unit of type `def`, owned by `owner`, on `tile`, at full
 * movement — the one definition of "a unit comes into being" outside `newGame`.
 *
 * - **Id.** `nextFreeUnitId`, which is `state.nextUnitId` on every state the
 *   engine built and never an id already in use (see above). The new unit is
 *   appended and the array re-sorted by id, so the "sorted by id" invariant
 *   holds for the caller's state as well as for a well-formed one.
 * - **Movement.** Full (`def.movement`), because a unit that has just been built
 *   or just appeared has not spent anything this turn. `EndTurn` refills to the
 *   same number, so a unit spawned mid-turn is indistinguishable from one that
 *   started the turn there.
 * - **What it does not do.** No RNG draw (spawning is not a random event), no
 *   `revision` bump (that counts *applied commands*, M2 invariant 2), no fog
 *   fold (memory grows from movement and from `newGame`; a unit placed in a city
 *   sees what the player who founded that city already saw), and no terrain
 *   check: *where* a unit may appear is the caller's rule — M3 places a produced
 *   unit in its city's centre, a hut reward near the hut — and duplicating that
 *   judgement here would be a second statement of it.
 */
export const spawnUnit = (
  state: GameState,
  def: UnitDef,
  owner: PlayerId,
  tile: TileIndex,
): SpawnedUnit => {
  const id = nextFreeUnitId(state);
  const unit: Unit = {
    id,
    type: def.id,
    owner,
    tile,
    movementLeft: fullMovement(def),
  };

  const units = [...state.units, unit].sort((a, b) => Number(a.id) - Number(b.id));
  return { state: { ...state, nextUnitId: Number(id) + 1, units }, unit };
};
