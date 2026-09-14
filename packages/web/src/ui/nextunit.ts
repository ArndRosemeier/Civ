/**
 * `nextunit.ts` — **the next-unit flow**: which unit still has something to do.
 *
 * `docs/UI-OVERHAUL.md` §7.6 phase 5 asks for "a way to move to the next unit that still has
 * something to do (the genre's 'unit needs orders')". The owner's design adds the one qualifier
 * that decides everything here: **this is navigation, not a command** (§3, idea 5). Nothing in
 * this module dispatches, and nothing in it decides whether an action is legal — it reads the
 * engine's own answer to "what may this unit do?" and moves the selection.
 *
 * ## What "needs orders" means, and why it is one call to the engine
 *
 * `unitActions(state, ruleset, unitId)` is the engine's list for that unit, built out of the
 * appliers' own evaluators. A unit with movement left and somewhere to put it yields something; a
 * unit that has spent its turn yields nothing. So the predicate is **one engine call**, and this
 * module states no rule of its own:
 *
 * - it never reads `movementLeft`, a move cost, a terrain row or a unit's statistics;
 * - it never asks whether a unit is fortified. It does not have to: fortifying *spends the
 *   movement* (`planFortifyUnit`), so a fortified unit yields nothing from `unitActions` and drops
 *   out of the flow by the engine's arithmetic rather than by a rule written here;
 * - it does not ask about fog, ownership of a tile, or an attack. If the engine offers it, the unit
 *   is one a player has to decide about.
 *
 * That is the same discipline `ui/goto.ts` follows for routes, for the same reason: a second
 * statement of the rules in the web package is a statement free to disagree with `applyCommand`.
 *
 * ## The order, and the wrap
 *
 * The flow visits the acting seat's units in `state.units` order — which `INTERFACES.md` M2 fixes
 * as ascending id, so the order is a function of the state and two frames agree. `from` is the
 * unit the player is looking at now. The scan starts **after** it and wraps to the beginning, and
 * `from` is deliberately **excluded** from its own answer: "the next unit" that is the unit
 * already selected is not a move, and returning it would make the key look broken. The callers
 * read the same distinction as information ("no other unit needs orders"), which is why it is
 * `undefined` rather than a self-answer.
 *
 * ## What is deliberately NOT here
 *
 * **No auto-advance.** `docs/UI-OVERHAUL.md` §6.2 leaves "next-unit auto-advance — yes or no?" as
 * an open question for the owner, and §3 idea 5 sketches the version where an order advances the
 * selection by itself. That is a change to how the game is played, not a keyboard binding, and it
 * is not this phase's call: the flow here happens only when the player asks for it (the `Next unit`
 * control, `Space`). Recorded in §9 of the plan as the reason this module has no "and then".
 */

import {
  unitActions,
  type GameState,
  type PlayerId,
  type RulesetView,
  type UnitId,
} from '@civts/core';

/**
 * The acting seat's units the engine still offers something, in `state.units` order.
 *
 * Exported because the count is what the flow says when it finds nothing to do ("3 units still
 * need orders"): a message assembled from the state by a caller would be a second answer to the
 * question this function exists to ask.
 */
export const unitsNeedingOrders = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly UnitId[] =>
  state.units
    .filter((unit) => unit.owner === playerId)
    .filter((unit) => unitActions(state, ruleset, unit.id).length > 0)
    .map((unit) => unit.id);

/**
 * The next unit after `from` that the engine still offers something — or `undefined`.
 *
 * `undefined` has two meanings and both are "do not move the selection": no unit of this seat needs
 * orders at all, and every unit that does need orders is `from` itself. The caller distinguishes
 * them by asking `unitsNeedingOrders` for its count, which is why both exist rather than a tagged
 * answer: the count is the useful half of the message and the id is the useful half of the move.
 *
 * `from === undefined` means "nothing is selected": the flow starts at the first unit of the seat,
 * which is the only answer that does not depend on a position that does not exist. A `from` the
 * state does not hold (a captured unit, a unit from a previous game) is treated the same way,
 * because the honest reading of "the unit you were looking at is gone" is "start again".
 */
export const nextUnitNeedingOrders = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  from: UnitId | undefined,
): UnitId | undefined => {
  const mine = state.units.filter((unit) => unit.owner === playerId);
  const at = from === undefined ? -1 : mine.findIndex((unit) => unit.id === from);
  // From just after `from` to the end, then from the start back through `from` itself — the wrap is
  // the genre's, and it is written as a rotation of one array rather than as arithmetic on indices
  // so that "which units does this consider?" is answerable by reading one line. With `at === -1`
  // the first slice is the whole list and the second is empty, i.e. the scan starts at the first
  // unit — which is exactly the "nothing selected" case above.
  const rotated = [...mine.slice(at + 1), ...mine.slice(0, at + 1)];
  const candidate = rotated.find(
    (unit) => unit.id !== from && unitActions(state, ruleset, unit.id).length > 0,
  );
  return candidate?.id;
};
