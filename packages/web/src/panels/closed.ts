/**
 * **Has the engine finished this game?** — the one question every command control asks before it
 * renders itself.
 * See docs/INTERFACES.md, M9+M10 ("Victory and score": "A finished game REFUSES further commands
 * with a typed error, which is the difference between a victory screen and a game that keeps
 * playing behind it") and M8 ("The UI must not contain game rules").
 *
 * ## Why this is a module of its own
 *
 * It is four lines, and it lives apart from `index.ts` for one reason: `index.ts` imports every
 * panel, so a panel importing a *value* back out of `index.ts` would make a runtime cycle. A type
 * import is erased and costs nothing; this is not a type. So the shared read sits below both, and
 * every panel — the unit action group, the city screen's tiles and menu, the tech tree, the rates
 * row, the government selector — asks *this*.
 *
 * ## What it decides, and what it refuses to decide
 *
 * `isGameOver` is `victory.ts`' own public statement of "the game has ended": it is a pure
 * recomputation of the outcome, so the same board always answers the same way and no panel can hold
 * a stale verdict across a load, a new game or a dispatch. This module decides **nothing** — it does
 * not know which condition fired, who won, or whether a panel should disable or hide a control. It
 * answers the one question the keystone property needs answered: *would the engine refuse a command
 * issued right now?*
 *
 * The UI never stores the answer and never derives it from a screen: a finished game is a fact about
 * the state, and a flag living in the presentation layer would be a second place for it to be wrong.
 */

import { isGameOver } from '@civts/core';
import type { PanelsApi } from './index.js';

/**
 * The engine's own answer for the state the panels are rendering.
 *
 * A panel that offers a command while this is true offers a control whose command `applyCommand`
 * would refuse with `game-over` — the exact defect the M8 keystone forbids. So a command control is
 * rendered `disabled` while it holds (never removed: "what this unit could have done" is still true
 * of the final position, and a disabled control is not one the page *offers*).
 */
export const commandsClosed = (api: PanelsApi): boolean => isGameOver(api.state(), api.ruleset);
