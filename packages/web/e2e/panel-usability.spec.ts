/**
 * X1 — the two things a player could not do: see a panel, and set the rates.
 * See docs/INTERFACES.md, M8 ("The accessibility contract", "The UI must not contain game
 * rules", A1/A4 coverage).
 *
 * ## Why these two facts need their own assertions
 *
 * 1. **A panel opened below the fold is an A1 failure.** The dialogs are non-modal on purpose
 *    (the game keeps being played while one is open), and a `<dialog open>` is laid out at its
 *    static position unless the stylesheet says otherwise — so on a 900 px-tall window the city
 *    screen, the tech tree and the debug panel appeared as a title and a Close button under
 *    everything else. Nothing in the suite noticed, because every locator is role-and-name based
 *    and a scrolled-out element still *matches*. The assertions here are therefore geometric:
 *    the panel's box is inside the window, and the screen points that matter (the middle of the
 *    map, an action button in the panel column) still belong to the game rather than to a panel
 *    floating over it. That last half is not hypothetical either: centring the dialogs with
 *    `position: fixed` was implemented and measured, and it turned `debug.spec.ts` (which plays
 *    on while the debug panel is open) and the keystone wheel-zoom red — a panel over the game
 *    eats the gestures the game is driven by.
 * 2. **`SetRates` had no control anywhere.** It is the one queried setter with no enumerable
 *    list behind it — the rate space is a search space over a triple — so the status strip now
 *    carries an editable triple beside the pools it feeds, and the ENGINE judges every edit
 *    (`planSetRates`, the same evaluator `applyCommand` refuses with). The tests below check the
 *    whole loop: the engine's rates really move, the displayed strip stays in step, and an
 *    illegal triple is refused by the engine with the engine's own words rather than by a rule
 *    this UI invented.
 *
 * Every locator is role + accessible name. The three rate controls and their verdict are the
 * *new* names this milestone adds (`Tax rate`, `Science rate`, `Luxury rate`, `Rates`); none of
 * them collides with the names the frozen table fixes.
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

  // The debug panel is the one `debug.spec.ts` plays on through, so it is the one that must be
  // proven not to be in the way.
  const debug = await openPanel(page, /^Debug$/);
  await expect(debug).toBeVisible();

  // 1. The middle of the map belongs to the canvas. This is the assertion a panel floating over
  //    the game fails: the box is inside the window, and it is on top of the map.
  const canvas = await canvasBox(page);
  const mapCentre = centreOf(canvas);
  expect(
    await elementAt(page, mapCentre),
    'something covers the middle of the map while a panel is open',
  ).toBe('CANVAS');

  // 2. The map actually receives the pointer: its description names the tile under the cursor.
  await page.mouse.move(mapCentre.x, mapCentre.y);
  await expect(page.getByRole('application', { name: 'Map' }).locator('canvas')).toHaveAttribute(
    'aria-description',
    /pointer over tile \d+,\d+/,
  );

  // 3. The wheel is the zoom gesture, and it still reaches the map. A panel over the map swallows
  //    it and the camera does not move — which is exactly how the floating layout was caught.
  const beforeZoom = await cameraOf(page);
  const zoomed = await zoomTo(page, 1, 1);
  expect(
    zoomed.zoomNumerator,
    'the wheel over the map did not zoom while a panel was open',
  ).not.toBe(beforeZoom.zoomNumerator);

  // 4. The panel column is operable: the shell's turn control works with a panel up...
  const beforeTurn = await readState(page);
  await endTurnButton(page).click();
  expect((await readState(page)).turn, 'End turn did not advance the game').toBe(
    beforeTurn.turn + 1,
  );

  // ... and so does a unit order, issued from the group beside the panel.
  const city = await foundCity(page);
  expect(city.owner, 'founding a city through the panel column produced a foreign city').toBe(
    humanPlayerId(await readState(page)),
  );

  // 5. And a second panel opened beside the first is still fully visible: they share the dock.
  const tech = await openPanel(page, /^Technology$/);
  await expectFullyVisible('the Technology panel beside the Debug panel', tech);
  await expectFullyVisible('the Debug panel beside the Technology panel', debug);
  await closeDialogs(page);
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
