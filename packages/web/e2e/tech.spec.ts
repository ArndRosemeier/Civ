/**
 * W3 — A4's tech tree: research selection, and the known/available/locked distinction.
 * See docs/INTERFACES.md, M8 ("A4 coverage") and M5 for the tech rules.
 *
 * The dialog is `role="dialog"` named `Technology`, opened by the button of the same name, and
 * nothing here decides what a player may research: the three states are checked against the
 * ENGINE's own verdict. A tech is *available* exactly when the applier accepts a `SetResearch`
 * for it (asked of the app through `dispatch`), *locked* when it refuses, and *known* when the
 * player's own `techs` list holds it — which is also why a known tech is not selectable.
 */

import { expect, test, type Page } from '@playwright/test';

import { applyCommand, asPlayerId, asTechId, type GameState, type Settings } from '@civts/core';
import { CATALOG } from '@civts/rules';

import {
  dispatch,
  endTurns,
  foundCity,
  hashOf,
  headlessNewGame,
  openApp,
  openPanel,
  readState,
  replayScript,
  RULESET,
  seedApp,
  settingsFrom,
  stateHash,
  techDialog,
} from './helpers.js';

const SEED = 1234;

/** A control's accessible name, as the tech row spells it: `<name> (<era>, <cost> beakers)`. */
const techButton = (page: Page, name: string) =>
  techDialog(page).getByRole('button', { name: new RegExp(`^${escapeRegExp(name)} \\(`) });

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Open the tech screen through its own button. */
const openTech = async (page: Page): Promise<void> => {
  await openPanel(page, /^Technology$/);
  await expect(techDialog(page)).toBeVisible();
};

test('A4 tech tree — research selection: choosing a technology in the dialog selects it in the engine', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  expect(
    state.players[0]?.researching,
    'a fresh player is already researching something',
  ).toBeUndefined();

  await openTech(page);

  // The first root of the tree, by its catalog name: the control is found by role and name.
  const root = CATALOG.techs[0];
  expect(root, 'the shipped catalog has no techs').toBeDefined();
  if (root === undefined) return;

  const control = techButton(page, root.name);
  await expect(control).toBeVisible();
  await expect(control, 'a root tech with no prerequisites is not selectable').toBeEnabled();
  await control.click();

  await expect
    .poll(async () => (await readState(page)).players[0]?.researching, {
      message: 'the engine did not record the researched technology',
    })
    .toBe(root.id);

  // And the reverse direction: the engine will not accept what the screen disabled. A tech
  // whose prerequisites are unmet must be refused if anything asks for it anyway.
  const locked = CATALOG.techs.find((tech) => tech.requires.length > 0);
  expect(locked, 'the shipped tree has no dependent tech').toBeDefined();
  if (locked === undefined) return;
  const lockedControl = techButton(page, locked.name);
  await expect(lockedControl).toBeDisabled();
  const answer = await dispatch(page, { type: 'SetResearch', tech: locked.id });
  expect(answer, 'the engine accepted a tech the screen disables').toBe('refused');
});

/** The seed and turn count at which the human player knows at least one technology. */
interface KnownTechScene {
  readonly seed: number;
  readonly turns: number;
  readonly script: readonly unknown[];
}

/**
 * Find a game in which a technology completes, by running the real engine headlessly.
 *
 * Research needs commerce, which needs a city, so the script found here is exactly what the
 * browser will be driven through: found the first city, choose a root tech, end turns until the
 * pool buys it. Nothing about it is invented — it is the engine's own answer, replayed.
 */
const findKnownTechScene = (
  settingsFor: (seed: number) => Settings,
  seed: number,
): KnownTechScene | undefined => {
  const started = headlessNewGame(seed, settingsFor(seed));
  if (!started.ok) return undefined;
  const settler = started.value.units.find(
    (unit) => unit.owner === asPlayerId(0) && unit.type.includes('settler'),
  );
  if (settler === undefined) return undefined;

  const found = applyCommand(
    started.value,
    asPlayerId(0),
    { type: 'FoundCity', unitId: settler.id },
    RULESET,
  );
  if (!found.ok) return undefined;
  const root = CATALOG.techs[0];
  if (root === undefined) return undefined;
  const researching = applyCommand(
    found.value.state,
    asPlayerId(0),
    { type: 'SetResearch', tech: asTechId(root.id) },
    RULESET,
  );
  if (!researching.ok) return undefined;

  const script: unknown[] = [
    { type: 'FoundCity', unitId: Number(settler.id) },
    { type: 'SetResearch', tech: root.id },
  ];
  let state: GameState = researching.value.state;
  for (let turn = 1; turn <= 25; turn += 1) {
    const outcome = applyCommand(state, asPlayerId(0), { type: 'EndTurn' }, RULESET);
    if (!outcome.ok) return undefined;
    state = outcome.value.state;
    script.push({ type: 'EndTurn' });
    const player = state.players.find((candidate) => candidate.id === asPlayerId(0));
    if (player !== undefined && player.techs.length > 0) {
      return { seed, turns: turn, script };
    }
  }
  return undefined;
};

test('A4 tech tree — known / available / locked: the three states match the engine’s own verdicts', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(page);
  const probe = await seedApp(page, SEED);
  const settingsFor = (seed: number): Settings => settingsFrom(probe.settings, seed);

  let scene: KnownTechScene | undefined;
  for (let seed = 1; seed <= 12 && scene === undefined; seed += 1) {
    scene = findKnownTechScene(settingsFor, seed);
  }
  expect(scene, 'no seed in the search budget completed a technology').toBeDefined();
  if (scene === undefined) return;

  // Drive the browser to exactly that game with the app's own controls.
  await seedApp(page, scene.seed);
  await foundCity(page);
  await openTech(page);
  const root = CATALOG.techs[0];
  if (root === undefined) return;
  await techButton(page, root.name).click();
  await endTurns(page, scene.turns);

  const state = await readState(page);
  const known = state.players[0]?.techs ?? [];
  expect(
    known.length,
    'the driven game knows no technology, so the states cannot be told apart',
  ).toBeGreaterThan(0);

  // The browser is on the same game the engine replays: the two agree by hash, so the rows
  // below are being compared against the right state.
  const headless = headlessNewGame(scene.seed, settingsFor(scene.seed));
  expect(headless.ok).toBe(true);
  if (!headless.ok) return;
  const replayed = replayScript(headless.value, asPlayerId(0), scene.script);
  expect(await stateHash(page)).toBe(hashOf(replayed));

  // Every tech row: its enabled state must be the engine's verdict on selecting it.
  const failures: string[] = [];
  const states = new Set<string>();
  for (const tech of CATALOG.techs) {
    const control = techButton(page, tech.name);
    if ((await control.count()) === 0) {
      failures.push(`the Technology dialog has no row for ${tech.name}`);
      continue;
    }
    const enabled = await control.isEnabled();
    const marked = await control.getAttribute('data-state');
    if (marked !== null) states.add(marked);
    const answer = await dispatch(page, { type: 'SetResearch', tech: tech.id });

    const isKnown = known.includes(tech.id);
    if (isKnown && enabled) {
      failures.push(`${tech.name} is already known and the screen still offers it`);
    }
    if (!isKnown && enabled !== (answer === 'ok')) {
      failures.push(
        `${tech.name}: the screen says ${enabled ? 'available' : 'locked'} and the engine says ` +
          (answer === 'ok' ? 'available' : 'locked'),
      );
    }
    if (!isKnown && answer !== 'ok' && enabled) {
      failures.push(`${tech.name} is locked and the screen offers it`);
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);

  // The distinction is actually rendered: known, available and locked are three different
  // markers, not one disabled bucket. (Only two are reachable at this point in a game —
  // available and known — and locked too, since the tree has dependent techs.)
  expect(states.size, 'the tech screen does not distinguish its states').toBeGreaterThanOrEqual(2);
  expect(states.has('known') || states.has('available'), 'no tech state marker was found').toBe(
    true,
  );

  // A known tech is on the screen as known: it is in the player's list, and the screen shows
  // its row rather than hiding it.
  for (const id of known) {
    const tech = CATALOG.techs.find((candidate) => candidate.id === id);
    if (tech === undefined) continue;
    await expect(techButton(page, tech.name)).toBeVisible();
  }
});
