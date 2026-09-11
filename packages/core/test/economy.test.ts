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
import { hashValue } from '@civts/testing';
import type { BuildingDef, City } from '../src/cities.js';
// The module under test. Every name it exports and this file uses is imported, so
// a rename fails here rather than in another package.
import {
  FREE_UNITS_BASE,
  FREE_UNITS_PER_CITY,
  UNIT_SUPPORT_COST,
  applyEconomy,
  buildingMaintenance,
  freeUnitAllowance,
  playerIncome,
  playerUpkeep,
  ratesProblem,
  splitCommerce,
  unitSupport,
} from '../src/economy.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
} from '../src/ids.js';
import type { GameMap, RulesetView, TerrainDef } from '../src/map.js';
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
};

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

/** A building with no declared upkeep — the only shape the M4b catalog has. */
const GRANARY: BuildingDef = { id: asBuildingId('granary'), name: 'Granary', cost: 10 };

/**
 * A building that *does* declare upkeep. M4c's buildings arrive with effects; this
 * row is what proves the maintenance term is summed rather than hard-coded to
 * zero. It is a test-local type rather than a field added to `BuildingDef` (which
 * is not this workstream's file), which is also why `economy.ts` reads the field
 * structurally.
 */
interface UpkeepDef extends BuildingDef {
  readonly maintenance: number;
}

const TEMPLE: UpkeepDef = {
  id: asBuildingId('temple'),
  name: 'Temple',
  cost: 20,
  maintenance: 2,
};

/** Rows whose declared upkeep is not a usable count: billed as nothing, not as a fraction. */
const ZERO_UPKEEP: UpkeepDef = {
  id: asBuildingId('zero'),
  name: 'Zero',
  cost: 1,
  maintenance: 0,
};
const NEGATIVE_UPKEEP: UpkeepDef = {
  id: asBuildingId('negative'),
  name: 'Negative',
  cost: 1,
  maintenance: -3,
};
const FRACTIONAL_UPKEEP: UpkeepDef = {
  id: asBuildingId('fractional'),
  name: 'Fractional',
  cost: 1,
  maintenance: 0.5,
};

const RULESET: RulesetView = {
  terrains: [TERRAIN],
  units: [WARRIOR, WORKER],
  buildings: [GRANARY],
  improvements: [],
  fidelity: 'tuned',
};

/** The same view with the upkept building, and one with nonsense upkeep rows. */
const UPKEEP_RULESET: RulesetView = { ...RULESET, buildings: [GRANARY, TEMPLE] };

const NONSENSE_RULESET: RulesetView = {
  ...RULESET,
  buildings: [ZERO_UPKEEP, NEGATIVE_UPKEEP, FRACTIONAL_UPKEEP],
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** A player with the money fields spelled out; every override is explicit. */
const player = (index: number, overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(0),
  kind: 'civ',
  treasury: 0,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
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
});

describe('unit support — the free allowance and the cost beyond it', () => {
  it('is FREE_UNITS_BASE with no cities, and FREE_UNITS_PER_CITY more per city', () => {
    const bare = board({ units: [] });
    expect(freeUnitAllowance(bare, P0)).toBe(FREE_UNITS_BASE);

    const cityful = board({ cities: [city(0, 0, 5), city(1, 0, 10), city(2, 1, 12)] });
    // Only the player's own cities count: two of the three, plus the base.
    expect(freeUnitAllowance(cityful, P0)).toBe(FREE_UNITS_PER_CITY * 2 + FREE_UNITS_BASE);
    expect(freeUnitAllowance(cityful, P1)).toBe(FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE);
  });

  it('charges nothing at exactly the free threshold and one unit’s cost one over', () => {
    const at = board({ units: unitStack(FREE_UNITS_BASE, 0) });
    expect(unitSupport(at, P0)).toEqual({
      units: FREE_UNITS_BASE,
      free: FREE_UNITS_BASE,
      supported: 0,
      gold: 0,
    });

    const over = board({ units: unitStack(FREE_UNITS_BASE + 1, 0) });
    expect(unitSupport(over, P0)).toEqual({
      units: FREE_UNITS_BASE + 1,
      free: FREE_UNITS_BASE,
      supported: 1,
      gold: UNIT_SUPPORT_COST,
    });
  });

  it('charges the same boundary one unit over a city allowance', () => {
    // Three cities: the allowance is 10, so ten units are free and the eleventh
    // costs one. The formula is the contract's, and it is pinned at its edge.
    const cities = [city(0, 0, 5), city(1, 0, 10), city(2, 0, 12)];
    const allowance = FREE_UNITS_PER_CITY * cities.length + FREE_UNITS_BASE;
    const at = board({ cities, units: unitStack(allowance, 0) });
    const over = board({ cities, units: unitStack(allowance + 1, 0) });

    expect(allowance).toBe(10);
    expect(unitSupport(at, P0).gold).toBe(0);
    expect(unitSupport(over, P0).gold).toBe(UNIT_SUPPORT_COST);
  });

  it('counts only the player’s own units — a barbarian band is on nobody’s bill', () => {
    const state = board({
      units: [...unitStack(FREE_UNITS_BASE + 2, 0), unit(90, WARRIOR, 1), unit(91, WARRIOR, 2)],
    });
    expect(unitSupport(state, P0).gold).toBe(2 * UNIT_SUPPORT_COST);
    expect(unitSupport(state, P1)).toEqual({
      units: 1,
      free: FREE_UNITS_BASE,
      supported: 0,
      gold: 0,
    });
    expect(unitSupport(state, BARBARIAN).units).toBe(1);
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
      // One city lifts the allowance to FREE_UNITS_PER_CITY + FREE_UNITS_BASE, so
      // nine units leave three billable.
      units: unitStack(FREE_UNITS_PER_CITY + FREE_UNITS_BASE + 3, 0),
    });

    expect(playerUpkeep(state, UPKEEP_RULESET, P0)).toEqual({
      maintenance: TEMPLE.maintenance,
      unitSupport: 3 * UNIT_SUPPORT_COST,
      gold: TEMPLE.maintenance + 3 * UNIT_SUPPORT_COST,
    });
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
        // The city lifts the allowance: FREE_UNITS_PER_CITY per city plus the base.
        freeUnits: FREE_UNITS_PER_CITY + FREE_UNITS_BASE,
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
        saved: UNIT_SUPPORT_COST,
      },
      {
        type: 'UnitDisbanded',
        playerId: P0,
        unitId: asUnitId(4),
        unitType: WARRIOR.id,
        tile: asTileIndex(0),
        saved: UNIT_SUPPORT_COST,
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
        freeUnits: FREE_UNITS_PER_CITY + FREE_UNITS_BASE,
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
    // 200 turns of two cities that earn 1 gold each and a temple each, with nine
    // units (one billable). The treasury drains, goes bankrupt once, disbands the
    // one unit it can, and then runs at a permanent 2-gold shortfall — which is
    // never a negative treasury, and is reported every turn it happens.
    //
    // On *every* turn the identity in the module note holds to the gold:
    //   after - before === income - upkeep + sum(disbanded.saved) + shortfall.unpaid
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
    // The run really did go bankrupt and stay short, rather than idling:
    // income 2 a turn, upkeep 5 (four of maintenance, one of support) — so the
    // first three turns are paid from the starting treasury, the fourth disbands
    // unit 8, and every turn after that reports the same 2 gold it cannot pay.
    expect(disbands).toBe(1);
    expect(shortfalls).toBe(197);
    expect(state.units.map((kept) => Number(kept.id))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(state.players[0]?.treasury).toBe(0);
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

    expect(unitSupport(without, P0).gold).toBe(0);
    expect(unitSupport(oneMore, P0).gold).toBe(UNIT_SUPPORT_COST);
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
