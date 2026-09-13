/**
 * W3 — A4's save/load: a round trip that preserves `stateHash()`.
 * See docs/INTERFACES.md, M8 ("A4 coverage"):
 *
 * > Save/load writes to `localStorage` and must round-trip `stateHash()` unchanged.
 *
 * The assertion is the engine's own hash, before and after — not a comparison of panel text. The
 * round trip is exercised across a real reload, because a save that only survives inside one
 * document's memory is not a save.
 */

import { expect, test } from '@playwright/test';

import {
  foundCity,
  loadButton,
  openApp,
  readState,
  saveButton,
  seedApp,
  stateHash,
} from './helpers.js';

const SEED = 8080;

test('A4 save/load: a save round-trips stateHash() unchanged, across a page reload', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);

  // Play a little first, so the saved state is not merely "a fresh game": a city founded, and
  // a turn or two of pipeline behind it.
  await foundCity(page);
  await page.getByRole('button', { name: 'End turn', exact: true }).click();

  const savedHash = await stateHash(page);
  const savedState = await readState(page);

  await saveButton(page).click();
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.length), {
      message: 'Save game wrote nothing to localStorage',
    })
    .toBeGreaterThan(0);

  // Move the game on, so a load that did nothing at all would be caught.
  await page.getByRole('button', { name: 'End turn', exact: true }).click();
  const movedHash = await stateHash(page);
  expect(movedHash, 'the game did not move, so the round trip would be vacuous').not.toBe(
    savedHash,
  );

  // Reload first: the save must survive a document that has forgotten everything.
  await page.reload();
  await expect(loadButton(page)).toBeVisible();
  await loadButton(page).click();

  await expect
    .poll(async () => stateHash(page), { message: 'loading did not restore the saved game' })
    .toBe(savedHash);

  const loaded = await readState(page);
  expect(loaded.turn).toBe(savedState.turn);
  expect(loaded.seed).toBe(savedState.seed);
  expect(loaded.revision).toBe(savedState.revision);
  expect(loaded.units.length).toBe(savedState.units.length);
  expect(loaded.cities.length).toBe(savedState.cities.length);
  expect(loaded.cities[0]?.name).toBe(savedState.cities[0]?.name);

  // A loaded game is a game, not a snapshot: the engine still accepts commands for it.
  await page.getByRole('button', { name: 'End turn', exact: true }).click();
  expect((await readState(page)).turn).toBe(loaded.turn + 1);
});

test('A4 save/load: the same save loaded twice produces the same hash, and a fresh game is not what is restored', async ({
  page,
}) => {
  await openApp(page);
  const fresh = await seedApp(page, SEED);
  const freshHash = await stateHash(page);

  await foundCity(page);
  const playedHash = await stateHash(page);
  await saveButton(page).click();

  // Reseed to a pristine game (no city), then load: what comes back must be the PLAYED game.
  await seedApp(page, SEED);
  expect(await stateHash(page)).toBe(freshHash);
  await loadButton(page).click();
  await expect.poll(async () => stateHash(page)).toBe(playedHash);
  expect((await readState(page)).cities.length).toBe(1);

  // And loading again is idempotent: the save is a value, not a cursor into the past.
  await loadButton(page).click();
  await expect.poll(async () => stateHash(page)).toBe(playedHash);
  expect(fresh.turn).toBe(1);
});

test('A4 save/load: the save payload is the engine’s own state and hash, with no clock in it', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  const hash = await stateHash(page);
  await saveButton(page).click();

  const payload = await page.evaluate(() => {
    const raw = window.localStorage.getItem('civts.save.v1');
    return raw;
  });
  expect(payload, 'the save is not under the documented key `civts.save.v1`').not.toBeNull();
  if (payload === null) return;

  // The engine's hash is carried beside its state, so a load can be checked against the same
  // value the goldens use. The payload carries no timestamp: a save's identity is its hash.
  expect(payload).toContain(hash);
  expect(payload).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  expect(await stateHash(page)).toBe(hash);
});
