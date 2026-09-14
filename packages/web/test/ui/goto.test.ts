/**
 * `ui/goto.ts` — the goto decision, on real boards, without a browser.
 *
 * The e2e suite can show that a goto *walks*; it cannot show the cases that matter most, because
 * they are the ones where nothing happens: a route the engine has closed, a route the engine has
 * changed, a unit with no movement left. Those are decided in `nextGotoStep` and they are decided
 * here, on `newGame` boards with the shipped catalog, so the assertions are about the engine's own
 * answers rather than about a hand-written idea of them.
 *
 * The three cases below are the three answers `docs/UI-OVERHAUL.md` §8 decision 4 needs, and they
 * have to be told apart — a UI that treated "out of movement" as "the route is gone" would cancel
 * every second goto with a message that is not true:
 *
 * | state of the world | what the decision must be | why |
 * |---|---|---|
 * | the engine still plans the same route, the unit can afford the step | `step` | walk it |
 * | the engine still plans it, the unit cannot afford the step yet | `waiting` | the next turn refills it |
 * | the engine plans a different route, or none | `cancelled` | §8 decision 4: never silently replanned |
 *
 * And one property that is worth more than any of them: **`step` is only ever returned with a
 * command the engine accepts.** The goto's dispatches are the UI issuing orders on its own
 * initiative, which is exactly where the keystone invariant is easiest to break, so the last test
 * walks a whole journey by repeatedly asking the decision and applying what it returned.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitId,
  DEFAULT_SETTINGS,
  newGame,
  unitActions,
  type GameState,
  type PlayerId,
  type RulesetView,
  type TileIndex,
  type Unit,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { nextGotoStep, startGoto, type GotoIntent } from '../../src/ui/goto.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const SEED = 7;

const startOf = (): GameState => {
  const started = newGame(
    SEED,
    { ...DEFAULT_SETTINGS, seed: SEED, mapSize: 'tiny', civCount: 2 },
    RULESET,
  );
  if (!started.ok) throw new Error('newGame refused the fixture seed');
  return started.value;
};

const STATE = startOf();
const SEAT: PlayerId = STATE.players[0]?.id ?? asPlayerId(0);
const UNIT: Unit = (() => {
  const unit = STATE.units.find((each) => each.owner === SEAT && each.type === 'settler');
  if (unit === undefined) throw new Error('the fixture board has no settler for the human seat');
  return unit;
})();

const mover = (state: GameState, unitId: UnitId): Unit => {
  const found = state.units.find((each) => each.id === unitId);
  if (found === undefined) throw new Error(`no unit ${String(unitId)}`);
  return found;
};

/** A destination between `min` and `max` Chebyshev tiles away that the engine can route to. */
const aDestination = (state: GameState, min: number, max: number): TileIndex => {
  const width = state.map.width;
  const from = mover(state, UNIT.id).tile;
  const fx = from % width;
  const fy = Math.floor(from / width);
  for (let index = 0; index < state.map.terrain.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const away = Math.max(Math.abs(x - fx), Math.abs(y - fy));
    if (away < min || away > max) continue;
    const to = asTileIndex(index);
    if (startGoto(state, RULESET, UNIT.id, to).kind === 'started') return to;
  }
  throw new Error(`no routable destination ${String(min)}-${String(max)} tiles from the settler`);
};

/** The intent a click on `to` would set up. */
const intentTo = (state: GameState, to: TileIndex): GotoIntent => {
  const began = startGoto(state, RULESET, UNIT.id, to);
  if (began.kind !== 'started') throw new Error('the fixture destination has no route');
  return began.intent;
};

/** `state` with an enemy unit parked on `tile` — the world moving under a route. */
const rivalOn = (state: GameState, tile: TileIndex): GameState => {
  const rival = state.units.find((each) => each.owner !== SEAT);
  if (rival === undefined) throw new Error('the fixture board has no rival unit to move');
  return {
    ...state,
    units: state.units.map((each) => (each.id === rival.id ? { ...each, tile } : each)),
  };
};

describe('ui/goto: starting a journey', () => {
  it('plans the journey with the engine and hands back the steps it will walk', () => {
    const to = aDestination(STATE, 3, 8);
    const intent = intentTo(STATE, to);
    expect(intent.unitId).toBe(UNIT.id);
    expect(intent.destination).toBe(to);
    expect(intent.route.length).toBeGreaterThan(1);
    expect(intent.route.at(-1), 'the plan does not end on the destination').toBe(to);
    // Every step is a single step from the one before it, starting at the unit's own tile.
    let from = mover(STATE, UNIT.id).tile;
    for (const step of intent.route) {
      const dx = Math.abs((step % STATE.map.width) - (from % STATE.map.width));
      const dy = Math.abs(Math.floor(step / STATE.map.width) - Math.floor(from / STATE.map.width));
      expect(Math.max(dx, dy), `step ${String(step)} is not adjacent to ${String(from)}`).toBe(1);
      from = step;
    }
  });

  it('says there is no route, in the engine\u2019s own words, when there is none', () => {
    // Water: a land unit may never stand on it. The sentence is the engine's own — `route.ts` hands
    // back `planMove`'s own refusal when the *destination* is what is wrong, so a player reads
    // "tile 0 cannot be entered" rather than a claim about a journey — and nothing about it is
    // invented here.
    const sea = STATE.map.terrain.findIndex((id) => id === 'ocean' || id === 'coast');
    expect(sea, 'the fixture board has no water, so this case cannot be made').toBeGreaterThan(-1);
    const began = startGoto(STATE, RULESET, UNIT.id, asTileIndex(sea));
    expect(began.kind).toBe('no-route');
    if (began.kind !== 'no-route') return;
    expect(began.reason).toBe(`tile ${String(sea)} cannot be entered`);
  });
});

describe('ui/goto: the three answers a pending journey can get', () => {
  it('offers the next step, as a command the engine itself offers for that unit', () => {
    const intent = intentTo(STATE, aDestination(STATE, 3, 8));
    const decision = nextGotoStep(STATE, RULESET, intent);
    expect(decision.kind).toBe('step');
    if (decision.kind !== 'step') return;
    expect(decision.command.to, 'the step is not the head of the route').toBe(intent.route[0]);
    expect(decision.intent.route, 'the step did not shorten the route').toStrictEqual(
      intent.route.slice(1),
    );
    // The keystone property at this seam: the command the goto would issue is one the engine's own
    // list for this unit contains, and one the applier accepts on this very state.
    expect(
      unitActions(STATE, RULESET, UNIT.id).some(
        (command) => command.type === 'MoveUnit' && command.to === decision.command.to,
      ),
      'the goto would issue a command the engine does not offer',
    ).toBe(true);
    expect(applyCommand(STATE, SEAT, decision.command, RULESET).ok).toBe(true);
  });

  it('WAITS, rather than cancelling, when the unit has no movement left for the step', () => {
    // The distinction this test exists for: the route is intact — the engine plans exactly what it
    // planned — but the unit cannot take the step until the next turn refills it. Treating this as
    // an invalidation would cancel a goto every time a unit spent its movement mid-journey.
    const intent = intentTo(STATE, aDestination(STATE, 3, 8));
    const spent: GameState = {
      ...STATE,
      units: STATE.units.map((each) => (each.id === UNIT.id ? { ...each, movementLeft: 0 } : each)),
    };
    const decision = nextGotoStep(spent, RULESET, intent);
    expect(decision.kind, 'a unit with no movement left was read as a lost route').toBe('waiting');

    // And with the movement a fresh turn gives it, the same intent steps — which is what `waiting`
    // promises and what the shell relies on at the turn boundary.
    const refilled: GameState = {
      ...spent,
      units: spent.units.map((each) =>
        each.id === UNIT.id ? { ...each, movementLeft: mover(STATE, UNIT.id).movementLeft } : each,
      ),
    };
    expect(nextGotoStep(refilled, RULESET, intent).kind).toBe('step');
  });

  it('CANCELS with the engine\u2019s reason when the route is gone, and does not re-plan', () => {
    const to = aDestination(STATE, 3, 8);
    const intent = intentTo(STATE, to);
    // A rival walks onto the destination. That is the fog case in miniature: legality never
    // consults visibility, so a route can be closed by something the player could not see.
    const blocked = rivalOn(STATE, to);
    const decision = nextGotoStep(blocked, RULESET, intent);
    expect(decision.kind).toBe('cancelled');
    if (decision.kind !== 'cancelled') return;
    expect(decision.cause).toBe('no-route');
    // The engine's own reason for the destination, not a paraphrase: `planMove` says a tile another
    // player holds cannot be entered, and that is what the cancellation carries.
    expect(decision.detail).toBe(
      `tile ${String(to)} is held by another player, so a unit may not enter it`,
    );
  });

  it('CANCELS when the engine plans a DIFFERENT route, rather than silently taking the detour', () => {
    // §8 decision 4's hard half. The destination is still reachable — but not the way the player was
    // told, so the order is cancelled and said out loud instead of being quietly re-routed.
    const to = aDestination(STATE, 4, 10);
    const intent = intentTo(STATE, to);
    const second = intent.route[1];
    expect(
      second,
      'this destination is one step away, so there is no detour to test',
    ).toBeDefined();
    if (second === undefined) return;

    // A rival stands on the route's second tile. Whether that closes the route or merely re-routes
    // it is the engine's business; what this asserts is that the UI cancels either way, with the
    // changed plan named as the cause when a plan still exists.
    const blocked = rivalOn(STATE, second);
    const stillRoutable = startGoto(blocked, RULESET, UNIT.id, to).kind === 'started';
    const decision = nextGotoStep(blocked, RULESET, intent);
    expect(decision.kind, 'the goto carried on past a plan that is no longer the plan').toBe(
      'cancelled',
    );
    if (decision.kind !== 'cancelled') return;
    expect(decision.cause).toBe(stillRoutable ? 'plan-changed' : 'no-route');
    expect(stillRoutable, 'this board cannot produce the detour case, so it is not covered').toBe(
      true,
    );
  });

  it('answers arrived, gone and an inconsistent intent without guessing', () => {
    const to = aDestination(STATE, 3, 8);
    const intent = intentTo(STATE, to);
    expect(
      nextGotoStep(STATE, RULESET, { ...intent, destination: mover(STATE, UNIT.id).tile }).kind,
    ).toBe('arrived');
    expect(nextGotoStep(STATE, RULESET, { ...intent, unitId: asUnitId(9999) }).kind).toBe('gone');
    expect(
      nextGotoStep(STATE, RULESET, { ...intent, route: [] }).kind,
      'an intent with no steps and no arrival was treated as a journey',
    ).toBe('cancelled');
  });
});

describe('ui/goto: a whole journey, one engine-offered step at a time', () => {
  it('walks the unit to the destination, and every step is a command the engine accepts', () => {
    // This is the shell's loop (`advanceGoto`) written out: ask, dispatch, ask again — with a fresh
    // turn's movement granted whenever the decision is `waiting`, exactly as `End turn` does. It is
    // the test that makes "the goto cannot issue a refused order" a fact rather than a hope.
    const to = aDestination(STATE, 4, 12);
    let intent: GotoIntent = intentTo(STATE, to);
    let current = STATE;
    const walked: TileIndex[] = [];
    let refills = 0;
    let arrived = false;

    for (let guard = 0; guard < 64; guard += 1) {
      const decision = nextGotoStep(current, RULESET, intent);
      if (decision.kind === 'arrived') {
        arrived = true;
        break;
      }
      if (decision.kind === 'waiting') {
        refills += 1;
        expect(refills, 'the walk never arrived and kept waiting for movement').toBeLessThan(32);
        current = {
          ...current,
          units: current.units.map((each) =>
            each.id === UNIT.id
              ? {
                  ...each,
                  movementLeft: RULESET.units.find((def) => def.id === each.type)?.movement ?? 1,
                }
              : each,
          ),
        };
        continue;
      }
      expect(decision.kind, 'the journey was cancelled on a board that never changed').toBe('step');
      if (decision.kind !== 'step') break;
      const outcome = applyCommand(current, SEAT, decision.command, RULESET);
      expect(
        outcome.ok,
        `the goto issued ${JSON.stringify(decision.command)}, which the engine refused`,
      ).toBe(true);
      if (!outcome.ok) break;
      current = outcome.value.state;
      walked.push(mover(current, UNIT.id).tile);
      intent = decision.intent;
    }

    expect(arrived, 'the goto never reported arrival').toBe(true);
    expect(mover(current, UNIT.id).tile, 'the goto did not arrive').toBe(to);
    expect(walked.at(-1)).toBe(to);
    expect(
      refills,
      'the walk never needed a refill, so `waiting` was not exercised',
    ).toBeGreaterThan(0);
    expect(applyCommand(current, SEAT, { type: 'EndTurn' }, RULESET).ok).toBe(true);
  });
});
