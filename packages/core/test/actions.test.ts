/**
 * Legal actions — `unitMoveOptions`, `unitActions`, `legalActions`, and the
 * keystone property (docs/INTERFACES.md, invariant 1, as amended):
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
 * M3 extends the pair to the city commands, and the extension is deliberately
 * *asymmetric*, with the asymmetry stated rather than hidden:
 *
 * - `FoundCity` is a unit's action, so all three generators yield it exactly when
 *   `planFoundCity` accepts it — the same both-directions sweep as movement, and
 *   the candidate universe below grew to include it.
 * - `SetWorkedTiles` and `SetProduction` are *choices* over a search space (an
 *   assignment is `C(radius, population)` candidates) and are not enumerated by
 *   any generator — `actions.ts` says why. Their two directions are therefore
 *   asserted against the evaluator that `applyCommand` itself consults:
 *   `assertSetterAgreement` below walks a universe of legal *and* illegal choices
 *   and requires the applier's verdict (and its typed refusal) to be the plan's,
 *   while asserting that none of them is advertised as an action. The one thing
 *   that would be a bug — a setter the applier accepts but the plan refuses, or
 *   the reverse — fails there.
 *
 * M4a adds the work commands, and they extend the enumerated half rather than the
 * queried one: a job is named by an improvement kind, so "every way this worker
 * may start work" is a finite list read from the catalog, and the universe below
 * enumerates exactly that list (plus an unknown kind, plus `CancelWork` for every
 * unit, so the refusals are swept too). That makes the keystone property span
 * **five generators** — `unitMoveOptions`, `unitActions`, `legalActions`,
 * `planStartWork` and `planCancelWork` — and `assertWorkAgreement` states the two
 * new evaluators' agreement directly, including that an accepted work command
 * *is* advertised, which the setters' half deliberately does not claim.
 *
 * The walk covers eight states — a hand-built board, one with cities, a starved
 * one, a rich one, the unknown-type one, real `newGame` boards, and the M4a worker
 * boards (idle, working, and on an already-improved tile) — and applies every
 * candidate to the state it came from.
 *
 * The hand-built board is the one from `commands.test.ts`: width 4, tile index
 * `y * 4 + x`, every `explored` row `false` so that legality is visibly not a fog
 * question.
 */

import { describe, expect, it } from 'vitest';
import { legalActions, unitActions, unitMoveOptions } from '../src/actions.js';
import { cityRadius, type City, type ProductionItem } from '../src/cities.js';
import {
  applyCommand,
  planCancelWork,
  planSetProduction,
  planSetWorkedTiles,
  planStartWork,
  type Command,
  type GameError,
} from '../src/commands.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type PlayerId,
} from '../src/ids.js';
import {
  asImprovementId,
  improvementCatalog,
  type ImprovementDef,
  type ImprovementId,
} from '../src/improvements.js';
import {
  TERRAIN_ROLES,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import type { Result } from '../src/result.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { SCHEMA_VERSION, newGame, type GameState, type PlayerState } from '../src/state.js';
import { withWork, type Unit, type UnitDef, type UnitRole, type UnitWork } from '../src/units.js';

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
  // M3: the map carries its goody huts; none here, so no action below can be
  // affected by one (hut rewards are another workstream's).
  huts: [],
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
/** Movement 1: enough to start a job or take one step, never both. */
const WORKER = makeDef('worker', 'worker', 1);

/**
 * The improvement catalog, in the order the generator enumerates it. **Placeholder
 * rows of ours** (M4a): the turn counts are fixture numbers, the deltas are single
 * +1s, and the roles are our reading of which terrain suits which improvement —
 * none of it is sourced from Civ 3.
 */
const IMPROVEMENTS: readonly ImprovementDef[] = [
  {
    id: asImprovementId('road'),
    kind: 'road',
    name: 'Road',
    turns: 2,
    yields: { food: 0, shields: 0, commerce: 1 },
    allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
  },
  {
    id: asImprovementId('mine'),
    kind: 'mine',
    name: 'Mine',
    turns: 3,
    yields: { food: 0, shields: 1, commerce: 0 },
    allowedRoles: ['hills', 'mountains'],
  },
  {
    id: asImprovementId('irrigation'),
    kind: 'irrigation',
    name: 'Irrigation',
    turns: 2,
    yields: { food: 1, shields: 0, commerce: 0 },
    allowedRoles: ['grassland', 'plains'],
  },
];

const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, SCOUT, WARRIOR, WORKER],
  buildings: [
    { id: asBuildingId('granary'), name: 'Granary', cost: 10 },
    { id: asBuildingId('library'), name: 'Library', cost: 20 },
  ],
  improvements: IMPROVEMENTS,
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (index: number, startingTile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(startingTile),
  kind: 'civ',
});

/** A city with M3's shape and playable defaults; every field is spelled out. */
const city = (id: number, owner: number, tile: number, overrides: Partial<City> = {}): City => ({
  id: asCityId(id),
  owner: asPlayerId(owner),
  name: `City ${String(id + 1)}`,
  tile: asTileIndex(tile),
  population: 1,
  foodBox: 0,
  shields: 0,
  queue: [],
  buildings: [],
  workedTiles: [],
  ...overrides,
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
  nextCityId: 0,
  cities: [],
  improvements: [],
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

const foundCity = (unitId: number): Command => ({ type: 'FoundCity', unitId: asUnitId(unitId) });

const setWorkedTiles = (cityId: number, tiles: readonly number[]): Command => ({
  type: 'SetWorkedTiles',
  cityId: asCityId(cityId),
  tiles: tiles.map((tile) => asTileIndex(tile)),
});

const setProduction = (cityId: number, item: ProductionItem): Command => ({
  type: 'SetProduction',
  cityId: asCityId(cityId),
  item,
});

const unitItem = (id: string): ProductionItem => ({ kind: 'unit', id: asUnitTypeId(id) });
const buildingItem = (id: string): ProductionItem => ({ kind: 'building', id: asBuildingId(id) });

const startWork = (unitId: number, kind: string): Command => ({
  type: 'StartWork',
  unitId: asUnitId(unitId),
  kind: asImprovementId(kind),
});

const cancelWork = (unitId: number): Command => ({ type: 'CancelWork', unitId: asUnitId(unitId) });

/** An improvement kind no row in this file's catalog describes. */
const UNKNOWN_KIND = 'space-elevator';

/** `state` with `cities`, and `nextCityId` past the highest id present. */
const withCities = (state: GameState, cities: readonly City[]): GameState => ({
  ...state,
  cities: [...cities],
  nextCityId: cities.reduce((next, existing) => Math.max(next, Number(existing.id) + 1), 0),
});

/**
 * Player 0's city on tile 13 ((1,3)), population 2, working nothing — the board
 * the city-command sweeps run on. It is two tiles from the settler on 5, so
 * founding a city there is still legal.
 */
const CITY = city(0, 0, 13, { population: 2 });

/** The hand-built board plus player 0's city. */
const CITY_STATE: GameState = withCities(STATE, [CITY]);

/** A board with two cities: player 0's on 13 and player 1's on 5 working tile 8. */
const SHARED_STATE: GameState = withCities(STATE, [
  CITY,
  city(1, 1, 5, { population: 1, workedTiles: [asTileIndex(8)] }),
]);

/** `state` with `units`, keeping `nextUnitId` past the highest id present. */
const withUnits = (state: GameState, units: readonly Unit[]): GameState => ({
  ...state,
  units: [...units].sort((a, b) => Number(a.id) - Number(b.id)),
  nextUnitId: units.reduce((next, existing) => Math.max(next, Number(existing.id) + 1), 0),
});

/**
 * Player 0's worker on tile 1 (hills) — the M4a board.
 *
 * Tile 1 is chosen because it puts the work commands' acceptance in one place: a
 * `mine` and a `road` are allowed on hills, an `irrigation` is not, and its
 * neighbours offer exactly two affordable steps (4 and 5, both grassland at cost
 * 1; 0 and 2 are impassable and 6 holds player 1's warrior).
 */
const WORKER_TILE = 1;
const WORKER_STATE: GameState = withUnits(STATE, [
  ...STATE.units,
  unit(3, WORKER, 0, WORKER_TILE, WORKER.movement),
]);

/** A job, in the shape the engine stores: `turnsLeft` is the count still owed. */
const mineWork = (turnsLeft: number): UnitWork => ({
  kind: asImprovementId('mine'),
  tile: asTileIndex(WORKER_TILE),
  turnsLeft,
});

/** `state` with unit 3 already working on its own tile. */
const digging = (state: GameState, work: UnitWork): GameState => ({
  ...state,
  units: state.units.map((u) => (u.id === asUnitId(3) ? withWork(u, work) : u)),
});

/** The worker mid-job: it may cancel, and it may step — which cancels the job. */
const WORKING_STATE: GameState = digging(WORKER_STATE, mineWork(2));

/** The worker idle on a tile that already carries a mine, so only a road is left. */
const MINED_STATE: GameState = {
  ...WORKER_STATE,
  improvements: [{ tile: asTileIndex(WORKER_TILE), kind: asImprovementId('mine') }],
};

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
  // A generated board carries no improvements, so the catalog is empty here and
  // every existing count on those boards is unchanged by M4a: a new game still
  // starts with an empty `improvements` list and a settler that cannot work.
  improvements: [],
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

/**
 * A stable identity for a command, so generators and appliers can be compared as
 * sets. Total over the M4a union, including the two city setters and the two work
 * commands, so a comparison that included one could not silently collapse it onto
 * another shape.
 */
const commandKey = (cmd: Command): string => {
  switch (cmd.type) {
    case 'MoveUnit':
      return `MoveUnit:${String(Number(cmd.unitId))}:${String(Number(cmd.to))}`;
    case 'EndTurn':
      return 'EndTurn';
    case 'FoundCity':
      return `FoundCity:${String(Number(cmd.unitId))}`;
    case 'SetWorkedTiles':
      return `SetWorkedTiles:${String(Number(cmd.cityId))}:${cmd.tiles.map(Number).join(',')}`;
    case 'SetProduction':
      return `SetProduction:${String(Number(cmd.cityId))}:${cmd.item.kind}:${cmd.item.id}`;
    case 'StartWork':
      return `StartWork:${String(Number(cmd.unitId))}:${cmd.kind}`;
    case 'CancelWork':
      return `CancelWork:${String(Number(cmd.unitId))}`;
  }
};

/**
 * A superset of every command the generators *could* produce for `playerId`:
 * every tile index from one before the board to one past it for each of the
 * player's units, one non-integer index (a `TileIndex` is a number at runtime,
 * and a client can hand over 1.5), `FoundCity`, one `StartWork` per catalog kind
 * **plus one for a kind no row describes**, `CancelWork`, and `EndTurn`.
 *
 * It is deliberately wider than the generator's output — that is what makes the
 * completeness check meaningful: the applier must reject everything here that the
 * generator does not yield. Moves of *other* players' units are left out on
 * purpose, because the generators never yield them and `not-your-unit` is a
 * separate property (asserted in `commands.test.ts`).
 */
const candidateCommands = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly Command[] => {
  const size = state.map.width * state.map.height;
  const candidates: Command[] = [];
  const kinds: readonly (ImprovementId | string)[] = [
    ...improvementCatalog(ruleset).map((def) => def.id),
    UNKNOWN_KIND,
  ];

  for (const owner of state.units) {
    if (owner.owner !== playerId) continue;
    for (let tile = -1; tile <= size; tile += 1) candidates.push(move(Number(owner.id), tile));
    candidates.push({ type: 'MoveUnit', unitId: owner.id, to: asTileIndex(1.5) });
    // M3: founding is one entry per unit — a unit either can found where it
    // stands or it cannot — so the universe stays exhaustive without exploding.
    candidates.push(foundCity(Number(owner.id)));
    // M4a: a job is named by its kind, so the work space *is* the catalog (plus one
    // kind nothing describes, so the `unknown-improvement` refusal is swept too),
    // and the cancel is one entry per unit.
    for (const kind of kinds) candidates.push(startWork(Number(owner.id), kind));
    candidates.push(cancelWork(Number(owner.id)));
  }
  candidates.push({ type: 'EndTurn' });

  return candidates;
};

/**
 * The setter candidate universe: every shape of `SetWorkedTiles`/`SetProduction`
 * a caller could hand over for this player's cities, legal and illegal alike.
 * Derived from each city's actual radius (so it works on a generated board too),
 * and deliberately wider than anything the applier accepts — that is what makes
 * the agreement check below meaningful.
 */
const setterCommands = (state: GameState, playerId: PlayerId): readonly Command[] => {
  const commands: Command[] = [];
  const size = state.map.width * state.map.height;
  const items: readonly ProductionItem[] = [
    unitItem('settler'),
    unitItem('scout'),
    unitItem('warrior'),
    unitItem('spaceship'),
    buildingItem('granary'),
    buildingItem('library'),
    buildingItem('spaceship'),
  ];

  for (const owned of state.cities) {
    if (owned.owner !== playerId) continue;
    const radius = cityRadius(state, owned.tile);
    const inRadius = new Set<number>(radius.map(Number));
    const outside = Array.from({ length: size }, (_, index) => index).find(
      (index) => !inRadius.has(index),
    );
    const first = radius[0];
    const second = radius[1];
    const two = radius.slice(0, 2).map(Number);
    const tooMany = radius.slice(0, owned.population + 1).map(Number);

    const assignments: readonly (readonly number[])[] = [
      [], // no citizen assigned at all: legal, and it works nothing
      two, // the first two tiles in radius order
      [...two].reverse(), // order matters, so the reverse is a different request
      first === undefined ? [] : [Number(first), Number(first)], // a duplicate
      [Number(owned.tile)], // the centre: always worked, never a citizen's tile
      tooMany, // one tile more than there are citizens
      outside === undefined ? [] : [outside], // off the radius entirely
      [1.5], // not a tile index at all
    ];

    for (const tiles of assignments) commands.push(setWorkedTiles(Number(owned.id), tiles));
    if (second !== undefined) {
      commands.push(setWorkedTiles(Number(owned.id), [Number(second)]));
    }

    // A tile another city works, when one lies inside this city's radius — the
    // `tile-worked-by-another-city` branch, derived rather than hard-coded so it
    // exists on every board this universe runs against.
    const rivalClaim = radius
      .map(Number)
      .find((tile) =>
        state.cities.some(
          (other) =>
            other.id !== owned.id && other.workedTiles.some((worked) => Number(worked) === tile),
        ),
      );
    if (rivalClaim !== undefined) {
      commands.push(setWorkedTiles(Number(owned.id), [rivalClaim]));
    }
    for (const item of items) commands.push(setProduction(Number(owned.id), item));
  }

  // Unknown and foreign city ids, so the `unknown-city` / `not-your-city` branches
  // are swept too.
  for (const id of [77, 99]) {
    commands.push(setWorkedTiles(id, []));
    commands.push(setProduction(id, unitItem('scout')));
  }

  return commands;
};

/** The plan evaluator a setter command is decided by — the applier's own. */
const planSetter = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  cmd: Command,
): Result<unknown, GameError> => {
  if (cmd.type === 'SetWorkedTiles') {
    return planSetWorkedTiles(state, playerId, cmd.cityId, cmd.tiles);
  }
  if (cmd.type === 'SetProduction') {
    return planSetProduction(state, ruleset, playerId, cmd.cityId, cmd.item);
  }
  throw new Error(`not a setter command: ${cmd.type}`);
};

/** What one setter sweep measured, so a caller can prove it was not vacuous. */
interface SetterTotals {
  readonly checked: number;
  readonly accepted: number;
  readonly yielded: number;
}

/**
 * The two directions for the city *choice* commands, as described in the file
 * header: for every candidate, the applier's verdict — and its typed refusal —
 * must be the plan evaluator's, and no candidate may be advertised by
 * `legalActions`. The counts let a caller assert the sweep was neither empty nor
 * all-accepting.
 */
const assertSetterAgreement = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): SetterTotals => {
  const yielded = new Set([...legalActions(state, ruleset, playerId)].map(commandKey));

  let checked = 0;
  let accepted = 0;
  for (const cmd of setterCommands(state, playerId)) {
    checked += 1;
    const applied = applyCommand(state, playerId, cmd, ruleset);
    const planned = planSetter(state, ruleset, playerId, cmd);

    expect(applied.ok).toBe(planned.ok);
    if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);

    if (applied.ok) {
      accepted += 1;
      expect(yielded.has(commandKey(cmd))).toBe(false);
    }
  }

  return { checked, accepted, yielded: yielded.size };
};

/** What one work sweep measured, so a caller can prove it was not vacuous. */
interface WorkTotals {
  readonly checked: number;
  readonly accepted: number;
  readonly refused: number;
}

/**
 * M4a's half of the keystone property, and the reason it is asserted here as well
 * as in the candidate sweep: `planStartWork` and `planCancelWork` are the fourth
 * and fifth generators, so for every candidate of either command —
 *
 * - the applier's verdict must be the plan evaluator's, with the *same* typed
 *   refusal (so a worker refused with `improvement-not-allowed` by one and
 *   `already-improved` by the other fails here), and
 * - an accepted one must be advertised by `legalActions`, which is the
 *   completeness claim the setters deliberately do not make — a worker's job *is*
 *   enumerable, so an accepted `StartWork` that no generator yielded would be a
 *   real bug.
 */
const assertWorkAgreement = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): WorkTotals => {
  const yielded = new Set([...legalActions(state, ruleset, playerId)].map(commandKey));
  const kinds: readonly (ImprovementId | string)[] = [
    ...improvementCatalog(ruleset).map((def) => def.id),
    UNKNOWN_KIND,
  ];

  let checked = 0;
  let accepted = 0;

  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    const candidates: readonly Command[] = [
      ...kinds.map((kind) => startWork(Number(unit.id), kind)),
      cancelWork(Number(unit.id)),
    ];

    for (const cmd of candidates) {
      checked += 1;
      const applied = applyCommand(state, playerId, cmd, ruleset);
      const planned =
        cmd.type === 'StartWork'
          ? planStartWork(state, ruleset, playerId, cmd.unitId, cmd.kind)
          : cmd.type === 'CancelWork'
            ? planCancelWork(state, playerId, cmd.unitId)
            : undefined;
      if (planned === undefined) throw new Error(`not a work command: ${cmd.type}`);

      expect(applied.ok).toBe(planned.ok);
      if (!applied.ok && !planned.ok) expect(applied.error).toStrictEqual(planned.error);

      if (applied.ok) {
        accepted += 1;
        expect(yielded.has(commandKey(cmd))).toBe(true);
      }
    }
  }

  return { checked, accepted, refused: checked - accepted };
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
  for (const cmd of candidateCommands(state, ruleset, playerId)) {
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
  it('offers FoundCity first, then one MoveUnit per option', () => {
    expect(unitActions(STATE, RULESET, asUnitId(0))).toEqual([
      foundCity(0),
      ...unitMoveOptions(STATE, RULESET, asUnitId(0)).map((to) => move(0, to)),
    ]);
  });

  it('offers an idle worker its jobs in catalog order, then its steps', () => {
    // The catalog is road, mine, irrigation; the worker stands on hills, so
    // irrigation is not buildable there and is not offered. Moves come last: a step
    // relocates the unit, and M4a cancels a job when a unit relocates, so the
    // actions that leave the worker in place are listed first.
    expect(unitActions(WORKER_STATE, RULESET, asUnitId(3))).toEqual([
      startWork(3, 'road'),
      startWork(3, 'mine'),
      move(3, 4),
      move(3, 5),
    ]);
  });

  it('offers a working unit its cancel first, and still offers the steps that would cancel for it', () => {
    expect(unitActions(WORKING_STATE, RULESET, asUnitId(3))).toEqual([
      cancelWork(3),
      move(3, 4),
      move(3, 5),
    ]);
    // No StartWork while a job is running, whatever the kind.
    expect(
      unitActions(WORKING_STATE, RULESET, asUnitId(3)).some((cmd) => cmd.type === 'StartWork'),
    ).toBe(false);
  });

  it('offers StartWork for exactly the kinds the applier accepts, and nowhere else', () => {
    const offers = (state: GameState, unitId: number, kind: string): boolean =>
      unitActions(state, RULESET, asUnitId(unitId)).some(
        (cmd) => cmd.type === 'StartWork' && cmd.kind === asImprovementId(kind),
      );
    const applies = (state: GameState, unitId: number, kind: string): boolean =>
      applyCommand(state, P0, startWork(unitId, kind), RULESET).ok;

    const kinds: readonly string[] = ['road', 'mine', 'irrigation', UNKNOWN_KIND];
    const boards: readonly GameState[] = [
      WORKER_STATE,
      WORKING_STATE,
      MINED_STATE,
      withMovement(WORKER_STATE, 3, 0),
      CITY_STATE,
    ];

    for (const board of boards) {
      for (const unitId of [0, 1, 3]) {
        for (const kind of kinds) {
          expect(offers(board, unitId, kind)).toBe(applies(board, unitId, kind));
        }
      }
    }

    // …and the sweep above is not a comparison of two constants: it sees both
    // verdicts, on the same board and on different ones.
    expect(offers(WORKER_STATE, 3, 'mine')).toBe(true);
    expect(offers(WORKER_STATE, 3, 'irrigation')).toBe(false);
    expect(offers(WORKER_STATE, 3, UNKNOWN_KIND)).toBe(false);
    expect(offers(MINED_STATE, 3, 'mine')).toBe(false);
    expect(offers(MINED_STATE, 3, 'road')).toBe(true);
    expect(offers(WORKING_STATE, 3, 'road')).toBe(false);
    expect(offers(WORKER_STATE, 0, 'mine')).toBe(false); // a settler is not a worker
    expect(offers(withMovement(WORKER_STATE, 3, 0), 3, 'road')).toBe(false);
  });

  it('offers CancelWork exactly where cancelling is legal, and nowhere else', () => {
    const offers = (state: GameState, unitId: number): boolean =>
      unitActions(state, RULESET, asUnitId(unitId)).some((cmd) => cmd.type === 'CancelWork');
    const applies = (state: GameState, unitId: number): boolean =>
      applyCommand(state, P0, cancelWork(unitId), RULESET).ok;

    for (const board of [WORKER_STATE, WORKING_STATE, MINED_STATE, CITY_STATE, STATE]) {
      for (const unitId of [0, 1, 3, 99]) {
        expect(offers(board, unitId)).toBe(applies(board, unitId));
      }
    }

    expect(offers(WORKING_STATE, 3)).toBe(true);
    expect(offers(WORKER_STATE, 3)).toBe(false);
  });

  it('has no actions for a unit that has none', () => {
    expect(unitActions(STATE, RULESET, asUnitId(1))).toEqual([]);
    expect(unitActions(STATE, RULESET, asUnitId(99))).toEqual([]);
    // A worker that has spent its movement and is not working has nothing left: no
    // job (it costs movement) and no step (nothing affordable).
    expect(unitActions(withMovement(WORKER_STATE, 3, 0), RULESET, asUnitId(3))).toEqual([]);
  });

  it('offers FoundCity exactly where founding is legal, and nowhere else', () => {
    const offers = (state: GameState, unitId: number): boolean =>
      unitActions(state, RULESET, asUnitId(unitId)).some((cmd) => cmd.type === 'FoundCity');
    const applies = (state: GameState, unitId: number): boolean =>
      applyCommand(state, asPlayerId(0), foundCity(unitId), RULESET).ok;

    // The settler on 5 can found: land, no city within MIN_CITY_DISTANCE, and its
    // type is a settler's.
    expect(offers(STATE, 0)).toBe(true);
    expect(applies(STATE, 0)).toBe(true);

    // Not a settler: the scout and the warrior can never found, whatever their
    // movement — founding is a property of the unit's *type*.
    expect(offers(STATE, 1)).toBe(false);
    expect(applies(STATE, 1)).toBe(false);
    expect(offers(STATE, 2)).toBe(false);
    expect(applies(STATE, 2)).toBe(false);

    // A type the ruleset cannot resolve is not a settler either.
    const ghost = ghostState(0);
    expect(offers(ghost, 0)).toBe(false);
    expect(applies(ghost, 0)).toBe(false);

    // Off land: a settler standing on a coast tile has nowhere to put a city.
    const atSea: GameState = { ...STATE, nextUnitId: 1, units: [unit(0, SETTLER, 0, 3, 2)] };
    expect(offers(atSea, 0)).toBe(false);
    expect(applies(atSea, 0)).toBe(false);

    // Too close to an existing city (tile 4 is adjacent to 5).
    const crowded = withCities(STATE, [city(0, 1, 4)]);
    expect(offers(crowded, 0)).toBe(false);
    expect(applies(crowded, 0)).toBe(false);

    // A settler that has already founded: the unit is gone, so its id resolves to
    // nothing and nothing is offered for it.
    const founded = applyCommand(STATE, P0, foundCity(0), RULESET);
    if (!founded.ok) throw new Error('the settler should have founded a city');
    expect(offers(founded.value.state, 0)).toBe(false);
    expect(applies(founded.value.state, 0)).toBe(false);
  });

  it('does not offer FoundCity for another player’s settler, and the applier refuses it', () => {
    const rival = withCities(
      // Tile 1 (hills) is land, and three tiles from the city on 13 — so this
      // settler has somewhere to found, and the only thing standing between it and
      // a city is whose settler it is.
      { ...STATE, nextUnitId: 4, units: [...STATE.units, unit(3, SETTLER, 1, 1, 2)] },
      [CITY],
    );

    // The per-unit generator speaks for the unit's own owner, so the rival settler
    // is offered its own city — but never to player 0, and applying it as player 0
    // is `not-your-unit`.
    expect(unitActions(rival, RULESET, asUnitId(3))).toContainEqual(foundCity(3));
    expect(
      [...legalActions(rival, RULESET, P0)].some(
        (cmd) => cmd.type === 'FoundCity' && cmd.unitId === asUnitId(3),
      ),
    ).toBe(false);
    expect(applyCommand(rival, P0, foundCity(3), RULESET).ok).toBe(false);
  });
});

describe('legalActions', () => {
  it("yields this player's unit actions, then a single EndTurn", () => {
    const actions = [...legalActions(STATE, RULESET, P0)];

    // The settler's FoundCity comes before its moves (see `unitActions`); the
    // scout has spent its movement and offers nothing; EndTurn is last.
    expect(actions).toEqual([
      foundCity(0),
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
    const units = actions.flatMap((cmd) =>
      cmd.type === 'MoveUnit' || cmd.type === 'FoundCity' ? [cmd.unitId] : [],
    );
    expect(units.every((unitId) => unitId !== asUnitId(2))).toBe(true);
  });

  it('is deterministic across walks, and lazy', () => {
    expect([...legalActions(STATE, RULESET, P0)]).toEqual([...legalActions(STATE, RULESET, P0)]);

    // A generator hands over one action at a time: asking for the first must not
    // materialise the whole space (PLAN.md §5.2).
    const walk = legalActions(STATE, RULESET, P0);
    expect(walk.next().done).toBe(false);
    // Seven in total (FoundCity, five moves, EndTurn), one of them already taken.
    expect([...walk]).toHaveLength(6);
  });

  it('yields nothing at all for a player that does not exist', () => {
    // Not even EndTurn: an action that `applyCommand` would refuse as
    // `unknown-player` must not be advertised as legal.
    expect([...legalActions(STATE, RULESET, asPlayerId(9))]).toEqual([]);
  });

  it('covers exactly the union of the player units’ actions, plus EndTurn', () => {
    const expected = [
      ...[asUnitId(0), asUnitId(1)].flatMap((unitId) => unitActions(STATE, RULESET, unitId)),
      { type: 'EndTurn' } as Command,
    ];

    expect([...legalActions(STATE, RULESET, P0)]).toEqual(expected);
  });

  it('does not advertise the two city choice commands, however many cities exist', () => {
    // `SetWorkedTiles` and `SetProduction` are queries, not actions: an assignment
    // is a search space and a production item is a content choice, so a generator
    // that yielded "the" assignment would advertise an arbitrary subset as if it
    // were the whole of what is legal. Their legality is asserted against the plan
    // evaluators in the keystone sweep below.
    for (const state of [CITY_STATE, SHARED_STATE]) {
      const actions = [...legalActions(state, RULESET, P0)];
      expect(actions.some((cmd) => cmd.type === 'SetWorkedTiles')).toBe(false);
      expect(actions.some((cmd) => cmd.type === 'SetProduction')).toBe(false);
      // …while a legal choice really is legal: the applier accepts it.
      expect(applyCommand(state, P0, setWorkedTiles(0, []), RULESET).ok).toBe(true);
      expect(applyCommand(state, P0, setProduction(0, unitItem('scout')), RULESET).ok).toBe(true);
    }
  });
});

describe('keystone — the generator and the applier agree, in both directions', () => {
  it('holds for the hand-built board, exhaustively, for both players', () => {
    // Soundness: FoundCity plus 5 settler moves plus 1 EndTurn for player 0; 1
    // EndTurn for player 1 (its warrior has spent everything, and a warrior cannot
    // found). Completeness: the applier accepts those same 8 and nothing else.
    // Asserted exactly, so the walk cannot pass vacuously.
    expect(assertEveryLegalActionApplies(STATE, RULESET, [P0, P1])).toBe(8);
    expect(assertEveryUnitActionApplies(STATE, RULESET)).toBe(6);
    expect(assertKeystone(STATE, RULESET, P0)).toEqual({ yielded: 7, accepted: 7 });
    expect(assertKeystone(STATE, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('holds on a board with cities, for both players', () => {
    // Cities change nothing about the action space yet — `FoundCity` is still the
    // only city command the generators express, and player 0's settler may still
    // found (its city on 13 is exactly MIN_CITY_DISTANCE away) — so the counts
    // match the cityless board. That is the point: adding cities did not change
    // what is *enumerated*, only what is *queried*.
    expect(assertEveryLegalActionApplies(CITY_STATE, RULESET, [P0, P1])).toBe(8);
    expect(assertKeystone(CITY_STATE, RULESET, P0)).toEqual({ yielded: 7, accepted: 7 });
    expect(assertKeystone(CITY_STATE, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('holds for a starved board and for a board where everything is affordable', () => {
    const starved: GameState = {
      ...STATE,
      units: STATE.units.map((u) => ({ ...u, movementLeft: 0 })),
    };
    const rich: GameState = withMovement(STATE, 1, SCOUT.movement);

    // A spent settler cannot *move*, but it can still *found*: founding costs no
    // movement in M3 (it consumes the unit instead), so each player offers one
    // action more than M2's board did.
    expect(assertEveryLegalActionApplies(starved, RULESET, [P0, P1])).toBe(3);
    expect(assertKeystone(starved, RULESET, P0)).toEqual({ yielded: 2, accepted: 2 });
    expect(assertKeystone(starved, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });

    expect(assertEveryLegalActionApplies(rich, RULESET, [P0, P1])).toBe(14);
    expect(assertKeystone(rich, RULESET, P0)).toEqual({ yielded: 13, accepted: 13 });
    expect(assertKeystone(rich, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });
  });

  it('holds on the M4a worker boards, exhaustively, for both players', () => {
    // Soundness: the settler's FoundCity plus 5 settler moves, the worker's 2 jobs
    // (road, then mine — irrigation is not hills work) plus 2 worker moves, and one
    // EndTurn: 11 for player 0. Player 1's warrior has spent its movement and can
    // neither found nor work, so it has the EndTurn alone. Completeness: the applier
    // accepts those same 11 and nothing else — so the walk cannot pass vacuously.
    expect(assertEveryLegalActionApplies(WORKER_STATE, RULESET, [P0, P1])).toBe(12);
    expect(assertEveryUnitActionApplies(WORKER_STATE, RULESET)).toBe(10);
    expect(assertKeystone(WORKER_STATE, RULESET, P0)).toEqual({ yielded: 11, accepted: 11 });
    expect(assertKeystone(WORKER_STATE, RULESET, P1)).toEqual({ yielded: 1, accepted: 1 });

    // A worker mid-job: the two jobs are gone, the cancel takes their place, and the
    // steps stay — a step is still legal, and it cancels the job (M4a), which is
    // exactly why the generator must keep offering it.
    expect(assertEveryLegalActionApplies(WORKING_STATE, RULESET, [P0, P1])).toBe(11);
    expect(assertEveryUnitActionApplies(WORKING_STATE, RULESET)).toBe(9);
    expect(assertKeystone(WORKING_STATE, RULESET, P0)).toEqual({ yielded: 10, accepted: 10 });

    // A tile that already carries a mine: that job is refused, the road is not.
    expect(assertEveryLegalActionApplies(MINED_STATE, RULESET, [P0, P1])).toBe(11);
    expect(assertEveryUnitActionApplies(MINED_STATE, RULESET)).toBe(9);
    expect(assertKeystone(MINED_STATE, RULESET, P0)).toEqual({ yielded: 10, accepted: 10 });
  });

  it('holds for a worker with no movement left: no job, no step, and no command the applier would take', () => {
    const spent = withMovement(WORKER_STATE, 3, 0);

    expect(unitActions(spent, RULESET, asUnitId(3))).toEqual([]);
    // Four units' worth of nothing to do plus the two EndTurns: the settler's
    // FoundCity and five steps, and nothing else.
    expect(assertEveryLegalActionApplies(spent, RULESET, [P0, P1])).toBe(8);
    expect(assertKeystone(spent, RULESET, P0)).toEqual({ yielded: 7, accepted: 7 });
  });

  it('agrees for the two work evaluators — the fourth and fifth generators', () => {
    // Each worker board accepts *and* refuses, so both directions are being compared.
    for (const board of [WORKER_STATE, WORKING_STATE, MINED_STATE]) {
      const totals = assertWorkAgreement(board, RULESET, P0);

      expect(totals.checked).toBeGreaterThan(0);
      expect(totals.accepted).toBeGreaterThan(0);
      expect(totals.refused).toBeGreaterThan(0);
    }

    // A board with no worker at all: the sweep still asks its two units (10
    // candidates) and accepts nothing, which is the right verdict for a settler and
    // a scout.
    for (const board of [STATE, CITY_STATE]) {
      expect(assertWorkAgreement(board, RULESET, P0)).toEqual({
        checked: 10,
        accepted: 0,
        refused: 10,
      });
    }

    // The exact shape on the worker board: three units of player 0's (0, 1 and 3),
    // each asked 4 kinds plus a cancel — 15 candidates — of which only the worker's
    // road and mine are accepted, and only those two are advertised.
    expect(assertWorkAgreement(WORKER_STATE, RULESET, P0)).toEqual({
      checked: 15,
      accepted: 2,
      refused: 13,
    });
    // Mid-job: the two jobs are refused (`already-working`) and the cancel is the one
    // accepted command; on an already-mined tile the mine is refused and only the
    // road is accepted. Same universe size, different acceptances — which is what
    // makes these sweeps about the state rather than about the fixture.
    expect(assertWorkAgreement(WORKING_STATE, RULESET, P0)).toEqual({
      checked: 15,
      accepted: 1,
      refused: 14,
    });
    expect(assertWorkAgreement(MINED_STATE, RULESET, P0)).toEqual({
      checked: 15,
      accepted: 1,
      refused: 14,
    });
    // Player 1's warrior can neither work nor cancel: the sweep is not vacuous (it
    // checks a unit) and accepts nothing, which is the correct verdict for a unit
    // that is not a worker.
    expect(assertWorkAgreement(WORKER_STATE, RULESET, P1)).toEqual({
      checked: 5,
      accepted: 0,
      refused: 5,
    });
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

    // The settler spent its 2 points on the hills, so it has no options left — but
    // it can still found where it now stands (tile 1 is hills: land).
    expect(unitMoveOptions(after.value.state, RULESET, asUnitId(0))).toEqual([]);
    expect(assertEveryLegalActionApplies(after.value.state, RULESET, [P0, P1])).toBe(3);
    expect(assertKeystone(after.value.state, RULESET, P0)).toEqual({ yielded: 2, accepted: 2 });
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

  it('holds on a real generated board after a city has been founded on it', () => {
    const board = generatedBoard(42);
    const founding = applyCommand(board, P0, foundCity(0), GEN_RULESET);
    if (!founding.ok) {
      throw new Error(
        `founding on a generated board was refused: ${JSON.stringify(founding.error)}`,
      );
    }
    const founded = founding.value.state;
    expect(founded.cities).toHaveLength(1);

    // The settler is gone (consumed), so player 0's next actions are its city's —
    // which are queries — and the board's *enumerated* actions are the produced
    // city's neighbours… of which there are none until it produces something. What
    // must hold: both directions still agree, and the choice commands are decided
    // by the same evaluator the applier uses.
    for (const playerId of [P0, P1]) {
      const one = assertEveryLegalActionApplies(founded, GEN_RULESET, [playerId]);
      expect(assertGeneratorIsComplete(founded, GEN_RULESET, playerId)).toBe(one);
    }

    const totals = assertSetterAgreement(founded, GEN_RULESET, P0);
    expect(totals.accepted).toBeGreaterThan(0);
    expect(totals.checked).toBeGreaterThan(totals.accepted);
  });

  it('holds for the city choice commands: the plan is the applier’s decision', () => {
    // The other half of the M3 extension (see the file header). Player 0's city on
    // 13, on a board where player 1's city on 5 works tile 8, so the
    // `tile-worked-by-another-city` branch is in the universe too.
    const totals = assertSetterAgreement(SHARED_STATE, RULESET, P0);

    // One city of player 0 (8 assignment shapes + 1 second-tile shape + 1 rival-claim
    // shape + 7 items) plus four commands aimed at city ids that do not exist.
    expect(totals.checked).toBe(21);
    expect(totals.accepted).toBeGreaterThan(0); // not vacuously all-refused
    expect(totals.checked).toBeGreaterThan(totals.accepted); // …nor all-accepted
    // And none of the accepted choices was advertised as an action.
    expect(totals.yielded).toBe(assertEveryLegalActionApplies(SHARED_STATE, RULESET, [P0]));
  });

  it('accepts a legal assignment the generator does not advertise (the stated scope)', () => {
    // Said out loud rather than left implicit: `legalActions` yields no assignment,
    // so a legal-but-unsolicited one applies without appearing in any action list.
    // The completeness claim for the setters is therefore "the applier's decision
    // is the plan evaluator's" (asserted above), not "every accepted setter command
    // is yielded" — which no generator could honour without enumerating
    // C(radius, population) assignments.
    const choice = setWorkedTiles(0, [8, 4]);

    expect(applyCommand(CITY_STATE, P0, choice, RULESET).ok).toBe(true);
    expect([...legalActions(CITY_STATE, RULESET, P0)].map(commandKey)).not.toContain(
      commandKey(choice),
    );
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
