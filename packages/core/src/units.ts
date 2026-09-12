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
  /** Offensive strength (M6). Read in exactly one place: `combat.ts`. */
  readonly attack: number;
  /** Defensive strength (M6). Read in exactly one place: `combat.ts`. */
  readonly defense: number;
  /**
   * Hit points at **full health** — how many rounds of combat this unit survives
   * (M6, "Unit combat statistics"). `UnitSpec` requires it, and `validateRuleset`
   * refuses a non-integer or a value below 1.
   *
   * **Optional on this *view*, required on the spec.** That asymmetry is a
   * deliberate, recorded compromise, not an oversight: this view is the shape every
   * hand-built structural ruleset in the tree already satisfies (the `TerrainDef`
   * and `UnitDef` literals in `packages/core/test/*.test.ts`,
   * `packages/testing/src/scenario.ts`, `packages/sim`), and a *required* field here
   * would be a few hundred type errors in files this workstream does not own. The
   * engine's own construction paths always set it, every reader goes through
   * `fullHitPoints` below, and a view that omits it means "1" rather than "unknown".
   */
  readonly hitPoints?: number;
  /** Movement points per turn; `EndTurn` refills `movementLeft` to this. */
  readonly movement: number;
  /** Production cost in shields. Unused in M2: production arrives in M3+. */
  readonly cost: number;
  readonly domain: UnitDomain;
  /**
   * The resource this unit type needs (M4c). Absent on every row that needs
   * nothing — the key is **omitted**, never present and `undefined`, for the
   * reason every optional field in this project is: a present-but-`undefined` key
   * cannot survive a JSON round trip.
   *
   * What the field *means* is stated once, in `resources.ts`: a unit whose row
   * declares one may be produced only by a city whose owner has that resource
   * connected by road (`resourceGate`, read by `planSetProduction` in
   * `commands.ts`). This module owns the field's shape and nothing else — it does
   * not decide gating, and `requiredResourceOf` is the engine's only read of it.
   * `validateRuleset` rejects a value naming a resource no catalog row defines.
   */
  readonly requiresResource?: ResourceId;
  /**
   * M5's `requiresTech` is **not** declared on this view, and that is a decision
   * rather than an omission. Where it is declared is content (`@civts/rules`
   * `UnitSpec`, and the other three spec types); how the engine reads it is
   * `tech.ts`' `requiresTechOf(row: unknown)` — total on any row, whatever type that
   * row declares — with `resources.ts`' `unmetTechFor` as its one entry point for
   * gating. Declaring it here *as well* would state one field in two of the four
   * catalog views (`BuildingDef` lives in `cities.ts`, `ResourceDef` in `map.ts`),
   * and a view that declared it would invite readers to think this module decides
   * gating: it does not. `src/units.ts` owns the field's *shape* where it exists
   * (`requiresResource` above) and nothing about who may build what.
   *
   * A unit row that declares one is gated by it: `productionGate` (`resources.ts`)
   * refuses the item with the missing tech named, and `validateRuleset` — not this
   * module — is where a `requiresTech` naming a tech no catalog row defines is
   * rejected.
   */
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
  /**
   * Hit points left, in `1..hitPoints` (M6, "Units in play").
   *
   * **A unit at 0 hit points is DESTROYED, not stored at 0.** Nothing in this
   * module ever writes a live unit with `hitPointsLeft <= 0`: `woundUnit` removes
   * it from `state.units` instead, and `removeUnit` is how a caller does the same
   * deliberately. A live unit at 0 is the state that makes every later battle
   * wrong, which is why it is also a named invariant in `@civts/sim`.
   *
   * Optional on the *view* for the same recorded reason as `UnitDef.hitPoints`:
   * the many hand-built `Unit` literals in this tree predate M6, and every reader
   * goes through `hitPointsLeftOf`/`maxHitPointsOf` below, which treat "absent" as
   * "at full health" — the reading that keeps a pre-M6 fixture playable rather than
   * making it a unit that is already dead.
   */
  readonly hitPointsLeft?: number;
  /**
   * Promotions earned in combat, `0..MAX_EXPERIENCE`. **Absent when zero**, never a
   * key holding `undefined` — the M3 rule that has now blocked hashing four times
   * over (`Settings.ruleset`, `City.production`, `PlayerState.researching`, and the
   * state hashes that moved for each). Absence *is* zero: `experienceOf` below is
   * the only reader, and it answers 0 for an absent, non-integer or negative value.
   *
   * Experience never decreases — losing a combat a unit survives grants nothing,
   * and moving costs nothing — which `promoteUnit` and `woundUnit` both preserve.
   */
  readonly experience?: number;
  /**
   * Whether this unit has fortified in place (M6). **Absent when false**, never a
   * key holding `false` or `undefined`: "not fortified" is the absence of the key,
   * the same way the rest of this state spells every falsy optional field. Cleared
   * by any move (`clearFortified`), which is the rule the M6 contract states.
   */
  readonly fortified?: boolean;
}

/* ------------------------------------------------------------------ *
 * M6 — hit points, experience and fortification.
 *
 * Every reader and writer of the three new fields lives in the block at the END of
 * this module, so the "absent means zero/false/full" rule is stated once instead of
 * at each call site. All of them are total: a hand-built unit, an older save, or a
 * foreign object may carry any of the three as absent, as a fraction, or as
 * nonsense, and none of them may throw inside a legality check.
 * ------------------------------------------------------------------ */

/**
 * `unit` busy with `work` — the only way a job is ever attached.
 *
 * The unit is rebuilt field by field rather than spread, so the result carries
 * exactly the fields `Unit` declares and `work` is written as a real value.
 * A spread (`{ ...unit, work }`) would also copy any field a *foreign* unit
 * object happened to carry, which is the sort of undeclared key that reaches a
 * state hash and surprises everyone; and, more importantly, the explicit rebuild
 * makes it impossible for this module to write `work: undefined` by accident.
 *
 * M6's `hitPointsLeft`, `experience` and `fortified` are carried across: attaching a
 * job is not a healing event, a promotion or a fortification, and a rebuild that
 * dropped them would silently reset a wounded veteran to full health. The optional
 * pair is re-attached by `keepOptional`, which writes each key only when it is present —
 * so this function cannot spell "no promotions" as `undefined` either.
 */
export const withWork = (unit: Unit, work: UnitWork): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
  hitPointsLeft: hitPointsLeftOf(unit),
  ...keepOptional(unit),
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
 *
 * Like `withWork`, it carries M6's hit points, experience and fortification across —
 * a worker that finishes a job is the same unit with the same scars.
 */
export const withoutWork = (unit: Unit): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
  hitPointsLeft: hitPointsLeftOf(unit),
  ...keepOptionalExcept(unit, 'work'),
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
const highestUnitIdIn = (units: readonly Unit[]): number =>
  units.reduce((highest, unit) => Math.max(highest, Number(unit.id)), -1);

const highestUnitId = (state: GameState): number => highestUnitIdIn(state.units);

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
 * - **Hit points.** Full (`def.hitPoints`, M6), for exactly the same reason: a unit
 *   that has just been built has taken no damage. This is the only place a *new*
 *   unit's health is decided, so "everything starts at full" is one line rather than
 *   a convention each creation path has to remember — and a fresh unit with no
 *   `hitPointsLeft` at all is not a unit at 0, it is a unit the reader treats as
 *   un-wounded (`hitPointsLeftOf`).
 * - **Experience and fortification are absent**, which is the same statement: a new
 *   unit has no promotions and is not fortified, and this state spells both as an
 *   absent key rather than as `0`/`false` values.
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
    hitPointsLeft: fullHitPoints(def),
  };

  const units = [...state.units, unit].sort((a, b) => Number(a.id) - Number(b.id));
  return { state: { ...state, nextUnitId: Number(id) + 1, units }, unit };
};

/* ------------------------------------------------------------------ *
 * M6 — hit points, experience and fortification.
 *
 * Nothing above needs any of this, and section `advanceTurn` (step 1) is a pure
 * read of `hitPointsLeftOf`/`experienceOf`; so the whole block is kept together at
 * the end of the module, where it can build on `unitById` and `nextFreeUnitId`
 * rather than duplicating them.
 *
 * The three rules, stated once:
 *
 * 1. **Absent means the benign default**: no `hitPointsLeft` is a unit at full
 *    health as far as any reader is concerned (`hitPointsLeftOf` → 1), no
 *    `experience` is zero promotions, no `fortified` is "not fortified".
 * 2. **A unit at 0 hit points does not exist.** `damageUnit` answers `undefined`,
 *    `woundUnit` removes it from the state, and nothing here can write 0.
 * 3. **Every optional key is written by omission, never as `undefined`.** The single
 *    implementation of that is `keepOptional`/`keepOptionalExcept`, which every rebuild
 *    spreads, so no writer here can put `undefined` into a hashed state.
 * ------------------------------------------------------------------ */

/** Hit points a unit has when its type declares none — the smallest honest answer. */
const DEFAULT_HIT_POINTS = 1;

/**
 * The hit points at full health of a unit whose definition is `def`.
 *
 * `def.hitPoints` is optional on the view (see `UnitDef.hitPoints`), and
 * `validateRuleset` guarantees a whole number `>= 1` for anything it produced — but
 * a hand-built view can carry a fraction, a zero or a negative, and `hitPointsLeft`
 * is part of every state hash: a value `canonicalize` cannot represent must never
 * reach the state. A definition the engine cannot read therefore means 1 rather than
 * `NaN` or a throw.
 */
export const fullHitPoints = (def: UnitDef | undefined): number => {
  const declared = def?.hitPoints;
  return declared !== undefined && Number.isInteger(declared) && declared >= 1
    ? declared
    : DEFAULT_HIT_POINTS;
};

/**
 * Hit points **at full health** for a unit already in the world: its type's
 * `hitPoints` when the ruleset describes it, and otherwise the `fallback` the caller
 * derived from the unit itself (normally `hitPointsLeftOf(unit)`).
 *
 * The fallback matters because a type the view cannot resolve must not silently heal
 * a damaged unit: "the ruleset does not describe this type" and "this unit has full
 * health" are different facts, and only the second may be assumed.
 */
export const maxHitPointsOf = (def: UnitDef | undefined, fallback: number): number =>
  def?.hitPoints !== undefined ? fullHitPoints(def) : Math.max(fallback, DEFAULT_HIT_POINTS);

/** The promotions a unit has earned; an absent, fractional or negative value is 0. */
export const experienceOf = (unit: Unit): number => {
  const earned = unit.experience;
  return earned !== undefined && Number.isInteger(earned) && earned > 0 ? earned : 0;
};

/** Whether a unit is fortified in place; anything but `true` is "no". */
export const isFortified = (unit: Unit): boolean => unit.fortified === true;

/** Hit points a unit has left, floored at 1 — a unit in the world is alive. */
export const hitPointsLeftOf = (unit: Unit): number => {
  const left = unit.hitPointsLeft;
  return left !== undefined && Number.isInteger(left) && left >= 1 ? left : DEFAULT_HIT_POINTS;
};

/**
 * The optional keys of `unit` that are genuinely present, as an object safe to spread.
 *
 * A key whose value is `undefined` is **omitted**, not copied across: that is the whole
 * point of the helper. Spreading a unit directly (`{ ...unit }`) would copy such a key
 * and put `undefined` into a state hash; so would a `const { key, ...rest } = unit`
 * removal, because destructuring writes the removed key into `rest` as well.
 * `keepOptionalExcept` is the same thing with one key left out, which is what a
 * *removal* needs.
 */
const keepOptional = (unit: Unit): object => keepOptionalExcept(unit, undefined);

/**
 * The optional keys of `unit` that are present, minus `skip`.
 *
 * `skip` is typed as the field names rather than as a string so a typo is a compile error
 * and so a fourth optional key cannot be added without this function being revisited —
 * the failure mode it exists to prevent. `work` is on the list for the same reason the
 * other two are: leaving a job is spelled by the key being absent, so `withoutWork` is a
 * removal too.
 */
const keepOptionalExcept = (
  unit: Unit,
  skip: 'work' | 'experience' | 'fortified' | undefined,
): object => ({
  ...(skip === 'work' || unit.work === undefined ? {} : { work: unit.work }),
  ...(skip === 'experience' || unit.experience === undefined
    ? {}
    : { experience: unit.experience }),
  ...(skip === 'fortified' || unit.fortified === undefined ? {} : { fortified: unit.fortified }),
});

/**
 * `unit` with its hit points set to `hitPointsLeft` — the one writer of that field.
 *
 * Rebuilt field by field rather than spread, for the reason `withWork` states: a
 * spread would copy any undeclared key a foreign unit object happened to carry
 * straight into the state hash. Every optional key the unit already had is
 * re-attached only when it is genuinely present (`keepOptional`), so this cannot write
 * `undefined` — and a rebuild that used a *rest pattern* to delete one of them would,
 * because destructuring a present-but-`undefined` key puts the key back in the rest
 * object. That distinction is why the removers below are explicit rebuilds too.
 *
 * It does **not** enforce the `>= 1` rule — that is `damageUnit`'s job, which is the
 * only path that lowers hit points. This setter is for raising them (`healUnit`) and
 * for the full-health value a fresh unit is built with.
 */
export const withHitPointsLeft = (unit: Unit, hitPointsLeft: number): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
  hitPointsLeft,
  ...keepOptional(unit),
});

/**
 * `unit` with `experience` promotions; a value that is not a positive integer clears
 * the field instead of writing it, so `0`, a fraction and `NaN` all mean "no
 * promotions" — spelled by absence, which is the only spelling this state accepts.
 */
export const withExperience = (unit: Unit, experience: number): Unit =>
  Number.isInteger(experience) && experience > 0
    ? { ...unit, experience }
    : withoutExperience(unit);

/** `unit` with no `experience` key at all — zero promotions, spelled by absence. */
export const withoutExperience = (unit: Unit): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
  hitPointsLeft: hitPointsLeftOf(unit),
  // Every other key is re-attached by hand rather than by a rest-pattern: a spread of the
  // unit followed by a destructured removal would leave `experience: undefined` *present*
  // on the result (destructuring copies the key it removed into the rest object and then
  // the spread writes it back), and a present-but-`undefined` key is the one shape
  // `canonicalize` refuses. This is the fourth time that trap has been approached in this
  // project; here it is closed by construction rather than by care.
  ...keepOptionalExcept(unit, 'experience'),
});

/** `unit` fortified in place — `fortified: true` is the only value this field takes. */
export const withFortified = (unit: Unit): Unit => ({ ...unit, fortified: true });

/** `unit` with the `fortified` key **removed**, never set to `false` or `undefined`. */
export const clearFortified = (unit: Unit): Unit => ({
  id: unit.id,
  type: unit.type,
  owner: unit.owner,
  tile: unit.tile,
  movementLeft: unit.movementLeft,
  hitPointsLeft: hitPointsLeftOf(unit),
  ...keepOptionalExcept(unit, 'fortified'),
});

/**
 * `unit` after taking `damage` hit points, or `undefined` when that kills it.
 *
 * The rules this function exists to make unbreakable:
 *
 * - **The result never falls below zero, and zero is not a unit.** It returns
 *   `undefined` at `<= 0`, so a caller cannot construct a live unit with 0 hit points
 *   by forgetting to special-case the subtraction. `woundUnit` below is the engine's
 *   damage path and it removes rather than stores.
 * - **Experience and fortification survive.** A wound is a wound; promotions and a
 *   dug-in position are not lost by being hit.
 * - **It is total.** A negative damage value heals (see `healUnit` for the capped
 *   version); a fractional one would land in a hashed field, so a non-integer is a
 *   no-op rather than a value `canonicalize` would reject.
 */
export const damageUnit = (unit: Unit, damage: number): Unit | undefined => {
  if (!Number.isInteger(damage) || damage < 0) return unit;
  const left = hitPointsLeftOf(unit) - damage;
  return left > 0 ? withHitPointsLeft(unit, left) : undefined;
};

/**
 * `unit` restored by `amount` hit points, capped at its type's `hitPoints`.
 *
 * Healing needs the maximum, and the maximum may have to come from the *unit* rather
 * than from a ruleset the caller does not have — a unit can outlive the view that
 * built it, which is the same observation `turn.ts` makes about the movement refill.
 * So when the definition is unavailable the cap is the unit's own `hitPointsLeft`:
 * without a definition, "full" is whatever the unit already has, and `healUnit` is
 * then a no-op rather than an invented promotion to full.
 *
 * A non-positive or fractional `amount` is a no-op, so healing cannot write a fraction
 * into the state either.
 */
export const healUnit = (unit: Unit, def: UnitDef | undefined, amount: number): Unit => {
  if (!Number.isInteger(amount) || amount <= 0) return unit;
  const current = hitPointsLeftOf(unit);
  const maximum = maxHitPointsOf(def, current);
  return withHitPointsLeft(unit, Math.min(current + amount, maximum));
};

/**
 * One promotion, or the same unit when it is already at `maxLevel`.
 *
 * Experience never decreases (M6, "Experience and promotion"), so this only ever
 * raises the level; a `maxLevel` that is not a positive integer means "no promotions
 * are available" and the unit comes back untouched rather than being given one.
 */
export const promoteUnit = (unit: Unit, maxLevel: number): Unit => {
  const earned = experienceOf(unit);
  const cap = Number.isInteger(maxLevel) && maxLevel > 0 ? maxLevel : 0;
  return earned >= cap ? unit : withExperience(unit, earned + 1);
};

/**
 * Rebuild `state.units` from `units` — the one writer of the unit list.
 *
 * Only `units`, `nextUnitId` and `revision` are touched. `nextUnitId` is tightened
 * past every id in the new list, for the reason `nextFreeUnitId` gives: reusing an id
 * would make two units indistinguishable to every lookup and owner check.
 *
 * `revision` counts *applied commands* (M2 invariant 2), and whether this rebuild is
 * part of applying one is the caller's fact, not this function's — so the bump is an
 * argument rather than a decision: a command passes 1 and a hand rebuild passes 0.
 */
export const withUnits = (
  state: GameState,
  units: readonly Unit[],
  revisionBump: number,
): GameState => ({
  ...state,
  revision: state.revision + revisionBump,
  nextUnitId: Math.max(state.nextUnitId, highestUnitIdIn(units) + 1),
  units: [...units].sort((a, b) => Number(a.id) - Number(b.id)),
});

/**
 * `state` with `unitId` gone — the one way a unit leaves the world.
 *
 * A unit that is not in the state is *not* an error: the caller is asking for it to
 * be absent, and it already is. That reading matters because destruction runs inside
 * combat resolution and inside bankruptcy, where "the unit was already removed by an
 * earlier step of the same turn" is a legitimate state of affairs rather than a bug
 * worth reporting.
 */
export const removeUnit = (state: GameState, unitId: UnitId): GameState =>
  withUnits(
    state,
    state.units.filter((unit) => unit.id !== unitId),
    0,
  );

/** What wounding a unit did: the state after it, and whether the unit survived. */
export interface WoundOutcome {
  readonly state: GameState;
  /** The wounded unit, or `undefined` when the damage destroyed it. */
  readonly unit: Unit | undefined;
  readonly destroyed: boolean;
}

/**
 * `state` with `unitId` wounded by `damage`: the damaged unit, or the unit **removed**
 * when the damage kills it.
 *
 * **This is the engine's damage entry point, and it never leaves a live unit at 0 hit
 * points.** `damageUnit` already answers `undefined` at zero; this function is what
 * turns that answer into state, which is how the M6 rule "a unit at 0 is DESTROYED,
 * not stored at 0" is enforced in one place instead of at every call site. It is also
 * what makes that rule a *property of the module* rather than a convention a caller
 * has to remember.
 *
 * `undefined` means the state does not hold that unit at all — a caller cannot conjure
 * one into existence by wounding it, and combat resolution needs to distinguish "this
 * unit is already gone" from "this unit just died".
 */
export const woundUnit = (
  state: GameState,
  unitId: UnitId,
  damage: number,
): WoundOutcome | undefined => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return undefined;

  const wounded = damageUnit(unit, damage);
  if (wounded === undefined) {
    return { state: removeUnit(state, unitId), unit: undefined, destroyed: true };
  }

  return {
    state: withUnits(
      state,
      state.units.map((candidate) => (candidate.id === unitId ? wounded : candidate)),
      0,
    ),
    unit: wounded,
    destroyed: false,
  };
};
