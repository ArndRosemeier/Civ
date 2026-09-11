/**
 * Commands — the only way the game state changes — with the typed reasons a
 * command is refused and the events an applied command emits.
 * See docs/INTERFACES.md, M2 ("Core — commands, errors, legal actions"),
 * PLAN.md §4.4 (exhaustive unions) and §5.3 (determinism).
 *
 * Design notes:
 *
 * - **One evaluator, two callers.** `planMove` is the single statement of "may
 *   this unit step onto this tile, and what does the step cost?". `applyCommand`
 *   refuses with its error and `actions.ts` enumerates legal moves with it, so
 *   the UI and the AI cannot advertise a move the engine would reject. That is
 *   M2's keystone property (INTERFACES.md, invariant 1) and it holds *by
 *   construction* here rather than by two code paths agreeing by review.
 * - **Pure.** Nothing below mutates `state`, `ruleset` or `cmd`: results are
 *   built from fresh arrays and objects, `revision` is bumped exactly once on
 *   success and left untouched on failure, and the ruleset is only read. A
 *   caller may deep-freeze its state and still apply commands.
 * - **The ruleset argument is required — the compiler enforces it.** `MoveUnit`
 *   needs the destination terrain's `moveCost`/`impassable`, and `EndTurn` needs
 *   each unit type's `movement` to refill `movementLeft`, but `GameState` carries
 *   neither: `map.terrain` holds ids, and `Unit` has no maximum-movement field.
 *   `applyCommand(state, playerId, cmd, ruleset)` therefore takes the view as a
 *   **required** fourth parameter, exactly as the amended contract states
 *   (INTERFACES.md M2, "Amendment (post-review, binding)"), and `RulesetView`
 *   carries the unit catalog the refill reads. An earlier interim version made
 *   the parameter optional and refused at runtime: it compiled, the typechecker
 *   could not catch a missing argument, and every command silently failed. The
 *   type is the guarantee here; there is no runtime refusal to fall back on.
 * - **Single step (M2).** `MoveUnit` targets one of the 8 adjacent tiles. Paths
 *   are an M7 convenience and are deliberately absent: a non-adjacent `to` is
 *   `invalid-argument`, never a silently expanded path.
 * - **Combat is M6.** A tile occupied by another player is simply not enterable
 *   (`occupied-by-enemy`); nothing here resolves an attack. A tile occupied by
 *   *your own* units is enterable — Civ 3 stacks, and M2 sets no stacking limit
 *   (recorded as debt, with a stacking cap as the M3+ owner's call).
 * - **Fog is folded, not consulted.** Legality never asks what is explored
 *   (INTERFACES.md M2 leaves fog out of the legality rule); a successful move
 *   folds the player's new `visibleTiles` into `explored` through `fog.ts`, which
 *   is the "moving a unit extends explored" half of the fog contract. The fog
 *   module owns the radius and the memory rule; this layer only says *when*.
 * - **`EndTurn` advances the world.** M2's `GameState` has no active-player
 *   field, so `turn` is a round counter: ending the turn refills *every* unit's
 *   movement and increments `turn` once. Refilling only the caller's units would
 *   leave the other players' units frozen forever, with nothing in the state
 *   saying whose turn it is; per-player turn order arrives with the M5 AI.
 * - **`EndTurn` is total.** Ending a turn refills the units whose type the
 *   ruleset defines and leaves the rest exactly as they are, so the turn always
 *   applies. An adversarial sweep found the opposite: `legalActions` yields
 *   `EndTurn` for any real player, but the interim refill refused the whole turn
 *   when one unit's `type` was absent from the ruleset — a generator and an
 *   applier disagreeing, which is the latent bug the keystone invariant exists to
 *   catch. Refusing was never honest either: there is no movement budget to guess
 *   for a type the view does not describe, and a unit the ruleset cannot resolve
 *   is best left untouched rather than silently given *some* budget. The state is
 *   unreachable from `newGame`, but reachable from a hand-built state, a foreign
 *   ruleset view or a future save load.
 *
 * M3 adds three commands — `FoundCity`, `SetWorkedTiles`, `SetProduction` — and
 * with them three more notes:
 *
 * - **One evaluator, two callers, again.** Each new command has a *plan*
 *   function (`planFoundCity`, `planSetWorkedTiles`, `planSetProduction`), the
 *   same arrangement `planMove` established: `applyCommand` decides with it, and
 *   a caller that wants to know whether a choice is legal (the AI picking a tile
 *   to work, the UI greying out a button, a test asserting a refusal) asks the
 *   same function. A generator and an applier that disagree is a bug, and the way
 *   to make disagreement impossible is to have one evaluator rather than two
 *   careful ones.
 * - **Founding consumes the settler, and that *is* "already used".** M3 has no
 *   "has this settler founded yet?" flag, and does not need one: the settler
 *   leaves `units` when the city appears, so a used settler is an id that no
 *   longer resolves. `planFoundCity` therefore requires a unit that exists, is
 *   owned by the actor, and whose type the ruleset resolves with
 *   `role: 'settler'` — a worker, a warrior or a type the view does not describe
 *   cannot found, and neither can a settler that is already a city.
 * - **The two setters emit no event.** The contract's M3 list of new
 *   `GameEvent` members (INTERFACES.md, "Commands (added to the frozen union)")
 *   names `CityFounded`, `CityGrew`, `CityStarved`, `CityProduced`, `HutEntered`
 *   and `BarbariansSpawned` — and nothing for a re-assignment or a queue change.
 *   The command's own payload is the record of that change, so `SetWorkedTiles`
 *   and `SetProduction` apply with an empty event list rather than amending a
 *   frozen union with members it does not have.
 * - **The turn is not this file's idea.** `EndTurn` checks the actor, calls
 *   `advanceTurn` in `turn.ts`, and appends its own `TurnEnded` event. Growth, production, the refill and `turn += 1` happen in that order
 *   because `turn.ts` says so, in one place, for every caller.
 * - **Goody huts hang off `MoveUnit`, and their rule lives in `hut.ts`.** A land
 *   unit entering a hut consumes it and draws a reward from the state RNG (a free
 *   unit, a band of barbarians near the hut, or nothing). This file states *when*
 *   that happens — the moment a successful step has put the mover on the
 *   destination tile — and `hut.ts` states *what* it does, so the reward table,
 *   the band size and the barbarian placement have one home rather than a second
 *   copy here. The result is one applied command bumping `revision` exactly once
 *   while emitting up to three events: `UnitMoved`, `HutEntered`, and
 *   `BarbariansSpawned` when the draw produced a band.
 *
 * M4a adds two commands — `StartWork` and `CancelWork` — and with them:
 *
 * - **One evaluator, two callers, a third time.** `planStartWork` and
 *   `planCancelWork` state a worker's legality once; `applyCommand` decides with
 *   them and `actions.ts` advertises with them, so the fifth generator cannot
 *   drift from the applier (M4a fixes this as the keystone invariant, both
 *   directions, across five generators).
 * - **`StartWork` has no target tile, and that is the point.** The job is on the
 *   unit's *own* tile: a target parameter would only invite a mismatch between
 *   the unit's position and the tile being improved, and there is nothing it
 *   could express that moving the worker first does not. `planStartWork` still
 *   resolves and checks the tile, because the improvement has to be *allowed on
 *   that terrain role* — the rule that makes a mine a hills-and-mountains job.
 * - **Starting work spends the unit's whole turn.** It costs the unit's
 *   remaining movement, so a worker that has moved cannot also start a job and a
 *   worker that starts a job cannot also move. That is a **placeholder** rule of
 *   ours (Civ 3's worker movement accounting is not reproduced here, and M4a's
 *   contract only says "it costs the unit's remaining movement for the turn").
 * - **Work progress is not this file's idea.** `turn.ts` owns it, as step 1 of
 *   the turn, because an improvement finished this turn must contribute to this
 *   turn's yields. This layer only attaches and detaches jobs.
 * - **Relocation cancels a job, in the event stream.** A step that moves a
 *   working unit drops its `work` and appends `WorkCancelled` with
 *   `reason: 'moved'`, so a consumer sees the cancellation rather than having to
 *   diff the unit to discover it. `CancelWork` emits the same event with
 *   `reason: 'cancelled'`; both are the *same* event type because they are the
 *   same fact — the job is over and nothing was refunded.
 * - **The improvement is added on completion, never on start.** Starting a job
 *   writes only `work`; the pair lands in `state.improvements` when the last
 *   turn is paid (in `turn.ts`), which is what makes the job cancellable without
 *   unpicking anything.
 */

import {
  autoAssignWorkedTiles,
  cityById,
  cityRadius,
  MIN_CITY_DISTANCE,
  type City,
  type ProductionItem,
} from './cities.js';
import { visibleTiles, withExplored } from './fog.js';
import { resolveHutEntry, type HutRewardKind } from './hut.js';
// Runtime imports, not type-only: `StartWork` asks the catalog what a job *is*
// (its `turns` and its `allowedRoles`) and whether the tile already carries the
// improvement, and both answers come from `improvements.ts` — the module that
// owns the pair list. Keeping those reads there is what stops this file from
// growing a second opinion about what is built where.
import { hasImprovement, improvementDef, type ImprovementId } from './improvements.js';
import {
  asCityId,
  asPlayerId,
  asTileIndex,
  asUnitId,
  type BuildingId,
  type CityId,
  type PlayerId,
  type TileIndex,
  type UnitId,
} from './ids.js';
import {
  distance8,
  inBounds,
  indexToX,
  indexToY,
  terrainAtIndex,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from './map.js';
import { itemCostOf } from './production.js';
import { err, ok, type Result } from './result.js';
import type { GameState, PlayerState } from './state.js';
import { advanceTurn } from './turn.js';
import {
  unitById,
  unitDef,
  unitsOnTile,
  withWork,
  withoutWork,
  type Unit,
  type UnitWork,
} from './units.js';

/**
 * Every way a player may change the game. An exhaustive union (PLAN.md §4.4) so
 * a consumer that switches on `type` is told by the typechecker when a command
 * is added.
 */
export type Command =
  | { readonly type: 'MoveUnit'; readonly unitId: UnitId; readonly to: TileIndex }
  | { readonly type: 'EndTurn' }
  | { readonly type: 'FoundCity'; readonly unitId: UnitId }
  | {
      readonly type: 'SetWorkedTiles';
      readonly cityId: CityId;
      readonly tiles: readonly TileIndex[];
    }
  | { readonly type: 'SetProduction'; readonly cityId: CityId; readonly item: ProductionItem }
  /**
   * Put the unit to work improving the tile it stands on (M4a). No `tile`
   * parameter: the tile *is* the unit's own, which removes the only way a caller
   * could ask for a job somewhere the unit is not.
   */
  | { readonly type: 'StartWork'; readonly unitId: UnitId; readonly kind: ImprovementId }
  /** Abandon the unit's job. Nothing is refunded: the turns already paid are spent. */
  | { readonly type: 'CancelWork'; readonly unitId: UnitId };

/**
 * Every way a command can be refused, as a *reason* rather than a message
 * (PLAN.md §4.4): the AI branches on these, the UI renders them, and tests
 * assert on them.
 *
 * M3 adds the reasons the city commands need. They are separate members rather
 * than one catch-all because the *fix* differs: a tile outside the radius wants a
 * different tile, a tile another city works wants that claim released, an unknown
 * production item wants a different item, and a building the city already has
 * wants another project entirely.
 */
export type GameError =
  | { readonly kind: 'unknown-unit'; readonly unitId: UnitId }
  | { readonly kind: 'unknown-player'; readonly playerId: PlayerId }
  | { readonly kind: 'not-your-unit'; readonly unitId: UnitId; readonly owner: PlayerId }
  | { readonly kind: 'out-of-bounds'; readonly to: TileIndex }
  | { readonly kind: 'impassable'; readonly unitId: UnitId; readonly to: TileIndex }
  | {
      readonly kind: 'not-enough-movement';
      readonly unitId: UnitId;
      readonly needed: number;
      readonly available: number;
    }
  | { readonly kind: 'occupied-by-enemy'; readonly unitId: UnitId; readonly to: TileIndex }
  /**
   * `FoundCity` was asked of a unit that is not an unused settler-role unit —
   * including a unit whose type the ruleset does not describe, because the engine
   * cannot see a settler there. A settler that has *already* founded a city is
   * gone from `state.units`, so that case reports `unknown-unit` (see the module
   * note).
   */
  | { readonly kind: 'not-a-settler'; readonly unitId: UnitId }
  /** `FoundCity` on a tile that is not land (ocean or coast). */
  | { readonly kind: 'not-on-land'; readonly unitId: UnitId; readonly tile: TileIndex }
  /** `FoundCity` too close to an existing city, nearest first. */
  | {
      readonly kind: 'city-too-close';
      readonly unitId: UnitId;
      readonly tile: TileIndex;
      readonly cityId: CityId;
      readonly distance: number;
      readonly minDistance: number;
    }
  | { readonly kind: 'unknown-city'; readonly cityId: CityId }
  | { readonly kind: 'not-your-city'; readonly cityId: CityId; readonly owner: PlayerId }
  /**
   * A tile a city may not work at all: outside its radius, off the map, or the
   * city centre itself (which is always worked and costs no citizen).
   */
  | { readonly kind: 'tile-not-workable'; readonly cityId: CityId; readonly tile: TileIndex }
  /** A tile another city (of any owner) already works. */
  | {
      readonly kind: 'tile-worked-by-another-city';
      readonly cityId: CityId;
      readonly tile: TileIndex;
      readonly byCityId: CityId;
    }
  /** The same tile listed twice: one citizen works one tile. */
  | { readonly kind: 'duplicate-worked-tile'; readonly cityId: CityId; readonly tile: TileIndex }
  /** More tiles than the city has citizens to work them. */
  | {
      readonly kind: 'too-many-worked-tiles';
      readonly cityId: CityId;
      readonly requested: number;
      readonly allowed: number;
    }
  /**
   * A production item this ruleset cannot build: an id no catalog defines, or one
   * whose cost is not a usable number of shields (see `itemCostOf`).
   */
  | { readonly kind: 'unknown-production-item'; readonly item: ProductionItem }
  /** The city already has this building; building it twice is not a no-op. */
  | { readonly kind: 'already-built'; readonly cityId: CityId; readonly building: BuildingId }
  /**
   * `StartWork` was asked of a unit that is not a worker — including a unit whose
   * type the ruleset does not describe, because the engine cannot see a worker
   * there. Only a `worker`-role unit can improve a tile (M4a, "Workers"); a scout
   * standing on a hill is not a mine that has not been dug yet.
   */
  | { readonly kind: 'not-a-worker'; readonly unitId: UnitId }
  /** `StartWork` on a unit that is already working: one job at a time. */
  | {
      readonly kind: 'already-working';
      readonly unitId: UnitId;
      /** The job it is already doing, so the caller can say what to cancel first. */
      readonly improvement: ImprovementId;
    }
  /** `CancelWork` on a unit that is not working: there is nothing to cancel. */
  | { readonly kind: 'not-working'; readonly unitId: UnitId }
  /**
   * `StartWork` naming an improvement this ruleset cannot build: an id no row
   * defines, or a row whose `turns` is not a usable count (see `workTurnsOf`).
   * The two are one error kind for the same reason `unknown-production-item`
   * covers an unusable cost: both mean "this ruleset cannot build that", and the
   * *fix* is the same — pick an improvement the catalog describes.
   */
  | { readonly kind: 'unknown-improvement'; readonly improvement: ImprovementId }
  /** The improvement cannot be built on this terrain role: a mine needs rock. */
  | {
      readonly kind: 'improvement-not-allowed';
      readonly unitId: UnitId;
      readonly tile: TileIndex;
      readonly improvement: ImprovementId;
      readonly role: TerrainRole;
    }
  /** The tile already carries this improvement; building it again is not a no-op. */
  | {
      readonly kind: 'already-improved';
      readonly tile: TileIndex;
      readonly improvement: ImprovementId;
    }
  | { readonly kind: 'invalid-argument'; readonly detail: string };

/**
 * What an applied command did, for consumers that must not diff the whole state
 * (PLAN.md §5.4: the UI receives events, not 16k tiles per turn). M2 emits two
 * events; M3 adds the four city ones below. The union is exhaustive so a
 * consumer's `switch` is checked, and every event is plain data, so an event log
 * is as hashable as the state it came from.
 *
 * M3's two hut events (`HutEntered`, `BarbariansSpawned` — INTERFACES.md M3,
 * "Commands (added to the frozen union)") are declared here, with the payload this
 * workstream produced, and they are emitted by the `MoveUnit` case below through
 * `hut.ts`. `HutEntered` is emitted **whenever a hut is consumed**, including for
 * the `nothing` reward: "nothing" is a reward, and a consumer that had to infer
 * consumption from the absence of an event would be reading a diff.
 *
 * M4a adds three more: `WorkStarted`, `WorkCancelled` and `WorkCompleted`. The
 * middle one is the reason the event stream exists — a step that relocates a
 * working unit *cancels* the job, and a consumer that had to diff the unit to
 * find that out would be reading exactly the kind of change events are for. There
 * is deliberately no `WorkProgressed` event: a job losing a turn is visible in
 * the state's `turnsLeft`, and a per-turn event for every worker would be a log
 * line that says nothing new. Completion is the event; progress is state.
 */
export type GameEvent =
  | {
      readonly type: 'UnitMoved';
      readonly unitId: UnitId;
      readonly from: TileIndex;
      readonly to: TileIndex;
      /** The destination terrain's `moveCost`, actually paid. */
      readonly cost: number;
      /** That unit's movement after the step. */
      readonly movementLeft: number;
    }
  | { readonly type: 'TurnEnded'; readonly playerId: PlayerId; readonly turn: number }
  /** A city appeared: `FoundCity` succeeded, and the settler is gone. */
  | {
      readonly type: 'CityFounded';
      readonly cityId: CityId;
      readonly owner: PlayerId;
      readonly name: string;
      readonly tile: TileIndex;
    }
  /** `population` citizens now, with `foodBox` carried over toward the next one. */
  | {
      readonly type: 'CityGrew';
      readonly cityId: CityId;
      readonly owner: PlayerId;
      readonly population: number;
      readonly foodBox: number;
    }
  /** A deficit took a citizen (never below 1) and restarted the food box at 0. */
  | {
      readonly type: 'CityStarved';
      readonly cityId: CityId;
      readonly owner: PlayerId;
      readonly population: number;
      readonly foodBox: number;
    }
  /**
   * A city finished an item; `shields` is what stayed in its pool. `unitId` and
   * `tile` are present only when the item was a unit, and say where it appeared.
   */
  | {
      readonly type: 'CityProduced';
      readonly cityId: CityId;
      readonly owner: PlayerId;
      readonly item: ProductionItem;
      readonly shields: number;
      readonly unitId?: UnitId;
      readonly tile?: TileIndex;
    }
  /**
   * A goody hut was consumed: `unitId` (owned by `owner`) stepped onto it at
   * `tile`, and `reward` says what the player got. The hut is gone from
   * `state.map.huts` and `state.rng` has advanced by one draw — for `nothing` too,
   * because a spent hut is spent whatever it held.
   *
   * `unitGiven` is present only for the `unit` reward, and names the free unit
   * that appeared on `tile`; the other two rewards have no unit to name, so the
   * key is **absent** rather than present-and-`undefined` (`exactOptionalPropertyTypes`,
   * and a present-but-`undefined` key cannot survive canonical JSON — the same
   * trap `City.production` documents).
   *
   * `reward` is one of `HUT_REWARD_KINDS` (`hut.ts`), which is exhaustive-for-M3:
   * it has no `gold` member because M3 has no treasury and M4 owns one, and the
   * reward reports what the player actually received, so a branch this ruleset
   * cannot honour (no `military` land unit to give away, or nowhere for a band to
   * stand) arrives here as `nothing`.
   */
  | {
      readonly type: 'HutEntered';
      readonly unitId: UnitId;
      readonly owner: PlayerId;
      readonly tile: TileIndex;
      readonly reward: HutRewardKind;
      readonly unitGiven?: UnitId;
    }
  /**
   * A hut's band appeared: `owner` is the barbarian player, `tile` is the hut the
   * band came out of, and `unitIds`/`tiles` are parallel lists (ascending tile
   * order) saying which unit stands where. Never empty — a band the map has no
   * room for is reported as `reward: 'nothing'` on the `HutEntered` event instead,
   * because a spawn event naming no units would be a written-down non-event.
   *
   * The units it names are ordinary `Unit`s owned by an ordinary player
   * (`PlayerState.kind === 'barbarian'`), so nothing downstream needs a barbarian
   * special case to move them.
   */
  | {
      readonly type: 'BarbariansSpawned';
      readonly owner: PlayerId;
      readonly tile: TileIndex;
      readonly unitIds: readonly UnitId[];
      readonly tiles: readonly TileIndex[];
    }
  /**
   * A worker began a job (M4a): `turnsLeft` is what the command's plan says the
   * job owes, so a consumer can render "3 turns" without reading the catalog, and
   * `tile` is the unit's own tile — the one the improvement will land on.
   */
  | {
      readonly type: 'WorkStarted';
      readonly unitId: UnitId;
      readonly kind: ImprovementId;
      readonly tile: TileIndex;
      readonly turnsLeft: number;
    }
  /**
   * A job ended without producing anything: the unit was told to stop
   * (`reason: 'cancelled'`) or it relocated, which cancels work by construction
   * (`reason: 'moved'`). `turnsLeft` is how much of the job was still owed when it
   * was abandoned — never refunded, which is why it is reported rather than
   * silently dropped.
   */
  | {
      readonly type: 'WorkCancelled';
      readonly unitId: UnitId;
      readonly kind: ImprovementId;
      readonly tile: TileIndex;
      readonly turnsLeft: number;
      readonly reason: WorkCancelledReason;
    }
  /**
   * The last turn of a job was paid and the improvement now exists on `tile`.
   * Emitted by the turn pipeline, which is where the pair is added to the state,
   * and *before* growth and production — an improvement finished this turn
   * contributes to this turn's yields (INTERFACES.md M4a, "advanceTurn order").
   */
  | {
      readonly type: 'WorkCompleted';
      readonly unitId: UnitId;
      readonly kind: ImprovementId;
      readonly tile: TileIndex;
    };

/**
 * Why a job ended without producing anything. Two members rather than one because
 * the *caller's* reading differs: `cancelled` is what the player asked for,
 * `moved` is a consequence of a step the player may not have thought about — the
 * case INTERFACES.md M4a insists must be visible in the event stream.
 */
export type WorkCancelledReason = 'cancelled' | 'moved';

/**
 * The outcome of an applied command: the new state (a fresh object; the input is
 * untouched) plus what happened. Named so callers can annotate a variable with
 * it; structurally it is exactly the `{ state, events }` the contract spells
 * inline.
 */
export interface CommandOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** The acting player, or `undefined` when no player in the state carries this id. */
const playerById = (state: GameState, playerId: PlayerId): PlayerState | undefined =>
  state.players.find((player) => player.id === playerId);

/** The ruleset's definition of the terrain on `tile`, or `undefined`. */
const terrainDefAt = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): TerrainDef | undefined => {
  const id = terrainAtIndex(state.map, tile);
  return id === undefined ? undefined : ruleset.terrains.find((terrain) => terrain.id === id);
};

/**
 * A legal single-step move, as decided by `planMove`: the unit that moves, what
 * the step costs, and what the mover has left afterwards.
 */
export interface MovePlan {
  readonly unit: Unit;
  readonly to: TileIndex;
  readonly cost: number;
  /** The mover's movement after paying `cost`: the doc's `{ cost, movementLeft }`, read off the plan. */
  readonly movementLeft: number;
}

/**
 * Decide whether a unit may move to a tile, and at what cost — the one place
 * movement legality is stated. Two call shapes, both of which reach the same
 * evaluator:
 *
 * - `planMove(state, ruleset, unitId, to)` — the signature the M2 contract
 *   publishes. The acting player is the unit's own owner; a unit whose owner is
 *   not in `state.players` is `unknown-player`, exactly as it would be when the
 *   command layer asks on that owner's behalf.
 * - `planMove(state, ruleset, playerId, unitId, to)` — the explicit-actor form
 *   the engine itself uses, because `applyCommand` must be able to say
 *   `not-your-unit` about a command naming somebody else's unit.
 *
 * The branded id types keep the two apart at compile time: a `PlayerId` is not
 * assignable to `UnitId`, so a four-argument call cannot be mistaken for a
 * five-argument one.
 *
 * Checks run in a fixed order so the reported reason is the most specific one
 * available: actor, unit, ownership, a well-formed index, the map's bounds,
 * adjacency, terrain, occupancy, then affordability.
 *
 * `ok` carries the unit, the cost and the remaining movement so a caller (the AI
 * pricing a step, the UI labelling a button, `applyCommand` doing the move) does
 * not re-derive them. `actions.ts` filters candidate tiles with this function,
 * which is what makes "every yielded action applies successfully" true by
 * construction — and, because the applier refuses nothing else, the reverse
 * direction too.
 */
export function planMove(
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  to: TileIndex,
): Result<MovePlan, GameError>;
export function planMove(
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
  to: TileIndex,
): Result<MovePlan, GameError>;
export function planMove(
  state: GameState,
  ruleset: RulesetView,
  actorOrUnit: number,
  unitOrTo: number,
  to?: TileIndex,
): Result<MovePlan, GameError> {
  if (to === undefined) {
    // Four-argument form: the actor is the unit's owner.
    const unitId = asUnitId(actorOrUnit);
    const unit = unitById(state, unitId);
    if (unit === undefined) return err({ kind: 'unknown-unit', unitId });
    return planMoveFor(state, ruleset, unit.owner, unitId, asTileIndex(unitOrTo));
  }
  return planMoveFor(state, ruleset, asPlayerId(actorOrUnit), asUnitId(unitOrTo), to);
}

/**
 * The evaluator behind both `planMove` shapes. Kept unexported so movement
 * legality has exactly one entry point and one reading of "who is acting".
 */
const planMoveFor = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
  to: TileIndex,
): Result<MovePlan, GameError> => {
  if (playerById(state, playerId) === undefined) {
    return err({ kind: 'unknown-player', playerId });
  }

  const unit = unitById(state, unitId);
  if (unit === undefined) return err({ kind: 'unknown-unit', unitId });
  if (unit.owner !== playerId) return err({ kind: 'not-your-unit', unitId, owner: unit.owner });

  // A branded `TileIndex` is a number, and a client (or a scenario file) can
  // hand over 1.5 or NaN. That is not a tile that is off the map; it is not a
  // tile at all, so it is an argument error rather than `out-of-bounds`.
  if (!Number.isInteger(to)) {
    return err({
      kind: 'invalid-argument',
      detail: `"to" must be an integer tile index (got ${String(to)})`,
    });
  }

  const x = indexToX(state.map, to);
  const y = indexToY(state.map, to);
  if (!inBounds(state.map, x, y)) return err({ kind: 'out-of-bounds', to });

  const steps = distance8(state.map, unit.tile, to);
  if (steps !== 1) {
    return err({
      kind: 'invalid-argument',
      detail:
        `MoveUnit is a single step to one of the 8 adjacent tiles: tile ${String(to)} is ` +
        `${String(steps)} tiles from tile ${String(unit.tile)}. Path movement is not part of M2; ` +
        'chain single steps instead.',
    });
  }

  const terrain = terrainDefAt(state, ruleset, to);
  if (terrain === undefined) {
    return err({
      kind: 'invalid-argument',
      detail: `the ruleset defines no terrain for the destination tile ${String(to)}`,
    });
  }
  if (terrain.impassable) return err({ kind: 'impassable', unitId, to });

  // Any unit of another player blocks the tile: with combat arriving in M6, an
  // enemy tile is simply not enterable, and M2 must not half-implement an attack.
  // A tile holding only this player's units is enterable (Civ 3 stacks).
  const enemy = unitsOnTile(state, to).find((other) => other.owner !== unit.owner);
  if (enemy !== undefined) return err({ kind: 'occupied-by-enemy', unitId, to });

  // `validateRuleset` guarantees an integer `moveCost >= 1` on passable terrain;
  // a hand-built view can still carry a broken one, and paying a NaN would put a
  // non-integer (unhashable) value into the state, so it is refused here.
  if (!Number.isInteger(terrain.moveCost) || terrain.moveCost < 0) {
    return err({
      kind: 'invalid-argument',
      detail: `terrain "${terrain.id}" has a non-integer or negative moveCost (${String(terrain.moveCost)})`,
    });
  }

  // Civ 3 style: the *destination* tile's cost is paid, and a unit may never
  // end on a tile it could not afford. Roads and rail (M4) will discount this.
  if (terrain.moveCost > unit.movementLeft) {
    return err({
      kind: 'not-enough-movement',
      unitId,
      needed: terrain.moveCost,
      available: unit.movementLeft,
    });
  }

  return ok({
    unit,
    to,
    cost: terrain.moveCost,
    movementLeft: unit.movementLeft - terrain.moveCost,
  });
};

/* ------------------------------------------------------------------ *
 * M3: cities — founding, citizen assignment and production choices
 * ------------------------------------------------------------------ */

/**
 * The terrain roles that are water. "On land" for `FoundCity` (and "a land tile"
 * for anything else that asks) means a tile whose terrain role is neither of
 * these — the same reading `generateWorld` uses when it places starts and huts on
 * `isWater[i] === false` tiles. Roles are the engine's structural vocabulary for
 * this: a terrain's `impassable` flag cannot answer it, because mountains are
 * impassable *and* land.
 */
const WATER_ROLES: readonly TerrainRole[] = ['ocean', 'coast'];

/** Is this terrain role water (ocean or coast)? */
const isWaterRole = (role: TerrainRole): boolean => WATER_ROLES.includes(role);

/**
 * The id the next founded city will take.
 *
 * `nextCityId` is authoritative — it is the state's own statement of "the id the
 * next founded city will take" — with the same defence `spawnUnit` applies to
 * unit ids: on a hand-built state or an edited save whose counter is stale, the
 * id must still not be one the state already uses, because two cities with one id
 * are indistinguishable to `cityById`, to `cityAt` and to every ownership check.
 */
const nextFreeCityId = (state: GameState): CityId =>
  asCityId(
    state.cities.reduce((next, city) => Math.max(next, Number(city.id) + 1), state.nextCityId),
  );

/**
 * A deterministic name for the city with this id. `City 1`, `City 2`, … numbered
 * by id, so a city's name is a function of creation order alone.
 *
 * A **placeholder** naming scheme: Civ 3 draws names from a per-civilization list,
 * this project ships no such content, and inventing one here would be content
 * pretending to be a rule. A player-visible rename command is M4+ if it is wanted.
 */
const cityName = (id: CityId): string => `City ${String(Number(id) + 1)}`;

/** `state` with `city` added, keeping `cities` sorted by id. */
const withNewCity = (state: GameState, city: City): GameState => ({
  ...state,
  cities: [...state.cities, city].sort((a, b) => Number(a.id) - Number(b.id)),
});

/** `state` with the city of the same id replaced (`cities` is rebuilt, not mutated). */
const withCity = (state: GameState, city: City): GameState => ({
  ...state,
  cities: state.cities.map((existing) => (existing.id === city.id ? city : existing)),
});

/** A city standing too close to where a new one would go. */
interface CityClash {
  readonly city: City;
  readonly distance: number;
}

/**
 * The nearest city closer to `tile` than `minDistance` (Chebyshev), or
 * `undefined` when the site is clear.
 *
 * Ties go to the lowest city id, because only a *strictly* smaller distance
 * replaces the incumbent and `state.cities` is sorted by id — so the reported
 * clash is a function of the state rather than of iteration luck.
 */
const nearestCityWithin = (
  state: GameState,
  tile: TileIndex,
  minDistance: number,
): CityClash | undefined => {
  let nearest: CityClash | undefined;
  for (const city of state.cities) {
    const distance = distance8(state.map, tile, city.tile);
    if (distance >= minDistance) continue;
    if (nearest === undefined || distance < nearest.distance) nearest = { city, distance };
  }
  return nearest;
};

/**
 * What founding a city will produce, as decided by `planFoundCity`: the settler
 * that will be consumed, and the city that will exist afterwards — including the
 * tiles its first citizen will work, so the founder and the applier cannot
 * disagree about the assignment either.
 */
export interface FoundCityPlan {
  readonly unit: Unit;
  readonly city: City;
}

/**
 * Decide whether `unitId` may found a city for `playerId` — the one place
 * `FoundCity`'s legality is stated, used by `applyCommand` to refuse and by
 * `actions.ts` to advertise.
 *
 * Checks run in a fixed order so the reported reason is the most specific one
 * available: actor, unit, ownership, settler role, a well-formed tile on the map,
 * a terrain the ruleset describes, land, then the distance rule. The plan carries
 * the city that will be created (id, deterministic name, centre, and the centre's
 * first citizen's tile from `autoAssignWorkedTiles`), so nothing downstream
 * re-decides any part of it.
 *
 * `MIN_CITY_DISTANCE` (2, Chebyshev, a placeholder) is enforced against *every*
 * city, of every owner: two cities may not be adjacent, and a tile that already
 * holds a city centre is distance 0, so "one city per tile" is the same rule.
 *
 * Nothing here distinguishes a barbarian settler, and that is a reading stated
 * rather than an oversight: the frozen `GameError` union has no member for
 * "barbarians do not build cities", and M3 makes barbarians an ordinary player
 * holding ordinary units. Refusing one would mean inventing an error kind the
 * contract does not define (or reusing `not-a-settler` for a unit that plainly is
 * one, which would make the error lie about why). `commands.test.ts` pins the
 * behaviour so the next reader sees a decision, not an accident.
 */
export const planFoundCity = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
): Result<FoundCityPlan, GameError> => {
  if (playerById(state, playerId) === undefined) {
    return err({ kind: 'unknown-player', playerId });
  }

  const unit = unitById(state, unitId);
  if (unit === undefined) return err({ kind: 'unknown-unit', unitId });
  if (unit.owner !== playerId) return err({ kind: 'not-your-unit', unitId, owner: unit.owner });

  // A unit type the ruleset does not describe cannot be shown to be a settler, so
  // it is refused as `not-a-settler` rather than assumed to be one.
  const def = unitDef(ruleset, unit.type);
  if (def === undefined || def.role !== 'settler') return err({ kind: 'not-a-settler', unitId });

  const tile = unit.tile;
  if (!Number.isInteger(Number(tile))) {
    return err({
      kind: 'invalid-argument',
      detail: `FoundCity needs a unit standing on an integer tile index (unit ${String(unitId)} is on ${String(tile)})`,
    });
  }
  const x = indexToX(state.map, Number(tile));
  const y = indexToY(state.map, Number(tile));
  if (!inBounds(state.map, x, y)) return err({ kind: 'out-of-bounds', to: tile });

  const terrain = terrainDefAt(state, ruleset, tile);
  if (terrain === undefined) {
    return err({
      kind: 'invalid-argument',
      detail: `the ruleset defines no terrain for tile ${String(tile)}, so the site cannot be checked`,
    });
  }
  if (isWaterRole(terrain.role)) return err({ kind: 'not-on-land', unitId, tile });

  const clash = nearestCityWithin(state, tile, MIN_CITY_DISTANCE);
  if (clash !== undefined) {
    return err({
      kind: 'city-too-close',
      unitId,
      tile,
      cityId: clash.city.id,
      distance: clash.distance,
      minDistance: MIN_CITY_DISTANCE,
    });
  }

  const id = nextFreeCityId(state);
  const founded: City = {
    id,
    owner: playerId,
    name: cityName(id),
    tile,
    population: 1,
    foodBox: 0,
    shields: 0,
    // Nothing is being built yet: production is the player's next decision. The
    // key is *omitted* rather than written as `undefined` — `City.production` is
    // optional, and a present-but-`undefined` key cannot be represented in
    // canonical JSON, so `hashValue` would throw on the city just founded.
    queue: [],
    buildings: [],
    workedTiles: [],
  };

  // The new city is placed in a *copy* of the state so the city-radius helpers can
  // see it, and its first citizen's tile comes from `autoAssignWorkedTiles` — the
  // one definition of "the best tiles this city may still take", which also keeps
  // it off tiles another city already works.
  const provisional = withNewCity(state, founded);
  const workedTiles = autoAssignWorkedTiles(provisional, ruleset, id);

  return ok({ unit, city: { ...founded, workedTiles } });
};

/** What `planSetWorkedTiles` decided: the city, and the assignment it will hold. */
export interface SetWorkedTilesPlan {
  readonly city: City;
  readonly tiles: readonly TileIndex[];
}

/**
 * Decide whether `cityId` may be given the assignment `tiles` — the one place
 * `SetWorkedTiles`'s legality is stated.
 *
 * The checks, in order, and why:
 *
 * 1. the actor exists, the city exists, the actor owns it (`unknown-player`,
 *    `unknown-city`, `not-your-city`);
 * 2. `tiles.length <= population` (`too-many-worked-tiles`) — one citizen works
 *    one tile, and the request is rejected as a whole rather than truncated,
 *    because a caller that asked for six tiles with three citizens has a bug this
 *    refusal will find;
 * 3. each tile, in the order given: a whole number (`invalid-argument`), inside
 *    the city radius and not the centre (`tile-not-workable`), not worked by
 *    another city (`tile-worked-by-another-city`), and not already listed
 *    (`duplicate-worked-tile`).
 *
 * The list's **order is preserved** into the state, because it is meaningful:
 * `cityYields` counts the first `population` entries, so the order is which
 * citizen works what. Re-listing a tile the city already works is legal (it is
 * the same city's claim), and assigning *fewer* tiles than the city has citizens
 * is legal too — an unassigned citizen works nothing, which is a real choice.
 *
 * This is the one plan function that takes no `RulesetView`: which tiles a city
 * may work is geometry (`cityRadius`) and ownership, not content. Saying that in
 * the signature is more honest than an unused parameter that suggests a rule the
 * engine does not have.
 */
export const planSetWorkedTiles = (
  state: GameState,
  playerId: PlayerId,
  cityId: CityId,
  tiles: readonly TileIndex[],
): Result<SetWorkedTilesPlan, GameError> => {
  if (playerById(state, playerId) === undefined) {
    return err({ kind: 'unknown-player', playerId });
  }

  const city = cityById(state, cityId);
  if (city === undefined) return err({ kind: 'unknown-city', cityId });
  if (city.owner !== playerId) return err({ kind: 'not-your-city', cityId, owner: city.owner });

  if (tiles.length > city.population) {
    return err({
      kind: 'too-many-worked-tiles',
      cityId,
      requested: tiles.length,
      allowed: city.population,
    });
  }

  const centre = Number(city.tile);
  const inside = new Set<number>(cityRadius(state, city.tile).map(Number));
  const listed = new Set<number>();

  for (const tile of tiles) {
    const index = Number(tile);
    if (!Number.isInteger(index)) {
      return err({
        kind: 'invalid-argument',
        detail: `SetWorkedTiles takes integer tile indices (got ${String(tile)})`,
      });
    }
    if (index === centre || !inside.has(index))
      return err({ kind: 'tile-not-workable', cityId, tile });

    const other = state.cities.find(
      (candidate) =>
        candidate.id !== city.id &&
        candidate.workedTiles.some((worked) => Number(worked) === index),
    );
    if (other !== undefined) {
      return err({ kind: 'tile-worked-by-another-city', cityId, tile, byCityId: other.id });
    }

    if (listed.has(index)) return err({ kind: 'duplicate-worked-tile', cityId, tile });
    listed.add(index);
  }

  return ok({ city, tiles: [...tiles] });
};

/** What `planSetProduction` decided: the city, the item, and what it costs. */
export interface SetProductionPlan {
  readonly city: City;
  readonly item: ProductionItem;
  readonly cost: number;
}

/**
 * Decide whether `cityId` may be set to build `item` — the one place
 * `SetProduction`'s legality is stated.
 *
 * Two refusals, as the contract fixes them: an item this ruleset cannot build
 * (`unknown-production-item`, which includes a row whose cost is not a usable
 * number of shields — see `itemCostOf`), and a building the city already has
 * (`already-built`; building it twice is a typed refusal, never a silent no-op).
 * Queueing a building the city does **not** yet have is legal, and so is setting
 * the item a city is already building — the applier accepts exactly what this
 * function accepts, and an applier that refused a redundant-but-legal command
 * would make the two disagree.
 */
export const planSetProduction = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  cityId: CityId,
  item: ProductionItem,
): Result<SetProductionPlan, GameError> => {
  if (playerById(state, playerId) === undefined) {
    return err({ kind: 'unknown-player', playerId });
  }

  const city = cityById(state, cityId);
  if (city === undefined) return err({ kind: 'unknown-city', cityId });
  if (city.owner !== playerId) return err({ kind: 'not-your-city', cityId, owner: city.owner });

  const cost = itemCostOf(ruleset, item);
  if (cost === undefined) return err({ kind: 'unknown-production-item', item });

  if (item.kind === 'building' && city.buildings.includes(item.id)) {
    return err({ kind: 'already-built', cityId, building: item.id });
  }

  return ok({ city, item, cost });
};

/* ------------------------------------------------------------------ *
 * M4a: workers — starting, cancelling and losing a tile improvement job
 * ------------------------------------------------------------------ */

/**
 * How many worker turns a catalog row's job costs, or `undefined` when the engine
 * cannot read a count out of it.
 *
 * `validateRuleset` guarantees an integer `turns >= 1`, but a foreign or
 * hand-built view can carry anything, and `turnsLeft` is written into the state
 * and therefore into every hash: a fractional or NaN count would put a value into
 * the state that `canonicalize` cannot represent. Such a row is reported as an
 * improvement this ruleset cannot build (see `unknown-improvement`), the same
 * reading `itemCostOf` gives a row with an unusable `cost`.
 */
const workTurnsOf = (turns: number): number | undefined =>
  Number.isInteger(turns) && turns >= 1 ? turns : undefined;

/** `state` with the unit of the same id replaced (`units` is rebuilt, not mutated). */
const withUnit = (state: GameState, unit: Unit): GameState => ({
  ...state,
  units: state.units.map((existing) => (existing.id === unit.id ? unit : existing)),
});

/**
 * What `planStartWork` decided: the worker, the tile it stands on (which *is* the
 * target — there is no target parameter), the improvement, and the `turnsLeft` the
 * job will start with, straight from the catalog row.
 */
export interface StartWorkPlan {
  readonly unit: Unit;
  readonly tile: TileIndex;
  readonly kind: ImprovementId;
  readonly turnsLeft: number;
}

/**
 * Decide whether `unitId` may start building `kind` where it stands — the one
 * place `StartWork`'s legality is stated, used by `applyCommand` to refuse and by
 * `actions.ts` to advertise (M4a's fifth generator).
 *
 * The checks, in the order they run, and why that order:
 *
 * 1. the actor exists, the unit exists, the actor owns it (`unknown-player`,
 *    `unknown-unit`, `not-your-unit`) — the same three every unit command opens
 *    with, so a wrong-owner command is refused before anything else is read;
 * 2. the unit's type resolves and its role is `worker` (`not-a-worker`) — a unit
 *    type the view does not describe cannot be shown to be a worker, exactly as
 *    `planFoundCity` reads an undescribed type as not-a-settler;
 * 3. the unit is idle (`already-working`, naming the job in progress) — one job
 *    at a time, and a caller that has to cancel first is told what to cancel;
 * 4. its tile is a whole number on the map (`invalid-argument` /
 *    `out-of-bounds`), and the ruleset describes the terrain there
 *    (`invalid-argument`) — because step 5 needs the terrain *role*;
 * 5. the improvement is one this ruleset can build (`unknown-improvement`), and
 *    its `allowedRoles` contains that role (`improvement-not-allowed`) — a mine
 *    needs rock, irrigation needs flat land;
 * 6. the tile does not already carry it (`already-improved`) — building it twice
 *    is a typed refusal rather than a silent no-op, the reading M3 fixed for
 *    buildings;
 * 7. the worker has movement left (`not-enough-movement`, `needed: 1`) —
 *    affordability is checked last, as `planMove` does, so the reason reported is
 *    about the job rather than about the turn's movement whenever both are wrong.
 *
 * The plan carries the catalog's `turnsLeft`, so the applier and any caller that
 * asks "how long will this take?" read one number from one place.
 *
 * This is deliberately **not** a check that the tile is unworked, unowned or
 * inside someone's border: M4a has no tile ownership, and an improvement's
 * `allowedRoles` is the only territorial rule the contract gives. Nor is it a
 * check on whether *another* worker is already doing the same job on that tile:
 * the contract's list above is the whole rule, two workers digging the same mine
 * is therefore legal, and the second one merely wastes its turns — completion is
 * idempotent (`withImprovement`), so the tile still ends up with one mine.
 */
export const planStartWork = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  unitId: UnitId,
  kind: ImprovementId,
): Result<StartWorkPlan, GameError> => {
  if (playerById(state, playerId) === undefined) {
    return err({ kind: 'unknown-player', playerId });
  }

  const unit = unitById(state, unitId);
  if (unit === undefined) return err({ kind: 'unknown-unit', unitId });
  if (unit.owner !== playerId) return err({ kind: 'not-your-unit', unitId, owner: unit.owner });

  const def = unitDef(ruleset, unit.type);
  if (def === undefined || def.role !== 'worker') return err({ kind: 'not-a-worker', unitId });

  const inProgress = unit.work;
  if (inProgress !== undefined) {
    return err({ kind: 'already-working', unitId, improvement: inProgress.kind });
  }

  const tile = unit.tile;
  if (!Number.isInteger(Number(tile))) {
    return err({
      kind: 'invalid-argument',
      detail: `StartWork needs a unit standing on an integer tile index (unit ${String(unitId)} is on ${String(tile)})`,
    });
  }
  const x = indexToX(state.map, Number(tile));
  const y = indexToY(state.map, Number(tile));
  if (!inBounds(state.map, x, y)) return err({ kind: 'out-of-bounds', to: tile });

  const terrain = terrainDefAt(state, ruleset, tile);
  if (terrain === undefined) {
    return err({
      kind: 'invalid-argument',
      detail: `the ruleset defines no terrain for tile ${String(tile)}, so the improvement cannot be checked against it`,
    });
  }

  const improvement = improvementDef(ruleset, kind);
  if (improvement === undefined) return err({ kind: 'unknown-improvement', improvement: kind });

  const turnsLeft = workTurnsOf(improvement.turns);
  if (turnsLeft === undefined) return err({ kind: 'unknown-improvement', improvement: kind });

  if (!improvement.allowedRoles.includes(terrain.role)) {
    return err({
      kind: 'improvement-not-allowed',
      unitId,
      tile,
      improvement: kind,
      role: terrain.role,
    });
  }

  if (hasImprovement(state, tile, kind)) {
    return err({ kind: 'already-improved', tile, improvement: kind });
  }

  // The job costs the unit's remaining movement — all of it (M4a: "it costs the
  // unit's remaining movement for the turn"), so all that is required is that
  // there is some left to spend. `needed: 1` states the smallest amount that
  // would have made this legal, which is what a caller needs to know.
  if (!Number.isInteger(unit.movementLeft) || unit.movementLeft <= 0) {
    return err({
      kind: 'not-enough-movement',
      unitId,
      needed: 1,
      available: unit.movementLeft,
    });
  }

  return ok({ unit, tile, kind, turnsLeft });
};

/** What `planCancelWork` decided: the unit, and the job it is giving up. */
export interface CancelWorkPlan {
  readonly unit: Unit;
  readonly work: UnitWork;
}

/**
 * Decide whether `unitId` may stop working — the one place `CancelWork`'s
 * legality is stated.
 *
 * Three checks, the same opening every unit command has: the actor exists, the
 * unit exists, the actor owns it. The fourth is the command's whole rule: the
 * unit must actually be working (`not-working` otherwise), because "cancel" on an
 * idle unit is not a no-op a caller should be able to issue silently — it is a
 * command aimed at a state that does not exist, and the typed refusal is what
 * tells a client its picture is stale.
 *
 * Nothing here refunds movement, and nothing here removes an improvement: a job
 * never adds one before it completes (see the module note), so cancelling cannot
 * leave a half-built improvement behind.
 */
export const planCancelWork = (
  state: GameState,
  playerId: PlayerId,
  unitId: UnitId,
): Result<CancelWorkPlan, GameError> => {
  if (playerById(state, playerId) === undefined) {
    return err({ kind: 'unknown-player', playerId });
  }

  const unit = unitById(state, unitId);
  if (unit === undefined) return err({ kind: 'unknown-unit', unitId });
  if (unit.owner !== playerId) return err({ kind: 'not-your-unit', unitId, owner: unit.owner });

  const work = unit.work;
  if (work === undefined) return err({ kind: 'not-working', unitId });

  return ok({ unit, work });
};

/**
 * The `WorkCancelled` event for a unit that is giving up `work`, or `[]` when
 * there was no job to give up.
 *
 * One helper rather than two inline object literals, because the two cancellation
 * paths (`CancelWork` and relocation) must report the *same* fact in the same
 * shape; the only thing that differs is `reason`.
 */
const workCancelledEvent = (unit: Unit, reason: WorkCancelledReason): readonly GameEvent[] => {
  const work = unit.work;
  if (work === undefined) return [];
  return [
    {
      type: 'WorkCancelled',
      unitId: unit.id,
      kind: work.kind,
      tile: work.tile,
      turnsLeft: work.turnsLeft,
      reason,
    },
  ];
};

/**
 * Apply a decided move: a new `units` array with the mover replaced (in place,
 * so the array stays sorted by id), `revision` bumped once, and the mover's new
 * line of sight folded into its player's memory.
 *
 * Fog is *folded, never consulted*: legality does not ask what is explored
 * (INTERFACES.md M2 keeps fog out of the legality rule), and a move that
 * succeeded records what the player can now see. Both halves live in `fog.ts`:
 * `VISIBILITY_RADIUS` is the *only* definition of how far a unit sees, and
 * `withExplored` is the *only* writer of the explored layer. This layer calls
 * `visibleTiles` on the post-move state and hands the result to `withExplored`,
 * so it states *when* memory grows and never *how much*.
 *
 * Everything else — map, players, settings, RNG, turn — is shared with the input,
 * which is never touched.
 *
 * M4a: **a relocated unit loses its job.** Work happens *on a tile by a unit
 * standing there*, so a step invalidates it — and the job is not "carried along",
 * because then a worker could walk away from a half-finished mine and collect it
 * somewhere else. The `work` key is removed through `withoutWork` (absent, never
 * `undefined`), and the caller appends the `WorkCancelled` event, because the
 * event stream — not a diff of the unit — is how a consumer learns about it. A
 * step to the tile the unit already occupies would leave it alone; `planMove`
 * refuses non-adjacent destinations, so that case exists only for totality.
 */
const movedState = (state: GameState, plan: MovePlan): GameState => {
  const units = state.units.map((unit) => {
    if (unit.id !== plan.unit.id) return unit;
    const moved: Unit = {
      ...unit,
      tile: plan.to,
      movementLeft: unit.movementLeft - plan.cost,
    };
    return unit.tile === plan.to ? moved : withoutWork(moved);
  });

  const moved: GameState = { ...state, revision: state.revision + 1, units };
  return withExplored(moved, plan.unit.owner, visibleTiles(moved, plan.unit.owner));
};

/**
 * Apply `cmd` as `playerId`, or refuse it with a typed `GameError`.
 *
 * `ruleset` is **required** (INTERFACES.md M2, the post-review amendment):
 * movement legality reads the destination terrain's `moveCost`/`impassable`, and
 * `EndTurn` reads each unit type's `movement`, neither of which `GameState`
 * carries. Required means the compiler enforces what the runtime needs; there is
 * no runtime "missing ruleset" refusal left to catch a three-argument call.
 *
 * Success means: `revision` is exactly `state.revision + 1`, the returned state
 * shares nothing mutable with the input, and `events` describes what changed.
 * Failure means the input state is returned unchanged — no partial application,
 * because every check runs before any state is built.
 */
export const applyCommand = (
  state: GameState,
  playerId: PlayerId,
  cmd: Command,
  ruleset: RulesetView,
): Result<CommandOutcome, GameError> => {
  switch (cmd.type) {
    case 'MoveUnit': {
      const plan = planMove(state, ruleset, playerId, cmd.unitId, cmd.to);
      if (!plan.ok) return err(plan.error);

      const moved = movedState(state, plan.value);
      const events: GameEvent[] = [
        {
          type: 'UnitMoved',
          unitId: plan.value.unit.id,
          from: plan.value.unit.tile,
          to: plan.value.to,
          cost: plan.value.cost,
          movementLeft: plan.value.movementLeft,
        },
      ];

      // M4a: the step relocated the unit, so any job it was doing is over.
      // `movedState` removed the job from the unit; this appends the event that
      // says so, immediately after the move it is a consequence of (and before the
      // hut the mover just entered, because the cancellation happened *with* the
      // step rather than after arriving). `movedState` and this read the same
      // `plan.value.unit`, so the two cannot disagree about whether there was a job.
      events.push(...workCancelledEvent(plan.value.unit, 'moved'));

      // M3 goody huts. The move has succeeded and the mover is standing on
      // `plan.value.to`, so *this* is where a hut on that tile resolves — and the
      // resolver is handed the post-move state, never the plan's `unit` value,
      // which still stands on the tile it stepped from. `hut.ts` decides what a
      // hut does: consume the hut, draw one reward from `state.rng`, and maybe put
      // a free unit or a barbarian band on the map. `undefined` means there was no
      // hut to enter (or the unit is a sea unit, or a city stands there), and then
      // nothing at all happened beyond the move.
      //
      // Everything the command layer owns stays here: one `revision` bump for the
      // one applied command (the resolver never touches it), the fog fold that
      // `movedState` performed, and the event order — the move first, then the
      // work it cancelled, then the hut it entered, then the band it produced,
      // because that is the order in which they happened.
      const entry = resolveHutEntry(moved, ruleset, plan.value.unit.id);
      if (entry !== undefined) events.push(...entry.events);

      return ok({ state: entry?.state ?? moved, events });
    }

    case 'EndTurn': {
      if (playerById(state, playerId) === undefined) {
        return err({ kind: 'unknown-player', playerId });
      }

      // The whole of "a turn" lives in `turn.ts` — work progress for every unit
      // (unit-id order), growth for every city (city-id order), production for
      // every city (city-id order), every unit's movement refilled, `turn += 1` —
      // and this case deliberately re-implements none of it. All this layer adds is
      // the actor's `TurnEnded` event (which names a player, and so is not a
      // property of the world) and the single `revision` bump every applied command
      // performs.
      const outcome = advanceTurn(state, ruleset);
      const turn = outcome.state.turn;
      const events: readonly GameEvent[] = [
        ...outcome.events,
        { type: 'TurnEnded', playerId, turn },
      ];
      return ok({ state: { ...outcome.state, revision: state.revision + 1 }, events });
    }

    case 'FoundCity': {
      const plan = planFoundCity(state, ruleset, playerId, cmd.unitId);
      if (!plan.ok) return err(plan.error);

      const founded = plan.value.city;

      // The settler is consumed and the city takes its place. Nothing else moves:
      // `nextCityId` advances past the id just used, the cities array stays sorted
      // by id, and every other field is shared with the input.
      const next: GameState = {
        ...state,
        revision: state.revision + 1,
        nextCityId: Number(founded.id) + 1,
        cities: [...state.cities, founded].sort((a, b) => Number(a.id) - Number(b.id)),
        units: state.units.filter((unit) => unit.id !== plan.value.unit.id),
      };

      const events: readonly GameEvent[] = [
        {
          type: 'CityFounded',
          cityId: founded.id,
          owner: founded.owner,
          name: founded.name,
          tile: founded.tile,
        },
      ];
      return ok({ state: next, events });
    }

    case 'SetWorkedTiles': {
      const plan = planSetWorkedTiles(state, playerId, cmd.cityId, cmd.tiles);
      if (!plan.ok) return err(plan.error);

      // No event (see the module note): the command's payload *is* the change, and
      // the frozen M3 event list has no member for an assignment. The tiles are
      // stored in the order given — that order is which citizen works what.
      return ok({
        state: {
          ...withCity(state, { ...plan.value.city, workedTiles: plan.value.tiles }),
          revision: state.revision + 1,
        },
        events: [],
      });
    }

    case 'SetProduction': {
      const plan = planSetProduction(state, ruleset, playerId, cmd.cityId, cmd.item);
      if (!plan.ok) return err(plan.error);

      // "Set" replaces the head of the queue; the rest of the queue is left alone,
      // and so are the city's stored shields — they are the city's investment, not
      // the item's, so redirecting production does not throw them away. There is no
      // command in M3 that appends to the queue (that is M4's, with a cancel to go
      // with it), so `queue` remains what a save or a hand-built state put there.
      return ok({
        state: {
          ...withCity(state, { ...plan.value.city, production: plan.value.item }),
          revision: state.revision + 1,
        },
        events: [],
      });
    }

    case 'StartWork': {
      const plan = planStartWork(state, ruleset, playerId, cmd.unitId, cmd.kind);
      if (!plan.ok) return err(plan.error);

      // The job is attached and the unit's remaining movement is spent. Nothing
      // else changes: the improvement is *not* added here (it lands when the last
      // turn is paid, in `turn.ts`), no RNG is drawn, and the tile the job names is
      // the unit's own, so the record cannot point somewhere the worker is not.
      const work: UnitWork = {
        kind: plan.value.kind,
        tile: plan.value.tile,
        turnsLeft: plan.value.turnsLeft,
      };
      const started: Unit = { ...withWork(plan.value.unit, work), movementLeft: 0 };

      return ok({
        state: { ...withUnit(state, started), revision: state.revision + 1 },
        events: [
          {
            type: 'WorkStarted',
            unitId: started.id,
            kind: work.kind,
            tile: work.tile,
            turnsLeft: work.turnsLeft,
          },
        ],
      });
    }

    case 'CancelWork': {
      const plan = planCancelWork(state, playerId, cmd.unitId);
      if (!plan.ok) return err(plan.error);

      // The job is dropped, the unit keeps every movement point it had (nothing is
      // refunded and nothing is charged — cancelling is free, and the turns already
      // paid are simply gone), and the improvement is untouched because a job never
      // added one before completing.
      const idle = withoutWork(plan.value.unit);

      return ok({
        state: { ...withUnit(state, idle), revision: state.revision + 1 },
        events: workCancelledEvent(plan.value.unit, 'cancelled'),
      });
    }
  }
};
