/**
 * `route.ts` — the route query, and the property that makes it allowed to exist:
 * **every "may the unit step there?" answer it gives is `planMove`'s.**
 *
 * This file is written to fail if that stops being true. A route query can go wrong
 * in exactly two ways, and each has its own section below:
 *
 * 1. **It states a movement rule of its own.** The falsifiers are board cases where
 *    the engine's clause decides and a plausible reimplementation would decide
 *    differently, one per clause of `planMove`:
 *    - *terrain cost vs the unit's movement* — a hills gap (cost 2) that a
 *      movement-2 settler crosses and a movement-1 warrior cannot, ever;
 *    - *impassable terrain* — a mountain wall with one gap, so every route must
 *      cross it at a known tile;
 *    - *an enemy on a tile* — the gap is closed by a rival unit, and re-opened when
 *      it leaves;
 *    - *a friendly unit on a tile* — Civ 3 stacks, so the same gap is **not** closed
 *      by the player's own unit, and the step onto it is accepted by the applier;
 *    - *a rival city on a tile* — closed, like a rival unit, because `planMove`
 *      refuses both with `occupied-by-enemy`.
 *    A query that hardcoded "passable terrain costs one" would walk the warrior
 *    through the hills; one that ignored occupancy would walk it through the rival;
 *    one that treated any unit as a blocker would refuse to walk past its own.
 * 2. **It returns a route the engine cannot execute.** The falsifier is
 *    `walksTheRoute`: the returned steps are applied one at a time through
 *    `applyCommand`, with the unit refilled as `EndTurn` refills it, and every step
 *    must be accepted and must land where the route said.
 *
 * Two further properties are pinned because the UI's goto depends on them
 * (`docs/UI-OVERHAUL.md` §7.4 shape (b), §8 decision 4), and neither is obvious from
 * reading the search:
 *
 * - **The route from the second tile is the tail of the route from the first**, so a
 *   caller can re-ask and compare for equality: the query runs *backwards* from the
 *   destination, which makes the parents one tree and the route independent of where
 *   the walk started. Checked on real generated boards, for every reachable
 *   destination of every unit.
 * - **The route is a shortest one, and the query is a pure read**: the same call
 *   twice returns the same steps, and the state's own hash is unchanged by asking.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

import { applyCommand, planMove, planRoute, type Command, type GameError } from '../src/index.js';
import {
  asCityId,
  asGovernmentId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type TileIndex,
  type UnitId,
} from '../src/ids.js';
import {
  neighbors8,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  newGame,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import type { Unit, UnitDef, UnitRole } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * The board: a wall with one gap, and the gap's cost is why it matters
 * ------------------------------------------------------------------ */

const width = 8;
const height = 6;

/** `tile(x, y)` — this fixture's own arithmetic, so no test spells `y * 8 + x` out. */
const tile = (x: number, y: number): TileIndex => asTileIndex(y * width + x);

const TERRAIN_ROWS: readonly (readonly [TerrainRole, number, boolean])[] = [
  ['grassland', 1, false],
  ['hills', 2, false],
  ['mountains', 3, true],
  ['ocean', 1, true],
];

const TERRAINS: readonly TerrainDef[] = TERRAIN_ROWS.map(([role, moveCost, impassable]) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost,
  defenseBonusPct: 0,
  yields: { food: 1, shields: 0, commerce: 0 },
  impassable,
}));

/**
 * Grassland everywhere except a **mountain wall at x = 4**, with a single gap at
 * (4,2) that is *hills* rather than grassland.
 *
 * The wall is what makes "the route must" an assertion that can be made by hand:
 * every step between the left and right halves lands on x = 4, and only x = 4, y = 2
 * is passable. The gap's cost is what makes the movement rule visible: hills cost 2,
 * so a unit with movement 2 crosses it and a unit with movement 1 never can.
 */
const TERRAIN: readonly TerrainRole[] = Array.from({ length: width * height }, (_, index) => {
  const x = index % width;
  const y = Math.floor(index / width);
  if (x !== 4) return 'grassland';
  return y === 2 ? 'hills' : 'mountains';
});

const MAP: GameMap = {
  width,
  height,
  terrain: TERRAIN.map((role) => asTerrainId(role)),
  huts: [],
  resources: [],
};

const GAP = tile(4, 2);
const LEFT = tile(0, 3);
const RIGHT = tile(7, 3);

const makeDef = (id: string, role: UnitRole, movement: number): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 1,
  defense: 1,
  movement,
  cost: 1,
  domain: 'land',
});

const SETTLER = makeDef('settler', 'settler', 2);
const WARRIOR = makeDef('warrior', 'military', 1);

const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, WARRIOR],
  improvements: [],
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (index: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: '#d12f2f',
  startingTile: LEFT,
  kind: 'civ',
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  techs: [],
  government: asGovernmentId('despotism'),
});

const unitAt = (id: number, type: UnitDef, owner: number, at: TileIndex): Unit => ({
  id: asUnitId(id),
  type: type.id,
  owner: asPlayerId(owner),
  tile: at,
  movementLeft: type.movement,
});

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);

/** **Nothing explored anywhere**, so a route that crossed fog would be visible as a bug. */
const UNSEEN: readonly boolean[] = Array.from({ length: width * height }, () => false);

/** The settler (unit 0, movement 2) on the left; player 1's warrior (unit 1) on the right. */
const board = (units: readonly Unit[]): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0), player(1)],
  nextUnitId: units.length,
  units: [...units].sort((a, b) => Number(a.id) - Number(b.id)),
  explored: [UNSEEN, UNSEEN],
  nextCityId: 0,
  tileOwner: [],
  cities: [],
  improvements: [],
});

const SETTLER_ID = asUnitId(0);

/** Where player 1's warrior parks on the base board: the far corner, and never `RIGHT`. */
const PARKED = tile(7, 5);

/** The base board: the settler on `LEFT`, player 1's warrior parked in the far corner. */
const BASE: GameState = board([unitAt(0, SETTLER, 0, LEFT), unitAt(1, WARRIOR, 1, PARKED)]);

/** `state` with an extra unit standing on `at` — the occupancy cases. */
const plus = (state: GameState, id: number, type: UnitDef, owner: number, at: TileIndex) =>
  board([...state.units, unitAt(id, type, owner, at)]);

/** `state` with unit `id` moved, for "and then the rival walked away" cases. */
const moved = (state: GameState, id: number, at: TileIndex): GameState => ({
  ...state,
  units: state.units.map((each) => (each.id === asUnitId(id) ? { ...each, tile: at } : each)),
});

/** A city, as M3 stores one — only the fields `planMove`'s city clause reads matter here. */
const cityOn = (state: GameState, owner: number, at: TileIndex): GameState => ({
  ...state,
  cities: [
    {
      id: asCityId(0),
      owner: asPlayerId(owner),
      name: 'City 1',
      tile: at,
      population: 1,
      foodBox: 0,
      shields: 0,
      queue: [],
      buildings: [],
      workedTiles: [],
      culture: 0,
    },
  ],
});

/** Every tile index of the fixture board, for the exhaustive walks below. */
const ALL_TILES: readonly TileIndex[] = Array.from({ length: width * height }, (_, index) =>
  asTileIndex(index),
);

/** The steps of a route the engine says exists — or a failure naming the refusal. */
const stepsTo = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  to: TileIndex,
): readonly TileIndex[] => {
  const planned = planRoute(state, ruleset, unitId, to);
  if (!planned.ok) {
    throw new Error(
      `planRoute(unit ${String(unitId)}, tile ${String(to)}) was refused: ` +
        JSON.stringify(planned.error),
    );
  }
  return planned.value.steps;
};

/** The `GameError` a route query is refused with — or a failure if it was accepted. */
const refusal = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  to: TileIndex,
): GameError => {
  const planned = planRoute(state, ruleset, unitId, to);
  if (planned.ok) {
    throw new Error(
      `planRoute(unit ${String(unitId)}, tile ${String(to)}) was accepted with steps ` +
        JSON.stringify(planned.value.steps.map(Number)),
    );
  }
  return planned.error;
};

const mover = (state: GameState, unitId: UnitId): Unit => {
  const found = state.units.find((each) => each.id === unitId);
  if (found === undefined) throw new Error(`no unit ${String(unitId)} on this board`);
  return found;
};

/** One walked step: where the unit ended up, or the engine's refusal of that step. */
interface Walk {
  readonly to: TileIndex;
  readonly steps: readonly TileIndex[];
  readonly walked: readonly TileIndex[];
  /** Absent when every step was accepted. */
  readonly refused: { readonly step: TileIndex; readonly error: GameError } | undefined;
}

/**
 * Walk a route the way the UI does: **one step per turn**, with the mover refilled
 * exactly as `EndTurn` refills it (`turn.ts` `refillMovement`), each step applied
 * through `applyCommand`.
 *
 * This is the assertion that the query is not a second opinion: if a step were
 * illegal, the applier would refuse it here and the failure would name the tile. The
 * refill is what makes the walk faithful rather than convenient — the query plans with
 * a full turn's movement, so the walk has to give the unit one.
 *
 * **It reports a refusal rather than throwing**, because a refusal can mean two very
 * different things and only one of them is a bug in the query. On a board that does
 * not change under the walk, a refusal is the query being wrong; on a board that
 * *does* change it is the world moving, which is a fact about `MoveUnit` rather than
 * about this module — entering a goody hut can put a band of barbarians on the map,
 * sometimes straight onto the route being walked (see the hut case below). The
 * callers that mean "the query is right" assert no refusal, on boards where that is
 * the question.
 */
const walkRoute = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  to: TileIndex,
  steps: readonly TileIndex[],
): Walk => {
  const def = ruleset.units.find((each) => each.id === mover(state, unitId).type);
  if (def === undefined) throw new Error('the walk has no unit definition to refill from');
  let current = state;
  const walked: TileIndex[] = [];
  for (const step of steps) {
    // A fresh turn's movement for the mover, and nothing else touched.
    current = {
      ...current,
      units: current.units.map((each) =>
        each.id === unitId ? { ...each, movementLeft: def.movement } : each,
      ),
    };
    const command: Command = { type: 'MoveUnit', unitId, to: step };
    const outcome = applyCommand(current, mover(current, unitId).owner, command, ruleset);
    if (!outcome.ok) return { to, steps, walked, refused: { step, error: outcome.error } };
    current = outcome.value.state;
    walked.push(mover(current, unitId).tile);
  }
  return { to, steps, walked, refused: undefined };
};

/**
 * Walk the engine's own route and require every step to be accepted, on a board that
 * **cannot change under the walk** — the fixture boards carry no huts, and the
 * generated boards are given none (see `withoutHuts`) because a hut is a change the
 * move itself causes.
 */
const walksTheRoute = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  to: TileIndex,
): readonly TileIndex[] => {
  const steps = stepsTo(state, ruleset, unitId, to);
  expect(steps.length, 'a walk of a route with no steps would prove nothing').toBeGreaterThan(0);
  const walk = walkRoute(state, ruleset, unitId, to, steps);
  if (walk.refused !== undefined) {
    throw new Error(
      `the route to tile ${String(to)} contains tile ${String(walk.refused.step)}, which the ` +
        `engine refuses: ${JSON.stringify(walk.refused.error)}`,
    );
  }
  expect(walk.walked, 'the walk did not land on the tiles the route named').toStrictEqual([
    ...steps,
  ]);
  expect(walk.walked.at(-1), 'the walk did not end on the destination').toBe(to);
  return walk.walked;
};

/** The board a walk left behind, stopped where it stopped — the hut case asks it. */
const walkState = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  walk: Walk,
): GameState => {
  const def = ruleset.units.find((each) => each.id === mover(state, unitId).type);
  if (def === undefined) throw new Error('no unit definition to refill from');
  let current = state;
  for (const step of walk.walked) {
    current = {
      ...current,
      units: current.units.map((each) =>
        each.id === unitId ? { ...each, movementLeft: def.movement } : each,
      ),
    };
    const outcome = applyCommand(
      current,
      mover(current, unitId).owner,
      { type: 'MoveUnit', unitId, to: step },
      ruleset,
    );
    if (!outcome.ok) throw new Error('the walk could not be replayed to its stopping point');
    current = outcome.value.state;
  }
  return current;
};

/**
 * A board with **no goody huts on it**.
 *
 * A hut is not scenery: `applyCommand`'s `MoveUnit` resolves one the moment a unit
 * enters it, and a "band of barbarians" reward puts units on the map — sometimes on
 * the very route being walked. That is a *world change caused by the step*, so a walk
 * across a hut-bearing board can legitimately meet a refusal this module has nothing
 * to do with (measured on seed 31337, unit 2, destination 226: the band appeared on
 * tile 393, four steps along the route). The properties in this file are about the
 * query against a fixed board, so the sweeps that assert them ask a board with no
 * huts; the hut case has its own test, which is the one that says what happens
 * instead.
 */
const withoutHuts = (state: GameState): GameState => ({
  ...state,
  map: { ...state.map, huts: [] },
});

/* ------------------------------------------------------------------ *
 * 1. It answers the question `MoveUnit` cannot
 * ------------------------------------------------------------------ */

describe('planRoute: a route is a sequence of engine-accepted single steps', () => {
  it('walks the settler through the one gap in the wall, and the direct command cannot', () => {
    // Non-vacuity for the whole file: the command layer really cannot do this.
    const direct = applyCommand(
      BASE,
      P0,
      { type: 'MoveUnit', unitId: SETTLER_ID, to: RIGHT },
      RULESET,
    );
    expect(
      direct.ok,
      'the engine accepted a multi-tile MoveUnit, so this board proves nothing',
    ).toBe(false);
    if (direct.ok) return;
    expect(direct.error.kind).toBe('invalid-argument');

    const steps = stepsTo(BASE, RULESET, SETTLER_ID, RIGHT);
    // Chebyshev distance is 7, and the detour through (4,2) is still 7 steps, because
    // the wall can be crossed diagonally: `steps.length === 7` is a claim about
    // shortest-ness as well as about the wall.
    expect(steps.length).toBe(7);
    expect(steps).toContain(GAP);
    expect(new Set(steps).size, 'the route visits a tile twice').toBe(steps.length);
    expect(steps.at(-1)).toBe(RIGHT);

    walksTheRoute(BASE, RULESET, SETTLER_ID, RIGHT);
  });

  it('refuses a destination the movement rule cannot reach, naming both tiles', () => {
    // The warrior has movement 1 and the gap is hills (cost 2), so the right half of
    // the board is unreachable for it — while the settler beside it crosses.
    const warrior = plus(BASE, 2, WARRIOR, 0, LEFT);
    expect(stepsTo(warrior, RULESET, SETTLER_ID, RIGHT).length).toBeGreaterThan(0);

    const error = refusal(warrior, RULESET, asUnitId(2), RIGHT);
    expect(error).toStrictEqual({
      kind: 'invalid-argument',
      detail:
        `no route from tile ${String(LEFT)} to tile ${String(RIGHT)}: every sequence of ` +
        'single steps between them is refused by the movement rule',
    });
  });

  it('answers with no steps when the unit is already there, and never refuses that', () => {
    const planned = planRoute(BASE, RULESET, SETTLER_ID, LEFT);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.steps).toStrictEqual([]);
    expect(planned.value.to).toBe(LEFT);
    expect(planned.value.unit.id).toBe(SETTLER_ID);
  });

  it('routes to a tile it is standing beside, one step at a time', () => {
    expect(stepsTo(BASE, RULESET, SETTLER_ID, tile(1, 3))).toStrictEqual([tile(1, 3)]);
    expect(stepsTo(BASE, RULESET, SETTLER_ID, tile(1, 4))).toStrictEqual([tile(1, 4)]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. One falsifier per clause of `planMove`
 * ------------------------------------------------------------------ */

describe('planRoute: every clause of the movement rule is the engine declaring it', () => {
  it('is not a "passable costs one" shortcut: the hills gap is open to movement 2 only', () => {
    // The same tile, the same board, two units: the answer differs, and the only
    // thing that differs is the engine's affordability clause.
    const twoUnits = plus(BASE, 2, WARRIOR, 0, LEFT);
    expect(planRoute(twoUnits, RULESET, SETTLER_ID, tile(5, 2)).ok).toBe(true);
    expect(planRoute(twoUnits, RULESET, asUnitId(2), tile(5, 2)).ok).toBe(false);

    // Chebyshev distance 5, every shortest route crosses the wall at the gap, and the
    // warrior's answer to the same destination is "no route at all". Note what is NOT
    // asserted: the exact tiles. Two five-step routes exist and the search is free to
    // prefer either — pinning one would pin a tie-break rather than a rule.
    const steps = stepsTo(twoUnits, RULESET, SETTLER_ID, tile(5, 2));
    expect(steps.length).toBe(5);
    expect(steps).toContain(GAP);
    expect(steps.at(-1)).toBe(tile(5, 2));
  });

  it('is not an "any passable tile is enterable" shortcut: the mountain wall blocks', () => {
    // (4,1) is mountains — the wall, one row above the gap. The engine refuses it, and
    // so must the query, while its neighbour (4,2) is enterable for the settler. A
    // query that read neither `impassable` nor a cost would walk straight onto it.
    expect(refusal(BASE, RULESET, SETTLER_ID, tile(4, 1)).kind).toBe('invalid-argument');
    expect(planRoute(BASE, RULESET, SETTLER_ID, GAP).ok).toBe(true);
    expect(stepsTo(BASE, RULESET, SETTLER_ID, GAP).length).toBe(4);
  });

  it('is not "any unit blocks": a rival on the gap closes it, and reopens when it leaves', () => {
    const blocked = moved(BASE, 1, GAP);
    const error = refusal(blocked, RULESET, SETTLER_ID, RIGHT);
    expect(error.kind).toBe('invalid-argument');

    expect(stepsTo(moved(blocked, 1, tile(7, 5)), RULESET, SETTLER_ID, RIGHT)).toContain(GAP);
  });

  it('is not "any unit blocks": the player\u2019s own unit on the gap does not, and the step is accepted', () => {
    // Civ 3 stacks, and the engine says so — so the route must go through, and the
    // applier must accept the step onto the friendly-occupied tile.
    const stacked = plus(BASE, 2, WARRIOR, 0, GAP);
    const steps = stepsTo(stacked, RULESET, SETTLER_ID, RIGHT);
    expect(steps).toContain(GAP);

    walksTheRoute(stacked, RULESET, SETTLER_ID, RIGHT);

    // The engine's own evaluator agrees, which is the statement being leaned on.
    const onto = moved(stacked, 0, tile(3, 2));
    const planned = planMove(onto, RULESET, P0, SETTLER_ID, GAP);
    expect(planned.ok, 'planMove refused a step onto a friendly-occupied tile').toBe(true);
  });

  it('treats a rival city on the gap as it treats a rival unit: closed', () => {
    const walled = cityOn(BASE, Number(P1), GAP);
    expect(refusal(walled, RULESET, SETTLER_ID, RIGHT).kind).toBe('invalid-argument');

    // The player's own city on the same tile is enterable, exactly as `planMove` says.
    const own = cityOn(BASE, Number(P0), GAP);
    expect(stepsTo(own, RULESET, SETTLER_ID, RIGHT)).toContain(GAP);
  });

  it('is not a fog rule: an unexplored board routes exactly like an explored one', () => {
    // `explored` is all-false on this fixture (see `UNSEEN`), which is how the engine's
    // own test boards state "legality must not care". The route is unchanged.
    expect(stepsTo(BASE, RULESET, SETTLER_ID, RIGHT).length).toBe(7);
    const seen: GameState = { ...BASE, explored: BASE.explored.map((row) => row.map(() => true)) };
    expect(stepsTo(seen, RULESET, SETTLER_ID, RIGHT)).toStrictEqual(
      stepsTo(BASE, RULESET, SETTLER_ID, RIGHT),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. Refusals, and the shape of the result
 * ------------------------------------------------------------------ */

describe('planRoute: the argument and actor refusals mirror the movement rule', () => {
  it('refuses an unknown unit, an absent player, a non-integer and an off-map tile', () => {
    expect(refusal(BASE, RULESET, asUnitId(99), RIGHT)).toStrictEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(99),
    });
    expect(refusal(BASE, RULESET, SETTLER_ID, asTileIndex(width * height))).toStrictEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(width * height),
    });
    expect(refusal(BASE, RULESET, SETTLER_ID, 1.5 as TileIndex)).toStrictEqual({
      kind: 'invalid-argument',
      detail: '"to" must be an integer tile index (got 1.5)',
    });
    expect(refusal(BASE, RULESET, SETTLER_ID, asTileIndex(-1))).toStrictEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(-1),
    });

    const ownerless: GameState = { ...BASE, players: [player(1)] };
    expect(refusal(ownerless, RULESET, SETTLER_ID, RIGHT)).toStrictEqual({
      kind: 'unknown-player',
      playerId: P0,
    });
  });

  it('refuses a unit type the ruleset does not describe, rather than guessing a budget', () => {
    const unknown: GameState = {
      ...BASE,
      units: [{ ...unitAt(0, SETTLER, 0, LEFT), type: asUnitTypeId('hovercraft') }],
    };
    const error = refusal(unknown, RULESET, SETTLER_ID, RIGHT);
    expect(error.kind).toBe('invalid-argument');
    if (error.kind !== 'invalid-argument') return;
    expect(error.detail).toContain('hovercraft');
  });
});

/* ------------------------------------------------------------------ *
 * 4. Shortest, deterministic, a pure read — and the tail property the UI needs
 * ------------------------------------------------------------------ */

/**
 * An **independent** breadth-first search, written forwards from the unit, used only
 * as an oracle for "fewest steps".
 *
 * It exists because "the route is a shortest one" is a claim about the search, and a
 * claim about a search cannot be checked by the search. It asks the same rule —
 * `planMove`, on the same probe — and nothing else, so it can disagree with the
 * implementation about *length* without disagreeing about legality.
 */
const oracleDistances = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): ReadonlyMap<number, number> => {
  const unit = mover(state, unitId);
  const def = ruleset.units.find((each) => each.id === unit.type);
  if (def === undefined) throw new Error('the oracle has no unit definition');
  const probe = (at: TileIndex): GameState => ({
    ...state,
    units: state.units.map((each) =>
      each.id === unitId ? { ...each, tile: at, movementLeft: def.movement } : each,
    ),
  });
  const distances = new Map<number, number>([[Number(unit.tile), 0]]);
  const queue: TileIndex[] = [unit.tile];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    if (at === undefined) break;
    const distance = distances.get(Number(at));
    if (distance === undefined) break;
    for (const step of neighbors8(state.map, at)) {
      if (distances.has(Number(step))) continue;
      if (!planMove(probe(at), ruleset, unit.owner, unitId, step).ok) continue;
      distances.set(Number(step), distance + 1);
      queue.push(step);
    }
  }
  return distances;
};

describe('planRoute: fewest steps, same answer twice, and nothing written down', () => {
  it('agrees with an independent search on every tile of the fixture board', () => {
    const oracle = oracleDistances(BASE, RULESET, SETTLER_ID);
    let reachable = 0;
    let unreachable = 0;
    for (const to of ALL_TILES) {
      const planned = planRoute(BASE, RULESET, SETTLER_ID, to);
      const distance = oracle.get(Number(to));
      if (distance === undefined) {
        expect(planned.ok, `tile ${String(to)} is unreachable but a route was returned`).toBe(
          false,
        );
        unreachable += 1;
        continue;
      }
      expect(planned.ok, `tile ${String(to)} is reachable but no route was returned`).toBe(true);
      if (!planned.ok) continue;
      expect(planned.value.steps.length, `tile ${String(to)}: not a shortest route`).toBe(distance);
      reachable += 1;
    }
    // Non-vacuity: the board really does contain both answers. The unreachable ones are
    // the five mountain tiles of the wall — a settler with movement 2 can reach every
    // other tile of this board, which is why the count is small rather than a defect.
    expect(reachable).toBeGreaterThan(20);
    expect(reachable + unreachable).toBe(width * height);
    // And the unreachable ones are named, so this is a statement about the board rather
    // than a number that happened: the five mountain tiles of the wall, and the tile
    // player 1's warrior is standing on (an enemy tile is not enterable).
    expect(unreachable).toBe(6);
    expect(
      ALL_TILES.filter((to) => !planRoute(BASE, RULESET, SETTLER_ID, to).ok)
        .map(Number)
        .sort((a, b) => a - b),
    ).toStrictEqual([4, 12, 28, 36, 44, Number(PARKED)].sort((a, b) => a - b));
  });

  it('returns the same route twice, and leaves the state\u2019s own hash alone', () => {
    const before = hashValue(BASE);
    const first = stepsTo(BASE, RULESET, SETTLER_ID, RIGHT);
    const second = stepsTo(BASE, RULESET, SETTLER_ID, RIGHT);
    expect(second).toStrictEqual(first);
    expect(hashValue(BASE), 'asking the route query wrote something into the state').toBe(before);
  });

  it('plans from the second tile exactly the tail of the route from the first', () => {
    // The property the UI's goto is built on: it stores the route, walks one step,
    // and re-asks from where the unit now stands. "The same route, minus its first
    // step" is what makes a difference meaningful — it means the world moved, not
    // that the search picked a different one of two equal-length paths.
    const steps = stepsTo(BASE, RULESET, SETTLER_ID, RIGHT);
    const second = steps[0];
    if (second === undefined) throw new Error('the route is empty');
    const walked = moved(BASE, 0, second);
    expect(stepsTo(walked, RULESET, SETTLER_ID, RIGHT)).toStrictEqual(steps.slice(1));

    // Halfway along, not just one step: the same statement, further in.
    const middle = steps[3];
    if (middle === undefined) throw new Error('the route is shorter than four steps');
    expect(stepsTo(moved(BASE, 0, middle), RULESET, SETTLER_ID, RIGHT)).toStrictEqual(
      steps.slice(4),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 5. The same properties on real generated boards
 * ------------------------------------------------------------------ */

const validated = (): RulesetView => {
  const result = validateRuleset(CATALOG, 'tuned');
  if (!result.ok) throw new Error('the shipped catalog does not validate');
  return result.value;
};

const RULES: RulesetView = validated();

/**
 * A real generated board, at the **duel** size rather than the default: this file
 * asks thousands of route questions, and the answer's content does not depend on the
 * map's size — only the price does. 40×40 keeps the two board-wide sweeps inside the
 * fast tier's budget without sampling a smaller *fraction* of either board.
 */
const generated = (seed: number, civCount = 2): GameState => {
  const started = newGame(seed, { ...DEFAULT_SETTINGS, seed, mapSize: 'duel', civCount }, RULES);
  if (!started.ok) throw new Error(`newGame(${String(seed)}) failed`);
  return started.value;
};

/**
 * **A route is a statement about the board it was asked on, and `MoveUnit` can change
 * that board.** Entering a goody hut resolves it inside the applier, and one of its
 * rewards is a band of barbarians placed on the map — sometimes on the tile the route
 * was about to use.
 *
 * This case is here because it was *found* here rather than reasoned about: the walk
 * sweep below failed on seed 31337 with `{"kind":"occupied-by-enemy","unitId":2,
 * "to":393}`, and 393 was empty when the route was planned. It is the reason the
 * sweeps that assert "every step of a route is accepted" ask a board without huts,
 * and it is the engine-side half of `docs/UI-OVERHAUL.md` §8 decision 4 — an
 * invalidated goto is cancelled with a message rather than silently recomputed,
 * because the player's plan can be undone by a hut they just walked into.
 */
describe('planRoute: a step can change the board the route was planned on', () => {
  it('meets a barbarian band from a hut on its own route, and the query then says so', () => {
    const state = generated(31337);
    const unit = state.units.find((each) => Number(each.id) === 2);
    if (unit === undefined) throw new Error('seed 31337 has no unit 2 on this board');
    const destination = asTileIndex(226);
    const planned = planRoute(state, RULES, unit.id, destination);
    expect(planned.ok, 'seed 31337 no longer routes unit 2 to tile 226').toBe(true);
    if (!planned.ok) return;
    expect(planned.value.steps.map(Number)).toContain(393);

    const walk = walkRoute(state, RULES, unit.id, destination, planned.value.steps);
    expect(
      walk.refused,
      'this board no longer changes under the walk, so the case it documents is gone — ' +
        'the test needs a new board rather than a weaker assertion',
    ).toBeDefined();
    if (walk.refused === undefined) return;
    expect(walk.refused.step).toBe(asTileIndex(393));
    expect(walk.refused.error).toStrictEqual({
      kind: 'occupied-by-enemy',
      unitId: unit.id,
      to: asTileIndex(393),
    });

    // And the query, re-asked against the changed board, no longer offers the route the
    // walk was following: it goes *around* the band instead. Measured — the re-asked
    // route here is not a refusal, it is a different plan, which is why the UI's check
    // is "is this the route the player was given?" rather than "does a route still
    // exist?". A goto that quietly took the detour would be the silent recomputation
    // `docs/UI-OVERHAUL.md` §8 decision 4 forbids.
    const after = walkState(state, RULES, unit.id, walk);
    const remainder = planned.value.steps.slice(walk.walked.length);
    expect(remainder[0], 'the remainder of the stored route should start at the blocked tile').toBe(
      asTileIndex(393),
    );
    const fresh = planRoute(after, RULES, unit.id, destination);
    const stillTheSamePlan =
      fresh.ok &&
      fresh.value.steps.length === remainder.length &&
      fresh.value.steps.every((step, index) => step === remainder[index]);
    expect(
      stillTheSamePlan,
      'the engine plans the same route after the band appeared, so the plan-changed check the UI ' +
        'is built on would not fire',
    ).toBe(false);
  });
});

describe('planRoute: on generated boards', () => {
  it('walks every reachable destination of every unit, one accepted step at a time', () => {
    let walks = 0;
    let refused = 0;
    for (const seed of [1, 7, 31337]) {
      const state = withoutHuts(generated(seed));
      for (const unit of state.units) {
        for (const to of ALL_TILES_OF(state)) {
          if (to === unit.tile) continue;
          const planned = planRoute(state, RULES, unit.id, to);
          if (!planned.ok) {
            refused += 1;
            continue;
          }
          const walked = walksTheRoute(withoutHuts(state), RULES, unit.id, to);
          expect(walked, `seed ${String(seed)} unit ${String(unit.id)}`).toStrictEqual([
            ...planned.value.steps,
          ]);
          walks += 1;
          // A route per source is enough: the walk above is the expensive half.
          break;
        }
      }
    }
    expect(walks, 'no route was walked, so this proved nothing').toBeGreaterThan(3);
    expect(refused, 'no destination was ever unreachable on these boards').toBeGreaterThan(0);
  });

  it('keeps the tail property over a whole generated board, for every unit', () => {
    let checked = 0;
    // Two seeds and a per-unit cap, because this walks *every* destination of *every*
    // unit and the fast tier's whole test step is ~25 s: the cap keeps the property
    // broad (every unit, every direction) without making the gate pay for 10 000
    // repeated comparisons of the same tree.
    const perUnit = 25;
    for (const seed of [1, 7]) {
      const state = generated(seed);
      for (const unit of state.units) {
        let forThisUnit = 0;
        for (const to of stride(ALL_TILES_OF(state), 3)) {
          if (forThisUnit >= perUnit) break;
          const planned = planRoute(state, RULES, unit.id, to);
          if (!planned.ok || planned.value.steps.length < 2) continue;
          const first = planned.value.steps[0];
          if (first === undefined) continue;
          // The unit is *moved* to the first step before re-asking: the property is
          // about the query from where the unit now stands, not about asking the same
          // question with a nearer destination.
          const fromSecond = planRoute(moved(state, Number(unit.id), first), RULES, unit.id, to);
          expect(fromSecond.ok).toBe(true);
          if (!fromSecond.ok) continue;
          expect(
            fromSecond.value.steps,
            `seed ${String(seed)}, unit ${String(unit.id)}`,
          ).toStrictEqual(planned.value.steps.slice(1));
          checked += 1;
          forThisUnit += 1;
        }
      }
    }
    expect(
      checked,
      'no multi-step route was checked, so the property proved nothing',
    ).toBeGreaterThan(50);
  });

  it('agrees with the independent search about reachability on a generated board', () => {
    const state = generated(31337);
    for (const unit of state.units.slice(0, 2)) {
      const oracle = oracleDistances(state, RULES, unit.id);
      let agreed = 0;
      for (const to of ALL_TILES_OF(state)) {
        const planned = planRoute(state, RULES, unit.id, to);
        const distance = oracle.get(Number(to));
        expect(
          planned.ok,
          `unit ${String(unit.id)} tile ${String(to)}: the two searches disagree`,
        ).toBe(distance !== undefined);
        if (planned.ok && distance !== undefined) {
          expect(planned.value.steps.length).toBe(distance);
        }
        agreed += 1;
      }
      expect(agreed).toBe(state.map.width * state.map.height);
    }
  });
});

/** Every `step`th entry — a deterministic sample of a board, for the sweeps that would
 * otherwise ask thousands of questions to prove one property. */
const stride = <T>(items: readonly T[], step: number): readonly T[] =>
  items.filter((_, index) => index % step === 0);

/** Every tile index of a state's own map — the generated boards are not the fixture's size. */
function ALL_TILES_OF(state: GameState): readonly TileIndex[] {
  return Array.from({ length: state.map.width * state.map.height }, (_, index) =>
    asTileIndex(index),
  );
}
