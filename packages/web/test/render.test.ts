/**
 * The renderer's M9 border layer, tested where it is decided rather than through pixels.
 *
 * `drawFrame` is a **pure function of its input** (the module note says why: no clock, no
 * randomness), so a unit test can drive it with a recording 2D context and assert exactly what the
 * frame painted — which is the same claim the e2e suite makes through the draw trace and the pixel
 * sample, one layer down and much cheaper. Three things are checked here and nothing else:
 *
 * 1. the ownership reported by the trace is the ENGINE's own `tileOwner` layer, tile for tile;
 * 2. a border is drawn exactly where ownership changes, in the owner's colour, and never on a tile
 *    the player has not explored (fog must not leak a rival's territory — see `render.ts`);
 * 3. two draws of the same state produce the same frame, which is the determinism the e2e spec
 *    checks end to end.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asTileIndex,
  indexToX,
  indexToY,
  newGame,
  ownerAt,
  UNOWNED,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { drawFrame, rgbCss, type Canvas2D, type FrameTrace } from '../src/render.js';
import { centreOnTile, defaultCamera } from '../src/view.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(21, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');

const P0: PlayerId = started.value.players[0]?.id ?? (0 as PlayerId);
const settler = started.value.units.find((unit) => unit.owner === P0 && unit.type === 'settler');
if (settler === undefined) throw new Error('the acting seat has no settler');
const founded = applyCommand(started.value, P0, { type: 'FoundCity', unitId: settler.id }, RULESET);
if (!founded.ok) throw new Error('founding the first city was refused');

/** A real board with a real city on it — the ownership layer is written by the engine, not here. */
const STATE: GameState = founded.value.state;
const CITY = STATE.cities[0];
if (CITY === undefined) throw new Error('the founded city is missing from the state');

const VIEWPORT = { width: 720, height: 540 };

/** The app's own colour lookup, mirrored here so the frame is driven with a real palette. */
const colourOf = (owner: number): string =>
  STATE.players.find((player) => player.id === owner)?.color ?? '#d0d0d0';

interface Fill {
  readonly colour: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A 2D context that paints nothing and records every fill with the style in force at the time. */
const recordingContext = (): { readonly ctx: Canvas2D; readonly fills: Fill[] } => {
  const fills: Fill[] = [];
  const paint = { fill: '#000000', stroke: '#000000' };
  const ctx: Canvas2D = {
    get fillStyle(): string {
      return paint.fill;
    },
    set fillStyle(value: string) {
      paint.fill = value;
    },
    get strokeStyle(): string {
      return paint.stroke;
    },
    set strokeStyle(value: string) {
      paint.stroke = value;
    },
    lineWidth: 1,
    imageSmoothingEnabled: false,
    fillRect(x, y, width, height): void {
      fills.push({ colour: paint.fill, x, y, width, height });
    },
    strokeRect(): void {},
    drawImage(): void {},
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    closePath(): void {},
    fill(): void {},
    stroke(): void {},
    arc(): void {},
    save(): void {},
    restore(): void {},
    translate(): void {},
    scale(): void {},
    setTransform(): void {},
    clearRect(): void {},
  };
  return { ctx, fills };
};

/** A frame centred on the city, so the tiles it owns are the tiles the frame walks. */
const cityCamera = () =>
  centreOnTile(defaultCamera(), { width: STATE.map.width, height: STATE.map.height }, VIEWPORT, {
    x: indexToX(STATE.map, CITY.tile),
    y: indexToY(STATE.map, CITY.tile),
  });

/** One whole frame, drawn with a fresh recorder. */
const drawCityFrame = (): { readonly trace: FrameTrace; readonly fills: readonly Fill[] } => {
  const recorder = recordingContext();
  const trace = drawFrame(recorder.ctx, {
    state: STATE,
    viewer: Number(P0),
    camera: cityCamera(),
    viewport: VIEWPORT,
    units: [],
    cities: [],
    ownerColour: colourOf,
    cursor: null,
  });
  return { trace, fills: recorder.fills };
};

describe('drawFrame — the border layer', () => {
  const drawn = drawCityFrame();
  const trace = drawn.trace;
  const recorder = { fills: drawn.fills };

  it('reports the ownership the ENGINE holds, tile for tile', () => {
    expect(trace.tiles.length, 'the frame drew no tiles').toBeGreaterThan(0);
    for (const entry of trace.tiles) {
      const owner = ownerAt(STATE, entry.tile);
      expect(entry.owner, `trace disagrees with tileOwner on tile ${String(entry.tile)}`).toBe(
        owner === undefined ? null : Number(owner),
      );
      expect(entry.x).toBe(indexToX(STATE.map, entry.tile));
      expect(entry.y).toBe(indexToY(STATE.map, entry.tile));
    }
  });

  it('finds the city’s claim in the layer, so the border cases below are not vacuous', () => {
    const owned = trace.tiles.filter((entry) => entry.owner !== null);
    expect(
      owned.length,
      'no drawn tile is owned, so nothing about borders could be tested',
    ).toBeGreaterThan(0);
    expect(
      owned.every((entry) => entry.owner === Number(P0)),
      'the declared map or the fog is wrong',
    ).toBe(true);
  });

  it('marks a border exactly where ownership changes, and never on an unexplored tile', () => {
    const width = STATE.map.width;
    const ownerOn = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= width || y >= STATE.map.height) return UNOWNED;
      const value = ownerAt(STATE, asTileIndex(y * width + x));
      return value === undefined ? UNOWNED : Number(value);
    };

    for (const entry of trace.tiles) {
      const owner = entry.owner;
      const explored = STATE.explored[Number(P0)]?.[entry.tile] === true;
      const foreign =
        owner === null
          ? false
          : ownerOn(entry.x - 1, entry.y) !== owner ||
            ownerOn(entry.x + 1, entry.y) !== owner ||
            ownerOn(entry.x, entry.y - 1) !== owner ||
            ownerOn(entry.x, entry.y + 1) !== owner;
      expect(
        entry.border,
        `tile ${String(entry.tile)} (owner ${String(owner)}, explored ${String(explored)})`,
      ).toBe(owner !== null && explored && foreign);
    }

    const borders = trace.tiles.filter((entry) => entry.border);
    expect(
      borders.length,
      'the city claims tiles but no border was drawn for any of them',
    ).toBeGreaterThan(0);
    expect(borders.every((entry) => entry.owner !== null)).toBe(true);
  });

  it("paints the tint in the owner's own colour, as bands inside the tile", () => {
    const wanted = rgbCss(colourOf(Number(P0)));
    const bands = recorder.fills.filter((fill) => fill.colour === wanted);
    expect(
      bands.length,
      `no fill used the owner's colour ${wanted}, so the tint never reached the canvas`,
    ).toBeGreaterThan(0);
    // A band is a thin strip of a tile, not the tile: the terrain at a tile's centre stays the
    // terrain, which is what keeps the pixel tests' terrain samples meaningful.
    const size = bands[0]?.height ?? 0;
    expect(size).toBeGreaterThan(0);
    expect(
      bands.some((band) => band.width < 32 || band.height < 32),
      'every fill in the owner’s colour covers a whole tile, so this is a fill and not a border',
    ).toBe(true);
  });

  it('draws the same frame twice — the renderer is a pure function of the state', () => {
    const first = drawCityFrame();
    const second = drawCityFrame();
    expect(JSON.stringify(second.trace)).toBe(JSON.stringify(first.trace));
    expect(JSON.stringify(second.fills)).toBe(JSON.stringify(first.fills));
  });
});
