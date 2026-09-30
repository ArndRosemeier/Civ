import { expect, test } from '@playwright/test';
import { openApp, seedApp, foundCity, readState, OPPONENT_OFF } from './helpers.js';

test('workspace navigation and dialogs preserve map geometry and essential actions', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, 8123, OPPONENT_OFF);
  const map = page.getByRole('application', { name: 'Map' });
  const before = await map.boundingBox();
  for (const name of ['Empire', 'Diplomacy', 'History', 'Game', 'Overview']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Save game', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'End turn', exact: true })).toBeVisible();
    expect(await map.boundingBox()).toEqual(before);
    const pageBox = page.getByRole('tabpanel');
    expect(
      await pageBox.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: `../../.cache/ui-${name.toLowerCase()}.png` });
  }
  await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Empire', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  const stateBefore = await readState(page);
  const unitBefore = await page
    .locator('[data-floating="unit-actions"]')
    .getAttribute('aria-label');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect((await readState(page)).turn).toBe(stateBefore.turn);
  await expect(page.locator('[data-floating="unit-actions"]')).toHaveAttribute(
    'aria-label',
    unitBefore ?? '',
  );
  await page.screenshot({ path: '../../.cache/ui-overview.png' });
  const city = await foundCity(page);
  await page
    .getByRole('list', { name: 'Cities', exact: true })
    .getByRole('button', { name: city.name, exact: true })
    .click();
  const box = await page.getByRole('dialog').boundingBox();
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  expect(box?.height).toBeGreaterThan(400);
  expect(await map.boundingBox()).toEqual(before);
  await page.screenshot({ path: '../../.cache/ui-city.png' });
  await page.getByRole('button', { name: 'Technology', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Technology', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../.cache/ui-technology.png' });
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.screenshot({ path: '../../.cache/ui-new-game.png' });
  await page.getByRole('button', { name: 'Close new game', exact: true }).click();
});

test('workspace fits narrow desktops and phones without document overflow', async ({ page }) => {
  await openApp(page);
  for (const viewport of [
    { width: 900, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('button', { name: 'End turn', exact: true })).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
    ).toBe(false);
    await page.screenshot({ path: `../../.cache/ui-${String(viewport.width)}.png` });
  }
});
