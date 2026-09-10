#!/usr/bin/env node
/**
 * CivTS headless CLI. See PLAN.md 8.1.
 *
 * This is the agent's primary interface to the game: text in, text out, no
 * browser and no eyes required. Subcommands land as milestones land — M0 ships
 * `provenance`, M1 ships `map` (a rendered world plus its state hash), M2 ships
 * `play` (the REPL, implemented in `repl.ts`).
 *
 * Two properties the `map` command is expected to hold, because everything else
 * is built on them:
 *
 * - **It is the same engine the tests run.** Settings go through
 *   `loadSettings` (defaults → CLI layer → parse), the ruleset through
 *   `validateRuleset`, and the world through `newGame` — no CLI-only path, so a
 *   hash printed here is the hash the golden harness would compute.
 * - **Flags are parsed, never guessed.** A non-numeric or NaN-looking value is
 *   an error with a non-zero exit, not a silent fallback to the default; a typo
 *   must not quietly produce a different world than the one asked for.
 */

import {
  MAP_SIZES,
  describe,
  err,
  loadSettings,
  newGame,
  ok,
  type MapSize,
  type Result,
  type RulesetView,
  type SettingsIssue,
} from '@civts/core';
import {
  CATALOG,
  provenanceSections,
  summarizeProvenance,
  validateRuleset,
  type ProvenanceRow,
  type ProvenanceSection,
  type RulesetError,
} from '@civts/rules';
import { hashValue } from '@civts/testing';

import {
  PLAY_USAGE,
  createSession,
  formatSetupError,
  parseIntFlag,
  parsePlayArgs,
  readScript,
  runInteractive,
  runScript,
} from './repl.js';

const USAGE = `civts — headless tooling

Usage: civts <command> [options]

Commands:
  provenance   print every rules-data row's provenance (terrains and units)
  map          generate a world, render it as ASCII, print its state hash
  play         interactive text REPL: play the game from a terminal or a script
  run          headless AI-vs-AI game                     (arrives in M7)

Options:
  -h, --help   show this help

map options:
  --seed <int>        world seed                          (default: 1)
  --map-size <size>   ${MAP_SIZES.join('|')}  (default: tiny)
  --civs <int>        number of civilizations, 2..16       (default: 2)

play options:
  --seed <int>        world seed                          (default: 1)
  --map-size <size>   ${MAP_SIZES.join('|')}  (default: tiny)
  --civs <int>        number of civilizations, 2..16       (default: 2)
  --player <int>      which civilization you play, 0-based (default: 0)
  --script <file>     run a command file, print the transcript, exit 0

Examples:
  pnpm map --seed 42
  pnpm play --seed 42 --map-size tiny --civs 2 --player 0
  pnpm play --seed 42 --script session.txt
`;

const MAP_USAGE = `usage: civts map [--seed <int>] [--map-size <size>] [--civs <int>]

  --seed <int>        world seed (any integer; default 1)
  --map-size <size>   one of ${MAP_SIZES.join('|')} (default tiny)
  --civs <int>        number of civilizations, 2..16 (default 2)
`;

const formatError = (e: RulesetError): string => {
  switch (e.kind) {
    case 'empty-catalog':
      return `empty catalog: ${e.catalog}`;
    case 'duplicate-id':
      return `duplicate id in ${e.catalog}: ${e.id}`;
    case 'placeholder-in-cited-only':
      return `placeholder row in cited-only mode: ${e.catalog}/${e.id} (${e.note})`;
    case 'invalid-value':
      return `invalid value: ${e.catalog}/${e.id}.${e.field} — ${e.detail}`;
    case 'missing-role':
      return `no terrain fills role "${e.role}"`;
  }
};

/** Width of the provenance kind column: `placeholder` is the longest kind. */
const PROVENANCE_KIND_WIDTH = 11;

/**
 * One section's rows as table lines: `id`, the provenance kind, then the claim
 * itself — a cited row's source, or a placeholder row's note, exactly as before.
 * The detail is the last cell, so it is never padded and never truncated.
 */
const provenanceRowLines = (rows: readonly ProvenanceRow[], idWidth: number): readonly string[] =>
  rows.map((row) => {
    const p = row.provenance;
    const detail = p.kind === 'cited' ? p.source : p.note;
    return `  ${row.id.padEnd(idWidth)}  ${p.kind.padEnd(PROVENANCE_KIND_WIDTH)}  ${detail}`;
  });

/** A section's heading, stating the counts of the rows printed under it. */
const provenanceSectionLines = (section: ProvenanceSection, idWidth: number): readonly string[] => [
  `${section.name} — ${String(section.summary.total)} ` +
    `${section.summary.total === 1 ? 'row' : 'rows'}, ` +
    `${String(section.summary.cited)} cited, ` +
    `${String(section.summary.placeholder)} placeholder`,
  ...provenanceRowLines(section.rows, idWidth),
];

/**
 * The provenance report: the cited-vs-placeholder ratio (PLAN.md §6.2) followed
 * by every row the ratio was counted over.
 *
 * The table iterates `provenanceSections` and the header total is the sum of
 * those same sections (`summarizeProvenance` adds up nothing else), so the rows
 * printed *are* the rows counted — there is no second list that could fall out
 * of step. That is not decoration: when this command printed only the terrain
 * table under a total that already included the unit rows, it reported
 * "0/11 cited" above six rows, and a provenance report that overstates its own
 * coverage is the precise half-truth PLAN.md §6.2 exists to prevent.
 */
const commandProvenance = (): number => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    for (const e of validated.error) console.error(`ruleset error: ${formatError(e)}`);
    return 1;
  }

  const summary = summarizeProvenance(CATALOG);
  const pct = summary.total === 0 ? 0 : Math.round((summary.cited / summary.total) * 100);
  console.log(
    `ruleset provenance — ${String(summary.cited)}/${String(summary.total)} cited (${String(pct)}%), ${String(summary.placeholder)} placeholder`,
  );
  console.log('');

  const sections = provenanceSections(CATALOG);
  // One width for every id in every section, so the kinds and the claims line up
  // across the whole report rather than jumping between tables.
  const idWidth = sections
    .flatMap((section) => section.rows)
    .reduce((width, row) => Math.max(width, row.id.length), 0);

  for (const [index, section] of sections.entries()) {
    if (index > 0) console.log('');
    for (const line of provenanceSectionLines(section, idWidth)) console.log(line);
  }

  console.log('');
  console.log('cited-only mode is expected to FAIL until rows are traced to sources.');
  return 0;
};

/* ------------------------------------------------------------------ *
 * `map` — settings, world, text view, state hash.
 * ------------------------------------------------------------------ */

/** Flags as parsed — absent means "leave the default alone", not "zero". */
interface MapFlags {
  readonly seed: number | undefined;
  readonly mapSize: MapSize | undefined;
  readonly civCount: number | undefined;
}

const parseMapArgs = (args: readonly string[]): Result<MapFlags, string> => {
  let seed: number | undefined;
  let mapSize: MapSize | undefined;
  let civCount: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined) break;

    if (flag !== '--seed' && flag !== '--map-size' && flag !== '--civs') {
      return err(`unknown option for map: "${flag}"`);
    }

    const raw = args[i + 1];
    if (raw === undefined) return err(`${flag} needs a value`);
    i += 1; // consume the value

    if (flag === '--map-size') {
      const size = MAP_SIZES.find((candidate) => candidate === raw);
      if (size === undefined) {
        return err(`--map-size expects one of ${MAP_SIZES.join('|')}, got "${raw}"`);
      }
      mapSize = size;
      continue;
    }

    const value = parseIntFlag(flag, raw);
    if (!value.ok) return err(value.error);
    if (flag === '--seed') seed = value.value;
    else civCount = value.value;
  }

  return ok({ seed, mapSize, civCount });
};

const formatSettingsIssue = (issue: SettingsIssue): string =>
  `${issue.path === '' ? '<root>' : issue.path}: ${issue.message}`;

/**
 * The one place output goes. `process.exitCode` (never `process.exit`) is used by
 * `main`'s caller so that stdout is fully flushed before the process ends —
 * a truncated transcript would be worse than no transcript for a regression test.
 */
const writeOut = (text: string): void => {
  process.stdout.write(text);
};

const commandMap = (args: readonly string[]): number => {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(MAP_USAGE);
    return 0;
  }

  const flags = parseMapArgs(args);
  if (!flags.ok) {
    console.error(`error: ${flags.error}`);
    console.error('');
    console.error(MAP_USAGE);
    return 2;
  }

  // Only flags that were actually given become a layer: `loadSettings` merges
  // over `DEFAULT_SETTINGS` and then *parses*, so unknown keys and out-of-range
  // values are rejected rather than silently accepted.
  const layer: Record<string, unknown> = {};
  if (flags.value.seed !== undefined) layer['seed'] = flags.value.seed;
  if (flags.value.mapSize !== undefined) layer['mapSize'] = flags.value.mapSize;
  if (flags.value.civCount !== undefined) layer['civCount'] = flags.value.civCount;

  const settings = loadSettings(layer);
  if (!settings.ok) {
    for (const issue of settings.error)
      console.error(`settings error: ${formatSettingsIssue(issue)}`);
    return 2;
  }

  const validated = validateRuleset(CATALOG, settings.value.fidelity);
  if (!validated.ok) {
    for (const e of validated.error) console.error(`ruleset error: ${formatError(e)}`);
    return 1;
  }

  // `validated.value` is a `Ruleset`, and a `Ruleset` *is* the engine's
  // structural `RulesetView`: every terrain carries the `role` generation
  // resolves terrain by, and every unit carries the `movement` `EndTurn` refills
  // from. Both catalogs are required by the view (INTERFACES.md M2's amendment),
  // and validation has already produced both, so the ruleset is passed straight
  // through — no adapter, no id-to-role guessing, and nothing the engine needs
  // can be missing from it.
  const view: RulesetView = validated.value;
  const state = newGame(settings.value.seed, settings.value, view);
  if (!state.ok) {
    console.error(`setup failed: ${formatSetupError(state.error)}`);
    return 1;
  }

  // `describe` already ends with a newline; write it as-is so there is no blank
  // line between the map and its hash.
  process.stdout.write(describe(state.value, view));
  console.log(`state hash: ${hashValue(state.value)}`);
  return 0;
};

/* ------------------------------------------------------------------ *
 * `play` — the text REPL (the agent's hands). All of the session logic
 * lives in `repl.ts`; this function is only wiring: flags, settings,
 * ruleset, `newGame`, then hand a session either a command file or the
 * terminal.
 * ------------------------------------------------------------------ */

const commandPlay = async (args: readonly string[]): Promise<number> => {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(PLAY_USAGE);
    return 0;
  }

  const flags = parsePlayArgs(args);
  if (!flags.ok) {
    console.error(`error: ${flags.error}`);
    console.error('');
    console.error(PLAY_USAGE);
    return 2;
  }

  // The command file is read *before* a game is built: an unreadable script
  // should fail fast and print nothing, rather than generate a world and start a
  // transcript that is about to be abandoned.
  const script =
    flags.value.scriptPath === undefined ? undefined : readScript(flags.value.scriptPath);
  if (script !== undefined && !script.ok) {
    console.error(`error: ${script.error}`);
    return 2;
  }

  const layer: Record<string, unknown> = {};
  if (flags.value.seed !== undefined) layer['seed'] = flags.value.seed;
  if (flags.value.mapSize !== undefined) layer['mapSize'] = flags.value.mapSize;
  if (flags.value.civCount !== undefined) layer['civCount'] = flags.value.civCount;

  const settings = loadSettings(layer);
  if (!settings.ok) {
    for (const issue of settings.error)
      console.error(`settings error: ${formatSettingsIssue(issue)}`);
    return 2;
  }

  const validated = validateRuleset(CATALOG, settings.value.fidelity);
  if (!validated.ok) {
    for (const e of validated.error) console.error(`ruleset error: ${formatError(e)}`);
    return 1;
  }

  // The validated ruleset *is* the engine's `RulesetView` — terrains with the
  // roles generation resolves, and units with the movement `EndTurn` refills —
  // so the session gets the whole view, unit catalog included. The REPL applies
  // every command through `applyCommand(state, playerId, cmd, ruleset)`, whose
  // fourth argument is required (INTERFACES.md M2's amendment), so a session
  // built without a view the engine can read would not compile at all.
  const view: RulesetView = validated.value;
  const state = newGame(settings.value.seed, settings.value, view);
  if (!state.ok) {
    console.error(`setup failed: ${formatSetupError(state.error)}`);
    return 1;
  }

  // The acting player must be a player the state actually has: a session whose
  // commands could only ever come back `unknown-player` is not a game, it is a
  // typo, and it is cheaper to say so than to make the agent guess.
  const playerIndex = flags.value.playerIndex ?? 0;
  const player = state.value.players[playerIndex];
  if (player === undefined) {
    console.error(
      `error: --player ${String(playerIndex)} is not a player in this game: it has ` +
        `${String(state.value.players.length)} (0..${String(state.value.players.length - 1)})`,
    );
    return 2;
  }

  const session = createSession({
    state: state.value,
    ruleset: view,
    playerId: player.id,
    god: flags.value.god,
    write: writeOut,
  });

  if (script !== undefined) {
    return runScript(session, script.value, writeOut);
  }

  return runInteractive(session, writeOut);
};

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;

  if (command === undefined || command === '-h' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case 'provenance':
      return commandProvenance();
    case 'map':
      return commandMap(rest);
    case 'play':
      return commandPlay(rest);
    case 'run':
      console.log('run: the headless self-play harness arrives in M7.');
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      console.error(USAGE);
      return 2;
  }
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  const detail = cause instanceof Error ? cause.message : 'unknown error';
  console.error(`fatal: ${detail}`);
  process.exitCode = 1;
}
