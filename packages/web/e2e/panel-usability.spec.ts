/**
 * X1 — the three things a player could not do: see a panel, set the rates, and read the sidebar.
 * See docs/INTERFACES.md, M8 ("The accessibility contract", "The UI must not contain game
 * rules", A1/A4 coverage).
 *
 * ## Why these facts need their own assertions
 *
 * 1. **A panel opened below the fold is an A1 failure.** The dialogs are non-modal on purpose
 *    (the game keeps being played while one is open), and a `<dialog open>` is laid out at its
 *    static position unless the stylesheet says otherwise — so on a 900 px-tall window the city
 *    screen, the tech tree and the debug panel appeared as a title and a Close button under
 *    everything else. Nothing in the suite noticed, because every locator is role-and-name based
 *    and a scrolled-out element still *matches*. The assertions here are therefore geometric:
 *    the panel's box is inside the window, and the screen points that matter (the middle of the
 *    map, the unit's own controls) still belong to the game rather than to a panel floating over
 *    it. That last half is not hypothetical either: centring the dialogs with `position: fixed`
 *    was implemented and measured, and it turned `debug.spec.ts` (which plays on while the debug
 *    panel is open) and the keystone wheel-zoom red — a panel over the game eats the gestures the
 *    game is driven by.
 * 2. **`SetRates` had no control anywhere.** It is the one queried setter with no enumerable
 *    list behind it — the rate space is a search space over a triple — so the status strip now
 *    carries an editable triple beside the pools it feeds, and the ENGINE judges every edit
 *    (`planSetRates`, the same evaluator `applyCommand` refuses with). The tests below check the
 *    whole loop: the engine's rates really move, the displayed strip stays in step, and an
 *    illegal triple is refused by the engine with the engine's own words rather than by a rule
 *    this UI invented.
 * 3. **Phase 3 re-partitioned the sidebar, and both halves of that are geometry.** The dialogs
 *    were docked under the map, where they took up to 40 % of the map column's height — measured at
 *    900×1000, opening the debug panel cut the map region from 915 px to 546 px, which moves the box
 *    the camera clamps against and the click hit-test inverts. They are docked in the sidebar now,
 *    so the map's box is asserted to be *identical* with and without panels open. And the sidebar
 *    itself, which used to hold 1219 px of content in an 823 px box at 1280×900 (its scoreboard cut
 *    off mid-row, its table 530 px wide inside a 378 px panel), is asserted to hold all of it.
 *
 * Every locator is role + accessible name, except where the claim is about the CSS box itself —
 * see the note above `sidebarReport` for why that one exception is the right one. The new names this
 * file's milestones add (`Tax rate`, `Science rate`, `Luxury rate`, `Rates`) collide with none of the
 * names the frozen table fixes.
 */

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
  endTurns,
  eventLog,
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
  await taxRate(page).fill(tax);
  await scienceRate(page).fill(science);
  await luxuryRate(page).fill(luxury);
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

/** A box on screen, with whatever does not fit inside it. */
interface MeasuredBox {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How much more content there is than box, in each direction. Zero means nothing is clipped. */
  readonly overflowX: number;
  readonly overflowY: number;
}

interface SidebarReport {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly sidebar: MeasuredBox;
  readonly stack: MeasuredBox;
  readonly panels: readonly MeasuredBox[];
  readonly scoreTable: MeasuredBox;
  /** The `Score` columnheader's cell — M10's column, the one the horizontal defect hid. */
  readonly scoreHeader: MeasuredBox | null;
  /** The last cell of every scoreboard row, i.e. the score itself, one per player. */
  readonly scoreCells: readonly MeasuredBox[];
}

const sidebarReport = async (page: Page): Promise<SidebarReport> =>
  page.evaluate(() => {
    const measured = (element: Element, name: string): MeasuredBox => {
      const rect = element.getBoundingClientRect();
      const box = element as HTMLElement;
      return {
        name,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        overflowX: box.scrollWidth - box.clientWidth,
        overflowY: box.scrollHeight - box.clientHeight,
      };
    };
    const require = (selector: string): Element => {
      const found = document.querySelector(selector);
      if (found === null) throw new Error(`the page has no ${selector}`);
      return found;
    };

    const stack = require("[data-layout='panel-stack']");
    const table = require("[data-panel='scoreboard'] table");
    const scoreHeader = table.querySelector('thead th:last-child');
    const scoreCells: MeasuredBox[] = [];
    let index = 0;
    for (const row of table.querySelectorAll('tbody tr')) {
      const cell = row.lastElementChild;
      if (cell !== null) scoreCells.push(measured(cell, `score cell ${String(index)}`));
      index += 1;
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sidebar: measured(require("main > section[aria-label='Panels']"), 'the sidebar'),
      stack: measured(stack, 'the panel stack'),
      panels: Array.from(stack.children)
        // `display: contents` generates no box, so the outcome wrapper is skipped rather than
        // reported at 0,0: what it holds is the `Show outcome` control, which is hidden until the
        // game is over (`victory.ts`) and is covered by the ending-screen tests, not here.
        .filter((child) => child.getBoundingClientRect().height > 0)
        .map((child) => measured(child, child.getAttribute('data-panel') ?? child.tagName)),
      scoreTable: measured(table, 'the scoreboard table'),
      scoreHeader: scoreHeader === null ? null : measured(scoreHeader, 'the Score columnheader'),
      scoreCells,
    };
  });

const within = (inner: MeasuredBox, outer: MeasuredBox, tolerance = 1): boolean =>
  inner.x >= outer.x - tolerance &&
  inner.y >= outer.y - tolerance &&
  inner.x + inner.width <= outer.x + outer.width + tolerance &&
  inner.y + inner.height <= outer.y + outer.height + tolerance;

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

  // 7. And a second panel opened beside the first is still fully visible: they share the dock — and
  //    the map is still where it was, with three things now on screen.
  const tech = await openPanel(page, /^Technology$/);
  await expectFullyVisible('the Technology panel beside the Debug panel', tech);
  await expectFullyVisible('the Debug panel beside the Technology panel', debug);
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
test('X1 sidebar: at 1280×900 the strip holds every panel and the whole scoreboard, and does not scroll to do it', async ({
  page,
}) => {
  await openApp(page);
  expect(page.viewportSize(), 'this test is about the 1280×900 window').toEqual(VIEWPORT);
  await seedApp(page, SEED);
  // A city in the `Cities` list and a second unit in the `Units` list, and then a played game so the
  // event log fills to its own bound — the state the overflow was measured in.
  await foundCity(page);
  await endTurns(page, 14);

  const logOverflow = await eventLog(page).evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
  expect(
    logOverflow,
    'the event log is not longer than its own box, so this test is measuring an empty strip and ' +
      'could not fail for the defect it is about',
  ).toBeGreaterThan(0);

  const report = await sidebarReport(page);

  // 1. The strip itself never overflows, in either direction. A strip that scrolls is how the
  //    scoreboard got cut off in the first place: a scrollbar does not tell a player that the row
  //    they are looking at is half a row.
  expect(
    report.sidebar.overflowY,
    `the sidebar holds ${String(report.sidebar.overflowY)} px more content than it can show, so a ` +
      `panel at its bottom edge is cut off`,
  ).toBeLessThanOrEqual(1);
  expect(
    report.sidebar.overflowX,
    `the sidebar holds ${String(report.sidebar.overflowX)} px more content than it is wide, so a ` +
      `panel is clipped at its right edge`,
  ).toBeLessThanOrEqual(1);

  // 2. And neither does the stack inside it — which is the stronger claim, because that is the
  //    element that could scroll instead: the strip would look tidy while the stack hid the
  //    scoreboard behind a scrollbar.
  expect(
    report.stack.overflowY,
    `the panel stack holds ${String(report.stack.overflowY)} px more content than it can show, so ` +
      `the panels at its bottom are below the fold`,
  ).toBeLessThanOrEqual(1);

  // 3. Every panel is whole, inside the strip and inside the window. Named individually, because
  //    "one of them is cut off" is not a useful failure message.
  expect(report.panels.length, 'the sidebar is not holding the panels').toBeGreaterThan(5);
  for (const panel of report.panels) {
    expect(
      within(panel, report.sidebar, 1.5),
      `the ${panel.name} panel is not inside the sidebar: the panel is at ${String(
        Math.round(panel.y),
      )}..${String(Math.round(panel.y + panel.height))} and the sidebar holds ${String(
        Math.round(report.sidebar.y),
      )}..${String(Math.round(report.sidebar.y + report.sidebar.height))}`,
    ).toBe(true);
    expect(
      panel.overflowY,
      `the ${panel.name} panel has ${String(panel.overflowY)} px of its own content hidden inside it`,
    ).toBeLessThanOrEqual(1);
  }

  // 4. The scoreboard is the panel the defect was measured on, so it is asserted cell by cell: the
  //    table is inside the strip (its width is the part that was cut off sideways), there is a row
  //    per player — so "every row is on screen" is not a claim about an empty table — and the last
  //    cell of each row, which is M10's score, is on screen.
  const players = (await readState(page)).players.length;
  expect(
    report.scoreTable.x + report.scoreTable.width,
    'the scoreboard is clipped by the strip',
  ).toBeLessThanOrEqual(report.sidebar.x + report.sidebar.width + 1);
  // The table's OWN box, not only the strip's. The tempting band-aid for a table that does not fit
  // is to let the table scroll sideways inside its panel — which hides the same columns one level
  // down, behind a scrollbar that nothing in the app ever shows a player. Measured before the fix:
  // 530 px of table in a 378 px panel.
  expect(
    report.scoreTable.overflowX,
    `the scoreboard's columns are ${String(report.scoreTable.overflowX)} px wider than the panel, so ` +
      `its right-hand columns are behind a horizontal scrollbar`,
  ).toBeLessThanOrEqual(1);
  expect(
    report.scoreCells.length,
    'the scoreboard has no rows, so nothing below is a claim about the scoreboard',
  ).toBe(players);
  const scoreHeader = report.scoreHeader;
  expect(scoreHeader, 'the scoreboard has no Score columnheader to measure').not.toBeNull();
  if (scoreHeader === null) return;
  expect(
    within(scoreHeader, report.sidebar, 1.5),
    `the Score columnheader is off the edge of the strip at x=${String(Math.round(scoreHeader.x))}, ` +
      `which is where the horizontal half of the defect put it`,
  ).toBe(true);
  for (const cell of report.scoreCells) {
    expect(
      within(cell, report.sidebar, 1.5),
      `${cell.name} is cut off: the cell is at y=${String(Math.round(cell.y))}..${String(
        Math.round(cell.y + cell.height),
      )}, x=${String(Math.round(cell.x))}..${String(Math.round(cell.x + cell.width))}, and the ` +
        `sidebar holds y=${String(Math.round(report.sidebar.y))}..${String(
          Math.round(report.sidebar.y + report.sidebar.height),
        )}, x=${String(Math.round(report.sidebar.x))}..${String(
          Math.round(report.sidebar.x + report.sidebar.width),
        )}`,
    ).toBe(true);
  }
});

/* ------------------------------------------------------------------ *
 * 2. THE RATES
 * ------------------------------------------------------------------ */

test('X1 rates: setting the rates through the status strip moves the ENGINE’s own rates, and the strip follows', async ({
  page,
}) => {
  await openApp(page);
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
  await expect(taxRate(page)).toHaveValue(String(initial.tax));
  await expect(scienceRate(page)).toHaveValue(String(initial.science));
  await expect(luxuryRate(page)).toHaveValue(String(initial.luxury));
  await expect(ratesNotice(page)).toContainText('the engine accepts');
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
  await expect(taxRate(page)).toHaveValue('5');
  await expect(scienceRate(page)).toHaveValue('3');
  await expect(luxuryRate(page)).toHaveValue('2');
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
  await expect(taxRate(page)).toHaveValue(String(elsewhere.tax));
  await expect(scienceRate(page)).toHaveValue(String(elsewhere.science));
  await expect(luxuryRate(page)).toHaveValue(String(elsewhere.luxury));
});

test('X1 rates: an illegal triple is refused by the ENGINE, in the engine’s own words, and never dispatched', async ({
  page,
}) => {
  await openApp(page);
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
  await expect(ratesNotice(page)).toContainText(engineMessage);
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
  await expect(ratesNotice(page)).toContainText(unreadable ?? 'unreachable');
  await expect(setRatesButton(page)).toBeDisabled();

  // And the rule is recoverable: a legal triple re-enables the control and applies.
  await typeRates(page, '5', '5', '0');
  await expect(setRatesButton(page)).toBeEnabled();
  await expect(ratesNotice(page)).toContainText('the engine accepts');
  await setRatesButton(page).click();
  expect(await stateHash(page), 'the legal triple did not change the state').not.toBe(hashBefore);
});
