/**
 * The map renderer and its palette — the presentation half, with no game rules in it.
 * See docs/INTERFACES.md, M8 ("Rendering, and how it is tested (§16.2)").
 *
 * ## What this module decides, and what it refuses to decide
 *
 * It decides **presentation**: which rectangle a tile occupies (`view.ts`'s projection, called,
 * never re-derived), which colour a terrain id is painted in, where a unit marker sits, and how
 * a tile nobody has explored is dimmed. It decides **nothing** about the game: it never asks
 * whether a move is legal, never computes a cost, a yield or an outcome, and never reads the
 * RNG. The two facts it takes from the state — each tile's terrain id and the exploring player's
 * `explored` row — are copied verbatim into the frame, and the visible-tile walk is the
 * projection's own `visibleTileBounds`, so a tile outside the viewport is never drawn and a tile
 * inside it always is.
 *
 * ## The palette is the app's own statement of what it paints
 *
 * `TERRAIN_COLOURS` is exported as a plain record of `#rrggbb` strings, which is what the e2e
 * suite's palette probe reads (`e2e/helpers.ts`' `paletteOf`, source 2): a pixel sample is then
 * checked against the colour the **renderer** documents, rather than against a swatch the test
 * invented. The six ids are the shipped ruleset's own terrain catalog; `FALLBACK_TERRAIN_COLOUR`
 * covers a ruleset that ships a row this build has never heard of, so the renderer stays total
 * (a tile with an unknown terrain is painted, not skipped) without pretending to know it.
 *
 * That default is deliberately a colour no shipped terrain uses: an unknown row is visible as
 * "something this build does not paint", which is the honest reading, rather than a plausible
 * green that would make a missing palette entry look like grassland.
 *
 * ## Unexplored tiles
 *
 * Fog is the engine's memory (`state.explored`), and it arrives here as a plain boolean per tile.
 * An unexplored tile is painted in one flat `FOG_COLOUR`: terrain is not masked out of the draw
 * trace — the trace is a claim about what the frame drew, and the frame genuinely walked that
 * tile — but no terrain colour reaches the canvas for a tile the player has never seen, so
 * reading the pixels cannot reveal terrain the player has not explored. That is a presentation
 * decision and it is stated here rather than implied.
 *
 * ## Determinism
 *
 * Integer arithmetic, comparisons and `Math.floor`/`Math.round`/`Math.min`/`Math.max` only. No
 * clock, no randomness, no transcendentals: the frame is a pure function of
 * `(state, camera, viewport)`, so two runs of the same game draw the same pixels and the same
 * draw trace.
 */

import {
  asTileIndex,
  indexToX,
  indexToY,
  type GameState,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { tileRect, visibleTileBounds, type Camera, type ScreenPoint } from './view.js';

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

/**
 * One colour per terrain id, as `#rrggbb`. Six flat greens-to-blues, chosen so that **any two
 * differ by far more than a rounding error** in each channel: the pixel tests assert that two
 * different terrains are painted differently, and a palette whose sea differed from its grassland
 * by 2/255 would satisfy the code and fail the reader.
 *
 * The exact numbers are presentation and nothing else — no rule, no yield and no hash reads them.
 */
export const TERRAIN_COLOURS: Readonly<Record<string, string>> = {
  grassland: '#4a9d4a',
  plains: '#b8a24a',
  hills: '#8a7a52',
  mountains: '#8c8c94',
  ocean: '#1d4f8a',
  coast: '#3aa0c8',
};

/** Painted for a terrain id this build has no colour for — never a colour a shipped terrain uses. */
export const FALLBACK_TERRAIN_COLOUR = '#ff00ff';

/** One flat tone for a tile the acting player has never explored. */
export const FOG_COLOUR = '#31394a';

/** The grid line between tiles. */
export const GRID_COLOUR = '#20262e';

/** A city's marker and outline — the player's own colour is used beside it. */
export const CITY_COLOUR = '#f2e6c8';

/** The marker drawn for a unit whose owner is not the acting player. */
export const FOE_COLOUR = '#e0523c';

/** The tile outline drawn under the acting player's selected unit. */
export const SELECTION_COLOUR = '#ffffff';

/** The terrain colour this build paints `terrainId` in. Total: unknown ids get the fallback. */
export const terrainColour = (terrainId: string): string =>
  TERRAIN_COLOURS[terrainId] ?? FALLBACK_TERRAIN_COLOUR;

/* ------------------------------------------------------------------ *
 * The frame
 * ------------------------------------------------------------------ */

/** The canvas size, in CSS pixels. */
export interface ViewportPx {
  readonly width: number;
  readonly height: number;
}

/** One tile the frame drew, and what it was drawn as. */
export interface DrawEntry {
  readonly tile: TileIndex;
  readonly x: number;
  readonly y: number;
  readonly terrain: string;
}

/**
 * What the last frame drew, in draw order.
 *
 * **Bounded and documented**, as the contract asks: the renderer walks the viewport's own tile
 * rectangle and stops after `DRAW_TRACE_LIMIT` entries, so the traced list is a function of the
 * viewport rather than of the map size — 20 000 tiles on a zoomed-out huge map would otherwise be
 * a 20 000-element array rebuilt every frame for the benefit of nobody. The cap is far above any
 * viewport this app can produce (the canvas is at most `MAX_CANVAS_PX` wide, so the smallest tile
 * the renderer draws is 8 CSS pixels and the trace holds thousands of entries), which is why the
 * e2e suite can assert containment in both directions on every map size it plays.
 */
export const DRAW_TRACE_LIMIT = 8192;

/** What a drawn frame reports. */
export interface FrameTrace {
  readonly tiles: readonly DrawEntry[];
  /** The tile the pointer is over, or `null` — the description's second fact. */
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

/** A 2D context, narrowed to the calls this module makes. */
export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
}

/**
 * A unit marker's shape, from the engine's own numbers: its tile, and whose it is.
 *
 * The renderer is handed the *identity* of what stands on a tile rather than deriving it, so
 * "is this mine?" is a comparison of two ids and not a game question.
 */
export interface UnitMarker {
  readonly id: UnitId;
  readonly tile: TileIndex;
  readonly colour: string;
  readonly selected: boolean;
}

/** A city marker: its tile, and the colour of its owner. */
export interface CityMarker {
  readonly tile: TileIndex;
  readonly colour: string;
}

/** Everything a frame needs, all of it copied from the state or from presentation state. */
export interface FrameInput {
  readonly state: GameState;
  /** The exploring player's id — the index into `state.explored`. */
  readonly viewer: number;
  readonly camera: Camera;
  readonly viewport: ViewportPx;
  readonly units: readonly UnitMarker[];
  readonly cities: readonly CityMarker[];
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

/** The `#rrggbb` colour parsed into three 0-255 channels. */
const rgbOf = (colour: string): { readonly r: number; readonly g: number; readonly b: number } => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (match === null) return { r: 255, g: 0, b: 255 };
  return {
    r: Number.parseInt(match[1] ?? 'ff', 16),
    g: Number.parseInt(match[2] ?? 'ff', 16),
    b: Number.parseInt(match[3] ?? 'ff', 16),
  };
};

/** The same colour as a CSS `rgb(...)` string, for a fill with no alpha arithmetic. */
export const rgbCss = (colour: string): string => {
  const { r, g, b } = rgbOf(colour);
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
};

/** A colour `t` percent of the way to black, in integer arithmetic. Presentation only. */
export const darken = (colour: string, t: number): string => {
  const { r, g, b } = rgbOf(colour);
  const mix = (channel: number): number => Math.round((channel * (100 - t)) / 100);
  return `rgb(${String(mix(r))}, ${String(mix(g))}, ${String(mix(b))})`;
};

/**
 * Draw one frame of the map and report what it drew.
 *
 * The walk is the projection's own `visibleTileBounds`, clipped to the map, and the fill is
 * `view.ts`'s `tileRect` — the *same* rectangle the hit-test inverts. A tile's terrain id comes
 * from `state.map.terrain` (an engine read), its explored flag from `state.explored[viewer]`
 * (also an engine read), and nothing else on the tile is inspected.
 */
export const drawFrame = (ctx: Canvas2D, input: FrameInput): FrameTrace => {
  const { state, camera, viewport } = input;
  const extent = { width: state.map.width, height: state.map.height };
  const bounds = visibleTileBounds(camera, extent, viewport);
  const exploredRow = state.explored[input.viewer];

  ctx.fillStyle = rgbCss(FOG_COLOUR);
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const tiles: DrawEntry[] = [];
  for (let y = bounds.y0; y <= bounds.y1; y += 1) {
    for (let x = bounds.x0; x <= bounds.x1; x += 1) {
      if (tiles.length >= DRAW_TRACE_LIMIT) break;
      // The walk is inside `visibleTileBounds`, which is already clipped to the map, so `(x, y)`
      // is a real tile. The lookup is a bound check rather than a cast: a state whose terrain
      // array is shorter than its dimensions is corrupt, and drawing nothing for it is the
      // honest answer (the same reading `view.ts` takes of a missing zoom level).
      const tile = y * state.map.width + x;
      const terrainId = state.map.terrain[tile];
      if (terrainId === undefined) continue;
      const rect = tileRect(camera, x, y);
      const explored = exploredRow?.[tile] === true;
      ctx.fillStyle = rgbCss(explored ? terrainColour(terrainId) : FOG_COLOUR);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      // A one-pixel grid line, drawn inside the tile so neighbouring fills never land on a
      // sampled centre. It is presentation and it is cheap; it makes the tile grid readable at
      // every zoom level, which the screenshots are reviewed for.
      if (rect.size >= 8) {
        ctx.strokeStyle = rgbCss(GRID_COLOUR);
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
      }
      // The index is a real one: the walk is inside the map's own bounds, and the terrain lookup
      // above is what proved it. `asTileIndex` is the engine's own constructor for the branded id
      // — a widening, not an escape hatch.
      tiles.push({ tile: asTileIndex(tile), x, y, terrain: terrainId });
    }
  }

  // Markers, deliberately small and corner-anchored: the pixel tests sample a tile's CENTRE, and
  // a marker that covered the centre would make "the colour of grassland" depend on what was
  // standing there. A marker therefore never reaches the middle of a tile.
  const size = tileRect(camera, 0, 0).size;
  for (const city of input.cities) {
    const rect = tileRect(camera, indexToX(state.map, city.tile), indexToY(state.map, city.tile));
    if (!onScreen(rect.x, rect.y, viewport)) continue;
    const r = Math.max(2, size / 6);
    ctx.fillStyle = rgbCss(CITY_COLOUR);
    ctx.beginPath();
    ctx.arc(rect.x + size / 4, rect.y + size / 4, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = rgbCss(city.colour);
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
  }

  for (const unit of input.units) {
    const rect = tileRect(camera, indexToX(state.map, unit.tile), indexToY(state.map, unit.tile));
    if (!onScreen(rect.x, rect.y, viewport)) continue;
    const inset = Math.max(1, size / 8);
    const half = size / 2;
    ctx.fillStyle = rgbCss(unit.colour);
    ctx.beginPath();
    ctx.moveTo(rect.x + inset, rect.y + size - inset);
    ctx.lineTo(rect.x + half, rect.y + inset);
    ctx.lineTo(rect.x + size - inset, rect.y + size - inset);
    ctx.closePath();
    ctx.fill();
    if (unit.selected) {
      ctx.strokeStyle = rgbCss(SELECTION_COLOUR);
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
    }
  }

  return { tiles, cursor: input.cursor };
};

/** Is this tile's top-left corner inside the canvas (with one tile of slack for the edges)? */
const onScreen = (x: number, y: number, viewport: ViewportPx): boolean =>
  x > -64 && y > -64 && x < viewport.width + 64 && y < viewport.height + 64;

/** A screen point, offset by the canvas's own page position — the hit-test's first step. */
export const withinCanvas = (point: ScreenPoint, viewport: ViewportPx): boolean =>
  point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
