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
 * - **Goody huts are drawn** (M3, "Goody huts"): a hut is map data the reader has
 *   to be able to see, because a hut is the one place a unit walks to and gets
 *   something for free. `%` is the glyph — distinct from every terrain role's
 *   glyph, from `?`, and from the start-marker digits — and it joins the legend
 *   exactly when it is drawn, the way `? unknown` and `? unexplored` do. A hut on
 *   a tile the viewer has not explored is not drawn and adds no legend entry:
 *   fog hides the feature, not just the terrain under it.
 * - **Player start markers** number the *civilizations* by player index (`0`-`9`,
 *   then `*`), which is the same numbering used by `PlayerState.id`. Barbarians
 *   are a player but have no homeland (see `startsLine`).
 * - **Fog is a viewer question, not a map question.** With no `viewer` the full
 *   map renders — god mode, the debugging view the CLI has always printed. With
 *   a `viewer`, the picture is what *that player* has explored: unexplored tiles
 *   render `?`, and nothing about them leaks — not the terrain, not a start
 *   marker, not a start coordinate. See `viewer` in `DescribeOptions`.
 * - **Work in progress is drawn as a line, not as a glyph** (M4a). A worker's job
 *   is a fact about a *unit*, and the map has no per-unit marking of any kind —
 *   inventing a glyph for "a worker is here" would have to answer what happens
 *   when a worker stands on a hut, on a start tile or in fog. So a job is named on
 *   its own `work:` line, exactly as `starts:` names tiles that the grid can only
 *   mark with an ambiguous digit, and the reader gets the unit id, where the job
 *   is, what it is doing and how many turns are left. It is drawn *only when
 *   something is being worked*, the rule the `% hut` legend entry follows (nothing
 *   is said about a feature that is not on the board), and through a `viewer` only
 *   for jobs on explored tiles, because a worker nobody can see is not knowledge
 *   that player has.
 */

import type { PlayerId, TerrainId, UnitTypeId } from './ids.js';
import { improvementDef, type ImprovementId } from './improvements.js';
import {
  indexToX,
  indexToY,
  TERRAIN_ROLES,
  type GameMap,
  type RulesetView,
  type TerrainRole,
} from './map.js';
import { civPlayers, type GameState } from './state.js';
import { unitDef, type UnitWork } from './units.js';

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DescribeOptions {
  readonly viewport?: Viewport;
  readonly showStarts?: boolean;
  /**
   * Render from this player's point of view: only tiles in its explored row are
   * drawn, everything else is `?` (INTERFACES.md "Fog"). Absent means god mode —
   * the whole map, exactly as before this option existed, so existing callers
   * and snapshots are unaffected. `viewer` is a `PlayerId`, and an id with no
   * explored row simply sees nothing.
   */
  readonly viewer?: PlayerId;
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

/**
 * Glyph for a tile the viewer has never explored. The same character as
 * `UNKNOWN_GLYPH` is deliberate — INTERFACES.md fixes `?` for unexplored — so
 * the legend disambiguates the two cases by naming both.
 */
const UNEXPLORED_GLYPH = '?';

/**
 * Glyph for a goody hut (M3, "Goody huts"). It must be readable *as itself*: it
 * is not one of `ROLE_GLYPHS`' terrain glyphs, not `?` (unknown or unexplored),
 * and not a start marker (`0`-`9` or `*`), so a reader can never mistake a hut
 * for terrain, for fog, or for a civilization's home. `%` is chosen because it
 * appears in none of those sets and stands out in a field of `,`/`-`/`~`.
 */
const HUT_GLYPH = '%';

/**
 * The row a viewer sees when the state has no explored row for it — a player id
 * that names nobody. An empty row answers "never explored" for every tile, which
 * is exactly right, and it keeps *god mode* (no viewer at all) a distinct thing:
 * the mode is decided by whether a viewer was given, never by whether a row was
 * found.
 */
const NO_EXPLORED_ROW: readonly boolean[] = [];

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

/**
 * The header's `civs=` field asks `civPlayers`, never `players.length`: M3 appends
 * a barbarian player to `players`, so the array length is the number of *player
 * identities*, one more than the number of civilizations, and a `civs=3` for a
 * two-civilization game is simply a wrong count (INTERFACES.md M3, "State shape":
 * anything that means "how many civilizations" must use `civPlayers`).
 */
const headerLine = (state: GameState, viewer: PlayerId | undefined): string =>
  `CivTS state: seed=${String(state.seed)} turn=${String(state.turn)} ` +
  `revision=${String(state.revision)} map=${state.settings.mapSize}` +
  `(${String(state.map.width)}x${String(state.map.height)}) ` +
  `civs=${String(civPlayers(state).length)}` +
  // God mode has no viewer, so it says nothing extra: the no-`viewer` header is
  // byte-for-byte what it was before this option existed.
  (viewer === undefined ? '' : ` viewer=${String(viewer)}`);

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

const legendLine = (sawUnknown: boolean, sawUnexplored: boolean, sawHut: boolean): string => {
  const parts = TERRAIN_ROLES.map((role) => `${ROLE_GLYPHS[role]} ${role}`);
  // Only when one was drawn, like `? unknown` below: a legend entry is a claim
  // that the glyph is on the map. In viewer mode this also keeps a hut the viewer
  // has not explored out of the legend entirely, which is what "nothing about an
  // unexplored tile leaks" means for a feature that is not terrain.
  if (sawHut) parts.push(`${HUT_GLYPH} hut`);
  if (sawUnknown) parts.push(`${UNKNOWN_GLYPH} unknown`);
  // Only in viewer mode, and only when a `?` actually came from fog: god mode
  // must keep the legend it has always printed.
  if (sawUnexplored) parts.push(`${UNEXPLORED_GLYPH} unexplored`);
  return `legend: ${parts.join('  ')}`;
};

/**
 * One line naming every **civilization** and its start tile, marking starts
 * outside the rendered window so a cropped view never looks like a player has
 * vanished.
 *
 * **Civilizations only — the ruling on starts.** `starts:` is the legend for the
 * digits painted on the map, and the digits are for civilizations. Barbarians are
 * a player (M3, "State shape": `PlayerId` is the index into `players`, and
 * `explored` is row-indexed by it), but they have no homeland: `newGame` gives
 * them no settler and points their `startingTile` at the map's first goody hut as
 * a required-field convention. Painting a start digit there and naming it here
 * would tell the reader something false — that a civilization begins where a
 * barbarian band will come from — and it would hide a *hut*, the one feature a
 * unit wants to walk to, behind a marker that means "home". So this line iterates
 * `civPlayers(state)`, exactly like the header's `civs=` count and for the same
 * reason: it answers a question about civilizations. The barbarians stay a player
 * in `state.players`, with an id, a colour, a fog row and (later) units — which
 * is all a band from a hut needs.
 *
 * `explored` (present only in viewer mode) is the viewer's fog row, and a start
 * the viewer has not explored is omitted entirely — a `starts:` line that
 * recited every opponent's coordinates would leak through the fog the map
 * itself is hiding. Omitted starts are counted, so the line stays honest about
 * what it left out (`civs=` in the header already states how many there are).
 */
const startsLine = (
  state: GameState,
  map: GameMap,
  view: Window,
  explored: readonly boolean[] | undefined,
): string => {
  const parts: string[] = [];
  let hidden = 0;

  for (const player of civPlayers(state)) {
    const tile = player.startingTile;
    if (explored !== undefined && explored[tile] !== true) {
      hidden += 1;
      continue;
    }
    // The marker is the player's own `id`, which *is* its index in `players`
    // (M3) — the same numbering `startMarker` paints on the map. Deriving it from
    // the player rather than from a loop counter means the digit and the player
    // cannot drift apart if the array ever stops being "civilizations first".
    if (tile < 0 || tile >= map.terrain.length) {
      parts.push(`${startMarker(Number(player.id))}=${player.name}(invalid)`);
      continue;
    }
    const x = indexToX(map, tile);
    const y = indexToY(map, tile);
    const visible =
      x >= view.x0 && x < view.x0 + view.width && y >= view.y0 && y < view.y0 + view.height;
    parts.push(
      `${startMarker(Number(player.id))}=${player.name}@${String(x)},${String(y)}${
        visible ? '' : ' (off-view)'
      }`,
    );
  }

  if (hidden > 0) parts.push(`(+${String(hidden)} unexplored)`);
  return `starts: ${parts.join('  ')}`;
};

/**
 * What a job is doing, as a reader needs it: `mining, 2 turns left`.
 *
 * The *verb* comes from the improvement's **kind**, which is the engine's own
 * vocabulary (`IMPROVEMENT_KINDS`), so a ruleset that renames a row or spells its
 * ids differently still renders a job the engine understands. The catalog row is
 * looked up only to learn that kind, and a job naming an improvement this ruleset
 * cannot describe falls back to the raw id — the same "read what is there" the
 * renderer applies to an unknown terrain id. The fact that the work is happening
 * belongs to the *state*, and it has to be visible even when the catalog cannot
 * name it: a reader who saw nothing at all would think the worker idle.
 *
 * The turn count is the state's `turnsLeft`, verbatim — this function states no
 * rule about how long a job takes (the catalog's `turns` and the turn pipeline
 * own that), it only says what is left.
 *
 * Exported because the REPL prints the same fact in its `units` line, its `units`
 * table and its `state` view: one mapping from a job to prose, not three that can
 * drift apart.
 */
export const workSummary = (ruleset: RulesetView, work: UnitWork): string =>
  `${workActivity(ruleset, work.kind)}, ${String(work.turnsLeft)} turn${
    work.turnsLeft === 1 ? '' : 's'
  } left`;

/** The activity word behind `workSummary`: `road` → `building a road`, and so on. */
const workActivity = (ruleset: RulesetView, kind: ImprovementId): string => {
  const def = improvementDef(ruleset, kind);
  // No row, no kind: the id is all that is known about the job, and printing it
  // is truer than printing a verb invented for it.
  if (def === undefined) return kind;
  switch (def.kind) {
    case 'road':
      return 'building a road';
    case 'mine':
      return 'mining';
    case 'irrigation':
      return 'irrigating';
    default:
      // A foreign catalog can carry a kind this build does not know; its own name
      // is then the only honest description of the job.
      return def.name.toLowerCase();
  }
};

/** The type name of a unit, or its raw type id when the ruleset cannot name it. */
const unitTypeName = (ruleset: RulesetView, type: UnitTypeId): string =>
  unitDef(ruleset, type)?.name ?? type;

/**
 * One line naming every unit that is **working**, or `undefined` when none is.
 *
 * `tile` is the job's own tile, which is where the improvement will land — the
 * unit's position while a job runs (M4a: the job is on the tile the worker stands
 * on), so the coordinate answers "where is my worker" and "what is being built"
 * with one number. The unit's *id* is on the line because the id is what a command
 * names.
 *
 * Through a `viewer`, a job on a tile that player has not explored is omitted and
 * counted, exactly as an unexplored start is: a job is knowledge, and a line that
 * recited an opponent's worker would leak through the fog the grid is hiding. The
 * count keeps the line honest about what it left out, and with nothing being
 * worked at all the line is absent entirely — the same rule the `% hut` legend
 * entry follows.
 */
const workLine = (
  state: GameState,
  ruleset: RulesetView,
  explored: readonly boolean[] | undefined,
): string | undefined => {
  const parts: string[] = [];
  let hidden = 0;

  for (const unit of state.units) {
    const work = unit.work;
    if (work === undefined) continue;

    if (explored !== undefined && explored[work.tile] !== true) {
      hidden += 1;
      continue;
    }

    parts.push(
      `${String(unit.id)} p${String(unit.owner)} ${unitTypeName(ruleset, unit.type)}` +
        `@${String(indexToX(state.map, work.tile))},${String(indexToY(state.map, work.tile))} ` +
        workSummary(ruleset, work),
    );
  }

  if (hidden > 0) parts.push(`(+${String(hidden)} unexplored)`);
  return parts.length === 0 ? undefined : `work: ${parts.join('  ')}`;
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
 * A map with a visible goody hut adds one legend field, `% hut`, and draws `%`
 * on the hut's tile — which is why the legend is composed from what was actually
 * drawn rather than being a constant string:
 *
 * ```
 * legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains  % hut
 * ```
 *
 * A unit in the middle of a job adds one `work:` line under `starts:` (M4a), and
 * only when something is being worked:
 *
 * ```
 * work: 3 p0 Worker@2,2 mining, 2 turns left
 * ```
 *
 * The gutter is sized to the widest row number, the tens ruler writes a digit
 * only above every tenth column, and every line is right-stripped — output is
 * stable for a given `(state, ruleset, options)` and safe to snapshot.
 *
 * With `options.viewer`, the same geometry is drawn from that player's explored
 * row: unexplored tiles become `?` (including their start markers and their
 * huts), the legend gains `? unexplored`, and the header names the viewer.
 * Nothing else changes, and with no `viewer` the output is exactly what it was
 * before the option existed (PLAN.md 8.1: the agent's primary eyes, in both
 * modes).
 */
export const describe = (
  state: GameState,
  ruleset: RulesetView,
  options?: DescribeOptions,
): string => {
  const showStarts = options?.showStarts ?? true;
  const viewer = options?.viewer;
  const map = state.map;
  const view = windowOf(map, options?.viewport);

  // The viewer's fog row, or `undefined` in god mode. One read here means the
  // rendering loop below never has to ask whether a viewer exists.
  const viewerRow =
    viewer === undefined ? undefined : (state.explored[Number(viewer)] ?? NO_EXPLORED_ROW);

  const roleById = new Map<TerrainId, TerrainRole>();
  for (const def of ruleset.terrains) roleById.set(def.id, def.role);

  // Huts, as a set of flat tile indices. Built once per call so a hut lookup is
  // not a scan of `map.huts` per rendered tile.
  const hutTiles = new Set<number>(map.huts.map(Number));

  // Start markers keyed by flat tile index; the first *civilization* on a tile
  // wins, so a (malformed) shared start does not make the output order-dependent.
  // `civPlayers`, never `players`: a digit means "a civilization begins here", and
  // the barbarians have no homeland (see `startsLine` — the ruling on starts). In
  // viewer mode a marker is only painted where the viewer has explored — a start
  // tile is knowledge, and knowledge the fog has not granted must not be drawn.
  const civs = civPlayers(state);
  const markerByTile = new Map<number, string>();
  if (showStarts) {
    for (const player of civs) {
      const tile = player.startingTile;
      if (tile < 0 || tile >= map.terrain.length) continue;
      if (viewerRow !== undefined && viewerRow[tile] !== true) continue;
      const marker = startMarker(Number(player.id));
      if (!markerByTile.has(tile)) markerByTile.set(tile, marker);
    }
  }

  let sawUnknown = false;
  let sawUnexplored = false;
  let sawHut = false;
  const glyphAt = (x: number, y: number): string => {
    const slot = y * map.width + x;
    // Fog first: an unexplored tile's terrain — and any hut on it — is not read
    // at all, so it cannot influence the output even indirectly (via `sawUnknown`
    // or `sawHut`, say). `?` is returned before the hut check below, which is what
    // "a hut on an unexplored tile must not be revealed" means in code.
    if (viewerRow !== undefined && viewerRow[slot] !== true) {
      sawUnexplored = true;
      return UNEXPLORED_GLYPH;
    }
    // A hut is drawn over the terrain it sits on: it is the more useful fact
    // about the tile, and its glyph is not a terrain glyph, so nothing is lost —
    // the legend still spells out the terrain roles the rest of the map uses.
    if (hutTiles.has(slot)) {
      sawHut = true;
      return HUT_GLYPH;
    }
    const id = map.terrain[slot];
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

  const lines: string[] = [headerLine(state, viewer), viewLine(view, map)];
  lines.push(stripEnd(`${gutter}|${tensRuler(view)}`));
  lines.push(stripEnd(`${gutter}|${unitsRuler(view)}`));

  for (let y = view.y0; y < view.y0 + view.height; y++) {
    let row = '';
    for (let x = view.x0; x < view.x0 + view.width; x++) {
      // A start marker wins over the hut under it: `generateWorld` never places a
      // hut on a start tile, so the two collide only on a hand-built map, and "a
      // civilization is here" is the stronger fact when they do.
      const marker = markerByTile.get(y * map.width + x);
      row += marker ?? glyphAt(x, y);
    }
    lines.push(stripEnd(`${String(y).padStart(labelWidth)} |${row}`));
  }

  lines.push(legendLine(sawUnknown, sawUnexplored, sawHut));
  // Any *civilization* with a start tile gets a `starts:` line, so the digits on
  // the map always have a legend (see `startsLine` on why this is `civPlayers`,
  // exactly like the `civs=` count in the header).
  if (showStarts && civs.length > 0) {
    lines.push(startsLine(state, map, view, viewerRow));
  }

  // Work in progress, last — it is the most transient fact on the board (a job
  // ends, a worker moves, a new one starts) and it is the only line whose content
  // changes between two turns of the same game. `showStarts` deliberately does not
  // gate it: a job is not a start marker, and switching the starts legend off must
  // not hide what the army of workers is doing.
  const work = workLine(state, ruleset, viewerRow);
  if (work !== undefined) lines.push(work);

  return `${lines.join('\n')}\n`;
};
