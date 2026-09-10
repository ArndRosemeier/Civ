/**
 * `describe` tests (INTERFACES.md W3).
 *
 * The text view is the agent's primary way of seeing the game, so these tests
 * pin the *picture* (an inline snapshot of a 4x4 glyph grid), the properties
 * that make it trustworthy (stable across calls, no trailing whitespace), and
 * the viewport maths (crop + clamp).
 */

import { describe, expect, it } from 'vitest';
import { asPlayerId, asTerrainId, asTileIndex } from '../src/ids.js';
import type { RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { newGame, SCHEMA_VERSION, type GameState, type PlayerState } from '../src/state.js';
import { describe as describeState } from '../src/textview.js';

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

const RULESET: RulesetView = { terrains: TERRAINS, fidelity: 'tuned' };

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

const syntheticState = (players: readonly PlayerState[]): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: { width: 4, height: 4, terrain: GRID_4x4.map((role) => asTerrainId(role)) },
  players,
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
    expect(view).toContain(
      'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
    );
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
