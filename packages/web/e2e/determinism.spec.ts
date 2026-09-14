/**
 * W3 — "the UI adds no rules", proven by hash equality.
 * See docs/INTERFACES.md, M8 ("Determinism at the UI layer"):
 *
 * > A fixed seed plus a fixed script of dispatched actions must produce the same
 * > `stateHash()` as the same script run headless through the engine — that
 * > equality is the proof the UI added no rules.
 *
 * The proof is arranged so that neither half can be self-serving:
 *
 * - The script is not written by hand. It is whatever the app actually dispatched,
 *   recorded from the seam's own `dispatch` wrapper as the game is played, so the
 *   browsers's run is the thing being tested and not a description of it.
 * - The second run is the real engine in this process — `newGame` on the shipped,
 *   validated catalog with the state's own settings, then `applyCommand` for every
 *   recorded command — and it is compared by the engine's own `hashValue`.
 * - Some of the script is produced by clicking the app's real `End turn` button
 *   rather than by calling `dispatch`, so the round includes the path a human takes.
 */

import { expect, test, type Page } from '@playwright/test';

import { CATALOG } from '@civts/rules';

import {
  actionType,
  actionsFor,
  clearDispatchLog,
  dispatch,
  dispatchLog,
  drawCount,
  endTurnButton,
  hashOf,
  headlessNewGame,
  humanPlayerId,
  humanPlayer,
  OPPONENT_OFF,
  openApp,
  readState,
  recordDispatches,
  replayScript,
  seedApp,
  settingsFrom,
  stateHash,
  unitsOf,
} from './helpers.js';

const SEED = 20260101;

/** How many recorded commands the script runs to. */
const SCRIPT_LENGTH = 30;

/**
 * One step of the script, chosen from the engine's own lists by a rule that depends only on the
 * state — never on a clock, a random number or the order a control happens to be rendered in.
 * The rule's only job is to produce a varied game; the equality being proven does not depend on
 * which commands it picks.
 */
const chooseStep = async (page: Page, step: number): Promise<unknown> => {
  const state = await readState(page);

  // Every fifth step (and the last) ends the turn, so production, growth, research and the
  // barbarian step all run inside the script.
  if (step % 5 === 4 || step === SCRIPT_LENGTH - 1) return 'end-turn';

  // A city's own options are a separate query — setting production is a content choice rather
  // than a member of a unit's action list.
  const city = state.cities[0];
  if (step === 1 && city !== undefined && city.production === undefined) {
    const options = await actionsFor(page, { cityId: city.id });
    if (options.length > 0) return options[0];
  }

  // Otherwise: the first legal action of the first unit that has one, in the engine's own order.
  for (const unit of unitsOf(state, humanPlayerId(state))) {
    const actions = await actionsFor(page, { unitId: unit.id });
    const notEndTurn = actions.filter((action) => actionType(action) !== 'EndTurn');
    if (notEndTurn.length > 0) return notEndTurn[0];
  }
  return 'end-turn';
};

test('determinism at the UI layer: a scripted game through the UI hashes exactly like the same script through the engine', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(page);
  // **The opponent is held still, on both sides of this comparison.** The headless half below is
  // `newGame` + `applyCommand` in this process and plays no policy for the rival seat; the browser
  // plays `SMART_POLICY` for every non-human seat whenever the turn advances (including the
  // `End turn` clicks this script makes). Left on, the two runs are different games and the hash
  // equality below would be comparing a game with an opponent against one without. The setting goes
  // into the SEEDED settings, so `settingsFrom(started.settings, seed)` hands the headless engine
  // the same object — settings are part of the hashed state. See `OPPONENT_OFF` in `helpers.ts`.
  const started = await seedApp(page, SEED, OPPONENT_OFF);
  const seed = started.seed;
  const settings = settingsFrom(started.settings, seed);

  expect(
    await recordDispatches(page),
    'the suite must record what the app dispatched, not describe it',
  ).toBe(true);
  await clearDispatchLog(page);

  const script: unknown[] = [];
  for (let step = 0; step < SCRIPT_LENGTH; step += 1) {
    if (step === 2) {
      // Research is a query rather than a member of the action list (docs/INTERFACES.md,
      // `actions.ts`): the first tech the engine accepts, in the ruleset's own order.
      // Refused probes are silent and do not enter the script.
      for (const tech of CATALOG.techs) {
        if ((await dispatch(page, { type: 'SetResearch', tech: tech.id })) === 'ok') break;
      }
    } else {
      const choice = await chooseStep(page, step);
      if (choice === 'end-turn') await endTurnButton(page).click();
      else {
        const answer = await dispatch(page, choice);
        expect(answer, `the chosen step ${JSON.stringify(choice)} was refused`).toBe('ok');
      }
    }

    const recorded = await dispatchLog(page);
    await clearDispatchLog(page);
    const accepted = recorded.filter((entry) => entry.result === 'ok');
    /*
     * **Exactly one command per step, and that is the check that keeps gotos out of this fixture.**
     *
     * A goto is UI intent (`packages/web/src/ui/goto.ts`): when one is pending, the app dispatches
     * steps of its own accord — between the commands this test chose, and between turns. Those
     * dispatches would land in the recorded script and be replayed headlessly, so the equality below
     * would still hold while proving something weaker than it claims: the script would no longer be
     * "the commands a chooser picked from the engine's own lists", it would be that *plus* a UI
     * planner. `docs/UI-OVERHAUL.md` §8 records this as the open debt of goto shape (b) and says the
     * fixtures must keep gotos out and say so here.
     *
     * They stay out by construction: nothing in this file ever clicks the **map**, and a goto can
     * only be started by a map click (`main.ts`, the far-tile branch). The assertion was
     * `toBeGreaterThan(0)` — "something was dispatched" — which would have let a UI-initiated step
     * through unnoticed. `toBe(1)` is the statement that this fixture contains only what the chooser
     * asked for, so if a future change makes the app dispatch anything else here, this fails and
     * names the step.
     */
    expect(
      accepted.length,
      `step ${String(step)} dispatched ${String(accepted.length)} commands (${JSON.stringify(
        accepted.map((entry) => entry.action),
      )}), and this fixture is supposed to contain exactly the one the chooser asked for`,
    ).toBe(1);
    for (const entry of accepted) script.push(entry.action);
  }

  expect(script.length, 'the script is empty, so the equality would be vacuous').toBeGreaterThan(0);

  const uiHash = await stateHash(page);
  const uiState = await readState(page);

  // The same script, through the real engine, in this process, with no browser.
  const headless = headlessNewGame(seed, settings);
  expect(headless.ok, 'the engine could not start the same game headlessly').toBe(true);
  if (!headless.ok) return;
  const replayed = replayScript(headless.value, humanPlayerId(uiState), script);
  const engineHash = hashOf(replayed);

  expect(
    engineHash,
    `the UI produced ${uiHash} after ${String(script.length)} commands, the engine ${engineHash}\n` +
      `script: ${JSON.stringify(script)}`,
  ).toBe(uiHash);

  // And the two runs agree about the game itself, not only about its hash: a hash
  // that collided on two different games would still be caught here.
  expect(replayed.turn).toBe(uiState.turn);
  expect(replayed.units.length).toBe(uiState.units.length);
  expect(replayed.cities.length).toBe(uiState.cities.length);
  expect(replayed.revision).toBe(uiState.revision);
});

test('determinism at the UI layer: the same seed and settings produce the same game on a reload', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  const firstHash = await stateHash(page);
  const firstState = await readState(page);

  // A reload throws away every scrap of in-memory UI state: whatever comes back is a
  // function of the seed and the settings alone. Nothing in the DOM, the camera or a
  // frame counter may leak into it.
  await page.reload();
  await seedApp(page, SEED);
  const secondHash = await stateHash(page);

  expect(secondHash).toBe(firstHash);
  expect((await readState(page)).seed).toBe(firstState.seed);
  expect((await readState(page)).turn).toBe(firstState.turn);

  // The human seat is the same player on both runs, painted the same colour.
  expect(humanPlayer(await readState(page)).color).toBe(humanPlayer(firstState).color);
});

test('determinism at the UI layer: the render counter only ever grows, and never feeds the simulation', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  const before = await readState(page);

  // Rendering repeatedly must not move the state at all: the frame counter is
  // presentation, and the simulation is untouched by how often it is drawn.
  const hashBefore = await stateHash(page);
  const revisionBefore = (await readState(page)).revision;
  const framesBefore = await drawCount(page);
  await page.mouse.move(10, 10);
  await page.mouse.move(410, 310);
  await page.mouse.move(10, 10);
  expect(await stateHash(page)).toBe(hashBefore);
  expect((await readState(page)).revision).toBe(revisionBefore);
  expect((await readState(page)).turn).toBe(before.turn);

  // The counter itself is monotonic and moves when the world does — never the other
  // way round.
  await endTurnButton(page).click();
  expect(await drawCount(page)).toBeGreaterThan(framesBefore);
  expect((await readState(page)).turn).toBe(before.turn + 1);
});
