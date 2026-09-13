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
// The shipped catalog is read by ONE test below, which pins the coincidence the
// state-level ordering depends on (`id === kind` for every shipped row). Nothing in
// `packages/core/src` reads this package.
import { CATALOG } from '@civts/rules';
import { hashValue } from '@civts/testing';
import { cityYields, type City } from '../src/cities.js';
import {
  asCityId,
  asGovernmentId,
  asPlayerId,
  asTechId,
  asTerrainId,
  asTileIndex,
  asUnitTypeId,
  type TechId,
} from '../src/ids.js';
import { unmetTechFor } from '../src/resources.js';
import type { TechDef } from '../src/tech.js';
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
import {
  DEFAULT_RATES,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  newGame,
  type GameState,
  type PlayerState,
} from '../src/state.js';

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

const player = (
  index: number,
  tile: number,
  kind: 'civ' | 'barbarian' = 'civ',
  techs: readonly TechId[] = [],
): PlayerState => ({
  id: asPlayerId(index),
  name: kind === 'barbarian' ? 'Barbarians' : `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind,
  // M4b: every player carries the money fields, barbarians included (they hold 0
  // and never move, because they have no economy). A civilization's fixture starts
  // with the engine's own `STARTING_TREASURY` at `DEFAULT_RATES` so a fixture can
  // never drift from what `newGame` builds.
  treasury: kind === 'barbarian' ? 0 : STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: `techs` is required and never absent — "knows nothing" is an *empty list*,
  // the same way "no cities" is an empty `cities` array. This file's subject is tile
  // yields, so the default is that a fixture player has researched nothing; the
  // parameter exists because the improvement kind is gated by tech too (M5's
  // "Gating"), and the one section that says so needs a player who knows one.
  techs: [...techs],
  government: asGovernmentId('despotism'),
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
  // M9: a city's accumulated culture. `borders.ts` derives a city's claim radius
  // from this and `computeTileOwner` reads it, so a hand-built city states a number
  // rather than leaving the engine to guess one.
  culture: 0,
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
  map: {
    width: WIDTH,
    height: HEIGHT,
    terrain: terrainIds(),
    huts: [],
    // M4c: the map carries the resources `generateWorld` placed, as sparse
    // `(tile, resource)` pairs. Empty here — an improvement's own rules read no
    // resource — and spelled out rather than omitted, because the key is part of
    // `GameMap` and therefore of every state hash.
    resources: [],
  },
  players: PLAYERS,
  nextUnitId: 0,
  units: [],
  explored: PLAYERS.map(() => new Array<boolean>(WIDTH * HEIGHT).fill(false)),
  nextCityId: cities.length,

  tileOwner: [],
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
  it('starts empty, as an array, at schema version 9', () => {
    // A fifth additive shape change (M1 -> M2 -> M3 -> M4a -> M4b -> M4c -> M5): the
    // field is empty here, and the version moved with it, so a save from the previous
    // shape is recognisable rather than silently misread. M4b moved it because
    // `PlayerState` gained `treasury`/`rates`/`beakers`/`luxuries` and `newGame`
    // now also places a worker — both of which change every existing hash
    // (INTERFACES.md M4b, "Migration owners"). M4c moved it again because `GameMap`
    // gained `resources`: no `GameState` key is new this time, but `map` is inside
    // the state and is hashed with it, so a new map key moves every hash exactly as
    // a new state key would (INTERFACES.md M4c, "Resources", "Migration owners").
    // M5 moved it for `PlayerState.techs`: a required list on every player, so every
    // player row of every existing save hashes differently (INTERFACES.md M5,
    // "Research", "Migration owners"). The version is the *applier's* fact, not this
    // file's — `state.ts` owns it and `state.test.ts` pins it by value too.
    const game = newGame(42, SETTINGS, RULESET);
    expect(game.ok).toBe(true);
    if (!game.ok) return;

    expect(game.value.improvements).toEqual([]);
    expect(Array.isArray(game.value.improvements)).toBe(true);
    expect(game.value.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(9);

    // M4c's map key, read the same way and for the same reason: a fresh game's map
    // always *carries* `resources`, and this stand-in catalog ships no resource row,
    // so the honest reading is present-and-empty. Absent would be a state that
    // predates M4c — a different shape wearing the same version number.
    expect(Array.isArray(game.value.map.resources)).toBe(true);
    expect(game.value.map.resources).toEqual([]);
    expect(Object.keys(game.value.map).sort()).toEqual([
      'height',
      'huts',
      'resources',
      'terrain',
      'width',
    ]);

    // The new keys are readable straight off a fresh game, on *every* player:
    // civilizations hold the starting treasury, barbarians hold nothing, and every
    // row carries a well-formed rates triple. A field added to the shape but left
    // unwritten would be exactly the unhashable-state bug class this project has
    // hit three times, so it is asserted rather than assumed.
    expect(game.value.players.length).toBe(SETTINGS.civCount + 1);
    for (const player of game.value.players) {
      expect(player.rates).toEqual(DEFAULT_RATES);
      expect(player.rates.tax + player.rates.science + player.rates.luxury).toBe(RATE_TOTAL);
      expect(Number.isInteger(player.treasury)).toBe(true);
      expect(player.treasury).toBe(player.kind === 'barbarian' ? 0 : STARTING_TREASURY);
      expect(player.beakers).toBe(0);
      expect(player.luxuries).toBe(0);
    }
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

  it('ranks a stored id by the KIND it names, and not by its spelling', () => {
    // The second key is the position of the id's kind in `IMPROVEMENT_KINDS`
    // (road, mine, irrigation): editorial order, and deliberately *not* code-unit
    // order, which would put irrigation first and move every golden. Built by adding
    // the two rows in the order a spelling comparison would have produced.
    const board = withImprovement(
      withImprovement(state([]), asTileIndex(WORKED), IRRIGATION),
      asTileIndex(WORKED),
      ROAD,
    );

    expect(improvementsAt(board, asTileIndex(WORKED))).toEqual([ROAD, IRRIGATION]);
    // Non-vacuity: the two spellings really do sort the other way round, and the two
    // kinds really are in the other order in the vocabulary.
    expect([...['road', 'irrigation']].sort()).toEqual(['irrigation', 'road']);
    expect(IMPROVEMENT_KINDS.indexOf('road')).toBeLessThan(IMPROVEMENT_KINDS.indexOf('irrigation'));
  });

  it('orders ids the kind vocabulary does not contain by id, never by insertion order', () => {
    // The state layer ranks *ids*. This module never sees a ruleset — the frozen
    // helpers take `(state, tile, kind)` and the state must be able to order its own
    // pairs without a catalog — so an id that names no kind has no rank, and it is
    // separated from another such id by its spelling rather than by the order it
    // arrived in. Without that tie-break, two unknown ids on one tile compare equal in
    // both directions, and the stored order — which is hashed — becomes a function of
    // insertion order for exactly the states this module is careful about (a hand-built
    // fixture, a save written by another build).
    const forward = withImprovement(
      withImprovement(state([]), asTileIndex(WORKED), asImprovementId('zeta')),
      asTileIndex(WORKED),
      asImprovementId('alpha'),
    );
    const backward = withImprovement(
      withImprovement(state([]), asTileIndex(WORKED), asImprovementId('alpha')),
      asTileIndex(WORKED),
      asImprovementId('zeta'),
    );

    expect(improvementsAt(forward, asTileIndex(WORKED))).toEqual([
      asImprovementId('alpha'),
      asImprovementId('zeta'),
    ]);
    // The two builds are the same state, not merely the same list.
    expect(backward).toEqual(forward);
    expect(hashValue(backward)).toBe(hashValue(forward));
  });

  it('puts an id that names no kind before every kind it does know', () => {
    // An unknown id ranks `-1`, before the vocabulary: arbitrary, but fixed — the same
    // answer on every engine — so a foreign save's order cannot move between runs.
    const board = withImprovement(
      withImprovement(state([]), asTileIndex(WORKED), ROAD),
      asTileIndex(WORKED),
      asImprovementId('space-elevator'),
    );

    expect(improvementsAt(board, asTileIndex(WORKED))).toEqual([
      asImprovementId('space-elevator'),
      ROAD,
    ]);
  });

  it('states the shipped catalog’s coincidence: every shipped row is named after its kind', () => {
    // The state-level ranking above reads an id against the *kind* vocabulary, which is
    // only the same question as "which kind is this row?" while `id` and `kind` agree —
    // and the shipped catalog is exactly that case. Pinned rather than assumed, because
    // it is a coupling between content and the hashed stored order: renaming a shipped
    // row's id would change where that row's pairs sort (its id would rank `-1`), which
    // is a behaviour change nobody would see in a diff of the catalog alone. A consumer
    // that has the ruleset reads the row's own `kind` field instead
    // (`improvementDef(ruleset, id)?.kind` — `packages/sim`'s worker-job ranking), and
    // that reading is the proper derivation of a kind from a stored id.
    const catalog = CATALOG.improvements;
    expect(catalog.length).toBeGreaterThan(0);
    for (const row of catalog) expect(row.id).toBe(row.kind);
    // ...and the engine's vocabulary contains every kind the catalog uses, so no
    // shipped row can be the `-1` case.
    for (const row of catalog) expect(IMPROVEMENT_KINDS).toContain(row.kind);

    // The same statement against a *renamed* catalog, which is what the caveat above
    // is about: the rows' kinds are unchanged, but the stored order now follows the ids.
    const renamed: readonly ImprovementDef[] = catalog.map((row) => ({
      ...row,
      id: asImprovementId(`zz-${row.kind}`),
    }));
    const board = withImprovement(
      withImprovement(state([]), asTileIndex(WORKED), asImprovementId('zz-road')),
      asTileIndex(WORKED),
      asImprovementId('zz-mine'),
    );
    expect(improvementsAt(board, asTileIndex(WORKED))).toEqual([
      asImprovementId('zz-mine'),
      asImprovementId('zz-road'),
    ]);
    expect(renamed.map((row) => row.kind)).toEqual(catalog.map((row) => row.kind));
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

/* ------------------------------------------------------------------ *
 * M5 gating — an improvement row's tech, and the yields it does not change
 * ------------------------------------------------------------------ */

/**
 * The M5 fixture tech rows: two **placeholder** rows of ours (the costs are arbitrary
 * and unread — a requirement is a membership test on `player.techs`). `BRONZE` gates
 * the row below; `UNUSED_TECH` gates nothing, which is the control the contract asks
 * for.
 */
const BRONZE = asTechId('bronze-working');
const UNUSED_TECH = asTechId('ceremonial-burial');

const TECHS: readonly TechDef[] = [
  { id: BRONZE, name: 'Bronze Working', era: 'ancient', cost: 6, requires: [] },
  { id: UNUSED_TECH, name: 'Ceremonial Burial', era: 'ancient', cost: 6, requires: [] },
];

/**
 * The one gated improvement row, with an id of its own rather than a second `mine`:
 * an id is the key a catalog is looked up by, so two rows sharing one would make "the
 * row for `mine`" depend on catalog order. Its shape is the mine's — same kind, same
 * delta, same roles — so the only difference between it and the mine is the tech.
 */
const PROSPECTING: ImprovementDef & { readonly requiresTech: TechId } = {
  id: asImprovementId('prospecting'),
  kind: 'mine',
  name: 'Prospecting Pit',
  turns: 3,
  yields: { food: 0, shields: 1, commerce: 0 },
  allowedRoles: ['hills', 'mountains'],
  requiresTech: BRONZE,
};

/** The fixture view plus the one gated row, and somewhere for techs to live. */
const TECH_RULESET: RulesetView & { readonly techs: readonly TechDef[] } = {
  ...RULESET,
  improvements: [...IMPROVEMENTS, PROSPECTING],
  techs: TECHS,
};

describe('M5 gating — an improvement row may declare a tech', () => {
  const P0 = asPlayerId(0);

  /** The fixture board with player 0 knowing exactly `techs`, and nothing else changed. */
  const knowing = (techs: readonly TechId[]): GameState => {
    const base = state([]);
    return {
      ...base,
      players: base.players.map((p) => (p.id === P0 ? player(0, at(1, 1), 'civ', techs) : p)),
    };
  };

  it('reads the requirement off the catalog row, before and after the tech', () => {
    // The row `improvementDef` resolves is where the field lives, and the gate reads
    // it off that row rather than off the id or the kind.
    const row = improvementDef(TECH_RULESET, PROSPECTING.id);
    expect(row).toBe(PROSPECTING);
    expect(unmetTechFor(knowing([]), P0, row)).toBe(BRONZE);

    // Control: the same board with one player field changed is satisfied.
    expect(unmetTechFor(knowing([BRONZE]), P0, row)).toBeUndefined();

    // A tech that gates nothing does not satisfy it — the requirement is `BRONZE`.
    expect(unmetTechFor(knowing([UNUSED_TECH]), P0, row)).toBe(BRONZE);

    // A row the catalog does not define has no requirement to report, and the
    // *ungated* mine's requirement is nothing whatever the player knows.
    expect(improvementDef(TECH_RULESET, asImprovementId('nope'))).toBeUndefined();
    expect(unmetTechFor(knowing([]), P0, improvementDef(RULESET, MINE))).toBeUndefined();
  });

  it('leaves every row that declares no tech ungated', () => {
    // The other half of the sweep, over this file's own catalog: three of its four
    // rows declare nothing, and a player who knows nothing may still start them.
    let ungated = 0;
    for (const row of improvementCatalog(TECH_RULESET)) {
      if (row === PROSPECTING) continue;
      ungated += 1;
      expect(unmetTechFor(knowing([]), P0, row)).toBeUndefined();
      expect(unmetTechFor(knowing([UNUSED_TECH]), P0, row)).toBeUndefined();
    }
    expect(ungated).toBe(IMPROVEMENTS.length);
  });

  it('does not change what a gated improvement is worth on a tile', () => {
    // The requirement gates *building* the improvement (M5's gating section is about
    // what may be built, not about what a thing is worth), so the delta a gated row
    // adds is the delta any player sees: a tile that already carries one is worth the
    // same to a player who could not have built it.
    const plain = tileYields(knowing([]), TECH_RULESET, asTileIndex(HILLS));
    const dug = tileYields(
      state([{ tile: asTileIndex(HILLS), kind: PROSPECTING.id }]),
      TECH_RULESET,
      asTileIndex(HILLS),
    );

    // Hills are 1/2/1 here and the row adds one shield — the mine's own delta — with
    // no reference to any player's techs.
    expect(plain).toEqual({ food: 1, shields: 2, commerce: 1 });
    expect(dug).toEqual({ food: 1, shields: 3, commerce: 1 });
  });
});
