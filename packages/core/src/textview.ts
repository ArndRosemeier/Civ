/**
 * Text view — the agent's primary "eyes" on the game (PLAN.md 8.1).
 *
 * Requirements that shaped this file:
 *
 * - **Legibility for a reader with no other channel.** A header (seed, turn,
 *   revision, map size, civ count), a two-line column ruler, row numbers, one
 *   glyph per terrain *role*, and a legend that spells the glyphs out.
 * - **Deterministic and snapshot-testable.** Output is a pure function of
 *   `(state, ruleset, options)`; nothing iterates a hash map in insertion order
 *   in a way that could vary, and no line carries trailing whitespace.
 * - **Glyphs are role-based, not id-based**, so a ruleset that renames or
 *   renumbers its terrain still renders the same picture. A tile whose terrain
 *   id is not in the ruleset renders `?` and adds `? unknown` to the legend —
 *   a broken ruleset should be visible, not silently blank.
 * - **Player start markers** number players by index (`0`-`9`, then `*`), which
 *   is the same numbering used by `PlayerState.id`.
 */

import type { TerrainId } from './ids.js';
import {
  indexToX,
  indexToY,
  TERRAIN_ROLES,
  type GameMap,
  type RulesetView,
  type TerrainRole,
} from './map.js';
import type { GameState } from './state.js';

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DescribeOptions {
  readonly viewport?: Viewport;
  readonly showStarts?: boolean;
}

/** One glyph per terrain role. */
const ROLE_GLYPHS: Readonly<Record<TerrainRole, string>> = {
  ocean: '~',
  coast: ':',
  grassland: ',',
  plains: '-',
  hills: 'h',
  mountains: '^',
};

/** Glyph for a tile whose terrain id (or map slot) is not resolvable. */
const UNKNOWN_GLYPH = '?';

/** Markers are digits for the first ten players, then `*` for the rest. */
const DIGIT_MARKER_LIMIT = 10;

/** The visible rectangle actually rendered, after clamping to the map. */
interface Window {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** Floor a possibly non-finite number, falling back when it is not usable. */
const asInt = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.floor(value) : fallback;

/**
 * Clamp a requested viewport to the map. Origins are pulled inside the map and
 * extents are truncated to what remains, so an out-of-bounds viewport degrades
 * to the nearest legal window instead of producing blank or ragged output.
 */
const windowOf = (map: GameMap, viewport: Viewport | undefined): Window => {
  if (viewport === undefined) return { x0: 0, y0: 0, width: map.width, height: map.height };

  const x0 = clamp(asInt(viewport.x, 0), 0, Math.max(map.width - 1, 0));
  const y0 = clamp(asInt(viewport.y, 0), 0, Math.max(map.height - 1, 0));
  const width = clamp(asInt(viewport.width, map.width), 0, map.width - x0);
  const height = clamp(asInt(viewport.height, map.height), 0, map.height - y0);
  return { x0, y0, width, height };
};

/** Markers are per player *index*; `*` stands in past the digit range. */
const startMarker = (playerIndex: number): string =>
  playerIndex < DIGIT_MARKER_LIMIT ? String(playerIndex) : '*';

/** Strip trailing spaces: no line may carry invisible trailing whitespace. */
const stripEnd = (line: string): string => line.replace(/ +$/, '');

const headerLine = (state: GameState): string =>
  `CivTS state: seed=${String(state.seed)} turn=${String(state.turn)} ` +
  `revision=${String(state.revision)} map=${state.settings.mapSize}` +
  `(${String(state.map.width)}x${String(state.map.height)}) ` +
  `civs=${String(state.players.length)}`;

const viewLine = (view: Window, map: GameMap): string => {
  if (view.width === 0 || view.height === 0) {
    return `view: empty (map ${String(map.width)}x${String(map.height)})`;
  }
  const lastX = view.x0 + view.width - 1;
  const lastY = view.y0 + view.height - 1;
  return (
    `view: x ${String(view.x0)}..${String(lastX)}, y ${String(view.y0)}..${String(lastY)} ` +
    `(${String(view.width)}x${String(view.height)} of ${String(map.width)}x${String(map.height)})`
  );
};

/** Sparse tens ruler: the tens digit is written above every tenth column. */
const tensRuler = (view: Window): string => {
  let out = '';
  for (let x = view.x0; x < view.x0 + view.width; x++) {
    out += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ';
  }
  return out;
};

/** Units ruler: the last digit of every column number, so x is readable per tile. */
const unitsRuler = (view: Window): string => {
  let out = '';
  for (let x = view.x0; x < view.x0 + view.width; x++) out += String(x % 10);
  return out;
};

const legendLine = (sawUnknown: boolean): string => {
  const parts = TERRAIN_ROLES.map((role) => `${ROLE_GLYPHS[role]} ${role}`);
  if (sawUnknown) parts.push(`${UNKNOWN_GLYPH} unknown`);
  return `legend: ${parts.join('  ')}`;
};

/**
 * One line naming every player and its start tile, marking starts outside the
 * rendered window so a cropped view never looks like a player has vanished.
 */
const startsLine = (state: GameState, map: GameMap, view: Window): string => {
  const parts = state.players.map((player, index) => {
    const tile = player.startingTile;
    if (tile < 0 || tile >= map.terrain.length) {
      return `${startMarker(index)}=${player.name}(invalid)`;
    }
    const x = indexToX(map, tile);
    const y = indexToY(map, tile);
    const visible =
      x >= view.x0 && x < view.x0 + view.width && y >= view.y0 && y < view.y0 + view.height;
    return `${startMarker(index)}=${player.name}@${String(x)},${String(y)}${
      visible ? '' : ' (off-view)'
    }`;
  });
  return `starts: ${parts.join('  ')}`;
};

/**
 * Render `state` as deterministic ASCII.
 *
 * Layout (a real 20x10 crop of a duel map, so the alignment below is exact):
 *
 * ```
 * CivTS state: seed=42 turn=1 revision=0 map=duel(40x40) civs=2
 * view: x 20..39, y 18..27 (20x10 of 40x40)
 *    |2         3
 *    |01234567890123456789
 * 18 |,,----hh^^^hh--:~~~~
 * ...
 * legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains
 * starts: 0=Player 1@12,8 (off-view)  1=Player 2@25,33 (off-view)
 * ```
 *
 * The gutter is sized to the widest row number, the tens ruler writes a digit
 * only above every tenth column, and every line is right-stripped — output is
 * stable for a given `(state, ruleset, options)` and safe to snapshot.
 */
export const describe = (
  state: GameState,
  ruleset: RulesetView,
  options?: DescribeOptions,
): string => {
  const showStarts = options?.showStarts ?? true;
  const map = state.map;
  const view = windowOf(map, options?.viewport);

  const roleById = new Map<TerrainId, TerrainRole>();
  for (const def of ruleset.terrains) roleById.set(def.id, def.role);

  // Start markers keyed by flat tile index; the first player on a tile wins, so
  // a (malformed) shared start does not make the output order-dependent.
  const markerByTile = new Map<number, string>();
  if (showStarts) {
    for (const [index, player] of state.players.entries()) {
      const tile = player.startingTile;
      if (tile < 0 || tile >= map.terrain.length) continue;
      if (!markerByTile.has(tile)) markerByTile.set(tile, startMarker(index));
    }
  }

  let sawUnknown = false;
  const glyphAt = (x: number, y: number): string => {
    const id = map.terrain[y * map.width + x];
    if (id === undefined) {
      sawUnknown = true;
      return UNKNOWN_GLYPH;
    }
    const role = roleById.get(id);
    if (role === undefined) {
      sawUnknown = true;
      return UNKNOWN_GLYPH;
    }
    return ROLE_GLYPHS[role];
  };

  const labelWidth = Math.max(String(view.y0 + view.height - 1).length, 1);
  const gutter = ' '.repeat(labelWidth + 1);

  const lines: string[] = [headerLine(state), viewLine(view, map)];
  lines.push(stripEnd(`${gutter}|${tensRuler(view)}`));
  lines.push(stripEnd(`${gutter}|${unitsRuler(view)}`));

  for (let y = view.y0; y < view.y0 + view.height; y++) {
    let row = '';
    for (let x = view.x0; x < view.x0 + view.width; x++) {
      const marker = markerByTile.get(y * map.width + x);
      row += marker ?? glyphAt(x, y);
    }
    lines.push(stripEnd(`${String(y).padStart(labelWidth)} |${row}`));
  }

  lines.push(legendLine(sawUnknown));
  if (showStarts && state.players.length > 0) lines.push(startsLine(state, map, view));

  return `${lines.join('\n')}\n`;
};
