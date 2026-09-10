/**
 * `newGame` assembly tests (INTERFACES.md W3).
 *
 * The ruleset here is a local stand-in: `newGame` only needs the structural
 * `RulesetView`, so these tests do not depend on another workstream's content
 * package. The point of the file is that state assembly is deterministic and
 * that every generation failure surfaces as a typed `SetupError` rather than an
 * exception — a direct `newGame` call in a test *is* the no-throw assertion,
 * because a thrown error would fail the test.
 */

import { describe, expect, it } from 'vitest';
import { asTerrainId } from '../src/ids.js';
import {
  TERRAIN_BY_ROLE,
  TERRAIN_ROLES,
  terrainAtIndex,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { isErr, type Result } from '../src/result.js';
import { DEFAULT_SETTINGS, MAP_DIMENSIONS, type Settings } from '../src/settings.js';
import { SCHEMA_VERSION, newGame, type GameState, type SetupError } from '../src/state.js';

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

const RULESET: RulesetView = { terrains: TERRAINS, fidelity: 'tuned' };

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
        fidelity: 'tuned',
      };
      expect(TERRAIN_BY_ROLE(ruleset, missing)).toBeUndefined();

      const result = newGame(42, SETTINGS, ruleset);
      expect(isErr(result)).toBe(true);
      expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: missing });
    }
  });

  it('reports missing-terrain-role for an entirely empty ruleset', () => {
    const result = newGame(42, SETTINGS, { terrains: [], fidelity: 'tuned' });
    expect(mustErr(result)).toEqual({ kind: 'missing-terrain-role', role: 'ocean' });
  });

  it('reports no-valid-starts when no land tile is passable', () => {
    const ruleset: RulesetView = {
      terrains: TERRAINS.map((t) => ({ ...t, impassable: true })),
      fidelity: 'tuned',
    };

    const result = newGame(42, SETTINGS, ruleset);
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
      [42, SETTINGS, { terrains: [], fidelity: 'tuned' }],
      [42, SETTINGS, { terrains: TERRAINS.filter((t) => t.role !== 'hills'), fidelity: 'tuned' }],
      [42, SETTINGS, { terrains: TERRAINS.map((t) => ({ ...t, impassable: true })), fidelity: 'tuned' }],
      [42, { ...SETTINGS, civCount: 500 }, RULESET],
      [-7, SETTINGS, RULESET],
    ];

    for (const [seed, settings, ruleset] of setups) {
      expect(() => newGame(seed, settings, ruleset)).not.toThrow();
    }
  });
});
