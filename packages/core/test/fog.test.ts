/**
 * Fog of war tests (INTERFACES.md M2, "Fog").
 *
 * The properties that matter here are the ones the rest of M2 leans on:
 *
 * - **Explored is memory, visible is derived.** `visibleTiles` recomputes sight
 *   from unit positions and reads no stored layer at all; `withExplored` is the
 *   only thing that grows memory, and it only ever adds.
 * - **`withExplored` is pure.** The state it is handed is deeply frozen before
 *   the call, so any write to it would throw in strict mode, and the rows are
 *   compared against copies afterwards. Two independent checks, because "it
 *   looked pure" is not evidence.
 * - **Fog does not leak.** A viewer's `describe` output is a function of the
 *   explored row alone: changing the terrain or a start position underneath
 *   unexplored tiles must not change a single character.
 *
 * The board is a hand-built 6x6 because it makes "which tile is that" arithmetic
 * in the test, and because the fog rules are about tiles, not about generation —
 * `state.test.ts` and the `newGame` cases at the end cover the generated world.
 * The expected Chebyshev balls are computed with `distance8` from `map.ts`: an
 * independent oracle, so the box scan inside `visibleTiles` is not checked
 * against a copy of itself.
 *
 * **Migrated to the M3 state shape** (docs/INTERFACES.md M3). The hand-built
 * fixtures carry `kind: 'civ'` on a player, `huts` on the map and
 * `nextCityId`/`cities` on the state, and the generated-game cases ask
 * `civPlayers` for "the civilizations' starts" — `players` now ends with the
 * barbarian player, whose own fog row is asserted to be blank and map-sized
 * rather than being silently skipped.
 */

import { describe, expect, it } from 'vitest';
import {
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type TileIndex,
} from '../src/ids.js';
import { isExplored, visibleTiles, withExplored, VISIBILITY_RADIUS } from '../src/fog.js';
import {
  distance8,
  neighbors8,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  civPlayers,
  newGame,
  SCHEMA_VERSION,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import { describe as describeState } from '../src/textview.js';
import { type Unit, type UnitDef } from '../src/units.js';

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

const RULESET: RulesetView = { terrains: TERRAINS, units: [SETTLER], fidelity: 'tuned' };

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** A 6x6 board of plain grassland, so tile indices read as y * 6 + x. */
const WIDTH = 6;
const SIZE = WIDTH * WIDTH;
const MAP: GameMap = {
  width: WIDTH,
  height: WIDTH,
  terrain: Array.from({ length: SIZE }, () => asTerrainId('grassland')),
  // M3: huts live on the map. This board has none — fog is about tiles a player
  // has seen, and a hut is not a fog rule; the generated-game cases below do
  // carry the real, hut-bearing map.
  huts: [],
};

/** A civilization. M3 added `kind`; these hand-built players are all civs. */
const player = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind: 'civ',
});

const unit = (id: number, owner: number, tile: number): Unit => ({
  id: asUnitId(id),
  type: SETTLER.id,
  owner: asPlayerId(owner),
  tile: asTileIndex(tile),
  movementLeft: SETTLER.movement,
});

/** Player 0's unit at (1,1) = 7; player 1's at (4,4) = 28. Far apart on purpose. */
const P0_START = 7;
const P1_START = 28;

/** Every tile within Chebyshev `radius` of `centre`, ascending — the oracle. */
const ball = (centre: number, radius: number): readonly number[] => {
  const out: number[] = [];
  for (let tile = 0; tile < SIZE; tile += 1) {
    if (distance8(MAP, tile, centre) <= radius) out.push(tile);
  }
  return out;
};

const tiles = (indices: readonly number[]): readonly TileIndex[] =>
  indices.map((index) => asTileIndex(index));

/** A dense, map-sized fog row with `indices` marked explored. */
const rowOf = (indices: readonly number[]): readonly boolean[] =>
  Array.from({ length: SIZE }, (_, tile) => indices.includes(tile));

/** A copy of `state` with unit number `index` standing on `tile`. */
const withUnitOn = (state: GameState, index: number, tile: number): GameState => ({
  ...state,
  units: state.units.map((existing, at) =>
    at === index ? { ...existing, tile: asTileIndex(tile) } : existing,
  ),
});

/** The glyph columns of every grid row, without the row-number gutter. */
const glyphRows = (view: string): readonly string[] =>
  view
    .split('\n')
    .filter((line) => /^ *\d+ \|/.test(line))
    .map((line) => line.slice(line.indexOf('|') + 1));

/** How many tiles the view renders as fog. */
const fogCount = (view: string): number => glyphRows(view).join('').split('?').length - 1;

/** A state whose fog rows start from the two starts' visibility radius. */
const STATE: GameState = {
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 11,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0, P0_START), player(1, P1_START)],
  nextUnitId: 2,
  units: [unit(0, 0, P0_START), unit(1, 1, P1_START)],
  explored: [rowOf(ball(P0_START, 2)), rowOf(ball(P1_START, 2))],
  // M3: a hand-built world has no cities; `FoundCity` is the only creator.
  nextCityId: 0,
  cities: [],
};

/** A tile player 0 has never been near: (5,5) = 35, four tiles from its unit. */
const FAR_TILE = 35;

/** Player 0's unit at (3,4) = 27: its sight has moved, its explored row has not. */
const MOVED: GameState = withUnitOn(STATE, 0, 27);

/** Freeze everything `withExplored` could possibly write to. */
const frozen = (state: GameState): GameState => {
  for (const row of state.explored) Object.freeze(row);
  Object.freeze(state.explored);
  Object.freeze(state.units);
  return Object.freeze(state);
};

/** A deep copy of the fog rows, for comparing against after a call. */
const rowsCopy = (state: GameState): readonly (readonly boolean[])[] =>
  state.explored.map((row) => [...row]);

const mustGame = (seed: number): GameState => {
  const result = newGame(seed, SETTINGS, RULESET);
  if (!result.ok) throw new Error('expected a state');
  return result.value;
};

describe('isExplored', () => {
  it('reports exactly the tiles inside the radius the start was marked with', () => {
    const expected = ball(P0_START, VISIBILITY_RADIUS);
    const wrong: number[] = [];
    for (let tile = 0; tile < SIZE; tile += 1) {
      if (isExplored(STATE, asPlayerId(0), asTileIndex(tile)) !== expected.includes(tile)) {
        wrong.push(tile);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('says no for a tile no unit has been near, and yes for the player whose unit is', () => {
    expect(isExplored(STATE, asPlayerId(0), asTileIndex(FAR_TILE))).toBe(false);
    expect(isExplored(STATE, asPlayerId(1), asTileIndex(FAR_TILE))).toBe(true);
    // The far tile is not merely "not visible now": it is not even visible.
    expect(visibleTiles(STATE, asPlayerId(0))).not.toContain(asTileIndex(FAR_TILE));
  });

  it('answers false — never throws — for tiles off the map and ids with no row', () => {
    for (const tile of [-1, SIZE, 9999, 1.5, Number.NaN]) {
      expect(isExplored(STATE, asPlayerId(0), asTileIndex(tile))).toBe(false);
    }
    expect(isExplored(STATE, asPlayerId(9), asTileIndex(P0_START))).toBe(false);
    expect(isExplored(STATE, asPlayerId(0.5), asTileIndex(P0_START))).toBe(false);
    expect(isExplored(STATE, asPlayerId(0), asTileIndex(P0_START))).toBe(true);
  });

  it('tells memory apart from current sight', () => {
    // The unit moved to (3,4) = 27. Tile (3,5) = 33 is one step from there, so
    // the unit can see it now, while the player's row — marked around (1,1) —
    // has never covered y = 5.
    expect(visibleTiles(MOVED, asPlayerId(0))).toContain(asTileIndex(33));
    expect(isExplored(MOVED, asPlayerId(0), asTileIndex(33))).toBe(false);
  });
});

describe('visibleTiles', () => {
  it('derives the ball around the player own units, ascending and in bounds', () => {
    const visible = visibleTiles(STATE, asPlayerId(0));

    expect(visible).toEqual(tiles(ball(P0_START, VISIBILITY_RADIUS)));
    for (const tile of visible) {
      expect(Number.isInteger(Number(tile))).toBe(true);
      expect(Number(tile)).toBeGreaterThanOrEqual(0);
      expect(Number(tile)).toBeLessThan(SIZE);
    }
    // Cheap cross-check that the order is ascending, not just a permutation.
    expect([...visible].sort((a, b) => a - b)).toEqual([...visible]);
  });

  it('is per player: one player never sees through another player units', () => {
    const mine = visibleTiles(STATE, asPlayerId(0));
    const theirs = visibleTiles(STATE, asPlayerId(1));

    expect(theirs).toEqual(tiles(ball(P1_START, VISIBILITY_RADIUS)));
    expect(mine).not.toEqual(theirs);
    expect(mine).not.toContain(asTileIndex(P1_START));
    expect(theirs).not.toContain(asTileIndex(P0_START));
  });

  it('honours an explicit radius, and defaults to VISIBILITY_RADIUS', () => {
    expect(VISIBILITY_RADIUS).toBe(2);
    expect(visibleTiles(STATE, asPlayerId(0), VISIBILITY_RADIUS)).toEqual(
      visibleTiles(STATE, asPlayerId(0)),
    );
    expect(visibleTiles(STATE, asPlayerId(0), 0)).toEqual([asTileIndex(P0_START)]);
    expect(visibleTiles(STATE, asPlayerId(0), 1)).toEqual(tiles(ball(P0_START, 1)));
    expect(visibleTiles(STATE, asPlayerId(0), 3)).toEqual(tiles(ball(P0_START, 3)));
    // Radius 3 reaches the map edge here, so the ball is clipped, not wrapped.
    expect(visibleTiles(STATE, asPlayerId(0), 99)).toEqual(tiles(ball(P0_START, 99)));
  });

  it('normalises a radius that cannot be a tile count', () => {
    const at = (radius: number): readonly TileIndex[] => visibleTiles(STATE, asPlayerId(0), radius);

    expect(at(-1)).toEqual(at(0));
    expect(at(1.5)).toEqual(at(1));
    expect(at(Number.NaN)).toEqual(at(VISIBILITY_RADIUS));
    expect(at(Number.POSITIVE_INFINITY)).toEqual(at(VISIBILITY_RADIUS));
  });

  it('is deterministic and hands back a fresh array each call', () => {
    const first = visibleTiles(STATE, asPlayerId(0));
    const second = visibleTiles(STATE, asPlayerId(0));

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('derives sight from units alone: clearing the fog does not change it', () => {
    const forgetful: GameState = { ...STATE, explored: STATE.explored.map(() => rowOf([])) };

    expect(visibleTiles(forgetful, asPlayerId(0))).toEqual(visibleTiles(STATE, asPlayerId(0)));
  });

  it('sees nothing for a player with no units, and shrugs off a unit off the map', () => {
    expect(visibleTiles(STATE, asPlayerId(9))).toEqual([]);
    expect(visibleTiles({ ...STATE, units: [] }, asPlayerId(0))).toEqual([]);

    // A corrupt save could place a unit outside the map; the neighbourhood maths
    // would wrap, so the unit contributes nothing instead.
    const stray: GameState = withUnitOn({ ...STATE, units: [unit(0, 0, 999)] }, 0, 999);
    expect(visibleTiles(stray, asPlayerId(0))).toEqual([]);
  });

  it('picks up every unit a player owns, not just the first', () => {
    const two: GameState = {
      ...STATE,
      units: [unit(0, 0, 0), unit(1, 0, SIZE - 1), unit(2, 1, P1_START)],
    };

    expect(visibleTiles(two, asPlayerId(0))).toEqual(tiles([...ball(0, 2), ...ball(SIZE - 1, 2)]));
  });
});

describe('withExplored', () => {
  it('marks the requested tiles and leaves every other tile as it was', () => {
    const next = withExplored(STATE, asPlayerId(0), tiles([FAR_TILE, 34]));

    expect(isExplored(next, asPlayerId(0), asTileIndex(FAR_TILE))).toBe(true);
    expect(isExplored(next, asPlayerId(0), asTileIndex(34))).toBe(true);
    expect(next.explored[0]).toEqual(rowOf([...ball(P0_START, 2), FAR_TILE, 34]));
    // The other player's row is untouched, by identity as well as by value.
    expect(next.explored[1]).toBe(STATE.explored[1]);
  });

  it('marks exactly the tiles it is given, with no radius of its own', () => {
    // The radius belongs to `visibleTiles`; `withExplored` is a pure write. If it
    // expanded the request itself, a caller folding sight into memory would
    // apply the radius twice — and with whatever radius it guessed.
    const next = withExplored(STATE, asPlayerId(0), tiles([FAR_TILE]));

    expect(next.explored[0]).toEqual(rowOf([...ball(P0_START, 2), FAR_TILE]));
    for (const neighbour of neighbors8(MAP, FAR_TILE)) {
      expect(isExplored(next, asPlayerId(0), neighbour)).toBe(false);
    }
  });

  it('is pure: a deeply frozen input survives the call unchanged', () => {
    const state = frozen(STATE);
    const before = rowsCopy(STATE);

    const next = withExplored(state, asPlayerId(0), tiles([FAR_TILE]));

    expect(rowsCopy(state)).toEqual(before);
    expect(state.explored[0]).toEqual(rowOf(ball(P0_START, 2)));
    expect(next).not.toBe(state);
    expect(next.explored).not.toBe(state.explored);
    expect(next.explored[0]).not.toBe(state.explored[0]);
  });

  it('ignores tiles outside the map instead of writing past the row', () => {
    const state = frozen(STATE);
    const next = withExplored(state, asPlayerId(0), tiles([-1, SIZE, 9999]));

    expect(next.explored[0]).toEqual(STATE.explored[0]);
    // A no-op still returns a distinct state object for a player that exists...
    expect(next).not.toBe(state);
    // ...but it reuses the row rather than copying width * height flags.
    expect(next.explored[0]).toBe(STATE.explored[0]);
  });

  it('reuses the row when every requested tile is already explored', () => {
    const next = withExplored(STATE, asPlayerId(0), tiles(ball(P0_START, 2)));

    expect(next.explored[0]).toBe(STATE.explored[0]);
    expect(next).not.toBe(STATE);
  });

  it('leaves the state untouched when the player has no explored row', () => {
    expect(withExplored(STATE, asPlayerId(9), tiles([0]))).toBe(STATE);
  });

  it('never forgets: explored only grows', () => {
    const next = withExplored(STATE, asPlayerId(0), tiles([FAR_TILE]));

    for (let tile = 0; tile < SIZE; tile += 1) {
      if (isExplored(STATE, asPlayerId(0), asTileIndex(tile))) {
        expect(isExplored(next, asPlayerId(0), asTileIndex(tile))).toBe(true);
      }
    }
  });

  it('leaves revision, turn, rng and units to the command layer', () => {
    const next = withExplored(STATE, asPlayerId(0), tiles([FAR_TILE]));

    expect(next.revision).toBe(STATE.revision);
    expect(next.turn).toBe(STATE.turn);
    expect(next.rng).toBe(STATE.rng);
    expect(next.units).toBe(STATE.units);
    expect(next.players).toBe(STATE.players);
    expect(next.schemaVersion).toBe(STATE.schemaVersion);
  });

  it('is deterministic', () => {
    const request = tiles([FAR_TILE, 34, 0]);
    const first = withExplored(STATE, asPlayerId(0), request).explored[0];

    expect(withExplored(STATE, asPlayerId(0), request).explored[0]).toEqual(first);
    expect(first).toEqual(rowOf([...ball(P0_START, 2), FAR_TILE, 34, 0]));
  });

  it('grows as a unit moves: what the unit sees becomes what the player knows', () => {
    const fresh = visibleTiles(MOVED, asPlayerId(0)).filter(
      (tile) => !isExplored(STATE, asPlayerId(0), tile),
    );
    expect(fresh.length).toBeGreaterThan(0);

    const next = withExplored(STATE, asPlayerId(0), visibleTiles(MOVED, asPlayerId(0)));

    for (const tile of fresh) expect(isExplored(next, asPlayerId(0), tile)).toBe(true);
    // The unit's own new tile is seen, hence remembered.
    expect(isExplored(next, asPlayerId(0), asTileIndex(27))).toBe(true);
  });
});

describe('fog in a generated game', () => {
  it("starts with each civilization's start marked explored exactly to the visibility radius", () => {
    const state = mustGame(4242);

    // One player per *civilization*: since M3 `players` also carries the
    // barbarian player, so "the starts of the civilizations" is `civPlayers`.
    expect(civPlayers(state)).toHaveLength(SETTINGS.civCount);

    for (const playerState of civPlayers(state)) {
      const wrong: number[] = [];
      for (let tile = 0; tile < state.map.width * state.map.height; tile += 1) {
        const expected = distance8(state.map, tile, playerState.startingTile) <= VISIBILITY_RADIUS;
        if (isExplored(state, playerState.id, asTileIndex(tile)) !== expected) wrong.push(tile);
      }
      expect(wrong).toEqual([]);
    }
  });

  it('starts with each settler seeing what its own start has explored, and no more', () => {
    const state = mustGame(4242);

    for (const playerState of civPlayers(state)) {
      const visible = visibleTiles(state, playerState.id);
      expect(visible.length).toBeGreaterThan(0);
      for (const tile of visible) {
        expect(isExplored(state, playerState.id, tile)).toBe(true);
      }
    }
  });

  it('starts the barbarian player blind: a player identity, not a civilization', () => {
    const state = mustGame(4242);
    const size = state.map.width * state.map.height;
    const barbarian = state.players.find((playerState) => playerState.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('newGame must append a barbarian player');

    // `players.length === civCount + 1` after M3, and the extra one is not a
    // civilization — which is exactly why every "how many civs" question above
    // asks `civPlayers` instead of counting this array.
    expect(state.players).toHaveLength(SETTINGS.civCount + 1);
    expect(civPlayers(state)).not.toContain(barbarian);

    // It owns no unit at setup, so it sees nothing and remembers nothing…
    expect(visibleTiles(state, barbarian.id)).toEqual([]);
    const seen: number[] = [];
    for (let tile = 0; tile < size; tile += 1) {
      if (isExplored(state, barbarian.id, asTileIndex(tile))) seen.push(tile);
    }
    expect(seen).toEqual([]);

    // …but its row exists and is map-sized, because `PlayerId` *is* the index
    // into `players` and `explored` is row-indexed by it (M3, "State shape").
    expect(state.explored[Number(barbarian.id)]).toHaveLength(size);
    expect(state.explored).toHaveLength(state.players.length);
  });

  it('shows a viewer more of the map after it moves and the sight is recorded', () => {
    const state = mustGame(4242);
    const settler = state.units[0];
    if (settler === undefined) throw new Error('expected a starting unit');
    const step = neighbors8(state.map, settler.tile)[0];
    if (step === undefined) throw new Error('expected a neighbour');

    const moved = withUnitOn(state, 0, Number(step));
    const fresh = visibleTiles(moved, settler.owner).filter(
      (tile) => !isExplored(state, settler.owner, tile),
    );
    expect(fresh.length).toBeGreaterThan(0);

    const before = describeState(state, RULESET, { viewer: settler.owner });
    const after = describeState(
      withExplored(state, settler.owner, visibleTiles(moved, settler.owner)),
      RULESET,
      { viewer: settler.owner },
    );

    // Fog shrinks by exactly the tiles the unit newly sees — no more, no less.
    expect(fogCount(after)).toBe(fogCount(before) - fresh.length);
    expect(fogCount(before)).toBeGreaterThan(0);
  });
});

describe('describe with a viewer and fog', () => {
  /** Player 0 knows tiles 4, 5, 6 and 9; player 1 knows nothing yet. */
  const FOGGED: GameState = { ...STATE, explored: [rowOf([4, 5, 6, 9]), rowOf([])] };

  it('renders ? for every unexplored tile, and never the terrain under it', () => {
    const god = describeState(FOGGED, RULESET);
    const seen = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });

    expect(god).toContain('legend: ~ ocean');
    expect(seen).toContain('viewer=0');
    expect(fogCount(seen)).toBe(SIZE - 4);
    expect(fogCount(god)).toBe(0);
    // God mode is not merely different: it is the map the viewer cannot see.
    expect(god).not.toBe(seen);
  });

  it('renders identical bytes when only unexplored terrain differs', () => {
    const swapped: GameState = {
      ...FOGGED,
      map: {
        ...FOGGED.map,
        terrain: Array.from({ length: SIZE }, (_, tile) =>
          asTerrainId([4, 5, 6, 9].includes(tile) ? 'grassland' : 'mountains'),
        ),
      },
    };

    expect(describeState(swapped, RULESET, { viewer: asPlayerId(0) })).toBe(
      describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }),
    );
    expect(describeState(swapped, RULESET)).not.toBe(describeState(FOGGED, RULESET));
  });

  it('renders identical bytes when only an unexplored start position differs', () => {
    const moved: GameState = {
      ...FOGGED,
      players: [player(0, P0_START), player(1, P1_START + 1)],
    };

    expect(describeState(moved, RULESET, { viewer: asPlayerId(0) })).toBe(
      describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }),
    );
    expect(describeState(moved, RULESET)).not.toBe(describeState(FOGGED, RULESET));
  });

  it('answers fog questions about a ruleset with an empty unit catalog', () => {
    // `units` is a required field of `RulesetView` (INTERFACES.md M2, the
    // post-review amendment), so "no catalog at all" is no longer a shape a view
    // can have. An *empty* catalog is how a view says it has no units, and it
    // preserves the claim being made here exactly: fog and `describe` read the
    // state, never the catalog.
    const terrainOnly: RulesetView = { terrains: TERRAINS, units: [], fidelity: 'tuned' };
    // `describe` never needs a unit catalog: fog comes from the state.
    expect(describeState(STATE, terrainOnly, { viewer: asPlayerId(0) })).toBe(
      describeState(STATE, RULESET, { viewer: asPlayerId(0) }),
    );
  });
});
