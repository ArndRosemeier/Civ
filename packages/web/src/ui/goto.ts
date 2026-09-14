/**
 * `goto.ts` — **the goto decision**: what to do next for a unit walking to a far tile.
 *
 * ## What this module is, and what it deliberately is not
 *
 * `docs/UI-OVERHAUL.md` §7.4 records the owner's fork and the shape chosen for Phase 4 — **(b): a
 * route query in the engine, the destination held as UI intent.** So there are two halves to goto
 * and they live in two places on purpose:
 *
 * - **the route is the engine's** (`packages/core/src/route.ts`): it is made of steps `planMove`
 *   accepts, and this module never decides what is walkable;
 * - **the intent is the UI's** (this file): a destination and the route the player was given, held
 *   in the shell's memory, never in `GameState`. Nothing here is hashed, saved or replayed, which is
 *   what keeps the six goldens untouched — and what `docs/UI-OVERHAUL.md` §8 says has to be *said*
 *   in the code rather than left implied (see `determinism.spec.ts`, whose fixtures therefore
 *   contain no goto at all).
 *
 * This module is a **pure function of `(state, ruleset, intent)`**: it does not dispatch, does not
 * touch the DOM and does not remember anything. The shell executes its decision. That split is what
 * makes the interesting half — "is the goto still the goto the player asked for?" — testable without
 * a browser (`packages/web/test/ui/goto.test.ts`).
 *
 * ## The invalidation rule, which is the whole point of the module
 *
 * §8 decision 4: **an invalidated goto is cancelled, with a message, rather than silently
 * recomputed.** The case that made this a decision rather than a detail is fog — legality never
 * consults fog (`actions.ts`), so a route may cross ground the player has never seen, and what the
 * player cannot see can close the route between two turns.
 *
 * The rule is implemented as an **equality check against the stored route**, and it can be, because
 * the route query is a function of `(board, unit, destination)` alone: the route from a route's
 * second tile *is* its tail, by construction (one tree rooted at the destination — see `route.ts`).
 * So "the engine's plan for the rest of the journey is not the plan the player was given" is a fact
 * rather than a guess, and any difference means the world moved. Measured examples, both from the
 * engine's own tests: a rival stepping into the way re-routes the plan *around* it (a silent
 * detour, which is exactly what is forbidden), and a goody hut walked into can drop a barbarian
 * band on the route (`packages/core/test/route.test.ts`).
 *
 * The consequences are stated rather than hidden:
 *
 * - **A cancelled goto does not continue.** The player re-clicks; the unit stands still in the
 *   meantime, which is the honest outcome of "your plan no longer holds".
 * - **A goto whose next step is unaffordable is not cancelled** — it *waits*. The query plans with a
 *   full turn's movement (`route.ts`), so a step it names may cost more than the unit has left this
 *   turn; the engine simply offers no such `MoveUnit` yet, and the intent stands until the next
 *   turn refills the unit. `waiting` is that answer, and it is the only reason this module has more
 *   than two outcomes.
 */

import {
  planRoute,
  unitActions,
  type Command,
  type GameState,
  type RulesetView,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { problemText } from './problem.js';

/**
 * A goto the player has given: where the unit is going, and the steps the engine planned when the
 * order was made (or last confirmed).
 *
 * `route` is the **remaining** journey — its first entry is the next step — because that is what
 * the check below compares against a freshly asked route.
 */
export interface GotoIntent {
  readonly unitId: UnitId;
  readonly destination: TileIndex;
  readonly route: readonly TileIndex[];
}

/** What a click on a far tile resolves to. */
export type GotoStart =
  | { readonly kind: 'started'; readonly intent: GotoIntent }
  /** No sequence of single steps exists, with the engine's own words for why. */
  | { readonly kind: 'no-route'; readonly reason: string };

/** Why a goto was cancelled, in a form the shell can render without re-deriving anything. */
export type GotoCancelCause = 'no-route' | 'plan-changed';

/** What the shell should do next for a pending goto. */
export type GotoDecision =
  /**
   * Issue this command, and carry on with the returned intent.
   *
   * The command is narrowed to `MoveUnit` rather than left as the whole union, because that is what
   * a goto step can be: a walk is made of single steps and nothing else. The narrower type is the
   * statement of that, and it is what lets a caller read `.to` without a cast.
   */
  | {
      readonly kind: 'step';
      readonly command: Extract<Command, { type: 'MoveUnit' }>;
      readonly intent: GotoIntent;
    }
  /** The unit is there. The intent is discharged. */
  | { readonly kind: 'arrived' }
  /** The unit is no longer in the state — a captured, killed or disbanded unit. Drop it quietly. */
  | { readonly kind: 'gone' }
  /** Nothing to do *this turn*; the intent stands and the next turn may offer a step. */
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'cancelled';
      readonly cause: GotoCancelCause;
      /** The engine's own words for a lost route, or the plain fact of a changed plan. */
      readonly detail: string;
    };

/** Whether two routes are the same journey, tile for tile. */
const sameRoute = (a: readonly TileIndex[], b: readonly TileIndex[]): boolean =>
  a.length === b.length && a.every((tile, index) => tile === b[index]);

/**
 * Begin a goto for `unitId` to `destination`, asking the engine for the route.
 *
 * `no-route` carries the engine's own reason (`planRoute`'s `invalid-argument` sentence names both
 * tiles), so the caller does not have to invent one. A unit already standing on the destination is
 * `started` with an empty route — the caller's next decision is `arrived`, and there is nothing
 * special to say about it.
 */
export const startGoto = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  destination: TileIndex,
): GotoStart => {
  const planned = planRoute(state, ruleset, unitId, destination);
  if (!planned.ok) return { kind: 'no-route', reason: problemText(planned.error) };
  return {
    kind: 'started',
    intent: { unitId, destination, route: planned.value.steps },
  };
};

/**
 * The next thing to do for `intent`, decided from the state as it stands now.
 *
 * The order of the checks is the rule:
 *
 * 1. the unit is gone ⇒ `gone` (nothing to say: the player can see it is gone);
 * 2. the unit is on the destination ⇒ `arrived`;
 * 3. **the engine's route is not the route the player was given** ⇒ `cancelled` — a *lost* route
 *    (`no-route`, with the engine's sentence) or a *different* one (`plan-changed`). This is §8
 *    decision 4, and it is asked before anything is dispatched;
 * 4. the engine offers the next step ⇒ `step`;
 * 5. the engine offers nothing for it yet ⇒ `waiting`, and the intent survives to the next turn.
 *
 * Step 4 asks `unitActions` — the engine's own list for this unit — rather than dispatching a
 * `MoveUnit` built here and hoping. A command this module made up would be a command the keystone
 * invariant says the UI may not offer, and the difference is real: the query plans with a full
 * turn's movement, so the step it names is legitimately *not* offered while the unit is spent.
 */
export const nextGotoStep = (
  state: GameState,
  ruleset: RulesetView,
  intent: GotoIntent,
): GotoDecision => {
  const unit = state.units.find((each) => each.id === intent.unitId);
  if (unit === undefined) return { kind: 'gone' };
  if (unit.tile === intent.destination) return { kind: 'arrived' };

  const planned = planRoute(state, ruleset, intent.unitId, intent.destination);
  if (!planned.ok) {
    return { kind: 'cancelled', cause: 'no-route', detail: problemText(planned.error) };
  }
  if (!sameRoute(planned.value.steps, intent.route)) {
    return {
      kind: 'cancelled',
      cause: 'plan-changed',
      detail: 'the route the engine now plans is not the one this order was given with',
    };
  }

  const next = intent.route[0];
  if (next === undefined) {
    // Unreachable through `startGoto`: an empty stored route is only ever produced by a plan for a
    // unit already standing on the destination, which the arrival check above has already answered.
    // An intent built by hand could get here, so it is reported rather than asserted away.
    return {
      kind: 'cancelled',
      cause: 'plan-changed',
      detail: 'this order no longer describes a journey',
    };
  }
  const offered = unitActions(state, ruleset, intent.unitId).find(
    (command): command is Extract<Command, { type: 'MoveUnit' }> =>
      command.type === 'MoveUnit' && command.to === next,
  );
  if (offered === undefined) return { kind: 'waiting' };
  return {
    kind: 'step',
    command: offered,
    intent: { ...intent, route: intent.route.slice(1) },
  };
};
