/**
 * Legal actions — `unitMoveOptions`, `unitActions`, `legalActions`, and the
 * keystone property of M2 (docs/INTERFACES.md, invariant 1, as amended):
 *
 * > every command a generator yields applies successfully through `applyCommand`
 * > — and every command `applyCommand` accepts is one the generator yields.
 *
 * Both directions are checked exhaustively rather than by example. The first is
 * soundness: the UI cannot offer a button that fails and the AI cannot waste a
 * decision on an illegal move. The second is completeness: a generator that omits
 * a legal action is just as broken, because the AI would never consider it. An
 * adversarial sweep found a counterexample to the pair — `legalActions` yielded
 * `EndTurn`, but applying it failed when a unit's `type` was missing from the
 * ruleset — so the unknown-type state is an explicit case below, and `EndTurn` is
 * total (`commands.ts`).
 *
 * The walk covers four states — a hand-built board, a starved one, a rich one,
 * the unknown-type one, and real `newGame` boards — and applies every candidate
 * to the state it came from.
 *
 * The hand-built board is the one from `commands.test.ts`: width 4, tile index
 * `y * 4 + x`, every `explored` row `false` so that legality is visibly not a fog
 * question.
 */

import { describe, expect, it } from 'vitest';
import { legalActions, unitActions, unitMoveOptions } from '../src/actions.js';
import { applyCommand, type Command } from '../src/commands.js';
import {
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type PlayerId,
} from '../src/ids.js';
import {
  TERRAIN_ROLES,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { SCHEMA_VERSION, newGame, type GameState, type PlayerState } from '../src/state.js';
import type { Unit, UnitDef, UnitRole } from '../src/units.js';

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

/** Row-major, width 4 — see `commands.test.ts` for the annotated picture. */
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

const seen = (value: boolean): readonly boolean[] => Array.from({ length: 16 }, () => value);

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
  explored: [seen(false), seen(false)],
};

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);

const withMovement = (state: GameState, unitId: number, movementLeft: number): GameState => ({
  ...state,
  units: state.units.map((u) => (u.id === asUnitId(unitId) ? { ...u, movementLeft } : u)),
});

const move = (unitId: number, to: number): Command => ({
  type: 'MoveUnit',
  unitId: asUnitId(unitId),
  to: asTileIndex(to),
});

/**
 * The ruleset map generation actually runs with: all six terrain roles (or
 * `newGame` fails with `missing-terrain-role`) and the one unit role it places.
 */
const GEN_TERRAINS: readonly TerrainDef[] = TERRAIN_ROLES.map((role) => {
  const row = TERRAINS.find((terrain) => terrain.role === role);
  if (row === undefined) throw new Error(`no fixture terrain for role ${role}`);
  return { ...row, id: asTerrainId(role) };
});

const GEN_RULESET: RulesetView = {
  terrains: GEN_TERRAINS,
  units: [SETTLER],
  fidelity: 'tuned',
};

/** A real generated board — the state shape the engine actually ships. */
const generatedBoard = (seed: number): GameState => {
  const generated = newGame(seed, SETTINGS, GEN_RULESET);
  if (!generated.ok) {
    throw new Error(`newGame(${String(seed)}) failed: ${JSON.stringify(generated.error)}`);
  }
  return generated.value;
};

const isMove = (cmd: Command): cmd is Extract<Command, { type: 'MoveUnit' }> =>
  cmd.type === 'MoveUnit';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Freeze a state graph so any mutation throws (ESM is strict mode). */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/**
 * Walk every action `legalActions` yields for each player, require it to apply,
 * and require the state it came from to survive untouched (so the same state can
 * be reused for the next action). Returns how many actions were checked, so a
 * caller can assert the walk was not vacuous.
 */
const assertEveryLegalActionApplies = (
  state: GameState,
  ruleset: RulesetView,
  playerIds: readonly PlayerId[],
): number => {
  const snapshot = structuredClone(state);
  deepFreeze(state);

  let checked = 0;
  for (const playerId of playerIds) {
    for (const cmd of legalActions(state, ruleset, playerId)) {
      const outcome = applyCommand(state, playerId, cmd, ruleset);
      if (!outcome.ok) {
        throw new Error(
          `legalActions yielded a command the engine refused: ${JSON.stringify(cmd)} -> ` +
            JSON.stringify(outcome.error),
        );
      }
      expect(outcome.value.state.revision).toBe(state.revision + 1);
      expect(outcome.value.state.turn).toBe(cmd.type === 'EndTurn' ? state.turn + 1 : state.turn);
      checked += 1;
    }
  }

  expect(state).toEqual(snapshot);
  return checked;
};

/** The same walk over the per-unit generator path (`unitActions`). */
const assertEveryUnitActionApplies = (state: GameState, ruleset: RulesetView): number => {
  let checked = 0;
  for (const owner of state.units) {
    for (const cmd of unitActions(state, ruleset, owner.id)) {
      const outcome = applyCommand(state, owner.owner, cmd, ruleset);
      if (!outcome.ok) {
        throw new Error(
          `unitActions yielded a command the engine refused: ${JSON.stringify(cmd)} -> ` +
            JSON.stringify(outcome.error),
        );
      }
      checked += 1;
    }
  }
  return checked;
};

/** A stable identity for a command, so generators and appliers can be compared as sets. */
const commandKey = (cmd: Command): string =>
  cmd.type === 'EndTurn'
    ? 'EndTurn'
    : `MoveUnit:${String(Number(cmd.unitId))}:${String(Number(cmd.to))}`;

/**
 * A superset of every command the generators *could* produce for `playerId`:
 * every tile index from one before the board to one past it for each of the
 * player's units, one non-integer index (a `TileIndex` is a number at runtime,
 * and a client can hand over 1.5), and `EndTurn`.
 *
 * It is deliberately wider than the generator's output — that is what makes the
 * completeness check meaningful: the applier must reject everything here that the
 * generator does not yield. Moves of *other* players' units are left out on
 * purpose, because the generators never yield them and `not-your-unit` is a
 * separate property (asserted in `commands.test.ts`).
 */
const candidateCommands = (state: GameState, playerId: PlayerId): readonly Command[] => {
  const size = state.map.width * state.map.height;
  const candidates: Command[] = [];

  for (const owner of state.units) {
    if (owner.owner !== playerId) continue;
    for (let tile = -1; tile <= size; tile += 1) candidates.push(move(Number(owner.id), tile));
    candidates.push({ type: 'MoveUnit', unitId: owner.id, to: asTileIndex(1.5) });
  }
  candidates.push({ type: 'EndTurn' });

  return candidates;
};

/**
 * The other direction of the keystone property: every command `applyCommand`
 * *accepts* out of the candidate universe must be one the generator yields. An
 * incomplete generator is as broken as an unsound one — the AI would never
 * consider a legal move, and the UI would never offer it.
 *
 * Returns how many candidates were accepted, so a caller can assert the number
 * equals what was yielded (which is what makes the two directions one statement:
 * the generator's output *is* the accepted set) and that the walk was not
 * vacuous.
 */
const assertGeneratorIsComplete = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): number => {
  const yielded = new Set([...legalActions(state, ruleset, playerId)].map(commandKey));

  let accepted = 0;
  for (const cmd of candidateCommands(state, playerId)) {
    const outcome = applyCommand(state, playerId, cmd, ruleset);
    if (!outcome.ok) continue;
    accepted += 1;
    expect(yielded.has(commandKey(cmd))).toBe(true);
  }

  return accepted;
};

/**
 * Both directions, for one player: everything yielded applies, and everything
 * accepted is yielded. The two counts must be equal — the generator's output is
 * exactly the set of commands the engine accepts — and the walk must not be
 * vacuous.
 */
const assertKeystone = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): { readonly yielded: number; readonly accepted: number } => {
  const yielded = assertEveryLegalActionApplies(state, ruleset, [playerId]);
  const accepted = assertGeneratorIsComplete(state, ruleset, playerId);

  expect(accepted).toBe(yielded);
  return { yielded, accepted };
};

/**
 * A unit type no ruleset in this file defines. `newGame` cannot produce one and
 * neither can the builder, but a hand-built state, a foreign ruleset view or a
 * future save load can — and the adversarial sweep's counterexample lived
 * exactly here, so it is a permanent case rather than a curiosity.
 */
const GHOST = makeDef('ghost', 'settler', 2);

/** `STATE` with unit 0's type replaced by one the ruleset does not define. */
const ghostState = (movementLeft: number): GameState => ({
  ...STATE,
  nextUnitId: 4,
  units: [unit(0, GHOST, 0, 5, movementLeft), unit(1, SCOUT, 0, 10, 1), unit(2, WARRIOR, 1, 6, 0)],
});

describe('unitMoveOptions', () => {
  it('offers exactly the adjacent tiles the unit can afford, in index order', () => {
    // Neighbours of 5: 0 (ocean) and 2 (mountains) impassable, 6 held by player
    // 1, 1 and 9 hills (cost 2), 4 and 8 grassland, 10 held by this player's own
    // scout (Civ 3 stacks).
    expect(unitMoveOptions(STATE, RULESET, asUnitId(0))).toEqual([1, 4, 8, 9, 10]);
  });

  it('drops options the unit cannot pay for', () => {
    const poor = withMovement(STATE, 0, 1);
    expect(unitMoveOptions(poor, RULESET, asUnitId(0))).toEqual([4, 8, 10]);
  });

  it('is empty for a unit with no movement left, and for a unit that does not exist', () => {
    expect(unitMoveOptions(STATE, RULESET, asUnitId(1))).toEqual([]);
    expect(unitMoveOptions(STATE, RULESET, asUnitId(2))).toEqual([]);
    expect(unitMoveOptions(STATE, RULESET, asUnitId(99))).toEqual([]);
  });

  it('does not consult fog: an unlit board offers the same moves as a lit one', () => {
    const lit: GameState = { ...STATE, explored: [seen(true), seen(true)] };
    const partlyLit: GameState = { ...STATE, explored: [seen(false), seen(true)] };

    expect(unitMoveOptions(STATE, RULESET, asUnitId(0))).toEqual(
      unitMoveOptions(lit, RULESET, asUnitId(0)),
    );
    expect(unitMoveOptions(STATE, RULESET, asUnitId(0))).toEqual(
      unitMoveOptions(partlyLit, RULESET, asUnitId(0)),
    );
  });

  it('is stable across calls (the AI and the UI must agree, twice)', () => {
    const first = unitMoveOptions(STATE, RULESET, asUnitId(0));
    const second = unitMoveOptions(STATE, RULESET, asUnitId(0));
    expect(second).toEqual(first);
  });

  it('agrees with applyCommand: every offered tile is a successful move', () => {
    for (const to of unitMoveOptions(STATE, RULESET, asUnitId(0))) {
      expect(applyCommand(STATE, P0, move(0, to), RULESET).ok).toBe(true);
    }
    // …and the refusals are exactly the tiles that are *not* offered.
    for (const to of [0, 2, 6, 15]) {
      expect(applyCommand(STATE, P0, move(0, to), RULESET).ok).toBe(false);
    }
  });
});

describe('unitActions', () => {
  it('turns each option into the matching MoveUnit command', () => {
    expect(unitActions(STATE, RULESET, asUnitId(0))).toEqual(
      unitMoveOptions(STATE, RULESET, asUnitId(0)).map((to) => move(0, to)),
    );
  });

  it('has no actions for a unit that has none', () => {
    expect(unitActions(STATE, RULESET, asUnitId(1))).toEqual([]);
    expect(unitActions(STATE, RULESET, asUnitId(99))).toEqual([]);
  });
});

describe('legalActions', () => {
  it("yields this player's moves, then a single EndTurn", () => {
    const actions = [...legalActions(STATE, RULESET, P0)];

    expect(actions).toEqual([
      move(0, 1),
      move(0, 4),
      move(0, 8),
      move(0, 9),
      move(0, 10),
      { type: 'EndTurn' },
    ]);
  });

  it("never yields another player's units", () => {
    const actions = [...legalActions(STATE, RULESET, P0)];
    const units = actions.flatMap((cmd) => (cmd.type === 'MoveUnit' ? [cmd.unitId] : []));
    expect(units.every((unitId) => unitId !== asUnitId(2))).toBe(true);
  });

  it('is deterministic across walks, and lazy', () => {
    expect([...legalActions(STATE, RULESET, P0)]).toEqual([...legalActions(STATE, RULESET, P0)]);

    // A generator hands over one action at a time: asking for the first must not
    // materialise the whole space (PLAN.md §5.2).
    const walk = legalActions(STATE, RULESET, P0);
    expect(walk.next().done).toBe(false);
    expect([...walk]).toHaveLength(5);
  });

  it('yields nothing at all for a player that does not exist', () => {
    // Not even EndTurn: an action that `applyCommand` would refuse as
    // `unknown-player` must not be advertised as legal.
    expect([...legalActions(STATE, RULESET, asPlayerId(9))]).toEqual([]);
  });

  it('covers exactly the union of the player units’ actions, plus EndTurn', () => {
    const actions = [...legalActions(STATE, RULESET, P0)].filter(
      (cmd): cmd is Extract<Command, { type: 'MoveUnit' }> => cmd.type === 'MoveUnit',
    );
    const expected = [asUnitId(0), asUnitId(1)].flatMap((unitId) =>
      unitActions(STATE, RULESET, unitId),
    );

    expect(actions).toEqual(expected);
  });
});

describe('keystone — the generator and the applier agree, in both directions', () => {
  it('holds for the hand-built board, exhaustively, for both players', () => {
    // Soundness: 5 settler moves + 1 EndTurn for player 0; 1 EndTurn for player 1
    // (its warrior has spent everything). Completeness: the applier accepts those
    // same 7 and nothing else. Asserted exactly, so the walk cannot pass
    // vacuously.
    expect(assertEveryLegalActionApplies(STATE, RULESET, [P0, P1])).toBe(7);
    expect(assertEveryUnitActionApplies(STATE, RULESET)).toBe(5);
    expect(assertKeystone(STATE, RULESET, P0)).toEqual({ yielded: 6, accepted: 6 });
    expect(assertKeystone(STATE, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('holds for a starved board and for a board where everything is affordable', () => {
    const starved: GameState = {
      ...STATE,
      units: STATE.units.map((u) => ({ ...u, movementLeft: 0 })),
    };
    const rich: GameState = withMovement(STATE, 1, SCOUT.movement);

    expect(assertEveryLegalActionApplies(starved, RULESET, [P0, P1])).toBe(2);
    expect(assertKeystone(starved, RULESET, P0)).toEqual({ yielded: 1, accepted: 1 });
    expect(assertKeystone(starved, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });

    expect(assertEveryLegalActionApplies(rich, RULESET, [P0, P1])).toBe(13);
    expect(assertKeystone(rich, RULESET, P0)).toEqual({ yielded: 12, accepted: 12 });
    expect(assertKeystone(rich, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('holds when a unit type is missing from the ruleset (the sweep’s counterexample)', () => {
    // The state `legalActions` and `applyCommand` used to disagree about: the
    // generator yields `EndTurn` for any real player, so applying it must succeed
    // even though unit 0's type is not in the ruleset.
    const ghost = ghostState(0);
    const actions = [...legalActions(ghost, RULESET, P0)];
    expect(actions).toContainEqual({ type: 'EndTurn' });

    const outcome = applyCommand(ghost, P0, { type: 'EndTurn' }, RULESET);
    if (!outcome.ok) {
      throw new Error(
        `EndTurn was refused for an unknown unit type: ${JSON.stringify(outcome.error)}`,
      );
    }

    // Total: the unrecognised unit is carried over untouched, everything the
    // ruleset can resolve is refilled, and the turn advances exactly once.
    expect(outcome.value.state.units.map((u) => u.movementLeft)).toEqual([
      0, // the ghost keeps what it had — no definition to refill it from
      SCOUT.movement,
      WARRIOR.movement,
    ]);
    expect(outcome.value.state.turn).toBe(ghost.turn + 1);
    expect(outcome.value.state.revision).toBe(ghost.revision + 1);

    // And both directions hold on the state the sweep broke.
    expect(assertKeystone(ghost, RULESET, P0).yielded).toBeGreaterThanOrEqual(2);
    expect(assertKeystone(ghost, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('lets an unknown-typed unit move, because legality never reads the unit type', () => {
    // Movement reads the destination terrain and the mover's `movementLeft`, not
    // the unit's type, so an unresolvable type costs the unit nothing but its
    // refill. Both directions are checked on that state too.
    const mobile = ghostState(GHOST.movement);
    const ghostMoves = [...legalActions(mobile, RULESET, P0)].filter(
      (cmd): cmd is Extract<Command, { type: 'MoveUnit' }> =>
        isMove(cmd) && cmd.unitId === asUnitId(0),
    );

    expect(ghostMoves.length).toBeGreaterThan(0); // the unresolvable unit still moves
    expect(ghostMoves.map((cmd) => Number(cmd.to))).toEqual(
      unitMoveOptions(mobile, RULESET, asUnitId(0)).map(Number),
    );

    const { yielded, accepted } = assertKeystone(mobile, RULESET, P0);
    expect(yielded).toBeGreaterThan(ghostMoves.length); // ...plus the one EndTurn
    expect(accepted).toBe(yielded);
  });

  it('agrees for a player that does not exist: nothing yielded, nothing accepted', () => {
    const ghostPlayer = asPlayerId(9);
    expect([...legalActions(STATE, RULESET, ghostPlayer)]).toEqual([]);
    expect(assertGeneratorIsComplete(STATE, RULESET, ghostPlayer)).toBe(0);
  });

  it('holds after a move has been applied (post-move states stay legal)', () => {
    const after = applyCommand(STATE, P0, move(0, 1), RULESET);
    if (!after.ok) throw new Error('the first move should have applied');

    // The settler spent its 2 points on the hills, so it has no options left.
    expect(unitMoveOptions(after.value.state, RULESET, asUnitId(0))).toEqual([]);
    expect(assertEveryLegalActionApplies(after.value.state, RULESET, [P0, P1])).toBe(2);
    expect(assertKeystone(after.value.state, RULESET, P0)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('holds on generated boards, for every seed and every player', () => {
    for (const seed of [1, 42, 1337]) {
      const board = generatedBoard(seed);
      const checked = assertEveryLegalActionApplies(board, GEN_RULESET, [P0, P1]);
      const moves = assertEveryUnitActionApplies(board, GEN_RULESET);

      // Two EndTurns (one per player) plus the board's steps. The per-unit walk
      // must account for exactly the moves, so the player-wide walk neither
      // invented nor dropped one, and the walk is never vacuous — which a
      // ">= 2" assertion alone would allow.
      expect(checked).toBe(moves + 2);
      expect(moves).toBeGreaterThan(0);

      // Completeness, player by player: the applier accepts exactly what the
      // generator yields, and nothing the generator leaves out.
      for (const playerId of [P0, P1]) {
        const one = assertEveryLegalActionApplies(board, GEN_RULESET, [playerId]);
        expect(assertGeneratorIsComplete(board, GEN_RULESET, playerId)).toBe(one);
      }
    }
  });

  it('plays a whole turn from the generators alone, stepping until nothing is left', () => {
    const start = generatedBoard(42);
    let state = start;
    let steps = 0;

    // The AI's and the REPL's loop: ask what is legal now, apply one action,
    // ask again. Every step must be accepted, and the walk must terminate
    // because movement runs out rather than because of a guard.
    for (let guard = 0; guard < 20; guard += 1) {
      const next = [...legalActions(state, GEN_RULESET, P0)].find(isMove);
      if (next === undefined) break;

      const outcome = applyCommand(state, P0, next, GEN_RULESET);
      if (!outcome.ok) throw new Error(`a mid-turn step was refused: ${JSON.stringify(next)}`);
      state = outcome.value.state;
      steps += 1;
    }

    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThanOrEqual(SETTLER.movement); // each step costs >= 1
    expect(state.revision).toBe(start.revision + steps);
    expect(unitMoveOptions(state, GEN_RULESET, asUnitId(0))).toEqual([]);

    const end = applyCommand(state, P0, { type: 'EndTurn' }, GEN_RULESET);
    if (!end.ok) throw new Error('EndTurn was refused');
    expect(end.value.state.units.every((u) => u.movementLeft === SETTLER.movement)).toBe(true);
    expect(end.value.state.turn).toBe(state.turn + 1);
  });
});
