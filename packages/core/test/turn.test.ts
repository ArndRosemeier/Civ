/**
 * The turn pipeline as a whole — `advanceTurn` (docs/INTERFACES.md M4b, "Where the
 * money loop runs").
 *
 * The steps' internals are pinned in their own files (`improvements.test.ts`,
 * `cities.test.ts`, `production.test.ts`, `economy.test.ts`). What is pinned
 * *here* is the thing only this file can see: **the order**, and the two orderings
 * M4b adds a step in the middle of.
 *
 * - The event list is the pipeline, in order. Every step emits into one list, so
 *   "what happened this turn" is readable in the sequence the contract fixes:
 *   work, growth, production, money.
 * - **A unit produced this turn costs support this turn.** Production runs before
 *   the money loop, so a unit that appears in step 3 is on its owner's bill in step
 *   4 — the same turn. Running the money loop first would give every unit ever
 *   built one free turn of support, which is a different game and a difference the
 *   second test below measures.
 * - **A building that completes this turn is billed this turn**, for the same
 *   reason: maintenance is read from the state production just wrote.
 * - And the money loop is the *last* thing before the movement refill, so a
 *   disbanded unit is gone before anything gives movement back — there is no step
 *   after it that could resurrect one.
 *
 * M5's research step slots between production and the money loop, and this file is
 * where that position is pinned — including the **beaker reading** it forces:
 * research spends the pool the *previous* turn's money loop left, never the science
 * the same turn's cities are about to produce. The reading is argued out at the top
 * of `tech.ts`; the last section below *measures* it, with a board where the other
 * reading would complete a tech a turn early.
 *
 * Every number is a **placeholder** rule of ours: the free-unit allowance, the
 * support cost and the rate total are unsourced and chosen to be playable (see
 * `economy.ts` and `state.ts`). Nothing here is claimed to be Civ 3's.
 */

import { describe, expect, it } from 'vitest';
import { hashValue } from '@civts/testing';
import { type BuildingDef, type City } from '../src/cities.js';
import { FREE_UNITS_PER_CITY, FREE_UNITS_BASE, UNIT_SUPPORT_COST } from '../src/economy.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTechId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
} from '../src/ids.js';
import { asImprovementId, type ImprovementDef } from '../src/improvements.js';
import type { GameMap, RulesetView, TerrainDef } from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import { withResearching, type TechDef } from '../src/tech.js';
import { advanceTurn } from '../src/turn.js';
import type { Unit, UnitDef } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const GRASSLAND = asTerrainId('grassland');

/** 2 food, 1 shield, 1 commerce: a city centre of this yields a surplus of 0 at
 * population 1 (`FOOD_PER_CITIZEN` is 2), so growth has to be asked for by
 * handing the city a full food box. */
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
  // M4c: the map carries the resources `generateWorld` placed, as sparse
  // `(tile, resource)` pairs. Empty here, so no bonus resource can quietly change
  // a city's shields or commerce and move the numbers this file pins. The key is
  // present and empty — it is part of `GameMap`, and therefore of every state hash.
  resources: [],
};

const makeUnitDef = (
  id: string,
  role: UnitDef['role'],
  cost: number,
  movement: number,
): UnitDef => ({
  id: asUnitTypeId(id),
  role,
  name: id,
  attack: 0,
  defense: 0,
  movement,
  cost,
  domain: 'land',
});

/** Cost 1, so a city whose pool covers 1 shield finishes one the same turn. */
const WARRIOR = makeUnitDef('warrior', 'military', 1, 1);
const WORKER = makeUnitDef('worker', 'worker', 1, 1);

const MINE: ImprovementDef = {
  id: asImprovementId('mine'),
  kind: 'mine',
  name: 'Mine',
  turns: 1,
  yields: { food: 0, shields: 1, commerce: 0 },
  allowedRoles: ['grassland'],
};

/**
 * A building that bills gold, so "billed the turn it completes" is visible.
 *
 * M4c made `maintenance` a **required** field of `BuildingDef` (and added
 * `effects`), so the local `UpkeepDef` interface this fixture used to declare — a
 * `BuildingDef` plus an upkeep the engine could read — is gone: the contract now
 * says what it was saying. `effects: []` is the honest way to write "this row does
 * nothing but cost shields and gold"; it is a legal row, not an unknown one.
 */
const TEMPLE: BuildingDef = {
  id: asBuildingId('temple'),
  name: 'Temple',
  cost: 1,
  maintenance: 2,
  effects: [],
};

/**
 * A building that multiplies its city's science, so "the effect is felt the turn it
 * is finished" is visible in the pool. `cost: 1` means a city whose shield box
 * covers one shield finishes it the turn it is set.
 *
 * 50 is a **placeholder** percentage, like every number in this file: it is
 * unsourced and chosen so that the rounding is observable — `applyEffectPct(2, 50)`
 * is 3, so a science of 2 becomes 3 and the difference shows up in the beaker pool
 * one turn later. It is not a Civ 3 figure.
 */
const LIBRARY: BuildingDef = {
  id: asBuildingId('library'),
  name: 'Library',
  cost: 1,
  maintenance: 0,
  effects: [{ kind: 'beaker-multiplier', pct: 50 }],
};

/**
 * Two rows of a tree, enough to measure the pipeline: a root (`pottery`, 5 beakers)
 * and a second-tier tech behind it (`masonry`, 9 beakers, requiring
 * `bronze-working`).
 *
 * The `RulesetView` in this checkout does not declare `techs` (`map.ts` predates
 * M5's content workstream by design), so the tree is stated as a local extension of
 * it — the same shape the field will take when it is declared, and the shape
 * `tech.ts` reads structurally.
 */
interface TechView extends RulesetView {
  readonly techs: readonly TechDef[];
}

const POTTERY: TechDef = {
  id: asTechId('pottery'),
  name: 'Pottery',
  era: 'ancient',
  cost: 5,
  requires: [],
};

const BRONZE_WORKING: TechDef = {
  id: asTechId('bronze-working'),
  name: 'Bronze Working',
  era: 'ancient',
  cost: 6,
  requires: [],
};

const RULESET: TechView = {
  terrains: [TERRAIN],
  units: [WARRIOR, WORKER],
  buildings: [TEMPLE, LIBRARY],
  improvements: [MINE],
  techs: [POTTERY, BRONZE_WORKING],
  fidelity: 'tuned',
};

/**
 * A city that earns **5 commerce a turn** — its grassland centre plus four worked
 * grassland tiles — at the default 6/4/0 rates, so the money loop's split is
 * `gold 3 / beakers 2 / luxuries 0` exactly (5 × 4 / 10 = 2, and the remainder of
 * the three floors goes to gold).
 *
 * Population 5 is what makes the four worked tiles legal: a citizen works one tile,
 * and the centre costs none. Food is 5 × 2 = 10 against 5 citizens eating 2 each, so
 * the surplus is exactly 0 and no city grows in the middle of a beaker assertion.
 */
const TRADING_CITY = (overrides: Partial<City> = {}): City =>
  city(0, 5, {
    population: 5,
    workedTiles: [asTileIndex(1), asTileIndex(4), asTileIndex(6), asTileIndex(9)],
    ...overrides,
  });

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const player = (index: number, overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(0),
  kind: 'civ',
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  // M5: `[]` is how this state says "knows no techs", and `researching` is absent
  // until an override sets it — absence being the only spelling of "not researching"
  // (see `PlayerState`). The M5 section at the bottom of this file is the one place
  // that sets both, and it sets them through the fixture's own overrides.
  techs: [],
  ...overrides,
});

const unit = (id: number, def: UnitDef, tile = 0, movementLeft = def.movement): Unit => ({
  id: asUnitId(id),
  type: def.id,
  owner: asPlayerId(0),
  tile: asTileIndex(tile),
  movementLeft,
});

/** A unit with a job on its own tile, `turnsLeft` turns from done. */
const working = (
  id: number,
  def: UnitDef,
  tile: number,
  kind: string,
  turnsLeft: number,
): Unit => ({
  ...unit(id, def, tile),
  work: { tile: asTileIndex(tile), kind: asImprovementId(kind), turnsLeft },
});

const city = (id: number, tile: number, overrides: Partial<City> = {}): City => ({
  id: asCityId(id),
  owner: asPlayerId(0),
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

const board = (overrides: Partial<GameState> = {}): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0), player(1)],
  nextUnitId: 100,
  units: [],
  explored: [Array.from({ length: 16 }, () => false), Array.from({ length: 16 }, () => false)],
  nextCityId: 100,
  cities: [],
  improvements: [],
  ...overrides,
});

const P0 = asPlayerId(0);

/** `count` warriors, ids `0..count-1`. */
const unitStack = (count: number): readonly Unit[] =>
  Array.from({ length: count }, (_unused, index) => unit(index, WARRIOR));

const eventTypes = (state: GameState): readonly string[] =>
  advanceTurn(state, RULESET).events.map((event) => event.type);

/* ------------------------------------------------------------------ *
 * The order
 * ------------------------------------------------------------------ */

describe('advanceTurn — the steps run in the contract’s order', () => {
  it('emits work, then growth, then production, then the money loop', () => {
    // One board that fires every step: a worker on its last turn of a job, a city
    // about to grow, the same city about to finish a unit, and a player with money
    // to collect. The event list *is* the order.
    const state = board({
      players: [player(0), player(1)],
      // A worker on its last turn of a mine, on tile 4 — which the city also works,
      // so the same tile supplies the growth's food and production's shields.
      units: [working(0, WORKER, 4, 'mine', 1)],
      cities: [
        city(0, 5, {
          foodBox: 9, // 2 food of surplus reaches the 10 the next citizen needs
          workedTiles: [asTileIndex(4)],
          production: { kind: 'unit', id: WARRIOR.id },
        }),
      ],
    });

    expect(eventTypes(state)).toEqual([
      'WorkCompleted',
      'CityGrew',
      'CityProduced',
      // The money loop is one step, and it reports *every* civilization, in
      // player-id order — including the one with nothing to report. That is what
      // makes the step a ledger a consumer can reconstruct the treasury from
      // (see `economy.ts`), rather than a stream of only the interesting turns.
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
    ]);
  });

  it('moves a disbanded unit nowhere: the money loop is the last step that changes units', () => {
    // Five units with no cities means one billable unit against an empty treasury,
    // so the pass disbands the highest id. It is gone from the state, and the
    // movement refill — which runs after — has nothing to give back to it.
    const state = board({
      players: [player(0, { treasury: 0 }), player(1)],
      units: unitStack(FREE_UNITS_BASE + 1),
    });

    const outcome = advanceTurn(state, RULESET);

    expect(outcome.state.units.map((kept) => Number(kept.id))).toEqual([0, 1, 2, 3]);
    expect(eventTypes(state)).toContain('UnitDisbanded');
  });

  it('is pure and deterministic: the same turn twice gives the same state and events', () => {
    const state = board({
      cities: [city(0, 5, { foodBox: 9, production: { kind: 'unit', id: WARRIOR.id } })],
      units: [unit(0, WORKER, 4)],
    });
    const before = hashValue(state);

    const first = advanceTurn(state, RULESET);
    const second = advanceTurn(state, RULESET);

    expect(hashValue(state)).toBe(before);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toEqual(second.events);
    expect(first.state.turn).toBe(state.turn + 1);
  });
});

/* ------------------------------------------------------------------ *
 * Production before money
 * ------------------------------------------------------------------ */

describe('a unit produced this turn costs support from the turn it appears', () => {
  it('bills the produced unit in the same turn, not the next one', () => {
    // The allowance is FREE_UNITS_BASE with no city plus FREE_UNITS_PER_CITY for
    // this one, so six units are free. The board holds exactly six and the city
    // finishes a seventh: because production runs *before* the money loop, the
    // bill already sees seven units and charges one gold for the extra one.
    const allowance = FREE_UNITS_PER_CITY + FREE_UNITS_BASE;
    const state = board({
      players: [player(0), player(1)],
      units: unitStack(allowance),
      cities: [city(0, 5, { shields: 1, production: { kind: 'unit', id: WARRIOR.id } })],
    });

    const outcome = advanceTurn(state, RULESET);
    const upkeep = outcome.events.find((event) => event.type === 'UpkeepPaid');

    expect(outcome.state.units).toHaveLength(allowance + 1);
    expect(eventTypes(state)).toContain('CityProduced');
    expect(upkeep).toEqual({
      type: 'UpkeepPaid',
      playerId: P0,
      gold: UNIT_SUPPORT_COST,
      maintenance: 0,
      unitSupport: UNIT_SUPPORT_COST,
      units: allowance + 1,
      freeUnits: allowance,
    });
  });

  it('charges nothing in the same turn when nothing is produced', () => {
    // The control for the test above: the identical board with no production at
    // all. The unit count stays at the allowance, so the bill is zero — the two
    // turns differ by exactly one unit and one gold of support, which is the
    // coupling the ordering creates.
    const allowance = FREE_UNITS_PER_CITY + FREE_UNITS_BASE;
    const state = board({
      players: [player(0), player(1)],
      units: unitStack(allowance),
      cities: [city(0, 5)],
    });

    const outcome = advanceTurn(state, RULESET);
    const upkeep = outcome.events.find((event) => event.type === 'UpkeepPaid');

    expect(outcome.state.units).toHaveLength(allowance);
    expect(eventTypes(state)).not.toContain('CityProduced');
    expect(upkeep).toEqual({
      type: 'UpkeepPaid',
      playerId: P0,
      gold: 0,
      maintenance: 0,
      unitSupport: 0,
      units: allowance,
      freeUnits: allowance,
    });
  });

  it('bills a building that completes this turn for this turn’s maintenance', () => {
    // The same rule one step further: maintenance is read from the state
    // production just wrote, so the temple's first bill is the turn it is finished.
    const withTemple = board({
      players: [player(0), player(1)],
      cities: [city(0, 5, { shields: 1, production: { kind: 'building', id: TEMPLE.id } })],
    });

    const outcome = advanceTurn(withTemple, RULESET);
    const upkeep = outcome.events.find((event) => event.type === 'UpkeepPaid');

    expect(eventTypes(withTemple)).toContain('CityProduced');
    expect(outcome.state.cities[0]?.buildings).toEqual([TEMPLE.id]);
    expect(upkeep).toEqual({
      type: 'UpkeepPaid',
      playerId: P0,
      gold: TEMPLE.maintenance,
      maintenance: TEMPLE.maintenance,
      unitSupport: 0,
      units: 0,
      freeUnits: FREE_UNITS_PER_CITY + FREE_UNITS_BASE,
    });
  });
});

/* ------------------------------------------------------------------ *
 * M5 — where research runs, and which pool it reads
 * ------------------------------------------------------------------ */

/**
 * The research step's position is fixed by the contract — after production, before
 * the money loop — and the reading of the beaker pool that follows from it is argued
 * out at the top of `tech.ts`. These tests *measure* it, because there are exactly
 * two ways to implement it and only one of them survives the second test below.
 *
 * The board is chosen so the two readings disagree: a city earning 2 beakers a turn
 * against a player who has banked 4 and is researching a 5-beaker tech. If research
 * ran *after* the money loop, the pool would be 4 + 2 = 6 >= 5 and the tech would
 * complete on the first turn. Running first, as the contract's order says, research
 * sees 4, banks this turn's 2, and completes at the start of the second turn.
 */
describe('advanceTurn — the research step', () => {
  it('runs after production and before the money loop, so the event list says so', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 5 }), POTTERY.id), player(1)],
      cities: [TRADING_CITY({ shields: 1, production: { kind: 'building', id: TEMPLE.id } })],
    });

    // Production finishes the temple, research finishes the tech, and only then does
    // the money loop collect — the event list *is* the order. The money loop reports
    // every civilization, in player order, which is why it contributes four lines.
    expect(eventTypes(state)).toEqual([
      'CityProduced',
      'TechResearched',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
    ]);
  });

  it('reads the pool the money loop has not yet filled — the pipeline-delay reading', () => {
    // The discriminating test. The player banks 4, is researching a 5-beaker tech,
    // and owns a city that will earn 2 beakers this turn. Under the rejected reading
    // (research after the money loop) the tech completes *this* turn; under the
    // contract's order it does not, because research reads what the last turn's
    // money loop left.
    const state = board({
      players: [withResearching(player(0, { beakers: 4 }), POTTERY.id), player(1)],
      cities: [TRADING_CITY()],
    });

    const first = advanceTurn(state, RULESET);

    expect(first.events.map((event) => event.type)).not.toContain('TechResearched');
    // This turn's 2 beakers *were* collected — they are banked, not lost, and not
    // spent: 4 + 2.
    expect(first.events).toContainEqual({
      type: 'IncomeCollected',
      playerId: P0,
      gold: 3,
      beakers: 2,
      luxuries: 0,
    });
    expect(first.state.players[0]?.beakers).toBe(6);
    expect(first.state.players[0]?.techs).toEqual([]);
    // The choice survives the turn: nothing clears `researching` except a completion.
    expect(first.state.players[0]?.researching).toBe('pottery');

    // And at the start of the next turn those 6 beakers are there to spend: the
    // completion is reported with the remainder it leaves (6 - 5), and the next
    // collection adds to that.
    const second = advanceTurn(first.state, RULESET);
    expect(second.events).toContainEqual({
      type: 'TechResearched',
      playerId: P0,
      tech: 'pottery',
      cost: 5,
      beakers: 1,
    });
    expect(second.state.players[0]?.techs).toEqual([asTechId('pottery')]);
    expect(second.state.players[0]?.beakers).toBe(3); // 1 carried over, plus this turn's 2
    expect(Object.hasOwn(second.state.players[0] ?? player(0), 'researching')).toBe(false);
  });

  it('banks beakers for a player who is researching nothing', () => {
    // No selection, no spending: the pool grows and nothing else happens. That is
    // what makes stockpiling a legitimate (if wasteful) choice rather than a loss.
    const state = board({ players: [player(0), player(1)], cities: [TRADING_CITY()] });

    const outcome = advanceTurn(state, RULESET);

    expect(outcome.events.some((event) => event.type === 'TechResearched')).toBe(false);
    expect(outcome.state.players[0]?.beakers).toBe(2);
    expect(outcome.state.players[0]?.techs).toEqual([]);
  });

  it('lets a science building finished this turn multiply this turn’s science', () => {
    // Why the research step is *after* production, and the whole of the "effect
    // finished this turn contributes this turn" rule as it reaches the beaker pool:
    // the library is completed in step 3, the money loop in step 5 reads the city's
    // effects — which now include it — so a science of 2 becomes 3, and that extra
    // beaker is what completes a tech at the start of the next turn.
    const state = board({
      players: [withResearching(player(0, { beakers: 3 }), POTTERY.id), player(1)],
      cities: [TRADING_CITY({ shields: 1, production: { kind: 'building', id: LIBRARY.id } })],
    });

    const first = advanceTurn(state, RULESET);

    // 3 banked cannot cover 5, so nothing completes — but the library was finished
    // and this turn's collection is already multiplied: `applyEffectPct(2, 50)` is 3.
    expect(first.events.map((event) => event.type)).toContain('CityProduced');
    expect(first.state.cities[0]?.buildings).toEqual([LIBRARY.id]);
    expect(first.events).toContainEqual({
      type: 'IncomeCollected',
      playerId: P0,
      gold: 3,
      beakers: 3,
      luxuries: 0,
    });
    expect(first.state.players[0]?.beakers).toBe(6);

    // The next turn spends it: 6 covers the 5-beaker tech, leaving 1.
    const second = advanceTurn(first.state, RULESET);
    expect(second.events).toContainEqual({
      type: 'TechResearched',
      playerId: P0,
      tech: 'pottery',
      cost: 5,
      beakers: 1,
    });
  });

  it('carries the remainder into whatever is researched next', () => {
    // The surplus is not refunded and not thrown away: it stays in the pool, so the
    // next choice is already partly paid for. 12 beakers against a 5-beaker tech
    // leaves 7, which is more than the 6 the second tech costs.
    const rich = board({
      players: [withResearching(player(0, { beakers: 12 }), POTTERY.id), player(1)],
    });

    const first = advanceTurn(rich, RULESET);
    expect(first.state.players[0]?.beakers).toBe(7);
    expect(first.events).toContainEqual({
      type: 'TechResearched',
      playerId: P0,
      tech: 'pottery',
      cost: 5,
      beakers: 7,
    });

    // Choose the next tech *without* touching the pool, and the banked 7 pays for it
    // next turn: the carry-over is real spending power, not a number on an event.
    const reselected: GameState = {
      ...first.state,
      players: first.state.players.map((p) =>
        p.id === P0 ? withResearching(p, BRONZE_WORKING.id) : p,
      ),
    };
    const second = advanceTurn(reselected, RULESET);

    expect(second.events).toContainEqual({
      type: 'TechResearched',
      playerId: P0,
      tech: 'bronze-working',
      cost: 6,
      beakers: 1,
    });
    // Sorted and unique, through the pipeline rather than through a helper: the list
    // is part of every state hash, so its order is not a detail.
    expect([...(second.state.players[0]?.techs ?? [])].map(String)).toEqual([
      'bronze-working',
      'pottery',
    ]);
  });

  it('does not double-credit: research never adds to the pool', () => {
    // The conservation check behind the reading above. A turn with no city and no
    // income must leave the pool *exactly* where it was when nothing completed, and
    // leave it at banked-minus-cost when something did — never banked-minus-cost-plus
    // something.
    const idle = board({
      players: [withResearching(player(0, { beakers: 2 }), POTTERY.id), player(1)],
    });
    expect(advanceTurn(idle, RULESET).state.players[0]?.beakers).toBe(2);

    const completing = board({
      players: [withResearching(player(0, { beakers: 5 }), POTTERY.id), player(1)],
    });
    expect(advanceTurn(completing, RULESET).state.players[0]?.beakers).toBe(0);
  });

  it('is deterministic: the same board twice gives the same state and the same events', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 4 }), POTTERY.id), player(1)],
      cities: [TRADING_CITY()],
    });
    const before = hashValue(state);

    const first = advanceTurn(state, RULESET);
    const second = advanceTurn(state, RULESET);

    expect(hashValue(state)).toBe(before);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toEqual(second.events);
  });
});
