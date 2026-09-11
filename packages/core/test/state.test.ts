/**
 * `newGame` assembly tests (INTERFACES.md W3, plus M2's units/fog half and M3's
 * "State shape").
 *
 * The ruleset here is a local stand-in: `newGame` only needs the structural
 * `RulesetView`, so these tests do not depend on another workstream's content
 * package. The point of the file is that state assembly is deterministic and
 * that every generation failure surfaces as a typed `SetupError` rather than an
 * exception — a direct `newGame` call in a test *is* the no-throw assertion,
 * because a thrown error would fail the test.
 *
 * M3 changed what a "player" is: `players` now holds the civilizations *and* the
 * barbarian player. Every assertion that means "how many civilizations" goes
 * through `civPlayers` — which is the migrated form of the M1/M2 assertion
 * `players.length === civCount` — and the barbarian is asserted to exist, to be
 * the last player, and to own nothing.
 */

import { describe, expect, it } from 'vitest';
import { asTerrainId, asUnitId, asUnitTypeId } from '../src/ids.js';
import {
  TERRAIN_BY_ROLE,
  TERRAIN_ROLES,
  distance8,
  terrainAtIndex,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { isErr, type Result } from '../src/result.js';
import { DEFAULT_SETTINGS, MAP_DIMENSIONS, type Settings } from '../src/settings.js';
import { ratesProblem } from '../src/economy.js';
import {
  DEFAULT_RATES,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  civPlayers,
  newGame,
  type GameState,
  type SetupError,
} from '../src/state.js';
import { unitById, unitsOnTile, type UnitDef, type UnitRole } from '../src/units.js';

const ROLES: readonly TerrainRole[] = TERRAIN_ROLES;
const IMPASSABLE_ROLES: readonly TerrainRole[] = ['ocean', 'mountains'];

const makeTerrain = (role: TerrainRole, impassable: boolean): TerrainDef => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost: role === 'mountains' ? 3 : 1,
  defenseBonusPct: role === 'mountains' ? 100 : 0,
  yields: { food: 1, shields: 0, commerce: 0 },
  impassable,
});

const TERRAINS: readonly TerrainDef[] = ROLES.map((role) =>
  makeTerrain(role, IMPASSABLE_ROLES.includes(role)),
);

const makeUnit = (id: string, role: UnitRole, movement: number): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 0,
  defense: 0,
  movement,
  cost: 1,
  domain: 'land',
});

/** The role `newGame` places, with a movement value worth asserting on. */
const SETTLER = makeUnit('settler', 'settler', 2);

const UNITS: readonly UnitDef[] = [SETTLER, makeUnit('scout', 'scout', 3)];

/**
 * The engine's view of a ruleset: terrain *and* a unit catalog, both required
 * (M2 post-review amendment). Every view in this file spells out its unit
 * catalog, so "no units" is always visibly `units: []` rather than a field left
 * off.
 */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: UNITS,
  improvements: [],
  fidelity: 'tuned',
};

/** The same terrains with an empty unit catalog. */
const NO_UNITS: RulesetView = {
  terrains: TERRAINS,
  units: [],
  improvements: [],
  fidelity: 'tuned',
};

/** A duel map (40x40) with two civilizations: small, fast, and enough land. */
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const mustGame = (seed: number, settings: Settings, ruleset: RulesetView): GameState => {
  const result = newGame(seed, settings, ruleset);
  if (!result.ok) throw new Error(`expected a state, got ${JSON.stringify(result.error)}`);
  return result.value;
};

const mustErr = (result: Result<GameState, SetupError>): SetupError => {
  if (result.ok) throw new Error('expected newGame to fail');
  return result.error;
};

/** The terrain role of a tile, for assertions that read like the map. */
const roleAt = (map: GameMap, index: number): string => {
  const id = terrainAtIndex(map, index);
  if (id === undefined) return '<missing>';
  const def = TERRAINS.find((t) => t.id === id);
  return def === undefined ? '<unknown>' : def.role;
};

describe('newGame', () => {
  it('assembles a state with the map dimensions of the requested size', () => {
    const state = mustGame(42, SETTINGS, RULESET);
    const expected = MAP_DIMENSIONS[SETTINGS.mapSize];

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.revision).toBe(0);
    expect(state.turn).toBe(1);
    expect(state.seed).toBe(42);
    expect(state.settings).toBe(SETTINGS);
    expect(state.map.width).toBe(expected.width);
    expect(state.map.height).toBe(expected.height);
    expect(state.map.terrain).toHaveLength(expected.width * expected.height);
    // M3: `players` is the civilizations *plus* the barbarian player, which is
    // why "how many civilizations" is asked through `civPlayers`.
    expect(civPlayers(state)).toHaveLength(SETTINGS.civCount);
    expect(state.players).toHaveLength(SETTINGS.civCount + 1);
  });

  it('is deterministic: the same seed reproduces terrain, players and RNG', () => {
    const first = mustGame(1337, SETTINGS, RULESET);
    const second = mustGame(1337, SETTINGS, RULESET);

    expect(second.map.terrain).toEqual(first.map.terrain);
    expect(second.players).toEqual(first.players);
    expect(second.rng).toEqual(first.rng);
    expect(second).toEqual(first);
  });

  it('produces a different world for a different seed', () => {
    const a = mustGame(1, SETTINGS, RULESET);
    const b = mustGame(2, SETTINGS, RULESET);

    expect(b.map.terrain).not.toEqual(a.map.terrain);
  });

  it('numbers civilizations from zero with stable names and palette colours', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 4 }, RULESET);

    expect(civPlayers(state).map((p) => Number(p.id))).toEqual([0, 1, 2, 3]);
    expect(civPlayers(state).map((p) => p.name)).toEqual([
      'Player 1',
      'Player 2',
      'Player 3',
      'Player 4',
    ]);

    const colors = state.players.map((p) => p.color);
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    // Every player's colour is its own, barbarians included: a barbarian painted
    // in a civilization's colour would make the map legend lie.
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('appends exactly one barbarian player, after the civilizations, with kind set', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 3 }, RULESET);

    expect(state.players).toHaveLength(state.settings.civCount + 1);
    expect(civPlayers(state).map((p) => Number(p.id))).toEqual([0, 1, 2]);

    const kinds = state.players.map((p) => p.kind);
    expect(kinds).toEqual(['civ', 'civ', 'civ', 'barbarian']);

    // The barbarian is the last player, so every civilization keeps the id it had
    // before M3 — which is what makes `explored` and every `owner` reference line
    // up with the same indices they always did.
    const barbarian = state.players[state.players.length - 1];
    expect(barbarian?.kind).toBe('barbarian');
    expect(barbarian?.name).toBe('Barbarians');
    expect(Number(barbarian?.id)).toBe(state.settings.civCount);
    // It is a player *identity*, not a civilization: `civPlayers` is the list of
    // civilizations, and it never contains it.
    expect(civPlayers(state)).not.toContain(barbarian);
  });

  it('gives the barbarian player no homeland of its own', () => {
    // M3 documents the barbarian's `startingTile` as the map's first goody hut —
    // a real land tile no civilization starts on, and the place its units come
    // from — because `PlayerState.startingTile` is a required field. Nothing
    // places a barbarian unit there, and no civilization's start is stolen.
    const state = mustGame(42, SETTINGS, RULESET);
    const barbarian = state.players[state.players.length - 1];

    expect(state.map.huts.length).toBeGreaterThan(0);
    expect(Number(barbarian?.startingTile)).toBe(Number(state.map.huts[0]));
    for (const civ of civPlayers(state)) {
      expect(civ.startingTile).not.toBe(barbarian?.startingTile);
      // `generateWorld` never places a hut on a start tile, so no civilization
      // begins on top of one.
      expect(state.map.huts).not.toContain(civ.startingTile);
    }
  });

  it('starts with no cities and a nextCityId of zero', () => {
    // M3: cities are founded by `FoundCity`, never by setup. An empty `cities`
    // array is the honest starting state, and id 0 belongs to the first city
    // actually founded.
    const state = mustGame(42, SETTINGS, RULESET);

    expect(state.cities).toEqual([]);
    expect(state.nextCityId).toBe(0);
  });

  it('starts with nothing built: improvements are empty at setup', () => {
    // M4a: an improvement is something a *worker* does after the game starts, so
    // setup has none. The field is a required, empty array — never `undefined` —
    // because it is part of every state hash, and a key holding `undefined` could
    // not survive a JSON round trip (the bug class M3's `City.production`
    // documents). Improvements live on the *state* rather than on `GameMap`, so a
    // generated map and a played world cannot be confused for one another.
    const game = mustGame(42, SETTINGS, RULESET);

    expect(game.improvements).toEqual([]);
    expect(JSON.parse(JSON.stringify(game))).toEqual(game);
  });

  it('places every civilization on a passable land tile inside the map', () => {
    const state = mustGame(99, SETTINGS, RULESET);

    const tiles = civPlayers(state).map((player) => Number(player.startingTile));
    expect(new Set(tiles).size).toBe(tiles.length);

    for (const tile of tiles) {
      expect(tile).toBeGreaterThanOrEqual(0);
      expect(tile).toBeLessThan(state.map.terrain.length);
      const role = roleAt(state.map, tile);
      expect(['grassland', 'plains', 'hills']).toContain(role);
    }
  });

  it('reports missing-terrain-role for each role the ruleset lacks', () => {
    for (const missing of ROLES) {
      const ruleset: RulesetView = {
        terrains: TERRAINS.filter((t) => t.role !== missing),
        units: UNITS,
        improvements: [],
        fidelity: 'tuned',
      };
      expect(TERRAIN_BY_ROLE(ruleset, missing)).toBeUndefined();

      const result = newGame(42, SETTINGS, ruleset);
      expect(isErr(result)).toBe(true);
      expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: missing });
    }
  });

  it('reports missing-terrain-role for an entirely empty ruleset', () => {
    const result = newGame(42, SETTINGS, {
      terrains: [],
      units: [],
      improvements: [],
      fidelity: 'tuned',
    });
    expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: 'ocean' });
  });

  it('reports missing-unit-role when no unit can be the starting unit', () => {
    // The terrain is fine, so the failure is the unit: `newGame` places one
    // settler per player, and a ruleset that ships no settler cannot host a game.
    const withoutSettler: RulesetView = {
      terrains: TERRAINS,
      units: UNITS.filter((u) => u.role !== 'settler'),
      improvements: [],
      fidelity: 'tuned',
    };

    const result = newGame(42, SETTINGS, withoutSettler);
    expect(isErr(result)).toBe(true);
    expect(mustErr(result)).toEqual({ kind: 'missing-unit-role', role: 'settler' });
  });

  it('reports missing-unit-role for an empty unit catalog', () => {
    // A view with no units is `units: []` — the same situation as a catalog
    // without a settler, and the same typed answer.
    const result = newGame(42, SETTINGS, NO_UNITS);
    expect(isErr(result)).toBe(true);
    expect(mustErr(result)).toEqual({ kind: 'missing-unit-role', role: 'settler' });
  });

  it('reports the missing terrain role before the missing unit role', () => {
    // Both are wrong here; generation is the earlier boundary, so its error is
    // the one reported and the unit check never masks it.
    const empty: RulesetView = { terrains: [], units: [], improvements: [], fidelity: 'tuned' };
    const result = newGame(42, SETTINGS, empty);
    expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: 'ocean' });
  });

  it('reports no-valid-starts when no land tile is passable', () => {
    const impassableRuleset: RulesetView = {
      terrains: TERRAINS.map((t) => ({ ...t, impassable: true })),
      units: UNITS,
      improvements: [],
      fidelity: 'tuned',
    };

    const result = newGame(42, SETTINGS, impassableRuleset);
    expect(isErr(result)).toBe(true);
    expect(mustErr(result)).toEqual({
      kind: 'no-valid-starts',
      civCount: SETTINGS.civCount,
    });
  });

  it('reports too-few-start-candidates when the map cannot host the civ count', () => {
    // A 40x40 map cannot hold 500 tiles mutually at Chebyshev distance >= 2, so
    // this is impossible for every seed and terrain distribution.
    const impossible: Settings = { ...SETTINGS, civCount: 500 };

    const result = newGame(42, impossible, RULESET);
    expect(isErr(result)).toBe(true);
    expect(mustErr(result)).toEqual({ kind: 'too-few-start-candidates' });
  });

  it('never throws for a hostile setup: failures are values, not exceptions', () => {
    const setups: readonly (readonly [number, Settings, RulesetView])[] = [
      [42, SETTINGS, { terrains: [], units: [], improvements: [], fidelity: 'tuned' }],
      [
        42,
        SETTINGS,
        {
          terrains: TERRAINS.filter((t) => t.role !== 'hills'),
          units: UNITS,
          improvements: [],
          fidelity: 'tuned',
        },
      ],
      [
        42,
        SETTINGS,
        {
          terrains: TERRAINS.map((t) => ({ ...t, impassable: true })),
          units: UNITS,
          improvements: [],
          fidelity: 'tuned',
        },
      ],
      [42, { ...SETTINGS, civCount: 500 }, RULESET],
      [-7, SETTINGS, RULESET],
    ];

    for (const [seed, settings, ruleset] of setups) {
      expect(() => newGame(seed, settings, ruleset)).not.toThrow();
    }
  });
});

describe('starting units', () => {
  it('gives every civilization exactly one settler, on its own starting tile', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 4 }, RULESET);

    // One settler per *civilization*: the barbarian player is a player, but a
    // barbarian settler would be nonsense, so it starts with nothing at all.
    expect(state.units).toHaveLength(civPlayers(state).length);

    for (const player of civPlayers(state)) {
      const onStart = unitsOnTile(state, player.startingTile);
      const mine = onStart.filter((u) => u.owner === player.id);

      expect(mine).toHaveLength(1);
      const settler = mine[0];
      expect(settler?.type).toBe(SETTLER.id);
      expect(settler?.tile).toBe(player.startingTile);
      // A fresh unit can move: `movementLeft` starts at the catalog's movement,
      // which is what makes the first `MoveUnit` of a game legal.
      expect(settler?.movementLeft).toBe(SETTLER.movement);
      // No two players share a start, so nothing is stacked on turn 1.
      expect(onStart).toHaveLength(1);
    }

    const barbarian = state.players[state.players.length - 1];
    expect(barbarian?.kind).toBe('barbarian');
    expect(state.units.filter((u) => u.owner === barbarian?.id)).toEqual([]);
  });

  it('hands out dense, monotonic ids and keeps `units` sorted by id', () => {
    const state = mustGame(1337, { ...SETTINGS, civCount: 5 }, RULESET);

    const ids = state.units.map((u) => Number(u.id));
    expect(ids).toEqual([0, 1, 2, 3, 4]);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);

    // `nextUnitId` points *past* everything created: the next unit gets an id
    // nothing has used, and the count is the counter.
    expect(state.nextUnitId).toBe(state.units.length);
    expect(unitById(state, asUnitId(state.nextUnitId))).toBeUndefined();
    for (const unit of state.units) {
      expect(Number(unit.id)).toBeLessThan(state.nextUnitId);
      expect(unitById(state, unit.id)).toEqual(unit);
    }
  });

  it('numbers units in player order, so ids are a function of the civ order', () => {
    const state = mustGame(7, { ...SETTINGS, civCount: 3 }, RULESET);
    expect(state.units.map((u) => Number(u.owner))).toEqual([0, 1, 2]);
  });

  it('is deterministic: the same seed reproduces units, cities and explored rows', () => {
    const first = mustGame(99, SETTINGS, RULESET);
    const second = mustGame(99, SETTINGS, RULESET);

    expect(second.units).toEqual(first.units);
    expect(second.explored).toEqual(first.explored);
    expect(second.nextUnitId).toBe(first.nextUnitId);
    // M3: the new fields are part of the persisted state, so they must be as
    // reproducible as the old ones — and `toEqual` on the whole state (below)
    // covers `cities`, `nextCityId` and the map's huts too.
    expect(second.cities).toEqual(first.cities);
    expect(second.nextCityId).toBe(first.nextCityId);
    expect(second.map.huts).toEqual(first.map.huts);
    expect(second).toEqual(first);
  });

  it('starts every unit with movement to spare, never negative', () => {
    const state = mustGame(3, SETTINGS, RULESET);
    for (const unit of state.units) {
      expect(Number.isInteger(unit.movementLeft)).toBe(true);
      expect(unit.movementLeft).toBeGreaterThanOrEqual(1);
    }
  });
});

/**
 * M4b's starting army: a settler **and a worker** per civilization. Without the
 * worker the improvement system is unreachable at setup — a player would have to
 * found a city and produce one before it could build anything — which is why the
 * milestone closes the M4a gap here rather than in M4c.
 *
 * The worker is optional in the *ruleset* sense: a view with no worker row still
 * starts, with the settler alone (asserted at the end of this block). That is what
 * keeps the settler-only fixtures elsewhere in the suite meaningful, and it is the
 * same totality the rest of `newGame` takes: a catalog that does not offer
 * something cannot be read as an error about it.
 */
describe('starting units — M4b adds the worker', () => {
  const WORKER = makeUnit('worker', 'worker', 1);

  /** The ruleset this milestone's `newGame` is written for: both roles present. */
  const STAFFED: RulesetView = { ...RULESET, units: [SETTLER, WORKER] };

  it('gives every civilization exactly one settler and one worker, barbarians none', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 4 }, STAFFED);

    expect(state.units).toHaveLength(civPlayers(state).length * 2);

    for (const player of civPlayers(state)) {
      const mine = state.units.filter((unit) => unit.owner === player.id);
      expect(mine.map((unit) => unit.type)).toEqual([SETTLER.id, WORKER.id]);

      // The settler stands on the start; the worker stands next to it, and no two
      // units of one civilization share a tile.
      const settler = mine[0];
      const worker = mine[1];
      expect(settler?.tile).toBe(player.startingTile);
      expect(worker?.tile).not.toBe(player.startingTile);
      expect(new Set(mine.map((unit) => Number(unit.tile))).size).toBe(2);
      // A fresh worker can move (movement 1) and therefore *can* start a job on
      // turn 1: `StartWork` costs the unit's movement, and this is the unit that
      // spends it.
      expect(worker?.movementLeft).toBe(WORKER.movement);
    }

    const barbarian = state.players[state.players.length - 1];
    expect(barbarian?.kind).toBe('barbarian');
    expect(state.units.filter((unit) => unit.owner === barbarian?.id)).toEqual([]);
  });

  it('places the worker on standable land next to its settler, never on water, mountain or a unit', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const state = mustGame(seed, SETTINGS, STAFFED);
      const map = state.map;

      for (const player of civPlayers(state)) {
        const mine = state.units.filter((unit) => unit.owner === player.id);
        const worker = mine.find((unit) => unit.type === WORKER.id);
        expect(
          worker,
          `seed ${String(seed)}: player ${String(Number(player.id))} has a worker`,
        ).toBeDefined();
        if (worker === undefined) continue;

        // "Standable" read off the *ruleset's own* impassable flag rather than a
        // role list: this fixture makes ocean and mountains impassable and coast
        // passable, and the placement rule is the flag, not the role.
        const terrain = STAFFED.terrains.find((row) => row.id === map.terrain[Number(worker.tile)]);
        expect(
          terrain,
          `seed ${String(seed)}: the worker stands on described terrain`,
        ).toBeDefined();
        expect(terrain?.impassable).toBe(false);
        // One unit per tile: the worker is a neighbour of the settler, not a stack
        // on top of it — and adjacency is the contract's "on (or adjacent to) its
        // starting tile".
        expect(unitsOnTile(state, worker.tile)).toHaveLength(1);
        const dx = Math.abs(
          (Number(worker.tile) % map.width) - (Number(player.startingTile) % map.width),
        );
        const dy = Math.abs(
          Math.floor(Number(worker.tile) / map.width) -
            Math.floor(Number(player.startingTile) / map.width),
        );
        expect(Math.max(dx, dy)).toBe(1);
        // The fog it stands in is lit: `initialFog` reads the units, and a unit the
        // player cannot see would be a state its own player cannot explain.
        expect(state.explored[Number(player.id)]?.[Number(worker.tile)]).toBe(true);
      }
    }
  });

  it('numbers settler-then-worker per civilization, so ids are a function of the civ order', () => {
    const state = mustGame(7, { ...SETTINGS, civCount: 3 }, STAFFED);

    expect(state.units.map((unit) => Number(unit.owner))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(state.units.map((unit) => unit.type)).toEqual([
      SETTLER.id,
      WORKER.id,
      SETTLER.id,
      WORKER.id,
      SETTLER.id,
      WORKER.id,
    ]);
    expect(state.units.map((unit) => Number(unit.id))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.nextUnitId).toBe(state.units.length);
    // …and the whole state is still a function of the seed, worker included.
    expect(mustGame(7, { ...SETTINGS, civCount: 3 }, STAFFED)).toEqual(state);
  });

  it('never starts a unit on a goody hut', () => {
    // A hut is consumed by *entering* its tile, so a unit that begins the game
    // standing on one would leave a hut nothing can ever enter. The start tiles come
    // from `gen.ts` (which keeps huts off them) and the worker from the free
    // neighbour this file picks — so this is the assertion that the two agree.
    for (const seed of [1, 7, 42, 4242, 1337, 90210]) {
      const state = mustGame(seed, SETTINGS, STAFFED);
      const huts = new Set(state.map.huts.map(Number));
      for (const unit of state.units) {
        expect(
          huts.has(Number(unit.tile)),
          `seed ${String(seed)}: unit ${String(Number(unit.id))} stands on a hut`,
        ).toBe(false);
      }
    }
  });

  it('starts a ruleset without a worker row anyway, with the settler alone', () => {
    // The optional half of the rule. `RULESET` offers a settler and a scout — no
    // worker — and that is not an error: it is a game with no worker in it, which is
    // exactly what the M4a and fog fixtures rely on.
    const state = mustGame(42, SETTINGS, RULESET);

    expect(state.units).toHaveLength(civPlayers(state).length);
    expect(state.units.every((unit) => unit.type === SETTLER.id)).toBe(true);

    // A missing *settler* is still an error, and it is checked before the worker, so
    // the message names the role the game genuinely cannot start without.
    expect(mustErr(newGame(42, SETTINGS, NO_UNITS))).toEqual({
      kind: 'missing-unit-role',
      role: 'settler',
    });
  });
});

/**
 * M4b's money fields at setup. They are part of every state hash
 * (SCHEMA_VERSION 4 → 5), so their starting values are pinned here rather than
 * inferred from whichever unit test happens to read a treasury first.
 */
describe('starting money', () => {
  it('gives every civilization STARTING_TREASURY at the default rates, and barbarians nothing', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 3 }, RULESET);

    for (const player of civPlayers(state)) {
      expect(player.treasury).toBe(STARTING_TREASURY);
      expect(player.rates).toEqual(DEFAULT_RATES);
      expect(player.beakers).toBe(0);
      expect(player.luxuries).toBe(0);
    }

    const barbarian = state.players[state.players.length - 1];
    expect(barbarian?.kind).toBe('barbarian');
    // Barbarians have no economy (M4b): no treasury to lose, and nothing that
    // accumulates. Their rates are the defaults because a player state has one
    // shape, not because anything reads them.
    expect(barbarian?.treasury).toBe(0);
    expect(barbarian?.rates).toEqual(DEFAULT_RATES);
    expect(barbarian?.beakers).toBe(0);
    expect(barbarian?.luxuries).toBe(0);

    // The defaults are a legal rate triple, so a game cannot start in a state
    // `planSetRates` would refuse to re-create.
    expect(ratesProblem(DEFAULT_RATES)).toBeUndefined();
    expect(DEFAULT_RATES.tax + DEFAULT_RATES.science + DEFAULT_RATES.luxury).toBe(RATE_TOTAL);
  });

  it('keeps the money fields whole numbers, and the treasury non-negative', () => {
    const state = mustGame(3, SETTINGS, RULESET);
    for (const player of state.players) {
      for (const value of [player.treasury, player.beakers, player.luxuries]) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(player.treasury).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('starting fog', () => {
  it('has exactly one explored row per player — barbarians included — each map-sized', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 3 }, RULESET);

    // One row per *player*, not per civilization: `PlayerId` is the index into
    // `players`, so the barbarian player has a row. It is all false, because a
    // player with no units sees nothing — not a missing row, an empty memory.
    expect(state.explored).toHaveLength(state.players.length);
    expect(state.explored).toHaveLength(state.settings.civCount + 1);

    for (const [index, row] of state.explored.entries()) {
      expect(row).toHaveLength(state.map.width * state.map.height);
      // A row is addressed by tile index, so it must be dense and boolean.
      expect(row.every((seen) => typeof seen === 'boolean')).toBe(true);
      expect(Number(state.players[index]?.id)).toBe(index);

      const player = state.players[index];
      if (player?.kind === 'barbarian') {
        expect(row.some((seen) => seen)).toBe(false);
        continue;
      }
      expect(row.some((seen) => seen)).toBe(true);
      expect(row.some((seen) => !seen)).toBe(true);
    }
  });

  it('marks exactly the tiles within the starting visibility radius', () => {
    const state = mustGame(4242, SETTINGS, RULESET);

    // Radius 2 (Chebyshev), matching the visibility radius `fog.visibleTiles`
    // derives from a unit's position: a start sees what its settler sees.
    for (const player of civPlayers(state)) {
      const row = state.explored[Number(player.id)];
      expect(row).toBeDefined();
      if (row === undefined) continue;

      const wrong: number[] = [];
      let seen = 0;
      for (let tile = 0; tile < row.length; tile += 1) {
        const expected = distance8(state.map, tile, player.startingTile) <= 2;
        if (row[tile] !== expected) wrong.push(tile);
        if (expected) seen += 1;
      }

      // Empty means "every tile agrees", and it makes a failure list the tiles
      // that disagree instead of stopping at the first one.
      expect(wrong).toEqual([]);
      expect(seen).toBeGreaterThan(0);
      expect(seen).toBeLessThan(row.length);
    }
  });

  it('gives each civilization its own row, describing its own start', () => {
    const state = mustGame(11, SETTINGS, RULESET);
    const rows = civPlayers(state).map((player) => state.explored[Number(player.id)]);

    // Every row is a distinct array: one shared row would make all players see
    // the same tiles, and would show up here before it showed up in play.
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows[0]).not.toEqual(rows[1]);

    for (const [index, player] of civPlayers(state).entries()) {
      const row = rows[index];
      expect(row).toBeDefined();
      if (row === undefined) continue;

      expect(row[Number(player.startingTile)]).toBe(true);
      // Nothing explored for this player may sit outside this player's own
      // start radius — the rows are per player, not a union of everyone's.
      const outside = row.filter(
        (isExplored, tile) => isExplored && distance8(state.map, tile, player.startingTile) > 2,
      );
      expect(outside).toEqual([]);
    }
  });
});
