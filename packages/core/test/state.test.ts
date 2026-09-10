/**
 * `newGame` assembly tests (INTERFACES.md W3, plus M2's units/fog half).
 *
 * The ruleset here is a local stand-in: `newGame` only needs the structural
 * `RulesetView`, so these tests do not depend on another workstream's content
 * package. The point of the file is that state assembly is deterministic and
 * that every generation failure surfaces as a typed `SetupError` rather than an
 * exception — a direct `newGame` call in a test *is* the no-throw assertion,
 * because a thrown error would fail the test.
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
import { SCHEMA_VERSION, newGame, type GameState, type SetupError } from '../src/state.js';
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
const RULESET: RulesetView = { terrains: TERRAINS, units: UNITS, fidelity: 'tuned' };

/** The same terrains with an empty unit catalog. */
const NO_UNITS: RulesetView = { terrains: TERRAINS, units: [], fidelity: 'tuned' };

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
    expect(state.players).toHaveLength(SETTINGS.civCount);
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

  it('numbers players from zero with stable names and palette colours', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 4 }, RULESET);

    expect(state.players.map((p) => Number(p.id))).toEqual([0, 1, 2, 3]);
    expect(state.players.map((p) => p.name)).toEqual([
      'Player 1',
      'Player 2',
      'Player 3',
      'Player 4',
    ]);

    const colors = state.players.map((p) => p.color);
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('places every player on a passable land tile inside the map', () => {
    const state = mustGame(99, SETTINGS, RULESET);

    const tiles = state.players.map((player) => Number(player.startingTile));
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
        fidelity: 'tuned',
      };
      expect(TERRAIN_BY_ROLE(ruleset, missing)).toBeUndefined();

      const result = newGame(42, SETTINGS, ruleset);
      expect(isErr(result)).toBe(true);
      expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: missing });
    }
  });

  it('reports missing-terrain-role for an entirely empty ruleset', () => {
    const result = newGame(42, SETTINGS, { terrains: [], units: [], fidelity: 'tuned' });
    expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: 'ocean' });
  });

  it('reports missing-unit-role when no unit can be the starting unit', () => {
    // The terrain is fine, so the failure is the unit: `newGame` places one
    // settler per player, and a ruleset that ships no settler cannot host a game.
    const withoutSettler: RulesetView = {
      terrains: TERRAINS,
      units: UNITS.filter((u) => u.role !== 'settler'),
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
    const empty: RulesetView = { terrains: [], units: [], fidelity: 'tuned' };
    const result = newGame(42, SETTINGS, empty);
    expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: 'ocean' });
  });

  it('reports no-valid-starts when no land tile is passable', () => {
    const impassableRuleset: RulesetView = {
      terrains: TERRAINS.map((t) => ({ ...t, impassable: true })),
      units: UNITS,
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
      [42, SETTINGS, { terrains: [], units: [], fidelity: 'tuned' }],
      [
        42,
        SETTINGS,
        { terrains: TERRAINS.filter((t) => t.role !== 'hills'), units: UNITS, fidelity: 'tuned' },
      ],
      [
        42,
        SETTINGS,
        {
          terrains: TERRAINS.map((t) => ({ ...t, impassable: true })),
          units: UNITS,
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
  it('gives every player exactly one settler, on its own starting tile', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 4 }, RULESET);

    expect(state.units).toHaveLength(state.players.length);

    for (const player of state.players) {
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

  it('is deterministic: the same seed reproduces units and explored rows', () => {
    const first = mustGame(99, SETTINGS, RULESET);
    const second = mustGame(99, SETTINGS, RULESET);

    expect(second.units).toEqual(first.units);
    expect(second.explored).toEqual(first.explored);
    expect(second.nextUnitId).toBe(first.nextUnitId);
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

describe('starting fog', () => {
  it('has exactly one explored row per player, each one map-sized', () => {
    const state = mustGame(42, { ...SETTINGS, civCount: 3 }, RULESET);

    expect(state.explored).toHaveLength(state.players.length);
    for (const [index, row] of state.explored.entries()) {
      expect(row).toHaveLength(state.map.width * state.map.height);
      expect(row.some((seen) => seen)).toBe(true);
      expect(row.some((seen) => !seen)).toBe(true);
      // A row is addressed by tile index, so it must be dense and boolean.
      expect(row.every((seen) => typeof seen === 'boolean')).toBe(true);
      expect(Number(state.players[index]?.id)).toBe(index);
    }
  });

  it('marks exactly the tiles within the starting visibility radius', () => {
    const state = mustGame(4242, SETTINGS, RULESET);

    // Radius 2 (Chebyshev), matching the visibility radius `fog.visibleTiles`
    // derives from a unit's position: a start sees what its settler sees.
    for (const player of state.players) {
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

  it('gives each player its own row, describing its own start', () => {
    const state = mustGame(11, SETTINGS, RULESET);
    const rows = state.players.map((player) => state.explored[Number(player.id)]);

    // Every row is a distinct array: one shared row would make all players see
    // the same tiles, and would show up here before it showed up in play.
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows[0]).not.toEqual(rows[1]);

    for (const [index, player] of state.players.entries()) {
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
