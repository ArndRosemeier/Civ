/**
 * The **test tiers** — which suites the fast gate runs, and which the full one adds.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (twelve minutes
 * today is too slow to run) and the M5 acceptance evidence's closing line, "the fast
 * tier still under 90 s".
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
 *   between edits. It must stay well under 90 seconds, which is why the long suites
 *   are *not in it*.
 * - **full** (`pnpm test:full`, `pnpm verify:full`) — everything in fast **plus** the
 *   long ones. A superset: the full tier is the fast tier with the long tests added,
 *   never a different set of tests.
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
 * ## What is NOT a tier problem
 *
 * The fast tier's cost is dominated by a handful of tests, not by its breadth: the
 * 200-seed sweeps, the 120-turn conservation runs, the batch tournaments and the
 * fresh-process determinism checks. Everything else — the whole of `packages/core`,
 * `@civts/rules`, the scenario suite — is milliseconds per file and stays in the fast
 * tier. Moving a suite to the full tier is therefore a statement about *cost*, made
 * against a measurement, and every migrated test's comment records the number it was
 * migrated for.
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
