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
 */

import { visibleTiles, withExplored } from './fog.js';
import {
  asPlayerId,
  asTileIndex,
  asUnitId,
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
} from './map.js';
import { err, ok, type Result } from './result.js';
import type { GameState, PlayerState } from './state.js';
import { unitById, unitDef, unitsOnTile, type Unit } from './units.js';

/**
 * Every way a player may change the game. An exhaustive union (PLAN.md §4.4) so
 * a consumer that switches on `type` is told by the typechecker when a command
 * is added.
 */
export type Command =
  | { readonly type: 'MoveUnit'; readonly unitId: UnitId; readonly to: TileIndex }
  | { readonly type: 'EndTurn' };

/**
 * Every way a command can be refused, as a *reason* rather than a message
 * (PLAN.md §4.4): the AI branches on these, the UI renders them, and tests
 * assert on them.
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
  | { readonly kind: 'invalid-argument'; readonly detail: string };

/**
 * What an applied command did, for consumers that must not diff the whole state
 * (PLAN.md §5.4: the UI receives events, not 16k tiles per turn). M2 emits two:
 * a moved unit and an advanced turn. The union is exhaustive so a consumer's
 * `switch` is checked, and every event is plain data, so an event log is as
 * hashable as the state it came from.
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
  | { readonly type: 'TurnEnded'; readonly playerId: PlayerId; readonly turn: number };

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
 */
const movedState = (state: GameState, plan: MovePlan): GameState => {
  const units = state.units.map((unit) =>
    unit.id === plan.unit.id
      ? { ...unit, tile: plan.to, movementLeft: unit.movementLeft - plan.cost }
      : unit,
  );

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

      const events: readonly GameEvent[] = [
        {
          type: 'UnitMoved',
          unitId: plan.value.unit.id,
          from: plan.value.unit.tile,
          to: plan.value.to,
          cost: plan.value.cost,
          movementLeft: plan.value.movementLeft,
        },
      ];
      return ok({ state: movedState(state, plan.value), events });
    }

    case 'EndTurn': {
      if (playerById(state, playerId) === undefined) {
        return err({ kind: 'unknown-player', playerId });
      }

      // Total by design: every unit whose type the ruleset defines is refilled to
      // that type's movement, and a unit whose type it does not define is carried
      // over untouched. There is no honest budget to guess for an unresolvable
      // type, and refusing the whole turn for one such unit would contradict
      // `legalActions`, which yields `EndTurn` for every real player. Ending a
      // turn is about the turn, not about the catalog.
      const units: readonly Unit[] = state.units.map((unit) => {
        const def = unitDef(ruleset, unit.type);
        return def === undefined ? unit : { ...unit, movementLeft: def.movement };
      });

      const turn = state.turn + 1;
      const events: readonly GameEvent[] = [{ type: 'TurnEnded', playerId, turn }];
      return ok({ state: { ...state, revision: state.revision + 1, turn, units }, events });
    }
  }
};
