/**
 * Phase 4 — **goto**: clicking a far tile walks the unit there.
 *
 * `docs/UI-OVERHAUL.md` §7.4 (b) is the shape this proves: a route query in the engine, the
 * destination held as UI intent. Three things are asserted, and they are the three a player can
 * actually tell apart:
 *
 * 1. **a far click becomes a journey**, walked one engine-offered step at a time over as many turns
 *    as it takes, and the unit arrives;
 * 2. **an invalidated journey is cancelled, out loud** (§8 decision 4) — the world moves under the
 *    route, the unit stops where it is, and the order channel says why;
 * 3. **a click that reaches nowhere still says so** (§1.4) — the engine's own refusal is on screen
 *    instead of a silence that looks like a frozen game.
 *
 * ## Why the fixtures are chosen rather than picked
 *
 * The boards here are `newGame` boards at a fixed seed with the opponent **off**, because a goto
 * spans turns and the test has to know what the world will do in between. Two consequences are
 * designed for rather than hoped for:
 *
 * - **No goody hut on the route.** Entering one can put a barbarian band on the map — measured in
 *   `packages/core/test/route.test.ts`, landing four steps along the route — which is a legitimate
 *   cancellation and would turn the arrival test into a flake. The destination is chosen from tiles
 *   whose engine-planned route crosses no hut.
 * - **The blocker is placed by the ENGINE.** The cancellation test does not hand-edit a state: it
 *   moves a rival unit with a real `MoveUnit` dispatched for that rival's own seat, exactly the
 *   channel `playOpponentSeats` uses, and then lets the app's own `End turn` button resume the
 *   goto. So the invalidation is a real world change and the response to it is the app's.
 *
 * The order channel is a `status` named `Order` — a new name, stated in `docs/UI-OVERHAUL.md` §9
 * and in `main.ts`, because the frozen M8 table may not be extended in place.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  asTileIndex,
  distance8,
  neighbors8,
  planRoute,
  unitMoveOptions,
  type GameState,
  type PlayerId,
  type TileIndex,
  type Unit,
} from '@civts/core';

import {
  OPPONENT_OFF,
  authoritativeState,
  bringTileToCentre,
  cameraOf,
  clearDispatchLog,
  clickTile,
  dispatch,
  dispatchLog,
  endTurnButton,
  humanPlayerId,
  openApp,
  readState,
  recordDispatches,
  RULESET,
  seedApp,
  selectUnit,
  tileX,
  tileY,
} from './helpers.js';

const SEED = 7;

/** The order channel: what the app said about the last order. */
const orderChannel = (page: Page) => page.getByRole('status', { name: 'Order' });

const textOf = async (page: Page): Promise<string> => (await orderChannel(page).innerText()).trim();

const unitById = (state: GameState, id: number): Unit => {
  const found = state.units.find((unit) => Number(unit.id) === id);
  if (found === undefined) throw new Error(`no unit ${String(id)} in the state`);
  return found;
};

/** The human seat's settler — the unit every test here walks with. */
const settlerOf = (state: GameState, seat: PlayerId): Unit => {
  const unit = state.units.find((each) => each.owner === seat && each.type === 'settler');
  if (unit === undefined) throw new Error('the human seat has no settler on this board');
  return unit;
};

/** A tile of a state's map, by index, in the engine's own branded form. */
const tileOf = (index: number): TileIndex => asTileIndex(index);

/**
 * Destinations whose engine-planned route is long enough to need more than one turn and crosses no
 * goody hut, in tile order so the choice is reproducible. At least one must exist — if the board
 * ever stops offering one, the tests below say so rather than testing nothing.
 */
const farDestinations = (
  state: GameState,
  unit: Unit,
  options: { readonly min: number; readonly max: number },
): readonly TileIndex[] => {
  const huts = new Set(state.map.huts.map((hut) => Number(hut)));
  const found: TileIndex[] = [];
  for (let index = 0; index < state.map.terrain.length; index += 1) {
    const to = tileOf(index);
    if (to === unit.tile) continue;
    const away = distance8(state.map, unit.tile, to);
    if (away < options.min || away > options.max) continue;
    const planned = planRoute(state, RULESET, unit.id, to);
    if (!planned.ok) continue;
    if (planned.value.steps.length < options.min) continue;
    if (planned.value.steps.some((step) => huts.has(Number(step)))) continue;
    if (huts.has(index)) continue;
    found.push(to);
  }
  return found;
};

/**
 * Click a tile on the map, through the app's own projection.
 *
 * The pan comes first and the camera is read *after* it, for the reason `orderByMapClick` states:
 * `bringTileToCentre` drags the map, so a camera captured before the drag describes where the tile
 * used to be, and `clickTile` would then click the wrong one.
 */
const clickMapTile = async (page: Page, to: TileIndex): Promise<void> => {
  await bringTileToCentre(page, await readState(page), Number(to));
  const camera = await cameraOf(page);
  const state = await readState(page);
  await clickTile(page, camera, tileX(state, Number(to)), tileY(state, Number(to)));
};

test('a click on a far tile walks the unit there, one engine-offered step at a time', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  const state = await authoritativeState(page);
  const seat = humanPlayerId(await readState(page));
  const settler = settlerOf(state, seat);
  const candidates = farDestinations(state, settler, { min: 3, max: 6 });
  expect(
    candidates.length,
    'this board offers no far destination whose route is free of goody huts, so the walk below ' +
      'would be measuring the huts rather than the goto',
  ).toBeGreaterThan(0);
  const destination = candidates[0];
  if (destination === undefined) return;
  const planned = planRoute(state, RULESET, settler.id, destination);
  expect(planned.ok, 'the engine planned no route to the chosen destination').toBe(true);
  if (!planned.ok) return;
  const route = planned.value.steps.map(Number);

  await selectUnit(page, await readState(page), await cameraOf(page), Number(settler.id));
  await clickMapTile(page, destination);

  // **The first step, not the destination**: a goto is a journey, and the command that goes out on
  // the click is the engine-offered single step the route begins with.
  const first = (await dispatchLog(page)).map((entry) => entry.action);
  expect(first.length, 'clicking the destination dispatched nothing at all').toBeGreaterThan(0);
  expect(
    first.some((action) => {
      const record = action as { type?: string; to?: number };
      return record.type === 'MoveUnit' && record.to === route[0];
    }),
    `the click issued ${JSON.stringify(first)} rather than the first step of the route ` +
      `(${String(route[0])})`,
  ).toBe(true);

  // End turns until the unit is there. `End turn` is what resumes the goto — it refills movement —
  // and the loop is bounded so a stuck goto fails loudly instead of hanging the suite.
  let arrivedAt = Number(unitById(await authoritativeState(page), Number(settler.id)).tile);
  let turns = 0;
  while (arrivedAt !== Number(destination) && turns < 12) {
    await endTurnButton(page).click();
    turns += 1;
    const now = await authoritativeState(page);
    const moved = unitById(now, Number(settler.id)).tile;
    if (Number(moved) === arrivedAt && turns > 1) {
      throw new Error(
        `the goto stopped making progress at tile ${String(arrivedAt)} after ${String(turns)} ` +
          `turns; the channel says "${await textOf(page)}"`,
      );
    }
    arrivedAt = Number(moved);
  }

  expect(arrivedAt, 'the unit did not arrive at the tile that was clicked').toBe(
    Number(destination),
  );
  // The journey is a single goto, not a click per step: every step after the first was dispatched by
  // the app itself, between the turns this test clicked.
  expect(turns, 'the walk needed no turn at all, so it was one adjacent step').toBeGreaterThan(0);
  expect(await textOf(page), 'the channel still carried a message after the unit arrived').toBe('');
});

test('a goto the world closes is cancelled, out loud, and the unit stops where it stands', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  // **The fixture, and why it is searched for rather than assumed.** The invalidation is a rival
  // stepping onto a tile of the settler's route. That means a rival *and* a destination whose route
  // runs through the rival — and on a 60×60 board the two civilizations begin far apart, so the
  // destination has to be chosen near the rival rather than near the settler. What matters is that
  // the blocker is on the route and *ahead* of the walk: the goto is cancelled on the very next turn
  // wherever the settler is, so the journey does not have to be a short one.
  const state = await authoritativeState(page);
  const seat = humanPlayerId(await readState(page));
  const settler = settlerOf(state, seat);
  const huts = new Set(state.map.huts.map((hut) => Number(hut)));

  const rivals = state.units.filter((unit) => unit.owner !== seat);
  expect(rivals.length, 'the board has no rival unit to close the route with').toBeGreaterThan(0);

  let chosen:
    | {
        readonly destination: TileIndex;
        readonly route: readonly number[];
        readonly blocker: number;
      }
    | undefined;
  let rivalThatCanStep: { readonly unit: Unit; readonly step: TileIndex } | undefined;

  for (const rival of rivals) {
    for (const step of unitMoveOptions(state, RULESET, rival.id)) {
      for (const near of neighbors8(state.map, step)) {
        for (const destination of [step, near]) {
          const planned = planRoute(state, RULESET, settler.id, destination);
          if (!planned.ok) continue;
          const route = planned.value.steps.map(Number);
          const at = route.indexOf(Number(step));
          // The blocker must be ON the route, must not be the first step (the settler takes that one
          // on the click, before the rival moves), and the route must be long enough that the first
          // turn cannot carry the settler past it.
          if (at < 1 || route.length < 3) continue;
          if (route.some((tile) => huts.has(tile))) continue;
          chosen = { destination, route, blocker: Number(step) };
          rivalThatCanStep = { unit: rival, step };
          break;
        }
        if (chosen !== undefined) break;
      }
      if (chosen !== undefined) break;
    }
    if (chosen !== undefined) break;
  }
  expect(
    chosen,
    'this board has no rival that can step onto a tile of a route the settler would take, so the ' +
      'cancellation below could not be set up',
  ).toBeDefined();
  if (chosen === undefined || rivalThatCanStep === undefined) return;

  await selectUnit(page, await readState(page), await cameraOf(page), Number(settler.id));
  await clickMapTile(page, chosen.destination);

  // The goto is under way. The click's own turn may carry the unit several steps (the settler has
  // two movement points), so what is asserted is *where on the route* it now stands: on the route,
  // and before the blocker, which is the only thing the cancellation below needs to be meaningful.
  const afterClick = await authoritativeState(page);
  const movedTo = Number(unitById(afterClick, Number(settler.id)).tile);
  const at = chosen.route.indexOf(movedTo);
  const blockerAt = chosen.route.indexOf(chosen.blocker);
  expect(
    at,
    `the goto did not walk the planned route: it is on tile ${String(movedTo)}`,
  ).toBeGreaterThan(-1);
  expect(
    at,
    `the first turn carried the unit past the blocker (route position ${String(at)} of ` +
      `${String(blockerAt)}), so nothing is left to cancel`,
  ).toBeLessThan(blockerAt);

  // The world moves under the route: a RIVAL unit walks onto it, through the engine, for its own
  // seat — the same channel the opponent uses. This is the fog case in miniature: legality never
  // consults visibility, so a route can be crossed by something the player could not see coming.
  expect(
    await dispatch(page, {
      type: 'MoveUnit',
      unitId: Number(rivalThatCanStep.unit.id),
      to: Number(rivalThatCanStep.step),
      seat: Number(rivalThatCanStep.unit.owner),
    }),
    'the engine refused the rival step that was supposed to close the route',
  ).toBe('ok');

  const beforeTurn = await authoritativeState(page);
  const standingOn = Number(unitById(beforeTurn, Number(settler.id)).tile);

  // The log is cleared so the assertion below is about THIS turn's dispatches. Everything in it
  // before now is the click's own walk and the rival's step, and "the cancelled goto did not move
  // the unit" is a claim about the turn that resumed it.
  await clearDispatchLog(page);
  await endTurnButton(page).click();

  const after = await authoritativeState(page);
  const endedOn = Number(unitById(after, Number(settler.id)).tile);
  const message = await textOf(page);
  expect(
    message,
    'the cancelled goto said nothing, which is the silent behaviour decision 4 forbids',
  ).toContain('cancelled');
  expect(message).toContain('goto');
  expect(
    endedOn,
    `the unit kept walking after its route was closed (it moved from ${String(standingOn)} to ` +
      `${String(endedOn)}); the channel says "${message}"`,
  ).toBe(standingOn);
  // Nothing was dispatched for the goto on that turn: the only accepted command is the turn itself.
  const onThatTurn = (await dispatchLog(page)).map((entry) => entry.action);
  expect(
    onThatTurn.some((action) => {
      const record = action as { type?: string; unitId?: number };
      return record.type === 'MoveUnit' && record.unitId === Number(settler.id);
    }),
    `the cancelled goto still dispatched a step: ${JSON.stringify(onThatTurn)}`,
  ).toBe(false);
  // The turn itself did go through, so the absence above is not "nothing ran".
  expect(
    onThatTurn.some((action) => (action as { type?: string }).type === 'EndTurn'),
    'the end turn never reached the engine, so the absence of a step proves nothing',
  ).toBe(true);
});

test('a far tile with no route says so, in the engine\u2019s words, and nothing moves', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  await seedApp(page, SEED, OPPONENT_OFF);
  expect(await recordDispatches(page), 'the seam could not be instrumented').toBe(true);

  const state = await authoritativeState(page);
  const seat = humanPlayerId(await readState(page));
  const settler = settlerOf(state, seat);

  // Water: a land unit may never stand on it, so there is no route to it by any path — and the
  // engine's own sentence for it names the tile.
  const sea = state.map.terrain.findIndex((id) => id === 'ocean' || id === 'coast');
  expect(sea, 'this board has no water, so the case cannot be made').toBeGreaterThan(-1);
  const away = distance8(state.map, settler.tile, tileOf(sea));
  expect(away, 'the water is adjacent, so the click would not be a far-tile click').toBeGreaterThan(
    1,
  );

  await selectUnit(page, await readState(page), await cameraOf(page), Number(settler.id));
  const before = await authoritativeState(page);
  const standingOn = Number(unitById(before, Number(settler.id)).tile);
  const hashBefore = await page.evaluate(() => window.__CIVTS__?.stateHash());

  await clickMapTile(page, tileOf(sea));

  const message = await textOf(page);
  expect(message, 'a click that could not be honoured said nothing').not.toBe('');
  expect(
    message,
    `the channel reported "${message}" rather than the engine's reason about that tile`,
  ).toContain(`tile ${String(sea)}`);

  const after = await authoritativeState(page);
  expect(Number(unitById(after, Number(settler.id)).tile), 'the unit moved to water').toBe(
    standingOn,
  );
  expect(
    await page.evaluate(() => window.__CIVTS__?.stateHash()),
    'a click the engine refused changed the state',
  ).toBe(hashBefore);
});
