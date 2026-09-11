/**
 * `describe` tests (INTERFACES.md W3, plus M2's fog half).
 *
 * The text view is the agent's primary way of seeing the game, so these tests
 * pin the *picture* (an inline snapshot of a 4x4 glyph grid), the properties
 * that make it trustworthy (stable across calls, no trailing whitespace), the
 * viewport maths (crop + clamp), and — M2 — what a *viewer* may and may not see:
 * a viewer renders only explored tiles, and nothing about an unexplored tile
 * reaches the screen, not even through the legend or the `starts:` line.
 *
 * **Migrated to the M3 state shape** (docs/INTERFACES.md M3). The hand-built
 * fixtures here carry the new required fields: `kind: 'civ'` on a player (these
 * synthetic boards hold civilizations only — the barbarian player `newGame`
 * appends is covered by the generated-state cases), `huts` on a map, and
 * `nextCityId`/`cities` on the state. None of them is read by `describe`, and
 * that is the point of stating them explicitly: a fixture that omitted them
 * would only typecheck through a cast, and a cast would hide the next shape
 * change instead of failing on it.
 *
 * **M3 rulings pinned here.** `starts:` and the digits on the map are for
 * *civilizations only*: the barbarians are a player with no homeland, whose
 * `startingTile` is a hut, so presenting it as a start would tell the reader
 * something false (see the ruling test at the bottom). And a goody hut is drawn
 * as `%` with a legend entry, under the same fog rule as everything else: a hut
 * on a tile the viewer has not explored is not revealed, not even in the legend.
 *
 * **M4a.** A unit in the middle of a job is named on a `work:` line of its own —
 * what it is doing and how many turns are left — because the picture has no way to
 * draw a *unit*, let alone its job. The line follows the same fog rule (`describe`
 * with a `viewer`), and it is absent when nothing is being worked.
 */

import { describe, expect, it } from 'vitest';
import { asPlayerId, asTerrainId, asTileIndex, asUnitId, asUnitTypeId } from '../src/ids.js';
import { asImprovementId, type ImprovementDef } from '../src/improvements.js';
import type { RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  civPlayers,
  newGame,
  SCHEMA_VERSION,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import { describe as describeState, workSummary } from '../src/textview.js';
import { withWork, type Unit, type UnitDef, type UnitWork } from '../src/units.js';

const ROLES: readonly TerrainRole[] = [
  'ocean',
  'coast',
  'grassland',
  'plains',
  'hills',
  'mountains',
];

const TERRAINS: readonly TerrainDef[] = ROLES.map((role) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost: 1,
  defenseBonusPct: 0,
  yields: { food: 1, shields: 0, commerce: 0 },
  impassable: role === 'ocean' || role === 'mountains',
}));

/**
 * A settler: `newGame` places one of these per player, so a ruleset without one
 * cannot start a game (M2 `missing-unit-role`). Terrain is all `describe` reads
 * for its picture; the catalog exists so the generated-map tests below can call
 * `newGame` at all.
 */
const SETTLER: UnitDef = {
  id: asUnitTypeId('settler'),
  role: 'settler',
  name: 'Settler',
  attack: 0,
  defense: 0,
  movement: 2,
  cost: 1,
  domain: 'land',
};

/**
 * A worker (M4a). `describe` reads it only to *name* the unit on the `work:` line,
 * so its stats are arbitrary — but it has to be in the catalog for the line to say
 * `Worker` rather than the raw type id.
 */
const WORKER: UnitDef = {
  id: asUnitTypeId('worker'),
  role: 'worker',
  name: 'Worker',
  attack: 0,
  defense: 0,
  movement: 1,
  cost: 2,
  domain: 'land',
};

/**
 * The improvement rows the `work:` line's activity word comes from (M4a): the
 * *kind* is the engine's vocabulary, so the row is what tells the renderer that a
 * job on `mine` is "mining". All placeholder content, as every rules row is —
 * these numbers are never read by `describe`.
 */
const IMPROVEMENTS: readonly ImprovementDef[] = [
  {
    id: asImprovementId('mine'),
    kind: 'mine',
    name: 'Mine',
    turns: 3,
    yields: { food: 0, shields: 1, commerce: 0 },
    allowedRoles: ['hills', 'mountains'],
  },
  {
    id: asImprovementId('road'),
    kind: 'road',
    name: 'Road',
    turns: 2,
    yields: { food: 0, shields: 0, commerce: 1 },
    allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
  },
];

/** The ruleset as the engine sees it in M2: terrain *and* a unit catalog. */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, WORKER],
  improvements: IMPROVEMENTS,
  fidelity: 'tuned',
};

/**
 * The same terrains with an empty unit catalog. `RulesetView.units` is required
 * since M2's amendment, so "no units" is an empty catalog rather than a missing
 * field — and `describe` still draws the same picture, because it reads terrain
 * from the view and fog from the state.
 */
const NO_UNITS: RulesetView = {
  terrains: TERRAINS,
  units: [],
  improvements: [],
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** Terrain grid of the synthetic 4x4 map, in reading order. */
const GRID_4x4: readonly TerrainRole[] = [
  'ocean',
  'ocean',
  'coast',
  'coast',
  'ocean',
  'grassland',
  'grassland',
  'plains',
  'coast',
  'grassland',
  'hills',
  'mountains',
  'plains',
  'plains',
  'hills',
  'mountains',
];

/**
 * A civilization player. M3 gave `PlayerState` a `kind`, and these synthetic
 * boards are all civilizations: the barbarian player `newGame` appends (M3,
 * "State shape") is a deliberate omission here, because these tests are about a
 * *picture* and a barbarian would only add a start marker nobody asked for. The
 * generated-game cases at the bottom cover the real player list.
 */
const player = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind: 'civ',
});

/** One settler per player, on its own start tile — what `newGame` places. */
const startingUnits = (players: readonly PlayerState[]): readonly Unit[] =>
  players.map((owner, index) => ({
    id: asUnitId(index),
    type: SETTLER.id,
    owner: owner.id,
    tile: owner.startingTile,
    movementLeft: SETTLER.movement,
  }));

/** A map-sized fog row (16 tiles: this file's synthetic board is 4x4). */
const fogRow = (seen: readonly number[]): readonly boolean[] =>
  Array.from({ length: 16 }, (_, tile) => seen.includes(tile));

/**
 * A full `GameState` — including the M2 `nextUnitId`/`units`/`explored` fields
 * and M3's `nextCityId`/`cities`, because a partial literal would only typecheck
 * through a cast. The default fog row is blank: no player has explored anything
 * until a test says so, which makes the viewer tests state their fog explicitly
 * instead of inheriting it. M3's map carries `huts`; this board has none, so its
 * picture is terrain, starts and fog, and the hut tests below put one on the map
 * where they want it.
 */
const syntheticState = (
  players: readonly PlayerState[],
  explored?: readonly (readonly boolean[])[],
): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: { width: 4, height: 4, terrain: GRID_4x4.map((role) => asTerrainId(role)), huts: [] },
  players,
  nextUnitId: players.length,
  units: startingUnits(players),
  explored: explored ?? players.map(() => fogRow([])),
  nextCityId: 0,
  cities: [],
  // M4a: nothing is built at setup, and the key is an *empty array* rather than
  // absent — it is part of every state hash, and `canonicalize` refuses
  // `undefined`. None of `describe`'s picture reads it; the work *line* reads the
  // jobs on the units instead, which is where the state says what is being built.
  improvements: [],
});

const STATE_4x4: GameState = syntheticState([player(0, 5), player(1, 10)]);

/**
 * `state` with goody huts on the map (M3: `GameMap.huts`, ascending tile index).
 * The glyph they are drawn as, `%`, is pinned in the tests below rather than
 * imported: it is part of the picture a reader sees, not an internal detail.
 */
const withHuts = (state: GameState, huts: readonly number[]): GameState => ({
  ...state,
  map: { ...state.map, huts: huts.map((tile) => asTileIndex(tile)) },
});

/**
 * The barbarian player M3 appends to `players` (`newGame` does it after the
 * civilizations): a player *identity* whose `startingTile` is a convention
 * pointing at a hut, not a homeland. Its id is the next player index, which is
 * exactly the digit it must **not** be painted as — see the ruling test at the
 * bottom of this file.
 */
const barbarianPlayer = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: 'Barbarians',
  color: '#3f3f46',
  startingTile: asTileIndex(tile),
  kind: 'barbarian',
});

/** The glyph columns of every grid row, without the row-number gutter. */
const glyphRows = (view: string): readonly string[] =>
  view
    .split('\n')
    .filter((line) => /^ *\d+ \|/.test(line))
    .map((line) => line.slice(line.indexOf('|') + 1));

/** How many goody huts a rendered grid draws, counted as the picture shows them. */
const hutGlyphs = (grid: string): number => grid.split('%').length - 1;

/**
 * The players the `starts:` line names, as `marker=Name@x,y` entries — read off
 * the rendered line rather than from the state, so a test can assert what a
 * reader is told. The `(+N unexplored)` note carries no `=` and is filtered out.
 */
const namedStarts = (view: string): readonly string[] =>
  (view.split('\n').find((line) => line.startsWith('starts: ')) ?? '')
    .slice('starts: '.length)
    .split('  ')
    .filter((entry) => entry.includes('='));

/** A ruleset built from any terrain list, for the malformed-input cases. */
const withTerrains = (terrains: readonly TerrainDef[]): RulesetView => ({
  terrains,
  units: [],
  improvements: [],
  fidelity: 'tuned',
});

describe('describe', () => {
  it('renders a small synthetic state exactly', () => {
    expect(describeState(STATE_4x4, RULESET)).toMatchInlineSnapshot(`
      "CivTS state: seed=7 turn=1 revision=0 map=duel(4x4) civs=2
      view: x 0..3, y 0..3 (4x4 of 4x4)
        |0
        |0123
      0 |~~::
      1 |~0,-
      2 |:,1^
      3 |--h^
      legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains
      starts: 0=Player 1@1,1  1=Player 2@2,2
      "
    `);
  });

  it('is stable across repeated calls, with and without options', () => {
    const options = { viewport: { x: 1, y: 1, width: 2, height: 2 } };
    const first = describeState(STATE_4x4, RULESET, options);

    expect(describeState(STATE_4x4, RULESET, options)).toBe(first);
    expect(describeState(STATE_4x4, RULESET)).toBe(describeState(STATE_4x4, RULESET));
    expect(describeState(STATE_4x4, RULESET, { showStarts: false })).toBe(
      describeState(STATE_4x4, RULESET, { showStarts: false }),
    );
  });

  it('heads the view with seed, turn, map size and civ count', () => {
    const lines = describeState(STATE_4x4, RULESET).split('\n');

    expect(lines[0]).toContain('seed=7');
    expect(lines[0]).toContain('turn=1');
    expect(lines[0]).toContain('revision=0');
    expect(lines[0]).toContain('map=duel(4x4)');
    expect(lines[0]).toContain('civs=2');
    expect(lines[1]).toContain('view: x 0..3, y 0..3 (4x4 of 4x4)');
  });

  it('renders one glyph per terrain role with a legend', () => {
    const view = describeState(STATE_4x4, RULESET, { showStarts: false });

    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':,h^', '--h^']);
    expect(view).toContain('legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains');
  });

  it('numeral-rules the columns and numbers the rows', () => {
    const view = describeState(STATE_4x4, RULESET).split('\n');

    expect(view[2]).toBe('  |0');
    expect(view[3]).toBe('  |0123');
    expect(view[4]).toBe('0 |~~::');
    expect(view[7]).toBe('3 |--h^');
  });

  it('marks starting tiles with the player number and explains them', () => {
    const view = describeState(STATE_4x4, RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '--h^']);
    expect(view).toContain('starts: 0=Player 1@1,1  1=Player 2@2,2');
  });

  it('hides markers and the start legend when showStarts is false', () => {
    const view = describeState(STATE_4x4, RULESET, { showStarts: false });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view).join('')).toBe('~~::~,,-:,h^--h^');
  });

  it('uses * for players past the digit range', () => {
    const many = Array.from({ length: 11 }, (_, index) => player(index, index));
    const state: GameState = {
      ...syntheticState(many),
      map: {
        width: 11,
        height: 1,
        terrain: many.map(() => asTerrainId('grassland')),
        huts: [],
      },
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual(['0123456789*']);
    expect(view).toContain('*=Player 11@10,0');
  });

  it('marks tiles whose terrain id is not in the ruleset', () => {
    const state: GameState = {
      ...STATE_4x4,
      map: {
        width: 2,
        height: 1,
        terrain: [asTerrainId('grassland'), asTerrainId('volcano')],
        huts: [],
      },
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual([',?']);
    expect(view).toContain('? unknown');
  });

  it('crops to the requested viewport', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: 1, y: 1, width: 2, height: 2 },
    });

    expect(glyphRows(view)).toEqual(['0,', ',1']);
    expect(view).toContain('view: x 1..2, y 1..2 (2x2 of 4x4)');
    expect(view).toContain('starts: 0=Player 1@1,1  1=Player 2@2,2');
  });

  it('clamps a viewport that starts before the map', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: -5, y: -5, width: 99, height: 99 },
    });

    expect(view).toBe(describeState(STATE_4x4, RULESET));
  });

  it('clamps a viewport that starts past the map and flags off-view starts', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: 3, y: 3, width: 99, height: 99 },
    });

    expect(view).toContain('view: x 3..3, y 3..3 (1x1 of 4x4)');
    expect(glyphRows(view)).toEqual(['^']);
    expect(view).toContain('0=Player 1@1,1 (off-view)');
    expect(view).toContain('1=Player 2@2,2 (off-view)');
  });

  it('renders an empty grid for a zero-sized viewport', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: 1, y: 1, width: 0, height: 0 },
    });

    expect(view).toContain('view: empty (map 4x4)');
    expect(glyphRows(view)).toEqual([]);
  });

  it('emits no trailing whitespace and ends with a newline', () => {
    const state = newGame(4242, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');
    const view = describeState(state.value, RULESET, {
      viewport: { x: 7, y: 11, width: 23, height: 9 },
    });

    expect(view.endsWith('\n')).toBe(true);
    for (const line of view.split('\n')) expect(line).toBe(line.replace(/[ \t]+$/, ''));
    expect(glyphRows(view)).toHaveLength(9);
  });

  it('renders a full generated map, one glyph per tile', () => {
    const state = newGame(42, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');

    const first = describeState(state.value, RULESET);
    const rows = glyphRows(first);

    expect(describeState(state.value, RULESET)).toBe(first);
    expect(rows).toHaveLength(state.value.map.height);
    for (const row of rows) expect(row).toHaveLength(state.value.map.width);
    // CIVILIZATIONS ONLY — the ruling on starts. `starts:` is the legend for the
    // digits painted on the map, and both are for civilizations: barbarians are a
    // player (M3, "State shape") but have no homeland, so `newGame` points their
    // `startingTile` at the map's first hut as a field convention. Naming that
    // here as a start would tell the reader that a civilization begins where a
    // barbarian band will come from — and would hide the hut behind a digit.
    // `civPlayers`, never `players`, exactly like the header's `civs=` count.
    for (const player_ of civPlayers(state.value)) {
      expect(first).toContain(`${String(player_.id)}=${player_.name}@`);
    }
    // The barbarian player is still a player, and still not a start.
    expect(state.value.players.some((player_) => player_.kind === 'barbarian')).toBe(true);
    expect(civPlayers(state.value)).toHaveLength(SETTINGS.civCount);
    expect(first).not.toContain('Barbarians');
    expect(namedStarts(first)).toHaveLength(civPlayers(state.value).length);
  });

  it('shows the goody huts an agent has to find, and explains the glyph', () => {
    const state = newGame(42, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');
    const huts = state.value.map.huts;
    expect(huts.length).toBeGreaterThan(0);

    // God mode draws every hut and nothing else as `%`: `generateWorld` keeps
    // huts off start tiles, so no marker can hide one, and the count is exact.
    const god = glyphRows(describeState(state.value, RULESET)).join('');
    expect(hutGlyphs(god)).toBe(huts.length);
    expect(describeState(state.value, RULESET)).toContain('% hut');

    // The barbarian player's `startingTile` is one of those huts (M3's convention
    // for a required field), so the tile a "start" reading would put a digit on
    // shows the hut instead — the feature an agent wants to walk to.
    const barbarian = state.value.players.find((candidate) => candidate.kind === 'barbarian');
    expect(barbarian === undefined ? 'no barbarian player' : String(barbarian.startingTile)).toBe(
      String(huts[0]),
    );

    // Through the fog, exactly the huts the viewer has explored are drawn — the
    // positive half, so the count below cannot pass by both sides being zero.
    const seeing: GameState = {
      ...state.value,
      explored: state.value.explored.map((row) => row.map(() => true)),
    };
    const all = glyphRows(describeState(seeing, RULESET, { viewer: asPlayerId(0) })).join('');
    expect(hutGlyphs(all)).toBe(huts.length);

    // …and a fresh viewer draws only what its own start has revealed.
    const fresh = describeState(state.value, RULESET, { viewer: asPlayerId(0) });
    const revealed = huts.filter((hut) => state.value.explored[0]?.[hut] === true).length;
    expect(hutGlyphs(glyphRows(fresh).join(''))).toBe(revealed);
  });

  it('draws a hut as %, with a legend field, over the terrain it sits on', () => {
    const view = describeState(withHuts(STATE_4x4, [13]), RULESET);

    // Tile 13 is (1,3), the west tile of the bottom row: the hut replaces the
    // `-` it sat on rather than being drawn beside it, and `%` is not a terrain
    // glyph (`GRID_4x4[13]` is plains, and the hills tile at 14 is untouched).
    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '-%h^']);
    expect(view).toContain(
      'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains  % hut',
    );

    // A map with no hut adds no legend field and never draws the glyph: the entry
    // is a claim that the glyph is on the map, so it is made only when it is.
    const bare = describeState(STATE_4x4, RULESET);
    expect(glyphRows(bare).join('')).not.toContain('%');
    expect(bare).not.toContain('hut');
  });

  it('lets a start marker win over a hut on the same tile', () => {
    // Unreachable from `generateWorld` (it never puts a hut on a start tile), so
    // the collision is hand-built. A marker wins, and the legend does not claim a
    // hut glyph that was never drawn.
    const view = describeState(withHuts(STATE_4x4, [5]), RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '--h^']);
    expect(view).not.toContain('% hut');
  });

  it('still draws huts when the start legend is switched off', () => {
    const view = describeState(withHuts(STATE_4x4, [9]), RULESET, { showStarts: false });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':%h^', '--h^']);
    expect(view).toContain('% hut');
  });

  it('accepts a start tile outside the map without crashing', () => {
    const state: GameState = {
      ...STATE_4x4,
      players: [{ ...player(0, 5), startingTile: asTileIndex(9999) }],
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':,h^', '--h^']);
    expect(view).toContain('0=Player 1(invalid)');
  });

  it('renders a state whose ruleset has no terrains at all', () => {
    const view = describeState(STATE_4x4, withTerrains([]));

    expect(glyphRows(view)).toEqual(['????', '?0??', '??1?', '????']);
    expect(view).toContain('? unknown');
  });
});

/* ------------------------------------------------------------------ *
 * M4a — work in progress
 *
 * A worker's job is the one thing on the board that the *grid* cannot draw: the
 * picture marks terrain, huts and start tiles, and has no per-unit marking at
 * all. So the job is named on a line of its own, and these tests pin what that
 * line says, when it is there, and what a viewer may see of it.
 * ------------------------------------------------------------------ */

/** The hills tile at (2,3): a mine may be built there, and it is off both starts. */
const WORKER_TILE = 14;

/** A job on the worker's own tile, as `StartWork` writes it. */
const job = (kind: string, turnsLeft: number, tile = WORKER_TILE): UnitWork => ({
  kind: asImprovementId(kind),
  tile: asTileIndex(tile),
  turnsLeft,
});

/**
 * A unit of `type` (a worker unless a test says otherwise) owned by player 0,
 * standing on `tile`, doing `work` when one is given. `work` is attached through
 * `withWork`, the only writer of the field — an idle unit carries no `work` key at
 * all, never a key holding `undefined`.
 */
const withWorkOn = (
  work: UnitWork | undefined,
  options?: { type?: string; tile?: number },
): GameState => {
  const base: Unit = {
    id: asUnitId(2),
    type: asUnitTypeId(options?.type ?? 'worker'),
    owner: asPlayerId(0),
    tile: asTileIndex(options?.tile ?? WORKER_TILE),
    movementLeft: 0,
  };
  return {
    ...STATE_4x4,
    nextUnitId: 3,
    units: [...STATE_4x4.units, work === undefined ? base : withWork(base, work)],
  };
};

/** A working worker with an explicit id, owner and tile — for the two-worker cases. */
const workerOn = (id: number, owner: number, tile: number, work: UnitWork): Unit =>
  withWork(
    {
      id: asUnitId(id),
      type: asUnitTypeId('worker'),
      owner: asPlayerId(owner),
      tile: asTileIndex(tile),
      movementLeft: 0,
    },
    work,
  );

/** The same board with only the fog rows replaced — the viewer cases below. */
const foggedAs = (state: GameState, seen: readonly number[]): GameState => ({
  ...state,
  explored: [fogRow(seen), fogRow([])],
});

describe('describe and work in progress', () => {
  it('names the job of every working unit, and says nothing when none is', () => {
    // Nothing is being worked: no line, exactly like a `% hut` legend entry that
    // would claim a glyph that is not on the map.
    const idle = describeState(withWorkOn(undefined), RULESET);
    expect(idle).not.toContain('work:');
    expect(idle).not.toContain('mining');

    // A job in progress is a line of its own, under `starts:`, naming the unit by
    // id, its owner, its type, the tile the job is on and how long it has left.
    const working = describeState(withWorkOn(job('mine', 2)), RULESET);
    const lines = working.split('\n').filter((line) => line !== '');
    expect(lines[lines.length - 1]).toBe('work: 2 p0 Worker@2,3 mining, 2 turns left');
    // …and the rest of the picture is untouched: the grid, the legend and the
    // starts line are byte-for-byte what the same board renders with no job.
    expect(working.replace('work: 2 p0 Worker@2,3 mining, 2 turns left\n', '')).toBe(idle);
  });

  it('says one turn when one turn is left, and names every job on one line', () => {
    expect(describeState(withWorkOn(job('mine', 1)), RULESET)).toContain(
      'work: 2 p0 Worker@2,3 mining, 1 turn left',
    );

    // Two workers on two tiles: both jobs, two spaces apart, in `units` order.
    const pair: GameState = {
      ...STATE_4x4,
      nextUnitId: 4,
      units: [
        ...STATE_4x4.units,
        workerOn(2, 0, 9, job('road', 2, 9)),
        workerOn(3, 1, 13, job('mine', 3, 13)),
      ],
    };
    expect(describeState(pair, RULESET)).toContain(
      'work: 2 p0 Worker@1,2 building a road, 2 turns left  3 p1 Worker@1,3 mining, 3 turns left',
    );
  });

  it('shows a job even when the start legend is switched off', () => {
    // `showStarts` hides the markers and their legend; a job is not a start, and
    // switching one off must not hide what the workers are doing.
    const view = describeState(withWorkOn(job('mine', 2)), RULESET, { showStarts: false });

    expect(view).not.toContain('starts:');
    expect(view).toContain('work: 2 p0 Worker@2,3 mining, 2 turns left');
  });

  it('falls back to the raw ids for a job the ruleset cannot describe', () => {
    // An improvement no catalog row defines: the work still *happened* — the state
    // says so — and the renderer must not pretend the worker is idle. The id is
    // all that is known, so the id is what is printed.
    expect(describeState(withWorkOn(job('quarry', 2)), RULESET)).toContain(
      'work: 2 p0 Worker@2,3 quarry, 2 turns left',
    );

    // …and a unit type the ruleset cannot name is printed as its raw id, the same
    // rule the rest of this file applies to an unknown terrain id.
    expect(describeState(withWorkOn(job('mine', 2), { type: 'ghost' }), RULESET)).toContain(
      'work: 2 p0 ghost@2,3 mining, 2 turns left',
    );
    // A ruleset with no catalogs at all is the same case twice over: no crash, and
    // both the type and the job are named by their ids.
    expect(describeState(withWorkOn(job('mine', 2)), NO_UNITS)).toContain(
      'work: 2 p0 worker@2,3 mine, 2 turns left',
    );
  });

  it('hides a job on an unexplored tile from a viewer, and counts it', () => {
    // Player 0 has explored tiles 4, 5, 6 and 9 (the same blob the fog block below
    // uses); the hills at 14 are not among them, so the job there is not knowledge
    // this player has.
    const seen = describeState(foggedAs(withWorkOn(job('mine', 2)), [4, 5, 6, 9]), RULESET, {
      viewer: asPlayerId(0),
    });

    // The *existence* of unseen work is counted, exactly as an unexplored start is
    // (`starts: … (+1 unexplored)`): the count is a number, and it is the only
    // thing about the hidden job that reaches the screen.
    expect(seen).toContain('work: (+1 unexplored)');
    expect(seen).not.toContain('Worker@');
    expect(seen).not.toContain('mining');
    expect(seen).not.toContain('2,3');

    // The strongest form of "does not leak the content": two *different* hidden
    // jobs, on two different unexplored tiles, render the same bytes — so nothing
    // about a job the viewer cannot see can influence the output at all.
    const other = foggedAs(withWorkOn(job('road', 7, 13), { tile: 13 }), [4, 5, 6, 9]);
    expect(describeState(other, RULESET, { viewer: asPlayerId(0) })).toBe(seen);

    // …and the same job, on a tile the viewer *has* explored, is shown in full.
    const inSight = foggedAs(withWorkOn(job('mine', 2, 9), { tile: 9 }), [4, 5, 6, 9]);
    expect(describeState(inSight, RULESET, { viewer: asPlayerId(0) })).toContain(
      'work: 2 p0 Worker@1,2 mining, 2 turns left',
    );
  });

  it('renders the job of a unit in the state, never the state of the world', () => {
    // A job's line is a pure function of the state: the same state renders the same
    // line, and adding a job changes exactly one line of the picture.
    const first = describeState(withWorkOn(job('mine', 2)), RULESET);

    expect(describeState(withWorkOn(job('mine', 2)), RULESET)).toBe(first);
    expect(first).not.toBe(describeState(withWorkOn(job('mine', 1)), RULESET));
    expect(first).not.toBe(describeState(withWorkOn(job('road', 2)), RULESET));
  });

  it('describes one job as prose, from the catalog and the state alone', () => {
    // The exported helper the REPL prints too, pinned phrase by phrase: the verb
    // comes from the improvement's kind, and the count is the state's.
    expect(workSummary(RULESET, job('mine', 2))).toBe('mining, 2 turns left');
    expect(workSummary(RULESET, job('mine', 1))).toBe('mining, 1 turn left');
    expect(workSummary(RULESET, job('road', 3))).toBe('building a road, 3 turns left');
    // Nothing in the catalog describes `quarry`, so the id stands in for the verb.
    expect(workSummary(RULESET, job('quarry', 2))).toBe('quarry, 2 turns left');
    expect(workSummary(NO_UNITS, job('mine', 2))).toBe('mine, 2 turns left');
  });
});

/**
 * Fog, from a player's point of view (INTERFACES.md M2, "Fog").
 *
 * God mode — no `viewer` — is the map, and it is byte-identical to what this
 * renderer printed before the option existed (the snapshots above are the
 * regression test for that). A `viewer` sees its explored row and nothing else:
 * unexplored tiles are `?`, and nothing about them reaches the output, not the
 * terrain, not a start marker, not a start coordinate, not a legend entry.
 */
describe('describe with a viewer', () => {
  /** Player 0 has explored tiles 4, 5, 6 and 9 — a blob around its start at 5. */
  const FOGGED: GameState = syntheticState(
    [player(0, 5), player(1, 10)],
    [fogRow([4, 5, 6, 9]), fogRow([])],
  );

  it('renders the explored tiles and ? for the rest', () => {
    expect(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) })).toMatchInlineSnapshot(`
      "CivTS state: seed=7 turn=1 revision=0 map=duel(4x4) civs=2 viewer=0
      view: x 0..3, y 0..3 (4x4 of 4x4)
        |0
        |0123
      0 |????
      1 |~0,?
      2 |?,??
      3 |????
      legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains  ? unexplored
      starts: 0=Player 1@1,1  (+1 unexplored)
      "
    `);
  });

  it('hides unexplored tiles that god mode still shows', () => {
    expect(glyphRows(describeState(FOGGED, RULESET))).toEqual(['~~::', '~0,-', ':,1^', '--h^']);
    expect(glyphRows(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }))).toEqual([
      '????',
      '~0,?',
      '?,??',
      '????',
    ]);
  });

  it('does not leak the terrain under an unexplored tile', () => {
    // Everything player 0 has not explored becomes mountains; only those tiles
    // change, and a viewer must not be able to tell.
    const swapped: GameState = {
      ...FOGGED,
      map: {
        width: 4,
        height: 4,
        terrain: GRID_4x4.map((role, tile) =>
          asTerrainId([4, 5, 6, 9].includes(tile) ? role : 'mountains'),
        ),
        huts: [],
      },
    };

    expect(describeState(swapped, RULESET, { viewer: asPlayerId(0) })).toBe(
      describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }),
    );
    expect(glyphRows(describeState(swapped, RULESET))).not.toEqual(
      glyphRows(describeState(FOGGED, RULESET)),
    );
  });

  it('does not leak an unexplored terrain id the ruleset does not know', () => {
    // `?` under fog is fog, not a broken ruleset: the tile's id is never read,
    // so the legend must not acquire `? unknown` from it.
    const state: GameState = {
      ...FOGGED,
      map: {
        width: 2,
        height: 1,
        terrain: [asTerrainId('volcano'), asTerrainId('grassland')],
        huts: [],
      },
    };

    expect(glyphRows(describeState(state, RULESET, { viewer: asPlayerId(0) }))).toEqual(['??']);
    expect(describeState(state, RULESET, { viewer: asPlayerId(0) })).toContain('? unexplored');
    expect(describeState(state, RULESET, { viewer: asPlayerId(0) })).not.toContain('? unknown');
    // God mode sees the same tile and does report the unknown id.
    expect(describeState(state, RULESET)).toContain('? unknown');
  });

  it('does not leak the start marker, or the coordinates, of an unexplored start', () => {
    const view = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });

    // Player 1's start (tile 10) is unexplored, so it is neither drawn nor named.
    expect(glyphRows(view)[2]?.[2]).toBe('?');
    expect(view).toContain('starts: 0=Player 1@1,1  (+1 unexplored)');
    expect(view).not.toContain('Player 2@');

    // Moving that unseeable start must not change a byte of the view.
    const moved: GameState = {
      ...FOGGED,
      players: [player(0, 5), player(1, 12)],
    };
    expect(describeState(moved, RULESET, { viewer: asPlayerId(0) })).toBe(view);
    expect(describeState(moved, RULESET)).not.toBe(describeState(FOGGED, RULESET));
  });

  it('names the viewer and explains ? in the legend, and only then', () => {
    const seen = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });
    const god = describeState(FOGGED, RULESET);

    expect(seen.split('\n')[0]).toBe(
      'CivTS state: seed=7 turn=1 revision=0 map=duel(4x4) civs=2 viewer=0',
    );
    expect(seen).toContain('? unexplored');
    expect(god).not.toContain('viewer=');
    expect(god).not.toContain('unexplored');
  });

  it('treats a viewer with no explored row as seeing nothing', () => {
    const blind = describeState(FOGGED, RULESET, { viewer: asPlayerId(7) });

    expect(glyphRows(blind)).toEqual(['????', '????', '????', '????']);
    expect(blind).toContain('viewer=7');
    expect(blind).toContain('(+2 unexplored)');
  });

  it('renders every tile, and no fog note, once the row is complete', () => {
    const all = syntheticState(
      [player(0, 5), player(1, 10)],
      [fogRow(Array.from({ length: 16 }, (_, tile) => tile)), fogRow([])],
    );
    const seen = describeState(all, RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(seen)).toEqual(glyphRows(describeState(all, RULESET)));
    expect(seen).not.toContain('unexplored');
  });

  it('still crops to a viewport, and flags a start that falls outside it', () => {
    const view = describeState(FOGGED, RULESET, {
      viewer: asPlayerId(0),
      viewport: { x: 3, y: 3, width: 99, height: 99 },
    });

    expect(view).toContain('view: x 3..3, y 3..3 (1x1 of 4x4)');
    expect(glyphRows(view)).toEqual(['?']);
    expect(view).toContain('0=Player 1@1,1 (off-view)');
  });

  it('hides the starts line for a viewer when showStarts is false', () => {
    const view = describeState(FOGGED, RULESET, {
      viewer: asPlayerId(0),
      showStarts: false,
    });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view)).toEqual(['????', '~,,?', '?,??', '????']);
    expect(view).toContain('? unexplored');
  });

  it('is stable across repeated calls with a viewer', () => {
    const first = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });

    expect(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) })).toBe(first);
  });

  it('starts a viewer in fog its own settler can see out of', () => {
    const state = newGame(42, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');

    const view = describeState(state.value, RULESET, { viewer: asPlayerId(0) });
    const fogged = glyphRows(view).join('').split('?').length - 1;

    // Fog everywhere except the tiles around the starting settler...
    expect(fogged).toBeGreaterThan(0);
    expect(fogged).toBeLessThan(state.value.map.width * state.value.map.height);
    expect(view).toContain('? unexplored');
    // ...so the viewer's own start is drawn and named, and the fog is explained.
    expect(view).toContain('0=Player 1@');
  });

  it('needs no unit catalog: a viewer works with an empty one', () => {
    // `describe` reads fog from the state, so callers whose view ships no units
    // keep working.
    expect(describeState(FOGGED, NO_UNITS, { viewer: asPlayerId(0) })).toBe(
      describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }),
    );
  });

  it('draws a hut the viewer has explored, and adds its legend field', () => {
    // Tile 9 is one of the four player 0 has explored (4, 5, 6, 9).
    const view = describeState(withHuts(FOGGED, [9]), RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(view)[2]).toBe('?%??');
    expect(view).toContain('% hut');
  });

  it('does not reveal a hut on a tile the viewer has not explored', () => {
    // Tile 13 is unexplored, so the fog hides the feature as well as the terrain
    // under it — including from the legend, which would otherwise announce that
    // the glyph is somewhere on the map.
    const hutInTheFog = withHuts(FOGGED, [13]);
    const view = describeState(hutInTheFog, RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(view)[3]).toBe('????');
    expect(view).not.toContain('%');
    // The strongest form of "does not leak": the whole view is byte-identical to
    // the same board with no hut at all.
    expect(view).toBe(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }));
    // …while god mode, which is allowed to know, shows it.
    expect(glyphRows(describeState(hutInTheFog, RULESET))[3]).toBe('-%h^');
  });

  it('never presents the barbarians as a start, in god mode or through the fog', () => {
    // The barbarian player M3 appends: id 2, no units, and a `startingTile` that
    // is really the map's first hut. Player 0 has explored 4, 5, 6 and 9.
    const barbarians = barbarianPlayer(2, 13);
    const base = syntheticState(
      [player(0, 5), player(1, 10), barbarians],
      [fogRow([4, 5, 6, 9]), fogRow([]), fogRow([])],
    );
    const state: GameState = {
      ...base,
      // `newGame` places one settler per *civilization*, so the barbarians own
      // nothing: they are an identity for the band a hut will spawn.
      units: base.units.filter((unit) => unit.owner !== barbarians.id),
      nextUnitId: 2,
      map: { ...base.map, huts: [asTileIndex(13)] },
    };

    // It *is* still a player — an id, a name and a fog row of its own — and it
    // owns nothing: `newGame` places one settler per civilization, so the only
    // units the barbarians ever have are the band a hut spawns for them. That is
    // what "a player without a homeland" means, and it is why the two readings
    // below are about *presentation*, not about the player existing.
    const inGame = state.players.find((player_) => player_.kind === 'barbarian');
    expect(inGame?.id).toBe(barbarians.id);
    expect(inGame?.name).toBe('Barbarians');
    expect(state.explored[Number(barbarians.id)]).toHaveLength(GRID_4x4.length);
    expect(state.units.filter((candidate) => candidate.owner === barbarians.id)).toEqual([]);

    // God mode: the civs are named, the barbarians are not, and their tile is
    // drawn as the hut it is rather than as the digit `2`.
    const god = describeState(state, RULESET);
    expect(namedStarts(god)).toEqual(['0=Player 1@1,1', '1=Player 2@2,2']);
    expect(god).not.toContain(barbarians.name);
    expect(god).not.toContain('2=');
    expect(glyphRows(god)[3]).toBe('-%h^');

    // Through the fog, the count of hidden starts counts *civilization* starts:
    // player 1's is unexplored, the barbarians' hut is not a start at all and is
    // therefore neither drawn nor counted.
    const seen = describeState(state, RULESET, { viewer: asPlayerId(0) });
    expect(namedStarts(seen)).toEqual(['0=Player 1@1,1']);
    expect(seen).toContain('starts: 0=Player 1@1,1  (+1 unexplored)');
    expect(seen).not.toContain(barbarians.name);
    expect(glyphRows(seen)[3]).toBe('????');
  });
});
