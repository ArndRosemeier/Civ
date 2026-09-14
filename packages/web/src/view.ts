/**
 * The map camera — pan, zoom, and the ONE tile↔pixel projection.
 * See docs/INTERFACES.md, M8 ("Rendering, and how it is tested (§16.2)").
 *
 * ## Why this module is a separate file with no DOM in it
 *
 * The camera is the part of the map view that can be *wrong in a way pixels hide*:
 * a camera whose stored offset and whose derived tile placement disagree, or a
 * hit-test written as a second, inverse mapping that drifts from the forward one.
 * INTERFACES.md names that failure explicitly — "Click hit-testing converts a page
 * coordinate to a tile through the SAME function the renderer uses — a second
 * inverse mapping is a bug waiting to happen and must not exist."
 *
 * So the projection lives here, as pure functions over plain numbers, and the
 * renderer (`map.ts`) and the hit-test (`screenToTile` below) are both written in
 * terms of it. Nothing in this file touches `window`, `document` or a canvas, which
 * is what lets `packages/web/test/*.test.ts` unit-test the round trip in the fast
 * vitest tier (Node, no DOM) rather than in a browser.
 *
 * ## Determinism
 *
 * No clock, no randomness, no transcendentals — only `+ - * /`, `Math.floor`,
 * `Math.min/max/abs` and comparisons, exactly the arithmetic PLAN.md §5.3 permits.
 * The camera is presentation state (it is never hashed and never reaches
 * `GameState`), but keeping it integer-clean means a test can assert exact pixel
 * numbers instead of tolerances.
 *
 * ## Zoom is a ratio, not a float
 *
 * Zoom is `zoomNumerator / zoomDenominator` — a small exact rational — rather than a
 * `number` like `1.75`. Every level is a dyadic ratio (1, 2, 4, 8, 1/2, 1/4, …), so
 * `baseTile * numerator / denominator` is exact in IEEE-754 double arithmetic and two
 * machines agree on the pixel a tile starts at. A float zoom would make "which tile
 * did I click?" depend on accumulated rounding, which is precisely the class of bug
 * this file exists to make impossible.
 */

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Tile edge length in CSS pixels at zoom 1. */
export const BASE_TILE_PX = 32;

/** One zoom level, as the exact rational `numerator / denominator`. */
export interface ZoomLevel {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * The zoom levels the UI steps through, outermost to innermost. Each is an exact
 * dyadic ratio (see the module note), and `ZOOM_DEFAULT_INDEX` names the level a
 * fresh game starts at — 2× so painted terrain textures read clearly while a
 * starting scout of a `tiny` map still fits the canvas.
 */
export const ZOOM_LEVELS: readonly ZoomLevel[] = [
  { numerator: 1, denominator: 4 },
  { numerator: 1, denominator: 2 },
  { numerator: 1, denominator: 1 },
  { numerator: 2, denominator: 1 },
  { numerator: 4, denominator: 1 },
];

/** Index into `ZOOM_LEVELS` of the default level — 2× so textured tiles read clearly. */
export const ZOOM_DEFAULT_INDEX = 3;

/**
 * The camera: which map coordinate sits at the canvas's top-left corner, and how
 * many pixels a tile covers. `x`/`y` are in **map coordinates** (so `x: 3.5` means
 * "half a tile to the right of tile 3's left edge"), which is what makes panning by
 * a pixel delta a division by the tile size rather than a table of magic offsets.
 */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoomNumerator: number;
  readonly zoomDenominator: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One tile's top-right corner cell: the only other shape the projection needs.
 * `width`/`height` are the map's dimensions in tiles.
 */
export interface TileExtent {
  readonly width: number;
  readonly height: number;
}

/* ------------------------------------------------------------------ *
 * The projection (the one mapping; the hit-test is its exact inverse)
 * ------------------------------------------------------------------ */

/** CSS pixels one tile covers at this camera's zoom. Exact for dyadic zooms. */
export const tileScreenPx = (camera: Camera): number =>
  (BASE_TILE_PX * camera.zoomNumerator) / camera.zoomDenominator;

/**
 * Where the tile at map coordinate `(x, y)` starts on screen. **This is the
 * forward mapping**; `screenToTile` is its inverse and the renderer places every
 * tile through this function, so the two cannot disagree.
 *
 * A tile's identity is its *top-left corner*: the renderer fills the rectangle
 * `[tileToScreen(c, x, y), +size)` and the hit-test floors the screen point back to
 * a tile coordinate. Fractional tile coordinates are legal input (that is what a
 * camera between two tiles means) and are reported as the fractional pixel they
 * imply, because rounding here would be a second, subtly different mapping.
 */
export const tileToScreen = (camera: Camera, x: number, y: number): ScreenPoint => {
  const size = tileScreenPx(camera);
  return { x: (x - camera.x) * size, y: (y - camera.y) * size };
};

/**
 * The inverse of `tileToScreen`: which tile (fractional) a screen point is over.
 * Out-of-range results are *returned as they are* — clamping is a UI decision
 * (`pickTile`), not a property of the projection, and a projection that silently
 * clamped could not be unit-tested for round-tripping.
 */
export const screenToTilePoint = (camera: Camera, point: ScreenPoint): ScreenPoint => {
  const size = tileScreenPx(camera);
  return { x: camera.x + point.x / size, y: camera.y + point.y / size };
};

/**
 * The tile a screen point is over, as whole numbers, or `undefined` when the point
 * is outside the map. The map's own bounds are the only clamp: a point over the
 * ocean past the drawn map is `undefined`, which is the honest answer a cursor read
 * needs, rather than an invented tile index.
 */
export const screenToTile = (
  camera: Camera,
  extent: TileExtent,
  point: ScreenPoint,
): { readonly x: number; readonly y: number } | undefined => {
  const at = screenToTilePoint(camera, point);
  const x = Math.floor(at.x);
  const y = Math.floor(at.y);
  if (x < 0 || y < 0 || x >= extent.width || y >= extent.height) return undefined;
  return { x, y };
};

/** The screen rectangle a tile covers — the renderer's fill area, verbatim. */
export const tileRect = (
  camera: Camera,
  x: number,
  y: number,
): ScreenRect & { readonly size: number } => {
  const at = tileToScreen(camera, x, y);
  const size = tileScreenPx(camera);
  return { x: at.x, y: at.y, width: size, height: size, size };
};

/**
 * The round trip a hit-test must satisfy: screen point → tile → the *same* screen
 * rectangle, which must contain the original point. Used by the tests to prove the
 * forward mapping and the inverse agree for every zoom level and camera offset,
 * without depending on a canvas — the property INTERFACES.md's "a second inverse
 * mapping must not exist" is really asking for.
 */
export const tileRoundTrip = (
  camera: Camera,
  extent: TileExtent,
  point: ScreenPoint,
):
  | { readonly tile: { readonly x: number; readonly y: number }; readonly rect: ScreenRect }
  | undefined => {
  const tile = screenToTile(camera, extent, point);
  if (tile === undefined) return undefined;
  const rect = tileRect(camera, tile.x, tile.y);
  return {
    tile,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
};

/* ------------------------------------------------------------------ *
 * Camera construction, panning and zooming
 * ------------------------------------------------------------------ */

const zoomAt = (index: number): ZoomLevel => {
  const clamped = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index));
  // `ZOOM_LEVELS` is a non-empty literal; the fallback keeps
  // `noUncheckedIndexedAccess` honest rather than asserting.
  return (
    ZOOM_LEVELS[clamped] ?? ZOOM_LEVELS[ZOOM_DEFAULT_INDEX] ?? { numerator: 1, denominator: 1 }
  );
};

/** The default camera: zoom level `ZOOM_DEFAULT_INDEX`, showing the map's origin. */
export const defaultCamera = (): Camera => {
  const level = zoomAt(ZOOM_DEFAULT_INDEX);
  return { x: 0, y: 0, zoomNumerator: level.numerator, zoomDenominator: level.denominator };
};

/** This camera's index in `ZOOM_LEVELS` (the exact level, or the nearest one below). */
export const zoomIndexOf = (camera: Camera): number => {
  for (let index = ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    const level = ZOOM_LEVELS[index];
    if (level === undefined) continue;
    if (level.numerator === camera.zoomNumerator && level.denominator === camera.zoomDenominator) {
      return index;
    }
  }
  return ZOOM_DEFAULT_INDEX;
};

/**
 * Keep the camera over the map, and keep the map over the viewport.
 *
 * Two cases, and the second is the one that is easy to get wrong:
 *
 * - **The map is larger than the viewport**: the offset is clamped to
 *   `[0, mapTiles - viewportTiles]`, so the viewport can never show space beyond the
 *   map's far edge — a black band that looks like a rendering bug.
 * - **The map is smaller than the viewport** (a 4×4 test map at zoom 1, which is a
 *   real case in the unit tests and in a Playwright fixture): the map is *centred*,
 *   not pinned to the top-left. `Math.max` on a negative upper bound would otherwise
 *   put the map off-screen; centring gives a negative offset, which is exactly where
 *   the map belongs when it is narrower than the window.
 */
export const clampCamera = (camera: Camera, extent: TileExtent, viewport: ViewportSize): Camera => {
  const size = tileScreenPx(camera);
  const visibleX = viewport.width / size;
  const visibleY = viewport.height / size;

  const spanX = extent.width - visibleX;
  const spanY = extent.height - visibleY;

  const x = spanX >= 0 ? Math.min(spanX, Math.max(0, camera.x)) : spanX / 2;
  const y = spanY >= 0 ? Math.min(spanY, Math.max(0, camera.y)) : spanY / 2;

  return { ...camera, x, y };
};

/** Pan by a screen-pixel delta (`dx` positive drags the map right). */
export const panCamera = (
  camera: Camera,
  extent: TileExtent,
  viewport: ViewportSize,
  dx: number,
  dy: number,
): Camera => {
  const size = tileScreenPx(camera);
  return clampCamera(
    { ...camera, x: camera.x - dx / size, y: camera.y - dy / size },
    extent,
    viewport,
  );
};

/**
 * Move to the next (`steps > 0`) or previous zoom level, keeping the map point
 * under `anchor` pinned to `anchor` — the behaviour a pointer-centred wheel zoom
 * needs, written once here rather than in the event handler.
 */
export const zoomCamera = (
  camera: Camera,
  extent: TileExtent,
  viewport: ViewportSize,
  steps: number,
  anchor: ScreenPoint,
): Camera => {
  const next = zoomAt(zoomIndexOf(camera) + steps);
  const zoomed: Camera = {
    ...camera,
    zoomNumerator: next.numerator,
    zoomDenominator: next.denominator,
  };
  const before = screenToTilePoint(camera, anchor);
  const after = screenToTilePoint(zoomed, anchor);
  return clampCamera(
    { ...zoomed, x: zoomed.x + (before.x - after.x), y: zoomed.y + (before.y - after.y) },
    extent,
    viewport,
  );
};

/**
 * Centre the camera on a tile, as far as the clamp allows. Used by "select a unit
 * and follow it" and by the initial view, which centres the player's starting tile.
 */
export const centreOnTile = (
  camera: Camera,
  extent: TileExtent,
  viewport: ViewportSize,
  tile: { readonly x: number; readonly y: number },
): Camera =>
  clampCamera(
    {
      ...camera,
      x: tile.x - viewport.width / (2 * tileScreenPx(camera)),
      y: tile.y - viewport.height / (2 * tileScreenPx(camera)),
    },
    extent,
    viewport,
  );

/**
 * The half-open tile range the viewport currently covers: `x0..x1` inclusive,
 * clipped to the map. The renderer walks exactly this rectangle — never the whole
 * map — which is what keeps a 180×180 `huge` map drawable at 60 fps, and is also
 * why the draw trace's entry list is a function of the viewport rather than of the
 * map size.
 */
export const visibleTileBounds = (
  camera: Camera,
  extent: TileExtent,
  viewport: ViewportSize,
): { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number } => {
  const size = tileScreenPx(camera);
  const x0 = Math.max(0, Math.floor(camera.x));
  const y0 = Math.max(0, Math.floor(camera.y));
  const x1 = Math.min(extent.width - 1, Math.floor(camera.x + viewport.width / size));
  const y1 = Math.min(extent.height - 1, Math.floor(camera.y + viewport.height / size));
  return { x0, x1, y0, y1 };
};
