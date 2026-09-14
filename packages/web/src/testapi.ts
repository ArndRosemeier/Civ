/**
 * `window.__CIVTS__` — the frozen M8 test seam, and the one place the browser's game lives.
 * See docs/INTERFACES.md, M8 ("The test seam (frozen — the Playwright suite depends on it)").
 *
 * ## The seam is a wrapper, not a second engine
 *
 * Every member is a read of the same `GameState` the app renders, or a call into the same
 * `applyCommand` the app's own controls call. `dispatch` returns `'refused'` — never a throw —
 * when the engine refuses, because "the engine said no" is a normal answer a test has to be able
 * to read; `state()` hands back the **authoritative** state object itself, not a copy, so
 * `stateHash()` and the engine's goldens are computed over the same value.
 *
 * `actionsFor` is `legalActions` / `unitActions` / `cityProductionOptions` — the engine's own
 * lists, with the unit list narrowed to the queried unit when one is named. It deliberately
 * does **not** merge, filter or reorder anything: a UI or a test that wants "what may this unit
 * do?" gets the engine's answer and no other.
 *
 * ## Input validation, not a cast
 *
 * `dispatch` and `seed` take `unknown` from the page, and both **validate** before calling the
 * engine: a non-object, or an object whose `type` is not a member of the frozen command union,
 * is refused here rather than handed to the applier. The reader builds a fresh `Command` from the
 * fields it read, which is why this file needs no `as` — and why a test cannot smuggle a malformed
 * action past the seam and then report the engine as having accepted it.
 *
 * That reader is `commandFrom`, in `@civts/core` — not a switch of this file's own (M11: one
 * statement of every rule; the history is in `toCommand` below).
 *
 * ## `ready`, and the frame counter
 *
 * `ready` is the contract's own statement of "the first frame is drawn", so it is set by the app
 * after its first `draw()`, never by a timer. `draws()` is a plain counter that only ever grows
 * and that nothing in the simulation reads — the renderer is a pure function of the state, so
 * drawing more often cannot change the game.
 */

import {
  asCityId,
  asPlayerId,
  asUnitId,
  cityProductionOptions,
  commandFrom,
  legalActions,
  unitActions,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { hashValue } from '@civts/testing';

/**
 * What the app's own dispatch reports: the outcome, and the events the engine returned.
 *
 * The frozen seam's `dispatch` publishes the **outcome alone** (`'ok' | 'refused'`), which is what
 * the e2e suite compares against and what must cross the browser boundary as a plain string. The
 * events travel beside it through the host's own `dispatch`/`onEvents` pair instead — one engine
 * call, two readings of it — because a richer return value would either be unserialisable across
 * `page.evaluate` or would have to lie about its type.
 */
export interface DispatchResult {
  readonly outcome: 'ok' | 'refused';
  readonly events: readonly GameEvent[];
}

/** Everything the seam needs from the running app — provided by `main.ts`, never re-derived. */
export interface SeamHost {
  /** The authoritative state. The app owns the reference; the seam only reads it. */
  state(): GameState;
  /** The human seat, as the engine's own id — or `undefined` before a game exists. */
  playerId(): PlayerId | undefined;
  readonly ruleset: RulesetView;
  /**
   * Route a validated command through the real applier and re-render, reporting the engine's own
   * events for the command. This is the app's *engine call*; the seam's `dispatch` is the frozen
   * wrapper over it, and `tookEvents` is how the same single call also reaches the log.
   */
  dispatch(command: Command, forSeat?: PlayerId): DispatchResult;
  /**
   * The events of the command that was applied most recently, and an empty list before the first
   * one. Read (not pushed) by the panel adapter after each dispatch, so there is exactly one
   * statement of "these are the events of that call".
   */
  lastEvents(): readonly GameEvent[];
  /** Start a new game at `seed`, merging `options` over the app's current settings. */
  seed(seed: number, options?: unknown): void;
  /** The settings the current game was started with — exactly `state.settings`. */
  settings(): unknown;
  /** Install a whole state, as `Load` does. */
  replaceState(state: GameState): void;
  /** The draw trace of the last frame, in the shape the e2e suite reads. */
  drawTrace(): unknown;
  /** The camera the renderer is using. */
  camera(): unknown;
  /** The app's own terrain palette: `#rrggbb` per terrain id. */
  terrainColours(): Readonly<Record<string, string>>;
  /** Whether the first frame has been drawn. */
  ready(): boolean;
  /** The render counter. */
  draws(): number;
}

/** The members `docs/INTERFACES.md` freezes, plus the three the rendering section requires. */
interface CivtsTestApiMembers {
  readonly ready: boolean;
  state(): unknown;
  stateHash(): string;
  /**
   * Spelled as a **function-typed property** rather than a method, and deliberately: this is the
   * one member whose identity matters. The app's controls read it at click time, a test replaces
   * it with `Object.defineProperty`, and `seamDispatch` compares the replacement against the
   * original by identity. A method signature would make every one of those a detached
   * method reference (and lint says so); a property of function type is the same value, honestly
   * typed, and can be passed, compared and wrapped.
   */
  readonly dispatch: (action: unknown) => 'ok' | 'refused';
  actionsFor(unitId?: number, cityId?: number): unknown[];
  settings(): unknown;
  seed(seed: number, options?: unknown): void;
  draws(): number;
}

/**
 * The frozen interface, spelled exactly as `docs/INTERFACES.md` freezes it, with the three
 * presentation extras the rendering section requires.
 *
 * The three extras are **optional**, and deliberately: they are the app's own documented probes
 * rather than part of the frozen list, so a build that had not grown them yet would fail one
 * named assertion ("the app exposes no draw trace") instead of failing to compile — which is what
 * lets the contract's own list stay the contract. This build implements all three.
 *
 * `ready` is declared as a readonly property because that is what the contract writes; the
 * installed object implements it with a getter, so the value is read from the app at the moment a
 * test asks rather than snapshotted at install time (a snapshot would report `false` forever).
 */
export interface CivtsTestApi extends CivtsTestApiMembers {
  /** The deterministic draw trace of the last frame (M8 §Rendering). */
  drawTrace?(): unknown;
  /** The camera the renderer is using (M8 §Rendering, hit-testing). */
  camera?(): unknown;
  /** The app's own terrain palette, `#rrggbb` per terrain id (M8 §Rendering). */
  terrainColours?(): unknown;
}

/** What this app actually installs: every probe present, and the app can rely on that. */
export interface InstalledTestApi extends CivtsTestApiMembers {
  drawTrace(): unknown;
  camera(): unknown;
  terrainColours(): unknown;
}

/**
 * The global the seam is installed on.
 *
 * This is the **one** declaration of `window.__CIVTS__`. The e2e suite reads the interface from
 * here (`e2e/helpers.ts` re-exports the type rather than declaring a second, structurally similar
 * copy): TypeScript refuses two augmentations of one global property that are not textually
 * identical, and two hand-written copies of a frozen interface are exactly the pair that drifts.
 */
declare global {
  interface Window {
    __CIVTS__?: CivtsTestApi;
  }
}

/**
 * Read an action into a `Command`, or `undefined` when it is not a member of the frozen union.
 *
 * **This function is a delegation, and that is the point.** It used to be a ninety-line switch of
 * its own — a second reader of "what is a `Command`", which had to agree with the engine's about
 * every field of every member and which nobody could keep honest. It did not: M9's `SetGovernment`
 * was accepted by `applyCommand`, built correctly by its panel, enabled on `planSetGovernment`'s
 * own verdict — and refused *here*, because this switch had no case for it. The click dispatched
 * nothing, and the e2e assertion that caught it was the one comparing the recorded dispatch
 * against the engine.
 *
 * M11's rule is one statement of every rule, so the union now has **one** reader: `commandFrom` in
 * `@civts/core`, which the replay log uses to re-read a recorded command and which this seam uses
 * to read an action. A command added to the engine is readable here the moment it exists — there
 * is no list left in this file to fall behind.
 *
 * The narrowing to `undefined` is this seam's own: the frozen `dispatch(action: unknown)` reports
 * `'ok' | 'refused'`, and "this is not a command at all" is the refused half. The reason
 * `commandFrom` gives is discarded here rather than thrown away everywhere: `replay` is the
 * caller that needs it (it must say *which* recorded command a log could not read).
 */
/**
 * Split a dispatched action into the seat acting and the command itself.
 *
 * The opponent dispatches through this same seam, so that its commands appear in the dispatch log
 * and "the rival really acted" is checkable rather than inferred from a counter that moved. The
 * acting seat therefore rides on the action as an extra key, removed here before the command
 * parser sees it.
 *
 * The human's controls carry no seat and are applied for the human seat, which is what stops a UI
 * action from ever ordering a rival's unit. The seat is a test-and-opponent channel, not something
 * the interface can express.
 */
export const splitSeat = (
  action: unknown,
): { readonly seat: PlayerId | undefined; readonly rest: unknown } => {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return { seat: undefined, rest: action };
  }
  const { seat, ...rest } = action as Record<string, unknown>;
  return { seat: typeof seat === 'number' ? asPlayerId(seat) : undefined, rest };
};

export const toCommand = (raw: unknown): Command | undefined => {
  const read = commandFrom(raw);
  return read.ok ? read.value : undefined;
};

/**
 * The installed seam, with the one derivation of a validated dispatch written inside it.
 *
 * The type is `InstalledTestApi` (every probe present) rather than the frozen `CivtsTestApi`,
 * because this app implements all three of the rendering section's extras; the frozen interface
 * is what the object is *published* as on `window`, which is why `installTestApi` widens on
 * assignment rather than pretending the extras are absent.
 */
const seamOf = (host: SeamHost): InstalledTestApi => {
  /** One engine call per dispatched command, whichever caller asked for it. */
  const applyOnce = (action: unknown): DispatchResult => {
    const { seat, rest } = splitSeat(action);
    const command = toCommand(rest);
    if (command === undefined) return { outcome: 'refused', events: [] };
    const result = host.dispatch(command, seat);
    // The host records the events of this call for the log; the seam still publishes only the
    // outcome, so a wrapper installed by a test keeps working unchanged.
    return result;
  };

  return {
    get ready(): boolean {
      return host.ready();
    },
    state: () => host.state(),
    // The engine's own hash, over the authoritative state — the same function the goldens use.
    stateHash: () => hashValue(host.state()),
    dispatch: (action) => applyOnce(action).outcome,
    actionsFor: (unitId, cityId) => actionsForHost(host, unitId, cityId),
    settings: () => host.settings(),
    seed: (seed, options) => {
      host.seed(seed, options);
    },
    draws: () => host.draws(),
    drawTrace: () => host.drawTrace(),
    camera: () => host.camera(),
    terrainColours: () => host.terrainColours(),
  };
};

/**
 * Build the frozen seam over `host` and install it on `window`.
 *
 * ## One dispatch, two callers — and why that is the keystone's foundation
 *
 * The app has two callers of "apply this command": the panels, which need the engine's own events
 * back so the log can render what happened, and a test driving the seam, which needs the bare
 * `'ok' | 'refused'` the contract freezes. **They must share one function object.** The keystone
 * sweep proves the offered-controls direction by WRAPPING `window.__CIVTS__.dispatch` and reading
 * back every command a click produced; if the panel buttons called an internal function of their
 * own, that instrumentation would observe nothing and the sweep would report every control as
 * "dispatched nothing at all" — the one property this package exists to hold would be untestable
 * at the UI layer. (It was found exactly that way: buttons applied successfully while the seam's
 * wrapper saw no calls at all.)
 *
 * So `dispatch` is defined **once**, inside the seam, and the panels are handed `panelDispatch` —
 * a narrow adapter that closes over this same object and calls it. A wrapper installed by a test
 * therefore reaches both callers, and a command is applied exactly once either way. The seam is a
 * plain, mutable object on purpose: the wrapper needs `Object.defineProperty` to succeed, and a
 * frozen one would take that direction of the keystone property out of reach.
 */
export const installTestApi = (host: SeamHost): InstalledTestApi => {
  const api = seamOf(host);
  window.__CIVTS__ = api;
  return api;
};

/** The dispatch the app installed, and a way to tell whether a test has replaced it. */
export interface SeamDispatch {
  /** The function object `installTestApi` put on `window`, retained for identity comparison. */
  readonly installed: (action: unknown) => 'ok' | 'refused';
  /**
   * Run a command through the seam **as it currently stands**: a test's wrapper if one is
   * installed, the app's own dispatch otherwise. Every control in the app dispatches through
   * this, so a wrapper (`recordDispatches`, `clearDispatchLog`, the keystone sweep) observes the
   * map's clicks and the buttons exactly as it observes a command a test dispatched itself.
   *
   * If the seam's `dispatch` is still the installed one, the app's own runner is called directly:
   * that avoids handing a command back through the seam's validation for no gain. If it has been
   * replaced, the replacement is called instead — and it will call the app's runner, which is
   * where the command is actually applied. Exactly one application either way, and no path that
   * applies a command without passing the installed seam.
   */
  arm(apply: (action: unknown) => 'ok' | 'refused'): (action: unknown) => 'ok' | 'refused';
}

/** Wire the app's controls to the seam's current dispatch — see `SeamDispatch`. */
export const seamDispatch = (installed: (action: unknown) => 'ok' | 'refused'): SeamDispatch => ({
  installed,
  arm: (apply) => (action) => {
    const current = window.__CIVTS__?.dispatch;
    if (current === undefined || current === installed) return apply(action);
    return current(action);
  },
});

/**
 * The engine's own list for the thing named: a unit's actions when `unitId` is given, a city's
 * production options when `cityId` is, and this player's whole `legalActions` list when neither
 * is. Both ids may be given at once — the answer is the two lists side by side, which is what a
 * caller asking about "this city and this unit" means.
 *
 * A unit or city id the state does not hold yields `[]` from the engine's own query, which is
 * the honest answer rather than an error: asking about something that is not there is a question
 * a UI asks every frame.
 */
const actionsForHost = (host: SeamHost, unitId?: number, cityId?: number): unknown[] => {
  const state = host.state();
  const ruleset = host.ruleset;
  const actions: unknown[] = [];

  if (unitId !== undefined) {
    actions.push(...unitActions(state, ruleset, asUnitId(unitId)));
  }
  if (cityId !== undefined) {
    // `cityProductionOptions` answers with the engine's production **items** (a search space over
    // the catalog), not with commands: a production choice is not part of `legalActions` — M3/M4b
    // record that deliberately, because `SetProduction` emits no event. The frozen seam's
    // `actionsFor` publishes **the engine's list of actions**, and the suite that consumes it does
    // both things a caller does with such a list: it compares the list against what the controls
    // dispatched, and it takes an entry and dispatches it. Both require commands. So each item is
    // published as the one command that carries it, in the same shape the city screen's own
    // control uses — no cost is summed and no legality is decided here; the engine's verdict is
    // the membership of this list, and `applyCommand` re-states it when the command arrives.
    const city = asCityId(cityId);
    for (const item of cityProductionOptions(state, ruleset, city)) {
      actions.push({ type: 'SetProduction', cityId: city, item });
    }
  }
  if (unitId === undefined && cityId === undefined) {
    const playerId = host.playerId();
    if (playerId !== undefined) actions.push(...legalActions(state, ruleset, playerId));
  }
  return actions;
};

/** The engine's own hash of a state, exported so the app and a test compute it identically. */
export const hashOfState = (state: GameState): string => hashValue(state);

/** The player a state's first civilization belongs to — the seat a human plays. */
export const humanSeatOf = (state: GameState): PlayerId | undefined => {
  const civ = state.players.find((player) => player.kind === 'civ');
  return civ === undefined ? undefined : asPlayerId(civ.id);
};
