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

import { SAVE_VERSION, SCHEMA_VERSION } from '@civts/core';

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

test('A4 save/load: the payload is the engine’s own format — its keys, its version, its hash, no clock', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  const hash = await stateHash(page);
  await saveButton(page).click();

  const payload = await page.evaluate(() => window.localStorage.getItem('civts.save.v1'));
  expect(payload, 'the save is not under the documented key `civts.save.v1`').not.toBeNull();
  if (payload === null) return;

  // The engine's hash is carried beside its state, so a load can be checked against the same
  // value the goldens use. The payload carries no timestamp: a save's identity is its hash.
  expect(payload).toContain(hash);
  expect(payload).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

  // M11: this is `@civts/core`'s payload — `{ version, engine, hash, state }` — not a format the
  // panel invented. Four keys, the engine's version, and the state's own schema in `engine`, so
  // `civts load` (and the REPL's `load`) read exactly this file.
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the save is not an object');
  expect(Object.keys(parsed).sort()).toEqual(['engine', 'hash', 'state', 'version']);
  // The engine's own constants, not a number written here: `version` is the format's version and
  // `engine.schemaVersion` is the state's, and both come from `@civts/core`.
  expect(parsed).toMatchObject({
    version: SAVE_VERSION,
    hash,
    engine: { schemaVersion: SCHEMA_VERSION },
  });
  // Absent, never `undefined` — on the wire, where the rule actually has to hold.
  expect(payload).not.toContain('undefined');
  expect(await stateHash(page)).toBe(hash);
});

test('A4 save/load: a corrupt, foreign or absent save is refused, and the game is left alone', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  await saveButton(page).click();

  const good = await page.evaluate(() => window.localStorage.getItem('civts.save.v1'));
  if (good === null) throw new Error('Save game wrote nothing to localStorage');
  const hash = await stateHash(page);
  const status = page.getByLabel('Save status');

  // The app's own former envelope, rebuilt from the payload it now writes — with a self-check,
  // because a rewrite that silently matched nothing would turn this case into a second copy of
  // "the payload is truncated".
  const legacy = good.replace(
    /^\{"version":\d+,"engine":\{[^}]*\},"hash":"([0-9a-f]+)","state":/,
    '{"schema":1,"hash":"$1","state":',
  );
  if (legacy === good) throw new Error('the legacy-envelope rewrite did not apply');

  /** Everything that is not this build's save — including the format the panel used to write. */
  const BAD: readonly { readonly why: string; readonly text: string | null }[] = [
    { why: 'there is no save at all', text: null },
    { why: 'the payload is truncated', text: good.slice(0, Math.floor(good.length / 2)) },
    { why: 'the payload is not JSON', text: '{"version":' },
    { why: 'the payload is the app’s old `{schema, hash, state}` envelope', text: legacy },
    {
      why: 'the recorded hash is not the state’s',
      text: good.replace(hash, 'ffffffffffffffff'),
    },
  ];
  // …and the last rewrite is checked the same way: a no-op there would make the case vacuous.
  if (BAD[4]?.text === good) throw new Error('the hash rewrite did not apply');

  for (const { why, text } of BAD) {
    await page.evaluate((value) => {
      if (value === null) window.localStorage.removeItem('civts.save.v1');
      else window.localStorage.setItem('civts.save.v1', value);
    }, text);

    await loadButton(page).click();
    // The refusal is *reported* (a silent button is indistinguishable from a broken one)…
    await expect(status, why).toContainText('Load failed');
    // …and the game is exactly where it was: no half-installed state, no rollback to nothing.
    expect(await stateHash(page), why).toBe(hash);
    await expect(page.getByRole('button', { name: 'End turn', exact: true })).toBeEnabled();
  }

  // The good save still loads, so the loop refused the *files* and not the verb.
  await page.evaluate((value) => {
    window.localStorage.setItem('civts.save.v1', value);
  }, good);
  // …and move the game first, so "it loaded" is distinguishable from "it did nothing".
  await page.getByRole('button', { name: 'End turn', exact: true }).click();
  expect(await stateHash(page)).not.toBe(hash);
  await loadButton(page).click();
  await expect.poll(async () => stateHash(page)).toBe(hash);
  await expect(status).toContainText('Loaded');
});
