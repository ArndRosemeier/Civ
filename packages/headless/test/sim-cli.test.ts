/**
 * `sim` — the batch command — and the balance sweep that is built on it.
 *
 * What this file exists to prove, in the order the standing requirement states it:
 *
 * 1. **Runnable without a UI, deterministically.** The command runs a batch end to end
 *    and exits 0 when every run holds every invariant; the same flags produce
 *    byte-identical output in process and in two fresh processes, which is the property
 *    `--json` is for.
 * 2. **Observable.** The report is built from `@civts/sim`'s structured result, and the
 *    text renderer prints figures the structured value contains — asserted by finding
 *    each aggregate's own numbers in the line that prints it, so "the renderer computed
 *    its own figure" (the M2 provenance bug) cannot pass unnoticed.
 * 3. **Tunable.** `--override` changes a catalog number through `applyOverrides`; an
 *    override the catalog refuses is *refused*, with the id and the known ids in the
 *    message and a non-zero exit, and one that produces an invalid ruleset is refused by
 *    validation. The sweep varies one number across a grid and shows the measured
 *    effect, including the honest verdict when there is none.
 * 4. **Checkable in flight.** A violation is loud: named, with its seed and turn, on
 *    stdout (text) or stderr (`--json`), and the exit code is non-zero.
 *
 * One thing this file deliberately does NOT assert, because it would be an assertion
 * about *content* rather than about the harness: the exact aggregate values of a batch
 * (they move whenever the engine or the policy is tuned). The sweep's numbers are
 * asserted only as *relations* — the shipped row equals the baseline, some metric moves,
 * a rejected value is rejected — never as pinned figures, so a content change moves the
 * table without breaking the gate.
 *
 * What IS pinned, and belongs to the harness rather than to content, is the registry the
 * report is built from (its count and its names, printed from the report's own fields)
 * and the **uniformity of a batch's horizon** on the seed set that used to break it: a
 * false-positive invariant truncated runs, and a batch whose runs stop on different turns
 * makes every aggregate folded over it a mean over games of different lengths. That is a
 * property of the check, so a test is the right place for it.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Result } from '@civts/core';
import { CATALOG } from '@civts/rules';
import { CORE_INVARIANTS, DEFAULT_TOURNAMENT_BUDGET_MS } from '@civts/sim';
import { describe, expect, it } from 'vitest';
// The **test tier** predicate: this file's long sweeps are `it.skipIf(!FULL_TIER)` —
// they run under `pnpm verify:full` and are reported as skipped by `pnpm verify`. The
// boundary and its reasoning live in `@civts/testing`'s `tier.ts`, once.
import { FULL_TIER } from '@civts/testing';

import {
  A3_TOURNAMENT_SEED_SPEC,
  A3_TOURNAMENT_TURNS,
  DEFAULT_TOURNAMENT_SEED_SPEC,
  DEFAULT_TOURNAMENT_TURNS,
  HORIZON_METRICS,
  buildRulesetPatch,
  parseIntegerSpec,
  parseOverrideText,
  parseSeedSpec,
  parseSimArgs,
  parseSweepArgs,
  parseTournamentArgs,
  readKnob,
  runSimCommand,
  runSweepCommand,
  runTournamentCommand,
  type SimReport,
  type SweepCommandDefaults,
  type SweepReport,
  type SweepValueRow,
  type TournamentFlags,
  type TournamentReport,
} from '../src/sim-cli.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const okOrThrow = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

/** A small, fast batch: two seeds, a handful of turns. */
const SMALL: readonly string[] = ['--seeds', '1..2', '--turns', '4'];

/** The default experiment the sweep tests run, sized to finish in about a second. */
const TEST_DEFAULTS: SweepCommandDefaults = {
  knob: 'units.settler.cost',
  values: [1, 3, 9],
  seedSpec: '1,4',
  turns: 12,
};

/** A cheaper experiment, for the tests that only care that the output is stable. */
const TINY_DEFAULTS: SweepCommandDefaults = {
  knob: 'units.settler.cost',
  values: [3, 5],
  seedSpec: '1',
  turns: 6,
};

const simReportOf = (args: readonly string[]): SimReport => {
  const output = okOrThrow(runSimCommand(args));
  if (output.report === undefined) throw new Error('the command produced no report');
  return output.report;
};

const sweepReportOf = (args: readonly string[], defaults: SweepCommandDefaults): SweepReport => {
  const output = okOrThrow(runSweepCommand(args, defaults));
  if (output.report === undefined) throw new Error('the command produced no report');
  return output.report;
};

const measuredRows = (report: SweepReport): readonly SweepValueRow[] =>
  report.rows.filter((row): row is SweepValueRow => row.kind === 'measured');

/** A plain JSON object — the shape `canonicalize` produces, decided without a cast. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every object key in `value`, recursively, is in sorted order — `--json`'s contract. */
const expectSortedKeys = (value: unknown, path: string): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      expectSortedKeys(entry, `${path}[${String(index)}]`);
    });
    return;
  }
  if (!isRecord(value)) return;

  const keys = Object.keys(value);
  expect(keys, `keys of ${path}`).toStrictEqual([...keys].sort());
  for (const key of keys) expectSortedKeys(value[key], `${path}.${key}`);
};

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(REPO_ROOT, 'packages', 'headless', 'src', 'cli.ts');
const SWEEP_SCRIPT = join(REPO_ROOT, 'scripts', 'balance-sweep.ts');
const COMBAT_SWEEP_SCRIPT = join(REPO_ROOT, 'scripts', 'combat-balance-sweep.ts');

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One process: `node tsx <script> <args…>`, the way a pipeline starts it. */
const runProcess = (script: string, args: readonly string[]): CliRun => {
  const result = spawnSync(process.execPath, [TSX_CLI, script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** The real CLI (the same shape `repl.test.ts` drives it with). */
const runCli = (args: readonly string[]): CliRun => runProcess(CLI, args);

/** The sweep script, started the way the principal was told to start it. */
const runSweepScript = (args: readonly string[]): CliRun => runProcess(SWEEP_SCRIPT, args);

/** M7's combat/capture sweep, started the same way — it is the one that measures battles. */
const runCombatSweepScript = (args: readonly string[]): CliRun =>
  runProcess(COMBAT_SWEEP_SCRIPT, args);

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

describe('the sim command parses its flags, and refuses what it cannot mean', () => {
  it('reads a seed list, ranges, and a mix of both, ascending', () => {
    expect(okOrThrow(parseSeedSpec('3'))).toStrictEqual([3]);
    expect(okOrThrow(parseSeedSpec('1..4'))).toStrictEqual([1, 2, 3, 4]);
    expect(okOrThrow(parseSeedSpec('5,1,3'))).toStrictEqual([1, 3, 5]);
    expect(okOrThrow(parseSeedSpec(' 1..3 , 9 '))).toStrictEqual([1, 2, 3, 9]);
    expect(okOrThrow(parseSeedSpec('2..2'))).toStrictEqual([2]);
    // A seed listed twice is run twice: the batch's own contract says a caller that
    // lists a seed twice asked for two games, so this must not silently de-duplicate.
    expect(okOrThrow(parseSeedSpec('1,1'))).toStrictEqual([1, 1]);
  });

  it('refuses a downward range, an empty entry and a non-number, naming the flag', () => {
    const down = parseSeedSpec('3..1');
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error).toContain('counts downwards');

    const empty = parseSeedSpec('1,,2');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('empty entry');

    const word = parseSeedSpec('one..three');
    expect(word.ok).toBe(false);
    if (!word.ok) expect(word.error).toContain('--seeds expects an integer');
  });

  it('refuses a spec larger than the guard, rather than starting a runaway batch', () => {
    const huge = parseIntegerSpec('1..100000', '--seeds', 500);
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error).toContain('at most 500');
  });

  it('leaves every default absent when no flag is given', () => {
    const flags = okOrThrow(parseSimArgs([]));
    expect(flags.seeds).toBeUndefined();
    expect(flags.seedSpec).toBeUndefined();
    expect(flags.mapSize).toBeUndefined();
    expect(flags.civCount).toBeUndefined();
    expect(flags.turns).toBeUndefined();
    expect(flags.policy).toBeUndefined();
    expect(flags.sampleEvery).toBeUndefined();
    expect(flags.overrides).toStrictEqual([]);
    expect(flags.faults).toStrictEqual([]);
    expect(flags.json).toBe(false);
  });

  it('parses the whole flag set, and collects repeated overrides', () => {
    const flags = okOrThrow(
      parseSimArgs([
        '--seeds',
        '1..2,7',
        '--map-size',
        'duel',
        '--civs',
        '2',
        '--turns',
        '5',
        '--policy',
        'none',
        '--sample-every',
        '2',
        '--override',
        'units.settler.cost=4',
        '--override',
        'buildings.granary.cost=8',
        '--fault',
        'gate-probe',
        '--json',
      ]),
    );
    expect(flags.seeds).toStrictEqual([1, 2, 7]);
    expect(flags.seedSpec).toBe('1..2,7');
    expect(flags.mapSize).toBe('duel');
    expect(flags.civCount).toBe(2);
    expect(flags.turns).toBe(5);
    expect(flags.policy).toBe('none');
    expect(flags.sampleEvery).toBe(2);
    expect(flags.overrides).toStrictEqual(['units.settler.cost=4', 'buildings.granary.cost=8']);
    expect(flags.faults).toStrictEqual(['gate-probe']);
    expect(flags.json).toBe(true);
  });

  it('refuses an unknown flag, a missing value, an unknown map size and an unknown policy', () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--nope'], 'unknown option for sim'],
      [['--seeds'], 'needs a value'],
      [['--map-size', 'gigantic'], '--map-size expects one of'],
      [['--policy', 'genius'], '--policy expects one of'],
      [['--turns', '0'], '--turns must be at least 1'],
      [['--sample-every', '0'], '--sample-every must be at least 1'],
      [['--fault', 'Not Kebab'], '--fault expects a kebab-case'],
    ];
    for (const [args, fragment] of cases) {
      const parsed = parseSimArgs(args);
      expect(parsed.ok, `args ${args.join(' ')}`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(fragment);
    }
  });

  it('reads one --override into its three parts and a typed value', () => {
    const flat = okOrThrow(parseOverrideText('units.settler.cost=4'));
    expect(flat.section).toBe('units');
    expect(flat.id).toBe('settler');
    expect(flat.field).toBe('cost');
    expect(flat.value).toStrictEqual({ kind: 'integer', value: 4 });

    const nested = okOrThrow(parseOverrideText('terrains.grassland.yields.shields=2'));
    expect(nested.field).toBe('yields.shields');

    const flag = okOrThrow(parseOverrideText('buildings.pyramids.wonder=true'));
    expect(flag.value).toStrictEqual({ kind: 'boolean', value: true });
  });

  it('refuses a malformed --override, naming what it expected', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['units.settler', 'expects <section>.<id>.<field>=<value>'],
      ['units..cost=1', 'a section, a row id and a field'],
      ['gadgets.settler.cost=1', 'is not one of terrains|units|buildings|improvements|resources'],
      ['units.settler.cost=', 'the value after "=" is empty'],
    ];
    for (const [text, fragment] of cases) {
      const parsed = parseOverrideText(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(fragment);
    }
  });

  it('builds a typed patch, and refuses a field or a value the row does not take', () => {
    const patch = okOrThrow(
      buildRulesetPatch([
        okOrThrow(parseOverrideText('terrains.grassland.yields.shields=2')),
        okOrThrow(parseOverrideText('units.worker.cost=2')),
      ]),
    );
    expect(patch.terrains?.['grassland']?.yields).toStrictEqual({ shields: 2 });
    expect(patch.units?.['worker']?.cost).toBe(2);
    // A patch that names no buildings must not carry an empty `buildings` key at all: an
    // empty section is a claim that the catalog's buildings were rewritten, and they
    // were not.
    expect(patch.buildings).toBeUndefined();

    const badField = buildRulesetPatch([okOrThrow(parseOverrideText('units.settler.speed=2'))]);
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.error).toContain('settable fields are');

    const badValue = buildRulesetPatch([okOrThrow(parseOverrideText('units.settler.cost=fast'))]);
    expect(badValue.ok).toBe(false);
    if (!badValue.ok) expect(badValue.error).toContain('takes an integer');

    const wonder = buildRulesetPatch([
      okOrThrow(parseOverrideText('buildings.pyramids.wonder=false')),
    ]);
    expect(wonder.ok).toBe(false);
    if (!wonder.ok) expect(wonder.error).toContain('may only be set to true');
  });

  it("addresses M6b's singleton combat section, in both of its spellings", () => {
    // The section is one row of nine numbers, so the flag names no id — and the long
    // spelling (`combat.combat.<field>`, the way the provenance report prints the row) is
    // accepted too, because a reader who copies a printed name should get what they copied.
    const short = okOrThrow(parseOverrideText('combat.wallsBonusPct=100'));
    expect(short.section).toBe('combat');
    expect(short.id).toBe('combat');
    expect(short.field).toBe('wallsBonusPct');
    expect(short.value).toStrictEqual({ kind: 'integer', value: 100 });

    const long = okOrThrow(parseOverrideText('combat.combat.rollBound=10'));
    expect(long.field).toBe('rollBound');

    const patch = okOrThrow(
      buildRulesetPatch([
        okOrThrow(parseOverrideText('combat.wallsBonusPct=100')),
        okOrThrow(parseOverrideText('combat.combat.damagePerRound=3')),
      ]),
    );
    expect(patch.combat?.wallsBonusPct).toBe(100);
    expect(patch.combat?.damagePerRound).toBe(3);
    // The sections the flag did not name stay absent rather than becoming empty claims.
    expect(patch.units).toBeUndefined();
    expect(patch.terrains).toBeUndefined();
  });

  it("reads a combat global as a sweepable knob, with the catalog's own value", () => {
    // `readKnob` is what a `--knob combat.<field>` sweep goes through, and it reads the
    // shipped value *out of* the catalog: before M6b there was no such knob, and a sweep
    // that wanted one had to restate the number, which is a second source.
    const knob = okOrThrow(readKnob(CATALOG, 'combat.wallsBonusPct'));
    expect(knob.section).toBe('combat');
    expect(knob.id).toBe('combat');
    expect(knob.setting).toBe('wallsBonusPct');
    expect(knob.shipped).toBe(CATALOG.combat.wallsBonusPct);
    expect(knob.provenanceKind).toBe('placeholder');
    expect(knob.provenanceDetail).toBe(CATALOG.combat.provenance.note);

    // An unknown magnitude and an unknown row are both refused rather than read as zero:
    // a knob that silently became `0` would sweep a ruleset nobody wrote.
    expect(readKnob(CATALOG, 'combat.wallsBonusPCT').ok).toBe(false);
    expect(readKnob(CATALOG, 'combat.walls.rollBound').ok).toBe(false);

    // The two fields this CLI used to refuse with "not settable from the CLI" while the
    // applier would have honoured them.
    const hitPoints = okOrThrow(readKnob(CATALOG, 'units.warrior.hitPoints'));
    expect(hitPoints.setting).toBe('hitPoints');
    expect(hitPoints.shipped).toBe(CATALOG.units.find((row) => row.id === 'warrior')?.hitPoints);
    // M6's second spelling of the terrain bonus reads the same magnitude through the
    // engine's own reader, so the two names cannot report different numbers.
    const defense = okOrThrow(readKnob(CATALOG, 'terrains.grassland.defenseBonus'));
    expect(defense.setting).toBe('defenseBonus');
    expect(defense.shipped).toBe(
      okOrThrow(readKnob(CATALOG, 'terrains.grassland.defenseBonusPct')).shipped,
    );
    expect(okOrThrow(parseOverrideText('units.warrior.hitPoints=4')).field).toBe('hitPoints');
    expect(okOrThrow(parseOverrideText('units.warrior.requiresTech=pottery')).value).toStrictEqual({
      kind: 'text',
      value: 'pottery',
    });
  });

  it('refuses a misspelled combat magnitude, listing the nine that would work', () => {
    // A patch that named nothing would be a sweep reporting "no effect" for a knob that
    // was never applied, so the field is checked here and the nine names are the answer.
    const typo = buildRulesetPatch([okOrThrow(parseOverrideText('combat.wallsBonusPCT=100'))]);
    expect(typo.ok).toBe(false);
    if (!typo.ok) {
      expect(typo.error).toContain('wallsBonusPCT');
      expect(typo.error).toContain('wallsBonusPct');
    }

    // A row id is not a thing this section has, and saying so is better than looking for
    // a row called `walls` and failing with "unknown id".
    const noSuchRow = parseOverrideText('combat.walls.rollBound=10');
    expect(noSuchRow.ok).toBe(false);
    if (!noSuchRow.ok) expect(noSuchRow.error).toContain('no id to name');

    // A path with no field at all is the same complaint, not a crash.
    expect(parseOverrideText('combat.=10').ok).toBe(false);
  });

  it("addresses M7's singleton capture section, in both of its spellings", () => {
    // The second singleton, and the reason the singleton branch is now a *list* of
    // sections rather than an `if` for combat: the rule is about the section's shape, and
    // a section the CLI cannot spell is a knob a sweep reads about and cannot turn.
    const short = okOrThrow(parseOverrideText('capture.populationDivisor=4'));
    expect(short.section).toBe('capture');
    expect(short.id).toBe('capture');
    expect(short.field).toBe('populationDivisor');
    expect(short.value).toStrictEqual({ kind: 'integer', value: 4 });

    const long = okOrThrow(parseOverrideText('capture.capture.populationDivisor=3'));
    expect(long.id).toBe('capture');
    expect(long.field).toBe('populationDivisor');

    const patch = okOrThrow(
      buildRulesetPatch([okOrThrow(parseOverrideText('capture.populationDivisor=4'))]),
    );
    expect(patch.capture?.populationDivisor).toBe(4);
    // The sections the flag did not name stay absent rather than becoming empty claims.
    expect(patch.combat).toBeUndefined();
    expect(patch.units).toBeUndefined();
  });

  it("reads the capture divisor as a sweepable knob, with the catalog's own value", () => {
    // The knob the M7 evidence names: `--knob capture.populationDivisor` reads the shipped
    // value *out of* the catalog, so a sweep cannot restate the number it is sweeping —
    // which is the failure mode a second source in a script would reintroduce.
    const knob = okOrThrow(readKnob(CATALOG, 'capture.populationDivisor'));
    expect(knob.section).toBe('capture');
    expect(knob.id).toBe('capture');
    expect(knob.setting).toBe('populationDivisor');
    expect(knob.shipped).toBe(CATALOG.capture.populationDivisor);
    expect(knob.provenanceKind).toBe('placeholder');
    expect(knob.provenanceDetail).toBe(CATALOG.capture.provenance.note);

    // An unknown magnitude and a row id the section does not have are both refused rather
    // than read as zero: a knob that silently became `0` would sweep a ruleset nobody wrote
    // (and `floor(population / 0)` is `Infinity`).
    expect(readKnob(CATALOG, 'capture.populationDivizor').ok).toBe(false);
    expect(readKnob(CATALOG, 'capture.sack.populationDivisor').ok).toBe(false);
  });

  it('refuses a misspelled capture magnitude, listing the one that would work', () => {
    const typo = buildRulesetPatch([okOrThrow(parseOverrideText('capture.divisor=4'))]);
    expect(typo.ok).toBe(false);
    if (!typo.ok) {
      expect(typo.error).toContain('divisor');
      expect(typo.error).toContain('populationDivisor');
    }

    // A row id is not a thing this section has, and saying so is better than looking for a
    // row called `sack` and failing with "unknown id".
    const noSuchRow = parseOverrideText('capture.sack.populationDivisor=4');
    expect(noSuchRow.ok).toBe(false);
    if (!noSuchRow.ok) expect(noSuchRow.error).toContain('no id to name');

    // A path with no field at all is the same complaint, not a crash.
    expect(parseOverrideText('capture.=4').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The report, and the rule that the renderer computes nothing
 * ------------------------------------------------------------------ */

describe('the sim report is one structured value, rendered', () => {
  it('reports the batch, its aggregates and its invariant checks', () => {
    const report = simReportOf(SMALL);

    expect(report.kind).toBe('civts-sim-report');
    expect(report.status).toBe('ok');
    expect(report.exitCode).toBe(0);
    expect(report.runs).toHaveLength(2);
    expect(report.parameters.seeds).toStrictEqual([1, 2]);
    expect(report.parameters.seedSpec).toBe('1..2');
    expect(report.totals.runs).toBe(2);
    expect(report.totals.turnsPlayed).toBe(8);
    // One row per civilization per sampled turn, and one whole-registry check per turn.
    expect(report.totals.metricRows).toBe(2 * 2 * 4);
    expect(report.invariants.count).toBe(report.invariants.names.length);
    expect(report.invariants.checks).toBe(report.invariants.count * report.totals.turnsPlayed);
    expect(report.invariants.violations).toBe(0);
    expect(report.violations).toStrictEqual([]);
    expect(report.aggregates.map((aggregate) => aggregate.metric)).toContain('population');
    expect(report.horizonTotals.map((total) => total.metric)).toStrictEqual([...HORIZON_METRICS]);
    // The engine has no victory condition, so the batch reports none — and the key is
    // omitted rather than written as an empty list, which would claim wins were counted.
    expect(report.wins).toBeUndefined();
  });

  it('prints the registry the report was built from — its count, and every name', () => {
    const report = simReportOf(SMALL);
    const output = okOrThrow(runSimCommand(SMALL));

    // The printed figure is the report's own field and the field is the registry's size,
    // so an invariant added to `CORE_INVARIANTS` cannot leave the report behind. It is
    // asserted against the registry itself rather than against a literal: the count was 20
    // before `city-tile-unique` landed, and a literal here would have gone stale in a way
    // no test could see.
    expect(report.invariants.count).toBe(CORE_INVARIANTS.length);
    expect(report.invariants.count).toBeGreaterThanOrEqual(21);
    expect(report.invariants.names).toStrictEqual(
      CORE_INVARIANTS.map((invariant) => invariant.name),
    );
    expect(report.invariants.names).toContain('city-tile-unique');
    expect(output.stdout).toContain(
      `invariants  ${String(report.invariants.count)} named predicates`,
    );
    expect(output.stdout).toContain('city-tile-unique');
  });

  // Full tier: 3.8 s — a multi-seed sweep through the real CLI, i.e. a batch run out of process. It is
  // the regression evidence for a fixed food-box bug, so it must keep running; the fast tier keeps the
  // single-seed CLI tests.
  it.skipIf(!FULL_TIER)(
    'holds the seeds that used to trip the food-box check, at ONE horizon',
    () => {
      // The five seeds whose cities completed a granary on the turn the growth pass had
      // already filled their box, and which `city-food-box-within-threshold` therefore
      // reported — a false positive: `advanceTurn` runs growth *before* production, so the
      // reduced threshold a completion brings applies to the NEXT growth check. They are
      // pinned here through the shipped command as a regression, and what is asserted is the
      // property that matters to a balance run: no violation, and one horizon. A batch whose
      // runs stop on different turns makes `BatchResult.aggregates` a mean over games of
      // different lengths, silently.
      const args: readonly string[] = [
        '--seeds',
        '6,17,29,38,39',
        '--map-size',
        'tiny',
        '--turns',
        '20',
      ];
      const output = okOrThrow(runSimCommand(args));
      const report = simReportOf(args);

      expect(report.status).toBe('ok');
      expect(report.exitCode).toBe(0);
      expect(report.invariants.violations).toBe(0);
      expect(report.violations).toStrictEqual([]);
      expect(report.runs).toHaveLength(5);
      // Every run reached `maxTurns` — no run was truncated by a check.
      expect([...new Set(report.runs.map((run) => run.turnsPlayed))]).toStrictEqual([20]);
      expect(report.runs.every((run) => run.stoppedBecause === 'max-turns')).toBe(true);
      // ...and the report says so itself, in the field the renderer reads to print its
      // horizon caveat: one horizon, no caveat.
      expect(report.totals.horizonVaries).toBe(false);
      expect(report.totals.horizonTurnMin).toBe(report.totals.horizonTurnMax);
      expect([...new Set(report.runs.map((run) => run.finalTurn))]).toStrictEqual([
        report.totals.horizonTurnMax,
      ]);
      expect(output.stdout).not.toContain('runs stopped on different turns');
      expect(output.stderr).toBe('');
    },
    300_000,
  );

  it('prints exactly the figures the structured value holds, for every metric', () => {
    const output = okOrThrow(runSimCommand(SMALL));
    const report = simReportOf(SMALL);
    const lines = output.stdout.split('\n');

    for (const aggregate of report.aggregates) {
      const line = lines.find((candidate) => candidate.startsWith(`  ${aggregate.metric} `));
      expect(line, `a rendered line for ${aggregate.metric}`).toBeDefined();
      if (line === undefined) continue;
      expect(line).toContain(String(aggregate.count));
      expect(line).toContain(String(aggregate.sum));
      expect(line).toContain(aggregate.mean.toFixed(2));
      expect(line).toContain(String(aggregate.median));
      expect(line).toContain(String(aggregate.min));
      expect(line).toContain(String(aggregate.max));
    }

    // The header's own figures are the report's too — the seed spec, the settings and the
    // check total are fields, not recomputations.
    expect(output.stdout).toContain(report.parameters.seedSpec);
    expect(output.stdout).toContain(String(report.invariants.checks));
    expect(output.stdout).toContain(String(report.totals.turnsPlayed));
    expect(output.stdout).toContain(report.ruleset.hash);
  });

  it('emits canonical JSON — sorted keys, no undefined, byte-stable across runs', () => {
    const first = okOrThrow(runSimCommand([...SMALL, '--json']));
    const second = okOrThrow(runSimCommand([...SMALL, '--json']));

    expect(first.stdout).toBe(second.stdout);
    expect(first.stderr).toBe('');

    const parsed: unknown = JSON.parse(first.stdout);
    expectSortedKeys(parsed, '$');
    // `canonicalize` throws on `undefined`, NaN or a class instance, so a report that
    // serialises at all is a report made only of representable data — and it must carry
    // what the in-process report carries, not a summary of it.
    expect(parsed).toStrictEqual(JSON.parse(JSON.stringify(simReportOf(SMALL))));
  });

  it('counts an override into the report, and pins the ruleset that produced it', () => {
    const shipped = simReportOf(SMALL);
    const overridden = simReportOf([...SMALL, '--override', 'units.settler.cost=5']);

    expect(overridden.ruleset.overrideCount).toBe(1);
    expect(overridden.ruleset.applied).toHaveLength(1);
    expect(overridden.ruleset.applied[0]).toContain('units.settler.cost');
    expect(overridden.ruleset.patch.units?.['settler']?.cost).toBe(5);
    // The hash is of the catalog the runs actually used: without it, a balance figure has
    // no way to say which content produced it.
    expect(overridden.ruleset.hash).not.toBe(shipped.ruleset.hash);

    const output = okOrThrow(runSimCommand([...SMALL, '--override', 'units.settler.cost=5']));
    expect(output.stdout).toContain('units.settler.cost');
  });

  it('refuses an override the catalog does not have, naming the known ids, and exits 2', () => {
    const refused = runSimCommand([...SMALL, '--override', 'units.dragon.cost=4']);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.exitCode).toBe(2);
    expect(refused.error.lines.join('\n')).toContain('units.dragon');
    expect(refused.error.lines.join('\n')).toContain('settler');
    expect(refused.error.usage).toBeDefined();
  });

  it('refuses an override that would produce an invalid ruleset, and exits 1', () => {
    const refused = runSimCommand([...SMALL, '--override', 'units.settler.cost=0']);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.exitCode).toBe(1);
    // The wording is `validateRuleset`'s, because the override went through it: an
    // override is not a second set of rules about what a catalog may say.
    expect(refused.error.lines.join('\n')).toContain('invalid value: units/settler.cost');
    expect(refused.error.usage).toBeUndefined();
  });

  it('refuses a malformed --override as a flag error, before running anything', () => {
    const refused = runSimCommand([...SMALL, '--override', 'units.settler']);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.exitCode).toBe(2);
    expect(refused.error.lines[0]).toContain('expects <section>.<id>.<field>=<value>');
  });

  it('counts a combat override into the report, so a swept battle figure has provenance', () => {
    // M6b's claim, at the CLI: a combat global is a knob like any other — it goes through
    // `applyOverrides`, it appears in the receipt, and it moves the ruleset hash the runs
    // are pinned to. Before M6b there was no way to say this on the command line at all.
    const shipped = simReportOf(SMALL);
    const overridden = simReportOf([...SMALL, '--override', 'combat.damagePerRound=3']);

    expect(overridden.ruleset.overrideCount).toBe(1);
    expect(overridden.ruleset.applied[0]).toContain('combat.combat.damagePerRound');
    expect(overridden.ruleset.patch.combat?.damagePerRound).toBe(3);
    expect(overridden.ruleset.hash).not.toBe(shipped.ruleset.hash);

    // The patch names one field, and the other eight keep the catalog's own values.
    expect(overridden.ruleset.patch.combat?.wallsBonusPct).toBeUndefined();
  });

  it('refuses a combat override that would break the odds clamp, and exits 1', () => {
    // Validation is the same function a hand-edited catalog goes through: a `rollBound`
    // under the ceiling is refused by name rather than producing a ruleset whose clamp has
    // no room.
    const refused = runSimCommand([...SMALL, '--override', 'combat.rollBound=10']);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.exitCode).toBe(1);
    expect(refused.error.lines.join('\n')).toContain('combat');
  });
});

/* ------------------------------------------------------------------ *
 * Violations
 * ------------------------------------------------------------------ */

describe('a violation is surfaced loudly, by name, seed and turn', () => {
  it('names the invariant, the seed and the turn, and exits 1', () => {
    const output = okOrThrow(
      runSimCommand(['--seeds', '1..2', '--turns', '2', '--fault', 'invariant-gate-self-test']),
    );
    const report = output.report;
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.status).toBe('violations');
    expect(report.exitCode).toBe(1);
    expect(output.exitCode).toBe(1);
    expect(report.totals.violatingRuns).toBe(2);
    expect(report.violations.map((violation) => violation.invariant)).toStrictEqual([
      'invariant-gate-self-test',
      'invariant-gate-self-test',
    ]);
    expect(report.violations.map((violation) => violation.seed)).toStrictEqual([1, 2]);
    expect(report.violations.every((violation) => violation.turn === 2)).toBe(true);
    // The injected invariant is part of the registry the report describes, so the report
    // says which registry was checked rather than implying the shipped one.
    expect(report.invariants.names).toContain('invariant-gate-self-test');

    expect(output.stdout).toContain('!!!');
    expect(output.stdout).toContain('INVARIANT VIOLATION');
    expect(output.stdout).toContain('seed 1, turn 2 — invariant-gate-self-test');
    expect(output.stdout).toContain(report.violations[0]?.message ?? 'injected fault');
  });

  it('keeps stdout machine-readable under --json and shouts on stderr', () => {
    const output = okOrThrow(
      runSimCommand(['--seeds', '1', '--turns', '2', '--fault', 'gate-probe', '--json']),
    );
    const parsed: unknown = JSON.parse(output.stdout);
    expectSortedKeys(parsed, '$');
    expect(output.stdout).not.toContain('!!!');
    expect(output.stderr).toContain('!!!');
    expect(output.stderr).toContain('gate-probe');
    expect(output.stderr).toContain('seed 1, turn 2');
    expect(parsed).toMatchObject({ status: 'violations', exitCode: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * The real CLI, in a fresh process
 * ------------------------------------------------------------------ */

describe('the sim command through the real CLI', () => {
  it('runs a batch end to end and exits 0', () => {
    const run = runCli(['sim', ...SMALL]);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('civts sim — 2 games in one batch');
    expect(run.stdout).toContain('per-metric aggregates');
    expect(run.stdout).toContain('horizon');
    expect(run.stdout).toContain('invariants');
    expect(run.stdout).not.toContain('!!!');
  }, 300_000);

  // Full tier: determinism across two fresh processes, named by the standing requirement. Cheap in
  // wall clock (1.26 s) and impossible to test in-process, so it is worth the deferral.
  it.skipIf(!FULL_TIER)(
    'prints the same --json bytes twice, in two fresh processes',
    () => {
      const first = runCli(['sim', ...SMALL, '--json']);
      const second = runCli(['sim', ...SMALL, '--json']);

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toBe(second.stdout);

      const parsed: unknown = JSON.parse(first.stdout);
      expectSortedKeys(parsed, '$');
      expect(parsed).toMatchObject({ kind: 'civts-sim-report', status: 'ok', exitCode: 0 });
    },
    300_000,
  );

  it('refuses an invalid --override with a clear message and a non-zero exit', () => {
    const run = runCli(['sim', ...SMALL, '--override', 'units.dragon.cost=4']);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('--override units.dragon.cost=4');
    expect(run.stderr).toContain('no such row');
    expect(run.stderr).toContain('usage: civts sim');
  }, 300_000);

  it('surfaces a violation loudly and exits non-zero', () => {
    const run = runCli(['sim', '--seeds', '1', '--turns', '2', '--fault', 'cli-gate-probe']);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('!!!');
    expect(run.stdout).toContain('cli-gate-probe');
    expect(run.stdout).toContain('seed 1, turn 2');
    expect(run.stdout).toContain('in 1 of 1 run');
    expect(run.stdout).toContain('totals      1 run, 1 turn played');
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * The balance sweep
 * ------------------------------------------------------------------ */

describe('the balance sweep', () => {
  it('parses its own flags, and defaults to the experiment it was handed', () => {
    const defaults = okOrThrow(parseSweepArgs([]));
    expect(defaults.knob).toBeUndefined();
    expect(defaults.values).toBeUndefined();
    expect(defaults.json).toBe(false);

    const explicit = okOrThrow(
      parseSweepArgs([
        '--knob',
        'buildings.factory.maintenance',
        '--values',
        '3,1,5,1',
        '--seeds',
        '1..3',
        '--turns',
        '7',
        '--json',
      ]),
    );
    expect(explicit.knob).toBe('buildings.factory.maintenance');
    // Ascending and unique: a value listed twice is one row, not two identical ones.
    expect(explicit.values).toStrictEqual([1, 3, 5]);
    expect(explicit.seeds).toStrictEqual([1, 2, 3]);
    expect(explicit.turns).toBe(7);

    const unknown = parseSweepArgs(['--nope']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('unknown option for the sweep');
  });

  // Full tier: 1.75 s — the same seeds under every value of a knob, i.e. a batch per variant, which is
  // exactly the mutation-sweep shape the standing requirement assigns to the full tier.
  it.skipIf(!FULL_TIER)(
    'runs the same seeds under every value, with the shipped row as its own control',
    () => {
      const report = sweepReportOf([], TEST_DEFAULTS);

      expect(report.kind).toBe('civts-balance-sweep');
      expect(report.status).toBe('ok');
      expect(report.exitCode).toBe(0);
      expect(report.knob.field).toBe('units.settler.cost');
      // The shipped value and its provenance come from the catalog, never from the caller.
      expect(report.knob.shipped).toBe(3);
      expect(report.knob.provenanceKind).toBe('placeholder');
      expect(report.knob.provenanceDetail.length).toBeGreaterThan(0);

      // The control: no override at all, so its hash is the shipped catalog's.
      expect(report.baseline.overrides).toStrictEqual([]);
      expect(report.baseline.runs).toBe(2);

      const rows = measuredRows(report);
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.value)).toStrictEqual([1, 3, 9]);
      expect(rows.map((row) => row.shipped)).toStrictEqual([false, true, false]);
      // Each value really produced a different ruleset, or the table would be measuring one
      // catalog three times and calling it a sweep.
      expect(new Set(rows.map((row) => row.rulesetHash)).size).toBe(3);
      expect(rows.every((row) => row.overrides.length === 1)).toBe(true);
      expect(report.violations).toStrictEqual([]);
      // The banner's own sentence is a stored count, not arithmetic the renderer does.
      expect(report.totals).toStrictEqual({ runs: 6, violatingRuns: 0 });

      // The shipped row and the no-override control measure the same numbers: the sweep
      // does not assume that, it displays it — and this is the display, asserted.
      const shipped = rows.find((row) => row.shipped);
      expect(shipped).toBeDefined();
      if (shipped === undefined) return;
      expect(shipped.rulesetHash).toBe(report.baseline.rulesetHash);
      expect(shipped.horizons).toStrictEqual(report.baseline.horizons);
      expect(shipped.deltas.every((delta) => delta.delta === 0)).toBe(true);
    },
  );

  // Full tier: 1.55 s, and it is not independently runnable — it reads the balance sweep's output,
  // which is itself a batch run. Running it fast would mean running the sweep anyway.
  it.skipIf(!FULL_TIER)(
    'shows a visible effect, and says so in a verdict rather than leaving it to the eye',
    () => {
      const output = okOrThrow(runSweepCommand([], TEST_DEFAULTS));
      const report = output.report;
      expect(report).toBeDefined();
      if (report === undefined) return;

      // The requirement is explicit: a sweep that shows no difference proves nothing. This
      // asserts the *relation* (some metric moved; the verdict says so) rather than pinned
      // figures, which would turn a content change into a test failure.
      const moved = report.effects.filter((effect) => effect.spread > 0);
      expect(moved.length).toBeGreaterThan(0);
      expect(report.verdict).toBe('moves-metrics');
      expect(moved.every((effect) => effect.min <= effect.max)).toBe(true);

      expect(output.stdout).toContain('VERDICT: the knob moves the measured metrics');
      expect(output.stdout).toContain(report.knob.field);
      expect(output.stdout).toContain(`${String(report.knob.shipped)} (shipped)`);
      expect(output.exitCode).toBe(0);
    },
  );

  it('says plainly when a knob moves nothing at all', () => {
    // A factory costs 25 shields, so no city has one 12 turns in: the maintenance of a
    // building nobody holds cannot change a metric, and the honest report is the one that
    // says the sweep proved nothing rather than one that treats a null result as a finding.
    const args = [
      '--knob',
      'buildings.factory.maintenance',
      '--values',
      '1,5',
      '--seeds',
      '1,4',
      '--turns',
      '12',
    ];
    const output = okOrThrow(runSweepCommand(args, TEST_DEFAULTS));
    const report = output.report;
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.knob.field).toBe('buildings.factory.maintenance');
    expect(report.verdict).toBe('no-measurable-effect');
    expect(report.effects.every((effect) => effect.spread === 0)).toBe(true);
    expect(output.stdout).toContain('VERDICT: NO MEASURABLE EFFECT');
    expect(output.stdout).toContain('proves nothing');
  });

  it('reports a value that cannot be run as a rejected row, never by dropping it', () => {
    const args = ['--values', '0,3', '--seeds', '1', '--turns', '3'];
    const output = okOrThrow(runSweepCommand(args, TEST_DEFAULTS));
    const report = output.report;
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.status).toBe('rejected-values');
    expect(report.exitCode).toBe(2);
    expect(output.exitCode).toBe(2);

    const rejected = report.rows.filter((row) => row.kind === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.value).toBe(0);
    if (rejected[0]?.kind === 'rejected') {
      expect(rejected[0].reason).toContain('invalid value: units/settler.cost');
    }
    expect(output.stdout).toContain('REJECTED');
  });

  it('refuses a knob that is not a number it can read, naming the row', () => {
    const unknown = runSweepCommand(['--knob', 'units.dragon.cost'], TEST_DEFAULTS);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.exitCode).toBe(2);
      expect(unknown.error.lines.join('\n')).toContain('units.dragon');
    }

    const wordField = runSweepCommand(['--knob', 'units.settler.name'], TEST_DEFAULTS);
    expect(wordField.ok).toBe(false);
    if (!wordField.ok) {
      expect(wordField.error.lines.join('\n')).toContain('units.settler.name');
      expect(wordField.error.lines.join('\n')).toContain('not a number this sweep can read');
    }
  });

  it('emits the sweep as canonical JSON, sorted and stable', () => {
    const first = okOrThrow(runSweepCommand(['--json'], TINY_DEFAULTS));
    const second = okOrThrow(runSweepCommand(['--json'], TINY_DEFAULTS));

    expect(first.stdout).toBe(second.stdout);
    expect(first.stderr).toBe('');
    const parsed: unknown = JSON.parse(first.stdout);
    expectSortedKeys(parsed, '$');
    expect(parsed).toMatchObject({ kind: 'civts-balance-sweep', exitCode: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * The script the principal runs
 * ------------------------------------------------------------------ */

describe('scripts/balance-sweep.ts', () => {
  // Full tier: 2.4 s and two subprocess runs of the balance sweep. The standing requirement's
  // "vary one catalog number, run a batch" evidence is a sweep of batches; the fast tier keeps the
  // cheap half of the sweep suite and this one waits.
  it.skipIf(!FULL_TIER)(
    'runs as `npx tsx scripts/balance-sweep.ts …` and prints the same table twice',
    () => {
      const args = ['--values', '2,3', '--seeds', '1,4', '--turns', '8'];
      const first = runSweepScript(args);
      const second = runSweepScript(args);

      expect(first.status).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).toContain('balance sweep — units.settler.cost');
      expect(first.stdout).toContain('shipped value');
      expect(first.stdout).toContain('provenance');
      expect(first.stdout).toContain('VERDICT');
    },
    300_000,
  );

  it('refuses a flag it does not know, and explains itself when asked', () => {
    const bad = runSweepScript(['--nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown option for the sweep');

    const help = runSweepScript(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage: tsx scripts/balance-sweep.ts');
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * The combat/capture sweep, and the sentence a flat table needs (M7)
 * ------------------------------------------------------------------ */

describe('scripts/combat-balance-sweep.ts', () => {
  /**
   * The M7 acceptance evidence — "`CAPTURE_POPULATION_DIVISOR` is in the catalog and
   * swept" — as a regression rather than as a paragraph in a report.
   *
   * Two claims, and both are the kind that rot silently:
   *
   * 1. **Every combat and capture magnitude is reachable.** The report proves it field by
   *    field (each magnitude patched through `applyOverrides` and read back), and the
   *    count it prints is asserted here to be a full `N of N` — so a magnitude that stops
   *    being carried, or a validator that starts refusing a legal value, fails this test
   *    instead of quietly dropping out of a table. The "cannot move" list must be empty,
   *    which is the milestone's headline claim.
   * 2. **A flat table always comes with its reading.** The walls-bonus sweep is the M7
   *    repair's own example: it was flat for two milestones, and whether that is a finding
   *    about the knob or a limitation of the measurement is exactly what a reader cannot
   *    tell from the numbers. The script must say which, in words, whenever no effect is
   *    measurable — never print a flat table on its own.
   *
   * Full tier: two subprocess runs of the sweep (~3 s together). The script is deterministic
   * by construction, so running it twice also pins that the table is a function of its flags.
   */
  it.skipIf(!FULL_TIER)(
    'sweeps the capture divisor, proves every magnitude reachable, and classifies a flat table',
    () => {
      const args = [
        '--knob',
        'capture-divisor',
        '--values',
        '1,2',
        '--seeds',
        '1',
        '--turns',
        '20',
      ];
      const first = runCombatSweepScript(args);
      const second = runCombatSweepScript(args);

      expect(first.status).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toBe(second.stdout);

      // The knob really moved: the receipt names the section, the row id and the field, and
      // the effective column is the *patched* value rather than the shipped one.
      expect(first.stdout).toContain('knob:      capture.populationDivisor');
      expect(first.stdout).toContain('capture.capture.populationDivisor: ');
      expect(first.stdout).toContain('EXPOSURE (what the swept knob was actually given)');

      // Item 1: no magnitude is unreachable, and all of them are proven movable.
      expect(first.stdout).toContain(
        'combat and capture magnitudes this override surface CANNOT move',
      );
      expect(first.stdout).toContain('(none —');
      const reachability = /reachability of every combat\/capture magnitude: (\d+) of (\d+)/.exec(
        first.stdout,
      );
      expect(reachability).not.toBeNull();
      // `N of N`, with N > 0 — the assertion that would fail if a magnitude were dropped
      // from the probe list, which is how "reachable" would quietly stop being checked.
      expect(reachability?.[1]).toBe(reachability?.[2]);
      expect(Number(reachability?.[1])).toBeGreaterThan(0);
      expect(first.stdout).toContain('ok   capture.populationDivisor');

      // Item 2: the flat-table reading. The walls knob's grid is flat at this size, and the
      // report must say which of the two things that means rather than leaving it to the
      // reader. (When the exposure is zero the honest answer is the measurement limitation;
      // once the real policy reaches walled cities it may become the other one. Either
      // sentence is accepted here — what is asserted is that one of them is printed.)
      const flat = runCombatSweepScript([
        '--knob',
        'walls-bonus',
        '--seeds',
        '1',
        '--turns',
        '20',
        '--values',
        '0,100',
      ]);
      expect(flat.status).toBe(0);
      if (flat.stdout.includes('NO MEASURABLE EFFECT')) {
        expect(flat.stdout).toMatch(/MEASUREMENT LIMITATION|TRUE FINDING/);
      }
      // …and the exposure is printed either way: whether or not the table moved, the reader
      // is told how often the knob was in play.
      expect(flat.stdout).toContain('EXPOSURE (what the swept knob was actually given)');
      expect(flat.stdout).toContain('battles fought by a defender inside its own walled city');
    },
    300_000,
  );

  it('refuses a knob it does not know, and explains itself when asked', () => {
    const bad = runCombatSweepScript(['--knob', 'unit-cost']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown knob');
    expect(bad.stderr).toContain('capture-divisor');

    const help = runCombatSweepScript(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage: npx tsx scripts/combat-balance-sweep.ts');
    expect(help.stdout).toContain('capture.populationDivisor');
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * The tournament command
 *
 * M7's second command, and the same discipline as `sim`: one structured value, a renderer
 * that only formats it, and `--json` for `canonicalize` of that value. What this section
 * proves beyond `sim`'s rules is what a tournament adds — the seat rotation is visible in
 * the report, the pass/fail condition is the violation count, and the budget verdict is
 * honest in both directions.
 * ------------------------------------------------------------------ */

/** A small tournament: two games, two seats, four turns each. Milliseconds to run. */
const SMALL_TOURNAMENT: readonly string[] = [
  '--seeds',
  '1..2',
  '--turns',
  '4',
  '--seats',
  'simple,none',
  '--map-size',
  'duel',
];

const tournamentReportOf = (args: readonly string[]): TournamentReport => {
  const output = okOrThrow(runTournamentCommand(args));
  if (output.report === undefined) throw new Error('the command produced no report');
  return output.report;
};

/** The `--json` report as the plain object a pipeline parses out of stdout. */
const parsedJson = (output: { readonly stdout: string }): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(output.stdout);
  if (!isRecord(parsed)) throw new Error('the JSON report is not an object');
  return parsed;
};

/**
 * The report with the **one** field a clock decides replaced.
 *
 * `elapsedMs` is a measurement of the harness's own work, so two runs of the same flags
 * cannot agree on it — there is no honest way to make a wall-clock reading reproducible.
 * Everything else must be byte-identical, which is what the test below asserts by
 * comparing the whole report with that one field (and the figure derived from it) pinned.
 */
const withoutTiming = (report: Record<string, unknown>): Record<string, unknown> => {
  const budget = report['budget'];
  if (!isRecord(budget)) throw new Error('the report has no budget block');
  return {
    ...report,
    budget: { ...budget, elapsedMs: 0, overByMs: 0 },
  };
};

describe('the tournament command parses its flags, and refuses what it cannot mean', () => {
  it('leaves every default absent when no flag is given', () => {
    const flags: TournamentFlags = okOrThrow(parseTournamentArgs([]));
    expect(flags.seeds).toBeUndefined();
    expect(flags.seedSpec).toBeUndefined();
    expect(flags.seats).toBeUndefined();
    expect(flags.mapSize).toBeUndefined();
    expect(flags.civCount).toBeUndefined();
    expect(flags.turns).toBeUndefined();
    expect(flags.budgetMs).toBeUndefined();
    expect(flags.overrides).toStrictEqual([]);
    expect(flags.faults).toStrictEqual([]);
    expect(flags.json).toBe(false);
  });

  it('parses the whole flag set, seats included and in order', () => {
    const flags = okOrThrow(
      parseTournamentArgs([
        '--seeds',
        '1..3',
        '--seats',
        'smart, simple ',
        '--map-size',
        'duel',
        '--civs',
        '2',
        '--turns',
        '6',
        '--budget-ms',
        '2500',
        '--override',
        'units.settler.cost=4',
        '--fault',
        'gate-probe',
        '--json',
      ]),
    );

    expect(flags.seeds).toStrictEqual([1, 2, 3]);
    expect(flags.seedSpec).toBe('1..3');
    // Left to right, and "a policy may repeat" needs no special case: this is a list.
    expect(flags.seats).toStrictEqual(['smart', 'simple']);
    expect(flags.mapSize).toBe('duel');
    expect(flags.civCount).toBe(2);
    expect(flags.turns).toBe(6);
    expect(flags.budgetMs).toBe(2500);
    expect(flags.overrides).toStrictEqual(['units.settler.cost=4']);
    expect(flags.faults).toStrictEqual(['gate-probe']);
    expect(flags.json).toBe(true);
  });

  it('refuses a flag it cannot mean, naming the flag', () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--nope'], 'unknown option for the tournament'],
      [['--seats'], 'needs a value'],
      [['--seats', 'genius'], '--seats expects a comma-separated list'],
      [['--seats', 'simple,,none'], 'empty entry'],
      [['--seats', 'simple,'], 'empty entry'],
      [['--map-size', 'gigantic'], '--map-size expects one of'],
      [['--turns', '0'], '--turns must be at least 1'],
      [['--budget-ms', '-1'], '--budget-ms must be zero or more'],
      [['--budget-ms', 'soon'], '--budget-ms expects an integer'],
      [['--fault', 'Not Kebab'], '--fault expects a kebab-case'],
    ];
    for (const [args, fragment] of cases) {
      const parsed = parseTournamentArgs(args);
      expect(parsed.ok, `args ${args.join(' ')}`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(fragment);
    }
  });

  it('refuses a seat list that does not match the number of civilizations, and exits 2', () => {
    const output = runTournamentCommand(['--seats', 'simple,none,simple', '--civs', '2']);

    expect(output.ok).toBe(false);
    if (output.ok) return;
    expect(output.error.exitCode).toBe(2);
    expect(output.error.lines.join('\n')).toContain('every seat needs exactly one policy');
    expect(output.error.lines.join('\n')).toContain('a policy may repeat');
  });

  it('explains itself when asked, without running a game', () => {
    const output = okOrThrow(runTournamentCommand(['--help']));

    expect(output.exitCode).toBe(0);
    expect(output.report).toBeUndefined();
    expect(output.stdout).toContain('usage: civts tournament');
    // The rotation is documented where a reader meets the flags, not only in the code.
    expect(output.stdout).toContain('Seats ROTATE');
    // ...and the default budget the report will quote is the library's own stated one, so
    // the help text and the verdict cannot disagree about what a run was judged against.
    expect(output.stdout).toContain(String(DEFAULT_TOURNAMENT_BUDGET_MS));
    // Every exit code this command can return is stated, including the one that says a run
    // was slow rather than broken.
    expect(output.stdout).toContain('but the run took longer than the budget');
  });

  it('states the default it will run, and says how to ask for A3’s nine-minute experiment', () => {
    // M7b's second stale claim: the help text used to present A3's twenty seeds at a hundred
    // turns as the default, which is what made `civts run` a nine-minute job. The two facts a
    // reader needs are (a) what will happen if they type nothing and (b) what to type to get
    // the evidence run — and both are asserted here rather than left to the reader to infer
    // from a constant.
    const lines = okOrThrow(runTournamentCommand(['--help'])).stdout;

    expect(lines).toContain(`(default ${DEFAULT_TOURNAMENT_SEED_SPEC}`);
    expect(lines).toContain(`(default ${String(DEFAULT_TOURNAMENT_TURNS)})`);
    expect(lines).toContain('THE DEFAULT RUN IS SMALL ON PURPOSE');
    // The larger run is NAMED, with both of its numbers and its measured cost, so "ask for it
    // explicitly" is an instruction a reader can follow.
    expect(lines).toContain(A3_TOURNAMENT_SEED_SPEC);
    expect(lines).toContain(`--turns ${String(A3_TOURNAMENT_TURNS)}`);
    expect(lines).toContain('NINE MINUTES');
    expect(lines).toContain('pnpm tournament:evidence');
    // And A3's experiment is NOT the default: a help text that mentioned it as one would be
    // the footgun this change exists to remove.
    expect(lines).not.toContain(`default ${A3_TOURNAMENT_SEED_SPEC}`);
    expect(lines).not.toContain(`default ${String(A3_TOURNAMENT_TURNS)})`);
  });

  it('runs two games of ten turns when no flag is given — the pinned default', () => {
    // The default is pinned by RUNNING it, not by reading two constants: the report is the
    // CLI's own structured value, so this fails if the command stops reading the constants it
    // documents. `--map-size duel` is the only flag, and it is there to keep the two default
    // games cheap (~1 s in-process) — the horizon and the seed set are the defaults.
    const report = tournamentReportOf(['--map-size', 'duel']);

    expect(DEFAULT_TOURNAMENT_SEED_SPEC).toBe('1..2');
    expect(DEFAULT_TOURNAMENT_TURNS).toBe(10);
    expect(report.parameters.seedSpec).toBe(DEFAULT_TOURNAMENT_SEED_SPEC);
    expect(report.parameters.seeds).toStrictEqual([1, 2]);
    expect(report.parameters.maxTurns).toBe(DEFAULT_TOURNAMENT_TURNS);
    // Both games really played the whole default horizon — a report that *said* ten turns and
    // stopped at two would be worse than a slow default.
    expect(report.games.map((game) => game.turnsPlayed)).toStrictEqual([
      DEFAULT_TOURNAMENT_TURNS,
      DEFAULT_TOURNAMENT_TURNS,
    ]);
    expect(report.games.map((game) => game.stoppedBecause)).toStrictEqual([
      'max-turns',
      'max-turns',
    ]);
    // Two games with two seats is the shortest run whose rotation completes: each of the two
    // policy instances plays each seat once, which is what "a policy that only wins from seat
    // 0 has not been tested" asks of the smallest experiment.
    for (const policy of report.policies) {
      expect(policy.seatGames).toStrictEqual([1, 1]);
    }
    expect(report.verdict.accepted).toBe(true);
    // A3's experiment is a different, larger thing — and the constants say so, so the help
    // text, the default and the evidence script cannot drift apart.
    expect(A3_TOURNAMENT_SEED_SPEC).not.toBe(DEFAULT_TOURNAMENT_SEED_SPEC);
    expect(A3_TOURNAMENT_TURNS).toBeGreaterThan(DEFAULT_TOURNAMENT_TURNS);
  });

  it('defaults to the real AI in every seat — a self-play tournament', () => {
    // One seed and one turn: enough to read the seating off the report, and cheap enough
    // for the fast tier even though the real policy makes every decision.
    const report = tournamentReportOf(['--seeds', '1', '--turns', '1', '--map-size', 'duel']);

    expect(report.parameters.seats).toStrictEqual(['smart', 'smart']);
    expect(report.policies.map((policy) => policy.policy)).toStrictEqual(['smart', 'smart']);
    // Two seats running policies with one name: the labels keep the two rows apart, so a
    // self-play report cannot read as one policy reported twice.
    expect(report.policies.map((policy) => policy.label)).toStrictEqual(['smart #0', 'smart #1']);
    expect(report.games[0]?.seats).toStrictEqual(['smart #0', 'smart #1']);
  });
});

describe('the tournament report is one structured value, rendered', () => {
  it('reports the games, the rotated seating, the verdict and the budget', () => {
    const report = tournamentReportOf(SMALL_TOURNAMENT);

    expect(report.kind).toBe('civts-tournament-report');
    expect(report.status).toBe('ok');
    expect(report.exitCode).toBe(0);
    expect(report.games.map((game) => game.seed)).toStrictEqual([1, 2]);
    expect(report.totals.games).toBe(report.games.length);
    expect(report.seats.map((seat) => seat.seat)).toStrictEqual([0, 1]);
    expect(report.policies).toHaveLength(2);
    expect(report.verdict.passed).toBe(true);
    expect(report.verdict.accepted).toBe(true);
    expect(report.violations).toStrictEqual([]);

    // The rotation is in the report, game by game: the two seatings, alternating.
    expect(report.games.map((game) => game.seats)).toStrictEqual([
      ['simple-placeholder', 'do-nothing'],
      ['do-nothing', 'simple-placeholder'],
    ]);
    // ...and in the per-policy totals, which is where a reader checks that an experiment was
    // long enough for its rotation to complete.
    for (const policy of report.policies) {
      expect(policy.seatGames).toStrictEqual([1, 1]);
    }
  });

  it('prints exactly the figures the structured value holds, for every seat and policy', () => {
    // One invocation, and the report it produced: comparing a text report with a *second*
    // run's value would fail on the timing field alone, which is not a rendering bug.
    const output = okOrThrow(runTournamentCommand([...SMALL_TOURNAMENT]));
    const report = output.report;
    if (report === undefined) throw new Error('the command produced no report');

    for (const seat of report.seats) {
      const noun = seat.games === 1 ? 'game' : 'games';
      expect(output.stdout).toContain(
        `seat ${String(seat.seat)} — ${String(seat.games)} ${noun}, played by ${seat.policies.join(', ')}:`,
      );
      // Every metric of the seat's stored horizon table is printed under it.
      expect(seat.horizon.map((total) => total.metric)).toStrictEqual([...HORIZON_METRICS]);
    }

    for (const policy of report.policies) {
      expect(output.stdout).toContain(`seats ${policy.seatGames.join('/')}`);
      expect(output.stdout).toContain(policy.policy);
    }

    for (const game of report.games) {
      expect(output.stdout).toContain(game.finalHash);
      expect(output.stdout).toContain(game.seats.join(', '));
    }

    // The budget, the check total and the verdict are fields, not recomputations.
    expect(output.stdout).toContain(`${String(report.budget.budgetMs)}ms stated`);
    expect(output.stdout).toContain(`${report.budget.elapsedMs.toFixed(1)}ms elapsed`);
    expect(output.stdout).toContain(String(report.invariants.checks));
    expect(output.stdout).toContain(report.verdict.summary);
    expect(output.stdout).toContain(String(report.totals.turnsPlayed));
    expect(output.stdout).toContain(report.ruleset.hash);
  });

  it('emits canonical JSON — sorted keys, no undefined, byte-stable across two runs', () => {
    const first = okOrThrow(runTournamentCommand([...SMALL_TOURNAMENT, '--json']));
    const second = okOrThrow(runTournamentCommand([...SMALL_TOURNAMENT, '--json']));
    const firstReport = parsedJson(first);
    const secondReport = parsedJson(second);

    expectSortedKeys(firstReport, 'tournament');
    // No key holds `undefined` (JSON would have dropped it) and nothing stringified to
    // `null` (which is how an `Infinity` budget would travel).
    expect(first.stdout).not.toContain('null');
    // The JSON text is the report itself, canonicalised: round-tripping the command's own
    // value reproduces the bytes it printed.
    const report = first.report;
    if (report === undefined) throw new Error('the command produced no report');
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(JSON.parse(first.stdout));

    // Byte-stability, stated exactly: `elapsedMs` is a wall-clock measurement of the
    // harness's own work and cannot be reproducible, and it is the *only* field that is not.
    expect(second.stdout).not.toBe(first.stdout);
    expect(withoutTiming(secondReport)).toStrictEqual(withoutTiming(firstReport));
    expect(secondReport['totals']).toStrictEqual(firstReport['totals']);
    expect(secondReport['games']).toStrictEqual(firstReport['games']);
    expect(secondReport['verdict']).toStrictEqual(firstReport['verdict']);
    // Both runs really did measure a clock, so the one unstable field is live rather than
    // a constant that happened to match.
    expect(typeof report.budget.elapsedMs).toBe('number');
    expect(report.budget.elapsedMs).toBeGreaterThan(0);
  });
});

describe('a tournament violation is surfaced loudly, by name, seed and turn', () => {
  const FAULTY: readonly string[] = [...SMALL_TOURNAMENT, '--fault', 'gate-probe'];

  it('names the invariant, fails the pass condition and exits 1', () => {
    const output = okOrThrow(runTournamentCommand(FAULTY));
    const report = tournamentReportOf(FAULTY);

    expect(output.exitCode).toBe(1);
    expect(report.status).toBe('violations');
    expect(report.verdict.passed).toBe(false);
    expect(report.verdict.accepted).toBe(false);
    expect(report.verdict.violations).toBeGreaterThan(0);
    expect(report.violations.map((violation) => violation.invariant)).toStrictEqual([
      'gate-probe',
      'gate-probe',
    ]);
    // A tournament's unit of work is a game, and the banner says so — one seed per game, so
    // a reader can tell which game to open.
    expect(output.stdout).toContain('INVARIANT VIOLATIONS');
    expect(output.stdout).toContain('gate-probe');
    expect(output.stdout).toContain('seed 1');
    expect(output.stdout).toContain('seed 2');
    expect(output.stdout).toContain('has found a bug');
    // A game stops on the turn that broke, so the tournament is shorter than its horizon —
    // and the report says which turn each game actually reached.
    expect(report.games.every((game) => game.stoppedBecause === 'violation')).toBe(true);
    expect(report.games.every((game) => game.turnsPlayed === 1)).toBe(true);
  });

  it('keeps stdout machine-readable under --json, and shouts on stderr', () => {
    const output = okOrThrow(runTournamentCommand([...FAULTY, '--json']));

    expect(output.exitCode).toBe(1);
    expect(() => JSON.parse(output.stdout) as unknown).not.toThrow();
    expect(output.stderr).toContain('INVARIANT VIOLATIONS');
    expect(output.stderr).toContain('gate-probe');
    expect(output.stdout).not.toContain('INVARIANT VIOLATIONS');
  });
});

describe('the tournament budget verdict is honest', () => {
  it('says OVER BUDGET, still plays every seed, and exits 3', () => {
    // A budget of zero milliseconds: no real run can be inside it, which is the honest
    // direction to test — a run that fits is the easy case.
    const args: readonly string[] = [...SMALL_TOURNAMENT, '--budget-ms', '0'];
    const output = okOrThrow(runTournamentCommand(args));
    const report = tournamentReportOf(args);

    expect(output.exitCode).toBe(3);
    expect(report.status).toBe('over-budget');
    expect(report.budget.budgetMs).toBe(0);
    expect(report.budget.withinBudget).toBe(false);
    expect(report.budget.overByMs).toBeGreaterThan(0);
    // The seed set is *not* trimmed to fit: both games were played and both are reported.
    expect(report.games).toHaveLength(2);
    expect(report.totals.games).toBe(2);
    expect(report.verdict.passed).toBe(true);
    expect(report.verdict.withinBudget).toBe(false);
    expect(report.verdict.accepted).toBe(false);

    expect(output.stdout).toContain('OVER BUDGET');
    expect(output.stdout).toContain('never trimmed to fit');
    expect(output.stderr).toBe('');
  });

  it('reports the defect when a run is both broken and late', () => {
    // Two failures with two different causes: a broken invariant (exit 1) must win over an
    // overrun (exit 3), because the defect is the thing to fix first — and the report still
    // carries the budget verdict rather than dropping it.
    const args: readonly string[] = [
      ...SMALL_TOURNAMENT,
      '--fault',
      'gate-probe',
      '--budget-ms',
      '0',
    ];
    const output = okOrThrow(runTournamentCommand(args));
    const report = tournamentReportOf(args);

    expect(output.exitCode).toBe(1);
    expect(report.status).toBe('violations');
    expect(report.verdict.passed).toBe(false);
    expect(report.budget.withinBudget).toBe(false);
    expect(report.verdict.accepted).toBe(false);
    // Both games were still played, and the roll-up counts both failures.
    expect(report.games).toHaveLength(2);
    expect(report.verdict.violations).toBe(2);
  });

  it('reports a met budget when the run is inside a stated one', () => {
    const args: readonly string[] = [...SMALL_TOURNAMENT, '--budget-ms', '600000'];
    const report = tournamentReportOf(args);

    expect(report.budget.withinBudget).toBe(true);
    expect(report.verdict.accepted).toBe(true);
    expect(report.budget.overByMs).toBe(0);
    expect(okOrThrow(runTournamentCommand(args)).exitCode).toBe(0);
  });
});
