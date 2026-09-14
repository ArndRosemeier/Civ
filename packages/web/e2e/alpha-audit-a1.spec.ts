/**
 * **O4 — the alpha audit's A1 driver.**
 *
 * `PLAN.md` §16.1 A1: *"A human can start a new game from the web UI, choose settings, and play to a
 * victory/defeat screen **without touching the CLI**"*. This file is the auditor's own attempt to
 * falsify that claim against the running app, and it is deliberately **not** a copy of
 * `m9-m10-ui.spec.ts`'s victory test, which reaches the ending by dispatching most of the game
 * through the frozen test seam. Three differences, each of which is the point:
 *
 * 1. **Every turn is ended by CLICKING the app's own `End turn` control.** The seam's `dispatch` is
 *    used only to *read* state, never to play. A criterion that says "a human can play it" is not
 *    evidenced by a test that plays it through a JavaScript API.
 * 2. **The page starts from a clean browser state** (`localStorage` cleared before the first
 *    navigation), so this is the game a first-time visitor gets — not a game a test seeded. The one
 *    thing this file changes about it, it changes through the visitor's own `New game` control: the
 *    opponent is switched off (see item 3).
 * 3. **The opponent is held still, and the reason is recorded here.** A1's own gate
 *    (`s2-a1-conformance.spec.ts` §6) measures the live opponent; this audit measures something
 *    else — that a human can click a game all the way to its ending screen — and with a real
 *    policy playing the rival seat the audit's own game ends at turn 51 by a victory condition
 *    instead of at the catalog's score horizon, which is a different claim, not a weaker one. So
 *    the opponent is switched off through the app's `New game` control
 *    (`startSameGameWithoutOpponent`), and the audit still records whether the rival
 *    civilization's board changed while the human played — which, with the switch off, is the
 *    evidence that the switch is the thing that holds it still.
 *
 * The adversarial half of A1 lives here too: after the ending, the file walks the page looking for a
 * state the UI cannot escape — a dialog that will not close, a control that stays enabled over a
 * finished game, and any control at all that would let a player start a *different* game or choose a
 * setting. Findings that are gaps rather than failures are attached as test annotations (which the
 * `list` reporter prints) rather than asserted red, because the audit's job is to report, not to
 * change the gate: **a fabricated finding is worse than an empty report**, and so is a red suite that
 * says "the feature is missing" where the honest answer is "this is what alpha does not have".
 *
 * Run it alone (it starts the real app on 127.0.0.1:4174; port 3080 is never touched):
 *
 * ```
 * pnpm --filter @civts/web exec playwright test --config playwright.config.ts alpha-audit-a1
 * ```
 */

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import {
  clearDispatchLog,
  closeDialogs,
  dispatchLog,
  endTurnButton,
  foundCity,
  humanPlayerId,
  openApp,
  readSettings,
  readState,
  recordDispatches,
  stateHash,
  type UiState,
} from './helpers.js';

const ARTIFACTS = fileURLToPath(new URL('../artifacts/alpha-audit', import.meta.url));

/** The turn limit the catalog's score condition uses; the game must end at or before it. */
const SCORE_HORIZON = 200;

/** What the outcome dialog says, read from the DOM the way a player reads it. */
interface OutcomeReadout {
  readonly headline: string;
  readonly detail: string;
  readonly turn: number;
  readonly revision: number;
  readonly hash: string;
}

/**
 * A path inside `artifacts/alpha-audit/`.
 *
 * A function rather than a string concatenation at each call site: `ARTIFACTS` has no trailing
 * separator (it comes from `fileURLToPath`), and the first version of this file wrote four PNGs
 * called `alpha-audit01-clean-load.png` beside the directory instead of inside it. The directory and
 * the four files were the evidence trail; the join is one place so it cannot happen twice.
 */
const shot = (name: string): string => `${ARTIFACTS}/${name}`;

const readOutcome = async (page: Page): Promise<OutcomeReadout> => {
  const dialog = page.getByRole('dialog', { name: 'Game over' });
  const headline = ((await dialog.locator('h2').textContent()) ?? '').trim();
  const detail = await dialog.locator('p').innerText();
  const state = await readState(page);
  return {
    headline,
    detail,
    turn: state.turn,
    revision: state.revision,
    hash: await stateHash(page),
  };
};

/** The board of one seat, reduced to the facts "did this seat do anything at all?" needs. */
interface SeatFingerprint {
  readonly cities: number;
  readonly units: number;
  readonly unitTilesSorted: string;
  readonly treasury: number;
  readonly techs: number;
}

const fingerprint = (state: UiState, owner: number): SeatFingerprint => {
  const units = state.units.filter((unit) => unit.owner === owner);
  const player = state.players.find((candidate) => candidate.id === owner);
  return {
    cities: state.cities.filter((city) => city.owner === owner).length,
    units: units.length,
    unitTilesSorted: units
      .map((unit) => `${String(unit.id)}@${String(unit.tile)}`)
      .sort()
      .join(','),
    treasury: player?.treasury ?? -1,
    techs: player?.techs.length ?? -1,
  };
};

/** Every interactive control the page offers, by accessible name — the UI's whole surface. */
const controlNames = async (page: Page): Promise<readonly string[]> => {
  const names: string[] = [];
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible())) continue;
    names.push((await button.innerText()).trim());
  }
  return names;
};

/**
 * Start the SAME game with the opponent switched off, by clicking the app's own New game surface.
 *
 * ## Why this audit holds the opponent still, and why it does it by clicking
 *
 * The app now plays a real policy for every non-human seat on each turn advance
 * (`src/main.ts`'s `playOpponentSeats`: `SMART_POLICY`). This audit plays its game by clicking
 * `End turn` and nothing else, so with the opponent live the rival plays a real game against a
 * human who never moves a unit: measured on this very test, the game ends at **turn 51** by a
 * victory condition rather than at the catalog's score horizon, and the assertion below — the one
 * A1 needs, that the UI can play a game all the way to an ending screen — cannot hold. That ending
 * is a legitimate result of a live opponent; it is simply a different claim from the one this file
 * makes, and it is measured where it belongs: `s2-a1-conformance.spec.ts` §6, which plays a real
 * game to its end against a live opponent, and `e2e/t2-probe.ts`. So the opponent is held still
 * here — and it is held still **through the app's own control**, not by seeding a game through the
 * test seam, because this file's second claim is that it plays the game a first-time visitor gets
 * and not a game a test seeded (`window.__CIVTS__.seed` never touches this test).
 *
 * That control exists because A1 also asks for it: `PLAN.md` §16.1 A1 is *"a human can start a new
 * game from the web UI, choose settings"*, and the setting this clicks is `ai.opponent` — the
 * engine's own field (`packages/core/src/settings.ts`), carried in `state.settings` and therefore
 * visible in the hashed state of the game that follows.
 *
 * It is deliberately the same game: the form is filled in with the seed the clean load is already
 * playing, so the only thing that changes between the visitor's opening game and the audited one is
 * the opponent. The seed equivalence is asserted by the caller rather than assumed here.
 */
const startSameGameWithoutOpponent = async (page: Page, seed: number): Promise<void> => {
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New game' });
  await expect(dialog, 'the New game control opened no New game dialog').toBeVisible();

  const seedField = dialog.getByRole('spinbutton', { name: 'Seed' });
  await seedField.fill(String(seed));
  const opponent = dialog.getByRole('checkbox', { name: 'Opponent' });
  await expect(
    opponent,
    'the New game dialog offers no Opponent control, so a player cannot hold the opponent still',
  ).toBeVisible();
  await opponent.uncheck();
  await dialog.getByRole('button', { name: 'Start new game' }).click();
  await expect(dialog).toBeHidden();
};

test('A1 audit: a clean browser session is played to an outcome screen by clicking, and the rival seat is measured', async ({
  page,
}) => {
  test.setTimeout(900_000);
  mkdirSync(ARTIFACTS, { recursive: true });

  // A first-time visitor: no save, no residue. `addInitScript` runs before the app's first frame.
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await openApp(page);

  // The clean-load game, and then the same game with the opponent switched off — through the app's
  // own New game control, because this file audits the game a player can actually start. See
  // `startSameGameWithoutOpponent` for why the opponent is held still and what measures it instead.
  const cleanLoad = await readState(page);
  await startSameGameWithoutOpponent(page, cleanLoad.seed);

  const start = await readState(page);
  expect(
    start.seed,
    'the audited game is not the clean load’s own game with the opponent switched off',
  ).toBe(cleanLoad.seed);
  const human = humanPlayerId(start);
  const rival = start.players.find((candidate) => candidate.id !== human);
  const settings = await readSettings(page);
  const startHuman = fingerprint(start, human);
  const startRival = rival === undefined ? undefined : fingerprint(start, rival.id);

  test.info().annotations.push({
    type: 'A1 seed',
    description: `clean load started seed=${String(start.seed)} turn=${String(start.turn)} settings=${JSON.stringify(settings)}`,
  });

  await page.screenshot({ path: shot('01-clean-load.png') });

  // The control surface of a FRESH page, before anything has been played. "There is no settings
  // control" has to be true here and not only at the end of a game: a setup screen would live at
  // the start, if it lived anywhere.
  const atStart = await controlNames(page);
  test.info().annotations.push({
    type: 'A1 control surface (fresh page)',
    description: `buttons on a clean load: ${atStart.join(' | ')}`,
  });

  // A real game: found a city through the app's own settler control, the way a player starts.
  await foundCity(page);
  await closeDialogs(page);
  await page.screenshot({ path: shot('02-first-city.png') });

  // **Play by clicking.** The only stop condition is the app's own End turn control closing, which
  // is the UI's report that the engine has finished the game.
  let clicks = 0;
  const deadline = Date.now() + 840_000;
  while (!(await endTurnButton(page).isDisabled())) {
    await endTurnButton(page).click();
    clicks += 1;
    if (Date.now() > deadline) {
      throw new Error(
        `the End turn control was still enabled after ${String(clicks)} clicks and 840 s of wall ` +
          `time — this is a dead end, and it is the exact input A1 needs`,
      );
    }
    if (clicks > SCORE_HORIZON + 60) {
      throw new Error(
        `ended ${String(clicks)} turns and the game has not finished; the catalog's score horizon ` +
          `is ${String(SCORE_HORIZON)}, so this is a game the UI cannot finish`,
      );
    }
  }

  const end = await readState(page);
  const outcome = await readOutcome(page);
  await page.screenshot({ path: shot('03-outcome.png') });

  const endHuman = fingerprint(end, human);
  const endRival = rival === undefined ? undefined : fingerprint(end, rival.id);

  test.info().annotations.push({
    type: 'A1 result',
    description:
      `clicks=${String(clicks)} turn=${String(outcome.turn)} headline=${outcome.headline} ` +
      `detail="${outcome.detail}" hash=${outcome.hash} revision=${String(outcome.revision)}`,
  });
  test.info().annotations.push({
    type: 'A1 rival seat',
    description:
      `rival=${JSON.stringify(rival?.name ?? 'none')} at start=${JSON.stringify(startRival)} ` +
      `at end=${JSON.stringify(endRival)} humanStart=${JSON.stringify(startHuman)} ` +
      `humanEnd=${JSON.stringify(endHuman)}`,
  });

  // The claims the criterion actually makes, in the order it makes them.
  await expect(page.getByRole('dialog', { name: 'Game over' })).toBeVisible();
  expect(['victory', 'defeat', 'draw']).toContain(outcome.headline.toLowerCase());
  expect(outcome.detail, 'the screen does not name the engine’s condition').toContain('"');
  expect(end.turn, 'the game did not reach the catalog’s score horizon').toBeGreaterThanOrEqual(
    SCORE_HORIZON,
  );

  // ---- A1, adversarially: can the player be trapped, and what is unreachable? ----------------

  const atEnd = await controlNames(page);

  // 1. The ending screen must be closable and re-openable; a modal a player cannot leave is the
  //    dead end A1's second half asks about.
  await page.getByRole('button', { name: 'Close outcome' }).click();
  await expect(page.getByRole('dialog', { name: 'Game over' })).toBeHidden();
  await page.getByRole('button', { name: 'Show outcome' }).click();
  await expect(page.getByRole('dialog', { name: 'Game over' })).toBeVisible();

  // 2. Every other panel must open and close at the end of the game, and the app must stay usable
  //    while they are all open at once — the dock layout's whole purpose.
  for (const pattern of [/^Technology$/, /^Debug$/, /^City /]) {
    const opener = page.getByRole('button', { name: pattern }).first();
    if ((await opener.count()) === 0) continue;
    await opener.click();
  }
  await page.screenshot({ path: shot('04-all-panels-open-at-the-end.png') });
  await closeDialogs(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 3. Nothing may offer a command over a finished game. `End turn` is the engine's one no-op and
  //    the UI keeps it disabled anyway; a control that dispatches a command the engine would ACCEPT
  //    must not exist. The claim is about *accepted dispatches*, not about enablement: a panel
  //    opener or a unit selector is legitimately still live over a finished board, and a name-based
  //    filter would confuse the two. So the seam's `dispatch` is instrumented, every enabled control
  //    is clicked, and anything it dispatched has to come back `refused`.
  await expect(endTurnButton(page)).toBeDisabled();
  const armed = await recordDispatches(page);
  expect(armed, 'the audit could not instrument the seam, so this probe proves nothing').toBe(true);
  const accepted: string[] = [];
  const panelOpeners: string[] = [];
  for (const name of await controlNames(page)) {
    if (/^(Show outcome|Close outcome|Save game|Load game|Close)/.test(name)) continue;
    const button = page.getByRole('button', { name, exact: true }).first();
    if ((await button.count()) === 0) continue;
    if (!(await button.isEnabled())) continue;
    await clearDispatchLog(page);
    const before = (await readState(page)).revision;
    await button.click();
    const dialogs = await page.getByRole('dialog').count();
    if (dialogs > 0) {
      panelOpeners.push(name);
      await closeDialogs(page);
      continue;
    }
    const dispatched = await dispatchLog(page);
    const after = (await readState(page)).revision;
    if (after !== before)
      accepted.push(`${name} changed revision ${String(before)} → ${String(after)}`);
    for (const entry of dispatched) {
      if (entry.result === 'ok')
        accepted.push(`${name} dispatched ${JSON.stringify(entry.action)} → ok`);
    }
  }
  test.info().annotations.push({
    type: 'A1 adversarial — controls live over a finished game',
    description:
      panelOpeners.length === 0
        ? 'none (every enabled control was disabled)'
        : `panel openers / selectors, which dispatch nothing: ${panelOpeners.join(' | ')}`,
  });

  // 4. **The terminal state itself.** A game that has ended is the one place a player has nowhere
  //    left to go, and A1's second half is exactly this question. After the ending the engine
  //    refuses every command but `EndTurn`, so the honest probe is what a player can still do:
  //    everything except look at the board and the panels.
  await clearDispatchLog(page);
  const afterEnd = await readState(page);
  const restart = atEnd.filter((name) =>
    /new game|settings|seed|map size|restart|difficulty|options|civ count|rematch/i.test(name),
  );
  test.info().annotations.push({
    type: 'A1 adversarial — the terminal state',
    description:
      `at turn ${String(afterEnd.turn)} the page offers ${String(atEnd.length)} buttons and ` +
      `${String(restart.length)} of them can start another game. ` +
      (restart.length === 0
        ? 'A finished game is terminal: the only ways out are a page reload (which restarts seed 1 ' +
          'with the same settings) or the test seam. That is the UI dead end A1 asks about — not a ' +
          'modal trap, but a game with no next game.'
        : `restart controls: ${restart.join(' | ')}`),
  });

  // 5. **Is there any way to start a different game or choose a setting?** This is the half of A1
  //    that the rest of the suite never asks about, and the answer is recorded rather than assumed.
  //    Both surfaces are tested: a setup screen would live at the START of a session, if anywhere.
  const setUpName = /new game|settings|seed|map size|restart|difficulty|options|civ count/i;
  const gameStarting = [...atStart, ...atEnd].filter((name) => setUpName.test(name));
  test.info().annotations.push({
    type: 'A1 control surface',
    description: `buttons at the end of the game: ${atEnd.join(' | ')}`,
  });
  test.info().annotations.push({
    type: 'A1 finding — settings / new game',
    description:
      gameStarting.length === 0
        ? `NO control starts a new game and NO control chooses any setting (seed, map size, civ count, ` +
          `difficulty): ${String(atStart.length)} buttons on a clean load and ${String(atEnd.length)} ` +
          `at the end of a game, and not one of them is game setup. The only way to change any of them ` +
          `is the test seam window.__CIVTS__.seed(seed, options). A1 says "start a new game from the ` +
          `web UI, choose settings" — this half is NOT met by the UI.`
        : `controls that look like game setup: ${gameStarting.join(' | ')}`,
  });
  expect(
    accepted,
    'a control over a finished game dispatched something the engine ACCEPTED, so the ending screen ' +
      'is not the end of the game',
  ).toEqual([]);
});
