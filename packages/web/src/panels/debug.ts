/**
 * The debug panel: `role="dialog"` named `Debug`, with the engine's state hash as a
 * `status` named `State hash` plus the internals worth having one click away.
 * See docs/INTERFACES.md, M8 ("The accessibility contract").
 *
 * ## The hash is the panel's one contractual element
 *
 * `State hash` is the same string `stateHash()` in the test seam returns and the same one the
 * goldens store — so this panel and a test read one value from one function, and a person
 * looking at the screen can compare it with a headless run byte for byte. It is rendered as
 * `role="status"` rather than as plain text because it *changes* when a command applies, and
 * a live region is how a screen reader learns that the game moved.
 *
 * ## Which internals, and why these
 *
 * The rest of the panel is the set of facts a person debugging a *state* actually needs, all
 * of them direct reads — never a derived number this file invented: schema version (does
 * this build understand this save?), revision (did that command apply?), turn, seed, map
 * dimensions, terrain id count, the RNG state's four words (a wrong RNG is a wrong game),
 * entity counts, and how many tiles the acting player has explored. Every one of them is a
 * field of `GameState` or a `length` over one, so the panel cannot disagree with the engine
 * about any of them.
 */

import { civPlayers, type GameState, type PlayerId, type RulesetView } from '@civts/core';
import type { PanelContext } from './index.js';

/** One labelled internal: `Revision`, `7`. */
export interface DebugFact {
  readonly label: string;
  readonly value: string;
}

/**
 * The facts the panel shows, the hash first (it is the contractual one).
 *
 * Pure, so the fast tier can assert the hash is present and that the counts match the state
 * without a DOM.
 */
export const debugFacts = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  hash: string,
): readonly DebugFact[] => {
  const tiles = state.map.width * state.map.height;
  // A direct read of the state's own explored row (the layer `fog.ts` owns and is the only
  // writer of): counting the true entries is arithmetic over stored data, not a second
  // visibility rule — nothing here asks which tiles are *visible* now.
  const explored = (state.explored[Number(playerId)] ?? []).filter((seen) => seen).length;

  return [
    { label: 'State hash', value: hash },
    { label: 'Schema version', value: String(state.schemaVersion) },
    { label: 'Revision', value: String(state.revision) },
    { label: 'Turn', value: String(state.turn) },
    { label: 'Seed', value: String(state.seed) },
    {
      label: 'Map',
      value: `${String(state.map.width)}×${String(state.map.height)} (${String(tiles)} tiles)`,
    },
    { label: 'Terrain ids', value: String(state.map.terrain.length) },
    { label: 'Huts left', value: String(state.map.huts.length) },
    { label: 'Resources placed', value: String(state.map.resources.length) },
    {
      label: 'Rng',
      value: `${String(state.rng.a)}/${String(state.rng.b)}/${String(state.rng.c)}/${String(state.rng.d)}`,
    },
    { label: 'Players', value: String(state.players.length) },
    { label: 'Civilizations', value: String(civPlayers(state).length) },
    { label: 'Units', value: String(state.units.length) },
    { label: 'Cities', value: String(state.cities.length) },
    { label: 'Improvements', value: String(state.improvements.length) },
    { label: 'Ruleset fidelity', value: ruleset.fidelity },
    {
      label: 'Explored by the acting player',
      value: `${String(explored)} / ${String(tiles)}`,
    },
  ];
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

export interface DebugPanelHandle {
  readonly element: HTMLElement;
  readonly dialog: HTMLDialogElement;
  /** The `status` element named `State hash` — the contractual one. */
  readonly hashStatus: HTMLElement;
  refresh(): void;
  open(): void;
}

/**
 * Mount the debug panel into `parent`: a `Debug` button, the `State hash` status, and the
 * dialog holding the rest of the internals.
 *
 * **The hash status sits outside the dialog, and that is deliberate.** A closed `<dialog>` is
 * `display: none`, so everything inside it is out of the accessibility tree — and a test that
 * asks "does the screen show the engine's hash?" should not have to open a modal first to find
 * out. The hash is also the one fact worth having on screen permanently while debugging, so it
 * lives in the always-visible part of this panel (`data-panel="debug"`) and the dialog holds
 * the facts that are worth a click. There is exactly one element named `State hash`; putting a
 * second copy inside the dialog would make `getByRole('status', { name: 'State hash' })`
 * ambiguous, which is a worse failure than the one it would fix.
 *
 * The facts are rebuilt on every refresh because every one of them is a read of the current
 * state, and a debug panel showing a stale revision is worse than no debug panel.
 */
export const mountDebugPanel = (parent: HTMLElement, ctx: PanelContext): DebugPanelHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'section');
  element.dataset['panel'] = 'debug';

  const openButton = el(doc, 'button', 'Debug');
  openButton.type = 'button';

  const dialog = doc.createElement('dialog');
  dialog.setAttribute('aria-label', 'Debug');
  const close = el(doc, 'button', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });

  const hashStatus = el(doc, 'div');
  hashStatus.setAttribute('role', 'status');
  hashStatus.setAttribute('aria-label', 'State hash');
  hashStatus.dataset['role'] = 'state-hash';

  const facts = el(doc, 'dl');
  dialog.append(el(doc, 'h2', 'Debug'), close, facts);
  element.append(el(doc, 'h2', 'Debug'), openButton, hashStatus, dialog);
  parent.append(element);

  const refresh = (): void => {
    const state = ctx.api.state();
    const hash = ctx.api.stateHash();
    const rows = debugFacts(state, ctx.api.ruleset, ctx.api.playerId(), hash);

    const first = rows[0];
    hashStatus.textContent = first === undefined ? hash : first.value;

    facts.replaceChildren();
    for (const row of rows.slice(1)) {
      facts.append(el(doc, 'dt', row.label), el(doc, 'dd', row.value));
    }
  };

  const open = (): void => {
    refresh();
    // `show()` rather than `showModal()`: see the note on `mountCityPanel` — the panel is a
    // side screen of a game that is still being played, so the map must stay operable.
    if (!dialog.open) dialog.show();
  };
  openButton.addEventListener('click', open);

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, dialog, hashStatus, refresh, open };
};
