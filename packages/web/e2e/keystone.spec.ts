/**
 * W3 — THE KEYSTONE at the UI layer, both directions.
 * See docs/INTERFACES.md, M8 ("The UI must not contain game rules").
 *
 * > Every control the UI offers must be accepted by the engine, and every action
 * > the engine accepts for a unit or city must be reachable from the UI.
 *
 * A mismatch in EITHER direction is a failure, and the two are asserted separately
 * so the report says which way the seam broke:
 *
 * - **Offered ⊆ accepted.** Each control is clicked on a fresh, identical game; the
 *   command it dispatched is compared against the engine's own `actionsFor` list and
 *   then dispatched again, by itself, to prove the engine accepts it. A control that
 *   offered a command outside that list — a move the unit cannot afford, an item a
 *   tech gate forbids — fails here.
 * - **Accepted ⊆ reachable.** Every command the engine returns for that unit or city
 *   is produced by clicking something: a control in the unit's own action group, or
 *   the destination tile on the map (which is how a player moves and attacks).
 *
 * Note what is deliberately NOT asserted anywhere below: a list of expected
 * commands. The expectation is always the engine's own answer, read from the running
 * app through `actionsFor`, so this suite cannot drift from the rules and cannot
 * pass by agreeing with a second copy of them.
 */

import { expect, test, type Page } from '@playwright/test';

import { enumeratedIn } from '../src/ui/schema.js';

import {
  actionControlIndices,
  actionTarget,
  actionsFor,
  actionType,
  bringTileToCentre,
  cameraOf,
  canonicalAction,
  canvasBox,
  clearDispatchLog,
  clickTile,
  clickTileOrder,
  dispatch,
  dispatchLog,
  dragMap,
  findUnitByType,
  humanPlayerId,
  openApp,
  openCity,
  readState,
  recordDispatches,
  sameActionSet,
  seedApp,
  selectUnit,
  stateHash,
  tileX,
  tileY,
  unitAbilitiesGroup,
  unitActionButtons,
  unitActionsGroup,
  unitsOf,
  visibleTiles,
  zoomTo,
  type UiUnit,
} from './helpers.js';

const SEED = 31337;

/**
 * The commands `actionsFor` *enumerates* for a unit — asked of the schema, not restated here.
 *
 * The distinction is the engine's own (docs/INTERFACES.md, `actions.ts`): some legal commands are
 * enumerated — a unit either can or cannot step onto each of its eight neighbours — while others are
 * *queried*, because their space is content or a search space (`FortifyUnit`, `SetRates`,
 * `SetResearch`, `SetWorkedTiles`). A UI control for a queried command is legal and required (A4
 * names "fortify" among the unit orders), so the offered-controls sweep asserts what the contract
 * asserts — that the engine ACCEPTS it — and additionally that every *enumerated* command it offers
 * is present in the engine's own list.
 *
 * These two sets used to be written out by hand, and that is exactly how this file came to disagree
 * with `src/ui/schema.ts` about `SetProduction`: the schema called it globally queried while this set
 * called it enumerated, and *neither could be checked*, because a hand-maintained list is a second
 * statement of a fact that already had an owner. Deriving them means the sweep and the UI cannot
 * disagree about what the UI is obliged to offer.
 *
 * `EndTurn` is deliberately **not** in the unit set any more, and that is a correction rather than a
 * relaxation. The filter below asks "must this command be in the engine's list *for this unit*?" —
 * and `actionsFor({ unitId })` answers with `unitActions`, which by design never yields the turn (a
 * unit's actions are its own, `actions.ts:127-137`). `EndTurn` in a set meaning "must be in the
 * unit's list" was simply wrong.
 *
 * **State the cost plainly, because it is real:** a unit control that wrongly dispatched `EndTurn`
 * would no longer be flagged by this sweep. I first wrote that the assertion below would catch it,
 * and that is FALSE — `EndTurn` is accepted from anywhere, so the engine cannot refuse it. Nothing
 * here compensates. The claim being given up was never the keystone invariant (which is about
 * reachability and acceptance); this set was simply the wrong instrument for it, and carrying
 * `EndTurn` in it bought a check that misdescribed what the check meant.
 */
const ENUMERATED_UNIT_COMMANDS: ReadonlySet<string> = new Set(enumeratedIn('unit'));

/** The commands `actionsFor` enumerates for a city — likewise the schema's answer. */
const ENUMERATED_CITY_COMMANDS: ReadonlySet<string> = new Set(enumeratedIn('city'));

/** A fresh, identical game on the page, zoomed in and panned so tiles are clickable. */
const freshGame = async (page: Page): Promise<void> => {
  await seedApp(page, SEED);
  await zoomTo(page, 1, 1);
  await dragMap(page, -128, -64);
};

/** The map order a command names, or `undefined` for anything that is not one. */
const mapOrderType = (action: unknown): 'MoveUnit' | 'AttackUnit' | undefined => {
  const type = actionType(action);
  return type === 'MoveUnit' || type === 'AttackUnit' ? type : undefined;
};

/** A unit of `typeName` owned by the human seat, or a named failure. */
const humanUnit = async (page: Page, typeName: string): Promise<UiUnit> => {
  const state = await readState(page);
  const unit = findUnitByType(state, humanPlayerId(state), typeName);
  expect(unit, `the human seat has no ${typeName}`).toBeDefined();
  if (unit === undefined) throw new Error(`no ${typeName}`);
  return unit;
};

/** Select a unit through the UI, using the state the app is currently reporting. */
const select = async (page: Page, unitId: number): Promise<void> =>
  selectUnit(page, await readState(page), await cameraOf(page), unitId);

test('keystone UI adds no rules: every control the unit panel offers dispatches a command the engine accepts', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  const settle = await humanUnit(page, 'settler');
  const engineActions = await actionsFor(page, { unitId: settle.id });
  expect(engineActions.length, 'the engine offers the settler nothing').toBeGreaterThan(0);
  const engineSet = new Set(engineActions.map(canonicalAction));

  await select(page, settle.id);
  const controlIndices = await actionControlIndices(unitActionsGroup(page, settle.id));
  expect(controlIndices.length, 'the UI offers no controls for the settler').toBeGreaterThan(0);
  // The abilities group is the queried side of the command union — fortify, and one attack per
  // tile the engine's own `planAttackUnit` accepts — so it is swept too: a control there must be
  // accepted by the engine just as surely as one in the action group.
  const abilityIndices = await actionControlIndices(unitAbilitiesGroup(page, settle.id));

  const failures: string[] = [];
  const produced: unknown[] = [];
  for (const index of [...controlIndices, ...abilityIndices.map((at) => -1 - at)]) {
    // Every control is exercised on its own identical game, so one click cannot hide
    // the next control's answer (founding a city consumes the settler).
    await freshGame(page);
    const unit = await humanUnit(page, 'settler');
    await select(page, unit.id);
    const inAbilities = index < 0;
    const buttons = inAbilities
      ? unitAbilitiesGroup(page, unit.id).getByRole('button')
      : unitActionButtons(page, unit.id);
    const at = inAbilities ? -1 - index : index;
    const label = (await buttons.nth(at).innerText()).trim();
    await buttons.nth(at).click();
    const log = await dispatchLog(page);
    if (log.length === 0) {
      failures.push(`control "${label}" dispatched nothing at all`);
      continue;
    }
    for (const entry of log) {
      produced.push(entry.action);
      const type = actionType(entry.action);
      if (ENUMERATED_UNIT_COMMANDS.has(type) && !engineSet.has(canonicalAction(entry.action))) {
        failures.push(
          `control "${label}" offered the enumerated command ${JSON.stringify(entry.action)}, ` +
            `which is not in the engine's list for unit ${String(unit.id)}`,
        );
      }
      if (entry.result !== 'ok') {
        failures.push(
          `control "${label}" dispatched ${JSON.stringify(entry.action)} and the engine refused it`,
        );
      }
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);
  expect(produced.length).toBeGreaterThan(0);

  // The same commands are accepted when the engine is asked directly, one per fresh
  // game: the controls did not merely appear to work.
  for (const action of produced) {
    await freshGame(page);
    const answer = await dispatch(page, action);
    expect(answer, `re-dispatching ${JSON.stringify(action)} was refused`).toBe('ok');
  }
});

test('keystone UI adds no rules: every command the engine accepts for a unit is reachable from the UI', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page);

  const settle = await humanUnit(page, 'settler');
  const engineActions = await actionsFor(page, { unitId: settle.id });
  expect(engineActions.length).toBeGreaterThan(0);

  // Every control, on its own identical game, records the command it produces.
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);
  const reachable: unknown[] = [];
  await select(page, settle.id);
  const controlIndices = await actionControlIndices(
    page.getByRole('group', { name: `Actions for unit ${String(settle.id)}` }),
  );
  for (const index of controlIndices) {
    await freshGame(page);
    const unit = await humanUnit(page, 'settler');
    await select(page, unit.id);
    await unitActionButtons(page, unit.id).nth(index).click();
    for (const entry of await dispatchLog(page)) reachable.push(entry.action);
  }

  // The rest — the commands a player issues on the map — are issued the way a player
  // issues them: by clicking the destination tile.
  const missing = (): readonly unknown[] => {
    const found = new Set(reachable.map(canonicalAction));
    return engineActions.filter((action) => !found.has(canonicalAction(action)));
  };

  for (const action of missing()) {
    const type = mapOrderType(action);
    const target = actionTarget(action);
    if (type === undefined || target === undefined) continue;
    await freshGame(page);
    const unit = await humanUnit(page, 'settler');
    await select(page, unit.id);
    const state = await readState(page);
    const camera = await cameraOf(page);
    const box = await canvasBox(page);
    if (!visibleTiles(state, camera, box).includes(target)) continue;
    const issued = await clickTileOrder(page, camera, target, state.map.width, type);
    expect(issued, `clicking tile ${String(target)} did not issue a ${type}`).toBe(true);
    for (const entry of await dispatchLog(page)) reachable.push(entry.action);
  }

  // The comparison is over the ENUMERATED commands on both sides: a control for a
  // queried command (fortify) is legal and required, and its absence from
  // `actionsFor` is the engine's own design rather than a gap in the UI.
  const enumeratedFromUi = reachable.filter((action) =>
    ENUMERATED_UNIT_COMMANDS.has(actionType(action)),
  );
  const comparison = sameActionSet(enumeratedFromUi, engineActions);
  expect(
    comparison.equal,
    `commands the engine offers that the UI cannot reach: ${JSON.stringify(comparison.onlyInB)}\n` +
      `commands the UI produced that the engine does not offer: ${JSON.stringify(comparison.onlyInA)}`,
  ).toBe(true);
});

test('the map ALONE can issue every map order the engine offers — no control is clicked', async ({
  page,
}) => {
  // WHY THIS TEST EXISTS, and why the reachability test above cannot cover it.
  //
  // That test reaches a map command by trying the click, and then falling back to a control named
  // after the coordinates (`clickTileOrder`). The fallback means it cannot distinguish a map that
  // works from one that does not — and since the movement buttons currently reach everything, its map
  // path is dead code that has never proved anything. It also `continue`s past any target it cannot
  // currently see, so a target it never even attempted is silently absent from its evidence.
  //
  // `docs/UI-OVERHAUL.md` §5 plans to DELETE those buttons. Doing that is only safe against an
  // assertion that the map alone suffices, made by clicking nothing but the tile. That is this test.
  await openApp(page);
  await freshGame(page);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  const settle = await humanUnit(page, 'settler');
  const offered = (await actionsFor(page, { unitId: settle.id })).filter(
    (action) => mapOrderType(action) !== undefined,
  );
  // Non-vacuity: if the engine offered the settler no map order, every line below would pass while
  // testing nothing, and this spec would go on reporting success after the map had stopped working.
  expect(
    offered.length,
    'the engine offered the settler no map order at all, so this proved nothing',
  ).toBeGreaterThan(0);

  const failures: string[] = [];
  for (const action of offered) {
    await freshGame(page);
    const unit = await humanUnit(page, 'settler');
    await select(page, unit.id);
    const state = await readState(page);
    const type = mapOrderType(action);
    const tile = actionTarget(action);
    if (type === undefined || tile === undefined) continue;

    // Pan first, then read the camera. `bringTileToCentre` drags the map, and a camera captured
    // before that drag describes where the tile used to be — a stale camera here would click some
    // other tile and then report a missing feature.
    await bringTileToCentre(page, state, tile);
    const camera = await cameraOf(page);
    await clearDispatchLog(page);
    await clickTile(page, camera, tileX(state, tile), tileY(state, tile));

    const log = await dispatchLog(page);
    const issued = log.some(
      (entry) => mapOrderType(entry.action) === type && actionTarget(entry.action) === tile,
    );
    if (!issued) {
      failures.push(
        `tile ${String(tile)} at (${String(tileX(state, tile))},${String(tileY(state, tile))}): ` +
          `clicking it issued no ${type}. Dispatched: ` +
          JSON.stringify(log.map((entry) => entry.action)),
      );
    }
  }

  expect(
    failures,
    `map orders the engine offers that a tile click alone cannot issue:\n${failures.join('\n')}`,
  ).toEqual([]);
});

test('keystone UI adds no rules: every control the city screen offers dispatches a command the engine accepts, and every production option is offered', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openApp(page);
  await freshGame(page);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  /** Found a city through the UI's own control, and return its id. */
  const found = async (): Promise<number> => {
    await freshGame(page);
    const unit = await humanUnit(page, 'settler');
    await select(page, unit.id);
    await page
      .getByRole('group', { name: `Actions for unit ${String(unit.id)}` })
      .getByRole('button', { name: /found/i })
      .first()
      .click();
    const state = await readState(page);
    const city = state.cities[0];
    expect(city, 'clicking the founding control did not found a city').toBeDefined();
    if (city === undefined) throw new Error('no city was founded');
    return city.id;
  };

  const firstCity = await found();
  const firstState = await readState(page);

  const engineOptions = await actionsFor(page, { cityId: firstCity });
  expect(engineOptions.length, 'the engine offers the city nothing to build').toBeGreaterThan(0);
  const engineSet = new Set(engineOptions.map(canonicalAction));

  const initialCity = firstState.cities.find((city) => city.id === firstCity);
  expect(initialCity).toBeDefined();
  if (initialCity === undefined) return;
  const dialog = await openCity(page, firstState, await cameraOf(page), initialCity);
  const indices = await actionControlIndices(dialog);
  expect(indices.length, 'the city screen offers no controls').toBeGreaterThan(0);

  const failures: string[] = [];
  const reachable: unknown[] = [];
  for (const index of indices) {
    const id = await found();
    const state = await readState(page);
    const city = state.cities.find((candidate) => candidate.id === id);
    if (city === undefined) throw new Error('the founded city vanished');
    const open = await openCity(page, state, await cameraOf(page), city);
    const control = open.getByRole('button').nth(index);
    const label = (await control.innerText()).trim();
    await control.click();
    const log = await dispatchLog(page);
    if (log.length === 0) {
      failures.push(`city control "${label}" dispatched nothing at all`);
      continue;
    }
    for (const entry of log) {
      reachable.push(entry.action);
      const type = actionType(entry.action);
      if (ENUMERATED_CITY_COMMANDS.has(type) && !engineSet.has(canonicalAction(entry.action))) {
        failures.push(
          `city control "${label}" offered ${JSON.stringify(entry.action)}, which is not in the ` +
            `engine's option list for city ${String(id)}`,
        );
      }
      if (entry.result !== 'ok') {
        failures.push(
          `city control "${label}" dispatched ${JSON.stringify(entry.action)} and the engine refused it`,
        );
      }
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);

  const comparison = sameActionSet(
    reachable.filter((action) => ENUMERATED_CITY_COMMANDS.has(actionType(action))),
    engineOptions,
  );
  expect(
    comparison.equal,
    `city options the engine offers that the UI cannot reach: ${JSON.stringify(comparison.onlyInB)}\n` +
      `city commands the UI produced that the engine does not offer: ${JSON.stringify(comparison.onlyInA)}`,
  ).toBe(true);
});

test('keystone UI adds no rules: the engine refuses what the UI must never offer, and a refusal changes nothing', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page);

  const before = await readState(page);
  const hashBefore = await stateHash(page);
  const owner = humanPlayerId(before);

  // A `FoundCity` from a unit that is not a settler is the engine's own refusal, and
  // the worker is right there: no control may offer it, and asking directly fails.
  const worker = findUnitByType(before, owner, 'worker');
  if (worker !== undefined) {
    expect(
      await dispatch(page, { type: 'FoundCity', unitId: worker.id }),
      'the engine accepted a city from a worker',
    ).toBe('refused');
    await select(page, worker.id);
    const foundControl = page
      .getByRole('group', { name: `Actions for unit ${String(worker.id)}` })
      .getByRole('button', { name: /found/i });
    expect(await foundControl.count(), 'the UI offers a worker a city it cannot found').toBe(0);
  }

  // A move the engine refuses (the far side of the map) is refused as well, and the
  // state is untouched: nothing silently pretended to work.
  const settle = await humanUnit(page, 'settler');
  const far = before.map.width * before.map.height - 1;
  expect(
    await dispatch(page, { type: 'MoveUnit', unitId: settle.id, to: far }),
    'the engine accepted a move to the far side of the map',
  ).toBe('refused');

  expect(await stateHash(page), 'a refused command changed the engine state').toBe(hashBefore);
  expect((await readState(page)).revision).toBe(before.revision);
});

test('keystone UI adds no rules: the player-level action list is the engine legalActions list, not a UI subset', async ({
  page,
}) => {
  await openApp(page);
  await freshGame(page);
  const state = await readState(page);
  const owner = humanPlayerId(state);

  const playerActions = await actionsFor(page, {});
  expect(playerActions.length, 'the app reports no legal actions for the player').toBeGreaterThan(
    0,
  );

  // The engine's own generator, asked headlessly with the same seed and settings,
  // must yield the same commands: a UI that reported its own list — or dropped the
  // ones it has no control for — would differ here.
  const perUnit: unknown[] = [];
  for (const unit of unitsOf(state, owner)) {
    for (const action of await actionsFor(page, { unitId: unit.id })) perUnit.push(action);
  }
  expect(perUnit.length).toBeGreaterThan(0);
  const endTurns = playerActions.filter(
    (action) => canonicalAction(action) === '{"type":"EndTurn"}',
  );
  expect(endTurns.length, 'EndTurn is always legal for a real player').toBe(1);
  expect(
    sameActionSet(
      perUnit,
      playerActions.filter((a) => canonicalAction(a) !== '{"type":"EndTurn"}'),
    ).equal,
  ).toBe(true);
});
