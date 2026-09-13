#!/usr/bin/env node
/**
 * `scripts/tournament-evidence.ts` — **A3's tournament, run deliberately and reported as
 * evidence.**
 *
 * ```
 *   npx tsx scripts/tournament-evidence.ts              # A3: seeds 1..20, 100 turns
 *   npx tsx scripts/tournament-evidence.ts --json       # the same run, as canonical JSON
 *   npx tsx scripts/tournament-evidence.ts --seeds 1..2 --turns 10   # a seconds-long check
 *   npx tsx scripts/tournament-evidence.ts --help
 * ```
 *
 * ## Why this is a script and not a test (the M7b decision)
 *
 * Alpha criterion A3 asks for a twenty-seed tournament with zero invariant violations inside
 * a stated budget. That experiment costs **minutes, not seconds** — the measured figure, the
 * bound it is judged against and the headroom between them are recorded **once**, in
 * `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE`, and this script prints them rather than restating
 * them (the same figure used to live in five files at once and was stale in all five by 1.66×;
 * see that record's own note). What matters here is that a per-commit gate cannot hold a run
 * of that size: M7b bounds `time pnpm verify` at 70 s, and A3's run alone is an order of
 * magnitude more. So the run lives here, executed **on purpose**, and its output is what the
 * docs record.
 *
 * What the suite keeps is the *smoke* version of the same machinery: `tournament.test.ts` plays
 * small tournaments (a handful of games, four to six turns) plus one four-seed smoke run of the
 * real policy, and asserts that a violation fails the pass condition by name; m7-adversarial's
 * full tier plays twenty seeds at a horizon the gate can afford. The suite proves the machinery
 * and the failure path; this script produces the acceptance number. Nothing was deleted to make
 * the gate faster — the split is visible in the fast run's own output, which names every skipped
 * test.
 *
 * ## The recorded figure and the fresh one, side by side
 *
 * A timing is evidence only while it is current, and the AI it measures changes every wave, so
 * the text report ends with **recorded vs measured**: the per-game and whole-run figures from
 * `A3_TOURNAMENT_EVIDENCE`, beside the ones this process just measured. A drift is not a
 * failure — nothing exits non-zero for it, and the run's own verdict is unaffected — but it is
 * printed, because the alternative is exactly how this number went 1.66× stale in five files
 * without anybody noticing.
 *
 * ## What it measures, and the two clocks it prints
 *
 * The run goes through the **shipped CLI** (`runTournamentCommand`), not a private path: the
 * flags, the ruleset, the seat rotation, the invariant registry and the structured report are
 * the ones `civts tournament` produces, so a number measured here is one a reader can
 * reproduce by hand. `--json` prints that report plus this script's own measurement of it.
 *
 * Two clocks appear in the output, and they answer different questions:
 *
 * 1. **`wallMs`** — this process's own bracket around the call, from `process.hrtime.bigint()`.
 *    That is the number a person waiting for the command experiences, and the number behind the
 *    per-game figure the record below quotes.
 * 2. **`harnessElapsedMs`** — the tournament harness's own reading, from `@civts/sim`'s
 *    `HOST_CLOCK`, which is the one the **budget verdict** is computed from.
 *
 * There is a third timing, and it belongs to the caller rather than to this process: the `time`
 * figure for `pnpm tournament:evidence` end to end — measured from a quiet shell, with the load
 * average it ran under recorded beside it, and stored in the record's `commandWallMs`. Three
 * numbers, each labelled with what it measures: M7b's A5 failure was comparing one against a
 * bound written for another, so none of them is left to be inferred.
 *
 * Printing both is the point: they are independent measurements of the same work, and
 * `clockAgreementPct` is the difference between them. A run whose two clocks disagreed by more
 * than a fraction of a percent would mean the budget verdict was computed from a clock that is
 * not measuring the run.
 *
 * ## The third question: did any game actually END?
 *
 * The text report prints an **outcome distribution** beside the timings — one row per stop
 * reason the engine reported, the count of games that reached their horizon, and, when *every*
 * game reached it, the finding that says so out loud. It exists because the timings and the
 * verdicts above it cannot answer that question: a tournament in which nothing ever ends reports
 * zero violations, stays inside its budget and looks exactly like a healthy one. A victory
 * condition that has never fired is a condition that does not work, and the count of endings is
 * the only figure that shows it. See `outcomeDistribution`.
 *
 * ## Determinism and provenance
 *
 * The clocks are read **only** for the report: nothing they return reaches a game, a policy,
 * the ruleset or the settings — the same rule `packages/sim/src/tournament.ts` states for its
 * own clock, and the reason `eslint.config.js`'s determinism guard does not list `scripts/`
 * ("they report, they do not simulate"). The games are a pure function of the seeds, the
 * settings and the catalog, so two runs of the same flags produce the same twenty final
 * hashes; only the timing fields move.
 *
 * This script introduces **no game magnitude**. The seed set and the horizon are A3's, and
 * they are imported from the CLI's own exported constants rather than restated here, so the
 * evidence run and the `--help` text that documents it cannot drift apart.
 */

import { DEFAULT_SETTINGS } from '@civts/core';
import { A3_TOURNAMENT_EVIDENCE, DEFAULT_TOURNAMENT_BUDGET_MS } from '@civts/sim';
import { canonicalize } from '@civts/testing';

import { parseIntFlag } from '../packages/headless/src/repl.js';
import {
  A3_TOURNAMENT_SEED_SPEC,
  A3_TOURNAMENT_TURNS,
  parseSeedSpec,
  runTournamentCommand,
  type TournamentGameReport,
  type TournamentReport,
} from '../packages/headless/src/sim-cli.js';

/* ------------------------------------------------------------------ *
 * The experiment this script runs
 * ------------------------------------------------------------------ */

/**
 * The map every evidence run uses, and the number of civilizations.
 *
 * **A3's own shape, stated rather than guessed**: the acceptance line's tournament is the
 * shipped settings — a `tiny` map and two civilizations — with the real policy in both seats.
 * Only the seed set and the horizon are flags, because those are the two numbers the criterion
 * names. They are passed to the CLI explicitly (and printed with the command) so the recorded
 * command line is complete on its own.
 */
const EVIDENCE_MAP_SIZE = DEFAULT_SETTINGS.mapSize;
const EVIDENCE_CIV_COUNT = DEFAULT_SETTINGS.civCount;

/** A3's experiment: the twenty seeds, at the full horizon the acceptance line means. */
const A3_SEED_SPEC = A3_TOURNAMENT_SEED_SPEC;
const A3_TURNS = A3_TOURNAMENT_TURNS;

export const EVIDENCE_USAGE = `usage: npx tsx scripts/tournament-evidence.ts [--seeds <spec>]
                                                  [--turns <int>] [--budget-ms <int>] [--json]

  --seeds <spec>      the seeds to play: a list, ranges, or both (default ${A3_SEED_SPEC},
                      which is A3's twenty-seed experiment)
  --turns <int>       turns per game, at least 1 (default ${String(A3_TURNS)}, a full game at this engine's
                      scale — and the reason the default run costs what it does; the recorded
                      figure is printed under RECORDED COST below)
  --budget-ms <int>   the budget the run is judged against, in milliseconds (default
                      ${String(DEFAULT_TOURNAMENT_BUDGET_MS)} — ${String(A3_TOURNAMENT_EVIDENCE.budgetMs / 60_000)} minutes, the stated bound for
                      A3's experiment). A run that exceeds it SAYS SO; the seed set is never
                      trimmed to fit
  --json              print the canonical JSON of the structured result plus this script's own
                      measurement of it, instead of the text report
  -h, --help          print this

The tournament itself runs through the shipped CLI, with the same override machinery, the same
invariant registry and the same structured report:

  civts tournament --seeds ${A3_SEED_SPEC} --turns ${String(A3_TURNS)} --json

The text report ends with an OUTCOME DISTRIBUTION: one row per stop reason the engine reported,
how many games reached their turn limit, and — when every one of them did — the finding that no
victory condition can be reached in this build. A tournament where nothing ever ends is evidence
about the conditions, not a table of outcomes.

Exit codes: 0 = zero violations, zero planner failures, and within budget; 1 = a violation, a
planner failure, or both (each is named loudly — the violation with its seed and turn, the planner
failure with its seed, turn and pass; M7d counts a planner failure like a violation, because a run
whose AI stopped playing mid-turn is not evidence either); 2 = the flags are unusable; 3 = every
invariant held and no policy threw, but the run was over budget.

RECORDED COST OF THIS EXPERIMENT — the one record, \`@civts/sim\`'s \`A3_TOURNAMENT_EVIDENCE\`,
so no figure is restated here and none can go stale on its own:

  ${A3_TOURNAMENT_EVIDENCE.summary}

  (that record also carries the twenty per-game final hashes, and a text run of this script
  prints the recorded figures beside the fresh ones — a drift is how the old number went stale)
`;

/* ------------------------------------------------------------------ *
 * This script's own flags — the two numbers the criterion names
 * ------------------------------------------------------------------ */

interface EvidenceFlags {
  readonly seedSpec: string;
  readonly turns: number;
  readonly budgetMs: number | undefined;
  readonly json: boolean;
}

type ParsedEvidenceArgs =
  { readonly kind: 'help' } | { readonly kind: 'flags'; readonly flags: EvidenceFlags };

/**
 * Parse this script's own flags. A typo is refused before any game starts.
 *
 * The seed spec goes through the CLI's own parser (`parseSeedSpec`), so the cap and the "a seed
 * listed twice is two games" rule are the ones the tournament will apply rather than a second
 * reading of the same text.
 */
export const parseEvidenceArgs = (args: readonly string[]): ParsedEvidenceArgs | string => {
  let seedSpec: string | undefined;
  let turns: number | undefined;
  let budgetMs: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined) break;

    if (flag === '-h' || flag === '--help') return { kind: 'help' };
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag !== '--seeds' && flag !== '--turns' && flag !== '--budget-ms') {
      return `unknown option: "${flag}"`;
    }

    const raw = args[i + 1];
    if (raw === undefined) return `${flag} needs a value`;
    i += 1; // consume the value

    if (flag === '--seeds') {
      const parsed = parseSeedSpec(raw);
      if (!parsed.ok) return parsed.error;
      seedSpec = raw.trim();
      continue;
    }

    const parsed = parseIntFlag(flag, raw);
    if (!parsed.ok) return parsed.error;
    if (flag === '--turns') turns = parsed.value;
    else budgetMs = parsed.value;
  }

  if (turns !== undefined && turns < 1) {
    return `--turns must be at least 1, got ${String(turns)} (a tournament of zero turns measures nothing)`;
  }
  if (budgetMs !== undefined && budgetMs < 0) {
    return `--budget-ms must be zero or more, got ${String(budgetMs)} (a negative budget is a verdict no run can satisfy)`;
  }

  return {
    kind: 'flags',
    flags: {
      seedSpec: seedSpec ?? A3_SEED_SPEC,
      turns: turns ?? A3_TURNS,
      budgetMs,
      json,
    },
  };
};

/* ------------------------------------------------------------------ *
 * The evidence value — one source of truth: the report plus the bracket
 * ------------------------------------------------------------------ */

export interface TournamentEvidence {
  readonly kind: 'civts-tournament-evidence';
  readonly evidenceVersion: number;
  /** The exact argv this script handed the CLI, so the run can be reproduced by hand. */
  readonly command: readonly string[];
  /** This process's own bracket around the run: the wall time a person waiting would see. */
  readonly wallMs: number;
  /** The harness's own reading — the one the budget verdict is computed from. */
  readonly harnessElapsedMs: number;
  /** `wallMs / games`: the per-game figure the docs quote. */
  readonly perGameMs: number;
  /** `|wallMs - harnessElapsedMs| / wallMs` as a percentage: do the two clocks agree? */
  readonly clockAgreementPct: number;
  /**
   * **Why each game stopped** — the outcome distribution, counted from the report above.
   *
   * A tournament's *timings* say how the AI is doing; its *outcomes* say whether the game can
   * end at all. The two questions were conflated until this field existed: every A3 run
   * reported "zero violations, within budget" while every one of its twenty games stopped at
   * the horizon, and nothing in the output said so. A condition that has never fired is a
   * condition that does not work, and the only way to tell that from a table of averages is to
   * count the endings — so the count is a field, printed by `renderOutcomeDistribution`, and
   * never a figure a renderer derives on its own.
   *
   * It is computed here rather than carried by the CLI because it is a *reading of* the
   * report's own `games`, exactly like `perGameMs` is a reading of the wall time: the per-game
   * stop reason is the engine's (`TournamentGameReport.stoppedBecause`), and this adds no
   * vocabulary of its own to it.
   */
  readonly outcomes: OutcomeDistribution;
  /** The run itself, exactly as `civts tournament --json` would report it. */
  readonly report: TournamentReport;
}

/**
 * The version of the evidence value's shape.
 *
 * - 1 — M7b: the command, the two clocks, the per-game figure and the report.
 * - 2 — the outcome distribution (`outcomes`). Additive, and bumped anyway because a consumer
 *   that reads this value wants to know whether the endings were counted at all: a version-1
 *   value's silence about outcomes is not the same fact as a version-2 value reporting that
 *   every game reached the horizon.
 */
export const EVIDENCE_VERSION = 2;

/* ------------------------------------------------------------------ *
 * The outcome distribution
 * ------------------------------------------------------------------ */

/** One stop reason, and how many of the tournament's games ended with it. */
export interface OutcomeCount {
  /**
   * The engine's own `StopReason` for the game — the union's spelling, never a name invented
   * here, and typed from the report so a renamed reason is a compile error rather than a row
   * that silently reads zero.
   */
  readonly stoppedBecause: TournamentGameReport['stoppedBecause'];
  readonly count: number;
}

/**
 * Why a run's games stopped, counted by the engine's own reason.
 *
 * **`games` and `turnLimitGames` are carried as fields rather than left to the reader**, for the
 * rule the whole report follows: a figure the text prints is a figure the structured value
 * contains. `turnLimitGames` is the one this block exists for — "how many hit the turn limit"
 * is the question A3's outcome line asks — and `earlyGames` is its complement, stated so that
 * no renderer has to subtract.
 *
 * The rows are sorted by the reason's own name (code-unit order), never by count and never by
 * the order the games happened to be played in, so two runs of the same seeds print the same
 * block and a diff between two reports means the games changed.
 */
export interface OutcomeDistribution {
  readonly games: number;
  /** Games that reached their horizon — `stoppedBecause === 'max-turns'`. */
  readonly turnLimitGames: number;
  /** Games that ended before their horizon, for whatever engine reason. */
  readonly earlyGames: number;
  /** One row per reason that occurred, ascending by reason. */
  readonly counts: readonly OutcomeCount[];
}

/**
 * Count the stop reasons of a report's games.
 *
 * `'max-turns'` is written here as the engine spells it, and it compiles only against
 * `TournamentGameReport['stoppedBecause']` — the single place that vocabulary is defined. That
 * is deliberate: a literal that matched a *string* rather than the union would turn a renamed
 * reason into "no game ever reached the horizon", which is the most misleading number this
 * block could print.
 */
export const outcomeDistribution = (
  games: readonly TournamentGameReport[],
): OutcomeDistribution => {
  const counts = new Map<TournamentGameReport['stoppedBecause'], number>();
  for (const game of games) {
    counts.set(game.stoppedBecause, (counts.get(game.stoppedBecause) ?? 0) + 1);
  }

  const rows: OutcomeCount[] = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stoppedBecause, count]) => ({ stoppedBecause, count }));

  const turnLimitGames = counts.get('max-turns') ?? 0;
  return {
    games: games.length,
    turnLimitGames,
    earlyGames: games.length - turnLimitGames,
    counts: rows,
  };
};

/**
 * The outcome block: how many games ended in which condition, and how many hit the turn limit.
 *
 * What each reason *means* is not restated here — `@civts/sim`'s `StopReason` names them, and a
 * second glossary would be a second place for them to drift — so the block prints the reason and
 * the count, and one interpretation that is only true when the data says so:
 *
 * - **every** game reaching its horizon is printed with the finding it is, because a tournament
 *   in which nothing ever ends is evidence that no victory condition can be reached, not a table
 *   of outcomes. The sentence is emitted **only** in that case; a run with one early ending says
 *   nothing about conditions being unreachable, and a report that always carried the line would
 *   be claiming a finding it had not measured.
 */
export const renderOutcomeDistribution = (distribution: OutcomeDistribution): string => {
  const lines: string[] = [
    '',
    `OUTCOME DISTRIBUTION (why each of the ${String(distribution.games)} games stopped — ` +
      "the engine's own stop reasons, counted from the report above)",
  ];

  if (distribution.counts.length === 0) {
    lines.push('  (no games were played, so there are no endings to count)');
    return lines.join('\n');
  }

  for (const row of distribution.counts) {
    const share =
      distribution.games === 0 ? 0 : Math.round((row.count / distribution.games) * 1000) / 10;
    lines.push(
      `  ${row.stoppedBecause.padEnd(18)}${String(row.count)} of ${String(
        distribution.games,
      )} games (${share.toFixed(1)}%)`,
    );
  }

  if (distribution.turnLimitGames === distribution.games) {
    lines.push(
      '  FINDING            every game in this run reached its turn limit and no game ended by a',
      '                     victory or a defeat, so this run is evidence that no victory condition',
      '                     can be reached in this build — it is a finding, not a table of outcomes',
    );
  } else {
    lines.push(
      `  ${'ended early'.padEnd(18)}${String(distribution.earlyGames)} of ${String(
        distribution.games,
      )} games stopped before their horizon (see the reasons above)`,
    );
  }

  return lines.join('\n');
};

const roundTo1 = (value: number): number => Math.round(value * 10) / 10;
const roundTo2 = (value: number): number => Math.round(value * 100) / 100;

/** The argv the CLI is handed, so the run is reproducible from the printed command line. */
const commandFor = (flags: EvidenceFlags): readonly string[] => [
  '--seeds',
  flags.seedSpec,
  '--turns',
  String(flags.turns),
  '--map-size',
  EVIDENCE_MAP_SIZE,
  '--civs',
  String(EVIDENCE_CIV_COUNT),
  ...(flags.budgetMs === undefined ? [] : ['--budget-ms', String(flags.budgetMs)]),
];

/**
 * The evidence block: the numbers that exist only *outside* the run.
 *
 * Every figure printed here is a field of `TournamentEvidence`. Nothing is recomputed — the
 * per-game average and the agreement percentage are stored on the value, because a renderer
 * that can compute can disagree with the thing it is describing.
 */
export const renderEvidence = (evidence: TournamentEvidence): string =>
  [
    '',
    "EVIDENCE (this script's own measurement of the call above — A3's numbers, not the gate's)",
    `  command            ${evidence.command.join(' ')}`,
    `  wall               ${evidence.wallMs.toFixed(1)}ms  (external bracket: process.hrtime.bigint)`,
    `  reported elapsed   ${evidence.harnessElapsedMs.toFixed(1)}ms  (the harness clock the budget is judged with)`,
    `  agreement          ${evidence.clockAgreementPct.toFixed(2)}% between the two clocks — the gap`,
    '                     is this process scaffolding the call (argv parsing, report rendering),',
    "                     so it is a fraction of a percent at A3's size and larger on a toy run",
    `  per game           ${evidence.perGameMs.toFixed(1)}ms over ${String(evidence.report.totals.games)} games`,
    `  verdict            ${evidence.report.verdict.summary}`,
    `  exit code          ${String(evidence.report.exitCode)}`,
    renderOutcomeDistribution(evidence.outcomes),
    renderRecordComparison(evidence),
    '',
  ].join('\n');

/**
 * The recorded figure beside the fresh one — printed, and deliberately not fatal.
 *
 * ## Why this exists
 *
 * A timing is evidence only while it is current, and the thing being timed (the AI's own
 * per-turn decision work) changes in almost every wave. The figure this project published went
 * **1.66× stale in five files at once** because nothing compared a stored number against a
 * fresh one: each site was edited by hand, and the run that would have contradicted all five
 * was the expensive one nobody re-ran.
 *
 * So every text run prints both, with the record's own `measuredAt` and `loadAverage` beside
 * it. Nothing here changes the exit code: a drift is information, not a failure — the run's
 * verdict is about *this* run and its budget, and a busy machine makes a run slower without
 * making the record wrong. What it does mean is stated in words, because a reader who sees
 * "+61 %" should not have to work out whether that is noise (it is not) or a broken build (it
 * is not: it is the AI having moved, and the fix is to re-record `A3_TOURNAMENT_EVIDENCE`).
 *
 * The comparison is only made between **like runs**: if this invocation asked for a different
 * seed set or horizon than the record describes, the two figures are not comparable and the
 * block says so rather than printing a ratio between different experiments.
 */
export const renderRecordComparison = (evidence: TournamentEvidence): string => {
  const recorded = A3_TOURNAMENT_EVIDENCE;
  const games = evidence.report.totals.games;
  const freshPerGameMs = games === 0 ? 0 : evidence.wallMs / games;
  const recordedPerGameMs = recorded.perGameMs;

  const lines: string[] = [
    'RECORDED vs MEASURED (the recorded figures live once, in `@civts/sim` A3_TOURNAMENT_EVIDENCE)',
    `  recorded           ${recordedPerGameMs.toFixed(1)}ms per game over ${String(
      recorded.games.length,
    )} games of ${String(recorded.turns)} turns — ${recorded.budgetMs.toFixed(0)}ms budget, ` +
      `${recorded.headroomMs.toFixed(0)}ms headroom (${recorded.headroomPct.toFixed(1)}%)`,
    `  recorded under     load average ${recorded.loadAverage} on ${recorded.host}, measured ${recorded.measuredAt}`,
    `  this run           ${freshPerGameMs.toFixed(1)}ms per game over ${String(games)} games of ${String(
      evidence.report.parameters.maxTurns,
    )} turns`,
  ];

  if (games !== recorded.games.length || evidence.report.parameters.maxTurns !== recorded.turns) {
    lines.push(
      '  not comparable     this invocation is not the recorded experiment (different seed count ' +
        'or horizon), so no drift is computed: the two numbers describe different runs',
    );
    return lines.join('\n');
  }

  // A record with no positive per-game figure is a placeholder rather than a measurement:
  // there is nothing to compare against, and printing "+0.0 %" beside a zero would read as
  // agreement between a run and a record that has never been filled in.
  if (recordedPerGameMs <= 0) {
    lines.push(
      '  no record yet      the record carries no measured per-game figure, so there is nothing ' +
        'to compare this run against — record the numbers from this output',
    );
    return lines.join('\n');
  }

  const driftPct = recordedPerGameMs === 0 ? 0 : (freshPerGameMs / recordedPerGameMs - 1) * 100;
  lines.push(
    `  drift              ${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(1)}% per game — a few ` +
      'percent is machine noise; a factor means the AI moved, and the record needs re-measuring',
  );
  return lines.join('\n');
};

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const parsedArgs = parseEvidenceArgs(process.argv.slice(2));

if (typeof parsedArgs === 'string') {
  process.stderr.write(`error: ${parsedArgs}\n\n${EVIDENCE_USAGE}`);
  process.exitCode = 2;
} else if (parsedArgs.kind === 'help') {
  process.stdout.write(EVIDENCE_USAGE);
  process.exitCode = 0;
} else {
  const { flags } = parsedArgs;
  const command = commandFor(flags);

  // The bracket. `process.hrtime.bigint()` is a monotonic nanosecond clock, so the wall clock
  // being adjusted mid-run cannot move it; it is read exactly twice, here and after the call,
  // and neither reading reaches a game (see the header for why this is sanctioned in
  // `scripts/` and banned in `packages/sim/src`).
  const started = process.hrtime.bigint();
  const output = runTournamentCommand(command);
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (!output.ok) {
    for (const line of output.error.lines) process.stderr.write(`${line}\n`);
    if (output.error.usage !== undefined) process.stderr.write(`\n${output.error.usage}`);
    process.exitCode = output.error.exitCode;
  } else {
    const report = output.value.report;
    if (report === undefined) {
      process.stderr.write('error: the tournament command returned no report\n');
      process.exitCode = 1;
    } else {
      const games = report.totals.games;
      const evidence: TournamentEvidence = {
        kind: 'civts-tournament-evidence',
        evidenceVersion: EVIDENCE_VERSION,
        command: ['civts', 'tournament', ...command],
        wallMs: roundTo1(wallMs),
        harnessElapsedMs: roundTo1(report.budget.elapsedMs),
        perGameMs: games === 0 ? 0 : roundTo1(wallMs / games),
        clockAgreementPct:
          wallMs === 0 ? 0 : roundTo2((Math.abs(wallMs - report.budget.elapsedMs) / wallMs) * 100),
        outcomes: outcomeDistribution(report.games),
        report,
      };

      if (flags.json) {
        process.stdout.write(`${canonicalize(evidence)}\n`);
      } else {
        // The CLI's own text report first — every figure in it is a field of the structured
        // value — then the three numbers the CLI cannot know, because they are this process's
        // measurement of that call.
        process.stdout.write(output.value.stdout);
        process.stdout.write(renderEvidence(evidence));
      }
      if (output.value.stderr !== '') process.stderr.write(output.value.stderr);
      process.exitCode = output.value.exitCode;
    }
  }
}
