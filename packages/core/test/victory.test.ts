/**
 * The victory rule's domination **numerator** — which tiles the land share counts.
 *
 * ## Why this file exists
 *
 * `dominationWinner` divides an owned count by `landTileCount(state.map, ruleset)` — the map's
 * land. The denominator has always been land. The numerator had not: it counted every tile the
 * player's cities claim, and a claim is a **geometric disc** (`computeTileOwner` has no terrain
 * filter), so a coastal city claims its bay. Every document states the rule as a share of the
 * map's land, so the numerator and the denominator were counting two different kinds of thing:
 * a player could hold a third of the world's ground and reach the threshold on the strength of
 * the sea inside its borders.
 *
 * The measurement that settled it (`scripts/probes/land-numerator-probe.ts`, re-runnable):
 * water inside a border is not a corner case — on eight AI-played `tiny` games at 200 turns,
 * **713 of 1,793 owned tiles (40 %) were water**, and the all-tiles share of the map's land was
 * up to 1.5× the land-only one. What did *not* move on that measurement was any outcome: the
 * tournaments at 100/150/200 turns, the six goldens and the scenario numbers are identical with
 * and without the filter, because a domination share that reaches 60 % has never been reached
 * by any policy this engine ships. So the filter costs nothing observable and makes the
 * numerator the same *kind* of quantity as the denominator.
 *
 * ## What this file pins
 *
 * A board built to make the two readings disagree, and the rule's answer on it:
 *
 * - the claim is **5 tiles, 2 land and 3 water** (asserted through both counts, so the fixture
 *   cannot drift into one where the question is moot);
 * - the all-tiles numerator *would* satisfy the shipped 60 % threshold (**5 of 5 land tiles**)
 *   while the land numerator does not (**2 of 5**), asserted as arithmetic, so the two
 *   inequalities are visible rather than implied;
 * - `gameOutcomeOf` therefore returns **null** — the rule does not count the water — and the
 *   control board below (the same claim with the sea filled in and the same 5-tile land
 *   denominator) returns **domination**, which is what makes the null a reading of the
 *   numerator rather than of a condition that cannot fire here at all.
 *
 * **This test fails if the numerator goes back to counting water**: that is the mutation it
 * names, and it was run — with `ownedLandTiles` replaced by `ownedLandCount` the second
 * assertion below comes back as `{condition: 'domination', winner: 0}` instead of `null`.
 *
 * The board is hand-built rather than generated, because the property is about *which tiles
 * are counted* and a generated map makes the land/water composition of a claim a matter of
 * luck. The thresholds are the **shipped** catalog's, read from it rather than restated: this
 * file patches nothing.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG, validateRuleset } from '@civts/rules';

import { ownedLandCount, ownedLandTiles, withOwnership } from '../src/borders.js';
import {
  asCityId,
  asGovernmentId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
} from '../src/ids.js';
import { landTileCount, isLandAt, tileIndex, type RulesetView } from '../src/map.js';
import { seedRng } from '../src/rng.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import { gameOutcomeOf } from '../src/victory.js';
import { victoryRulesOf } from '../src/victory-rules.js';
import type { City } from '../src/cities.js';
import type { TerrainId } from '../src/ids.js';
import type { Unit } from '../src/units.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
/** The shipped content, unpatched: the thresholds this rule is judged against are its own. */
const RULESET: RulesetView = validated.value;

const WIDTH = 7;
const HEIGHT = 7;
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const at = (x: number, y: number): number => tileIndex(WIDTH, x, y);

/**
 * The map, as a role per tile: a two-tile island the city sits on, one ocean bay inside its
 * radius-1 claim, and three far-away land tiles that exist only to be the denominator.
 *
 * The claim (radius 1 around `(1,1)`, culture 0) is exactly `(1,0) (0,1) (1,1) (2,1) (1,2)`:
 * **2 land, 3 water**.
 */
const ISLAND: readonly string[] = [
  // y = 0
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  // y = 1
  'ocean',
  'grassland',
  'grassland',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  // y = 2
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  // y = 3
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  // y = 4
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  // y = 5
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'grassland',
  'grassland',
  // y = 6
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'ocean',
  'grassland',
  'ocean',
];

/**
 * The control: the **same five claimed tiles, all land**, and the same five land tiles in the
 * denominator — the bay inside the claim is filled in and three far-away tiles become ocean, so
 * only the numerator's composition changes. Everything else about the board (the city, the
 * rival's unit, the population, the turn) is identical, so a difference in the verdict is a
 * difference the numerator made.
 */
const FILLED: readonly string[] = ISLAND.map((role, index) => {
  if (index === at(1, 0) || index === at(0, 1) || index === at(1, 2)) return 'grassland';
  if (index === at(5, 5) || index === at(6, 5) || index === at(5, 6)) return 'ocean';
  return role;
});

/**
 * Four tiles of terrain for `isLandAt`'s edge test, in role order: **both** water roles, then
 * land, then a land role that is also impassable. Mountains are the interesting one — a terrain's
 * `impassable` flag cannot answer "is this ground land?", because mountains are impassable *and*
 * land — so the predicate is checked against roles rather than against flags.
 */
const MAP_TERRAIN: readonly TerrainId[] = [
  asTerrainId('ocean'),
  asTerrainId('coast'),
  asTerrainId('grassland'),
  asTerrainId('mountains'),
];

const player = (index: number, kind: 'civ' | 'barbarian' = 'civ'): PlayerState => ({
  id: asPlayerId(index),
  name: kind === 'barbarian' ? 'Barbarians' : `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(at(1, 1)),
  kind,
  treasury: kind === 'barbarian' ? 0 : STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  techs: [],
  government: asGovernmentId('despotism'),
});

const PLAYERS: readonly PlayerState[] = [player(0), player(1), player(2, 'barbarian')];

/** One city of player 0 on the island, culture 0 — so its claim is the radius-1 ring. */
const CITY: City = {
  id: asCityId(0),
  owner: asPlayerId(0),
  name: 'Island',
  tile: asTileIndex(at(1, 1)),
  population: 1,
  foodBox: 0,
  shields: 0,
  queue: [],
  buildings: [],
  workedTiles: [],
  culture: 0,
};

/**
 * One unit of player 1, standing on the far shore.
 *
 * It is not decoration: conquest ends the game when every *other* civilization is off the
 * board, and "off the board" is `isInPlay` — a city or a unit. Without it, player 0's lone city
 * would make it the last civilization standing and the outcome below would be `conquest`,
 * which is a different condition answering a different question. With it, the only condition
 * that can fire on this board is the one under test.
 */
const RIVAL_UNIT: Unit = {
  id: asUnitId(0),
  type: asUnitTypeId('warrior'),
  owner: asPlayerId(1),
  tile: asTileIndex(at(5, 5)),
  movementLeft: 1,
};

/** The board, with the ownership layer written by the engine's own writer. */
const board = (grid: readonly string[]): GameState =>
  withOwnership(
    {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      turn: 1,
      seed: 7,
      settings: SETTINGS,
      rng: seedRng(7),
      map: {
        width: WIDTH,
        height: HEIGHT,
        terrain: grid.map((role) => asTerrainId(role)),
        huts: [],
        resources: [],
      },
      players: PLAYERS,
      nextUnitId: 1,
      units: [RIVAL_UNIT],
      explored: PLAYERS.map(() => new Array<boolean>(WIDTH * HEIGHT).fill(false)),
      nextCityId: 1,
      tileOwner: [],
      cities: [CITY],
      improvements: [],
    },
    RULESET,
  );

describe('the domination land share counts LAND, not every claimed tile', () => {
  it('is measured against the map’s land, and counts the same kind of tile in the numerator', () => {
    const state = board(ISLAND);
    const rules = victoryRulesOf(RULESET);
    const land = landTileCount(state.map, RULESET);

    // The two readings, on the same board: the claim is a geometric disc that includes the bay,
    // so the all-tiles count is larger than the land count. Both numbers are pinned, because the
    // test below is only meaningful while they differ.
    const claimed = ownedLandCount(state, asPlayerId(0));
    const claimedLand = ownedLandTiles(state, RULESET, asPlayerId(0));
    expect(claimed).toBe(5);
    expect(claimedLand).toBe(2);
    expect(claimed).toBeGreaterThan(claimedLand);

    // The denominator, and the two inequalities spelled out rather than left to the rule: the
    // water-inclusive numerator satisfies the shipped threshold and the land numerator does not.
    expect(land).toBe(5);
    expect(claimed * 100).toBeGreaterThanOrEqual(rules.dominationLandPct * land);
    expect(claimedLand * 100).toBeLessThan(rules.dominationLandPct * land);

    // The population half holds either way — one citizen is the whole world's population — so
    // the verdict below is decided by the land half alone.
    expect(rules.dominationPopPct).toBeLessThanOrEqual(100);

    // **The rule's answer**: not domination. Counting the bay would have ended the game here.
    expect(gameOutcomeOf(state, RULESET)).toBeNull();
  });

  it('fires on the control board, where the same claim is entirely land', () => {
    // Non-vacuity: the null above is a reading of the numerator, not of a board on which no
    // condition can fire. Same city, same rival unit, same population, same turn, and the same
    // five land tiles in the denominator — only the three claimed water tiles became land.
    const filled = board(FILLED);
    const claimed = ownedLandCount(filled, asPlayerId(0));
    const claimedLand = ownedLandTiles(filled, RULESET, asPlayerId(0));

    expect(claimed).toBe(5);
    expect(claimedLand).toBe(5);
    expect(landTileCount(filled.map, RULESET)).toBe(5);

    expect(gameOutcomeOf(filled, RULESET)).toStrictEqual({
      condition: 'domination',
      winner: asPlayerId(0),
    });
  });
});

/**
 * **The one statement of "is this ground land?"** (S2's refactor; Q3's F5, R2's R2-F3).
 *
 * `borders.ts` used to carry a private `isLandAt` that re-derived `map.ts`' `landTileCount`'s
 * inline rule — three lines, in a file whose own doc comment named `landTileCount` as the source
 * of truth. The copy is deleted and both readers now call the exported predicate, so this suite
 * pins the predicate's *edges*: what a missing terrain means, and what a tile the map does not
 * have means.
 *
 * Both answers have a reader that depends on them. The domination numerator walks
 * `state.tileOwner`, and a hand-built state's layer may be longer than its map's terrain — an
 * out-of-range index must be "not land" rather than a throw, because `ownedLandTiles` is total by
 * contract. And a terrain the ruleset does not describe is not land, in the numerator and in the
 * denominator alike: calling it land would inflate a share with ground nobody can describe.
 */
describe('isLandAt — the one land predicate, at its edges', () => {
  it('agrees with landTileCount, and answers "not land" past the terrain the map has', () => {
    // A map that *claims* seven columns but carries terrain for four tiles: the shape a
    // hand-built state or an edited save can have, and the only one where the two readers can
    // disagree about an index.
    const map = { width: 7, height: 1, terrain: MAP_TERRAIN, huts: [], resources: [] };

    expect(MAP_TERRAIN).toHaveLength(4);
    expect(map.width * map.height).toBe(7);

    // Every index the map has terrain for: land exactly where the role is not water.
    expect(isLandAt(map, RULESET, 0)).toBe(false); // ocean
    expect(isLandAt(map, RULESET, 1)).toBe(false); // coast, the second water role
    expect(isLandAt(map, RULESET, 2)).toBe(true); // grassland
    expect(isLandAt(map, RULESET, 3)).toBe(true); // mountains: impassable, and LAND

    // Past the terrain: not land, and not a throw.
    expect(isLandAt(map, RULESET, 4)).toBe(false);
    expect(isLandAt(map, RULESET, 9999)).toBe(false);
    expect(isLandAt(map, RULESET, -1)).toBe(false);

    // The count is the predicate applied to every tile the map has — the arithmetic
    // `landTileCount` performs, restated here so the two can never drift apart silently.
    expect(landTileCount(map, RULESET)).toBe(
      MAP_TERRAIN.filter((_, index) => isLandAt(map, RULESET, index)).length,
    );
    expect(landTileCount(map, RULESET)).toBe(2);
  });

  it('counts a terrain the ruleset does not describe as not land, in both readers', () => {
    // A content pack's row is not in this ruleset: the map and the ruleset disagree about the
    // tile, and both readers answer the same way — not land — rather than one of them guessing.
    const map = {
      width: 2,
      height: 1,
      terrain: [
        asTerrainId('terrain-that-does-not-exist'),
        // The shipped catalog's first row is grassland, so the second tile is described and
        // land: the count below is 1, and it is 1 because of *this* tile, not the unknown one.
        RULESET.terrains[0]?.id ?? asTerrainId(''),
      ],
      huts: [],
      resources: [],
    };

    expect(isLandAt(map, RULESET, 0)).toBe(false);
    expect(isLandAt(map, RULESET, 1)).toBe(true);
    expect(landTileCount(map, RULESET)).toBe(1);
  });
});
