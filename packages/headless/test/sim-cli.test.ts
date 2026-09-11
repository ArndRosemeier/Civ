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
import { CORE_INVARIANTS } from '@civts/sim';
import { describe, expect, it } from 'vitest';
// The **test tier** predicate: this file's long sweeps are `it.skipIf(!FULL_TIER)` —
// they run under `pnpm verify:full` and are reported as skipped by `pnpm verify`. The
// boundary and its reasoning live in `@civts/testing`'s `tier.ts`, once.
import { FULL_TIER } from '@civts/testing';

import {
  HORIZON_METRICS,
  buildRulesetPatch,
  parseIntegerSpec,
  parseOverrideText,
  parseSeedSpec,
  parseSimArgs,
  parseSweepArgs,
  runSimCommand,
  runSweepCommand,
  type SimReport,
  type SweepCommandDefaults,
  type SweepReport,
  type SweepValueRow,
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
