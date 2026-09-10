/**
 * The REPL is the agent's hands on the game (PLAN.md §8.1), so the things worth
 * testing are the things that make it usable and safe to automate:
 *
 * - **A play session is a regression test.** `--script` prints a deterministic
 *   transcript; the full text is asserted below, so a change in the engine, the
 *   text view, the rules data or the REPL itself shows up as a diff.
 * - **A refused command is inert.** Malformed input, an unknown command word and
 *   an illegal move all leave `revision` and the state hash exactly where they
 *   were — "does not advance the game" is asserted, not promised.
 * - **Errors are typed, not textual.** `run` returns the engine's `GameError`, so
 *   the assertions below name reasons (`impassable`, `not-your-unit`, …) rather
 *   than matching prose, while a human still reads the prose.
 * - **Non-interactive-safe.** End of input exits 0, both at the session level and
 *   through the real CLI with stdin closed, so `play` can never hang a pipeline.
 * - **The REPL never mutates state.** Commands run against a frozen state, and a
 *   second run from the same input reaches the same final hash.
 *
 * The synthetic 4x4 map is deliberate: small enough that the expected transcript
 * stays readable, and it puts every interesting case next to the unit —
 * mountains (impassable), hills (moveCost 2, unaffordable), an enemy-held tile,
 * and a free adjacent tile.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  asPlayerId,
  asTerrainId,
  asUnitId,
  asUnitTypeId,
  newGame,
  seedRng,
  tileIndex,
  type GameError,
  type GameState,
  type RulesetView,
  type TerrainId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { canonicalize, hashValue } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  createSession,
  parsePlayArgs,
  runScript,
  type LineOutcome,
  type ReplSession,
} from '../src/repl.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog must validate');
const RULESET: RulesetView = validated.value;

const WIDTH = 4;
const HEIGHT = 4;

const terrainIds = (): TerrainId[] => {
  const tiles = new Array<TerrainId>(WIDTH * HEIGHT).fill(asTerrainId('grassland'));
  tiles[tileIndex(WIDTH, 1, 0)] = asTerrainId('mountains'); // impassable
  tiles[tileIndex(WIDTH, 2, 2)] = asTerrainId('hills'); // moveCost 2
  return tiles;
};

/**
 * A 4x4 world: player 0's settler on (0,0) with 2 movement, player 1's on (0,1).
 * Every refusal worth testing is one step away from (0,0): (1,0) mountains,
 * (0,1) enemy-held, (1,1) free grassland, and (2,2) hills that cost more than
 * the unit has left once it has stepped to (1,1).
 */
const syntheticState = (): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed: 7 },
  rng: seedRng(7),
  map: { width: WIDTH, height: HEIGHT, terrain: terrainIds() },
  players: [
    {
      id: asPlayerId(0),
      name: 'Player 1',
      color: '#d12f2f',
      startingTile: tileIndex(WIDTH, 0, 0),
    },
    {
      id: asPlayerId(1),
      name: 'Player 2',
      color: '#2f6fd1',
      startingTile: tileIndex(WIDTH, 0, 1),
    },
  ],
  nextUnitId: 2,
  units: [
    {
      id: asUnitId(0),
      type: asUnitTypeId('settler'),
      owner: asPlayerId(0),
      tile: tileIndex(WIDTH, 0, 0),
      movementLeft: 2,
    },
    {
      id: asUnitId(1),
      type: asUnitTypeId('settler'),
      owner: asPlayerId(1),
      tile: tileIndex(WIDTH, 0, 1),
      movementLeft: 2,
    },
  ],
  explored: [
    new Array<boolean>(WIDTH * HEIGHT).fill(true),
    new Array<boolean>(WIDTH * HEIGHT).fill(true),
  ],
});

/** A state whose explored rows are all `false`: the viewer sees nothing. */
const blindState = (): GameState => ({
  ...syntheticState(),
  explored: [
    new Array<boolean>(WIDTH * HEIGHT).fill(false),
    new Array<boolean>(WIDTH * HEIGHT).fill(true),
  ],
});

/**
 * The same hierarchy with every array frozen. A command that mutated the state
 * it was handed — instead of rebuilding it, which is what `applyCommand` does —
 * throws a `TypeError` in strict mode, and that is the test.
 */
const frozenState = (): GameState => {
  const state = syntheticState();
  for (const row of state.explored) Object.freeze(row);
  Object.freeze(state.explored);
  Object.freeze(state.map.terrain);
  Object.freeze(state.map);
  Object.freeze(state.units);
  Object.freeze(state.players);
  return Object.freeze(state);
};

interface Capture {
  readonly session: ReplSession;
  readonly write: (text: string) => void;
  /** Everything printed so far. */
  readonly text: () => string;
  /** Forget what was printed, so one test can assert on one command. */
  readonly clear: () => void;
}

const open = (options?: {
  readonly state?: GameState;
  readonly playerIndex?: number;
  readonly god?: boolean;
}): Capture => {
  const chunks: string[] = [];
  const session = createSession({
    state: options?.state ?? syntheticState(),
    ruleset: RULESET,
    playerId: asPlayerId(options?.playerIndex ?? 0),
    god: options?.god ?? false,
    write: (text: string) => {
      chunks.push(text);
    },
  });
  return {
    session,
    write: (text: string) => {
      chunks.push(text);
    },
    text: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
};

/** Assert a refusal and hand back the engine's typed reason. */
const refusal = (outcome: LineOutcome): GameError => {
  if (outcome.kind !== 'refused') {
    throw new Error(`expected the engine to refuse, got outcome "${outcome.kind}"`);
  }
  return outcome.error;
};

/* ------------------------------------------------------------------ *
 * The transcript: a play session as a regression test
 * ------------------------------------------------------------------ */

const SCRIPT = ['units', 'move 0 1 1', 'move 0 2 2', 'move 0 9 9', 'wibble', 'end', 'quit'];

/**
 * The whole session, verbatim: banner, opening view, and the output of every
 * echoed command. Regenerate deliberately (and say why in the commit message)
 * by running the same state and script through `createSession` + `runScript` and
 * pasting the result — that is the point of the fixture: the transcript may only
 * change on purpose.
 */
const EXPECTED_TRANSCRIPT = [
  'CivTS play - seed 7, tiny map 4x4, 2 civs',
  'you are Player 1 (p0); every view below is drawn from your fog of war',
  'commands: move <unitId> <x> <y> | end | units | state | save <path> | help | quit',
  '',
  'CivTS state: seed=7 turn=1 revision=0 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> units',
  'units: 2 of 2 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     terrain      legal',
  '*  0   Settler     Player 1     0,0       2/2      Grassland    1',
  '   1   Settler     Player 2     0,1       2/2      Grassland    3',
  'CivTS state: seed=7 turn=1 revision=0 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> move 0 1 1',
  'ok: unit 0 moved to (1,1), cost 1, 1 movement left',
  '  revision 1',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> move 0 2 2',
  'error: not-enough-movement - unit 0 (Settler at 1,1, 1/2 per turn movement left) needs 2 movement for the step onto that tile, but only 1 is left. "end" refills movement.',
  '  legal: unit 0 (Settler at 1,1, 1/2 per turn movement left) can move to (0,0) (2,0) (2,1) (0,2) (1,2).',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> move 0 9 9',
  'error: malformed command - (9,9) is outside the map (4x4): x must be 0..3 and y must be 0..3.',
  '  the ruler above the map lists the valid columns and rows',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> wibble',
  'error: unknown command "wibble" - no such command.',
  '  commands: move <unitId> <x> <y> | end | units | state | save <path> | help | quit',
  '  type "help" for what each one does.',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> end',
  'ok: turn 2 begins; every unit refilled its movement',
  '  revision 2',
  'CivTS state: seed=7 turn=2 revision=2 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)',
  'p0> quit',
  'bye - the state lives in memory only unless you ran "save <path>".',
].join('\n');

describe('the REPL transcript', () => {
  it('is exactly this, for a fixed state and script', () => {
    // The fixture is pinned as well as its rendering: if the shape of
    // `GameState`, the generation or the rules data moves, this hash moves and
    // the transcript below is no longer the transcript of *this* state.
    expect(hashValue(syntheticState())).toBe('b9166aa11541451a');

    const capture = open();
    runScript(capture.session, SCRIPT.join('\n'), capture.write);

    expect(capture.text()).toBe(`${EXPECTED_TRANSCRIPT}\n`);
  });

  it('is byte-identical across two runs of the same script', () => {
    const first = open();
    runScript(first.session, SCRIPT.join('\n'), first.write);
    const second = open();
    runScript(second.session, SCRIPT.join('\n'), second.write);

    expect(first.text()).toBe(second.text());
    expect(hashValue(first.session.state)).toBe(hashValue(second.session.state));
  });

  it('reports the state it ended on, not the one it started from', () => {
    const capture = open();
    runScript(capture.session, SCRIPT.join('\n'), capture.write);

    // move 0 1 1 applies; `end` applies; everything else in the script is
    // refused or malformed, so the final revision is exactly 2.
    expect(capture.session.state.revision).toBe(2);
    expect(capture.session.state.turn).toBe(2);
    expect(hashValue(capture.session.state)).toBe('416a43bd669192b4');
  });
});

/* ------------------------------------------------------------------ *
 * Refusals: what a bad command must not do
 * ------------------------------------------------------------------ */

describe('a command that does not apply', () => {
  it('never advances the game, whatever went wrong', () => {
    const capture = open();
    const before = hashValue(capture.session.state);
    const lines = [
      '', // empty input: nothing to do
      'move', // too few arguments
      'move 0', // still too few
      'move 0 1', // and still
      'move 0 x 1', // not a number
      'move 0 1.5 1', // not an integer
      'move 0 9 9', // off the map
      'move 9 1 1', // no such unit
      'move 1 1 1', // someone else's unit
      'move 0 1 0', // impassable
      'move 0 0 1', // enemy-held
      'move 0 2 2', // costs more movement than the unit has
      'wibble', // no such command
      'end extra', // an argument end does not take
      'units 2', // an argument units does not take
      'state now', // an argument state does not take
      'save', // a path save needs
    ];

    for (const line of lines) {
      const outcome = capture.session.run(line);
      expect(outcome.kind === 'applied').toBe(false);
    }

    expect(capture.session.state.revision).toBe(0);
    expect(capture.session.state.turn).toBe(1);
    expect(hashValue(capture.session.state)).toBe(before);
  });

  it('reports the typed GameError for every kind of illegal move', () => {
    const capture = open();
    const cases: readonly (readonly [string, string])[] = [
      ['move 9 1 1', 'unknown-unit'],
      ['move 1 1 1', 'not-your-unit'],
      ['move 0 1 0', 'impassable'],
      ['move 0 0 1', 'occupied-by-enemy'],
      ['move 0 0 0', 'invalid-argument'],
      ['move 0 2 2', 'invalid-argument'], // not adjacent yet: paths are not M2
    ];

    for (const [line, kind] of cases) {
      expect(refusal(capture.session.run(line)).kind).toBe(kind);
    }

    // …and not one of them moved the game on.
    expect(capture.session.state.revision).toBe(0);

    // The hills at (2,2) cost 2; one step onto (1,1) leaves 1, so the refusal is
    // about movement rather than about geometry.
    expect(capture.session.run('move 0 1 1').kind).toBe('applied');
    expect(refusal(capture.session.run('move 0 2 2')).kind).toBe('not-enough-movement');
    expect(capture.session.state.revision).toBe(1);
  });

  it('says what was wrong and which moves were legal', () => {
    const capture = open();

    capture.clear();
    capture.session.run('move 0 1 0');
    expect(capture.text()).toContain('impassable');
    expect(capture.text()).toContain('Mountains');
    expect(capture.text()).toContain('legal:');

    capture.session.run('move 0 1 1');
    capture.clear();
    capture.session.run('move 0 2 2');
    expect(capture.text()).toContain('not-enough-movement');
    expect(capture.text()).toContain('needs 2 movement');

    capture.clear();
    capture.session.run('move 9 1 1');
    expect(capture.text()).toContain('unknown-unit');
    expect(capture.text()).toContain('your units: 0 Settler at 1,1 (1 movement left)');

    capture.clear();
    capture.session.run('move 1 1 1');
    expect(capture.text()).toContain('not-your-unit');
    expect(capture.text()).toContain('belongs to Player 2 (p1)');

    capture.clear();
    capture.session.run('wibble');
    expect(capture.text()).toContain('unknown command "wibble"');
    expect(capture.text()).toContain('type "help"');

    capture.clear();
    capture.session.run('move 0 9 9');
    expect(capture.text()).toContain('(9,9) is outside the map (4x4)');
    expect(capture.text()).toContain('x must be 0..3');
  });
});

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

describe('commands', () => {
  it('map onto engine commands rather than editing state', () => {
    const capture = open();

    const moved = capture.session.run('move 0 1 1');
    expect(moved).toMatchObject({
      kind: 'applied',
      command: { type: 'MoveUnit', unitId: 0, to: tileIndex(WIDTH, 1, 1) },
    });

    const ended = capture.session.run('end');
    expect(ended).toMatchObject({ kind: 'applied', command: { type: 'EndTurn' } });
    expect(capture.session.state.revision).toBe(2);

    // A refused move carries its command too, so a caller can see *what* the
    // engine said no to without re-parsing the line.
    const refused = capture.session.run('move 0 1 0');
    expect(refused).toMatchObject({ kind: 'refused', command: { type: 'MoveUnit' } });
  });

  it('accepts diagonal steps, exactly one tile at a time', () => {
    const capture = open();
    expect(capture.session.run('move 0 1 1').kind).toBe('applied');
    expect(refusal(capture.session.run('move 0 3 3')).kind).toBe('invalid-argument');
  });

  it('leaves the state it was handed untouched, even frozen', () => {
    const state = frozenState();
    const before = hashValue(state);
    const capture = open({ state });

    expect(capture.session.run('move 0 1 1').kind).toBe('applied');
    expect(capture.session.run('end').kind).toBe('applied');

    expect(capture.session.state).not.toBe(state);
    expect(hashValue(state)).toBe(before);
    expect(hashValue(state)).toBe('b9166aa11541451a');

    // Same input, same result: the session holds no hidden state of its own.
    const fresh = open();
    fresh.session.run('move 0 1 1');
    fresh.session.run('end');
    expect(hashValue(fresh.session.state)).toBe(hashValue(capture.session.state));
  });

  it('ends the turn at end of input instead of hanging', () => {
    const capture = open();
    capture.clear();

    expect(runScript(capture.session, '', capture.write)).toBe(0);
    expect(capture.text()).toBe('');

    // A script that never says "quit" is a normal way to end a session.
    expect(runScript(capture.session, 'end\n', capture.write)).toBe(0);
    expect(capture.session.state.turn).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Inspectors — the agent's eyes
 * ------------------------------------------------------------------ */

describe('inspectors', () => {
  it('shows unit ids, remaining movement and the terrain under each unit', () => {
    const capture = open();
    capture.clear();
    capture.session.run('units');

    const text = capture.text();
    expect(text).toContain('units: 2 of 2 visible for Player 1 (p0)');
    expect(text).toContain('*  0   Settler     Player 1     0,0       2/2');
    expect(text).toContain('Grassland');
    expect(text).toContain('units: *0 p0 Settler @0,0 (2/2 movement)');
  });

  it('hides units standing outside the fog, and says how many', () => {
    const capture = open({ state: blindState() });
    capture.clear();
    capture.session.run('units');

    const text = capture.text();
    expect(text).toContain('units: 1 of 2 visible');
    expect(text).toContain('+1 unit(s) of other players are outside your fog');
    expect(text).not.toContain('Player 2');
    expect(text).not.toContain('0,1'); // the enemy tile is not even a coordinate yet
  });

  it('prints the state hash the golden harness would compute', () => {
    const capture = open();
    capture.clear();
    capture.session.run('state');

    const text = capture.text();
    expect(text).toContain(`hash: ${hashValue(capture.session.state)}`);
    expect(text).toContain('turn=1');
    expect(text).toContain('revision=0');
    expect(text).toContain(`schema=${String(SCHEMA_VERSION)}`);
    expect(text).toContain('explored 16/16 tiles');
  });

  it('documents every command in help', () => {
    const capture = open();
    capture.clear();
    capture.session.run('help');

    const text = capture.text();
    for (const command of ['move', 'end', 'units', 'state', 'save', 'help', 'quit']) {
      expect(text).toContain(command);
    }
    expect(text).toContain('move <unitId> <x> <y>');
    expect(text).toContain('legal');
  });

  it('saves a state that loads back to the same hash, byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'civts-repl-'));
    try {
      const capture = open();
      capture.session.run('move 0 1 1');
      const expected = hashValue(capture.session.state);

      const first = join(dir, 'one.json');
      const second = join(dir, 'two.json');
      expect(capture.session.run(`save ${first}`).kind).toBe('inspected');
      expect(capture.session.run(`save ${second}`).kind).toBe('inspected');

      const body = readFileSync(first, 'utf8');
      // Canonical JSON: the same state produces the same bytes, so a save is
      // diffable and hashable like any other state.
      expect(body).toBe(readFileSync(second, 'utf8'));
      expect(body.endsWith('\n')).toBe(true);

      const parsed: unknown = JSON.parse(body);
      const saved = stateOf(parsed);
      expect(hashValue(saved)).toBe(expected);
      expect(saved).toEqual(capture.session.state);
      expect(parsed).toMatchObject({ engine: 'civts', schemaVersion: SCHEMA_VERSION });
      expect(canonicalize(parsed)).toBe(body.trimEnd());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The `state` field of a save envelope, without casting the parsed JSON. */
const stateOf = (envelope: unknown): unknown => {
  if (typeof envelope !== 'object' || envelope === null || !('state' in envelope)) {
    throw new Error('the save envelope has no "state" field');
  }
  return envelope.state;
};

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

describe('flags', () => {
  it('rejects a typo instead of quietly playing another game', () => {
    for (const args of [
      ['--seed', 'abc'],
      ['--seed', '1.5'],
      ['--seed'],
      ['--civs', 'two'],
      ['--map-size', 'smallest'],
      ['--player', 'x'],
      ['--wat'],
    ]) {
      expect(parsePlayArgs(args).ok).toBe(false);
    }
  });

  it('parses the documented invocation', () => {
    const flags = parsePlayArgs([
      '--seed',
      '42',
      '--map-size',
      'tiny',
      '--civs',
      '2',
      '--player',
      '1',
      '--script',
      'session.txt',
      '--god',
    ]);
    if (!flags.ok) throw new Error(`expected the flags to parse: ${flags.error}`);

    expect(flags.value).toEqual({
      seed: 42,
      mapSize: 'tiny',
      civCount: 2,
      playerIndex: 1,
      scriptPath: 'session.txt',
      god: true,
    });
  });

  it('--player decides who the session acts as', () => {
    const capture = open({ playerIndex: 1 });
    expect(capture.text()).toContain('you are Player 2 (p1)');
    expect(capture.text()).toContain('*1 p1 Settler @0,1 (2/2 movement)');

    expect(refusal(capture.session.run('move 0 1 1')).kind).toBe('not-your-unit');
    expect(capture.session.run('move 1 0 2').kind).toBe('applied');
  });

  it('--god renders the whole map instead of the fog', () => {
    const fogged = open({ state: blindState() });
    const god = open({ state: blindState(), god: true });

    // Nothing explored: every tile is a question mark, even the viewer's own row.
    expect(fogged.text()).toContain('0 |????');
    expect(fogged.text()).toContain('? unexplored');
    expect(fogged.text()).toContain('starts: (+2 unexplored)');

    expect(god.text()).toContain('GOD MODE');
    expect(god.text()).toContain('0 |0^,,');
    expect(god.text()).not.toContain('? unexplored');
  });
});

/* ------------------------------------------------------------------ *
 * The real CLI, driven the way a pipeline drives it
 * ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(REPO_ROOT, 'packages', 'headless', 'src', 'cli.ts');

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = (args: readonly string[], input: string): CliRun => {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('the play command', () => {
  it('exits 0 when stdin is closed, printing the opening view', () => {
    const run = runCli(['play', '--seed', '42', '--map-size', 'duel', '--civs', '2'], '');

    expect(run.stderr).not.toContain('fatal');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('CivTS play - seed 42, duel map 40x40, 2 civs');
    expect(run.stdout).toContain('you are Player 1 (p0)');
    expect(run.stdout).toContain('CivTS state: seed=42 turn=1 revision=0');
  }, 120_000);

  it('runs --script deterministically, against the same engine the tests use', () => {
    const setup = newGame(
      42,
      { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2, seed: 42 },
      RULESET,
    );
    if (!setup.ok) throw new Error(`newGame failed: ${setup.error.kind}`);

    const dir = mkdtempSync(join(tmpdir(), 'civts-repl-cli-'));
    try {
      const script = join(dir, 'session.txt');
      writeFileSync(script, 'state\nunits\nquit\n', 'utf8');

      const args = [
        'play',
        '--seed',
        '42',
        '--map-size',
        'duel',
        '--civs',
        '2',
        '--script',
        script,
      ];
      const first = runCli(args, '');
      const second = runCli(args, '');

      expect(first.status).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).toContain('p0> state');
      expect(first.stdout).toContain(`hash: ${hashValue(setup.value)}`);
      expect(first.stdout).toContain('p0> quit');
      expect(first.stdout).toContain('bye');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a --player that is not in the game', () => {
    const run = runCli(['play', '--seed', '42', '--player', '3'], '');

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--player 3 is not a player in this game');
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * The CLI's other output surfaces, driven the same way.
 *
 * `provenance` is the honesty surface PLAN.md §6.2 turns on: it must report the
 * cited-vs-placeholder ratio *and* the rows that ratio was counted over, and the
 * two must agree. These tests live here because this file already drives the real
 * CLI as a subprocess, which is the only way to test what a command prints.
 * ------------------------------------------------------------------ */

/** A section heading: `terrains — 6 rows, 0 cited, 6 placeholder`. */
const SECTION_HEADING = /^(\w+) — (\d+) rows?, (\d+) cited, (\d+) placeholder$/;

/** The first line: `ruleset provenance — 0/11 cited (0%), 11 placeholder`. */
const PROVENANCE_HEADER = /^ruleset provenance — (\d+)\/(\d+) cited \((\d+)%\), (\d+) placeholder$/;

/** One printed row: `id`, the provenance kind, and the claim itself. */
interface PrintedRow {
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
}

interface PrintedSection {
  readonly name: string;
  readonly total: number;
  readonly cited: number;
  readonly placeholder: number;
  readonly rows: readonly PrintedRow[];
}

/** `PrintedSection` while it is being filled in, so no cast is needed to build it. */
type SectionInProgress = Omit<PrintedSection, 'rows'> & { rows: PrintedRow[] };

interface PrintedProvenance {
  readonly cited: number;
  readonly total: number;
  readonly placeholder: number;
  readonly sections: readonly PrintedSection[];
}

/**
 * Read the report the way a person does — the printed total, then each section's
 * heading and the rows indented under it — so the test compares what was printed
 * rather than what the code holds internally.
 */
const parseProvenance = (stdout: string): PrintedProvenance => {
  const lines = stdout.split('\n');
  const header = PROVENANCE_HEADER.exec(lines[0] ?? '');
  if (header === null) throw new Error(`unrecognised provenance header: "${lines[0] ?? ''}"`);

  const sections: SectionInProgress[] = [];
  for (const line of lines.slice(1)) {
    const heading = SECTION_HEADING.exec(line);
    if (heading !== null) {
      sections.push({
        name: heading[1] ?? '',
        total: Number(heading[2]),
        cited: Number(heading[3]),
        placeholder: Number(heading[4]),
        rows: [],
      });
      continue;
    }

    // A row is indented; everything else (blank lines, the closing note) is not.
    if (!/^ {2}\S/.test(line)) continue;
    const [id, kind, ...rest] = line.trim().split(/\s+/);
    if (id === undefined || kind === undefined) continue;
    const row: PrintedRow = { id, kind, detail: rest.join(' ') };

    // Rows printed before any heading land in an unnamed section: the assertions
    // below then report the rows/total mismatch itself rather than blaming the
    // parser for a report that has no sections at all.
    const current = sections[sections.length - 1];
    if (current === undefined) {
      sections.push({ name: '', total: 0, cited: 0, placeholder: 0, rows: [row] });
      continue;
    }
    current.rows.push(row);
  }

  return {
    cited: Number(header[1]),
    total: Number(header[2]),
    placeholder: Number(header[4]),
    sections,
  };
};

/** The rows of every section, in printed order. */
const printedRows = (printed: PrintedProvenance): readonly PrintedRow[] =>
  printed.sections.flatMap((section) => section.rows);

describe('the provenance command', () => {
  it('lists every row its totals count — terrain and unit alike', () => {
    const run = runCli(['provenance'], '');

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('ruleset error');

    const printed = parseProvenance(run.stdout);

    // The header's own arithmetic, and the report is not empty.
    expect(printed.cited + printed.placeholder).toBe(printed.total);
    expect(printed.total).toBeGreaterThan(0);

    // The rows printed are exactly the rows of the catalog — both catalogs, in
    // catalog order. While only the terrain table was rendered, this listed six
    // rows under a total of eleven: a report that overstated its own coverage.
    const rows = printedRows(printed);
    expect(rows.map((row) => row.id)).toEqual([
      ...CATALOG.terrains.map((t) => t.id),
      ...CATALOG.units.map((u) => u.id),
    ]);

    // …which is what makes the table and the totals agree.
    expect(rows.length).toBe(printed.total);
    expect(rows.filter((row) => row.kind === 'placeholder').length).toBe(printed.placeholder);
    expect(rows.filter((row) => row.kind === 'cited').length).toBe(printed.cited);
  });

  it('states each section in its own heading, and adds those up to the total', () => {
    const stdout = runCli(['provenance'], '').stdout;
    const printed = parseProvenance(stdout);

    expect(printed.sections.map((section) => section.name)).toEqual(['terrains', 'units']);

    for (const section of printed.sections) {
      // Every section heading is a claim about the rows printed beneath it.
      expect(section.rows.length).toBe(section.total);
      expect(section.rows.filter((row) => row.kind === 'placeholder').length).toBe(
        section.placeholder,
      );
      expect(section.cited + section.placeholder).toBe(section.total);
      expect(section.total).toBeGreaterThan(0);
    }

    const sum = (pick: (section: PrintedSection) => number): number =>
      printed.sections.reduce((n, section) => n + pick(section), 0);
    expect(sum((section) => section.total)).toBe(printed.total);
    expect(sum((section) => section.placeholder)).toBe(printed.placeholder);

    // The unit section is not a stub: it carries the real unit rows, and each
    // row's claim text — not just its id — is what the catalog holds.
    const units = printed.sections.find((section) => section.name === 'units');
    expect(units?.rows.map((row) => row.id)).toEqual(CATALOG.units.map((u) => u.id));

    const settler = CATALOG.units.find((u) => u.id === 'settler');
    expect(settler?.provenance.kind).toBe('placeholder');
    if (settler?.provenance.kind === 'placeholder') {
      expect(units?.rows[0]?.detail).toBe(settler.provenance.note);
      expect(stdout).toContain(settler.provenance.note);
    }
  }, 120_000);
});

describe('the map command', () => {
  it('prints the same world, and the same hash, as the engine in-process', () => {
    const run = runCli(['map', '--seed', '42', '--map-size', 'tiny', '--civs', '2'], '');
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('error');

    const setup = newGame(
      42,
      { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed: 42 },
      RULESET,
    );
    if (!setup.ok) throw new Error(`newGame failed: ${setup.error.kind}`);

    expect(run.stdout).toContain('CivTS state: seed=42 turn=1');
    expect(run.stdout).toContain('legend:');
    expect(run.stdout).toContain(`state hash: ${hashValue(setup.value)}`);
  }, 120_000);
});
