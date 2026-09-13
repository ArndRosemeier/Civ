/**
 * M6's barbarians — **engine behaviour, not a policy** (docs/INTERFACES.md, M6,
 * "Barbarians are ENGINE behaviour, not a policy").
 *
 * What this file pins, and why each thing needs a test of its own:
 *
 * - **The exact tiles a band moves on a fixed board.** "Moves toward the nearest
 *   civilization city" is only a rule if it produces named tiles, so the approach is
 *   asserted tile by tile rather than as "it got closer".
 * - **An adjacent attack, resolving through the applier's own combat path.** The
 *   requirement is "not a second combat implementation", and the proof is behavioural:
 *   `advanceTurn`'s battle for a barbarian is deep-equal to `applyCommand`'s battle for
 *   the *same* command on the *same* board — same odds, same rounds, same losses — and it
 *   draws the same number of values from `state.rng`. A mirrored board where a
 *   *civilization* is the attacker with the same statistics gets the same odds, so no
 *   part of a battle reads who owns which unit.
 * - **A city capture**, by a band that walked to it.
 * - **The tie-break, which is by ascending tile index and not by iteration order.** The
 *   board has two cities the same distance away, on opposite sides, so the two choices
 *   produce *different* steps — and the test re-runs it with `state.cities` in the
 *   opposite order and asserts the same tile. (M5's finding was that row order is a real
 *   input; this is the city-list form of the same class of bug.)
 * - **The nearest city is the nearest one, not the nearest *reachable* one**, with the
 *   discriminating board where the nearer city is walled off. That is a stated reading of
 *   a placeholder rule, and a band that waits is its honest consequence; the test also
 *   asserts what the *other* city would have made it do, so an implementation that fell
 *   back would fail rather than pass quietly.
 * - **A band may leave a tile it could never re-enter** (a warrior standing on a hill).
 * - **No road discount — for a barbarian or for anybody else.** Roads are read for yields
 *   and for connectivity in this engine, never for movement, and the test measures the
 *   barbarian half of that against the plain board.
 * - **Over a long run: barbarians gain no gold, research nothing and build nothing**,
 *   measured from the event stream and the state rather than asserted once.
 *
 * Every fixture number (the combat statistics, the movement of 1 and 2, the hill's cost of
 * 2) is a **placeholder** chosen to make a rule visible, exactly as the engine's own
 * catalog rows are — none of it is claimed to be Civ 3's.
 */

import { describe, expect, it } from 'vitest';
import { hashValue } from '@civts/testing';
import {
  BARBARIAN_PROVENANCE,
  advanceBarbarians,
  barbarianAttackTarget,
  barbarianPlayer,
  barbarianStepBudget,
  barbarianStepTile,
  nearestCivCityTile,
} from '../src/barbarians.js';
import type { City } from '../src/cities.js';
import { applyCommand, type GameEvent } from '../src/commands.js';
import type { CombatDef } from '../src/combat.js';
import {
  asCityId,
  asGovernmentId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type PlayerId,
} from '../src/ids.js';
import { asImprovementId, withImprovement, type ImprovementDef } from '../src/improvements.js';
import type { GameMap, RulesetView, TerrainDef } from '../src/map.js';
import { isPlaceholder } from '../src/provenance.js';
import { seedRng } from '../src/rng.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';

import { advanceTurn } from '../src/turn.js';
import type { Unit, UnitDef, UnitRole } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const GRASSLAND = asTerrainId('grassland');
const HILLS = asTerrainId('hills');
const MOUNTAINS = asTerrainId('mountains');

/** Cost 1 and no defensive bonus, so a step's price is the plain number. */
const GRASSLAND_DEF: TerrainDef = {
  id: GRASSLAND,
  role: 'grassland',
  name: 'Grassland',
  moveCost: 1,
  defenseBonusPct: 0,
  yields: { food: 2, shields: 1, commerce: 1 },
  impassable: false,
};

/**
 * Cost 2 — so a movement-1 unit can never *enter* one, while a movement-2 unit can — and
 * a 50% defensive bonus. That asymmetry is what the departure and road tests need.
 */
const HILLS_DEF: TerrainDef = {
  id: HILLS,
  role: 'hills',
  name: 'Hills',
  moveCost: 2,
  defenseBonusPct: 50,
  yields: { food: 1, shields: 2, commerce: 0 },
  impassable: false,
};

const MOUNTAINS_DEF: TerrainDef = {
  id: MOUNTAINS,
  role: 'mountains',
  name: 'Mountains',
  moveCost: 3,
  defenseBonusPct: 100,
  yields: { food: 0, shields: 1, commerce: 0 },
  impassable: true,
};

/**
 * A map from rows of characters, row-major: `.` grassland, `h` hills, `^` impassable
 * mountains. Rows are written top first, which is how `GameMap.terrain` is stored
 * (`index = y * width + x`), so a fixture reads like the board it describes.
 */
const mapOf = (...rows: readonly string[]): GameMap => ({
  width: rows[0]?.length ?? 0,
  height: rows.length,
  terrain: rows.flatMap((row) =>
    Array.from(row, (cell) => (cell === 'h' ? HILLS : cell === '^' ? MOUNTAINS : GRASSLAND)),
  ),
  huts: [],
  resources: [],
});

const unitDefOf = (
  id: string,
  role: UnitRole,
  attack: number,
  defense: number,
  hitPoints: number,
  movement: number,
  cost: number,
): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack,
  defense,
  hitPoints,
  movement,
  cost,
  domain: 'land',
});

/** The ordinary band member: one movement, one attack, three hit points. */
const WARRIOR = unitDefOf('warrior', 'military', 1, 1, 3, 1, 1);
/** A raider with two movement, so "it spends its movement" is visible. */
const HORSEMAN = unitDefOf('horseman', 'military', 2, 1, 2, 2, 2);
/** A lopsided attacker, so a battle the barbarians win is not a coin flip. */
const WARLORD = unitDefOf('warlord', 'military', 6, 5, 5, 1, 3);
/** A defender whose 2 defence makes the odds worth reading. */
const SPEARMAN = unitDefOf('spearman', 'military', 1, 2, 3, 1, 2);
/** Cannot attack at all (`attack === 0`) — M6's legality rule, not a footnote. */
const SCOUT = unitDefOf('scout', 'scout', 0, 1, 1, 2, 1);

const ROAD: ImprovementDef = {
  id: asImprovementId('road'),
  kind: 'road',
  name: 'Road',
  turns: 1,
  yields: { food: 0, shields: 0, commerce: 0 },
  allowedRoles: ['grassland', 'hills'],
};

const RULESET: RulesetView & { readonly combat: CombatDef } = {
  terrains: [GRASSLAND_DEF, HILLS_DEF, MOUNTAINS_DEF],
  units: [WARRIOR, HORSEMAN, WARLORD, SPEARMAN, SCOUT],
  buildings: [],
  improvements: [ROAD],
  resources: [],
  // M6b: the combat magnitudes are catalog content now, and `combatRulesOf` reads them off
  // the ruleset it is handed. A view that declares no `combat` section therefore fights
  // under the *degenerate* table (`NO_COMBAT_RULES`: no bonuses, `rollBound: 1`, no
  // promotions), which is the deliberate answer `core/combat.ts` gives for "this ruleset
  // states no combat rules" — an absent section must change the odds rather than silently
  // reproduce the shipped ones.
  //
  // This fixture is about *barbarian behaviour*, not about a ruleset without combat, so it
  // declares the shipped table's nine numbers. They are written out here for the same
  // reason every other row in this view is: a hand-built fixture states the world it wants,
  // and the two tests in "M6 — a barbarian attack is the applier's attack" that check the
  // battle came out of the world's RNG stream (and that the attacker survived it) are
  // exactly the ones that need a ruleset under which an attack can be *won*.
  combat: {
    fortifyBonusPct: 25,
    cityDefenseBonusPct: 50,
    wallsBonusPct: 50,
    veteranAttackPct: 25,
    maxExperience: 3,
    rollBound: 100,
    damagePerRound: 1,
    minWinPct: 1,
    maxWinPct: 99,
  },
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (index: number, kind: 'civ' | 'barbarian'): PlayerState => ({
  id: asPlayerId(index),
  name: index === 2 ? 'Barbarians' : `Player ${String(index + 1)}`,
  color: '#000000',
  startingTile: asTileIndex(0),
  kind,
  // Barbarians carry the money fields too, inert, exactly as `newGame` writes them.
  treasury: kind === 'barbarian' ? 0 : STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  techs: [],
  government: asGovernmentId('despotism'),
});

const civ0 = player(0, 'civ');
const civ1 = player(1, 'civ');
const BARBARIANS = player(2, 'barbarian');
const P0 = asPlayerId(0);
const P1 = asPlayerId(1);
const BARBARIAN_ID = asPlayerId(2);

/** A unit at full health: `hitPointsLeft` is written out, so a wound is visible. */
const unit = (
  id: number,
  def: UnitDef,
  owner: number,
  tile: number,
  movementLeft = def.movement,
): Unit => ({
  id: asUnitId(id),
  type: def.id,
  owner: asPlayerId(owner),
  tile: asTileIndex(tile),
  movementLeft,
  hitPointsLeft: def.hitPoints ?? 1,
});

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
  // M9: a city's accumulated culture. `borders.ts` derives a city's claim radius
  // from this and `computeTileOwner` reads it, so a hand-built city states a number
  // rather than leaving the engine to guess one.
  culture: 0,
  ...overrides,
});

const GRASS_5X5 = mapOf('.....', '.....', '.....', '.....', '.....');

/**
 * **A garrison for a civilization that would otherwise be off the board**, placed as far as
 * the map allows from every barbarian band.
 *
 * M10's conquest condition has no threshold in it — "you are the last civilization on the
 * board" — and a civilization that owns neither a city nor a unit is, by that rule, gone. A
 * board where `civ1` was simply never given anything is therefore a *finished* game, and
 * `advanceTurn` refuses to move a finished game, so every barbarian approach in this file
 * would be measured on a board that never advanced.
 *
 * This file is about what barbarians do, not about who wins, so `board()` keeps every
 * civilization in play. The unit is placed on the tile whose **nearest barbarian is
 * farthest away** (ties to the lowest index), which is what keeps it out of the way: a band
 * attacks what it is adjacent to, and this file's bands walk diagonals and short routes.
 * The placement is computed from the board rather than written down, because this file's
 * maps, city tiles and band starts all differ from test to test and a fixed tile would be
 * adjacent to one of them.
 */
const garrisonTile = (state: {
  readonly map: GameMap;
  readonly units: readonly Unit[];
  readonly cities: readonly City[];
}): number => {
  const occupied = new Set<number>([
    ...state.units.map((each) => Number(each.tile)),
    ...state.cities.map((each) => Number(each.tile)),
  ]);
  const bands = state.units.filter((each) => Number(each.owner) === Number(BARBARIAN_ID));
  let best = -1;
  let bestDistance = -1;
  for (let tile = 0; tile < state.map.width * state.map.height; tile += 1) {
    if (occupied.has(tile)) continue;
    let nearest = Number.MAX_SAFE_INTEGER;
    for (const band of bands) {
      const dx = Math.abs((tile % state.map.width) - (Number(band.tile) % state.map.width));
      const dy = Math.abs(
        Math.floor(tile / state.map.width) - Math.floor(Number(band.tile) / state.map.width),
      );
      nearest = Math.min(nearest, Math.max(dx, dy));
    }
    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = tile;
    }
  }
  return best < 0 ? 0 : best;
};

const board = (overrides: Partial<GameState> = {}): GameState => {
  const map = overrides.map ?? GRASS_5X5;
  const players = overrides.players ?? [civ0, civ1, BARBARIANS];
  const state = {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    turn: 1,
    seed: 7,
    settings: SETTINGS,
    rng: { a: 1, b: 2, c: 3, d: 4 },
    map,
    players,
    nextUnitId: 100,
    units: [],
    explored: players.map(() => Array.from({ length: map.width * map.height }, () => false)),
    nextCityId: 100,
    // M9: the materialised ownership layer. `[]` is the honest value for a
    // state nobody has run a turn on: `withOwnership` fills it from the cities the
    // moment ownership matters, and `computeTileOwner` never reads it, so an empty
    // layer cannot make a border wrong — it only means none has been claimed yet.
    tileOwner: [],
    cities: [],
    improvements: [],
    ...overrides,
  };

  // Keep every civilization on the board (see `garrisonTile`). A civilization this state does
  // not mention at all has not been conquered — it has not been placed.
  const absent = players.filter(
    (each) =>
      each.kind === 'civ' &&
      !state.cities.some((city) => city.owner === each.id) &&
      !state.units.some((each2) => each2.owner === each.id),
  );
  if (absent.length === 0) return state;

  const tile = garrisonTile(state);
  const garrisoned = absent.map((each, at) => ({
    ...unit(90 + at, SCOUT, Number(each.id), tile),
    // One tile cannot hold two units, so each further garrison steps one tile along; this
    // file's boards never have more than one absent civilization.
    tile: asTileIndex(tile + at),
  }));
  return { ...state, units: [...state.units, ...garrisoned] };
};

const unitsOf = (state: GameState, owner: PlayerId): readonly Unit[] =>
  state.units.filter((each) => each.owner === owner);

const tileOf = (state: GameState, unitId: number): number | undefined => {
  const found = state.units.find((each) => each.id === asUnitId(unitId));
  return found === undefined ? undefined : Number(found.tile);
};

const healthOf = (state: GameState): readonly (readonly [number, number])[] =>
  state.units.map((each) => [Number(each.id), each.hitPointsLeft ?? 1] as const);

/** Every `UnitMoved` in `events`, as plain numbers a test can compare literally. */
const moves = (
  events: readonly GameEvent[],
): readonly { readonly from: number; readonly to: number; readonly cost: number }[] =>
  events.flatMap((event) =>
    event.type === 'UnitMoved'
      ? [{ from: Number(event.from), to: Number(event.to), cost: event.cost }]
      : [],
  );

const eventTypes = (events: readonly GameEvent[]): readonly string[] =>
  events.map((event) => event.type);

const ofType = <T extends GameEvent['type']>(
  events: readonly GameEvent[],
  type: T,
): readonly Extract<GameEvent, { type: T }>[] =>
  events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);

/* ------------------------------------------------------------------ *
 * The approach: exact tiles on a fixed board
 * ------------------------------------------------------------------ */

/**
 * A 5×5 grassland board whose corner-to-corner diagonal makes every step unambiguous:
 * from `(0,0)` the only neighbour strictly closer (in walkable steps) to `(4,4)` is
 * `(1,1)`, then `(2,2)`, then `(3,3)` — and `(3,3)` is adjacent to the city. So a
 * movement-1 warrior walks `0 → 6 → 12 → 18` and captures on the fourth turn.
 */
const DIAGONAL_CITY_TILE = 24;
const DIAGONAL_WALK: readonly number[] = [6, 12, 18];

const marchBoard = (): GameState =>
  board({
    cities: [city(0, 0, DIAGONAL_CITY_TILE)],
    units: [unit(0, WARRIOR, 2, 0)],
  });

describe('M6 — barbarians approach the nearest civilization city', () => {
  it('walks the exact tiles it approaches by, one per movement point', () => {
    let state = marchBoard();
    const walked: { from: number | undefined; to: number; cost: number }[] = [];

    for (const expected of DIAGONAL_WALK) {
      const outcome = advanceTurn(state, RULESET);
      walked.push(...moves(outcome.events).map((move) => ({ ...move })));
      state = outcome.state;
      expect(tileOf(state, 0)).toBe(expected);
    }

    expect(walked).toStrictEqual([
      { from: 0, to: 6, cost: 1 },
      { from: 6, to: 12, cost: 1 },
      { from: 12, to: 18, cost: 1 },
    ]);
    // The refill hands the movement back at the end of every turn, which is what lets the
    // band walk once per turn, turn after turn.
    expect(unitsOf(state, BARBARIAN_ID)[0]?.movementLeft).toBe(WARRIOR.movement);
  });

  it('captures the undefended city it walked up to, on the turn it arrives', () => {
    let state = marchBoard();
    for (let turn = 0; turn < DIAGONAL_WALK.length; turn += 1) {
      state = advanceTurn(state, RULESET).state;
    }
    expect(tileOf(state, 0)).toBe(18);

    const arrival = advanceTurn(state, RULESET);

    expect(ofType(arrival.events, 'CityCaptured')).toStrictEqual([
      {
        type: 'CityCaptured',
        cityId: asCityId(0),
        from: P0,
        to: BARBARIAN_ID,
        tile: asTileIndex(DIAGONAL_CITY_TILE),
        name: 'City 1',
        population: 1,
        destroyed: [],
      },
    ]);
    expect(arrival.state.cities[0]?.owner).toBe(BARBARIAN_ID);
    // The capture is not a battle: nothing was fought, so no `CombatResolved` is reported.
    expect(eventTypes(arrival.events)).not.toContain('CombatResolved');
  });

  it('is a pure function of the state: the same board twice gives the same state and events', () => {
    const state = marchBoard();
    const before = hashValue(state);

    const first = advanceTurn(state, RULESET);
    const second = advanceTurn(state, RULESET);

    expect(hashValue(state)).toBe(before);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toStrictEqual(second.events);
  });

  it('walks the same exact tiles whatever the seed holds, because walking draws nothing', () => {
    // M6's acceptance evidence asks for the approach "on a fixed seed, with the exact
    // tiles moved". The tiles do not depend on the seed at all — that is the point of a
    // step whose only randomness is a battle's — so the same board walked under three
    // very different streams produces one path, and every stream is left where it started.
    const paths = [seedRng(12345), seedRng(1), { a: 0, b: 0, c: 0, d: 0 }].map((rng) => {
      let state = board({
        cities: [city(0, 0, DIAGONAL_CITY_TILE)],
        units: [unit(0, WARRIOR, 2, 0)],
        rng,
      });
      const walked: number[] = [];
      for (let turn = 0; turn < DIAGONAL_WALK.length; turn += 1) {
        const outcome = advanceTurn(state, RULESET);
        expect(moves(outcome.events)).toHaveLength(1);
        state = outcome.state;
        walked.push(Number(tileOf(state, 0)));
      }
      return { walked, rngAtEnd: state.rng, started: rng, housing: state.cities[0]?.owner };
    });

    for (const { walked, started, rngAtEnd, housing } of paths) {
      expect(walked).toStrictEqual(DIAGONAL_WALK);
      expect(rngAtEnd).toStrictEqual(started);
      expect(housing).toBe(P0);
    }
  });

  it('draws nothing from the RNG when it only walks', () => {
    const state = marchBoard();
    const outcome = advanceTurn(state, RULESET);

    // The step's only randomness is combat's, and it comes from `state.rng`; a band that
    // has met nobody must not advance the world's stream at all — and must never touch a
    // policy's stream, which it cannot even see.
    expect(outcome.state.rng).toStrictEqual(state.rng);
    expect(tileOf(outcome.state, 0)).toBe(6);
  });

  it('spends two movement points on two steps, and no more', () => {
    const state = board({
      cities: [city(0, 0, DIAGONAL_CITY_TILE)],
      units: [unit(0, HORSEMAN, 2, 0)],
    });

    const outcome = advanceTurn(state, RULESET);

    expect(moves(outcome.events)).toStrictEqual([
      { from: 0, to: 6, cost: 1 },
      { from: 6, to: 12, cost: 1 },
    ]);
    // Two steps for two points, and the refill at the end of the turn gives the pair back.
    expect(unitsOf(outcome.state, BARBARIAN_ID)[0]?.movementLeft).toBe(HORSEMAN.movement);
  });

  it('stays exactly where it is when there is no city to head for', () => {
    // There is no rule for wandering, and inventing one would need a draw the contract
    // does not grant this step. So a band with no target holds its ground.
    const state = board({ units: [unit(0, WARRIOR, 2, 0)] });
    const outcome = advanceTurn(state, RULESET);

    expect(tileOf(outcome.state, 0)).toBe(0);
    expect(moves(outcome.events)).toStrictEqual([]);
  });

  it('does nothing at all for a state whose barbarian player owns no units', () => {
    const withoutBarbarians = board({ cities: [city(0, 0, DIAGONAL_CITY_TILE)] });
    const withThem = board({
      cities: [city(0, 0, DIAGONAL_CITY_TILE)],
      players: [civ0, civ1, { ...BARBARIANS, startingTile: asTileIndex(DIAGONAL_CITY_TILE) }],
    });

    expect(advanceTurn(withThem, RULESET).events).toStrictEqual(
      advanceTurn(withoutBarbarians, RULESET).events,
    );
    expect(advanceBarbarians(withoutBarbarians, RULESET).events).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The attack: the applier's combat path, not a second one
 * ------------------------------------------------------------------ */

/** A 3×3 board: the band on tile 0, the other civilization's spear two steps diagonally. */
const skirmishBoard = (overrides: Partial<GameState> = {}): GameState =>
  board({
    map: mapOf('...', '...', '...'),
    units: [unit(0, WARLORD, 2, 0), unit(1, SPEARMAN, 1, 4)],
    ...overrides,
  });

const ATTACK_COMMAND = { type: 'AttackUnit', unitId: asUnitId(0), target: asTileIndex(4) } as const;

describe('M6 — a barbarian attack is the applier’s attack', () => {
  it('attacks the adjacent enemy unit, and the pipeline’s battle is applyCommand’s battle', () => {
    const state = skirmishBoard();

    // The applier's own answer for the same command on the same board, resolved outside
    // the pipeline. If the barbarian step had its own resolver, its odds or its draws,
    // these two would differ.
    const direct = applyCommand(state, BARBARIAN_ID, ATTACK_COMMAND, RULESET);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;

    const outcome = advanceTurn(state, RULESET);

    expect(ofType(outcome.events, 'CombatResolved')).toStrictEqual(
      ofType(direct.value.events, 'CombatResolved'),
    );
    expect(ofType(outcome.events, 'CombatResolved')[0]).toMatchObject({
      attackerId: asUnitId(0),
      attackerOwner: BARBARIAN_ID,
      defenderId: asUnitId(1),
      defenderOwner: P1,
      target: asTileIndex(4),
    });

    // The same battle drew the same values from the world's stream and took the same hit
    // points off the same units. (`movementLeft` is deliberately not compared: the
    // pipeline's refill runs after the step and the bare command has no refill in it.)
    expect(outcome.state.rng).toStrictEqual(direct.value.state.rng);
    expect(healthOf(outcome.state)).toStrictEqual(healthOf(direct.value.state));
    expect(ofType(outcome.events, 'UnitDestroyed')).toStrictEqual(
      ofType(direct.value.events, 'UnitDestroyed'),
    );
    expect(ofType(outcome.events, 'UnitPromoted')).toStrictEqual(
      ofType(direct.value.events, 'UnitPromoted'),
    );
  });

  it('gives a civilization the same odds for the same statistics — ownership is not an input', () => {
    // The mirror image of the skirmish: the *civilization* owns the attacker, the
    // barbarians own the defender. Same statistics, same tiles, same RNG.
    const barbarianOnTop = skirmishBoard();
    const civOnTop = skirmishBoard({
      units: [unit(0, WARLORD, 0, 0), unit(1, SPEARMAN, 2, 4)],
    });

    const asBarbarian = applyCommand(barbarianOnTop, BARBARIAN_ID, ATTACK_COMMAND, RULESET);
    const asCiv = applyCommand(civOnTop, P0, ATTACK_COMMAND, RULESET);

    expect(asBarbarian.ok && asCiv.ok).toBe(true);
    if (!asBarbarian.ok || !asCiv.ok) return;

    const barbarianBattle = ofType(asBarbarian.value.events, 'CombatResolved')[0];
    const civBattle = ofType(asCiv.value.events, 'CombatResolved')[0];
    expect(barbarianBattle).toBeDefined();
    expect(civBattle).toBeDefined();
    if (barbarianBattle === undefined || civBattle === undefined) return;

    expect({
      outcome: civBattle.outcome,
      rounds: civBattle.rounds,
      attackerLost: civBattle.attackerLost,
      defenderLost: civBattle.defenderLost,
      attackerWinPct: civBattle.attackerWinPct,
    }).toStrictEqual({
      outcome: barbarianBattle.outcome,
      rounds: barbarianBattle.rounds,
      attackerLost: barbarianBattle.attackerLost,
      defenderLost: barbarianBattle.defenderLost,
      attackerWinPct: barbarianBattle.attackerWinPct,
    });

    // The rest of the two answers is the same too, down to the RNG state.
    expect(asCiv.value.state.rng).toStrictEqual(asBarbarian.value.state.rng);
  });

  it('resolves the battle out of the state’s stream, so the same seed gives the same battle', () => {
    const first = advanceTurn(skirmishBoard({ rng: seedRng(99) }), RULESET);
    const second = advanceTurn(skirmishBoard({ rng: seedRng(99) }), RULESET);

    expect(first.events).toStrictEqual(second.events);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    // The battle spent the world's stream: it is not ambient randomness, and it is not a
    // policy's stream.
    expect(first.state.rng).not.toStrictEqual(seedRng(99));
  });

  it('does not attack a stack — the applier refuses `target-stacked` for everyone', () => {
    // Two units of the other civilization on one tile is exactly the case M6 excludes
    // ("exactly one enemy-occupied thing"), and `barbarianAttackTarget` is `planAttackUnit`:
    // the barbarian is bound by the same rule a civilization is, and walks around instead.
    const state = board({
      map: mapOf('...', '...', '...'),
      cities: [city(0, 0, 8)],
      units: [unit(0, WARLORD, 2, 1), unit(1, SPEARMAN, 1, 4), unit(2, SPEARMAN, 1, 4)],
    });

    const [band] = unitsOf(state, BARBARIAN_ID);
    expect(band).toBeDefined();
    if (band === undefined) return;

    expect(barbarianAttackTarget(state, RULESET, band)).toBeUndefined();

    const outcome = advanceTurn(state, RULESET);

    expect(eventTypes(outcome.events)).not.toContain('CombatResolved');
    // Tile 4 is one step closer to the city at tile 8, and it cannot enter an enemy-held
    // tile — so it takes the next-closest step, tile 5, and the stack is untouched.
    expect(moves(outcome.events)).toStrictEqual([{ from: 1, to: 5, cost: 1 }]);
    expect(unitsOf(outcome.state, P1)).toHaveLength(2);
  });

  it('does not attack when its own type cannot attack, and walks on instead', () => {
    // A scout has `attack === 0`. M6's rule is a legality rule, so a barbarian scout is a
    // mover rather than a fighter — through the same evaluator that refuses a player's.
    const state = board({
      cities: [city(0, 0, DIAGONAL_CITY_TILE)],
      units: [unit(0, SCOUT, 2, 0), unit(1, SPEARMAN, 1, 1)],
    });

    const [scout] = unitsOf(state, BARBARIAN_ID);
    expect(scout).toBeDefined();
    if (scout === undefined) return;

    expect(barbarianAttackTarget(state, RULESET, scout)).toBeUndefined();

    const outcome = advanceTurn(state, RULESET);
    expect(eventTypes(outcome.events)).not.toContain('CombatResolved');
    // Tile 1 holds the enemy spear, so the band takes the next step on its route west.
    expect(moves(outcome.events)).toStrictEqual([
      { from: 0, to: 6, cost: 1 },
      { from: 6, to: 12, cost: 1 },
    ]);
  });

  it('attacks an adjacent defender rather than walking past it', () => {
    // "Attacks ... when it can" is rule 1 and moving is rule 2: the horse band beside the
    // scout attacks, and the attack ends its turn — so there is no move in the events.
    const state = board({
      map: mapOf('...', '...', '...'),
      units: [unit(0, HORSEMAN, 2, 0), unit(1, SCOUT, 1, 4)],
    });

    const outcome = advanceTurn(state, RULESET);

    expect(moves(outcome.events)).toStrictEqual([]);
    expect(ofType(outcome.events, 'CombatResolved')).toHaveLength(1);
  });

  it('refills the movement it spent on the attack, which is what makes it one action per turn', () => {
    const state = board({
      map: mapOf('...', '...', '...'),
      units: [unit(0, WARLORD, 2, 0), unit(1, SCOUT, 1, 4)],
    });

    const outcome = advanceTurn(state, RULESET);
    const battle = ofType(outcome.events, 'CombatResolved')[0];
    expect(battle?.attackerSurvives).toBe(true);

    // The attack spent the whole turn (`AttackUnit` costs the rest of the movement), and
    // the refill runs *after* the barbarian step — so the band starts the next turn whole.
    // With the refill first, this would be 0 and every barbarian would act every other turn.
    expect(unitsOf(outcome.state, BARBARIAN_ID)[0]?.movementLeft).toBe(WARLORD.movement);
  });
});

/* ------------------------------------------------------------------ *
 * The tie-break: ascending tile index, not iteration order
 * ------------------------------------------------------------------ */

/**
 * Two civilization cities the same distance from the band and on opposite sides of it, so
 * the two candidate targets produce **different** steps: toward the low-index city the
 * best step is tile 6, toward the high-index city it is tile 16. A rule that kept the
 * first city it met would answer differently for `[low, high]` than for `[high, low]`.
 */
const LOW_CITY = city(0, 0, 2);
const HIGH_CITY = city(1, 1, 22);
const tieBoard = (cities: readonly City[]): GameState =>
  board({ cities, units: [unit(0, WARRIOR, 2, 12)] });

describe('M6 — the tie-break is the city tile, never the list order', () => {
  it('picks the lower tile index when two cities are equally near', () => {
    const state = tieBoard([LOW_CITY, HIGH_CITY]);

    expect(nearestCivCityTile(state, asTileIndex(12))).toBe(2);

    const [band] = unitsOf(state, BARBARIAN_ID);
    expect(band).toBeDefined();
    if (band === undefined) return;

    const towardLow = barbarianStepTile(state, RULESET, band, asTileIndex(2));
    const towardHigh = barbarianStepTile(state, RULESET, band, asTileIndex(22));

    expect(towardLow).toBe(6);
    expect(towardHigh).toBe(16);
    // This test discriminates only while those two differ; assert it rather than trust it.
    expect(towardLow).not.toBe(towardHigh);
    // And end to end, the band walks toward the lower-index city.
    expect(moves(advanceTurn(state, RULESET).events)).toStrictEqual([{ from: 12, to: 6, cost: 1 }]);
  });

  it('gives the same answer with `state.cities` in the opposite order', () => {
    const forward = tieBoard([LOW_CITY, HIGH_CITY]);
    const reversed = tieBoard([HIGH_CITY, LOW_CITY]);

    expect(nearestCivCityTile(reversed, asTileIndex(12))).toBe(
      nearestCivCityTile(forward, asTileIndex(12)),
    );

    const [forwardBand] = unitsOf(forward, BARBARIAN_ID);
    const [reversedBand] = unitsOf(reversed, BARBARIAN_ID);
    expect(forwardBand).toBeDefined();
    expect(reversedBand).toBeDefined();
    if (forwardBand === undefined || reversedBand === undefined) return;

    const target = asTileIndex(2);
    expect(barbarianStepTile(reversed, RULESET, reversedBand, target)).toBe(
      barbarianStepTile(forward, RULESET, forwardBand, target),
    );
    expect(moves(advanceTurn(reversed, RULESET).events)).toStrictEqual([
      { from: 12, to: 6, cost: 1 },
    ]);
  });

  it('waits when the nearest city is walled off, rather than turning to a farther one', () => {
    // The nearer city sits behind an impassable ridge (row 1 is solid mountains) and a
    // *reachable* city is farther away. "The nearest city" is the rule; "the nearest city
    // it can actually walk to" is a different rule, and this band waits.
    const state = board({
      map: mapOf('.......', '^^^^^^^', '.......', '.......', '.......', '.......', '.......'),
      cities: [city(0, 0, 3), city(1, 1, 34)],
      units: [unit(0, WARRIOR, 2, 17)],
    });

    expect(nearestCivCityTile(state, asTileIndex(17))).toBe(3);

    const [band] = unitsOf(state, BARBARIAN_ID);
    expect(band).toBeDefined();
    if (band === undefined) return;

    expect(barbarianStepTile(state, RULESET, band, asTileIndex(3))).toBeUndefined();
    // The discriminating half: the *farther* city would send it to tile 18, which is a
    // legal step — so an implementation that fell back to a reachable city would move.
    expect(barbarianStepTile(state, RULESET, band, asTileIndex(34))).toBe(18);

    const outcome = advanceTurn(state, RULESET);
    expect(moves(outcome.events)).toStrictEqual([]);
    expect(tileOf(outcome.state, 0)).toBe(17);
  });
});

/* ------------------------------------------------------------------ *
 * Terrain, roads and the departure rule
 * ------------------------------------------------------------------ */

describe('M6 — terrain, roads and where a band may leave from', () => {
  it('may leave a hill it could never re-enter, at the destination’s price', () => {
    // A movement-1 warrior standing on hills (cost 2) could not walk back up, but "may I
    // leave where I stand" is a departure rule, not an entry rule: it steps down to
    // grassland and pays the grassland's cost of 1.
    const state = board({
      map: mapOf('.....', '.....', '..h..', '.....', '.....'),
      cities: [city(0, 0, 24)],
      units: [unit(0, WARRIOR, 2, 12)],
    });

    const [band] = unitsOf(state, BARBARIAN_ID);
    expect(band).toBeDefined();
    if (band === undefined) return;

    expect(barbarianStepBudget(RULESET, band)).toBe(WARRIOR.movement);
    expect(barbarianStepTile(state, RULESET, band, asTileIndex(24))).toBe(18);
    expect(moves(advanceTurn(state, RULESET).events)).toStrictEqual([
      { from: 12, to: 18, cost: 1 },
    ]);
  });

  it('routes around hills it cannot afford instead of walking at them', () => {
    // Hills sit between the band and the city, and a movement-1 warrior can never enter
    // one. The route search plans inside the unit's own budget, so the band heads east
    // along the open row rather than north-east into the ridge; a search that ignored the
    // budget would step to tile 6 and wedge itself there.
    const state = board({
      map: mapOf('.....', '.....', '.....', '.hhh.', '.....'),
      cities: [city(0, 0, 24)],
      units: [unit(0, WARRIOR, 2, 0)],
    });

    const outcome = advanceTurn(state, RULESET);

    expect(moves(outcome.events)).toStrictEqual([{ from: 0, to: 1, cost: 1 }]);
    expect(tileOf(outcome.state, 0)).toBe(1);
  });

  it('gets no discount from a road, and a road does not make a hill enterable', () => {
    // A city on a peninsula behind a single hill pass: `^^h^^` is the only way through.
    const map = mapOf('.....', '^^h^^', '.....', '.....', '.....');
    const state = board({
      map,
      cities: [city(0, 0, 2)],
      units: [unit(0, HORSEMAN, 2, 12)],
    });
    const roaded = withImprovement(
      withImprovement(state, asTileIndex(7), ROAD.id),
      asTileIndex(12),
      ROAD.id,
    );

    // The horse (two movement) pays the hill's price of 2, road or no road: a step costs
    // the destination *terrain's* `moveCost`, and improvements are read for yields and for
    // connectivity in this engine, never for movement.
    expect(roaded.improvements).toHaveLength(2);
    const plainMove = moves(advanceTurn(state, RULESET).events);
    expect(plainMove).toStrictEqual([{ from: 12, to: 7, cost: 2 }]);
    expect(moves(advanceTurn(roaded, RULESET).events)).toStrictEqual(plainMove);

    // And the road does not let a movement-1 warrior into the pass at all: the same board
    // with a warrior is a band that cannot reach its target, road or no road.
    const warrior = withImprovement(
      board({ map, cities: [city(0, 0, 2)], units: [unit(0, WARRIOR, 2, 12)] }),
      asTileIndex(7),
      ROAD.id,
    );
    const [band] = unitsOf(warrior, BARBARIAN_ID);
    expect(band).toBeDefined();
    if (band === undefined) return;

    expect(barbarianStepTile(warrior, RULESET, band, asTileIndex(2))).toBeUndefined();
    expect(moves(advanceTurn(warrior, RULESET).events)).toStrictEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * What barbarians never do, over a long run
 * ------------------------------------------------------------------ */

/**
 * The money and research events. A barbarian must never be named by one: they have no
 * economy (`economy.ts` skips the player) and no research (`techs.ts`' `applyResearch`
 * skips the player), and a long run is checked against the whole list rather than against
 * one event.
 */
const FORBIDDEN_FOR_BARBARIANS: readonly string[] = [
  'IncomeCollected',
  'UpkeepPaid',
  'TreasuryShortfall',
  'UnitDisbanded',
  'TechResearched',
];

describe('M6 — over a long run the barbarians gain no gold, research nothing and build nothing', () => {
  it('keeps every barbarian inert in money and research while its bands fight', () => {
    let state = board({
      map: mapOf(
        '.........',
        '.........',
        '...h.....',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
        '.........',
      ),
      cities: [city(0, 0, 4), city(1, 1, 76, { population: 2 })],
      units: [
        unit(0, WARRIOR, 2, 20),
        unit(1, HORSEMAN, 2, 40),
        // A defender standing in the second city, so the run contains a battle as well as
        // the walks that lead to one.
        unit(2, SPEARMAN, 1, 76),
        unit(3, WARRIOR, 0, 60),
      ],
    });

    const seen: GameEvent[] = [];
    let barbarianActions = 0;

    for (let turn = 0; turn < 80; turn += 1) {
      const owned = new Set(unitsOf(state, BARBARIAN_ID).map((each) => Number(each.id)));
      const outcome = advanceTurn(state, RULESET);

      seen.push(...outcome.events);
      barbarianActions += outcome.events.filter(
        (event) =>
          (event.type === 'UnitMoved' && owned.has(Number(event.unitId))) ||
          (event.type === 'CombatResolved' && owned.has(Number(event.attackerId))),
      ).length;
      state = outcome.state;
    }

    const barbarian = barbarianPlayer(state);
    expect(barbarian).toBeDefined();
    if (barbarian === undefined) return;

    expect(barbarian.treasury).toBe(0);
    expect(barbarian.beakers).toBe(0);
    expect(barbarian.luxuries).toBe(0);
    expect([...barbarian.techs]).toStrictEqual([]);
    expect(Object.hasOwn(barbarian, 'researching')).toBe(false);

    expect(
      seen.filter(
        (event) =>
          FORBIDDEN_FOR_BARBARIANS.includes(event.type) &&
          'playerId' in event &&
          event.playerId === BARBARIAN_ID,
      ),
    ).toStrictEqual([]);

    // The run is not vacuous: the bands acted, the civilizations were paid, and at least
    // one city changed hands.
    expect(barbarianActions).toBeGreaterThan(0);
    expect(seen.some((event) => event.type === 'IncomeCollected' && event.playerId === P0)).toBe(
      true,
    );
    expect(
      seen.filter((event) => event.type === 'CityCaptured' && event.to === BARBARIAN_ID).length,
    ).toBeGreaterThan(0);

    // Nothing the barbarians hold is building: a captured city has no queue and no
    // production head, and nothing ever orders one for a player no policy is polled for.
    const captured = state.cities.filter((each) => each.owner === BARBARIAN_ID);
    expect(captured.length).toBeGreaterThan(0);
    for (const barbarianCity of captured) {
      expect(barbarianCity.queue).toStrictEqual([]);
      expect(Object.hasOwn(barbarianCity, 'production')).toBe(false);
    }

    // The capture rule's consequence, stated as an invariant over the whole run: no unit
    // stands inside a city it does not own.
    for (const each of state.units) {
      const here = state.cities.find((candidate) => candidate.tile === each.tile);
      if (here !== undefined) expect(here.owner).toBe(each.owner);
    }
  });

  it('never lets a barbarian city produce, even twenty turns after a capture', () => {
    const state = board({
      map: mapOf('...', '...', '...'),
      cities: [
        city(0, 0, 4, {
          population: 2,
          // Nothing is close to completing, so the capture happens on the first turn with
          // the order still standing: the point is what happens to that order afterwards.
          shields: 0,
          production: { kind: 'unit', id: SPEARMAN.id },
          queue: [{ kind: 'unit', id: SPEARMAN.id }],
        }),
      ],
      units: [unit(0, WARLORD, 2, 0)],
    });

    const captured = advanceTurn(state, RULESET);
    // The city was still the other civilization's when production ran, and production did
    // not finish anything; the *capture* then clears what it was building.
    expect(ofType(captured.events, 'CityProduced')).toStrictEqual([]);
    expect(ofType(captured.events, 'CityCaptured')).toHaveLength(1);
    expect(captured.state.cities[0]?.owner).toBe(BARBARIAN_ID);
    expect(captured.state.cities[0]?.queue).toStrictEqual([]);
    expect(Object.hasOwn(captured.state.cities[0] ?? {}, 'production')).toBe(false);

    let after = captured.state;
    const events: GameEvent[] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      const outcome = advanceTurn(after, RULESET);
      events.push(...outcome.events);
      after = outcome.state;
    }

    expect(ofType(events, 'CityProduced')).toStrictEqual([]);
    expect(after.cities[0]?.owner).toBe(BARBARIAN_ID);
    expect(after.cities[0]?.queue).toStrictEqual([]);
    // The shields the captured city earns pile up in its pool — that is `production.ts`'s
    // banking rule for *any* city with no order, and it is not building. What matters, and
    // what the two assertions below pin, is that the pool can never buy anything: no item
    // completes, and the barbarians own no more units after twenty turns than they did
    // when they took the city.
    expect(after.cities[0]?.shields).toBeGreaterThan(captured.state.cities[0]?.shields ?? 0);
    expect(unitsOf(after, BARBARIAN_ID)).toHaveLength(unitsOf(captured.state, BARBARIAN_ID).length);
  });
});

/* ------------------------------------------------------------------ *
 * The module's own contract surface
 * ------------------------------------------------------------------ */

describe('M6 — the barbarian player, its order and its declared provenance', () => {
  it('finds the barbarian player, and answers `undefined` for a state without one', () => {
    expect(barbarianPlayer(board())?.id).toBe(BARBARIAN_ID);
    expect(barbarianPlayer(board({ players: [civ0, civ1] }))).toBeUndefined();

    const noBarbarians = board({ players: [civ0, civ1] });
    const outcome = advanceBarbarians(noBarbarians, RULESET);
    expect(outcome.state).toStrictEqual(noBarbarians);
    expect(outcome.events).toStrictEqual([]);
  });

  it('is an unsourced placeholder, and says so', () => {
    expect(isPlaceholder(BARBARIAN_PROVENANCE)).toBe(true);
    if (!isPlaceholder(BARBARIAN_PROVENANCE)) throw new Error('must be a placeholder');

    const note = BARBARIAN_PROVENANCE.note;
    expect(note).toContain('Unsourced placeholder');
    expect(note).toContain('NOT traced to Civ 3');
    // The three rules this module adds are ours, and the one the contract phrases
    // differently ("the nearest known (to it) city") says which reading it takes.
    expect(note).toContain('known (to it)');
  });

  it('drives units in unit-id order, whatever order the array is in', () => {
    const sorted = board({
      cities: [city(0, 0, DIAGONAL_CITY_TILE)],
      units: [unit(0, WARRIOR, 2, 0), unit(1, WARRIOR, 2, 20)],
    });
    const shuffled = board({
      cities: [city(0, 0, DIAGONAL_CITY_TILE)],
      units: [unit(1, WARRIOR, 2, 20), unit(0, WARRIOR, 2, 0)],
    });

    // Unit 0 (tile 0) acts first, then unit 1 (tile 20, whose best step toward the city is
    // tile 16) — in that order, in both states.
    const expected = [
      { from: 0, to: 6, cost: 1 },
      { from: 20, to: 16, cost: 1 },
    ];
    expect(moves(advanceTurn(sorted, RULESET).events)).toStrictEqual(expected);
    expect(moves(advanceTurn(shuffled, RULESET).events)).toStrictEqual(expected);
  });
});
