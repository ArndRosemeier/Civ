import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolvePath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // One entry per workspace package. `@civts/sim` was added when the package landed:
    // its own tests import it by name, so it must resolve the same way the other three
    // do rather than through the package's self-reference alone — an alias list that
    // covers three of four packages is a resolution difference waiting to be discovered
    // by whoever moves an `exports` map.
    alias: {
      '@civts/core': resolvePath('./packages/core/src/index.ts'),
      '@civts/rules': resolvePath('./packages/rules/src/index.ts'),
      '@civts/testing': resolvePath('./packages/testing/src/index.ts'),
      '@civts/sim': resolvePath('./packages/sim/src/index.ts'),
    },
  },
  test: {
    // Every package's tests, including `packages/sim/test/harness-adversarial.test.ts`
    // (the S4 harness verification) — the glob is what makes a new package's tests part
    // of the gate rather than a directory nobody runs.
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    reporters: ['dot'],
  },
});
