/** Browser checks for docked dialogs, map interaction, scoreboard readability and percentage budgets. Workspace navigation and responsive layout are covered in workspace.spec.ts. */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { RATE_TOTAL, applyCommand, planSetRates, rateCapsOf, ratesProblem } from '@civts/core';

import {
  actionType,
  cameraOf,
  canvasBox,
  cityDialog,
  clearDispatchLog,
  closeDialogs,
  dispatch,
  dispatchLog,
  endTurnButton,
  foundCity,
  hashOf,
  headlessNewGame,
  humanPlayer,
  humanPlayerId,
  OPPONENT_OFF,
  openApp,
  openCity,
  openPanel,
  readSettings,
  readState,
  recordDispatches,
  RULESET,
  seedApp,
  settingsFrom,
  stateHash,
  treasuryIndicator,
  unitActionsGroup,
  unitsOf,
  zoomTo,
} from './helpers.js';

const SEED = 8123;

/** The window the milestone is played in, and the one the suite configures. */
const VIEWPORT = { width: 1280, height: 900 } as const;

/* ------------------------------------------------------------------ *
 * The controls this file is about, by role and accessible name
 * ------------------------------------------------------------------ */

const taxRate = (page: Page): Locator => page.getByRole('spinbutton', { name: 'Tax rate' });
const scienceRate = (page: Page): Locator => page.getByRole('spinbutton', { name: 'Science rate' });
const luxuryRate = (page: Page): Locator => page.getByRole('spinbutton', { name: 'Luxury rate' });

/** The control that dispatches `SetRates`. */
const setRatesButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Set rates', exact: true });

/** The engine's own verdict on the triple the controls hold — a NEW `status`, not one of the five. */
const ratesNotice = (page: Page): Locator => page.getByRole('status', { name: 'Rates' });

/** Type a triple into the three controls, the way a player would. */
const typeRates = async (
  page: Page,
  tax: string,
  science: string,
  luxury: string,
): Promise<void> => {
  await page.getByRole('tab', { name: 'Empire', exact: true }).click();
  await taxRate(page).fill(String(Number(tax) * 10));
  await scienceRate(page).fill(String(Number(science) * 10));
  await luxuryRate(page).fill(String(Number(luxury) * 10));
};

/* ------------------------------------------------------------------ *
 * Geometry probes
 * ------------------------------------------------------------------ */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const centreOf = (box: Box): { readonly x: number; readonly y: number } => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/**
 * Which element owns a screen point, as `TAG[aria-label]`.
 *
 * `elementFromPoint` is the browser's own answer to "what would a click here hit?", which is
 * exactly the question a panel floating over the game gets wrong — a box measured inside the
 * window can still be *on top of* the thing the player is trying to click.
 */
const elementAt = async (
  page: Page,
  point: { readonly x: number; readonly y: number },
): Promise<string> =>
  page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return 'nothing';
    const label = hit.getAttribute('aria-label');
    return label === null ? hit.tagName : `${hit.tagName}[${label}]`;
  }, point);

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no bounding box, so it is not rendered');
  return box;
};

/* ------------------------------------------------------------------ *
 * The sidebar, measured
 *
 * Phase 3 moved everything that is not a direct unit action into the strip beside the map and
 * stopped it overflowing. Both halves of that are claims about geometry, so they are measured here
 * rather than inferred from a stylesheet: which box is inside which, which box has more content
 * than room, and whether the scoreboard's own cells are on screen.
 *
 * This is the one place in this file that names the layout (`data-layout`, `data-panel`) instead of
 * a role and an accessible name. That is deliberate and it is not a hole in the contract: the claim
 * is about the CSS — the same claim `styles.css` states in prose — and no role or accessible name
 * can express "this box has 96 px more content than it can show". Everything a player or a screen
 * reader is *offered* is still asserted by role and name, in this file and in `panels.spec.ts`.
 * ------------------------------------------------------------------ */

/** Assert `what`'s box — and its Close control — are entirely inside the window. */
const expectFullyVisible = async (what: string, dialog: Locator): Promise<void> => {
  await expect(dialog, `${what} is not visible`).toBeVisible();
  const box = await boxOf(dialog);
  expect(box.x, `${what} starts left of the window`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${what} starts above the window`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} runs past the right edge of the window`).toBeLessThanOrEqual(
    VIEWPORT.width,
  );
  expect(
    box.y + box.height,
    `${what} runs past the bottom of the window — the below-the-fold defect, where a player sees ` +
      `a title and a Close button and nothing else`,
  ).toBeLessThanOrEqual(VIEWPORT.height);

  const close = dialog.getByRole('button', { name: /^Close$/ });
  await expect(close, `${what} has no Close control`).toBeVisible();
  const closeBox = await boxOf(close);
  expect(
    closeBox.y + closeBox.height,
    `${what}'s Close control is below the fold`,
  ).toBeLessThanOrEqual(VIEWPORT.height);
};

/* ------------------------------------------------------------------ *
 * 1. PLACEMENT
 * ------------------------------------------------------------------ */

test('X1 placement: the city screen, the tech tree and the debug panel each open fully visible on a 900 px-tall window', async ({
  page,
}) => {
  await openApp(page);
  expect(page.viewportSize(), 'this test is about a 900 px-tall window').toEqual(VIEWPORT);
  await seedApp(page, SEED);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  // The city screen. It needs a city, founded through the settler's own control.
  const city = await foundCity(page);
  const openCityDialog = await openCity(page, await readState(page), await cameraOf(page), city);
  await expectFullyVisible(`the City ${city.name} screen`, cityDialog(page, city.name));

  // "Usable", not merely painted: a control inside it dispatches what it says it does.
  const build = openCityDialog.getByRole('button', { name: /^Build / }).first();
  await expect(build).toBeEnabled();
  await clearDispatchLog(page);
  await build.click();
  const built = await dispatchLog(page);
  expect(
    built.map((entry) => actionType(entry.action)),
    'the first Build control inside the docked city screen dispatched something else',
  ).toEqual(['SetProduction']);
  expect(built[0]?.result, 'the engine refused the production the control applied').toBe('ok');
  await closeDialogs(page);

  // The tech tree, and one of its rows.
  const tech = await openPanel(page, /^Technology$/);
  await expectFullyVisible('the Technology panel', tech);
  const rows = tech.getByRole('button', { name: /\(/ });
  const rowCount = await rows.count();
  expect(
    rowCount,
    'the tech tree shows no tech rows, so nothing in it could be clicked',
  ).toBeGreaterThan(0);
  let clicked = false;
  for (let index = 0; index < rowCount && !clicked; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isEnabled())) continue;
    await clearDispatchLog(page);
    await row.click();
    const answered = await dispatchLog(page);
    expect(
      answered.map((entry) => actionType(entry.action)),
      'an enabled tech row inside the docked tech tree dispatched something else',
    ).toEqual(['SetResearch']);
    expect(answered[0]?.result, 'the engine refused the research the row applied').toBe('ok');
    clicked = true;
  }
  expect(clicked, 'no tech row inside the panel was clickable').toBe(true);
  await closeDialogs(page);

  // The debug panel.
  const debug = await openPanel(page, /^Debug$/);
  await expectFullyVisible('the Debug panel', debug);
  await debug.getByRole('button', { name: /^Close$/ }).click();
  await expect(page.getByRole('dialog'), 'the Close control did not close the panel').toHaveCount(
    0,
  );
});

test('X1 placement: an open panel covers neither the map nor the action buttons, so the game can still be played', async ({
  page,
}) => {
  await openApp(page);
  // **The opponent is held still.** This test is about the docked panels covering nothing — the map
  // still takes the pointer, `End turn` still advances the game, and the settler's own control still
  // founds the acting seat's city. With the opponent left on, the `End turn` click below also plays
  // the rival seat, whose policy founds a city of its own first — and `foundCity` (which returns the
  // engine's first city) then hands back the RIVAL's city, so this test fails about a foreign city
  // instead of about panel placement. Nothing here is about the AI: switching it off keeps the
  // measurement on the panels and the controls beside them. See `OPPONENT_OFF` in `helpers.ts`.
  await seedApp(page, SEED, OPPONENT_OFF);

  // Phase 3: the panel that opens is docked in the sidebar, and the unit's orders float over the
  // map. Both of those are boxes, so both are measured BEFORE the panel opens — a panel that moves
  // the map (as the old dock under the map did, taking up to 40 % of the column's height) changes
  // the box the camera clamps against and the click hit-test inverts, which is a defect that a
  // "is anything covered?" check cannot see at all.
  const before = await readState(page);
  const owner = humanPlayerId(before);
  const unit = unitsOf(before, owner)[0];
  expect(unit, 'the acting seat has no unit, so there is no orders popup to measure').toBeDefined();
  if (unit === undefined) return;
  const orders = unitActionsGroup(page, unit.id);
  await expect(orders, 'no orders popup is on screen before anything is opened').toBeVisible();
  const canvasBefore = await canvasBox(page);
  const ordersBefore = await boxOf(orders);

  // The debug panel is the one `debug.spec.ts` plays on through, so it is the one that must be
  // proven not to be in the way.
  const debug = await openPanel(page, /^Debug$/);
  await expect(debug).toBeVisible();

  // 1. The map's box did not move, and neither did the unit's orders. This is the assertion that
  //    pins Phase 3's structural half: the dialogs are docked in the sidebar, so the map column has
  //    one claimant and the popup's placement is a function of the canvas alone.
  const canvasAfter = await canvasBox(page);
  expect(
    { x: canvasAfter.x, y: canvasAfter.y, width: canvasAfter.width, height: canvasAfter.height },
    'opening a panel moved or resized the map, so the camera’s clamp box and the click inverse ' +
      'changed while the player was looking at the same view',
  ).toEqual({
    x: canvasBefore.x,
    y: canvasBefore.y,
    width: canvasBefore.width,
    height: canvasBefore.height,
  });
  const ordersAfter = await boxOf(orders);
  expect(
    { x: ordersAfter.x, y: ordersAfter.y, width: ordersAfter.width, height: ordersAfter.height },
    'opening a panel moved the unit’s orders popup',
  ).toEqual({
    x: ordersBefore.x,
    y: ordersBefore.y,
    width: ordersBefore.width,
    height: ordersBefore.height,
  });

  // 2. A press on the popup's own control lands on that control, and the panel's box is beside the
  //    popup rather than over it. Both halves are asserted because they fail for different reasons:
  //    the hit-test is what the player experiences — the popup carries its own `z-index`, so it
  //    survives a dialog floated over it, which means a covered *control* takes a second mistake and
  //    this check is what catches that one — and the box overlap is the layout claim, which fails on
  //    its own the moment a panel is allowed to share pixels with the map.
  const orderButton = orders.getByRole('button').first();
  await expect(orderButton, 'the popup offers no control to press').toBeVisible();
  const buttonBox = await boxOf(orderButton);
  expect(
    await elementAt(page, centreOf(buttonBox)),
    'something other than the unit’s own control owns the point at the centre of that control',
  ).toBe('BUTTON');

  const debugBox = await boxOf(debug);
  const overlaps =
    ordersAfter.x < debugBox.x + debugBox.width &&
    debugBox.x < ordersAfter.x + ordersAfter.width &&
    ordersAfter.y < debugBox.y + debugBox.height &&
    debugBox.y < ordersAfter.y + ordersAfter.height;
  expect(overlaps, 'the open panel’s box overlaps the unit’s orders popup').toBe(false);

  // 3. The middle of the map belongs to the canvas. This is the assertion a panel floating over
  //    the game fails: the box is inside the window, and it is on top of the map.
  const canvas = await canvasBox(page);
  const mapCentre = centreOf(canvas);
  expect(
    await elementAt(page, mapCentre),
    'something covers the middle of the map while a panel is open',
  ).toBe('CANVAS');

  // 4. The map actually receives the pointer: its description names the tile under the cursor.
  await page.mouse.move(mapCentre.x, mapCentre.y);
  await expect(page.getByRole('application', { name: 'Map' }).locator('canvas')).toHaveAttribute(
    'aria-description',
    /pointer over tile \d+,\d+/,
  );

  // 5. The wheel is the zoom gesture, and it still reaches the map. A panel over the map swallows
  //    it and the camera does not move — which is exactly how the floating layout was caught.
  const beforeZoom = await cameraOf(page);
  const zoomed = await zoomTo(page, 1, 1);
  expect(
    zoomed.zoomNumerator,
    'the wheel over the map did not zoom while a panel was open',
  ).not.toBe(beforeZoom.zoomNumerator);

  // 6. The panel column is operable: the shell's turn control works with a panel up...
  const beforeTurn = await readState(page);
  await endTurnButton(page).click();
  expect((await readState(page)).turn, 'End turn did not advance the game').toBe(
    beforeTurn.turn + 1,
  );

  // ... and so does a unit order, issued from the popup beside the unit.
  const city = await foundCity(page);
  expect(city.owner, 'founding a city through the panel column produced a foreign city').toBe(
    humanPlayerId(await readState(page)),
  );

  // 7. Opening another panel replaces the previous dialog in the dock, and
  //    the map is still where it was, with three things now on screen.
  const tech = await openPanel(page, /^Technology$/);
  await expectFullyVisible('the Technology panel beside the Debug panel', tech);
  await expect(debug).toBeHidden();
  const canvasWithTwo = await canvasBox(page);
  expect(
    {
      x: canvasWithTwo.x,
      y: canvasWithTwo.y,
      width: canvasWithTwo.width,
      height: canvasWithTwo.height,
    },
    'a second open panel moved or resized the map',
  ).toEqual({
    x: canvasBefore.x,
    y: canvasBefore.y,
    width: canvasBefore.width,
    height: canvasBefore.height,
  });
  await closeDialogs(page);
});

/* ------------------------------------------------------------------ *
 * 1a. THE HOVER LAYER (phase 6), AND THE ONE RULE IT MUST OBEY
 * ------------------------------------------------------------------ */

/**
 * **The rule this test exists for is phase 2's, applied to phase 6's box.** The unit action popup
 * carries `pointer-events: none` with `auto` on its buttons, because a menu floating over a
 * clickable map that can be hit is a menu that eats the clicks aimed at the tiles beneath it — and
 * the paragraph above records the measurement that produced it. The tile readout is a box floating
 * over the same map, so it obeys the same discipline, and this is where that is measured rather
 * than asserted in a comment.
 *
 * The assertions are the browser's own hit test at two points: the middle of the map (which must
 * still belong to the canvas while a readout is on screen) and the middle of the readout itself
 * (which must belong to the canvas too — `elementFromPoint` skips an element that cannot be hit).
 * Neither of them is weakened by this phase: the map-centre assertion already existed here and is
 * re-taken with the readout up.
 */
test('X1 hover: the tile readout appears over the map, and the map keeps every click it is aimed at', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);

  const canvas = await canvasBox(page);
  const mapCentre = centreOf(canvas);
  const readout = page.getByRole('status', { name: 'Tile' });
  await expect(
    readout,
    'the tile readout is on screen before the pointer is over the map',
  ).toBeHidden();

  await page.mouse.move(mapCentre.x, mapCentre.y);
  await expect(
    readout,
    'hovering the middle of the map produced no tile readout: the hover layer is not wired to the pointer',
  ).toBeVisible();
  await expect(readout, 'the readout says nothing about the tile it is over').not.toBeEmpty();

  expect(
    await elementAt(page, mapCentre),
    'something covers the middle of the map while the tile readout is up',
  ).toBe('CANVAS');

  const readoutBox = await boxOf(readout);
  expect(
    readoutBox.x >= canvas.x - 1 &&
      readoutBox.y >= canvas.y - 1 &&
      readoutBox.x + readoutBox.width <= canvas.x + canvas.width + 1 &&
      readoutBox.y + readoutBox.height <= canvas.y + canvas.height + 1,
    `the readout is not on the map: its box ${
      `(${String(Math.round(readoutBox.x))},${String(Math.round(readoutBox.y))} ` +
      `${String(Math.round(readoutBox.width))}x${String(Math.round(readoutBox.height))})`
    } is outside the canvas (${String(Math.round(canvas.x))},${String(Math.round(canvas.y))} ` +
      `${String(Math.round(canvas.width))}x${String(Math.round(canvas.height))})`,
  ).toBe(true);

  expect(
    await elementAt(page, centreOf(readoutBox)),
    'the tile readout is hit-testable: the point at its own middle belongs to it, so a click aimed ' +
      'at the tile beneath it would be taken by the tooltip',
  ).toBe('CANVAS');

  // A panel opened while the pointer is on the map does not change the map's box (phase 3's
  // structural claim) and does not take the readout's job: it is docked in the sidebar, which is
  // where the panel column is, so neither box can reach the other.
  const debug = await openPanel(page, /^Debug$/);
  await expect(debug).toBeVisible();
  expect(
    { x: (await canvasBox(page)).x, y: (await canvasBox(page)).y },
    'opening a panel moved the map while the hover layer was measuring it',
  ).toEqual({ x: canvas.x, y: canvas.y });
  expect(await elementAt(page, mapCentre)).toBe('CANVAS');
  await closeDialogs(page);

  await page.mouse.move(2, 2);
  await expect(readout, 'the readout stayed up after the pointer left the map').toBeHidden();
});

/* ------------------------------------------------------------------ *
 * 1b. THE SIDEBAR: EVERYTHING THAT IS NOT A UNIT ORDER, AND NOTHING CUT OFF
 * ------------------------------------------------------------------ */

/**
 * The defect this test is about, in the owner's words: *"at 1280×900 the sidebar overflows and the
 * scoreboard is cut off mid-row"*. Measured before the fix, with the event log full and the opponent
 * live: **1219 px of content in an 823 px box** (396 px of overflow, so the save and debug panels
 * were below the fold entirely), and a scoreboard table **530 px wide inside a 378 px panel**, which
 * clipped its right-hand columns — `Score` among them — and could only be reached by scrolling the
 * whole strip sideways.
 *
 * So the assertions are about content that has been played into existence, not about a fresh board:
 * a founded city, a live opponent and an event log whose own list is provably longer than its box.
 * That last one is the control. Without it this test would pass on an empty log in a strip with
 * nothing in it, which is the "a test that cannot fail is decoration" failure this project names.
 */
test('X1 scoreboard: the name column is clear of its first figure, and the table still fits the strip', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('tab', { name: 'Diplomacy', exact: true }).click();
  await seedApp(page, SEED, OPPONENT_OFF);

  const measured = await page.evaluate(() => {
    const table = document.querySelector("[data-panel='scoreboard'] table");
    if (table === null) throw new Error('the scoreboard table is not in the DOM');
    const rows = [...table.querySelectorAll('tbody tr')];
    const last = rows[rows.length - 1];
    const cells = last === undefined ? [] : [...last.children];
    const value = cells[1]?.getBoundingClientRect();
    // The *text*, not the cell box: this column's padding lives inside the cell, so a cell boundary
    // says nothing about how far the word is from the figure beside it.
    const name = last?.firstElementChild?.firstChild ?? null;
    const range = document.createRange();
    let textRight: number | null = null;
    if (name !== null) {
      range.selectNodeContents(name.parentNode ?? table);
      const box = range.getBoundingClientRect();
      textRight = box.width === 0 ? null : box.right;
    }
    return {
      value: value === undefined ? null : { left: value.left, right: value.right },
      textRight,
      scrollWidth: table.scrollWidth,
      clientWidth: table.clientWidth,
      rows: rows.length,
      longest: last?.textContent ?? '',
    };
  });

  expect(measured.rows, 'the scoreboard has no rows to measure').toBeGreaterThan(0);
  expect(measured.value, 'the scoreboard has no second column').not.toBeNull();
  expect(
    measured.textRight,
    'the longest name has no text box, so the gap below would be measured from nothing',
  ).not.toBeNull();
  if (measured.value === null || measured.textRight === null) return;
  const gap = measured.value.left - measured.textRight;
  expect(
    gap,
    `the name column is not clear of its first figure: the row "${measured.longest}" ends its name ` +
      `at x=${String(Math.round(measured.textRight))} and begins its first value at x=${String(
        Math.round(measured.value.left),
      )}, a gap of ${String(Math.round(gap))} px — which is what made it read as "Barbarians0"`,
  ).toBeGreaterThanOrEqual(6);
  expect(
    measured.scrollWidth,
    'the scoreboard table overflows its panel, so the columns would be clipped or scrolled',
  ).toBeLessThanOrEqual(measured.clientWidth + 1);
});

test('X1 rates: setting the rates through the status strip moves the ENGINE’s own rates, and the strip follows', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('tab', { name: 'Empire', exact: true }).click();
  const state = await seedApp(page, SEED);
  const owner = humanPlayerId(state);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  // The engine's own game for this seed, in this process: every hash below is compared against
  // what the ENGINE does with the same command, so "the UI changed the rates" is a claim about
  // the engine's state and not about a label the panel printed.
  const started = headlessNewGame(SEED, settingsFrom(await readSettings(page), SEED));
  expect(started.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (!started.ok) return;
  expect(await stateHash(page), 'the browser is not the game the engine starts for this seed').toBe(
    hashOf(started.value),
  );

  // The triple on screen is the state's own: the control opens showing the rates the engine holds
  // and the engine's verdict on them.
  const initial = started.value.players.find((player) => player.id === owner)?.rates;
  expect(initial, 'the headless state has no rates for the acting seat').toBeDefined();
  if (initial === undefined) return;
  await expect(taxRate(page)).toHaveValue(String(initial.tax * 10));
  await expect(scienceRate(page)).toHaveValue(String(initial.science * 10));
  await expect(luxuryRate(page)).toHaveValue(String(initial.luxury * 10));
  await expect(ratesNotice(page)).toContainText('Budget ready to apply.');
  await expect(setRatesButton(page)).toBeEnabled();

  // A legal triple, typed by a player and applied by the control.
  const RATES = { tax: 5, science: 3, luxury: 2 } as const;
  await typeRates(page, '5', '3', '2');
  await expect(setRatesButton(page)).toBeEnabled();
  await clearDispatchLog(page);
  await setRatesButton(page).click();

  const dispatched = await dispatchLog(page);
  expect(
    dispatched.map((entry) => actionType(entry.action)),
    'the Set rates control dispatched something other than SetRates',
  ).toEqual(['SetRates']);
  expect(dispatched[0]?.result, 'the engine refused the rates the control applied').toBe('ok');

  // THE CLAIM: the engine's state is the state the engine produces by applying that very command.
  const applied = applyCommand(started.value, owner, { type: 'SetRates', rates: RATES }, RULESET);
  expect(applied.ok, 'the engine refused a legal rates triple').toBe(true);
  if (!applied.ok) return;
  const after = await stateHash(page);
  expect(after, 'the engine’s own rates did not move to the triple the control set').toBe(
    hashOf(applied.value.state),
  );
  expect(after, 'the rates command changed nothing at all').not.toBe(hashOf(started.value));

  // The strip is in step with the state it just changed — the triple, and the pool beside it.
  await expect(taxRate(page)).toHaveValue('50');
  await expect(scienceRate(page)).toHaveValue('30');
  await expect(luxuryRate(page)).toHaveValue('20');
  await expect(treasuryIndicator(page)).toContainText(
    String(humanPlayer(await readState(page)).treasury),
  );

  // A change the control did not make (a load, another seat, a command from a test) lands on
  // screen too: the panel re-reads the state rather than trusting its own last edit.
  //
  // This triple USED to be `{ tax: 1, science: 1, luxury: 8 }` and it moved in M9: `planSetRates`
  // now refuses a rate above the GOVERNMENT's own cap (`rateCapsOf`, M9's "rate caps clamp
  // `SetRates` legality"), and every game starts under the shipped `despotism` row, whose luxury
  // cap is 2. So 1/1/8 came back `refused` and the three assertions below stopped seeing a change
  // at all. The replacement is not another hand-picked triple — it is asked of the engine that
  // owns the rule: the caps come from the row the state holds, so this cannot go stale again when
  // a catalog number moves, and `planSetRates` is consulted before the dispatch so a triple the
  // engine would refuse fails here rather than looking like a UI defect.
  const seat = started.value.players.find((candidate) => candidate.id === owner);
  expect(seat, 'the headless state has no seat to read the rate caps from').toBeDefined();
  if (seat === undefined) return;
  const caps = rateCapsOf(RULESET, seat);
  // Both halves of the engine's rate rule are asked of the engine rather than written down here:
  // the sum `RATE_TOTAL` fixes, and the GOVERNMENT's own cap on each rate (`rateCapsOf`, M9 — the
  // ceiling `planSetRates` refuses above). The largest tax allocation the caps allow, the remainder
  // on luxury, and what is left on science sums to `RATE_TOTAL` by construction.
  const luxury = Math.min(caps.luxury, RATE_TOTAL - caps.tax);
  const elsewhere = {
    tax: caps.tax,
    luxury,
    science: RATE_TOTAL - caps.tax - luxury,
  } as const;
  expect(
    planSetRates(started.value, RULESET, owner, elsewhere).ok,
    `the engine refuses ${String(elsewhere.tax)}/${String(elsewhere.science)}/${String(
      elsewhere.luxury,
    )}, which is the triple this test uses to prove the strip follows the state`,
  ).toBe(true);
  expect(await dispatch(page, { type: 'SetRates', rates: elsewhere })).toBe('ok');
  await expect(taxRate(page)).toHaveValue(String(elsewhere.tax * 10));
  await expect(scienceRate(page)).toHaveValue(String(elsewhere.science * 10));
  await expect(luxuryRate(page)).toHaveValue(String(elsewhere.luxury * 10));
});

test('X1 rates: an illegal triple is refused by the ENGINE, in the engine’s own words, and never dispatched', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('tab', { name: 'Empire', exact: true }).click();
  await seedApp(page, SEED);
  const hashBefore = await stateHash(page);

  // 5/5/5 sums to 15, and the rule is stated once — in `economy.ts`' `ratesProblem`, which
  // `planSetRates` refuses with and which `applyCommand` refuses through. The panel must show
  // THAT string, because a second, hand-written "rates must total 10" in the UI would be a second
  // statement of the rule, free to disagree with the engine's.
  const engineMessage = ratesProblem({ tax: 5, science: 5, luxury: 5 });
  expect(
    engineMessage,
    'the engine has no complaint about 5/5/5, so this test is vacuous',
  ).toBeDefined();
  if (engineMessage === undefined) return;

  await typeRates(page, '5', '5', '5');
  await expect(ratesNotice(page)).toContainText('exactly 100%');
  await expect(ratesNotice(page)).toContainText('= 150%');
  // The control cannot offer what the engine refuses: it is disabled, so a player cannot dispatch
  // it and a sweep cannot either.
  await expect(setRatesButton(page)).toBeDisabled();

  // The refusal is the engine's, not the panel's: the same triple sent straight through the seam
  // — the applier every control goes through — is refused as well, and leaves the state alone.
  expect(
    await dispatch(page, { type: 'SetRates', rates: { tax: 5, science: 5, luxury: 5 } }),
    'the engine accepted a triple the panel refused, so the panel is the one deciding',
  ).toBe('refused');
  expect(await stateHash(page), 'a refused rates command changed the state').toBe(hashBefore);

  // A field the engine cannot read a rate out of is refused with the rule's own words too: the UI
  // hands the rule what the field holds rather than substituting a plausible zero for it.
  const unreadable = ratesProblem({ tax: Number.NaN, science: 5, luxury: 5 });
  expect(unreadable, 'the engine accepts an unreadable rate').toBeDefined();
  await taxRate(page).fill('');
  await expect(ratesNotice(page)).toContainText('percentage in steps of 10');
  await expect(setRatesButton(page)).toBeDisabled();

  // And the rule is recoverable: a legal triple re-enables the control and applies.
  await typeRates(page, '5', '5', '0');
  await expect(setRatesButton(page)).toBeEnabled();
  await expect(ratesNotice(page)).toContainText('Budget ready to apply.');
  await setRatesButton(page).click();
  expect(await stateHash(page), 'the legal triple did not change the state').not.toBe(hashBefore);
});
