/**
 * **Replay.** A game is `(seed, settings, ruleset identity, command log)`, and `replay` re-runs
 * that tuple and checks it against the hashes the log recorded.
 * See docs/INTERFACES.md, M11 ("Replay"):
 *
 * > A game is `(seed, settings, ruleset identity, command log)`. `replay(log)` re-runs it and must
 * > reproduce the recorded hash at **every turn boundary, not just at the end** — a divergence at
 * > turn 5 that reconverges by turn 20 is still a divergence. A command the engine now refuses
 * > must be reported **with the turn it happened**, not swallowed.
 *
 * ## Why every boundary, and not the final hash
 *
 * The final hash is the one check that cannot be fooled *and* the one that proves the least: a
 * game that diverges at turn 5 and reconverges by turn 20 — a rounding difference that cancels, a
 * command rejected here and accepted there, a RNG draw consumed and returned — ends on the
 * recorded hash and is a different game. Worse, when it does *not* reconverge, a final-hash-only
 * check reports "the run diverged" and nothing else: no turn, no command, no state to look at.
 * This module therefore compares at **every** boundary the log records, and stops at the first
 * disagreement so the report names the turn it happened on.
 *
 * ## The log
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "ruleset": "5f2a…",                     // the ruleset's own digest: hashValue(validated catalog)
 *   "seed": 42,
 *   "settings": { … },                      // fed through `parseSettings`, never trusted
 *   "commands": [ { "player": 0, "command": { "type": "EndTurn" } }, … ],
 *   "boundaries": [ { "turn": 1, "hash": "…" }, { "turn": 2, "hash": "…" }, … ]
 * }
 * ```
 *
 * - **`player` rides on each command** because the engine's applier takes the actor as an
 *   argument and the state does not record who issued what. A log that named one actor for the
 *   whole game would be unable to express anything else, and `applyCommand`'s answer genuinely
 *   depends on the actor (`not-your-unit`), so the actor is part of the input, not decoration.
 * - **`boundaries` has one entry per turn, starting at turn 1** — the state before any command
 *   is issued. `turn` is `index + 1` and the log is rejected if it is not, because a gap is a
 *   turn whose hash nobody recorded, and "no record" and "recorded and matching" render
 *   identically in a report that only counts what it checked.
 * - **`ruleset` is an identity, not a name.** `hashValue(validateRuleset(catalog))` is what
 *   `@civts/sim`'s ruleset-identity test pins, and it is the only thing that can tell a replay
 *   it is being run against different content: the same seed, settings and commands over a
 *   catalog with one number changed is a different game, and it would otherwise be reported as
 *   a divergence at whatever turn the changed number first mattered.
 *
 * ## Totality
 *
 * `replay` takes `unknown` and returns `Result`, like `deserialize`: a log off a disk is
 * untrusted input, and every way it can be wrong — not JSON, not a log, a bad setting, a command
 * that is not a member of the union, a ruleset that does not match, a setup the ruleset cannot
 * host, a command the engine now refuses, a missing boundary, a turn the log claims and the
 * commands never reach, and a hash that disagrees — is a `ReplayError` value.
 *
 * ## The recorder
 *
 * `createReplayRecorder` is the other half: it applies commands through the engine's own
 * `applyCommand` while recording each one and each boundary it crosses, so the log a caller
 * writes is the log this module can check. It exists so that nothing else has to know what a
 * boundary is — the one place that decides is the one place that checks.
 */

import { applyCommand, type Command, type CommandOutcome, type GameError } from './commands.js';
import {
  asBuildingId,
  asCityId,
  asGovernmentId,
  asPlayerId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type CityId,
  type PlayerId,
  type TileIndex,
  type UnitId,
} from './ids.js';
import type { ProductionItem } from './cities.js';
import { asImprovementId } from './improvements.js';
import { newGame, type GameState, type SetupError } from './state.js';
import { parseSettings, type Settings } from './settings.js';
import { err, ok, type Result } from './result.js';
import { assertNever, type SaveCodec } from './serialize.js';
import type { RulesetView } from './map.js';

/** The replay log's own format version — separate from the save envelope and from the schema. */
export const REPLAY_VERSION = 1;

/** One recorded command: what was issued, and by whom. */
export interface RecordedCommand {
  readonly player: PlayerId;
  readonly command: Command;
}

/** The hash at one turn boundary. */
export interface ReplayBoundary {
  /** The state's `turn` at this boundary; the first is 1. */
  readonly turn: number;
  readonly hash: string;
}

/** A whole game, as data. Everything needed to reproduce it and to check that it was reproduced. */
export interface ReplayLog {
  readonly version: number;
  /** The ruleset's digest — `codec.hash(validatedRuleset)`. */
  readonly ruleset: string;
  readonly seed: number;
  readonly settings: Settings;
  readonly commands: readonly RecordedCommand[];
  readonly boundaries: readonly ReplayBoundary[];
}

/** What a replay that reproduced every recorded boundary reports. */
export interface ReplayReport {
  readonly seed: number;
  /** How many turn boundaries were compared. */
  readonly boundaries: number;
  /** How many commands were applied. */
  readonly commands: number;
  readonly finalHash: string;
  readonly finalState: GameState;
}

/**
 * Every way a replay can fail. The two that matter most are `diverged` (with the **turn**) and
 * `refused-command` (with the **turn** the engine said no on) — the contract's whole point is
 * that neither is swallowed into a single "the replay failed".
 */
export type ReplayError =
  | { readonly kind: 'malformed-json'; readonly detail: string }
  | { readonly kind: 'not-a-log'; readonly detail: string }
  | { readonly kind: 'missing-field'; readonly path: string }
  | { readonly kind: 'wrong-type'; readonly path: string; readonly expected: string }
  | { readonly kind: 'unknown-version'; readonly found: number }
  | { readonly kind: 'bad-settings'; readonly issues: readonly string[] }
  /** A command in the log is not a member of the engine's command union. */
  | { readonly kind: 'unknown-command'; readonly index: number; readonly detail: string }
  | { readonly kind: 'ruleset-mismatch'; readonly recorded: string; readonly actual: string }
  | { readonly kind: 'setup-failed'; readonly error: SetupError }
  /** The engine refused a recorded command — reported with the turn it happened on. */
  | {
      readonly kind: 'refused-command';
      readonly index: number;
      readonly turn: number;
      readonly error: GameError;
    }
  /** The replay reached a turn boundary the log has no hash for. */
  | { readonly kind: 'missing-boundary'; readonly turn: number }
  /** The log records boundaries the commands never reach. */
  | { readonly kind: 'unreached-boundary'; readonly turn: number }
  /** The hash reproduced at a boundary is not the one the log recorded. */
  | {
      readonly kind: 'diverged';
      readonly turn: number;
      readonly recorded: string;
      readonly actual: string;
    };

export interface ReplayOptions {
  /** The live ruleset the log is to be replayed against. */
  readonly ruleset: RulesetView;
  /** The live ruleset's digest, to compare against the log's. */
  readonly rulesetIdentity: string;
  /** The engine's hasher — `SaveCodec.hash`, the same function the goldens use. */
  readonly codec: SaveCodec;
}

/* ------------------------------------------------------------------ *
 * Reading, and refusing to guess.
 * ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? Array.from<unknown>(value) : undefined;

const numberAt = (source: Record<string, unknown>, key: string): number | undefined => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const stringAt = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Validate one member of the engine's command union out of an untrusted value.
 *
 * This is the **one** reader of "what is a `Command`" in this tree: the web's seam
 * (`packages/web/src/testapi.ts`) delegates to it rather than keeping a second switch, because
 * the two readers would have to agree about every field of every member, and the M9 defect they
 * would disagree about is already on record — `SetGovernment` was accepted by the engine, built
 * correctly by its panel, and refused by a seam reader that had no case for it, so the control
 * dispatched nothing at all.
 */
export const commandFrom = (raw: unknown): Result<Command, string> => {
  if (!isRecord(raw)) return err('a command must be an object');
  const type = stringAt(raw, 'type');
  const unit = (): Result<UnitId, string> => {
    const id = numberAt(raw, 'unitId');
    return id === undefined ? err('needs a numeric "unitId"') : ok(asUnitId(id));
  };
  const city = (): Result<CityId, string> => {
    const id = numberAt(raw, 'cityId');
    return id === undefined ? err('needs a numeric "cityId"') : ok(asCityId(id));
  };
  const tile = (key: string): Result<TileIndex, string> => {
    const value = numberAt(raw, key);
    return value === undefined ? err(`needs a numeric "${key}"`) : ok(asTileIndex(value));
  };

  switch (type) {
    case 'EndTurn':
      return ok({ type: 'EndTurn' });
    case 'MoveUnit': {
      const unitId = unit();
      if (!unitId.ok) return unitId;
      const to = tile('to');
      if (!to.ok) return to;
      return ok({ type: 'MoveUnit', unitId: unitId.value, to: to.value });
    }
    case 'FoundCity': {
      const unitId = unit();
      return unitId.ok ? ok({ type: 'FoundCity', unitId: unitId.value }) : unitId;
    }
    case 'StartWork': {
      const unitId = unit();
      if (!unitId.ok) return unitId;
      const kind = stringAt(raw, 'kind');
      if (kind === undefined) return err('needs a string "kind"');
      return ok({ type: 'StartWork', unitId: unitId.value, kind: asImprovementId(kind) });
    }
    case 'CancelWork': {
      const unitId = unit();
      return unitId.ok ? ok({ type: 'CancelWork', unitId: unitId.value }) : unitId;
    }
    case 'AttackUnit': {
      const unitId = unit();
      if (!unitId.ok) return unitId;
      const target = tile('target');
      if (!target.ok) return target;
      return ok({ type: 'AttackUnit', unitId: unitId.value, target: target.value });
    }
    case 'FortifyUnit': {
      const unitId = unit();
      return unitId.ok ? ok({ type: 'FortifyUnit', unitId: unitId.value }) : unitId;
    }
    case 'SetProduction': {
      const cityId = city();
      if (!cityId.ok) return cityId;
      const item = productionItemFrom(raw['item']);
      if (!item.ok) return item;
      return ok({ type: 'SetProduction', cityId: cityId.value, item: item.value });
    }
    case 'SetWorkedTiles': {
      const cityId = city();
      if (!cityId.ok) return cityId;
      const tiles = asArray(raw['tiles']);
      if (tiles === undefined) return err('needs a list of tile indices');
      const indices: number[] = [];
      for (const entry of tiles) {
        const value = typeof entry === 'number' && Number.isFinite(entry) ? entry : undefined;
        if (value === undefined) return err('every entry of "tiles" must be a number');
        indices.push(value);
      }
      return ok({
        type: 'SetWorkedTiles',
        cityId: cityId.value,
        tiles: indices.map((index) => asTileIndex(index)),
      });
    }
    case 'SetRates': {
      const rates = raw['rates'];
      if (!isRecord(rates)) return err('needs a "rates" object');
      const tax = numberAt(rates, 'tax');
      const science = numberAt(rates, 'science');
      const luxury = numberAt(rates, 'luxury');
      if (tax === undefined || science === undefined || luxury === undefined) {
        return err('"rates" needs numeric tax, science and luxury');
      }
      return ok({ type: 'SetRates', rates: { tax, science, luxury } });
    }
    case 'SetResearch': {
      const tech = stringAt(raw, 'tech');
      return tech === undefined
        ? err('needs a string "tech"')
        : ok({ type: 'SetResearch', tech: asTechId(tech) });
    }
    case 'SetGovernment': {
      const government = stringAt(raw, 'government');
      return government === undefined
        ? err('needs a string "government"')
        : ok({ type: 'SetGovernment', government: asGovernmentId(government) });
    }
    default:
      return err(`"${type ?? 'undefined'}" is not a command in this engine`);
  }
};

const productionItemFrom = (value: unknown): Result<ProductionItem, string> => {
  if (!isRecord(value)) return err('a production item must be an object');
  const id = stringAt(value, 'id');
  const kind = stringAt(value, 'kind');
  if (id === undefined) return err('a production item needs a string "id"');
  if (kind === 'unit') return ok({ kind: 'unit', id: asUnitTypeId(id) });
  if (kind === 'building') return ok({ kind: 'building', id: asBuildingId(id) });
  return err('a production item\'s "kind" must be "unit" or "building"');
};

const boundaryProblem = (value: unknown, index: number): ReplayError | ReplayBoundary => {
  const path = `boundaries[${String(index)}]`;
  if (!isRecord(value)) return { kind: 'wrong-type', path, expected: 'an object' };
  const turn = numberAt(value, 'turn');
  if (turn === undefined) return { kind: 'missing-field', path: `${path}.turn` };
  if (!Number.isInteger(turn) || turn !== index + 1) {
    // One entry per turn, starting at turn 1, in order. A log that skipped a turn would make
    // "every turn boundary was reproduced" a claim about the turns somebody happened to record.
    return {
      kind: 'wrong-type',
      path: `${path}.turn`,
      expected: `the whole number ${String(index + 1)} (one boundary per turn, in order)`,
    };
  }
  const hash = stringAt(value, 'hash');
  if (hash === undefined) return { kind: 'missing-field', path: `${path}.hash` };
  return { turn, hash };
};

const readLog = (raw: unknown): Result<ReplayLog, ReplayError> => {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return err({
        kind: 'malformed-json',
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  if (!isRecord(parsed)) {
    return err({ kind: 'not-a-log', detail: 'the replay log is not an object' });
  }

  const version = numberAt(parsed, 'version');
  if (version === undefined) return err({ kind: 'missing-field', path: 'version' });
  if (version !== REPLAY_VERSION) return err({ kind: 'unknown-version', found: version });

  const ruleset = stringAt(parsed, 'ruleset');
  if (ruleset === undefined) return err({ kind: 'missing-field', path: 'ruleset' });

  const seed = numberAt(parsed, 'seed');
  if (seed === undefined || !Number.isInteger(seed)) {
    return err({ kind: 'missing-field', path: 'seed' });
  }

  const settings = parsed['settings'];
  if (settings === undefined) return err({ kind: 'missing-field', path: 'settings' });
  const parsedSettings = parseSettings(settings);
  if (!parsedSettings.ok) {
    return err({
      kind: 'bad-settings',
      issues: parsedSettings.error.map((issue) => `${issue.path}: ${issue.message}`),
    });
  }

  const rawCommands = asArray(parsed['commands']);
  if (rawCommands === undefined) return err({ kind: 'missing-field', path: 'commands' });
  const commands: RecordedCommand[] = [];
  for (const [index, entry] of rawCommands.entries()) {
    if (!isRecord(entry)) {
      return err({ kind: 'unknown-command', index, detail: 'the entry is not an object' });
    }
    const player = numberAt(entry, 'player');
    if (player === undefined || !Number.isInteger(player) || player < 0) {
      return err({ kind: 'missing-field', path: `commands[${String(index)}].player` });
    }
    const command = commandFrom(entry['command']);
    if (!command.ok) {
      return err({ kind: 'unknown-command', index, detail: command.error });
    }
    commands.push({ player: asPlayerId(player), command: command.value });
  }

  const rawBoundaries = asArray(parsed['boundaries']);
  if (rawBoundaries === undefined) return err({ kind: 'missing-field', path: 'boundaries' });
  const boundaries: ReplayBoundary[] = [];
  for (const [index, entry] of rawBoundaries.entries()) {
    const boundary = boundaryProblem(entry, index);
    if ('kind' in boundary) return err(boundary);
    boundaries.push(boundary);
  }
  if (boundaries.length === 0) {
    return err({
      kind: 'missing-field',
      path: 'boundaries (a log with no boundary proves nothing)',
    });
  }

  return ok({ version, ruleset, seed, settings: parsedSettings.value, commands, boundaries });
};

/* ------------------------------------------------------------------ *
 * Running it.
 * ------------------------------------------------------------------ */

/**
 * Re-run a recorded game and check it against every boundary the log recorded.
 *
 * `log` is either the log text or an already-parsed value, exactly as `deserialize` takes a save.
 */
export const replay = (log: unknown, options: ReplayOptions): Result<ReplayReport, ReplayError> => {
  const read = readLog(log);
  if (!read.ok) return read;
  const record = read.value;

  if (options.rulesetIdentity !== record.ruleset) {
    return err({
      kind: 'ruleset-mismatch',
      recorded: record.ruleset,
      actual: options.rulesetIdentity,
    });
  }

  const started = newGame(record.seed, record.settings, options.ruleset);
  if (!started.ok) return err({ kind: 'setup-failed', error: started.error });

  let state = started.value;
  let verified = 0;

  /** Compare the state as it stands against the boundary recorded for its turn. */
  const checkBoundary = (): ReplayError | undefined => {
    const boundary = record.boundaries[verified];
    if (boundary === undefined || boundary.turn !== state.turn) {
      return { kind: 'missing-boundary', turn: state.turn };
    }
    const actual = options.codec.hash(state);
    if (actual !== boundary.hash) {
      return { kind: 'diverged', turn: state.turn, recorded: boundary.hash, actual };
    }
    verified += 1;
    return undefined;
  };

  const opening = checkBoundary();
  if (opening !== undefined) return err(opening);

  for (const [index, entry] of record.commands.entries()) {
    const turn = state.turn;
    const applied = applyCommand(state, entry.player, entry.command, options.ruleset);
    if (!applied.ok) {
      // NOT swallowed and NOT reworded: the engine's own typed `GameError`, with the turn the
      // refusal happened on, so "a command this build no longer accepts" is distinguishable
      // from "the game diverged" — they need different fixes.
      return err({ kind: 'refused-command', index, turn, error: applied.error });
    }
    const before = state.turn;
    state = applied.value.state;
    if (state.turn !== before) {
      const problem = checkBoundary();
      if (problem !== undefined) return err(problem);
    }
  }

  // The log claims turns the commands never reach: the game stopped early (a finished game, a
  // shorter catalog) or the log is longer than the game it describes. Either way the un-reached
  // boundaries were never checked, and reporting them as reproduced would be a lie.
  if (verified < record.boundaries.length) {
    return err({ kind: 'unreached-boundary', turn: verified + 1 });
  }

  return ok({
    seed: record.seed,
    boundaries: verified,
    commands: record.commands.length,
    finalHash: options.codec.hash(state),
    finalState: state,
  });
};

/* ------------------------------------------------------------------ *
 * Recording one.
 * ------------------------------------------------------------------ */

export interface ReplayRecorder {
  /** The state as it now stands. Replaced wholesale by every applied command. */
  readonly state: GameState;
  /** Apply a command: on success it is recorded, on refusal the engine's reason comes back. */
  readonly apply: (player: PlayerId, command: Command) => Result<CommandOutcome, GameError>;
  /** The game so far, as a log `replay` can check. */
  readonly log: () => ReplayLog;
}

/**
 * Start recording a game.
 *
 * The recorder applies through the engine's own `applyCommand` and records **only what was
 * accepted**: a refused command changed nothing, so a log carrying it would re-refuse on the
 * other side and stop a replay that is in fact a faithful reproduction of the game that was
 * played. That is the difference between "the log is the game" and "the log is the keystrokes",
 * and this module's contract is the first.
 *
 * A boundary is recorded whenever the state's turn changes — never by counting `EndTurn`s,
 * because a turn can be ended by a command that does not advance it (`EndTurn` on a finished
 * game is a no-op) and a `turn + 1` predicted here would be a second opinion about what the
 * pipeline does.
 */
export const createReplayRecorder = (
  seed: number,
  settings: Settings,
  ruleset: RulesetView,
  rulesetIdentity: string,
  codec: SaveCodec,
): Result<ReplayRecorder, SetupError> => {
  const started = newGame(seed, settings, ruleset);
  if (!started.ok) return err(started.error);

  let state = started.value;
  const commands: RecordedCommand[] = [];
  const boundaries: ReplayBoundary[] = [{ turn: state.turn, hash: codec.hash(state) }];

  return ok({
    get state(): GameState {
      return state;
    },
    apply: (player, command) => {
      const outcome = applyCommand(state, player, command, ruleset);
      if (!outcome.ok) return outcome;
      commands.push({ player, command });
      const before = state.turn;
      state = outcome.value.state;
      if (state.turn !== before) {
        boundaries.push({ turn: state.turn, hash: codec.hash(state) });
      }
      return outcome;
    },
    log: () => ({
      version: REPLAY_VERSION,
      ruleset: rulesetIdentity,
      seed,
      settings,
      commands,
      boundaries,
    }),
  });
};

/* ------------------------------------------------------------------ *
 * Rendering.
 * ------------------------------------------------------------------ */

/**
 * One replay error, as one line. The switch has no `default` clause and ends at `assertNever`,
 * so a new `ReplayError` member stops the build instead of printing a blank line — the failure
 * shape M3 shipped once (`repl.ts`' event rendering) and M11 exists to not repeat.
 *
 * `refused-command` deliberately renders only the engine's `kind` here; the full explanation
 * (with the legal alternatives) is `repl.ts`' `formatGameError`, which is the one renderer of a
 * `GameError` and takes the context a bare line lacks.
 */
export const formatReplayError = (error: ReplayError): string => {
  switch (error.kind) {
    case 'malformed-json':
      return `the replay log is not JSON: ${error.detail}`;
    case 'not-a-log':
      return `the replay log is not a replay log: ${error.detail}`;
    case 'missing-field':
      return `the replay log has no ${error.path}`;
    case 'wrong-type':
      return `${error.path} is not ${error.expected}`;
    case 'unknown-version':
      return `replay format version ${String(error.found)} is not the one this build writes (${String(REPLAY_VERSION)})`;
    case 'bad-settings':
      return `the log's settings do not parse: ${error.issues.join('; ')}`;
    case 'unknown-command':
      return `commands[${String(error.index)}] is not a command this engine has: ${error.detail}`;
    case 'ruleset-mismatch':
      return `the log was recorded on ruleset ${error.recorded} and this build is ${error.actual}`;
    case 'setup-failed':
      return `the log's world cannot be built: ${error.error.kind}`;
    case 'refused-command':
      return `the engine refused commands[${String(error.index)}] on turn ${String(error.turn)}: ${error.error.kind}`;
    case 'missing-boundary':
      return `turn ${String(error.turn)} was reached and the log records no hash for it`;
    case 'unreached-boundary':
      return `the log records turn ${String(error.turn)}, which the commands never reach`;
    case 'diverged':
      return `turn ${String(error.turn)} diverged: the log recorded ${error.recorded}, this run produced ${error.actual}`;
  }
  // Reached only when every member above was handled — see `formatSaveError` for why this is a
  // `never` tail rather than a `default` clause.
  return assertNever(error);
};
