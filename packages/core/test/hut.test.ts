/**
 * `hut.ts` — goody huts (docs/INTERFACES.md M3, "Goody huts").
 *
 * The board is hand-built for the same reason `commands.test.ts`' board is: every
 * assertion reads as "on this map, this hut gives this answer", with the terrain,
 * the adjacent tiles and the units visible at the top of the file. Tile indices
 * are `y * 4 + x` on a 4x4 grid whose centre (`5`) is the hut.
 *
 * What is pinned here:
 *
 * - the reward table and the fact that it is drawn **only** from `state.rng`, so
 *   two runs of the same state agree (`HUT_REWARD_KINDS`, `nextBelow`);
 * - each of the three branches, on an RNG state chosen for it: a free unit, a band
 *   of barbarians near the hut, nothing;
 * - the three cases the contract excludes: a sea unit, a unit whose type the
 *   ruleset does not describe, and a city on the hut tile;
 * - the degenerate cases that make the rule total: a ruleset with no military land
 *   unit to give away, and a hut with nowhere for a band to stand;
 * - purity (the input state is never touched), one `revision`-neutral transition,
 *   and that the state it returns is plain JSON that canonicalizes — the
 *   "never write a key whose value is `undefined`" rule, which a `unitGiven: undefined`
 *   would break;
 * - the numbers are **placeholders** and the module says so: `HUT_REWARD_PROVENANCE`
 *   is asserted to be a `placeholder` whose note calls the values unsourced and
 *   names `gold` as the M3 reward that is deliberately missing.
 */

import { describe, expect, it } from 'vitest';
import { CATALOG, validateRuleset } from '@civts/rules';
import { canonicalize, hashValue } from '@civts/testing';
import type { City } from '../src/cities.js';
import {
  BARBARIAN_BAND_SIZE,
  HUT_REWARD_KINDS,
  HUT_REWARD_PROVENANCE,
  hutAt,
  resolveHutEntry,
  type HutRewardKind,
} from '../src/hut.js';
import {
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type UnitId,
  type UnitTypeId,
} from '../src/ids.js';
import type { RulesetView, TerrainDef, TerrainRole } from '../src/map.js';
import { isPlaceholder } from '../src/provenance.js';
import { nextBelow, seedRng, type RngState } from '../src/rng.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  civPlayers,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import { unitDef, type Unit, type UnitDef, type UnitRole } from '../src/units.js';

const WIDTH = 4;
const HEIGHT = 4;

/** The hut everything below enters, and the tile the entering unit stands on. */
const HUT_TILE = 5;

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

/**
 * A board with one corner of water (tile 0) and one range of mountains (tile 3),
 * so the hut at 5 has seven standable neighbours (1, 2, 4, 6, 8, 9, 10) and two
 * tiles a band can never use. Land everywhere else keeps the interesting cases —
 * an occupied neighbour, a blocked band — a matter of units rather than terrain.
 */
const GRID: readonly TerrainRole[] = [
  'ocean',
  'grassland',
  'grassland',
  'mountains',
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
  'grassland',
];

const unitDefOf = (
  id: string,
  role: UnitRole,
  domain: 'land' | 'sea',
  movement: number,
): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  attack: 0,
  defense: 0,
  movement,
  cost: 1,
  domain,
});

const SETTLER = unitDefOf('settler', 'settler', 'land', 2);
const WARRIOR = unitDefOf('warrior', 'military', 'land', 2);
const GALLEY = unitDefOf('galley', 'military', 'sea', 3);

/**
 * The REWARD rule is canonical, not positional (see the describe block at the foot of
 * this file): the cheapest `military` **land** row, ties broken by id. In this fixture
 * the warrior is the only military land row, so it is the reward whatever position the
 * rows hold.
 *
 * No improvements: a hut reward has nothing to do with a worker's job (M4a), and
 * an empty catalog is how a view says so — `RulesetView.improvements` is required,
 * so the field is stated rather than left out.
 */
const RULESET: RulesetView = {
  terrains: TERRAINS,
  units: [SETTLER, WARRIOR, GALLEY],
  improvements: [],
  fidelity: 'tuned',
};

/**
 * The same view without any military land unit: a hut has nothing to pay out with,
 * which is the case that makes "a reward the ruleset cannot supply" total rather
 * than a crash or an invented unit type.
 */
const NO_REWARD_UNITS: RulesetView = { ...RULESET, units: [SETTLER, GALLEY] };

const SETTINGS = { ...DEFAULT_SETTINGS, mapSize: 'duel' as const, civCount: 2 };

const civ = (id: number, tile: number): PlayerState => ({
  id: asPlayerId(id),
  name: `Player ${String(id + 1)}`,
  color: '#123456',
  startingTile: asTileIndex(tile),
  kind: 'civ',
  // M4b: every player carries the money fields, so a hand-built player literal
  // must too. The engine's own constants are used rather than copied literals.
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: knowledge is required on every player row, and a hand-built literal says
  // "knows nothing" with an empty array rather than by leaving the key out.
  techs: [],
});

/** The player a hut's band belongs to: a player identity with no homeland. */
const BARBARIANS: PlayerState = {
  id: asPlayerId(2),
  name: 'Barbarians',
  color: '#654321',
  // M3's convention: the map's first hut, not a real start.
  startingTile: asTileIndex(HUT_TILE),
  kind: 'barbarian',
  // M4b: barbarians have no economy at all — 0 gold, and pools nothing ever
  // adds to — but the fields are present because `PlayerState` has one shape for
  // every player (the same reading `explored` takes).
  treasury: 0,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: one shape for every row of `players`, so barbarians carry a techs list too —
  // empty, and it stays empty, because the research step skips them exactly as the
  // money loop does.
  techs: [],
};

const unit = (id: number, type: UnitTypeId, owner: number, tile: number): Unit => ({
  id: asUnitId(id),
  type,
  owner: asPlayerId(owner),
  tile: asTileIndex(tile),
  movementLeft: unitDef(RULESET, type)?.movement ?? 0,
});

/** A civilization's settler standing **on** the hut — the post-move state. */
const settlerOnHut = (): Unit => unit(0, SETTLER.id, 0, HUT_TILE);

interface BoardOptions {
  readonly rng?: RngState;
  readonly huts?: readonly number[];
  readonly units?: readonly Unit[];
  readonly cities?: readonly City[];
  readonly players?: readonly PlayerState[];
}

const board = (options: BoardOptions = {}): GameState => {
  const players = options.players ?? [civ(0, 1), civ(1, 14), BARBARIANS];
  const units = options.units ?? [settlerOnHut()];
  const huts = options.huts ?? [HUT_TILE];

  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 3,
    turn: 5,
    seed: 1,
    settings: SETTINGS,
    rng: options.rng ?? seedRng(0),
    map: {
      width: WIDTH,
      height: HEIGHT,
      terrain: GRID.map((role) => asTerrainId(role)),
      huts: huts.map((tile) => asTileIndex(tile)),
      // M4c: the map also carries the resources `generateWorld` placed, as sparse
      // `(tile, resource)` pairs. Empty here: a hut's reward is drawn from the
      // state RNG and reads no map field, so a resource on this board could only
      // be a hidden reason a reward changed. Present and empty, never absent —
      // the key is hashed with the state.
      resources: [],
    },
    players,
    nextUnitId: units.reduce((next, candidate) => Math.max(next, Number(candidate.id) + 1), 0),
    units,
    explored: players.map(() => GRID.map(() => false)),
    nextCityId: 0,
    cities: options.cities ?? [],
    // M4a: nothing is built on this hand-built board. The key is present and
    // *empty* — an absent key would make a state that predates M4a, which
    // `improvements.ts` tolerates but which is not the shape `newGame` writes.
    improvements: [],
  };
};

/**
 * An RNG state whose *first* hut draw selects `reward`, found by drawing from
 * `seedRng(0..59)` — a search, not a magic number, so the fixture states the rule
 * it depends on ("the reward is the first draw, mapped through the reward table")
 * instead of a constant that could quietly stop meaning it. The search is
 * deterministic: `seedRng` and `nextBelow` are pure.
 */
const rngFor = (reward: HutRewardKind): RngState => {
  for (let seed = 0; seed < 60; seed++) {
    const rng = seedRng(seed);
    const draw = nextBelow(rng, HUT_REWARD_KINDS.length);
    if ((HUT_REWARD_KINDS[draw[0]] ?? 'nothing') === reward) return rng;
  }
  throw new Error(`no seed in 0..59 draws ${reward}; the reward table changed`);
};

/** The RNG state one hut entry must leave behind: exactly one draw, always. */
const afterOneDraw = (rng: RngState): RngState => nextBelow(rng, HUT_REWARD_KINDS.length)[1];

/** The entered hut's outcome, or a loud failure — the tests below always find one. */
const mustResolve = (state: GameState, ruleset: RulesetView, unitId: UnitId) => {
  const outcome = resolveHutEntry(state, ruleset, unitId);
  if (outcome === undefined) throw new Error('expected the hut to resolve');
  return outcome;
};

/** The ids of the units a player owns, in state order. */
const idsOf = (state: GameState, owner: number): readonly number[] =>
  state.units.filter((candidate) => Number(candidate.owner) === owner).map((u) => Number(u.id));

describe('hut.ts — the reward table', () => {
  it('spends a hut on one of three rewards, and records that gold is out of scope', () => {
    // The order is behaviour, not cosmetics: draw `nextBelow(rng, 3)` and index
    // this. Pinned as one string so the table, its length and its order all move
    // together, and so a `gold` member appearing without a treasury (M4's job)
    // fails here rather than silently re-weighting every later draw.
    expect(HUT_REWARD_KINDS.join(',')).toBe('unit,barbarians,nothing');

    // The reward `{ kind: 'gold' }` is deliberately absent in M3 — there is no
    // treasury until M4 — and the provenance note says so rather than leaving the
    // reader to guess that it was forgotten.
    expect(isPlaceholder(HUT_REWARD_PROVENANCE)).toBe(true);
    if (!isPlaceholder(HUT_REWARD_PROVENANCE)) throw new Error('must be a placeholder');
    expect(HUT_REWARD_PROVENANCE.note).toContain('Unsourced placeholder, chosen to be playable');
    expect(HUT_REWARD_PROVENANCE.note).toContain('NOT traced to Civ 3');
    expect(HUT_REWARD_PROVENANCE.note).toContain('gold');
    expect(HUT_REWARD_PROVENANCE.note).toContain('M4');
  });

  it('finds a hut only on an integer tile that holds one', () => {
    const state = board({ huts: [5, 9] });

    expect(hutAt(state, 5)).toBe(true);
    expect(hutAt(state, 9)).toBe(true);
    expect(hutAt(state, 6)).toBe(false);
    // Total: off-map, negative, fractional and non-finite tiles have no hut.
    expect(hutAt(state, -1)).toBe(false);
    expect(hutAt(state, 16)).toBe(false);
    expect(hutAt(state, 5.5)).toBe(false);
    expect(hutAt(state, Number.NaN)).toBe(false);
  });
});

describe('hut.ts — the three rewards', () => {
  it('gives a free unit, beside the mover, on the draw that says unit', () => {
    const rng = rngFor('unit');
    const state = board({ rng });
    const outcome = mustResolve(state, RULESET, asUnitId(0));

    // One `HutEntered`, naming the free unit only in this branch.
    expect(outcome.events).toStrictEqual([
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: asPlayerId(0),
        tile: asTileIndex(5),
        reward: 'unit',
        unitGiven: asUnitId(1),
      },
    ]);

    // The hut is gone, the RNG advanced by exactly one draw, and `revision` and
    // `turn` are untouched: this is the move's transition, not a command of its own.
    expect(outcome.state.map.huts).toEqual([]);
    expect(outcome.state.rng).toStrictEqual(afterOneDraw(rng));
    expect(outcome.state.revision).toBe(state.revision);
    expect(outcome.state.turn).toBe(state.turn);

    // The reward unit is the cheapest military **land** row — here the warrior, the
    // only one — at full movement, standing on the hut tile with the mover: M2 lets a
    // player's own units stack.
    expect(outcome.state.units).toStrictEqual([
      {
        id: asUnitId(0),
        type: SETTLER.id,
        owner: asPlayerId(0),
        tile: asTileIndex(5),
        movementLeft: 2,
      },
      {
        id: asUnitId(1),
        type: WARRIOR.id,
        owner: asPlayerId(0),
        tile: asTileIndex(5),
        movementLeft: 2,
      },
    ]);
    expect(outcome.state.nextUnitId).toBe(2);

    // Pure: the input keeps its hut, its units and its RNG.
    expect(state.map.huts).toEqual([asTileIndex(5)]);
    expect(state.units).toHaveLength(1);
    expect(state.rng).toStrictEqual(rng);
  });

  it('spawns a band of barbarians beside the hut on the draw that says barbarians', () => {
    const rng = rngFor('barbarians');
    const state = board({ rng });
    const outcome = mustResolve(state, RULESET, asUnitId(0));

    // Two events: the hut was consumed, and the band arrived out of it. The ids
    // are the state's next free ones, in ascending tile order.
    expect(outcome.events).toStrictEqual([
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: asPlayerId(0),
        tile: asTileIndex(5),
        reward: 'barbarians',
      },
      {
        type: 'BarbariansSpawned',
        owner: BARBARIANS.id,
        tile: asTileIndex(5),
        unitIds: [asUnitId(1), asUnitId(2)],
        tiles: [asTileIndex(1), asTileIndex(2)],
      },
    ]);

    // The band belongs to the barbarian player and are ordinary `Unit`s: full
    // movement, a type the ruleset describes, and no special-casing anywhere.
    expect(BARBARIAN_BAND_SIZE).toBe(2);
    expect(idsOf(outcome.state, Number(BARBARIANS.id))).toEqual([1, 2]);
    expect(outcome.state.units.slice(1)).toStrictEqual([
      {
        id: asUnitId(1),
        type: WARRIOR.id,
        owner: BARBARIANS.id,
        tile: asTileIndex(1),
        movementLeft: 2,
      },
      {
        id: asUnitId(2),
        type: WARRIOR.id,
        owner: BARBARIANS.id,
        tile: asTileIndex(2),
        movementLeft: 2,
      },
    ]);

    // The mover is where it was, the hut is spent, and the draw is the only RNG use.
    expect(outcome.state.units[0]).toStrictEqual(settlerOnHut());
    expect(outcome.state.map.huts).toEqual([]);
    expect(outcome.state.rng).toStrictEqual(afterOneDraw(rng));
    expect(state.map.huts).toEqual([asTileIndex(5)]);
  });

  it('spends the hut and hands back nothing on the draw that says nothing', () => {
    const rng = rngFor('nothing');
    const state = board({ rng });
    const outcome = mustResolve(state, RULESET, asUnitId(0));

    // "Nothing" is a reward, not a non-event: the hut is gone, the draw happened,
    // and the event says so — a consumer never has to diff the map to find out.
    expect(outcome.events).toStrictEqual([
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: asPlayerId(0),
        tile: asTileIndex(5),
        reward: 'nothing',
      },
    ]);
    expect(outcome.state.map.huts).toEqual([]);
    expect(outcome.state.rng).toStrictEqual(afterOneDraw(rng));
    expect(outcome.state.units).toStrictEqual([settlerOnHut()]);

    // The absent option is *absent*, never an own `undefined` value: a key holding
    // `undefined` dies in a JSON round trip, so the canonical form would reject the
    // state and it could not be hashed. Asserted on the event and on the state.
    const event = outcome.events[0];
    expect(event === undefined ? [] : Object.keys(event)).not.toContain('unitGiven');
    expect(() => canonicalize(outcome.state)).not.toThrow();
    expect(JSON.parse(JSON.stringify(outcome.state))).toStrictEqual(outcome.state);
    expect(() => hashValue(outcome.state)).not.toThrow();
  });

  it('keeps the other huts, in ascending order', () => {
    const state = board({ huts: [5, 9, 13], rng: rngFor('nothing') });
    const outcome = mustResolve(state, RULESET, asUnitId(0));

    expect(outcome.state.map.huts).toEqual([asTileIndex(9), asTileIndex(13)]);
    expect(state.map.huts).toEqual([asTileIndex(5), asTileIndex(9), asTileIndex(13)]);
    // The map object is fresh, so a caller holding the old map is unaffected.
    expect(outcome.state.map).not.toBe(state.map);
  });

  it('derives the reward from the state RNG alone', () => {
    // Same state twice: equal state, equal events, equal hash — the whole point of
    // drawing from `state.rng` rather than from anything ambient.
    const state = board({ rng: rngFor('barbarians') });
    const first = mustResolve(state, RULESET, asUnitId(0));
    const second = mustResolve(state, RULESET, asUnitId(0));

    expect(second.state).toStrictEqual(first.state);
    expect(second.events).toStrictEqual(first.events);
    expect(hashValue(second.state)).toBe(hashValue(first.state));

    // And the branch is the draw, for every branch: a different RNG state is a
    // different reward, with no other input changed.
    for (const reward of HUT_REWARD_KINDS) {
      const outcome = mustResolve(board({ rng: rngFor(reward) }), RULESET, asUnitId(0));
      const event = outcome.events[0];
      expect(event?.type === 'HutEntered' ? event.reward : undefined).toBe(reward);
      expect(outcome.state.rng).toStrictEqual(afterOneDraw(rngFor(reward)));
    }
  });
});

describe('hut.ts — what never triggers', () => {
  it('ignores a tile with no hut, and a unit that does not exist', () => {
    const state = board({ huts: [], rng: rngFor('unit') });

    expect(resolveHutEntry(state, RULESET, asUnitId(0))).toBeUndefined();
    expect(resolveHutEntry(state, RULESET, asUnitId(9))).toBeUndefined();
    // Untouched: no consumption, no draw, nothing.
    expect(state.rng).toStrictEqual(rngFor('unit'));
    expect(state.units).toHaveLength(1);
  });

  it('never triggers for a sea unit, whatever the draw would have been', () => {
    // Every branch, so the exclusion is not just "this seed happened to draw
    // nothing": a galley on a hut tile is still a galley.
    for (const reward of HUT_REWARD_KINDS) {
      const state = board({ rng: rngFor(reward), units: [unit(0, GALLEY.id, 0, HUT_TILE)] });
      expect(resolveHutEntry(state, RULESET, asUnitId(0))).toBeUndefined();
      expect(state.map.huts).toEqual([asTileIndex(5)]);
      expect(state.rng).toStrictEqual(rngFor(reward));
    }
  });

  it('never triggers for a unit type the ruleset does not describe', () => {
    const state = board({
      rng: rngFor('unit'),
      units: [unit(0, asUnitTypeId('ghost'), 0, HUT_TILE)],
    });

    expect(resolveHutEntry(state, RULESET, asUnitId(0))).toBeUndefined();
    expect(state.map.huts).toEqual([asTileIndex(5)]);
  });

  it('never triggers under a city', () => {
    const capital: City = {
      id: asCityId(0),
      owner: asPlayerId(0),
      name: 'Capital',
      tile: asTileIndex(HUT_TILE),
      population: 1,
      foodBox: 0,
      shields: 0,
      queue: [],
      buildings: [],
      workedTiles: [],
    };
    const state = board({ rng: rngFor('barbarians'), cities: [capital] });

    expect(resolveHutEntry(state, RULESET, asUnitId(0))).toBeUndefined();
    // The hut stays on the map: no unit ever enters that tile again, so nothing
    // consumes it — a city that swallowed its tile's hut would be a silent edit to
    // map data the reader can still see.
    expect(state.map.huts).toEqual([asTileIndex(5)]);
    expect(state.rng).toStrictEqual(rngFor('barbarians'));
  });
});

describe('hut.ts — totality', () => {
  it('consumes the hut and reports nothing when the ruleset has no reward unit', () => {
    for (const reward of HUT_REWARD_KINDS) {
      const rng = rngFor(reward);
      const state = board({ rng });
      const outcome = mustResolve(state, NO_REWARD_UNITS, asUnitId(0));

      // No `military` land row to give away and none to arm a band with, so both
      // spawning branches report what the player actually got. The event reports
      // the *outcome*, never the branch the draw selected.
      expect(outcome.events).toStrictEqual([
        {
          type: 'HutEntered',
          unitId: asUnitId(0),
          owner: asPlayerId(0),
          tile: asTileIndex(5),
          reward: 'nothing',
        },
      ]);
      expect(outcome.state.units).toStrictEqual([settlerOnHut()]);
      expect(outcome.state.map.huts).toEqual([]);
      expect(outcome.state.rng).toStrictEqual(afterOneDraw(rng));
    }
  });

  it('consumes the hut and reports nothing when there is no barbarian player', () => {
    const rng = rngFor('barbarians');
    const state = board({ rng, players: [civ(0, 1), civ(1, 14)], huts: [HUT_TILE] });
    const outcome = mustResolve(state, RULESET, asUnitId(0));

    expect(civPlayers(state)).toHaveLength(2);
    expect(outcome.events).toStrictEqual([
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: asPlayerId(0),
        tile: asTileIndex(5),
        reward: 'nothing',
      },
    ]);
    expect(outcome.state.units).toStrictEqual([settlerOnHut()]);
    expect(outcome.state.map.huts).toEqual([]);
  });

  it('caps the band at the tiles it may stand on, and gives nothing when there are none', () => {
    // One free neighbour (tile 2): the band is one unit, not two.
    const blockers = [1, 4, 6, 8, 9, 10].map((tile, index) => unit(index + 1, WARRIOR.id, 1, tile));
    const crowded = board({ rng: rngFor('barbarians'), units: [settlerOnHut(), ...blockers] });
    const one = mustResolve(crowded, RULESET, asUnitId(0));
    const spawn = one.events[1];

    expect(spawn?.type === 'BarbariansSpawned' ? spawn.tiles : undefined).toEqual([asTileIndex(2)]);
    expect(idsOf(one.state, Number(BARBARIANS.id))).toHaveLength(1);

    // No neighbour at all — an enemy is on every standable tile — so the hut is
    // spent and the player gets nothing, rather than a band stacked on an enemy.
    const walled = board({
      rng: rngFor('barbarians'),
      units: [settlerOnHut(), ...blockers, unit(7, WARRIOR.id, 1, 2)],
    });
    const none = mustResolve(walled, RULESET, asUnitId(0));

    expect(none.events.map((event) => event.type)).toEqual(['HutEntered']);
    expect(none.state.units).toHaveLength(walled.units.length);
    expect(none.state.map.huts).toEqual([]);
  });

  it('treats the barbarian player as an ordinary owner, so a band may stack with itself', () => {
    // A barbarian already standing next to the hut does not block the band: M2
    // allows a player's own units to stack, and the barbarians are one player.
    const existing = unit(1, WARRIOR.id, Number(BARBARIANS.id), 1);
    const state = board({ rng: rngFor('barbarians'), units: [settlerOnHut(), existing] });
    const outcome = mustResolve(state, RULESET, asUnitId(0));

    expect(idsOf(outcome.state, Number(BARBARIANS.id))).toEqual([1, 2, 3]);
    const spawn = outcome.events[1];
    expect(spawn?.type === 'BarbariansSpawned' ? spawn.tiles : undefined).toEqual([1, 2]);
    // The band's units are the type a move could pick up: nothing marks them out.
    const band = outcome.state.units.filter((candidate) => Number(candidate.owner) === 2);
    for (const member of band) expect(unitDef(RULESET, member.type)?.name).toBe('Warrior');
  });
});

/**
 * **Which unit a hut pays is a function of the ruleset's content, never of where a row
 * sits in the catalog.**
 *
 * The rule used to be "the first `military` land row", so a catalog with the very same
 * rows in a different order paid a different unit for the same hut on the same seed —
 * a semantic change no reader could predict from the content, and one no test of the
 * content would have reported. It is now "the cheapest `military` land row, ties broken
 * by id": both keys are fields of the rows themselves, so reordering, appending or
 * shuffling a catalog cannot move the answer. (Differing row order is still a different
 * *ruleset* — its hash covers row order, pinned in `gen.test.ts` — so this is about a
 * difference a reviewer can see in the content, not about identity.)
 *
 * There are two claims here and the shipped catalog is the reason for both:
 *
 * - on the catalog this project ships the pick is the **warrior**, the same unit the old
 *   positional rule selected, so the change is behaviour-preserving on shipped content;
 * - the old rule would have answered **swordsman** on the reversed catalog, which is
 *   asserted below rather than asserted away — that is what "behaviour-preserving" means
 *   when it is a measurement instead of a hope.
 */
describe('hut.ts — the reward unit is a canonical pick, not a row position', () => {
  /** A military land row with a chosen price: the two keys of the canonical rule. */
  const row = (id: string, cost: number, spec: readonly [UnitRole, 'land' | 'sea']): UnitDef => ({
    ...unitDefOf(id, spec[0], spec[1], 2),
    cost,
  });

  /**
   * The view with its military rows replaced. The settler stays in the catalog: the
   * mover is a settler, and a ruleset that does not describe the moving unit's type
   * never triggers a hut at all — which would make every test below vacuous.
   */
  const viewWithUnits = (units: readonly UnitDef[]): RulesetView => ({
    ...RULESET,
    units: [SETTLER, ...units],
  });

  /** The type of the free unit a `unit`-reward entry handed out, read off the state. */
  const freeUnitType = (ruleset: RulesetView): string => {
    const outcome = mustResolve(board({ rng: rngFor('unit') }), ruleset, asUnitId(0));
    const spawned = outcome.state.units.find((candidate) => Number(candidate.id) !== 0);
    if (spawned === undefined) throw new Error('the unit branch spawned nothing');
    return String(spawned.type);
  };

  /** The first `military` land row in catalog order: the rule this one replaced. */
  const firstRowWouldBe = (ruleset: RulesetView): string | undefined => {
    const def = ruleset.units.find(
      (candidate) => candidate.role === 'military' && candidate.domain === 'land',
    );
    return def === undefined ? undefined : String(def.id);
  };

  it('picks the cheapest military land row, wherever the rows sit', () => {
    // Three military rows, two of them land: the sea one is cheaper than both, so the
    // `domain` half of the rule is exercised rather than merely stated.
    const rows: readonly UnitDef[] = [
      row('warrior', 2, ['military', 'land']),
      row('swordsman', 3, ['military', 'land']),
      row('galley', 1, ['military', 'sea']),
    ];
    const orders: readonly (readonly UnitDef[])[] = [
      rows,
      [...rows].reverse(),
      // The same content in a third order, written out rather than indexed: a
      // `rows[i]` read would be `UnitDef | undefined` for no reason.
      [
        row('galley', 1, ['military', 'sea']),
        row('warrior', 2, ['military', 'land']),
        row('swordsman', 3, ['military', 'land']),
      ],
    ];

    for (const units of orders) {
      expect(freeUnitType(viewWithUnits(units))).toBe('warrior');
    }

    // Non-vacuity: the orders really differ, and the positional rule this replaced
    // would have disagreed with the canonical one on the reversed order.
    expect(orders[0]?.map((def) => String(def.id))).toEqual(['warrior', 'swordsman', 'galley']);
    expect(orders[1]?.map((def) => String(def.id))).toEqual(['galley', 'swordsman', 'warrior']);
    expect(firstRowWouldBe(viewWithUnits(rows))).toBe('warrior');
    expect(firstRowWouldBe(viewWithUnits([...rows].reverse()))).toBe('swordsman');
  });

  it('breaks a price tie by id, not by position', () => {
    // Two land rows at one price. The lower id wins in both orders: without the
    // tie-break the answer would be the row that came first, which is the defect this
    // rule exists to remove.
    const zeta = row('zeta', 4, ['military', 'land']);
    const alpha = row('alpha', 4, ['military', 'land']);

    expect(freeUnitType(viewWithUnits([zeta, alpha]))).toBe('alpha');
    expect(freeUnitType(viewWithUnits([alpha, zeta]))).toBe('alpha');
    // ...and the tie really is a tie, so the assertion above is about the tie-break.
    expect(zeta.cost).toBe(alpha.cost);
    expect(String(zeta.id) > String(alpha.id)).toBe(true);
  });

  it('arms the barbarian band with the same canonical row', () => {
    // One rule, two branches: a band of a different type than the free unit would be
    // two rules that could drift apart.
    const rows: readonly UnitDef[] = [
      row('galley', 1, ['military', 'sea']),
      row('swordsman', 3, ['military', 'land']),
      row('warrior', 2, ['military', 'land']),
    ];
    const outcome = mustResolve(
      board({ rng: rngFor('barbarians') }),
      viewWithUnits(rows),
      asUnitId(0),
    );
    const band = outcome.state.units.filter((candidate) => candidate.id !== asUnitId(0));

    expect(band).toHaveLength(BARBARIAN_BAND_SIZE);
    for (const member of band) expect(String(member.type)).toBe('warrior');
    expect(freeUnitType(viewWithUnits(rows))).toBe('warrior');
  });

  it('picks the warrior on the SHIPPED catalog, in both row orders', () => {
    // The measurement the change rests on, taken from real content rather than from a
    // fixture: `warrior@1`, `swordsman@3`, and the galley at 2 excluded by `domain` —
    // so the canonical rule agrees with the old positional one on shipped content, and
    // the two disagree the moment the rows are reversed.
    const shipped = validateRuleset(CATALOG, 'tuned');
    if (!shipped.ok) throw new Error('the shipped catalog does not validate');
    const reversed = validateRuleset({ ...CATALOG, units: [...CATALOG.units].reverse() }, 'tuned');
    if (!reversed.ok) throw new Error('the reversed catalog does not validate');

    const warrior = CATALOG.units.find((unit) => unit.id === asUnitTypeId('warrior'));
    const swordsman = CATALOG.units.find((unit) => unit.id === asUnitTypeId('swordsman'));
    expect(warrior?.cost).toBe(1);
    expect(swordsman?.cost).toBe(3);
    expect(warrior?.role).toBe('military');
    expect(warrior?.domain).toBe('land');

    expect(freeUnitType(shipped.value)).toBe('warrior');
    expect(freeUnitType(reversed.value)).toBe('warrior');
    // The old rule, on the same two catalogs: the warrior, then the swordsman. So the
    // canonical pick preserved shipped behaviour and removed a dependence on order.
    expect(firstRowWouldBe(shipped.value)).toBe('warrior');
    expect(firstRowWouldBe(reversed.value)).toBe('swordsman');
  });
});
