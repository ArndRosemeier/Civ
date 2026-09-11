/**
 * Unit lookups (INTERFACES.md M2, "Core — units, movement, fog") and the M4a
 * `withWork` / `withoutWork` rebuilds that attach and detach a worker's job
 * (INTERFACES.md M4a, "Workers").
 *
 * These tests are about the *lookups* and the two pure unit rebuilds, so they run
 * against a small hand-built `GameState` instead of a generated one: a 4x4 map
 * with three units, two of them stacked on the same tile. That makes every
 * assertion readable as "on this board, asking this question gives that answer",
 * and it keeps the file independent of generation, which `state.test.ts` covers.
 *
 * The state literal is deliberately a full `GameState` (including the M2
 * `nextUnitId` / `units` / `explored` fields and M3's cities and M4a's
 * improvements): a partial object would typecheck only through a cast, and a cast
 * here would hide exactly the drift these tests exist to catch.
 *
 * The work field is the one place this file reaches for the hasher: M4a's hardest
 * rule is that an idle unit has **no** `work` key rather than a key holding
 * `undefined` (three earlier milestones lost a bug hunt to that spelling), and
 * `canonicalize` throwing on `undefined` is the only assertion that actually
 * proves it.
 */

import { describe, expect, it } from 'vitest';
import { canonicalize, hashValue } from '@civts/testing';
import { asPlayerId, asTerrainId, asTileIndex, asUnitId, asUnitTypeId } from '../src/ids.js';
import { asImprovementId } from '../src/improvements.js';
import type { GameMap, RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import {
  UNIT_ROLES,
  unitById,
  unitCatalog,
  unitDef,
  unitsOnTile,
  withWork,
  withoutWork,
  type Unit,
  type UnitDef,
  type UnitRole,
  type UnitWork,
} from '../src/units.js';

const ROLES: readonly TerrainRole[] = [
  'ocean',
  'coast',
  'grassland',
  'plains',
  'hills',
  'mountains',
];

const TERRAINS: readonly TerrainDef[] = ROLES.map((role) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost: 1,
  defenseBonusPct: 0,
  yields: { food: 1, shields: 0, commerce: 0 },
  impassable: role === 'ocean' || role === 'mountains',
}));

const makeDef = (id: string, role: UnitRole, movement: number): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 0,
  defense: 0,
  movement,
  cost: 1,
  domain: 'land',
});

const SETTLER = makeDef('settler', 'settler', 2);
const SCOUT = makeDef('scout', 'scout', 3);
const WARRIOR = makeDef('warrior', 'military', 1);

const DEFS: readonly UnitDef[] = [SETTLER, SCOUT, WARRIOR];

/** A ruleset that carries a unit catalog — what `validateRuleset` produces. */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: DEFS,
  // M4a: the catalog is a required field of a view. These tests are about unit
  // *lookups*, and every helper they exercise (`withWork`/`withoutWork` included)
  // reads a kind off a job rather than resolving it through a catalog, so "no
  // improvements ship in this stand-in" is the honest value — and it is stated as
  // an empty catalog rather than omitted, which the type would reject anyway.
  improvements: [],
  fidelity: 'tuned',
};

/**
 * The same terrains with an empty unit catalog.
 *
 * `RulesetView.units` is required (M2 post-review amendment), so a view that
 * ships no units states `units: []`. This is the shape to test against: every
 * unit lookup must miss cleanly rather than reading a missing field.
 */
const NO_UNITS_RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [],
  improvements: [],
  fidelity: 'tuned',
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** A 4x4 map, all grassland, so tile indices read as y * 4 + x. */
const MAP: GameMap = {
  width: 4,
  height: 4,
  terrain: Array.from({ length: 16 }, () => asTerrainId('grassland')),
  huts: [],
};

const player = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind: 'civ',
  // M4b: the money fields live on every player, so a hand-built player literal has
  // to carry them. The engine's own constants are used rather than literals so the
  // fixture cannot drift from what `newGame` assembles.
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
});

const unit = (id: number, owner: number, tile: number, movementLeft: number): Unit => ({
  id: asUnitId(id),
  type: id === 0 ? SETTLER.id : SCOUT.id,
  owner: asPlayerId(owner),
  tile: asTileIndex(tile),
  movementLeft,
});

/**
 * The job the fixture worker is doing, in M4a's shape. `turnsLeft: 3` is a
 * constructor argument of the test, not a claim about Civ 3: the engine carries
 * whatever the catalog's `turns` said, and nothing in this file resolves it.
 */
const WORK: UnitWork = {
  kind: asImprovementId('mine'),
  tile: asTileIndex(5),
  turnsLeft: 3,
};

/** Three units: 0 and 1 share tile 5 (player 0's start), 2 sits alone on tile 10. */
const UNITS: readonly Unit[] = [unit(0, 0, 5, 2), unit(1, 0, 5, 3), unit(2, 1, 10, 3)];

/** A 4x4 explored row (16 tiles) with `seen` marked, for readability below. */
const exploredRow = (seen: readonly number[]): readonly boolean[] =>
  Array.from({ length: 16 }, (_, index) => seen.includes(index));

const STATE: GameState = {
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0, 5), player(1, 10)],
  nextUnitId: 3,
  units: UNITS,
  explored: [exploredRow([0, 1, 4, 5]), exploredRow([10, 11, 14, 15])],
  nextCityId: 0,
  cities: [],
  improvements: [],
};

describe('unitById', () => {
  it('finds every unit in the state', () => {
    for (const expected of UNITS) {
      expect(unitById(STATE, expected.id)).toEqual(expected);
    }
  });

  it('returns undefined for an id that was never issued', () => {
    // Not a throw: "no such unit" is a question the command layer asks every
    // time it receives an id from a client, and it turns it into a typed
    // `unknown-unit` error rather than an exception.
    expect(unitById(STATE, asUnitId(3))).toBeUndefined();
    expect(unitById(STATE, asUnitId(-1))).toBeUndefined();
  });

  it('is unaffected by an unrelated id in the middle of the sequence', () => {
    // Ids are dense, so a gap should never exist; the lookup must still answer
    // "no such unit" rather than trusting the sequence.
    const gapped: GameState = { ...STATE, units: [unit(0, 0, 5, 2), unit(2, 1, 10, 3)] };
    expect(unitById(gapped, asUnitId(1))).toBeUndefined();
    expect(unitById(gapped, asUnitId(2))?.tile).toBe(asTileIndex(10));
  });
});

describe('unitsOnTile', () => {
  it('returns every unit standing on the tile, in id order', () => {
    const stacked = unitsOnTile(STATE, asTileIndex(5));
    expect(stacked.map((u) => Number(u.id))).toEqual([0, 1]);
    expect(stacked.every((u) => u.tile === asTileIndex(5))).toBe(true);
  });

  it('returns a single unit for a tile with one occupant', () => {
    expect(unitsOnTile(STATE, asTileIndex(10)).map((u) => Number(u.id))).toEqual([2]);
  });

  it('returns an empty list for an empty tile, and for a tile off the map', () => {
    expect(unitsOnTile(STATE, asTileIndex(0))).toEqual([]);
    expect(unitsOnTile(STATE, asTileIndex(15))).toEqual([]);
    expect(unitsOnTile(STATE, asTileIndex(999))).toEqual([]);
  });
});

describe('unitDef', () => {
  it('resolves a unit type the ruleset defines', () => {
    expect(unitDef(RULESET, asUnitTypeId('scout'))).toEqual(SCOUT);
    expect(unitDef(RULESET, asUnitTypeId('scout'))?.movement).toBe(3);
  });

  it('returns undefined for a type the ruleset does not define', () => {
    expect(unitDef(RULESET, asUnitTypeId('nuclear-submarine'))).toBeUndefined();
  });

  it('returns undefined for a type an empty catalog does not define', () => {
    // A view with no units at all is `units: []` — a catalog that holds nothing,
    // not a missing field. Every lookup misses, so `newGame` reports the typed
    // `missing-unit-role` rather than reading an undefined property.
    expect(unitDef(NO_UNITS_RULESET, SETTLER.id)).toBeUndefined();
    expect(unitCatalog(NO_UNITS_RULESET)).toEqual([]);
  });

  it('does not answer with a unit of the wrong role', () => {
    const def = unitDef(RULESET, asUnitTypeId('warrior'));
    expect(def?.role).toBe('military');
  });
});

describe('unitCatalog', () => {
  it('returns the catalog in data order, unchanged', () => {
    expect(unitCatalog(RULESET).map((d) => d.id)).toEqual(DEFS.map((d) => d.id));
  });

  it('reports the roles the engine knows, in canonical order', () => {
    expect([...UNIT_ROLES]).toEqual(['settler', 'worker', 'scout', 'military']);
    for (const def of unitCatalog(RULESET)) {
      expect(UNIT_ROLES).toContain(def.role);
    }
  });
});

describe('withWork / withoutWork — a unit’s job, in M4a’s shape', () => {
  it('is idle by absence: a unit that has never worked carries no `work` key at all', () => {
    // The rule the whole optional field exists for. `'work' in unit` is the honest
    // question — `unit.work === undefined` is also true for a key that is present
    // and holds `undefined`, which is precisely the spelling that cannot survive a
    // JSON round trip and made three earlier states unhashable.
    for (const looked of UNITS) {
      expect('work' in looked).toBe(false);
    }

    // …and the hasher agrees: `canonicalize` throws on any `undefined` it finds.
    expect(() => canonicalize(STATE)).not.toThrow();
    expect(() => hashValue(STATE)).not.toThrow();
  });

  it('attaches a job with exactly the unit’s own fields plus `work`', () => {
    const idle = UNITS[0];
    if (idle === undefined) throw new Error('the fixture has no unit 0');
    const busy = withWork(idle, WORK);

    expect(busy).toStrictEqual({ ...idle, work: WORK });
    expect(Object.keys(busy).sort()).toEqual([
      'id',
      'movementLeft',
      'owner',
      'tile',
      'type',
      'work',
    ]);
    expect(busy.work).toStrictEqual({
      kind: asImprovementId('mine'),
      tile: asTileIndex(5),
      turnsLeft: 3,
    });
  });

  it('detaches a job by removing the key — never by writing `undefined`', () => {
    const idle = UNITS[1];
    if (idle === undefined) throw new Error('the fixture has no unit 1');

    const busy = withWork(idle, WORK);
    const released = withoutWork(busy);

    expect('work' in released).toBe(false);
    expect(Object.keys(released).sort()).toEqual(['id', 'movementLeft', 'owner', 'tile', 'type']);
    // Every other field survives untouched, including the movement the job did not
    // refund: releasing a unit is not a state the caller has to repair.
    expect(released).toStrictEqual(idle);
  });

  it('is idempotent in both directions and never mutates the unit handed in', () => {
    const idle = UNITS[2];
    if (idle === undefined) throw new Error('the fixture has no unit 2');

    const frozen = Object.freeze({ ...idle });
    const busy = withWork(frozen, WORK);

    expect(withWork(busy, WORK)).toStrictEqual(busy); // attaching the same job again
    expect(withoutWork(withoutWork(busy))).toStrictEqual(idle); // releasing twice
    expect(frozen).toStrictEqual(idle); // the input is untouched
    expect('work' in frozen).toBe(false);
  });

  it('stays hashable with a job attached, and the job is part of the hash', () => {
    const board: GameState = {
      ...STATE,
      units: UNITS.map((u) => (u.id === asUnitId(0) ? withWork(u, WORK) : u)),
    };

    expect(() => canonicalize(board)).not.toThrow();
    // A job is persisted state, so it must move the hash — a unit's work that did
    // not change the hash would make replays and goldens blind to it.
    expect(hashValue(board)).not.toBe(hashValue(STATE));
    // A different count is a different state, for the same reason.
    const advanced: GameState = {
      ...board,
      units: board.units.map((u) =>
        u.id === asUnitId(0) ? withWork(u, { ...WORK, turnsLeft: 2 }) : u,
      ),
    };
    expect(hashValue(advanced)).not.toBe(hashValue(board));
  });
});
