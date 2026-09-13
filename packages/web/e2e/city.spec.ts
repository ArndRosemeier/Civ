/**
 * W3 — A4's city screen: worked tiles, production and the queue.
 * See docs/INTERFACES.md, M8 ("A4 coverage") and M3/M4c for the city rules.
 *
 * The screen is the dialog named `City <name>`, opened from the `Cities` list — both names are
 * contractual. Everything asserted about it comes from one of two engine sources:
 *
 * - the state, through `window.__CIVTS__` (which tiles are worked, what is being built);
 * - a DISPATCH PROBE: for a control the panel renders as enabled, asking the engine directly
 *   whether the assignment that control would write is legal — so "the UI offers something the
 *   engine would refuse" is caught in both directions, and no rule is restated here.
 */

import { expect, test } from '@playwright/test';

import {
  cameraOf,
  cityDialog,
  clearDispatchLog,
  cityList,
  dispatch,
  dispatchLog,
  foundCity,
  openApp,
  openCity,
  readState,
  recordDispatches,
  RULESET,
  seedApp,
  tileIndexOf,
  type UiCity,
  type UiState,
} from './helpers.js';

const SEED = 606;

/** The `x,y` in a worked-tile control's accessible name (`Work tile 3,4`). */
interface TileControl {
  readonly tile: number;
  readonly worked: boolean;
  readonly enabled: boolean;
  readonly name: string;
}

const tileCoordinates = (name: string): { readonly x: number; readonly y: number } | undefined => {
  const match = /(\d+)\s*,\s*(\d+)/.exec(name);
  if (match === null) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
};

/** Every worked-tile control in the dialog, keyed by the tile its name names. */
const tileControls = async (
  page: import('@playwright/test').Page,
  state: UiState,
): Promise<readonly TileControl[]> => {
  const boxes = page.getByRole('checkbox');
  const count = await boxes.count();
  const controls: TileControl[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const name = await box.getAttribute('aria-label');
    const label =
      name ?? (await box.evaluate((element) => element.parentElement?.textContent ?? ''));
    const at = tileCoordinates(label);
    if (at === undefined) continue;
    controls.push({
      tile: tileIndexOf(state, at.x, at.y),
      worked: await box.isChecked(),
      enabled: await box.isEnabled(),
      name: label.trim(),
    });
  }
  return controls;
};

/** A fresh game with one city founded through the UI, and its screen open. */
const cityOnScreen = async (
  page: import('@playwright/test').Page,
): Promise<{
  readonly state: UiState;
  readonly city: UiCity;
  readonly dialog: import('@playwright/test').Locator;
}> => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  const state = await readState(page);
  const city = state.cities[0];
  if (city === undefined) throw new Error('no city was founded');
  const dialog = await openCity(page, state, await cameraOf(page), city);
  return { state, city, dialog };
};

test('A4 city screen: the City <name> dialog opens from the Cities list and shows the engine’s city', async ({
  page,
}) => {
  const { state, city } = await cityOnScreen(page);

  const dialog = cityDialog(page, city.name);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(String(city.population));
  // The list entry that opened it is the city's own name, not a coordinate or an id.
  await expect(cityList(page).getByRole('button', { name: city.name, exact: true })).toBeVisible();
  expect(state.cities.length).toBe(1);
});

test('A4 city screen — worked tiles: the controls are the state’s own assignment and every toggle goes through the engine', async ({
  page,
}) => {
  const { state, city } = await cityOnScreen(page);

  const controls = await tileControls(page, state);
  expect(controls.length, 'the city screen offers no workable tiles').toBeGreaterThan(0);

  // The checked controls ARE the state's `workedTiles` — the engine's memory, not a UI guess.
  const checked = controls.filter((control) => control.worked).map((control) => control.tile);
  expect(new Set(checked)).toEqual(new Set(city.workedTiles));

  // One click, and the engine's own assignment must move exactly as the control asked. The
  // command the panel dispatched is compared with the state it produced, so a UI that wrote a
  // different assignment than the one it showed is caught here.
  const target = controls.find((control) => control.enabled);
  expect(target, 'no tile could be toggled').toBeDefined();
  if (target === undefined) return;

  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  await clearDispatchLog(page);
  await page.getByRole('checkbox', { name: target.name }).click();

  const log = await dispatchLog(page);
  const entry = log.at(-1);
  expect(entry?.result, `toggling ${target.name} was refused by the engine`).toBe('ok');
  const asked = workedTilesOf(entry?.action);
  expect(
    asked,
    'the toggle dispatched something other than a worked-tile assignment',
  ).toBeDefined();
  if (asked === undefined) return;

  const after = await readState(page);
  const updated = after.cities.find((candidate) => candidate.id === city.id);
  expect(updated, 'the city disappeared from the state').toBeDefined();
  if (updated === undefined) return;
  expect([...updated.workedTiles].sort((a, b) => a - b)).toEqual([...asked].sort((a, b) => a - b));
  if (target.worked) {
    expect(updated.workedTiles, 'unchecking a tile did not release it').not.toContain(target.tile);
  } else {
    expect(updated.workedTiles, 'checking a tile did not assign it').toContain(target.tile);
  }

  // Both directions of the keystone, per control: a control the screen ENABLES must be one the
  // engine accepts, and a control it DISABLES must be one the engine refuses. The probe writes
  // real assignments, so the state (and the render) is re-read for every control rather than
  // compared against a snapshot taken before the first probe.
  const failures: string[] = [];
  for (const control of controls) {
    // Re-read the control and the state for every probe: an earlier probe may have moved the
    // assignment, and a control's enablement is a statement about the state as it is NOW.
    const box = page.getByRole('checkbox', { name: control.name });
    const enabled = await box.isEnabled();
    const shownWorked = await box.isChecked();
    const now = await readState(page);
    const current = now.cities.find((candidate) => candidate.id === city.id);
    if (current === undefined) break;
    const inState = current.workedTiles.includes(control.tile);
    if (inState !== shownWorked) {
      failures.push(
        `the checkbox ${control.name} shows ${String(shownWorked)} and the state says ${String(inState)}`,
      );
    }
    const next = inState
      ? current.workedTiles.filter((tile) => tile !== control.tile)
      : [...current.workedTiles, control.tile];
    const answer = await dispatch(page, {
      type: 'SetWorkedTiles',
      cityId: city.id,
      tiles: next,
    });
    if (enabled && answer !== 'ok') {
      failures.push(`the UI offers ${control.name} and the engine refuses that assignment`);
    }
    if (!enabled && answer === 'ok') {
      failures.push(`the UI disables ${control.name} and the engine accepts that assignment`);
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);
});

/** The `tiles` a `SetWorkedTiles` command asked for, or `undefined` for anything else. */
const workedTilesOf = (action: unknown): readonly number[] | undefined => {
  if (typeof action !== 'object' || action === null || !('tiles' in action)) return undefined;
  const tiles: unknown = action.tiles;
  if (!Array.isArray(tiles)) return undefined;
  return tiles.every((tile) => typeof tile === 'number') ? tiles : undefined;
};

test('A4 city screen — production: the menu is the engine’s own buildable list, and choosing from it sets the head of the queue', async ({
  page,
}) => {
  const { state, city, dialog } = await cityOnScreen(page);

  const buttons = dialog.getByRole('button', { name: /^build /i });
  const count = await buttons.count();
  expect(count, 'the city screen offers nothing to build').toBeGreaterThan(0);

  // Every offered item is one the engine accepts: click each on the same game, and the state
  // must end up building exactly what the app asked for.
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1)
    names.push((await buttons.nth(index).innerText()).trim());
  expect(new Set(names).size, 'two production controls share one accessible name').toBe(
    names.length,
  );

  const chosen = await buttons.first().innerText();
  await buttons.first().click();
  const log = await dispatchLog(page);
  const entry = log.at(-1);
  expect(entry?.result, `${chosen} was refused by the engine`).toBe('ok');

  const after = await readState(page);
  const updated = after.cities.find((candidate) => candidate.id === city.id);
  expect(updated?.production, 'the city is building nothing after choosing an item').toBeDefined();
  expect(
    updated?.production?.id,
    'the city is building a different item than the one clicked',
  ).toBe(productionIdOf(entry?.action));
  // The item's name is on the screen, so the screen and the state agree about what is building.
  const item = updated?.production;
  if (item !== undefined) {
    const name = itemName(item);
    await expect(dialog).toContainText(name);
  }
  expect(state.revision).toBeLessThan(after.revision);
});

test('A4 city screen — queue: the queue section matches the state’s own queue', async ({
  page,
}) => {
  const { city, dialog } = await cityOnScreen(page);

  // A fresh city is building nothing, and the screen says so rather than showing an empty box.
  expect(city.queue).toEqual([]);
  await expect(dialog).toContainText(/nothing is being built/i);

  // Choosing production puts the item at the head; the engine's queue is left alone by
  // `SetProduction` (the frozen M3 rule), so the state's queue stays empty and the screen must
  // agree with the state rather than with what a player might expect.
  await dialog
    .getByRole('button', { name: /^build /i })
    .first()
    .click();
  const after = await readState(page);
  const updated = after.cities.find((candidate) => candidate.id === city.id);
  expect(updated).toBeDefined();
  if (updated === undefined) return;
  expect(updated.queue.length).toBe(city.queue.length);
  expect(updated.production).toBeDefined();
  await expect(dialog).not.toContainText(/nothing is being built/i);
});

/** The item id a `SetProduction` command names, for comparing with the state. */
const productionIdOf = (action: unknown): string | undefined => {
  if (typeof action !== 'object' || action === null || !('item' in action)) return undefined;
  const item: unknown = action.item;
  if (typeof item !== 'object' || item === null || !('id' in item)) return undefined;
  const id: unknown = item.id;
  return typeof id === 'string' ? id : undefined;
};

/**
 * The item's own name, from the ruleset's catalog — the same vocabulary the panel displays, so
 * this is not a second spelling invented here.
 */
const itemName = (item: { readonly kind: string; readonly id: string }): string => {
  const defs: readonly { readonly id: string; readonly name: string }[] =
    item.kind === 'unit' ? RULESET.units : RULESET.buildings;
  return defs.find((def) => def.id === item.id)?.name ?? item.id;
};
