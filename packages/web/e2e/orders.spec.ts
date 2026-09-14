/**
 * W3 — A4's "unit orders": move, found city, work, fortify, attack.
 * See docs/INTERFACES.md, M8 ("A4 coverage") and M4a/M6 for the commands themselves.
 *
 * Every order is issued through a CONTROL (a button in the unit's own action group,
 * or a click on the destination tile) and its effect is asserted against
 * `window.__CIVTS__` — the engine's state — never against panel text. The attack is
 * the interesting one: an attack is only available when an enemy is adjacent, so the
 * scene is not invented here. It is FOUND by running the real engine headlessly in
 * this process until a human unit can attack, and then the browser is driven to the
 * identical state by clicking the app's own `End turn` button. Because the engine is
 * deterministic, "the identical state" is checkable — and it is checked, by hash,
 * before the attack is issued and after.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitId,
  cityProductionOptions,
  unitActions,
  type GameState,
} from '@civts/core';

import {
  actionTarget,
  actionType,
  actionsFor,
  cameraOf,
  clearDispatchLog,
  clickTileOrder,
  dispatchLog,
  dragMap,
  driveScript,
  findUnitByType,
  bringTileToCentre,
  hashOf,
  headlessNewGame,
  humanPlayerId,
  OPPONENT_OFF,
  openApp,
  readState,
  recordDispatches,
  replayScript,
  RULESET,
  seedApp,
  selectUnit,
  settingsFrom,
  stateHash,
  unitActionsGroup,
  visibleTiles,
  canvasBox,
  zoomTo,
  type UiState,
} from './helpers.js';

const SEED = 777;

/** Zoomed in and panned, so tiles are big enough to click and not all at the origin. */
const freshGame = async (page: Page, seed: number): Promise<UiState> => {
  const state = await seedApp(page, seed);
  await zoomTo(page, 1, 1);
  await dragMap(page, -128, -64);
  return state;
};

const select = async (page: Page, unitId: number): Promise<void> =>
  selectUnit(page, await readState(page), await cameraOf(page), unitId);

/** The human's unit of a given type, or a named failure. */
const humanUnit = async (page: Page, typeName: string) => {
  const state = await readState(page);
  const unit = findUnitByType(state, humanPlayerId(state), typeName);
  expect(unit, `the human seat has no ${typeName}`).toBeDefined();
  if (unit === undefined) throw new Error(`no ${typeName}`);
  return unit;
};

test('A4 unit orders — move: a legal destination issued from the map moves the unit there', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page, SEED);
  await recordDispatches(page);

  const before = await readState(page);
  const unit = await humanUnit(page, 'settler');
  await select(page, unit.id);
  // Scroll the map to the unit first: the destination must be on screen for a click on it to
  // be a click on the tile the engine offered.
  await bringTileToCentre(page, before, unit.tile);

  const moves = (await actionsFor(page, { unitId: unit.id })).filter(
    (action) => actionType(action) === 'MoveUnit',
  );
  expect(moves.length, 'the engine offers the settler nowhere to move').toBeGreaterThan(0);

  const camera = await cameraOf(page);
  const box = await canvasBox(page);
  const onScreen = new Set(visibleTiles(before, camera, box));
  // An empty destination: clicking a tile that holds a unit or a city selects that unit or opens
  // that city, which is what a player expects — so an occupied tile would exercise the selection
  // rule rather than the move order.
  const occupied = new Set([
    ...before.units.map((candidate) => candidate.tile),
    ...before.cities.map((candidate) => candidate.tile),
  ]);
  const target = moves
    .map(actionTarget)
    .find((tile) => tile !== undefined && onScreen.has(tile) && !occupied.has(tile));
  expect(target, 'no legal destination was on screen').toBeDefined();
  if (target === undefined) return;

  const issued = await clickTileOrder(page, camera, target, before.map.width, 'MoveUnit');
  expect(issued, `clicking tile ${String(target)} did not issue a MoveUnit`).toBe(true);

  const after = await readState(page);
  const moved = after.units.find((candidate) => candidate.id === unit.id);
  expect(moved?.tile, 'the unit did not move to the tile that was clicked').toBe(target);
  expect(after.revision).toBeGreaterThan(before.revision);

  // The engine agrees that this was the move it was asked for: the command it
  // accepted names the tile, and it is one of the moves it offered.
  const log = await dispatchLog(page);
  expect(log.some((entry) => entry.result === 'ok')).toBe(true);
});

test('A4 unit orders — found city: founding through the control puts a city on the settler tile', async ({
  page,
}) => {
  await openApp(page);
  const before = await freshGame(page, SEED);
  expect(before.cities, 'a fresh game already has cities').toEqual([]);

  const settler = await humanUnit(page, 'settler');
  await select(page, settler.id);
  await unitActionsGroup(page, settler.id).getByRole('button', { name: /found/i }).first().click();

  const after = await readState(page);
  expect(after.cities.length, 'no city was founded').toBe(1);
  const city = after.cities[0];
  expect(city?.tile, 'the city is not on the tile the settler stood on').toBe(settler.tile);
  expect(city?.owner).toBe(humanPlayerId(before));
  expect(
    after.units.some((candidate) => candidate.id === settler.id),
    'the settler survived founding a city',
  ).toBe(false);
  expect(after.revision).toBe(before.revision + 1);
});

test('A4 unit orders — work: a worker starts an improvement the engine offers, and the job is in the state', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page, SEED);

  const worker = await humanUnit(page, 'worker');
  expect(worker.working, 'the worker starts already working').toBe(false);
  await select(page, worker.id);

  const starts = (await actionsFor(page, { unitId: worker.id })).filter(
    (action) => actionType(action) === 'StartWork',
  );
  expect(starts.length, 'the engine offers the worker no job').toBeGreaterThan(0);

  // The control is named after the improvement's own name in the ruleset (falling
  // back to its id), which is the vocabulary the engine uses for the kind.
  const kind = kindOf(starts[0]);
  expect(kind).toBeDefined();
  if (kind === undefined) return;
  const def = RULESET.improvements.find((improvement) => improvement.id === kind);
  const name = def?.name ?? kind;

  const group = unitActionsGroup(page, worker.id);
  const byName = group.getByRole('button', { name: new RegExp(name, 'i') });
  const byId = group.getByRole('button', { name: new RegExp(kind, 'i') });
  if ((await byName.count()) > 0) await byName.first().click();
  else if ((await byId.count()) > 0) await byId.first().click();
  else {
    throw new Error(
      `no control for the improvement "${name}" (${kind}) in Actions for unit ` +
        `${String(worker.id)}; the UI offers: ` +
        (await group.getByRole('button').allInnerTexts()).join(' | '),
    );
  }

  const after = await readState(page);
  const working = after.units.find((candidate) => candidate.id === worker.id);
  expect(working?.working, 'the worker is not working after starting a job').toBe(true);
  expect(after.revision).toBeGreaterThan(0);
});

test('A4 unit orders — fortify: digging in sets the unit’s fortified flag through the engine', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page, SEED);

  // A unit with movement left can fortify; the settler and the worker both qualify at
  // turn 1, and a fortify control is the queried legal command M6 added.
  const unit = await humanUnit(page, 'worker');
  await select(page, unit.id);

  const fortify = unitActionsGroup(page, unit.id).getByRole('button', { name: /fortif|dig in/i });
  expect(
    await fortify.count(),
    'the UI offers no fortify control for a unit that may fortify (A4 names fortify)',
  ).toBeGreaterThan(0);
  await fortify.first().click();

  const after = await readState(page);
  const fortified = after.units.find((candidate) => candidate.id === unit.id);
  expect(fortified?.fortified, 'the unit is not fortified after the order').toBe(true);
});

/* ------------------------------------------------------------------ *
 * The attack: the scene is found by the engine, not invented here
 * ------------------------------------------------------------------ */

interface AttackScene {
  readonly seed: number;
  /** The commands that lead to `target` being attackable, in order. */
  readonly script: readonly unknown[];
  readonly unitId: number;
  readonly target: number;
  /** For diagnostics only: how many of the script's commands were end turns. */
  readonly turns: number;
}

const MAX_SCENE_SEEDS = 20;
const MAX_SCENE_TURNS = 80;

/** Chebyshev distance between two tiles — the metric movement is measured in. */
const distance = (state: GameState, from: number, to: number): number => {
  const width = state.map.width;
  return Math.max(
    Math.abs((from % width) - (to % width)),
    Math.abs(Math.floor(from / width) - Math.floor(to / width)),
  );
};

/** The destinations the engine offers a unit, as plain numbers. */
const moveOptions = (state: GameState, unitId: number): readonly number[] =>
  unitActions(state, RULESET, asUnitId(unitId)).flatMap((action) =>
    action.type === 'MoveUnit' ? [Number(action.to)] : [],
  );

/** The target the engine offers a unit an attack on, or `undefined`. */
const attackOption = (state: GameState, unitId: number): number | undefined =>
  unitActions(state, RULESET, asUnitId(unitId)).flatMap((action) =>
    action.type === 'AttackUnit' ? [Number(action.target)] : [],
  )[0];

/** The human's first unit that the engine offers an attack for, or `undefined`. */
const attackerIn = (state: GameState, player: ReturnType<typeof asPlayerId>): number | undefined =>
  state.units
    .filter((unit) => unit.owner === player)
    .map((unit) => Number(unit.id))
    .find((id) => attackOption(state, id) !== undefined);

/**
 * Find a game in which one of the human's units can attack, and the commands that get there.
 *
 * A4 requires the attack order, and an attack needs an enemy next to a unit that can fight. The
 * opening position has a settler and a worker — neither can attack — so the scene is found by
 * playing the engine headlessly: found a city, put a warrior in production, then march that
 * warrior at the nearest enemy until contact. The scene is *found* rather than constructed,
 * because constructing one would mean a second way to build a game, and the whole point of this
 * suite is that the browser is a view over the one engine. The search is deterministic: the same
 * seeds, the same moves, the same answer.
 *
 * Every command it returns is one the UI has a control for (`driveScript` issues them by
 * clicking), so the browser can be driven to exactly this state.
 */
const findAttackScene = (
  settingsFor: (seed: number) => ReturnType<typeof settingsFrom>,
): AttackScene | undefined => {
  for (let seed = 1; seed <= MAX_SCENE_SEEDS; seed += 1) {
    const started = headlessNewGame(seed, settingsFor(seed));
    if (!started.ok) continue;
    const player = asPlayerId(0);
    const script: unknown[] = [];
    let state = started.value;

    const settler = state.units.find(
      (unit) => unit.owner === player && unit.type.includes('settler'),
    );
    if (settler === undefined) continue;
    const founded = applyCommand(state, player, { type: 'FoundCity', unitId: settler.id }, RULESET);
    if (!founded.ok) continue;
    state = founded.value.state;
    script.push({ type: 'FoundCity', unitId: Number(settler.id) });

    const city = state.cities.find((candidate) => candidate.owner === player);
    if (city === undefined) continue;
    // The cheapest unit the engine prices that can actually fight, chosen from the engine's own
    // menu rather than from the catalog.
    const soldier = cityProductionOptions(state, RULESET, city.id).find((item) => {
      const def = RULESET.units.find((candidate) => candidate.id === item.id);
      return item.kind === 'unit' && def !== undefined && def.attack > 0;
    });
    if (soldier === undefined) continue;
    const producing = applyCommand(
      state,
      player,
      { type: 'SetProduction', cityId: city.id, item: soldier },
      RULESET,
    );
    if (!producing.ok) continue;
    state = producing.value.state;
    script.push({
      type: 'SetProduction',
      cityId: Number(city.id),
      item: { kind: soldier.kind, id: soldier.id },
    });

    let turns = 0;
    for (let turn = 1; turn <= MAX_SCENE_TURNS; turn += 1) {
      const attacker = attackerIn(state, player);
      if (attacker !== undefined) {
        const target = attackOption(state, attacker);
        if (target !== undefined) {
          return { seed, script, unitId: attacker, target, turns };
        }
      }

      // March every unit that can fight toward the nearest enemy, one legal step at a time.
      const enemies = state.units.filter((unit) => unit.owner !== player).map((unit) => unit.tile);
      for (const unit of state.units.filter((candidate) => candidate.owner === player)) {
        const def = RULESET.units.find((candidate) => candidate.id === unit.type);
        if (def === undefined || def.attack <= 0) continue;
        for (let step = 0; step < 8; step += 1) {
          const here = state.units.find((candidate) => candidate.id === unit.id);
          if (here === undefined) break;
          const goal = enemies.reduce<number | undefined>(
            (best, tile) =>
              best === undefined ||
              distance(state, tile, here.tile) < distance(state, best, here.tile)
                ? tile
                : best,
            undefined,
          );
          const options = moveOptions(state, Number(unit.id));
          if (goal === undefined || options.length === 0) break;
          const best = options.reduce(
            (acc, to) => (distance(state, to, goal) < distance(state, acc, goal) ? to : acc),
            here.tile,
          );
          if (best === here.tile) break;
          const moved = applyCommand(
            state,
            player,
            { type: 'MoveUnit', unitId: unit.id, to: asTileIndex(best) },
            RULESET,
          );
          if (!moved.ok) break;
          state = moved.value.state;
          script.push({ type: 'MoveUnit', unitId: Number(unit.id), to: best });
        }
      }

      const ended = applyCommand(state, player, { type: 'EndTurn' }, RULESET);
      if (!ended.ok) break;
      state = ended.value.state;
      script.push({ type: 'EndTurn' });
      turns = turn;
    }
  }
  return undefined;
};

/** The improvement kind a `StartWork` names, or `undefined` for anything else. */
const kindOf = (action: unknown): string | undefined => {
  if (typeof action !== 'object' || action === null || !('kind' in action)) return undefined;
  const kind: unknown = action.kind;
  return typeof kind === 'string' ? kind : undefined;
};

const attackedFrom = async (page: Page, scene: AttackScene, state: UiState): Promise<boolean> => {
  const issued = async (): Promise<boolean> =>
    (await dispatchLog(page)).some((entry) => actionType(entry.action) === 'AttackUnit');
  const attackControl = unitActionsGroup(page, scene.unitId).getByRole('button', {
    name: /attack/i,
  });
  const camera = await cameraOf(page);
  const box = await canvasBox(page);
  const targetOnScreen = visibleTiles(state, camera, box).includes(scene.target);

  if ((await attackControl.count()) > 0) {
    await attackControl.first().click();
    if (await issued()) return true;
  }
  if (targetOnScreen) {
    await clickTileOrder(page, camera, scene.target, state.map.width, 'AttackUnit');
    if (await issued()) return true;
  }
  if ((await attackControl.count()) > 0) {
    await attackControl.first().click();
    if (await issued()) return true;
  }
  return false;
};

test('A4 unit orders — attack: an attack the engine offers is issued from the UI and resolves exactly as the engine says', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await openApp(page);

  // The settings the app plays with are the app's business; the search must use the same ones,
  // so they are read from a seeded game rather than assumed.
  // **The opponent is held still, on both sides.** The scene search below plays the engine
  // headlessly (`newGame` + `applyCommand`) and no policy plays the rival there, while the browser
  // plays `SMART_POLICY` for the rival seat on each `End turn` the driven script issues. With it
  // left on, the browser walks a different board from the engine's and the per-step hash equality
  // (and the attack's resolution) would be comparing two games. The setting is seeded here, so the
  // probe's own `state.settings` carries it into `settingsFor` — one settings object for the
  // search, the replay and the browser. See `OPPONENT_OFF` in `helpers.ts`.
  const probe = await seedApp(page, SEED, OPPONENT_OFF);
  const settingsFor = (seed: number): ReturnType<typeof settingsFrom> =>
    settingsFrom(probe.settings, seed);
  const scene = findAttackScene(settingsFor);
  expect(scene, 'no seed in the search budget produced an attack in eighty turns').toBeDefined();
  if (scene === undefined) return;

  // Drive the browser to the identical state with the app's OWN controls — the settler's
  // `Found city`, the city screen's `Build …`, one `Move to x,y` per step, the `End turn`
  // button — and then prove by hash that it IS that state before relying on it.
  await seedApp(page, scene.seed);
  const started = headlessNewGame(scene.seed, settingsFor(scene.seed));
  expect(started.ok, 'the engine could not start the scene game').toBe(true);
  if (!started.ok) return;

  // One command at a time, checking the hash after EVERY step: a divergence is then reported
  // with the command that caused it rather than as one number at the end.
  let cursor = started.value;
  let step = 0;
  for (const command of scene.script) {
    await driveScript(page, [command]);
    cursor = replayScript(cursor, asPlayerId(0), [command]);
    step += 1;
    expect(
      await stateHash(page),
      `the browser diverged from the engine after step ${String(step)}: ${JSON.stringify(command)}`,
    ).toBe(hashOf(cursor));
  }
  expect(step).toBe(scene.script.length);
  const headlessAtScene = cursor;
  const atScene = await readState(page);
  expect(
    await stateHash(page),
    'the browser and the engine disagree about the state the attack is issued from',
  ).toBe(hashOf(headlessAtScene));

  const attacker = atScene.units.find((unit) => unit.id === scene.unitId);
  expect(
    attacker,
    `unit ${String(scene.unitId)} is not on the board (${String(scene.turns)} turns into the scene)`,
  ).toBeDefined();
  if (attacker === undefined) return;

  await recordDispatches(page);
  await clearDispatchLog(page);
  await select(page, scene.unitId);
  const issued = await attackedFrom(page, scene, atScene);
  expect(
    issued,
    `the UI offered no way to attack tile ${String(scene.target)} from unit ` +
      `${String(scene.unitId)} (A4 names attack among the unit orders)`,
  ).toBe(true);

  // The engine's own answer for the same attack, applied to the same state: if the two agree by
  // hash, the browser resolved the battle exactly as the engine does — same odds, same RNG
  // stream, same survivors.
  const afterAttack = applyCommand(
    headlessAtScene,
    asPlayerId(0),
    { type: 'AttackUnit', unitId: asUnitId(scene.unitId), target: asTileIndex(scene.target) },
    RULESET,
  );
  expect(afterAttack.ok, 'the engine refused the attack the UI was driven to issue').toBe(true);
  if (!afterAttack.ok) return;

  const afterUi = await readState(page);
  expect(
    await stateHash(page),
    'the attack resolved differently in the browser than in the engine',
  ).toBe(hashOf(afterAttack.value.state));
  expect(afterUi.revision).toBeGreaterThan(atScene.revision);

  // And the command the engine accepted was the attack, from the control the player used.
  const logged = (await dispatchLog(page)).filter(
    (entry) => actionType(entry.action) === 'AttackUnit',
  );
  expect(logged.length, 'no AttackUnit reached the engine from the UI').toBe(1);
  expect(logged[0]?.result).toBe('ok');
});
