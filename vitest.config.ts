import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolvePath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@civts/core': resolvePath('./packages/core/src/index.ts'),
      '@civts/rules': resolvePath('./packages/rules/src/index.ts'),
      '@civts/testing': resolvePath('./packages/testing/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    reporters: ['dot'],
  },
});
