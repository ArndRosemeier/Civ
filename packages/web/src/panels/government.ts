/**
 * The government selector — M9's one new player-level control.
 * See docs/INTERFACES.md, M9+M10 ("Governments", "The UI") and M8 ("The UI must not contain game
 * rules", "The accessibility contract").
 *
 * ## The menu is the engine's catalog and the verdict is the engine's planner
 *
 * `SetGovernment` is a **queried setter** in exactly the sense `SetRates` is: the engine accepts it
 * (`applyCommand` applies it, `legalActions` never enumerates it) and it takes an id from a small
 * closed set. So this panel is built the way the rates row in `index.ts` is built, and for the same
 * reason: it *offers the catalog's rows* and lets the **engine** say whether this player may adopt
 * the selected one.
 *
 * - the menu is `governmentCatalog(ruleset)` — `governments.ts`' own list, in catalog order, so a
 *   ruleset that ships a fourth government needs no change here;
 * - the verdict is `planSetGovernment(state, ruleset, playerId, id)` — **the evaluator
 *   `applyCommand` itself refuses with**, so the sentence a player reads and the answer to the
 *   click are one answer, and no prerequisite, cap or id check is restated in this package;
 * - the control is rendered `disabled` while the verdict refuses, so the panel cannot offer an
 *   action the applier would turn down — the keystone property (docs/INTERFACES.md, M8) at this
 *   panel.
 *
 * ## The two refusals this panel must be able to show
 *
 * The engine refuses a `SetGovernment` for an id no `governments` row defines
 * (`unknown-government`, which carries the ids it *does* know) and for a row whose `requiresTech`
 * this player has not researched (`government-tech-required`, which names the tech). Both are
 * rendered here in the engine's own words, with the error's own `kind` in the sentence so a reader
 * (and a test) can see *which* refusal the engine gave rather than a UI paraphrase:
 *
 * ```
 * the engine refuses it (unknown-government): it knows no government "senate"; it knows despotism, monarchy, republic
 * the engine refuses it (government-tech-required): Monarchy needs Monarchy, which has not been researched
 * ```
 *
 * The unknown-id case is unreachable from the menu — the menu is the catalog, so every id it offers
 * is one the engine knows — which is exactly why the verdict is a function of a **government id**
 * rather than of the menu: a player's saved state, a hand-built fixture or a stale menu can name an
 * id this ruleset does not describe, and the honest thing for the panel to do with it is to print
 * the engine's refusal rather than to crash or to guess.
 *
 * ## The control's accessibility names (new, and unique)
 *
 * | element | role | accessible name |
 * |---|---|---|
 * | the menu | `combobox` | `Government` |
 * | the button that dispatches | `button` | `Set government` |
 * | the engine's verdict | `status` | `Government verdict` |
 *
 * None collides with the frozen M8 table: the role-and-name pairs there are a `status` named
 * `Treasury`/`Science`/`Luxury`/`Turn`/`Year`, a `button` named `End turn`, and so on, and these
 * three names are new. They are also distinct from the rates row's `Tax rate`/`Science rate`/
 * `Luxury rate`/`Set rates`/`Rates`, which sits beside them. `docs/INTERFACES.md`' M8 section is
 * frozen and is **not** edited; the names are stated here, beside the panel, which is what the M9
 * contract asks for instead.
 */

import {
  asGovernmentId,
  governmentCatalog,
  planSetGovernment,
  type GameError,
  type GameState,
  type GovernmentId,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { governmentLabel, techName } from '../events.js';
import { commandsClosed } from './closed.js';
import type { PanelContext } from './index.js';

/** One row of the menu: the engine's own id and the engine's own name for it. */
export interface GovernmentOption {
  readonly id: GovernmentId;
  readonly name: string;
}

/** Every government this ruleset describes, in catalog order — the menu's whole content. */
export const governmentOptions = (ruleset: RulesetView): readonly GovernmentOption[] =>
  governmentCatalog(ruleset).map((row) => ({ id: row.id, name: row.name }));

/** What the engine says about adopting one government: acceptable, or why not, in its own words. */
export interface GovernmentVerdict {
  readonly acceptable: boolean;
  readonly note: string;
}

/**
 * The engine's own reason for refusing a `SetGovernment`, verbatim where the engine gave a reason.
 *
 * `planSetGovernment` refuses for exactly four reasons, and the two a player can act on are named
 * here with the `kind` beside them — the same shape `index.ts`' `refusalNote` takes for rates, and
 * for the same reason: exactly one statement of the government rule exists, in `commands.ts`, and
 * this panel prints it rather than paraphrasing it.
 */
const refusalNote = (ruleset: RulesetView, error: GameError): string => {
  switch (error.kind) {
    case 'unknown-government':
      return `the engine knows no government "${String(error.government)}"; it knows ${error.known.join(', ')}`;
    case 'government-tech-required':
      return `${governmentLabel(ruleset, error.government)} needs ${techName(ruleset, error.tech)}, which has not been researched`;
    case 'invalid-argument':
      return error.detail;
    case 'unknown-player':
      return `the engine knows no player ${String(error.playerId)}`;
    default:
      return `the engine refused it without naming a reason this panel can read`;
  }
};

/**
 * Ask the ENGINE whether this player may adopt `government`, and report its answer.
 *
 * This is the whole of the control's participation in the rule: `planSetGovernment` is the
 * evaluator `applyCommand` itself refuses with, so the answer here and the answer to the click are
 * one answer. Nothing about a government's prerequisite, its caps or its name is decided in this
 * file.
 */
export const governmentVerdict = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  government: GovernmentId,
): GovernmentVerdict => {
  const plan = planSetGovernment(state, ruleset, playerId, government);
  if (plan.ok) {
    // The plan carries the row the engine matched, so the name printed here is the one the engine
    // accepted — not a second lookup that could answer for a different row.
    return {
      acceptable: true,
      note: `the engine accepts ${plan.value.government.name} as your government`,
    };
  }
  return {
    acceptable: false,
    note: `the engine refuses it (${plan.error.kind}): ${refusalNote(ruleset, plan.error)}`,
  };
};

export interface GovernmentControlHandle {
  /** The `[data-panel='government']` row. */
  readonly element: HTMLElement;
  /** The menu: one option per catalog row, in catalog order. */
  readonly select: HTMLSelectElement;
  /** The control that dispatches `SetGovernment`; disabled exactly when the engine refuses it. */
  readonly button: HTMLButtonElement;
  /** The `status` named `Government verdict`: the engine's own verdict, verbatim. */
  readonly notice: HTMLElement;
  refresh(): void;
}

/**
 * The government a `<select>` value names, or `undefined` for a value no option carries.
 *
 * The menu is a DOM element, so what it holds is a plain string; this turns it back into the
 * engine's branded id **by finding the option it came from** rather than by asserting the type.
 * A value no option carries answers `undefined` — and the fallback below then shows the state's
 * own government, which is what the menu was showing anyway.
 */
const optionIdOf = (
  options: readonly GovernmentOption[],
  value: string,
): GovernmentId | undefined => options.find((option) => option.id === value)?.id;

/**
 * Mount the government row into `parent` (the status strip, beside the rates it caps).
 *
 * The draft is the player's choice until the state's **own** government changes, and a refresh
 * re-seeds it only then — the same rule the rates row follows, and for the same reason: the panels
 * re-render on every command and every selection, and an edit in flight must not be wiped by a
 * click on something else. `Set government` dispatches through the same seam every other control
 * uses, so a test's instrumentation sees it and the engine applies it once.
 */
export const mountGovernmentControl = (
  parent: HTMLElement,
  ctx: PanelContext,
): GovernmentControlHandle => {
  const doc = parent.ownerDocument;
  const element = doc.createElement('div');
  element.dataset['panel'] = 'government';
  const caption = doc.createElement('span');
  caption.textContent = 'Government';
  element.append(caption);

  const options = governmentOptions(ctx.api.ruleset);
  const select = doc.createElement('select');
  select.setAttribute('aria-label', 'Government');
  for (const option of options) {
    const node = doc.createElement('option');
    node.value = option.id;
    node.textContent = option.name;
    select.append(node);
  }

  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Set government';
  button.dataset['command'] = 'SetGovernment';

  const notice = doc.createElement('span');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-label', 'Government verdict');

  element.append(select, button, notice);
  parent.append(element);

  /** The id the player has chosen, or `undefined` while the menu shows the state's own. */
  let chosen: GovernmentId | undefined;
  /** The state's own government as last seen — the menu's fallback and the drift detector. */
  let theirs: GovernmentId = options[0]?.id ?? asGovernmentId('');
  let seen = '';

  /**
   * The government the control is asking about: the player's choice when there is one, and the
   * state's own otherwise. Total, because `theirs` is seeded from the catalog — and a ruleset with
   * no `governments` section at all seeds the empty id, which the engine then refuses with
   * `unknown-government`, which is the honest sentence for "this ruleset describes no government".
   */
  const selected = (): GovernmentId => chosen ?? theirs;

  const update = (): void => {
    const verdict = governmentVerdict(
      ctx.api.state(),
      ctx.api.ruleset,
      ctx.api.playerId(),
      selected(),
    );
    // M10: a finished game refuses every command, so the control is closed with the engine's own
    // verdict rather than beside it. The menu itself stays usable — looking at what a government
    // would have been is not issuing a command — but the button that dispatches is not offered.
    button.disabled = !verdict.acceptable || commandsClosed(ctx.api);
    notice.textContent = verdict.note;
  };

  select.addEventListener('change', () => {
    chosen = optionIdOf(options, select.value);
    update();
  });

  button.addEventListener('click', () => {
    ctx.dispatch({ type: 'SetGovernment', government: selected() });
  });

  const refresh = (): void => {
    const player = ctx.api.state().players.find((candidate) => candidate.id === ctx.api.playerId());
    const current = player?.government ?? '';
    if (current !== seen) {
      seen = current;
      // The engine's government moved (a load, a new game, another seat): the menu follows it and
      // the player's in-flight choice is dropped, because it was a choice about the old state.
      chosen = undefined;
      if (player !== undefined) theirs = player.government;
    }
    const wanted = selected();
    if (select.value !== wanted) select.value = wanted;
    update();
  };

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, select, button, notice, refresh };
};
