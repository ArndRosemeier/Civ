/**
 * W3 — A4's debug panel, and the `State hash` status that is the panel's contractual element.
 * See docs/INTERFACES.md, M8 ("The accessibility contract": `dialog`/`Debug`, `status`/`State hash`).
 *
 * The panel's job in this suite is to be the human-readable twin of the test seam: the hash it
 * shows must be the SAME string `window.__CIVTS__.stateHash()` returns (and therefore the same
 * one the goldens store), so a person looking at the screen and a test looking at the seam are
 * reading one value.
 */

import { expect, test } from '@playwright/test';

import {
  debugDialog,
  endTurnButton,
  foundCity,
  openApp,
  openPanel,
  readState,
  seedApp,
  stateHash,
  stateHashIndicator,
} from './helpers.js';

const SEED = 909;

const openDebug = async (page: import('@playwright/test').Page): Promise<void> => {
  await openPanel(page, /^Debug$/);
  await expect(debugDialog(page)).toBeVisible();
};

test('A4 debug panel: it opens from its own control and shows the engine’s own state hash', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await openDebug(page);

  const hash = await stateHash(page);
  const status = stateHashIndicator(page);
  await expect(status).toBeVisible();
  await expect(status).toContainText(hash);
});

test('A4 debug panel: the hash and the counts follow the state as the game is played', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await openDebug(page);

  const before = await readState(page);
  const status = stateHashIndicator(page);
  await expect(status).toContainText(await stateHash(page));

  // The panel is opened once and then the game moves on: it must re-render from the state (a
  // stale debug panel is worse than none, because it looks authoritative).
  await foundCity(page);
  const afterFounding = await readState(page);
  expect(afterFounding.revision).toBeGreaterThan(before.revision);
  await expect(status).toContainText(await stateHash(page));

  await endTurnButton(page).click();
  const afterTurn = await readState(page);
  expect(afterTurn.turn).toBe(afterFounding.turn + 1);
  await expect(status).toContainText(await stateHash(page));

  // The internals listed beside the hash are the state's own numbers.
  const dialog = debugDialog(page);
  await expect(dialog).toContainText(String(afterTurn.revision));
  await expect(dialog).toContainText(String(afterTurn.seed));
  await expect(dialog).toContainText(String(afterTurn.units.length));
  await expect(dialog).toContainText(String(afterTurn.cities.length));
});

test('A4 debug panel: two different games have two different hashes on screen', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await openDebug(page);
  const first = await stateHashIndicator(page).innerText();
  const firstHash = await stateHash(page);
  expect(first).toContain(firstHash);

  // Founding a city changes the state, so the panel must change with it — a hash that never
  // moved would mean the panel is showing a frame from a previous game.
  await foundCity(page);
  const secondHash = await stateHash(page);
  expect(secondHash).not.toBe(firstHash);
  await expect(stateHashIndicator(page)).toContainText(secondHash);
  await expect(stateHashIndicator(page)).not.toContainText(firstHash);
});
