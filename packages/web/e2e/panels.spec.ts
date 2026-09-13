/**
 * W3 — A4's panels: turn/year, treasury/science/luxury, the event log, the scoreboard, the
 * city list and the unit region.
 * See docs/INTERFACES.md, M8 ("The accessibility contract", "A4 coverage").
 *
 * Every panel is found by ROLE and ACCESSIBLE NAME — the frozen table — and every number it
 * shows is compared with the ENGINE's own state, read through `window.__CIVTS__`. The one
 * exception is stated where it happens: the YEAR, which the engine does not have, is compared
 * against the presentation convention the UI documents for it (`formatYear`).
 */

import { expect, test } from '@playwright/test';

import { applyCommand } from '@civts/core';

import { formatYear } from '../src/panels/index.js';

import {
  cityList,
  endTurnButton,
  endTurns,
  eventLog,
  foundCity,
  headlessNewGame,
  humanPlayer,
  humanPlayerId,
  luxuryIndicator,
  openApp,
  replayScript,
  RULESET,
  settingsFrom,
  readState,
  scienceIndicator,
  scoreboard,
  seedApp,
  treasuryIndicator,
  turnIndicator,
  unitLabel,
  unitPanel,
  unitsOf,
  yearIndicator,
} from './helpers.js';

const SEED = 5150;

test('A4 turn indicator: Turn <n> is the engine’s own turn counter, before and after ending a turn', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  expect(state.turn).toBe(1);

  // The contract says the indicator's text CONTAINS `Turn <n>`.
  await expect(turnIndicator(page)).toBeVisible();
  await expect(turnIndicator(page)).toContainText(`Turn ${String(state.turn)}`);

  await endTurnButton(page).click();

  const after = await readState(page);
  expect(after.turn, 'ending a turn did not advance the engine').toBe(state.turn + 1);
  await expect(turnIndicator(page)).toContainText(`Turn ${String(after.turn)}`);
});

test('A4 year indicator: the year follows the turn counter and is reproducible, never a clock reading', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);

  await expect(yearIndicator(page)).toBeVisible();
  // The engine keeps no calendar, so the convention is the UI's own documented one — and the
  // indicator must be exactly it, not a second spelling of "the year".
  await expect(yearIndicator(page)).toContainText(formatYear(state.turn));
  await expect(yearIndicator(page)).toContainText('Year');
  const atStart = await yearIndicator(page).innerText();

  await endTurnButton(page).click();
  const after = await readState(page);
  await expect(yearIndicator(page)).toContainText(formatYear(after.turn));
  expect(formatYear(after.turn)).not.toBe(formatYear(state.turn));

  // Reproducible: a reload and a reseed of the same seed show the same year for the same turn,
  // so nothing in the indicator came from the wall clock.
  await page.reload();
  await seedApp(page, SEED);
  expect((await readState(page)).turn).toBe(state.turn);
  expect(await yearIndicator(page).innerText()).toBe(atStart);
});

test('A4 status strip: treasury, science and luxury are the acting player’s own state', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  const player = humanPlayer(state);

  await expect(treasuryIndicator(page)).toContainText(String(player.treasury));
  await expect(scienceIndicator(page)).toContainText(String(player.beakers));
  await expect(luxuryIndicator(page)).toContainText(String(player.luxuries));

  // A turn collects income, so the treasury either moves or the engine says it cannot: either
  // way the panel follows the state rather than the frame.
  await endTurnButton(page).click();
  const after = await readState(page);
  const next = humanPlayer(after);
  await expect(treasuryIndicator(page)).toContainText(String(next.treasury));
  await expect(scienceIndicator(page)).toContainText(String(next.beakers));
});

test('A4 event log: the log is the engine’s own story of the game', async ({ page }) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  await expect(eventLog(page)).toBeAttached();
  const linesAtStart = await eventLog(page).getByRole('listitem').count();
  expect(linesAtStart, 'a game that has just started already had events').toBe(0);

  // Founding a city is an engine event, and the log names it with the engine's own name.
  const city = await foundCity(page);
  const afterFounding = await eventLog(page).getByRole('listitem').count();
  expect(afterFounding, 'founding a city wrote nothing to the log').toBeGreaterThan(linesAtStart);
  expect(await eventLog(page).innerText()).toContain(city.name);

  // How many turns until the pipeline itself reports something? Asked of the engine, so the
  // assertion below is about a turn that really happened rather than about a quiet one.
  let turnsWithEvents = 0;
  const cursor = headlessNewGame(SEED, settingsFrom(state.settings, SEED));
  expect(cursor.ok).toBe(true);
  if (!cursor.ok) return;
  const settler = cursor.value.units.find((unit) => unit.type.includes('settler'));
  expect(settler, 'the human seat has no settler in this seed').toBeDefined();
  if (settler === undefined) return;
  let current = replayScript(cursor.value, humanPlayerId(state), [
    { type: 'FoundCity', unitId: Number(settler.id) },
  ]);
  for (let turn = 1; turn <= 15 && turnsWithEvents === 0; turn += 1) {
    const outcome = applyCommand(current, humanPlayerId(state), { type: 'EndTurn' }, RULESET);
    if (!outcome.ok) break;
    current = outcome.value.state;
    if (outcome.value.events.length > 0) turnsWithEvents = turn;
  }
  expect(turnsWithEvents, 'the turn pipeline reported no events in fifteen turns').toBeGreaterThan(
    0,
  );

  await endTurns(page, turnsWithEvents);
  const afterTurns = await eventLog(page).getByRole('listitem').count();
  expect(
    afterTurns,
    `the engine reported events over ${String(turnsWithEvents)} turns and the log grew by nothing`,
  ).toBeGreaterThan(afterFounding);
});

test('A4 scoreboard: one row per player, with the engine’s own counts', async ({ page }) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  const after = await readState(page);
  const owner = humanPlayerId(after);

  const table = scoreboard(page);
  await expect(table).toBeVisible();

  // Every player has a row — barbarians included, because the state gives them a treasury and
  // a row of explored flags rather than pretending they are not there.
  const rowsText = await table.locator('tbody tr').allInnerTexts();
  expect(rowsText.length).toBe(after.players.length);
  for (const player of after.players) {
    expect(rowsText.some((row) => row.includes(player.name))).toBe(true);
  }

  // The acting player's row carries the state's own figures: cities, units and population.
  const human = after.players.find((player) => player.id === owner);
  expect(human).toBeDefined();
  if (human === undefined) return;
  const humanRow = rowsText.find((row) => row.includes(human.name));
  expect(humanRow).toBeDefined();
  const cities = after.cities.filter((city) => city.owner === owner).length;
  const units = unitsOf(after, owner).length;
  const population = after.cities
    .filter((city) => city.owner === owner)
    .reduce((total, city) => total + city.population, 0);
  expect(humanRow).toContain(String(cities));
  expect(humanRow).toContain(String(units));
  expect(humanRow).toContain(String(population));
  expect(humanRow).toContain(String(human.treasury));
});

test('A4 city list: the Cities list names exactly the acting player’s cities', async ({ page }) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  const owner = humanPlayerId(state);

  const list = cityList(page);
  await expect(list).toBeAttached();
  expect(await list.getByRole('button').count(), 'a fresh game lists a city').toBe(0);

  const city = await foundCity(page);
  const after = await readState(page);
  const expected = after.cities.filter((candidate) => candidate.owner === owner).length;
  expect(expected).toBe(1);
  await expect(list.getByRole('button', { name: city.name, exact: true })).toBeVisible();
  expect(await list.getByRole('button').count()).toBe(expected);

  // A city the player does not own is not in the player's list.
  const foreign = after.cities.filter((candidate) => candidate.owner !== owner);
  for (const other of foreign) {
    await expect(list.getByRole('button', { name: other.name, exact: true })).toHaveCount(0);
  }
});

test('A4 unit panel: the Units region lists the acting player’s units, and only those', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  const owner = humanPlayerId(state);
  const mine = unitsOf(state, owner);

  const panel = unitPanel(page);
  await expect(panel).toBeVisible();
  expect(mine.length, 'the human seat starts with no units to list').toBeGreaterThan(0);

  for (const unit of mine) {
    await expect(
      panel.getByRole('button', { name: unitLabel(unit), exact: true }),
      `the Units region does not list ${unitLabel(unit)}`,
    ).toBeVisible();
  }

  const foreign = state.units.filter((unit) => unit.owner !== owner);
  const rows = await panel.getByRole('button').count();
  expect(rows, 'the Units region lists units that are not the player’s').toBe(mine.length);
  for (const unit of foreign) {
    await expect(panel.getByRole('button', { name: unitLabel(unit), exact: true })).toHaveCount(0);
  }
});

test('A4 panels keep up: every panel follows the state after a turn is ended through the control', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  await foundCity(page);
  await endTurns(page, 3);

  const state = await readState(page);
  await expect(turnIndicator(page)).toContainText(`Turn ${String(state.turn)}`);
  await expect(yearIndicator(page)).toContainText(formatYear(state.turn));
  const player = humanPlayer(state);
  await expect(treasuryIndicator(page)).toContainText(String(player.treasury));
  await expect(scienceIndicator(page)).toContainText(String(player.beakers));

  // The unit region still lists the units the engine has: a panel that stopped refreshing
  // after the first frame would fail here.
  const panel = unitPanel(page);
  for (const unit of unitsOf(state, humanPlayerId(state))) {
    await expect(panel.getByRole('button', { name: unitLabel(unit), exact: true })).toBeVisible();
  }
  expect(await panel.getByRole('button').count()).toBe(unitsOf(state, humanPlayerId(state)).length);
});
