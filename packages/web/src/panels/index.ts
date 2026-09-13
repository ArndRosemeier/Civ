/**
 * `mountPanels` — the panels' one entry point, and the interface the shell (W1's
 * `main.ts`/`app.ts`) calls.
 * See docs/INTERFACES.md, M8 ("The test seam", "The accessibility contract", "A4 coverage").
 *
 * ## The contract between the shell and the panels
 *
 * The shell owns the game loop, the map and the *state*; the panels own everything else and
 * never mutate the state themselves. Concretely, `mountPanels(root, api)` requires this from
 * the app:
 *
 * ```ts
 * interface PanelsApi {
 *   readonly document: Document;            // the document the panels build elements in
 *   readonly ruleset: RulesetView;          // the validated ruleset for the session
 *   state(): GameState;                     // the AUTHORITATIVE state (browser engine host)
 *   playerId(): PlayerId;                   // the human seat every panel acts as
 *   dispatch(command: Command): DispatchReturn;  // through the real applier, never a bypass
 *   replaceState(state: GameState): void;   // install a state — used only by Load
 *   stateHash(): string;                    // the engine's hash, the same one the goldens use
 *   onSelectionChange?(selection: PanelSelection): void;  // so the map can follow the panel
 * }
 * ```
 *
 * `dispatch` may return the engine's events beside the outcome
 * (`{ outcome: 'ok', events }`) — the log renders them — or the bare `'ok' | 'refused'` of
 * the frozen test seam, in which case the log has nothing to show. Both are accepted, and
 * `refused` must mean "the engine's `applyCommand` returned an error", never a thrown
 * exception: a refusal is a normal answer and the panels treat it as one.
 *
 * **Return the events.** The bare outcome keeps a shell compiling, but the `Events` log can only
 * render what it is handed, and there is no second way to get it: the events are what
 * `applyCommand` returns, and reconstructing them in the UI by diffing states would be the UI
 * deciding what happened. A shell that returns only `'ok' | 'refused'` therefore ships a legally
 * empty event log, which is a missing feature rather than a style choice.
 *
 * **`dispatch` must be synchronous, and so must `stateHash`.** The engine is pure, so applying a
 * command needs no I/O and there is nothing to await; and the M8 seam is instrumented by wrapping
 * `window.__CIVTS__.dispatch` and pushing `{ action, result }` with the value it returns. An
 * `async` dispatch would log a `Promise` where the spec reads `'ok' | 'refused'`, and every
 * keystone sweep would report the engine as refusing commands it actually accepted. Returning a
 * promise is therefore not merely unnecessary here: it breaks the seam's contract.
 *
 * In return `mountPanels` gives the shell a handle:
 *
 * ```ts
 * interface PanelsHandle {
 *   refresh(): void;                       // re-render every panel from the current state
 *   selection(): PanelSelection;           // { unitId?, cityId? } — what the panels show
 *   selectUnit(unitId?: UnitId): void;     // the map's click handler calls this
 *   selectCity(cityId?: CityId): void;     // and this, which also opens the city screen
 *   openCity(cityId: CityId): void;
 *   openTechnology(): void;
 *   openDebug(): void;
 *   readonly elements: PanelsElements;     // the mounted elements, for layout and styling
 * }
 * ```
 *
 * **The shell must call `refresh()` after anything that changes the state outside
 * `dispatch`** (a new game, a seed, a load) — the panels never poll and never subscribe, so
 * one explicit call is the whole update protocol, and a stale panel is a missing call rather
 * than a race.
 *
 * ## What the shell must NOT also render
 *
 * The contractual elements these panels own, and which must therefore not be duplicated by
 * the shell — two elements with one accessible name makes `getByRole(name)` ambiguous:
 * `Turn`, `Year`, `Treasury`, `Science`, `Luxury` (statuses), `Cities` (list),
 * `City <name>` (dialog), `Technology` (dialog), `Events` (log), `Scoreboard` (table),
 * `Units` (region) plus the selected unit's `Actions for unit <id>` group, `Save game`,
 * `Load game`, `Debug` (button) and
 * `State hash` (status). The shell keeps `Map` (application), `End turn` (button) and the
 * turn pipeline's own dispatch.
 *
 * **M9/M10's new names are stated beside their panels rather than in the frozen table**
 * (`docs/INTERFACES.md`' M8 section may not be edited): the government selector adds a `combobox`
 * named `Government`, a `button` named `Set government` and a `status` named `Government verdict`
 * (`government.ts`), and the end of the game adds a `dialog` named `Game over` with a
 * `button` named `Show outcome` and a `button` named `Close outcome` (`victory.ts`). The score column
 * adds a `columnheader` named `Score` to the existing `Scoreboard` table (`scoreboard.ts`), and the
 * city screen adds the `Culture`, `Happiness` and `Disorder` facts to the `City <name>` dialog
 * (`city.ts`). None of them collides with a name in the table above.
 *
 * ## The status strip, and the one number the engine does not have
 *
 * `Turn`, `Treasury`, `Science` and `Luxury` are direct reads of the state — `turn` and the
 * acting player's `treasury`/`beakers`/`luxuries`, which M4b/M5 store so a save file *is* the
 * game. Beakers are spent by research (M5) and **luxuries do nothing at all until M9** —
 * each status says so in its `title`, because a number on screen with no effect is exactly
 * the kind of claim this project refuses to leave implied.
 *
 * `Year` is the exception and it is stated plainly: **the engine has no year**. Civ 3's
 * calendar is not modelled here and no milestone owns it, so the year is a *presentation
 * convention* derived from the turn counter alone (`formatYear` below), feeding nothing back
 * into the simulation. It exists because A4 requires the indicator; it is integer arithmetic,
 * deterministic, and labelled in the UI as a display convention.
 *
 * ## The rates row — the editable half of the same strip
 *
 * `SetRates` is the one queried setter with no enumerable list behind it, and until now it had no
 * control anywhere: the rate space is a search space over a triple, so a panel cannot *offer* its
 * members the way the tech tree offers every tech. A player still has to be able to manage the
 * economy, so the triple is entered and the **engine** judges it (`planSetRates`, the same
 * evaluator `applyCommand` refuses with): no total, no bound and no arithmetic is computed in this
 * package, a refused triple is shown with the engine's own message, and the control stays disabled
 * until the engine accepts what it holds. It is added to the accessibility contract as five NEW
 * names — `Tax rate`, `Science rate`, `Luxury rate` (each a `spinbutton`), `Set rates` (the
 * `button` that dispatches the triple) and `Rates` (a `status` carrying the engine's verdict) —
 * none of which collides with the five statuses the contract fixes, because the roles differ and
 * the names differ from `Treasury`/`Science`/`Luxury` (see `RATE_FIELDS` for the ambiguity that
 * made that a requirement rather than a preference). The three fields keep the frozen strip's own
 * names in their visible labels (`Tax`, `Science`, `Luxury`), so what a player reads beside the
 * inputs is the row above them.
 */

import {
  planSetRates,
  RATE_TOTAL,
  type CityId,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Rates,
  type RulesetView,
  type UnitId,
} from '@civts/core';
import { eventLines } from '../events.js';
import { commandsClosed } from './closed.js';
import { mountCityPanel, type CityPanelHandle } from './city.js';
import { mountDebugPanel, type DebugPanelHandle } from './debug.js';
import { mountEventLog, type EventLogHandle } from './eventlog.js';
import { mountGovernmentControl, type GovernmentControlHandle } from './government.js';
import { mountSavePanel, type SavePanelHandle } from './save.js';
import { mountScoreboard, type ScoreboardHandle } from './scoreboard.js';
import { mountTechPanel, type TechPanelHandle } from './techtree.js';
import { defaultUnitId, mountUnitPanel, type UnitPanelHandle } from './unitpanel.js';
import { mountVictoryPanel, type VictoryPanelHandle } from './victory.js';

/* ------------------------------------------------------------------ *
 * The API the shell implements
 * ------------------------------------------------------------------ */

/** What `dispatch` reports back: the engine accepted the command, or refused it. */
export type DispatchOutcome = 'ok' | 'refused';

/**
 * A dispatch that also carries the engine's events, so the log can render what happened
 * without re-reading the state. The frozen seam's `dispatch` returns the bare outcome; an app
 * that has the events (it just applied the command) should return this instead — see the module
 * note on why the bare outcome leaves the `Events` log empty.
 */
export interface DispatchResult {
  readonly outcome: DispatchOutcome;
  readonly events: readonly GameEvent[];
}

/** Either shape the app may return from `PanelsApi.dispatch`. */
export type DispatchReturn = DispatchResult | DispatchOutcome;

/** What the panels currently show as selected. Absent keys mean "nothing selected". */
export interface PanelSelection {
  readonly unitId?: UnitId;
  readonly cityId?: CityId;
}

/** Everything the panels need from the app — see the module note for the full contract. */
export interface PanelsApi {
  /** The document elements are created in (the shell's document, or a test's). */
  readonly document: Document;
  /** The validated ruleset the session plays under. */
  readonly ruleset: RulesetView;
  /** The authoritative game state. */
  state(): GameState;
  /** The human seat every panel issues commands as. */
  playerId(): PlayerId;
  /** Route a command through the real applier; `refused` on a typed `GameError`. */
  dispatch(command: Command): DispatchReturn;
  /** Install a whole state — the Load button's only way to change the world. */
  replaceState(state: GameState): void;
  /** The engine's state hash of the current state. */
  stateHash(): string;
  /** Optional: told whenever the panels' selection changes, so the map can follow. */
  onSelectionChange?(selection: PanelSelection): void;
}

/** The context a panel module receives: the API plus the shared wiring. */
export interface PanelContext {
  readonly api: PanelsApi;
  /** Re-render every panel from the current state. */
  refresh(): void;
  /** Dispatch through the engine, render the events into the log, and re-render. */
  dispatch(command: Command): DispatchOutcome;
  /** The current selection (unit and city). */
  selection(): PanelSelection;
  selectUnit(unitId: UnitId | undefined): void;
  selectCity(cityId: CityId | undefined): void;
}

/** The mounted elements, for the shell's layout and stylesheet. */
export interface PanelsElements {
  readonly statusbar: HTMLElement;
  /** The `Units` region: the unit list and the selected unit's readouts. */
  readonly units: HTMLElement;
  /** The `Actions for unit <id>` group, a sibling of `units` rather than a child of it. */
  readonly unitActions: HTMLElement;
  readonly cities: HTMLElement;
  readonly cityDialog: HTMLDialogElement;
  readonly technology: HTMLElement;
  readonly techDialog: HTMLDialogElement;
  readonly events: HTMLElement;
  readonly scoreboard: HTMLElement;
  readonly save: HTMLElement;
  readonly debug: HTMLElement;
  readonly debugDialog: HTMLDialogElement;
  /** M9's government selector row, inside the status strip beside the rates it caps. */
  readonly government: HTMLElement;
  /** M10's victory/defeat screen. */
  readonly outcomeDialog: HTMLDialogElement;
}

/** What `mountPanels` returns to the shell. */
export interface PanelsHandle {
  refresh(): void;
  selection(): PanelSelection;
  selectUnit(unitId?: UnitId): void;
  selectCity(cityId?: CityId): void;
  openCity(cityId: CityId): void;
  openTechnology(): void;
  openDebug(): void;
  /**
   * The `Events` log, handed to the shell because the shell is what applies commands: the events
   * arrive at `dispatch`, and a log can only render what it is given (see the module note). The
   * shell also needs `clear()` for the one case the panels cannot see — a **new game**, where the
   * world is replaced wholesale and yesterday's story would otherwise remain on screen.
   */
  readonly log: EventLogHandle;
  readonly elements: PanelsElements;
}

/* ------------------------------------------------------------------ *
 * The status strip (turn, year, treasury, science, luxury)
 * ------------------------------------------------------------------ */

/** One status element: its accessible name (contractual) and its text. */
export interface StatusFact {
  readonly name: 'Turn' | 'Year' | 'Treasury' | 'Science' | 'Luxury';
  readonly text: string;
  readonly title: string;
}

/**
 * The year a turn is *displayed* as. **Presentation only** — see the module note: the engine
 * keeps no calendar, this reads nothing but the turn number, and nothing reads its output
 * back.
 *
 * The convention is a placeholder: turn 1 is 4000 BC and every turn is 20 years, which is the
 * kind of spacing a Civ player expects to see and is explicitly **not** a claim about Civ 3's
 * calendar (which speeds up over the eras and is not modelled here). Integer arithmetic only,
 * so two browsers show the same year.
 */
export const formatYear = (turn: number): string => {
  const turns = Number.isFinite(turn) ? Math.max(1, Math.floor(turn)) : 1;
  const year = -4000 + (turns - 1) * 20;
  if (year < 0) return `${String(-year)} BC`;
  return `${String(year === 0 ? 1 : year)} AD`;
};

/**
 * The five status elements' contents, from the state alone.
 *
 * `Turn <n>` is spelled out because the contract requires the turn indicator's text to
 * *contain* `Turn <n>` — a bare number would satisfy the role but not the reading.
 */
export const statusFacts = (state: GameState, playerId: PlayerId): readonly StatusFact[] => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  const treasury = player?.treasury ?? 0;
  const beakers = player?.beakers ?? 0;
  const luxuries = player?.luxuries ?? 0;

  return [
    {
      name: 'Turn',
      text: `Turn ${String(state.turn)}`,
      title: 'The world turn counter; one turn ends when the turn is ended.',
    },
    {
      name: 'Year',
      text: `Year ${formatYear(state.turn)}`,
      title:
        'A display convention derived from the turn number. The engine keeps no calendar and this number feeds nothing.',
    },
    {
      name: 'Treasury',
      text: `Treasury ${String(treasury)} gold`,
      title: 'Gold: income minus upkeep each turn. It never goes below zero.',
    },
    {
      name: 'Science',
      text: `Science ${String(beakers)} beakers`,
      title: 'Beakers banked so far. Research spends them when a tech completes.',
    },
    {
      name: 'Luxury',
      text: `Luxury ${String(luxuries)} luxuries`,
      title: 'Luxuries accumulate and have no effect until happiness arrives (M9).',
    },
  ];
};

/* ------------------------------------------------------------------ *
 * The rates control — the editable half of the status strip
 * ------------------------------------------------------------------ */

/**
 * One rate the player may set: the engine's own field name, the control's accessible name and the
 * text printed beside it.
 *
 * **These accessible names are new, and they are deliberately not the contractual ones.** The
 * frozen table names the *statuses* `Treasury`, `Science` and `Luxury`, and this control must not
 * put a second element on the page that a `getByRole` query for those names could match: Playwright
 * matches an accessible name by substring, so a second `status` reading `Science rate` would make
 * `getByRole('status', { name: 'Science' })` ambiguous and break every spec that reads the science
 * figure. The controls are therefore `spinbutton`s — a different role entirely — and carry names
 * (`Tax rate`, `Science rate`, `Luxury rate`) that name the *rate*, not the pool the strip already
 * shows. The `Rates` status beside them is new too, and for the same reason: it is the engine's own
 * verdict on the triple, and it is not any of the five figures the contract fixes.
 */
export interface RateField {
  readonly key: 'tax' | 'science' | 'luxury';
  readonly name: string;
  readonly label: string;
}

/** The three rate fields, in the order the engine declares them (`Rates`). */
export const RATE_FIELDS: readonly RateField[] = [
  { key: 'tax', name: 'Tax rate', label: 'Tax' },
  { key: 'science', name: 'Science rate', label: 'Science' },
  { key: 'luxury', name: 'Luxury rate', label: 'Luxury' },
];

/** The triple as `tax/science/luxury` — the same spelling `unitpanel.ts` labels a `SetRates` with. */
export const rateTripleText = (rates: Rates): string =>
  `${String(rates.tax)}/${String(rates.science)}/${String(rates.luxury)}`;

/** What the engine says about a triple: acceptable, or why not, in the engine's own words. */
export interface RatesVerdict {
  readonly acceptable: boolean;
  readonly note: string;
}

/**
 * The engine's own reason for refusing a `SetRates`, verbatim where the engine gave a reason.
 *
 * `planSetRates` refuses for exactly two reasons (`unknown-player`, and a triple `ratesProblem`
 * rejects), and only the second is about the numbers — so the message a player reads when their
 * triple is wrong is the string `economy.ts` produced, which names the offending field or the
 * actual sum. The UI never restates it: there is exactly one statement of the rate rule, and this
 * panel prints it rather than paraphrasing it.
 */
const refusalNote = (error: GameError): string => {
  switch (error.kind) {
    case 'invalid-argument':
      return error.detail;
    case 'unknown-player':
      return `the engine knows no player ${String(error.playerId)}`;
    default:
      return `the engine refused it (${error.kind})`;
  }
};

/**
 * Ask the ENGINE whether this triple is a legal `SetRates`, and report its answer.
 *
 * This is the whole of the control's participation in the rule. `planSetRates` is the evaluator
 * `applyCommand` itself refuses with, so the answer here and the answer to the click are one
 * answer: **no total, no bound and no arithmetic is computed in this file**, and a triple the
 * engine refuses stays refused with the engine's message. A control the verdict rejects is
 * rendered `disabled`, so the panel cannot offer an action the applier would turn down — the
 * keystone property (docs/INTERFACES.md, "The UI must not contain game rules") at this panel.
 *
 * The control exists at all because `SetRates` is the one **queried** setter with no enumerable
 * list behind it: the rate space is a search space over a triple, so a UI cannot offer every member
 * of it the way the tech tree offers every tech. A player still has to be able to manage the
 * economy, so the triple is *entered* and the engine judges it, which is the same shape the city
 * screen's worked-tile checkboxes take (`city.ts`).
 */
export const ratesVerdict = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  rates: Rates,
): RatesVerdict => {
  // M9: the verdict now includes the player's **government's rate caps**, so the refusal a
  // field shows is the engine's own sentence about a cap ("a despotism allows at most 2 of
  // 10 to the luxury slider"), not a second opinion computed here.
  const plan = planSetRates(state, ruleset, playerId, rates);
  if (plan.ok)
    return { acceptable: true, note: `the engine accepts ${rateTripleText(plan.value.rates)}` };
  return { acceptable: false, note: `the engine refuses it: ${refusalNote(plan.error)}` };
};

/**
 * The number a rate field holds, or `NaN` when it holds nothing the engine can read.
 *
 * `NaN` is handed to the engine rather than papered over: `ratesProblem` reads a field totally and
 * says "science must be an integer >= 0 (got NaN)", so an empty or non-numeric field is refused by
 * the rule's own author with the rule's own words. Coercing it to zero here would be this panel
 * inventing a value — and a plausible-looking zero is precisely the kind of silent substitution a
 * player would never notice.
 */
const rateFromInput = (input: HTMLInputElement | undefined): number => {
  if (input === undefined) return Number.NaN;
  const parsed = Number.parseInt(input.value, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export interface RatesControlHandle {
  /** The `[data-panel='rates']` row, inside the status strip. */
  readonly element: HTMLElement;
  /** The control that dispatches `SetRates`; disabled exactly when the engine refuses the draft. */
  readonly button: HTMLButtonElement;
  /** The `status` named `Rates`: the engine's own verdict, verbatim. */
  readonly notice: HTMLElement;
  refresh(): void;
}

/**
 * Mount the rates row into the status strip (its `parent` is the strip's own element).
 *
 * The strip already *shows* Treasury, Science and Luxury — the three pools the rates feed — so this
 * is where a player looks for the economy, and the numbers they read and the numbers they set stay
 * one region. The draft is the player's: a refresh re-seeds it only when the state's **own** rates
 * changed, because the panels re-render on every command and every selection and an edit in flight
 * must not be wiped by a click on something else. `Set rates` dispatches through the same seam
 * every other control uses, so a test's instrumentation sees it and the engine applies it once.
 */
export const mountRatesControl = (parent: HTMLElement, ctx: PanelContext): RatesControlHandle => {
  const doc = parent.ownerDocument;
  const element = el(doc, 'div');
  element.dataset['panel'] = 'rates';
  element.append(el(doc, 'span', 'Rates'));

  const inputs = new Map<RateField['key'], HTMLInputElement>();
  for (const field of RATE_FIELDS) {
    const label = el(doc, 'label');
    const input = doc.createElement('input');
    input.type = 'number';
    // The spinner's own bounds are the engine's constant, so it cannot be nudged past the total the
    // rule is stated in terms of. They are a form hint, not the rule: nothing here sums the three,
    // and a triple typed past them is still the engine's to accept or refuse.
    input.min = '0';
    input.max = String(RATE_TOTAL);
    input.step = '1';
    input.setAttribute('aria-label', field.name);
    input.value = '0';
    inputs.set(field.key, input);
    label.append(field.label, input);
    element.append(label);
  }

  const button = el(doc, 'button', 'Set rates');
  button.type = 'button';
  button.dataset['command'] = 'SetRates';

  const notice = el(doc, 'span');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-label', 'Rates');

  element.append(button, notice);
  parent.append(element);

  let draft: Rates = { tax: 0, science: 0, luxury: 0 };
  /** The state's rates as last seen, so a change that came from the engine re-seeds the draft. */
  let seeded = '';

  const read = (key: RateField['key']): number => rateFromInput(inputs.get(key));

  const update = (): void => {
    const verdict = ratesVerdict(ctx.api.state(), ctx.api.ruleset, ctx.api.playerId(), draft);
    // M10: a finished game refuses *every* command, so the control is closed with the engine's own
    // verdict rather than beside it — the keystone property with one more rule behind it.
    button.disabled = !verdict.acceptable || commandsClosed(ctx.api);
    notice.textContent = verdict.note;
  };

  const onEdit = (): void => {
    draft = { tax: read('tax'), science: read('science'), luxury: read('luxury') };
    update();
  };

  button.addEventListener('click', () => {
    ctx.dispatch({ type: 'SetRates', rates: draft });
  });
  for (const input of inputs.values()) {
    input.addEventListener('input', onEdit);
    input.addEventListener('change', onEdit);
  }

  const refresh = (): void => {
    const player = ctx.api.state().players.find((candidate) => candidate.id === ctx.api.playerId());
    const current = player?.rates;
    const seenNow = current === undefined ? '' : rateTripleText(current);
    if (seenNow !== seeded) {
      seeded = seenNow;
      if (current !== undefined) {
        draft = { tax: current.tax, science: current.science, luxury: current.luxury };
      }
    }
    for (const field of RATE_FIELDS) {
      const input = inputs.get(field.key);
      if (input === undefined) continue;
      // An unreadable draft leaves the field empty rather than writing `NaN` into it: the number
      // input would drop that text anyway, and the engine's verdict already says what is wrong.
      const value = draft[field.key];
      const text = Number.isFinite(value) ? String(value) : '';
      if (input.value !== text) input.value = text;
    }
    update();
  };

  // Deliberately **not** refreshed here — see `unitpanel.ts`' note on mount order.
  return { element, button, notice, refresh };
};

/* ------------------------------------------------------------------ *
 * The mount
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

const normalizeDispatch = (result: DispatchReturn): DispatchResult =>
  typeof result === 'string' ? { outcome: result, events: [] } : result;

const makeSelection = (unitId: UnitId | undefined, cityId: CityId | undefined): PanelSelection => ({
  ...(unitId === undefined ? {} : { unitId }),
  ...(cityId === undefined ? {} : { cityId }),
});

/**
 * Mount every panel into `root` and return the handle the shell drives.
 *
 * `root` should be the container the shell wants the panels in; the panels append their own
 * labelled elements to it (and, for the three dialogs, `<dialog>` elements that stay in the DOM
 * closed until opened). The returned `elements` lets the shell place or style any of them.
 */
export const mountPanels = (root: HTMLElement, api: PanelsApi): PanelsHandle => {
  const doc = api.document;
  let selection: PanelSelection = {};

  const statusbar = el(doc, 'section');
  statusbar.dataset['panel'] = 'status';
  const statusElements = new Map<StatusFact['name'], HTMLElement>();
  for (const name of ['Turn', 'Year', 'Treasury', 'Science', 'Luxury'] as const) {
    const node = el(doc, 'div');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-label', name);
    node.dataset['status'] = name;
    statusElements.set(name, node);
    statusbar.append(node);
  }
  root.append(statusbar);

  // The editable half of the strip: appended into the strip itself, so the economy a player reads
  // (treasury, beakers, luxuries) and the economy a player sets (the rates that feed them) are one
  // region rather than two places to look for the same thing.
  const rates: RatesControlHandle = mountRatesControl(statusbar, context());
  // M9's government selector, beside the rates it caps: a cap is the reason the triple above is
  // refused, so the control that chooses the government and the control that sets the rates read
  // as one region rather than two places a player has to connect for themselves.
  const government: GovernmentControlHandle = mountGovernmentControl(statusbar, context());

  const log: EventLogHandle = mountEventLog(root);
  const units: UnitPanelHandle = mountUnitPanel(root, context());
  const cities: CityPanelHandle = mountCityPanel(root, context());
  const tech: TechPanelHandle = mountTechPanel(root, context());
  const score: ScoreboardHandle = mountScoreboard(root, context());
  const save: SavePanelHandle = mountSavePanel(root, context());
  const debug: DebugPanelHandle = mountDebugPanel(root, context());
  const outcome: VictoryPanelHandle = mountVictoryPanel(root, context());

  /**
   * The context handed to every panel. Declared as a function so the panels can be mounted
   * before it exists (it closes over the handles, and the handles close over it) without a
   * half-built object ever being read: nothing calls `refresh` during construction.
   */
  function context(): PanelContext {
    return {
      api,
      refresh,
      dispatch: (command) => dispatch(command),
      selection: () => selection,
      selectUnit: (unitId) => {
        setSelection(makeSelection(unitId, selection.cityId));
      },
      selectCity: (cityId) => {
        setSelection(makeSelection(selection.unitId, cityId));
        if (cityId !== undefined) cities.open(cityId);
      },
    };
  }

  function setSelection(next: PanelSelection): void {
    selection = next;
    api.onSelectionChange?.(next);
    refresh();
  }

  function dispatch(command: Command): DispatchOutcome {
    const result = normalizeDispatch(api.dispatch(command));
    if (result.outcome === 'ok' && result.events.length > 0) {
      // The line is rendered against the state the command produced — the moment the event
      // happened — so a later refresh cannot restate history (`events.ts` says why).
      log.append(eventLines(result.events, { state: api.state(), ruleset: api.ruleset }));
    }
    refresh();
    return result.outcome;
  }

  function refresh(): void {
    const state = api.state();
    const playerId = api.playerId();

    for (const fact of statusFacts(state, playerId)) {
      const node = statusElements.get(fact.name);
      if (node === undefined) continue;
      node.textContent = fact.text;
      node.title = fact.title;
    }

    // The rates row is refreshed beside the pools it feeds, so the triple on screen is always the
    // state's own (unless the player is mid-edit) and the engine's verdict is always the current
    // triple's. The government row beside it follows the same rule.
    rates.refresh();
    government.refresh();

    // The selection is *resolved* here rather than only displayed, so `selection()` and the
    // unit panel's own default cannot disagree: the panel falls back to this player's first
    // unit, and that is what the handle reports back to the map.
    const resolved = makeSelection(
      defaultUnitId(state, playerId, selection.unitId),
      selection.cityId,
    );
    if (resolved.unitId !== selection.unitId) selection = resolved;

    units.refresh();
    cities.refresh();
    tech.refresh();
    score.refresh();
    save.refresh();
    debug.refresh();
    // Last, so the screen shows the outcome of the state every other panel has just rendered —
    // and so a dialog it opens is never immediately re-rendered by a sibling.
    outcome.refresh();
  }

  refresh();

  return {
    refresh,
    selection: () => selection,
    selectUnit: (unitId) => {
      setSelection(makeSelection(unitId, selection.cityId));
    },
    selectCity: (cityId) => {
      setSelection(makeSelection(selection.unitId, cityId));
      if (cityId !== undefined) cities.open(cityId);
    },
    openCity: (cityId) => {
      setSelection(makeSelection(selection.unitId, cityId));
      cities.open(cityId);
    },
    openTechnology: () => {
      tech.open();
    },
    openDebug: () => {
      debug.open();
    },
    log,
    elements: {
      statusbar,
      units: units.element,
      unitActions: units.actions,
      cities: cities.list,
      cityDialog: cities.dialog,
      technology: tech.element,
      techDialog: tech.dialog,
      events: log.element,
      scoreboard: score.element,
      save: save.element,
      debug: debug.element,
      debugDialog: debug.dialog,
      government: government.element,
      outcomeDialog: outcome.dialog,
    },
  };
};
