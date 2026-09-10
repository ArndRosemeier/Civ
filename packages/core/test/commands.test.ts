/**
 * `applyCommand` — movement, refusals, purity and the turn advance
 * (docs/INTERFACES.md M2, "Core — commands, errors, legal actions").
 *
 * The board is hand-built rather than generated so every assertion reads as "on
 * this map, that command gives this answer": tile indices are `y * 4 + x`, and
 * the terrain costs and blockers are visible at the top of the file.
 *
 * The fixture's `explored` rows are entirely `false` on purpose: M2 leaves fog
 * out of the legality rule, so every movement assertion below is also evidence
 * that legality does not consult what a player has seen.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  planMove,
  type Command,
  type CommandOutcome,
  type GameError,
} from '../src/commands.js';
import { isExplored } from '../src/fog.js';
import {
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type PlayerId,
} from '../src/ids.js';
import type { GameMap, RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { isOk, type Result } from '../src/result.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { SCHEMA_VERSION, type GameState, type PlayerState } from '../src/state.js';
import type { Unit, UnitDef, UnitRole } from '../src/units.js';

/** Move cost per role; ocean/coast/mountains are impassable. */
const TERRAIN_ROWS: readonly (readonly [TerrainRole, number, boolean])[] = [
  ['ocean', 1, true],
  ['coast', 1, true],
  ['grassland', 1, false],
  ['plains', 1, false],
  ['hills', 2, false],
  ['mountains', 3, true],
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
 * The board (row-major, width 4):
 *
 * ```text
 *   ocean      hills      mountains  coast       0  1  2  3
 *   grassland  grassland  grassland  plains      4  5  6  7
 *   grassland  hills      grassland  grassland   8  9 10 11
 *   coast      grassland  grassland  mountains  12 13 14 15
 * ```
 *
 * Unit 0 (player 0's settler) stands on 5, so its neighbours exercise every
 * refusal at once: 0 and 2 are impassable, 6 holds player 1's warrior, 1 and 9
 * are hills (cost 2), and 4, 8 and 10 are affordable grassland — 10 being
 * occupied by player 0's own scout.
 */
const TERRAIN_GRID: readonly TerrainRole[] = [
  'ocean',
  'hills',
  'mountains',
  'coast',
  'grassland',
  'grassland',
  'grassland',
  'plains',
  'grassland',
  'hills',
  'grassland',
  'grassland',
  'coast',
  'grassland',
  'grassland',
  'mountains',
];

const MAP: GameMap = {
  width: 4,
  height: 4,
  terrain: TERRAIN_GRID.map((role) => asTerrainId(role)),
};

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
const SCOUT = makeDef('scout', 'scout', 3);
const WARRIOR = makeDef('warrior', 'military', 2);

/** The engine's view of a ruleset: terrain *and* a unit catalog (both required). */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, SCOUT, WARRIOR],
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (index: number, startingTile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(startingTile),
});

const unit = (
  id: number,
  type: UnitDef,
  owner: number,
  tile: number,
  movementLeft: number,
): Unit => ({
  id: asUnitId(id),
  type: type.id,
  owner: asPlayerId(owner),
  tile: asTileIndex(tile),
  movementLeft,
});

/** Nothing explored anywhere: legality must not care (see the file header). */
const UNSEEN: readonly boolean[] = Array.from({ length: 16 }, () => false);

/** Player 0's settler on 5 (movement 2), its scout on 10 (spent), player 1's warrior on 6 (spent). */
const STATE: GameState = {
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0, 5), player(1, 6)],
  nextUnitId: 3,
  units: [
    unit(0, SETTLER, 0, 5, SETTLER.movement),
    unit(1, SCOUT, 0, 10, 0),
    unit(2, WARRIOR, 1, 6, 0),
  ],
  explored: [UNSEEN, UNSEEN],
};

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);

const move = (unitId: number, to: number): Command => ({
  type: 'MoveUnit',
  unitId: asUnitId(unitId),
  to: asTileIndex(to),
});

const END_TURN: Command = { type: 'EndTurn' };

/** `applyCommand` with the ruleset the engine is evaluated against. */
const apply = (
  state: GameState,
  playerId: PlayerId,
  cmd: Command,
): Result<CommandOutcome, GameError> => applyCommand(state, playerId, cmd, RULESET);

const mustOk = (result: Result<CommandOutcome, GameError>): CommandOutcome => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const errorOf = <T>(result: Result<T, GameError>): GameError => {
  if (result.ok) throw new Error('expected the command to be refused');
  return result.error;
};

const refusedAs = <T>(result: Result<T, GameError>, kind: GameError['kind']): GameError => {
  const error = errorOf(result);
  expect(error.kind).toBe(kind);
  return error;
};

/** The detail of an `invalid-argument` refusal, with the kind asserted first. */
const detailOf = <T>(result: Result<T, GameError>): string => {
  const error = refusedAs(result, 'invalid-argument');
  if (error.kind !== 'invalid-argument') throw new Error('unreachable');
  return error.detail;
};

const withMovement = (state: GameState, unitId: number, movementLeft: number): GameState => ({
  ...state,
  units: state.units.map((u) => (u.id === asUnitId(unitId) ? { ...u, movementLeft } : u)),
});

const movementLeftOf = (state: GameState, unitId: number): number | undefined =>
  state.units.find((u) => u.id === asUnitId(unitId))?.movementLeft;

const tileOf = (state: GameState, unitId: number): number | undefined => {
  const found = state.units.find((u) => u.id === asUnitId(unitId));
  return found === undefined ? undefined : Number(found.tile);
};

/** Ascending tile indices a row has marked explored. */
const exploredIndices = (row: readonly boolean[] | undefined): number[] =>
  row === undefined ? [] : row.map((isSeen, index) => (isSeen ? index : -1)).filter((i) => i >= 0);

/** An explored row of this 4x4 board with `tiles` marked. */
const markedExplored = (tiles: readonly number[]): readonly boolean[] =>
  Array.from({ length: 16 }, (_, index) => tiles.includes(index));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Freeze a state graph so any mutation throws (ESM is strict mode). */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

describe('applyCommand — MoveUnit', () => {
  it('moves a unit one step onto adjacent grassland and pays its cost', () => {
    const outcome = mustOk(apply(STATE, P0, move(0, 4)));

    expect(tileOf(outcome.state, 0)).toBe(4);
    expect(movementLeftOf(outcome.state, 0)).toBe(SETTLER.movement - 1);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    expect(outcome.state.turn).toBe(STATE.turn);
    expect(outcome.events).toEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: asTileIndex(5),
        to: asTileIndex(4),
        cost: 1,
        movementLeft: 1,
      },
    ]);
  });

  it("pays the destination tile's cost, not the origin's", () => {
    // Origin (5) and destination (1) differ by design: grassland costs 1, hills 2.
    const outcome = mustOk(apply(STATE, P0, move(0, 1)));

    expect(tileOf(outcome.state, 0)).toBe(1);
    expect(movementLeftOf(outcome.state, 0)).toBe(0);
    expect(outcome.events[0]).toMatchObject({ cost: 2, movementLeft: 0 });
  });

  it('touches nothing but the mover, the revision and the explored layer', () => {
    const outcome = mustOk(apply(STATE, P0, move(0, 4)));

    expect(outcome.state.map).toBe(STATE.map);
    expect(outcome.state.players).toBe(STATE.players);
    expect(outcome.state.settings).toBe(STATE.settings);
    expect(outcome.state.rng).toBe(STATE.rng);
    expect(outcome.state.seed).toBe(STATE.seed);
    expect(outcome.state.nextUnitId).toBe(STATE.nextUnitId);
    expect(outcome.state.units).not.toBe(STATE.units);
    expect(outcome.state.units.slice(1)).toEqual(STATE.units.slice(1));
  });

  it("folds what the mover can now see into its explored row, and nobody else's", () => {
    // One unit on the board, so the folded sight is exactly the mover's own.
    const solo: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 5, 2)] };
    const outcome = mustOk(apply(solo, P0, move(0, 4)));

    // Tile 4 is (0, 1): the radius-2 box covers x in {0, 1, 2} (x = -2 and -1 are
    // off the board) and every y, i.e. these twelve tiles.
    expect(exploredIndices(outcome.state.explored[0])).toEqual([
      0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14,
    ]);
    expect(outcome.state.explored[1]).toBe(UNSEEN);
    // The input's rows are untouched: explored is folded into the new state only.
    expect(solo.explored[0]?.some(Boolean)).toBe(false);
    // Visibility is derived from every unit the player owns, so the scout's
    // sight (radius 2 around tile 10, i.e. the whole 4x4 board) joins memory too.
    expect(exploredIndices(mustOk(apply(STATE, P0, move(0, 4))).state.explored[0])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('makes the destination visible to the mover, seen through fog.isExplored', () => {
    const solo: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 5, 2)] };
    expect(isExplored(solo, P0, asTileIndex(4))).toBe(false);

    const outcome = mustOk(apply(solo, P0, move(0, 4)));

    expect(isExplored(outcome.state, P0, asTileIndex(4))).toBe(true);
    expect(isExplored(outcome.state, P0, asTileIndex(15))).toBe(false);
    // Fog is per player: nothing the mover did is known to anyone else.
    expect(isExplored(outcome.state, P1, asTileIndex(4))).toBe(false);
  });

  it('never un-explores a tile: memory only grows', () => {
    const remembered: GameState = { ...STATE, explored: [markedExplored([15]), UNSEEN] };
    const outcome = mustOk(apply(remembered, P0, move(0, 8)));

    const row = outcome.state.explored[0];
    expect(row?.[15]).toBe(true); // the corner the settler walked away from
    expect(row?.[8]).toBe(true); // where it now stands
    expect(outcome.state.explored[1]).toBe(UNSEEN); // the other player saw nothing
  });

  it("allows stepping onto a tile held by the same player's units (Civ 3 stacks)", () => {
    const outcome = mustOk(apply(STATE, P0, move(0, 10)));

    expect(tileOf(outcome.state, 0)).toBe(10);
    expect(outcome.state.units.filter((u) => u.tile === asTileIndex(10))).toHaveLength(2);
  });
});

describe('applyCommand — refusals', () => {
  it('refuses an impassable destination', () => {
    expect(refusedAs(apply(STATE, P0, move(0, 2)), 'impassable')).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: asTileIndex(2),
    });
    expect(refusedAs(apply(STATE, P0, move(0, 0)), 'impassable')).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: asTileIndex(0),
    });
  });

  it('refuses an unaffordable destination, reporting what is needed and available', () => {
    const poor = withMovement(STATE, 0, 1);
    expect(refusedAs(apply(poor, P0, move(0, 1)), 'not-enough-movement')).toEqual({
      kind: 'not-enough-movement',
      unitId: asUnitId(0),
      needed: 2,
      available: 1,
    });
    // A unit that has spent everything cannot enter even a cost-1 tile.
    expect(refusedAs(apply(STATE, P0, move(1, 13)), 'not-enough-movement')).toEqual({
      kind: 'not-enough-movement',
      unitId: asUnitId(1),
      needed: 1,
      available: 0,
    });
  });

  it('refuses a tile held by another player, without resolving combat', () => {
    expect(refusedAs(apply(STATE, P0, move(0, 6)), 'occupied-by-enemy')).toEqual({
      kind: 'occupied-by-enemy',
      unitId: asUnitId(0),
      to: asTileIndex(6),
    });
    // The blocker is a wall, not a target: nothing about it changes, and M2
    // never half-implements an attack (combat is M6).
    expect(tileOf(STATE, 2)).toBe(6);
    expect(movementLeftOf(STATE, 2)).toBe(0);
  });

  it('refuses a unit id that does not exist', () => {
    expect(refusedAs(apply(STATE, P0, move(99, 4)), 'unknown-unit')).toEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(99),
    });
  });

  it('refuses a player id that does not exist', () => {
    const ghost = asPlayerId(7);
    expect(refusedAs(apply(STATE, ghost, move(0, 4)), 'unknown-player')).toEqual({
      kind: 'unknown-player',
      playerId: ghost,
    });
    expect(refusedAs(apply(STATE, ghost, END_TURN), 'unknown-player')).toEqual({
      kind: 'unknown-player',
      playerId: ghost,
    });
  });

  it("refuses another player's unit rather than applying it quietly", () => {
    expect(refusedAs(apply(STATE, P1, move(0, 4)), 'not-your-unit')).toEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(0),
      owner: P0,
    });
    expect(tileOf(STATE, 0)).toBe(5);
  });

  it('refuses a destination off the map', () => {
    expect(refusedAs(apply(STATE, P0, move(0, 16)), 'out-of-bounds')).toEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(16),
    });
    expect(refusedAs(apply(STATE, P0, move(0, -1)), 'out-of-bounds')).toEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(-1),
    });
  });

  it('refuses a non-adjacent destination instead of finding a path (M2 is single-step)', () => {
    // Tile 15 is two tiles away from 5: reachable only by chaining steps, and
    // the refusal must say so rather than silently expanding a path.
    expect(detailOf(apply(STATE, P0, move(0, 15)))).toContain('adjacent');
    expect(tileOf(STATE, 0)).toBe(5);
  });

  it('refuses a destination that is not a tile at all', () => {
    expect(detailOf(apply(STATE, P0, move(0, 5)))).toContain('adjacent'); // staying put
    expect(detailOf(apply(STATE, P0, move(0, 1.5)))).toContain('integer');
    expect(detailOf(apply(STATE, P0, move(0, Number.NaN)))).toContain('integer');
  });
});

describe('applyCommand — the RulesetView argument is required', () => {
  /**
   * The amended contract (INTERFACES.md M2, "Amendment (post-review, binding)"):
   * `applyCommand` takes its ruleset as a **required** fourth parameter.
   *
   * This is the whole point of the amendment, so the assertion is a *type* one.
   * The directive below suppresses a real error — a four-parameter function is
   * not callable as a three-argument one — and if that parameter ever became
   * optional again, the directive would suppress nothing and `pnpm typecheck`
   * would fail with "Unused '@ts-expect-error' directive". An optional parameter
   * that refuses at runtime is the trap: the typechecker cannot catch it and
   * every command silently fails.
   */
  // @ts-expect-error applyCommand requires the ruleset as its fourth argument
  const applyWithThreeArguments: (state: GameState, playerId: PlayerId, cmd: Command) => unknown =
    applyCommand;

  it('is enforced by the compiler, not by a runtime refusal', () => {
    // The old implementation shipped a `missing-ruleset` refusal path that could
    // only ever fire on a call the compiler now rejects outright. Nothing about
    // the arity is left to runtime: `applyCommand` is the same function, and the
    // three-argument spelling above does not typecheck.
    expect(typeof applyWithThreeArguments).toBe('function');
    expect(applyCommand.length).toBe(4);
  });
});

describe('applyCommand — purity and revision', () => {
  it('never mutates a deeply frozen state and bumps revision exactly once', () => {
    const snapshot = structuredClone(STATE);
    deepFreeze(STATE);

    for (const cmd of [move(0, 4), move(0, 1), END_TURN]) {
      const outcome = mustOk(apply(STATE, P0, cmd));
      expect(outcome.state).not.toBe(STATE);
      expect(outcome.state.revision).toBe(STATE.revision + 1);
    }

    expect(STATE).toEqual(snapshot);
  });

  it('increases revision by one per applied command', () => {
    const first = mustOk(apply(STATE, P0, move(0, 4)));
    const second = mustOk(apply(first.state, P0, move(0, 8)));

    expect(STATE.revision).toBe(0);
    expect(first.state.revision).toBe(1);
    expect(second.state.revision).toBe(2);
  });

  it('leaves the state untouched when a command is refused', () => {
    const snapshot = structuredClone(STATE);
    deepFreeze(STATE);

    const refusals: readonly Command[] = [
      move(99, 4),
      move(2, 4),
      move(0, 2),
      move(0, 16),
      move(0, 15),
      move(0, 1.5),
      move(0, 6),
    ];
    for (const cmd of refusals) {
      expect(apply(STATE, P0, cmd).ok).toBe(false);
      expect(STATE.revision).toBe(0);
      expect(STATE).toEqual(snapshot);
    }

    expect(apply(STATE, asPlayerId(7), END_TURN).ok).toBe(false);
    expect(STATE.turn).toBe(1);
    expect(STATE).toEqual(snapshot);
  });
});

describe('applyCommand — EndTurn', () => {
  it("refills every unit to its type's movement and advances the turn", () => {
    const outcome = mustOk(apply(STATE, P0, END_TURN));

    expect(outcome.state.turn).toBe(STATE.turn + 1);
    expect(outcome.state.revision).toBe(STATE.revision + 1);
    expect(movementLeftOf(outcome.state, 0)).toBe(SETTLER.movement);
    expect(movementLeftOf(outcome.state, 1)).toBe(SCOUT.movement);
    expect(movementLeftOf(outcome.state, 2)).toBe(WARRIOR.movement);
    expect(outcome.events).toEqual([{ type: 'TurnEnded', playerId: P0, turn: 2 }]);
  });

  it('restores movement that a move spent, keeping the unit where it stands', () => {
    const moved = mustOk(apply(STATE, P0, move(0, 1))).state;
    expect(movementLeftOf(moved, 0)).toBe(0);

    const next = mustOk(apply(moved, P0, END_TURN)).state;
    expect(movementLeftOf(next, 0)).toBe(SETTLER.movement);
    expect(tileOf(next, 0)).toBe(1);
  });

  it('is total: a unit type the ruleset does not define does not block the turn', () => {
    // A hand-built state (or a save, or a foreign view) can hold a unit type no
    // ruleset defines. There is no honest movement budget to guess for it, and
    // refusing the whole turn would contradict `legalActions`, which yields
    // `EndTurn` for every real player — so the unit is carried over untouched and
    // the turn still advances.
    const ghost = { ...SETTLER, id: asUnitTypeId('ghost') };
    const withGhost: GameState = {
      ...STATE,
      nextUnitId: 2,
      units: [unit(0, ghost, 0, 5, 0), unit(1, SCOUT, 0, 10, 1)],
    };

    const outcome = mustOk(apply(withGhost, P0, END_TURN));

    expect(outcome.state.turn).toBe(withGhost.turn + 1);
    expect(outcome.state.revision).toBe(withGhost.revision + 1);
    expect(movementLeftOf(outcome.state, 0)).toBe(0); // unresolvable: left alone
    expect(tileOf(outcome.state, 0)).toBe(5);
    expect(movementLeftOf(outcome.state, 1)).toBe(SCOUT.movement); // resolvable: refilled
    expect(outcome.events).toEqual([{ type: 'TurnEnded', playerId: P0, turn: 2 }]);
    // Nothing was mutated in place: the input keeps its spent movement.
    expect(movementLeftOf(withGhost, 1)).toBe(1);
  });

  it('refills a resolvable unit even when an unresolvable one is present', () => {
    const ghost = { ...SCOUT, id: asUnitTypeId('ghost') };
    const withGhost: GameState = {
      ...STATE,
      units: [...STATE.units, unit(3, ghost, 1, 10, 0)],
      nextUnitId: 4,
    };

    const outcome = mustOk(apply(withGhost, P1, END_TURN));

    expect(outcome.state.units.map((u) => u.movementLeft)).toEqual([
      SETTLER.movement,
      SCOUT.movement,
      WARRIOR.movement,
      0, // the ghost keeps what it had
    ]);
  });

  it('is not blocked by fog: an unlit board still ends its turn', () => {
    const outcome = mustOk(apply(STATE, P0, END_TURN));
    expect(outcome.state.explored[0]?.some(Boolean)).toBe(false);
    expect(outcome.state.turn).toBe(2);
  });
});

describe('planMove', () => {
  it('reports the unit and the cost of a legal step', () => {
    const plan = planMove(STATE, RULESET, P0, asUnitId(0), asTileIndex(1));
    expect(isOk(plan)).toBe(true);
    if (!plan.ok) throw new Error('unreachable');

    expect(plan.value.cost).toBe(2);
    expect(plan.value.unit.id).toBe(asUnitId(0));
    expect(plan.value.to).toBe(asTileIndex(1));
    // The doc's four-argument form names the cost and the movement left over.
    expect(plan.value.movementLeft).toBe(SETTLER.movement - 2);
  });

  it('publishes the documented four-argument form, acting as the unit owner', () => {
    // `planMove(state, ruleset, unitId, to)` — INTERFACES.md M2's signature. The
    // acting player is the unit's owner, so it agrees with the explicit-actor
    // form the engine uses internally, and it is the same evaluator either way.
    const documented = planMove(STATE, RULESET, asUnitId(0), asTileIndex(1));
    const explicit = planMove(STATE, RULESET, P0, asUnitId(0), asTileIndex(1));

    expect(documented).toEqual(explicit);
    expect(documented.ok).toBe(true);

    // An unknown unit is a refusal, not a crash, whichever form asks.
    expect(errorOf(planMove(STATE, RULESET, asUnitId(99), asTileIndex(1)))).toEqual({
      kind: 'unknown-unit',
      unitId: asUnitId(99),
    });
    // A unit whose owner is not a player in the state has no acting player, so
    // the documented form refuses exactly as the command layer would.
    const orphaned: GameState = { ...STATE, players: [player(1, 6)] };
    expect(errorOf(planMove(orphaned, RULESET, asUnitId(0), asTileIndex(1)))).toEqual({
      kind: 'unknown-player',
      playerId: P0,
    });
  });

  it('refuses with the same reasons applyCommand refuses with', () => {
    expect(errorOf(planMove(STATE, RULESET, P0, asUnitId(0), asTileIndex(2)))).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: asTileIndex(2),
    });
    expect(errorOf(planMove(STATE, RULESET, P1, asUnitId(0), asTileIndex(2)))).toEqual({
      kind: 'not-your-unit',
      unitId: asUnitId(0),
      owner: P0,
    });
  });
});
