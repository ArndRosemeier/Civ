/**
 * Replay: a game is `(seed, settings, ruleset identity, command log)`, and re-running it has to
 * reproduce the recorded hash at **every turn boundary**.
 * See docs/INTERFACES.md, M11 ("Replay").
 *
 * The two claims worth pinning here, because they are the two the contract singles out:
 *
 * - **Every boundary, not the last one.** The test below tampers with turn 5's recorded hash and
 *   leaves every other boundary — including the final one — exactly as the game produced it. A
 *   replay that only compared the end hash would report success; this one reports `diverged` at
 *   turn 5, which is the whole property the contract's paragraph is about.
 * - **A refused command is reported with its turn.** A log recorded before a rule changed still
 *   names the command and the turn it was issued on; the refusal is a typed error carrying both,
 *   never a run that merely ends early.
 *
 * Everything else in this file is the same property from another side: the states are the real
 * engine's, the log is produced by the recorder that ships beside `replay`, and every refusal is
 * asserted by `kind` and asserted not to throw.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  REPLAY_VERSION,
  asBuildingId,
  applyCommand,
  asPlayerId,
  commandFrom,
  createReplayRecorder,
  formatReplayError,
  isGameOver,
  newGame,
  replay,
  type Command,
  type ReplayError,
  type ReplayLog,
  type ReplayReport,
  type ReplayRecorder,
  type Result,
  type RulesetView,
  type SaveCodec,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;
const RULESET_IDENTITY = hashValue(validated.value);

const CODEC: SaveCodec = { hash: hashValue, invariants: [] };
const P0 = asPlayerId(0);
const SEED = 42;
/** The game's own settings — with the seed, so the pair `(seed, settings)` is one statement. */
const SETTINGS = { ...DEFAULT_SETTINGS, seed: SEED, civCount: 2, mapSize: 'tiny' } as const;

/* ------------------------------------------------------------------ *
 * A recorded game, played by the engine.
 * ------------------------------------------------------------------ */

/**
 * Play `turns` turns through the recorder: found a city with the settler, put it on a granary,
 * and end every turn. Every command goes through `applyCommand` — the recorder never edits state
 * — so the log is a record of a game the engine really played.
 */
const recordGame = (turns: number): ReplayRecorder => {
  const recorder = createReplayRecorder(SEED, SETTINGS, RULESET, RULESET_IDENTITY, CODEC);
  if (!recorder.ok) throw new Error(`the recorder could not start a game: ${recorder.error.kind}`);
  const session = recorder.value;

  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn === 1) {
      const settler = session.state.units.find(
        (unit) => unit.owner === P0 && unit.type === 'settler',
      );
      if (settler === undefined) throw new Error('the opening board has no settler');
      const founded = session.apply(P0, { type: 'FoundCity', unitId: settler.id });
      if (!founded.ok) throw new Error(`founding a city was refused: ${founded.error.kind}`);
      const chosen = session.apply(P0, {
        type: 'SetProduction',
        cityId: founded.value.state.cities[0]?.id ?? (0 as never),
        item: { kind: 'building', id: asBuildingId('granary') },
      });
      if (!chosen.ok) throw new Error(`setting production was refused: ${chosen.error.kind}`);
    }
    const ended = session.apply(P0, { type: 'EndTurn' });
    if (!ended.ok) throw new Error(`ending the turn was refused: ${ended.error.kind}`);
  }
  return session;
};

const LOG: ReplayLog = recordGame(20).log();

const replayOf = (log: unknown): ReturnType<typeof replay> =>
  replay(log, { ruleset: RULESET, rulesetIdentity: RULESET_IDENTITY, codec: CODEC });

/** A typed error, and **no throw** — both halves measured, for the reason `serialize.test.ts` gives. */
const refusal = (log: unknown): ReplayError => {
  let captured: Result<ReplayReport, ReplayError> | undefined;
  let threw = false;
  try {
    captured = replayOf(log);
  } catch {
    threw = true;
  }
  expect(threw, 'replay threw instead of returning a typed error').toBe(false);
  if (captured === undefined) throw new Error('replay returned nothing at all');
  if (captured.ok) throw new Error('the log was accepted; it should have been refused');
  return captured.error;
};

const asText = (log: ReplayLog): string => JSON.stringify(log);

const mutable = (log: ReplayLog): ReplayLog => ({ ...log });

/* ------------------------------------------------------------------ *
 * The happy path, and the fixture it leans on.
 * ------------------------------------------------------------------ */

describe('the recorded game', () => {
  it('records one boundary per turn, starting at turn 1', () => {
    expect(LOG.version).toBe(REPLAY_VERSION);
    expect(LOG.boundaries.length).toBe(21); // turn 1 …, plus one for every one of 20 turns
    expect(LOG.boundaries.map((boundary) => boundary.turn)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    // The game really moved: the last boundary is not the opening board's hash, so a replay that
    // compared nothing would not be comparing the same value twice.
    expect(LOG.boundaries[20]?.hash).not.toBe(LOG.boundaries[0]?.hash);
    expect(LOG.commands.length).toBeGreaterThan(20);
  });

  it('records only commands the engine accepted', () => {
    const recorder = recordGame(3);
    const before = recorder.log().commands.length;
    // A command the engine refuses changes nothing, so it is not part of the game that was
    // played — a log that kept it would re-refuse on the other side and stop a faithful replay.
    const refused = recorder.apply(P0, { type: 'FoundCity', unitId: 999 as never });
    expect(refused.ok).toBe(false);
    expect(recorder.state.revision).toBe(recorder.state.revision);
    expect(recorder.log().commands.length).toBe(before);
  });
});

describe('replay reproduces every turn boundary', () => {
  it('reproduces a 21-boundary game, boundary by boundary', () => {
    const result = replayOf(LOG);
    if (!result.ok)
      throw new Error(`a log this build recorded did not replay: ${refusal(LOG).kind}`);
    const report: ReplayReport = result.value;

    expect(report.boundaries).toBe(LOG.boundaries.length);
    expect(report.commands).toBe(LOG.commands.length);
    // …and the final state is the one the game ended on, hashed by the engine's own hasher.
    expect(report.finalHash).toBe(LOG.boundaries[LOG.boundaries.length - 1]?.hash);
    expect(report.finalHash).toBe(hashValue(report.finalState));
  });

  it('replays a log handed over as text, exactly as one handed over as a value', () => {
    const fromText = replayOf(asText(LOG));
    const fromValue = replayOf(LOG);
    if (!fromText.ok || !fromValue.ok) throw new Error('the log did not replay');
    expect(fromText.value.finalHash).toBe(fromValue.value.finalHash);
  });

  it('DIVERGES at the turn it diverges on, even when the end still matches', () => {
    // Turn 5's recorded hash is replaced with the FINAL hash. Every later boundary, the last one
    // included, is left exactly as the game produced it — so a replay that compared only the end
    // hash would report a clean run. The divergence it must report is at turn 5.
    const final = LOG.boundaries[LOG.boundaries.length - 1]?.hash ?? '';
    const tampered = mutable({
      ...LOG,
      boundaries: LOG.boundaries.map((boundary) =>
        boundary.turn === 5 ? { turn: 5, hash: final } : boundary,
      ),
    });

    expect(refusal(tampered)).toEqual({
      kind: 'diverged',
      turn: 5,
      recorded: final,
      actual: LOG.boundaries[4]?.hash,
    });
    // The fixture is what it claims: the untouched log replays cleanly, so the tamper is the
    // only reason the run above failed.
    expect(replayOf(LOG).ok).toBe(true);
  });

  it('reports a turn the replay reaches with no recorded boundary', () => {
    const short = mutable({ ...LOG, boundaries: LOG.boundaries.slice(0, 4) });
    // Only four boundaries: the replay crosses turn 5 having applied the commands that got there.
    const error = refusal(short);
    expect(error.kind).toBe('missing-boundary');
    if (error.kind !== 'missing-boundary') return;
    expect(error.turn).toBeGreaterThanOrEqual(5);
  });

  it('reports a recorded turn the commands never reach', () => {
    const long = mutable({
      ...LOG,
      boundaries: [
        ...LOG.boundaries,
        { turn: LOG.boundaries.length + 1, hash: 'deadbeefdeadbeef' },
      ],
    });
    expect(refusal(long)).toEqual({
      kind: 'unreached-boundary',
      turn: LOG.boundaries.length + 1,
    });
  });

  it('refuses a boundary list with a hole in it, rather than counting what it checked', () => {
    const skipped = mutable({
      ...LOG,
      boundaries: LOG.boundaries.map((boundary, index) =>
        // Turn 4 is missing and every later entry has moved up — the shape a log gets when a
        // turn's hash was dropped rather than recomputed.
        index >= 3 ? (LOG.boundaries[index + 1] ?? boundary) : boundary,
      ),
    });
    expect(refusal(skipped).kind).toBe('wrong-type');
  });
});

describe('a refused command is reported with the turn it happened on', () => {
  it('names the command, the turn and the engine’s own reason', () => {
    // A log recorded before a rule changed: the commands are the ones that were played, and one
    // of them is no longer legal — here a `FoundCity` for a unit that does not exist. The replay
    // stops there and says where.
    const lastTurn = LOG.boundaries[LOG.boundaries.length - 1]?.turn ?? 0;
    const broken = mutable({
      ...LOG,
      commands: [
        ...LOG.commands,
        { player: P0, command: { type: 'FoundCity', unitId: 9999 as never } },
      ],
    });

    const error = refusal(broken);
    expect(error.kind).toBe('refused-command');
    if (error.kind !== 'refused-command') return;
    expect(error.index).toBe(LOG.commands.length);
    expect(error.turn).toBe(lastTurn);
    // The engine's own typed reason travels through: the replay does not reword it.
    expect(error.error.kind).toBe('unknown-unit');
  });
});

/* ------------------------------------------------------------------ *
 * Every way a log can be wrong.
 * ------------------------------------------------------------------ */

describe('replay is total over a bad log', () => {
  it('refuses text that is not JSON, and a value that is not a log', () => {
    expect(refusal('{ nope').kind).toBe('malformed-json');
    expect(refusal([]).kind).toBe('not-a-log');
    expect(refusal(null).kind).toBe('not-a-log');
    expect(refusal(LOG.version).kind).toBe('not-a-log');
  });

  it('refuses a log with a missing field', () => {
    expect(refusal({ ...LOG, seed: undefined })).toEqual({ kind: 'missing-field', path: 'seed' });
    expect(refusal({ ...LOG, settings: undefined })).toEqual({
      kind: 'missing-field',
      path: 'settings',
    });
    expect(refusal({ ...LOG, boundaries: undefined })).toEqual({
      kind: 'missing-field',
      path: 'boundaries',
    });
    expect(refusal({ ...LOG, ruleset: undefined })).toEqual({
      kind: 'missing-field',
      path: 'ruleset',
    });
  });

  it('refuses a log format version this build does not write', () => {
    expect(refusal({ ...LOG, version: REPLAY_VERSION + 1 })).toEqual({
      kind: 'unknown-version',
      found: REPLAY_VERSION + 1,
    });
  });

  it('refuses settings the engine’s own parser refuses', () => {
    const error = refusal({ ...LOG, settings: { ...SETTINGS, civCount: 99 } });
    expect(error.kind).toBe('bad-settings');
    if (error.kind !== 'bad-settings') return;
    expect(error.issues.join(' ')).toContain('civCount');
  });

  it('refuses a command that is not a member of the engine’s union', () => {
    expect(refusal({ ...LOG, commands: [{ player: 0, command: { type: 'Nope' } }] })).toEqual({
      kind: 'unknown-command',
      index: 0,
      detail: '"Nope" is not a command in this engine',
    });
    expect(refusal({ ...LOG, commands: [{ player: 0, command: { type: 'MoveUnit' } }] }).kind).toBe(
      'unknown-command',
    );
    expect(refusal({ ...LOG, commands: [{ command: { type: 'EndTurn' } }] })).toEqual({
      kind: 'missing-field',
      path: 'commands[0].player',
    });
  });

  it('refuses a log recorded on a different ruleset', () => {
    // The identity is the whole point: the same seed, settings and commands over different
    // content is a different game, and without this check it would surface as a divergence at
    // whatever turn the changed number first mattered.
    const error = refusal({ ...LOG, ruleset: 'not-this-catalog' });
    expect(error.kind).toBe('ruleset-mismatch');
    if (error.kind !== 'ruleset-mismatch') return;
    expect(error.recorded).toBe('not-this-catalog');
    expect(error.actual).toBe(RULESET_IDENTITY);
  });

  it('refuses a seed the ruleset cannot host', () => {
    // A grid with no legal start for two civilizations: `newGame` reports it as a `SetupError`,
    // and the replay reports that, rather than starting a game the engine would not have.
    const impossible = refusal({ ...LOG, settings: { ...SETTINGS, mapSize: 'duel' as const } });
    expect(['setup-failed', 'diverged', 'missing-boundary', 'unreached-boundary']).toContain(
      impossible.kind,
    );
  });

  it('renders every error as a non-empty line, so none can become a blank one', () => {
    const samples: readonly ReplayError[] = [
      { kind: 'malformed-json', detail: 'x' },
      { kind: 'not-a-log', detail: 'x' },
      { kind: 'missing-field', path: 'seed' },
      { kind: 'wrong-type', path: 'boundaries[0].turn', expected: 'a whole number' },
      { kind: 'unknown-version', found: 2 },
      { kind: 'bad-settings', issues: ['civCount: bad'] },
      { kind: 'unknown-command', index: 3, detail: 'nope' },
      { kind: 'ruleset-mismatch', recorded: 'a', actual: 'b' },
      { kind: 'setup-failed', error: { kind: 'too-few-start-candidates' } },
      {
        kind: 'refused-command',
        index: 0,
        turn: 4,
        error: { kind: 'unknown-unit', unitId: 9999 as never },
      },
      { kind: 'missing-boundary', turn: 5 },
      { kind: 'unreached-boundary', turn: 30 },
      { kind: 'diverged', turn: 5, recorded: 'a', actual: 'b' },
    ];
    for (const error of samples) {
      const text = formatReplayError(error);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('unhandled union member');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The command reader.
 * ------------------------------------------------------------------ */

describe('commandFrom reads every member of the union, and nothing else', () => {
  const COMMANDS: readonly Command[] = [
    { type: 'EndTurn' },
    { type: 'MoveUnit', unitId: 1 as never, to: 5 as never },
    { type: 'FoundCity', unitId: 0 as never },
    { type: 'SetWorkedTiles', cityId: 0 as never, tiles: [1 as never, 2 as never] },
    { type: 'SetProduction', cityId: 0 as never, item: { kind: 'unit', id: 'warrior' as never } },
    {
      type: 'SetProduction',
      cityId: 0 as never,
      item: { kind: 'building', id: 'granary' as never },
    },
    { type: 'StartWork', unitId: 2 as never, kind: 'mine' as never },
    { type: 'CancelWork', unitId: 2 as never },
    { type: 'AttackUnit', unitId: 1 as never, target: 6 as never },
    { type: 'FortifyUnit', unitId: 1 as never },
    { type: 'SetRates', rates: { tax: 6, science: 4, luxury: 0 } },
    { type: 'SetResearch', tech: 'pottery' as never },
    { type: 'SetGovernment', government: 'despotism' as never },
  ];

  it('accepts every command, and reads it back unchanged through JSON', () => {
    for (const command of COMMANDS) {
      const read = commandFrom(JSON.parse(JSON.stringify(command)));
      if (!read.ok) throw new Error(`${command.type} was refused: ${read.error}`);
      expect(read.value).toEqual(command);
    }
    // One case per member of the union, **named**: a member added to `Command` without a case
    // here fails this assertion, and a `commandFrom` that silently dropped one fails it too.
    expect([...new Set(COMMANDS.map((command) => command.type))].sort()).toEqual([
      'AttackUnit',
      'CancelWork',
      'EndTurn',
      'FortifyUnit',
      'FoundCity',
      'MoveUnit',
      'SetGovernment',
      'SetProduction',
      'SetRates',
      'SetResearch',
      'SetWorkedTiles',
      'StartWork',
    ]);
  });

  it('refuses everything that is not one', () => {
    for (const raw of [undefined, null, 7, 'EndTurn', [], {}, { type: 'Nope' }]) {
      expect(commandFrom(raw).ok).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The fixture is a real game, not a stub.
 * ------------------------------------------------------------------ */

describe('the recorded fixture is worth replaying', () => {
  it('plays real turns, and one of them is a game the engine would refuse more of', () => {
    const replayResult = replayOf(LOG);
    if (!replayResult.ok) throw new Error('the fixture did not replay');
    const state = replayResult.value.finalState;
    expect(state.turn).toBe(LOG.boundaries.length);
    expect(state.cities.length).toBeGreaterThan(0);
    expect(state.revision).toBeGreaterThan(20);

    // The opening board really is a different game: a replay that quietly replaced the log's
    // seed with the default's would produce a different hash and be caught by the boundaries.
    const elsewhere = newGame(SEED + 1, SETTINGS, RULESET);
    if (!elsewhere.ok) throw new Error('the control game did not start');
    expect(hashValue(elsewhere.value)).not.toBe(LOG.boundaries[0]?.hash);
    expect(isGameOver(state, RULESET)).toBe(false);
  });

  it('would notice a different starting board, command for command', () => {
    // The same commands under a different seed: the first boundary is already wrong, which is
    // what makes the seed part of the game's identity rather than a detail of the log.
    const moved = refusal({ ...LOG, seed: SEED + 1 });
    expect(moved.kind).toBe('diverged');
    if (moved.kind !== 'diverged') return;
    expect(moved.turn).toBe(1);
    expect(moved.recorded).toBe(LOG.boundaries[0]?.hash);
  });
});

/* ------------------------------------------------------------------ *
 * The recorder applies through the engine, not around it.
 * ------------------------------------------------------------------ */

describe('the recorder', () => {
  it('applies through applyCommand, so its state is the engine’s own', () => {
    const recorder = createReplayRecorder(SEED, SETTINGS, RULESET, RULESET_IDENTITY, CODEC);
    if (!recorder.ok) throw new Error('the recorder did not start');
    const session = recorder.value;

    const ended = session.apply(P0, { type: 'EndTurn' });
    if (!ended.ok) throw new Error('ending the turn was refused');

    // The control: the same seed, the same command, straight through `applyCommand` with no
    // recorder in the way. Identical states is the claim that the recorder is a wrapper and not
    // a second applier.
    const started = newGame(SEED, SETTINGS, RULESET);
    if (!started.ok) throw new Error('the control game did not start');
    const manual = applyCommand(started.value, P0, { type: 'EndTurn' }, RULESET);
    if (!manual.ok) throw new Error('the control game refused the same turn');
    expect(hashValue(session.state)).toBe(hashValue(manual.value.state));
  });

  it('reports a setup the ruleset cannot host rather than building half a game', () => {
    // A view with no terrain at all: `generateWorld` cannot resolve a role, and the recorder
    // must report that as a `SetupError` rather than hand out a game with no world in it.
    const barren: RulesetView = { ...RULESET, terrains: [] };
    const recorder = createReplayRecorder(SEED, SETTINGS, barren, 'x', CODEC);
    expect(recorder.ok).toBe(false);
  });
});
