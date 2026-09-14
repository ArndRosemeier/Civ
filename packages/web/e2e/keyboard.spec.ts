/**
 * Phase 5 — the keyboard contract and the next-unit flow.
 * See `docs/UI-OVERHAUL.md` §7.6 phase 5, rules §2.A ("selection is navigation, never a command")
 * and §2.E (chrome exists only when it is needed).
 *
 * ## What this file is for, and what it cannot be for
 *
 * Before this phase there was **no `keydown` anywhere in `packages/web/src`** (the inventory in §4.6e
 * called the pointer-only map "the sharpest gap"), so every assertion here is about a contract that
 * this phase wrote rather than one it changed. Three kinds of claim need a browser and cannot be
 * made anywhere else:
 *
 * 1. **The keys reach the app at all**, through a real focus, in a real page — the binding table is
 *    tested in `packages/web/test/ui/keys.test.ts` without a browser, and that test cannot show that
 *    a `keydown` listener is wired to the table.
 * 2. **The deferral rule holds in the situations it exists for**: Space in a number field, Space and
 *    Enter with a panel open, and a modified press. Each of those is a way this phase could have
 *    made the app worse by taking a key the browser was using, and each is measured here rather than
 *    argued in a comment.
 * 3. **The next-unit flow visits exactly the units the engine offers**, which is a claim about the
 *    engine's own lists at the board the browser is playing — asked of the app's seam
 *    (`actionsFor`), not of a second opinion in this file.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  actionsFor,
  cameraOf,
  clearDispatchLog,
  clickUnitAction,
  closeDialogs,
  dispatchLog,
  foundCity,
  endTurnButton,
  humanPlayerId,
  mapViewport,
  OPPONENT_OFF,
  openApp,
  openPanel,
  readState,
  recordDispatches,
  seedApp,
  turnIndicator,
  unitActionsGroup,
  unitsOf,
} from './helpers.js';

const SEED = 8123;

/**
 * The unit the app is showing orders for — read from the **contractual** group name
 * (`Actions for unit <id>`), which is the same name every other spec targets.
 */
const selectedUnit = async (page: Page): Promise<number> => {
  const label = await page.locator("[data-floating='unit-actions']").getAttribute('aria-label');
  const found = /^Actions for unit (\d+)$/.exec(label ?? '');
  if (found === null) {
    throw new Error(`the orders popup does not name a unit: ${String(label)}`);
  }
  return Number(found[1]);
};

/** The session keys' own readout: the header's `Order` channel, which says what just happened. */
const orderChannel = (page: Page): Promise<string> =>
  page.locator("[data-role='order']").innerText();

/**
 * The units of the acting seat the **engine** still offers an order, in id order.
 *
 * Asked of the app's own seam (`actionsFor`), one call per unit, so this expectation is the engine's
 * answer for the board the browser is playing rather than a rule restated in this file.
 */
const unitsNeedingOrders = async (page: Page): Promise<readonly number[]> => {
  const state = await readState(page);
  const owner = humanPlayerId(state);
  const needy: number[] = [];
  for (const unit of unitsOf(state, owner)) {
    const offered = await actionsFor(page, { unitId: unit.id });
    if (offered.length > 0) needy.push(unit.id);
  }
  return needy;
};

test('phase 5 next-unit: Space visits every unit the engine still offers an order, and never the current one', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);

  const needy = await unitsNeedingOrders(page);
  expect(
    needy.length,
    'the acting seat has fewer than two units with orders, so "the next unit" is not a question ' +
      'this board can ask — re-measure the seed',
  ).toBeGreaterThan(1);

  const first = await selectedUnit(page);
  expect(
    needy,
    `the app is showing orders for unit ${String(first)}, which the engine offers nothing`,
  ).toContain(first);

  // One press moves to the next unit that needs orders, in id order, wrapping round — and the
  // expectation is computed from the engine's lists, not from a count taken here.
  const start = needy.indexOf(first);
  const visited: number[] = [first];
  for (let step = 1; step < needy.length; step += 1) {
    await page.keyboard.press('Space');
    const expected = needy[(start + step) % needy.length];
    const now = await selectedUnit(page);
    expect(
      now,
      `press ${String(step)} of Space selected unit ${String(now)}; the engine's own lists say ` +
        `unit ${String(expected)} is the next one with orders`,
    ).toBe(expected);
    expect(now, 'the next-unit key answered with the unit it started from').not.toBe(
      visited.at(-1),
    );
    // The popup follows the selection, so the group the contract names is the selected unit's.
    await expect(unitActionsGroup(page, now)).toBeVisible();
    visited.push(now);
  }

  // Every unit that needs orders has been visited exactly once, and the wrap returns to the start.
  expect(visited.slice().sort((a, b) => a - b)).toEqual(needy.slice().sort((a, b) => a - b));
  await page.keyboard.press('Space');
  expect(
    await selectedUnit(page),
    'a full cycle of the next-unit key did not wrap round to the unit it started from',
  ).toBe(first);

  // The flow is navigation: it issues no command at all, on any press — and it says nothing in the
  // order channel, because the channel is about orders and a unit was not given one.
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  await page.keyboard.press('Space');
  expect(
    (await dispatchLog(page)).map((entry) => entry.action),
    'the next-unit key dispatched something: selecting a unit is navigation, not an order',
  ).toEqual([]);
  expect(
    await orderChannel(page),
    'moving to the next unit wrote into the channel that reports what the engine said about an order',
  ).toBe('');
});

test('phase 5 next-unit: when there is nothing to move to, the flow says so instead of going quiet', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);
  const needy = await unitsNeedingOrders(page);
  expect(needy.length, 'the fixture board has nothing to cycle').toBeGreaterThan(1);

  // Founding the city consumes the settler, so the seat is left with exactly one unit — and that
  // unit is the one already selected. "The next unit is the unit you are on" is not a move, so the
  // flow has nothing to offer, and a key that did nothing at all would be indistinguishable from a
  // broken one. It says which of the two situations this is, from the engine's own count.
  await foundCity(page);
  const after = await unitsNeedingOrders(page);
  expect(
    after.length,
    'the seat has more than one unit with orders, so this case cannot arise',
  ).toBe(1);
  expect(await selectedUnit(page), 'the remaining unit is not the selected one').toBe(after[0]);
  await page.keyboard.press('Space');
  expect(
    await orderChannel(page),
    'the next-unit key answered with the unit already selected instead of saying there was nothing ' +
      'to move to',
  ).toContain('no other unit needs orders');

  // And once nothing at all needs orders, the sentence changes to say that instead: the two
  // situations are different answers and the engine is what tells them apart.
  await clickUnitAction(page, after[0] as number, /^Fortify$/);
  await expect
    .poll(async () => unitsNeedingOrders(page), {
      message: 'fortifying the last unit did not leave the engine offering it nothing',
    })
    .toEqual([]);
  await page.keyboard.press('Space');
  expect(await orderChannel(page)).toContain('no unit needs orders');
});

test('phase 5 keyboard: a field, a panel and a modifier keep the keys the browser gave them', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  const turnBefore = (await readState(page)).turn;
  const selectedBefore = await selectedUnit(page);

  /* --------------------------- (1) a text field --------------------------- */

  // The rates row is three number fields a player types into, and it is on the page for real. Enter
  // in a field is the field's; Space in a field is a space. A session key that ran anyway would make
  // the rate controls unusable — and Enter would end the turn while the player was typing a rate.
  const taxRate = page.getByRole('spinbutton', { name: 'Tax rate' });
  await taxRate.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(
    (await dispatchLog(page)).map((entry) => entry.action),
    'a key pressed inside a text field was handled by the app: Enter or Space escaped the field',
  ).toEqual([]);
  expect((await readState(page)).turn, 'Enter in a text field ended the turn').toBe(turnBefore);
  expect(await selectedUnit(page), 'a key in a text field moved the selection').toBe(
    selectedBefore,
  );

  /* ------------------------- (2) a modifier held -------------------------- */

  // Ctrl/Space is not the app's: a web app that took the browser's modified keys is a web app that
  // breaks Ctrl+R, Cmd+← and every keyboard shortcut its user already knows.
  // `blur` rather than a click: a click could land on a control and give the next key to *it*,
  // which would test something else. The point is that the key goes to the document with a modifier
  // held and is refused there.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.keyboard.press('Control+Space');
  expect(
    await selectedUnit(page),
    'Control+Space moved the selection: the app took a key the browser owns',
  ).toBe(selectedBefore);
  expect((await dispatchLog(page)).map((entry) => entry.action)).toEqual([]);

  /* --------------------------- (3) a panel open --------------------------- */

  // The panels are non-modal side screens, and a control inside one is activated by Enter and Space.
  // A session handler that ran as well would act twice on one press: end the turn *and* press the
  // button. So while a panel is up the keyboard belongs to the panel.
  await openPanel(page, /^Debug$/);
  await clearDispatchLog(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(
    (await dispatchLog(page)).map((entry) => entry.action),
    'an open panel did not keep Enter and Space: the app acted on a press the panel was using',
  ).toEqual([]);
  expect((await readState(page)).turn, 'Enter with a panel open ended the turn behind it').toBe(
    turnBefore,
  );
  await closeDialogs(page);
});

test('phase 5 keyboard: the map is in the tab order, the arrows pan it, and a key outside it leaves the map alone', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);

  /* --------------------------- (1) Tab reaches it ------------------------- */

  // The gap this phase closes: the map was a `role=application` region with no focusable child, so
  // a keyboard user could not touch it at all (`docs/UI-OVERHAUL.md` §4.6e). It is in the tab order
  // now, and the assertion is that Tab actually lands on it — a `tabindex` nobody reaches is a
  // `tabindex` that does nothing.
  const map = mapViewport(page);
  let reached = false;
  const seen: string[] = [];
  for (let press = 0; press < 25 && !reached; press += 1) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return 'nothing';
      const label = active.getAttribute('aria-label');
      return `${active.tagName}${label === null ? '' : `[${label}]`}`;
    });
    seen.push(where);
    reached = where === 'DIV[Map]';
  }
  expect(
    reached,
    `Tab never reached the map region from the top of the page; the focus walked: ${seen.join(' → ')}`,
  ).toBe(true);

  /* ------------------------- (2) the map keys work ------------------------ */

  const before = await cameraOf(page);
  await page.keyboard.press('ArrowRight');
  const right = await cameraOf(page);
  expect(
    right.x - before.x,
    'ArrowRight did not pan the map exactly one tile to the right',
  ).toBeCloseTo(1, 5);
  expect(right.y, 'ArrowRight moved the map vertically').toBeCloseTo(before.y, 5);
  await page.keyboard.press('ArrowLeft');
  expect((await cameraOf(page)).x, 'ArrowLeft did not undo ArrowRight').toBeCloseTo(before.x, 5);

  await page.keyboard.press('ArrowDown');
  expect((await cameraOf(page)).y, 'ArrowDown did not pan the map one tile down').toBeCloseTo(
    before.y + 1,
    5,
  );
  await page.keyboard.press('ArrowUp');
  expect((await cameraOf(page)).y, 'ArrowUp did not undo ArrowDown').toBeCloseTo(before.y, 5);

  // Zoom has two spellings because `+` is `Shift+=` on most layouts and `=` is not: both are in the
  // binding table, and both must work (`ui/keys.ts` states why shift is not treated as a modifier).
  const zoomBefore = await cameraOf(page);
  await page.keyboard.press('=');
  const zoomedIn = await cameraOf(page);
  expect(zoomedIn.zoomNumerator, 'the = key did not zoom the map in').not.toBe(
    zoomBefore.zoomNumerator,
  );
  await page.keyboard.press('-');
  expect((await cameraOf(page)).zoomNumerator, 'the - key did not zoom back out').toBe(
    zoomBefore.zoomNumerator,
  );
  await page.keyboard.press('+');
  expect(
    (await cameraOf(page)).zoomNumerator,
    'the shifted spelling of + did not zoom the map in, so the key is unreachable on layouts ' +
      'where + needs shift',
  ).not.toBe(zoomBefore.zoomNumerator);
  await page.keyboard.press('-');

  /* ------------------- (3) and nowhere else: the region owns them --------- */

  // The other half of the same rule, and the one that protects the sidebar's own scrolling: an arrow
  // pressed while a sidebar control has the focus is the browser's, and the map must not move.
  const parked = await cameraOf(page);
  await endTurnButton(page).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  expect(
    await cameraOf(page),
    'an arrow key pressed outside the map panned it: the map keys are bound to the region, not the ' +
      'document, and that is what keeps them from being stolen from every scrollable panel',
  ).toEqual(parked);

  // And Tab is not trapped: after the map, the focus moves on into the sidebar.
  await map.focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''),
    'Tab was trapped: the map kept the focus instead of passing it on',
  ).not.toBe('Map');
});

test('phase 5 discoverability: the bindings are listed in one place, and the list is what the app obeys', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);

  // The map says what it will do with the keys a keyboard user is about to press, on the region that
  // owns them (the canvas's own description is the *cursor* readout, which the contract fixes and
  // `map.spec.ts` asserts).
  await expect(mapViewport(page)).toHaveAttribute('aria-description', /Arrow keys pan/);

  const open = page.getByRole('button', { name: 'Keyboard' });
  await expect(open, 'the keyboard contract has no discoverable control').toBeVisible();
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard' });
  await expect(dialog, 'the Keyboard control opened no panel').toBeVisible();

  const keys = await dialog.locator('dt').allInnerTexts();
  const meanings = await dialog.locator('dd').allInnerTexts();
  expect(meanings.length, 'a listed key explains nothing').toBe(keys.length);
  for (const wanted of ['Space', 'Enter', 'Escape', '←', '→', '↑', '↓', '+', '−']) {
    expect(keys, `the help does not list ${wanted}`).toContain(wanted);
  }
  expect(
    keys.length,
    'the help lists fewer bindings than the table has: a key exists that nobody can find',
  ).toBe(9);

  // **The panel scrolls its bindings and never its way out.** Measured at 1280×900 the nine rows
  // plus their notes are 159 px taller than the body's box, so a panel that scrolled as a whole put
  // its own `Close` control below the fold — which is the defect `styles.css` records for the city
  // and tech screens, pointed the other way. Only the body scrolls, and the Close control is
  // asserted to be inside the window, the same way `panel-usability.spec.ts` asserts it for the
  // dialogs it measures.
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(close, 'the Keyboard panel has no Close control').toBeVisible();
  const closeBox = await close.boundingBox();
  const window_ = page.viewportSize();
  expect(closeBox, 'the Close control has no box, so it is not rendered').not.toBeNull();
  expect(window_, 'the viewport size is unknown').not.toBeNull();
  if (closeBox !== null && window_ !== null) {
    expect(
      closeBox.y + closeBox.height,
      'the Keyboard panel Close control is below the fold: the bindings scroll, and so did the way ' +
        'out of them',
    ).toBeLessThanOrEqual(window_.height);
  }

  // And the panel keeps its own keyboard while it is open (the deferral rule, at the one panel whose
  // opening control is the thing a player is most likely to press again).
  const selectedBefore = await selectedUnit(page);
  const turnBefore = (await readState(page)).turn;
  await page.keyboard.press('Space');
  expect(
    await selectedUnit(page),
    'Space pressed inside the Keyboard panel moved the selection',
  ).toBe(selectedBefore);
  expect((await readState(page)).turn).toBe(turnBefore);
  await closeDialogs(page);
});

test('phase 5 measured: what the next-unit flow costs, and what it replaces', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);

  const state = await readState(page);
  const owner = humanPlayerId(state);
  const mine = unitsOf(state, owner);
  const needy = await unitsNeedingOrders(page);
  const selected = await selectedUnit(page);

  // The pointer path to the same thing: the `Units` list, one row per unit, where **which unit still
  // has orders is not written** — the row is a name and an id, and the orders popup only appears for
  // the unit that is selected. So the pointer route is one click per unit plus reading the map; the
  // flow is one press per unit that actually needs one, and it never lands on a spent unit.
  const list = await page.evaluate(() => {
    const body = document.querySelector("[data-panel='units'] > ul");
    if (body === null) return null;
    const box = body.getBoundingClientRect();
    return {
      rows: body.querySelectorAll('li').length,
      boxHeight: Math.round(box.height),
      overflowY: body.scrollHeight - body.clientHeight,
    };
  });

  const presses = Math.max(needy.length - 1, 0);
  const report = [
    '',
    'phase 5 next-unit flow, measured through the app (seed ' + String(SEED) + '):',
    `  the seat owns ${String(mine.length)} units, of which the ENGINE offers orders for ${String(needy.length)}`,
    `  the Units list is the pointer path: ${String(list?.rows ?? 0)} rows in a ${String(list?.boxHeight ?? 0)} px box ` +
      `(overflowing by ${String(list?.overflowY ?? 0)} px), and a row says nothing about whether that unit still has orders`,
    `  the flow reaches every other unit with orders in ${String(presses)} keypresses, from any selection,`,
    '  and it says when there is nothing to move to rather than doing nothing (see the test above)',
    '',
  ].join('\n');
  process.stdout.write(report);

  // The claim that holds whatever the numbers are: the flow's own answer is the engine's.
  expect(
    needy.length,
    'the measure ran on a board where nothing needs orders, so it measured nothing',
  ).toBeGreaterThan(0);
  expect(needy, 'the app is showing orders for a unit the engine offers nothing').toContain(
    selected,
  );
  if (needy.length > 1) {
    await page.keyboard.press('Space');
    expect(needy, 'the flow selected a unit the engine offers nothing').toContain(
      await selectedUnit(page),
    );
  }
  // The turn indicator is read so the assertion above cannot silently be about a game that never
  // advanced.
  await expect(turnIndicator(page)).toContainText(/Turn \d+/);
});
