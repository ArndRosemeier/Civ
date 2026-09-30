import { expect, test } from '@playwright/test';
import { asTileIndex, planRoute, unitMoveOptions } from '@civts/core';
import {
  authoritativeState,
  bringTileToCentre,
  cameraOf,
  clickTile,
  dispatch,
  endTurns,
  foundCity,
  humanPlayerId,
  openApp,
  OPPONENT_OFF,
  readState,
  RULESET,
  seedApp,
  stateHash,
  tileX,
  tileY,
} from './helpers.js';

test('city garrison is directly selectable and only the selected subset moves', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, 7, OPPONENT_OFF);
  const city = await foundCity(page);
  expect(
    await dispatch(page, {
      type: 'SetProduction',
      cityId: city.id,
      item: { kind: 'unit', id: 'warrior' },
    }),
  ).toBe('ok');
  for (let i = 0; i < 60; i++) {
    const state = await readState(page);
    if (
      state.units.filter((unit) => unit.type === 'warrior' && unit.tile === city.tile).length >= 3
    )
      break;
    expect(
      await dispatch(page, {
        type: 'SetProduction',
        cityId: city.id,
        item: { kind: 'unit', id: 'warrior' },
      }),
    ).toBe('ok');
    await endTurns(page, 1);
  }
  await endTurns(page, 1);
  const before = await authoritativeState(page);
  const seat = humanPlayerId(await readState(page));
  const warriors = before.units.filter(
    (unit) => unit.owner === seat && unit.tile === city.tile && unit.type === 'warrior',
  );
  expect(warriors.length).toBeGreaterThanOrEqual(3);
  const first = warriors[0];
  const remaining = warriors[2];
  if (first === undefined || remaining === undefined) throw new Error('Missing garrison');
  await bringTileToCentre(page, await readState(page), city.tile);
  const state = await readState(page);
  const hash = await stateHash(page);
  await clickTile(page, await cameraOf(page), tileX(state, city.tile), tileY(state, city.tile));
  const menu = page.getByRole('region', { name: 'Tile options' });
  await expect(
    menu.getByRole('button', { name: `Open city ${city.name}`, exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole('checkbox', { name: `Select Warrior ${String(first.id)}`, exact: true }),
  ).toBeVisible();
  expect(await stateHash(page)).toBe(hash);
  await menu.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(menu.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(
    menu.getByText('Select a unit on the map to give orders.', { exact: true }),
  ).toBeVisible();
  for (const unit of warriors.slice(0, 2))
    await menu
      .getByRole('checkbox', { name: `Select Warrior ${String(unit.id)}`, exact: true })
      .check();
  await expect(menu.getByText(/^2 selected/)).toBeVisible();
  await page.screenshot({ path: '../../.cache/map-context.png' });
  const destination = unitMoveOptions(before, RULESET, first.id).find(
    (to) => !before.map.huts.includes(to),
  );
  if (destination === undefined) throw new Error('No destination');
  await clickTile(
    page,
    await cameraOf(page),
    tileX(state, Number(destination)),
    tileY(state, Number(destination)),
  );
  await expect(menu.getByRole('button', { name: 'Move 2 units here', exact: true })).toBeVisible();
  expect(await stateHash(page)).toBe(hash);
  await menu.getByRole('button', { name: 'Move 2 units here', exact: true }).click();
  const after = await authoritativeState(page);
  for (const unit of warriors.slice(0, 2))
    expect(after.units.find((each) => each.id === unit.id)?.tile).toBe(
      asTileIndex(Number(destination)),
    );
  expect(after.units.find((each) => each.id === remaining.id)?.tile).toBe(city.tile);
  const members = warriors.slice(0, 2).map((unit) => unit.id);
  const far = Array.from(after.map.terrain, (_, i) => asTileIndex(i)).find((to) => {
    const route = planRoute(after, RULESET, first.id, to, members.slice(1));
    return (
      route.ok &&
      route.value.steps.length >= 2 &&
      route.value.steps.length <= 4 &&
      route.value.steps.every((step) => !after.map.huts.includes(step))
    );
  });
  if (far === undefined) throw new Error('No shared multi-turn route');
  await page.getByRole('button', { name: 'Save game', exact: true }).click();
  await bringTileToCentre(page, await readState(page), Number(far));
  await clickTile(page, await cameraOf(page), tileX(state, Number(far)), tileY(state, Number(far)));
  await menu.getByRole('button', { name: 'Move 2 units here', exact: true }).click();
  await endTurns(page, 1);
  // Reading via Save would overwrite the snapshot this test needs to load.
  const advanced = await readState(page);
  const advancedTiles = advanced.units
    .filter((unit) => members.some((id) => Number(id) === unit.id))
    .map((unit) => unit.tile);
  expect(new Set(advancedTiles).size).toBe(1);
  expect(advancedTiles[0]).not.toBe(destination);
  await page.getByRole('button', { name: 'Load game', exact: true }).click();
  await endTurns(page, 1);
  const loaded = await authoritativeState(page);
  expect(
    loaded.units
      .filter((unit) => members.includes(unit.id))
      .every((unit) => unit.tile === destination),
  ).toBe(true);
  expect(loaded.units.find((unit) => unit.id === remaining.id)?.tile).toBe(city.tile);
});

test('a tile click opens actions without moving and Escape dismisses the menu', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, 7, OPPONENT_OFF);
  const unit = state.units.find((each) => each.owner === humanPlayerId(state));
  if (unit === undefined) throw new Error('No unit');
  const hash = await stateHash(page);
  await clickTile(page, await cameraOf(page), tileX(state, unit.tile), tileY(state, unit.tile));
  await expect(page.getByRole('region', { name: 'Tile options' })).toBeVisible();
  expect(await stateHash(page)).toBe(hash);
  const checkbox = page.getByRole('region', { name: 'Tile options' }).getByRole('checkbox').first();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Tile options' })).toBeHidden();
});
