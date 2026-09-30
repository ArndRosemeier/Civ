import { expect, test } from '@playwright/test';
import { openApp, readState, authoritativeState, endTurnButton } from './helpers.js';

test('diplomacy controls declare war and negotiate peace through the engine', async ({ page }) => {
  await openApp(page);
  const rival = (await readState(page)).players.find(
    (player) => player.kind === 'civ' && player.id !== 0,
  );
  if (rival === undefined) throw new Error('missing rival');
  await expect(
    page.getByRole('button', { name: `Declare war with ${rival.name}`, exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: `Declare war with ${rival.name}`, exact: true }).click();
  expect((await authoritativeState(page)).diplomacy?.[0]?.status).toBe('war');
  await page.getByRole('button', { name: `Offer peace with ${rival.name}`, exact: true }).click();
  expect((await authoritativeState(page)).diplomacy?.[0]?.offer).toBe(0);
  await endTurnButton(page).click();
  expect((await authoritativeState(page)).diplomacy?.[0]?.status).toBe('peace');
  await page.getByRole('button', { name: `Declare war with ${rival.name}`, exact: true }).click();
  await page.evaluate((target) => {
    window.__CIVTS__?.dispatch({ type: 'OfferPeace', targetPlayer: 0, seat: target });
  }, rival.id);
  await page.getByRole('button', { name: `Accept peace with ${rival.name}`, exact: true }).click();
  expect((await authoritativeState(page)).diplomacy?.[0]?.status).toBe('peace');
  await page.screenshot({ path: '.cache/diplomacy-review.png', fullPage: true });
});
