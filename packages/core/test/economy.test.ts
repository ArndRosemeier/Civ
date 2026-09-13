/**
 * The money loop — commerce split, income, upkeep and bankruptcy
 * (docs/INTERFACES.md M4b, "Rates and the commerce split" and "The money loop").
 *
 * The board is hand-built rather than generated, for the same reason
 * `commands.test.ts` builds one: every number below is meant to be checkable by
 * reading it. A 4×4 grassland map with `1` commerce per tile means a city's
 * commerce is `1 + (tiles it works)`, so "this city splits 3 commerce into
 * 2 gold, 1 beaker and nothing" is arithmetic a reader can do in their head rather
 * than a hash they have to trust.
 *
 * What this file is *for*, in the milestone's terms (INTERFACES.md M4b,
 * "Acceptance evidence"):
 *
 * - the **split**, including the remainder-to-gold rule, as a property over every
 *   legal rate triple rather than one example;
 * - **unit support at exactly the free threshold and one unit over**;
 * - **bankruptcy** removing the exact documented unit ids, in the documented
 *   order, with the treasury floored at 0 and the uncovered remainder reported
 *   rather than invented;
 * - and a **long run** in which the treasury never goes negative and every gold
 *   piece is accounted for by the events of the turn that moved it.
 *
 * Every number here is a **placeholder** rule of ours — the free allowance, the
 * support cost, the rate total and the starting treasury are unsourced and chosen
 * to be playable (see `economy.ts` and `state.ts` for each one's provenance). None
 * of it is claimed to be Civ 3's.
 */

import { describe, expect, it } from 'vitest';
// SHIPPED content, read by one test below (`M4c: a TreasuryShortfall reachable from
// shipped content`): M4c's acceptance criterion is about shipped content
// specifically, and `@civts/core`' own reads never touch this package.
import { CATALOG, validateRuleset } from '@civts/rules';
import { canonicalize, hashValue } from '@civts/testing';
// `cityYields` is the city read the money loop multiplies: `playerIncome` splits a
// city's commerce, so "what a city yields" is a number this file has to be able to
// state rather than infer.
import { cityYields, type BuildingDef, type City } from '../src/cities.js';
import type { GameEvent } from '../src/commands.js';
// The module under test. Every name it exports and this file uses is imported, so
// a rename fails here rather than in another package.
import {
  FREE_UNITS_BASE,
  applyEconomy,
  buildingMaintenance,
  freeUnitAllowance,
  playerIncome,
  playerUpkeep,
  ratesProblem,
  splitCommerce,
  unitSupport,
} from '../src/economy.js';
// M9: the free-per-city allowance and the per-unit support cost are **catalog rows of the
// government**, not module constants, so this file reads them from the ruleset it hands the
// engine — the same read `economy.ts` makes. A test that hard-coded "2 free per city, 1 gold
// each" would go on passing after a balance sweep moved either number.
import { freeUnitsPerCity, governmentDef, type GovernmentDef } from '../src/governments.js';
import {
  asGovernmentId,
  asBuildingId,
  asCityId,
  asPlayerId,
  asResourceId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type BuildingId,
  type TileIndex,
} from '../src/ids.js';
import { asImprovementId, type ImprovementDef, type TileImprovement } from '../src/improvements.js';
import type { GameMap, ResourceDef, RulesetView, TerrainDef, TileResource } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
  type Rates,
} from '../src/state.js';

import type { Unit, UnitDef } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const GRASSLAND = asTerrainId('grassland');

/** Every tile yields the same, so a city's commerce is a count of tiles. */
const TERRAIN: TerrainDef = {
  id: GRASSLAND,
  role: 'grassland',
  name: 'Grassland',
  moveCost: 1,
  defenseBonusPct: 10,
  yields: { food: 2, shields: 1, commerce: 1 },
  impassable: false,
};

const MAP: GameMap = {
  width: 4,
  height: 4,
  terrain: Array.from({ length: 16 }, () => GRASSLAND),
  huts: [],
  // M4c: the map carries the resources `generateWorld` placed. Empty here, so no
  // bonus resource can be the hidden reason a number in this file moved; the one
  // test that *wants* a resource builds its own map with `mapWith` below.
  resources: [],
};

/**
 * The same board with the given (tile, resource) pairs on it — the map half of
 * M4c's shape, spelled out where a test asks for it rather than baked into `MAP`.
 */
const mapWith = (resources: readonly TileResource[]): GameMap => ({ ...MAP, resources });

const makeUnitDef = (id: string, role: UnitDef['role'], movement: number): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 0,
  defense: 0,
  movement,
  cost: 1,
  domain: 'land',
});

const WARRIOR = makeUnitDef('warrior', 'military', 1);
const WORKER = makeUnitDef('worker', 'worker', 1);

/**
 * A building with nothing declared but its cost: free to keep, and doing nothing
 * for its city. M4c's `BuildingDef` carries `maintenance` and `effects` as
 * required fields, and `0` / `[]` are how a row says "neither" — a legal row, not
 * an unknown one.
 */
const GRANARY: BuildingDef = {
  id: asBuildingId('granary'),
  name: 'Granary',
  cost: 10,
  maintenance: 0,
  effects: [],
};

/**
 * A building that bills gold. `effects: []` because the money loop reads no
 * effect: what this row is for is the `maintenance` term, and the *effects*
 * (commerce, beakers, shields, growth food) are exercised in `buildings.test.ts`
 * and `cities.test.ts`.
 */
const TEMPLE: BuildingDef = {
  id: asBuildingId('temple'),
  name: 'Temple',
  cost: 20,
  maintenance: 2,
  effects: [],
};

/**
 * A library: one gold of maintenance and a +50% beaker effect, the shape
 * `@civts/rules` ships. This is the row that makes the beaker half of M4c
 * observable in the money loop, and the numbers are this file's stand-in — the
 * shipped values are pinned in `@civts/rules`' test and used end to end in
 * `buildings.test.ts`. Not claimed to be Civ 3's.
 */
const LIBRARY: BuildingDef = {
  id: asBuildingId('library'),
  name: 'Library',
  cost: 20,
  maintenance: 1,
  effects: [{ kind: 'beaker-multiplier', pct: 50 }],
};

/** Rows whose declared upkeep is not a usable count: billed as nothing, not as a fraction. */
const ZERO_UPKEEP: BuildingDef = {
  id: asBuildingId('zero'),
  name: 'Zero',
  cost: 1,
  maintenance: 0,
  effects: [],
};
const NEGATIVE_UPKEEP: BuildingDef = {
  id: asBuildingId('negative'),
  name: 'Negative',
  cost: 1,
  maintenance: -3,
  effects: [],
};
const FRACTIONAL_UPKEEP: BuildingDef = {
  id: asBuildingId('fractional'),
  name: 'Fractional',
  cost: 1,
  maintenance: 0.5,
  effects: [],
};

/**
 * M9's government rows for this file's hand-built world: one row (`despotism`) whose
 * numbers are **this file's own placeholders**, deliberately different from the shipped
 * catalog's so a test that read the shipped number by accident would fail. The
 * per-city allowance is 2 and the per-unit cost 1, which is what the M4b contract's
 * numbers were before M9 moved them into the catalog.
 */
const DESPOTISM: GovernmentDef = {
  id: asGovernmentId('despotism'),
  name: 'Despotism',
  rateCaps: { tax: 8, science: 8, luxury: 2 },
  freeUnitsPerCity: 2,
  unitSupportCost: 1,
  happinessModifier: 0,
};

const RULESET: RulesetView = {
  terrains: [TERRAIN],
  units: [WARRIOR, WORKER],
  buildings: [GRANARY],
  improvements: [],
  governments: [DESPOTISM],
  fidelity: 'tuned',
};

/** The same view with the upkept building, and one with nonsense upkeep rows. */
const UPKEEP_RULESET: RulesetView = { ...RULESET, buildings: [GRANARY, TEMPLE] };

/** The same view with a library, for M4c's beaker effect. */
const LIBRARY_RULESET: RulesetView = { ...RULESET, buildings: [GRANARY, LIBRARY] };

const NONSENSE_RULESET: RulesetView = {
  ...RULESET,
  buildings: [ZERO_UPKEEP, NEGATIVE_UPKEEP, FRACTIONAL_UPKEEP],
};

/**
 * The two numbers this file's fixture states, **read back out of the row it just
 * declared** rather than written a second time in the assertions below. That is the M9
 * discipline applied to a test: a body that spelled `2` and `1` for itself would be a second
 * statement of the fixture, and a sweep that moved the row would leave the body asserting a
 * game nobody plays.
 */
const HAND_ALLOWANCE_PER_CITY = DESPOTISM.freeUnitsPerCity;
const HAND_UNIT_COST = DESPOTISM.unitSupportCost;

/**
 * The sanity check that the two readers below agree with the row: `freeUnitAllowance` and
 * `unitSupport` reach their magnitudes through `governments.ts`' accessors, so the numbers
 * this file asserts against are the numbers the engine would charge. Asserted here, before
 * any test runs, because a disagreement is a broken *fixture* and every assertion below
 * would then be measuring the wrong game — and asserted rather than assumed because a
 * silent mismatch is exactly the dual-source bug M9's catalog exists to prevent.
 */
const checkFixture = (): void => {
  const ruleset = freeUnitsPerCity(RULESET, player(0));
  if (ruleset !== HAND_ALLOWANCE_PER_CITY) {
    throw new Error('economy.test.ts: the fixture row and the engine disagree about free units');
  }
  if (governmentDef(RULESET, asGovernmentId('despotism'))?.unitSupportCost !== HAND_UNIT_COST) {
    throw new Error('economy.test.ts: the fixture row and the engine disagree about unit cost');
  }
};

/**
 * One improvement and three resource rows for M4c's tile composition, all
 * stand-ins of this file's own with plain numbers, so a delta is the difference
 * between two readings rather than a value the reader has to trust: the mine adds
 * one shield, the bonus wheat adds one food **and** one commerce. The shipped
 * catalog's values are pinned in `@civts/rules`' test and exercised against the
 * engine in `resources.test.ts`; none of these is claimed to be Civ 3's.
 *
 * The three resource rows exist together so the *kind* is observable in the money
 * loop: only `bonus` reaches a tile, while a `strategic` row is a gate and a
 * `luxury` row a count (M4c, "Resources").
 */
const MINE: ImprovementDef = {
  id: asImprovementId('mine'),
  kind: 'mine',
  name: 'Mine',
  turns: 3,
  yields: { food: 0, shields: 1, commerce: 0 },
  allowedRoles: ['grassland'],
};

const WHEAT: ResourceDef = {
  id: asResourceId('wheat'),
  name: 'Wheat',
  kind: 'bonus',
  yields: { food: 1, shields: 0, commerce: 1 },
  allowedRoles: ['grassland'],
};

const IRON: ResourceDef = {
  id: asResourceId('iron'),
  name: 'Iron',
  kind: 'strategic',
  yields: { food: 0, shields: 0, commerce: 0 },
  allowedRoles: ['grassland'],
};

const GEMS: ResourceDef = {
  id: asResourceId('gems'),
  name: 'Gems',
  kind: 'luxury',
  yields: { food: 0, shields: 0, commerce: 0 },
  allowedRoles: ['grassland'],
};

/**
 * The views above plus an improvement catalog and a resource catalog. `resources`
 * is the optional half of the M4c map shape (`improvements` on a view is required,
 * resources are not), and this view is used by the M4c tests at the end of the
 * income section and by nothing else — no number in any other test moves because
 * this catalog exists.
 */
const RESOURCE_RULESET: RulesetView = {
  ...RULESET,
  improvements: [MINE],
  resources: [WHEAT, IRON, GEMS],
};

/**
 * The **shipped** content, validated the way the CLI validates it — a validated
 * `Ruleset` is structurally a `RulesetView`, so no adapter is needed. Read by the
 * M4c acceptance test at the bottom of this file and by nothing else here; the
 * engine's own modules never reach for content.
 */
const SHIPPED: RulesetView = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog must validate at fidelity "tuned": ${JSON.stringify(validated.error)}`,
    );
  }
  return validated.value;
})();

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** A player with the money fields spelled out; every override is explicit. */
const player = (index: number, overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(0),
  kind: 'civ',
  // M9: a player carries a government. `defaultGovernmentOf` picks the first row of
  // the ruleset's `governments` section, which is `despotism` in the shipped catalog;
  // this literal is a hand-built state, so it states the id rather than deriving it.
  government: asGovernmentId('despotism'),
  treasury: 0,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: required, and "knows nothing" is the empty array rather than an absent key.
  // It sits *before* the spread so a test that wants a known techs list still can.
  techs: [],
  ...overrides,
});

const barbarians = (overrides: Partial<PlayerState> = {}): PlayerState =>
  player(2, { name: 'Barbarians', kind: 'barbarian', ...overrides });

/**
 * A player object with one field *removed* — a state the type says cannot exist,
 * built deliberately. The only reason to write such a thing is to check that a
 * read stays total on it (an older save, a hand-edited file), and the cast is the
 * honest way to say "this object is not a `PlayerState` and I know it".
 */
const withoutField = (value: PlayerState, field: 'rates' | 'treasury'): PlayerState => {
  const kept = Object.entries(value).filter(([key]) => key !== field);
  // `Object.fromEntries` rather than `delete`: nothing in this suite deletes a key
  // from a state, and the money loop's own rule is that a field is either there or
  // absent — never present and `undefined`.
  return Object.fromEntries(kept) as unknown as PlayerState;
};

const unit = (id: number, def: UnitDef, owner: number): Unit => ({
  id: asUnitId(id),
  type: def.id,
  owner: asPlayerId(owner),
  tile: asTileIndex(0),
  movementLeft: def.movement,
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

/** A board with nothing on it unless a test says otherwise. */
const board = (overrides: Partial<GameState> = {}): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0), player(1), barbarians()],
  nextUnitId: 100,
  units: [],
  explored: [
    Array.from({ length: 16 }, () => false),
    Array.from({ length: 16 }, () => false),
    Array.from({ length: 16 }, () => false),
  ],
  nextCityId: 100,
  // M9: the materialised ownership layer. `[]` is the honest value for a
  // state nobody has run a turn on: `withOwnership` fills it from the cities the
  // moment ownership matters, and `computeTileOwner` never reads it, so an empty
  // layer cannot make a border wrong — it only means none has been claimed yet.
  tileOwner: [],
  cities: [],
  improvements: [],
  ...overrides,
});

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);
const BARBARIAN = asPlayerId(2);

/** `count` units of one type, ids `0..count-1`, owned by `owner`. */
const unitStack = (count: number, owner: number): readonly Unit[] =>
  Array.from({ length: count }, (_unused, index) => unit(index, WARRIOR, owner));

/**
 * The two tiles city 0 (centre tile 5, i.e. (1,1)) works, and the two city 1
 * (centre tile 10, i.e. (2,2)) works. Every tile on this board is grassland with
 * 1 commerce, so each city's commerce is `1 + 2 = 3` and the arithmetic below can
 * be done in the reader's head.
 */
const WORKED_0: readonly TileIndex[] = [asTileIndex(4), asTileIndex(6)];
const WORKED_1: readonly TileIndex[] = [asTileIndex(9), asTileIndex(11)];

/** Every rates triple of non-negative integers summing to `RATE_TOTAL`. */
const everyRates = (): readonly Rates[] => {
  const out: Rates[] = [];
  for (let tax = 0; tax <= RATE_TOTAL; tax += 1) {
    for (let science = 0; tax + science <= RATE_TOTAL; science += 1) {
      out.push({ tax, science, luxury: RATE_TOTAL - tax - science });
    }
  }
  return out;
};

/** Rates no command could write, for the total-read checks. */
const ILLEGAL_RATES: readonly Rates[] = [
  { tax: 10, science: 10, luxury: 10 },
  { tax: 0, science: 0, luxury: 0 },
  { tax: -5, science: 5, luxury: 10 },
  { tax: 1.5, science: 4, luxury: 4.5 },
];

/** The values of one event field across a run of events, for comparison by list. */
const pluck = <T>(
  events: readonly T[],
  take: (event: T) => boolean,
  value: (event: T) => number,
): readonly number[] => events.flatMap((event) => (take(event) ? [value(event)] : []));

/**
 * Every event of one type, narrowed by the predicate rather than by a cast — the
 * same shape `commands.ts` uses to read a payload it cannot trust.
 */
const eventsOfType = <T extends GameEvent['type']>(
  events: readonly GameEvent[],
  type: T,
): readonly Extract<GameEvent, { readonly type: T }>[] =>
  events.filter((event): event is Extract<GameEvent, { readonly type: T }> => event.type === type);

/* ------------------------------------------------------------------ *
 * The split
 * ------------------------------------------------------------------ */

describe('splitCommerce — the rates divide each city’s commerce', () => {
  it('splits ten parts of commerce exactly, one part per tenth', () => {
    // 5/4/1 of 10 commerce is the one case where nothing is left over: each
    // channel's exact share is already a whole number.
    expect(splitCommerce(10, { tax: 5, science: 4, luxury: 1 })).toEqual({
      gold: 5,
      beakers: 4,
      luxuries: 1,
    });
  });

  it('sends the remainder of the integer division to gold', () => {
    // 3 commerce at 5/4/1: the floors are 1 gold, 1 beaker and 0 luxuries — 2 of
    // the 3 — and the leftover 1 goes to gold. This is the rule, stated.
    expect(splitCommerce(3, { tax: 5, science: 4, luxury: 1 })).toEqual({
      gold: 2,
      beakers: 1,
      luxuries: 0,
    });

    // A remainder of 2, so the rule is not "add at most one".
    expect(splitCommerce(3, { tax: 3, science: 3, luxury: 4 })).toEqual({
      gold: 2,
      beakers: 0,
      luxuries: 1,
    });

    // And the all-gold rate is the identity, with no channel to take from.
    expect(splitCommerce(7, { tax: 10, science: 0, luxury: 0 })).toEqual({
      gold: 7,
      beakers: 0,
      luxuries: 0,
    });
  });

  it('conserves the commerce exactly, for every legal rate and 0..40 commerce', () => {
    const rates = everyRates();
    // The whole space: every triple of non-negative integers summing to
    // RATE_TOTAL is 66 commands, and every one of them must conserve.
    expect(rates).toHaveLength(((RATE_TOTAL + 1) * (RATE_TOTAL + 2)) / 2);

    for (const rate of rates) {
      for (let commerce = 0; commerce <= 40; commerce += 1) {
        const split = splitCommerce(commerce, rate);
        const where = `${String(commerce)} at ${String(rate.tax)}/${String(rate.science)}/${String(rate.luxury)}`;

        // Nothing is created and nothing is lost: the three channels add up to
        // exactly the commerce that was split.
        expect(split.gold + split.beakers + split.luxuries, where).toBe(commerce);
        // Every channel is a whole, non-negative number — the milestone's
        // "integer arithmetic only" rule, checked rather than assumed.
        for (const value of [split.gold, split.beakers, split.luxuries]) {
          expect(Number.isInteger(value), where).toBe(true);
          expect(value, where).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('is total on commerce that is not a positive number', () => {
    for (const commerce of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(splitCommerce(commerce, DEFAULT_RATES), String(commerce)).toEqual({
        gold: 0,
        beakers: 0,
        luxuries: 0,
      });
    }
  });

  it('never returns a negative channel for rates a command could not write', () => {
    // The command layer refuses such a triple (`ratesProblem`), but a hand-built
    // state can carry one, and a negative beaker pool would be a *state* the
    // hasher rejects. Total, not thrown.
    for (const rates of ILLEGAL_RATES) {
      for (const commerce of [0, 1, 3, 10]) {
        const split = splitCommerce(commerce, rates);
        const where = `${JSON.stringify(rates)} at ${String(commerce)}`;
        for (const value of [split.gold, split.beakers, split.luxuries]) {
          expect(Number.isInteger(value), where).toBe(true);
          expect(value, where).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('ratesProblem — one statement of what a legal rate triple is', () => {
  it('accepts every triple of non-negative integers summing to RATE_TOTAL', () => {
    for (const rates of everyRates()) {
      expect(ratesProblem(rates), JSON.stringify(rates)).toBeUndefined();
    }
  });

  it('names the offending field when a rate is not an integer >= 0', () => {
    expect(ratesProblem({ tax: -1, science: 5, luxury: 6 })).toContain('tax');
    expect(ratesProblem({ tax: -1, science: 5, luxury: 6 })).toContain('>= 0');
    expect(ratesProblem({ tax: 1.5, science: 4, luxury: 4.5 })).toContain('tax');
    expect(ratesProblem({ tax: 1.5, science: 4, luxury: 4.5 })).toContain('integer');
    expect(ratesProblem({ tax: 4, science: 0, luxury: -1 })).toContain('luxury');
  });

  it('reports the actual sum when the three rates do not add up', () => {
    const problem = ratesProblem({ tax: 3, science: 3, luxury: 3 });
    expect(problem).toBeDefined();
    // The contract asks for the actual sum in the message, and for the parts, so a
    // caller can render "3 + 3 + 3 = 9, needs 10" without re-deriving them.
    expect(problem).toContain(`exactly ${String(RATE_TOTAL)}`);
    expect(problem).toContain('= 9');

    expect(ratesProblem({ tax: 0, science: 0, luxury: 0 })).toContain('= 0');
    expect(ratesProblem({ tax: 10, science: 10, luxury: 10 })).toContain('= 30');
  });
});

/* ------------------------------------------------------------------ *
 * Income and upkeep reads
 * ------------------------------------------------------------------ */

describe('playerIncome — the split is per city, not once for the player', () => {
  it('collects the centre’s commerce and every worked tile’s, split at the rates', () => {
    // City 0 on tile 5 (1,1), population 3: the centre (1 commerce) plus tiles 4
    // and 6 = 3 commerce, which at 5/4/1 is 2 gold, 1 beaker and nothing — the
    // remainder-to-gold example, arrived at through the map rather than by hand.
    const state = board({
      players: [player(0, { rates: { tax: 5, science: 4, luxury: 1 } })],
      cities: [city(0, 0, 5, { population: 3, workedTiles: [asTileIndex(4), asTileIndex(6)] })],
    });

    expect(playerIncome(state, RULESET, P0)).toEqual({ gold: 2, beakers: 1, luxuries: 0 });
  });

  it('splits each city on its own, so the remainder is taken per city', () => {
    // At 0/5/5 the remainder is visible: two 3-commerce cities each floor to
    // 1 beaker and 1 luxury with 1 left over, so gold is 2, beakers 2, luxuries 2.
    // One 6-commerce city splits *once*: 3 beakers, 3 luxuries and no remainder at
    // all, so its gold is 0. The totals differ, which is exactly why the contract's
    // "each city's commerce is split by the rates" is pinned here rather than left
    // to the reader.
    const rates: Rates = { tax: 0, science: 5, luxury: 5 };
    const two = board({
      players: [player(0, { rates })],
      cities: [
        city(0, 0, 5, { population: 3, workedTiles: [asTileIndex(4), asTileIndex(6)] }),
        city(1, 0, 10, { population: 3, workedTiles: [asTileIndex(9), asTileIndex(11)] }),
      ],
    });
    const one = board({
      players: [player(0, { rates })],
      cities: [
        city(0, 0, 5, {
          population: 6,
          workedTiles: [0, 1, 2, 4, 6].map((tile) => asTileIndex(tile)),
        }),
      ],
    });

    expect(playerIncome(two, RULESET, P0)).toEqual({ gold: 2, beakers: 2, luxuries: 2 });
    expect(playerIncome(one, RULESET, P0)).toEqual({ gold: 0, beakers: 3, luxuries: 3 });
  });

  it('collects nothing for a player with no cities, and for a player that is not there', () => {
    const state = board({ players: [player(0)], cities: [city(0, 0, 5)] });
    expect(playerIncome(state, RULESET, P1)).toEqual({ gold: 0, beakers: 0, luxuries: 0 });
    expect(playerIncome(state, RULESET, asPlayerId(99))).toEqual({
      gold: 0,
      beakers: 0,
      luxuries: 0,
    });
  });

  it('reads a player whose rates are missing as the defaults, rather than throwing', () => {
    // A state the type says cannot exist (an older save, a hand-edited file): the
    // read stays total, exactly as `units.ts` reads a movement budget it cannot
    // resolve.
    const state = board({
      players: [withoutField(player(0), 'rates')],
      cities: [city(0, 0, 5)],
    });
    expect(playerIncome(state, RULESET, P0)).toEqual({ gold: 1, beakers: 0, luxuries: 0 });
  });

  it('scales the beaker channel by the library the city holds, and by no other city’s', () => {
    // M4c's beaker effect, in the money loop. One city of three citizens works two
    // grassland tiles: 3 commerce, all of it science at 0/10/0, so 3 beakers — and
    // `floor(3 * 150 / 100) = 4` with a +50% library. The other city is the same
    // player's and holds nothing, so it still splits to its own unmultiplied
    // channels: an effect is a *city's*, never a player's.
    const rates: Rates = { tax: 0, science: RATE_TOTAL, luxury: 0 };
    const bareCity = city(0, 0, 5, { population: 3, workedTiles: WORKED_0 });
    const libraryCity: City = { ...bareCity, buildings: [asBuildingId('library')] };
    const neighbours: readonly City[] = [city(1, 0, 10, { population: 3, workedTiles: WORKED_1 })];

    const plain = board({ players: [player(0, { rates })], cities: [bareCity, ...neighbours] });
    const built = board({ players: [player(0, { rates })], cities: [libraryCity, ...neighbours] });

    // The library's city went from 3 beakers to 4; the other city contributed its
    // own 3, untouched.
    expect(playerIncome(plain, LIBRARY_RULESET, P0)).toEqual({ gold: 0, beakers: 6, luxuries: 0 });
    expect(playerIncome(built, LIBRARY_RULESET, P0)).toEqual({ gold: 0, beakers: 7, luxuries: 0 });

    // …and the same library is on the same player's *bill* in the same turn: the two
    // halves of M4c — an effect and a maintenance — are read from one row.
    expect(playerUpkeep(built, LIBRARY_RULESET, P0).maintenance).toBe(LIBRARY.maintenance);
    expect(playerUpkeep(plain, LIBRARY_RULESET, P0).maintenance).toBe(0);
  });
});

describe('bonus resources — a tile’s worth reaches the city, and then the money loop', () => {
  /**
   * The two tiles the city works, and the first of them — where every pair below
   * goes. A tuple, so `WORKED[0]` is a `TileIndex` and not `TileIndex | undefined`.
   */
  const WORKED: readonly [TileIndex, TileIndex] = [asTileIndex(4), asTileIndex(6)];
  const TILE = WORKED[0];

  /**
   * One city of three citizens on tile 5, working tiles 4 and 6 (M4c's
   * `cityYields` composition, on this file's all-grassland board: terrain is
   * 2 food / 1 shield / 1 commerce per tile, and the centre is floored, not added).
   */
  const CITY = city(0, 0, 5, { population: 3, workedTiles: WORKED });

  /** The board with whatever the test puts on the map and on the city's tiles. */
  const boardWith = (
    resources: readonly TileResource[],
    improvements: readonly TileImprovement[] = [],
  ): GameState =>
    board({
      map: mapWith(resources),
      players: [player(0)],
      cities: [CITY],
      improvements,
    });

  it('stacks terrain, the improvement and the bonus resource, and nothing else', () => {
    // Three contributions on one tile, in the order M4c fixes them: the terrain's
    // own yields, the improvement's delta, then the bonus resource's delta — read
    // through `cityYields`, which is the composition the money loop multiplies.
    const bare = boardWith([]);
    const mined = boardWith([], [{ tile: TILE, kind: MINE.id }]);
    const wheat = boardWith([{ tile: TILE, resource: WHEAT.id }], [{ tile: TILE, kind: MINE.id }]);

    // Grassland everywhere: centre 2/1/1 plus two worked tiles at 2/1/1.
    expect(cityYields(bare, RESOURCE_RULESET, CITY.id)).toEqual({
      food: 6,
      shields: 3,
      commerce: 3,
      foodSurplus: 0,
    });
    // …plus the mine's +1 shield on the worked tile.
    expect(cityYields(mined, RESOURCE_RULESET, CITY.id)).toEqual({
      food: 6,
      shields: 4,
      commerce: 3,
      foodSurplus: 0,
    });
    // …plus the wheat's +1 food and +1 commerce, on top of both of the above.
    expect(cityYields(wheat, RESOURCE_RULESET, CITY.id)).toEqual({
      food: 7,
      shields: 4,
      commerce: 4,
      foodSurplus: 1,
    });

    // The deltas are the *catalog rows'* declared yields, not numbers this test
    // happens to agree with: a retuned wheat row moves the expectation with it, and
    // a row silently ignored by the engine cannot pass.
    const bareYields = cityYields(bare, RESOURCE_RULESET, CITY.id);
    const wheatYields = cityYields(wheat, RESOURCE_RULESET, CITY.id);
    expect(wheatYields.food - bareYields.food).toBe(WHEAT.yields.food);
    expect(wheatYields.shields - bareYields.shields).toBe(MINE.yields.shields);
    expect(wheatYields.commerce - bareYields.commerce).toBe(WHEAT.yields.commerce);

    // A resource on a tile no citizen works contributes nothing: a bonus resource
    // is not connected (it needs no road) but it is also not a per-*player* number —
    // it feeds the city that works the tile it sits on, and nothing else.
    const elsewhere = boardWith([{ tile: asTileIndex(9), resource: WHEAT.id }]);
    expect(cityYields(elsewhere, RESOURCE_RULESET, CITY.id)).toEqual(bareYields);

    // And the centre is not a worked tile, so a resource on the city's own tile is
    // worth nothing either — the same rule M4a states for improvements, applied by
    // the same composition (`cities.ts`: the centre reads its *terrain* alone).
    const onCentre = boardWith([{ tile: CITY.tile, resource: WHEAT.id }]);
    expect(cityYields(onCentre, RESOURCE_RULESET, CITY.id)).toEqual(bareYields);
  });

  it('adds nothing for a strategic or a luxury row, whose yields are zeros by contract', () => {
    // M4c: `yields` is "bonus only; zeros otherwise". A strategic row's effect is the
    // production gate and a luxury row's is its connection count, and neither is a
    // number on a tile — stated here so a later change that made iron feed a city
    // would have to change this test on purpose. Which rows reach the engine *when*
    // they do carry yields is a rule about the kind, and `resources.test.ts` pins it
    // directly; what this file checks is the consequence one layer up.
    const bare = boardWith([]);
    for (const row of [IRON, GEMS]) {
      const placed = boardWith([{ tile: TILE, resource: row.id }]);

      // The premise this test rests on, asserted rather than assumed: these two rows
      // declare no delta, so "nothing changed" cannot be explained by zeros that
      // were never meant to be added. Editing a row above therefore has to edit this
      // line too, instead of quietly turning the case into a different one.
      expect(row.yields).toEqual({ food: 0, shields: 0, commerce: 0 });
      expect(cityYields(placed, RESOURCE_RULESET, CITY.id)).toEqual(
        cityYields(bare, RESOURCE_RULESET, CITY.id),
      );
    }
  });

  it('splits the extra commerce through the rates, so the gold and beakers move', () => {
    // The tile's worth is not the end of the chain: commerce is what `playerIncome`
    // divides. At 5/4/1, 3 commerce is 2 gold / 1 beaker (the remainder-to-gold
    // example), and the wheat's extra commerce makes it 4 — `floor(4*5/10) = 2` gold
    // plus the remainder, and `floor(4*4/10) = 1` beaker. One more commerce is one
    // more gold here, which is the only reason a bonus resource is visible at all.
    const rates: Rates = { tax: 5, science: 4, luxury: 1 };
    const bare = board({
      map: mapWith([]),
      players: [player(0, { rates })],
      cities: [CITY],
    });
    const wheat = board({
      map: mapWith([{ tile: TILE, resource: WHEAT.id }]),
      players: [player(0, { rates })],
      cities: [CITY],
    });

    expect(cityYields(bare, RESOURCE_RULESET, CITY.id).commerce).toBe(3);
    expect(playerIncome(bare, RESOURCE_RULESET, P0)).toEqual({ gold: 2, beakers: 1, luxuries: 0 });
    expect(cityYields(wheat, RESOURCE_RULESET, CITY.id).commerce).toBe(4);
    expect(playerIncome(wheat, RESOURCE_RULESET, P0)).toEqual({ gold: 3, beakers: 1, luxuries: 0 });
  });
});

describe('unit support — the free allowance and the cost beyond it', () => {
  it('reads the allowance and the cost this file declared on its one government row', () => {
    checkFixture();
  });

  it('is FREE_UNITS_BASE with no cities, and HAND_ALLOWANCE_PER_CITY more per city', () => {
    const bare = board({ units: [] });
    expect(freeUnitAllowance(bare, RULESET, P0)).toBe(FREE_UNITS_BASE);

    const cityful = board({ cities: [city(0, 0, 5), city(1, 0, 10), city(2, 1, 12)] });
    // Only the player's own cities count: two of the three, plus the base.
    expect(freeUnitAllowance(cityful, RULESET, P0)).toBe(
      HAND_ALLOWANCE_PER_CITY * 2 + FREE_UNITS_BASE,
    );
    expect(freeUnitAllowance(cityful, RULESET, P1)).toBe(
      HAND_ALLOWANCE_PER_CITY * 1 + FREE_UNITS_BASE,
    );
  });

  it('charges nothing at exactly the free threshold and one unit’s cost one over', () => {
    const at = board({ units: unitStack(FREE_UNITS_BASE, 0) });
    expect(unitSupport(at, RULESET, P0)).toEqual({
      units: FREE_UNITS_BASE,
      free: FREE_UNITS_BASE,
      supported: 0,
      gold: 0,
    });

    const over = board({ units: unitStack(FREE_UNITS_BASE + 1, 0) });
    expect(unitSupport(over, RULESET, P0)).toEqual({
      units: FREE_UNITS_BASE + 1,
      free: FREE_UNITS_BASE,
      supported: 1,
      gold: HAND_UNIT_COST,
    });
  });

  it('charges the same boundary one unit over a city allowance', () => {
    // Three cities: the allowance is 10, so ten units are free and the eleventh
    // costs one. The formula is the contract's, and it is pinned at its edge.
    const cities = [city(0, 0, 5), city(1, 0, 10), city(2, 0, 12)];
    const allowance = HAND_ALLOWANCE_PER_CITY * cities.length + FREE_UNITS_BASE;
    const at = board({ cities, units: unitStack(allowance, 0) });
    const over = board({ cities, units: unitStack(allowance + 1, 0) });

    expect(allowance).toBe(10);
    expect(unitSupport(at, RULESET, P0).gold).toBe(0);
    expect(unitSupport(over, RULESET, P0).gold).toBe(HAND_UNIT_COST);
  });

  it('counts only the player’s own units — a barbarian band is on nobody’s bill', () => {
    const state = board({
      units: [...unitStack(FREE_UNITS_BASE + 2, 0), unit(90, WARRIOR, 1), unit(91, WARRIOR, 2)],
    });
    expect(unitSupport(state, RULESET, P0).gold).toBe(2 * HAND_UNIT_COST);
    expect(unitSupport(state, RULESET, P1)).toEqual({
      units: 1,
      free: FREE_UNITS_BASE,
      supported: 0,
      gold: 0,
    });
    expect(unitSupport(state, RULESET, BARBARIAN).units).toBe(1);
  });
});

describe('buildingMaintenance — what the catalog declares, and nothing else', () => {
  it('sums a declared maintenance over the player’s cities, once per building', () => {
    const state = board({
      cities: [
        city(0, 0, 5, { buildings: [asBuildingId('temple'), asBuildingId('granary')] }),
        city(1, 0, 10, { buildings: [asBuildingId('temple')] }),
        city(2, 1, 12, { buildings: [asBuildingId('temple')] }),
      ],
    });

    // Two temples of this player's, and the granary declares nothing.
    expect(buildingMaintenance(state, UPKEEP_RULESET, P0)).toBe(TEMPLE.maintenance * 2);
    // The other player's temple is not on this player's bill.
    expect(buildingMaintenance(state, UPKEEP_RULESET, P1)).toBe(TEMPLE.maintenance);
  });

  it('bills zero for a catalog that declares no maintenance, and for an unknown building', () => {
    const state = board({
      cities: [city(0, 0, 5, { buildings: [asBuildingId('granary'), asBuildingId('palace')] })],
    });
    expect(buildingMaintenance(state, RULESET, P0)).toBe(0);
  });

  it('never turns a nonsense maintenance into a fractional or negative bill', () => {
    const state = board({
      cities: [
        city(0, 0, 5, {
          buildings: [asBuildingId('zero'), asBuildingId('negative'), asBuildingId('fractional')],
        }),
      ],
    });
    expect(buildingMaintenance(state, NONSENSE_RULESET, P0)).toBe(0);
  });
});

describe('playerUpkeep — the two halves, and their sum', () => {
  it('adds maintenance to unit support', () => {
    const state = board({
      cities: [city(0, 0, 5, { buildings: [asBuildingId('temple')] })],
      // One city lifts the allowance to HAND_ALLOWANCE_PER_CITY + FREE_UNITS_BASE, so
      // nine units leave three billable.
      units: unitStack(HAND_ALLOWANCE_PER_CITY + FREE_UNITS_BASE + 3, 0),
    });

    expect(playerUpkeep(state, UPKEEP_RULESET, P0)).toEqual({
      maintenance: TEMPLE.maintenance,
      unitSupport: 3 * HAND_UNIT_COST,
      gold: TEMPLE.maintenance + 3 * HAND_UNIT_COST,
    });
  });
});

/* ------------------------------------------------------------------ *
 * M4c: the shipped catalog's maintenance, and the shortfall it makes real
 * ------------------------------------------------------------------ */

describe('M4c: a TreasuryShortfall reachable from shipped content', () => {
  /**
   * This is the **one** test in this file that reads `@civts/rules` instead of a
   * local stand-in, and it does so deliberately: M4c's acceptance evidence names "a
   * city whose buildings outrun its income drives a real `TreasuryShortfall` from
   * SHIPPED content", and M4b's accepted debt was that only a hand-built view could
   * reach the branch. Every read in `packages/core/src` stays content-agnostic —
   * this is evidence about the catalog, not a dependency of the engine on it.
   *
   * The expectations are **derived from the catalog**, never written down: a retune
   * of a row's maintenance changes the number this test expects instead of turning
   * it red, and what it pins is the rule (the sum is billed, the unpaid remainder is
   * reported, the buildings that caused it are lost) rather than today's tuning.
   */
  const billing = CATALOG.buildings.filter((row) => row.maintenance > 0);

  const maintenanceOfIds = (ids: readonly BuildingId[]): number => {
    const byId = new Map(billing.map((row) => [String(row.id), row.maintenance]));
    return ids.reduce((total, id) => total + (byId.get(String(id)) ?? 0), 0);
  };

  it('bills the shipped maintenance, reports what the city cannot pay, and takes the buildings', () => {
    // Non-vacuity first: the shipped catalog really does bill for something, so
    // nothing below is an assertion about zero.
    expect(billing.length).toBeGreaterThan(0);
    const billed = billing.reduce((total, row) => total + row.maintenance, 0);

    // One city holding every building the catalog charges for, one commerce of
    // income (the centre's, at 6/4/0 -> 1 gold), no units, an empty treasury.
    const state = board({
      players: [player(0, { treasury: 0 })],
      cities: [city(0, 0, 5, { buildings: billing.map((row) => row.id) })],
    });

    const outcome = applyEconomy(state, SHIPPED);
    const income = eventsOfType(outcome.events, 'IncomeCollected')[0];
    const upkeep = eventsOfType(outcome.events, 'UpkeepPaid')[0];
    const shortfalls = eventsOfType(outcome.events, 'TreasuryShortfall');
    const disbands = eventsOfType(outcome.events, 'UnitDisbanded');

    // The bill *is* the catalog's own sum of maintenances, to the gold — read
    // through the money loop and through the read it delegates to.
    expect(buildingMaintenance(state, SHIPPED, P0)).toBe(billed);
    expect(upkeep?.maintenance).toBe(billed);
    expect(upkeep?.gold).toBe(billed);

    // Nothing could pay it: no unit is billable, so no unit is disbanded, the unpaid
    // remainder is *reported* (this is the branch M4c makes reachable), and the
    // treasury floors at 0.
    expect(disbands).toEqual([]);
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]?.unpaid).toBe(billed - (income?.gold ?? 0));
    expect(shortfalls[0]?.unpaid).toBeGreaterThan(0);
    expect(outcome.state.players[0]?.treasury).toBe(0);

    // M4c's other half: the player also loses the buildings it could not pay for —
    // most recently completed first, until their maintenance covers the unpaid
    // amount, and no further.
    const before = billing.map((row) => row.id);
    const after = outcome.state.cities[0]?.buildings ?? [];
    const shed = before.slice(after.length);
    const kept = before.slice(0, after.length);
    const unpaid = shortfalls[0]?.unpaid ?? 0;

    expect(shed.length).toBeGreaterThan(0);
    expect(maintenanceOfIds(shed)).toBeGreaterThanOrEqual(unpaid);
    expect(maintenanceOfIds(kept)).toBeLessThan(unpaid);
    // And the state stays hashable: a loss is a smaller `buildings` array, never an
    // `undefined` written into one.
    expect(() => canonicalize(outcome.state)).not.toThrow();
  });

  it('emits no shortfall at all for the same city once it holds nothing that bills', () => {
    // The falsification of the test above: the shortfall has to come from the
    // buildings, not from the city or the pass. Same board, same rates, no
    // buildings — and the money loop is silent.
    const state = board({
      players: [player(0, { treasury: 0 })],
      cities: [city(0, 0, 5, { buildings: [asBuildingId('granary')] })],
    });
    const outcome = applyEconomy(state, SHIPPED);

    expect(buildingMaintenance(state, SHIPPED, P0)).toBe(0);
    expect(eventsOfType(outcome.events, 'TreasuryShortfall')).toEqual([]);
    expect(outcome.state.cities[0]?.buildings.map(String)).toEqual(['granary']);
  });
});

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

describe('applyEconomy — income, upkeep and bankruptcy', () => {
  it('adds income, pays upkeep, banks what is left, and reports every line', () => {
    // One city (1 commerce -> 1 gold at 6/4/0: both shares floor to 0 and the
    // remainder is 1 gold), no units, so nothing is owed.
    const state = board({
      players: [player(0, { treasury: STARTING_TREASURY })],
      cities: [city(0, 0, 5)],
    });

    const outcome = applyEconomy(state, RULESET);

    expect(outcome.events).toEqual([
      { type: 'IncomeCollected', playerId: P0, gold: 1, beakers: 0, luxuries: 0 },
      {
        type: 'UpkeepPaid',
        playerId: P0,
        gold: 0,
        maintenance: 0,
        unitSupport: 0,
        units: 0,
        // The city lifts the allowance: HAND_ALLOWANCE_PER_CITY per city plus the base.
        freeUnits: HAND_ALLOWANCE_PER_CITY + FREE_UNITS_BASE,
      },
    ]);
    expect(outcome.state.players[0]?.treasury).toBe(STARTING_TREASURY + 1);
  });

  it('banks beakers and luxuries in their own pools, which nothing else reads yet', () => {
    const rates: Rates = { tax: 0, science: 5, luxury: 5 };
    const state = board({
      players: [player(0, { rates })],
      cities: [city(0, 0, 5, { population: 3, workedTiles: [asTileIndex(4), asTileIndex(6)] })],
    });

    const outcome = applyEconomy(state, RULESET);
    const split = splitCommerce(3, rates);

    expect(outcome.state.players[0]?.treasury).toBe(split.gold);
    expect(outcome.state.players[0]?.beakers).toBe(split.beakers);
    expect(outcome.state.players[0]?.luxuries).toBe(split.luxuries);
  });

  it('disbands the highest-id units, one per gold of shortfall, and no others', () => {
    // Six units, no cities: four are free, so two are billable (2 gold). An empty
    // treasury cannot pay, so the two billable units are disbanded — ids 5 then 4,
    // highest first — and the treasury ends at exactly 0. Units 0..3 are untouched:
    // removing a *free* unit would destroy it and buy nothing.
    const state = board({ players: [player(0, { treasury: 0 })], units: unitStack(6, 0) });

    const outcome = applyEconomy(state, RULESET);

    expect(outcome.events).toEqual([
      { type: 'IncomeCollected', playerId: P0, gold: 0, beakers: 0, luxuries: 0 },
      {
        type: 'UpkeepPaid',
        playerId: P0,
        gold: 2,
        maintenance: 0,
        unitSupport: 2,
        units: 6,
        freeUnits: FREE_UNITS_BASE,
      },
      {
        type: 'UnitDisbanded',
        playerId: P0,
        unitId: asUnitId(5),
        unitType: WARRIOR.id,
        tile: asTileIndex(0),
        saved: HAND_UNIT_COST,
      },
      {
        type: 'UnitDisbanded',
        playerId: P0,
        unitId: asUnitId(4),
        unitType: WARRIOR.id,
        tile: asTileIndex(0),
        saved: HAND_UNIT_COST,
      },
    ]);
    expect(outcome.state.units.map((kept) => Number(kept.id))).toEqual([0, 1, 2, 3]);
    expect(outcome.state.players[0]?.treasury).toBe(0);
  });

  it('reports the uncovered remainder instead of letting the treasury go negative', () => {
    // A temple costs 2 and there is nothing to disband (no units at all), so the
    // whole shortfall is unpaid: the treasury floors at 0 and the amount is *said*,
    // never invented as a debt field.
    const state = board({
      players: [player(0, { treasury: 0 })],
      cities: [city(0, 0, 5, { buildings: [asBuildingId('temple')] })],
    });

    const outcome = applyEconomy(state, UPKEEP_RULESET);

    expect(outcome.state.players[0]?.treasury).toBe(0);
    expect(outcome.events).toEqual([
      { type: 'IncomeCollected', playerId: P0, gold: 1, beakers: 0, luxuries: 0 },
      {
        type: 'UpkeepPaid',
        playerId: P0,
        gold: TEMPLE.maintenance,
        maintenance: TEMPLE.maintenance,
        unitSupport: 0,
        units: 0,
        freeUnits: HAND_ALLOWANCE_PER_CITY + FREE_UNITS_BASE,
      },
      // One gold of income against two of maintenance leaves one unpaid, and a
      // disband would not have helped: there is no unit to remove.
      { type: 'TreasuryShortfall', playerId: P0, unpaid: 1 },
    ]);
  });

  it('covers what the billable units can and reports what they cannot', () => {
    // One city lifts the allowance to 6, so of the eight units the two highest ids
    // are billable. Upkeep is 4 (a temple for 2 plus those two for 2) against income
    // 1 from an empty treasury: the shortfall is 3. Disbanding both billable units
    // covers 2 of it, and 1 is left unpaid — the gold that no amount of disbanding
    // could have paid, because the temple remains.
    const state = board({
      players: [player(0, { treasury: 0 })],
      cities: [city(0, 0, 5, { buildings: [asBuildingId('temple')] })],
      units: unitStack(8, 0),
    });

    const outcome = applyEconomy(state, UPKEEP_RULESET);
    const disbanded = pluck(
      outcome.events,
      (event) => event.type === 'UnitDisbanded',
      (event) => (event.type === 'UnitDisbanded' ? Number(event.unitId) : -1),
    );
    const unpaid = pluck(
      outcome.events,
      (event) => event.type === 'TreasuryShortfall',
      (event) => (event.type === 'TreasuryShortfall' ? event.unpaid : -1),
    );

    expect(disbanded).toEqual([7, 6]);
    expect(unpaid).toEqual([1]);
    expect(outcome.state.units.map((kept) => Number(kept.id))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(outcome.state.players[0]?.treasury).toBe(0);
  });

  it('leaves barbarians entirely alone — no income, no upkeep, no disbanded band', () => {
    // Ten barbarian units and no gold would be a disbanding spree if the pass
    // treated them like a civilization; the contract says they have no economy.
    const band = Array.from({ length: 10 }, (_unused, index) => unit(index, WARRIOR, 2));
    const state = board({ players: [player(0), barbarians()], units: band });

    const outcome = applyEconomy(state, RULESET);
    const namedBarbarians = outcome.events.filter(
      (event) => 'playerId' in event && event.playerId === BARBARIAN,
    );

    expect(namedBarbarians).toEqual([]);
    expect(outcome.state.units.map((kept) => Number(kept.id))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const after = outcome.state.players.find((each) => each.id === BARBARIAN);
    expect(after?.treasury).toBe(0);
    expect(after?.beakers).toBe(0);
  });

  it('visits every civilization in player-id order, whatever order `players` is in', () => {
    const state = board({
      players: [barbarians(), player(1), player(0)],
      cities: [city(0, 0, 5), city(1, 1, 10)],
    });

    const outcome = applyEconomy(state, RULESET);
    const order = pluck(
      outcome.events,
      (event) => event.type === 'IncomeCollected',
      (event) => (event.type === 'IncomeCollected' ? Number(event.playerId) : -1),
    );

    expect(order).toEqual([0, 1]);
  });

  it('does not mutate its input, and produces a hashable, reproducible state', () => {
    const state = board({
      players: [player(0, { treasury: 3 })],
      cities: [city(0, 0, 5, { buildings: [asBuildingId('temple')] })],
      units: unitStack(7, 0),
    });
    const before = hashValue(state);

    const first = applyEconomy(state, UPKEEP_RULESET);
    const second = applyEconomy(state, UPKEEP_RULESET);

    expect(hashValue(state)).toBe(before);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    for (const each of first.state.players) {
      expect(Number.isInteger(each.treasury)).toBe(true);
      expect(Number.isInteger(each.beakers)).toBe(true);
      expect(Number.isInteger(each.luxuries)).toBe(true);
      expect(each.treasury).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the treasury non-negative and the ledger exact over a long run', () => {
    // 200 turns of two cities that earn 1 gold each and a temple each (2 gold of
    // maintenance apiece), with nine units — one of them billable. The treasury
    // drains and the player goes bankrupt on turn 4.
    //
    // **M4c changes what happens next, and this is where that is pinned.** M4b
    // disbanded the one billable unit and then ran a permanent 2-gold shortfall for
    // the rest of the run. A building that bills gold is now a building a broke
    // player cannot keep, so the same turn also costs it the temple it could not pay
    // for (`disbandBuildings`, most recently completed first) — and once those are
    // gone the player is *solvent*: income 2, upkeep 2, and no further shortfall.
    // The M4b reading was a civilization permanently in arrears with its buildings
    // intact, which is not a state the contract asks the money loop to sustain.
    //
    // On *every* turn the identity in the module note holds to the gold:
    //   after - before === income - upkeep + sum(disbanded.saved) + shortfall.unpaid
    // — unchanged by M4c, because a lost building buys no gold (see the module note:
    // crediting the demolition would make `TreasuryShortfall` unreachable).
    let state = board({
      players: [player(0, { treasury: STARTING_TREASURY })],
      cities: [
        city(0, 0, 5, { buildings: [asBuildingId('temple')] }),
        city(1, 0, 10, { buildings: [asBuildingId('temple')] }),
      ],
      units: unitStack(9, 0),
    });

    let turns = 0;
    let disbands = 0;
    let shortfalls = 0;

    for (let turn = 0; turn < 200; turn += 1) {
      const before = state.players[0];
      if (before === undefined) throw new Error('the fixture lost its player');

      const outcome = applyEconomy(state, UPKEEP_RULESET);
      const after = outcome.state.players[0];
      if (after === undefined) throw new Error('the pass lost the player');

      const income = pluck(
        outcome.events,
        (event) => event.type === 'IncomeCollected',
        (event) => (event.type === 'IncomeCollected' ? event.gold : 0),
      );
      const upkeep = pluck(
        outcome.events,
        (event) => event.type === 'UpkeepPaid',
        (event) => (event.type === 'UpkeepPaid' ? event.gold : 0),
      );
      const covered = pluck(
        outcome.events,
        (event) => event.type === 'UnitDisbanded',
        (event) => (event.type === 'UnitDisbanded' ? event.saved : 0),
      );
      const unpaid = pluck(
        outcome.events,
        (event) => event.type === 'TreasuryShortfall',
        (event) => (event.type === 'TreasuryShortfall' ? event.unpaid : 0),
      );
      const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

      expect(after.treasury - before.treasury).toBe(
        sum(income) - sum(upkeep) + sum(covered) + sum(unpaid),
      );
      // The invariant the milestone names: a treasury is never negative.
      expect(after.treasury).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(after.treasury)).toBe(true);

      disbands += covered.length;
      shortfalls += unpaid.length;
      state = outcome.state;
      turns += 1;
    }

    expect(turns).toBe(200);
    // The run really did go bankrupt rather than idling: income 2 a turn, upkeep 5
    // (four of maintenance, one of support) — so the first three turns are paid from
    // the starting treasury and the fourth cannot be.
    expect(disbands).toBe(1);
    expect(shortfalls).toBe(1);
    // What bankruptcy cost it: unit 8 (the highest id, and the only billable one) and
    // the two-gold temple it could not pay for. The *most recently completed*
    // building went, which on this fixture is city 1's — city 0 keeps its temple, and
    // the run then sits at income 2 against upkeep 2 for the remaining 196 turns.
    expect(state.units.map((kept) => Number(kept.id))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(state.cities.map((each) => each.buildings.map(String))).toEqual([['temple'], []]);
    expect(state.players[0]?.treasury).toBe(0);
    // And it stays solvent: a further turn collects 2 against the 2 it still owes,
    // so nothing is unpaid and no building is lost. This is the falsification of the
    // M4b reading — the shortfall is not a permanent condition once M4c can take the
    // buildings that caused it.
    const next = applyEconomy(state, UPKEEP_RULESET);
    expect(next.events.filter((event) => event.type === 'TreasuryShortfall')).toEqual([]);
    expect(next.state.cities.map((each) => each.buildings.map(String))).toEqual([['temple'], []]);
    expect(next.state.players[0]?.treasury).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The reads the pass relies on
 * ------------------------------------------------------------------ */

describe('the money loop reads the state, not a cache', () => {
  it('counts a unit the moment it exists — no free turn of support', () => {
    // This is the property `turn.ts` places the pass for: a unit added to the state
    // by *anything* (production, a hut, a test) is billable in the same pass.
    const without = board({ players: [player(0)], units: unitStack(FREE_UNITS_BASE, 0) });
    const oneMore = board({ players: [player(0)], units: unitStack(FREE_UNITS_BASE + 1, 0) });

    expect(unitSupport(without, RULESET, P0).gold).toBe(0);
    expect(unitSupport(oneMore, RULESET, P0).gold).toBe(HAND_UNIT_COST);
  });

  it('reads the rates from the state it is handed, and never rewrites a banked turn', () => {
    const atDefaults = board({ cities: [city(0, 0, 5)], players: [player(0)] });
    const allScience = board({
      cities: [city(0, 0, 5)],
      players: [player(0, { rates: { tax: 0, science: 10, luxury: 0 } })],
    });

    expect(playerIncome(atDefaults, RULESET, P0)).toEqual({ gold: 1, beakers: 0, luxuries: 0 });
    expect(playerIncome(allScience, RULESET, P0)).toEqual({ gold: 0, beakers: 1, luxuries: 0 });
    // The rates are an input to a collection, never a recomputation of one: the
    // first board's answer cannot change because a *different* board changed rates.
    expect(playerIncome(atDefaults, RULESET, P0)).toEqual({ gold: 1, beakers: 0, luxuries: 0 });
  });
});
