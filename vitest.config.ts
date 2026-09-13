import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
// The reporter API's own entry points: `Reporter` lives on `vitest/reporters` and the task type
// is `RunnerTask` — `Task` and the `vitest` root's `Reporter` are both deprecated aliases, and
// `pnpm lint` refuses deprecated spellings.
import type { Reporter } from 'vitest/reporters';
import type { RunnerTask } from 'vitest';

const resolvePath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * **The fast tier** — `pnpm test`, and therefore `pnpm verify`.
 *
 * Everything here that is not the alias list is the tier decision, so the two are
 * documented together.
 *
 * ## One test glob, two tiers, and the tier is decided *inside* a suite
 *
 * This config collects **every** test file in the workspace, the long ones included.
 * They are not excluded here and are not excluded by a filename convention: a long test
 * marks itself with `it.skipIf(!FULL_TIER)` (or `describe.skipIf(!FULL_TIER)`), and that
 * predicate lives in one place — `@civts/testing`'s `tier.ts`. `pnpm test:full` sets
 * `CIVTS_TEST_TIER=full` and runs *this same config*, so the full tier is the fast tier
 * with the long tests running rather than skipping — one config, one glob, one resolution
 * rule, two tiers. A second config file for the full tier would be a second statement of
 * the include glob and the alias map, which is the kind of difference nobody notices until
 * the two disagree.
 *
 * The reason for marking the *tests* instead of excluding the *files* is the failure mode
 * a tier split is most likely to have. **A tier split that silently stops running tests
 * is worse than a slow gate, because the tests still look like they exist.** A file-level
 * `exclude` takes a suite out of the fast run and leaves no trace of it there; a skip is
 * *reported by name* in the fast run's own summary, so `pnpm test` prints exactly what it
 * did not run. A reader learns the boundary from the gate's output rather than from having
 * to know a glob, which is what makes the split discoverable rather than hidden.
 *
 * ## The budget, measured rather than asserted
 *
 * Alpha criterion A5 bounds the commands a person runs: fast `pnpm verify` under 90 s of wall
 * time, `pnpm verify:full` under 10 minutes. M7b then re-drew the fast tier's *target* to
 * **≤ 70 s** on purpose — the point of the 20 s is headroom, because M8 adds a browser suite and
 * M9-M11 add systems, and a tier that exactly meets its bound is a tier that is about to break
 * it. This config is where both numbers are aimed at; the measured result is reported as the raw
 * output of `time pnpm verify`.
 *
 * **Wall time, not vitest's internal duration.** Those are two different numbers and the
 * difference is not rounding: after M7 the fast tier measured **65.9 s inside vitest** and
 * **104 s for `pnpm verify`** end to end. The bound is on the second, so the second is what is
 * reported — a run's own stopwatch does not include `typecheck`, `lint` or `format:check`, and
 * it is the whole command that a developer waits for. `pnpm verify` is four steps, and the
 * three that are not vitest cost a measured **37 s** on an idle machine (`typecheck` 5.5 s,
 * `lint` 21.7 s, `format:check` 10.0 s) — kept here as an M7b reading. **O3 replaced that
 * addition with a maximum**: the three checks are independent, so the fast tier now runs
 * them as concurrent processes and the static step is bounded by its slowest member. The
 * measurements that decided it are in the O3 section below, and the one thing a developer
 * needs from them is that the test step was never the problem.
 *
 * The tier boundary is drawn against a per-file measurement, not a guess. Vitest's JSON
 * reporter gives every file's span; on this machine the fast tier's critical path was two
 * files, because a file's tests run in one worker and the longest file is the wall. The
 * `after` column is from a run shared with another workspace's suite, so it is the pessimistic
 * reading of the same spans:
 *
 * | file                                            | before | after  | what moved                                     |
 * | ----------------------------------------------- | ------ | ------ | ---------------------------------------------- |
 * | `packages/sim/test/ai.test.ts`                   | 54.4 s | 7.6 s  | 7 whole-game tests → full tier                 |
 * | `packages/testing/test/m7-adversarial.test.ts`   | 47.9 s | 16.8 s | 4 long walks → full tier                       |
 * | `packages/headless/test/sim-cli.test.ts`         | 8.5 s  | 10.2 s | stays: the fast tier's own CLI tests           |
 * | `packages/sim/test/harness-adversarial.test.ts`  | 6.1 s  | 7.5 s  | stays                                          |
 * | the other 44 files                               | ≤ 4.8 s | ≤ 5.1 s | stay                                          |
 *
 * Neither file was trimmed: every migrated test still runs, in `pnpm verify:full`. See the skip
 * sites — each one's comment records the milliseconds it was measured at and what it buys, so
 * "why is this skipped?" is answerable from the test itself. The same measurement is what the
 * report below is checked against, and it is why the boundary moved *tests* rather than files:
 * the two files carried 102 s of a 104 s gate between them, and nothing else in the collection
 * was within 5 s of them.
 *
 * The result of that move, as the raw output of the command the criterion names. **These are
 * readings, not claims about what the tier costs now** — each is labelled with the box it was taken
 * on, because a figure that reads as current is a figure that goes stale silently, and this project
 * has already corrected that drift twice (a `~100 s` comment over a 489 s tier, and the five-file
 * budget restatement above). The **bound** is not quoted here at all: it lives in
 * `A3_TOURNAMENT_EVIDENCE` / `DEFAULT_TOURNAMENT_BUDGET_MS`, which is the one place it changes.
 *
 * - `real 0m57.320s` for fast `pnpm verify` **as measured when this tier was drawn** (M7b, quiet
 *   machine, vitest's own share 19.6 s), against `104 s` before it — 12.7 s inside the 70 s target
 *   and 33 s inside A5's 90 s bound;
 * - `real 1m0.655s` for a second run taken at the same time while another workspace's suite was
 *   running (`loadavg` 2.62, six of its test processes live), with vitest's own share 21.1 s — so
 *   the headroom survived a busy machine, which is the point of having any.
 *
 * Two things this config deliberately does **not** do. It does not exclude files (the header
 * above), and it does not shrink the *work* — the expensive experiments that are evidence
 * rather than regressions left the suite for scripts, where they are run on purpose:
 * `scripts/tournament-evidence.ts` runs A3's twenty seeds at a hundred turns, which no
 * per-commit gate can hold. **Its measured cost, and the budget it is judged against, are recorded
 * once in `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE` and are named here rather than repeated.** That
 * is deliberate, and this file is the worst possible place for a second copy: it is loaded by
 * every test run, and the figure it would quote is exactly the one that went stale in five files
 * at once (1.66×) when the AI got slower — and then stale a second time here when the budget
 * returned to 900 s (M7d; see `DEFAULT_TOURNAMENT_BUDGET_MS`, which is the one place the bound
 * itself lives). **No budget figure is restated in this file at all**, so there is no third time.
 * The same rule applied to the *full* tier, where the twenty-seed sixty-turn tournament in
 * `packages/sim/test/tournament.test.ts` measured 417 s — 85 % of that tier's 489 s — against a
 * comment claiming ~100 s: it is a four-seed smoke run now (9.2 s), and the twenty seeds are the
 * evidence script's job.
 *
 * **`real 2m58.085s` was quoted here for that tier, unlabelled, and it is not what the tier costs.**
 * Re-measured while landing H1, solo and with no other job of this workspace running, on the shared
 * box (`/home/box/Harness`, `loadavg` 5.7-9.9 from the machine's own long-lived processes):
 * `real 1m37.342s` (1913 tests passing, vitest's own share 96.6 s) and `real 1m41.303s` on a second
 * run. Both are **readings from 2026-09-13**, kept as such rather than as a current figure: the fast
 * tier is the gate on every commit and the one the ≤ 70 s bound is aimed at, so the full tier is
 * measured when the tier boundary moves, not restated as a standing number. The old figure is left
 * in this sentence instead of deleted because the 1.8× gap between it and the two runs above is
 * exactly the drift an unlabelled number invites, and the next reader deserves to see it named.
 *
 * **H2 re-took both bounds while verifying H1** (2026-09-13, same box and the same long-lived load
 * from the machine's own processes, no other job of this workspace running, each run starting with
 * `loadavg` 4.2-6.0 on eight cores): `real 0m53.062s` for fast `pnpm verify` — 17 s inside the 70 s
 * bound — and `real 2m5.756s` for `pnpm verify:full`, 7.9 minutes inside the 10 minute one. Those
 * runs collect **1914 tests** rather than the 1913 above, because H2 added one test to
 * `sim-cli.test.ts` (the phase-less planner record, a branch nothing else drove): the two counts are
 * readings from two runs, not a drift, and neither figure is a claim about what the tier costs next
 * week.
 *
 * ## O3 — the gate redrawn by measurement (2026-09-13)
 *
 * The wave opened with the fast gate **reported at 78.3 s wall on a shared box** — the figure
 * in the M11 contract, which this box did not reproduce: the same unmodified command measured
 * `real 1m5.237s` here at `loadavg` 4.3–5.0, so the two readings differ by the machine rather
 * than by the gate. Both agree on the diagnosis, which is why the diagnosis is what the redraw
 * acts on: roughly 45 s of it was eslint and prettier rather than tests. So the first thing
 * done was to measure the four steps separately, on a frozen
 * copy of HEAD (`d4e7f72`) rather than on the live tree — other workstreams were
 * mid-edit, and a red tree that fails in `typecheck` never reaches the test step, which
 * is not a timing. Every column below is the same frozen tree, driven by the same
 * commands, with no other job of this workspace running; the `loadavg` printed in the raw
 * output was 6.9 when the "one after another" column started and 12.4 after the last
 * `vitest` run — this run's own workers and whatever else the shared machine was doing are
 * both inside that number, which is why it is quoted rather than offered as a quiet box.
 *
 * | step                     | one after another | three at once, cold cache | three at once, warm cache |
 * | ------------------------ | ----------------- | ------------------------- | ------------------------- |
 * | `typecheck`              | 6.3 s             | 6.3 s                     | 6.3 s                     |
 * | `lint`                   | 26.4 s            | 26.5–27.9 s (writes cache) | 1.05 s                   |
 * | `format:check`           | 12.6 s            | 13.0 s (writes cache)     | 0.71 s                    |
 * | **static step**          | **45.2 s**        | **31.5 s**                | **6.4 s**                 |
 * | `test`                   | 25.7 s            | 24.4 s                    | 25.8 s                    |
 * | **the whole gate, steps** | **70.9 s**       | **55.9 s**                | **32.3 s**                |
 *
 * Two of those cells are separate readings rather than spans of the run beside them, and
 * are labelled so: the cold `lint` cost (26.5 s with eslint's default metadata strategy,
 * 27.9 s with the content strategy this repo uses) and the cold `format:check` cost
 * (13.0 s) were timed on the live tree within the same hour, not on the frozen copy. The
 * **static step** rows are the single measurement that matters, and each is one run.
 *
 * The finding is in the two bold rows: **the tests were never the gate.** The whole fast
 * test set is 61 files and 25.7 s of wall, and its critical path is a single file —
 * `packages/testing/test/m9-m10-adversarial.test.ts` at 15.5 s, with
 * `packages/headless/test/sim-cli.test.ts` at 12.9 s next (vitest's JSON reporter, same
 * run; the 61 files' spans sum to 113.7 s, which is only interesting as proof the work
 * is spread across workers). Nothing was moved to the full tier, no `skipIf` was added,
 * and no test was touched. What changed is `package.json`'s three static scripts, which
 * are now three concurrent processes guarded by an explicit `wait` on each (a bare
 * `wait` returns 0 and would have turned every lint failure green), and two caches.
 *
 * **What the caches do and do not cover is stated once, in `@civts/testing`'s
 * `tier.ts`** — including the one honest gap (a typed-lint verdict that depends on
 * another file's types is not re-derived for an unchanged file in the fast tier) and the
 * developer rule it implies. It is not restated here; this file is loaded by every test
 * run and is the worst place for a second copy of a rule.
 *
 * The two end-to-end readings that bracket all of this, kept because the bound is on the
 * command and not on the steps, and both taken with `time pnpm verify` — the command a
 * person runs. **Before:** `real 1m5.237s` on the live tree at `loadavg` 4.3–5.0, green,
 * `2023 passed | 56 skipped`. **After**, on the live tree again and green both times,
 * `2095 passed | 56 skipped` (the count is larger because three other workstreams landed
 * M11 tests in between): `real 0m54.798s` with no `.cache` at `loadavg` 10.7, and
 * `real 0m32.074s` warm at `loadavg` 12.0. The after pair was measured under **more** load
 * than the before, which is the wrong direction for a favourable comparison and the right
 * one for evidence: the command is ~10 s faster cold and ~33 s faster warm than the 65.2 s
 * before-reading, while carrying ~3.5 % more tests, leaving 15.2 s and 37.9 s of headroom
 * under the 70 s target on a box that was not quiet. No test was removed to buy it, and the
 * fast tier still names all 56 skipped tests, one line each.
 *
 * **A faster gate that catches nothing would be worse, so it was made to fail on purpose.**
 * Three probes against a frozen copy of HEAD, each applied to an existing file, each run
 * *after* the caches had been warmed by a green gate (the state a cache bug would need to
 * hide in): a type error appended to `packages/core/src/textview.ts` turned the gate red in
 * `typecheck` (`error TS2322`); a `new Date();` statement appended to the same file turned it
 * red in `lint` (`no-restricted-syntax`, the determinism guard); a failing test appended to
 * `packages/core/test/rng.test.ts` turned it red in `test` (`1 failed | 2023 passed | 56
 * skipped`). Each file was restored from a byte copy, its `sha256` was re-checked as
 * unchanged, and the gate was re-run green. The cache keys on file content, so the file that
 * broke was re-checked in every case; that is the property the probes exist to confirm.
 *
 * ## Why the alias map is exported
 *
 * One entry per workspace package. `@civts/sim` was added when the package landed: its own
 * tests import it by name, so it must resolve the same way the other three do rather than
 * through the package's self-reference alone — an alias list that covers three of four
 * packages is a resolution difference waiting to be discovered by whoever moves an
 * `exports` map. Both tiers run this file, so there is nothing to keep in sync.
 */
export const resolveAliases = {
  '@civts/core': resolvePath('./packages/core/src/index.ts'),
  '@civts/rules': resolvePath('./packages/rules/src/index.ts'),
  '@civts/testing': resolvePath('./packages/testing/src/index.ts'),
  '@civts/sim': resolvePath('./packages/sim/src/index.ts'),
};

/**
 * Every package's tests, including `packages/sim/test/harness-adversarial.test.ts`
 * (the S4 harness verification) — the glob is what makes a new package's tests part of
 * the gate rather than a directory nobody runs. Both tiers use it, unchanged.
 */
export const testInclude = ['packages/*/test/**/*.test.ts'];

/* ------------------------------------------------------------------ *
 * The skipped tests, BY NAME
 *
 * The header states the design's central claim: a test that is not run in this tier is
 * **reported as skipped, by name**, so a reader learns the boundary from the gate's own output
 * rather than from having to know a glob. That claim was false as configured — vitest's `dot`
 * reporter prints `7 skipped` per file and never says *which* seven, and the verbose reporter
 * does not name them either (measured, M7b). A count is exactly the "silently stops running
 * tests" failure the claim is about, one step milder.
 *
 * So the gate runs one more reporter, and it is deliberately tiny: on finish, walk the collected
 * tree, print every task this run marked `skip` or `todo`, grouped by file, with the names of
 * the suites it sits in. It computes nothing and asserts nothing — the node ids, names and
 * modes are all vitest's own — and it prints the same block in both tiers. **The full tier's
 * block is not empty, and that is a correction rather than a detail**: measured 2026-09-13,
 * `pnpm verify:full` reports `2077 passed | 2 skipped` and prints a two-line block for the
 * `CIVTS_MUTATION_CHECK=1` mutation checks in `m9-m10-adversarial.test.ts`, which are gated on
 * a *second* switch and run by `pnpm mutation:check`. Nothing is skipped in the full tier for
 * *tier* reasons, and the block is what says so out loud: with one reporter in both tiers,
 * `full ⊇ fast` is checkable by eye — the fast run's 56 names are all absent from the full
 * run's list of 2, and those 2 are a different question's answer.
 * ------------------------------------------------------------------ */

/** One skipped test: the file it is in, the suites around it, and its own name. */
interface SkippedTest {
  readonly file: string;
  readonly path: readonly string[];
  readonly name: string;
}

/** Skipped for the purposes of this report: `skip` (any `skipIf`) or `todo`. */
const isSkippedMode = (mode: string): boolean => mode === 'skip' || mode === 'todo';

/**
 * Every skipped test inside one collected task, in collection order.
 *
 * The walk carries the ancestors' `mode` down, so a `describe.skipIf` around a whole suite is
 * reported exactly like the `it.skipIf` it wraps. A `file` task is *not* walked through here —
 * its `name` is the file's own path, which the report's header line already carries, and
 * nesting it would print `packages/…/x.test.ts > packages/…/x.test.ts > …` for every test in
 * it. The reporter below starts at the file's children instead.
 */
const skippedTestsIn = (
  task: RunnerTask,
  file: string,
  path: readonly string[],
  inheritedSkip: boolean,
  out: SkippedTest[],
): void => {
  const skipped = inheritedSkip || isSkippedMode(task.mode);

  if (task.type === 'test') {
    if (skipped) out.push({ file, path, name: task.name });
    return;
  }
  // A `custom` task is a benchmark or an unhandled hook, never a test: it has no children.
  if (task.type === 'custom') return;

  for (const child of task.tasks) skippedTestsIn(child, file, [...path, task.name], skipped, out);
};

/** The block: one line per skipped test, grouped by file, or nothing when nothing is skipped. */
export const renderSkippedTests = (skipped: readonly SkippedTest[]): string => {
  if (skipped.length === 0) return '';

  const byFile = new Map<string, SkippedTest[]>();
  for (const test of skipped) {
    const forFile = byFile.get(test.file);
    if (forFile === undefined) byFile.set(test.file, [test]);
    else forFile.push(test);
  }

  const lines: string[] = [
    '',
    `Skipped in this tier — ${String(skipped.length)} ` +
      `${skipped.length === 1 ? 'test' : 'tests'}, reported by name so the split is readable from ` +
      'this output. They RUN under `pnpm verify:full` (CIVTS_TEST_TIER=full); nothing is deleted:',
  ];
  for (const [file, tests] of byFile) {
    lines.push(`  ${file} (${String(tests.length)})`);
    for (const test of tests) {
      const where = test.path.length === 0 ? '' : `${test.path.join(' > ')} > `;
      lines.push(`    · ${where}${test.name}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
};

/**
 * The reporter itself.
 *
 * It lands between the per-file lines and the totals, which is where it belongs: the names are
 * read against the `(27 tests | 7 skipped)` lines immediately above them. Note that the reporter
 * list lives here and **not** on the command line — `vitest run --reporter=dot` *replaces* this
 * array rather than adding to it (measured), so a `--reporter` flag in `package.json`'s `test`
 * script would silently switch this block off again. That is why the two scripts are plain
 * `vitest run`.
 */
export const skippedTestsReporter = (): Reporter => ({
  onFinished: (files) => {
    const skipped: SkippedTest[] = [];
    for (const file of files) {
      const fileSkipped = isSkippedMode(file.mode);
      for (const task of file.tasks) {
        skippedTestsIn(task, file.name, [], fileSkipped, skipped);
      }
    }
    const block = renderSkippedTests(skipped);
    if (block !== '') process.stdout.write(block);
  },
});

export default defineConfig({
  resolve: { alias: resolveAliases },
  test: {
    include: testInclude,
    environment: 'node',
    reporters: ['dot', skippedTestsReporter()],
    // Note the **absence** of an `exclude` beyond vitest's own defaults: the long suites
    // are collected, and reported as skipped by the tier predicate inside them — and named,
    // one line each, by the reporter above. Adding a `*.full.test.ts` glob here is the change
    // this design exists to prevent — see the header.
  },
});
