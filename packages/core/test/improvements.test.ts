/**
 * Tile improvement tests (INTERFACES.md M4a, "Where improvements live",
 * "Rules — improvement catalog", "Yields with improvements").
 *
 * Three things are being pinned here, and they are pinned separately on purpose:
 *
 * - **The state contract.** `GameState.improvements` is a sparse list of
 *   `(tile, kind)` pairs sorted by `(tile, kind)` with no duplicates, because that
 *   order is hashed. The tests below state the order, the uniqueness, the
 *   idempotence of `withImprovement` and the purity of all four helpers directly,
 *   rather than inferring them from a yield.
 * - **The yield contract.** A *worked* tile yields its terrain plus every
 *   improvement's delta; an *unworked* tile yields the same thing but contributes
 *   nothing to a city; the city centre is untouched; and a negative delta clamps
 *   at zero instead of subtracting.
 * - **Determinism.** An empty `improvements` list is still a new key in the
 *   hashed JSON, so setup is asserted to hash reproducibly, and the pair order is
 *   asserted to be a function of the pairs rather than of insertion order.
 *
 * The ruleset is a local stand-in: `core` reads only the structural
 * `RulesetView`, so nothing here depends on another workstream's content package.
 * The numbers are constructor arguments, not claims about Civ 3.
 */

import { describe, expect, it } from 'vitest';
import { cityYields, type City } from '../src/cities.js';
import { asCityId, asPlayerId, asTerrainId, asTileIndex, asUnitTypeId } from '../src/ids.js';
import {
  IMPROVEMENT_KINDS,
  asImprovementId,
  hasImprovement,
  improvementCatalog,
  improvementDef,
  improvementsAt,
  tileYields,
  withImprovement,
  withoutImprovement,
  type ImprovementDef,
  type TileImprovement,
} from '../src/improvements.js';
import {
  indexToX,
  indexToY,
  tileIndex,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { seedRng } from '../src/rng.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { SCHEMA_VERSION, newGame, type GameState, type PlayerState } from '../src/state.js';
import type { UnitDef } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * The synthetic board
 * ------------------------------------------------------------------ */

const WIDTH = 5;
const HEIGHT = 5;

/**
 * A 5x5 board. (2,2) is the city centre and is `mountains` (0/0/0) so the centre
 * floor is visible; (0,2) is hills, so a mine has a rock tile to sit on; (3,2) is
 * the grassland tile the city works; (1,1) is a second grassland, used as the
 * *unworked* tile. The three land tiles are distinct indices — indices, not
 * coordinates, are what the assertions compare, so two tiles that happen to share
 * one (`(0,2)` and `(1,1)` both being 6 on a 5-wide map) would make a test pass
 * for the wrong tile.
 */
const GRID: readonly string[] = [
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'hills', // (0,2) = tile 10 — the rock tile a mine sits on
  'grassland',
  'mountains', // (2,2) — the city centre
  'grassland', // (3,2) — the worked tile
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
  'grassland',
];

const TERRAIN_YIELDS: Readonly<
  Record<string, { food: number; shields: number; commerce: number }>
> = {
  grassland: { food: 2, shields: 1, commerce: 1 },
  hills: { food: 1, shields: 2, commerce: 1 },
  mountains: { food: 0, shields: 0, commerce: 0 },
};

/**
 * The board's terrain roles, plus water and plains. `newGame` insists the ruleset
 * can fill **every** role generation emits (`missing-terrain-role` otherwise), so
 * a view that only described the three roles the assertions happen to use could
 * not start a game at all. The extra rows are never reached by a tile above; they
 * exist so setup is legal, and `TERRAIN_YIELDS` stays the table the yield
 * assertions read.
 */
const ALL_ROLES: readonly { readonly role: TerrainRole; readonly impassable: boolean }[] = [
  { role: 'ocean', impassable: true },
  { role: 'coast', impassable: true },
  { role: 'grassland', impassable: false },
  { role: 'plains', impassable: false },
  { role: 'hills', impassable: false },
  { role: 'mountains', impassable: true },
];

const TERRAINS: readonly TerrainDef[] = ALL_ROLES.map(({ role, impassable }) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost: role === 'mountains' ? 3 : 1,
  defenseBonusPct: 0,
  yields: TERRAIN_YIELDS[role] ?? { food: 1, shields: 0, commerce: 0 },
  impassable,
}));

const MINE = asImprovementId('mine');
const ROAD = asImprovementId('road');
const IRRIGATION = asImprovementId('irrigation');

/**
 * Three catalog rows with deliberately plain numbers so a delta is obvious: a
 * mine adds one shield, a road adds one commerce, irrigation adds one food. The
 * *real* catalog's placeholder values are pinned in `@civts/rules`' test.
 */
const IMPROVEMENTS: readonly ImprovementDef[] = [
  {
    id: ROAD,
    kind: 'road',
    name: 'Road',
    turns: 2,
    yields: { food: 0, shields: 0, commerce: 1 },
    allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
  },
  {
    id: MINE,
    kind: 'mine',
    name: 'Mine',
    turns: 3,
    yields: { food: 0, shields: 1, commerce: 0 },
    allowedRoles: ['hills', 'mountains'],
  },
  {
    id: IRRIGATION,
    kind: 'irrigation',
    name: 'Irrigation',
    turns: 2,
    yields: { food: 1, shields: 0, commerce: 0 },
    allowedRoles: ['grassland', 'plains'],
  },
];

/** The unit type `newGame` must be able to place: one settler-role row. */
const SETTLER: UnitDef = {
  id: asUnitTypeId('settler'),
  role: 'settler',
  name: 'Settler',
  attack: 0,
  defense: 0,
  movement: 2,
  cost: 1,
  domain: 'land',
};

/**
 * A ruleset with the three rows above, and a settler so `newGame` can populate the
 * world. `core` reads only the structural view, so a local stand-in is the honest
 * thing here; the shipped catalog is exercised in `@civts/rules`' test and by the
 * golden harness.
 */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER],
  improvements: IMPROVEMENTS,
  fidelity: 'tuned',
};

/**
 * The same view with one *broken* improvement row: an improvement that
 * **subtracts**. The engine clamps at zero per component, and this is the row that
 * makes the clamp observable — no shipped row subtracts, because a shipped row
 * that relied on the clamp would be a row whose author meant something else
 * (`checkImprovement` rejects a negative delta in the real catalog).
 */
const DRAIN: ImprovementDef = {
  id: asImprovementId('drain'),
  kind: 'road', // the kind is irrelevant: only the deltas are read
  name: 'Drain',
  turns: 1,
  yields: { food: -5, shields: -5, commerce: -5 },
  allowedRoles: ['grassland', 'hills', 'mountains'],
};

const DRAINING: RulesetView = { ...RULESET, improvements: [...IMPROVEMENTS, DRAIN] };

/** A ruleset that ships no improvements at all: `[]` is a catalog, not a hole. */
const NO_IMPROVEMENTS: RulesetView = { ...RULESET, improvements: [] };

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const at = (x: number, y: number): number => tileIndex(WIDTH, x, y);

const terrainIds = (): readonly ReturnType<typeof asTerrainId>[] =>
  GRID.map((role) => asTerrainId(role));

const player = (index: number, tile: number, kind: 'civ' | 'barbarian' = 'civ'): PlayerState => ({
  id: asPlayerId(index),
  name: kind === 'barbarian' ? 'Barbarians' : `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind,
});

const PLAYERS: readonly PlayerState[] = [
  player(0, at(1, 1)),
  player(1, at(3, 3)),
  player(2, at(2, 2), 'barbarian'),
];

const city = (overrides: Partial<City> = {}): City => ({
  id: asCityId(0),
  owner: asPlayerId(0),
  name: 'City 1',
  tile: asTileIndex(at(2, 2)),
  population: 2,
  foodBox: 0,
  shields: 0,
  queue: [],
  buildings: [],
  workedTiles: [],
  ...overrides,
});

/**
 * A hand-built state, with the improvements it carries stated outright. The
 * literal is complete — including M4a's `improvements` — because a partial literal
 * would only typecheck through a cast, and a cast here would hide exactly the bug
 * this file exists to catch (a state built without the field).
 */
const state = (
  improvements: readonly TileImprovement[],
  cities: readonly City[] = [],
): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: seedRng(7),
  map: { width: WIDTH, height: HEIGHT, terrain: terrainIds(), huts: [] },
  players: PLAYERS,
  nextUnitId: 0,
  units: [],
  explored: PLAYERS.map(() => new Array<boolean>(WIDTH * HEIGHT).fill(false)),
  nextCityId: cities.length,
  cities,
  improvements,
});

/**
 * The city centre, the rock tile, and the tiles a citizen does and does not work.
 * Plain numbers, converted at each use: `asTileIndex` is where the brand belongs,
 * and a raw number that is never branded cannot be handed to `withImprovement`
 * without the compiler complaining — which is what keeps these four honest.
 */
const CENTRE = at(2, 2); // 12, mountains
const HILLS = at(0, 2); // 10, hills
const WORKED = at(3, 2); // 13, grassland
const UNWORKED = at(1, 1); // 6, grassland

/** A thawed deep copy, for the purity checks. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* ------------------------------------------------------------------ *
 * Setup: the field itself
 * ------------------------------------------------------------------ */

describe('GameState.improvements at setup', () => {
  it('starts empty, as an array, at schema version 4', () => {
    // A third additive shape change (M1 -> M2 -> M3 -> M4a): the field is empty
    // here, and the version moved with it, so a save from the previous shape is
    // recognisable rather than silently misread.
    const game = newGame(42, SETTINGS, RULESET);
    expect(game.ok).toBe(true);
    if (!game.ok) return;

    expect(game.value.improvements).toEqual([]);
    expect(Array.isArray(game.value.improvements)).toBe(true);
    expect(game.value.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
  });

  it('is deterministic, and a rebuilt state is deep-equal', () => {
    const first = newGame(1337, SETTINGS, RULESET);
    const second = newGame(1337, SETTINGS, RULESET);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.improvements).toEqual(first.value.improvements);
    expect(second.value).toEqual(first.value);
    // The field is JSON-serialisable, which is the whole reason it is an empty
    // array rather than `undefined`: a key holding `undefined` cannot survive a
    // round trip and makes the state unhashable.
    expect(JSON.parse(JSON.stringify(first.value))).toEqual(first.value);
  });
});

/* ------------------------------------------------------------------ *
 * The four helpers: contract, ordering, purity
 * ------------------------------------------------------------------ */

describe('improvement helpers', () => {
  it('reads an empty list for an unimproved tile, and the kinds on an improved one', () => {
    const board = state([{ tile: asTileIndex(WORKED), kind: ROAD }]);

    expect(improvementsAt(board, asTileIndex(WORKED))).toEqual([ROAD]);
    expect(improvementsAt(board, asTileIndex(UNWORKED))).toEqual([]);
    expect(improvementsAt(board, asTileIndex(-1))).toEqual([]);

    expect(hasImprovement(board, asTileIndex(WORKED), ROAD)).toBe(true);
    expect(hasImprovement(board, asTileIndex(WORKED), MINE)).toBe(false);
    expect(hasImprovement(board, asTileIndex(UNWORKED), ROAD)).toBe(false);
  });

  it('holds several improvements on one tile, in the canonical kind order', () => {
    // A road *and* a mine on one tile is the reason this is a list of pairs.
    const board = withImprovement(
      withImprovement(state([]), asTileIndex(HILLS), MINE),
      asTileIndex(HILLS),
      ROAD,
    );

    // `IMPROVEMENT_KINDS` is ['road', 'mine', 'irrigation'], so the road sorts
    // before the mine whatever order they were added in.
    expect(improvementsAt(board, asTileIndex(HILLS))).toEqual([ROAD, MINE]);
    expect(IMPROVEMENT_KINDS).toEqual(['road', 'mine', 'irrigation']);
  });

  it('keeps the list sorted by (tile, kind) wherever an entry was added', () => {
    // Indices, not coordinates: two tiles that happen to share an index would make
    // this pass for the wrong tile, so the constants are asserted distinct first.
    expect(new Set<number>([HILLS, WORKED, UNWORKED]).size).toBe(3);

    // Added in the worst possible order: the highest tile first, and within a tile
    // the later kind first. The stored order is a function of the pairs, not of the
    // insertion order — which is what makes the order safe to hash.
    let scrambled = state([]);
    scrambled = withImprovement(scrambled, asTileIndex(UNWORKED), MINE);
    scrambled = withImprovement(scrambled, asTileIndex(UNWORKED), ROAD);
    scrambled = withImprovement(scrambled, asTileIndex(WORKED), IRRIGATION);
    scrambled = withImprovement(scrambled, asTileIndex(HILLS), ROAD);
    scrambled = withImprovement(scrambled, asTileIndex(WORKED), MINE);

    const pairs = scrambled.improvements.map((entry) => [Number(entry.tile), entry.kind]);
    // The unworked grassland first, then the hills tile (only a road was added
    // there), then the worked tile with its two kinds in kind order.
    expect(pairs).toEqual([
      [UNWORKED, 'road'],
      [UNWORKED, 'mine'],
      [HILLS, 'road'],
      [WORKED, 'mine'],
      [WORKED, 'irrigation'],
    ]);

    // Sorting by tile, then by kind, is exactly the same statement, checked against
    // an independent sort rather than against the module's own comparison.
    const kindOrder: readonly string[] = IMPROVEMENT_KINDS;
    const sorted = [...scrambled.improvements].sort((a, b) => {
      if (a.tile !== b.tile) return Number(a.tile) - Number(b.tile);
      return kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
    });
    expect(scrambled.improvements).toEqual(sorted);

    // The store is per (tile, kind): the tile order leads, and only then the kind.
    const tileOrder = scrambled.improvements.map((entry) => Number(entry.tile));
    expect([...tileOrder]).toEqual([...tileOrder].sort((a, b) => a - b));
  });

  it('never stores the same pair twice, and is idempotent', () => {
    const once = withImprovement(state([]), asTileIndex(WORKED), MINE);
    const twice = withImprovement(once, asTileIndex(WORKED), MINE);
    const thrice = withImprovement(twice, asTileIndex(WORKED), MINE);

    expect(once.improvements).toHaveLength(1);
    // "Idempotent" is the strong reading: the second call changes nothing at all,
    // so a repeated request cannot move a hash.
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    expect(new Set(twice.improvements.map((e) => `${String(e.tile)}:${e.kind}`)).size).toBe(1);

    // Adding a *different* kind to the same tile is a real change.
    expect(withImprovement(once, asTileIndex(WORKED), ROAD)).not.toEqual(once);
  });

  it('reads a state whose improvements key is absent as having none', () => {
    // `GameState.improvements` is required, so this state is not one the engine
    // builds — it stands in for a hand-built literal or an old save. The read path
    // is *total* for it: `FoundCity`'s auto-assignment reaches `tileYields` through
    // `cityYields` on whatever state it is handed, and a `TypeError` in the middle
    // of a yield sum is a far worse answer than "nothing is built here".
    const board = state([]);
    const withoutKey = { ...board };
    // A deliberate `delete` on a copy, because the point is the *absent* key: no
    // literal spelling of `GameState` can produce one, which is exactly why the
    // read has to tolerate it rather than trust the type.
    delete (withoutKey as { improvements?: readonly TileImprovement[] }).improvements;

    expect('improvements' in withoutKey).toBe(false);
    expect(improvementsAt(withoutKey, asTileIndex(WORKED))).toEqual([]);
    expect(hasImprovement(withoutKey, asTileIndex(WORKED), ROAD)).toBe(false);
    expect(tileYields(withoutKey, RULESET, asTileIndex(WORKED))).toEqual(
      TERRAIN_YIELDS['grassland'],
    );
    // And writing to such a state produces a *complete* one: the field is added.
    const repaired = withImprovement(withoutKey, asTileIndex(WORKED), ROAD);
    expect(improvementsAt(repaired, asTileIndex(WORKED))).toEqual([ROAD]);
    expect('improvements' in repaired).toBe(true);
  });

  it('removes exactly the pair asked for, and nothing when it is not there', () => {
    const board = withImprovement(
      withImprovement(state([]), asTileIndex(HILLS), MINE),
      asTileIndex(HILLS),
      ROAD,
    );

    const withoutMine = withoutImprovement(board, asTileIndex(HILLS), MINE);
    expect(improvementsAt(withoutMine, asTileIndex(HILLS))).toEqual([ROAD]);

    // Removing what is not there is a no-op in value, even though it rebuilds the
    // array (the call is uniform).
    expect(withoutImprovement(board, asTileIndex(HILLS), IRRIGATION)).toEqual(board);
    expect(withoutImprovement(board, asTileIndex(UNWORKED), ROAD)).toEqual(board);
    // And it never touches another tile: the same kind elsewhere stays.
    const two = withImprovement(
      withImprovement(state([]), asTileIndex(HILLS), ROAD),
      asTileIndex(WORKED),
      ROAD,
    );
    expect(
      improvementsAt(withoutImprovement(two, asTileIndex(HILLS), ROAD), asTileIndex(WORKED)),
    ).toEqual([ROAD]);
  });

  it('never modifies the state it was handed', () => {
    const board = state([{ tile: asTileIndex(WORKED), kind: ROAD }]);
    const before = clone(board);
    const frozen = JSON.stringify(before, null, 2);

    const added = withImprovement(board, asTileIndex(HILLS), MINE);
    const removed = withoutImprovement(board, asTileIndex(WORKED), ROAD);
    // Reads, too: a pure read that mutated would be worse, because nothing would
    // look wrong until a later hash.
    improvementsAt(board, asTileIndex(WORKED));
    hasImprovement(board, asTileIndex(WORKED), ROAD);

    expect(board).toEqual(before);
    expect(JSON.stringify(board, null, 2)).toBe(frozen);
    expect(added).not.toBe(board);
    expect(removed).not.toBe(board);
    // The original still holds its own single improvement.
    expect(board.improvements).toEqual([{ tile: asTileIndex(WORKED), kind: ROAD }]);
    expect(added.improvements).toHaveLength(2);
    expect(removed.improvements).toHaveLength(0);
    // Nothing else about the state moved: an improvement is not a revision.
    expect(added.revision).toBe(board.revision);
    expect(added.map).toBe(board.map);
    expect(added.turn).toBe(board.turn);
  });

  it('does not consult a ruleset, so an unknown kind is still visible', () => {
    // The state says what is built; the catalog says what a kind *does*. A kind
    // this build of the ruleset does not describe was still built, so it reads
    // back — it simply contributes no yields.
    const unknown = asImprovementId('space-elevator');
    const board = withImprovement(state([]), asTileIndex(WORKED), unknown);

    expect(improvementsAt(board, asTileIndex(WORKED))).toEqual([unknown]);
    expect(hasImprovement(board, asTileIndex(WORKED), unknown)).toBe(true);
    expect(improvementDef(RULESET, unknown)).toBeUndefined();
    expect(tileYields(board, RULESET, asTileIndex(WORKED))).toEqual(TERRAIN_YIELDS['grassland']);
  });

  it('exposes the catalog as data order, and resolves a row by id', () => {
    expect(improvementCatalog(RULESET)).toEqual([...IMPROVEMENTS]);
    expect(improvementCatalog(NO_IMPROVEMENTS)).toEqual([]);
    expect(improvementDef(RULESET, MINE)?.turns).toBe(3);
    expect(improvementDef(RULESET, asImprovementId('farm'))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Yields: worked tiles change, unworked tiles do not
 * ------------------------------------------------------------------ */

describe('yields with improvements', () => {
  it('adds exactly the improvement delta to a tile’s own yields', () => {
    const plain = tileYields(state([]), RULESET, asTileIndex(HILLS));
    const mined = tileYields(
      state([{ tile: asTileIndex(HILLS), kind: MINE }]),
      RULESET,
      asTileIndex(HILLS),
    );

    // Hills are 1/2/1 in this ruleset; a mine adds one shield and nothing else.
    expect(plain).toEqual({ food: 1, shields: 2, commerce: 1 });
    expect(mined).toEqual({ food: 1, shields: 3, commerce: 1 });

    // And an unknown tile still answers "nothing", not a throw.
    expect(tileYields(state([]), RULESET, asTileIndex(-1))).toBeUndefined();
  });

  it('sums every improvement on the tile, and only that tile’s', () => {
    const board = state([
      { tile: asTileIndex(HILLS), kind: ROAD },
      { tile: asTileIndex(HILLS), kind: MINE },
      // An irrigation on a different tile must not leak into this one.
      { tile: asTileIndex(WORKED), kind: IRRIGATION },
    ]);

    expect(tileYields(board, RULESET, asTileIndex(HILLS))).toEqual({
      food: 1,
      shields: 3, // 2 + mine
      commerce: 2, // 1 + road
    });
    expect(tileYields(board, RULESET, asTileIndex(WORKED))).toEqual({
      food: 3, // 2 + irrigation
      shields: 1,
      commerce: 1,
    });
  });

  it('changes a city’s output by exactly the delta for a worked tile', () => {
    const worked = city({ workedTiles: [asTileIndex(WORKED)] });
    const before = state([], [worked]);

    const after = state([{ tile: asTileIndex(WORKED), kind: MINE }], [worked]);

    const plain = cityYields(before, RULESET, asCityId(0));
    const mined = cityYields(after, RULESET, asCityId(0));

    // Centre (mountains 0/0/0) floors to 1/1/1; the worked grassland adds 2/1/1.
    expect(plain).toEqual({ food: 3, shields: 2, commerce: 2, foodSurplus: 3 - 2 * 2 });
    // Exactly one more shield, and *only* a shield: the delta, not a re-derivation.
    expect(mined.shields - plain.shields).toBe(1);
    expect(mined.food).toBe(plain.food);
    expect(mined.commerce).toBe(plain.commerce);
    expect(mined.foodSurplus).toBe(plain.foodSurplus);
    expect(mined).toEqual({ food: 3, shields: 3, commerce: 2, foodSurplus: -1 });
  });

  it('leaves the city’s output alone for an improvement on an unworked tile', () => {
    // The city works (3,2); the mine is on (0,2) — inside the radius, but no
    // citizen works it, so it produces nothing for this city. This is the whole
    // distinction M4a adds: improvements pay only where a citizen works.
    const worked = city({ workedTiles: [asTileIndex(WORKED)] });
    const untouched = state([], [worked]);
    const minedElsewhere = state([{ tile: asTileIndex(HILLS), kind: MINE }], [worked]);

    const plain = cityYields(untouched, RULESET, asCityId(0));
    const other = cityYields(minedElsewhere, RULESET, asCityId(0));

    expect(other).toEqual(plain);
    // Stated both ways: nothing changed, and every component is what the terrain
    // alone gives.
    expect(other.shields).toBe(2);
    expect(other.food).toBe(3);

    // The unworked tile *does* yield more on its own — the difference is the city,
    // not the tile.
    expect(tileYields(minedElsewhere, RULESET, asTileIndex(HILLS))?.shields).toBe(3);
  });

  it('does not let an improvement touch the city centre', () => {
    // The centre (2,2) is mountains (0/0/0) and is not a worked tile, so a mine on
    // it changes nothing at all — not even the floor, which is read from terrain.
    const bare = state([], [city()]);
    const mined = state([{ tile: asTileIndex(CENTRE), kind: MINE }], [city()]);

    expect(cityYields(mined, RULESET, asCityId(0))).toEqual(cityYields(bare, RULESET, asCityId(0)));
    expect(cityYields(mined, RULESET, asCityId(0))).toEqual({
      food: 1,
      shields: 1,
      commerce: 1,
      foodSurplus: 1 - 2 * 2,
    });
  });

  it('clamps a negative delta at zero per component', () => {
    const worked = city({ workedTiles: [asTileIndex(WORKED)] });
    const drained = state([{ tile: asTileIndex(WORKED), kind: DRAIN.id }], [worked]);

    // The tile yields 2/1/1 and the delta is -5 per component, so without a clamp
    // it would be -3/-4/-4. Improvements may never make a tile negative.
    expect(tileYields(drained, DRAINING, asTileIndex(WORKED))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });

    const plain = cityYields(state([], [worked]), RULESET, asCityId(0));
    const after = cityYields(drained, DRAINING, asCityId(0));

    // The city keeps its centre floor and loses only what the tile could give.
    expect(after).toEqual({ food: 1, shields: 1, commerce: 1, foodSurplus: 1 - 2 * 2 });
    expect(after.shields).toBeLessThan(plain.shields);
    for (const value of [after.food, after.shields, after.commerce, after.foodSurplus]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('changes nothing when the ruleset ships no improvements', () => {
    // `improvements: []` is a catalog, not a hole: the field exists, and a ruleset
    // that describes nothing produces exactly the terrain's yields.
    const board = state(
      [{ tile: asTileIndex(WORKED), kind: ROAD }],
      [city({ workedTiles: [asTileIndex(WORKED)] })],
    );

    expect(tileYields(board, NO_IMPROVEMENTS, asTileIndex(WORKED))).toEqual(
      TERRAIN_YIELDS['grassland'],
    );
    expect(cityYields(board, NO_IMPROVEMENTS, asCityId(0))).toEqual(
      cityYields(state([], [city({ workedTiles: [asTileIndex(WORKED)] })]), RULESET, asCityId(0)),
    );
  });

  it('produces integers for every combination of improvements and tiles', () => {
    const kinds = [ROAD, MINE, IRRIGATION];
    const tiles = [asTileIndex(HILLS), asTileIndex(CENTRE), asTileIndex(WORKED)];

    let board = state([]);
    for (const tile of tiles) for (const kind of kinds) board = withImprovement(board, tile, kind);

    const worked = city({ population: 4, workedTiles: tiles });
    const withCity = state(board.improvements, [worked]);

    for (const tile of tiles) {
      const yields = tileYields(withCity, RULESET, tile);
      expect(yields).toBeDefined();
      if (yields === undefined) continue;
      for (const value of [yields.food, yields.shields, yields.commerce]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }

    const cityOut = cityYields(withCity, RULESET, asCityId(0));
    for (const value of [cityOut.food, cityOut.shields, cityOut.commerce, cityOut.foodSurplus]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('is independent of where the improvements sit in the array', () => {
    // Same pairs, different array order: the *result* must be identical, because
    // the yielded numbers are a sum and the sum does not care. (The stored order
    // is a separate contract, asserted above.)
    const pairs: readonly TileImprovement[] = [
      { tile: asTileIndex(HILLS), kind: MINE },
      { tile: asTileIndex(WORKED), kind: ROAD },
    ];
    const forwards = state(pairs);
    const backwards = state([...pairs].reverse());

    expect(tileYields(forwards, RULESET, asTileIndex(HILLS))).toEqual(
      tileYields(backwards, RULESET, asTileIndex(HILLS)),
    );
    expect(improvementsAt(forwards, asTileIndex(WORKED))).toEqual(
      improvementsAt(backwards, asTileIndex(WORKED)),
    );

    // The arrays themselves differ (which is why the sorted order is a rule), and
    // the map grid is what the coordinate helpers agree on.
    expect(forwards.improvements[0]?.kind).toBe(MINE);
    expect(backwards.improvements[0]?.kind).toBe(ROAD);
    expect(indexToX(forwards.map, HILLS)).toBe(0);
    expect(indexToY(forwards.map, HILLS)).toBe(2);
    // The two tiles the pairs name really are two tiles.
    expect(HILLS).not.toBe(WORKED);
  });
});
