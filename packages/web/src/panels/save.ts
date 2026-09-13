/**
 * Save and load — `button`/`Save game` and `button`/`Load game`, to `localStorage`.
 * See docs/INTERFACES.md, M8: "Save/load writes to `localStorage` and must round-trip
 * `stateHash()` unchanged."
 *
 * ## What a save is, and why the hash is in it
 *
 * A save is `{ schema, hash, state }`: the state exactly as `GameState` is (plain,
 * JSON-serialisable data — PLAN.md §4.3), plus the engine's own hash of it, written by the
 * engine's own hasher through the app's `stateHash()`. Storing the hash is not decoration: it
 * is what makes **loading verifiable**.
 *
 * ## Load is checked, not trusted, and it fails closed
 *
 * A load reads the payload, checks it is plausibly ours (`isGameState`), swaps it in, and then
 * asks the app for the hash **of the state it just installed**. If that hash differs from the
 * one stored in the file, the load is refused and the previous state is put back. So:
 *
 * - the round-trip property is enforced *by the loader*, not only asserted by a test — a save
 *   that cannot be reproduced exactly is rejected on the spot;
 * - a truncated or hand-edited payload cannot silently become the game;
 * - the failure is visible (`Load failed: …` in the panel's status line) rather than being a
 *   half-applied state.
 *
 * The check is deliberately *not* a deep field-by-field validator. The honest guarantee this
 * layer can give is "the engine hashes this back to the same value"; anything else would be
 * this file re-implementing the engine's schema — and a second, weaker validator is exactly
 * how a state that hashes differently slips through.
 *
 * ## What it never does
 *
 * It never mutates state except through `replaceState` (which the app owns and which is only
 * reachable from this panel's Load), never writes a key holding `undefined` (the state it
 * serialises is the engine's own, and `JSON.stringify` of it is what the hash covers), and
 * never reads the clock — a save's identity is its hash, not its timestamp.
 */

import type { GameState } from '@civts/core';
import type { PanelContext } from './index.js';

/** The `localStorage` key a save lives under. One slot, documented, so it is findable. */
export const SAVE_KEY = 'civts.save.v1';

/** The save format's own version — separate from `GameState.schemaVersion` on purpose. */
export const SAVE_SCHEMA = 1;

/** What a save file holds. */
export interface SaveFile {
  readonly schema: number;
  /** The engine's hash of `state`, as `stateHash()` returned it when the save was written. */
  readonly hash: string;
  readonly state: GameState;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Does this look like a `GameState` this app can install?
 *
 * A **type predicate** rather than a cast: the checks below are real (every field the replayed
 * game touches must be present and of the right broad shape), and writing it as a predicate is
 * what lets the loader hand back a `GameState` without an `as` — the escape hatch this project
 * forbids precisely because it silences the question "is this actually a state".
 *
 * `terrain`'s length against `width * height`, and the three admin arrays the engine indexes
 * by player id, are checked because a save whose shape is wrong in those places would not throw
 * at load time; it would produce a plausible-looking game that refuses every command.
 */
const isGameState = (value: unknown): value is GameState => {
  if (!isRecord(value)) return false;
  if (typeof value['schemaVersion'] !== 'number') return false;
  if (typeof value['revision'] !== 'number') return false;
  if (typeof value['turn'] !== 'number') return false;
  if (typeof value['seed'] !== 'number') return false;
  if (typeof value['nextUnitId'] !== 'number') return false;
  if (typeof value['nextCityId'] !== 'number') return false;
  if (!isRecord(value['rng'])) return false;
  if (!isRecord(value['settings'])) return false;

  const map = value['map'];
  if (!isRecord(map)) return false;
  const width = map['width'];
  const height = map['height'];
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  const terrain = map['terrain'];
  if (!Array.isArray(terrain) || terrain.length !== width * height) return false;

  for (const key of ['players', 'units', 'cities', 'explored', 'improvements'] as const) {
    if (!Array.isArray(value[key])) return false;
  }
  return true;
};

/** The save payload for a state and its hash, as the string `localStorage` stores. */
export const serializeSave = (state: GameState, hash: string): string =>
  JSON.stringify({ schema: SAVE_SCHEMA, hash, state } satisfies SaveFile);

/**
 * Parse a save string. `undefined` for anything that is not a save this build can install —
 * malformed JSON, a foreign schema, a payload whose `state` is not state-shaped, or one whose
 * recorded hash is not a string.
 */
export const parseSave = (text: string): SaveFile | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed['schema'] !== SAVE_SCHEMA) return undefined;
  const hash = parsed['hash'];
  if (typeof hash !== 'string') return undefined;
  const state = parsed['state'];
  if (!isGameState(state)) return undefined;
  return { schema: SAVE_SCHEMA, hash, state };
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

export interface SavePanelHandle {
  readonly element: HTMLElement;
  readonly saveButton: HTMLButtonElement;
  readonly loadButton: HTMLButtonElement;
  /** The last outcome, in prose — `Saved (hash …)`, `Load failed: …`. */
  status(): string;
  refresh(): void;
}

/**
 * Mount the two buttons and a status line into `parent`.
 *
 * Both buttons are plain `button`s with the contractual names (`Save game`, `Load game`), and
 * every outcome — including failure — is reported in the status line rather than swallowed:
 * a load that refuses a corrupt save is the feature working, and a silent button would make it
 * indistinguishable from a broken one.
 */
export const mountSavePanel = (parent: HTMLElement, ctx: PanelContext): SavePanelHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'section');
  element.dataset['panel'] = 'save';

  const saveButton = el(doc, 'button', 'Save game');
  saveButton.type = 'button';
  const loadButton = el(doc, 'button', 'Load game');
  loadButton.type = 'button';
  const statusLine = el(doc, 'div');
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-label', 'Save status');
  statusLine.dataset['role'] = 'save-status';

  let message = 'No save yet.';

  const setStatus = (text: string): void => {
    message = text;
    statusLine.textContent = text;
  };

  const storage = (): Storage | undefined => {
    try {
      return doc.defaultView?.localStorage ?? undefined;
    } catch {
      // A browser may refuse `localStorage` entirely (private mode, a `file://` page, a
      // policy). "No storage" is a state this panel reports rather than a crash.
      return undefined;
    }
  };

  saveButton.addEventListener('click', () => {
    const store = storage();
    if (store === undefined) {
      setStatus('Save failed: this browser will not give the page storage.');
      return;
    }
    try {
      const hash = ctx.api.stateHash();
      store.setItem(SAVE_KEY, serializeSave(ctx.api.state(), hash));
      setStatus(`Saved (hash ${hash})`);
    } catch (cause) {
      setStatus(`Save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });

  loadButton.addEventListener('click', () => {
    const store = storage();
    if (store === undefined) {
      setStatus('Load failed: this browser will not give the page storage.');
      return;
    }
    let text: string | null;
    try {
      text = store.getItem(SAVE_KEY);
    } catch (cause) {
      setStatus(`Load failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    if (text === null) {
      setStatus('Load failed: there is no save in this browser.');
      return;
    }
    const file = parseSave(text);
    if (file === undefined) {
      setStatus('Load failed: that save is not one this build can read.');
      return;
    }

    const previous = ctx.api.state();
    ctx.api.replaceState(file.state);
    const actual = ctx.api.stateHash();
    if (actual !== file.hash) {
      // Fail closed: the state we just installed does not hash to what the file claims, so it
      // is not the state that was saved. Put the old one back and say so.
      ctx.api.replaceState(previous);
      setStatus(`Load failed: the save hashes to ${actual}, not ${file.hash}.`);
      return;
    }
    setStatus(`Loaded (hash ${actual})`);
    ctx.refresh();
  });

  element.append(el(doc, 'h2', 'Save'), saveButton, loadButton, statusLine);
  parent.append(element);
  setStatus(message);

  return {
    element,
    saveButton,
    loadButton,
    status: () => message,
    refresh: () => {
      // Nothing on this panel is derived from the state; the method exists so the panel set
      // has one uniform shape (`refresh` on every panel, called by the app after a dispatch).
    },
  };
};
