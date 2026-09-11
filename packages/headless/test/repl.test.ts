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
 * - **M4a: the worker surface is a third copy of the same arrangement.** `work
 *   <unitId> <improvementId>` and `cancel <unitId>` build exactly one `Command`
 *   each and hand it to the engine, every refusal is the engine's typed reason, and
 *   what a unit is *doing* shows up wherever a unit shows up — the `units:` line,
 *   the `units` table and the `state` view. `work` keeps M3's city reading (the
 *   second argument tells the two apart) and both readings are pinned.
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
  asBuildingId,
  asCityId,
  asImprovementId,
  asPlayerId,
  asTerrainId,
  asUnitId,
  asUnitTypeId,
  cityById,
  cityRadius,
  foodBoxSize,
  indexToX,
  indexToY,
  newGame,
  seedRng,
  tileIndex,
  type City,
  type GameError,
  type GameEvent,
  type GameState,
  type RulesetView,
  type TerrainId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { canonicalize, hashValue } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_SUMMARY,
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
 *
 * Migrated to the M3 state shape (docs/INTERFACES.md M3): both players are
 * civilizations (`kind`), the map carries `huts` (this board has none — the
 * fixture is about movement and fog, and a hut would only be a M3 reward test of
 * its own), and the state carries `nextCityId`/`cities`. There is deliberately
 * **no** barbarian player here: the session is driven against a hand-built
 * board, so the transcript stays a fixture of the *REPL*, while the barbarian
 * player `newGame` appends is exercised by the real-CLI tests below.
 */
const syntheticState = (): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed: 7 },
  rng: seedRng(7),
  map: { width: WIDTH, height: HEIGHT, terrain: terrainIds(), huts: [] },
  players: [
    {
      id: asPlayerId(0),
      name: 'Player 1',
      color: '#d12f2f',
      startingTile: tileIndex(WIDTH, 0, 0),
      kind: 'civ',
    },
    {
      id: asPlayerId(1),
      name: 'Player 2',
      color: '#2f6fd1',
      startingTile: tileIndex(WIDTH, 0, 1),
      kind: 'civ',
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
  nextCityId: 0,
  cities: [],
  // M4a: nothing is built yet, and the key is an *empty array* rather than absent —
  // `improvements` is part of every state hash, and `canonicalize` refuses
  // `undefined` (the trap that cost M2's `Settings.ruleset` and M3's
  // `City.production` a bug hunt each). `workerState` below is where a job appears.
  improvements: [],
});

/**
 * The synthetic board plus one worker of player 0's, standing on the hills at
 * (2,2) with a full allowance of movement and no job yet.
 *
 * The worker exists for the M4a surface: `work <unitId> <improvementId>` and
 * `cancel <unitId>`, and the job that then shows up in the `units:` line, the
 * `units` table and the `state` view. (2,2) is deliberately the *hills* tile: it is
 * the one tile on this board where a mine is allowed but irrigation is not, so a
 * refusal about terrain has somewhere to happen.
 *
 * An idle unit carries **no** `work` key: `withWork` is the only writer of that
 * field and it is never handed `undefined`, because a present-but-`undefined` key
 * cannot survive a JSON round trip and would make the state unhashable.
 */
const workerState = (): GameState => {
  const base = syntheticState();
  return {
    ...base,
    nextUnitId: 3,
    units: [
      ...base.units,
      {
        id: asUnitId(2),
        type: asUnitTypeId('worker'),
        owner: asPlayerId(0),
        tile: tileIndex(WIDTH, 2, 2),
        movementLeft: 2,
      },
    ],
  };
};

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
  /** A view other than the shipped catalog's, for the ambiguity a kind must break. */
  readonly ruleset?: RulesetView;
}): Capture => {
  const chunks: string[] = [];
  const session = createSession({
    state: options?.state ?? syntheticState(),
    ruleset: options?.ruleset ?? RULESET,
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

/** The events of an applied command, or a thrown error — for assertions on what happened. */
const appliedEvents = (outcome: LineOutcome): readonly GameEvent[] => {
  if (outcome.kind !== 'applied') {
    throw new Error(`expected an applied command, got outcome "${outcome.kind}"`);
  }
  return outcome.outcome.events;
};

/**
 * The regression this whole file exists to keep: rendering an applied command must
 * be **complete**.
 *
 * A `GameEvent` member the renderer does not handle falls through its `switch` and
 * maps to `undefined`, which throws nothing and prints no error — it joins into a
 * silently **blank line** inside the `ok:` block, and a transcript with a missing
 * case in it reads like a formatting choice. So the assertion is exact: one
 * non-empty `ok: ` line per event, no blank line among them, and the revision line
 * after them. A missing case fails the count; a case that renders as `''` fails
 * the "has content" check.
 */
const expectEveryEventRendered = (outcome: LineOutcome, text: string): readonly string[] => {
  const events = appliedEvents(outcome);
  if (events.length === 0) {
    throw new Error('expectEveryEventRendered wants a command that emitted events');
  }
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('ok: '));
  const revision = lines.findIndex((line) => line.startsWith('  revision '));

  expect(start).toBeGreaterThanOrEqual(0);
  expect(revision).toBeGreaterThan(start);

  const block = lines.slice(start, revision);
  expect(block).toHaveLength(events.length);
  for (const line of block) {
    expect(line.startsWith('ok: ')).toBe(true);
    expect(line.length).toBeGreaterThan('ok: '.length);
  }
  expect(text).not.toMatch(/undefined|NaN/);
  return block;
};

/**
 * The same regression without the events list: **no `ok:` block may contain a
 * blank line**.
 *
 * `expectEveryEventRendered` above proves it for one command whose events the test
 * already knows. This walks a whole transcript instead, which is how the M4a work
 * events are covered end to end — `WorkStarted`, `WorkCancelled` and
 * `WorkCompleted` each have to print a real line, and an unhandled member shows up
 * here as an empty line *inside* a block (or as a block that runs into the revision
 * line with nothing in it).
 */
const expectNoBlankEventLines = (text: string): void => {
  const lines = text.split('\n');
  let blocks = 0;

  // Anchored on the revision line rather than on the block's first `ok: ` line: an
  // event that renders as `''` produces no `ok: ` line at all, so a scan that looks
  // for one simply *skips* the very block it was meant to catch. Everything before a
  // revision line, back to the echoed command, is that command's events.
  for (const [index, line] of lines.entries()) {
    if (!/^ {2}revision /.test(line)) continue;

    let previous = index - 1;
    while (previous >= 0 && (lines[previous] ?? '').startsWith('ok: ')) {
      expect((lines[previous] ?? '').length).toBeGreaterThan('ok: '.length);
      previous -= 1;
    }

    // At least one event, and the line before the block is the command that was
    // echoed — never a blank line, which is exactly what a missing `case` leaves.
    expect(index - 1 - previous).toBeGreaterThan(0);
    expect(lines[previous] ?? '').not.toBe('');
    blocks += 1;
  }

  expect(blocks).toBeGreaterThan(0);
  expect(text).not.toMatch(/\nok: ?\n/);
  expect(text).not.toMatch(/\n\n {2}revision /);
};

/**
 * The synthetic board plus a goody hut at (1,1) and a chosen RNG state: the unit
 * at (0,0) can step onto the hut, so one `move` reaches the whole hut rule —
 * including which of the three rewards the draw gives, which is `rngSeed`'s job.
 *
 * Unlike `syntheticState`, this board carries the **barbarian player** `newGame`
 * appends (with a blank explored row, since `PlayerId` indexes that array).
 * `hut.ts` degenerates a band to `reward: 'nothing'` when no player could own it,
 * so without one the barbarian third of the reward table is unreachable — and the
 * rendering of `BarbariansSpawned` would go untested.
 */
const hutState = (rngSeed: number): GameState => {
  const base = syntheticState();
  return {
    ...base,
    rng: seedRng(rngSeed),
    map: { ...base.map, huts: [tileIndex(WIDTH, 1, 1)] },
    players: [
      ...base.players,
      {
        id: asPlayerId(2),
        name: 'Barbarians',
        color: '#3f3f46',
        startingTile: tileIndex(WIDTH, 1, 1),
        kind: 'barbarian',
      },
    ],
    explored: [...base.explored, new Array<boolean>(WIDTH * HEIGHT).fill(false)],
  };
};

/** The city with this id, or a thrown error: the tests below founded it first. */
const cityOf = (state: GameState, id = 0): City => {
  const city = cityById(state, asCityId(id));
  if (city === undefined) throw new Error(`the session has no city ${String(id)}`);
  return city;
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
 *
 * Regenerated once for M3, deliberately, for two reasons that are visible in the
 * text below: the command summary (printed in the banner and under an unknown
 * command) now names the city verbs, and every view now carries a `cities:` line
 * under its `units:` line. The view had to grow that line: `describe` draws
 * terrain and goody huts, not cities, so a session that founded one would else
 * show a map with no unit on it and no sign of the city it had just built.
 */
const EXPECTED_TRANSCRIPT = [
  'CivTS play - seed 7, tiny map 4x4, 2 civs',
  'you are Player 1 (p0); every view below is drawn from your fog of war',
  'commands: move <unitId> <x> <y> | found <unitId> | cities | city <cityId> | work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | work <unitId> <improvementId> | cancel <unitId> | end | units | state | save <path> | help | quit',
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
  'cities: none',
  'p0> units',
  'units: 2 of 2 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     terrain      job                         legal',
  '*  0   Settler     Player 1     0,0       2/2      Grassland    (idle)                      1',
  '   1   Settler     Player 2     0,1       2/2      Grassland    (idle)                      3',
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
  'cities: none',
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
  'cities: none',
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
  'cities: none',
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
  'cities: none',
  'p0> wibble',
  'error: unknown command "wibble" - no such command.',
  '  commands: move <unitId> <x> <y> | found <unitId> | cities | city <cityId> | work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | work <unitId> <improvementId> | cancel <unitId> | end | units | state | save <path> | help | quit',
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
  'cities: none',
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
  'cities: none',
  'p0> quit',
  'bye - the state lives in memory only unless you ran "save <path>".',
].join('\n');

const WORKER_SCRIPT = [
  'units',
  'work 2 mine',
  'state',
  'end',
  'cancel 2',
  'work 2 road',
  'end',
  'end',
  'units',
  'quit',
];

const EXPECTED_WORKER_TRANSCRIPT = [
  'CivTS play - seed 7, tiny map 4x4, 2 civs',
  'you are Player 1 (p0); every view below is drawn from your fog of war',
  'commands: move <unitId> <x> <y> | found <unitId> | cities | city <cityId> | work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | work <unitId> <improvementId> | cancel <unitId> | end | units | state | save <path> | help | quit',
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
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement)',
  'cities: none',
  'p0> units',
  'units: 3 of 3 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     terrain      job                         legal',
  '*  0   Settler     Player 1     0,0       2/2      Grassland    (idle)                      1',
  '   1   Settler     Player 2     0,1       2/2      Grassland    (idle)                      3',
  '*  2   Worker      Player 1     2,2       2/2      Hills        (idle)                      8',
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
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement)',
  'cities: none',
  'p0> work 2 mine',
  'ok: unit 2 started improvement "Mine" (3 turns) on (2,2): 3 turns left',
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
  'work: 2 p0 Worker@2,2 mining, 3 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (0/2 movement) mining, 3 turns left',
  'cities: none',
  'p0> state',
  'state: seed=7 turn=1 revision=1 schema=4 map=tiny(4x4) civs=2',
  'you: 2 unit(s), explored 16/16 tiles, 16 visible right now',
  'jobs: 2 Worker@2,2 mining, 3 turns left',
  'civs: Player 1 (p0) <- you, Player 2 (p1)',
  'rng: a=-456573687 b=-84222363 c=801465066 d=1648156487',
  'hash: b7b4f66082f55c25',
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
  'work: 2 p0 Worker@2,2 mining, 3 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (0/2 movement) mining, 3 turns left',
  'cities: none',
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
  'work: 2 p0 Worker@2,2 mining, 2 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement) mining, 2 turns left',
  'cities: none',
  'p0> cancel 2',
  'ok: unit 2 stopped improvement "Mine" (3 turns) on (2,2) (cancelled), 2 turns of work lost',
  '  revision 3',
  'CivTS state: seed=7 turn=2 revision=3 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement)',
  'cities: none',
  'p0> work 2 road',
  'ok: unit 2 started improvement "Road" (2 turns) on (2,2): 2 turns left',
  '  revision 4',
  'CivTS state: seed=7 turn=2 revision=4 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 building a road, 2 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (0/2 movement) building a road, 2 turns left',
  'cities: none',
  'p0> end',
  'ok: turn 3 begins; every unit refilled its movement',
  '  revision 5',
  'CivTS state: seed=7 turn=3 revision=5 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 building a road, 1 turn left',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement) building a road, 1 turn left',
  'cities: none',
  'p0> end',
  'ok: unit 2 finished improvement "Road" (2 turns) on (2,2); the tile is improved',
  'ok: turn 4 begins; every unit refilled its movement',
  '  revision 6',
  'CivTS state: seed=7 turn=4 revision=6 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement)',
  'cities: none',
  'p0> units',
  'units: 3 of 3 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     terrain      job                         legal',
  '*  0   Settler     Player 1     0,0       2/2      Grassland    (idle)                      1',
  '   1   Settler     Player 2     0,1       2/2      Grassland    (idle)                      3',
  '*  2   Worker      Player 1     2,2       2/2      Hills        (idle)                      8',
  'CivTS state: seed=7 turn=4 revision=6 map=tiny(4x4) civs=2 viewer=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  *2 p0 Worker @2,2 (2/2 movement)',
  'cities: none',
  'p0> quit',
  'bye - the state lives in memory only unless you ran "save <path>".',
].join('\n');

describe('the REPL transcript', () => {
  it('is exactly this, for a fixed state and script', () => {
    // The fixture is pinned as well as its rendering: if the shape of
    // `GameState`, the generation or the rules data moves, this hash moves and
    // the transcript below is no longer the transcript of *this* state.
    //
    // Rehashed for M3 (SCHEMA_VERSION 2 -> 3): the state gained `nextCityId` and
    // `cities`, the map gained `huts` and each player gained `kind`, so every
    // state hash moved. b9166aa11541451a -> d270dc95982b4fdb. The *transcript*
    // did not move: this fixture's two players are both civilizations, so
    // nothing that lists players changed for it.
    expect(hashValue(syntheticState())).toBe('15920e8782c85ecd');

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
    // Rehashed for M4a (SCHEMA_VERSION 3 -> 4): the state gained `improvements`,
    // and an additive field moves *every* state hash. 880e2d6fa2c828dd ->
    // 73edef6a26a57a1f. The transcript above is unchanged by this one: `describe`
    // reads the job on a *unit*, and no unit on this board is working.
    expect(hashValue(capture.session.state)).toBe('73edef6a26a57a1f');
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
      // The M3 city verbs, same rule: a bad argument or a refusal never moves the
      // game on. ('found 0' is deliberately absent — on this board the settler at
      // (0,0) *can* found a city, which is the point of the verb.)
      'found', // needs a unit id
      'found 0 extra', // and only one
      'found x', // not a number
      'found 9', // no such unit
      'cities 1', // an argument cities does not take
      'city', // needs a city id
      'city x', // not a number
      'city 0', // no such city yet: an inspector, not a command
      'work', // needs a city id
      'work 0 1', // a pair needs two coordinates
      'work 0 x 1', // not a number
      'work 0 9 9', // off the map
      'work 9 1 1', // no such city
      'build', // needs a city and an item
      'build 0', // needs an item
      'build 0 unit:', // an empty id after the kind
      'build 0 tile:scout', // not a kind of thing to build
      'build 0 unit:wibble', // no such item, and no city either
      'build 9 unit:scout', // no such city
      // The M4a worker verbs, same rule: a bad argument, a missing unit, a unit that
      // is not a worker, a job that cannot start and a `cancel` on an idle unit are
      // all refusals or malformed lines, and none of them touches the state.
      'work 2 mine', // no such unit on this board
      'work 0 mine', // a settler is not a worker
      'work 0', // the city reading: no such city
      'work 0 mine extra', // the worker reading takes one improvement id
      'cancel', // needs a unit id
      'cancel 0 extra', // and only one
      'cancel x', // not a number
      'cancel 0', // not working: a refusal, never a silent no-op
      'cancel 9', // no such unit
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
    // Rehashed for M4a: the fixture gained `improvements: []` (see the transcript
    // hash above).
    expect(hashValue(state)).toBe('15920e8782c85ecd');

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
 * M3 — the city verbs: found, show, work, build, and the turn that grows
 * ------------------------------------------------------------------ */

describe('the city verbs', () => {
  it('founds a city with "found <unitId>" and consumes the settler', () => {
    const capture = open();
    capture.clear();

    const outcome = capture.session.run('found 0');
    expect(outcome).toMatchObject({ kind: 'applied', command: { type: 'FoundCity', unitId: 0 } });
    expectEveryEventRendered(outcome, capture.text());

    const city = cityOf(capture.session.state);
    expect(city.owner).toBe(asPlayerId(0));
    expect(city.name).toBe('City 1');
    expect(city.tile).toBe(tileIndex(WIDTH, 0, 0));
    expect(city.population).toBe(1);
    expect(city.foodBox).toBe(0);
    expect(city.shields).toBe(0);
    // Nothing is being built yet, and the key is *absent* — a present-but-undefined
    // `production` cannot survive canonical JSON, so `hashValue` would throw on the
    // city the engine had just founded (see `City.production`).
    expect(city.production).toBeUndefined();
    expect('production' in city).toBe(false);
    expect(city.queue).toEqual([]);
    expect(city.buildings).toEqual([]);
    expect(city.workedTiles).toHaveLength(1);
    expect(hashValue(capture.session.state)).toMatch(/^[0-9a-f]{16}$/);

    // The settler is the price, and its id no longer resolves to anything.
    expect(capture.session.state.units.some((unit) => Number(unit.id) === 0)).toBe(false);
    expect(capture.text()).toContain('City 1 founded at (0,0)');
    expect(capture.text()).toContain('the settler is consumed');
    // …and the view under it shows the city, since `describe` draws no cities.
    expect(capture.text()).toContain('cities: *0 City 1 p0 @0,0 pop 1 food 0/10 shields 0 (idle)');
  });

  it('shows one city in full: population, food box and threshold, shields, item, queue, buildings, tiles', () => {
    const capture = open();
    capture.session.run('found 0');
    capture.clear();
    capture.session.run('city 0');

    const state = capture.session.state;
    const city = cityOf(state);
    const box = foodBoxSize(city.population);
    const text = capture.text();

    expect(text).toContain('city 0 "City 1" (Player 1 (p0) at 0,0)');
    expect(text).toContain(`population 1; food box 0/${String(box)} (${String(box)} more to grow)`);
    expect(text).toContain('food 4 per turn, 2 eaten, surplus +2');
    expect(text).toContain('shields 0; building nothing');
    expect(text).toContain('queue: (empty)');
    expect(text).toContain('buildings: (none)');
    expect(text).toContain('works 1 of 1 citizen(s)');

    // The worked tile is the engine's own auto-assignment, printed with its terrain
    // and its coordinates — the numbers a reader assigns from.
    const worked = city.workedTiles[0];
    expect(worked).toBeDefined();
    if (worked !== undefined) {
      expect(text).toContain(
        `(${String(indexToX(state.map, worked))},${String(indexToY(state.map, worked))}) Grassland`,
      );
    }
  });

  it('lists your cities, and says so plainly when you have none', () => {
    const empty = open();
    empty.clear();
    empty.session.run('cities');
    expect(empty.text()).toContain('cities: 0 for Player 1 (p0)');
    expect(empty.text()).toContain('found <unitId>');

    const capture = open();
    capture.session.run('found 0');
    capture.clear();
    capture.session.run('cities');

    const text = capture.text();
    expect(text).toContain('cities: 1 for Player 1 (p0)');
    expect(text).toContain('id  name');
    expect(text).toContain('0   City 1');
    expect(text).toContain('0/10');
    expect(text).toContain('(idle)');
  });

  it('sets production from an explicit unit or building id, and from an unambiguous one', () => {
    const capture = open();
    capture.session.run('found 0');
    capture.clear();

    const unit = capture.session.run('build 0 unit:scout');
    expect(unit).toMatchObject({
      kind: 'applied',
      command: { type: 'SetProduction', cityId: 0, item: { kind: 'unit', id: 'scout' } },
    });
    expect(cityOf(capture.session.state).production).toEqual({ kind: 'unit', id: 'scout' });
    expect(capture.text()).toContain('production set to unit "Scout" (cost 1 shield)');

    const building = capture.session.run('build 0 building:granary');
    expect(building).toMatchObject({
      kind: 'applied',
      command: { type: 'SetProduction', cityId: 0, item: { kind: 'building', id: 'granary' } },
    });
    expect(cityOf(capture.session.state).production).toEqual({ kind: 'building', id: 'granary' });

    // A bare id means the kind that holds it: no unit in this ruleset is a
    // "barracks", so "build 0 barracks" is the building. The kind is still spelled
    // out in the confirmation, so the reading is never left to the reader.
    capture.clear();
    expect(capture.session.run('build 0 barracks').kind).toBe('applied');
    expect(cityOf(capture.session.state).production).toEqual({ kind: 'building', id: 'barracks' });
    expect(capture.text()).toContain('production set to building "Barracks" (cost 12 shields)');

    // …and the city view agrees with the state.
    capture.clear();
    capture.session.run('city 0');
    expect(capture.text()).toContain('building building "Barracks" (cost 12; 12 more to go)');
  });

  it('insists on the kind when a unit and a building share an id', () => {
    // The two id spaces really are different (the note on `ProductionItem` says so),
    // so a bare id both catalogs hold cannot be resolved — and guessing would build
    // the wrong thing. The rule is refused with both spellings offered.
    const shared: RulesetView = {
      ...RULESET,
      buildings: [
        ...(RULESET.buildings ?? []),
        { id: asBuildingId('scout'), name: 'Scout Lodge', cost: 5 },
      ],
    };
    const capture = open({ ruleset: shared });
    capture.session.run('found 0');
    capture.clear();

    const before = hashValue(capture.session.state);
    const ambiguous = capture.session.run('build 0 scout');
    expect(ambiguous.kind).toBe('malformed');
    expect(capture.text()).toContain('is both a unit and a building');
    expect(capture.text()).toContain('unit:scout');
    expect(capture.text()).toContain('building:scout');
    // Refusing the ambiguous spelling changed nothing at all.
    expect(hashValue(capture.session.state)).toBe(before);

    // Both spellings work, and each sets the item it names.
    expect(capture.session.run('build 0 unit:scout').kind).toBe('applied');
    expect(cityOf(capture.session.state).production).toEqual({ kind: 'unit', id: 'scout' });
    expect(capture.session.run('build 0 building:scout').kind).toBe('applied');
    expect(cityOf(capture.session.state).production).toEqual({ kind: 'building', id: 'scout' });
  });

  it('sets which tiles a city works, and clears the assignment with no pairs', () => {
    const capture = open();
    capture.session.run('found 0');
    capture.clear();

    const set = capture.session.run('work 0 1 1');
    expect(set).toMatchObject({
      kind: 'applied',
      command: { type: 'SetWorkedTiles', cityId: 0, tiles: [tileIndex(WIDTH, 1, 1)] },
    });
    expect(cityOf(capture.session.state).workedTiles).toEqual([tileIndex(WIDTH, 1, 1)]);
    expect(capture.text()).toContain('now works (1,1) with 1 of 1 citizen(s)');

    capture.clear();
    expect(capture.session.run('work 0').kind).toBe('applied');
    expect(cityOf(capture.session.state).workedTiles).toEqual([]);
    expect(capture.text()).toContain('now works no tiles');
  });

  it('ends turns until the city grows, and carries the food box over', () => {
    const capture = open();
    capture.session.run('found 0');
    capture.session.run('work 0 1 1');
    capture.clear();

    // One turn at a time, so the exact turn the city grows is asserted, not just
    // that it grew: 4 food a turn, 2 eaten, +2 into a box of 10.
    for (const turn of [1, 2, 3, 4]) {
      const outcome = capture.session.run('end');
      expectEveryEventRendered(outcome, capture.text());
      expect(cityOf(capture.session.state).population).toBe(1);
      expect(cityOf(capture.session.state).foodBox).toBe(2 * turn);
    }

    capture.clear();
    const grew = capture.session.run('end');
    expectEveryEventRendered(grew, capture.text());
    expect(capture.text()).toContain('grew to 2 citizen(s)');
    expect(capture.text()).toContain('food box 0/15 carried over');
    expect(appliedEvents(grew).map((event) => event.type)).toContain('CityGrew');

    const city = cityOf(capture.session.state);
    expect(city.population).toBe(2);
    expect(city.foodBox).toBe(0);
    expect(foodBoxSize(city.population)).toBe(15);
    // The new citizen was assigned a tile by growth, so the city produces what its
    // two citizens can work rather than starving on the next turn.
    expect(city.workedTiles).toHaveLength(2);
    // Shields accumulated for the whole five turns, nothing being built: 2 a turn,
    // plus 1 more on the turn the city grew. That last point is the turn pipeline's
    // order made visible — growth runs *before* production (`turn.ts`), so the new
    // citizen's tile is already being worked when the shields are counted.
    expect(city.shields).toBe(11);

    capture.clear();
    capture.session.run('city 0');
    expect(capture.text()).toContain('population 2; food box 0/15 (15 more to grow)');
    expect(capture.text()).toContain('works 2 of 2 citizen(s)');
  });

  it('leaves revision and the state hash untouched when a city verb is refused', () => {
    const capture = open();
    capture.session.run('found 0');
    const before = hashValue(capture.session.state);
    const revision = capture.session.state.revision;

    const cases: readonly (readonly [string, string])[] = [
      ['work 0 0 0', 'tile-not-workable'], // the centre: always worked, never listed
      ['work 0 3 3', 'tile-not-workable'], // outside the 2-tile radius
      ['work 0 1 1 2 0', 'too-many-worked-tiles'], // two tiles, one citizen
      ['work 9 1 1', 'unknown-city'],
      ['build 0 unit:wibble', 'unknown-production-item'],
      ['build 9 unit:scout', 'unknown-city'],
      ['found 0', 'unknown-unit'], // the settler founded the city and is gone
    ];

    for (const [line, kind] of cases) {
      capture.clear();
      const error = refusal(capture.session.run(line));
      expect(error.kind).toBe(kind);
      // The prose names the typed reason first, so text and type stay in step…
      expect(capture.text()).toContain(`error: ${kind}`);
      // …and nothing moved: not the revision, not one byte of the state.
      expect(capture.session.state.revision).toBe(revision);
      expect(hashValue(capture.session.state)).toBe(before);
    }
  });

  it('teaches what was legal, from the engine’s own evaluators', () => {
    const capture = open();
    capture.session.run('found 0');

    // A tile the city may not work: the lesson is the tiles it *may* work, which
    // is `planSetWorkedTiles` answering one tile at a time.
    capture.clear();
    refusal(capture.session.run('work 0 0 0'));
    expect(capture.text()).toContain('is the centre of');
    expect(capture.text()).toContain('legal:');
    expect(capture.text()).toContain('has 1 citizen(s)');
    expect(capture.text()).toContain('(1,1)');

    // An item this ruleset cannot build: the lesson is everything it can, which is
    // `planSetProduction` answering for every catalog row.
    capture.clear();
    refusal(capture.session.run('build 0 unit:wibble'));
    expect(capture.text()).toContain('cannot build unit "wibble"');
    expect(capture.text()).toContain('may be set to build units: unit "Settler"');
    expect(capture.text()).toContain('unit "Worker" (cost 2 shields), unit "Scout"');
    expect(capture.text()).toContain('buildings: building "Granary"');
    expect(capture.text()).toContain('build 0 building:<id>');

    // An unknown city: the lesson is the cities the session does have.
    capture.clear();
    refusal(capture.session.run('build 9 unit:scout'));
    expect(capture.text()).toContain('your cities: 0 City 1 at 0,0');
  });

  it('refuses to found a city next to one, and says how far apart they must be', () => {
    const first = open();
    first.session.run('found 0');
    const withCity = first.session.state;

    // Player 1's settler at (0,1) is one tile from the city at (0,0).
    const second = open({ state: withCity, playerIndex: 1 });
    const before = hashValue(second.session.state);
    second.clear();

    const error = refusal(second.session.run('found 1'));
    expect(error.kind).toBe('city-too-close');
    expect(second.text()).toContain('error: city-too-close');
    expect(second.text()).toContain('at least 2 apart');
    expect(second.text()).toContain('legal:');
    expect(second.session.state.revision).toBe(withCity.revision);
    expect(hashValue(second.session.state)).toBe(before);
  });

  it('shows a city only where the player can see it', () => {
    const capture = open();
    capture.session.run('found 0');
    const withCity = capture.session.state;

    // Player 2 has explored nothing here, so city 0 is not theirs to look at: it is
    // not theirs, and it does not stand in what they have seen.
    const hidden: GameState = {
      ...withCity,
      explored: withCity.explored.map(() => new Array<boolean>(WIDTH * HEIGHT).fill(false)),
    };
    const blind = open({ state: hidden, playerIndex: 1 });
    blind.clear();
    expect(blind.session.run('city 0').kind).toBe('unknown-city');
    expect(blind.text()).toContain('error: unknown-city');
    expect(blind.text()).toContain('not one you can see');
    // Not a leak either way: the fogged city is absent from the view line too.
    expect(blind.text()).toContain('cities: none');

    // …but the god view is the debugging view, and shows everything.
    const god = open({ state: withCity, playerIndex: 1, god: true });
    god.clear();
    expect(god.session.run('city 0').kind).toBe('inspected');
    expect(god.text()).toContain('city 0 "City 1"');
    expect(god.session.state.cities).toHaveLength(1);

    // `cities` lists *your* cities — but it names another player's visible city
    // under the table rather than pretending it is not there.
    god.clear();
    god.session.run('cities');
    expect(god.text()).toContain('cities: 0 for Player 2 (p1)');
    expect(god.text()).toContain('not yours, but visible to you:  0 City 1 p0 @0,0');
  });
});

/* ------------------------------------------------------------------ *
 * Event rendering: one non-empty line per event, whatever the event is
 * ------------------------------------------------------------------ */

describe('event rendering', () => {
  it('prints a line for every event a turn emits, completion included', () => {
    const capture = open();
    capture.session.run('found 0');
    capture.session.run('build 0 unit:scout');
    capture.clear();

    const outcome = capture.session.run('end');
    const block = expectEveryEventRendered(outcome, capture.text());
    expect(appliedEvents(outcome).map((event) => event.type)).toEqual([
      'CityProduced',
      'TurnEnded',
    ]);
    expect(block[0]).toBe(
      'ok: city 0 "City 1" (Player 1 (p0) at 0,0) finished unit "Scout" (unit 2 at (0,0)); ' +
        '1 shields left',
    );
    expect(block[1]).toBe('ok: turn 2 begins; every unit refilled its movement');
  });

  it('prints a line for a starving city', () => {
    // A city whose centre is mountains still eats: 1 food floored at the centre
    // against 2 a citizen, so it loses the box and then a citizen. Hand-built
    // because the engine cannot found a city on mountains — and this is a
    // rendering test, not a founding one.
    const starving: GameState = {
      ...syntheticState(),
      nextCityId: 1,
      cities: [
        {
          id: asCityId(0),
          owner: asPlayerId(0),
          name: 'City 1',
          tile: tileIndex(WIDTH, 1, 0),
          population: 1,
          foodBox: 0,
          shields: 0,
          queue: [],
          buildings: [],
          workedTiles: [],
        },
      ],
    };

    const capture = open({ state: starving });
    capture.clear();
    const outcome = capture.session.run('end');
    const block = expectEveryEventRendered(outcome, capture.text());

    expect(appliedEvents(outcome).map((event) => event.type)).toEqual(['CityStarved', 'TurnEnded']);
    expect(block[0]).toContain('starved down to 1 citizen(s)');
    expect(block[0]).toContain('food box restarted at 0');
  });

  it('prints a real line for a hut entry, whichever of the three rewards it held', () => {
    const rewards = new Set<string>();

    for (let rngSeed = 0; rngSeed < 64 && rewards.size < 3; rngSeed += 1) {
      const capture = open({ state: hutState(rngSeed) });
      capture.clear();
      const outcome = capture.session.run('move 0 1 1');
      const block = expectEveryEventRendered(outcome, capture.text());

      const hut = appliedEvents(outcome).find((event) => event.type === 'HutEntered');
      if (hut === undefined) {
        throw new Error(
          `the move onto the hut emitted no HutEntered event (seed ${String(rngSeed)})`,
        );
      }
      rewards.add(hut.reward);

      // The move and the hut entry at least: a hut that pays nothing still printed
      // a line, which is exactly the case that used to print a blank one.
      expect(block.length).toBeGreaterThanOrEqual(2);
      expect(capture.text()).toContain('entered a goody hut at (1,1)');

      if (hut.reward === 'unit') {
        expect(block[1]).toContain('found a free unit');
        expect(block[1]).toContain('unit 2');
      }

      if (hut.reward === 'barbarians') {
        // The band is a second event, so it is a second line — and the line says
        // whose units they are and where they stand.
        expect(block).toHaveLength(3);
        expect(appliedEvents(outcome).map((event) => event.type)).toEqual([
          'UnitMoved',
          'HutEntered',
          'BarbariansSpawned',
        ]);
        expect(block[2]).toContain('2 barbarian unit(s) (2, 3)');
        expect(block[2]).toContain('owned by Barbarians');
        expect(capture.text()).toContain('barbarian unit(s)');
      }

      if (hut.reward === 'nothing') {
        expect(block[1]).toContain('found nothing (the hut is spent)');
      }
    }

    // All three branches reached, so no reward can fall through unrendered.
    expect([...rewards].sort()).toEqual(['barbarians', 'nothing', 'unit']);
  });

  it('never leaves an empty line where an event should be', () => {
    // The failure mode itself: a `switch` case that returns `undefined` prints a
    // blank line rather than failing. Sweeping every line of a session that founds,
    // builds, works, grows and enters a hut is a cheap way to say "none of them".
    const capture = open({ state: hutState(0) });
    const lines = [
      'move 0 1 1', // UnitMoved + HutEntered (+ BarbariansSpawned, for this seed)
      'found 0',
      'build 0 unit:scout',
      'work 0 2 0',
      'city 0',
      'cities',
      'end',
      'end',
    ];
    for (const line of lines) {
      // One command per assertion: the helper looks for the first `ok:` block in
      // the text, so accumulated output from earlier lines would be read as one.
      capture.clear();
      const outcome = capture.session.run(line);
      if (outcome.kind === 'applied' && outcome.outcome.events.length > 0) {
        expectEveryEventRendered(outcome, capture.text());
      }
      expect(capture.text()).not.toMatch(/\n\n {2}revision /);
    }
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
    for (const command of [
      'move',
      'found',
      'cities',
      'city',
      'work',
      'build',
      'end',
      'units',
      'state',
      'save',
      'help',
      'quit',
    ]) {
      expect(text).toContain(command);
    }
    expect(text).toContain('move <unitId> <x> <y>');
    expect(text).toContain('found <unitId>');
    expect(text).toContain('city <cityId>');
    expect(text).toContain('work <cityId> <x> <y> ...');
    expect(text).toContain('build <cityId> <item>');
    expect(text).toContain('unit:<id>');
    expect(text).toContain('building:<id>');
    expect(text).toContain('legal');

    // The summary line is what an unknown command prints, so it has to name them too.
    expect(COMMAND_SUMMARY).toContain('found <unitId>');
    expect(COMMAND_SUMMARY).toContain('work <cityId> <x> <y> ...');
    expect(COMMAND_SUMMARY).toContain('build <cityId> <unit|building>:<id>');
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
 * M4a: the worker surface — `work <unitId> <improvementId>`, `cancel <unitId>`
 *
 * The verbs are thin (`applyCommand` decides everything), so what is worth
 * pinning is the arrangement: one command built per line, every refusal the
 * engine's own typed reason, the job visible wherever a unit is visible, and an
 * `ok:` line for each of the three work events. The pinned `workerState`
 * transcript above is the whole-session fixture; these are the pieces.
 * ------------------------------------------------------------------ */

/** A session on the board with a worker, the way every test below wants it. */
const openWorker = (): Capture => open({ state: workerState() });

/** The worker's job, read out of the state — `undefined` when it has none. */
const jobOf = (capture: Capture, id = 2) =>
  capture.session.state.units.find((unit) => Number(unit.id) === id)?.work;

describe('the worker verbs', () => {
  it('builds the engine command rather than editing the state', () => {
    const capture = openWorker();

    const started = capture.session.run('work 2 mine');
    expect(started.kind).toBe('applied');
    expect(started.kind === 'applied' ? started.command : undefined).toEqual({
      type: 'StartWork',
      unitId: asUnitId(2),
      kind: asImprovementId('mine'),
    });

    // The engine wrote the job, not the REPL: the tile, the count and the unit are
    // the applier's, and `revision` moved exactly once.
    expect(jobOf(capture)).toEqual({
      kind: asImprovementId('mine'),
      tile: tileIndex(WIDTH, 2, 2),
      turnsLeft: 3,
    });
    expect(capture.session.state.revision).toBe(1);

    const cancelled = capture.session.run('cancel 2');
    expect(cancelled.kind).toBe('applied');
    expect(cancelled.kind === 'applied' ? cancelled.command : undefined).toEqual({
      type: 'CancelWork',
      unitId: asUnitId(2),
    });
    // An idle unit carries no `work` key at all — never one holding `undefined`,
    // which cannot survive a JSON round trip and would make the state unhashable.
    expect(jobOf(capture)).toBeUndefined();
    expect(Object.hasOwn(capture.session.state.units[2] ?? {}, 'work')).toBe(false);
    expect(capture.session.state.revision).toBe(2);
  });

  it('advances a job a turn at a time and finishes it on the turn it is owed', () => {
    const capture = openWorker();
    expect(capture.session.run('work 2 mine').kind).toBe('applied');

    // A mine takes three turns: two `end`s leave work in progress, the third
    // completes it — and completion is a `WorkCompleted` *event*, which is how a
    // consumer learns about it (there is no "job vanished" diff to read).
    capture.clear();
    const first = capture.session.run('end');
    expect(jobOf(capture)?.turnsLeft).toBe(2);
    expect(expectEveryEventRendered(first, capture.text())).toEqual([
      'ok: turn 2 begins; every unit refilled its movement',
    ]);

    capture.clear();
    capture.session.run('end');
    expect(jobOf(capture)?.turnsLeft).toBe(1);

    capture.clear();
    const finished = capture.session.run('end');
    expect(expectEveryEventRendered(finished, capture.text())).toEqual([
      'ok: unit 2 finished improvement "Mine" (3 turns) on (2,2); the tile is improved',
      'ok: turn 4 begins; every unit refilled its movement',
    ]);

    // The job is gone and the tile really is improved — the engine's own record,
    // not a REPL bookkeeping field.
    expect(jobOf(capture)).toBeUndefined();
    expect(capture.session.state.improvements).toEqual([
      { tile: tileIndex(WIDTH, 2, 2), kind: asImprovementId('mine') },
    ]);
  });

  it('cancels a job when the worker walks away from the tile', () => {
    const capture = openWorker();
    capture.session.run('work 2 mine');
    capture.session.run('end'); // refills movement, leaves two turns of work
    capture.clear();

    const moved = capture.session.run('move 2 1 1');

    // A step invalidates the job (M4a: work happens on a tile by a unit standing
    // there), and the *event* is how a reader learns it — not the absence of a job.
    expect(expectEveryEventRendered(moved, capture.text())).toEqual([
      'ok: unit 2 moved to (1,1), cost 1, 1 movement left',
      'ok: unit 2 stopped improvement "Mine" (3 turns) on (2,2) (the unit moved), 2 turns of work lost',
    ]);
    expect(jobOf(capture)).toBeUndefined();
    expect(capture.session.state.improvements).toEqual([]);
  });

  it('reports the engine’s typed reason for every way a job is refused', () => {
    const capture = openWorker();

    // A settler is not a worker, whatever it is standing on.
    expect(refusal(capture.session.run('work 0 mine')).kind).toBe('not-a-worker');
    // No such unit, and not yours.
    expect(refusal(capture.session.run('work 9 mine')).kind).toBe('unknown-unit');
    expect(refusal(capture.session.run('work 1 road')).kind).toBe('not-your-unit');
    // …and an improvement no catalog row defines.
    expect(refusal(capture.session.run('work 2 wibble')).kind).toBe('unknown-improvement');
    expect(capture.session.run('work 2 mine').kind).toBe('applied');
    expect(refusal(capture.session.run('work 2 road')).kind).toBe('already-working');
    expect(capture.session.run('end').kind).toBe('applied');
    expect(refusal(capture.session.run('work 2 road')).kind).toBe('already-working');
    expect(capture.session.run('end').kind).toBe('applied');
    expect(capture.session.run('end').kind).toBe('applied'); // the mine completes
    // Now it is idle again, and the tile carries a mine: building one twice is
    // refused rather than quietly ignored.
    expect(refusal(capture.session.run('work 2 mine')).kind).toBe('already-improved');
    // Nothing to cancel on an idle unit — a command aimed at a state that does not
    // exist, which the typed refusal is what tells a client about.
    expect(refusal(capture.session.run('cancel 2')).kind).toBe('not-working');
    expect(refusal(capture.session.run('cancel 0')).kind).toBe('not-working');
    expect(refusal(capture.session.run('cancel 9')).kind).toBe('unknown-unit');
    expect(refusal(capture.session.run('cancel 1')).kind).toBe('not-your-unit');

    // A worker with no movement left cannot start at all: the job spends whatever
    // the unit had, so the smallest amount that would have made it legal is 1.
    const tired: GameState = {
      ...workerState(),
      units: workerState().units.map((unit) =>
        Number(unit.id) === 2 ? { ...unit, movementLeft: 0 } : unit,
      ),
    };
    const idle = open({ state: tired });
    expect(refusal(idle.session.run('work 2 mine')).kind).toBe('not-enough-movement');
  });

  it('refuses an improvement the terrain does not allow, and says what would', () => {
    // Step the worker onto grassland at (1,1): a mine is not allowed there, and the
    // lesson under the refusal has to come from the catalog, not from a second
    // statement of the rule in this file.
    const worker = openWorker();
    expect(worker.session.run('move 2 1 1').kind).toBe('applied');
    worker.clear();

    const line = worker.session.run('work 2 mine');
    expect(refusal(line).kind).toBe('improvement-not-allowed');
    expect(worker.text()).toContain('cannot be built at (1,1)');
    expect(worker.text()).toContain('this terrain role allows: road, irrigation');
    // …and the same tile really does take an irrigation job, so the refusal was
    // about the improvement and not about the worker.
    expect(worker.session.run('work 2 irrigation').kind).toBe('applied');
  });

  it('tells `work <unitId> <improvementId>` apart from `work <cityId> <x> <y>`', () => {
    // A word after the id is an improvement id; numbers are coordinates. This is
    // the one ambiguous reading in the grammar, so both halves are pinned.
    const worded = openWorker();
    const start = worded.session.run('work 2 mine');
    expect(start.kind === 'applied' ? start.command.type : undefined).toBe('StartWork');

    const numbers = open();
    numbers.session.run('found 0');
    const assignment = numbers.session.run('work 0 1 1');
    expect(assignment.kind === 'applied' ? assignment.command.type : undefined).toBe(
      'SetWorkedTiles',
    );
    // …and a lone coordinate is still the *city* form's half-pair error, not a
    // silently accepted improvement id.
    const half = open();
    half.session.run('found 0');
    expect(half.session.run('work 0 1').kind).toBe('malformed');
    expect(half.text()).toContain('usage: work 0 <improvementId>');
  });

  it('shows the job in the units line, the units table and the state view', () => {
    const capture = openWorker();
    capture.clear();
    capture.session.run('work 2 mine');

    const text = capture.text();
    // The line under every view: position, movement *and* the job, so "what is my
    // worker doing?" needs no second command. Pinned whole, because the job has to
    // sit *after* the movement it spent rather than replacing it.
    const unitsLine = text.split('\n').find((line) => line.startsWith('units: ')) ?? '';
    expect(unitsLine).toBe(
      'units: *0 p0 Settler @0,0 (2/2 movement)   1 p1 Settler @0,1 (2/2 movement)  ' +
        '*2 p0 Worker @2,2 (0/2 movement) mining, 3 turns left',
    );
    // `describe`'s own line (see textview.test.ts): the agent's eyes on the map.
    expect(text).toContain('work: 2 p0 Worker@2,2 mining, 3 turns left');

    capture.clear();
    capture.session.run('units');
    expect(capture.text()).toContain('job');
    expect(capture.text()).toContain('mining, 3 turns left');
    expect(capture.text()).toContain(
      'Settler     Player 2     0,1       2/2      Grassland    (idle)',
    );

    capture.clear();
    capture.session.run('state');
    expect(capture.text()).toContain('jobs: 2 Worker@2,2 mining, 3 turns left');

    // An idle board says so, in the same place and in the same words.
    const idle = openWorker();
    idle.clear();
    idle.session.run('state');
    expect(idle.text()).toContain('jobs: none of your units is working');
  });

  it('names a working unit in the prose of a refusal about it', () => {
    const capture = openWorker();
    capture.session.run('work 2 mine');
    capture.clear();

    capture.session.run('work 2 road');

    // The label carries the job, because "why can this worker not start a job?" is
    // answered by the job it already has — and so does the per-unit units line.
    expect(capture.text()).toContain('mining, 3 turns left');
    capture.clear();
    capture.session.run('move 9 1 1');
    expect(capture.text()).toContain('2 Worker at 2,2 (0 movement left, mining, 3 turns left)');
  });

  it('renders every work event as a real line, never a blank one', () => {
    // The regression this file exists to keep, at the level of the whole session:
    // an event member with no `case` joins into the `ok:` block as an *empty* line,
    // which reads like a formatting choice rather than a missing renderer. Every
    // block in the M4a transcript must be `ok: ` lines and nothing else.
    const capture = openWorker();
    runScript(capture.session, WORKER_SCRIPT.join('\n'), capture.write);

    expectNoBlankEventLines(capture.text());
    // …and the three M4a members are in there, each on its own line.
    expect(capture.text()).toContain('ok: unit 2 started improvement "Mine" (3 turns)');
    expect(capture.text()).toContain('ok: unit 2 stopped improvement "Mine" (3 turns)');
    expect(capture.text()).toContain('ok: unit 2 finished improvement "Road" (2 turns)');

    // The same sweep over the sessions that reach the *other* event members: a
    // blank line is a property of a block, and this is the widest net for it.
    const plain = open();
    runScript(plain.session, SCRIPT.join('\n'), plain.write);
    expectNoBlankEventLines(plain.text());
    const hut = open({ state: hutState(3) });
    runScript(hut.session, ['move 0 1 1', 'units', 'end', 'quit'].join('\n'), hut.write);
    expectNoBlankEventLines(hut.text());
  });

  it('is byte-identical across two runs of the same worker script', () => {
    const first = openWorker();
    runScript(first.session, WORKER_SCRIPT.join('\n'), first.write);
    const second = openWorker();
    runScript(second.session, WORKER_SCRIPT.join('\n'), second.write);

    // The same guarantee the main transcript makes, for the session that actually
    // exercises the work events: two fresh sessions, one transcript, byte for byte.
    expect(first.text()).toBe(second.text());
    expect(first.text()).toBe(`${EXPECTED_WORKER_TRANSCRIPT}\n`);
    expect(hashValue(first.session.state)).toBe('9dac80e9663b8231');
  });

  it('documents the worker verbs in help and in the command summary', () => {
    const capture = open();
    capture.clear();
    capture.session.run('help');

    expect(capture.text()).toContain('work <unitId> <improvementId>');
    expect(capture.text()).toContain('cancel <unitId>');
    expect(capture.text()).toContain('work <cityId> <x> <y> ...');
    expect(COMMAND_SUMMARY).toContain('work <unitId> <improvementId>');
    expect(COMMAND_SUMMARY).toContain('cancel <unitId>');
  });
});

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
    // CORRECTED (M3 civ-count fix). `--civs 2` starts a game with two
    // civilizations *plus* the barbarian player `newGame` appends, so a count over
    // `state.players` would print "3 civs". It did: this line used to record that
    // as observed output, with a note that the defect lived outside the migration's
    // file list. `bannerText` and `describe`'s header now both ask `civPlayers`
    // (docs/INTERFACES.md M3, "State shape": anything that means "how many
    // civilizations" must use `civPlayers`, never `players.length`), so the honest
    // assertion is 2. The `civs=` field of the `CivTS state:` line below it moved
    // with it.
    expect(run.stdout).toContain('CivTS play - seed 42, duel map 40x40, 2 civs');
    expect(run.stdout).toContain('you are Player 1 (p0)');
    expect(run.stdout).toContain('CivTS state: seed=42 turn=1 revision=0');
    // One start marker per **civilization**, and never one for the barbarians —
    // the same reading as the `civs=` count above, for the same reason. Barbarians
    // are a player (M3, "State shape"), but their `startingTile` is a convention
    // pointing at the map's first goody hut, not a homeland, so `starts:` (the
    // legend for the digits drawn on the map) is keyed to `civPlayers` and this
    // world's barbarian player is neither named nor drawn. The assertion is
    // unchanged — `--civs 2` names exactly two starts — but the reading it records
    // is the corrected one; the old note here claimed the barbarian's hut was
    // presented as a third start, which is exactly what the ruling forbids.
    expect(run.stdout).toContain('starts: 0=Player 1@');
    expect(run.stdout).not.toContain('Barbarians@');
    expect(run.stdout).not.toContain('civs=3');
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

  it('founds a city, works it, builds in it and ends turns — byte-identically in two fresh processes', () => {
    // M3's acceptance line, verbatim: "the REPL can found a city and show it".
    // The script is derived from the engine's own state (the settler's id and tile,
    // a tile inside the new city's radius), never from coordinates typed in by
    // hand, so it stays a session on *this* world rather than on a remembered one.
    const setup = newGame(
      42,
      { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2, seed: 42 },
      RULESET,
    );
    if (!setup.ok) throw new Error(`newGame failed: ${setup.error.kind}`);

    const state = setup.value;
    const settler = state.units.find((unit) => unit.owner === asPlayerId(0));
    if (settler === undefined) throw new Error('player 0 has no settler');
    const home = settler.tile;
    const work = cityRadius(state, home).find((tile) => Number(tile) !== Number(home));
    if (work === undefined) throw new Error('the start tile has no neighbouring radius tile');

    const lines = [
      'units',
      `found ${String(settler.id)}`,
      'cities',
      'city 0',
      `work 0 ${String(indexToX(state.map, work))} ${String(indexToY(state.map, work))}`,
      'build 0 unit:warrior',
      'city 0',
      'end',
      'end',
      'end',
      'city 0',
      'cities',
      'state',
      'quit',
    ];

    const dir = mkdtempSync(join(tmpdir(), 'civts-repl-city-'));
    try {
      const script = join(dir, 'session.txt');
      writeFileSync(script, `${lines.join('\n')}\n`, 'utf8');
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
      expect(first.stderr).not.toContain('fatal');
      // The fixture assertion, kept exactly as it was: two fresh node processes,
      // one transcript, byte for byte — not a substring match, not a hash of the
      // interesting parts.
      expect(first.stdout).toBe(second.stdout);

      // The city really was founded, worked, given something to build and grown —
      // and each of those steps is visible in the transcript.
      expect(first.stdout).toContain(
        `ok: City 1 founded at (${String(indexToX(state.map, home))},${String(indexToY(state.map, home))})`,
      );
      expect(first.stdout).toContain('units: none visible'); // the settler was consumed
      expect(first.stdout).toContain('cities: 1 for Player 1 (p0)');
      expect(first.stdout).toContain('id  name');
      expect(first.stdout).toContain(
        `now works (${String(indexToX(state.map, work))},${String(indexToY(state.map, work))})`,
      );
      expect(first.stdout).toContain('production set to unit "Warrior" (cost 1 shield)');
      expect(first.stdout).toContain('population 1; food box');
      expect(first.stdout).toContain('works 1 of 1 citizen(s)');
      expect(first.stdout).toContain('ok: turn 2 begins');
      expect(first.stdout).toContain('p0> quit');
      expect(first.stdout).toContain('bye');

      // The quiet failure mode, at the level of the whole transcript: an event the
      // renderer does not handle used to join into a *blank* line, which shows up
      // here as an `ok:` block with an empty line in it.
      expect(first.stdout).not.toMatch(/\n\n {2}revision /);
      expect(first.stdout).not.toMatch(/\nok: \n/);
      expect(first.stdout).not.toMatch(/undefined|NaN/);

      // …and the same session, run in this process against the same engine, prints
      // the same transcript and reaches the hash the CLI printed.
      const chunks: string[] = [];
      const session = createSession({
        state,
        ruleset: RULESET,
        playerId: asPlayerId(0),
        god: false,
        write: (text: string) => {
          chunks.push(text);
        },
      });
      const code = runScript(session, `${lines.join('\n')}\n`, (text: string) => {
        chunks.push(text);
      });
      expect(code).toBe(0);
      expect(chunks.join('')).toBe(first.stdout);
      expect(first.stdout).toContain(`hash: ${hashValue(session.state)}`);
      // The literal pin, in the spirit of the transcript fixture above: this exact
      // script on this exact world ends on this exact state. A change to the city
      // rules, the turn pipeline or the generator moves it, and moving it has to be
      // deliberate — `hashValue(session.state)` alone would only prove the CLI and
      // this process agreed, not that either still plays the same game.
      //
      // Rehashed for M4a (SCHEMA_VERSION 3 -> 4), deliberately: every state now
      // carries `improvements`, so 3d72c9af7146e389 -> d7caab78d25b1473. The
      // transcript this pin belongs to did not otherwise move.
      expect(first.stdout).toContain('hash: d7caab78d25b1473');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('puts a worker on a job, shows it and cancels it, through the real CLI', () => {
    // The M4a surface end to end, on a generated world: the city produces a worker,
    // the worker starts a road, the `units:` line and the `state` view both say what
    // it is doing, and `cancel` gives the job up. The script is derived from the
    // engine's own state (the produced unit's id, the city's tile), never from
    // numbers typed in by hand, so it stays a session on *this* world.
    const setup = newGame(
      42,
      { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2, seed: 42 },
      RULESET,
    );
    if (!setup.ok) throw new Error(`newGame failed: ${setup.error.kind}`);

    const state = setup.value;
    const settler = state.units.find((unit) => unit.owner === asPlayerId(0));
    if (settler === undefined) throw new Error('player 0 has no settler');

    // Ids are dense and monotonic (M2): the worker the city produces takes the id
    // `newGame` left in `nextUnitId`, and nothing else is created on this board.
    const workerId = String(state.nextUnitId);
    const at = `(${String(indexToX(state.map, settler.tile))},${String(indexToY(state.map, settler.tile))})`;

    const lines = [
      `found ${String(settler.id)}`,
      'build 0 unit:worker',
      'end',
      'end',
      'end',
      'units',
      `work ${workerId} road`,
      'state',
      'end',
      `cancel ${workerId}`,
      'units',
      'quit',
    ];

    const dir = mkdtempSync(join(tmpdir(), 'civts-repl-worker-'));
    try {
      const script = join(dir, 'session.txt');
      writeFileSync(script, `${lines.join('\n')}\n`, 'utf8');
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
      expect(first.stderr).not.toContain('fatal');
      expect(first.stdout).toBe(second.stdout); // two fresh processes, one transcript

      expect(first.stdout).toContain('ok: city 0 "City 1"');
      expect(first.stdout).toContain(
        `ok: unit ${workerId} started improvement "Road" (2 turns) on ${at}`,
      );
      // The job is visible in both of the places a reader looks: the one-line
      // summary under every view, and the `state` view's own `jobs:` line.
      expect(first.stdout).toContain(
        `units: *${workerId} p0 Worker @${at.slice(1, -1)} (0/2 movement) building a road, 2 turns left`,
      );
      expect(first.stdout).toContain(
        `jobs: ${workerId} Worker@${at.slice(1, -1)} building a road, 2 turns left`,
      );
      expect(first.stdout).toContain(
        `ok: unit ${workerId} stopped improvement "Road" (2 turns) on ${at}`,
      );
      expect(first.stdout).toContain('building a road, 1 turn left'); // after one `end`

      // The whole-transcript form of the blank-line regression, over a real CLI run.
      expectNoBlankEventLines(first.stdout);
      expect(first.stdout).not.toMatch(/undefined|NaN/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

/** The first line: `ruleset provenance — 0/16 cited (0%), 16 placeholder`. */
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
  it('lists every row its totals count — terrain, unit, building and improvement alike', () => {
    const run = runCli(['provenance'], '');

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('ruleset error');

    const printed = parseProvenance(run.stdout);

    // The header's own arithmetic, and the report is not empty.
    expect(printed.cited + printed.placeholder).toBe(printed.total);
    expect(printed.total).toBeGreaterThan(0);

    // The rows printed are exactly the rows of the catalog — every catalog, in
    // catalog order. While only the terrain table was rendered, this listed six
    // rows under a total of eleven: a report that overstated its own coverage.
    // M3 added a third catalog (buildings), which the same claim now covers: the
    // report is the honesty surface for the M3 numbers, so a section it forgot
    // would be exactly the kind of unstated guess the rule exists to prevent.
    // M4a added the fourth catalog (improvements), and the claim covers it the same
    // way: every row the totals count is a row this test read out of the catalog
    // itself, so a section the report forgot — or invented — fails here.
    const rows = printedRows(printed);
    expect(rows.map((row) => row.id)).toEqual([
      ...CATALOG.terrains.map((t) => t.id),
      ...CATALOG.units.map((u) => u.id),
      ...CATALOG.buildings.map((b) => b.id),
      ...CATALOG.improvements.map((i) => i.id),
    ]);

    // …which is what makes the table and the totals agree.
    expect(rows.length).toBe(printed.total);
    expect(rows.filter((row) => row.kind === 'placeholder').length).toBe(printed.placeholder);
    expect(rows.filter((row) => row.kind === 'cited').length).toBe(printed.cited);
  });

  it('states each section in its own heading, and adds those up to the total', () => {
    const stdout = runCli(['provenance'], '').stdout;
    const printed = parseProvenance(stdout);

    expect(printed.sections.map((section) => section.name)).toEqual([
      'terrains',
      'units',
      'buildings',
      'improvements',
    ]);

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

    // The same holds for M3's building rows: every one of them is a
    // `placeholder` whose printed detail is the catalog's own note, which is
    // where the "unsourced, chosen to be playable" claim is written down.
    const buildings = printed.sections.find((section) => section.name === 'buildings');
    expect(buildings?.rows.map((row) => row.id)).toEqual(CATALOG.buildings.map((b) => b.id));
    for (const [index, spec] of CATALOG.buildings.entries()) {
      expect(spec.provenance.kind).toBe('placeholder');
      if (spec.provenance.kind === 'placeholder') {
        expect(buildings?.rows[index]?.detail).toBe(spec.provenance.note);
      }
    }

    // …and for M4a's improvement rows, which is where "unsourced, chosen to be
    // playable" has to be readable for the mine/road/irrigation numbers: no row of
    // this catalog claims Civ 3 accuracy, and the report is where that is said.
    const improvements = printed.sections.find((section) => section.name === 'improvements');
    expect(improvements?.rows.map((row) => row.id)).toEqual(CATALOG.improvements.map((i) => i.id));
    for (const [index, spec] of CATALOG.improvements.entries()) {
      expect(spec.provenance.kind).toBe('placeholder');
      if (spec.provenance.kind === 'placeholder') {
        expect(improvements?.rows[index]?.detail).toBe(spec.provenance.note);
        expect(spec.provenance.note).toContain('unsourced');
      }
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
