/**
 * The victory / defeat screen — M10's end of the game, and A1's last step.
 * See docs/INTERFACES.md, M9+M10 ("Victory and score", "The UI") and M8 ("The test seam", "The
 * accessibility contract").
 *
 * ## The outcome is DERIVED, and this screen is the only thing that decides nothing
 *
 * `GameOutcome` is not a stored flag; it is `outcomeFor(state, ruleset, playerId)` over the board
 * as it stands, so the screen cannot disagree with the world it describes and a state that no
 * command can produce cannot be "reported". Three consequences, all of them load-bearing:
 *
 * - **`kind` is caller-relative.** `victory` when the winner is the watching seat, `defeat` when
 *   somebody else won, `draw` when nobody did. One engine value serves the player, the headless
 *   runner and the tournament because the relative half is computed by `outcomeFor` for the player
 *   who is asking rather than stored per seat.
 * - **The condition and the turn are the engine's.** The screen prints `outcome.condition` (the
 *   `VictoryConditionId` the catalog declares — `conquest`, `domination`, `cultural`, `score`) and
 *   `outcome.turn` verbatim rather than naming them itself; there is no second table of condition
 *   names here to drift from the catalog's order or its membership.
 * - **A finished game refuses further commands.** `applyCommand` answers `game-over`, so this
 *   screen is *why* the rest of the UI stops offering them: every panel asks the engine's own
 *   `isGameOver` before it renders a command control (see `commandsClosed` in `index.ts`, and the
 *   `End turn`/ability guards in `main.ts`). A victory screen over a game that kept playing would
 *   be a picture, not an end.
 *
 * ## When it is shown
 *
 * `refresh()` shows the dialog the first time the outcome appears, and never re-opens it after the
 * player has closed it — `shownFor` remembers the outcome it opened for, so a refresh loop (every
 * command, every selection, every frame that redraws a panel) cannot make the dialog un-closable.
 * A *new* outcome (a new game that ends) shows again, because the key changed.
 *
 * ## Its accessibility names (new, and unique)
 *
 * | element | role | accessible name |
 * |---|---|---|
 * | the screen | `dialog` | `Game over` |
 * | the re-open control | `button` | `Show outcome` |
 * | the close control | `button` | `Close outcome` |
 *
 * The M8 table's dialogs are named `City <name>`, `Technology` and `Debug`, so `Game over` is new
 * and collides with none of them; `Show outcome` and `Close outcome` are new button names (the
 * other screens' close controls are all plain `Close`, so this one is deliberately spelled longer).
 * `docs/INTERFACES.md`' M8 section is frozen and is **not** edited; the names live here, beside the
 * panel, which is what the M9 contract asks for instead.
 */

import { outcomeFor, type GameState, type PlayerId, type RulesetView } from '@civts/core';
import { playerLabel } from '../events.js';
import type { PanelContext } from './index.js';

/** What the screen says, all of it read out of the engine's own `GameOutcome`. */
export interface OutcomeFacts {
  readonly kind: 'victory' | 'defeat' | 'draw';
  /** The engine's own condition id, verbatim — never a name this file invented. */
  readonly condition: string;
  readonly winner: PlayerId | null;
  readonly turn: number;
  /** `Victory` / `Defeat` / `Draw` — the heading. */
  readonly headline: string;
  /** One sentence naming the condition, the turn and the winner. */
  readonly detail: string;
}

const HEADLINES: Readonly<Record<OutcomeFacts['kind'], string>> = {
  victory: 'Victory',
  defeat: 'Defeat',
  draw: 'Draw',
};

/**
 * The screen's contents for the seat watching, or `undefined` while the game is still being
 * played — `outcomeFor`' answer, rendered.
 *
 * The winner is named through `events.ts`' `playerLabel`, the same spelling the log uses, and a
 * draw says so in words: `winner: null` is a real outcome (the score condition's tie rule) and the
 * screen must not print "nobody" as though a name were missing.
 */
export const outcomeFacts = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): OutcomeFacts | undefined => {
  const outcome = outcomeFor(state, ruleset, playerId);
  if (outcome === undefined) return undefined;

  const headline = HEADLINES[outcome.kind];
  const winner = outcome.winner;
  // A draw keeps the engine's own `winner: null` and says only what is true of it: nobody won. It
  // does NOT explain *why* — the engine's score condition is the one that can produce a null
  // winner, but a screen that printed "the scores are tied" would be asserting a reason it was
  // never told, and a state with no civilization at all produces the same null for a different one.
  const who = winner === null ? 'nobody won' : `${playerLabel(state, winner)} won`;
  return {
    kind: outcome.kind,
    condition: outcome.condition,
    winner,
    turn: outcome.turn,
    headline,
    detail: `${who} by the engine's "${outcome.condition}" condition, on turn ${String(outcome.turn)}.`,
  };
};

export interface VictoryPanelHandle {
  /** The wrapper holding the re-open control and the dialog. */
  readonly element: HTMLElement;
  /** The `dialog` named `Game over`. */
  readonly dialog: HTMLDialogElement;
  /** The `button` named `Show outcome`, present only while the game is over. */
  readonly opener: HTMLButtonElement;
  refresh(): void;
}

/**
 * Mount the outcome screen into `parent`: a `<dialog>` that stays closed until the game ends (or
 * until the player re-opens it) and a `Show outcome` control that exists only once there is an
 * outcome to show.
 *
 * `show()`, not `showModal()`, for the same reason the city, tech and debug panels use it: a modal
 * makes the rest of the page inert, and this app keeps the map and its panels live. Here the reason
 * is even sharper — the screen is the *end* of a game whose final position a player is entitled to
 * keep looking at.
 */
export const mountVictoryPanel = (parent: HTMLElement, ctx: PanelContext): VictoryPanelHandle => {
  const doc = parent.ownerDocument;
  const element = doc.createElement('section');
  element.dataset['panel'] = 'outcome';

  const opener = doc.createElement('button');
  opener.type = 'button';
  opener.textContent = 'Show outcome';
  opener.hidden = true;

  const dialog = doc.createElement('dialog');
  dialog.setAttribute('aria-label', 'Game over');
  dialog.dataset['panel'] = 'outcome-dialog';
  const headline = doc.createElement('h2');
  const detail = doc.createElement('p');
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Close outcome';
  close.addEventListener('click', () => {
    dialog.close();
  });
  dialog.append(headline, detail, close);

  opener.addEventListener('click', () => {
    if (!dialog.open) dialog.show();
  });

  element.append(opener, dialog);
  parent.append(element);

  /**
   * The outcome this dialog was opened for, so a dismissed screen stays dismissed.
   *
   * `''` means "nothing shown yet"; a new game that ends produces a different key and shows again.
   */
  let shownFor = '';

  const refresh = (): void => {
    const facts = outcomeFacts(ctx.api.state(), ctx.api.ruleset, ctx.api.playerId());
    if (facts === undefined) {
      // While the game runs there is nothing to show and nothing to re-open: the control is absent
      // rather than disabled, so the page offers no command the engine would refuse and no button
      // that does nothing.
      opener.hidden = true;
      shownFor = '';
      if (dialog.open) dialog.close();
      return;
    }

    headline.textContent = facts.headline;
    detail.textContent = facts.detail;
    opener.hidden = false;

    const key = `${facts.kind}/${facts.condition}/${String(facts.turn)}/${String(facts.winner)}`;
    if (key !== shownFor) {
      shownFor = key;
      if (!dialog.open) dialog.show();
    }
  };

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, dialog, opener, refresh };
};
