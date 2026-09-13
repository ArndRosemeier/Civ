/**
 * Shared fixtures and accessors for the M8 end-to-end suite (W3).
 * See docs/INTERFACES.md, M8 ("The test seam", "The accessibility contract",
 * "Rendering, and how it is tested").
 *
 * ## What this file is for
 *
 * Three jobs, and nothing else:
 *
 * 1. **Wrap the frozen test seam** (`window.__CIVTS__`) so a spec reads the
 *    ENGINE's answer — `state()`, `stateHash()`, `actionsFor()`, `dispatch()` —
 *    rather than guessing from panel text or pixels. Everything a spec asserts
 *    about the game comes through here.
 * 2. **Name the frozen accessibility contract once.** Every locator below is
 *    `getByRole` + accessible name, exactly as the contract's table spells them,
 *    so a restyle cannot break the suite and the two workstreams could be built in
 *    parallel. No locator here uses a CSS class or a DOM position, and none may
 *    start to: the contract exists so that the tests survive the markup.
 * 3. **Provide the presentation probes the contract mandates** — pixel sampling at
 *    a tile's centre, the deterministic draw trace, and the page↔tile projection.
 *
 * ## One mapping, not two
 *
 * `docs/INTERFACES.md` is explicit that "Click hit-testing converts a page
 * coordinate to a tile through the SAME function the renderer uses — a second
 * inverse mapping is a bug waiting to happen and must not exist." So this file
 * does not re-derive the projection: it imports the app's own camera module
 * (`../src/view.ts`, whose header states the same rule) and uses `tileToScreen` /
 * `screenToTile` for every coordinate a spec computes. The one thing the suite
 * supplies independently is the CAMERA's current value, which is presentation
 * state and is read from the app through a documented probe (see `cameraOf`).
 */

import { expect, type Locator, type Page } from '@playwright/test';

import {
  applyCommand,
  asCityId,
  asImprovementId,
  asPlayerId,
  asBuildingId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  DEFAULT_SETTINGS,
  newGame,
  parseSettings,
  type Command,
  type GameState,
  type PlayerId,
  type ProductionItem,
  type Result,
  type Settings,
  type SetupError,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

import {
  screenToTile,
  tileScreenPx,
  tileToScreen,
  visibleTileBounds,
  type Camera,
} from '../src/view.js';

/* ------------------------------------------------------------------ *
 * The frozen test seam
 * ------------------------------------------------------------------ */

/**
 * `window.__CIVTS__` — the interface docs/INTERFACES.md freezes for this suite.
 *
 * The three trailing optional members are *not* part of the frozen list: they are
 * the presentation-side extras the rendering section requires the app to expose
 * (the draw trace) and the camera a hit-test needs. They are declared optional so
 * that a missing one is a clean test failure with a named message rather than a
 * silent `undefined` — see `drawTraceOf` and `cameraOf`, which report exactly what
 * they looked for and what they found.
 */
/**
 * The seam's shape, as the app declares it: `src/testapi.ts` owns the interface and the one
 * `declare global` for `window.__CIVTS__`.
 *
 * Declaring it again here would be a second contract for one property. TypeScript rejects two
 * augmentations of one global that are not textually identical, and two hand-written copies of a
 * frozen interface are exactly the pair that drifts — the suite's copy would keep compiling after
 * the app had moved. `src/testapi.ts` spells the frozen members exactly as `docs/INTERFACES.md`
 * freezes them, with the three presentation-side extras (draw trace, camera, palette) as
 * *optional* members, so a missing one is a clean failure with a named message from
 * `drawTraceOf`/`cameraOf` rather than a compile error in the suite.
 */
export type { CivtsTestApi } from '../src/testapi.js';

declare global {
  interface Window {
    /** Installed by `recordDispatches`: every dispatch this page has seen. */
    __CIVTS_DISPATCH_LOG__?: { action: unknown; result: 'ok' | 'refused' }[];
  }
}

/* ------------------------------------------------------------------ *
 * Opening the app, and the state it exposes
 * ------------------------------------------------------------------ */

export const READY_TIMEOUT_MS = 30_000;

/** Wait until the app reports `ready === true` (the first frame has been drawn). */
export const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__CIVTS__?.ready === true, undefined, {
    timeout: READY_TIMEOUT_MS,
  });
};

/**
 * Load the app and wait for its first frame.
 *
 * The `ready` flag is the contract's own statement of "the first frame is drawn",
 * so waiting on it is the substitute for waiting on a pixel or on a network idle
 * state, neither of which the contract offers.
 */
export const openApp = async (page: Page): Promise<void> => {
  await page.goto('/');
  await waitForApp(page);
};

/* ------------------------------------------------------------------ *
 * Reading the engine's state — narrow, validated views of it
 *
 * The seam hands back `unknown` on purpose (it is `state(): unknown`), so this is
 * where the suite turns that into typed data. The guards below reject a
 * malformed state with a message naming the field, which is what makes a shape
 * change a clear failure instead of an `undefined` propagating into an assertion.
 * ------------------------------------------------------------------ */

export interface UiUnit {
  readonly id: number;
  readonly owner: number;
  readonly tile: number;
  readonly type: string;
  readonly movementLeft: number;
  readonly fortified: boolean;
  readonly hitPointsLeft: number;
  readonly working: boolean;
}

export interface UiProductionItem {
  readonly kind: string;
  readonly id: string;
}

export interface UiCity {
  readonly id: number;
  readonly owner: number;
  readonly name: string;
  readonly tile: number;
  readonly population: number;
  readonly shields: number;
  readonly production: UiProductionItem | undefined;
  readonly queue: readonly UiProductionItem[];
  readonly buildings: readonly string[];
  readonly workedTiles: readonly number[];
  readonly foodBox: number;
}

export interface UiPlayer {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly color: string;
  readonly treasury: number;
  readonly beakers: number;
  readonly luxuries: number;
  readonly techs: readonly string[];
  readonly researching: string | undefined;
}

export interface UiMap {
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly string[];
}

export interface UiState {
  readonly revision: number;
  readonly turn: number;
  readonly seed: number;
  readonly map: UiMap;
  readonly players: readonly UiPlayer[];
  readonly units: readonly UiUnit[];
  readonly cities: readonly UiCity[];
  /** One row per player, indexed by player id: the tiles that player has seen. */
  readonly explored: readonly (readonly boolean[])[];
  /** The settings this game was started with — the engine's own stored settings. */
  readonly settings: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (what: string, value: unknown): never => {
  throw new Error(`state field ${what} is not the expected shape: ${JSON.stringify(value)}`);
};

const asNumber = (value: unknown, what: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(what, value);

const asString = (value: unknown, what: string): string =>
  typeof value === 'string' ? value : fail(what, value);

const asArray = (value: unknown, what: string): readonly unknown[] =>
  Array.isArray(value) ? value : fail(what, value);

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const uiProductionItem = (value: unknown, what: string): UiProductionItem => {
  if (!isRecord(value)) return fail(what, value);
  return { kind: asString(value['kind'], `${what}.kind`), id: asString(value['id'], `${what}.id`) };
};

const optionalProductionItem = (value: unknown, what: string): UiProductionItem | undefined =>
  value === undefined ? undefined : uiProductionItem(value, what);

/** Narrow the seam's `unknown` state into the typed view above, or fail loudly. */
export const asUiState = (raw: unknown): UiState => {
  if (!isRecord(raw)) return fail('state', raw);
  const map = raw['map'];
  if (!isRecord(map)) return fail('state.map', map);

  const units = asArray(raw['units'], 'units').map((entry, index): UiUnit => {
    if (!isRecord(entry)) return fail(`units[${String(index)}]`, entry);
    const work = entry['work'];
    return {
      id: asNumber(entry['id'], 'unit.id'),
      owner: asNumber(entry['owner'], 'unit.owner'),
      tile: asNumber(entry['tile'], 'unit.tile'),
      type: asString(entry['type'], 'unit.type'),
      movementLeft: asNumber(entry['movementLeft'], 'unit.movementLeft'),
      fortified: entry['fortified'] === true,
      hitPointsLeft: asNumber(entry['hitPointsLeft'] ?? 0, 'unit.hitPointsLeft'),
      working: isRecord(work),
    };
  });

  const cities = asArray(raw['cities'], 'cities').map((entry, index): UiCity => {
    if (!isRecord(entry)) return fail(`cities[${String(index)}]`, entry);
    return {
      id: asNumber(entry['id'], 'city.id'),
      owner: asNumber(entry['owner'], 'city.owner'),
      name: asString(entry['name'], 'city.name'),
      tile: asNumber(entry['tile'], 'city.tile'),
      population: asNumber(entry['population'], 'city.population'),
      shields: asNumber(entry['shields'], 'city.shields'),
      production: optionalProductionItem(entry['production'], 'city.production'),
      queue: asArray(entry['queue'], 'city.queue').map((item, at) =>
        uiProductionItem(item, `city.queue[${String(at)}]`),
      ),
      buildings: asArray(entry['buildings'], 'city.buildings').map((building) =>
        asString(building, 'city.buildings[]'),
      ),
      workedTiles: asArray(entry['workedTiles'], 'city.workedTiles').map((tile) =>
        asNumber(tile, 'city.workedTiles[]'),
      ),
      foodBox: asNumber(entry['foodBox'] ?? 0, 'city.foodBox'),
    };
  });

  const players = asArray(raw['players'], 'players').map((entry, index): UiPlayer => {
    if (!isRecord(entry)) return fail(`players[${String(index)}]`, entry);
    return {
      id: asNumber(entry['id'], 'player.id'),
      name: asString(entry['name'], 'player.name'),
      kind: asString(entry['kind'], 'player.kind'),
      color: asString(entry['color'], 'player.color'),
      treasury: asNumber(entry['treasury'], 'player.treasury'),
      beakers: asNumber(entry['beakers'], 'player.beakers'),
      luxuries: asNumber(entry['luxuries'], 'player.luxuries'),
      techs: asArray(entry['techs'], 'player.techs').map((tech) =>
        asString(tech, 'player.techs[]'),
      ),
      researching: asOptionalString(entry['researching']),
    };
  });

  return {
    revision: asNumber(raw['revision'], 'revision'),
    turn: asNumber(raw['turn'], 'turn'),
    seed: asNumber(raw['seed'], 'seed'),
    map: {
      width: asNumber(map['width'], 'map.width'),
      height: asNumber(map['height'], 'map.height'),
      terrain: asArray(map['terrain'], 'map.terrain').map((id) => asString(id, 'map.terrain[]')),
    },
    players,
    units,
    cities,
    explored: asArray(raw['explored'], 'explored').map((row) =>
      asArray(row, 'explored row').map((flag) => flag === true),
    ),
    settings: raw['settings'],
  };
};

/** The authoritative state, as the engine holds it inside the browser. */
export const readState = async (page: Page): Promise<UiState> =>
  asUiState(
    await page.evaluate(() => {
      const api = window.__CIVTS__;
      if (api === undefined) throw new Error('the M8 test seam is missing');
      return api.state();
    }),
  );

/** The engine's own state hash — the same value its goldens use. */
export const stateHash = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    return api.stateHash();
  });

/** Dispatch through the real applier. `'refused'` is an answer, never an exception. */
export const dispatch = (page: Page, action: unknown): Promise<'ok' | 'refused'> =>
  page.evaluate((a) => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    return api.dispatch(a);
  }, action);

/** Exactly the engine's own legal-action list for a unit and/or a city. */
export const actionsFor = (
  page: Page,
  query: { readonly unitId?: number; readonly cityId?: number },
): Promise<readonly unknown[]> =>
  page.evaluate(
    (ids) => {
      const api = window.__CIVTS__;
      if (api === undefined) throw new Error('the M8 test seam is missing');
      return api.actionsFor(ids.unitId, ids.cityId);
    },
    { unitId: query.unitId, cityId: query.cityId },
  );

/** The settings the app is playing with — what a headless replay must be given. */
export const readSettings = (page: Page): Promise<unknown> =>
  page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    return api.settings();
  });

/** The render counter, which must only ever grow. */
export const drawCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    return api.draws();
  });

/**
 * Start a new, deterministic game and wait until the app is playing it.
 *
 * `seed` is the only source of variation the contract allows, and the state it
 * produces is asserted to be that seed's turn-1 game rather than merely "some
 * state": a spec that seeds and then asserts against a stale frame is exactly the
 * flake this wait exists to prevent.
 */
export const seedApp = async (page: Page, seed: number, options?: unknown): Promise<UiState> => {
  await page.evaluate(
    (input) => {
      const api = window.__CIVTS__;
      if (api === undefined) throw new Error('the M8 test seam is missing');
      if (input.options === null) api.seed(input.seed);
      else api.seed(input.seed, input.options);
    },
    { seed, options: options ?? null },
  );
  await waitForApp(page);
  await expect
    .poll(async () => (await readState(page)).seed, {
      message: `the app did not start the seeded game ${String(seed)}`,
    })
    .toBe(seed);
  return readState(page);
};

/* ------------------------------------------------------------------ *
 * The accessibility contract, named once
 *
 * Every locator is role + accessible name. Nothing here reads a class, a tag or a
 * DOM position, which is the contract's stated reason for freezing these names.
 * ------------------------------------------------------------------ */

export const mapViewport = (page: Page): Locator => page.getByRole('application', { name: 'Map' });

export const endTurnButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'End turn', exact: true });

export const turnIndicator = (page: Page): Locator => page.getByRole('status', { name: 'Turn' });

export const yearIndicator = (page: Page): Locator => page.getByRole('status', { name: 'Year' });

export const treasuryIndicator = (page: Page): Locator =>
  page.getByRole('status', { name: 'Treasury' });

export const scienceIndicator = (page: Page): Locator =>
  page.getByRole('status', { name: 'Science' });

export const luxuryIndicator = (page: Page): Locator =>
  page.getByRole('status', { name: 'Luxury' });

export const eventLog = (page: Page): Locator => page.getByRole('log', { name: 'Events' });

export const scoreboard = (page: Page): Locator => page.getByRole('table', { name: 'Scoreboard' });

export const cityList = (page: Page): Locator => page.getByRole('list', { name: 'Cities' });

export const cityDialog = (page: Page, name: string): Locator =>
  page.getByRole('dialog', { name: `City ${name}` });

export const techDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Technology' });

export const saveButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Save game', exact: true });

export const loadButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Load game', exact: true });

export const debugDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Debug' });

export const stateHashIndicator = (page: Page): Locator =>
  page.getByRole('status', { name: 'State hash' });

export const unitPanel = (page: Page): Locator => page.getByRole('region', { name: 'Units' });

export const unitActionsGroup = (page: Page, unitId: number): Locator =>
  page.getByRole('group', { name: `Actions for unit ${String(unitId)}` });

/**
 * The drawing surface. The contract names the map *viewport* as the `application`
 * region; the canvas is the element inside it that carries the pixels, and a viewport
 * that is itself the canvas is accepted too.
 */
export const mapCanvas = async (page: Page): Promise<Locator> => {
  const viewport = mapViewport(page);
  const inside = viewport.locator('canvas');
  if ((await inside.count()) > 0) return inside.first();
  return viewport.first();
};

/* ------------------------------------------------------------------ *
 * Small state queries — reads of the engine's state, never rules
 * ------------------------------------------------------------------ */

/** The human seat's id, as the engine's own `PlayerId` — what `applyCommand` takes. */
export const humanPlayerId = (state: UiState): PlayerId => asPlayerId(humanPlayer(state).id);

/** The human seat: the first civilization in the player list. */
export const humanPlayer = (state: UiState): UiPlayer => {
  const player = state.players.find((candidate) => candidate.kind === 'civ');
  if (player === undefined) throw new Error('the state has no civilization to play as');
  return player;
};

export const unitsOf = (state: UiState, owner: number): readonly UiUnit[] =>
  state.units.filter((unit) => unit.owner === owner);

export const unitById = (state: UiState, unitId: number): UiUnit | undefined =>
  state.units.find((unit) => unit.id === unitId);

export const cityById = (state: UiState, cityId: number): UiCity | undefined =>
  state.cities.find((city) => city.id === cityId);

export const cityAt = (state: UiState, tile: number): UiCity | undefined =>
  state.cities.find((city) => city.tile === tile);

export const unitAt = (state: UiState, tile: number): UiUnit | undefined =>
  state.units.find((unit) => unit.tile === tile);

export const terrainAtTile = (state: UiState, tile: number): string => {
  const terrain = state.map.terrain[tile];
  if (terrain === undefined) throw new Error(`tile ${String(tile)} is outside the map`);
  return terrain;
};

export const tileX = (state: UiState, tile: number): number => tile % state.map.width;

export const tileY = (state: UiState, tile: number): number => Math.floor(tile / state.map.width);

export const tileIndexOf = (state: UiState, x: number, y: number): number =>
  y * state.map.width + x;

/** The first unit of `owner` whose type id or role-ish name matches `wanted`. */
export const findUnitByType = (state: UiState, owner: number, wanted: string): UiUnit | undefined =>
  state.units.find((unit) => unit.owner === owner && unit.type.includes(wanted));

/** A unit id the engine will answer `actionsFor` for, as a number. */
export const actionUnitId = (action: unknown): number | undefined => {
  if (!isRecord(action)) return undefined;
  const id = action['unitId'];
  return typeof id === 'number' ? id : undefined;
};

/** The command's own `type` field, for the transcripts and the comparisons below. */
export const actionType = (action: unknown): string => {
  if (!isRecord(action)) throw new Error(`action is not an object: ${JSON.stringify(action)}`);
  return asString(action['type'], 'action.type');
};

/**
 * Two commands are the same command when they carry the same fields with the same
 * values, compared key-order independently by the engine's own canonical rule
 * (sorted keys, JSON). Ordering of an object's keys is never part of a command's
 * identity, and `actionsFor`'s *list* order is compared separately where it matters.
 */
export const canonicalAction = (action: unknown): string => {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) out[key] = walk(value[key]);
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(action));
};

export const sameAction = (a: unknown, b: unknown): boolean =>
  canonicalAction(a) === canonicalAction(b);

export const findAction = (
  actions: readonly unknown[],
  predicate: (action: unknown) => boolean,
): unknown => actions.find(predicate);

/* ------------------------------------------------------------------ *
 * Dispatched-action recording
 *
 * The keystone invariant is "every control the UI offers dispatches a command the
 * engine accepts, and every command the engine accepts for a unit or a city is
 * reachable from the UI". Proving the second direction needs to know *which*
 * command a control produced, so this wraps the seam's own `dispatch` — it adds no
 * behaviour, it only records what the app already did, and it is installed by the
 * test rather than by the app.
 * ------------------------------------------------------------------ */

export interface DispatchRecord {
  readonly action: unknown;
  readonly result: 'ok' | 'refused';
}

/**
 * Install the recorder, or report that the seam refuses to be wrapped (a frozen
 * object). The caller decides whether that is fatal: the offered-controls
 * direction needs it, the rest of the suite does not.
 */
export const recordDispatches = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    const log: { action: unknown; result: 'ok' | 'refused' }[] = [];
    window.__CIVTS_DISPATCH_LOG__ = log;
    const original = api.dispatch.bind(api);
    try {
      Object.defineProperty(api, 'dispatch', {
        configurable: true,
        writable: true,
        value: (action: unknown): 'ok' | 'refused' => {
          const result = original(action);
          log.push({ action, result });
          return result;
        },
      });
    } catch {
      delete window.__CIVTS_DISPATCH_LOG__;
      return false;
    }
    return true;
  });

export const clearDispatchLog = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const log = window.__CIVTS_DISPATCH_LOG__;
    if (log !== undefined) log.length = 0;
  });

export const dispatchLog = (page: Page): Promise<readonly DispatchRecord[]> =>
  page.evaluate(() => {
    const log = window.__CIVTS_DISPATCH_LOG__;
    if (log === undefined) return [];
    return log.map((entry) => ({ action: entry.action, result: entry.result }));
  });

/* ------------------------------------------------------------------ *
 * The camera, and the projection the app itself uses
 * ------------------------------------------------------------------ */

const cameraFrom = (value: unknown, source: string): Camera => {
  if (!isRecord(value)) throw new Error(`camera source ${source} is not an object`);
  const numerator = value['zoomNumerator'];
  const denominator = value['zoomDenominator'];
  if (typeof numerator !== 'number' || typeof denominator !== 'number') {
    throw new Error(`camera source ${source} has no zoom ratio: ${JSON.stringify(value)}`);
  }
  return {
    x: asNumber(value['x'], 'camera.x'),
    y: asNumber(value['y'], 'camera.y'),
    zoomNumerator: numerator,
    zoomDenominator: denominator,
  };
};

/**
 * The camera the renderer is using.
 *
 * The frozen seam does not name a camera accessor, and it does not need to for the
 * *contract's* tests — but a hit-test "at a non-zero pan and zoom" has to know
 * where the map is, and re-deriving it from pixels would be the second mapping the
 * contract forbids. So the suite reads it from the app, in a documented order, and
 * fails with the whole candidate list when none of them answers.
 */
export const cameraOf = async (page: Page): Promise<Camera> => {
  const raw = await page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    const direct: unknown = typeof api.camera === 'function' ? api.camera() : undefined;
    const canvas = document.querySelector('canvas');
    const fromDataset =
      canvas instanceof HTMLElement && typeof canvas.dataset['camera'] === 'string'
        ? canvas.dataset['camera']
        : undefined;
    return { direct, fromDataset };
  });
  if (raw.direct !== undefined) return cameraFrom(raw.direct, '__CIVTS__.camera()');
  if (typeof raw.fromDataset === 'string') {
    return cameraFrom(JSON.parse(raw.fromDataset), 'canvas[data-camera]');
  }
  throw new Error(
    'the app exposes no camera: expected window.__CIVTS__.camera() or canvas[data-camera] — ' +
      'the hit-test needs the SAME projection the renderer uses (docs/INTERFACES.md M8)',
  );
};

/** The map point a page coordinate is over, through the app's own projection. */
export const pagePointToTile = (
  state: UiState,
  camera: Camera,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } | undefined =>
  screenToTile(camera, { width: state.map.width, height: state.map.height }, point);

/** The page coordinate of a tile's centre, through the app's own projection. */
export const tileCentre = (
  camera: Camera,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } => {
  const size = tileScreenPx(camera);
  const at = tileToScreen(camera, x, y);
  return { x: at.x + size / 2, y: at.y + size / 2 };
};

/** The canvas's page rectangle, or a named failure. */
export const canvasBox = async (
  page: Page,
): Promise<{
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}> => {
  const box = await (await mapCanvas(page)).boundingBox();
  if (box === null) throw new Error('the map canvas has no bounding box (is it rendered?)');
  return box;
};

/** A page-space coordinate → the coordinate the canvas itself sees. */
export const canvasRelative = async (
  page: Page,
  point: { readonly x: number; readonly y: number },
): Promise<{ readonly x: number; readonly y: number }> => {
  const box = await canvasBox(page);
  return { x: point.x - box.x, y: point.y - box.y };
};

/** The page coordinate a map point lands on, for a real mouse click. */
export const tilePagePoint = async (
  page: Page,
  camera: Camera,
  x: number,
  y: number,
): Promise<{ readonly x: number; readonly y: number }> => {
  await bringCanvasIntoView(page);
  const box = await canvasBox(page);
  const local = tileCentre(camera, x, y);
  return { x: box.x + local.x, y: box.y + local.y };
};

/**
 * Click the map at a tile's centre, through the app's own projection.
 *
 * A real `page.mouse.click` at real page coordinates — never a synthetic DOM
 * event — so the click travels the same path a human's does (pointer events,
 * hit-testing, focus). A tile whose centre falls outside the canvas is a refusal
 * to click at all: a click at a clamped coordinate would test a tile nobody asked
 * about, and the specs that need a tile on screen pan to it first.
 */
export const clickTile = async (
  page: Page,
  camera: Camera,
  x: number,
  y: number,
): Promise<void> => {
  await bringCanvasIntoView(page);
  const box = await canvasBox(page);
  const point = await tilePagePoint(page, camera, x, y);
  const inside =
    point.x >= box.x &&
    point.y >= box.y &&
    point.x < box.x + box.width &&
    point.y < box.y + box.height;
  if (!inside) {
    throw new Error(
      `tile (${String(x)}, ${String(y)}) is not on screen at this camera: its centre is ` +
        `${String(point.x)},${String(point.y)} and the canvas is ` +
        `${String(box.x)},${String(box.y)} ${String(box.width)}x${String(box.height)}`,
    );
  }
  await page.mouse.click(point.x, point.y);
};

/* ------------------------------------------------------------------ *
 * Pixels
 * ------------------------------------------------------------------ */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * The palette the APP paints with, so a pixel sample is checked against the renderer's own
 * documented colour rather than against a copy of it living in this file.
 *
 * `docs/INTERFACES.md` freezes the draw trace and pixel sampling but not a palette accessor, so
 * three sources are tried in order, strongest first:
 *
 *   1. `window.__CIVTS__.terrainColours()` — the app saying, in its own words, what it paints;
 *   2. the dev server's module graph: any exported record of `#rrggbb` values under `/src/`,
 *      which is how the renderer documents itself to its own reader;
 *   3. nothing — `undefined`, and the caller asserts only what holds without a palette (that
 *      the same terrain is always the same colour, and that two terrains differ).
 *
 * A palette that is present but malformed is an error rather than a silent downgrade: a
 * half-read palette would let a colour assertion pass against a colour nobody claimed.
 */
export const paletteOf = async (
  page: Page,
): Promise<Readonly<Record<string, string>> | undefined> => {
  const exposed = await page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api?.terrainColours === undefined) return null;
    const value: unknown = api.terrainColours();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('__CIVTS__.terrainColours() did not return a record of colours');
    }
    const out: Record<string, string> = {};
    for (const [key, colour] of Object.entries(value)) {
      if (typeof colour !== 'string') {
        throw new Error(`__CIVTS__.terrainColours() maps ${key} to a non-string`);
      }
      out[key] = colour;
    }
    return out;
  });
  if (exposed !== null && Object.keys(exposed).length > 0) {
    for (const colour of Object.values(exposed)) parseHexColour(colour);
    return exposed;
  }

  const modulePalette = await page.evaluate(async () => {
    // Defined here rather than imported: this callback is serialized and runs in the page, so
    // it can only use what the page has.
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const paths = ['/src/view.ts', '/src/palette.ts', '/src/colours.ts', '/src/colors.ts'];
    const found: Record<string, string> = {};
    for (const path of paths) {
      let module_: unknown;
      try {
        module_ = await import(/* @vite-ignore */ path);
      } catch {
        continue;
      }
      if (!isRecord(module_)) continue;
      for (const value of Object.values(module_)) {
        if (!isRecord(value)) continue;
        const entries = Object.entries(value);
        if (entries.length === 0) continue;
        const colours = entries.filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && /^#[0-9a-f]{6}$/i.test(entry[1]),
        );
        if (colours.length !== entries.length) continue;
        for (const [key, colour] of colours) found[key] = colour;
      }
    }
    return Object.keys(found).length > 0 ? found : null;
  });
  if (modulePalette === null) return undefined;
  for (const colour of Object.values(modulePalette)) parseHexColour(colour);
  return modulePalette;
};

export const parseHexColour = (hex: string): Rgb => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  return {
    r: Number.parseInt(match[1] ?? '0', 16),
    g: Number.parseInt(match[2] ?? '0', 16),
    b: Number.parseInt(match[3] ?? '0', 16),
    a: 255,
  };
};

/**
 * Sample one canvas pixel, by CSS coordinate inside the canvas.
 *
 * The canvas's backing store may be scaled by `devicePixelRatio`, so the CSS point
 * is mapped through the element's own ratio rather than assumed to be 1:1 — a
 * sampler that ignored it would read a neighbouring tile on a hidpi run and report
 * a "wrong colour" that is really a wrong coordinate.
 */
export const sampleCanvasPixel = async (
  page: Page,
  cssPoint: { readonly x: number; readonly y: number },
): Promise<Rgb> =>
  (await mapCanvas(page)).evaluate((element, point) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error('the map viewport contains no <canvas> to sample');
    }
    const rect = element.getBoundingClientRect();
    const context = element.getContext('2d');
    if (context === null) throw new Error('the map canvas has no 2d context');
    const x = Math.floor((point.x * element.width) / rect.width);
    const y = Math.floor((point.y * element.height) / rect.height);
    const data = context.getImageData(x, y, 1, 1).data;
    return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 };
  }, cssPoint);

/** The colour at the centre of a tile, through the app's own projection. */
export const sampleTileColour = async (
  page: Page,
  camera: Camera,
  x: number,
  y: number,
): Promise<Rgb> => sampleCanvasPixel(page, tileCentre(camera, x, y));

export const colourDistance = (a: Rgb, b: Rgb): number =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

export const describeColour = (colour: Rgb): string =>
  `rgb(${String(colour.r)}, ${String(colour.g)}, ${String(colour.b)})`;

/* ------------------------------------------------------------------ *
 * The draw trace
 * ------------------------------------------------------------------ */

export interface DrawEntry {
  readonly tile: number;
  readonly x: number;
  readonly y: number;
  readonly terrain: string;
}

const drawEntry = (raw: unknown, index: number, mapWidth: number): DrawEntry => {
  if (!isRecord(raw)) throw new Error(`draw trace entry ${String(index)} is not an object`);
  const terrain = raw['terrain'] ?? raw['terrainId'] ?? raw['terrain_id'];
  const x = raw['x'];
  const y = raw['y'];
  const tile = raw['tile'];
  if (typeof x === 'number' && typeof y === 'number') {
    return { x, y, tile: y * mapWidth + x, terrain: asString(terrain, 'draw.terrain') };
  }
  if (typeof tile === 'number') {
    return {
      tile,
      x: tile % mapWidth,
      y: Math.floor(tile / mapWidth),
      terrain: asString(terrain, 'draw.terrain'),
    };
  }
  throw new Error(`draw trace entry ${String(index)} names no tile: ${JSON.stringify(raw)}`);
};

/**
 * The draw trace of the last frame.
 *
 * Contracts this asserts, in order, so a missing or reshaped trace names itself:
 * the app exposes one, it is a list, and every entry names a tile and the terrain
 * drawn there. `mapWidth` turns a `(tile, terrain)` pair into coordinates, which is
 * the form the specs compare against the map.
 */
export const drawTraceOf = async (page: Page, mapWidth: number): Promise<readonly DrawEntry[]> => {
  const raw = await page.evaluate(() => {
    const api = window.__CIVTS__;
    if (api === undefined) throw new Error('the M8 test seam is missing');
    if (typeof api.drawTrace === 'function') return api.drawTrace();
    return undefined;
  });
  if (raw === undefined) {
    throw new Error(
      'the app exposes no draw trace: docs/INTERFACES.md M8 §Rendering requires one ' +
        '("an ordered list of what was drawn for the last frame, with the tile coordinates ' +
        'and terrain ids, capped and documented") — expected window.__CIVTS__.drawTrace()',
    );
  }
  // Two shapes are accepted for the same documented thing: the list itself, or an object that
  // carries it under one of the obvious names (a trace with a camera beside it is a normal way
  // to expose "what was drawn for the last frame"). Anything else names itself.
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? [raw['entries'], raw['trace'], raw['drawn'], raw['items']].find(Array.isArray)
      : undefined;
  if (list === undefined) {
    throw new Error(
      `the draw trace is not a list of drawn tiles: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return list.map((entry, index) => drawEntry(entry, index, mapWidth));
};

/* ------------------------------------------------------------------ *
 * Pan and zoom, as a player performs them
 * ------------------------------------------------------------------ */

/**
 * Drag the map by a screen-pixel delta, with real mouse events.
 *
 * `dx` positive drags the map right, which is the direction `view.ts`'
 * `panCamera` documents — the two agree because the renderer's handler is written
 * in terms of that function.
 */
export const dragMap = async (page: Page, dx: number, dy: number): Promise<void> => {
  let remainingX = dx;
  let remainingY = dy;
  // Chromium coalesces pointer moves onto animation frames, so a drag can arrive one step short
  // of where it was aimed. Rather than hope, the helper measures what the camera actually did
  // (through the app's own projection: `camera.x - dx/size`) and drags the remainder. It stops
  // as soon as the delta is delivered, or when the camera stops moving — a camera clamped at the
  // map's edge, which is a real answer rather than a failure.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await cameraOf(page);
    await dragOnce(page, remainingX, remainingY);
    const after = await cameraOf(page);
    const size = tileScreenPx(after);
    const movedX = (before.x - after.x) * size;
    const movedY = (before.y - after.y) * size;
    remainingX -= movedX;
    remainingY -= movedY;
    if (Math.abs(remainingX) < 1 && Math.abs(remainingY) < 1) return;
    if (movedX === 0 && movedY === 0) return;
  }
};

/**
 * One press-drag-release, in several small steps so the app sees a drag and not a click.
 *
 * The pointer starts on the side the drag is heading AWAY from and the delta is clamped to what
 * fits inside the viewport: a pointer moved past the window's edge stops producing events, and a
 * pan that silently loses its last few hundred pixels is a flaky assertion waiting to happen.
 * `dragMap` calls this repeatedly with whatever is left over.
 */
const dragOnce = async (page: Page, dx: number, dy: number): Promise<void> => {
  await mapCanvas(page);
  await bringCanvasIntoView(page);
  const box = await canvasBox(page);
  const view = page.viewportSize() ?? { width: 1280, height: 900 };
  const margin = 12;
  const left = Math.max(box.x, 0);
  const right = Math.min(box.x + box.width, view.width);
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, view.height);
  if (right - left <= 2 * margin || bottom - top <= 2 * margin) {
    throw new Error('the map canvas is not visible enough to drag on');
  }
  const from = {
    x: dx < 0 ? right - margin : left + margin,
    y: dy < 0 ? bottom - margin : top + margin,
  };
  const roomLeft = from.x - left - margin;
  const roomRight = right - margin - from.x;
  const roomUp = from.y - top - margin;
  const roomDown = bottom - margin - from.y;
  const usedX = dx < 0 ? -Math.min(-dx, roomLeft) : Math.min(dx, roomRight);
  const usedY = dy < 0 ? -Math.min(-dy, roomUp) : Math.min(dy, roomDown);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + (usedX * step) / steps, from.y + (usedY * step) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

/**
 * A point INSIDE the canvas that is also inside the viewport, with the map scrolled into view
 * first.
 *
 * Panels below the map grow as the game is played, and a taller document scrolls: the canvas's
 * own bounding box can then sit above the viewport, and a wheel or a drag aimed at its centre
 * would land on nothing at all. The map is scrolled into view and the point is taken from the
 * VISIBLE part of the box, so the gesture reaches the element it names however tall the page is.
 */
/**
 * Scroll the map canvas fully into the viewport.
 *
 * `scrollIntoViewIfNeeded` is satisfied by a sliver: after a modal opens and closes, the page can
 * be scrolled so far that only the canvas's bottom edge shows, and a point computed "inside" it
 * then lands outside the window — where the mouse produces no events at all. Aiming the canvas at
 * the middle of the viewport makes the geometry independent of whatever scrolled the page.
 */
export const bringCanvasIntoView = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    document.querySelector('canvas')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
};

export const mapPoint = async (page: Page): Promise<{ readonly x: number; readonly y: number }> => {
  await mapCanvas(page);
  await bringCanvasIntoView(page);
  const box = await canvasBox(page);
  const view = page.viewportSize() ?? { width: 1280, height: 900 };
  const left = Math.max(box.x, 0);
  const right = Math.min(box.x + box.width, view.width);
  const top = Math.max(box.y, 0);
  const bottom = Math.min(box.y + box.height, view.height);
  if (right - left <= 0 || bottom - top <= 0) {
    throw new Error(
      `the map canvas is not visible: box ${JSON.stringify(box)} in ${JSON.stringify(view)}`,
    );
  }
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
};

/** Turn the wheel over the map, which is the contract's zoom gesture. */
export const wheelMap = async (page: Page, deltaY: number): Promise<void> => {
  const at = await mapPoint(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, deltaY);
};

/**
 * Which wheel sign zooms in: measured, never assumed.
 *
 * The contract fixes the projection, not the gesture's polarity, so the suite
 * probes. A wheel that grows the tile is zooming in; one that does not is zooming
 * out, and the probe is undone so it leaves the camera where it found it.
 */
const zoomSign = async (page: Page): Promise<1 | -1> => {
  const before = await cameraOf(page);
  await wheelMap(page, 120);
  const after = await cameraOf(page);
  const grew = tileScreenPx(after) > tileScreenPx(before);
  const shrank = tileScreenPx(after) < tileScreenPx(before);
  if (!grew && !shrank) {
    throw new Error('a wheel event over the map did not change the zoom at all');
  }
  // Undo the probe: the caller's camera must be exactly where it found it, or every zoom
  // level asserted below would be off by the probe's own step.
  await wheelMap(page, shrank ? -120 : 120);
  const restored = await cameraOf(page);
  if (tileScreenPx(restored) !== tileScreenPx(before)) {
    throw new Error('the zoom probe could not be undone: the wheel is not a symmetric gesture');
  }
  return grew ? 1 : -1;
};

export const zoomTo = async (page: Page, direction: -1 | 1, steps: number): Promise<Camera> => {
  const sign: 1 | -1 = (await zoomSign(page)) * direction === 1 ? 1 : -1;
  let camera = await cameraOf(page);
  for (let step = 0; step < steps; step += 1) {
    await wheelMap(page, 120 * sign);
    const next = await cameraOf(page);
    if (tileScreenPx(next) === tileScreenPx(camera)) break;
    camera = next;
  }
  return camera;
};

/* ------------------------------------------------------------------ *
 * What the renderer should be drawing
 * ------------------------------------------------------------------ */

/** The tile range the viewport covers, through the renderer's own function. */
export const visibleTiles = (
  state: UiState,
  camera: Camera,
  size: { readonly width: number; readonly height: number },
): readonly number[] => {
  const bounds = visibleTileBounds(
    camera,
    { width: state.map.width, height: state.map.height },
    size,
  );
  const tiles: number[] = [];
  for (let y = bounds.y0; y <= bounds.y1; y += 1) {
    for (let x = bounds.x0; x <= bounds.x1; x += 1) tiles.push(y * state.map.width + x);
  }
  return tiles;
};

/** Did `playerId` ever see this tile? Fog is the engine's memory, not a guess. */
export const isExplored = (state: UiState, playerId: number, tile: number): boolean =>
  state.explored[playerId]?.[tile] === true;

/** Does anything else occupy this tile, so a terrain sample would read it instead? */
export const tileIsClear = (state: UiState, tile: number): boolean =>
  unitAt(state, tile) === undefined && cityAt(state, tile) === undefined;

/**
 * The map canvas's accessible description, which the contract requires to name the
 * visible map dimensions and the tile under the cursor.
 */
export const mapDescription = async (page: Page): Promise<string> => {
  const text = await (
    await mapCanvas(page)
  ).evaluate((element) => {
    const description = element.getAttribute('aria-description');
    if (description !== null && description !== '') return description;
    const referenced = element.getAttribute('aria-describedby');
    if (referenced !== null) {
      const target = element.ownerDocument.getElementById(referenced);
      const text = target?.textContent ?? '';
      if (text !== '') return text;
    }
    const title = element.getAttribute('title');
    if (title !== null && title !== '') return title;
    return element.getAttribute('aria-label') ?? '';
  });
  if (text === '') {
    throw new Error(
      'the map canvas carries no accessible description: docs/INTERFACES.md M8 requires one ' +
        "naming the visible map dimensions and the cursor's tile coordinates",
    );
  }
  return text;
};

/* ------------------------------------------------------------------ *
 * Selecting things in the UI
 *
 * Neither the frozen table nor the contracts say *how* a unit or a city is
 * selected; they only require that the selected unit's actions are exposed as the
 * group `Actions for unit <id>` and that a city screen is the dialog
 * `City <name>`. So selection is discovered by role and name, with the map as the
 * documented fallback, and every strategy ends by asserting the contract's own
 * observable (`closing the loop` rather than assuming which one worked).
 * ------------------------------------------------------------------ */

/**
 * The accessible name a unit's row carries: `<type name> <id>`.
 *
 * The ruleset's own name for the type, never the raw id, because that is the vocabulary the
 * unit panel uses and the one a person reads.
 */
export const unitLabel = (unit: UiUnit): string => {
  const def = RULESET.units.find((candidate) => candidate.id === unit.type);
  return `${def?.name ?? unit.type} ${String(unit.id)}`;
};

/**
 * Select a unit the way a player does: click its row in the `Units` region.
 *
 * The row's accessible name is `<type name> <id>` (the panel's own convention, built from the
 * ruleset), so the locator is role + name and not a position. The map click is the documented
 * fallback for a shell that makes the list read-only; either way the strategy ends by
 * asserting the contract's own observable — `Actions for unit <id>` is on screen — rather than
 * assuming which one worked.
 */
export const selectUnit = async (
  page: Page,
  state: UiState,
  camera: Camera,
  unitId: number,
): Promise<void> => {
  const group = unitActionsGroup(page, unitId);
  if ((await group.count()) === 0) {
    const unit = unitById(state, unitId);
    if (unit === undefined) throw new Error(`no unit ${String(unitId)} in state to select`);
    const row = unitPanel(page).getByRole('button', { name: unitLabel(unit), exact: true });
    if ((await row.count()) > 0) await row.first().click();
    else await clickTile(page, camera, tileX(state, unit.tile), tileY(state, unit.tile));
  }
  await expect(group, `the UI did not expose Actions for unit ${String(unitId)}`).toBeVisible();
};

/**
 * The group of commands the engine's *planners* accept for a unit — `Abilities for unit <id>`:
 * fortify, and one attack per adjacent tile the engine accepts an attack on (the queried side
 * of the command union, which `unitActions` deliberately does not enumerate).
 */
export const unitAbilitiesGroup = (page: Page, unitId: number): Locator =>
  page.getByRole('group', { name: `Abilities for unit ${String(unitId)}` });

/**
 * Open a city's screen the way a player does: click its entry in the `Cities` list.
 *
 * The list entry is a button whose accessible name is the city's own name, so the locator is
 * role + name again. The map click remains the fallback, and the contract's own observable
 * (`City <name>` dialog visible) closes the loop either way.
 */
export const openCity = async (
  page: Page,
  state: UiState,
  camera: Camera,
  city: UiCity,
): Promise<Locator> => {
  const dialog = cityDialog(page, city.name);
  if ((await dialog.count()) === 0) {
    const entry = cityList(page).getByRole('button', { name: city.name, exact: true });
    if ((await entry.count()) > 0) await entry.first().click();
    else await clickTile(page, camera, tileX(state, city.tile), tileY(state, city.tile));
  }
  if ((await dialog.count()) === 0) {
    const entry = cityList(page).getByRole('button', { name: city.name, exact: true });
    if ((await entry.count()) > 0) await entry.first().click();
  }
  await expect(dialog, `the UI did not open the City ${city.name} dialog`).toBeVisible();
  return dialog;
};

/** Close whatever dialog is open, so the next step starts from the map. */
export const closeDialogs = async (page: Page): Promise<void> => {
  const dialogs = page.getByRole('dialog');
  const count = await dialogs.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    const close = dialog.getByRole('button', { name: /close|cancel|done/i });
    if ((await close.count()) > 0) await close.first().click();
    else await page.keyboard.press('Escape');
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

/* ------------------------------------------------------------------ *
 * Ordering a unit through the UI
 *
 * The contract fixes the group's name (`Actions for unit <id>`) but not the names
 * of the controls inside it, so a spec names the ORDER it wants and this layer
 * finds the control that offers it — by role and accessible name, never by
 * position. Both halves are used by the keystone sweep: the buttons are enumerated
 * to prove the UI offers nothing the engine refuses, and looked up by name to
 * prove the engine's actions are reachable.
 * ------------------------------------------------------------------ */

export const unitActionButtons = (page: Page, unitId: number): Locator =>
  unitActionsGroup(page, unitId).getByRole('button');

/** Every accessible name the unit's action controls carry, for diagnostics. */
export const unitActionNames = async (page: Page, unitId: number): Promise<readonly string[]> => {
  const buttons = unitActionButtons(page, unitId);
  const count = await buttons.count();
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    names.push((await buttons.nth(index).innerText()).trim());
  }
  return names;
};

/** Click the control in a unit's action group whose accessible name matches. */
export const clickUnitAction = async (
  page: Page,
  unitId: number,
  pattern: RegExp,
): Promise<void> => {
  const button = unitActionsGroup(page, unitId).getByRole('button', { name: pattern }).first();
  if ((await button.count()) === 0) {
    const names = await unitActionNames(page, unitId);
    throw new Error(
      `no control matching ${String(pattern)} in Actions for unit ${String(unitId)}; ` +
        `the UI offers: ${names.length === 0 ? '(nothing)' : names.join(' | ')}`,
    );
  }
  await button.click();
};

/**
 * Issue a move or an attack by clicking the destination tile — the way a player
 * does it — accepting either shape the UI may use: a click that dispatches the
 * command directly, or a click that selects the tile and a control that confirms.
 *
 * Returns whether the engine was asked, which keeps "the UI has no such control" a
 * fact the spec asserts rather than an exception it has to catch.
 */
export const clickTileOrder = async (
  page: Page,
  camera: Camera,
  tile: number,
  mapWidth: number,
  wanted: 'MoveUnit' | 'AttackUnit',
): Promise<boolean> => {
  await clearDispatchLog(page);
  await clickTile(page, camera, tile % mapWidth, Math.floor(tile / mapWidth));
  const dispatched = async (): Promise<boolean> =>
    (await dispatchLog(page)).some((entry) => {
      if (!isRecord(entry.action)) return false;
      if (entry.action['type'] !== wanted) return false;
      const field = wanted === 'MoveUnit' ? entry.action['to'] : entry.action['target'];
      return field === tile;
    });
  if (await dispatched()) return true;

  // Otherwise the click selected the destination and a control confirms it. The control is
  // found by the coordinates it NAMES (`Move to 3,4`, `Attack 3,4`) rather than by being the
  // first button that says "move" — clicking a control for a different tile would issue a
  // command nobody asked for and then report the order as unreachable.
  const x = tile % mapWidth;
  const y = Math.floor(tile / mapWidth);
  const verb = wanted === 'MoveUnit' ? 'move' : 'attack';
  const named = page.getByRole('button', {
    name: new RegExp(`${verb}[^0-9]*${String(x)}\\s*,\\s*${String(y)}(?!\\d)`, 'i'),
  });
  if ((await named.count()) > 0) {
    await named.first().click();
    if (await dispatched()) return true;
  }
  const confirm = page.getByRole('button', { name: /confirm/i }).first();
  if ((await confirm.count()) > 0) {
    await confirm.click();
    if (await dispatched()) return true;
  }
  return false;
};

/** The tile a `MoveUnit`/`AttackUnit` names, or `undefined` for anything else. */
export const actionTarget = (action: unknown): number | undefined => {
  if (!isRecord(action)) return undefined;
  const type = action['type'];
  if (type === 'MoveUnit') {
    const to = action['to'];
    return typeof to === 'number' ? to : undefined;
  }
  if (type === 'AttackUnit') {
    const target = action['target'];
    return typeof target === 'number' ? target : undefined;
  }
  return undefined;
};

/**
 * The buttons in a container that are ACTION controls, as indices.
 *
 * A dialog is allowed to carry chrome — a close button, a "done" button — and
 * clicking one of those is not an order, so the keystone sweeps must not count its
 * silence as a command the UI failed to dispatch. The excluded names are UI chrome
 * and nothing else; a control named like an order is always swept.
 */
const UI_CHROME = /close|cancel|done|dismiss|^×$|^x$/i;

export const actionControlIndices = async (container: Locator): Promise<readonly number[]> => {
  const buttons = container.getByRole('button');
  const count = await buttons.count();
  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = (await buttons.nth(index).innerText()).trim();
    if (UI_CHROME.test(name)) continue;
    indices.push(index);
  }
  return indices;
};

/* ------------------------------------------------------------------ *
 * Opening a panel whose opener the contract does not name
 * ------------------------------------------------------------------ */

/**
 * Open a dialog by clicking a control whose accessible name matches `pattern`.
 *
 * The frozen table names the DIALOGS (`City <name>`, `Technology`, `Debug`) and two
 * of the buttons (`Save game`, `Load game`); it does not name the controls that open
 * the tech tree or the debug panel, so those are found by role and name here rather
 * than by a position a restyle would move.
 */
export const openPanel = async (page: Page, pattern: RegExp): Promise<Locator> => {
  const existing = page.getByRole('dialog', { name: pattern });
  if ((await existing.count()) > 0) return existing.first();
  const opener = page.getByRole('button', { name: pattern }).first();
  if ((await opener.count()) === 0) {
    const names: string[] = [];
    const buttons = page.getByRole('button');
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      names.push((await buttons.nth(index).innerText()).trim());
    }
    throw new Error(
      `no control opens ${String(pattern)}; the page's buttons are: ${names.join(' | ')}`,
    );
  }
  await opener.click();
  return page.getByRole('dialog', { name: pattern }).first();
};

/* ------------------------------------------------------------------ *
 * Playing a little, through the UI's own controls
 * ------------------------------------------------------------------ */

/** The unit's action group, as a locator (the contractual name). */
export const actionsGroup = (page: Page, unitId: number): Locator => unitActionsGroup(page, unitId);

/**
 * Found the first city by clicking the settler's own `Found city` control, and return the
 * city the engine created.
 */
export const foundCity = async (page: Page): Promise<UiCity> => {
  const state = await readState(page);
  const owner = humanPlayerId(state);
  const settler = state.units.find((unit) => unit.owner === owner && unit.type.includes('settler'));
  if (settler === undefined) throw new Error('the human seat has no settler to found a city with');
  await selectUnit(page, state, await cameraOf(page), settler.id);
  await clickUnitAction(page, settler.id, /found city/i);
  await expect
    .poll(async () => (await readState(page)).cities.length, { message: 'no city was founded' })
    .toBeGreaterThan(0);
  const after = await readState(page);
  const city = after.cities[0];
  if (city === undefined) throw new Error('the engine reports no city after founding one');
  return city;
};

/** End `turns` turns by clicking the app's own `End turn` button. */
export const endTurns = async (page: Page, turns: number): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await endTurnButton(page).click();
};

/**
 * Bring a tile to the middle of the canvas by dragging the map — the way a player scrolls to
 * something.
 *
 * A pan is computed through the app's own projection (`panCamera`'s sign: `camera.x - dx/size`),
 * so the drag the test performs is the one the renderer's arithmetic implies, and the camera is
 * re-read afterwards rather than assumed.
 */
export const bringTileToCentre = async (
  page: Page,
  state: UiState,
  tile: number,
): Promise<void> => {
  const box = await canvasBox(page);
  const camera = await cameraOf(page);
  const size = tileScreenPx(camera);
  const wanted = {
    x: tileX(state, tile) - box.width / (2 * size),
    y: tileY(state, tile) - box.height / (2 * size),
  };
  const dx = (camera.x - wanted.x) * size;
  const dy = (camera.y - wanted.y) * size;
  if (dx === 0 && dy === 0) return;
  await dragMap(page, dx, dy);
};

/**
 * Drive a script of commands through the UI'S OWN CONTROLS, one control per command.
 *
 * This is the counterpart of `replayScript`: the same commands, but every one of them issued by
 * clicking something a player can click — the settler's `Found city`, a city screen's
 * `Build …`, an action group's `Move to x,y`, the `End turn` button. A command the UI has no
 * control for is a failure with the command in the message, not a silent skip, and each step is
 * checked against the dispatch log so a click that quietly refused cannot pass as a step.
 *
 * Returns the number of commands it issued.
 */
export const driveScript = async (page: Page, script: readonly unknown[]): Promise<number> => {
  await recordDispatches(page);
  let issued = 0;
  for (const raw of script) {
    await clearDispatchLog(page);
    const command = toCommand(raw);
    switch (command.type) {
      case 'EndTurn': {
        await endTurnButton(page).click();
        break;
      }
      case 'FoundCity': {
        const state = await readState(page);
        await selectUnit(page, state, await cameraOf(page), Number(command.unitId));
        await clickUnitAction(page, Number(command.unitId), /found city/i);
        break;
      }
      case 'MoveUnit': {
        const state = await readState(page);
        const to = command.to;
        await selectUnit(page, state, await cameraOf(page), Number(command.unitId));
        await clickUnitAction(
          page,
          Number(command.unitId),
          new RegExp(`^Move to ${String(tileX(state, to))},${String(tileY(state, to))}$`),
        );
        break;
      }
      case 'StartWork': {
        const state = await readState(page);
        await selectUnit(page, state, await cameraOf(page), Number(command.unitId));
        const name =
          RULESET.improvements.find((def) => def.id === command.kind)?.name ?? command.kind;
        await clickUnitAction(page, Number(command.unitId), new RegExp(`^Start work: ${name}$`));
        break;
      }
      case 'SetProduction': {
        const state = await readState(page);
        const city = state.cities.find((candidate) => candidate.id === Number(command.cityId));
        if (city === undefined) throw new Error(`no city ${String(command.cityId)} to build in`);
        const dialog = await openCity(page, state, await cameraOf(page), city);
        const name = itemName(command.item);
        await dialog
          .getByRole('button', { name: new RegExp(`^Build ${name} `) })
          .first()
          .click();
        await closeDialogs(page);
        break;
      }
      default: {
        throw new Error(`the UI drive has no control for ${JSON.stringify(raw)}`);
      }
    }

    const log = await dispatchLog(page);
    const last = log.at(-1);
    if (last === undefined) {
      throw new Error(`clicking for ${JSON.stringify(raw)} dispatched nothing`);
    }
    if (last.result !== 'ok') {
      throw new Error(`the engine refused the control for ${JSON.stringify(raw)}`);
    }
    issued += 1;
  }
  return issued;
};

/** A production item's own display name, from the ruleset's catalog. */
const itemName = (item: { readonly kind: string; readonly id: string }): string => {
  const defs: readonly { readonly id: string; readonly name: string }[] =
    item.kind === 'unit' ? RULESET.units : RULESET.buildings;
  return defs.find((def) => def.id === item.id)?.name ?? item.id;
};

/* ------------------------------------------------------------------ *
 * Comparing UI state with the engine's own answer
 * ------------------------------------------------------------------ */

/**
 * The set of actions the engine accepts for a unit, canonicalised for set
 * comparison. Used by the keystone spec in both directions.
 */
export const canonicalActions = (actions: readonly unknown[]): readonly string[] =>
  actions.map(canonicalAction);

export const sameActionSet = (
  a: readonly unknown[],
  b: readonly unknown[],
): {
  readonly equal: boolean;
  readonly onlyInA: readonly string[];
  readonly onlyInB: readonly string[];
} => {
  const setA = new Set(canonicalActions(a));
  const setB = new Set(canonicalActions(b));
  const onlyInA = [...setA].filter((entry) => !setB.has(entry));
  const onlyInB = [...setB].filter((entry) => !setA.has(entry));
  return { equal: onlyInA.length === 0 && onlyInB.length === 0, onlyInA, onlyInB };
};

/** A page-level assertion helper: the app must still be reporting itself ready. */
export const expectReady = async (page: Page): Promise<void> => {
  await expect.poll(async () => page.evaluate(() => window.__CIVTS__?.ready === true)).toBe(true);
};

/* ------------------------------------------------------------------ *
 * The engine, in the test process
 *
 * The keystone proof at the UI layer is "the same script through the browser and
 * through the engine directly produce the same `stateHash()`" — which is only a
 * proof if the second run is the real engine, on the real catalog, with the real
 * applier. So the suite imports `@civts/core` and `@civts/rules` here and drives
 * them headlessly in Node, with no browser and no server in the loop.
 *
 * Nothing in this section is a rule of this suite's own: `newGame`, `applyCommand`,
 * `parseSettings` and `hashValue` are the engine's and the goldens' own functions,
 * called with the same arguments the browser calls them with.
 * ------------------------------------------------------------------ */

/** The shipped, validated content — the same ruleset the app plays on. */
export const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

/**
 * The settings a headless replay must be given so that it plays the SAME game the
 * browser is playing: whatever the app reports, parsed by the engine's own parser
 * (so an app that reported a shape the engine cannot read fails here, loudly,
 * instead of producing a different game).
 */
export const settingsFrom = (raw: unknown, seed: number): Settings => {
  const parsed = parseSettings({ ...DEFAULT_SETTINGS, ...(isRecord(raw) ? raw : {}), seed });
  if (!parsed.ok) {
    throw new Error(
      `the app's settings are not settings the engine accepts: ${parsed.error
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join(', ')}`,
    );
  }
  return parsed.value;
};

/** Start the same game the browser would start, in this process. */
export const headlessNewGame = (seed: number, settings: Settings): Result<GameState, SetupError> =>
  newGame(seed, settings, RULESET);

/**
 * Replay a script of commands through the real applier, in order.
 *
 * A command the applier refuses stops the replay with the engine's own error: a
 * script that the UI ran successfully cannot contain one, so a refusal here is
 * itself a finding (the two are not running the same engine).
 */
export const replayScript = (
  state: GameState,
  playerId: PlayerId,
  script: readonly unknown[],
): GameState => {
  let current = state;
  for (const raw of script) {
    const outcome = applyCommand(current, playerId, toCommand(raw), RULESET);
    if (!outcome.ok) {
      throw new Error(
        `the headless replay refused ${JSON.stringify(raw)}: ${JSON.stringify(outcome.error)}`,
      );
    }
    current = outcome.value.state;
  }
  return current;
};

/** The engine's own state hash, exactly as the app's `stateHash()` computes it. */
export const hashOf = (state: GameState): string => hashValue(state);

/**
 * The same validation for the *engine's* `ProductionItem`, whose ids are branded:
 * `asUiState`'s mirror above is plain data for assertions, this one is what the
 * applier accepts.
 */
const toProductionItem = (value: unknown, what: string): ProductionItem => {
  if (!isRecord(value)) return fail(what, value);
  const id = asString(value['id'], `${what}.id`);
  const kind = asString(value['kind'], `${what}.kind`);
  if (kind === 'unit') return { kind: 'unit', id: asUnitTypeId(id) };
  if (kind === 'building') return { kind: 'building', id: asBuildingId(id) };
  return fail(`${what}.kind`, kind);
};

/**
 * Validate a dispatched action into a `Command`.
 *
 * This is a *validator*, not a cast: every field of every member of the frozen
 * command union is read and checked, and the object handed to the applier is built
 * here rather than trusted. It is also the one place that says out loud which
 * commands the UI is allowed to dispatch — the union is closed, and an action
 * outside it is a failure rather than something the engine is asked to absorb.
 */
export const toCommand = (raw: unknown): Command => {
  if (!isRecord(raw)) throw new Error(`not a command: ${JSON.stringify(raw)}`);
  const type = raw['type'];
  const unit = (what: string): ReturnType<typeof asUnitId> => asUnitId(asNumber(raw[what], what));
  const city = (what: string): ReturnType<typeof asCityId> => asCityId(asNumber(raw[what], what));
  const tile = (what: string): ReturnType<typeof asTileIndex> =>
    asTileIndex(asNumber(raw[what], what));

  switch (type) {
    case 'MoveUnit':
      return { type: 'MoveUnit', unitId: unit('unitId'), to: tile('to') };
    case 'EndTurn':
      return { type: 'EndTurn' };
    case 'FoundCity':
      return { type: 'FoundCity', unitId: unit('unitId') };
    case 'SetWorkedTiles':
      return {
        type: 'SetWorkedTiles',
        cityId: city('cityId'),
        tiles: asArray(raw['tiles'], 'tiles').map((entry) => asTileIndex(asNumber(entry, 'tile'))),
      };
    case 'SetProduction':
      return {
        type: 'SetProduction',
        cityId: city('cityId'),
        item: toProductionItem(raw['item'], 'item'),
      };
    case 'StartWork':
      return {
        type: 'StartWork',
        unitId: unit('unitId'),
        kind: asImprovementId(asString(raw['kind'], 'kind')),
      };
    case 'CancelWork':
      return { type: 'CancelWork', unitId: unit('unitId') };
    case 'SetRates': {
      const rates = raw['rates'];
      if (!isRecord(rates)) throw new Error('SetRates without a rates object');
      return {
        type: 'SetRates',
        rates: {
          tax: asNumber(rates['tax'], 'rates.tax'),
          science: asNumber(rates['science'], 'rates.science'),
          luxury: asNumber(rates['luxury'], 'rates.luxury'),
        },
      };
    }
    case 'SetResearch':
      return { type: 'SetResearch', tech: asTechId(asString(raw['tech'], 'tech')) };
    case 'AttackUnit':
      return { type: 'AttackUnit', unitId: unit('unitId'), target: tile('target') };
    case 'FortifyUnit':
      return { type: 'FortifyUnit', unitId: unit('unitId') };
    default:
      throw new Error(`not a member of the frozen command union: ${JSON.stringify(raw)}`);
  }
};
