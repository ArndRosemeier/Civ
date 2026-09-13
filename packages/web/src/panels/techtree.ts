/**
 * The tech tree: known / available / locked, and research selection.
 * See docs/INTERFACES.md, M8 ("The accessibility contract": `dialog`/`Technology`) and M5's
 * research rules (`tech.ts`).
 *
 * ## The three states are the engine's, computed once
 *
 * A tech is:
 *
 * - **known** — `knowsTech(player, id)`, the engine's total read of `PlayerState.techs`;
 * - **available** — `researchProblem(ruleset, player, id)` answers `undefined`, i.e. every
 *   direct prerequisite is known and the row has a usable price;
 * - **locked** — anything else, and the reason travels with the row (`missing`, the direct
 *   prerequisites the player does not know) so the screen can say *why* rather than only
 *   that it cannot be researched.
 *
 * The classification is derived from two engine calls and nothing else: no cost is
 * recomputed, no prerequisite list is re-walked here, and "available" is not inferred from
 * the era or the tree's shape.
 *
 * ## The control that is offered, and the one that is not
 *
 * `SetResearch` is legal exactly where `planSetResearch` accepts it, and that planner is
 * built on the same `researchProblem` this file classifies with — so a row rendered
 * `available` is a row the applier accepts, and a row rendered `known` or `locked` renders a
 * **disabled** button. That is the keystone property at this panel: the UI offers an action
 * only where the engine's own planner offers it, and it *shows* the refusals it cannot
 * offer, because "why can I not research this?" is the question the tree exists to answer.
 */

import {
  currentResearch,
  isOk,
  knowsTech,
  planSetResearch,
  researchingOf,
  researchProblem,
  techCatalog,
  type GameState,
  type PlayerId,
  type PlayerState,
  type RulesetView,
  type TechDef,
  type TechId,
} from '@civts/core';
import { assertNever, techName } from '../events.js';
import type { PanelContext } from './index.js';

/** The three states a tree node can be in. */
export type TechState = 'known' | 'available' | 'locked';

/** One node of the tree, as the screen renders it. */
export interface TechRow {
  readonly id: TechId;
  readonly name: string;
  /** The catalog's own era label — opaque to the engine, so it is printed verbatim. */
  readonly era: string;
  /** `undefined` when the row has no usable price (see `TechState`). */
  readonly cost: number | undefined;
  readonly state: TechState;
  /** Direct prerequisites this player does not know, in canonical order. */
  readonly missing: readonly TechId[];
  /** `planSetResearch` accepts a `SetResearch` for this tech — the control's enablement. */
  readonly selectable: boolean;
  /** This is the tech the player is currently researching. */
  readonly researching: boolean;
}

/**
 * Classify one tech for one player, from the engine's own answers only.
 *
 * A row the ruleset cannot price (`techDef`/`techCostOf` refuse it) is `locked` rather than
 * a fourth state: the engine will not research it, and "not researchable" is what locked
 * means. `researchProblem` reports it as `unknown-tech`, and the row's `cost` stays
 * `undefined` so the screen can say so.
 */
export const classifyTech = (ruleset: RulesetView, player: PlayerState, id: TechId): TechState => {
  if (knowsTech(player, id)) return 'known';
  return researchProblem(ruleset, player, id) === undefined ? 'available' : 'locked';
};

/**
 * The whole tree for the acting player, in catalog order (data order, never RNG order, so
 * the list is identical on every frame and every machine). `[]` when the state holds no such
 * player: an absent player can research nothing, which is what `planSetResearch` says about
 * such an actor too.
 */
export const techRows = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly TechRow[] => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) return [];

  return techCatalog(ruleset).map((def: TechDef) => {
    const problem = researchProblem(ruleset, player, def.id);
    const state_: TechState = classifyTech(ruleset, player, def.id);
    return {
      id: def.id,
      name: techName(ruleset, def.id),
      era: def.era,
      cost: problem === undefined || problem.kind !== 'unknown-tech' ? def.cost : undefined,
      state: state_,
      missing:
        problem !== undefined && problem.kind === 'unmet-prerequisite' ? problem.missing : [],
      selectable: planSetResearch(state, ruleset, playerId, def.id).ok,
      researching: researchingOf(player) === def.id,
    };
  });
};

/** What the player is researching, with the engine's own reason when there is nothing. */
export interface ResearchStatus {
  /** The tech's name, or absent when nothing is being researched. */
  readonly name?: string;
  /** Beakers banked so far — the state's own pool, spent by the pipeline. */
  readonly beakers: number;
  /** The reason there is no current research, when there is none. */
  readonly note: string;
}

/**
 * The header line of the tech dialog. Uses `currentResearch`, which is `tech.ts`' own answer
 * to "what am I researching and what does it cost" — so a `researching` id this ruleset
 * cannot price or that the player somehow already knows is reported as exactly that, rather
 * than being mistaken for "nothing yet".
 */
export const researchStatus = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): ResearchStatus => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  const beakers = player?.beakers ?? 0;
  const current = currentResearch(state, ruleset, playerId);
  if (isOk(current)) return { name: current.value.name, beakers, note: 'in progress' };

  switch (current.error.kind) {
    case 'nothing-being-researched':
      return { beakers, note: 'nothing is being researched' };
    case 'unknown-tech':
      return { beakers, note: `the ruleset cannot price ${current.error.tech}` };
    case 'already-known':
      return { beakers, note: `${current.error.tech} is already known` };
    case 'unmet-prerequisite':
      return {
        beakers,
        note: `${current.error.tech} waits on ${current.error.missing.join(', ')}`,
      };
  }
  return assertNever(current.error);
};

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface TechPanelHandle {
  readonly element: HTMLElement;
  readonly dialog: HTMLDialogElement;
  refresh(): void;
  open(): void;
}

/**
 * Mount the tech screen into `parent`: a `Technology` button (the way in) and the dialog
 * itself, `role="dialog"` by virtue of being a native `<dialog>`, named `Technology`.
 *
 * Each tech is a button labelled `<name> (<era>, <cost> beakers)` with its state in a
 * `data-state` attribute, disabled unless the engine's planner accepts a `SetResearch` for
 * it. A lock is never hidden: the row is on the screen with its missing prerequisites named,
 * because a tree that only showed what you can already have would not be a tree.
 */
export const mountTechPanel = (parent: HTMLElement, ctx: PanelContext): TechPanelHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'section');
  element.dataset['panel'] = 'technology';

  const openButton = el(doc, 'button', 'Technology');
  openButton.type = 'button';

  const dialog = doc.createElement('dialog');
  dialog.setAttribute('aria-label', 'Technology');
  const close = el(doc, 'button', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });
  const status = el(doc, 'p');
  const list = el(doc, 'ul');
  dialog.append(el(doc, 'h2', 'Technology'), close, status, list);
  element.append(openButton, dialog);
  parent.append(element);

  const refresh = (): void => {
    const state = ctx.api.state();
    const ruleset = ctx.api.ruleset;
    const playerId = ctx.api.playerId();

    const research = researchStatus(state, ruleset, playerId);
    status.textContent =
      research.name === undefined
        ? `Researching: ${research.note} (${String(research.beakers)} beakers)`
        : `Researching: ${research.name} (${String(research.beakers)} beakers banked)`;

    list.replaceChildren();
    for (const row of techRows(state, ruleset, playerId)) {
      const item = el(doc, 'li');
      const button = el(
        doc,
        'button',
        `${row.name} (${row.era}${row.cost === undefined ? '' : `, ${String(row.cost)} beakers`})`,
      );
      button.type = 'button';
      button.dataset['state'] = row.state;
      button.dataset['tech'] = row.id;
      button.disabled = !row.selectable;
      if (row.researching) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => {
        ctx.dispatch({ type: 'SetResearch', tech: row.id });
      });
      item.append(button);
      if (row.state === 'locked' && row.missing.length > 0) {
        item.append(el(doc, 'span', ` — requires ${row.missing.join(', ')}`));
      }
      list.append(item);
    }
  };

  const open = (): void => {
    refresh();
    // `show()`, not `showModal()` — same reason as the city screen: the game keeps its
    // controls while a panel is open, and a modal would make the rest of the page inert.
    if (!dialog.open) dialog.show();
  };
  openButton.addEventListener('click', open);

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, dialog, refresh, open };
};
