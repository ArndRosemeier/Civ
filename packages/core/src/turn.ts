/**
 * The turn pipeline — the single definition of what "a turn" means.
 * See docs/INTERFACES.md M3 ("Turn pipeline"), PLAN.md §5.3 (determinism).
 *
 * `advanceTurn` is the only place the order exists, and the order is part of the
 * frozen contract:
 *
 * 1. growth for every city (city-id order), then
 * 2. production for every city (city-id order), then
 * 3. every unit's movement refilled, then
 * 4. `turn += 1`.
 *
 * Why it is a module rather than a branch of `EndTurn`: the ordering is the kind
 * of rule that quietly gets re-derived. The CLI, a scenario harness, a "skip
 * turns" convenience and a future AI all want to advance the world, and if any of
 * them re-implemented *growth, production, refill, turn* in its own words, the
 * game would have several definitions of a turn that agree only until somebody
 * edits one. So the pipeline is exported, `EndTurn` calls it, and nothing else
 * spells the order out.
 *
 * Design notes:
 *
 * - **Growth runs before production, and that is observable.** A city that grows
 *   during a turn has one more citizen (and one more worked tile, assigned by
 *   growth) *before* its shields are counted, so the turn a city grows is also
 *   the turn it produces slightly more. The reverse order would be equally
 *   implementable and would give different numbers — which is exactly why the
 *   contract fixes the order and why `commands.test.ts` pins it.
 * - **The refill is total.** A unit whose type the ruleset does not define is
 *   carried over untouched rather than given a guessed budget or refusing the
 *   turn: M2's adversarial sweep found `legalActions` yielding `EndTurn` for a
 *   state with such a unit, and a generator and an applier that disagree is a
 *   bug. There is no honest movement number for a type nothing describes.
 * - **`revision` is not touched here.** It counts *applied commands* (M2
 *   invariant 2), and advancing a turn is one step of one command: `applyCommand`
 *   bumps it exactly once. This keeps the pipeline usable by a caller that is not
 *   a command (a test, a future "advance N turns" harness) without inventing
 *   revisions.
 * - **Events, not diffs.** The events returned are the *world's* events — who
 *   grew, who starved, what was finished — in pipeline order. `TurnEnded` is not
 *   among them: it names the acting player and belongs to the command layer,
 *   which appends it after these. The whole list is plain data, so an event log
 *   is as hashable and as reproducible as the state it came from.
 *
 * Deterministic and pure: every ordering is stated (city id, unit id, ascending
 * tile), no ambient state is read, and the input state is never modified.
 */

import type { GameEvent } from './commands.js';
import { applyGrowth } from './growth.js';
import type { RulesetView } from './map.js';
import { applyProduction } from './production.js';
import type { GameState } from './state.js';
import { unitDef, type Unit } from './units.js';

/** The state after a turn, and everything that happened during it. */
export interface TurnOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * Refill every unit's movement to its type's movement, leaving a unit whose type
 * the ruleset cannot resolve exactly as it is. Units are visited in `state.units`
 * order (sorted by id), which keeps the rebuilt array sorted by construction.
 */
const refillMovement = (state: GameState, ruleset: RulesetView): GameState => {
  const units: readonly Unit[] = state.units.map((unit) => {
    const def = unitDef(ruleset, unit.type);
    return def === undefined ? unit : { ...unit, movementLeft: def.movement };
  });
  return { ...state, units };
};

/**
 * Advance the world by exactly one turn: growth for every city, then production
 * for every city, then refill movement, then `turn += 1` — in that order, for the
 * reasons in the module note.
 *
 * Pure: the returned state is a fresh object built from `state`, which is never
 * modified, and the same `(state, ruleset)` always yields an equal result.
 */
export const advanceTurn = (state: GameState, ruleset: RulesetView): TurnOutcome => {
  const grown = applyGrowth(state, ruleset);
  const produced = applyProduction(grown.state, ruleset);
  const refilled = refillMovement(produced.state, ruleset);

  return {
    state: { ...refilled, turn: refilled.turn + 1 },
    events: [...grown.events, ...produced.events],
  };
};
