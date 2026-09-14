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
 * - the unit panel and its `Actions for unit <id>` group (W2) render `unitActions` verbatim, plus
 *   the engine's *queried* commands — `planFortifyUnit`'s fortify, which `unitActions` yields to
 *   nobody because it emits no event, and which A4 nevertheless names as a unit order;
 * - the city screen (W2) renders `cityProductionOptions` and asks `planSetWorkedTiles` about the
 *   assignment each checkbox would write;
 * - a click on the map is resolved by looking the clicked tile up in the unit's own action list
 *   (`unitActions`), so the click can only ever issue a command the engine already offered. A
 *   click the engine would refuse (an empty tile further than the unit can walk) is dispatched
 *   anyway and comes back `'refused'`, because "the engine said no" is an answer a player and a
 *   test are both entitled to see — and a refusal leaves the state exactly as it was.
 *
 * ## What the shell owns, and what it must not own
 *
 * The shell owns `Map` (the `application` role), `End turn` (the button), the turn pipeline's
 * dispatch, and the *placement* of the panels' elements — where a thing sits, never what it says.
 * It must **not** render a second copy of any element the panels own: two elements with one
 * accessible name make a role-and-name locator ambiguous, which is a worse failure than a missing
 * one. It adds exactly what A4 requires of the shell and nothing else (`Map`, `End turn`).
 *
 * That rule has teeth, and it was being broken here. This file used to build its own
 * `Abilities for unit <id>` group — a second list of orders for a unit, beside the panel's
 * `Actions for unit <id>`, with a second labeller of its own whose `default` arm would have put a
 * raw command name on a button. The group is gone: the shell now moves the panel's group to the map
 * (see the placement note in `start`) rather than restating its contents.
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
  MAP_SIZES,
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitId,
  indexToX,
  indexToY,
  isExplored,
  isGameOver,
  mergeSettings,
  newGame,
  opponentModeOf,
  parseSettings,
  unitActions,
  visibleTiles,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Settings,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
/**
 * The opponent, imported rather than written.
 *
 * A1 requires a human to play against opponents, and the sim package already owns the only
 * decision-maker this project has: `SMART_POLICY`, the same policy the tournaments and the
 * balance sweeps run. A browser-only second implementation would be a second opponent, free to
 * disagree with the one every measurement in this repository was taken against — the
 * command-versus-generator defect class this project has already found six times, at a new layer.
 */
import { SMART_POLICY, policyRngFor } from '@civts/sim';
import { hashValue } from '@civts/testing';

import {
  centreOnTile,
  clampCamera,
  defaultCamera,
  panCamera,
  screenToTile,
  tileScreenPx,
  tileToScreen,
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
import { loadTerrainSprites, type TerrainSprites } from './tiles.js';
import { loadUnitSprites, type UnitSprites } from './units.js';
import { eventLines } from './events.js';
import { mountPanels, type PanelsApi, type PanelsHandle } from './panels/index.js';
import { humanSeatOf, installTestApi, seamDispatch, splitSeat, toCommand } from './testapi.js';
import { tileNamedBy, unitNamedBy } from './ui/schema.js';
import { nextGotoStep, startGoto, type GotoIntent } from './ui/goto.js';
import { problemText } from './ui/problem.js';
import { nextUnitNeedingOrders, unitsNeedingOrders } from './ui/nextunit.js';
import { KEY_HELP, mapActionFor, sessionActionFor, type KeyContext } from './ui/keys.js';
import { hoverReadout, readoutText } from './ui/hover.js';

/** The seed a page load starts on, when nothing has seeded it. */
const DEFAULT_SEED = 1;

/**
 * The map's CSS size is **measured, not declared**.
 *
 * It used to be a fixed 720×540 box, and the argument for fixing it was sound: the viewport the
 * camera is clamped against, the rectangle the renderer walks, and the box the hit-test inverts must
 * be *one* number, or "which tile did I click?" stops agreeing with "which tile did I draw?". That
 * argument is kept — the change is only *who owns the number*. It is now the layout (a square that
 * takes the room the sidebar leaves), read in exactly one place and handed to all three consumers
 * through `viewport()`.
 *
 * What the fixed box was protecting against is real and is why nothing else may read the layout: if
 * the size could change between asking the question and answering it, the answer would depend on
 * *when* it was asked. So the size changes only when the measured box genuinely differs, and every
 * change re-clamps the camera against the new size before the next frame.
 *
 * The fallback is used only before the canvas has been laid out — `getBoundingClientRect` on an
 * unmounted element is zero, and clamping a camera against a viewport of nothing would put it
 * nowhere. `tests` never see it: by the time a page is interactive the box is real.
 */
const CANVAS_FALLBACK_PX = 540;

/** One wheel notch of zoom, in zoom levels. */
const WHEEL_STEP = 1;

/**
 * How far the unit action popup sits from the tile it belongs to, in CSS pixels.
 *
 * It is a presentation constant and never a rule: it decides only where a menu is drawn. The popup
 * is placed in the ring *around* the unit's tile rather than on it, so the tile being decided about
 * is never covered by the menu doing the deciding.
 */
const UNIT_ACTIONS_GAP_PX = 6;

/**
 * How far the pointer may travel between press and release and still count as a click.
 *
 * A browser fires `click` on the common ancestor of the press and the release, so a drag across
 * the map ends in a click on the canvas. Anything past this many pixels was a pan, not an order:
 * the number is a gesture threshold in the presentation layer and is never consulted by a rule.
 */
const DRAG_CLICK_TOLERANCE_PX = 4;

/**
 * How far the tile readout sits from the pointer, in CSS pixels (Phase 6).
 *
 * Two numbers rather than one because a tooltip is read *after* the thing it is about: it is placed
 * down and to the right of the pointer by the same amount a caption sits below a figure, and it is
 * flipped to the other side at the map's edge so it never leaves the canvas. Presentation only — no
 * rule and no engine answer depends on where it lands.
 */
const READOUT_GAP_X_PX = 14;
const READOUT_GAP_Y_PX = 18;

/**
 * The map's keyboard hint, on the region rather than on the canvas.
 *
 * The canvas's own `aria-description` is the *cursor* readout — the contract requires it to name the
 * visible dimensions and the tile under the pointer, and `map.spec.ts` asserts it — so the map's
 * keys are described on the region that owns them. A keyboard user reaches the region with `Tab`,
 * and this is what tells them what the region will do with the keys they press.
 */
const MAP_KEY_HINT =
  'The map is in the tab order. Arrow keys pan it, plus and minus zoom it. ' +
  'Space selects the next unit that needs orders and Enter ends the turn.';

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

/**
 * The validated ruleset the whole session plays on — the same `tuned` catalog the goldens use.
 *
 * The type is the **content** ruleset, not the structural view: `validateRuleset` returns the
 * content, and a policy needs the content (its `PolicyContext` is given the whole ruleset, since
 * a decision may read a cost or a combat row that the engine's own view never needs). Annotating
 * this as the view was harmless until the opponent arrived and then read it.
 */
const validatedRuleset = (): Ruleset => {
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
 * One marker per unit the viewing player can **see right now**, each in its owner's colour, so
 * "mine" and "not mine" are distinguishable at a glance without the viewer having to know the
 * palette.
 *
 * **This file decides what is visible, by asking the engine.** `render.ts` is a pure function of
 * `(state, camera, viewport, markers)` and reads no fog of its own, so the filtering has to happen
 * where the markers are built — and it is a *question*, not a decision of this file's own: the
 * engine exports both notions of "known" and they answer different questions (`fog.ts`).
 * `visibleTiles` is current sight, derived from the viewing player's own units, and it is the one
 * a unit marker needs: a marker is a claim about what the player can see *this instant*, so a
 * rival that walks out of range must stop being drawn. `isExplored` is memory — the right function
 * for terrain, for the border tint, and for the city markers below — and using it here would leak,
 * because a rival on ground the player once saw but cannot see now would still be painted.
 *
 * This comment used to say "this file does not decide what is visible". It was true of this
 * function and false of the app: every unit of every player was marked, the renderer filtered only
 * by viewport, and an unexplored tile was painted flat fog with the enemy drawn on top of it
 * (measured in docs/UI-OVERHAUL.md §7.8; recorded in docs/KNOWN-ISSUES.md).
 */
const unitMarkers = (
  state: GameState,
  selected: UnitId | undefined,
  viewer: PlayerId,
): readonly UnitMarker[] => {
  const visible = new Set<number>(visibleTiles(state, viewer).map((tile) => Number(tile)));
  return state.units
    .filter((unit) => visible.has(Number(unit.tile)))
    .map((unit) => ({
      id: unit.id,
      tile: unit.tile,
      type: unit.type,
      colour: colourOfPlayer(state, unit.owner),
      selected: unit.id === selected,
    }));
};

/**
 * One marker per city the viewing player **remembers**, which is `isExplored` and deliberately not
 * `visibleTiles`: you keep a city you have seen on the map after it leaves your sight, which is the
 * genre convention and what this codebase already does one layer down — `render.ts` says "a border
 * is drawn only on an explored tile", for the same reason (revealing through the marker exactly
 * what the flat fog colour refuses to reveal through the terrain). So cities are the stated
 * exception to the units rule above, and the two rules differ on purpose rather than by oversight.
 */
const cityMarkers = (state: GameState, viewer: PlayerId): readonly CityMarker[] =>
  state.cities
    .filter((city) => isExplored(state, viewer, city.tile))
    .map((city) => ({ tile: city.tile, colour: colourOfPlayer(state, city.owner) }));

/**
 * Which tile a map order names is the schema's question, not this file's.
 *
 * `tileNamedBy` in `ui/schema.ts` is the single answer, and the click handler below asks it. There
 * used to be a local `commandTile` here doing the same job with an `if` chain; two definitions of
 * "which tile does this command point at" is the same class of defect the contract bans for the
 * projection (`docs/INTERFACES.md:1908`), and it is how a click ends up dispatching an order for a
 * tile the caller did not mean.
 */

/* ------------------------------------------------------------------ *
 * The app
 * ------------------------------------------------------------------ */

interface Shell {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /**
   * The map region: the box the canvas is a square inside, and where the unit action popup is
   * placed. Exposed so the shell can put a panel element *over the map* without owning its markup —
   * the same split that lets the dialogs be docked (see the placement note in `start`).
   */
  readonly mapRegion: HTMLElement;
  readonly endTurn: HTMLButtonElement;
  /**
   * The **order channel**: the one place this app says what the engine said about an order.
   *
   * §1.4 measured the defect it fixes — a refused click applied nothing and said nothing — and it
   * carries a second job Phase 4 needs: a goto that has been invalidated has to be *cancelled out
   * loud* (`docs/UI-OVERHAUL.md` §8, decision 4), and this is the same channel a refusal uses, so
   * there is one place a player reads "what happened to my order".
   *
   * It is a new accessible name — `status`/`Order` — and it is unique on the page. The frozen M8
   * table may not be extended in place (`docs/INTERFACES.md`, M9+M10's note), which is why the name
   * is stated here and in `docs/UI-OVERHAUL.md` §9 instead, and Playwright matches names by
   * substring, so it must not be a substring of `Turn`, `Year`, `Treasury`, `Science`, `Luxury`,
   * `Rates`, `State hash`, `Save status`, `Government verdict` or `New game problem`: it is none of
   * those, and none of those contains it.
   */
  readonly orderStatus: HTMLElement;
  /** The sidebar: the strip holding everything that is not a direct unit action. */
  readonly panelsRoot: HTMLElement;
  /** The nine panels, inside the sidebar. This is the one region of it that may scroll. */
  readonly panelStack: HTMLElement;
  /** The dialogs' dock, at the foot of the sidebar — see `buildShell`. */
  readonly dock: HTMLElement;
  /**
   * The next-unit flow's control (Phase 5).
   *
   * A **new accessible name** — `Next unit` — stated here and in `docs/UI-OVERHAUL.md` §9 rather
   * than in the frozen M8 table, which the M9+M10 note forbids extending in place. It collides with
   * none of the names in that table, and it dispatches **nothing**: moving to the next unit is
   * navigation, not an order (§2.A), so a control for it must be a control that issues no command.
   */
  readonly nextUnit: HTMLButtonElement;
  /**
   * The keyboard contract's discoverable half (Phase 5): the button that opens the bindings, and
   * the docked panel that lists them.
   *
   * Both carry the **new** accessible name `Keyboard` (a `button` and a `dialog`), which collides
   * with nothing in the frozen table. The panel is docked in the sidebar like every other dialog
   * (`styles.css` states why an opened panel never floats over the game), and its contents come
   * from `ui/keys.ts` `KEY_HELP`, so the help cannot describe a key the handler does not have.
   */
  readonly keyboard: { readonly open: HTMLButtonElement; readonly dialog: HTMLDialogElement };
  /**
   * The tile readout (Phase 6): the hover layer's one element.
   *
   * A **new** accessible name — `status`/`Tile` — again stated here rather than in the frozen table.
   * It is `aria-live="off"` on purpose: the text changes on every pointer move, and a live region
   * that announced each one would make the map unusable with a screen reader.
   */
  readonly tileReadout: HTMLElement;
  readonly newGame: NewGameControls;
}

/**
 * The new-game surface: A1's "start a new game from the web UI, **choose settings**".
 *
 * Before this existed the only way to choose a seed, a map size or a civilisation count was the
 * test seam, so a human got whatever board the app happened to construct and could not start a
 * second game at all. Each control carries its own accessible name because the accessibility
 * contract targets by role and name, and **the engine does the validating**: the values are
 * handed to `parseSettings`, and the refusal the player reads is the engine's own words. A check
 * written here would be a second statement of what a legal game is, free to disagree with the
 * one every other path uses.
 */
interface NewGameControls {
  readonly dialog: HTMLDialogElement;
  readonly open: HTMLButtonElement;
  readonly seed: HTMLInputElement;
  readonly mapSize: HTMLSelectElement;
  readonly civCount: HTMLInputElement;
  readonly opponent: HTMLInputElement;
  readonly start: HTMLButtonElement;
  readonly problem: HTMLElement;
}

const buildNewGame = (doc: Document): NewGameControls => {
  const dialog = doc.createElement('dialog');
  dialog.setAttribute('aria-label', 'New game');

  const field = (label: string, control: HTMLElement): HTMLLabelElement => {
    const wrapper = el(doc, 'label', `${label} `);
    wrapper.append(control);
    return wrapper;
  };

  const seed = doc.createElement('input');
  seed.type = 'number';
  seed.setAttribute('aria-label', 'Seed');
  seed.value = String(DEFAULT_SETTINGS.seed);

  const civCount = doc.createElement('input');
  civCount.type = 'number';
  civCount.setAttribute('aria-label', 'Civilisations');
  // The bounds are rendered so the control is usable, but they are not the rule: an out-of-range
  // value is still passed to the engine and refused by it, which is the path the test exercises.
  civCount.min = '2';
  civCount.max = '16';
  civCount.value = String(DEFAULT_SETTINGS.civCount);

  const mapSize = doc.createElement('select');
  mapSize.setAttribute('aria-label', 'Map size');
  for (const size of MAP_SIZES) {
    const option = el(doc, 'option', size);
    option.value = size;
    if (size === DEFAULT_SETTINGS.mapSize) option.selected = true;
    mapSize.append(option);
  }

  const opponent = doc.createElement('input');
  opponent.type = 'checkbox';
  opponent.setAttribute('aria-label', 'Opponent');
  opponent.checked = DEFAULT_SETTINGS.ai.opponent === 'policy';

  const problem = el(doc, 'p');
  problem.setAttribute('role', 'status');
  problem.setAttribute('aria-label', 'New game problem');

  const start = el(doc, 'button', 'Start new game');
  start.type = 'button';

  const close = el(doc, 'button', 'Close new game');
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });

  const fields = el(doc, 'div');
  fields.append(
    field('Seed', seed),
    field('Map size', mapSize),
    field('Civilisations', civCount),
    field('Opponent', opponent),
    problem,
    start,
    close,
  );

  const heading = el(doc, 'h2', 'New game');
  dialog.append(heading, fields);

  const open = el(doc, 'button', 'New game');
  open.type = 'button';

  return { dialog, open, seed, mapSize, civCount, opponent, start, problem };
};

/**
 * The keyboard help: the header control that opens the bindings, and the panel that lists them.
 *
 * **Discoverability is the half of a keyboard contract that is easy to skip.** A binding nobody can
 * find is a binding that does not exist for a new player, so the keys are listed in one place a
 * player can open, from the header, beside the other app-level controls — and the list is
 * `KEY_HELP`, derived from the binding table itself (`ui/keys.ts`), so the help cannot advertise a
 * key that does nothing or omit one that works.
 *
 * It is a `<dialog>` with its own `Close`, exactly like the city screen and the tech tree, and it is
 * a **new** accessible name (`Keyboard`) rather than a row in the frozen M8 table, which the
 * M9+M10 note forbids extending in place. The heading is the same word as the control that opens
 * it, which is the shape `New game` already has (a `button` and a `dialog`).
 */
const buildKeyboardHelp = (doc: Document): Shell['keyboard'] => {
  const dialog = doc.createElement('dialog');
  dialog.setAttribute('aria-label', 'Keyboard');
  dialog.dataset['panel'] = 'keyboard';

  const close = el(doc, 'button', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    dialog.close();
  });

  const heading = el(doc, 'h2', 'Keyboard');
  // The bindings live in their own scroll box, and the `Close` control does not: measured at
  // 1280×900, the nine rows plus their two notes are taller than the share of the sidebar a docked
  // panel gets, so a panel that scrolled as a whole put its own Close button below the fold — which
  // is the defect `styles.css` records for the *other* direction and is just as bad this way round.
  // The body scrolls; the way out stays put.
  const body = el(doc, 'div');
  body.dataset['role'] = 'keys';
  for (const section of KEY_HELP) {
    const group = el(doc, 'section');
    const rows = el(doc, 'dl');
    for (const row of section.rows) {
      rows.append(el(doc, 'dt', row.keys), el(doc, 'dd', row.meaning));
    }
    group.append(el(doc, 'h3', section.where), el(doc, 'p', section.note), rows);
    body.append(group);
  }
  dialog.append(heading, body, close);

  const open = el(doc, 'button', 'Keyboard');
  open.type = 'button';
  return { open, dialog };
};

const buildShell = (doc: Document): Shell => {
  const root = el(doc, 'div');
  root.id = 'civts-app';

  const header = el(doc, 'header');
  const title = el(doc, 'h1', 'CivTS');
  const endTurn = el(doc, 'button', 'End turn');
  endTurn.type = 'button';
  endTurn.dataset['command'] = 'EndTurn';
  // The next-unit flow's control: **navigation, and it deliberately carries no `data-command`**,
  // because it issues no command at all. It exists so the flow is discoverable with a pointer as
  // well as with `Space` — a keyboard-only feature is a feature half the players cannot find.
  const nextUnit = el(doc, 'button', 'Next unit');
  nextUnit.type = 'button';
  nextUnit.dataset['role'] = 'next-unit';
  const keyboard = buildKeyboardHelp(doc);
  const newGame = buildNewGame(doc);
  // The order channel — see `Shell.orderStatus` for what it carries and why its name is what it is.
  // Empty until something happens to an order, and `styles.css` keeps it to one line whatever it
  // says: the header is `flex: 0 0 auto`, so a status line that wrapped or grew would take height
  // off the map column, and the map's box is the box the camera clamps against and the click
  // hit-test inverts.
  const orderStatus = el(doc, 'p');
  orderStatus.setAttribute('role', 'status');
  orderStatus.setAttribute('aria-label', 'Order');
  orderStatus.dataset['role'] = 'order';
  header.append(title, newGame.open, endTurn, nextUnit, keyboard.open, orderStatus);

  const main = el(doc, 'main');

  // The map column holds the map and nothing else, so the map's box — the box the camera clamps
  // against and the click hit-test inverts — cannot move because a panel opened. It used to hold the
  // map *and* the dock, and the dock took up to 40 % of the column's height: measured at 900×1000,
  // opening the debug panel cut the map region from 915 px to 546 px. See `styles.css`, which states
  // the two-column rule and where a dialog is docked now.
  const mapColumn = el(doc, 'div');
  mapColumn.dataset['layout'] = 'map-column';

  const mapRegion = el(doc, 'div');
  mapRegion.setAttribute('role', 'application');
  mapRegion.setAttribute('aria-label', 'Map');
  mapRegion.dataset['panel'] = 'map';
  // **The map is in the tab order** (Phase 5). `role=application` is the ARIA statement that the
  // region handles keys itself, and a region a keyboard cannot reach is a region whose keys nobody
  // can press — which is exactly the gap the inventory called "the sharpest" (§4.6e). Tab still
  // moves on afterwards: nothing here traps it, and the hint below says what the keys do.
  mapRegion.tabIndex = 0;
  mapRegion.setAttribute('aria-description', MAP_KEY_HINT);

  const canvas = doc.createElement('canvas');
  // The backing store is resized by `draw` from the measured CSS box and the device pixel ratio;
  // these initial numbers only have to be non-zero so the first frame has something to scale onto.
  canvas.width = CANVAS_FALLBACK_PX;
  canvas.height = CANVAS_FALLBACK_PX;
  // The CSS box itself is the layout's business, not this file's — see `styles.css`, where the
  // canvas is the largest square the map region can hold. Setting a pixel width here would be a
  // second, competing statement of the size, which is the defect this whole file is arranged around.
  canvas.style.display = 'block';
  // The map's non-pixel interface: it names the visible map dimensions and the tile under the
  // cursor, which is what lets "which tile is under the pointer" be asserted without a colour.
  canvas.setAttribute('aria-description', 'Map');
  mapRegion.append(canvas);
  // The tile readout (Phase 6) is a sibling of the canvas, like the orders popup, and it is placed
  // from the pointer's own client coordinates — see `showReadout`. It is `aria-live="off"`: the
  // text changes on every pointer move, and a live region that read each one aloud would make the
  // map unusable with a screen reader rather than more useful.
  const tileReadout = el(doc, 'p');
  tileReadout.setAttribute('role', 'status');
  tileReadout.setAttribute('aria-label', 'Tile');
  tileReadout.setAttribute('aria-live', 'off');
  tileReadout.dataset['floating'] = 'tile-readout';
  tileReadout.hidden = true;
  mapRegion.append(tileReadout);
  mapColumn.append(mapRegion);

  // The sidebar: a strip holding everything that is not a direct unit action, in two regions. The
  // stack carries the panels; the dock, at its foot, carries the dialogs the panels open. Both live
  // here rather than in the map column because a side screen belongs with the other side furniture
  // and because the two of them must share one bounded strip — see `styles.css` for the 40/60 split
  // and for what the strip's overflow used to cost.
  const panelsRoot = el(doc, 'section');
  panelsRoot.setAttribute('aria-label', 'Panels');
  const panelStack = el(doc, 'div');
  panelStack.dataset['layout'] = 'panel-stack';
  const dock = el(doc, 'div');
  dock.dataset['layout'] = 'dock';
  panelsRoot.append(panelStack, dock);
  main.append(mapColumn, panelsRoot);

  root.append(header, main);
  doc.body.append(root);
  dock.append(newGame.dialog);
  // The keyboard help is docked like every other panel rather than floated over the map: `styles.css`
  // states the rule and the measurement behind it (a floating panel over the game ate the gestures
  // the game is driven by, and turned three green tests red).
  dock.append(keyboard.dialog);
  return {
    root,
    canvas,
    mapRegion,
    endTurn,
    nextUnit,
    keyboard,
    orderStatus,
    tileReadout,
    panelsRoot,
    panelStack,
    dock,
    newGame,
  };
};

/**
 * Start the app.
 *
 * The order is strict, because each step depends on the last: the shell's DOM exists before the
 * panels are mounted into it, the panels exist before the first `refresh()`, and the ruleset is
 * validated before any game is created from it. Terrain sprites are decoded before the first
 * frame so `ready` means "painted with the real art", not a flat-colour flash.
 */
const start = async (): Promise<void> => {
  const doc = document;
  const ruleset = validatedRuleset();
  const shell = buildShell(doc);
  const canvas = shell.canvas;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser gave the map canvas no 2d context');
  const window_ = doc.defaultView;
  const sprites: TerrainSprites = await loadTerrainSprites();
  const unitSprites: UnitSprites = await loadUnitSprites();

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

  /**
   * The one number: the map's laid-out CSS size, shared by the camera clamp, the renderer and the
   * click hit-test. See `CANVAS_FALLBACK_PX` for why this is one number owned by the layout.
   */
  let mapSizePx: ViewportSize = { width: CANVAS_FALLBACK_PX, height: CANVAS_FALLBACK_PX };

  /**
   * Read the canvas's laid-out box into `mapSizePx`. Returns whether it *changed*.
   *
   * Rounded, deliberately: `getBoundingClientRect` reports fractional CSS pixels, and every consumer
   * walks whole ones. A fractional viewport would make the renderer's tile walk and the hit-test's
   * inverse disagree in the last pixel column — which is exactly the drift this file is arranged to
   * prevent, and the kind that shows up as "the click landed next door" rather than as an error.
   */
  const measureCanvas = (): boolean => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    // Zero means "not laid out yet" — an unmounted or hidden canvas. Taking it would clamp the
    // camera against a viewport of nothing and put the view nowhere, so the previous size stands.
    if (width <= 0 || height <= 0) return false;
    if (width === mapSizePx.width && height === mapSizePx.height) return false;
    mapSizePx = { width, height };
    return true;
  };

  const viewport = (): ViewportSize => mapSizePx;
  const extent = (): ViewportSize => ({ width: state.map.width, height: state.map.height });

  state = startGame(initialSettings());

  /* -------------------------------- drawing ------------------------------ */

  const draw = (): FrameTrace => {
    // Measured at the top of the only function that paints, so the rectangle the renderer walks and
    // the box the hit-test inverts come from one layout read. A size cached at start would be stale
    // after the first resize, and a size measured separately by each consumer could differ *between*
    // them, which is the drift this whole arrangement exists to make impossible.
    measureCanvas();
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
    // The acting player, read once: the frame's fog layer, the unit markers and the city markers
    // must all be answers about the SAME viewer, and three separate calls could disagree the day
    // one of them grows a fallback. Seat 0 when the state names no civilization is the same
    // fallback `viewer` had, said in the engine's own type rather than in a bare `0`.
    const viewer = humanSeatOf(state) ?? asPlayerId(0);
    const frame = drawFrame(context as unknown as Canvas2D, {
      state,
      viewer,
      camera,
      viewport: size,
      units: unitMarkers(state, panels.selection().unitId, viewer),
      cities: cityMarkers(state, viewer),
      // The ONE colour lookup for a player, shared with the markers above and with the territory
      // tint the renderer draws: a player is one colour all over the canvas (M9's borders).
      ownerColour: (owner) => colourOfPlayer(state, owner),
      cursor,
      sprites,
      unitSprites,
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
    // M10: a finished game refuses every command (`game-over`), so the turn button closes with it —
    // asked of the engine's own `isGameOver` on every frame rather than remembered in a flag, so a
    // load or a new game re-opens it and the button can never be out of step with the state.
    shell.endTurn.disabled = isGameOver(state, ruleset);
    draw();
    // The hover readout is rebuilt here rather than only on `pointermove`, because what it describes
    // can change while the pointer stands still: a move, a new turn, a key that pans the map. See
    // `updateReadout` — it reads the engine and changes nothing.
    updateReadout();
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

  /**
   * The app's own runner: split the acting seat off (`splitSeat`, the seam's own rule), validate
   * into a `Command`, apply once for that seat, render.
   *
   * This and the installed seam's `applyOnce` are the same three steps in the same order, because
   * an action must be applied identically whether a test wrapper is installed or not — the AI's
   * commands go through both paths, and a wrapper that changed which seat they were applied for
   * made the opponent silently vanish.
   */
  const applyAction = (action: unknown): 'ok' | 'refused' => {
    const { seat, rest } = splitSeat(action);
    const command = toCommand(rest);
    if (command === undefined) return 'refused';
    return dispatchCommand(command, seat).outcome;
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
  // (The panels' `replaceState` above is the Load path's first half; the seam's is the second. Both
  // land on the same three lines below.)

  const panels: PanelsHandle = mountPanels(shell.panelStack, panelsApi);

  /**
   * Dock the panels' dialogs at the foot of the sidebar.
   *
   * The panels own the elements — their roles, their names and their contents are all built in
   * `panels/` — and the shell owns the *layout*, which is the split `panels/index.ts` states. So
   * this is a placement, not a second copy: the elements move, they are not duplicated, and every
   * panel's own `open()` keeps working because it holds the element it always held.
   *
   * **They used to be docked under the map, and moving them here is the phase's structural
   * change.** The map column then had two claimants and the map lost height whenever a panel
   * opened — measured at 900×1000, where opening the debug panel cut the map region from 915 px to
   * 546 px — which moves the box the camera clamps against and the click hit-test inverts *while
   * the player is playing*. The sidebar is the home of everything that is not a direct unit action
   * (the owner's design, §7.6 phase 3), and a side screen belongs with it; the stack of panels and
   * the dock share the strip rather than one of them taking the map's room. What the move buys,
   * beyond the map standing still, is that an opened panel still covers neither the map nor the
   * unit's orders — the two facts the green placement tests assert.
   */
  shell.dock.append(
    // M10's outcome screen goes first: it is the one dialog that is opened BY the game rather than
    // by the player, and it should land at the top of the dock, where the end of a game is
    // impossible to miss.
    panels.elements.outcomeDialog,
    panels.elements.cityDialog,
    panels.elements.techDialog,
    panels.elements.debugDialog,
  );

  /**
   * The unit action popup: **the panel's own group, moved beside the unit.**
   *
   * This used to be two lists — the shell's `Abilities for unit <id>` group (fortify plus one attack
   * per adjacent target) sitting beside the panel's `Actions for unit <id>` group (the engine's
   * enumerated actions plus fortify). Two lists meant two independent statements of "what may this
   * unit do?", and two independent labellers to go with them: the shell's `abilityLabel` ended in
   * `default: return command.type`, so a new command member would have reached the screen as its own
   * type name, while the panel's `actionLabel` ends in `assertNever` and stops the build (§3, idea
   * 12).
   *
   * The merge **deletes** the shell's list rather than combining two lists, because the panel's is
   * already a strict superset: `unitPanelCommands` is the engine's `unitActions` — which enumerates
   * one `AttackUnit` per adjacent legal target, `core/src/actions.ts:209` — followed by the queried
   * `FortifyUnit`. That is precisely why `unitQueriedActions` adds only fortify: adding attacks there
   * would offer the same command twice. Nothing the old group offered is lost, and a test in
   * `map.spec.ts` now asserts the superset rather than leaving it to a comment.
   *
   * It is a *placement*, not a second copy, exactly like the docked dialogs above: the panel owns the
   * element, its role, its frozen name (`Actions for unit <id>`, `docs/INTERFACES.md` M8) and its
   * contents; the shell owns where it sits. What the move buys is the owner's design — the orders a
   * unit can take appear next to that unit, over the map, instead of in a column at the far right of
   * the screen (§8 decision 1, §7.6 phase 2).
   */
  shell.mapRegion.append(panels.elements.unitActions);
  panels.elements.unitActions.dataset['floating'] = 'unit-actions';

  /**
   * Put the popup beside the selected unit, and keep it on the map.
   *
   * **Beside, never over.** The popup is placed in the ring around the unit's own tile, so the tile
   * a player is deciding about is never hidden by the menu they are deciding with — which is also
   * what keeps `panel-usability.spec.ts`'s "nothing covers the middle of the map" honest when the
   * selected unit is standing in the middle of the map, as it does at the start of a game.
   *
   * `position: fixed` with the canvas's own rectangle, rather than absolute positioning inside the
   * map region: the region is a padded, centred box with `container-type: size`, so an absolutely
   * positioned child needs that box's padding and border widths undone before canvas coordinates mean
   * anything. Measuring the canvas directly removes the arithmetic instead of getting it right.
   *
   * The size is read *after* the panel has rebuilt the buttons, so the flip and the clamp use the
   * popup's real width rather than a guess; a control that runs off the map is an order the player
   * cannot give.
   */
  const placeUnitActions = (): void => {
    const popup = panels.elements.unitActions;
    const unitId = panels.selection().unitId;
    const unit = unitId === undefined ? undefined : state.units.find((one) => one.id === unitId);
    const box = canvas.getBoundingClientRect();
    if (unit === undefined) {
      // Nothing selected: the group keeps its frozen empty name (`Actions for unit none`) and leaves
      // the map. Hidden rather than removed, so its role and name stay in the document the way the
      // M8 table describes them.
      popup.hidden = true;
      return;
    }
    popup.hidden = false;

    const size = tileScreenPx(camera);
    const at = tileToScreen(camera, indexToX(state.map, unit.tile), indexToY(state.map, unit.tile));
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const gap = UNIT_ACTIONS_GAP_PX;

    // Right of the tile by preference, then left, then clamped: the flip keeps the popup off the
    // tile it belongs to at the map's right edge, and the clamp keeps it on screen everywhere else.
    let left = box.left + at.x + size + gap;
    if (left + width > box.right) left = box.left + at.x - width - gap;
    let top = box.top + at.y;
    left = Math.max(box.left, Math.min(left, box.right - width));
    top = Math.max(box.top, Math.min(top, box.bottom - height));
    popup.style.left = `${String(left)}px`;
    popup.style.top = `${String(top)}px`;
  };

  /* ------------------------------ the readout ---------------------------- */

  /**
   * **The hover layer** (`docs/UI-OVERHAUL.md` §7.6 phase 6): what the tile under the pointer
   * yields, what the selected unit would spend to go there, and what the engine says an attack on it
   * would be. Every number comes from `ui/hover.ts`, which asks the engine and computes no rule of
   * its own — this half only says *when* to ask and *where* to put the answer.
   *
   * **Why it is a sibling of the canvas and `position: fixed`.** The same arrangement, and the same
   * reasons, as the orders popup above: a child of the padded, size-contained region would need that
   * box's padding and border undone before canvas coordinates meant anything, and measuring from the
   * pointer's own client coordinates removes the arithmetic instead of getting it right.
   *
   * **Why it never blocks the map.** It carries `pointer-events: none` (`styles.css`) — the rule
   * Phase 2 established for the popup, and for the same measured reason: a box floating over a
   * clickable map that can be hit is a box that eats the clicks aimed at the tiles beneath it. The
   * readout has no controls at all, so there is nothing that needs `auto` back, and
   * `elementFromPoint` at the middle of the map therefore still answers `CANVAS`
   * (`panel-usability.spec.ts` asserts exactly that, and this phase did not weaken it).
   *
   * It is shown only while the pointer is over the **canvas** — not merely inside the region — so a
   * pointer over the orders popup (which is a menu, not map) leaves the readout for the tile it was
   * last over… which is nothing: the readout is hidden, because the thing under the pointer is not
   * the map. What counts as "the tile under the pointer" is `screenToTile`, the one inverse mapping
   * the renderer's projection and the canvas's own `aria-description` already agree on.
   */
  let pointerAt: { readonly clientX: number; readonly clientY: number } | null = null;

  const hideReadout = (): void => {
    shell.tileReadout.hidden = true;
  };

  /**
   * Put the readout beside the pointer: right and below by preference, flipped at the map's edge,
   * then clamped inside the canvas so it can never leave the map's own box. Presentation only.
   */
  const placeReadout = (): void => {
    if (pointerAt === null || shell.tileReadout.hidden) return;
    const box = canvas.getBoundingClientRect();
    const width = shell.tileReadout.offsetWidth;
    const height = shell.tileReadout.offsetHeight;
    let left = pointerAt.clientX + READOUT_GAP_X_PX;
    if (left + width > box.right) left = pointerAt.clientX - width - READOUT_GAP_X_PX;
    let top = pointerAt.clientY + READOUT_GAP_Y_PX;
    if (top + height > box.bottom) top = pointerAt.clientY - height - READOUT_GAP_Y_PX;
    left = Math.max(box.left, Math.min(left, box.right - width));
    top = Math.max(box.top, Math.min(top, box.bottom - height));
    shell.tileReadout.style.left = `${String(left)}px`;
    shell.tileReadout.style.top = `${String(top)}px`;
  };

  /**
   * Read the tile under the pointer and say what the engine says about it.
   *
   * Called on every pointer move *and* from `redraw`, which is what makes the readout honest: the
   * state it describes can change without the pointer moving (a move, a new turn, a key that pans
   * the map), and a readout that only updated on `pointermove` would go on describing a tile the
   * camera had already moved away from. Nothing in this function dispatches, and `ui/hover.ts`
   * cannot change the state — it reads the engine, folds a command on a copy, and throws the copy
   * away — so a pointer that never clicks cannot play the game for the player.
   */
  const updateReadout = (): void => {
    if (pointerAt === null) {
      hideReadout();
      return;
    }
    const tile = tileAt(localPoint(pointerAt));
    if (tile === undefined) {
      hideReadout();
      return;
    }
    const seat = humanSeatOf(state) ?? asPlayerId(0);
    const index = asTileIndex(tile.y * state.map.width + tile.x);
    const readout = hoverReadout(state, ruleset, seat, panels.selection().unitId, index);
    const text = readoutText(readout);
    shell.tileReadout.textContent = text;
    // The whole sentence, for a long one that the box's own width would clip — the same arrangement
    // the order channel uses, and for the same reason.
    shell.tileReadout.title = text;
    shell.tileReadout.hidden = false;
    placeReadout();
  };

  /* ------------------------------ dispatching ---------------------------- */

  /**
   * **The order channel's text, and the goto the player has given.**
   *
   * The header's `Order` status carries the answer to the last thing the player tried to do — a
   * refusal, a goto that is under way, or a goto that was cancelled. `pendingGoto` is a destination
   * plus the route the engine planned for it, held **here and nowhere else**: it is not state, it is
   * never hashed, and it dies with the page. That is the shape `docs/UI-OVERHAUL.md` §7.4 (b)
   * decides on, and §8 names its price: a pending goto emits dispatches a headless script would not
   * contain, which is why the determinism fixtures contain no goto at all. See
   * `determinism.spec.ts`, where that is stated where it is relied on.
   */
  let pendingGoto: GotoIntent | undefined;
  /**
   * Whether an advance is already running. The loop dispatches through `armDispatch`, which reaches
   * `dispatchCommand`, which is also what cancels a goto when the player gives that unit another
   * order — so the loop has to be able to tell its own steps from the player's.
   */
  let advancingGoto = false;

  /** Say what happened to the last order, in the one place the player reads it. */
  const setOrderMessage = (text: string): void => {
    shell.orderStatus.textContent = text;
    // The full sentence, for when the line is ellipsised on a narrow window: the channel is one line
    // by construction (see `buildShell`), so the title is where a long message stays readable.
    if (text === '') shell.orderStatus.removeAttribute('title');
    else shell.orderStatus.title = text;
  };

  /** A tile as the rest of the app writes one: the map's own x,y. */
  const tileText = (index: number): string =>
    `${String(indexToX(state.map, index))},${String(indexToY(state.map, index))}`;

  /**
   * Apply a command through the real applier, then bring the screen up to date.
   *
   * Returns the engine's own events beside the outcome: the log can only render what it is
   * handed, and reconstructing it by diffing states would be the UI deciding what happened (see
   * `panels/index.ts`). A refusal changes nothing — no state, no events — and is reported as
   * `'refused'` rather than thrown, so a caller can prove the refusal was the engine's.
   *
   * **A refusal is now also said out loud**, which §1.4 measured as missing: the engine's typed
   * `GameError` used to be discarded here, so a click the engine turned down looked exactly like a
   * frozen game. It goes to the order channel in the engine's own terms (`ui/problem.ts`), and the
   * channel is cleared when an order is accepted, because a stale `refused` beside a unit that has
   * just moved is a claim about the present that is no longer true.
   */
  function dispatchCommand(
    command: Command,
    forSeat?: PlayerId,
  ): {
    readonly outcome: 'ok' | 'refused';
    readonly events: readonly GameEvent[];
  } {
    const seat = forSeat ?? humanSeatOf(state);
    if (seat === undefined) return { outcome: 'refused', events: [] };

    // An order given to the unit that is walking somewhere replaces that goto — the player has just
    // said what the unit should do instead. Silent, because the player did it, and *before* the
    // apply, so that even a refused order cancels the old plan rather than leaving the unit
    // committed to a journey the player has abandoned. `advancingGoto` is what keeps this from
    // cancelling the goto's own steps.
    if (!advancingGoto && pendingGoto !== undefined) {
      if (unitNamedBy(command) === pendingGoto.unitId) pendingGoto = undefined;
    }

    // Clear first: the buffer belongs to the call about to happen, so a refusal cannot leave the
    // previous command's events for the panels' dispatch to render again.
    lastEvents = [];
    const outcome = applyCommand(state, seat, command, ruleset);
    if (!outcome.ok) {
      setOrderMessage(problemText(outcome.error));
      // The panels still re-render: a refusal is a normal answer, and a control that must not
      // change has to be rebuilt from the state that did not change.
      panels.refresh();
      placeUnitActions();
      return { outcome: 'refused', events: [] };
    }

    state = outcome.value.state;
    lastEvents = outcome.value.events;
    setOrderMessage('');
    // The log is appended **here and nowhere else**: every path into the engine — a panel button,
    // an ability button, a map click, the `End turn` button, the seam — runs through
    // `dispatchCommand`, so one append per accepted command is one statement of "what happened".
    logEvents(outcome.value.events);
    panels.refresh();
    placeUnitActions();
    redraw();
    return { outcome: 'ok', events: outcome.value.events };
  }

  /**
   * Walk a pending goto as far as this turn allows, one engine-offered step at a time.
   *
   * `nextGotoStep` decides (`ui/goto.ts`, and its unit test is where the decisions are pinned); this
   * function only *executes* the decision and says what happened. Five things are worth stating
   * here, because each is a way this could have been wrong:
   *
   * - **Steps go through `armDispatch`, never around it.** A goto step is a command this app issues
   *   on its own initiative, which is exactly the kind of dispatch the seam's instrumentation must
   *   see: a test's `recordDispatches` wrapper observes a goto step the same way it observes a
   *   button press, so "the UI issued this" stays checkable. Applying it through `dispatchCommand`
   *   directly would have hidden every step from the dispatch log.
   * - **The loop terminates because each step consumes a step of the stored route**, and it stops the
   *   moment the engine offers nothing (the unit is out of movement) rather than spinning.
   *   `advancingGoto` is a belt on that brace: a re-entrant call cannot start a second loop.
   * - **A refusal cancels the goto**, with the engine's reason — the same rule as an invalidated
   *   route, and for the same reason: nothing is retried behind the player's back. The channel
   *   already carries the engine's sentence, because `dispatchCommand` wrote it.
   * - **An invalidated route cancels and says so** (§8 decision 4). `ui/goto.ts` decides that; here
   *   the sentence is assembled, naming the tile in the map's own coordinates.
   * - **A finished game ends the loop before it dispatches anything.** M10 refuses every command once
   *   a game is over, and a goto that kept trying would fill the channel with `game-over` refusals
   *   for a game that has already ended.
   */
  function advanceGoto(): void {
    if (advancingGoto) return;
    advancingGoto = true;
    try {
      while (pendingGoto !== undefined) {
        if (isGameOver(state, ruleset)) {
          pendingGoto = undefined;
          break;
        }
        const decision = nextGotoStep(state, ruleset, pendingGoto);
        if (decision.kind === 'step') {
          pendingGoto = decision.intent;
          const outcome = armDispatch(decision.command);
          if (outcome !== 'ok') {
            pendingGoto = undefined;
            break;
          }
          continue;
        }
        if (decision.kind === 'waiting') {
          // The intent stands and the unit is out of movement for it: not a cancellation but the
          // next turn's work, and saying so is what stops this silence from reading as a broken
          // order.
          setOrderMessage(`heading for tile ${tileText(pendingGoto.destination)}`);
          break;
        }
        if (decision.kind === 'cancelled') {
          setOrderMessage(
            `the goto to tile ${tileText(pendingGoto.destination)} is cancelled: ${decision.detail}`,
          );
          pendingGoto = undefined;
          break;
        }
        // `arrived` — the unit is there, and an accepted step has already cleared the channel.
        // `gone` — the unit is not in the state any more, and a message about a unit that is not
        // there would be noise. Both discharge the intent and say nothing.
        pendingGoto = undefined;
        break;
      }
    } finally {
      advancingGoto = false;
    }
  }

  /**
   * Drop the intent without a word: a new game, a load, or a game that has ended leaves nothing for
   * a goto to be about, and a message about the old game's journey would be a claim about the new
   * one.
   */
  const forgetGoto = (): void => {
    pendingGoto = undefined;
    setOrderMessage('');
  };

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
    // The ENGINE's layered merge, not a spread. `{...settings, ...{ai: {opponent: 'off'}}}`
    // replaces the whole `ai` object, drops `aggression` and `expandFast`, and the strict schema
    // then refuses the lot — so the caller's intent vanished and the setting looked inert while
    // not being applied either. One statement of what merging settings means, and it is the
    // engine's.
    const merged = parseSettings(
      mergeSettings(state.settings, mergeSettings(isRecord(options) ? options : {}, { seed })),
    );
    if (!merged.ok) return;
    state = startGame(merged.value);
    camera = openingCamera(state);
    cursor = null;
    panels.log.clear();
    panels.selectUnit(undefined);
    panels.selectCity(undefined);
    // A new game is a new world: the old game's pending goto and its message are about a board that
    // no longer exists.
    forgetGoto();
    panels.refresh();
    placeUnitActions();
    redraw();
  }

  /* ------------------------------- the map ------------------------------- */

  const localPoint = (at: { readonly clientX: number; readonly clientY: number }): ScreenPoint => {
    const rect = canvas.getBoundingClientRect();
    // No scale factor, and that is a real simplification rather than an omission. `draw` paints in
    // the CSS pixels of the measured box (`viewport()`), so a client point minus the box's origin is
    // *already* in the coordinate space the tiles were projected into. The old
    // `CANVAS_WIDTH_PX / rect.width` factor existed to undo a stylesheet that stretched a canvas
    // whose CSS size was its own pixel size; the layout owns the CSS size now, so there is nothing
    // to undo — and any factor here would be a second opinion about the size the renderer used.
    return { x: at.clientX - rect.left, y: at.clientY - rect.top };
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

  /**
   * Which element each map gesture is bound to — and they are deliberately not all the same one.
   *
   * The canvas and the unit action popup are **siblings** inside the map region, because the popup
   * is placed over the map. That single fact decides the whole split:
   *
   * - `click` and `pointerdown` stay on the **canvas**. A press on the popup therefore never reaches
   *   the map's click handler — the canvas is not an ancestor of the popup, so the event does not
   *   travel through it — which is what stops a button press from also ordering the unit onto
   *   whatever tile happens to lie beneath the menu. The DOM gives that guard for free, which is why
   *   there is no "was this click inside the popup?" test in the handler below.
   * - everything else belongs to the **region**: the wheel, the pointer move, the release and the
   *   leave. Bound to the canvas, each goes dark the moment the pointer crosses the popup, and that
   *   was measured rather than reasoned about. With the wheel still on the canvas, a wheel over the
   *   popup stopped zooming ("a wheel event over the map did not change the zoom at all"), and a
   *   pointer move over it left the map's own description reading "pointer over no tile". The worst
   *   of the four was `pointerup`: a drag that ENDED over the popup never ended, leaving the map
   *   stuck to the pointer.
   *
   * The rule underneath: gestures that START something new belong to the map's own surface, and
   * gestures that continue or end something already running belong to the region holding both.
   */
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    travelled = 0;
    lastX = event.clientX;
    lastY = event.clientY;
  });

  shell.mapRegion.addEventListener('pointermove', (event) => {
    // The hover layer follows the pointer, and **only while the pointer is over the canvas**. The
    // region is bigger than the canvas (it has padding) and it also holds the orders popup, so
    // "inside the region" is not the same question as "over the map": a tile readout under a menu
    // would be describing the ground beneath a control the player is about to press. `target` is the
    // browser's own answer to which element the pointer is over, so this needs no geometry — and a
    // pointer that leaves the canvas takes the readout away with it.
    pointerAt = event.target === canvas ? { clientX: event.clientX, clientY: event.clientY } : null;
    updateReadout();
    const tile = tileAt(localPoint(event));
    const next = tile === undefined ? null : { x: tile.x, y: tile.y };
    if (next?.x !== cursor?.x || next?.y !== cursor?.y) {
      cursor = next;
      draw();
    }
    // The readout is positioned from the pointer, so a move *within* one tile still moves it; the
    // content above is only recomputed when the pointer moves at all, which is what keeps a hover
    // over a defended tile from folding a battle on every frame the camera moves.
    placeReadout();
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
  shell.mapRegion.addEventListener('pointerup', endDrag);
  shell.mapRegion.addEventListener('pointercancel', endDrag);
  shell.mapRegion.addEventListener('pointerleave', () => {
    dragging = false;
    cursor = null;
    // The pointer is gone, so there is no tile under it and nothing to read out. The readout is a
    // claim about *the pointer's* tile, and leaving a stale one behind would be a claim about a
    // pointer that is no longer over the map.
    pointerAt = null;
    hideReadout();
    draw();
  });

  shell.mapRegion.addEventListener(
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

  /* ------------------------------ the keyboard --------------------------- */

  /**
   * **THE KEYBOARD CONTRACT, wired.** The bindings themselves are `ui/keys.ts` — one table, which
   * the help panel is rendered from as well, so this half cannot drift from what the player is told.
   * What is here is the three things a table cannot state:
   *
   * 1. **Where each half is bound.** The session keys (`Space`, `Enter`, `Escape`) are the
   *    document's, because a player should not have to focus the map to advance a unit; the map keys
   *    are the **region's**, so a keydown reaches them only when the focus is already inside the map
   *    and the arrows cannot be taken away from a scrollable panel. That split is structural — the
   *    listener placement *is* the guard — which is why `ui/keys.ts`'s resolver takes "is a dialog
   *    open" for the session half and not for the map half.
   * 2. **What the page looks like when the key arrives.** A `keydown` carries the key and the
   *    modifiers; the two facts the deferral rule also needs (is a text field focused, is a dialog
   *    open) are read here, because they are facts about a DOM and `ui/keys.ts` deliberately knows
   *    nothing about one.
   * 3. **`preventDefault` only when the key is ours.** Nothing is prevented for a key the contract
   *    does not claim, so `Tab`, `PageDown`, `F5` and every browser shortcut behave exactly as they
   *    did before this phase — the one thing the brief for it asked for by name.
   */
  const isTextEntry = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  };

  const keyContext = (event: KeyboardEvent, dialogOpen: boolean): KeyContext => ({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    inTextField: isTextEntry(event.target),
    dialogOpen,
  });

  /**
   * Pan the view by whole tiles — the keyboard's half of a drag.
   *
   * `panCamera` is the projection module's own pan, and the sign is the one the drag handler uses:
   * the camera moves by `-dx / tileSize`, so asking for the view to move right means a negative
   * delta here. Expressing it as tiles rather than pixels is the whole point of the binding: a key
   * press is not a gesture with a distance, and "one tile" is the unit a player can see.
   */
  const panByTiles = (tilesX: number, tilesY: number): void => {
    const size = tileScreenPx(camera);
    camera = panCamera(camera, extent(), viewport(), -tilesX * size, -tilesY * size);
    redraw();
  };

  /** Zoom one step, anchored on the middle of the view — the keyboard's half of the wheel. */
  const zoomByStep = (steps: number): void => {
    const size = viewport();
    camera = zoomCamera(camera, extent(), viewport(), steps, {
      x: size.width / 2,
      y: size.height / 2,
    });
    redraw();
  };

  shell.mapRegion.addEventListener('keydown', (event) => {
    // No dialog clause: this listener only hears keys aimed at the map (see the note above), and a
    // side panel does not suspend the map it is docked beside.
    const action = mapActionFor(keyContext(event, false));
    if (action === undefined) return;
    event.preventDefault();
    switch (action) {
      case 'pan-left':
        panByTiles(-1, 0);
        return;
      case 'pan-right':
        panByTiles(1, 0);
        return;
      case 'pan-up':
        panByTiles(0, -1);
        return;
      case 'pan-down':
        panByTiles(0, 1);
        return;
      case 'zoom-in':
        zoomByStep(1);
        return;
      case 'zoom-out':
        zoomByStep(-1);
        return;
    }
  });

  /**
   * Cancel the pending goto, and say so — Phase 4's owed item, paid here.
   *
   * §9 of the plan records the debt in the phase that created it: *"no way to cancel a goto except
   * by giving the unit another order … and no Escape binding — Phase 5 owns the keyboard."* An
   * `Escape` with no goto pending is deliberately **silent**: there is nothing to cancel and nothing
   * to apologize for, and a message about a journey nobody is on would be exactly the sort of claim
   * this app does not make. The intent is dropped without a dispatch, because a goto is UI memory
   * and cancelling it is not an order the engine has any part in.
   */
  const cancelGoto = (): void => {
    if (pendingGoto === undefined) return;
    setOrderMessage(`the goto to tile ${tileText(pendingGoto.destination)} is cancelled`);
    pendingGoto = undefined;
  };

  /**
   * **The next-unit flow** (`ui/nextunit.ts` decides; this executes).
   *
   * Selecting a unit is navigation and issues nothing (§2.A), so this dispatches nothing: it moves
   * the selection and, when the unit is off screen, the camera. That second half has a rule worth
   * stating — **the view follows only when it has to**: a player cycling two units that are both on
   * screen should be able to watch both, and a camera that jumped on every press would make the map
   * impossible to read. So the camera is re-centred only when the next unit's tile is not wholly
   * within the canvas, which is measured against the same projection the renderer drew with.
   *
   * The answer "there is no next unit" is said out loud, in the order channel, because silence from
   * a key that is supposed to do something is indistinguishable from a broken key. Which of the two
   * sentences it says is the engine's count, not a guess: no unit needs orders at all, or every unit
   * that does is the one already selected.
   */
  function advanceToNextUnit(): void {
    const seat = humanSeatOf(state);
    if (seat === undefined) return;
    const from = panels.selection().unitId;
    const next = nextUnitNeedingOrders(state, ruleset, seat, from);
    if (next === undefined) {
      const waiting = unitsNeedingOrders(state, ruleset, seat).length;
      setOrderMessage(waiting === 0 ? 'no unit needs orders' : 'no other unit needs orders');
      return;
    }
    panels.selectUnit(next);
    const unit = state.units.find((each) => each.id === next);
    if (unit !== undefined && !tileIsOnScreen(unit.tile)) {
      camera = centreOnTile(camera, extent(), viewport(), {
        x: indexToX(state.map, unit.tile),
        y: indexToY(state.map, unit.tile),
      });
    }
    placeUnitActions();
    redraw();
  }

  /** Whether a tile is wholly inside the canvas — the question "does the view have to follow?". */
  const tileIsOnScreen = (tile: TileIndex): boolean => {
    const size = tileScreenPx(camera);
    const at = tileToScreen(camera, indexToX(state.map, tile), indexToY(state.map, tile));
    const box = viewport();
    return at.x >= 0 && at.y >= 0 && at.x + size <= box.width && at.y + size <= box.height;
  };

  shell.nextUnit.addEventListener('click', () => {
    advanceToNextUnit();
  });

  shell.keyboard.open.addEventListener('click', () => {
    shell.keyboard.dialog.show();
  });

  doc.addEventListener('keydown', (event) => {
    const dialogOpen = doc.querySelector('dialog[open]') !== null;
    const action = sessionActionFor(keyContext(event, dialogOpen));
    if (action === undefined) return;
    // Ours, so the browser's default goes: Space would scroll the page and Enter would re-press
    // whatever has focus, and both are the app's now (the deferral rule has already given them back
    // to a field, a dialog and every modified press).
    event.preventDefault();
    if (action === 'next-unit') {
      advanceToNextUnit();
      return;
    }
    if (action === 'end-turn') {
      // **The button's own click, not a second statement of ending a turn.** Playing the opponent
      // seats, dispatching `EndTurn`, resuming a goto — all of it is that listener, so the key
      // cannot end a turn differently from the control, and a test's dispatch instrumentation sees
      // exactly what it sees for a press. A disabled button (a finished game) fires nothing, which
      // is the engine's own `isGameOver` answer rather than a second guard here.
      shell.endTurn.click();
      return;
    }
    cancelGoto();
  });

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
   * 4. **a tile further away than one step starts a goto** (Phase 4, `docs/UI-OVERHAUL.md` §7.6):
   *    the engine's route query (`@civts/core`'s `planRoute`) is asked, and if it finds a route the
   *    destination is held as UI intent and the unit starts walking it, one engine-offered step at a
   *    time, resuming after each `End turn`. When the query finds **no** route, the click falls
   *    through to the bare `MoveUnit` below rather than becoming a silent no-op;
   * 5. an empty tile with nothing to route to is still dispatched as a `MoveUnit`, and the engine
   *    refuses it — which the order channel now *shows*, in the engine's own words, where §1.4
   *    measured that nothing was shown at all. A refusal leaves the state untouched;
   * 6. a tile outside the map, or one held by somebody else with nothing to attack, leaves the
   *    state alone rather than asking the engine a question whose answer is already known.
   *
   * What is deliberately **not** here: goto-then-attack. §8 decision 2 settles that a distant enemy
   * does nothing, so a goto's destination is always ground the unit may stand on, and an
   * enemy-occupied tile is refused by the route query like any other unenterable tile.
   */
  canvas.addEventListener('click', (event) => {
    // M10: an ended game issues no orders. A map click is a command like any other, so it stops
    // here rather than being dispatched and refused — the map is still there to be looked at, and
    // selecting a unit or opening one of your cities below is navigation, not a command, so those
    // two remain (see the guards on the branches themselves).
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
    // M10: the engine refuses every command once a game has ended, so the two branches below that
    // would ISSUE an order are skipped. The two that only LOOK — opening one of your own cities and
    // selecting one of your own units — still run: a final position is a position a player is
    // entitled to inspect, and neither of them dispatches anything.
    const over = isGameOver(state, ruleset);

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
    if (!over && selected !== undefined) {
      const ordered = unitActions(state, ruleset, selected).find(
        (command) => tileNamedBy(command) === index,
      );
      if (ordered !== undefined) {
        armDispatch(ordered);
        return;
      }
    }

    const own = state.units.find((unit) => unit.tile === index && unit.owner === seat);
    if (own !== undefined) {
      panels.selectUnit(own.id);
      placeUnitActions();
      redraw();
      return;
    }

    const occupied =
      state.units.some((unit) => unit.tile === index) ||
      state.cities.some((candidate) => candidate.tile === index);
    if (occupied || over) return;

    // **A far tile: the goto.** The engine's own route query decides whether this is a journey it
    // can make, and the destination is then held here as intent — `advanceGoto` walks it, one step
    // per turn, through the seam like any other control. `no-route` deliberately falls through to
    // the bare `MoveUnit` below: the engine's refusal is the player's answer, and nothing about
    // goto may turn a click that reaches nowhere into a click that says nothing. (`over` is not
    // re-checked: the `occupied || over` guard above has already returned for a finished game.)
    if (selected !== undefined) {
      const began = startGoto(state, ruleset, selected, asTileIndex(index));
      if (began.kind === 'started') {
        pendingGoto = began.intent;
        advanceGoto();
        return;
      }
    }

    // An empty tile the unit's own list did not name and the route query could not reach: the
    // command is issued anyway so the engine can refuse it out loud. The index is inside the map —
    // `screenToTile` returned it — and `asTileIndex` is the engine's own constructor for the branded
    // id rather than an escape from the type system. When the seat owns no unit at all the sentinel
    // id is refused as `unknown-unit`: a refusal either way, never a silent no-op dressed up as
    // success.
    armDispatch({
      type: 'MoveUnit',
      unitId: selected ?? asUnitId(-1),
      to: asTileIndex(index),
    });
  });

  /**
   * Let every civilization that is not the human's take its turn.
   *
   * This mirrors `runSimulation`'s ordering exactly — each policy seat asks its policy for
   * commands, and every command goes through `applyCommand` — because the runner already states
   * how a policy seat is played and a second statement of it here would be a second opponent.
   * The policy draws from its OWN stream, derived from the game seed, and never from
   * `state.rng`: if it consumed the world's stream then switching the opponent on would change
   * the map and the battles, and the browser game could not be compared with the headless one.
   *
   * Called when the human ends their turn and BEFORE the turn advances, which is the runner's
   * order: every seat acts, and only then does the turn move on. A policy's own `EndTurn` is
   * skipped for the same reason the runner skips it — the turn boundary belongs to the engine.
   */
  function playOpponentSeats(): void {
    if (opponentModeOf(state.settings) === 'off') return;
    const human = humanSeatOf(state);
    for (const player of state.players) {
      if (player.kind !== 'civ' || player.id === human) continue;
      const proposed = SMART_POLICY.chooseCommands({
        state,
        playerId: player.id,
        ruleset,
        rng: policyRngFor(state.settings.seed, player.id, state.turn),
      });
      for (const command of proposed) {
        if (command.type === 'EndTurn') continue;
        // Through the seam, carrying the acting seat. The dispatch log then shows the rival's
        // commands as accepted commands naming its own units and cities — which is the only
        // evidence that distinguishes an opponent from a counter that moved on its own.
        armDispatch({ ...command, seat: player.id });
      }
    }
    // The human must SEE what the rival did: the log is the engine's own story of the game, and an
    // opponent that acts invisibly is indistinguishable from one that does nothing.
    panels.refresh();
    placeUnitActions();
    redraw();
  }

  shell.endTurn.addEventListener('click', () => {
    playOpponentSeats();
    armDispatch({ type: 'EndTurn' });
    // **A goto resumes at the turn boundary**, and this is the only place it can: `EndTurn` refills
    // every unit's movement (`turn.ts` `refillMovement`), and the step the route query named may
    // have been unaffordable with what was left of the last turn. A goto whose route the rival's
    // move has closed cancels here, with the message the channel carries — which is the case §8
    // decision 4 is about, and the one a player meets most often.
    advanceGoto();
  });

  /* --------------------------- the new-game surface ---------------------- */

  /**
   * The patch the new-game controls describe. It is an `unknown` on purpose: it goes to the
   * engine's parser exactly as a settings file would, so nothing in this file claims to know what
   * a legal game is.
   */
  const chosenSettings = (): Record<string, unknown> => ({
    seed: Number(shell.newGame.seed.value),
    mapSize: shell.newGame.mapSize.value,
    civCount: Number(shell.newGame.civCount.value),
    ai: {
      ...state.settings.ai,
      opponent: shell.newGame.opponent.checked ? 'policy' : 'off',
    },
  });

  shell.newGame.open.addEventListener('click', () => {
    shell.newGame.problem.textContent = '';
    shell.newGame.dialog.show();
  });

  shell.newGame.start.addEventListener('click', () => {
    // The ENGINE decides whether these are settings and the UI only reports its answer. A check
    // written here would be a second statement of what a legal game is, and an empty or
    // non-numeric field is refused by the same parser rather than by a guard beside it.
    const patch = chosenSettings();
    const merged = parseSettings({ ...state.settings, ...patch });
    if (!merged.ok) {
      const [first] = merged.error;
      shell.newGame.problem.textContent = `the engine refused these settings: ${
        first === undefined ? 'no reason given' : `${first.path} ${first.message}`
      }`;
      return;
    }
    shell.newGame.problem.textContent = '';
    shell.newGame.dialog.close();
    reseed(merged.value.seed, patch);
  });

  /* ------------------------------- the seam ------------------------------ */

  const seam = installTestApi({
    state: () => state,
    playerId: () => humanSeatOf(state),
    ruleset,
    dispatch: (command, forSeat) => dispatchCommand(command, forSeat),
    lastEvents: () => lastEvents,
    seed: (seed, options) => {
      reseed(seed, options);
    },
    settings: () => state.settings,
    replaceState: (next) => {
      state = next;
      // A loaded game is a different world, and the goto held against the old one describes a board
      // that is gone. The intent is UI memory with no place in a save (`docs/UI-OVERHAUL.md` §7.4),
      // so loading cannot restore it and must not pretend to: it is dropped, and the channel says
      // nothing rather than something about a journey nobody is on.
      forgetGoto();
      panels.refresh();
      placeUnitActions();
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
  camera = openingCamera(state);
  panels.refresh();
  placeUnitActions();
  redraw();

  /* ------------------------------ resizing ------------------------------- */

  /**
   * Re-clamp the camera and repaint when the map's box changes.
   *
   * A fluid map can shrink *under* a camera that was clamped for a larger one, and `clampCamera` is
   * what stops the view walking off the map's edge. Without this, resizing the window would leave
   * the camera pointing at empty space beyond the map — and the hit-test would then faithfully
   * invert a camera aimed at nothing, so every click would resolve to a tile that is not shown. The
   * clamp is the fix; the repaint is only so the player sees it.
   *
   * `ResizeObserver` rather than a window listener, because the box can change without the window
   * changing: a scrollbar appearing in the sidebar's panel stack takes width off the strip and
   * therefore width off the map. (It used to be the dock growing under the map, which Phase 3 moved
   * into the sidebar — the observer is the same one either way.) The window listener stays as the
   * fallback for a browser without the observer, and is harmless where both exist — `measureCanvas`
   * returns `false` when nothing moved, so the second caller does nothing.
   *
   * Wired *after* the first `redraw`, so the initial size is established by the normal paint path.
   *
   * **Unconditional, and that is the whole point of the function.** The obvious version skips the
   * work when `measureCanvas` reports the size did not change — and that version is broken, which
   * was measured rather than reasoned about. `draw` calls `measureCanvas` too, so any repaint
   * between the layout change and this callback (the pointer events of a drag are enough) consumes
   * the change first; this handler then sees "nothing changed", returns early, and the camera is
   * *never* clamped. Measured: at 900×1000 the camera sat at 52.97, widening the window to 1600×700
   * made 50.67 the legal limit, and the camera stayed at 52.97 indefinitely — while a later resize
   * with no intervening repaint clamped correctly, so the defect showed up intermittently and would
   * have read as a flake. `clampCamera` is idempotent, so calling it unconditionally is both correct
   * and immune to that coupling.
   */
  const onViewportChanged = (): void => {
    // Keep the size current, then clamp against it. `measureCanvas` leaves the previous size in
    // place when the canvas is not laid out (a zero box), so this cannot clamp against nothing.
    measureCanvas();
    camera = clampCamera(camera, extent(), viewport());
    redraw();
  };

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(onViewportChanged).observe(canvas);
  }
  window_?.addEventListener('resize', onViewportChanged);
};

/** A `ViewportSize` from any state's map — the extent `clampCamera` and friends take. */
const extentOf = (state: GameState): ViewportSize => ({
  width: state.map.width,
  height: state.map.height,
});

/**
 * Put a failed boot on the page instead of leaving it blank.
 *
 * `start` is async because it decodes the art before the first frame, so a rejected promise is now
 * a possible outcome of a page load. `void start()` would turn a missing or corrupt asset into an
 * empty page with nothing but a console message — and `tiles.ts` claims a bad tile is "a broken
 * build, not a silent flat colour", which is only true if somebody is actually told. This is the
 * telling.
 */
const reportStartFailure = (error: unknown): void => {
  const doc = document;
  const banner = el(doc, 'div');
  banner.id = 'civts-start-failure';
  banner.setAttribute('role', 'alert');
  const heading = el(doc, 'h2', 'CivTS could not start');
  const detail = el(doc, 'p', error instanceof Error ? error.message : String(error));
  const hint = el(
    doc,
    'p',
    'A missing or unreadable art asset is the usual cause. Reload once before assuming the ' +
      'worst; the browser console has the full error.',
  );
  banner.append(heading, detail, hint);
  doc.body.replaceChildren(banner);
};

start().catch((error: unknown) => {
  console.error(error);
  reportStartFailure(error);
});
