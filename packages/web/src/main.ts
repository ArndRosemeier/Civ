/**
 * The app's entry point: the shell that owns the game loop, the map and the state.
 * See docs/INTERFACES.md, M8 ("Where it lives, and where the game runs", "The test seam",
 * "The accessibility contract", "Rendering, and how it is tested").
 *
 * ## The browser IS the engine host
 *
 * `@civts/core` and `@civts/rules` are pure TypeScript, so this page loads them and runs the
 * game itself. There is no server-side state and no second copy of the rules: the `GameState`
 * this shell holds is the authoritative one, `applyCommand` is the engine in this tab, and
 * nothing here computes legality, a cost, a yield or an outcome. **Every** action a player can
 * take goes through `applyCommand`, and every control that offers an action is built from an
 * engine answer:
 *
 * - the unit panel and its `Actions for unit <id>` group (W2) render `unitActions` verbatim;
 * - the city screen (W2) renders `cityProductionOptions` and asks `planSetWorkedTiles` about the
 *   assignment each checkbox would write;
 * - this file's own `Abilities for unit <id>` group is `planFortifyUnit` and one `AttackUnit` per
 *   adjacent tile `planAttackUnit` accepts — the engine's *queried* commands, which no generator
 *   advertises (fortify emits no event) and which A4 nevertheless names as a unit order;
 * - a click on the map is resolved by looking the clicked tile up in the unit's own action list
 *   (`unitActions`), so the click can only ever issue a command the engine already offered. A
 *   click the engine would refuse (an empty tile further than the unit can walk) is dispatched
 *   anyway and comes back `'refused'`, because "the engine said no" is an answer a player and a
 *   test are both entitled to see — and a refusal leaves the state exactly as it was.
 *
 * ## What the shell owns, and what it must not own
 *
 * The shell owns `Map` (the `application` role), `End turn` (the button) and the turn pipeline's
 * dispatch. It must **not** render a second copy of any element the panels own: two elements with
 * one accessible name make a role-and-name locator ambiguous, which is a worse failure than a
 * missing one. The panels' own header lists them; this file adds only what A4 requires of the
 * shell (`Map`, `End turn`) plus the abilities group the unit panel deliberately leaves out.
 *
 * ## Determinism
 *
 * No clock, no randomness, no transcendentals anywhere in this file. The frame counter is a
 * counter — it is not derived from `Date.now()` or `performance.now()`, and nothing in the
 * simulation reads it. The renderer is a pure function of `(state, camera, viewport, markers)`,
 * so drawing more often cannot change the game and two runs of the same seed draw the same
 * pixels. The camera is presentation state: it is never hashed and never reaches `GameState`.
 */

import {
  DEFAULT_SETTINGS,
  applyCommand,
  asTileIndex,
  asUnitId,
  indexToX,
  indexToY,
  neighbors8,
  newGame,
  parseSettings,
  planAttackUnit,
  planFortifyUnit,
  unitActions,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RulesetView,
  type Settings,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

import {
  centreOnTile,
  defaultCamera,
  panCamera,
  screenToTile,
  tileScreenPx,
  zoomCamera,
  type Camera,
  type ScreenPoint,
  type ViewportSize,
} from './view.js';
import {
  TERRAIN_COLOURS,
  drawFrame,
  type Canvas2D,
  type CityMarker,
  type FrameTrace,
  type UnitMarker,
} from './render.js';
import { eventLines } from './events.js';
import { mountPanels, type PanelsApi, type PanelsHandle } from './panels/index.js';
import { humanSeatOf, installTestApi, seamDispatch, toCommand } from './testapi.js';

/** The seed a page load starts on, when nothing has seeded it. */
const DEFAULT_SEED = 1;

/**
 * The canvas's CSS size. Fixed rather than fluid on purpose: the viewport the camera is clamped
 * against, the rectangle the renderer walks, and the box the hit-test inverts must be one number,
 * and a layout that resized the canvas mid-test would make "which tile did I click?" depend on
 * when the question was asked. Large enough to show a good part of a `tiny` map at the default
 * zoom, and comfortably inside the e2e suite's own 1280×900 viewport.
 */
const CANVAS_WIDTH_PX = 720;
const CANVAS_HEIGHT_PX = 540;

/** One wheel notch of zoom, in zoom levels. */
const WHEEL_STEP = 1;

/**
 * How far the pointer may travel between press and release and still count as a click.
 *
 * A browser fires `click` on the common ancestor of the press and the release, so a drag across
 * the map ends in a click on the canvas. Anything past this many pixels was a pan, not an order:
 * the number is a gesture threshold in the presentation layer and is never consulted by a rule.
 */
const DRAG_CLICK_TOLERANCE_PX = 4;

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The validated ruleset the whole session plays on — the same `tuned` catalog the goldens use. */
const validatedRuleset = (): RulesetView => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    // A ruleset that does not validate cannot host a game. There is no honest way to keep going,
    // and failing loudly here is the difference between "the catalog is broken" and a blank
    // canvas somebody has to debug.
    throw new Error(
      `the shipped catalog does not validate: ${validated.error
        .map((issue) => issue.kind)
        .join(', ')}`,
    );
  }
  return validated.value;
};

/* ------------------------------------------------------------------ *
 * What the map draws: markers, from engine reads only
 * ------------------------------------------------------------------ */

const colourOfPlayer = (state: GameState, owner: number): string =>
  state.players.find((player) => player.id === owner)?.color ?? '#d0d0d0';

/**
 * One marker per unit, with the acting player's own units drawn in their owner's colour and
 * everyone else's in a single warning colour, so "mine" and "not mine" are distinguishable at a
 * glance without the viewer having to know the palette. Which units are marked is the state's
 * list, verbatim: this file does not decide what is visible.
 */
const unitMarkers = (state: GameState, selected: UnitId | undefined): readonly UnitMarker[] =>
  state.units.map((unit) => ({
    id: unit.id,
    tile: unit.tile,
    colour: colourOfPlayer(state, unit.owner),
    selected: unit.id === selected,
  }));

const cityMarkers = (state: GameState): readonly CityMarker[] =>
  state.cities.map((city) => ({ tile: city.tile, colour: colourOfPlayer(state, city.owner) }));

/* ------------------------------------------------------------------ *
 * The queried commands: fortify, and the attacks the engine accepts
 * ------------------------------------------------------------------ */

/**
 * A unit's **queried** commands: the ones no generator advertises but `applyCommand` accepts.
 *
 * `planFortifyUnit` decides fortify — it emits no event, which is why `unitActions` yields it to
 * nobody (`actions.ts`), and A4 names fortify among the unit orders the UI must offer. The
 * attacks are here for a different reason: `unitActions` *does* enumerate them, so they are not
 * queried at all, and this group repeats them by name over the same adjacency ring and through
 * the same `planAttackUnit`, because attacking is an order a player issues against a tile on the
 * map and the group is where the map's orders are listed. Either way the control exists only
 * where the engine's own evaluator accepted it, so the keystone property holds by construction.
 */
const abilityCommands = (
  state: GameState,
  ruleset: RulesetView,
  seat: PlayerId | undefined,
  unitId: UnitId,
): readonly Command[] => {
  if (seat === undefined) return [];
  const unit = state.units.find((candidate) => candidate.id === unitId);
  if (unit === undefined) return [];

  const commands: Command[] = [];
  if (planFortifyUnit(state, seat, unitId).ok) commands.push({ type: 'FortifyUnit', unitId });
  for (const target of neighbors8(state.map, unit.tile)) {
    if (planAttackUnit(state, ruleset, seat, unitId, target).ok) {
      commands.push({ type: 'AttackUnit', unitId, target });
    }
  }
  return commands;
};

/**
 * What an ability control says. Named after the same vocabulary the unit panel uses, so a player
 * reads one set of words for one set of orders, and a coordinate-bearing label (`Move to 3,4`,
 * `Attack 3,4`) is discoverable by name rather than by position.
 */
const abilityLabel = (state: GameState, command: Command): string => {
  const at = (tile: number): string =>
    `${String(indexToX(state.map, tile))},${String(indexToY(state.map, tile))}`;
  switch (command.type) {
    case 'FortifyUnit':
      return 'Fortify';
    case 'AttackUnit':
      return `Attack ${at(command.target)}`;
    case 'MoveUnit':
      return `Move to ${at(command.to)}`;
    case 'FoundCity':
      return 'Found city';
    case 'CancelWork':
      return 'Cancel work';
    case 'StartWork':
      return `Start work: ${command.kind}`;
    default:
      return command.type;
  }
};

/** The tile a map order names, or `undefined` for a command that is not a map order. */
const commandTile = (command: Command): number | undefined => {
  if (command.type === 'MoveUnit') return command.to;
  if (command.type === 'AttackUnit') return command.target;
  return undefined;
};

/* ------------------------------------------------------------------ *
 * The app
 * ------------------------------------------------------------------ */

interface Shell {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly endTurn: HTMLButtonElement;
  readonly panelsRoot: HTMLElement;
  /** Where an opened panel is docked — see `buildShell`. */
  readonly dock: HTMLElement;
}

const buildShell = (doc: Document): Shell => {
  const root = el(doc, 'div');
  root.id = 'civts-app';

  const header = el(doc, 'header');
  const title = el(doc, 'h1', 'CivTS');
  const endTurn = el(doc, 'button', 'End turn');
  endTurn.type = 'button';
  endTurn.dataset['command'] = 'EndTurn';
  header.append(title, endTurn);

  const main = el(doc, 'main');

  // The map and the dock share one column, so a panel that opens lands UNDER the map rather than
  // over the game. An opened panel is a side screen of a game that is still being played, and the
  // placement is what makes that true: a `<dialog open>` in the document flow sits below the fold
  // (a 900 px window showed a title and a Close button and nothing else), and a floating one
  // intercepts the pointer the map and the action buttons need. See `styles.css` for the measured
  // evidence. The dialogs themselves are moved in here by `start`, once the panels exist.
  const mapColumn = el(doc, 'div');
  mapColumn.dataset['layout'] = 'map-column';

  const mapRegion = el(doc, 'div');
  mapRegion.setAttribute('role', 'application');
  mapRegion.setAttribute('aria-label', 'Map');
  mapRegion.dataset['panel'] = 'map';

  const canvas = doc.createElement('canvas');
  canvas.width = CANVAS_WIDTH_PX;
  canvas.height = CANVAS_HEIGHT_PX;
  canvas.style.width = `${String(CANVAS_WIDTH_PX)}px`;
  canvas.style.height = `${String(CANVAS_HEIGHT_PX)}px`;
  canvas.style.display = 'block';
  // The map's non-pixel interface: it names the visible map dimensions and the tile under the
  // cursor, which is what lets "which tile is under the pointer" be asserted without a colour.
  canvas.setAttribute('aria-description', 'Map');
  mapRegion.append(canvas);

  const dock = el(doc, 'div');
  dock.dataset['layout'] = 'dock';
  mapColumn.append(mapRegion, dock);

  const panelsRoot = el(doc, 'section');
  panelsRoot.setAttribute('aria-label', 'Panels');
  main.append(mapColumn, panelsRoot);

  root.append(header, main);
  doc.body.append(root);
  return { root, canvas, endTurn, panelsRoot, dock };
};

/**
 * Start the app.
 *
 * The order is strict, because each step depends on the last: the shell's DOM exists before the
 * panels are mounted into it, the panels exist before the first `refresh()`, and the ruleset is
 * validated before any game is created from it.
 */
const start = (): void => {
  const doc = document;
  const ruleset = validatedRuleset();
  const shell = buildShell(doc);
  const canvas = shell.canvas;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser gave the map canvas no 2d context');
  const window_ = doc.defaultView;

  /* -------------------------------- state -------------------------------- */

  let state: GameState;
  let camera: Camera = defaultCamera();
  let cursor: { readonly x: number; readonly y: number } | null = null;
  let trace: FrameTrace = { tiles: [], cursor: null };
  let frames = 0;
  let ready = false;

  const initialSettings = (): Settings => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, seed: DEFAULT_SEED });
    if (!parsed.ok) throw new Error('the default settings are not settings the engine accepts');
    return parsed.value;
  };

  const startGame = (chosen: Settings): GameState => {
    const started = newGame(chosen.seed, chosen, ruleset);
    if (!started.ok) throw new Error(`the engine could not start a game: ${started.error.kind}`);
    return started.value;
  };

  const viewport = (): ViewportSize => ({ width: CANVAS_WIDTH_PX, height: CANVAS_HEIGHT_PX });
  const extent = (): ViewportSize => ({ width: state.map.width, height: state.map.height });

  state = startGame(initialSettings());

  /* -------------------------------- drawing ------------------------------ */

  const draw = (): FrameTrace => {
    const size = viewport();
    const ratio = window_?.devicePixelRatio ?? 1;
    const backingWidth = Math.round(size.width * ratio);
    const backingHeight = Math.round(size.height * ratio);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    // Draw in CSS pixels: the transform scales the whole frame onto the backing store, so the
    // rectangle `tileToScreen` returns is the rectangle that lands on screen — and a pixel sample
    // taken at `tileCentre` reads that tile's colour on a hidpi page as well as an ordinary one.
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const frame = drawFrame(context as unknown as Canvas2D, {
      state,
      viewer: humanSeatOf(state) ?? 0,
      camera,
      viewport: size,
      units: unitMarkers(state, panels.selection().unitId),
      cities: cityMarkers(state),
      cursor,
    });
    trace = frame;
    frames += 1;
    updateDescription(size, cursor);
    // The drawing surface documents the projection it used, beside the seam's own `camera()`.
    canvas.dataset['camera'] = JSON.stringify(camera);
    return frame;
  };

  /** The canvas's accessible description: the map's dimensions, the view, then the cursor. */
  const updateDescription = (
    size: ViewportSize,
    at: { readonly x: number; readonly y: number } | null,
  ): void => {
    const tilePx = tileScreenPx(camera);
    const showing = `${String(Math.round(size.width / tilePx))} by ${String(
      Math.round(size.height / tilePx),
    )}`;
    const where =
      at === null ? 'no tile under the pointer' : `tile ${String(at.x)},${String(at.y)}`;
    canvas.setAttribute(
      'aria-description',
      `Map of ${String(state.map.width)} by ${String(state.map.height)} tiles, showing about ` +
        `${showing} tiles at zoom ${String(camera.zoomNumerator)}/${String(
          camera.zoomDenominator,
        )}; pointer over ${where}.`,
    );
  };

  /** The end of every state or camera change: one synchronous frame, and `ready` after it. */
  const redraw = (): void => {
    draw();
    ready = true;
  };

  /* ------------------------------ the panels ------------------------------ */

  /**
   * The events of the command that was applied most recently.
   *
   * It exists because the frozen seam's `dispatch` publishes the bare `'ok' | 'refused'` — that
   * string is what crosses `page.evaluate`, and it is what the e2e suite compares against — while
   * the log needs the engine's own event list. Both come from ONE `applyCommand` call: the buffer
   * is set for each accepted command and read by whichever caller asked for the dispatch. It is
   * cleared first, so a refusal can never leave a previous command's events behind.
   */
  let lastEvents: readonly GameEvent[] = [];

  /** Render the engine's events into the `Events` log, against the state they happened in. */
  const logEvents = (events: readonly GameEvent[]): void => {
    if (events.length === 0) return;
    panels.log.append(eventLines(events, { state, ruleset }));
  };

  /**
   * The function every control dispatches through: the **seam as it currently stands**.
   *
   * A map click, an ability button, the `End turn` button and the panels all call this, so a test
   * that wraps `window.__CIVTS__.dispatch` — `recordDispatches`, `clearDispatchLog`, the keystone
   * sweep — observes the app's own controls exactly as it observes a command it dispatched itself.
   * Without it a control could apply a command the seam's instrumentation never saw, which is
   * exactly the defect that makes "every control the UI offers" untestable at the UI layer. See
   * `testapi.ts`' `seamDispatch`: it calls a wrapper when one is installed and the app's own
   * runner otherwise, so a command is applied exactly once along every path.
   */
  let armDispatch: (action: unknown) => 'ok' | 'refused' = () => 'refused';

  /** The app's own runner: validate into a `Command`, apply once, render, refresh. */
  const applyAction = (action: unknown): 'ok' | 'refused' => {
    const command = toCommand(action);
    if (command === undefined) return 'refused';
    return dispatchCommand(command).outcome;
  };

  const panelsApi: PanelsApi = {
    document: doc,
    ruleset,
    state: () => state,
    playerId: (): PlayerId => {
      const seat = humanSeatOf(state);
      if (seat === undefined) throw new Error('the state has no civilization to play as');
      return seat;
    },
    // **The panels dispatch through the seam**, not around it — see `armDispatch`.
    dispatch: (action) => armDispatch(action),
    replaceState: (next) => {
      state = next;
      draw();
    },
    stateHash: () => hashValue(state),
  };

  const panels: PanelsHandle = mountPanels(shell.panelsRoot, panelsApi);

  /**
   * Dock the panels' three dialogs under the map.
   *
   * The panels own the elements — their roles, their names and their contents are all built in
   * `panels/` — and the shell owns the *layout*, which is the split `panels/index.ts` states. So
   * this is a placement, not a second copy: the elements move, they are not duplicated, and every
   * panel's own `open()` keeps working because it holds the element it always held. What the move
   * buys is that an opened panel cannot cover the map (wheel, drag and click stay the map's) or the
   * action buttons in the panel column (a player can keep playing with a panel up), which is
   * exactly what the two green tests that a floating layout broke are asserting.
   */
  shell.dock.append(
    panels.elements.cityDialog,
    panels.elements.techDialog,
    panels.elements.debugDialog,
  );

  /**
   * The abilities group: the shell's own, because these are the orders a player issues against
   * the map as much as from a list. Appended beside the unit panel's action group so the two read
   * together, and named separately so a keystone sweep can tell them apart.
   */
  const abilities = el(doc, 'div');
  abilities.setAttribute('role', 'group');
  shell.panelsRoot.append(abilities);

  const refreshAbilities = (): void => {
    const unitId = panels.selection().unitId;
    abilities.replaceChildren();
    if (unitId === undefined) {
      abilities.setAttribute('aria-label', 'Abilities for unit none');
      return;
    }
    abilities.setAttribute('aria-label', `Abilities for unit ${String(unitId)}`);
    for (const command of abilityCommands(state, ruleset, humanSeatOf(state), unitId)) {
      const button = el(doc, 'button', abilityLabel(state, command));
      button.type = 'button';
      button.dataset['command'] = command.type;
      button.addEventListener('click', () => {
        armDispatch(command);
      });
      abilities.append(button);
    }
  };

  /* ------------------------------ dispatching ---------------------------- */

  /**
   * Apply a command through the real applier, then bring the screen up to date.
   *
   * Returns the engine's own events beside the outcome: the log can only render what it is
   * handed, and reconstructing it by diffing states would be the UI deciding what happened (see
   * `panels/index.ts`). A refusal changes nothing — no state, no events — and is reported as
   * `'refused'` rather than thrown, so a caller can prove the refusal was the engine's.
   */
  function dispatchCommand(command: Command): {
    readonly outcome: 'ok' | 'refused';
    readonly events: readonly GameEvent[];
  } {
    const seat = humanSeatOf(state);
    if (seat === undefined) return { outcome: 'refused', events: [] };

    // Clear first: the buffer belongs to the call about to happen, so a refusal cannot leave the
    // previous command's events for the panels' dispatch to render again.
    lastEvents = [];
    const outcome = applyCommand(state, seat, command, ruleset);
    if (!outcome.ok) {
      // The panels still re-render: a refusal is a normal answer, and a control that must not
      // change has to be rebuilt from the state that did not change.
      panels.refresh();
      refreshAbilities();
      return { outcome: 'refused', events: [] };
    }

    state = outcome.value.state;
    lastEvents = outcome.value.events;
    // The log is appended **here and nowhere else**: every path into the engine — a panel button,
    // an ability button, a map click, the `End turn` button, the seam — runs through
    // `dispatchCommand`, so one append per accepted command is one statement of "what happened".
    logEvents(outcome.value.events);
    panels.refresh();
    refreshAbilities();
    redraw();
    return { outcome: 'ok', events: outcome.value.events };
  }

  /* -------------------------------- seeding ------------------------------ */

  /** The camera a game starts at: centred on the human seat's starting tile, as far as it clamps. */
  const openingCamera = (game: GameState): Camera => {
    const seat = humanSeatOf(game);
    const player = game.players.find((candidate) => candidate.id === seat);
    const anchor =
      player?.startingTile ?? game.units.find((unit) => unit.owner === seat)?.tile ?? 0;
    return centreOnTile(defaultCamera(), extentOf(game), viewport(), {
      x: indexToX(game.map, anchor),
      y: indexToY(game.map, anchor),
    });
  };

  /**
   * Start a new game at `seed`: the engine's own `newGame` on the validated ruleset, over the
   * settings this app already plays with (so a test's options are a patch on the app's own
   * configuration rather than a second, competing one), then a fresh camera, empty log and empty
   * selection. Nothing is carried over, because a new game is a new game.
   */
  function reseed(seed: number, options?: unknown): void {
    const merged = parseSettings({
      ...state.settings,
      ...(isRecord(options) ? options : {}),
      seed,
    });
    if (!merged.ok) return;
    state = startGame(merged.value);
    camera = openingCamera(state);
    cursor = null;
    panels.log.clear();
    panels.selectUnit(undefined);
    panels.selectCity(undefined);
    panels.refresh();
    refreshAbilities();
    redraw();
  }

  /* ------------------------------- the map ------------------------------- */

  const localPoint = (event: MouseEvent): ScreenPoint => {
    const rect = canvas.getBoundingClientRect();
    // The canvas is never stretched (its CSS size is set to its own pixel size), but the scale is
    // taken from the rect anyway: a page-wide zoom or a stylesheet that resized it would otherwise
    // shift every hit-test by the difference, and this is the one place that arithmetic lives.
    const scaleX = rect.width === 0 ? 1 : CANVAS_WIDTH_PX / rect.width;
    const scaleY = rect.height === 0 ? 1 : CANVAS_HEIGHT_PX / rect.height;
    return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
  };

  const tileAt = (point: ScreenPoint): { readonly x: number; readonly y: number } | undefined =>
    screenToTile(camera, extent(), point);

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  /**
   * How far the pointer has travelled since it went down, and whether that makes the release a
   * drag rather than a click.
   *
   * A browser fires `click` on the nearest common ancestor of the press and the release — here
   * always the canvas — so **a drag that pans the map ends in a click on the tile it was released
   * over**. Treating that as an order would mean a player who scrolled the map silently issued a
   * move; it was found exactly that way, by a sweep whose control clicks were preceded by a pan
   * and which then read a `MoveUnit` no control had offered. The distance is presentation-only
   * state: no rule reads it, and it never reaches the engine.
   */
  let travelled = 0;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    travelled = 0;
    lastX = event.clientX;
    lastY = event.clientY;
  });

  canvas.addEventListener('pointermove', (event) => {
    const tile = tileAt(localPoint(event));
    const next = tile === undefined ? null : { x: tile.x, y: tile.y };
    if (next?.x !== cursor?.x || next?.y !== cursor?.y) {
      cursor = next;
      draw();
    }
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx === 0 && dy === 0) return;
    travelled += Math.abs(dx) + Math.abs(dy);
    // `panCamera` is the projection module's own pan: this handler converts a drag to a delta and
    // nothing else, so the sign convention the e2e suite computes against is the app's own.
    camera = panCamera(camera, extent(), viewport(), dx, dy);
    redraw();
  });

  const endDrag = (): void => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    dragging = false;
    cursor = null;
    draw();
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      // The page must not scroll under a wheel aimed at the map: the gesture is zoom, and a
      // scrolled page would move the canvas out from under the pointer the wheel anchored on.
      event.preventDefault();
      const steps = event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      camera = zoomCamera(camera, extent(), viewport(), steps, localPoint(event));
      redraw();
    },
    { passive: false },
  );

  /**
   * A click on the map, ordered through the engine's own list.
   *
   * The click is resolved against `unitActions(state, ruleset, selectedUnitId)` — the engine's
   * answer for that unit — so this handler cannot invent a destination:
   *
   * 1. a tile one of the unit's own `MoveUnit`/`AttackUnit` commands names is **dispatched**
   *    (through the real applier, as everything is);
   * 2. a tile holding one of your own cities opens its screen — checked **before** the unit pass,
   *    because a city is a landmark and a unit standing in it is not what a player means by
   *    clicking it (the unit is still reachable from the `Units` region, and the map still
   *    selects any unit on a tile that has no city);
   * 3. a tile holding one of your own units selects it;
   * 4. an empty tile that is not one of the unit's destinations is still dispatched as a
   *    `MoveUnit`, and the engine refuses it. That is deliberate: the refusal is the player's
   *    feedback, and a click that silently did nothing would be indistinguishable from a broken
   *    control. A refusal leaves the state untouched;
   * 5. a tile outside the map, or one held by somebody else with nothing to attack, leaves the
   *    state alone rather than asking the engine a question whose answer is already known.
   */
  canvas.addEventListener('click', (event) => {
    // The release that ended a pan is not a map click: the gesture was scrolling (see
    // `travelled`). The threshold is a few pixels so a shaky hand still lands an order.
    if (travelled > DRAG_CLICK_TOLERANCE_PX) {
      travelled = 0;
      return;
    }
    travelled = 0;
    const tile = tileAt(localPoint(event));
    if (tile === undefined) return;
    const index = tile.y * state.map.width + tile.x;
    const seat = humanSeatOf(state);
    const selection = panels.selection();
    const selected = selection.unitId;

    // One of the seat's own cities: the click opens that city's screen, whether or not the
    // selected unit could also walk onto the tile. `orders.spec.ts` states the rule the whole
    // suit is built on — "clicking a tile that holds a unit or a city selects that unit or opens
    // that city, which is what a player expects" — and the order that shares the tile is not
    // hidden by this: the unit's own action group lists it as a `Move to x,y` control, which is
    // where the keystone sweep's reachability direction finds it.
    const cityHere = state.cities.find(
      (candidate) => candidate.tile === index && candidate.owner === seat,
    );
    if (cityHere !== undefined) {
      panels.openCity(cityHere.id);
      return;
    }

    // The unit's own action list decides whether this click is an order. `unitActions` is the
    // engine's answer, so a destination that appears here is one `applyCommand` accepts.
    if (selected !== undefined) {
      const ordered = unitActions(state, ruleset, selected).find(
        (command) => commandTile(command) === index,
      );
      if (ordered !== undefined) {
        armDispatch(ordered);
        return;
      }
    }

    const own = state.units.find((unit) => unit.tile === index && unit.owner === seat);
    if (own !== undefined) {
      panels.selectUnit(own.id);
      refreshAbilities();
      redraw();
      return;
    }

    const occupied =
      state.units.some((unit) => unit.tile === index) ||
      state.cities.some((candidate) => candidate.tile === index);
    if (occupied) return;

    // An empty tile the unit's own list did not name: the command is issued anyway so the engine
    // can refuse it out loud. The index is inside the map — `screenToTile` returned it — and
    // `asTileIndex` is the engine's own constructor for the branded id rather than an escape from
    // the type system. When the seat owns no unit at all the sentinel id is refused as
    // `unknown-unit`: a refusal either way, never a silent no-op dressed up as success.
    armDispatch({
      type: 'MoveUnit',
      unitId: selected ?? asUnitId(-1),
      to: asTileIndex(index),
    });
  });

  shell.endTurn.addEventListener('click', () => {
    armDispatch({ type: 'EndTurn' });
  });

  /* ------------------------------- the seam ------------------------------ */

  const seam = installTestApi({
    state: () => state,
    playerId: () => humanSeatOf(state),
    ruleset,
    dispatch: (command) => dispatchCommand(command),
    lastEvents: () => lastEvents,
    seed: (seed, options) => {
      reseed(seed, options);
    },
    settings: () => state.settings,
    replaceState: (next) => {
      state = next;
      panels.refresh();
      refreshAbilities();
      redraw();
    },
    drawTrace: () => trace.tiles,
    camera: () => camera,
    terrainColours: () => TERRAIN_COLOURS,
    ready: () => ready,
    draws: () => frames,
  });

  // Arm the controls against the seam that was just installed: from here on, every click reads
  // `window.__CIVTS__.dispatch` at the moment it fires, so a test's wrapper sees it.
  armDispatch = seamDispatch(seam.dispatch).arm(applyAction);

  // The first frame, and then `ready` — the contract's `ready` means "the first frame is drawn",
  // so it is set by the draw itself rather than by a timer or by a load event.
  panels.refresh();
  refreshAbilities();
  redraw();
};

/** A `ViewportSize` from any state's map — the extent `clampCamera` and friends take. */
const extentOf = (state: GameState): ViewportSize => ({
  width: state.map.width,
  height: state.map.height,
});

start();
