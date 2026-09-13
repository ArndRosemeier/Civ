/**
 * Save and load — `button`/`Save game` and `button`/`Load game`, to `localStorage`.
 * See docs/INTERFACES.md, M8: "Save/load writes to `localStorage` and must round-trip
 * `stateHash()` unchanged", and M11 ("One serialization module, one version").
 *
 * ## This file is not a format any more
 *
 * It used to own one: `{ schema, hash, state }`, its own `SAVE_SCHEMA`, its own
 * `isGameState` shape check, and its own install-then-verify-rollback dance at load.
 * That made the browser the **second** serialization in the tree — a save the browser
 * wrote could not be read by `civts load`, and the reverse — and nothing in either place
 * could notice, because neither had ever seen the other's file.
 *
 * M11 settles it: there is one serialization module (`@civts/core`'s `serialize.ts`), one
 * format (`{ version, engine: { schemaVersion, nodeMajor }, hash, state }`) and one version
 * check. This file keeps only what genuinely belongs to it:
 *
 * - the `localStorage` key a save lives under;
 * - the two buttons and their status line;
 * - the codec — the engine's own hasher, `hashValue`, which is the **same function**
 *   `stateHash()` calls, so the browser and the goldens cannot disagree about what a state
 *   hashes to.
 *
 * ## Load is checked by the engine, before anything is installed
 *
 * `deserialize` is total: malformed JSON, a missing field, a field of the wrong type, an
 * out-of-range index, an unknown version, a state whose hash disagrees with the hash the
 * payload carries, and a state that violates an invariant each come back as a typed error.
 * Nothing is half-built and nothing is thrown, so the panel's load is now:
 *
 *     read (checked) → replace, or report and change nothing
 *
 * The old "install it, hash it, put the old one back if the hash disagrees" is gone — and
 * gone *because it is no longer needed*, not because it was dropped: the hash is checked by
 * the loader, against the state in the same file, before any of it reaches the game. That is
 * strictly stronger: a refused load never touches the state at all.
 *
 * ## The one honest narrowing
 *
 * The codec's invariant registry is **empty here**, and that is a real difference from
 * `civts load`, not a detail. The registry is `@civts/sim`'s `CORE_INVARIANTS`, whose checks
 * need a validated `Ruleset` (the full catalog); this app is handed a `RulesetView` (the
 * browser's own view of the ruleset), and `PanelsApi` exposes nothing more. So a save loaded
 * in the browser is checked for its format, its engine identity, every field and index, and
 * its hash — and **not** for the cross-field invariants the simulation maintains.
 *
 * Stated plainly, because a silently skipped check is the failure this milestone is named
 * after: the browser refuses a payload that is not this state's own serialisation; the CLI's
 * `civts load` additionally refuses one that is not a legal game. Both use the same
 * serializer and the same file format.
 *
 * ## What it never does
 *
 * It never mutates state except through `replaceState` (which the app owns and which is only
 * reachable from this panel's Load), never writes a key holding `undefined` (`JSON.stringify`
 * drops an undefined-valued key, which is exactly the absent-never-undefined rule, and the
 * hash covers the state, so key order cannot matter), and never reads the clock — a save's
 * identity is its hash, not its timestamp.
 */

import {
  SAVE_VERSION,
  deserialize,
  err,
  formatSaveError,
  ok,
  payloadOf,
  type GameState,
  type Result,
  type SaveCodec,
  type SaveError,
} from '@civts/core';
import { hashValue } from '@civts/testing';

import type { PanelContext } from './index.js';

/** The `localStorage` key a save lives under. One slot, documented, so it is findable. */
export const SAVE_KEY = 'civts.save.v1';

/**
 * The save format's version — **the engine's**, aliased rather than restated.
 *
 * `SAVE_VERSION` and this constant are the same number, and a second one here is exactly how
 * the two drift: a build that bumped the engine's version and forgot this one would write
 * files it then refused to read.
 */
export const SAVE_SCHEMA = SAVE_VERSION;

/** The engine's codec as this app can build it. See "The one honest narrowing" above. */
export const webCodec = (): SaveCodec => ({ hash: hashValue, invariants: [] });

/** What a save file holds, in the shape this app's loader has always returned. */
export interface SaveFile {
  /** The engine's format version (`SAVE_VERSION`). */
  readonly schema: number;
  /** The engine's hash of `state`, as `stateHash()` returned it when the save was written. */
  readonly hash: string;
  readonly state: GameState;
}

/**
 * The save payload for a state, as the string `localStorage` stores.
 *
 * `hash` is the caller's own `stateHash()`. The payload carries the **engine's** hash of the
 * state (`payloadOf` hashes the state itself), and this function's one job with the argument is
 * to insist the two agree — the old format wrote whatever it was handed, so a panel that saved
 * the hash of a *different* state wrote a file that lied, and only the next load found out. A
 * disagreement is a bug in the caller, not a save to write, so it is refused here; the panel's
 * `Save failed: …` line is where the user sees it.
 */
export const serializeSave = (state: GameState, hash: string): string => {
  const payload = payloadOf(state, webCodec());
  if (payload.hash !== hash) {
    throw new Error(
      `the hash does not describe the state being saved: ${hash} is not ${payload.hash}`,
    );
  }
  return JSON.stringify(payload);
};

/**
 * The engine's verdict on a save string: the checked state and its hash, or the typed reason it
 * was refused. The panel reports the reason through `formatSaveError`, so a refusal says what
 * was wrong — a load that answered "not one this build can read" told the user nothing.
 */
export const readSave = (text: string): Result<SaveFile, SaveError> => {
  const loaded = deserialize(text, webCodec());
  if (!loaded.ok) return err(loaded.error);
  const state = loaded.value;
  // The hash is the engine's hash of the checked state, which `deserialize` has already proved
  // is the hash the payload carried — otherwise the payload would have been refused.
  return ok({ schema: SAVE_VERSION, hash: hashValue(state), state });
};

/**
 * `readSave` in the `SaveFile | undefined` shape, for callers that only ask "is this a save".
 *
 * A payload this build cannot read and one that is not a save at all are the same answer here
 * (`undefined`), which is all a boolean question can say; `readSave` is the one to use when the
 * reason matters.
 */
export const parseSave = (text: string): SaveFile | undefined => {
  const read = readSave(text);
  return read.ok ? read.value : undefined;
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
      // The app's own hash, checked against the engine's by `serializeSave`, and written in
      // `@civts/core`'s format — the same bytes `civts save` and the REPL's `save` write.
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

    // The engine decides, and it decides **before** anything is installed: a refused load
    // leaves the game on the state it already had, because no state was ever handed over.
    const read = readSave(text);
    if (!read.ok) {
      setStatus(`Load failed: ${formatSaveError(read.error)}`);
      return;
    }

    ctx.api.replaceState(read.value.state);
    setStatus(`Loaded (hash ${read.value.hash})`);
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
