/**
 * `keys.ts` — **THE KEYBOARD CONTRACT**: every key this app takes, what it does, and where.
 *
 * `docs/UI-OVERHAUL.md` §7.6 phase 5 is the phase that adds a keyboard contract where none existed:
 * the inventory found "no `keydown`, no `tabindex`, no `.focus()`, no focus trap, no a11y lint
 * anywhere in the package" (§4.6e) and called the pointer-only map "the sharpest gap". So this file
 * *is* the contract, and it is written as **data rather than as a `switch`** for one reason: the
 * same table drives the handler and the help the player reads (`KEY_HELP` below). A binding
 * documented in prose beside a handler written in code is two statements that can disagree, and
 * "the shortcut the help lists does nothing" is the failure a keyboard user meets first.
 *
 * ## The bindings
 *
 * | where | key | meaning |
 * |---|---|---|
 * | anywhere | `Space` | select the next unit the engine still offers an order (`ui/nextunit.ts`) |
 * | anywhere | `Enter` | end the turn — the engine's own `EndTurn`, the same command the button dispatches |
 * | anywhere | `Escape` | cancel the unit's goto, and say so in the order channel |
 * | the map | arrow keys | pan the view by one tile |
 * | the map | `+` / `=` | zoom in one step |
 * | the map | `-` / `_` | zoom out one step |
 *
 * Nine rows, two of them alternatives for one action, and the list is deliberately short.
 * Everything here is either **navigation** (selecting, panning, zooming) or the one ambient act the
 * game cannot be played without (ending the turn) plus the one cancellation Phase 4 left owed (§9:
 * "there is no 'stop' control and no Escape binding — Phase 5 owns the keyboard"). **No order is
 * bound to a key**: a keyboard that could issue a `MoveUnit` would be a third path to a command
 * that already has two surfaces (the map and the unit's own popup), and this phase's brief is
 * navigation.
 *
 * ## Why these keys, and what they take from the browser
 *
 * - **`Space` and `Enter` are the genre's next-unit and end-turn keys**, and neither is free: they
 *   are exactly what a browser uses to *activate a focused control*, and `Space` also scrolls the
 *   page. Both are handled by the deferral rule below, which is why it is a rule and not a
 *   footnote.
 * - **Arrows and `+`/`-` are bound to the map region, not to the document.** A document-wide arrow
 *   binding would take scrolling away from every scrollable box in the app (the sidebar's panel
 *   stack, a dialog's body) and, worse, would pan the map while the player is reading a panel. The
 *   region is `role=application` (`buildShell`) and is put in the tab order, so a keyboard user
 *   reaches the map with `Tab` and the keys mean the map from then on — the ARIA reading of
 *   `application`, and the reason this half needs no dialog guard: a keydown reaches the region's
 *   listener only when the focus is already inside the map.
 * - **`Tab` is not touched.** There is no focus trap, no `tabindex` rewrite and no `preventDefault`
 *   on `Tab`, so the browser's own order is the contract: the header's controls, then the map, then
 *   the sidebar — each in DOM order. A trap would be a second order to get wrong, and this page is
 *   form-shaped, not a modal dialog.
 *
 * ## The deferral rule, which is what keeps the keys from fighting the browser
 *
 * A session key is **not ours** when any of these holds, and the decision is a pure function
 * (`sessionActionFor`) rather than an `if` chain inside a listener, so it can be tested without a
 * browser:
 *
 * 1. **a modifier is held** — `ctrl`, `meta` or `alt`. Those are the browser's and the operating
 *    system's keys (`Ctrl+R`, `Cmd+←`, `Alt+Tab`), and stealing one is how a web app becomes
 *    hostile. `shift` is deliberately ignored instead: `+` *is* `Shift+=` on most layouts, so
 *    requiring no shift would make zooming in unreachable on those keyboards.
 * 2. **a text field has focus** — `input`, `textarea`, `select` or a `contenteditable` host. Space
 *    in a field is a space, and Enter in a form is the form's. The rates row in the status strip is
 *    the live case: three number fields a player types into.
 * 3. **a dialog is open.** The panels are non-modal side screens and a control inside one is
 *    activated by `Enter` and `Space`; a session handler that ran as well would act twice on one
 *    press (end the turn *and* press the button). While a panel is up, the keyboard belongs to the
 *    panel — which is also what a player expects from a screen they just opened.
 *
 * ## The pointed-at gestures are untouched
 *
 * The map's existing gestures — wheel zoom, drag pan, click — are pointer events on the region and
 * the canvas, and nothing here reads, moves or rebinds them (`main.ts` states that split and why).
 * The only interaction between the two halves is spatial and it is the point of the keyboard half:
 * a keyboard pan or zoom **replaces the camera** through the same `panCamera`/`zoomCamera` the
 * pointer path calls, so the two cannot disagree about what "one tile left" means.
 */

/** What a `keydown` looks like to this module — the fields it reads, and no DOM type. */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** Everything the deferral rule needs: the event, plus the two facts about the page it lands in. */
export interface KeyContext extends KeyEventLike {
  /** Whether the event's target is a text field. The caller reads the DOM; this module does not. */
  readonly inTextField: boolean;
  /** Whether any dialog is open. The caller reads the DOM; this module does not. */
  readonly dialogOpen: boolean;
}

/** A binding for the app as a whole — the document's keys. */
export type SessionAction = 'next-unit' | 'end-turn' | 'cancel-goto';

/** A binding for the map region — the view's keys. */
export type MapAction = 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'zoom-in' | 'zoom-out';

/** Every action a key can name. */
export type KeyAction = SessionAction | MapAction;

/**
 * One row of the contract.
 *
 * `keys` holds **`KeyboardEvent.key` values**, which is the spelling that survives a layout: the
 * physical-key spelling (`code`) would make `+` mean different things on different keyboards, and
 * `' '` for space is what Chromium, Firefox and WebKit all report. The two legacy spellings
 * (`Spacebar`, `Esc`) are accepted beside the modern ones because they cost one array entry each
 * and a key that works in one engine and not another is a key nobody can document honestly.
 */
export interface KeyBinding {
  readonly action: KeyAction;
  /** Where the binding lives. See the module note: this is what makes the split structural. */
  readonly where: 'document' | 'map';
  readonly keys: readonly string[];
  /** How the key is printed in the help — the spelling a player reads, not the event's. */
  readonly printed: string;
  /** What it does, in one sentence, as the help shows it. */
  readonly meaning: string;
}

/** A binding that applies wherever the focus is. */
export interface SessionBinding extends KeyBinding {
  readonly where: 'document';
  readonly action: SessionAction;
}

/** A binding that applies when the map has the focus. */
export interface MapBinding extends KeyBinding {
  readonly where: 'map';
  readonly action: MapAction;
}

const DOCUMENT_BINDINGS: readonly SessionBinding[] = [
  {
    action: 'next-unit',
    where: 'document',
    keys: [' ', 'Spacebar', 'Space'],
    printed: 'Space',
    meaning: 'select the next unit the engine still offers an order, wrapping round at the end',
  },
  {
    action: 'end-turn',
    where: 'document',
    keys: ['Enter'],
    printed: 'Enter',
    meaning: 'end the turn — the same order the End turn button gives the engine',
  },
  {
    action: 'cancel-goto',
    where: 'document',
    keys: ['Escape', 'Esc'],
    printed: 'Escape',
    meaning: 'cancel the selected unit’s goto, and say so in the order channel',
  },
];

const MAP_BINDINGS: readonly MapBinding[] = [
  {
    action: 'pan-left',
    where: 'map',
    keys: ['ArrowLeft'],
    printed: '←',
    meaning: 'pan the map one tile left',
  },
  {
    action: 'pan-right',
    where: 'map',
    keys: ['ArrowRight'],
    printed: '→',
    meaning: 'pan the map one tile right',
  },
  {
    action: 'pan-up',
    where: 'map',
    keys: ['ArrowUp'],
    printed: '↑',
    meaning: 'pan the map one tile up',
  },
  {
    action: 'pan-down',
    where: 'map',
    keys: ['ArrowDown'],
    printed: '↓',
    meaning: 'pan the map one tile down',
  },
  {
    action: 'zoom-in',
    where: 'map',
    keys: ['+', '='],
    printed: '+',
    meaning: 'zoom the map in one step, anchored on the middle of the view',
  },
  {
    action: 'zoom-out',
    where: 'map',
    keys: ['-', '_'],
    printed: '−',
    meaning: 'zoom the map out one step, anchored on the middle of the view',
  },
];

/** **THE TABLE**, both halves: the one list the handler and the help are both derived from. */
export const KEY_BINDINGS: readonly KeyBinding[] = [...DOCUMENT_BINDINGS, ...MAP_BINDINGS];

/** The keys that work wherever the focus is. */
export const sessionBindings = (): readonly SessionBinding[] => DOCUMENT_BINDINGS;

/** The keys that work when the map has the focus. */
export const mapBindings = (): readonly MapBinding[] => MAP_BINDINGS;

/** Whether a modifier the browser owns is held. See the deferral rule's first clause. */
const browserModifier = (event: KeyEventLike): boolean =>
  event.ctrlKey || event.metaKey || event.altKey;

/**
 * The action a `keydown` means **for the app as a whole**, or `undefined` to leave it alone.
 *
 * `undefined` is the answer for every key outside the table and for every press the deferral rule
 * claims. A caller must therefore do nothing at all on `undefined` — not even prevent the default —
 * or it would take `Space` away from a button, which is the one thing this contract exists to
 * avoid.
 */
export const sessionActionFor = (ctx: KeyContext): SessionAction | undefined => {
  if (browserModifier(ctx)) return undefined;
  if (ctx.inTextField) return undefined;
  if (ctx.dialogOpen) return undefined;
  return DOCUMENT_BINDINGS.find((binding) => binding.keys.includes(ctx.key))?.action;
};

/**
 * The action a `keydown` means **for the map**, or `undefined`.
 *
 * The same deferral rule minus the dialog clause, and the reason is in the module note: the map's
 * keys are view-only, they are bound to the region rather than to the document so they arrive only
 * when the focus is already in the map, and a non-modal panel does not suspend the map the player
 * is still playing on. `inTextField` is kept as a guard for a region that grows a field one day;
 * today the region holds a canvas and its overlays, and a keydown from one of them is the map's.
 */
export const mapActionFor = (ctx: KeyContext): MapAction | undefined => {
  if (browserModifier(ctx)) return undefined;
  if (ctx.inTextField) return undefined;
  return MAP_BINDINGS.find((binding) => binding.keys.includes(ctx.key))?.action;
};

/** One row of the help: the key as printed, and what it does. */
export interface KeyHelpRow {
  readonly keys: string;
  readonly meaning: string;
}

/** One group of the help: where its keys apply, and why that is worth saying. */
export interface KeyHelpSection {
  readonly where: string;
  readonly note: string;
  readonly rows: readonly KeyHelpRow[];
}

/**
 * The help, derived from the table — **the only description of the bindings in the app**, and the
 * text of the `Keyboard` panel the header's control opens.
 *
 * The split is not decoration: an arrow key does nothing until the map has focus, and a player who
 * is not told that concludes the arrows are broken. So the two groups are told apart by which
 * section a key appears in, and each section carries the sentence that makes it usable.
 */
export const KEY_HELP: readonly KeyHelpSection[] = [
  {
    where: 'Anywhere',
    note:
      'These work wherever the focus is, except inside a text field or an open panel, which keep ' +
      'their own keyboard.',
    rows: DOCUMENT_BINDINGS.map((binding) => ({
      keys: binding.printed,
      meaning: binding.meaning,
    })),
  },
  {
    where: 'On the map',
    note: 'These work once the map has the focus: click it, or press Tab until it is outlined.',
    rows: MAP_BINDINGS.map((binding) => ({
      keys: binding.printed,
      meaning: binding.meaning,
    })),
  },
];
