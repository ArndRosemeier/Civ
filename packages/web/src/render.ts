/**
 * Canvas map presentation, without game rules or RNG reads.
 *
 * Terrain artwork blends decoded textures using explored neighbours only. The compositing
 * cache lives in terrain-art.ts; this module draws its results with view.ts's shared projection.
 * Unexplored tiles stay opaque. Objects and roads are separate overlays, followed by territory,
 * settlements and unit stacks. The caller filters city/unit markers using the engine's visibility.
 * TERRAIN_COLOURS documents the graded terrain centres for clear-tile pixel probes; objects,
 * borders and the optional grid deliberately do not form part of that palette.
 */

import {
  UNOWNED,
  asTileIndex,
  indexToX,
  indexToY,
  ownerAt,
  type GameState,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { tileRect, visibleTileBounds, type Camera, type ScreenPoint } from './view.js';
import { terrainNeighbourhood, type TerrainArtwork } from './terrain-art.js';
import type { MapSprites } from './map-art.js';

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
  grassland: '#5b8a39',
  plains: '#b49245',
  hills: '#7d6b47',
  mountains: '#7d7e7f',
  ocean: '#29578d',
  coast: '#378d9f',
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
  /**
   * The owner the engine's `tileOwner` layer holds for this tile, or `null` when the layer says
   * `UNOWNED`. Copied verbatim: the trace is a claim about the frame, and the frame read the
   * layer, so a test can compare this against `state.tileOwner` tile for tile.
   */
  readonly owner: number | null;
  /**
   * Was a border band painted on this tile? True only where the tile is owned, the player has
   * explored it, and at least one of its four neighbours is owned by somebody else (or by
   * nobody, or is off the map) — see the module note on fog and on the edges of the world.
   */
  readonly border: boolean;
  /** Visible map objects actually painted on this tile, without unexplored information. */
  readonly features?: readonly string[];
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
  /** Visible working stacks, used to start/stop the presentation clock. */
  readonly workingTiles?: readonly TileIndex[];
}

/** A 2D context, narrowed to the calls this module makes. */
export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  imageSmoothingEnabled: boolean;
  font?: string;
  textAlign?: CanvasTextAlign;
  fillText?(text: string, x: number, y: number, maxWidth?: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
}

/**
 * A unit marker's shape, from the engine's own numbers: its tile, type, and whose it is.
 *
 * The renderer is handed the *identity* of what stands on a tile rather than deriving it, so
 * "is this mine?" is a comparison of two ids and not a game question. The type id selects the
 * sprite; the colour is the owner badge (and the triangle fallback).
 */
export interface UnitMarker {
  readonly id: UnitId;
  readonly tile: TileIndex;
  /** Engine unit type id — used to look up a sprite when `unitSprites` is supplied. */
  readonly type: string;
  readonly colour: string;
  readonly selected: boolean;
  readonly hitPoints?: number;
  readonly maxHitPoints?: number;
  readonly fortified?: boolean;
  readonly work?: { readonly kind: string; readonly turnsLeft: number };
}

/** A city marker: its tile, and the colour of its owner. */
export interface CityMarker {
  readonly tile: TileIndex;
  readonly colour: string;
  readonly name?: string;
  readonly population?: number;
}

/**
 * The colour a player's things are painted in — the app's own palette, asked by the renderer.
 *
 * A function rather than a copy of the palette, and deliberately: the unit markers, the city
 * markers and the territory tint all ask this one lookup (`main.ts`' `colourOfPlayer`), so "which
 * colour is player 2?" has one answer in this app rather than one per drawing layer. The renderer
 * is still a pure function of its input — the palette is an input, and it never changes mid-frame.
 */
export type OwnerColour = (owner: number) => string;

/**
 * Optional terrain textures keyed by terrain id. When present, an explored tile is painted with
 * `drawImage` instead of a flat fill; the documented `TERRAIN_COLOURS` remain the centre-sample
 * contract for tests. Missing ids (and all unexplored tiles) still use the flat palette.
 */
export type TerrainSpriteMap = Readonly<Partial<Record<string, CanvasImageSource>>>;

/** Optional unit sprites keyed by unit type id. */
export type UnitSpriteMap = Readonly<Partial<Record<string, CanvasImageSource>>>;

/** Everything a frame needs, all of it copied from the state or from presentation state. */
export interface FrameInput {
  readonly state: GameState;
  /** The exploring player's id — the index into `state.explored`. */
  readonly viewer: number;
  readonly camera: Camera;
  readonly viewport: ViewportPx;
  /**
   * The markers to draw. **The caller decides which ones those are, and this module never
   * filters them**: `main.ts` builds them from the engine's own answer — `visibleTiles` for a unit
   * (current sight, so a rival that walks out of range stops being drawn) and `isExplored` for a
   * city (`fog.ts`'s memory, so a city you have seen stays on the map). Handing this module the
   * whole state's unit list is what drew every unit of every player through the fog
   * (docs/KNOWN-ISSUES.md §3.13).
   */
  readonly units: readonly UnitMarker[];
  /** The city markers to draw, already chosen by the caller — see `units` above. */
  readonly cities: readonly CityMarker[];
  /** The colour per player, for the territory tint (M9) — see `OwnerColour`. */
  readonly ownerColour: OwnerColour;
  readonly cursor: { readonly x: number; readonly y: number } | null;
  /** Preloaded terrain sprites from `tiles.ts`; omit in unit tests that only assert borders. */
  readonly sprites?: TerrainSpriteMap;
  /** Preloaded unit sprites from `units.ts`; omit to keep the triangle fallback. */
  readonly unitSprites?: UnitSpriteMap;
  readonly terrainArtwork?: TerrainArtwork;
  readonly mapSprites?: MapSprites;
  /** Optional tactical grid; terrain is continuous by default. */
  readonly showGrid?: boolean;
  /** Presentation-only work cycle. Omitted (or zero) gives a static activity symbol. */
  readonly animationStep?: number;
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

/** The ownership layer's value on a tile, or `UNOWNED` for a tile that is off the map. */
const ownerOn = (state: GameState, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= state.map.width || y >= state.map.height) return UNOWNED;
  return ownerAt(state, asTileIndex(y * state.map.width + x)) ?? UNOWNED;
};

/**
 * Which of a tile's four outer edges a border band belongs on: the ones where the neighbour's
 * owner differs from this tile's. Off the map counts as unowned, so the edge of the world is the
 * edge of a territory rather than a border that stops one column early.
 */
interface BorderEdges {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
}

const borderEdges = (state: GameState, x: number, y: number, owner: number): BorderEdges => ({
  left: ownerOn(state, x - 1, y) !== owner,
  right: ownerOn(state, x + 1, y) !== owner,
  up: ownerOn(state, x, y - 1) !== owner,
  down: ownerOn(state, x, y + 1) !== owner,
});

/**
 * Deterministic mirror of a terrain sprite from the tile's coordinates, so adjacent tiles of the
 * same terrain do not look rubber-stamped. Presentation only — same `(x, y)` always flips the
 * same way; no RNG. Uses `translate`/`scale` so the caller's DPR transform stays intact.
 */
const paintTerrainSprite = (
  ctx: Canvas2D,
  sprite: CanvasImageSource,
  x: number,
  y: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  size: number,
): void => {
  const flip = (x * 3 + y * 5) & 3;
  const mirrorX = (flip & 1) === 1;
  const mirrorY = (flip & 2) === 2;
  ctx.imageSmoothingEnabled = size >= 16;
  ctx.save();
  ctx.translate(rect.x + (mirrorX ? rect.width : 0), rect.y + (mirrorY ? rect.height : 0));
  ctx.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1);
  ctx.drawImage(sprite, 0, 0, rect.width, rect.height);
  ctx.restore();
};

/** One owned tile's pending tint: where it is, in whose colour, and on which of its edges. */
interface Territory {
  readonly x: number;
  readonly y: number;
  readonly colour: string;
  readonly edges: BorderEdges;
}

/**
 * Draw one frame of the map and report what it drew.
 *
 * The walk is the projection's own `visibleTileBounds`, clipped to the map, and the fill is
 * `view.ts`'s `tileRect` — the *same* rectangle the hit-test inverts. A tile's terrain id comes
 * from `state.map.terrain` (an engine read), its explored flag from `state.explored[viewer]`
 * (also an engine read), and its owner from `borders.ts`' `ownerAt` over `state.tileOwner` — the
 * M9 ownership layer, read rather than recomputed. Resources, huts and improvements are read directly from their stored layers.
 *
 * Draw order is terrain, then territory, then cities, then units: a border band is drawn along the
 * tiles' outer edges and both kinds of marker are corner-anchored, so a marker drawn last is never
 * swallowed by a band — which is what keeps "the colour at a tile's centre" a claim about terrain
 * rather than about who owns the tile. Terrain itself is a texture when `sprites` is supplied,
 * otherwise the documented flat palette — same centre colour either way.
 */
export const drawFrame = (ctx: Canvas2D, input: FrameInput): FrameTrace => {
  const { state, camera, viewport } = input;
  const extent = { width: state.map.width, height: state.map.height };
  const bounds = visibleTileBounds(camera, extent, viewport);
  const exploredRow = state.explored[input.viewer];
  const size = tileRect(camera, 0, 0).size;
  // The band's thickness in CSS pixels, from the tile's own size: at the default zoom a tile is
  // 32 px and the band is 4, so it is visible at a glance and still leaves the tile's centre —
  // where the pixel tests sample terrain — untouched.
  const band = Math.max(2, Math.round(size / 8));
  const sprites = input.sprites;

  ctx.fillStyle = rgbCss(FOG_COLOUR);
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const tiles: DrawEntry[] = [];
  const renderedFeatures = new Map<number, string[]>();
  const territories: Territory[] = [];
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
      const owner = ownerOn(state, x, y);
      const blended = explored
        ? input.terrainArtwork?.tile(terrainNeighbourhood(state, input.viewer, x, y), x, y)
        : undefined;
      const sprite = explored ? sprites?.[terrainId] : undefined;
      if (blended !== undefined) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(blended, rect.x, rect.y, rect.width, rect.height);
      } else if (sprite !== undefined) {
        paintTerrainSprite(ctx, sprite, x, y, rect, size);
      } else {
        ctx.fillStyle = rgbCss(explored ? terrainColour(terrainId) : FOG_COLOUR);
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
      // The tactical grid is opt-in; continuous terrain is the default view.
      if (input.showGrid === true && rect.size >= 8) {
        ctx.strokeStyle = rgbCss(GRID_COLOUR);
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
      }
      // Territory is collected here and painted after the walk (see the module note on draw
      // order), because the band must not be covered by the next tile's terrain fill.
      const banded = explored && owner !== UNOWNED;
      const edges = banded ? borderEdges(state, x, y, owner) : undefined;
      if (edges !== undefined) {
        territories.push({
          x: rect.x,
          y: rect.y,
          colour: input.ownerColour(owner),
          edges,
        });
      }
      // The index is a real one: the walk is inside the map's own bounds, and the terrain lookup
      // above is what proved it. `asTileIndex` is the engine's own constructor for the branded id
      // — a widening, not an escape hatch.
      const features: string[] = [];
      renderedFeatures.set(tile, features);
      tiles.push({
        tile: asTileIndex(tile),
        x,
        y,
        terrain: terrainId,
        owner: owner === UNOWNED ? null : owner,
        border: edges !== undefined && (edges.left || edges.right || edges.up || edges.down),
        features,
      });
    }
  }

  // Roads and objects are drawn after ALL terrain, so tile draw order cannot erase a connection.
  const improvements = new Map<number, Set<string>>();
  for (const improvement of state.improvements) {
    const kinds = improvements.get(Number(improvement.tile)) ?? new Set<string>();
    kinds.add(improvement.kind);
    improvements.set(Number(improvement.tile), kinds);
  }
  const resources = new Map(
    state.map.resources.map((resource) => [Number(resource.tile), resource.resource]),
  );
  const huts = new Set<number>(state.map.huts);
  const cityTiles = new Set<number>(input.cities.map((city) => Number(city.tile)));
  for (const entry of tiles) {
    if (exploredRow?.[entry.tile] !== true) continue;
    const rect = tileRect(camera, entry.x, entry.y);
    const kinds = improvements.get(Number(entry.tile));
    if (kinds?.has('road') === true || cityTiles.has(Number(entry.tile))) {
      paintRoads(ctx, input, entry.x, entry.y, rect, improvements, cityTiles);
      renderedFeatures.get(Number(entry.tile))?.push('road');
    }
    const feature = (id: string, dx: number, dy: number, fraction: number): void => {
      const art = input.mapSprites?.[id];
      if (art === undefined) return;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(art, rect.x + size * dx, rect.y + size * dy, size * fraction, size * fraction);
      renderedFeatures.get(Number(entry.tile))?.push(id);
    };
    if (kinds?.has('irrigation') === true) feature('irrigation', 0.04, 0.08, 0.42);
    if (kinds?.has('mine') === true) feature('mine', 0.53, 0.52, 0.43);
    if (huts.has(Number(entry.tile))) feature('hut', 0.03, 0.03, 0.46);
    const resource = resources.get(Number(entry.tile));
    if (resource !== undefined) feature(resource, 0.57, 0.04, 0.38);
  }

  // The ownership tint: one band per edge where ownership changes, in the owner's own colour.
  for (const territory of territories) {
    const { x, y, edges } = territory;
    ctx.fillStyle = rgbCss(territory.colour);
    if (edges.left) ctx.fillRect(x, y, band, size);
    if (edges.right) ctx.fillRect(x + size - band, y, band, size);
    if (edges.up) ctx.fillRect(x, y, size, band);
    if (edges.down) ctx.fillRect(x, y + size - band, size, band);
  }

  // Settlements overlay their tile; terrain probes sample tiles without cities or units.
  for (const city of input.cities) {
    const rect = tileRect(camera, indexToX(state.map, city.tile), indexToY(state.map, city.tile));
    if (!onScreen(rect.x, rect.y, viewport, size)) continue;
    const population = city.population ?? 1;
    const art =
      input.mapSprites?.[
        population >= 8 ? 'city-capital' : population >= 4 ? 'city-town' : 'city-village'
      ];
    if (art !== undefined) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(art, rect.x + size * 0.05, rect.y, size * 0.9, size * 0.9);
      // A small ivory population badge also stays legible at the strategic zoom levels.
      const badge = Math.max(4, size * 0.22);
      ctx.fillStyle = rgbCss(CITY_COLOUR);
      ctx.fillRect(rect.x + size - badge - 2, rect.y + size - badge - 2, badge, badge);
      if (size >= 32 && ctx.fillText !== undefined) {
        ctx.font = `bold ${String(Math.max(10, Math.round(size / 5)))}px system-ui`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#243028';
        ctx.fillText(String(population), rect.x + size - badge / 2 - 2, rect.y + size - 4, badge);
        if (city.name !== undefined) {
          ctx.fillStyle = '#17231ee6';
          ctx.fillRect(rect.x + 2, rect.y + size - 16, size - badge - 5, 14);
          ctx.fillStyle = '#f2e6c8';
          ctx.font = '11px system-ui';
          ctx.fillText(city.name, rect.x + (size - badge) / 2, rect.y + size - 5, size - badge - 8);
        }
      }
    } else {
      const r = Math.max(2, size / 6);
      ctx.fillStyle = rgbCss(CITY_COLOUR);
      ctx.beginPath();
      ctx.arc(rect.x + size / 4, rect.y + size / 4, r, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.strokeStyle = rgbCss(city.colour);
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
  }

  const stacks = new Map<number, UnitMarker[]>();
  const workingTiles: TileIndex[] = [];
  for (const unit of input.units) {
    const stack = stacks.get(Number(unit.tile)) ?? [];
    stack.push(unit);
    stacks.set(Number(unit.tile), stack);
  }
  for (const stack of stacks.values()) {
    // Keep the selected unit on top instead of allowing a later array entry to cover it.
    const working = stack.find((marker) => marker.work !== undefined);
    const unit = stack.find((marker) => marker.selected) ?? working ?? stack[0];
    if (unit === undefined) continue;
    const rect = tileRect(camera, indexToX(state.map, unit.tile), indexToY(state.map, unit.tile));
    if (!onScreen(rect.x, rect.y, viewport, size)) continue;
    const sprite = input.unitSprites?.[unit.type];
    if (sprite !== undefined) {
      const pose = (input.animationStep ?? 0) % 6;
      const bob = unit.work === undefined ? 0 : (([0, -1, -2, -1, 0, 1][pose] ?? 0) * size) / 64;
      paintUnitSprite(ctx, sprite, unit.colour, rect, size, bob);
    } else {
      const inset = Math.max(1, size / 8);
      const half = size / 2;
      ctx.fillStyle = rgbCss(unit.colour);
      ctx.beginPath();
      ctx.moveTo(rect.x + inset, rect.y + size - inset);
      ctx.lineTo(rect.x + half, rect.y + inset);
      ctx.lineTo(rect.x + size - inset, rect.y + size - inset);
      ctx.closePath();
      ctx.fill();
    }
    if (unit.selected) {
      ctx.strokeStyle = rgbCss(SELECTION_COLOUR);
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
    }
    if (size >= 24) {
      const hp = unit.hitPoints ?? 1;
      const maximum = Math.max(1, unit.maxHitPoints ?? hp);
      const length = size * 0.5;
      ctx.fillStyle = '#19261d';
      ctx.fillRect(rect.x + size * 0.25 - 1, rect.y + 3, length + 2, 5);
      ctx.fillStyle = hp * 3 <= maximum ? '#dd7355' : hp * 3 <= maximum * 2 ? '#e0c466' : '#a8c879';
      ctx.fillRect(rect.x + size * 0.25, rect.y + 4, length * Math.min(1, hp / maximum), 3);
      if (stack.length > 1 || unit.fortified === true) {
        ctx.fillStyle = '#17231ee6';
        ctx.fillRect(rect.x + size - 17, rect.y + size - 17, 15, 15);
        ctx.fillStyle = '#f2e6c8';
        ctx.font = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText?.(
          stack.length > 1 ? String(stack.length) : 'F',
          rect.x + size - 9,
          rect.y + size - 5,
        );
      }
    }
    if (working?.work !== undefined) {
      workingTiles.push(unit.tile);
      paintWorkActivity(ctx, rect, working.work.kind, input.animationStep ?? 0);
    }
  }

  if (input.cursor !== null) {
    const rect = tileRect(camera, input.cursor.x, input.cursor.y);
    ctx.strokeStyle = '#f2e6c880';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
  }

  return { tiles, cursor: input.cursor, workingTiles };
};

/**
 * Paint a unit sprite in the lower portion of the tile, with a small owner-colour badge at the
 * bottom-left so ownership stays readable without tinting the art. Anchored away from the exact
 * tile centre so terrain centre samples on clear tiles stay meaningful.
 */
const paintUnitSprite = (
  ctx: Canvas2D,
  sprite: CanvasImageSource,
  ownerColour: string,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  size: number,
  bob = 0,
): void => {
  const spriteSize = Math.max(8, Math.round((size * 3) / 4));
  const dx = rect.x + Math.round((size - spriteSize) / 2);
  const dy = rect.y + size - spriteSize - Math.max(1, Math.round(size / 16));
  ctx.imageSmoothingEnabled = size >= 16;
  ctx.drawImage(sprite, dx, dy + bob, spriteSize, spriteSize);
  const badge = Math.max(3, Math.round(size / 6));
  const bx = rect.x + Math.max(1, Math.round(size / 16));
  const by = rect.y + size - badge - Math.max(1, Math.round(size / 16));
  ctx.fillStyle = rgbCss(ownerColour);
  ctx.fillRect(bx, by, badge, badge);
  ctx.strokeStyle = rgbCss(GRID_COLOUR);
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, badge - 1, badge - 1);
};

/** A swinging tool and strike particles remain visible even when the worker is in a stack. */
const paintWorkActivity = (
  ctx: Canvas2D,
  rect: { readonly x: number; readonly y: number; readonly size: number },
  kind: string,
  step: number,
): void => {
  const size = rect.size;
  const pose = step % 6;
  const [tipX, tipY] = [
    [13, 3],
    [17, 4],
    [21, 8],
    [20, 13],
    [17, 8],
    [14, 4],
  ][pose] ?? [13, 3];
  ctx.save();
  ctx.translate(rect.x + size * 0.59, rect.y + size * 0.23);
  ctx.scale(size / 64, size / 64);
  ctx.fillStyle = '#192b25e8';
  ctx.beginPath();
  ctx.arc(13, 13, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#edce83';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = '#d9ad65';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(7, 23);
  ctx.lineTo(tipX ?? 13, tipY ?? 3);
  ctx.stroke();
  ctx.strokeStyle = kind === 'irrigation' ? '#9ad1c9' : '#dbe1d7';
  ctx.lineWidth = kind === 'road' ? 5 : 3;
  ctx.beginPath();
  ctx.moveTo((tipX ?? 13) - 6, (tipY ?? 3) + 2);
  ctx.lineTo((tipX ?? 13) + 5, (tipY ?? 3) - 1);
  ctx.stroke();
  if (pose === 3 || pose === 4) {
    ctx.fillStyle = kind === 'irrigation' ? '#9ad1c9' : '#edce83';
    for (const [x, y] of [
      [18, 23],
      [24, 19],
      [27, 26],
    ]) {
      ctx.fillRect((x ?? 0) + (pose - 3) * 2, (y ?? 0) - (pose - 3) * 2, 2, 2);
    }
  }
  ctx.restore();
};

/** Eight-way road segments meet at identical edge/corner coordinates on neighbouring tiles. */
const paintRoads = (
  ctx: Canvas2D,
  input: FrameInput,
  x: number,
  y: number,
  rect: { readonly x: number; readonly y: number; readonly size: number },
  improvements: ReadonlyMap<number, ReadonlySet<string>>,
  cities: ReadonlySet<number>,
): void => {
  const paths: readonly [number, number][] = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  const connected = paths.filter(([dx, dy]) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= input.state.map.width || ny >= input.state.map.height)
      return false;
    const tile = ny * input.state.map.width + nx;
    return (
      input.state.explored[input.viewer]?.[tile] === true &&
      (improvements.get(tile)?.has('road') === true || cities.has(tile))
    );
  });
  // A newly built isolated road still gets a short track rather than an invisible point.
  const segments =
    connected.length > 0
      ? connected
      : [
          [-0.45, 0.2],
          [0.45, -0.2],
        ];
  for (const [colour, width] of [
    ['#514835', Math.max(2, rect.size / 14)],
    ['#d5bc87', Math.max(1, rect.size / 28)],
  ] as const) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [dx, dy] of segments) {
      ctx.moveTo(rect.x + rect.size / 2, rect.y + rect.size / 2);
      ctx.lineTo(
        rect.x + (rect.size * (1 + (dx ?? 0))) / 2,
        rect.y + (rect.size * (1 + (dy ?? 0))) / 2,
      );
    }
    ctx.stroke();
  }
};

/** Does this tile intersect the canvas at the current zoom? */
const onScreen = (x: number, y: number, viewport: ViewportPx, size: number): boolean =>
  x + size > 0 && y + size > 0 && x < viewport.width && y < viewport.height;

/** A screen point, offset by the canvas's own page position — the hit-test's first step. */
export const withinCanvas = (point: ScreenPoint, viewport: ViewportPx): boolean =>
  point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
