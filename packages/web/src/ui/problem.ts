/**
 * `problem.ts` — **the one way this app says what the engine said.**
 *
 * ## Why it exists
 *
 * `docs/UI-OVERHAUL.md` §1.4 measured the defect this module is part of fixing: a click on the
 * map that the engine refuses applies nothing and *says* nothing — `main.ts` turned the typed
 * `GameError` into `{outcome: 'refused', events: []}` and dropped it on the floor. In a
 * panel-driven UI that is survivable, because a panel only offers what the engine accepts. On a
 * map, where the affordance is the whole world, it is fatal: the player clicks ground that looks
 * reachable and *nothing happens, ever*, which is indistinguishable from the game having frozen.
 *
 * §3's idea 11 puts the refusal rendering in the schema layer; this is that rendering, in `ui/`
 * beside `schema.ts`, and Phase 4 is where it became load-bearing — a goto that is invalidated has
 * to say so through the same channel that makes a refused order visible (`§8`, decision 4).
 *
 * ## What it does and does not do with the engine's answer
 *
 * The engine states a refusal as a **typed reason**, not a message (`commands.ts`: "as a *reason*
 * rather than a message: the AI branches on these, the UI renders them"). Rendering is therefore
 * this module's job, and the honest rendering is the smallest one that carries the reason and the
 * numbers the engine supplied:
 *
 * - `invalid-argument` **is** a sentence the engine wrote (`detail`), and it is printed verbatim —
 *   this is the member `planMove` uses for a destination it will not name, and `route.ts` uses for
 *   a destination it cannot reach, so the two most common answers on this channel arrive as prose.
 * - the kinds a player can actually meet through a map order or a goto get a sentence that names
 *   the tile, the unit or the count the engine put in the error.
 * - **everything else prints the engine's own `kind`** and nothing more. That is deliberate, and it
 *   was chosen over the two alternatives:
 *   - 40 hand-written sentences would be prose about rules — a place for this file to state a rule
 *     the engine owns, which is the defect class the whole project is arranged around. A paraphrase
 *     is a second statement of the rule, one remove away from being a second implementation of it.
 *   - `assertNever` would stop the build when the engine grows a kind, and a refusal channel that
 *     does not compile is a refusal channel that goes dark; the fallback always says *something*,
 *     and `problem.test.ts` holds a `Record<GameError['kind'], GameError>` sample table so a new
 *     kind cannot be added without a test that renders it.
 *
 * It is one function and not five because the five panel-local verdicts
 * (`index.ts` `refusalNote`, `government.ts` `refusalNote`, `techedRows(...).selectable`,
 * `WorkedTileOption.legal`, `ratesVerdict`) are five copies of this idea, and §1.4/§4.4c record
 * collapsing them as owed work. They are **not** collapsed here: each has its own tests and its own
 * wording, and Phase 4's job is the order channel, not a refactor of five panels. Recorded in
 * `docs/KNOWN-ISSUES.md` §4.4 rather than quietly left.
 */

import type { GameError } from '@civts/core';

/**
 * The engine's reason, as a sentence a player can read.
 *
 * Never empty, whatever the error: an empty message on a status line is indistinguishable from a
 * status line that is not working, which is the defect §1.4 recorded.
 */
export const problemText = (error: GameError): string => {
  switch (error.kind) {
    // The engine's own sentence (`planMove`, `planFoundCity`, `route.ts`). Printed whole.
    case 'invalid-argument':
      return `the engine refused it: ${error.detail}`;
    case 'not-enough-movement':
      return (
        `the unit has ${String(error.available)} movement left and that step needs ` +
        String(error.needed)
      );
    case 'impassable':
      return `tile ${String(error.to)} cannot be entered`;
    case 'occupied-by-enemy':
      return `tile ${String(error.to)} is held by another player, so a unit may not enter it`;
    case 'out-of-bounds':
      return `tile ${String(error.to)} is not on the map`;
    case 'unknown-unit':
      return `the engine knows no unit ${String(error.unitId)}`;
    case 'not-your-unit':
      return `unit ${String(error.unitId)} belongs to player ${String(error.owner)}`;
    case 'unknown-player':
      return `the engine knows no player ${String(error.playerId)}`;
    case 'nothing-to-attack':
      return `there is nothing to attack on tile ${String(error.target)}`;
    case 'target-stacked':
      return `tile ${String(error.target)} holds more than one enemy unit, so there is no one battle to fight`;
    case 'unit-cannot-attack':
      return `unit ${String(error.unitId)} has no attack to make (attack ${String(error.attack)})`;
    case 'game-over':
      return `the game ended (${error.condition} at turn ${String(error.turn)}), so the engine accepts no further orders`;
    // Everything else: the engine's own name for the reason and nothing invented about it.
    default:
      return `the engine refused it (${error.kind})`;
  }
};
