import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
 * M5's criterion A5: the fast tier is **≤ 90 s**, `pnpm verify:full` ≤ 10 min. See the
 * skip sites: each migrated test's comment records the measured cost it was migrated for
 * and what it buys, so "why is this skipped?" is answerable from the test itself.
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

export default defineConfig({
  resolve: { alias: resolveAliases },
  test: {
    include: testInclude,
    environment: 'node',
    reporters: ['dot'],
    // Note the **absence** of an `exclude` beyond vitest's own defaults: the long suites
    // are collected, and reported as skipped by the tier predicate inside them. Adding a
    // `*.full.test.ts` glob here is the change this design exists to prevent — see the
    // header.
  },
});
