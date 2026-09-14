/**
 * Vite's configuration for `@civts/web`.
 * See docs/INTERFACES.md, M8 ("Where it lives, and where the game runs").
 *
 * Two decisions, and both are rules rather than preferences:
 *
 * - **The aliases point at the workspace packages' SOURCE.** The browser is the engine host, and
 *   the engine it hosts must be the same source the headless tests run — a build against a stale
 *   `dist/` would let the UI and the engine disagree about the rules while both looked correct.
 *   Vite resolves `@civts/core` and friends to each package's `src/index.ts`, exactly as the root
 *   `vitest.config.ts` alias map does, so there is one answer to "which engine is this?".
 *   `dedupe` names the same four packages so a transitive import cannot pull a second copy in.
 * - **The port belongs to this app.** 4174 is the milestone's own port (never 3080, which is the
 *   DSH GUI and is never touched, restarted or proxied); `strictPort` makes a busy port a loud
 *   failure rather than a silent move to a port no test is looking at, and `host` binds loopback
 *   only. The static-file server the e2e suite starts (`playwright.config.ts`) passes the same
 *   flags on the command line, so `pnpm dev`, `pnpm preview` and the suite all agree.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Public asset base for production hosting under a subdirectory (domainfactory).
 * Local `pnpm --filter @civts/web build` / preview keep `/` unless `CIV_BASE` is set.
 * Deploy CI passes `CIV_BASE=/Civ/` so built asset URLs resolve under https://futuremagic.de/Civ/.
 */
function resolveBase(): string {
  const fromEnv = process.env['CIV_BASE']?.trim();
  if (fromEnv === undefined || fromEnv.length === 0) {
    return '/';
  }
  return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`;
}

export default defineConfig({
  base: resolveBase(),
  /**
   * **`process.env` does not exist in a browser tab, and one imported module reads it.**
   *
   * `@civts/testing` decides the test tier with `process.env[TIER_ENV]` at module scope, and this
   * app imports that package for `hashValue` — the engine's own state digest, which is the value
   * `stateHash()` has to report ("the same hash the engine's goldens use"). Importing it is not
   * optional, and re-implementing it would be a second hash, so the reference is *defined away*
   * here: Vite substitutes `process.env` with an empty object at build time, which makes the tier
   * read `undefined` — the fast tier, which is what a browser is — instead of throwing
   * `process is not defined` before the first frame is drawn.
   *
   * The substitution is textual and compile-time: no `process` shim reaches the browser, and
   * nothing can read the host's environment by accident.
   */
  define: {
    'process.env': '({})',
  },
  resolve: {
    alias: {
      '@civts/core': resolvePath('../core/src/index.ts'),
      '@civts/rules': resolvePath('../rules/src/index.ts'),
      '@civts/testing': resolvePath('../testing/src/index.ts'),
      '@civts/sim': resolvePath('../sim/src/index.ts'),
    },
    dedupe: ['@civts/core', '@civts/rules', '@civts/testing', '@civts/sim'],
  },
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  build: {
    // The engine is shipped to the browser, so the build is what proves the browser can host it:
    // a Node-only import anywhere in `core`/`rules` would fail here rather than at run time in a
    // player's tab.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
