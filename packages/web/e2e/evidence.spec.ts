/**
 * W3 — the acceptance evidence docs/INTERFACES.md asks for by name.
 *
 * See docs/INTERFACES.md, M8 ("Acceptance evidence"):
 *
 * > The app builds and serves on 127.0.0.1:4174; a screenshot of a played game is
 * > captured and Reviewed, and the runs are advisory evidence, never the primary
 * > assertion.
 *
 * The screenshot is the ADVISORY half of that sentence, so this file treats it as
 * such: a game is played through the UI's own controls, the resulting screen is
 * captured to `packages/web/artifacts/` and attached to the report, and the claim
 * that the picture is of a real game rests on the same hash equality the rest of the
 * suite uses — the browser's `stateHash()` against the engine replaying the same
 * commands. A screenshot whose game cannot be reproduced by hash is decoration.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { applyCommand, asPlayerId, cityProductionOptions, type GameState } from '@civts/core';

import {
  driveScript,
  hashOf,
  headlessNewGame,
  openApp,
  readState,
  replayScript,
  RULESET,
  seedApp,
  settingsFrom,
  stateHash,
} from './helpers.js';

const SEED = 31415;
const TURNS = 8;

/**
 * A game a player can actually play: found the first city, put the engine's own first
 * production option in it, and end a handful of turns.
 *
 * Every command is applied headlessly first and kept only if the engine accepts it, so
 * the script cannot contain a step the UI would refuse; `driveScript` then issues each
 * one through a real control and fails if the app's dispatch log disagrees.
 */
const playedScript = (
  state: GameState,
  player: ReturnType<typeof asPlayerId>,
): readonly unknown[] => {
  const script: unknown[] = [];
  let current = state;

  const settler = current.units.find(
    (unit) => unit.owner === player && unit.type.includes('settler'),
  );
  if (settler !== undefined) {
    const founded = applyCommand(
      current,
      player,
      { type: 'FoundCity', unitId: settler.id },
      RULESET,
    );
    if (founded.ok) {
      current = founded.value.state;
      script.push({ type: 'FoundCity', unitId: Number(settler.id) });
    }
  }

  const city = current.cities.find((candidate) => candidate.owner === player);
  const item = city === undefined ? undefined : cityProductionOptions(current, RULESET, city.id)[0];
  if (city !== undefined && item !== undefined) {
    const producing = applyCommand(
      current,
      player,
      { type: 'SetProduction', cityId: city.id, item },
      RULESET,
    );
    if (producing.ok) {
      current = producing.value.state;
      script.push({
        type: 'SetProduction',
        cityId: Number(city.id),
        item: { kind: item.kind, id: item.id },
      });
    }
  }

  for (let turn = 0; turn < TURNS; turn += 1) {
    const ended = applyCommand(current, player, { type: 'EndTurn' }, RULESET);
    if (!ended.ok) break;
    current = ended.value.state;
    script.push({ type: 'EndTurn' });
  }
  return script;
};

test('acceptance evidence: a game played through the UI is captured as a screenshot, at a hash the engine reproduces', async ({
  page,
}, testInfo) => {
  await openApp(page);
  const probe = await seedApp(page, SEED);
  const settings = settingsFrom(probe.settings, SEED);
  const started = headlessNewGame(SEED, settings);
  expect(started.ok, 'the engine could not start the evidence game').toBe(true);
  if (!started.ok) return;

  const player = asPlayerId(0);
  const script = playedScript(started.value, player);
  expect(script.length, 'the evidence game is too short to be evidence').toBeGreaterThan(TURNS);

  await seedApp(page, SEED);
  const steps = await driveScript(page, script);
  expect(steps).toBe(script.length);

  // The picture is of a game the engine can reproduce: same seed, same commands, same hash.
  const hash = await stateHash(page);
  expect(hash, 'the played game does not hash like the same script through the engine').toBe(
    hashOf(replayScript(started.value, player, script)),
  );

  const played = await readState(page);
  expect(played.turn).toBeGreaterThan(1);
  expect(played.cities.length, 'the evidence game founded no city').toBeGreaterThan(0);

  const shot = await page.screenshot({ fullPage: true });
  await testInfo.attach('played-game', { body: shot, contentType: 'image/png' });
  const target = resolve(import.meta.dirname, '..', 'artifacts', 'played-game.png');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, shot);

  testInfo.annotations.push({
    type: 'played game',
    description: `seed ${String(SEED)}, turn ${String(played.turn)}, ${String(
      played.cities.length,
    )} city/cities, stateHash ${hash} — screenshot at packages/web/artifacts/played-game.png`,
  });
});
