/**
 * `describe` tests (INTERFACES.md W3, plus M2's fog half).
 *
 * The text view is the agent's primary way of seeing the game, so these tests
 * pin the *picture* (an inline snapshot of a 4x4 glyph grid), the properties
 * that make it trustworthy (stable across calls, no trailing whitespace), the
 * viewport maths (crop + clamp), and — M2 — what a *viewer* may and may not see:
 * a viewer renders only explored tiles, and nothing about an unexplored tile
 * reaches the screen, not even through the legend or the `starts:` line.
 */

import { describe, expect, it } from 'vitest';
import { asPlayerId, asTerrainId, asTileIndex, asUnitId, asUnitTypeId } from '../src/ids.js';
import type { RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { newGame, SCHEMA_VERSION, type GameState, type PlayerState } from '../src/state.js';
import { describe as describeState } from '../src/textview.js';
import { type Unit, type UnitDef } from '../src/units.js';

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

/** The ruleset as the engine sees it in M2: terrain *and* a unit catalog. */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER],
  fidelity: 'tuned',
};

/**
 * The same terrains with an empty unit catalog. `RulesetView.units` is required
 * since M2's amendment, so "no units" is an empty catalog rather than a missing
 * field — and `describe` still draws the same picture, because it reads terrain
 * from the view and fog from the state.
 */
const NO_UNITS: RulesetView = { terrains: TERRAINS, units: [], fidelity: 'tuned' };

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

const player = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
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
 * A full `GameState` — including the M2 `nextUnitId`/`units`/`explored` fields,
 * because a partial literal would only typecheck through a cast. The default fog
 * row is blank: no player has explored anything until a test says so, which
 * makes the viewer tests state their fog explicitly instead of inheriting it.
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
  map: { width: 4, height: 4, terrain: GRID_4x4.map((role) => asTerrainId(role)) },
  players,
  nextUnitId: players.length,
  units: startingUnits(players),
  explored: explored ?? players.map(() => fogRow([])),
});

const STATE_4x4: GameState = syntheticState([player(0, 5), player(1, 10)]);

/** The glyph columns of every grid row, without the row-number gutter. */
const glyphRows = (view: string): readonly string[] =>
  view
    .split('\n')
    .filter((line) => /^ *\d+ \|/.test(line))
    .map((line) => line.slice(line.indexOf('|') + 1));

/** A ruleset built from any terrain list, for the malformed-input cases. */
const withTerrains = (terrains: readonly TerrainDef[]): RulesetView => ({
  terrains,
  units: [],
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
      },
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual(['0123456789*']);
    expect(view).toContain('*=Player 11@10,0');
  });

  it('marks tiles whose terrain id is not in the ruleset', () => {
    const state: GameState = {
      ...STATE_4x4,
      map: { width: 2, height: 1, terrain: [asTerrainId('grassland'), asTerrainId('volcano')] },
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
    for (const [index, player_] of state.value.players.entries()) {
      expect(first).toContain(`${String(index)}=${player_.name}@`);
    }
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
      map: { width: 2, height: 1, terrain: [asTerrainId('volcano'), asTerrainId('grassland')] },
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
});
