/**
 * The **test tiers** — which suites the fast gate runs, and which the full one adds.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (twelve minutes
 * today is too slow to run) and "M7b contracts — FROZEN (the gate budget, and a sane
 * default)", which re-drew the bound.
 *
 * The contract the two tiers exist for, in the standing requirement's own words:
 * **"Anything that runs a large batch must live in the full tier … `pnpm test` is the
 * fast tier (unit + scenario suites, well under 90 s); `pnpm verify:full` is
 * everything in fast plus the long sweeps, tournaments, determinism-across-processes
 * and the UI suite."**
 *
 * So there are exactly two tiers, and this module is the one place the boundary is
 * readable from code:
 *
 * - **fast** (`pnpm test`, `pnpm verify`) — the default, and what a developer runs
 *   between edits. M7b's bound is on the command, not on the runner: **`time pnpm
 *   verify` ≤ 70 s of wall time**, split into a static step (`typecheck` + `lint` +
 *   `format:check`, which run as three concurrent processes — see below) and a test
 *   step. Measured rather than assumed: on 2026-09-13 the four steps summed to
 *   **70.9 s** run one after another, and **45.2 s of that was the three checks, not
 *   the tests** — which is why the fix was to stop serialising them rather than to
 *   move tests. The
 *   long suites are *not in it* for that reason, and neither is the evidence machinery
 *   that does not belong in a gate at all: A3's twenty-seed tournament is
 *   `scripts/tournament-evidence.ts`, run on purpose rather than on every commit. **What
 *   that run costs, and the budget it is judged against, are recorded once — in
 *   `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE` — and are deliberately not repeated here.**
 *   This module is imported by every package, `@civts/sim` depends on it and not the other
 *   way round, so it cannot import that record; it names it instead. A tier document that
 *   quoted a timing would be a sixth copy of a number that went stale in five files at once
 *   (1.66×, when the AI got slower and the figure did not).
 * - **full** (`pnpm test:full`, `pnpm verify:full`) — everything in fast **plus** the
 *   long ones. A superset: the full tier is the fast tier with the long tests added,
 *   never a different set of tests.
 *
 * ## What the two *commands* run, check by check (O3, 2026-09-13)
 *
 * The tier boundary above is about tests. The commands also differ in how the three
 * static checks are invoked, and that difference is a **coverage** difference, so it is
 * stated here in full rather than left to the reader of `package.json`:
 *
 * | check           | `pnpm verify` (fast)                          | `pnpm verify:full` (full) |
 * | --------------- | --------------------------------------------- | ------------------------- |
 * | `typecheck`     | whole project, no cache — identical           | whole project, no cache   |
 * | `lint`          | every file, but a file whose content and resolved config are unchanged since its last clean lint is **skipped by eslint's cache** | `lint:full`: every file, **no cache** |
 * | `format:check`  | same cache rule, over prettier's file set     | `format:check:full`: every file, **no cache** |
 * | tests           | fast tier, skipped tests named in the output  | fast tier **plus** the long tests |
 *
 * The three checks are independent, read-only and single-threaded, so `check:static`
 * runs them as three concurrent processes and waits for all three; a failure in any of
 * them fails the step. Running them one after another cost 45.2 s of a 70.9 s step
 * total (measured 2026-09-13: `typecheck` 6.3 s, `lint` 26.4 s, `format:check` 12.6 s,
 * tests 25.7 s); concurrently the static step is bounded by its slowest member.
 *
 * **The one honest gap the cache leaves.** ESLint's cache is keyed on a file's own
 * content plus its resolved configuration. A typed-lint verdict can also depend on
 * *another* file's types, so editing a shared type under `packages/…/src` can in principle
 * change the right answer for a file that did not itself change — and the fast tier
 * would not re-lint that file. Two things bound it: `pnpm typecheck` runs uncached over
 * the whole project on every fast gate (so the type graph itself is always checked),
 * and `pnpm verify:full` re-lints and re-formats **every file with no cache**. The
 * developer-facing rule that follows: **after changing a shared type, run `pnpm
 * verify:full`** (or `pnpm lint:full`, which is the same uncached pass on its own)
 * before believing the lint is green. `--cache-strategy content` is deliberate for the
 * same reason — the default metadata strategy trusts mtime and size, and this project
 * mutates files in place with `writeFileSync` when it proves a gate can fail.
 *
 * ## How a suite declares its tier, and why this way
 *
 * A long test marks itself with `it.skipIf(!FULL_TIER)(...)` (or
 * `describe.skipIf(!FULL_TIER)`) and says in its own comment what it costs and what
 * it buys. The alternative — excluding whole *files* from the fast config — was
 * rejected on purpose, and the reason is the failure mode this split is most likely
 * to have: **a tier split that silently stops running tests is worse than a slow
 * gate, because the tests still look like they exist.** An excluded file leaves no
 * trace in the fast run; a skipped test is *reported as skipped, by name*, so
 * `pnpm test` prints exactly what it did not run. Someone reading a fast run can see
 * the deferred work rather than having to know that a config pattern hides it.
 *
 * That claim needed a reporter to be true: vitest's own `dot` and `verbose` reporters
 * print `7 skipped` per file and never name the seven. `vitest.config.ts` therefore adds
 * one tiny `Reporter` — `skippedTestsReporter`, about forty lines, reading nothing but
 * vitest's own task tree — which prints every deferred test, grouped by file, under the
 * per-file lines. Both tiers print that block; the full tier's is two lines for the
 * `CIVTS_MUTATION_CHECK=1` mutation checks (measured 2026-09-13: `2077 passed | 2 skipped`),
 * which are gated on a second switch and run by `pnpm mutation:check` — nothing is skipped in
 * the full tier for a *tier* reason, and the block is the evidence rather than a claim.
 *
 * ## What is NOT a tier problem
 *
 * The fast tier's cost was dominated by a handful of tests, not by its breadth. Measured
 * with vitest's per-file reporter while M7b re-drew the boundary: the 200-seed sweeps,
 * the 120-turn conservation runs, the batch tournaments and the fresh-process
 * determinism checks are milliseconds to a few seconds each, while **two files were the
 * whole gate** — `packages/sim/test/ai.test.ts` (54.4 s, seven whole-game tests) and
 * `packages/testing/test/m7-adversarial.test.ts` (47.9 s, four long walks). Those eleven
 * tests moved to the full tier and each one's comment records the number it was migrated
 * for; the two files now measure about 6 s and 15 s on a quiet machine (7.6 s and 16.8 s
 * while another workspace's suite was running), and everything else — the whole of
 * `packages/core`, `@civts/rules`, the scenario suite — stays in the fast tier.
 *
 * The same measurement done on the *full* tier found one test that was 85 % of it: the
 * twenty-seed sixty-turn tournament in `packages/sim/test/tournament.test.ts`, documented
 * at "~100 s on an idle machine" and measured at 417 s. It is a four-seed smoke run now,
 * and the twenty seeds are the evidence script's job — which is what the frozen contract
 * asks for, because an experiment that is most of the gate is not a gate test.
 *
 * **O3 re-measured this and moved no test.** With the boundary above in place the fast
 * tier's test step measured 25.7 s for all 61 files (critical path one file, 15.5 s),
 * while `typecheck` + `lint` + `format:check` measured 45.2 s run one after another —
 * the checks, not the tests, were the gate. The redraw therefore re-ran the checks
 * concurrently and cached lint and format; it did not shorten the test set, and no
 * `skipIf` was added or moved. See the table above for what the cache does and does not
 * cover in the fast tier.
 *
 * This module reads one environment variable and computes nothing else. It deliberately
 * imports no test framework: `@civts/testing` is shipped code that other packages
 * depend on, and a `vitest` dependency here would put the runner inside the library.
 * The predicate is the whole interface, and `vitest.config.ts` names the scripts.
 */

/**
 * The environment variable that selects the tier. Set by `package.json`'s
 * `test:full`/`verify:full` scripts; anything else — including an unset variable — is
 * the fast tier.
 */
export const TIER_ENV = 'CIVTS_TEST_TIER';

/** The value of `TIER_ENV` that selects the full tier. */
export const FULL_TIER_VALUE = 'full';

/**
 * Is this run the full tier?
 *
 * Read once, at module load, so a suite's decision cannot change mid-run, and so the
 * value is the same for every test file (each file is a fresh module graph, but the
 * environment is fixed for the whole process tree by the script that started it).
 *
 * The comparison is deliberately exact: a typo like `CIVTS_TEST_TIER=ful` selects the
 * *fast* tier, and prints skipped tests saying so, rather than half-selecting the full
 * one. A silently-ignored variable that looked like it worked would be the worst
 * reading of "explicit" — but note the direction of the failure: the gate still runs,
 * and it still says which tests it skipped.
 */
export const FULL_TIER: boolean = process.env[TIER_ENV] === FULL_TIER_VALUE;

/**
 * A sentence for a skipped test's own comment or a report — the tier, and the command
 * that runs it. Kept here so the two scripts and the test comments cannot drift.
 */
export const FULL_TIER_COMMAND = 'pnpm verify:full';
