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
 * - **M4b: `rates`, and an economy the reader cannot miss.** `rates <tax> <science>
 *   <luxury>` builds one `SetRates`; a bad triple is refused by the engine's own
 *   `ratesProblem`, and the lesson under it names legal triples that `planSetRates`
 *   accepted before they were printed. Gold, the three rates and the two inert
 *   pools are then shown in the banner, under every view and in `state`, and every
 *   one of the four money events has its own pinned line — including which units
 *   bankruptcy disbanded and why.
 * - **M6: `attack` and `fortify` are the same arrangement a fourth time.** `attack
 *   <unitId> <x> <y>` builds one `AttackUnit` — a battle against one adjacent enemy
 *   unit, or an outright capture of an undefended adjacent city — and `fortify
 *   <unitId>` builds one `FortifyUnit`, which is the one applied command in the whole
 *   language that emits no event. A unit's hit points are shown **wherever a unit is
 *   shown** (the `units` table's `hp` column, the `units:` line under every view, and
 *   the prose of a refusal about it), the city view states what its tile and walls are
 *   worth to a defender, and the four new events each have a pinned line — including
 *   *why* a unit was destroyed and who killed it.
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
  RATE_TOTAL,
  SCHEMA_VERSION,
  asBuildingId,
  asCityId,
  asImprovementId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTerrainId,
  asUnitId,
  asUnitTypeId,
  cityById,
  cityRadius,
  foodBoxSize,
  hitPointsLabel,
  indexToX,
  indexToY,
  newGame,
  playerIncome,
  playerUpkeep,
  seedRng,
  tileIndex,
  unitDef,
  unitSupport,
  type BuildingDef,
  type BuildingId,
  type City,
  type GameError,
  type GameEvent,
  type GameState,
  type ImprovementDef,
  type PlayerState,
  type Rates,
  type RulesetView,
  type TechId,
  type TerrainId,
  type TileIndex,
  type Unit,
  type UnitDef,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { FULL_TIER, canonicalize, hashValue } from '@civts/testing';
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
 *
 * Migrated again for **M4c**, which made `GameMap.resources` a required field: the
 * board carries `resources: []`. That is a migration and not a relaxation — the
 * field is required, so a fixture that omitted it would only typecheck through a
 * cast, which is exactly what this file refuses to do — and it is deliberately the
 * *empty* list, so every landmark this file pins (the transcript, the hashes, the
 * city view) stays a picture of a board with no resource on it. The resource
 * surface has its own board below, where a resource is the point.
 */
const syntheticState = (): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed: 7 },
  rng: seedRng(7),
  map: { width: WIDTH, height: HEIGHT, terrain: terrainIds(), huts: [], resources: [] },
  players: [
    {
      id: asPlayerId(0),
      name: 'Player 1',
      color: '#d12f2f',
      startingTile: tileIndex(WIDTH, 0, 0),
      kind: 'civ',
      // M5: every `PlayerState` carries `techs`, and an empty *list* is what "knows
      // nothing" is. `researching` is deliberately absent rather than present-and-
      // `undefined`: absence is what "researching nothing" means, and a key holding
      // `undefined` cannot survive a JSON round trip, so it would make the state
      // unhashable (`tech.ts` states the rule where it writes the field).
      techs: [],
      // M4b: every `PlayerState` carries the money fields. These are the values
      // `newGame` starts a civilization with (`state.ts` calls them placeholders,
      // which is what they are: nothing here is claimed to be a Civ 3 number).
      // 10 gold is deliberately enough to matter and small enough to be spent.
      treasury: 10,
      rates: { tax: 6, science: 4, luxury: 0 },
      beakers: 0,
      luxuries: 0,
    },
    {
      id: asPlayerId(1),
      name: 'Player 2',
      color: '#2f6fd1',
      startingTile: tileIndex(WIDTH, 0, 1),
      kind: 'civ',
      techs: [],
      treasury: 10,
      rates: { tax: 6, science: 4, luxury: 0 },
      beakers: 0,
      luxuries: 0,
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
 * Player 0's rates, straight out of the engine's state — the same field `SetRates`
 * writes and the money loop reads, never a copy the REPL kept. `undefined` only for
 * a state with no player 0 at all, which no fixture here builds.
 */
const ratesOf = (capture: Capture): Rates | undefined => capture.session.state.players[0]?.rates;

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
 * The money loop's two lines for one player, verbatim.
 *
 * Every `end` since M4b emits `IncomeCollected` + `UpkeepPaid` for *each*
 * civilization before `TurnEnded` (INTERFACES.md M4b, "The money loop"), so a test
 * about the work verbs that pinned the whole `ok:` block has to include them — the
 * block is exactly what `expectEveryEventRendered` counts, and a money line the
 * renderer dropped would show up as a wrong length right here.
 *
 * Built from the numbers rather than restated, because this helper is used by tests
 * about *jobs*: the prose is pinned character-for-character where it belongs, in
 * the `event rendering` suite, which asserts the full six-line block of a turn.
 * The parameters are the ones that actually vary between these fixtures — the
 * player, its unit count and its free allowance (`FREE_UNITS_PER_CITY * cities +
 * FREE_UNITS_BASE`, which is 4 with no cities).
 */
const moneyLines = (label: string, units: number, free: number, gold = 0): readonly string[] => [
  `ok: ${label} collected ${String(gold)} gold, 0 beakers and 0 luxuries from its cities at ` +
    'its rates - beakers now buy tech: they are banked toward the tech you selected and spent ' +
    'on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the ' +
    'tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  `ok: ${label} paid 0 gold of upkeep (0 building maintenance + 0 unit support for ` +
    `${String(units)} unit(s), ${String(free)} of them free)`,
];

/** Both civilizations' money lines, in the pipeline's player-id order. */
const bothMoneyLines = (): readonly string[] => [
  ...moneyLines('Player 1 (p0)', 2, 4),
  ...moneyLines('Player 2 (p1)', 1, 4),
];

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
        // M5: barbarians carry `techs` too, inert — the same "one shape for every
        // player" rule the money fields follow. `applyResearch` skips anything that
        // is not a civilization, so this list can never grow.
        techs: [],
        // M4b: one shape for every player, barbarians included — `PlayerId` is an
        // index into `players` and `state.ts` gives them the same money fields a
        // civilization has, inert. `applyEconomy` skips anything that is not a
        // civilization, so these are never collected or charged.
        treasury: 10,
        rates: { tax: 6, science: 4, luxury: 0 },
        beakers: 0,
        luxuries: 0,
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
 * M4b fixtures: a board that goes bankrupt, and a ruleset that can bill
 * ------------------------------------------------------------------ */

/**
 * A building row that bills a **large** maintenance: four gold a turn, where the
 * dearest shipped row (the factory) charges three.
 *
 * M4b needed this row because no shipped building declared `maintenance` at all —
 * `BuildingDef` carried a shield `cost` and nothing else, and `economy.ts` read a
 * structurally-declared field so the money loop could be tested at all. **M4c made
 * the field required and shipped rows that really bill** (the barracks charges 1,
 * the factory 3), so this is no longer a stand-in for a missing field and the
 * doc comment that said so is gone with it.
 *
 * It is kept for the fixture's *arithmetic*: `bankruptState` below needs a bill a
 * three-commerce city cannot come close to paying, so that two disbanded units
 * still leave a `TreasuryShortfall` in the same turn — and no shipped row costs
 * enough to do that. The row is an ordinary `BuildingDef` (the engine's own shape,
 * not a widened test-only one), with `effects: []` — legal, and the honest reading
 * for a row that exists to be a bill — and `cost`, `maintenance` and `name` are
 * placeholder numbers of this test's, not Civ 3's.
 */
const TOLL_HOUSE: readonly BuildingDef[] = [
  {
    id: asBuildingId('toll-house'),
    name: 'Toll House',
    cost: 10,
    maintenance: 4,
    effects: [],
  },
];

/** The shipped ruleset plus a building that actually bills its owner. */
const BILLING_RULESET: RulesetView = { ...RULESET, buildings: TOLL_HOUSE };

/**
 * A board player 0 cannot pay for, built so that **all four money events** happen
 * in one turn:
 *
 * - the city's commerce is split at rates with a science *and* a luxury share, so
 *   the `IncomeCollected` line has non-zero beakers and luxuries to report (the
 *   whole point of the inertness warning: they are banked and do nothing);
 * - a Toll House bills 4 gold, so upkeep exceeds the city's income;
 * - eight units against an allowance of `FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE`
 *   = 6 leaves 2 billable, so there is something to disband — and the shortfall
 *   that survives both removals is `maintenance - income`, which is what makes
 *   `TreasuryShortfall` reachable at all. With the shipped catalog it is *not*:
 *   maintenance is 0, income is never negative and the treasury never goes below
 *   zero, so the unpaid remainder can only be <= 0. That is why this fixture needs
 *   `BILLING_RULESET`, and it is said here rather than left as a puzzle.
 *
 * The city is at population 3 working two grassland tiles: food `2 + 2 + 2 = 6`
 * against `2 * 3 = 6` eaten, so the turn neither grows nor starves and the
 * commerce the money loop splits is exactly the assignment below. Everything is
 * hand-built because no legal sequence of commands produces a broke player with a
 * paid-up building in one turn, and this is a rendering test.
 */
const bankruptState = (): GameState => {
  const base = syntheticState();
  const army: readonly Unit[] = Array.from({ length: 7 }, (_, index) => ({
    id: asUnitId(index + 2),
    type: asUnitTypeId('warrior'),
    owner: asPlayerId(0),
    tile: tileIndex(WIDTH, 3, 3),
    movementLeft: 1,
  }));

  return {
    ...base,
    nextUnitId: 9,
    players: base.players.map((player) =>
      player.id === asPlayerId(0)
        ? {
            ...player,
            // Broke on purpose, and a rates triple that sends something to every
            // channel: 2/4/4 is a legal split of `RATE_TOTAL` (10).
            treasury: 0,
            rates: { tax: 2, science: 4, luxury: 4 },
            beakers: 0,
            luxuries: 0,
          }
        : player,
    ),
    nextCityId: 1,
    cities: [
      {
        id: asCityId(0),
        owner: asPlayerId(0),
        name: 'City 1',
        tile: tileIndex(WIDTH, 0, 0),
        population: 3,
        foodBox: 0,
        shields: 0,
        queue: [],
        buildings: [asBuildingId('toll-house')],
        workedTiles: [tileIndex(WIDTH, 0, 1), tileIndex(WIDTH, 1, 1)],
      },
    ],
    // The settler and settler-plus-army: eight units for player 0, one for player 1.
    units: [...base.units, ...army],
  };
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
 *
 * Regenerated a second time for M4b, and — unlike the M3 and M4a rehashes — the
 * text really did move. Three things are visible in it, and each is the milestone's
 * UI half rather than an accident: the banner states the economy before the first
 * command, every view carries an `economy:` line after its `cities:` line (the money
 * loop changes something on every turn, so a figure the agent has to ask for is a
 * figure it notices only too late), and every `end` prints the money loop's two
 * lines per civilization *before* `TurnEnded` — the pipeline's new step 4. The
 * inertness sentence travels with both, because a "2 beakers" with no caveat would
 * imply a research system this build does not have.
 *
 * **M4c re-pinned nothing here, and that is the finding rather than an omission.**
 * The map gained `resources`, `schemaVersion` went 5 -> 6 (so every hash moved —
 * see the pin in the test that reads this fixture), and the city view gained two
 * lines — but this board carries `resources: []`, the script never inspects a city,
 * and no existing view line prints the schema version. The transcript is therefore
 * byte-for-byte what M4b pinned, which is exactly what "a legend entry appears only
 * when the glyph was drawn" is supposed to buy. What M4c *did* have to re-pin is the
 * state-hash arithmetic elsewhere in this file (four pins on the synthetic board,
 * plus the CLI's own) and the worker transcript's one `state` line.
 */
const EXPECTED_TRANSCRIPT = [
  'CivTS play - seed 7, tiny map 4x4, 2 civs',
  'you are Player 1 (p0); every view below is drawn from your fog of war',
  'economy: 10 gold, 0 beakers, 0 luxuries, rates tax 6 / science 4 / luxury 0 (sum 10 of 10), 0 cities',
  '  beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree).',
  '  luxuries DO NOTHING yet: nothing reads them until M9 (happiness).',
  '  "rates <tax> <science> <luxury>" moves the sliders (they must sum to 10); gold pays upkeep, and a treasury that cannot pay disbands units.',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'commands: move <unitId> <x> <y> | attack <unitId> <x> <y> | fortify <unitId> | found <unitId> | cities | city <cityId> | work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | work <unitId> <improvementId> | cancel <unitId> | rates <tax> <science> <luxury> | research <techId> | tech | end | units | state | save <path> | help | quit',
  '',
  'CivTS state: seed=7 turn=1 revision=0 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> units',
  'units: 2 of 2 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     hp      terrain      job                         legal',
  '*  0   Settler     Player 1     0,0       2/2      1/1 hp  Grassland    (idle)                      1',
  '   1   Settler     Player 2     0,1       2/2      1/1 hp  Grassland    (idle)                      3',
  'CivTS state: seed=7 turn=1 revision=0 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> move 0 1 1',
  'ok: unit 0 moved to (1,1), cost 1, 1 movement left',
  '  revision 1',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> move 0 2 2',
  'error: not-enough-movement - unit 0 (Settler at 1,1, 1/2 per turn movement left, 1/1 hp) needs 2 movement for the step onto that tile, but only 1 is left. "end" refills movement.',
  '  legal: unit 0 (Settler at 1,1, 1/2 per turn movement left, 1/1 hp) can move to (0,0) (2,0) (2,1) (0,2) (1,2).',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> move 0 9 9',
  'error: malformed command - (9,9) is outside the map (4x4): x must be 0..3 and y must be 0..3.',
  '  the ruler above the map lists the valid columns and rows',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> wibble',
  'error: unknown command "wibble" - no such command.',
  '  commands: move <unitId> <x> <y> | attack <unitId> <x> <y> | fortify <unitId> | found <unitId> | cities | city <cityId> | work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | work <unitId> <improvementId> | cancel <unitId> | rates <tax> <science> <luxury> | research <techId> | tech | end | units | state | save <path> | help | quit',
  '  type "help" for what each one does.',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (1/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> end',
  'ok: Player 1 (p0) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 1 (p0) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 1 unit(s), 4 of them free)',
  'ok: Player 2 (p1) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 2 (p1) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 1 unit(s), 4 of them free)',
  'ok: turn 2 begins; every unit refilled its movement',
  '  revision 2',
  'CivTS state: seed=7 turn=2 revision=2 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @1,1 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
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

/**
 * The same pinned session for the worker verbs (M4a), re-pinned for M4c in exactly
 * two places, both of them facts about the *state shape* rather than about the
 * rendering: the `state` view prints `schema=6` (was 5) and that view's `hash:` line
 * moved because the map gained `resources` (`GameMap.resources` is inside the hashed
 * state — see `state.ts`'s SCHEMA_VERSION 6 note). `0511ae245fa10624` ->
 * `4815cda1972f9fd4`.
 *
 * Nothing else in it moved: no line of the picture, no `units` table cell, no city
 * line — this board carries `resources: []`, and a resource-free view stays
 * byte-identical by construction.
 */
const EXPECTED_WORKER_TRANSCRIPT = [
  'CivTS play - seed 7, tiny map 4x4, 2 civs',
  'you are Player 1 (p0); every view below is drawn from your fog of war',
  'economy: 10 gold, 0 beakers, 0 luxuries, rates tax 6 / science 4 / luxury 0 (sum 10 of 10), 0 cities',
  '  beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree).',
  '  luxuries DO NOTHING yet: nothing reads them until M9 (happiness).',
  '  "rates <tax> <science> <luxury>" moves the sliders (they must sum to 10); gold pays upkeep, and a treasury that cannot pay disbands units.',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'commands: move <unitId> <x> <y> | attack <unitId> <x> <y> | fortify <unitId> | found <unitId> | cities | city <cityId> | work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | work <unitId> <improvementId> | cancel <unitId> | rates <tax> <science> <luxury> | research <techId> | tech | end | units | state | save <path> | help | quit',
  '',
  'CivTS state: seed=7 turn=1 revision=0 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> units',
  'units: 3 of 3 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     hp      terrain      job                         legal',
  '*  0   Settler     Player 1     0,0       2/2      1/1 hp  Grassland    (idle)                      1',
  '   1   Settler     Player 2     0,1       2/2      1/1 hp  Grassland    (idle)                      3',
  '*  2   Worker      Player 1     2,2       2/2      1/1 hp  Hills        (idle)                      8',
  'CivTS state: seed=7 turn=1 revision=0 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> work 2 mine',
  'ok: unit 2 started improvement "Mine" (3 turns) on (2,2): 3 turns left',
  '  revision 1',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 1/1 hp mining, 3 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (0/2 movement, 1/1 hp) mining, 3 turns left',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> state',
  'state: seed=7 turn=1 revision=1 schema=8 map=tiny(4x4) civs=2',
  'economy: 10 gold, rates tax 6 / science 4 / luxury 0 (sum 10 of 10), 0 beakers, 0 luxuries',
  '  beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree).',
  '  luxuries DO NOTHING yet: nothing reads them until M9 (happiness): they only pile up, and this build neither spends nor reads them.',
  '  gold pays upkeep, and a treasury that cannot pay is paid for by disbanding units',
  '  (highest id first) rather than by going negative.',
  'economy: at these rates this state collects 0 gold, 0 beakers and 0 luxuries a turn',
  '  from 0 cities, and owes 0 gold of upkeep (0 maintenance + 0 unit support for 2 unit(s), 4 free)',
  '  - a projection from this state, because growth and production run before the bill is drawn.',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'tech: 0/19 known (none yet)',
  'tech: 3 researchable now, 16 blocked; "tech" prints the tree with costs and prerequisites',
  'you: 2 unit(s), explored 16/16 tiles, 16 visible right now',
  'jobs: 2 Worker@2,2 mining, 3 turns left',
  'civs: Player 1 (p0) <- you, Player 2 (p1)',
  'rng: a=-456573687 b=-84222363 c=801465066 d=1648156487',
  'hash: 07fda6ec366add66',
  'CivTS state: seed=7 turn=1 revision=1 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 1/1 hp mining, 3 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (0/2 movement, 1/1 hp) mining, 3 turns left',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> end',
  'ok: Player 1 (p0) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 1 (p0) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 2 unit(s), 4 of them free)',
  'ok: Player 2 (p1) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 2 (p1) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 1 unit(s), 4 of them free)',
  'ok: turn 2 begins; every unit refilled its movement',
  '  revision 2',
  'CivTS state: seed=7 turn=2 revision=2 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 1/1 hp mining, 2 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp) mining, 2 turns left',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> cancel 2',
  'ok: unit 2 stopped improvement "Mine" (3 turns) on (2,2) (cancelled), 2 turns of work lost',
  '  revision 3',
  'CivTS state: seed=7 turn=2 revision=3 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> work 2 road',
  'ok: unit 2 started improvement "Road" (2 turns) on (2,2): 2 turns left',
  '  revision 4',
  'CivTS state: seed=7 turn=2 revision=4 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 1/1 hp building a road, 2 turns left',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (0/2 movement, 1/1 hp) building a road, 2 turns left',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> end',
  'ok: Player 1 (p0) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 1 (p0) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 2 unit(s), 4 of them free)',
  'ok: Player 2 (p1) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 2 (p1) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 1 unit(s), 4 of them free)',
  'ok: turn 3 begins; every unit refilled its movement',
  '  revision 5',
  'CivTS state: seed=7 turn=3 revision=5 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'work: 2 p0 Worker@2,2 1/1 hp building a road, 1 turn left',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp) building a road, 1 turn left',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> end',
  'ok: unit 2 finished improvement "Road" (2 turns) on (2,2); the tile is improved',
  'ok: Player 1 (p0) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 1 (p0) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 2 unit(s), 4 of them free)',
  'ok: Player 2 (p1) collected 0 gold, 0 beakers and 0 luxuries from its cities at its rates - beakers now buy tech: they are banked toward the tech you selected and spent on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  'ok: Player 2 (p1) paid 0 gold of upkeep (0 building maintenance + 0 unit support for 1 unit(s), 4 of them free)',
  'ok: turn 4 begins; every unit refilled its movement',
  '  revision 6',
  'CivTS state: seed=7 turn=4 revision=6 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
  'p0> units',
  'units: 3 of 3 visible for Player 1 (p0)',
  'm  id  type        owner        at        move     hp      terrain      job                         legal',
  '*  0   Settler     Player 1     0,0       2/2      1/1 hp  Grassland    (idle)                      1',
  '   1   Settler     Player 2     0,1       2/2      1/1 hp  Grassland    (idle)                      3',
  '*  2   Worker      Player 1     2,2       2/2      1/1 hp  Hills        (idle)                      8',
  'CivTS state: seed=7 turn=4 revision=6 map=tiny(4x4) civs=2 viewer=0 gold=10 research=idle banked=0',
  'view: x 0..3, y 0..3 (4x4 of 4x4)',
  '  |0',
  '  |0123',
  '0 |0^,,',
  '1 |1,,,',
  '2 |,,h,',
  '3 |,,,,',
  'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains',
  'starts: 0=Player 1@0,0  1=Player 2@0,1',
  'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  *2 p0 Worker @2,2 (2/2 movement, 1/1 hp)',
  'cities: none',
  'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, 0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
  '  2 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
  'research: nothing being researched - 0 beakers banked ("research <techId>"; "tech" lists the tree)',
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
    //
    // Rehashed for M4b (SCHEMA_VERSION 4 -> 5): `PlayerState` gained `treasury`,
    // `rates`, `beakers` and `luxuries` — four additive fields on every player,
    // and an additive field moves *every* state hash (the M2 `esc`/M3 `cities`
    // lesson, stated in `state.ts`). 15920e8782c85ecd -> c3eaac847e1f2b2a. Unlike
    // M3's rehash, this one *did* move the transcript, and deliberately: the
    // banner, every view and the `state` output now carry the economy (see the
    // pinned text below), which is the whole point of the milestone's UI half.
    //
    // Rehashed for M4c (SCHEMA_VERSION 5 -> 6): `GameMap` gained the sparse
    // `resources` list, and `map` is *inside* the state, so a new map key moves
    // every hash exactly as a new state key would — which is why `state.ts` bumped
    // the version for it. c3eaac847e1f2b2a -> c8cee40ae7481c52. This board carries
    // `resources: []`, and its transcript is again **unchanged**: a resource adds a
    // glyph and a legend entry only where one was drawn, and this map has none. That
    // byte-identity is the conditional-legend rule doing its job, not an untested
    // path — the resource tests live in `packages/core/test/textview.test.ts`.
    //
    // Rehashed for M5 (SCHEMA_VERSION 6 -> 7): `PlayerState` gained `techs` — one
    // additive field on every player, and an additive field moves *every* state
    // hash, the same lesson M4b's rehash states above. c8cee40ae7481c52 ->
    // 6904c721ca6625e9. This rehash moved the transcript too, and deliberately: the
    // header gained `research=`, every view gained a `research:` line, and the
    // beaker half of the M4b inertness sentence was replaced with what beakers
    // actually do now. That is the milestone's UI half, and the pinned text below is
    // the assertion that it landed.
    //
    // Rehashed for M6 (SCHEMA_VERSION 7 -> 8): `Unit` gained the optional
    // `hitPointsLeft`/`experience`/`fortified` keys and `UnitSpec` gained attack,
    // defence and hit points. This board's two settlers carry **no** optional key at
    // all (absence is "a unit at full health, with no promotions and not dug in"), so
    // 6904c721ca6625e9 -> 68f146af88de5f28 is the schema-version bump alone. The
    // transcript below moved with it, and this time in the milestone's own right:
    // every unit line gained its hit points (`1/1 hp`), which is exactly M6's
    // requirement that a damaged unit be visible as damaged.
    //
    // This is a test-local pin, not a golden: it rehashes because the state *shape*
    // moved, and it is updated in the same wave as the shape change. (The
    // `packages/testing` goldens were regenerated once for M4c; nothing here
    // regenerates or re-derives them.)

    expect(hashValue(syntheticState())).toBe('68f146af88de5f28');

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
    //
    // Rehashed again for M4b (SCHEMA_VERSION 4 -> 5): the four money fields on
    // `PlayerState` (and this board's `end` now banks a turn of income, so the
    // treasury in the final state is 12 rather than the starting 10). 73edef6a26a57a1f
    // -> 849f619e646119bc. The transcript moved with it, for the first time in a
    // rehash: the money lines are in it (see `EXPECTED_TRANSCRIPT`).
    //
    // Rehashed for M4c (SCHEMA_VERSION 5 -> 6): `GameMap.resources`. 849f619e646119bc
    // -> c2e1360531cae92c. The transcript is unchanged once more, for the reason the
    // pin above states.
    //
    // Rehashed for M5 (SCHEMA_VERSION 6 -> 7): `PlayerState.techs`, an additive field
    // on both of this board's players. c2e1360531cae92c -> 1ca22df3412b4ceb. This
    // time the transcript *did* move with it, because the rehash and the `research:`
    // line under every view are the same milestone.
    //
    // Rehashed for M6 (SCHEMA_VERSION 7 -> 8): M6's unit shape, the same bump the pin
    // above records. 1ca22df3412b4ceb -> 854c8039fe812a82.
    expect(hashValue(capture.session.state)).toBe('854c8039fe812a82');
    // The `end` in this script banked a turn of a *cityless* economy: no city, so no
    // commerce and no income — the treasury is exactly the starting 10. A money loop
    // that invented income for a player with nothing built would move this.
    expect(capture.session.state.players[0]?.treasury).toBe(10);
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
    // M6: the prose of a refusal carries the unit's hit points too, so a lesson about a
    // wounded unit cannot read as a lesson about a whole one.
    expect(capture.text()).toContain('your units: 0 Settler at 1,1 (1 movement left, 1/1 hp)');

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
    // Rehashed for M4a (the fixture gained `improvements: []`) and again for M4b
    // (each player gained the four money fields): 15920e8782c85ecd ->
    // c3eaac847e1f2b2a. This is the state *it was handed*, not the one the session
    // ended on — the frozen fixture is never written to, which is the whole
    // assertion, and a money loop that mutated its input in place would move this
    // hash and fail right here.
    //
    // Rehashed for M4c, for the same reason as the pin above (`GameMap.resources`
    // is part of the hashed state): c3eaac847e1f2b2a -> c8cee40ae7481c52. What the
    // assertion *claims* is unchanged — the frozen state hashes to what it hashed
    // to before the session ran.
    //
    // Rehashed for M5 (`PlayerState.techs`, SCHEMA_VERSION 6 -> 7):
    // c8cee40ae7481c52 -> 6904c721ca6625e9. The claim is the same one a third time,
    // and it is worth restating because research is the first step that *writes a
    // player* on behalf of nobody: the frozen state still hashes to itself, and a
    // research step that edited its input in place would move this line.
    // Rehashed for M6 (SCHEMA_VERSION 7 -> 8) with every other pin in this file; the
    // M6 annotation on the synthetic-state pin above states why.
    expect(hashValue(state)).toBe('68f146af88de5f28');

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
    // M4c migration: a hand-built `BuildingDef` now carries `maintenance` and
    // `effects`, both required. This row exists only to make the two id spaces
    // collide, so it costs nothing to keep and does nothing — the empty effect list
    // is legal and is the honest reading for a row that is not about effects. The
    // claim below is unchanged and covers exactly what it covered before: a bare id
    // both catalogs hold is refused with both spellings offered.
    const shared: RulesetView = {
      ...RULESET,
      buildings: [
        ...(RULESET.buildings ?? []),
        {
          id: asBuildingId('scout'),
          name: 'Scout Lodge',
          cost: 5,
          maintenance: 0,
          effects: [],
        },
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
 * M4c — the resource gate, the wonder rule and what a building costs
 *
 * The milestone's REPL half, on boards built for it. The *rules* are the engine's
 * (`resources.ts`, `buildings.ts`, `commands.ts`); what is tested here is that a
 * reader can see them: which resource a refused build is missing, what a city's
 * buildings cost to keep, and which resources its owner has actually connected.
 * ------------------------------------------------------------------ */

/** The far corner of the synthetic board, where the fixture's Iron stands. */
const IRON_TILE = tileIndex(WIDTH, 3, 3);

/**
 * A board with player 0's city at (0,0) and an **Iron** at (3,3), plus a road on
 * every tile the caller names.
 *
 * The resource and the roads are both hand-built because the fixture is about the
 * *gate*, not about generation or about a worker spending turns: `improvements` is
 * the same array `WorkCompleted` appends to, so a road here is a road the engine
 * genuinely reads. (3,3) is deliberately far from the city — a resource **adjacent**
 * to a city centre counts as connected with no road at all ("endpoints inclusive",
 * `resources.ts`), so a near resource could not express "not connected".
 *
 * Nothing is connected with no roads: the walk starts at the city centre and only
 * expands through road tiles, so `roads: []` is the honest "no road reaches it".
 * The Iron id is the shipped catalog's row (`requiresResource: iron` on the
 * swordsman), and its name — "Iron" — is what the refusal below must print.
 */
const resourceState = (roadTiles: readonly TileIndex[]): GameState => {
  const base = syntheticState();
  return {
    ...base,
    nextCityId: 1,
    map: {
      ...base.map,
      resources: [{ tile: IRON_TILE, resource: asResourceId('iron') }],
    },
    cities: [
      {
        id: asCityId(0),
        owner: asPlayerId(0),
        name: 'City 1',
        tile: tileIndex(WIDTH, 0, 0),
        population: 1,
        foodBox: 0,
        shields: 0,
        queue: [],
        buildings: [],
        workedTiles: [],
      },
    ],
    improvements: roadTiles.map((tile) => ({ tile, kind: asImprovementId('road') })),
  };
};

/**
 * The road chain from the city at (0,0) to the Iron at (3,3): (1,1) and (2,2) are
 * road-improved, and (2,2) is 8-way adjacent to the resource — so the chain stops
 * *beside* the Iron, which the contract's "endpoints inclusive" makes a connection.
 */
const ROAD_TO_IRON: readonly TileIndex[] = [tileIndex(WIDTH, 1, 1), tileIndex(WIDTH, 2, 2)];

describe('the resource gate', () => {
  it('names the missing resource when a build is refused for want of one', () => {
    const capture = open({ state: resourceState([]) });
    capture.clear();

    const outcome = capture.session.run('build 0 unit:swordsman');
    const error = refusal(outcome);
    expect(error.kind).toBe('resource-not-connected');
    if (error.kind !== 'resource-not-connected') {
      throw new Error('expected the engine to refuse for a missing resource');
    }
    // The typed payload, which is the whole reason this is its own `GameError`
    // member: the resource, the item that wanted it, and whose connection was
    // missing.
    expect(error.resource).toBe(asResourceId('iron'));
    expect(error.item).toEqual({ kind: 'unit', id: asUnitTypeId('swordsman') });
    expect(error.owner).toBe(asPlayerId(0));
    expect(error.cityId).toBe(asCityId(0));

    // …and the prose a reader gets. **It names the resource**: "it requires Iron"
    // is the sentence the milestone's acceptance asks for, because "pick another
    // item" is the wrong fix for a unit that is perfectly buildable once a road
    // reaches the iron.
    const text = capture.text();
    expect(text).toContain('error: resource-not-connected');
    expect(text).toContain('unit "Swordsman"');
    expect(text).toContain('it requires Iron');
    expect(text).toContain('Player 1 (p0) has no road connecting it');
    // The rule itself, stated where the reader needs it, and stated as the *player's*
    // connection rather than this city's.
    expect(text).toContain('some city of that player reaches it');
    expect(text).toContain('endpoints inclusive');

    // The lesson is the engine's own option list (`planSetProduction`), so the gated
    // unit is not advertised as buildable while the iron is out of reach — and the
    // units that need nothing are.
    expect(text).toContain('legal:');
    expect(text).toContain('unit "Warrior" (cost 1 shield)');
    expect(text).not.toContain('unit "Swordsman" (cost 3 shields)');

    // Refused means nothing happened: no production was set and the game did not
    // advance.
    expect(cityOf(capture.session.state).production).toBeUndefined();
    expect(capture.session.state.revision).toBe(0);
  });

  it('allows the build once a road reaches the resource, and shows the connection', () => {
    // The negative half first, on the same board: with no road the city view says so.
    const blocked = open({ state: resourceState([]) });
    blocked.clear();
    blocked.session.run('city 0');
    expect(blocked.text()).toContain('resources: none connected');

    // The positive half, with the one thing that changed being the road.
    const capture = open({ state: resourceState(ROAD_TO_IRON) });
    capture.clear();
    capture.session.run('city 0');
    // The city view names the resources its *owner* has connected, by name, because
    // that is the fact the gate turns on.
    expect(capture.text()).toContain('resources: connected for Player 1 (p0): Iron');

    capture.clear();
    const outcome = capture.session.run('build 0 unit:swordsman');
    expect(outcome.kind).toBe('applied');
    expect(cityOf(capture.session.state).production).toEqual({
      kind: 'unit',
      id: asUnitTypeId('swordsman'),
    });
    expect(capture.text()).toContain('production set to unit "Swordsman" (cost 3 shields)');

    // Two facts about that line, both of them the rule rather than the rendering.
    //
    // (1) It reports the **owner's** connections even when somebody else is looking
    // at the city: the line names the owner it is about, so a rival reading `city 0`
    // is told about player 0's roads rather than being fed its own — or worse, being
    // told the city is unbuildable when the engine says otherwise.
    const rival = open({ state: resourceState(ROAD_TO_IRON), playerIndex: 1 });
    rival.clear();
    rival.session.run('city 0');
    expect(rival.text()).toContain('resources: connected for Player 1 (p0): Iron');

    // (2) Connection is per *player*, and it is *walked* rather than owned: the
    // road-improved tiles on this board belong to nobody in the state shape, so what
    // decides the answer is whether a city of the player in question can reach them.
    // Player 1's city at (0,3) touches neither road tile (1,1) nor (2,2), so its own
    // connection set is empty even though player 0's is not.
    const base = resourceState(ROAD_TO_IRON);
    const contested: GameState = {
      ...base,
      nextCityId: 2,
      cities: [
        ...base.cities,
        {
          id: asCityId(1),
          owner: asPlayerId(1),
          name: 'City 2',
          tile: tileIndex(WIDTH, 0, 3),
          population: 1,
          foodBox: 0,
          shields: 0,
          queue: [],
          buildings: [],
          workedTiles: [],
        },
      ],
    };
    const second = open({ state: contested, playerIndex: 1 });
    second.clear();
    second.session.run('city 1');
    expect(second.text()).toContain('resources: none connected');
  });
});

/* ------------------------------------------------------------------ *
 * M5: the tech gate, as a build meets it
 * ------------------------------------------------------------------ */

/**
 * The two rows a technology gates, one unit and one improvement.
 *
 * `requiresTech` is read **structurally** — `UnitDef` and `ImprovementDef` both say
 * so in their own words, and `tech.ts`' `requiresTechOf(row: unknown)` is the one
 * read — so the field is declared here on the intersection type rather than through
 * a cast. That is the same arrangement the M4c resource rows use, and it is what keeps
 * a fixture honest: if the engine ever *declared* the field, this intersection would
 * become redundant rather than wrong, and if it stopped reading it, the assertions
 * below would fail instead of quietly passing.
 *
 * The ids and numbers are this test's, not Civ 3's: nothing here is a claim about
 * what a Legionary or a Quarry costs or needs.
 */
const TECH_GATED_UNIT: UnitDef & { readonly requiresTech: TechId } = {
  id: asUnitTypeId('legionary'),
  role: 'military',
  name: 'Legionary',
  attack: 2,
  defense: 2,
  movement: 1,
  cost: 2,
  domain: 'land',
  requiresTech: asTechId('iron-working'),
};

const TECH_GATED_IMPROVEMENT: ImprovementDef & { readonly requiresTech: TechId } = {
  id: asImprovementId('quarry'),
  kind: 'mine',
  name: 'Quarry',
  turns: 2,
  yields: { food: 0, shields: 1, commerce: 0 },
  allowedRoles: ['hills', 'mountains'],
  requiresTech: asTechId('masonry'),
};

/** The shipped ruleset plus those two rows: everything else is unchanged. */
const TECH_RULESET: RulesetView = {
  ...RULESET,
  units: [...RULESET.units, TECH_GATED_UNIT],
  improvements: [...RULESET.improvements, TECH_GATED_IMPROVEMENT],
};

/** The M4c resource board (a city that can build, and iron it cannot reach). */
const gatedBoard = (): GameState => resourceState([]);

describe('a build the tech gate holds back', () => {
  it('is REFUSED, and the line says which tech is missing and how to get it', () => {
    const capture = open({ state: gatedBoard(), ruleset: TECH_RULESET });
    capture.clear();

    // **Migrated when M5's wiring closed.** This test used to assert the opposite — that the
    // engine *accepted* this order and merely banked shields — because `planSetProduction`
    // asked `resourceGate` alone. It asks `productionGate` now, so the applier refuses with
    // the typed `tech-required`, and the assertion is strictly stronger: it requires the
    // refusal to be the *right* refusal, naming the tech, with the state left untouched.
    const outcome = capture.session.run('build 0 unit:legionary');
    expect(outcome.kind).toBe('refused');
    const error = refusal(outcome);
    expect(error.kind).toBe('tech-required');
    if (error.kind !== 'tech-required')
      throw new Error(`expected tech-required, got ${error.kind}`);
    expect(error.tech).toBe('iron-working');
    // The command changed nothing: a refused build must not half-apply.
    expect(cityOf(capture.session.state).production).toBeUndefined();

    const text = capture.text();
    // The gate's own verdict, in one line: the tech by name and id, and the command
    // that lifts it — "a tech-gated build must name the missing tech and say how to
    // get it".
    expect(text).toContain('error: tech-required');
    expect(text).toContain('unit "Legionary"');
    expect(text).toContain('"Iron Working" (iron-working)');
    expect(text).toContain('"research iron-working"');
  });

  it('offers the build — and the item really is settable — once the tech is known', () => {
    const base = gatedBoard();
    const taught: GameState = {
      ...base,
      players: base.players.map((player) =>
        player.id === asPlayerId(0)
          ? { ...player, techs: [asTechId('iron-working'), asTechId('masonry')] }
          : player,
      ),
    };
    const capture = open({ state: taught, ruleset: TECH_RULESET });
    capture.clear();
    capture.session.run('build 0 unit:legionary');

    // One field of one player differs from the board above, and the refusal becomes an
    // applied command that the *state* records — the before/after the gate is: a refusal
    // that named the tech and an acceptance that sets the production are the same rule
    // read twice.
    expect(capture.text()).not.toContain('error: tech-required');
    expect(capture.text()).toContain('production set to unit "Legionary" (cost 2 shields)');
    expect(cityOf(capture.session.state).production).toEqual({
      kind: 'unit',
      id: asUnitTypeId('legionary'),
    });
  });

  it('names the tech-gated item in the lesson under another item’s refusal', () => {
    const capture = open({ state: gatedBoard(), ruleset: TECH_RULESET });
    capture.clear();

    // The swordsman is refused for want of a road to the iron (M4c), and the lesson
    // beneath that refusal is where a reader looks for what *is* available. The
    // tech-locked unit is named there, with the tech and the command — a lesson that
    // silently dropped it would leave an item that never finishes and no sentence
    // about why.
    const error = refusal(capture.session.run('build 0 unit:swordsman'));
    expect(error.kind).toBe('resource-not-connected');
    const text = capture.text();
    // The line is a *list*, so it is read as one: every item this ruleset gates on a tech
    // is named, each with its tech and the command that lifts it. M6's combat units put
    // five more rows on it (archer, spearman, horseman, transport, legionary) plus the
    // temple, and a lesson that named only the first of them would be the same bug the
    // line exists to prevent. Asserting the first item alone is what would break here.
    const locked = text
      .split('\n')
      .find((line) => line.includes('legal: locked behind a tech you have not researched:'))
      ?.trim();
    expect(locked).toBe(
      'legal: locked behind a tech you have not researched: unit "Archer" needs ' +
        '"Warrior Code" (warrior-code) ("research warrior-code"); unit "Spearman" needs ' +
        '"Warrior Code" (warrior-code) ("research warrior-code"); unit "Horseman" needs ' +
        '"Horseback Riding" (horseback-riding) ("research horseback-riding"); unit ' +
        '"Transport" needs "Map Making" (map-making) ("research map-making"); unit ' +
        '"Legionary" needs "Iron Working" (iron-working) ("research iron-working"); ' +
        'building "Temple" needs "Ceremonial Burial" (ceremonial-burial) ' +
        '("research ceremonial-burial").',
    );
    // The menu above that line is the engine's own (`cityProductionOptions`, which
    // asks `productionGate`), so the gated unit is *not* in the "may be set to build"
    // list — the two lines are two halves of the same verdict, and neither is this
    // file's opinion.
    expect(text).toContain('may be set to build units:');
    expect(text).not.toContain('unit "Legionary" (cost 2 shields)');
  });

  it('names a tech-gated improvement in the lesson under a refused job', () => {
    const capture = open({ state: workerState(), ruleset: TECH_RULESET });
    capture.clear();

    // `planStartWork` does not ask the tech gate either (the same owed wiring, named
    // in `resources.ts`), so what a reader needs is the *lesson* — and the lesson
    // under a refused job is where the available jobs are listed. `cancel 2` on an
    // idle worker is refused for exactly that reason, which makes it the cleanest way
    // to reach the list.
    expect(refusal(capture.session.run('cancel 2')).kind).toBe('not-working');
    const text = capture.text();
    expect(text).toContain('can start improvement "Road" (2 turns), improvement "Mine" (3 turns)');
    // …and the gated row is *not* in that list, because the two halves of the lesson
    // would otherwise contradict each other in adjacent lines.
    expect(text).not.toContain(
      'can start improvement "Road" (2 turns), improvement "Mine" (3 turns), improvement "Quarry"',
    );
    // The gated row is named beside them, with the tech and the command — and it is
    // named *as well as* the free ones, because "you may not start this yet" is a
    // different answer from "this does not exist".
    expect(text).toContain(
      'legal: locked behind a tech for you: improvement "Quarry" (2 turns) needs ' +
        '"Masonry" (masonry) ("research masonry")',
    );
    // …and the gate is the engine's `unmetTechFor`, so once the tech is known the
    // line is gone and the improvement is simply startable.
    const base = workerState();
    const taught: GameState = {
      ...base,
      players: base.players.map((player) =>
        player.id === asPlayerId(0) ? { ...player, techs: [asTechId('masonry')] } : player,
      ),
    };
    const known = open({ state: taught, ruleset: TECH_RULESET });
    known.clear();
    known.session.run('cancel 2');
    expect(known.text()).not.toContain('locked behind a tech');
    expect(known.text()).toContain('improvement "Mine" (3 turns), improvement "Quarry" (2 turns)');
  });
});

describe('buildings and wonders, as the reader meets them', () => {
  it('refuses a wonder another city already holds, and names the holder', () => {
    const base = syntheticState();
    /** A minimal city of player 0's: enough for `cityById`, `cityYields` and the view. */
    const city = (
      id: number,
      name: string,
      x: number,
      y: number,
      buildings: readonly BuildingId[],
    ): City => ({
      id: asCityId(id),
      owner: asPlayerId(0),
      name,
      tile: tileIndex(WIDTH, x, y),
      population: 1,
      foodBox: 0,
      shields: 0,
      queue: [],
      buildings,
      workedTiles: [],
    });
    const state: GameState = {
      ...base,
      nextCityId: 2,
      cities: [
        // City 1 finished the Pyramids (the shipped catalog's one wonder).
        city(0, 'City 1', 0, 0, [asBuildingId('pyramids')]),
        city(1, 'City 2', 3, 3, []),
      ],
    };

    const capture = open({ state });
    capture.clear();
    const outcome = capture.session.run('build 1 building:pyramids');
    const error = refusal(outcome);
    expect(error.kind).toBe('wonder-already-built');
    if (error.kind !== 'wonder-already-built') {
      throw new Error('expected the engine to refuse the duplicate wonder');
    }
    expect(error.holder).toBe(asCityId(0));
    expect(error.building).toBe(asBuildingId('pyramids'));

    const text = capture.text();
    expect(text).toContain('error: wonder-already-built');
    expect(text).toContain('building "Pyramids"');
    // The refusal names *who* has it, which is the difference from `already-built`
    // ("this city has it"): the fix is not "pick another item" but "someone else
    // finished it first".
    expect(text).toContain('city 0 "City 1"');
    expect(text).toContain('already holds it');
    expect(text).toContain('globally unique');
    // …and the wonder is not in city 2's legal list while city 1 holds it.
    expect(text).not.toContain('building "Pyramids" (cost');

    // City 1 asking for its own wonder is the *other* refusal, and the engine
    // distinguishes them — a reader told "someone else has it" about their own
    // building would look for the wrong problem.
    capture.clear();
    expect(refusal(capture.session.run('build 0 building:pyramids')).kind).toBe('already-built');
    expect(capture.text()).toContain('error: already-built');
  });

  it('shows every building with what it costs its owner, wonders marked', () => {
    const base = syntheticState();
    const state: GameState = {
      ...base,
      nextCityId: 1,
      cities: [
        {
          id: asCityId(0),
          owner: asPlayerId(0),
          name: 'City 1',
          tile: tileIndex(WIDTH, 0, 0),
          population: 3,
          foodBox: 0,
          shields: 0,
          queue: [],
          // Granary is free, the barracks bills 1, the Pyramids bill 2 — the shipped
          // catalog's own numbers, read through `maintenanceOf` rather than restated.
          buildings: [asBuildingId('granary'), asBuildingId('barracks'), asBuildingId('pyramids')],
          workedTiles: [tileIndex(WIDTH, 0, 1)],
        },
      ],
    };

    const capture = open({ state });
    capture.clear();
    capture.session.run('city 0');
    const text = capture.text();

    expect(text).toContain(
      'buildings: Granary (0 gold/turn), Barracks (1 gold/turn), ' +
        'Pyramids (wonder, 2 gold/turn); 3 gold/turn for this city',
    );
    // The number the reader is shown is the number the money loop charges: the same
    // `maintenanceOf` sum, asked of `playerUpkeep` rather than re-added here.
    const upkeep = playerUpkeep(state, RULESET, asPlayerId(0));
    expect(upkeep.maintenance).toBeGreaterThan(0);
    expect(text).toContain(`; ${String(upkeep.maintenance)} gold/turn for this city`);

    // A city with none still says so, rather than leaving the reader to guess
    // whether the view reports buildings at all.
    const bare = open({ state: resourceState([]) });
    bare.clear();
    bare.session.run('city 0');
    expect(bare.text()).toContain('buildings: (none)');
  });

  it('prints the growth threshold the engine will use, so a granary city reads 9 where a bare one reads 10', () => {
    // The M4c growth-food wiring made this view a *statement about the engine*, and the
    // statement has to be the engine's own: a city holding a granary grows on
    // `foodBoxSize(population) - 1`, so every place the REPL prints the threshold it is
    // filling toward — the city detail, the `cities` table, the one-line summary under
    // every command, and the `CityGrew` line — must print the reduced one. Before the
    // wiring this view printed the bare curve, which is exactly the "second answer to
    // one question" the module's own notes forbid.
    const base = syntheticState();
    const withCity = (buildings: readonly BuildingId[]): GameState => ({
      ...base,
      nextCityId: 1,
      cities: [
        {
          id: asCityId(0),
          owner: asPlayerId(0),
          name: 'City 1',
          tile: tileIndex(WIDTH, 0, 0),
          population: 1,
          foodBox: 7,
          shields: 0,
          queue: [],
          buildings,
          // One worked grassland tile: 4 food against 2 eaten, a surplus of +2.
          workedTiles: [tileIndex(WIDTH, 0, 1)],
        },
      ],
    });

    // The bare curve, unchanged: 10 at one citizen, 7 in the box, 3 to go.
    expect(foodBoxSize(1)).toBe(10);
    const plain = open({ state: withCity([]) });
    plain.clear();
    plain.session.run('city 0');
    expect(plain.text()).toContain('food box 7/10 (3 more to grow)');
    expect(plain.text()).toContain('0 City 1 p0 @0,0 pop 1 food 7/10 shields 0 (idle)');

    // ... and the granary's city: 9, two to go. The number the reader sees is the
    // number `applyGrowth` compares against, because it is asked of the engine
    // (`cityGrowthTarget`) rather than restated here.
    const granary = open({ state: withCity([asBuildingId('granary')]) });
    granary.clear();
    granary.session.run('city 0');
    const text = granary.text();
    expect(text).toContain('population 1; food box 7/9 (2 more to grow)');
    expect(text).toContain('food 4 per turn, 2 eaten, surplus +2');
    expect(text).toContain('0 City 1 p0 @0,0 pop 1 food 7/9 shields 0 (idle)');

    // The `cities` table prints the same number, so the two views cannot disagree.
    granary.clear();
    granary.session.run('cities');
    expect(granary.text()).toContain('7/9');

    // And when the city grows, the denominator is the requirement for the *next*
    // citizen at the new population: 7 + 2 = 9 spends the granary's 9 exactly and
    // carries 0, and the view says the box is filling toward 14, not the bare 15.
    granary.clear();
    granary.session.run('end');
    expect(granary.text()).toContain('grew to 2 citizen(s); food box 0/14 carried over');
    expect(granary.text()).toContain('pop 2 food 0/14 shields 3 (idle)');
    const grown = cityOf(granary.session.state);
    expect(grown.population).toBe(2);
    expect(grown.foodBox).toBe(0);
    expect(foodBoxSize(grown.population)).toBe(15);
  });

  it('renders a building the catalog cannot read as costing nothing, never as undefined', () => {
    // A hand-built city holding an id no catalog defines: the same "read what is
    // there" the renderer applies to an unknown terrain id. The line still names it,
    // and no line in the view may print `undefined`.
    const base = syntheticState();
    const state: GameState = {
      ...base,
      nextCityId: 1,
      cities: [
        {
          id: asCityId(0),
          owner: asPlayerId(0),
          name: 'City 1',
          tile: tileIndex(WIDTH, 0, 0),
          population: 1,
          foodBox: 0,
          shields: 0,
          queue: [],
          buildings: [asBuildingId('ghost-house')],
          workedTiles: [],
        },
      ],
    };

    const capture = open({ state });
    capture.clear();
    capture.session.run('city 0');
    expect(capture.text()).toContain(
      'buildings: ghost-house (0 gold/turn); 0 gold/turn for this city',
    );
    expect(capture.text()).not.toContain('undefined');
  });
});

/* ------------------------------------------------------------------ *
 * Event rendering: one non-empty line per event, whatever the event is
 * ------------------------------------------------------------------ */

describe('event rendering', () => {
  it('prints a line for every event a turn emits, completion and money included', () => {
    const capture = open();
    capture.session.run('found 0');
    capture.session.run('build 0 unit:scout');
    capture.clear();

    const outcome = capture.session.run('end');
    const block = expectEveryEventRendered(outcome, capture.text());
    // M4b moved this list, deliberately: the turn pipeline is now
    // `work ++ growth ++ production ++ economy ++ TurnEnded` (INTERFACES.md M4b,
    // "The money loop"), so an `end` carries the money loop's two lines for *every*
    // civilization — the zero ones included, which is exactly what the milestone's
    // ledger evidence asks for. Pinned by identity rather than by count: the order
    // is the contract.
    expect(appliedEvents(outcome).map((event) => event.type)).toEqual([
      'CityProduced',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
    ]);
    expect(block[0]).toBe(
      'ok: city 0 "City 1" (Player 1 (p0) at 0,0) finished unit "Scout" (unit 2 at (0,0)); ' +
        '1 shields left',
    );
    // The money lines, rendered in full. Six lines where there used to be two: the
    // regression this helper exists for is an *unhandled* `GameEvent` member, and
    // M4b added four of them, so a renderer that dropped one now shows up as a short
    // block as well as a blank line (the helper checks both).
    expect(block[1]).toBe(
      'ok: Player 1 (p0) collected 2 gold, 0 beakers and 0 luxuries from its cities at its ' +
        'rates - beakers now buy tech: they are banked toward the tech you selected and spent ' +
        'on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the ' +
        'tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
    );
    expect(block[2]).toBe(
      'ok: Player 1 (p0) paid 0 gold of upkeep (0 building maintenance + 0 unit support for ' +
        '1 unit(s), 6 of them free)',
    );
    expect(block[3]).toBe(
      'ok: Player 2 (p1) collected 0 gold, 0 beakers and 0 luxuries from its cities at its ' +
        'rates - beakers now buy tech: they are banked toward the tech you selected and spent ' +
        'on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the ' +
        'tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
    );
    expect(block[4]).toBe(
      'ok: Player 2 (p1) paid 0 gold of upkeep (0 building maintenance + 0 unit support for ' +
        '1 unit(s), 4 of them free)',
    );
    expect(block[5]).toBe('ok: turn 2 begins; every unit refilled its movement');
    // And the collection is real, not just printed: 10 to start with plus the 2 the
    // city's commerce produced. A renderer and a state that disagreed here would be
    // the worst of both — a plausible line about money that never moved.
    expect(capture.session.state.players[0]?.treasury).toBe(12);
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

    expect(appliedEvents(outcome).map((event) => event.type)).toEqual([
      'CityStarved',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
    ]);
    expect(block[0]).toBe(
      'ok: city 0 "City 1" (Player 1 (p0) at 1,0) starved down to 1 citizen(s); food box ' +
        'restarted at 0',
    );
    // A starving city still collects: starvation is food, not money, and a renderer
    // that let one suppress the other would lose the turn's ledger line entirely.
    expect(block[1]).toBe(
      'ok: Player 1 (p0) collected 1 gold, 0 beakers and 0 luxuries from its cities at its ' +
        'rates - beakers now buy tech: they are banked toward the tech you selected and spent ' +
        'on the turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the ' +
        'tree); luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
    );
    expect(capture.session.state.players[0]?.treasury).toBe(11);
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

  it('never leaves an empty line where a *money* event should be, disbanding included', () => {
    // M4b's half of the regression above, and the wider net of the two: it walks a
    // whole session rather than one command, and it *reaches all four money events*
    // — a collection with non-zero beakers and luxuries, an upkeep, the two
    // `UnitDisbanded` removals bankruptcy performs, and the `TreasuryShortfall` that
    // survives them. The M4a sweep above cannot do that: its board is solvent, so
    // three of the four members would never be emitted and their cases would be
    // unrendered-and-untested.
    const capture = open({ state: bankruptState(), ruleset: BILLING_RULESET });
    const lines = ['state', 'units', 'end', 'units', 'state', 'quit'];

    for (const line of lines) {
      capture.clear();
      const outcome = capture.session.run(line);
      if (outcome.kind === 'applied' && outcome.outcome.events.length > 0) {
        expectEveryEventRendered(outcome, capture.text());
      }
      expect(capture.text()).not.toMatch(/\n\n {2}revision /);
    }
  });

  it('renders all four money events, naming the units bankruptcy took and why', () => {
    const capture = open({ state: bankruptState(), ruleset: BILLING_RULESET });
    capture.clear();

    const before = capture.session.state;
    const outcome = capture.session.run('end');
    const block = expectEveryEventRendered(outcome, capture.text());
    const events = appliedEvents(outcome);

    // The pipeline, event by event: one collection and one upkeep for each
    // civilization in player-id order, the two disbandments bankruptcy performs,
    // the shortfall that survived them, and the turn. Pinned by identity, not by
    // a count: the order *is* the M4b contract.
    expect(events.map((event) => event.type)).toEqual([
      'IncomeCollected',
      'UpkeepPaid',
      'UnitDisbanded',
      'UnitDisbanded',
      'TreasuryShortfall',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
    ]);
    expect(block).toHaveLength(events.length);

    // Non-vacuity, stated as a check on the *fixture*: without this the four lines
    // below could all be about zeroes and the test would prove nothing about the
    // inert channels or about bankruptcy.
    const income = events[0];
    const upkeep = events[1];
    if (income?.type !== 'IncomeCollected' || upkeep?.type !== 'UpkeepPaid') {
      throw new Error('the fixture must collect and then pay before it goes broke');
    }
    expect(income.beakers).toBeGreaterThan(0);
    expect(income.luxuries).toBeGreaterThan(0);
    expect(upkeep.maintenance).toBeGreaterThan(0);
    expect(upkeep.unitSupport).toBeGreaterThan(0);

    // The two money lines carry the engine's own numbers, and the collection line
    // says out loud that the two pools it just banked do nothing.
    expect(block[0]).toBe(
      `ok: Player 1 (p0) collected ${String(income.gold)} gold, ` +
        `${String(income.beakers)} ${income.beakers === 1 ? 'beaker' : 'beakers'} and ` +
        `${String(income.luxuries)} ${income.luxuries === 1 ? 'luxury' : 'luxuries'} from its ` +
        'cities at its rates - beakers now buy tech: they are banked toward the tech you ' +
        'selected and spent on the turn the pool covers its cost ("research <techId>" chooses ' +
        'one, "tech" shows the tree); luxuries DO NOTHING yet: nothing reads them until M9 ' +
        '(happiness)',
    );
    expect(block[1]).toBe(
      `ok: Player 1 (p0) paid ${String(upkeep.gold)} gold of upkeep ` +
        `(${String(upkeep.maintenance)} building maintenance + ${String(upkeep.unitSupport)} ` +
        `unit support for ${String(upkeep.units)} unit(s), ${String(upkeep.freeUnits)} of them free)`,
    );

    // Which units were disbanded, and why. The ids are pinned *and* checked against
    // the state: the units the lines name are exactly the units that are gone, so a
    // renderer cannot name one that stayed (or stay silent about one that left). The
    // order is highest-id-first, the documented rule.
    const removalOrder = events.flatMap((event) =>
      event.type === 'UnitDisbanded' ? [event.unitId] : [],
    );
    expect(removalOrder).toEqual([asUnitId(8), asUnitId(7)]);
    const actuallyGone = before.units
      .filter((unit) => !capture.session.state.units.some((left) => left.id === unit.id))
      .map((unit) => Number(unit.id))
      .sort((a, b) => b - a);
    expect(actuallyGone).toEqual(removalOrder.map(Number));
    expect(block[2]).toBe(
      'ok: BANKRUPTCY - Player 1 (p0) disbanded unit 8 (Warrior at (3,3)) to pay 1 gold of ' +
        "this turn's upkeep: the treasury could not cover it, and the highest-id unit goes first",
    );
    expect(block[3]).toBe(
      'ok: BANKRUPTCY - Player 1 (p0) disbanded unit 7 (Warrior at (3,3)) to pay 1 gold of ' +
        "this turn's upkeep: the treasury could not cover it, and the highest-id unit goes first",
    );
    // …and the second removal saved nothing more than was still owed: the shortfall
    // line's number is `upkeep - income - treasury` minus what the two saved.
    const shortfall = events[4];
    if (shortfall?.type !== 'TreasuryShortfall') throw new Error('expected a shortfall');
    expect(shortfall.unpaid).toBe(upkeep.gold - income.gold - 2);
    expect(block[4]).toBe(
      `ok: BANKRUPTCY - Player 1 (p0) still owes ${String(shortfall.unpaid)} gold of this ` +
        "turn's upkeep after disbanding every unit it could pay with; the treasury is 0 (it " +
        'never goes negative) and the unpaid gold is reported here rather than carried as a debt',
    );

    // The invariant the contract turns on: the treasury NEVER goes negative, and the
    // pools still took this turn's beakers and luxuries — a broke treasury does not
    // un-research anything.
    const after = capture.session.state.players[0];
    expect(after?.treasury).toBe(0);
    expect(after?.beakers).toBe(income.beakers);
    expect(after?.luxuries).toBe(income.luxuries);
    // Player 2 never went broke and collected nothing (it has no city): its two
    // lines are still printed, which is the "the stream is the ledger" rule.
    expect(capture.session.state.players[1]?.treasury).toBe(10);
    expect(block[5]).toContain('ok: Player 2 (p1) collected 0 gold, 0 beakers and 0 luxuries');
    expect(block[6]).toContain('ok: Player 2 (p1) paid 0 gold of upkeep');

    // **M4c's other half of the bill**, asserted where a reader meets it: the
    // building whose maintenance caused the shortfall is the building the player
    // loses (`buildings.ts`' `disbandBuildings`, most recently completed first,
    // until its maintenance covers what went unpaid). Four gold of Toll House
    // against the `unpaid` remainder means the city is stripped of it — and the city
    // view, which M4c taught to print maintenance, is where that shows.
    expect(cityOf(capture.session.state).buildings).toEqual([]);
    capture.clear();
    capture.session.run('city 0');
    expect(capture.text()).toContain('buildings: (none)');
    // …and the *state* agrees with the number the upkeep event reported: nothing is
    // billed for a building the player no longer holds.
    expect(playerUpkeep(capture.session.state, BILLING_RULESET, asPlayerId(0)).maintenance).toBe(0);
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
    // M6's `hp` column sits between the movement and the terrain: a damaged unit has to
    // be *visible as damaged* in the table as well as on the line under every view.
    expect(text).toContain('*  0   Settler     Player 1     0,0       2/2      1/1 hp');
    expect(text).toContain('Grassland');
    expect(text).toContain('units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)');
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
    // The whole block, in order: the money loop's four lines (M4b) then the turn.
    expect(expectEveryEventRendered(first, capture.text())).toEqual([
      ...bothMoneyLines(),
      'ok: turn 2 begins; every unit refilled its movement',
    ]);

    capture.clear();
    capture.session.run('end');
    expect(jobOf(capture)?.turnsLeft).toBe(1);

    capture.clear();
    const finished = capture.session.run('end');
    expect(expectEveryEventRendered(finished, capture.text())).toEqual([
      'ok: unit 2 finished improvement "Mine" (3 turns) on (2,2); the tile is improved',
      ...bothMoneyLines(),
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
      'units: *0 p0 Settler @0,0 (2/2 movement, 1/1 hp)   ' +
        '1 p1 Settler @0,1 (2/2 movement, 1/1 hp)  ' +
        '*2 p0 Worker @2,2 (0/2 movement, 1/1 hp) mining, 3 turns left',
    );
    // `describe`'s own line (see textview.test.ts): the agent's eyes on the map, with the
    // same hit points the units line carries (one spelling, `@civts/core`'s).
    expect(text).toContain('work: 2 p0 Worker@2,2 1/1 hp mining, 3 turns left');

    capture.clear();
    capture.session.run('units');
    expect(capture.text()).toContain('job');
    expect(capture.text()).toContain('mining, 3 turns left');
    expect(capture.text()).toContain(
      'Settler     Player 2     0,1       2/2      1/1 hp  Grassland    (idle)',
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
    expect(capture.text()).toContain(
      '2 Worker at 2,2 (0 movement left, 1/1 hp, mining, 3 turns left)',
    );
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
    // Rehashed for M4b along with every other pinned state in this file: the
    // session ends on a different state because the money loop now banks four
    // turns of income (and the fixture's players carry the four money fields).
    // 9dac80e9663b8231 -> 54f6d5c75de7e9d6.
    //
    // Rehashed for M4c (`GameMap.resources`; SCHEMA_VERSION 5 -> 6).
    // 54f6d5c75de7e9d6 -> 3b83f6a9d4c11384. The transcript above moved with it only
    // in its one `state` line — see `EXPECTED_WORKER_TRANSCRIPT`.
    //
    // Rehashed for M5 (`PlayerState.techs`; SCHEMA_VERSION 6 -> 7).
    // 3b83f6a9d4c11384 -> d25659e4bfc2a50b. This transcript did move with the
    // milestone, unlike the M4c one: every view in it gained a `research:` line, and
    // its `state` view gained the same line plus the tech summary beneath it.
    //
    // Rehashed for M6 (SCHEMA_VERSION 7 -> 8): M6's unit shape, the same bump the
    // synthetic-state pin records. d25659e4bfc2a50b -> 9787f054e1c300ea. The transcript
    // moved with it in every line that names a unit — hit points, as above — and in the
    // `state` view's `schema=8`.
    expect(hashValue(first.session.state)).toBe('9787f054e1c300ea');
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
 * M4b — the money surface: the `rates` verb, and the economy the reader
 * is shown whether or not it asked.
 * ------------------------------------------------------------------ */

describe('the rates verb', () => {
  it('maps onto SetRates rather than editing the player itself', () => {
    const capture = open();
    capture.clear();

    const outcome = capture.session.run('rates 7 2 1');
    expect(outcome).toMatchObject({
      kind: 'applied',
      command: { type: 'SetRates', rates: { tax: 7, science: 2, luxury: 1 } },
    });
    // No event: the command's payload *is* the record of the change (M3's setters'
    // precedent), which is why the `ok:` line below has to say what happened itself.
    expect(appliedEvents(outcome)).toEqual([]);

    // The change is in the engine's state, and it is the *only* thing that moved:
    // a rate change is a statement about the next collection, never a recomputation
    // of one that already happened.
    const before = syntheticState().players[0];
    const after = capture.session.state.players[0];
    expect(ratesOf(capture)).toEqual({ tax: 7, science: 2, luxury: 1 });
    expect(after?.treasury).toBe(before?.treasury);
    expect(after?.beakers).toBe(before?.beakers);
    expect(after?.luxuries).toBe(before?.luxuries);
    expect(capture.session.state.revision).toBe(1);

    // The line says so, in those words.
    expect(capture.text()).toContain(
      'ok: rates set to tax 7 / science 2 / luxury 1 (sum 10 of 10); this changes future ' +
        'collections only - the treasury and the two pools are exactly what they were, and no ' +
        'turn already collected is recomputed',
    );
  });

  it('refuses a triple that does not sum to RATE_TOTAL, with the engine’s own reason', () => {
    const capture = open();
    capture.clear();

    const outcome = capture.session.run('rates 7 2 2');
    const error = refusal(outcome);
    // The engine's typed reason, and the sum in it — not the REPL's opinion.
    expect(error.kind).toBe('invalid-argument');
    if (error.kind === 'invalid-argument') {
      expect(error.detail).toContain('10');
      expect(error.detail).toContain('11'); // the sum that was actually asked for
      expect(error.detail).toContain('rates');
    }
    expect(capture.text()).toContain('error: invalid-argument');
    // The lesson: the rule, and legal triples — each of which the *engine* accepted
    // before it was printed (the hint is built with `planSetRates`, not asserted).
    expect(capture.text()).toContain(`must sum to exactly ${String(RATE_TOTAL)}`);
    expect(capture.text()).toContain(`"rates ${String(RATE_TOTAL)} 0 0"`);
    expect(capture.text()).toContain(`"rates 0 ${String(RATE_TOTAL)} 0"`);
    expect(capture.text()).toContain(`"rates 0 0 ${String(RATE_TOTAL)}"`);
    expect(capture.text()).toContain('"rates 6 4 0"');

    // A refusal is inert: the rates are still what they were.
    expect(ratesOf(capture)).toEqual({ tax: 6, science: 4, luxury: 0 });
    expect(capture.session.state.revision).toBe(0);

    // Negative numbers reach the engine too (they parse as integers and are refused
    // by the rate rule, not by the grammar), so the refusal is always the engine's.
    capture.clear();
    const negative = capture.session.run('rates -1 11 0');
    expect(refusal(negative).kind).toBe('invalid-argument');
    expect(capture.session.state.revision).toBe(0);
  });

  it('refuses a non-integer or a wrong arity as malformed, without touching the engine', () => {
    const capture = open();
    capture.clear();

    // Wrong arity: the grammar's own refusal, naming the shape it wants.
    for (const line of ['rates', 'rates 6', 'rates 6 4', 'rates 6 4 0 0']) {
      capture.clear();
      expect(capture.session.run(line).kind, line).toBe('malformed');
      expect(capture.text(), line).toContain('needs 3 arguments: rates <tax> <science> <luxury>');
      expect(capture.text(), line).toContain(`summing to exactly ${String(RATE_TOTAL)}`);
      expect(capture.session.state.revision, line).toBe(0);
    }

    // Right arity, wrong type: also the grammar — a rate is an integer or the command
    // is not built at all. Note what is *absent* from this list: a negative integer
    // parses, reaches the engine, and is refused there (the test above), because the
    // rate *rule* is the engine's and this layer must not hold a second opinion.
    for (const line of ['rates a b c', 'rates 6 4 1.5', 'rates 6 4 x']) {
      capture.clear();
      expect(capture.session.run(line).kind, line).toBe('malformed');
      expect(capture.text(), line).toContain('tax, science and luxury must be whole numbers');
      expect(capture.session.state.revision, line).toBe(0);
    }
  });

  it('is documented in help and in the command summary', () => {
    const capture = open();
    capture.clear();
    capture.session.run('help');

    expect(capture.text()).toContain('rates <tax> <science> <luxury>');
    expect(capture.text()).toContain(`sum to exactly ${String(RATE_TOTAL)}`);
    expect(COMMAND_SUMMARY).toContain('rates <tax> <science> <luxury>');
  });
});

/* ------------------------------------------------------------------ *
 * M5: research, and the tree the reader climbs
 * ------------------------------------------------------------------ */

/**
 * A board with a pool already banked toward a tech (M5).
 *
 * The synthetic board has no city, so an `end` collects nothing — which makes it
 * useless for reaching a *completion*. This fixture hands player 0 a pool instead:
 * `beakers` is a state field, so a hand-built state may hold one, and `end` runs the
 * research step over it exactly as it would over a collected pool. That is the point
 * of the pipeline order (INTERFACES.md M5): research reads the pool the previous
 * money loop filled, and it cannot tell where the beakers came from.
 *
 * `researching` is *absent*, not `undefined`, when the argument is omitted — see
 * `syntheticState` for why the key's absence is the documented form of "nothing".
 */
const researchState = (beakers: number, tech?: TechId): GameState => {
  const base = syntheticState();
  const [first, ...rest] = base.players;
  if (first === undefined) throw new Error('the synthetic board has no player 0');
  return {
    ...base,
    players: [
      {
        ...first,
        beakers,
        ...(tech === undefined ? {} : { researching: tech }),
      },
      ...rest,
    ],
  };
};

describe('the research verbs', () => {
  it('maps onto SetResearch rather than editing the player itself', () => {
    const capture = open();
    capture.clear();

    const outcome = capture.session.run('research pottery');
    expect(outcome).toMatchObject({
      kind: 'applied',
      command: { type: 'SetResearch', tech: asTechId('pottery') },
    });
    // M3's setters' precedent: the command's payload *is* the record of the change,
    // so no event — and therefore the `ok:` line has to carry the progress itself.
    expect(appliedEvents(outcome)).toEqual([]);
    expect(capture.session.state.players[0]?.researching).toBe('pottery');
    expect(capture.session.state.revision).toBe(1);

    // The line states the *engine's* price and the pool this state holds, so a
    // reader can see how far off the completion is without asking again.
    expect(capture.text()).toContain(
      'ok: Player 1 (p0) is now researching "Pottery" (pottery) - cost 5 beakers, 0 banked, ' +
        '5 to go; "end" spends the pool, so it completes on the turn the pool covers the cost',
    );
    // …and nothing else moved: choosing a tech is not a turn.
    expect(capture.session.state.turn).toBe(1);
    const before = syntheticState().players[0];
    expect(capture.session.state.players[0]?.beakers).toBe(before?.beakers);
    expect(capture.session.state.players[0]?.treasury).toBe(before?.treasury);
  });

  it('refuses a tech this ruleset does not have, naming the tree it does have', () => {
    const capture = open();
    capture.clear();

    const error = refusal(capture.session.run('research wibble'));
    expect(error.kind).toBe('unknown-tech');
    if (error.kind === 'unknown-tech') {
      expect(error.tech).toBe('wibble');
    }
    // The engine's own reason, and the REPL's lesson: every tech the *catalog* has,
    // asked of `planSetResearch` rather than read out of the ruleset by hand.
    const text = capture.text();
    expect(text).toContain('error: unknown-tech');
    expect(text).toContain('no tech row');
    expect(text).toContain('carries that id');
    expect(text).toContain('researchable in this ruleset: "pottery" (5 beakers)');
    expect(text).toContain('"electricity" (45 beakers)');
    // A refusal is inert.
    expect(capture.session.state.revision).toBe(0);
    expect(capture.session.state.players[0]?.researching).toBeUndefined();
  });

  it('refuses a tech whose prerequisite is unmet, naming the prerequisite and how to get it', () => {
    const capture = open();
    capture.clear();

    // `alphabet` requires `pottery` in the shipped catalog, and the fixture knows no
    // techs at all (its `techs` is an empty list). So this is the *engine's*
    // `tech-prerequisites-unmet`, reached through the verb.
    const error = refusal(capture.session.run('research alphabet'));
    expect(error.kind).toBe('tech-prerequisites-unmet');
    if (error.kind === 'tech-prerequisites-unmet') {
      expect(error.tech).toBe('alphabet');
      expect(error.missing).toEqual([asTechId('pottery')]);
    }

    const text = capture.text();
    expect(text).toContain('error: tech-prerequisites-unmet');
    // The missing prerequisite is named — by name *and* id, because the id is what
    // the fix spells — and the fix is spelled out.
    expect(text).toContain(
      '"Alphabet" (alphabet) needs "Pottery" (pottery), which Player 1 (p0) does not know yet.',
    );
    expect(text).toContain('to get there: "research pottery" (5 beakers)');
    // And the way out of the whole family of refusals: what *is* legal right now,
    // asked of the engine's planner one candidate at a time.
    expect(text).toContain('legal: researchable now:');
    expect(text).toContain('"Pottery" (pottery), cost 5 beakers');
    expect(text).toContain('"Bronze Working" (bronze-working), cost 6 beakers');
    expect(text).toContain('legal: "research <techId>" chooses one');
    expect(capture.session.state.revision).toBe(0);
  });

  it('refuses a tech the player already knows, saying so rather than silently agreeing', () => {
    const known: GameState = {
      ...syntheticState(),
      players: [
        { ...(researchState(0).players[0] as PlayerState), techs: [asTechId('pottery')] },
        ...researchState(0).players.slice(1),
      ],
    };
    const capture = open({ state: known });
    capture.clear();

    const error = refusal(capture.session.run('research pottery'));
    expect(error.kind).toBe('tech-already-known');
    expect(capture.text()).toContain('error: tech-already-known');
    expect(capture.text()).toContain('"Pottery" (pottery)');
    expect(capture.text()).toContain('already');
    // The tree agrees: a known tech is not selectable.
    expect(capture.session.state.revision).toBe(0);
  });

  it('prints the tree: what is known, what is available now, and what is blocked and by what', () => {
    const capture = open();
    capture.clear();

    const outcome = capture.session.run('tech');
    expect(outcome.kind).toBe('inspected');
    const text = capture.text();

    // The header counts the catalog for the *player*, not the catalog's size alone.
    // The header counts the catalog, so M6's two new techs (ceremonial-burial, which
    // gates the temple, and map-making, which gates the transport) move it from 17 to 19
    // and move `blocked` from 14 to 16. `available now` stays at 3: both new techs have a
    // prerequisite, so neither is available to a player who knows nothing.
    expect(text).toContain('tech: 19 tech(s) in this ruleset; Player 1 (p0) knows 0 of them');
    expect(text).toContain(`known (0): none yet`);
    expect(text).toContain('available now (3):');
    expect(text).toContain('blocked (16):');

    // Every row is `<id> "<Name>" (<era>, <cost> beakers, <prerequisites>)`, and the
    // prerequisite is named on the row itself — the whole point of the view.
    expect(text).toContain('  pottery "Pottery" (ancient, 5 beakers, no prerequisites)');
    expect(text).toContain('  alphabet "Alphabet" (ancient, 7 beakers, requires pottery)');
    expect(text).toContain(
      '  iron-working "Iron Working" (medieval, 14 beakers, ' + 'requires bronze-working, masonry)',
    );

    // A blocked tech says *why* it is blocked, in the tree, without a second command:
    // the prerequisite by name, and the command that lifts it.
    expect(text).toContain(
      '  alphabet "Alphabet" (ancient, 7 beakers, requires pottery) - needs "Pottery" ' +
        '(pottery), which you do not know yet ("research pottery" comes first)',
    );
    // …and nothing in the tree is printed with a blank reason or a `NaN` cost.
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('marks the tech being researched in the tree, and moves it to known when it lands', () => {
    const capture = open({ state: researchState(0, asTechId('pottery')) });
    capture.clear();
    capture.session.run('tech');

    // The row a reader is looking for: what am I doing right now, and how far along.
    expect(capture.text()).toContain(
      '  pottery "Pottery" (ancient, 5 beakers, no prerequisites) <- researching',
    );
    expect(capture.text()).toContain(
      'research: researching "Pottery" (pottery) - 0/5 beakers, 5 to go',
    );

    // A pool that already covers the cost: the same view, saying the completion is
    // next, and the `end` that does it moves the tech into `known`.
    const funded = open({ state: researchState(100, asTechId('pottery')) });
    funded.clear();
    const outcome = funded.session.run('end');
    const block = expectEveryEventRendered(outcome, funded.text());

    // M5's one new event, rendered as a real line — not a blank one, which is what
    // an unhandled `GameEvent` member produces.
    expect(appliedEvents(outcome).map((event) => event.type)).toContain('TechResearched');
    const line = block.find((each) => each.includes('finished researching'));
    expect(line).toBe(
      'ok: Player 1 (p0) finished researching "Pottery" (pottery) for 5 beakers; ' +
        '95 beakers left in the pool',
    );
    // The carry-over is real, and the tech is known: the line and the state agree.
    expect(funded.session.state.players[0]?.beakers).toBe(95);
    expect(funded.session.state.players[0]?.techs).toEqual([asTechId('pottery')]);
    // Nothing is being researched any more, and the tree says so.
    expect(funded.session.state.players[0]?.researching).toBeUndefined();

    funded.clear();
    funded.session.run('tech');
    expect(funded.text()).toContain('known (1):');
    expect(funded.text()).toContain('  pottery "Pottery" (ancient, 5 beakers, no prerequisites)');
    // …and the tree grew by exactly the rows the new tech unlocked: `alphabet`,
    // `the-wheel` and M6's `map-making` all want pottery, so "available now" goes from
    // the 3 a player who knows nothing is offered to 5 — pottery itself moved into
    // `known`, so the count is read as a whole rather than assumed.
    expect(funded.text()).toContain('available now (5):');
    expect(funded.text()).toContain('  alphabet "Alphabet" (ancient, 7 beakers, requires pottery)');
    expect(funded.text()).toContain(
      '  the-wheel "The Wheel" (ancient, 8 beakers, requires pottery)',
    );
    expect(funded.text()).toContain(
      '  map-making "Map Making" (ancient, 8 beakers, requires pottery)',
    );
    expect(funded.text()).not.toContain('- needs "Pottery" (pottery)');
    expect(funded.text()).toContain('research: nothing being researched');
  });

  it('prints the research standing line in each state the research step can be in', () => {
    // The four reachable members of `ResearchStep`, each through the view rather than
    // by calling `researchStep` here: the line under every view is the surface this
    // milestone's "checkable in flight" claim rests on, and these are its four
    // answers. Three of the four are about the *pool*, and the numbers come from
    // `tech.ts` — the counts below are the engine's, not the fixture's arithmetic.
    const standing = (beakers: number, tech?: TechId): string => {
      const capture = open({ state: researchState(beakers, tech) });
      capture.clear();
      capture.session.run('state');
      const line = capture
        .text()
        .split('\n')
        .find((each) => each.startsWith('research: '));
      if (line === undefined) throw new Error('the state view printed no research line');
      return line;
    };

    // 1. Nothing selected: the pool is banked, and the line says how much.
    expect(standing(4)).toBe(
      'research: nothing being researched - 4 beakers banked ("research <techId>"; "tech" ' +
        'lists the tree)',
    );
    // 2. Selected and short: the pool, the price, and the remainder still to come.
    expect(standing(2, asTechId('pottery'))).toBe(
      'research: researching "Pottery" (pottery) - 2/5 beakers, 3 to go',
    );
    // 3. Selected and covered: the member whose `beakers` is the *carry-over* rather
    // than the pool, which is why the fraction is printed from the pool and the
    // remainder is named separately. The next `end` is what completes it.
    expect(standing(6, asTechId('pottery'))).toBe(
      'research: researching "Pottery" (pottery) - 6/5 beakers: the pool covers it, so the next ' +
        '"end" completes it and carries 1 beaker past it',
    );
    // 4. Selected, but this ruleset cannot price it: the pipeline will spend nothing,
    // and the line says so with the engine's own reason rather than going quiet.
    expect(standing(9, asTechId('telegraph'))).toBe(
      'research: stuck on "telegraph" - this ruleset cannot research "telegraph": no row ' +
        'defines it, or its cost is not a whole number of beakers; "research <techId>" replaces ' +
        'it, and "tech" prints the tree',
    );

    // The covered state is a *statement about the next turn*, and the engine agrees:
    // the `end` that follows completes it, and the pool carries the remainder.
    const capture = open({ state: researchState(6, asTechId('pottery')) });
    capture.clear();
    capture.session.run('end');
    expect(capture.text()).toContain('finished researching "Pottery" (pottery) for 5 beakers');
    expect(capture.session.state.players[0]?.beakers).toBe(1);
  });

  it('renders every event of a research turn as its own line, never a blank one', () => {
    // The M4a regression, over the M5 events: a member with no `case` joins the
    // `ok:` block as an empty line, which reads like a formatting choice.
    const capture = open({ state: researchState(100, asTechId('pottery')) });
    runScript(
      capture.session,
      ['research bronze-working', 'tech', 'state', 'end', 'end', 'units', 'quit'].join('\n'),
      capture.write,
    );

    expectNoBlankEventLines(capture.text());
    // The completion is in there on its own line, and the block that carries it is
    // the one the sweep above walked: `TechResearched` is a member of `GameEvent`,
    // and `outcomeText` switches over all of them with no `default`, so this is the
    // regression test for the *next* one as much as for this one.
    expect(capture.text()).toContain('finished researching "Bronze Working" (bronze-working)');
  });

  it('is byte-identical across two runs of the same research script', () => {
    const script = ['tech', 'research pottery', 'state', 'end', 'tech', 'quit'].join('\n');
    const first = open({ state: researchState(100, asTechId('pottery')) });
    runScript(first.session, script, first.write);
    const second = open({ state: researchState(100, asTechId('pottery')) });
    runScript(second.session, script, second.write);

    // The determinism guarantee this file makes for every other verb, for the one
    // that spends a pool: two fresh sessions, one transcript, byte for byte.
    expect(first.text()).toBe(second.text());
    expect(hashValue(first.session.state)).toBe(hashValue(second.session.state));
    expect(first.text()).toContain('research=pottery 100/5');
  });

  it('is documented in help and in the command summary', () => {
    const capture = open();
    capture.clear();
    capture.session.run('help');

    expect(capture.text()).toContain('research <techId>');
    expect(capture.text()).toContain('tech');
    // The help text says what beakers do now, and does *not* repeat the sentence M4b
    // wrote about them being inert — the stale claim this milestone had to remove.
    expect(capture.text()).toContain('Beakers buy tech (see "research")');
    expect(capture.text()).toContain('LUXURIES DO');
    expect(capture.text()).not.toContain('beakers and luxuries DO NOTHING');
    expect(COMMAND_SUMMARY).toContain('research <techId>');
    expect(COMMAND_SUMMARY).toContain('tech');
  });

  it('refuses a wrong arity as malformed, without touching the engine', () => {
    const capture = open();
    capture.clear();

    for (const line of ['research', 'research pottery extra', 'tech now']) {
      capture.clear();
      expect(capture.session.run(line).kind, line).toBe('malformed');
      expect(capture.session.state.revision, line).toBe(0);
    }
    // `research` with no argument names the shape it wants.
    capture.clear();
    capture.session.run('research');
    expect(capture.text()).toContain('research <techId>');
    capture.clear();
    capture.session.run('tech now');
    expect(capture.text()).toContain('tech');
  });
});

describe('the economy the reader is shown', () => {
  it('states the position in the banner, before the first command', () => {
    const capture = open();
    const banner = capture.text();

    expect(banner).toContain(
      'economy: 10 gold, 0 beakers, 0 luxuries, rates tax 6 / science 4 / luxury 0 ' +
        '(sum 10 of 10), 0 cities',
    );
    // The two caveat sentences, in the banner, in full. M5 corrected the first: it
    // used to say beakers do nothing until M5, which is now false — beakers buy tech
    // and this line says how. The second is still exactly true, and it is still
    // quoted here rather than paraphrased, because "luxuries do nothing" is the one
    // claim a reader could otherwise be misled about.
    expect(banner).toContain(
      'beakers now buy tech: they are banked toward the tech you selected and spent on the ' +
        'turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree).',
    );
    expect(banner).toContain('luxuries DO NOTHING yet: nothing reads them until M9 (happiness).');
    expect(banner).toContain('"rates <tax> <science> <luxury>" moves the sliders');

    // M5: and the position *in the tree*, in the same banner, for the same reason —
    // the pool is spent by the research step of a turn, so what it is banked toward is
    // part of "where am I", not something the reader has to ask for.
    expect(banner).toContain('research: nothing being researched - 0 beakers banked');
    expect(banner).toContain('"tech" lists the tree');
  });

  it('prints an economy line under every view, so a turn cannot change it unseen', () => {
    const capture = open();
    capture.clear();
    capture.session.run('move 0 1 1');

    // Every view, not just the one the agent asked for: the money loop banks and
    // charges something on *every* turn, so a figure that has to be asked for is a
    // figure the player notices only after it has already gone bankrupt.
    const economyLines = capture
      .text()
      .split('\n')
      .filter((line) => line.startsWith('economy: '));
    expect(economyLines).toHaveLength(1);
    expect(economyLines[0]).toBe(
      'economy: 10 gold, rates 6/4/0 (tax/science/luxury, sum 10 of 10), 0 beakers, ' +
        '0 luxuries - luxuries DO NOTHING yet: nothing reads them until M9 (happiness)',
    );
    expect(capture.text()).toContain(
      '1 unit(s) against 4 supported free (0 billable at 0 gold); upkeep is what empties a treasury',
    );
    // The header of the view carries the gold too, from `textview`.
    expect(capture.text()).toContain('viewer=0 gold=10');
  });

  it('prints the full ledger under "state", with the engine’s own projection', () => {
    const capture = open();
    capture.clear();
    capture.session.run('state');

    const text = capture.text();
    const player = capture.session.state.players[0];
    if (player === undefined) throw new Error('no player 0');
    const income = playerIncome(capture.session.state, RULESET, asPlayerId(0));
    const upkeep = playerUpkeep(capture.session.state, RULESET, asPlayerId(0));
    const support = unitSupport(capture.session.state, asPlayerId(0));

    expect(text).toContain(
      'economy: 10 gold, rates tax 6 / science 4 / luxury 0 (sum 10 of 10), 0 beakers, ' +
        '0 luxuries',
    );
    // M5: the state view's luxuries line keeps the M4b sentence's tail and loses its
    // beaker half, which moved to the `research:` line printed just above it.
    expect(text).toContain(
      'luxuries DO NOTHING yet: nothing reads them until M9 (happiness): they only pile up, ' +
        'and this build neither spends nor reads them.',
    );
    // M5: the state view states the research position as well, in the engine's own
    // figures (`researchStep`, the step the pipeline runs), and counts the tree the
    // same way `tech` does — known, researchable now, blocked.
    expect(text).toContain('research: nothing being researched - 0 beakers banked');
    expect(text).toContain('tech: 0/19 known (none yet)');
    expect(text).toContain(
      'tech: 3 researchable now, 16 blocked; "tech" prints the tree with costs and prerequisites',
    );
    // The per-turn projection, from `playerIncome`/`playerUpkeep` — the same
    // evaluators the money loop runs — and labelled as a projection, because growth
    // and production happen before the bill is drawn.
    expect(text).toContain(
      `economy: at these rates this state collects ${String(income.gold)} gold, ` +
        `${String(income.beakers)} beakers and ${String(income.luxuries)} luxuries a turn`,
    );
    expect(text).toContain(
      `from 0 cities, and owes ${String(upkeep.gold)} gold of upkeep ` +
        `(${String(upkeep.maintenance)} maintenance + ${String(upkeep.unitSupport)} unit ` +
        `support for ${String(support.units)} unit(s), ${String(support.free)} free)`,
    );
    expect(text).toContain('- a projection from this state, because growth and production run');
  });

  it('lets the rates verb move what that projection says, and nothing else', () => {
    const capture = open({ state: bankruptState(), ruleset: BILLING_RULESET });
    capture.clear();
    capture.session.run('state');
    const before = capture.text();

    capture.clear();
    expect(capture.session.run('rates 10 0 0').kind).toBe('applied');
    expect(capture.text()).toContain(
      'ok: rates set to tax 10 / science 0 / luxury 0 (sum 10 of 10)',
    );

    capture.clear();
    capture.session.run('state');
    const after = capture.text();

    // All gold: the beaker and luxury channels of the projection go to zero, because
    // the same city commerce is being split differently.
    const income = playerIncome(capture.session.state, BILLING_RULESET, asPlayerId(0));
    expect(income.beakers).toBe(0);
    expect(income.luxuries).toBe(0);
    expect(after).toContain('0 beakers, 0 luxuries');
    expect(after).not.toBe(before);
    // …and the *pools* are untouched by a rate change: only the next split moves.
    expect(capture.session.state.players[0]?.beakers).toBe(bankruptState().players[0]?.beakers);
  });

  it('reads a broken money field as 0 rather than printing a fraction', () => {
    // The header is the agent's primary view: `gold=2.5` or `rates 1.5/NaN/0` would be
    // worse than a conservative 0 that says "nothing the engine can count", which is
    // the same total read `economy.ts` makes of its own fields.
    //
    // A *fractional* value rather than `NaN`, deliberately: `NaN` is not
    // representable in canonical JSON, so `hashValue` refuses such a state outright
    // (the `canonicalize` guard), and this test is about rendering, not about the
    // hasher. A fraction is a shape a broken save can really carry.
    const base = syntheticState();
    const first = base.players[0];
    if (first === undefined) throw new Error('the fixture has a player 0');
    const broken: GameState = {
      ...base,
      players: [{ ...first, treasury: 2.5, beakers: -0.5 }, ...base.players.slice(1)],
    };
    const capture = open({ state: broken });
    capture.clear();
    capture.session.run('state');

    expect(capture.text()).not.toMatch(/2\.5|-0\.5/);
    expect(capture.text()).toContain('gold=0');
    expect(capture.text()).toContain('0 gold, rates');
    expect(capture.text()).toContain('0 beakers');
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
    expect(capture.text()).toContain('*1 p1 Settler @0,1 (2/2 movement, 1/1 hp)');

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

  // Full tier: determinism across fresh processes, which the standing requirement names explicitly.
  // The rest of this file stays in the fast tier — it is a REPL, and its per-command tests are
  // milliseconds — so the fast tier still exercises the CLI; only the cross-process identity check
  // defers.
  it.skipIf(!FULL_TIER)(
    'founds a city, works it, builds in it and ends turns — byte-identically in two fresh processes',
    () => {
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
        // CORRECTED for M4b. This line used to read `units: none visible` — the
        // settler is consumed by founding, and on the M4a world it was the only unit
        // player 0 had. M4b's "Starting units (closes the M4a gap)" gives every
        // civilization a **worker** as well, so the honest assertion is now that the
        // settler is gone and the worker is what remains, named in full: the same
        // claim ("founding consumed the settler") pinned against the world this build
        // actually starts a game with. The search starts *after* the `found` line
        // rather than at the top of the transcript, because the opening view — printed
        // before the city existed — legitimately still names the settler.
        const startingWorker = state.units.find(
          (unit) => unit.owner === asPlayerId(0) && Number(unit.id) !== Number(settler.id),
        );
        if (startingWorker === undefined) throw new Error('M4b: player 0 starts with a worker too');
        const afterFounding = first.stdout.slice(first.stdout.indexOf('p0> found'));
        expect(afterFounding).not.toContain('units: none visible');
        expect(afterFounding).not.toContain(`*${String(settler.id)} p0 Settler`);
        // CORRECTED for M6. The line used to end at `(2/2 movement)`; M6 prints a unit's
        // hit points wherever it is named ("a wounded unit must be visible as wounded"),
        // so the `units:` list now carries `2/3 hp` as well. The figure is asked of the
        // engine's own reader — `hitPointsLabel`, the single spelling `textview` and the
        // REPL both use — rather than written here as a second mapping, and the maximum
        // comes with it.
        expect(afterFounding).toContain(
          `units: *${String(startingWorker.id)} p0 Worker ` +
            `@${String(indexToX(state.map, startingWorker.tile))},` +
            `${String(indexToY(state.map, startingWorker.tile))} ` +
            `(2/2 movement, ${hitPointsLabel(startingWorker, unitDef(RULESET, startingWorker.type))})`,
        );
        expect(first.stdout).toContain('cities: 1 for Player 1 (p0)');
        expect(first.stdout).toContain('id  name');
        expect(first.stdout).toContain(
          `now works (${String(indexToX(state.map, work))},${String(indexToY(state.map, work))})`,
        );
        expect(first.stdout).toContain('production set to unit "Warrior" (cost 1 shield)');
        expect(first.stdout).toContain('population 1; food box');
        expect(first.stdout).toContain('works 1 of 1 citizen(s)');
        // M4c's two city-view lines, on a **generated** world and in the transcript
        // the CLI really prints. The city holds nothing yet and no road of its owns
        // reaches a resource, so both say so out loud — a reader must be able to tell
        // "nothing is connected" from "this view does not report connections".
        expect(first.stdout).toContain('buildings: (none)');
        expect(first.stdout).toContain(
          'resources: none connected - a resource connects when a city of its owner reaches it ' +
            'through road tiles',
        );
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
        //
        // Rehashed again for M4b (SCHEMA_VERSION 4 -> 5), for three visible reasons:
        // every player carries the four money fields, `newGame` starts each
        // civilization with a **worker** as well as a settler (so the board has two
        // more units and the city has a second worked tile to grow with), and three
        // `end`s now bank three turns of income into the treasury.
        // d7caab78d25b1473 -> 914715d7a9abfab2. The transcript moved with it.
        //
        // Rehashed for M4c (SCHEMA_VERSION 5 -> 6): `GameMap.resources`, and on a
        // *generated* world that is not an empty list — `generateWorld` places
        // resources on tiles whose role allows them, so this pin moves both because the
        // map carries a new key and because the key has contents. 914715d7a9abfab2 ->
        // ba551db3aa29d33a. The transcript moved with it in three visible ways: the
        // `schema=6` field, that hash, and the two new lines the `city 0` view prints
        // (the buildings' maintenance and the owner's resource connections — see the
        // pinned assertions above, which cover both).
        //
        // Rehashed for M5 (SCHEMA_VERSION 6 -> 7): every player carries `techs`, so
        // the generated board's state moved for the same reason every fixture's did.
        // ba551db3aa29d33a -> 0e2e17c80d8447a8. The transcript moved with it in two
        // visible ways: `schema=7`, and the M5 surface on every view — the header's
        // `research=` field, the `research:` line under each view, and the two tech
        // summary lines the `state` view prints beneath them. Nothing about the city
        // view's own numbers moved: this script never researches anything, which is
        // what makes the *idle* form of the field the one pinned here.
        //
        // Rehashed for M6 (SCHEMA_VERSION 7 -> 8): `newGame` writes `hitPointsLeft` on
        // every unit it places (full health for a unit that has taken no damage), so
        // every state holding a unit moves — the same "one new key" reason as M5's
        // `techs`, and the reason every golden moved in this milestone too. The two
        // omitted-when-default keys M6 adds (`experience`, `fortified`) are written by
        // neither pass and so contribute nothing: a fresh settler is not promoted and
        // not dug in. 0e2e17c80d8447a8 -> 97b02fcaa6e3716b. The transcript moved with it
        // in two visible ways: `schema=8`, and the hit points M6 prints wherever a unit
        // is named — the `units:` list under each view now reads
        // `(2/2 movement, 1/1 hp)`, which the assertion above derives from the engine's
        // own `hitPointsLabel` rather than restating. The city view's own numbers are
        // unchanged.
        expect(first.stdout).toContain('hash: 97b02fcaa6e3716b');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

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
      //
      // The `units:` line carries *both* of player 0's workers as of M4b (the one
      // `newGame` now starts the civilization with, and the one the city produced),
      // so the assertion pins the produced worker's entry inside the line rather
      // than the whole line: it is now a substring of a longer, non-contiguous set
      // of entries, and asserting the whole line would pin the *other* worker's
      // presence too, which is a different claim (the CLI test above makes it).
      expect(first.stdout).toContain(
        `*${workerId} p0 Worker @${at.slice(1, -1)} (0/2 movement, 1/1 hp) ` +
          'building a road, 2 turns left',
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
  it('lists every row its totals count — terrain, unit, building, improvement and resource alike', () => {
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
    // M4c adds the fifth: the resource rows, whose numbers (yields, allowed terrain,
    // which unit is gated on one) are the milestone's newest placeholder content and
    // therefore exactly what this report has to account for. M5 adds the sixth, the
    // tech rows, for the same reason one milestone later: seventeen costs, eras and
    // prerequisite edges of ours, and the report is where that is readable.
    const rows = printedRows(printed);
    expect(rows.map((row) => row.id)).toEqual([
      ...CATALOG.terrains.map((t) => t.id),
      ...CATALOG.units.map((u) => u.id),
      ...CATALOG.buildings.map((b) => b.id),
      ...CATALOG.improvements.map((i) => i.id),
      ...CATALOG.resources.map((r) => r.id),
      ...CATALOG.techs.map((t) => t.id),
    ]);

    // …which is what makes the table and the totals agree.
    expect(rows.length).toBe(printed.total);
    expect(rows.filter((row) => row.kind === 'placeholder').length).toBe(printed.placeholder);
    expect(rows.filter((row) => row.kind === 'cited').length).toBe(printed.cited);
  });

  it('states each section in its own heading, and adds those up to the total', () => {
    const stdout = runCli(['provenance'], '').stdout;
    const printed = parseProvenance(stdout);

    // M4c adds `resources` as the fifth heading, after the four M2-M4a catalogs,
    // because the report's sections *are* the catalog list rather than a selection
    // from it. M5 adds `techs` as the sixth, in the same position the catalog puts it.
    expect(printed.sections.map((section) => section.name)).toEqual([
      'terrains',
      'units',
      'buildings',
      'improvements',
      'resources',
      'techs',
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

    // …and for M4c's resource rows, which is the newest place the honesty rule has
    // to be readable: a resource's yields, the terrain it may stand on and — for the
    // strategic one — the unit requirement it feeds are all numbers of ours. The
    // printed detail is the catalog's own note, so the report cannot soften the
    // claim, and at least the strategic row says outright that it is unsourced.
    const resources = printed.sections.find((section) => section.name === 'resources');
    expect(resources?.rows.map((row) => row.id)).toEqual(CATALOG.resources.map((r) => r.id));
    for (const [index, spec] of CATALOG.resources.entries()) {
      expect(spec.provenance.kind).toBe('placeholder');
      if (spec.provenance.kind === 'placeholder') {
        expect(resources?.rows[index]?.detail).toBe(spec.provenance.note);
      }
    }
    // The one strategic resource the shipped swordsman is gated on carries the
    // "unsourced, chosen to be playable" claim in its own row, which is what makes
    // the *gate* a placeholder rule rather than a claimed Civ 3 one.
    const strategic = CATALOG.resources.find((r) => r.id === 'iron');
    expect(strategic?.provenance.kind).toBe('placeholder');
    if (strategic?.provenance.kind === 'placeholder') {
      expect(stdout).toContain(strategic.provenance.note);
      expect(strategic.provenance.note).toContain('unsourced');
    }

    // …and for M5's tech rows, which is the newest place the honesty rule has to be
    // readable: every cost, era and prerequisite edge in the tree is ours. The
    // printed detail is the catalog's own note, so the report cannot soften the
    // claim, and every row of the tree says outright that it is unsourced — a tech
    // tree is exactly the kind of table a reader would otherwise assume came from the
    // game it is imitating.
    const techs = printed.sections.find((section) => section.name === 'techs');
    expect(techs?.rows.map((row) => row.id)).toEqual(CATALOG.techs.map((t) => t.id));
    for (const [index, spec] of CATALOG.techs.entries()) {
      expect(spec.provenance.kind).toBe('placeholder');
      if (spec.provenance.kind === 'placeholder') {
        expect(techs?.rows[index]?.detail).toBe(spec.provenance.note);
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

/* ------------------------------------------------------------------ *
 * M6 — the combat verbs: `attack`, `fortify`, the hit points every unit
 * is shown with, and the four events a battle and a capture emit.
 *
 * The board below is the M2 one plus the four warriors, the stack and
 * the enemy city a battle and a capture need. It is arranged rather than
 * found, for the reason every fixture in this file is: the REPL's
 * surface is what is under test, so the world has to be exact.
 * ------------------------------------------------------------------ */

/**
 * The M6 combat board.
 *
 * Player 0's warrior 2 stands on (1,1) — one step from an enemy settler at (0,1), an
 * enemy warrior at (1,2), a *stack* of two enemy warriors at (0,2) and the empty
 * hills at (2,2) — and player 0's warrior 4 stands beside the enemy city on (3,3),
 * which holds a granary, the Pyramids and city walls.
 *
 * Every unit carries `hitPointsLeft` **explicitly**, and that is not a detail:
 * `units.ts` reads a *missing* field as `DEFAULT_HIT_POINTS` (1), so a fixture that
 * left it out would be a board of units one hit from death, and every number below
 * would describe that board rather than a full-strength one. `spawnUnit` always
 * writes the field, so an explicit 3 is what a real board looks like; the
 * `attackerHitPoints` option is how a *damaged* board is built, which is the state
 * the "a damaged unit must be visible as damaged" tests need.
 *
 * The three optional keys a unit can carry are spread conditionally, so a key that
 * was not asked for is **absent** rather than present-and-`undefined` — the same
 * rule the engine's own writers follow, and the reason `syntheticState` spells it
 * out at length.
 */
const combatState = (options?: {
  readonly attackerHitPoints?: number;
  readonly attackerExperience?: number;
  readonly attackerFortified?: boolean;
  /** Put a defender inside the city, so a target there is a battle rather than a capture. */
  readonly garrison?: boolean;
  /** Give the city its walls. On by default: the wall bonus is half its defence. */
  readonly walls?: boolean;
}): GameState => {
  const base = syntheticState();
  const attacker: Unit = {
    id: asUnitId(2),
    type: asUnitTypeId('warrior'),
    owner: asPlayerId(0),
    tile: tileIndex(WIDTH, 1, 1),
    movementLeft: 1,
    hitPointsLeft: options?.attackerHitPoints ?? 3,
    ...(options?.attackerExperience === undefined
      ? {}
      : { experience: options.attackerExperience }),
    ...(options?.attackerFortified === true ? { fortified: true } : {}),
  };
  const warrior = (id: number, owner: number, x: number, y: number): Unit => ({
    id: asUnitId(id),
    type: asUnitTypeId('warrior'),
    owner: asPlayerId(owner),
    tile: tileIndex(WIDTH, x, y),
    movementLeft: 1,
    hitPointsLeft: 3,
  });

  return {
    ...base,
    nextUnitId: 8,
    nextCityId: 1,
    units: [
      ...base.units,
      attacker,
      warrior(3, 1, 1, 2),
      warrior(4, 0, 2, 3),
      // Two enemy warriors on one tile: the one target `planAttackUnit` refuses to aim
      // at, because which of them a battle would resolve against is a rule the engine
      // deliberately does not have (M2 lets units stack).
      warrior(5, 1, 0, 2),
      warrior(6, 1, 0, 2),
      ...(options?.garrison === true ? [warrior(7, 1, 3, 3)] : []),
    ],
    cities: [
      {
        id: asCityId(0),
        name: 'Enemy Town',
        owner: asPlayerId(1),
        tile: tileIndex(WIDTH, 3, 3),
        population: 4,
        foodBox: 5,
        shields: 3,
        queue: [],
        buildings: [
          asBuildingId('granary'),
          asBuildingId('pyramids'),
          ...(options?.walls === false ? [] : [asBuildingId('walls')]),
        ],
        workedTiles: [],
      },
    ],
  };
};

/** `attack <unitId> <x> <y>` and `fortify <unitId>`, in the order a session would type them. */
const COMBAT_SCRIPT = [
  'attack 2 0 2', // refused: the target is a stack of two, so no defender can be chosen
  'attack 2 1 2', // a battle the attacker loses, which kills it and promotes the defender
  'fortify 0', // no event, so the state's flag and the applied line are the record
  'attack 4 3 3', // an undefended city is not a battle: it is captured
  'units', // the gone and the damaged, on the line under every view
];

describe('the combat verbs', () => {
  it('turns `attack` into one AttackUnit, and prints every number the resolver produced', () => {
    const capture = open({ state: combatState() });
    capture.clear();
    const rngBefore = hashValue(capture.session.state.rng);

    const outcome = capture.session.run('attack 2 1 2');
    expect(outcome).toMatchObject({
      kind: 'applied',
      command: { type: 'AttackUnit', unitId: asUnitId(2), target: tileIndex(WIDTH, 1, 2) },
    });

    // The battle drew its rounds from the *state's* own RNG — the one field a save
    // carries — rather than from a stream invented in the resolver.
    expect(hashValue(capture.session.state.rng)).not.toBe(rngBefore);

    // Three events, three real lines, in the order they happened, and the odds before
    // the outcome they were drawn against.
    const block = expectEveryEventRendered(outcome, capture.text());
    expect(block).toEqual([
      'ok: COMBAT - unit 2 (Player 1 (p0)) attacked unit 3 (Player 2 (p1)) at (1,2): ' +
        '33% per-round odds for the attacker (a draw below that wins, and a tie goes to ' +
        'the defender), 3 round(s) fought, the attacker lost 3 hit point(s) and the ' +
        'defender lost 0 - defender-wins: the defender holds the field and unit 2 is destroyed',
      'ok: unit 2 (Warrior, Player 1 (p0)) is GONE from (1,1): it lost the battle it was ' +
        'fighting, and killed by unit 3 (Player 2 (p1))',
      'ok: unit 3 (Player 2 (p1)) won at (1,2) and was promoted to veteran level 1 of 3; ' +
        'each level is +25% attack, and experience is never lost',
    ]);

    // The odds on the line are the resolver's own number, not a second calculation
    // here: 1 attack against 2 defence on grassland (+10%) is 1/3 of the roll space.
    expect(appliedEvents(outcome)[0]).toMatchObject({
      type: 'CombatResolved',
      attackerWinPct: 33,
      rounds: 3,
      attackerLost: 3,
      defenderLost: 0,
      outcome: 'defender-wins',
      attackerSurvives: false,
      defenderSurvives: true,
    });

    // The state agrees with the lines: the loser is gone, the winner stands where it
    // was with its new promotion, and the command is one revision.
    const state = capture.session.state;
    expect(state.units.map((unit) => Number(unit.id))).toEqual([0, 1, 3, 4, 5, 6]);
    const winner = state.units.find((unit) => Number(unit.id) === 3);
    expect(winner?.tile).toBe(tileIndex(WIDTH, 1, 2));
    expect(winner?.experience).toBe(1);
    expect(state.revision).toBe(1);
  });

  it('shows the tile and the walls in the odds: the same warrior is harder to kill inside a city', () => {
    // Same attacker type, same seed, same map — the *defender's tile* is the only
    // difference. On grassland the defender's 2 defence gains the terrain's +10%, so the
    // attacker's odds are 1 in 3; inside a city with walls the same defender gains
    // +10% terrain, +50% city and +50% walls, which floors to 4 defence and 1-in-5.
    const field = open({ state: combatState() });
    field.clear();
    field.session.run('attack 2 1 2');
    expect(field.text()).toContain('33% per-round odds');

    const city = open({ state: combatState({ garrison: true }) });
    city.clear();
    const outcome = city.session.run('attack 4 3 3');
    expect(outcome.kind).toBe('applied');
    expect(city.text()).toContain('20% per-round odds');
    expect(appliedEvents(outcome)[0]).toMatchObject({
      type: 'CombatResolved',
      attackerWinPct: 20,
      outcome: 'defender-wins',
    });
    // A garrison is a *battle*, not a capture: the city changes hands only when nobody
    // is standing in it, which is the one line of the capture rule worth pinning here.
    expect(cityById(city.session.state, asCityId(0))?.owner).toBe(asPlayerId(1));
  });

  it('fortifies where the unit stands: the flag in the state, a real line, and no event', () => {
    const capture = open({ state: combatState() });
    capture.clear();

    const outcome = capture.session.run('fortify 2');
    expect(outcome).toMatchObject({
      kind: 'applied',
      command: { type: 'FortifyUnit', unitId: asUnitId(2) },
    });
    // The frozen M6 event list has no member for "the unit is dug in", so this command
    // emits nothing: the line below is `appliedCommandText`'s report, not an event's.
    expect(appliedEvents(outcome)).toEqual([]);
    expect(capture.text()).toContain(
      'ok: unit 2 is dug in where it stands; fortifying spends its remaining movement ' +
        '(0 left), and a unit that moves away is no longer fortified. It is worth ' +
        '+25% defence, and it emits no event, so this line is the record of it',
    );

    const unit = capture.session.state.units.find((each) => Number(each.id) === 2);
    expect(unit?.fortified).toBe(true);
    expect(unit?.movementLeft).toBe(0);
    expect(capture.session.state.revision).toBe(1);

    // Fortifying again is refused rather than repeated: with no movement left, the
    // engine's own `planFortifyUnit` is what says so.
    capture.clear();
    const again = capture.session.run('fortify 2');
    expect(refusal(again).kind).toBe('not-enough-movement');
    expect(capture.session.state.revision).toBe(1);
  });

  it('captures an undefended city: the exact population, the buildings the sack destroyed, the wonder it kept', () => {
    const capture = open({ state: combatState() });
    capture.clear();

    const outcome = capture.session.run('attack 4 3 3');
    expect(outcome).toMatchObject({
      kind: 'applied',
      command: { type: 'AttackUnit', unitId: asUnitId(4), target: tileIndex(WIDTH, 3, 3) },
    });

    // One event, and it is the capture: no battle happened, because there was nobody
    // in the city to fight. The battle it is *not* is worth asserting: a capture that
    // emitted a `CombatResolved` would be reporting a fight that did not occur.
    const block = expectEveryEventRendered(outcome, capture.text());
    expect(appliedEvents(outcome).map((event) => event.type)).toEqual(['CityCaptured']);
    expect(block).toEqual([
      'ok: Enemy Town (city 0) at (3,3) was CAPTURED by Player 1 (p0) from ' +
        'Player 2 (p1); population is now 2 and the sack destroyed 2 building(s) ' +
        '(building "City Walls", building "Granary") - a wonder is never destroyed by ' +
        'capture, the city is not razed, and its tile improvements stay',
    ]);

    // The state, item by item: half of population 4 (rounded down, floored once), the
    // wonder kept, the two ordinary buildings destroyed in maintenance-descending
    // order, the queue and the work cleared, and the id, name and tile untouched.
    const city = cityById(capture.session.state, asCityId(0));
    expect(city?.owner).toBe(asPlayerId(0));
    expect(city?.population).toBe(2);
    expect(city?.name).toBe('Enemy Town');
    expect(city?.tile).toBe(tileIndex(WIDTH, 3, 3));
    expect(city?.buildings).toEqual([asBuildingId('pyramids')]);
    expect(city?.queue).toEqual([]);
    expect(city?.workedTiles).toEqual([]);
    // The attacker spent its movement taking the city, and is standing outside it:
    // a capture does not move the unit.
    const attacker = capture.session.state.units.find((each) => Number(each.id) === 4);
    expect(attacker?.tile).toBe(tileIndex(WIDTH, 2, 3));
    expect(attacker?.movementLeft).toBe(0);

    // And the same city, read back through the view, says whose it is now.
    capture.clear();
    capture.session.run('city 0');
    expect(capture.text()).toContain('city 0 "Enemy Town" (Player 1 (p0) at 3,3)');
    expect(capture.text()).toContain('population 2;');
    expect(capture.text()).toContain('buildings: Pyramids (wonder, 2 gold/turn)');
    expect(capture.text()).not.toContain('City Walls');
  });

  it('shows a city’s defence, and says what the number is made of', () => {
    const walled = open({ state: combatState() });
    walled.clear();
    walled.session.run('city 0');
    // The city view's line is the *city's* half of the combat story: the attacker's user
    // needs to know that taking this tile costs more than taking the field beside it.
    expect(walled.text()).toContain(
      '  defence: +110% to a unit defending this tile (terrain +10%, city +50%, ' +
        'walls +50% (it holds defensive walls)), plus +25% if that unit is fortified. ' +
        'The city has no defence of its own: an undefended city is captured outright, ' +
        'so what defends it is a unit standing here.',
    );
    // Without walls the same city is worth 60%, so the line is reading the building
    // list rather than printing a constant.
    const openCity = open({ state: combatState({ walls: false }) });
    openCity.clear();
    openCity.session.run('city 0');
    expect(openCity.text()).toContain(
      '  defence: +60% to a unit defending this tile (terrain +10%, city +50%, ' +
        'walls +0% (no "walls" building here, so no wall bonus))',
    );
    expect(openCity.text()).not.toContain('City Walls');
  });

  it('shows a damaged unit as damaged wherever a unit is shown', () => {
    const capture = open({
      state: combatState({ attackerHitPoints: 1, attackerExperience: 2 }),
    });
    capture.clear();
    capture.session.run('units');

    const text = capture.text();
    // The table's own column, and the two spellings the session uses elsewhere: the
    // line under every view, and the prose of a refusal about the unit.
    expect(text).toContain('move     hp      terrain');
    expect(text).toContain('*  2   Warrior     Player 1     1,1       1/1      1/3 hp');
    // The whole units on the same board read `3/3 hp`, so the `1/3` above is a wound
    // rather than the format: a view that printed a constant would fail this pair.
    expect(text).toContain('   3   Warrior     Player 2     1,2       1/1      3/3 hp');
    expect(text).toContain('*2 p0 Warrior @1,1 (1/1 movement, 1/3 hp)');
    expect(text).toContain('3 p1 Warrior @1,2 (1/1 movement, 3/3 hp)');

    capture.clear();
    capture.session.run('attack 2 2 2');
    expect(capture.text()).toContain('unit 2 (Warrior at 1,1, 1/1 per turn movement left, 1/3 hp)');
  });

  it('is deterministic: the same board fights the same battle twice', () => {
    const first = open({ state: combatState() });
    const second = open({ state: combatState() });
    runScript(first.session, `${COMBAT_SCRIPT.join('\n')}\nquit\n`, first.write);
    runScript(second.session, `${COMBAT_SCRIPT.join('\n')}\nquit\n`, second.write);

    // A battle is the one place the engine's RNG is read for a *decision* rather than
    // for map generation, so byte-identity here is the determinism requirement on the
    // new surface: same seed, same board, same transcript, same final hash.
    expect(first.text()).toBe(second.text());
    expect(hashValue(first.session.state)).toBe(hashValue(second.session.state));
  });

  it('documents the two verbs in help and in the command summary', () => {
    expect(COMMAND_SUMMARY).toContain('attack <unitId> <x> <y>');
    expect(COMMAND_SUMMARY).toContain('fortify <unitId>');

    const capture = open();
    capture.clear();
    capture.session.run('help');
    const text = capture.text();
    expect(text).toContain('attack <unitId> <x> <y>');
    expect(text).toContain('fortify <unitId>');
    // The three rules a player cannot guess from the verb: the tie goes to the
    // defender, a city with nobody in it is captured rather than fought for, and
    // fortifying is worth a stated percentage.
    expect(text).toContain('A tie in a round goes to the DEFENDER');
    expect(text).toContain('CAPTURED');
    expect(text).toContain('+25% defence');
  });
});

describe('an attack that does not apply', () => {
  it('refuses a unit that cannot attack, and offers what it can do instead', () => {
    const capture = open({ state: combatState() });
    capture.clear();

    const outcome = capture.session.run('attack 0 1 2');
    const error = refusal(outcome);
    expect(error.kind).toBe('unit-cannot-attack');
    if (error.kind !== 'unit-cannot-attack') throw new Error('unreachable');
    expect(error.unitId).toBe(asUnitId(0));
    expect(error.attack).toBe(0);

    const text = capture.text();
    expect(text).toContain("cannot attack: its type's attack is 0");
    // The lesson is about the unit, not about the target: what a settler *can* do is
    // move, so the legal moves are printed under the refusal.
    expect(text).toContain('legal: unit 0 (Settler at 0,0');
    expect(capture.session.state.revision).toBe(0);
  });

  it('names exactly the tiles the engine would accept — the lesson is the applier’s own answer', () => {
    // The keystone invariant, on the new surface: the `legal:` line under a refusal is
    // produced by asking `planAttackUnit` one tile at a time (`legalAttackLines`), so
    // the tiles it prints and the tiles `attack` accepts must be the same set. This
    // walks all eight neighbours of (1,1) in a fresh session each, which is the only
    // way to see the *accepted* commands without killing the board.
    const neighbours: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ];
    const accepted: string[] = [];
    for (const [x, y] of neighbours) {
      const probe = open({ state: combatState() });
      probe.clear();
      if (probe.session.run(`attack 2 ${String(x)} ${String(y)}`).kind === 'applied') {
        accepted.push(`${String(x)},${String(y)}`);
      }
    }
    // (0,1) holds player 1's settler and (1,2) its warrior: the two enemy units this
    // warrior stands beside. (0,2) holds *two* enemies, which is refused; (2,2) holds
    // nothing; (0,0) holds player 0's own settler; (1,0) is impassable mountains.
    expect(accepted).toEqual(['0,1', '1,2']);

    const capture = open({ state: combatState() });
    capture.clear();
    capture.session.run('attack 2 2 2');
    const lesson =
      capture
        .text()
        .split('\n')
        .find((line) => line.includes('can attack ')) ?? '';
    expect(lesson).toContain('legal: unit 2 (Warrior at 1,1');
    expect(lesson).toContain('can attack (0,1) (1,2) - each is adjacent and holds one');
    // …and neither of the two tiles it leaves out appears on the line.
    expect(lesson).not.toContain('(0,2)');
    expect(lesson).not.toContain('(2,2)');
  });

  it('refuses a stacked target rather than choosing a defender', () => {
    const capture = open({ state: combatState() });
    capture.clear();

    const outcome = capture.session.run('attack 2 0 2');
    const error = refusal(outcome);
    expect(error.kind).toBe('target-stacked');
    if (error.kind !== 'target-stacked') throw new Error('unreachable');
    expect(error.defenders).toBe(2);

    const text = capture.text();
    expect(text).toContain('error: target-stacked - (0,2) holds 2 enemy units,');
    expect(text).toContain('rule this engine does not have (M2 lets units stack)');
    // Both defenders are untouched: a refused attack is inert.
    expect(capture.session.state.revision).toBe(0);
    for (const id of [5, 6]) {
      expect(
        capture.session.state.units.find((unit) => Number(unit.id) === id)?.hitPointsLeft,
      ).toBe(3);
    }
  });

  it('refuses a target that is not adjacent, an unknown unit and a malformed line', () => {
    const capture = open({ state: combatState() });

    const notAdjacent = (line: string): GameError => {
      capture.clear();
      const error = refusal(capture.session.run(line));
      expect(error.kind).toBe('invalid-argument');
      return error;
    };
    // The unit's own tile (0 steps) and a tile two away: a unit attacks what it stands
    // beside, and the rule is the engine's, not the REPL's.
    expect(notAdjacent('attack 2 1 1').kind).toBe('invalid-argument');
    expect(capture.text()).toContain('is 0 tiles from tile 5');
    expect(notAdjacent('attack 2 3 3').kind).toBe('invalid-argument');
    expect(capture.text()).toContain('ranged and multi-tile attacks are not part of M6');

    capture.clear();
    expect(refusal(capture.session.run('attack 9 1 2')).kind).toBe('unknown-unit');
    expect(refusal(capture.session.run('fortify 9')).kind).toBe('unknown-unit');

    // The REPL's own argument checks, which never reach the engine: a wrong count, a
    // non-numeric id and an off-map coordinate are all `malformed`.
    for (const line of [
      'attack 2 1',
      'attack 2 1 2 3',
      'attack x 1 2',
      'attack 2 x 2',
      'attack 2 9 9',
      'fortify',
      'fortify 2 3',
      'fortify x',
    ]) {
      capture.clear();
      expect(capture.session.run(line).kind, line).toBe('malformed');
    }
    expect(capture.session.state.revision).toBe(0);
  });

  it('renders every combat event as a real line, and never a blank one', () => {
    const capture = open({ state: combatState() });
    const seen = new Set<string>();
    let refusedLines = 0;
    for (const line of COMBAT_SCRIPT) {
      const outcome = capture.session.run(line);
      if (outcome.kind !== 'applied') {
        if (outcome.kind === 'refused') refusedLines += 1;
        continue;
      }
      for (const event of appliedEvents(outcome)) seen.add(event.type);
    }
    // One line of the script is the refusal (the stacked target): a refused command
    // emits nothing, so it is the *absence* of a block that has to stay blank-line-free
    // too — `expectNoBlankEventLines` checks the line above each block is the echoed
    // command, and a refusal that wrote a stray blank line would break that as well.
    expect(refusedLines).toBe(1);
    // The helper wants the *whole* session text: it anchors each block on the revision
    // line and checks the line above it is the echoed command, which a cleared capture
    // no longer carries.
    expectNoBlankEventLines(capture.text());

    // The regression is only worth anything if the script reached all four of M6's
    // events: a blank line is what an unrendered member leaves behind, so a script that
    // skipped one would leave nothing to catch.
    expect([...seen].sort()).toEqual([
      'CityCaptured',
      'CombatResolved',
      'UnitDestroyed',
      'UnitPromoted',
    ]);

    // And the same session is one blocking regression over all of them, with the
    // rendered content asserted line by line rather than only counted.
    expect(capture.text()).toContain('ok: COMBAT - unit 2');
    expect(capture.text()).toContain('is GONE from (1,1)');
    expect(capture.text()).toContain('CAPTURED by Player 1 (p0)');
    expect(capture.text()).toContain('ok: unit 0 is dug in where it stands');
  });
});
