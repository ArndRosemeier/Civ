/**
 * W3's Playwright configuration for the M8 end-to-end suite.
 * See docs/INTERFACES.md, M8 ("Where it lives", "Rendering, and how it is
 * tested (§16.2)") and PLAN.md §16.2.
 *
 * Three decisions worth stating, because each is a rule rather than a preference:
 *
 * - **127.0.0.1:4174, never 3080.** The app's dev/preview server binds the
 *   loopback address on the milestone's own port; 3080 is the DSH GUI and is never
 *   touched, restarted or proxied.
 * - **One browser, one worker, no retries.** The engine is deterministic, so a
 *   failure must be reproducible: a retry would hide exactly the flake this suite
 *   exists to detect, and parallel workers would put several games through one dev
 *   server for no gain.
 * - **Headless.** The suite runs with no display; a test that needs one is a test
 *   that has stopped being a gate.
 */

import { defineConfig } from '@playwright/test';

/** The app's port. Port 3080 belongs to the DSH GUI and is never used here. */
export const APP_ORIGIN = 'http://127.0.0.1:4174';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_ORIGIN,
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Static files only: the game runs in the browser and the engine ships with it.
    command: 'pnpm exec vite --host 127.0.0.1 --port 4174 --strictPort',
    url: APP_ORIGIN,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
