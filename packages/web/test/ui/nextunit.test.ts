/**
 * `ui/nextunit.ts` — the next-unit flow, on real boards and without a browser.
 *
 * The e2e suite can show that `Space` moves the selection. It cannot show the property the whole
 * module rests on: that **"needs orders" is the engine's own list, not a movement count**. That
 * distinction is exactly the defect class `docs/UI-OVERHAUL.md` §4.4 warns about — a second
 * statement of a rule in the web package, free to disagree with `applyCommand` — so the assertion
 * that matters here is a *falsifier*: a unit that has movement left and **nothing the engine
 * offers it** must not be in the flow.
 *
 * That board is not hypothetical and it is built below rather than argued about: a warrior ringed
 * by impassable ground has `movementLeft: 1` and `unitActions` returning **nothing**. A predicate
 * written as `unit.movementLeft > 0` would offer it; the engine's list does not.
 *
 * The cross-check is deliberately a **different engine function** from the one the module calls:
 * `unitsNeedingOrders` asks `unitActions` (the unit context), and the test compares its answer with
 * the units named by `legalActions` (the player context, `actions.ts:395`). Two generators, one
 * answer — which is the same agreement the keystone invariant is built on.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  asPlayerId,
  asUnitId,
  DEFAULT_SETTINGS,
  legalActions,
  neighbors8,
  newGame,
  spawnUnit,
  unitActions,
  unitCatalog,
  type Command,
  type GameState,
  type PlayerId,
  type RulesetView,
  type TerrainId,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { nextUnitNeedingOrders, unitsNeedingOrders } from '../../src/ui/nextunit.js';
import { unitNamedBy } from '../../src/ui/schema.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const SEED = 7;

const startOf = (seed = SEED): GameState => {
  const started = newGame(
    seed,
    { ...DEFAULT_SETTINGS, seed, mapSize: 'tiny', civCount: 2 },
    RULESET,
  );
  if (!started.ok) throw new Error('newGame refused the fixture seed');
  return started.value;
};

const STATE = startOf();
const SEAT: PlayerId = STATE.players[0]?.id ?? asPlayerId(0);

const unitOf = (state: GameState, id: UnitId): GameState['units'][number] => {
  const unit = state.units.find((each) => each.id === id);
  if (unit === undefined) throw new Error(`no unit ${String(id)}`);
  return unit;
};

/** The seat's units, in id order — the order the flow walks. */
const mineOf = (state: GameState): readonly UnitId[] =>
  state.units.filter((unit) => unit.owner === SEAT).map((unit) => unit.id);

/**
 * Apply a command and fail loudly if the engine refused it: every fixture step below is meant to
 * be a legal order, and a refusal here would make the case it sets up vacuous.
 */
const apply = (state: GameState, command: Command): GameState => {
  const outcome = applyCommand(state, SEAT, command, RULESET);
  if (!outcome.ok) {
    throw new Error(`the engine refused ${command.type}: ${JSON.stringify(outcome.error)}`);
  }
  return outcome.value.state;
};

/**
 * The units **the player-context generator** offers something for, which is a different question
 * from the one the module asks and must have the same answer.
 */
const namedByPlayerList = (state: GameState): ReadonlySet<number> => {
  const ids = new Set<number>();
  for (const command of legalActions(state, RULESET, SEAT)) {
    const named = unitNamedBy(command);
    if (named !== undefined) ids.add(Number(named));
  }
  return ids;
};

/**
 * The falsifying board: a military unit with movement left and nothing the engine offers it.
 *
 * The ring is the **ruleset's own** impassable terrain (read from `impassable`, never hardcoded by
 * name), and the unit is spawned through the engine's own `spawnUnit`, so nothing here invents a
 * unit type or a terrain rule. What it produces is a state the engine reads as "this unit may do
 * nothing" while its movement is untouched — the one shape a movement-count predicate gets wrong.
 */
const ringedIn = (state: GameState): { readonly state: GameState; readonly unit: UnitId } => {
  const impassable = RULESET.terrains.filter((terrain) => terrain.impassable).map((t) => t.id);
  const ring: TerrainId | undefined = impassable[0];
  if (ring === undefined) throw new Error('the ruleset declares no impassable terrain');
  const def = unitCatalog(RULESET).find(
    (candidate) => candidate.attack > 0 && candidate.role !== 'settler',
  );
  if (def === undefined) throw new Error('the ruleset has no military unit to ring in');
  const home = unitOf(state, mineOf(state)[0] ?? asUnitId(-1));
  const spawned = spawnUnit(state, def, SEAT, home.tile);
  const terrain = [...spawned.state.map.terrain];
  for (const neighbour of neighbors8(spawned.state.map, home.tile)) {
    terrain[Number(neighbour)] = ring;
  }
  return {
    state: { ...spawned.state, map: { ...spawned.state.map, terrain } },
    unit: spawned.unit.id,
  };
};

const RINGED = ringedIn(STATE);
const RINGED_SEAT_UNITS = RINGED.state.units.filter((unit) => unit.owner === SEAT).length;

describe('the next-unit flow asks the engine, not a movement count', () => {
  it('a unit with movement left and nothing to do is NOT offered, and the fixture really has one', () => {
    const unit = unitOf(RINGED.state, RINGED.unit);
    // The fixture's own claim, asserted rather than assumed: if this unit ever gains an action the
    // case below stops being a falsifier and the test says so before it says anything else.
    expect(
      unit.movementLeft,
      'the ringed unit has no movement, so it cannot falsify a movement-count predicate',
    ).toBeGreaterThan(0);
    expect(
      unitActions(RINGED.state, RULESET, RINGED.unit),
      'the ringed unit is offered something after all, so it is not the case this test is about',
    ).toEqual([]);

    expect(
      unitsNeedingOrders(RINGED.state, RULESET, SEAT),
      'the flow offered a unit the engine offers nothing for: "needs orders" is not a movement count',
    ).not.toContain(RINGED.unit);
  });

  it('agrees with the player-context generator, unit for unit', () => {
    for (const [name, state] of [
      ['the opening board', STATE],
      ['the ringed board', RINGED.state],
    ] as const) {
      const flow = new Set(unitsNeedingOrders(state, RULESET, SEAT).map(Number));
      expect(flow, `on ${name} the flow and legalActions name different units`).toEqual(
        namedByPlayerList(state),
      );
      expect(
        flow.size,
        `on ${name} the comparison is vacuous: no unit needs orders`,
      ).toBeGreaterThan(0);
    }
  });

  it('the ringed board is not vacuous: the seat still has units the flow does offer', () => {
    expect(RINGED_SEAT_UNITS, 'the ringed fixture lost the seat its units').toBeGreaterThan(1);
    expect(unitsNeedingOrders(RINGED.state, RULESET, SEAT).length).toBeGreaterThan(0);
  });
});

describe('the next-unit flow walks, wraps, and never returns the unit you are on', () => {
  const first = mineOf(STATE)[0];
  const second = mineOf(STATE)[1];
  if (first === undefined || second === undefined) {
    throw new Error('the fixture seat needs two units for this suite to mean anything');
  }

  it('the opening board has two units that need orders, so every case below is about a choice', () => {
    expect(unitsNeedingOrders(STATE, RULESET, SEAT)).toEqual([first, second]);
  });

  it('starts after the current unit and wraps round at the end', () => {
    expect(nextUnitNeedingOrders(STATE, RULESET, SEAT, first)).toBe(second);
    expect(nextUnitNeedingOrders(STATE, RULESET, SEAT, second)).toBe(first);
  });

  it('with nothing selected it starts at the first unit of the seat', () => {
    expect(nextUnitNeedingOrders(STATE, RULESET, SEAT, undefined)).toBe(first);
  });

  it('with a unit the state does not hold it starts again rather than guessing a position', () => {
    expect(nextUnitNeedingOrders(STATE, RULESET, SEAT, asUnitId(9999))).toBe(first);
  });

  it('a unit that spends its movement leaves the flow, and the next turn brings it back', () => {
    const spent = apply(STATE, { type: 'FortifyUnit', unitId: second });
    expect(
      unitOf(spent, second).movementLeft,
      'the fixture unit still has movement after fortifying, so it did not spend anything',
    ).toBe(0);
    expect(unitsNeedingOrders(spent, RULESET, SEAT)).toEqual([first]);
    // And the flow does not answer with the unit that is already selected: there is nothing left
    // to move to, and saying "the next unit is this one" would make the key look broken.
    expect(nextUnitNeedingOrders(spent, RULESET, SEAT, first)).toBeUndefined();

    const refilled = apply(spent, { type: 'EndTurn' });
    expect(
      unitOf(refilled, second).movementLeft,
      'the turn boundary did not refill the unit, so the case below proves nothing',
    ).toBeGreaterThan(0);
    expect(unitsNeedingOrders(refilled, RULESET, SEAT)).toEqual([first, second]);
  });

  it('is a function of the state: the same question has the same answer', () => {
    expect(nextUnitNeedingOrders(STATE, RULESET, SEAT, first)).toBe(
      nextUnitNeedingOrders(STATE, RULESET, SEAT, first),
    );
  });
});

describe('the next-unit flow never offers a unit the engine has nothing for, on any seed', () => {
  const SEEDS = [1, 7, 75, 31337];

  it('every unit it offers is one the engine offers something for, and never the current unit', () => {
    for (const seed of SEEDS) {
      const state = startOf(seed);
      const offered = unitsNeedingOrders(state, RULESET, SEAT);
      const names = namedByPlayerList(state);
      for (const id of offered) {
        expect(
          names.has(Number(id)),
          `seed ${String(seed)}: unit ${String(id)} is not offered`,
        ).toBe(true);
      }
      for (const from of state.units.filter((unit) => unit.owner === SEAT).map((unit) => unit.id)) {
        const next = nextUnitNeedingOrders(state, RULESET, SEAT, from);
        if (next === undefined) continue;
        expect(
          next,
          `seed ${String(seed)}: the flow answered with the unit it started from`,
        ).not.toBe(from);
        expect(
          names.has(Number(next)),
          `seed ${String(seed)}: the flow offered unit ${String(next)}, which the engine does not`,
        ).toBe(true);
      }
    }
  });
});
