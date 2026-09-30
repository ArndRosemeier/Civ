import { expect, test, type Page } from '@playwright/test';
import {
  actionsFor,
  dispatch,
  humanPlayerId,
  mapCanvas,
  openApp,
  OPPONENT_OFF,
  readState,
  seedApp,
} from './helpers.js';

const startWork = async (page: Page): Promise<number> => {
  await openApp(page);
  const state = await seedApp(page, 21, OPPONENT_OFF);
  const worker = state.units.find(
    (unit) => unit.owner === humanPlayerId(state) && unit.type === 'worker',
  );
  if (worker === undefined) throw new Error('No human worker');
  const actions = await actionsFor(page, { unitId: worker.id });
  const work = actions.find(
    (action) =>
      typeof action === 'object' &&
      action !== null &&
      'type' in action &&
      action.type === 'StartWork',
  );
  expect(work).toBeDefined();
  expect(await dispatch(page, work)).toBe('ok');
  return worker.id;
};

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('No map canvas');
    return {
      pixels: canvas.toDataURL(),
      hash: window.__CIVTS__?.stateHash(),
      draws: window.__CIVTS__?.draws() ?? 0,
    };
  });

const drawingAfterPause = (page: Page) =>
  page.evaluate(async () => {
    const before = window.__CIVTS__?.draws();
    await new Promise((resolve) => setTimeout(resolve, 350));
    return before === window.__CIVTS__?.draws();
  });

test('busy workers animate without game input or state changes, then stop on cancel', async ({
  page,
}) => {
  const worker = await startWork(page);
  const before = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).draws).toBeGreaterThan(before.draws + 1);
  await expect.poll(async () => (await snapshot(page)).pixels !== before.pixels).toBe(true);
  expect((await snapshot(page)).hash).toBe(before.hash);
  await (await mapCanvas(page)).screenshot({ path: '../../.cache/worker-animation-review.png' });
  expect(await dispatch(page, { type: 'CancelWork', unitId: worker })).toBe('ok');
  expect(await drawingAfterPause(page)).toBe(true);
});

test('work completion removes the activity and stops the animation', async ({ page }) => {
  const worker = await startWork(page);
  for (let turns = 0; turns < 10; turns += 1) {
    const state = await readState(page);
    if (state.units.find((unit) => unit.id === worker)?.working !== true) break;
    expect(await dispatch(page, { type: 'EndTurn' })).toBe('ok');
  }
  expect((await readState(page)).units.find((unit) => unit.id === worker)?.working).toBe(false);
  expect(await drawingAfterPause(page)).toBe(true);
});

test('panning the worker offscreen suspends drawing without changing its job', async ({ page }) => {
  const worker = await startWork(page);
  const before = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).draws).toBeGreaterThan(before.draws + 1);
  await page.getByRole('application', { name: 'Map', exact: true }).focus();
  const state = await readState(page);
  const unit = state.units.find((candidate) => candidate.id === worker);
  if (unit === undefined) throw new Error('Worker vanished');
  const direction = unit.tile % state.map.width >= state.map.width / 2 ? 'ArrowLeft' : 'ArrowRight';
  for (let i = 0; i < state.map.width; i += 1) await page.keyboard.press(direction);
  expect(await drawingAfterPause(page)).toBe(true);
  expect((await readState(page)).units.find((unit) => unit.id === worker)?.working).toBe(true);
  expect((await snapshot(page)).hash).toBe(before.hash);
});

test('reduced motion keeps a static work symbol and resumes when the preference changes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await startWork(page);
  const still = await snapshot(page);
  expect(await drawingAfterPause(page)).toBe(true);
  expect((await snapshot(page)).pixels).toBe(still.pixels);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(async () => (await snapshot(page)).draws).toBeGreaterThan(still.draws + 1);
  expect((await snapshot(page)).hash).toBe(still.hash);
});
