#!/usr/bin/env node
/**
 * CivTS headless CLI. See PLAN.md 8.1.
 *
 * This is the agent's primary interface to the game: text in, text out, no
 * browser and no eyes required. Subcommands land as milestones land — M0 ships
 * `provenance`, M1 ships `map` (a rendered world plus its state hash), M2 ships
 * `play` (the REPL).
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
  type SetupError,
} from '@civts/core';
import { CATALOG, summarizeProvenance, validateRuleset, type RulesetError } from '@civts/rules';
import { hashValue } from '@civts/testing';

const USAGE = `civts — headless tooling

Usage: civts <command> [options]

Commands:
  provenance   print the rules-data provenance table (cited vs placeholder)
  map          generate a world, render it as ASCII, print its state hash
  play         interactive text REPL                      (arrives in M2)
  run          headless AI-vs-AI game                     (arrives in M7)

Options:
  -h, --help   show this help

map options:
  --seed <int>        world seed                          (default: 1)
  --map-size <size>   ${MAP_SIZES.join('|')}  (default: tiny)
  --civs <int>        number of civilizations, 2..16       (default: 2)

Examples:
  pnpm map --seed 42
  pnpm map --seed 42 --map-size tiny --civs 2
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

  const width = Math.max(...CATALOG.terrains.map((t) => t.id.length));
  for (const t of CATALOG.terrains) {
    const p = t.provenance;
    const detail = p.kind === 'cited' ? p.source : p.note;
    console.log(`  ${t.id.padEnd(width)}  ${p.kind.padEnd(11)}  ${detail}`);
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

const INTEGER = /^[+-]?\d+$/;

/**
 * Strict integer parsing: `"abc"`, `"NaN"`, `""`, `"1.5"`, `"0x10"` and `"1e3"`
 * are all errors, so a mistyped flag can never be interpreted as a different
 * world than the one that was asked for.
 */
const parseIntFlag = (flag: string, raw: string): Result<number, string> => {
  const text = raw.trim();
  if (!INTEGER.test(text)) return err(`${flag} expects an integer, got "${raw}"`);

  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return err(`${flag} is out of range: "${raw}"`);
  return ok(value);
};

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

const formatSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `ruleset is missing terrain role "${error.role}"`;
    case 'no-valid-starts':
      return `no valid starting tile for ${String(error.civCount)} civilizations`;
    case 'too-few-start-candidates':
      return 'too few starting-tile candidates for the requested civilizations';
  }
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
  // structural `RulesetView` — every terrain carries the `role` generation
  // resolves terrain by — so the catalog is passed through with no adapter and
  // no id-to-role guessing.
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

const main = (argv: readonly string[]): number => {
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
      console.log('play: the interactive text REPL arrives in M2.');
      return 0;
    case 'run':
      console.log('run: the headless self-play harness arrives in M7.');
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      console.error(USAGE);
      return 2;
  }
};

process.exit(main(process.argv.slice(2)));
