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
} from '@civts/core';
import {
  CATALOG,
  provenanceSections,
  summarizeProvenance,
  validateRuleset,
  type ProvenanceRow,
  type ProvenanceSection,
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
import {
  A3_TOURNAMENT_SEED_SPEC,
  A3_TOURNAMENT_TURNS,
  SIM_POLICIES,
  formatRulesetError,
  formatSettingsIssue,
  runSimCommand,
  runTournamentCommand,
} from './sim-cli.js';
// A3's recorded cost, imported rather than quoted. This file used to restate it — a wall-time
// sentence in the usage text below, with its own per-game and whole-run figures — and that copy
// was **stale by 8×** when E3 checked the tree, which is the same five-files-one-number failure
// `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE` exists to end. The usage text prints that record's own
// summary, so this file cannot hold a second version of the number to go stale.
import { A3_TOURNAMENT_EVIDENCE } from '@civts/sim';

const USAGE = `civts — headless tooling

Usage: civts <command> [options]

Commands:
  provenance   print every rules-data row's provenance (terrains, units, buildings,
               improvements)
  map          generate a world, render it as ASCII, print its state hash
  play         interactive text REPL: play the game from a terminal or a script
  sim          run a batch of headless games and report per-metric aggregates and
               every invariant's verdict; see "civts sim --help"
  tournament   self-play: the same policies across seeds with the seats ROTATED, so no
               policy is ever tested from one position only; zero invariant violations
               and zero planner failures is the pass condition and the budget is
               reported; see "civts tournament --help". "run" is an accepted alias for
               this command.

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
  --god               render the whole map and ignore fog  (default: off)
  --script <file>     run a command file, print the transcript, exit 0

sim options (the full text is in "civts sim --help"):
  --seeds <spec>      games to run: "1..50", "3", "1,4,7", "1..3,9" (default: 1..10)
  --map-size <size>   ${MAP_SIZES.join('|')}  (default: tiny)
  --civs <int>        civilizations per game               (default: 2)
  --turns <int>       turns to play per game               (default: 20)
  --policy <name>     ${SIM_POLICIES.join('|')}  (default: simple)
  --sample-every <n>  sample metrics every n turns          (default: 1)
  --override <p>=<v>  change ONE catalog number for the batch, e.g.
                      --override units.settler.cost=4 (repeatable)
  --fault <name>      append a deliberately failing invariant named <name>, so the
                      violation path can be watched firing end to end (self-test)
  --json              emit one canonical JSON report (sorted keys) instead of text

  a violation anywhere in the batch is named, with its seed and turn, and exits 1;
  that is the command working, not failing. A policy that threw while planning is
  reported the same way (a PLANNER FAILURE, naming the seed, turn and pass) and also
  exits 1, because a run the AI walked out of is not evidence either. "exit 0" means
  every run held every invariant and every turn was decided by its policy.

tournament / run options (the full text is in "civts tournament --help"):
  --seeds <spec>      games to play: "1..2", "3", "1,4,7"   (default 1..2 — a smoke run)
  --seats <names>     one policy per seat, comma-separated; a name may repeat, and
                      "smart,smart" is a self-play tournament (default: smart in every
                      seat). The seats ROTATE across games.
  --map-size <size>   ${MAP_SIZES.join('|')}  (default: tiny)
  --civs <int>        civilizations, and the number of seats  (default: 2)
  --turns <int>       turns to play per game                (default 10)
  --budget-ms <int>   the budget the whole run is judged against; every seed is played
                      whatever the clock says, and an overrun is reported, never hidden
  --json              emit one canonical JSON report (sorted keys) instead of text

  THE DEFAULT IS DELIBERATELY SMALL. "run" is an alias for "tournament" — one command, one
  default — so a plain invocation is TWO GAMES OF TEN TURNS, seconds rather than minutes, and
  never A3's experiment. That experiment is twenty seeds of a hundred turns, asked for
  explicitly; its measured cost lives in ONE place and is printed here from there:

    ${A3_TOURNAMENT_EVIDENCE.summary}

    civts tournament --seeds ${A3_TOURNAMENT_SEED_SPEC} --turns ${String(A3_TOURNAMENT_TURNS)}
    pnpm tournament:evidence    the same run, printing the structured result and wall time

  exit 0 means every game held every invariant, no policy threw while planning, AND the
  run was within budget; exit 1 names a violation or a planner failure, exit 3 reports
  an honest overrun.

play commands (inside a session; "help" prints the same list with detail):
  move <unitId> <x> <y>      found <unitId>      cities      city <cityId>
  work <cityId> <x> <y> ...  build <cityId> <unit|building>:<id>
  work <unitId> <improve>    cancel <unitId>
  rates <tax> <science> <luxury>
  research <techId>          tech
  end   units   state   save <path>   help   quit

  gold, the three rates and your research (what you are researching, its cost and the
  beakers banked toward it) are shown in the banner, under every view, and in "state".
  Luxuries are shown too and still do nothing: happiness is M9.

Examples:
  pnpm map --seed 42
  pnpm play --seed 42 --map-size tiny --civs 2 --player 0
  pnpm play --seed 42 --script session.txt
  npx tsx packages/headless/src/cli.ts sim --seeds 1..10 --turns 20
  npx tsx packages/headless/src/cli.ts sim --seeds 1..3 --override units.settler.cost=4 --json
  npx tsx packages/headless/src/cli.ts run --seats smart,none
  npx tsx packages/headless/src/cli.ts tournament --seeds 1..20 --turns 100 --json
  npx tsx scripts/tournament-evidence.ts
  npx tsx scripts/balance-sweep.ts
`;

const MAP_USAGE = `usage: civts map [--seed <int>] [--map-size <size>] [--civs <int>]

  --seed <int>        world seed (any integer; default 1)
  --map-size <size>   one of ${MAP_SIZES.join('|')} (default tiny)
  --civs <int>        number of civilizations, 2..16 (default 2)
`;

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
    for (const e of validated.error) console.error(`ruleset error: ${formatRulesetError(e)}`);
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
    for (const e of validated.error) console.error(`ruleset error: ${formatRulesetError(e)}`);
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
    for (const e of validated.error) console.error(`ruleset error: ${formatRulesetError(e)}`);
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

/* ------------------------------------------------------------------ *
 * `sim` — a batch of headless games, and the report over it.
 *
 * Every part of this command lives in `sim-cli.ts` (flags, the run, the
 * structured report, the text renderer), and this function is the wiring the
 * other commands' functions are: it writes the text it was handed and returns
 * the exit code it was handed. Nothing here interprets a report, so there is no
 * second place where a figure could be recomputed and disagree with the engine —
 * the M2 provenance bug, which the standing requirement's "Reporting" paragraph
 * exists to prevent.
 * ------------------------------------------------------------------ */

const commandSim = (args: readonly string[]): number => {
  const result = runSimCommand(args);
  if (!result.ok) {
    for (const line of result.error.lines) console.error(line);
    if (result.error.usage !== undefined) {
      console.error('');
      console.error(result.error.usage);
    }
    return result.error.exitCode;
  }

  process.stdout.write(result.value.stdout);
  // In `--json` mode the machine-readable report is on stdout and the shout about a
  // violation is on stderr, so a pipeline that parses stdout still sees the warning.
  if (result.value.stderr !== '') process.stderr.write(result.value.stderr);
  return result.value.exitCode;
};

/* ------------------------------------------------------------------ *
 * `tournament` — the self-play harness, wired to the same rules as `sim`.
 *
 * This is the M7 contract's CLI half: "a `tournament` command alongside `sim`, printing
 * per-seat aggregates and the violation count, with `--json` for the structured
 * result". It is the *same* wiring `commandSim` is — write the stdout the command built,
 * pass its stderr through, return its exit code — because `runTournamentCommand` already
 * owns the flags, the run, the structured report and the renderer, and a second
 * interpretation of a report here is exactly the M2 provenance bug the standing
 * requirement's "Reporting" paragraph exists to prevent.
 *
 * **Why this function exists at all.** `sim-cli.ts` shipped `runTournamentCommand` with
 * its own tests while `main` below had no case for it: `civts tournament …` answered
 * "unknown command: tournament", so the command could only be reached by importing it in
 * a test. The tool was implemented and unreachable — the integration half of a feature is
 * the wiring, and a CLI command nobody can type is not shipped. `run` is routed here too:
 * PLAN.md §8.1 names the AI-vs-AI game `run`, and the old stub's message ("the M7
 * self-play harness is not built yet") was a lie the moment this milestone landed.
 * ------------------------------------------------------------------ */

const commandTournament = (args: readonly string[]): number => {
  const result = runTournamentCommand(args);
  if (!result.ok) {
    for (const line of result.error.lines) console.error(line);
    if (result.error.usage !== undefined) {
      console.error('');
      console.error(result.error.usage);
    }
    return result.error.exitCode;
  }

  process.stdout.write(result.value.stdout);
  if (result.value.stderr !== '') process.stderr.write(result.value.stderr);
  return result.value.exitCode;
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
    case 'sim':
      return commandSim(rest);
    case 'tournament':
      return commandTournament(rest);
    case 'run':
      // PLAN.md §8.1's name for the same self-play game. Written as its own case rather than a
      // fallthrough so that neither branch depends on a lint comment to stay honest.
      //
      // `run` is the plainest verb this CLI has and it used to be a stub that printed "the M7
      // self-play harness is not built yet" — so the two ways it could mislead are closed in
      // the command itself, not here: the default experiment is two games of ten turns
      // (`DEFAULT_TOURNAMENT_SEED_SPEC` / `DEFAULT_TOURNAMENT_TURNS`, stated in the usage
      // block above and in "civts tournament --help"), and A3's twenty seeds of a hundred
      // turns — whose cost is recorded once, in `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE`, and
      // printed into the usage block from there rather than restated here — has to be asked
      // for with `--seeds 1..20 --turns 100`.
      // Nothing here can start a long job by accident, because nothing here decides anything:
      // this case routes, and `runTournamentCommand` owns the defaults.
      return commandTournament(rest);
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
