/**
 * M4c adversarial review (Y5: integration owner for M4c, then adversarial review)
 * — an attempt to **falsify** the frozen M4c contracts in docs/INTERFACES.md
 * ("M4c contracts — FROZEN (buildings, wonders, resources)"), not to confirm them.
 *
 * This file was written after driving `pnpm verify` green, and it starts from the
 * code that exists on disk rather than from the prose. What it attacks, section by
 * section:
 *
 * 1. **The keystone, with M4c's production gate inside it.** Every command
 *    `legalActions`/`unitActions` yields must apply, and every command
 *    `applyCommand` accepts must be yielded by *both* generators — checked against
 *    an exhaustive candidate universe (every tile for `MoveUnit`, `FoundCity`, one
 *    `StartWork` per catalog kind, `CancelWork`, `EndTurn`) over played games.
 *    M4c's addition is the resource-gated production path: `SetProduction` is
 *    planner-only (the M3 setters' precedent, re-stated by M4b's amendment), so the
 *    property asserted is the one that matters — for **every** item in the catalog,
 *    `cityProductionOptions` (the UI's menu), `planSetProduction` (the planner) and
 *    `applyCommand` (the applier) give the *same* verdict, and for the gated unit
 *    that verdict is `resourceGate`'s.
 * 2. **Effects exact and compounding.** Every multiplier is re-derived by hand:
 *    the percentages are summed from the catalog rows *here*, and the expected
 *    shields/commerce/beakers are computed from the contract's own
 *    `floor(value * (100 + pct) / 100)` — never by calling `applyEffectPct`. The
 *    sweep is *exhaustive over all 2^8 subsets of the eight shipped buildings*, and
 *    it counts the subsets where flooring twice would give a **different** number,
 *    so "sum first, floor once" is shown to be load-bearing rather than
 *    accidentally equivalent. A fractional, negative or unknown effect is refused
 *    by `validateRuleset`.
 * 3. **One implementation of availability.** A hunt for a second code path that
 *    decides resource availability or city yields: the four M4c availability
 *    askers (`mayStartBuilding`, `availableBuildings`, `cityProductionOptions`,
 *    `planSetProduction`) plus the applier are compared to each other on every
 *    state a sweep visits; the connection's monotonicity under play is proved; and
 *    the REPL's own printed claim is compared with the engine's answer through the
 *    real CLI.
 * 4. **Wonders, including the same-turn race.** Globally unique under every order
 *    of play: two civilizations completing the same wonder on the **same turn**, in
 *    both city-id orders, with the loser's queue dropped and nothing charged; never
 *    double-built over a walk; counted exactly once in the world's effects;
 *    re-buildable after the bankruptcy that disbanded it.
 * 5. **Connection, hand-computed.** A road chain broken in the middle, a resource
 *    on the city tile, two resources sharing a tile, an 8-way diagonal, "endpoints
 *    inclusive", a chain with no length limit, and a barbarian city granting
 *    nobody anything.
 * 6. **Money still conserves with maintenance in play**, over 120 turns on a board
 *    whose buildings are affordable every turn and 60 on one whose maintenance
 *    bankrupts its owner and is paid for with the buildings themselves. Gold is
 *    re-derived from the events each turn, the ledger identity is asserted to the
 *    piece, and the treasury is never negative.
 * 7. **Determinism**, in-process and in a **fresh process** (`npx tsx -e`), over a
 *    recorded game that founds cities and builds improvements: the same seed and
 *    the same commands give the same hash, the same gold, the same buildings, the
 *    same improvement count and the same connected set.
 * 8. **Whether the goldens are still a real gate**, and which of the invariants
 *    above are checked by something *permanent* rather than only by this file. The
 *    audit is in the closing comment, and where a gap exists it is named.
 *
 * Findings, stated here so they are not only in the review report:
 *
 * - **FINDING 1 (substantive, FIXED AND NOW PINNED): `growth-food` was declared,
 *   validated and tested as a read — and applied to nothing.** The frozen contract
 *   says "`growth-food` reduces the food a city needs to grow (it is the granary)".
 *   The read existed and was correct (`buildings.ts`'
 *   `growthFoodNeeded`/`cityGrowthTarget`, floored at `MIN_GROWTH_FOOD`), but
 *   **nothing in the engine called it**: `growth.ts`' `applyGrowth` compared the food
 *   box against the bare `foodBoxSize(population)`, and the REPL printed the same
 *   unmodified threshold. So the shipped **granary** (10 shields) and the shipped
 *   **Pyramids** (30 shields, 2 gold/turn, the milestone's only wonder) delivered
 *   *nothing at all* in play. Reported as a contract-level decision rather than fixed
 *   in this file, because wiring it moves populations and therefore state hashes
 *   across the M3/M4a/M4b sweeps.
 *
 *   **The chief of staff took that decision; the fix has landed** (`applyGrowth`
 *   compares the box against `cityGrowthTarget`, the REPL prints the reduced
 *   threshold, and the three goldens were regenerated — see section 2b, which pins
 *   the fixed behaviour turn by turn, and section 2's "FINDING 1, closed", which is
 *   the old discriminating board re-asserted at the boundary it found). What this
 *   file asserted before the fix was the *divergence*; what it asserts now is the
 *   contract, which is strictly stronger, and the mutation check recorded at the end
 *   of this file shows the new cases going red when the wiring is reverted by hand.
 *   The obsolete reading — "a gap in the frozen contract's effect list that M4c's own
 *   acceptance evidence conspicuously does not mention, so no shipped test would have
 *   caught it" — is kept here only to say that it is what happened: the acceptance
 *   evidence still does not mention food, and this file (with `growth.test.ts` and
 *   `scenarios.test.ts`) is what would catch a regression.
 * - **FINDING 2 (defensive asymmetry, unreachable — reported as "no finding" with
 *   the proof): the resource gate is re-checked at completion for buildings but not
 *   for units.** `production.ts` calls `mayStartBuilding` before completing a
 *   building (which is what makes the wonder race safe) but completes a queued
 *   *unit* without asking `resourceGate` again. Section 3 proves this is
 *   unreachable through the command layer: in M4c nothing removes a road
 *   (`withoutImprovement` has no caller outside tests — checked) and nothing
 *   destroys a city, so a player's connected set is monotonically non-decreasing
 *   under play and a gate that was open when the item was queued is still open when
 *   it completes. A hand-built or hand-edited save that acquired the queued item
 *   *and* lost the road would complete it, so the asymmetry deserves a one-line
 *   comment in `production.ts`; it is not a defect this milestone can reach.
 * - **No other finding.** The keystone held in both directions on every state
 *   swept, including the resource-gated production path; the multipliers were exact
 *   on all 256 building subsets and the compound rule is discriminating; the wonder
 *   race resolved to exactly one holder in both orders; the connection walk matched
 *   every hand-computed case; money conserved to the piece over 240 player-turns
 *   with maintenance in play; and the hashes reproduced in a fresh process.
 *
 * **Re-verification of the growth-food fix (Z2, the integration owner for it).**
 * Section 2b is the adversarial half of that fix, and it is written to fail against
 * the old behaviour: the effect is asserted as *applied* (a granary city and an
 * identical control city in one state growing on different turns, with the exact
 * turns, remainders and thresholds), as *reachable through the command layer*, as
 * *observable through the multi-growth loop and through carry-over alone*, as
 * *owned by the Pyramids* — M4c's only wonder, whose sole declared effect was inert
 * before this fix — and as *floored*, so no combination of shipped `growth-food`
 * rows can make a city grow instantly or divide by zero. The control city in every
 * one of those cases is asserted to be **unchanged** by the wiring, so the fix is
 * pinned to be exactly the effect and nothing more. "No finding" for everything the
 * fix did not touch is reported as such rather than dressed up as a discovery.
 *
 * Evidence quality, stated so this file is not oversold:
 *
 * - Every sweep is *seeded* (a local integer-hash PRNG, never `Math.random`), so a
 *   failing run reproduces exactly; nothing here reads a clock.
 * - The arithmetic is re-derived here from the contract and from the catalog rows,
 *   never called from the module under test: the percentages, the floors, the
 *   support formula, the maintenance sum and the building-disband rule are all
 *   restated.
 * - Provenance: nothing here blesses a number as Civ 3's. The catalog's rows are
 *   read as the project's own `placeholder` content; the effect magnitudes, the
 *   maintenance bills, the free allowance and the support cost are the project's
 *   placeholders, and no Civ 3 figure is asserted or implied.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  FREE_UNITS_BASE,
  FREE_UNITS_PER_CITY,
  MIN_GROWTH_FOOD,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  UNIT_SUPPORT_COST,
  advanceTurn,
  applyCommand,
  applyEconomy,
  applyGrowth,
  applyProduction,
  asBuildingId,
  asCityId,
  asPlayerId,
  asTileIndex,
  asUnitTypeId,
  availableBuildings,
  bonusYieldsAt,
  buildingCatalog,
  buildingHolder,
  cityBuildingEffects,
  cityById,
  cityGrowthTarget,
  cityProductionOptions,
  cityYields,
  effectTotals,
  foodBoxSize,
  growthFoodNeeded,
  isConnected,
  isWonder,
  legalActions,
  maintenanceOf,
  mayStartBuilding,
  newGame,
  placeholder,
  planSetProduction,
  playerIncome,
  resourceGate,
  spawnUnit,
  splitCommerce,
  tileIndex,
  unitActions,
  unitCatalog,
  unitDef,
  type BuildingDef,
  type BuildingEffect,
  type City,
  type CityId,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type PlayerId,
  type ProductionItem,
  type ResourceId,
  type RulesetView,
  type Settings,
  type TileIndex,
  type Unit,
  type UnitTypeId,
} from '@civts/core';
import { CATALOG, validateRuleset, type BuildingSpec } from '@civts/rules';
import { createScenarioBuilder, hashValue, type ScenarioBuilder } from '../src/index.js';
import { loadGoldens } from '../src/goldens.js';

/* ------------------------------------------------------------------ *
 * Fixtures: the real content the CLI runs on, and the ids this file
 * names. Nothing here restates a catalog number: every magnitude is read
 * from `CATALOG` where it is used.
 * ------------------------------------------------------------------ */

const RULESET: RulesetView = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((e) => e.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

/** A catalog row by role, or a thrown fixture error naming the gap. */
const unitOfRole = (role: 'settler' | 'worker' | 'military'): UnitTypeId => {
  const def = RULESET.units.find((unit) => unit.role === role);
  if (def === undefined) throw new Error(`the shipped catalog defines no ${role}-role unit`);
  return def.id;
};

const SETTLER: UnitTypeId = unitOfRole('settler');
const MILITARY: UnitTypeId = unitOfRole('military');

/** M4c's one resource-gated unit, found by *requirement* rather than by id. */
const GATED_UNIT: UnitTypeId = (() => {
  const def = RULESET.units.find((unit) => unit.requiresResource !== undefined);
  if (def === undefined) throw new Error('the shipped catalog gates no unit on a resource');
  return def.id;
})();

const GATED_RESOURCE: ResourceId = (() => {
  const def = RULESET.units.find((unit) => unit.requiresResource !== undefined);
  const required = def?.requiresResource;
  if (required === undefined) throw new Error('the gated unit names no resource');
  return required;
})();

/** A resource of each kind, found by kind rather than by id. */
const resourceOfKind = (kind: 'strategic' | 'luxury' | 'bonus'): ResourceId => {
  const row = CATALOG.resources.find((def) => def.kind === kind);
  if (row === undefined) throw new Error(`the shipped catalog ships no ${kind} resource`);
  return row.id;
};

const STRATEGIC = resourceOfKind('strategic');
const LUXURY = resourceOfKind('luxury');
const BONUS = resourceOfKind('bonus');

/** The shipped road *kind*'s id, read the way `resources.ts` reads it. */
const ROAD = (() => {
  const row = CATALOG.improvements.find((def) => def.kind === 'road');
  if (row === undefined) throw new Error('the shipped catalog defines no road improvement');
  return row.id;
})();

const PYRAMIDS: BuildingDef = (() => {
  const row = buildingCatalog(RULESET).find((def) => isWonder(def));
  if (row === undefined) throw new Error('the shipped catalog ships no wonder');
  return row;
})();

const PYRAMIDS_ID = PYRAMIDS.id;
const PYRAMIDS_MAINTENANCE = maintenanceOf(PYRAMIDS);

/** The row of the catalog a city's building list names, or a thrown fixture error. */
const catalogRow = (id: BuildingDef['id']): BuildingDef => {
  const row = buildingCatalog(RULESET).find((def) => def.id === id);
  if (row === undefined) throw new Error(`the shipped catalog does not describe "${String(id)}"`);
  return row;
};

const GRANARY = catalogRow(asBuildingId('granary'));

/** Every ordinary (non-wonder) shipped building, in catalog order. */
const ORDINARY_ROWS: readonly BuildingDef[] = buildingCatalog(RULESET).filter(
  (def) => !isWonder(def),
);

/**
 * Every shipped building **including the wonder**, in catalog order: the effect
 * sweep's universe, so that the subsets it walks are all 2^8 of the rows the
 * catalog actually ships rather than a filtered sample.
 */
const ALL_ROWS: readonly BuildingDef[] = buildingCatalog(RULESET);

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

const DUEL: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };
const DUEL_WIDTH = 40;

/** A deterministic 32-bit PRNG: no sweep may depend on anything ambient. */
const makePrng = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
};

/** An accumulating recorder, so a sweep reports everything it found in one run. */
interface Recorder {
  readonly problems: string[];
  check(condition: boolean, message: string): void;
}

const recorder = (): Recorder => {
  const problems: string[] = [];
  return {
    problems,
    check(condition: boolean, message: string): void {
      if (!condition) problems.push(message);
    },
  };
};

const failuresOf = (rec: Recorder): readonly string[] => rec.problems;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Freeze a state (and everything under it), so a mutation is a thrown TypeError. */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/** Can this state be hashed at all? The "explicit `undefined`" bug class, caught. */
const isHashable = (state: GameState): boolean => {
  try {
    hashValue(state);
    return true;
  } catch {
    return false;
  }
};

/**
 * A stable key for a command, so two generators can be compared as sets. The
 * switch is exhaustive on purpose: a new `Command` variant that is not keyed here
 * is a *typecheck* failure rather than a silently equal pair of different commands.
 */
const cmdKey = (cmd: Command): string => {
  switch (cmd.type) {
    case 'EndTurn':
      return 'EndTurn';
    case 'MoveUnit':
      return `MoveUnit ${String(cmd.unitId)} -> ${String(cmd.to)}`;
    case 'FoundCity':
      return `FoundCity ${String(cmd.unitId)}`;
    case 'SetWorkedTiles':
      return `SetWorkedTiles ${String(cmd.cityId)} [${cmd.tiles.map(String).join(',')}]`;
    case 'SetProduction':
      return `SetProduction ${String(cmd.cityId)} ${cmd.item.kind}:${String(cmd.item.id)}`;
    case 'StartWork':
      return `StartWork ${String(cmd.unitId)} ${String(cmd.kind)}`;
    case 'CancelWork':
      return `CancelWork ${String(cmd.unitId)}`;
    case 'SetRates':
      return `SetRates ${String(cmd.rates.tax)}/${String(cmd.rates.science)}/${String(
        cmd.rates.luxury,
      )}`;
  }
};

const itemKey = (item: ProductionItem): string => `${item.kind}:${String(item.id)}`;

const errorText = (error: GameError): string => JSON.stringify(error);

const playerOf = (state: GameState, playerId: PlayerId): GameState['players'][number] | undefined =>
  state.players.find((player) => player.id === playerId);

const civIdsOf = (state: GameState): readonly PlayerId[] =>
  state.players.filter((player) => player.kind === 'civ').map((player) => player.id);

const cityOf = (state: GameState, id: CityId): City => {
  const city = cityById(state, id);
  if (city === undefined) throw new Error(`no city ${String(id)} in this state`);
  return city;
};

/** `state` with `city`'s buildings replaced — a pure read-side edit, never a rule. */
const withBuildings = (
  state: GameState,
  cityId: CityId,
  buildings: readonly BuildingDef['id'][],
): GameState => ({
  ...state,
  cities: state.cities.map((city) => (city.id === cityId ? { ...city, buildings } : city)),
});

/** The movement refill, restated so the replicated pipeline can match `advanceTurn`. */
const refilled = (unit: Unit): Unit => {
  const def = unitDef(RULESET, unit.type);
  return def === undefined ? unit : { ...unit, movementLeft: def.movement };
};

/** `spawnUnit` with the def resolved here, so a caller names a type id. */
const spawnUnitAt = (state: GameState, type: UnitTypeId, owner: PlayerId, tile: TileIndex) => {
  const def = unitDef(RULESET, type);
  if (def === undefined) throw new Error(`the shipped catalog defines no "${String(type)}"`);
  return spawnUnit(state, def, owner, tile);
};

/* ------------------------------------------------------------------ *
 * Boards: hand-built worlds through the scenario DSL, and generated ones
 * through `newGame`. Nothing here writes a ruleset of its own.
 * ------------------------------------------------------------------ */

const twoCivs = (): ScenarioBuilder =>
  createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2, seed: 5 })
    .addPlayer('A')
    .addPlayer('B');

/** A board whose two capitals stand far apart, on open grassland. */
const capitals = (): ScenarioBuilder =>
  twoCivs().fillTerrain('grassland').addUnit(0, SETTLER, [5, 5]).addUnit(1, SETTLER, [20, 20]);

/**
 * The same board with both capitals *founded* — the minimum a connection needs,
 * since the frozen rule quantifies over "some **city** of that player". Used
 * wherever the resource walk is the subject and the terrain under the city matters
 * (`setTile` before the city is added, so a capital can stand on hills).
 */
const settled = (): ScenarioBuilder =>
  capitals().addCity(0, [5, 5], { population: 1 }).addCity(1, [20, 20], { population: 1 });

const built = (builder: ScenarioBuilder): GameState => {
  const result = builder.build();
  if (!result.ok) throw new Error(`the fixture must build: ${JSON.stringify(result.error)}`);
  return result.value;
};

const mustStart = (seed: number, civCount = DUEL.civCount): GameState => {
  const settings: Settings = { ...DUEL, seed, civCount };
  const result = newGame(seed, settings, RULESET);
  if (!result.ok) throw new Error(`newGame(${String(seed)}) failed`);
  return result.value;
};

/** `tile` for the duel board's coordinates, so a hand-computed case reads as x,y. */
const at = (x: number, y: number): TileIndex => {
  if (x < 0 || y < 0 || x >= DUEL_WIDTH || y >= DUEL_WIDTH) {
    throw new Error(`(${String(x)}, ${String(y)}) is outside the duel board`);
  }
  return tileIndex(DUEL_WIDTH, x, y);
};

/* ------------------------------------------------------------------ *
 * Event readers: the event stream is the ledger, so these are how the
 * sweeps re-derive what a turn did. Predicates rather than casts.
 * ------------------------------------------------------------------ */

type IncomeEvent = Extract<GameEvent, { type: 'IncomeCollected' }>;
type UpkeepEvent = Extract<GameEvent, { type: 'UpkeepPaid' }>;
type DisbandEvent = Extract<GameEvent, { type: 'UnitDisbanded' }>;
type ShortfallEvent = Extract<GameEvent, { type: 'TreasuryShortfall' }>;
type ProducedEvent = Extract<GameEvent, { type: 'CityProduced' }>;

const incomeEventsOf = (events: readonly GameEvent[]): readonly IncomeEvent[] =>
  events.filter((event): event is IncomeEvent => event.type === 'IncomeCollected');

const upkeepEventsOf = (events: readonly GameEvent[]): readonly UpkeepEvent[] =>
  events.filter((event): event is UpkeepEvent => event.type === 'UpkeepPaid');

const disbandEventsOf = (events: readonly GameEvent[]): readonly DisbandEvent[] =>
  events.filter((event): event is DisbandEvent => event.type === 'UnitDisbanded');

const shortfallEventsOf = (events: readonly GameEvent[]): readonly ShortfallEvent[] =>
  events.filter((event): event is ShortfallEvent => event.type === 'TreasuryShortfall');

const producedEventsOf = (events: readonly GameEvent[]): readonly ProducedEvent[] =>
  events.filter((event): event is ProducedEvent => event.type === 'CityProduced');

const isMoneyEvent = (
  event: GameEvent,
): event is IncomeEvent | UpkeepEvent | DisbandEvent | ShortfallEvent =>
  event.type === 'IncomeCollected' ||
  event.type === 'UpkeepPaid' ||
  event.type === 'UnitDisbanded' ||
  event.type === 'TreasuryShortfall';

const moneyEventsOf = (events: readonly GameEvent[]): readonly GameEvent[] =>
  events.filter(isMoneyEvent);

/* ------------------------------------------------------------------ *
 * 1. The keystone, with M4c's production gate inside it
 * ------------------------------------------------------------------ */

interface Offer {
  readonly player: PlayerId;
  readonly cmd: Command;
}

/** Every command each real player may issue right now, tagged with its actor. */
const offersFor = (state: GameState): readonly Offer[] => {
  const offers: Offer[] = [];
  for (const player of state.players) {
    for (const cmd of legalActions(state, RULESET, player.id)) {
      offers.push({ player: player.id, cmd });
    }
  }
  return offers;
};

/**
 * Every production item a city could be asked to build: the unit catalog then the
 * building catalog, each with duplicate ids collapsed — the same universe
 * `cityProductionOptions` searches, built here so the sweep is *complete* rather
 * than a sample.
 */
const itemUniverse = (): readonly ProductionItem[] => {
  const candidates: readonly ProductionItem[] = [
    ...unitCatalog(RULESET).map((def): ProductionItem => ({ kind: 'unit', id: def.id })),
    ...buildingCatalog(RULESET).map((def): ProductionItem => ({ kind: 'building', id: def.id })),
  ];
  const seen = new Set<string>();
  const items: ProductionItem[] = [];
  for (const item of candidates) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
};

/** The armies the sweep needs so that moves, support and bankruptcy all happen. */
const withArmy = (state: GameState, perPlayer: number): GameState => {
  let current = state;
  for (const player of state.players) {
    if (player.kind !== 'civ') continue;
    for (let n = 0; n < perPlayer; n += 1) {
      current = spawnUnitAt(current, MILITARY, player.id, player.startingTile).state;
    }
  }
  return current;
};

interface KeystoneTotals {
  states: number;
  legalYielded: number;
  generatorApplied: number;
  unitCandidates: number;
  applierAccepted: number;
  movesYielded: number;
  movesAccepted: number;
  workCandidates: number;
  workAccepted: number;
  workYielded: number;
  productionCandidates: number;
  productionAccepted: number;
  productionOffered: number;
  gatedBlocks: number;
  gatedOpens: number;
}

interface KeystoneRun {
  readonly failures: readonly string[];
  readonly totals: KeystoneTotals;
}

/**
 * Walk real games forward and check both directions of the keystone property, with
 * M4c's production path inside it.
 *
 * - **soundness**: every action `legalActions`/`unitActions` yields applies, bumps
 *   `revision` by exactly one, emits at least one event, and leaves a hashable state;
 * - **completeness**: every command `applyCommand` accepts is yielded by *both*
 *   generators, against an exhaustive candidate universe — every tile index for
 *   `MoveUnit` (not just the eight neighbours), `FoundCity`, one `StartWork` per
 *   catalog improvement, `CancelWork`, and `EndTurn` per player;
 * - **the production gate**: for every city and every item in the catalog, the
 *   applier's verdict, the planner's verdict, the menu `cityProductionOptions`
 *   offers and (for buildings) `availableBuildings` all agree — and for the gated
 *   unit that verdict is `resourceGate`'s, so the gate is not a fifth opinion but
 *   the one the other four ask.
 */
const keystoneSweep = (
  seeds: readonly number[],
  steps: number,
  start: (seed: number) => GameState = (seed) => withArmy(mustStart(seed), 4),
): KeystoneRun => {
  const rec = recorder();
  const items = itemUniverse();
  const totals: KeystoneTotals = {
    states: 0,
    legalYielded: 0,
    generatorApplied: 0,
    unitCandidates: 0,
    applierAccepted: 0,
    movesYielded: 0,
    movesAccepted: 0,
    workCandidates: 0,
    workAccepted: 0,
    workYielded: 0,
    productionCandidates: 0,
    productionAccepted: 0,
    productionOffered: 0,
    gatedBlocks: 0,
    gatedOpens: 0,
  };

  expect(items.length).toBeGreaterThan(0);

  for (const seed of seeds) {
    let state = start(seed);
    const prng = makePrng(seed);
    const where = (step: number, extra: string): string =>
      `seed ${String(seed)} step ${String(step)}: ${extra}`;

    for (let step = 0; step < steps; step += 1) {
      totals.states += 1;
      const frozenHash = hashValue(state);
      deepFreeze(state);

      const offers: Offer[] = [];

      for (const player of state.players) {
        const legal = new Set<string>();

        for (const cmd of legalActions(state, RULESET, player.id)) {
          const key = cmdKey(cmd);
          legal.add(key);
          totals.legalYielded += 1;

          const outcome = applyCommand(state, player.id, cmd, RULESET);
          if (!outcome.ok) {
            rec.check(
              false,
              where(
                step,
                `legalActions yielded ${key} but applyCommand refused it: ${errorText(
                  outcome.error,
                )}`,
              ),
            );
            continue;
          }
          totals.generatorApplied += 1;
          rec.check(
            outcome.value.state.revision === state.revision + 1,
            where(step, `${key} did not bump revision by exactly one`),
          );
          rec.check(
            outcome.value.events.length > 0,
            where(step, `${key} applied without emitting an event`),
          );
          rec.check(
            isHashable(outcome.value.state),
            where(step, `the state after ${key} cannot be hashed`),
          );
          offers.push({ player: player.id, cmd });
        }

        /**
         * M4c's gate, and the second half of the keystone for the production path:
         * one verdict, four askers, over the whole item universe.
         */
        for (const city of state.cities) {
          if (city.owner !== player.id) continue;
          const menu = new Set(
            cityProductionOptions(state, RULESET, city.id).map((item) => itemKey(item)),
          );
          const startable = new Set(
            availableBuildings(state, buildingCatalog(RULESET), city).map(
              (def) => `building:${String(def.id)}`,
            ),
          );

          for (const item of items) {
            totals.productionCandidates += 1;
            const applied = applyCommand(
              state,
              player.id,
              { type: 'SetProduction', cityId: city.id, item },
              RULESET,
            );
            const planned = planSetProduction(state, RULESET, city.owner, city.id, item);
            const offered = menu.has(itemKey(item));

            rec.check(
              applied.ok === planned.ok,
              where(
                step,
                `${String(city.id)} ${itemKey(item)}: the planner and the applier disagree ` +
                  `(plan ok=${String(planned.ok)}, applied ok=${String(applied.ok)})`,
              ),
            );
            rec.check(
              applied.ok === offered,
              where(
                step,
                `${String(city.id)} ${itemKey(item)}: applyCommand accepted=${String(
                  applied.ok,
                )} but cityProductionOptions offered=${String(offered)}`,
              ),
            );
            if (item.kind === 'building') {
              rec.check(
                startable.has(itemKey(item)) === offered,
                where(
                  step,
                  `${String(city.id)} ${itemKey(item)}: availableBuildings and ` +
                    `cityProductionOptions disagree`,
                ),
              );
            }

            // The gate itself, for every item: the verdict is `resourceGate`'s and
            // nothing else's. A building, and a unit that demands nothing, are
            // always open — which is the contract, not a coincidence.
            const required =
              item.kind === 'unit' ? unitDef(RULESET, item.id)?.requiresResource : undefined;
            const gateOpen = resourceGate(state, RULESET, city.owner, item).kind === 'open';
            const expectedOpen =
              required === undefined || isConnected(state, RULESET, city.owner, required);
            rec.check(
              gateOpen === expectedOpen,
              where(
                step,
                `${String(city.id)} ${itemKey(item)}: the gate says open=${String(
                  gateOpen,
                )} but the connection says ${String(expectedOpen)}`,
              ),
            );
            if (item.id === GATED_UNIT && item.kind === 'unit') {
              if (gateOpen) totals.gatedOpens += 1;
              else totals.gatedBlocks += 1;
              rec.check(
                offered === gateOpen && applied.ok === gateOpen,
                where(
                  step,
                  `the gated unit: offered=${String(offered)}, accepted=${String(
                    applied.ok,
                  )}, gate open=${String(gateOpen)}`,
                ),
              );
            }

            if (applied.ok) totals.productionAccepted += 1;
            if (offered) totals.productionOffered += 1;
          }
        }

        for (const unit of state.units) {
          if (unit.owner !== player.id) continue;

          const mine = new Set<string>();
          for (const cmd of unitActions(state, RULESET, unit.id)) {
            const key = cmdKey(cmd);
            mine.add(key);
            if (cmd.type === 'MoveUnit') totals.movesYielded += 1;

            const outcome = applyCommand(state, player.id, cmd, RULESET);
            if (!outcome.ok) {
              rec.check(
                false,
                where(
                  step,
                  `unitActions yielded ${key} but applyCommand refused it: ${errorText(
                    outcome.error,
                  )}`,
                ),
              );
            }
          }

          const compare = (cmd: Command): boolean => {
            const key = cmdKey(cmd);
            const outcome = applyCommand(state, player.id, cmd, RULESET);
            const yielded = mine.has(key);
            const listed = legal.has(key);
            if (outcome.ok) {
              rec.check(
                yielded,
                where(step, `applier ACCEPTED ${key} but unitActions never yields it (incomplete)`),
              );
              rec.check(
                listed,
                where(
                  step,
                  `applier ACCEPTED ${key} but legalActions never yields it (incomplete)`,
                ),
              );
            } else {
              rec.check(
                !yielded,
                where(
                  step,
                  `applier REFUSED ${key} but unitActions yields it: ${errorText(outcome.error)}`,
                ),
              );
              rec.check(
                !listed,
                where(
                  step,
                  `applier REFUSED ${key} but legalActions yields it: ${errorText(outcome.error)}`,
                ),
              );
            }
            return outcome.ok;
          };

          for (const kind of RULESET.improvements.map((def) => def.id)) {
            const cmd: Command = { type: 'StartWork', unitId: unit.id, kind };
            totals.workCandidates += 1;
            if (compare(cmd)) totals.workAccepted += 1;
            if (mine.has(cmdKey(cmd))) totals.workYielded += 1;
          }

          totals.workCandidates += 1;
          if (compare({ type: 'CancelWork', unitId: unit.id })) totals.workAccepted += 1;

          totals.unitCandidates += 1;
          if (compare({ type: 'FoundCity', unitId: unit.id })) totals.applierAccepted += 1;

          const size = state.map.width * state.map.height;
          for (let to = 0; to < size; to += 1) {
            const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to: asTileIndex(to) };
            totals.unitCandidates += 1;
            if (compare(cmd)) {
              totals.applierAccepted += 1;
              totals.movesAccepted += 1;
            }
          }
        }

        rec.check(
          applyCommand(state, player.id, { type: 'EndTurn' }, RULESET).ok === legal.has('EndTurn'),
          where(step, 'EndTurn disagrees with legalActions'),
        );
      }

      rec.check(
        hashValue(state) === frozenHash,
        where(step, 'the read-only sweep mutated the state'),
      );

      // The walk itself: one command, applied for real, on the state everything
      // above only read. M4c's own commands are preferred so the sweep reaches
      // cities, buildings and roads rather than only movement.
      const offersNow = offersFor(state);
      const preferred = [
        offersNow.filter((offer) => offer.cmd.type === 'FoundCity'),
        offersNow.filter((offer) => offer.cmd.type === 'StartWork'),
        offersNow.filter((offer) => offer.cmd.type === 'MoveUnit'),
        offersNow,
      ].find((list) => list.length > 0);
      const chosen = preferred === undefined ? undefined : preferred[prng() % preferred.length];
      if (chosen === undefined) break;

      const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
      if (!outcome.ok) {
        rec.check(
          false,
          where(
            step,
            `chosen action ${cmdKey(chosen.cmd)} was refused: ${errorText(outcome.error)}`,
          ),
        );
        break;
      }
      state = outcome.value.state;
      rec.check(isHashable(state), where(step, 'the resulting state cannot be hashed'));
    }
  }

  return { failures: rec.problems, totals };
};

describe('1. keystone — the generators, the applier and the production gate agree', () => {
  it('holds over played games, with the resource-gated production path swept exhaustively', () => {
    const { failures, totals } = keystoneSweep([1, 2, 3, 5, 8, 13], 5);

    console.log('m4c keystone totals:', JSON.stringify(totals));
    expect(failures).toEqual([]);

    // Non-vacuity: the sweep has to have walked a real game and reached both sides
    // of the resource gate, or "the gate agrees" is a statement about nothing.
    expect(totals.states).toBeGreaterThanOrEqual(24);
    expect(totals.legalYielded).toBeGreaterThan(500);
    expect(totals.generatorApplied).toBeGreaterThan(500);
    expect(totals.movesAccepted).toBeGreaterThan(0);
    expect(totals.workAccepted).toBeGreaterThan(0);
    expect(totals.productionCandidates).toBeGreaterThan(500);
    expect(totals.productionAccepted).toBeGreaterThan(0);
    expect(totals.productionOffered).toBeGreaterThan(0);
    expect(totals.gatedBlocks).toBeGreaterThan(0);
  }, 300_000);

  /**
   * The other side of the gate, on boards where it is **open**: hand-built worlds
   * (a generated map has no road to a resource) in which player 0's capital reaches
   * iron and player 1's does not, so every state of the sweep has one player whose
   * gated unit is offered and one whose is refused. That is the resource-gated
   * production path under the keystone rather than beside it.
   */
  it('holds where one player has iron connected and the other does not', () => {
    const start = (seed: number): GameState =>
      withArmy(
        built(
          settled()
            .setTile(8, 5, 'hills')
            .addResource(8, 5, STRATEGIC)
            .addImprovement(6, 5, ROAD)
            .addImprovement(7, 5, ROAD)
            .setTreasury(0, STARTING_TREASURY)
            .setTreasury(1, STARTING_TREASURY)
            .setRates(1, { tax: 5, science: 5, luxury: 0 }),
        ),
        2 + (seed % 3),
      );

    const { failures, totals } = keystoneSweep([4, 9, 16, 25], 4, start);

    console.log('m4c gated keystone totals:', JSON.stringify(totals));
    expect(failures).toEqual([]);
    // Both sides of the gate were really swept: the world has one connected player
    // and one unconnected one at every state.
    expect(totals.gatedOpens).toBeGreaterThan(0);
    expect(totals.gatedBlocks).toBeGreaterThan(0);
    expect(totals.productionOffered).toBeGreaterThan(totals.gatedBlocks);
    expect(totals.states).toBeGreaterThanOrEqual(16);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * 2. Effects: exact, compounding, and refused when malformed
 * ------------------------------------------------------------------ */

/** The percentages a row set declares for one kind of multiplier, summed here. */
const declaredPct = (
  rows: readonly BuildingDef[],
  kind: 'commerce-multiplier' | 'beaker-multiplier' | 'shield-multiplier',
): number => {
  let total = 0;
  for (const row of rows) {
    for (const effect of row.effects) {
      if (effect.kind === kind) total += effect.pct;
    }
  }
  return total;
};

const declaredGrowthFood = (rows: readonly BuildingDef[]): number => {
  let total = 0;
  for (const row of rows) {
    for (const effect of row.effects) {
      if (effect.kind === 'growth-food') total += effect.amount;
    }
  }
  return total;
};

/** The percentages of one kind, in the order the rows declare them. */
const pctsOf = (
  rows: readonly BuildingDef[],
  kind: 'commerce-multiplier' | 'shield-multiplier',
): readonly number[] =>
  rows.flatMap((row) =>
    row.effects.flatMap((effect) => (effect.kind === kind ? [effect.pct] : [])),
  );

/**
 * The contract's arithmetic, restated: `floor(value * (100 + pct) / 100)` applied to
 * each multiplier **in turn**. This is the reading the engine must *not* implement,
 * and the sweep below is what makes the difference observable.
 */
const floorEach = (value: number, pcts: readonly number[]): number =>
  pcts.reduce((running, pct) => Math.floor((running * (100 + pct)) / 100), value);

/**
 * The board the effect sweep uses: player 0's city on grassland with a grassland
 * and two plains worked, so its *unmultiplied* triple is 6 food / 6 shields /
 * 4 commerce — with population 3, so nothing grows or starves mid-sweep — plus a
 * second city of the **same** player far away, so "effects apply only to their own
 * city" has something to fail against.
 */
const effectBoard = (): GameState =>
  built(
    twoCivs()
      .fillTerrain('grassland')
      .setTile(5, 6, 'plains')
      .setTile(6, 6, 'plains')
      .setTile(21, 21, 'plains')
      .addUnit(0, SETTLER, [5, 5])
      .addUnit(1, SETTLER, [35, 35])
      .addCity(0, [5, 5], { population: 3, workedTiles: [at(6, 5), at(5, 6), at(6, 6)] })
      .addCity(0, [20, 20], { population: 2, workedTiles: [at(21, 21)] })
      .addCity(1, [35, 35], { population: 1 }),
  );

/** Every subset of `ALL_ROWS`, as a list of building ids. */
const buildingSubsets = (): readonly (readonly BuildingDef['id'][])[] => {
  const rows = ALL_ROWS;
  const subsets: BuildingDef['id'][][] = [];
  for (let mask = 0; mask < 1 << rows.length; mask += 1) {
    const subset: BuildingDef['id'][] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      if ((mask & (1 << index)) !== 0) subset.push(row.id);
    }
    subsets.push(subset);
  }
  return subsets;
};

describe('2. effects — exact per building set, compounded once, refused when malformed', () => {
  it('re-derives every multiplier by hand over all 256 shipped building subsets, and finds flooring twice differs', () => {
    const rec = recorder();
    const base = effectBoard();
    const playerId = asPlayerId(0);
    const effective = asCityId(0);
    const bareState = withBuildings(base, effective, []);
    const bare = cityYields(bareState, RULESET, effective);
    const rates = playerOf(base, playerId)?.rates ?? { tax: 6, science: 4, luxury: 0 };
    const population = cityOf(base, effective).population;

    // The base the multipliers scale, from the state with no buildings at all.
    expect({ food: bare.food, shields: bare.shields, commerce: bare.commerce }).toEqual({
      food: 6,
      shields: 6,
      commerce: 4,
    });
    expect(population).toBe(3);

    const otherId = asCityId(1);
    const otherBare = cityYields(bareState, RULESET, otherId);

    const subsets = buildingSubsets();
    let discriminating = 0;
    let examples = 0;
    let fullSets = 0;

    for (const subset of subsets) {
      const rows = subset.map(catalogRow);
      const state = withBuildings(base, effective, subset);
      const yields = cityYields(state, RULESET, effective);

      const shieldPct = declaredPct(rows, 'shield-multiplier');
      const commercePct = declaredPct(rows, 'commerce-multiplier');
      const beakerPct = declaredPct(rows, 'beaker-multiplier');

      const expectedCommerce = Math.floor((bare.commerce * (100 + commercePct)) / 100);
      const expectedShields = Math.floor((bare.shields * (100 + shieldPct)) / 100);
      const expectedBeakers = Math.floor(
        (splitCommerce(expectedCommerce, rates).beakers * (100 + beakerPct)) / 100,
      );

      rec.check(
        yields.commerce === expectedCommerce,
        `[${subset.join(', ')}]: commerce ${String(yields.commerce)} but floor(${String(
          bare.commerce,
        )} * ${String(100 + commercePct)} / 100) = ${String(expectedCommerce)}`,
      );
      rec.check(
        yields.shields === expectedShields,
        `[${subset.join(', ')}]: shields ${String(yields.shields)} but floor(${String(
          bare.shields,
        )} * ${String(100 + shieldPct)} / 100) = ${String(expectedShields)}`,
      );
      // No building multiplies food, and growth-food shrinks a requirement rather
      // than a yield: the triple's food is the base's, at every subset.
      rec.check(
        yields.food === bare.food,
        `[${subset.join(', ')}]: food moved to ${String(yields.food)}`,
      );

      const income = playerIncome(state, RULESET, playerId);
      const expectedSplit = splitCommerce(expectedCommerce, rates);
      // The player's *other* city is bare, so its own split is unscaled: the beaker
      // multiplier scales one city's channel and nobody else's.
      const otherSplit = splitCommerce(otherBare.commerce, rates);
      rec.check(
        income.beakers === expectedBeakers + otherSplit.beakers,
        `[${subset.join(', ')}]: beakers ${String(income.beakers)} but floor(${String(
          expectedSplit.beakers,
        )} * ${String(100 + beakerPct)} / 100) + ${String(otherSplit.beakers)} = ${String(
          expectedBeakers + otherSplit.beakers,
        )}`,
      );
      rec.check(
        income.gold === expectedSplit.gold + otherSplit.gold &&
          income.luxuries === expectedSplit.luxuries + otherSplit.luxuries,
        `[${subset.join(', ')}]: gold/luxuries moved with the beaker multiplier ` +
          `(${String(income.gold)}/${String(income.luxuries)} vs ${String(
            expectedSplit.gold + otherSplit.gold,
          )}/${String(expectedSplit.luxuries + otherSplit.luxuries)})`,
      );

      // "Effects apply only to their own city": the same player's other city must
      // not move, whatever the first city holds.
      const other = cityYields(state, RULESET, otherId);
      rec.check(
        other.shields === otherBare.shields &&
          other.commerce === otherBare.commerce &&
          other.food === otherBare.food,
        `[${subset.join(', ')}]: city 1's yields moved with city 0's buildings`,
      );

      // The compound rule, made load-bearing rather than accidentally equal.
      const shieldsFloorEach = floorEach(bare.shields, pctsOf(rows, 'shield-multiplier'));
      const commerceFloorEach = floorEach(bare.commerce, pctsOf(rows, 'commerce-multiplier'));
      const shieldsDiffer = shieldsFloorEach !== expectedShields;
      const commerceDiffer = commerceFloorEach !== expectedCommerce;
      if (shieldsDiffer || commerceDiffer) {
        discriminating += 1;
        if (examples < 4) {
          examples += 1;
          console.log(
            `compound example: [${subset.join(', ')}] shields ${String(bare.shields)} -> ` +
              `sum-first ${String(expectedShields)} vs floor-each ${String(shieldsFloorEach)}; ` +
              `commerce ${String(bare.commerce)} -> sum-first ${String(expectedCommerce)} vs ` +
              `floor-each ${String(commerceFloorEach)}`,
          );
        }
      }
      if (shieldsDiffer) {
        rec.check(
          yields.shields !== shieldsFloorEach,
          `[${subset.join(', ')}]: shields ${String(yields.shields)} equals the floor-each ` +
            `reading (${String(shieldsFloorEach)}) rather than the sum-first one (${String(
              expectedShields,
            )})`,
        );
      }
      if (commerceDiffer) {
        rec.check(
          yields.commerce !== commerceFloorEach,
          `[${subset.join(', ')}]: commerce ${String(yields.commerce)} equals the floor-each ` +
            `reading (${String(commerceFloorEach)}) rather than the sum-first one (${String(
              expectedCommerce,
            )})`,
        );
      }

      const growthFood = declaredGrowthFood(rows);
      const expectedTarget = Math.max(MIN_GROWTH_FOOD, foodBoxSize(population) - growthFood);
      rec.check(
        cityGrowthTarget(
          buildingCatalog(RULESET),
          cityOf(state, effective),
          foodBoxSize(population),
        ) === expectedTarget,
        `[${subset.join(', ')}]: the growth target is not max(${String(
          MIN_GROWTH_FOOD,
        )}, ${String(foodBoxSize(population))} - ${String(growthFood)})`,
      );

      if (subset.length === ALL_ROWS.length) fullSets += 1;
    }

    console.log(
      `m4c effect sweep: ${String(subsets.length)} subsets, ${String(discriminating)} where ` +
        'flooring twice differs',
    );
    expect(failuresOf(rec)).toEqual([]);
    expect(subsets).toHaveLength(1 << ALL_ROWS.length);
    expect(discriminating).toBeGreaterThan(0);
    expect(fullSets).toBe(1);

    // The discriminating case named rather than merely counted: the two shipped 25%
    // shield multipliers on 6 shields give 9 summed-first and 8 floored each.
    const shieldRows = ORDINARY_ROWS.filter((row) =>
      row.effects.some((effect) => effect.kind === 'shield-multiplier'),
    ).slice(0, 2);
    expect(shieldRows).toHaveLength(2);
    const pcts = pctsOf(shieldRows, 'shield-multiplier');
    expect(pcts).toHaveLength(2);
    const compounded = cityYields(
      withBuildings(
        base,
        effective,
        shieldRows.map((row) => row.id),
      ),
      RULESET,
      effective,
    );
    const summed = pcts.reduce((total, pct) => total + pct, 0);
    expect(compounded.shields).toBe(Math.floor((bare.shields * (100 + summed)) / 100));
    expect(floorEach(bare.shields, pcts)).not.toBe(compounded.shields);
  });

  it('refuses a fractional, negative or unknown effect, and floors the growth reduction at 1', () => {
    const withEffect = (effects: readonly BuildingEffect[]): BuildingSpec => ({
      id: asBuildingId('test-building'),
      name: 'Test Building',
      cost: 10,
      maintenance: 1,
      effects,
      provenance: placeholder('unsourced: a fixture row, declared here to be refused or read'),
    });

    const refusalKinds = (row: BuildingSpec): readonly string[] => {
      const validated = validateRuleset(
        { ...CATALOG, buildings: [...CATALOG.buildings, row] },
        'tuned',
      );
      return validated.ok ? [] : validated.error.map((error) => error.kind);
    };

    expect(refusalKinds(withEffect([{ kind: 'commerce-multiplier', pct: 2.5 }]))).toContain(
      'invalid-value',
    );
    expect(refusalKinds(withEffect([{ kind: 'shield-multiplier', pct: -25 }]))).toContain(
      'invalid-value',
    );
    expect(refusalKinds(withEffect([{ kind: 'beaker-multiplier', pct: Number.NaN }]))).toContain(
      'invalid-value',
    );
    expect(refusalKinds(withEffect([{ kind: 'growth-food', amount: 1.5 }]))).toContain(
      'invalid-value',
    );
    expect(refusalKinds(withEffect([{ kind: 'growth-food', amount: -1 }]))).toContain(
      'invalid-value',
    );
    expect(refusalKinds(withEffect([]))).toEqual([]);

    // A kind the union does not have: written as JSON, because "the row is not a
    // shape the type allows" is exactly what a foreign or newer ruleset produces.
    const unknown = JSON.parse('{"kind":"happiness","amount":1}') as BuildingEffect;
    expect(refusalKinds(withEffect([unknown]))).toContain('invalid-value');

    // The floor of 1: no amount can drive the threshold to zero, so a city can
    // always eventually grow and nothing divides by zero.
    const enormous = effectTotals([{ kind: 'growth-food', amount: 1000 }]);
    expect(growthFoodNeeded(10, enormous)).toBe(MIN_GROWTH_FOOD);
    expect(growthFoodNeeded(1, enormous)).toBe(MIN_GROWTH_FOOD);
    expect(growthFoodNeeded(foodBoxSize(4), effectTotals([]))).toBe(foodBoxSize(4));
    expect(effectTotals([])).toEqual({
      commercePct: 0,
      beakerPct: 0,
      shieldPct: 0,
      growthFood: 0,
    });
    expect(declaredGrowthFood([GRANARY])).toBe(1);
  });

  /**
   * FINDING 1, **closed** — and this case is the regression guard that keeps it closed
   * on the board that found it.
   *
   * The board is discriminating by construction: a city of one citizen on grassland
   * with one worked grassland tile runs a surplus of exactly 2, so a box of 7 reaches
   * **9** this turn — the granary's reduced requirement — and not the bare 10. Before
   * the fix, this case asserted the *divergence* (the read said 9, `applyGrowth` grew
   * on 10, and both cities did exactly the same thing). It now asserts the contract at
   * the same boundary, which is strictly stronger: the granary city must grow, the
   * identical control must not, and the difference must be exactly the one food the
   * shipped row declares.
   *
   * The turn-by-turn version — with the exact turns, remainders and thresholds, the
   * multi-growth and carry-over-only boards, the Pyramids through real production, the
   * floor under every shipped combination of `growth-food` rows and the fresh-process
   * determinism of the result — is section **2b** below.
   */
  it('FINDING 1, closed: the granary crosses its reduced threshold and the control does not', () => {
    const board = (buildings: readonly BuildingDef['id'][]) =>
      built(capitals().addCity(0, [5, 5], { population: 1, foodBox: 7, buildings }));

    const plain = board([]);
    const grand = board([GRANARY.id]);
    const city = asCityId(0);
    const granaryCity = cityOf(grand, city);
    const thresholdByContract = cityGrowthTarget(
      buildingCatalog(RULESET),
      granaryCity,
      foodBoxSize(granaryCity.population),
    );
    const yields = cityYields(grand, RULESET, city);

    // The read, the board and the boundary: box 7 + surplus 2 reaches the granary's
    // threshold of 9 **exactly**, and is one food short of the bare 10.
    expect(granaryCity.buildings).toEqual([GRANARY.id]);
    expect(foodBoxSize(1)).toBe(10);
    expect(declaredGrowthFood([GRANARY])).toBe(1);
    expect(thresholdByContract).toBe(10 - declaredGrowthFood([GRANARY]));
    expect(thresholdByContract).toBe(9);
    expect(yields.foodSurplus).toBe(2);
    expect(granaryCity.foodBox + yields.foodSurplus).toBe(thresholdByContract);
    // The control's yields are the same, so nothing but the building separates them.
    expect(cityYields(plain, RULESET, city)).toEqual(yields);

    const grownPlain = applyGrowth(plain, RULESET);
    const grownGranary = applyGrowth(grand, RULESET);

    // The granary city grows on this very turn, spending its 9 and carrying 0 over.
    expect(cityOf(grownGranary.state, city)).toMatchObject({ population: 2, foodBox: 0 });
    expect(grownGranary.events).toEqual([
      { type: 'CityGrew', cityId: city, owner: asPlayerId(0), population: 2, foodBox: 0 },
    ]);

    // ... and the identical control does not: 9 is not 10. Before the wiring these two
    // event lists were equal, which is exactly what made the granary — and the Pyramids —
    // worth 10 and 30 shields and nothing else.
    expect(cityOf(grownPlain.state, city)).toMatchObject({ population: 1, foodBox: 9 });
    expect(grownPlain.events).toEqual([]);
    expect(grownGranary.events).not.toEqual(grownPlain.events);

    // The only declared effect of M4c's wonder is the same one, so the wonder's
    // inertness was this defect and not a separate one.
    expect(PYRAMIDS.effects).toEqual([{ kind: 'growth-food', amount: 1 }]);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. Growth food — the effect is APPLIED (the fix to FINDING 1)
 * ------------------------------------------------------------------ *
 *
 * FINDING 1 was that `growth-food` was declared by shipped content, validated, read
 * — and compared against nothing: `applyGrowth` grew every city on the bare
 * `foodBoxSize` curve, so the granary and the Pyramids were worth their shields and
 * nothing else. The fix makes `applyGrowth` compare the box against
 * `cityGrowthTarget` (the bare curve reduced by the city's own `growth-food` effects,
 * floored at `MIN_GROWTH_FOOD`). This section exists so that hole cannot silently
 * reopen: every case below is written to **fail against the old behaviour**, and the
 * mutation check recorded at the end of this file shows them going red when the
 * wiring is reverted by hand and the file restored byte-identical afterwards.
 *
 * The one fixture all of them use:
 *
 * - Two civilizations' capitals **15 tiles apart** on grassland, so their radii cannot
 *   touch and neither city's tile assignment can feed the other's yields. City 0 is
 *   the subject; city 1 is the **control** — identical in terrain, worked tiles,
 *   population and food box, differing in exactly one field: city 0's `buildings`.
 * - Each city works **one tile per citizen**, all of them the same role, chosen so the
 *   arithmetic is exact: a grassland tile (2 food) gives `2 + 2 = 4` food against
 *   `2 * 1` eaten, a surplus of **2**; a plains tile (1 food) gives `2 + 1 = 3`
 *   against 2, a surplus of **1**. With `FOOD_BOX_BASE = 10` the bare requirement at
 *   one citizen is 10, the granary's is 9, and the granary plus the Pyramids is 8.
 * - Everything runs through the **command layer** (`applyCommand(..., { type:
 *   'EndTurn' })`), which is the pipeline a real game uses, so the numbers below are
 *   what a player would see rather than what a direct call to `applyGrowth` returned.
 *
 * **The old behaviour is executed, not transcribed.** A `RulesetView` with no building
 * rows at all makes every `growth-food` effect unreachable — exactly what the pre-fix
 * `applyGrowth` did by never asking — so running the *real* engine over the *same*
 * state with that view is the uncalled-code behaviour, live, through the same command
 * layer. The only rows in the catalog that declare `growth-food` are the granary and
 * the Pyramids (counted below), the fixture's cities hold no production queue (except
 * where a case completes the wonder on purpose), and nothing else in the pipeline
 * reads a building row on these boards, so the two views differ in the growth
 * threshold and in nothing else.
 */

/** The shipped content with **no building rows at all**: the pre-fix growth behaviour. */
const NO_BUILDINGS: RulesetView = { ...RULESET, buildings: [] };

/**
 * Every shipped row that declares a `growth-food` effect, in catalog order — the
 * universe the combinations below are taken from. Read out of the catalog rather than
 * named, and then pinned, so a new row with the effect joins the sweep automatically
 * and a *removed* one fails the pin instead of silently shrinking the claim.
 */
const GROWTH_FOOD_ROWS: readonly BuildingDef[] = ALL_ROWS.filter(
  (row) => declaredGrowthFood([row]) > 0,
);

/** All 2^n subsets of `GROWTH_FOOD_ROWS`: every combination shipped content allows. */
const EVERY_GROWTH_FOOD_COMBINATION: readonly (readonly BuildingDef[])[] = (() => {
  const combinations: BuildingDef[][] = [];
  for (let mask = 0; mask < 1 << GROWTH_FOOD_ROWS.length; mask += 1) {
    const subset: BuildingDef[] = [];
    for (let index = 0; index < GROWTH_FOOD_ROWS.length; index += 1) {
      const row = GROWTH_FOOD_ROWS[index];
      if (row === undefined) continue;
      if ((mask & (1 << index)) !== 0) subset.push(row);
    }
    combinations.push(subset);
  }
  return combinations;
})();

interface GrowthBoardSpec {
  /** What city 0 holds. City 1 is the control and holds nothing. */
  readonly buildings?: readonly BuildingDef['id'][];
  readonly population?: number;
  /** The food box both cities start with. */
  readonly foodBox?: number;
  /** The role of every worked tile: grassland (surplus 2) or plains (surplus 1). */
  readonly worked?: 'grassland' | 'plains';
  /** City 0's stored shields and queue, so the wonder can be completed by production. */
  readonly shields?: number;
  readonly production?: ProductionItem;
  /** How many tiles each city works. Defaults to one per citizen; `0` works none. */
  readonly tiles?: number;
}

/** The tile offsets each city works, relative to its own centre: one per citizen. */
const WORKED_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 0],
  [0, 1],
  [1, 1],
];

/**
 * The two-capital fixture. Both cities are built from the same numbers; the only
 * argument that can make them differ is `buildings`, which is the whole point.
 *
 * `workedTiles` is passed explicitly (and `[]` is passed explicitly for `tiles: 0`)
 * so the fixture never leans on the builder's auto-assignment, which would otherwise
 * choose the tiles *for* the test.
 */
const growthBoard = (spec: GrowthBoardSpec = {}): GameState => {
  const buildings = spec.buildings ?? [];
  const population = spec.population ?? 1;
  const foodBox = spec.foodBox ?? 0;
  const worked = spec.worked ?? 'grassland';
  const shields = spec.shields ?? 0;
  const production = spec.production;
  const offsets = WORKED_OFFSETS.slice(0, Math.max(0, spec.tiles ?? population));

  let builder = twoCivs().fillTerrain('grassland');
  for (const [dx, dy] of offsets) {
    builder = builder.setTile(5 + dx, 5 + dy, worked).setTile(20 + dx, 20 + dy, worked);
  }

  return built(
    builder
      .addUnit(0, SETTLER, [5, 5])
      .addUnit(1, SETTLER, [20, 20])
      .addCity(0, [5, 5], {
        population,
        foodBox,
        shields,
        workedTiles: offsets.map(([dx, dy]) => at(5 + dx, 5 + dy)),
        buildings,
        ...(production === undefined ? {} : { production }),
      })
      .addCity(1, [20, 20], {
        population,
        foodBox,
        workedTiles: offsets.map(([dx, dy]) => at(20 + dx, 20 + dy)),
      }),
  );
};

interface CommandTurn {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** `turns` world turns through the **command layer**, keeping every intermediate state. */
const playTurns = (
  state: GameState,
  turns: number,
  ruleset: RulesetView = RULESET,
): readonly CommandTurn[] => {
  let current = state;
  const records: CommandTurn[] = [];
  for (let index = 0; index < turns; index += 1) {
    const outcome = applyCommand(current, asPlayerId(0), { type: 'EndTurn' }, ruleset);
    if (!outcome.ok) throw new Error(`EndTurn was refused: ${errorText(outcome.error)}`);
    current = outcome.value.state;
    records.push({ state: current, events: outcome.value.events });
  }
  return records;
};

/** A recorded turn by index, or a thrown fixture error — never a silent `undefined`. */
const recordAt = (records: readonly CommandTurn[], index: number): CommandTurn => {
  const record = records[index];
  if (record === undefined) {
    throw new Error(
      `the run recorded no turn ${String(index)} (it recorded ${String(records.length)})`,
    );
  }
  return record;
};

/** One city's `[turn, population, foodBox]` per turn — a whole trajectory as one value. */
const trajectory = (
  records: readonly CommandTurn[],
  cityId: CityId,
): readonly (readonly [number, number, number])[] =>
  records.map((record) => {
    const city = cityOf(record.state, cityId);
    return [record.state.turn, city.population, city.foodBox] as const;
  });

const populationsIn = (rows: readonly (readonly [number, number, number])[]): readonly number[] =>
  rows.map((row) => row[1]);

type GrewEvent = Extract<GameEvent, { readonly type: 'CityGrew' }>;

const grewEventsOf = (events: readonly GameEvent[], cityId: CityId): readonly GrewEvent[] =>
  events.filter(
    (event): event is GrewEvent => event.type === 'CityGrew' && event.cityId === cityId,
  );

/** The events one city's growth produced in one recorded turn, as a comparable list. */
const grewAt = (record: CommandTurn, cityId: CityId): readonly GrewEvent[] =>
  grewEventsOf(record.events, cityId);

const allEventsOf = (records: readonly CommandTurn[]): readonly GameEvent[] =>
  records.flatMap((record) => record.events);

/** The turn a city first grew in this window, or `undefined` if it never did. */
const firstGrowthTurn = (records: readonly CommandTurn[], cityId: CityId): number | undefined =>
  records.find((record) => grewAt(record, cityId).length > 0)?.state.turn;

/** The `growth-food` amount a set of rows declares, summed here — never asked of the engine. */
const reductionOf = (rows: readonly BuildingDef[]): number => declaredGrowthFood(rows);

/**
 * The contract's growth rule for **one city for one turn**, with the reduction and the
 * floor passed in: `box += surplus`, then spend
 * `max(MIN_GROWTH_FOOD, foodBoxSize(population) - reduction)` per citizen born and
 * carry the remainder. `surplus` must be positive — the cases below never starve, and
 * the engine's own surplus is asserted against a hand-derived one before it is used.
 */
const reducedRule = (
  population: number,
  foodBox: number,
  surplus: number,
  reduction: number,
): readonly [number, number] => {
  let box = foodBox + surplus;
  let citizens = population;
  for (;;) {
    const needed = Math.max(MIN_GROWTH_FOOD, foodBoxSize(citizens) - reduction);
    if (box < needed) break;
    box -= needed;
    citizens += 1;
  }
  return [citizens, box];
};

/** `state` with one city's population and food box replaced — a fixture edit, not a rule. */
const withFoodIn = (
  state: GameState,
  cityId: CityId,
  population: number,
  foodBox: number,
): GameState => ({
  ...state,
  cities: state.cities.map((city) =>
    city.id === cityId ? { ...city, population, foodBox } : city,
  ),
});

describe('2b. growth-food is APPLIED — the granary, the Pyramids, and the floor', () => {
  const CITY = asCityId(0);
  const CONTROL = asCityId(1);

  it('grows the granary city one turn before an identical control, with the exact turns, boxes and thresholds', () => {
    const side = growthBoard({ buildings: [GRANARY.id], foodBox: 7 });
    const granaryCity = cityOf(side, CITY);
    const controlCity = cityOf(side, CONTROL);

    // The fixture is what it says it is: one citizen each, one worked tile each, the
    // same food box, and a `buildings` field that differs in exactly one entry.
    expect([granaryCity.population, controlCity.population]).toEqual([1, 1]);
    expect([granaryCity.foodBox, controlCity.foodBox]).toEqual([7, 7]);
    expect([granaryCity.workedTiles.length, controlCity.workedTiles.length]).toEqual([1, 1]);
    expect(granaryCity.buildings).toEqual([GRANARY.id]);
    expect(controlCity.buildings).toEqual([]);

    // The curve is M3's, unchanged, and the row declares one food: 10 -> 9.
    expect(foodBoxSize(1)).toBe(10);
    expect(reductionOf([GRANARY])).toBe(1);
    const bareThreshold = foodBoxSize(1);
    const granaryThreshold = bareThreshold - reductionOf([GRANARY]);
    expect(granaryThreshold).toBe(9);

    // The effect moves the *requirement*, not the harvest: both cities make the same
    // food from the same terrain at the same population, so nothing else can explain
    // the trajectories below.
    const granaryYields = cityYields(side, RULESET, CITY);
    expect(cityYields(side, RULESET, CONTROL)).toEqual(granaryYields);
    expect(granaryYields).toMatchObject({ food: 4, foodSurplus: 2 });

    const records = playTurns(side, 6);

    // THE EXACT TRAJECTORIES. Granary: 7 + 2 = 9 reaches its own 9 on turn 2, spends
    // all 9 and carries 0, then runs 2 food a turn against a requirement of 14 at two
    // citizens. Control: the same 9 is one short of 10, so it holds at 9 and grows on
    // turn 3 from 9 + 2 = 11 over 10, carrying 1, then runs the same 2 food a turn
    // against a requirement of 15.
    expect(trajectory(records, CITY)).toEqual([
      [2, 2, 0],
      [3, 2, 2],
      [4, 2, 4],
      [5, 2, 6],
      [6, 2, 8],
      [7, 2, 10],
    ]);
    expect(trajectory(records, CONTROL)).toEqual([
      [2, 1, 9],
      [3, 2, 1],
      [4, 2, 3],
      [5, 2, 5],
      [6, 2, 7],
      [7, 2, 9],
    ]);

    // The exact turns, and the exact gap the reduction buys.
    expect(firstGrowthTurn(records, CITY)).toBe(2);
    expect(firstGrowthTurn(records, CONTROL)).toBe(3);
    expect((firstGrowthTurn(records, CONTROL) ?? 0) - (firstGrowthTurn(records, CITY) ?? 0)).toBe(
      1,
    );

    // The threshold each city actually used, read off the events: the granary spent
    // its own 9, the control spent the bare 10, and the two remainders are exactly
    // the difference of those two thresholds (0 = 9 - 9, 1 = 11 - 10).
    expect(grewAt(recordAt(records, 0), CITY)).toEqual([
      { type: 'CityGrew', cityId: CITY, owner: asPlayerId(0), population: 2, foodBox: 0 },
    ]);
    expect(grewAt(recordAt(records, 0), CONTROL)).toEqual([]);
    expect(grewAt(recordAt(records, 1), CONTROL)).toEqual([
      { type: 'CityGrew', cityId: CONTROL, owner: asPlayerId(1), population: 2, foodBox: 1 },
    ]);
    expect(7 + granaryYields.foodSurplus).toBe(granaryThreshold);
    expect(9 + granaryYields.foodSurplus - bareThreshold).toBe(1);

    // THE CONTROL IS UNCHANGED FROM THE UNMODIFIED CURVE — twice over. First as
    // literal arithmetic: box 7 + 2 = 9 is one short of 10 and holds, 9 + 2 = 11
    // reaches 10 and carries 1, and then 2 a turn against 15. Every number below is
    // hand-derived from `FOOD_BOX_BASE`/`FOOD_BOX_PER_CITIZEN` and the surplus, and
    // the control's whole trajectory is asserted to be exactly it.
    expect(reducedRule(1, 7, 2, 0)).toEqual([1, 9]);
    expect(reducedRule(1, 9, 2, 0)).toEqual([2, 1]);
    expect(reducedRule(2, 1, 2, 0)).toEqual([2, 3]);
    expect(reducedRule(2, 3, 2, 0)).toEqual([2, 5]);
    expect(reducedRule(2, 5, 2, 0)).toEqual([2, 7]);
    expect(reducedRule(2, 7, 2, 0)).toEqual([2, 9]);
    expect([foodBoxSize(1), foodBoxSize(2)]).toEqual([10, 15]);

    // ... and second by *executing* the old behaviour: the same board run with no
    // building rows at all must give the control exactly the trajectory the real
    // catalog gives it — and the same growth events, turn for turn.
    const old = playTurns(side, 6, NO_BUILDINGS);
    expect(trajectory(old, CONTROL)).toEqual(trajectory(records, CONTROL));
    expect(grewEventsOf(allEventsOf(old), CONTROL)).toEqual(
      grewEventsOf(allEventsOf(records), CONTROL),
    );
    expect(populationsIn(trajectory(old, CONTROL))).toEqual([1, 2, 2, 2, 2, 2]);

    // ... and the fix moved the *subject* and nothing else: on that same board the old
    // behaviour gives the granary city the control's trajectory, the control's events
    // and the control's hash shape, and the real catalog does not.
    expect(trajectory(old, CITY)).toEqual(trajectory(records, CONTROL));
    expect(trajectory(old, CITY)).not.toEqual(trajectory(records, CITY));
    expect(grewAt(recordAt(old, 0), CITY)).toEqual([]);
    expect(hashValue(recordAt(records, 5).state)).not.toBe(hashValue(recordAt(old, 5).state));

    // Playing it twice is the same game: the pin is a function of the state.
    expect(trajectory(playTurns(side, 6), CITY)).toEqual(trajectory(records, CITY));
    expect(hashValue(recordAt(playTurns(side, 6), 5).state)).toBe(
      hashValue(recordAt(records, 5).state),
    );
  });

  it('reaches the reduced threshold through the command layer, on a trajectory the pre-fix code could not produce', () => {
    const side = growthBoard({ buildings: [GRANARY.id], foodBox: 7 });
    const records = playTurns(side, 12);
    const old = playTurns(side, 12, NO_BUILDINGS);

    // The command layer really ran a game: twelve turns, each ending with `TurnEnded`.
    expect(records).toHaveLength(12);
    expect(records.map((record) => record.state.turn)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    for (const record of records) {
      expect(record.events.some((event) => event.type === 'TurnEnded')).toBe(true);
    }

    const mine = trajectory(records, CITY);
    const obsolete = trajectory(old, CITY);
    const control = trajectory(records, CONTROL);

    // The trajectory the old code produced on this very board is the control's — the
    // old code never looked at the building — and the fixed engine's is not. Both are
    // pinned exactly, turn by turn: the requirements are 9/14/19 for the granary city
    // and 10/15/20 for the control, and both run the same 2 food a turn.
    expect(obsolete).toEqual(control);
    expect(mine).not.toEqual(obsolete);
    expect(mine).toEqual([
      [2, 2, 0],
      [3, 2, 2],
      [4, 2, 4],
      [5, 2, 6],
      [6, 2, 8],
      [7, 2, 10],
      [8, 2, 12],
      [9, 3, 0],
      [10, 3, 2],
      [11, 3, 4],
      [12, 3, 6],
      [13, 3, 8],
    ]);
    expect(obsolete).toEqual([
      [2, 1, 9],
      [3, 2, 1],
      [4, 2, 3],
      [5, 2, 5],
      [6, 2, 7],
      [7, 2, 9],
      [8, 2, 11],
      [9, 2, 13],
      [10, 3, 0],
      [11, 3, 2],
      [12, 3, 4],
      [13, 3, 6],
    ]);

    // Every growth in the window, on both sides: the same number of citizens bought,
    // each exactly **one turn earlier** — which is the whole of what the fix changed.
    const grewFixed = grewEventsOf(allEventsOf(records), CITY);
    const grewOld = grewEventsOf(allEventsOf(old), CITY);
    // The same two growths over the same twelve turns, with the same final population
    // and the same number of citizens bought — reached one turn earlier by the fixed
    // city, and carrying the reduced remainder (0 = 9 spent of 9) where the old city
    // carried 1 (11 spent of 10).
    const growthShape = (events: readonly GrewEvent[]): readonly (readonly [number, number])[] =>
      events.map((event) => [event.population, event.foodBox] as const);
    expect(growthShape(grewFixed)).toEqual([
      [2, 0],
      [3, 0],
    ]);
    expect(growthShape(grewOld)).toEqual([
      [2, 1],
      [3, 0],
    ]);
    expect(growthShape(grewEventsOf(allEventsOf(records), CONTROL))).toEqual(growthShape(grewOld));
    expect(grewFixed).toHaveLength(grewOld.length);
    for (const record of records) {
      expect(grewAt(record, CITY).length).toBeLessThanOrEqual(1);
    }
    const growthTurns = (run: readonly CommandTurn[], cityId: CityId): readonly number[] =>
      run.flatMap((record) => (grewAt(record, cityId).length > 0 ? [record.state.turn] : []));
    expect(growthTurns(records, CITY)).toEqual([2, 9]);
    expect(growthTurns(old, CITY)).toEqual([3, 10]);
    expect(growthTurns(records, CONTROL)).toEqual([3, 10]);

    // The populations differ by exactly the number of growths the fix is ahead by at
    // that point — never by more, and never in the old code's favour.
    const fixedPopulations = populationsIn(mine);
    const oldPopulations = populationsIn(obsolete);
    expect(fixedPopulations).toHaveLength(oldPopulations.length);
    for (let index = 0; index < fixedPopulations.length; index += 1) {
      const turn = recordAt(records, index).state.turn;
      const lead =
        growthTurns(records, CITY).filter((grown) => grown <= turn).length -
        growthTurns(old, CITY).filter((grown) => grown <= turn).length;
      expect((fixedPopulations[index] ?? 0) - (oldPopulations[index] ?? 0)).toBe(lead);
      expect(lead).toBeGreaterThanOrEqual(0);
    }
    expect(fixedPopulations.filter((value, index) => value > (oldPopulations[index] ?? 0))).toEqual(
      [2, 3],
    );

    // The state after the run differs, and what differs is the food bookkeeping: the
    // fixed city is carrying two food it would not have, and the hash follows.
    expect(hashValue(recordAt(records, 11).state)).not.toBe(hashValue(recordAt(old, 11).state));
    expect(cityOf(recordAt(records, 11).state, CITY).foodBox).toBeGreaterThan(
      cityOf(recordAt(old, 11).state, CITY).foodBox,
    );
    expect(cityOf(recordAt(records, 11).state, CITY).foodBox).toBe(8);
    expect(cityOf(recordAt(old, 11).state, CITY).foodBox).toBe(6);
    console.log(
      `growth-food through the command layer: growth turns ${JSON.stringify(
        growthTurns(records, CITY),
      )} vs pre-fix ${JSON.stringify(growthTurns(old, CITY))}`,
    );
  });

  it('is observable through the multi-growth loop, and through carry-over alone', () => {
    // MULTI-GROWTH. Box 21 plus this turn's 2 is 23. The granary's requirements are 9
    // then 14, so it buys **two** citizens in one turn (23 - 9 - 14 = 0). The control's
    // are 10 then 15, so it buys one and stops at 13. A reading that applied the
    // reduction to the first citizen of a turn only would leave the granary city at two
    // citizens with 14 in the box — so this case fails that reading too, and not only
    // the completely unwired one.
    const multi = growthBoard({ buildings: [GRANARY.id], foodBox: 21 });
    const multiRecords = playTurns(multi, 1);
    const multiTurn = recordAt(multiRecords, 0);
    expect(trajectory(multiRecords, CITY)).toEqual([[2, 3, 0]]);
    expect(trajectory(multiRecords, CONTROL)).toEqual([[2, 2, 13]]);
    expect(reducedRule(1, 21, 2, 1)).toEqual([3, 0]);
    expect(reducedRule(1, 21, 2, 0)).toEqual([2, 13]);
    // The one-shot reduction reading, spelled out: 9 for the first citizen, the bare
    // 15 after — 14 in the box is one short of a third citizen.
    expect(21 + 2 - 9).toBe(14);
    expect(14).toBeLessThan(foodBoxSize(2));
    expect(foodBoxSize(2)).toBe(15);
    expect(grewAt(multiTurn, CITY)).toEqual([
      { type: 'CityGrew', cityId: CITY, owner: asPlayerId(0), population: 3, foodBox: 0 },
    ]);
    expect(grewAt(multiTurn, CONTROL)).toEqual([
      { type: 'CityGrew', cityId: CONTROL, owner: asPlayerId(1), population: 2, foodBox: 13 },
    ]);

    // CARRY-OVER ALONE. Box 24 plus 2 is 26: the granary city spends 9 then 14 and
    // carries 3, the control spends 10 then 15 and carries 1. Both end at the **same
    // population on the same turn**, so the only thing the reduction changed here is
    // the food carried into the next growth — which is what makes this the
    // carry-over-only witness, and the case a "the box is only a counter" reading
    // would pass.
    const carry = growthBoard({ buildings: [GRANARY.id], foodBox: 24 });
    const carryRecords = playTurns(carry, 2);
    expect(trajectory(carryRecords, CITY)).toEqual([
      [2, 3, 3],
      [3, 3, 5],
    ]);
    expect(trajectory(carryRecords, CONTROL)).toEqual([
      [2, 3, 1],
      [3, 3, 3],
    ]);
    expect(reducedRule(1, 24, 2, 1)).toEqual([3, 3]);
    expect(reducedRule(1, 24, 2, 0)).toEqual([3, 1]);
    expect(populationsIn(trajectory(carryRecords, CITY))).toEqual(
      populationsIn(trajectory(carryRecords, CONTROL)),
    );
    expect(grewAt(recordAt(carryRecords, 0), CITY)).toEqual([
      { type: 'CityGrew', cityId: CITY, owner: asPlayerId(0), population: 3, foodBox: 3 },
    ]);
    expect(grewAt(recordAt(carryRecords, 0), CONTROL)).toEqual([
      { type: 'CityGrew', cityId: CONTROL, owner: asPlayerId(1), population: 3, foodBox: 1 },
    ]);
    expect(firstGrowthTurn(carryRecords, CITY)).toBe(firstGrowthTurn(carryRecords, CONTROL));

    // And the old behaviour flattens both boards to the control's numbers: two
    // citizens on the multi-growth board, one food in the box on the carry-over board.
    const multiOld = playTurns(multi, 1, NO_BUILDINGS);
    const carryOld = playTurns(carry, 2, NO_BUILDINGS);
    expect(trajectory(multiOld, CITY)).toEqual([[2, 2, 13]]);
    expect(trajectory(carryOld, CITY)).toEqual([
      [2, 3, 1],
      [3, 3, 3],
    ]);
    expect(trajectory(multiOld, CITY)).not.toEqual(trajectory(multiRecords, CITY));
    expect(trajectory(carryOld, CITY)).not.toEqual(trajectory(carryRecords, CITY));
  });

  it('makes the Pyramids do something: the city that completes the wonder gets the reduction', () => {
    // The wonder is finished **through the production pass**, not stated by hand: its
    // cost in shields is banked and the wonder is queued, so the first `EndTurn`
    // completes it and emits `CityProduced`. The worked tile is plains, so the surplus
    // is 1 — the surplus that makes a one-food reduction cross a whole turn (8 + 1 = 9
    // reaches the wonder's 9 and not the bare 10).
    const board = growthBoard({
      foodBox: 7,
      worked: 'plains',
      shields: PYRAMIDS.cost,
      production: { kind: 'building', id: PYRAMIDS_ID },
    });
    const before = cityOf(board, CITY);
    expect(before.buildings).toEqual([]);
    expect(buildingHolder(board, PYRAMIDS_ID)).toBeUndefined();
    expect(cityYields(board, RULESET, CITY).foodSurplus).toBe(1);
    expect(cityYields(board, RULESET, CONTROL)).toEqual(cityYields(board, RULESET, CITY));
    expect(reductionOf([PYRAMIDS])).toBe(1);
    // The only effect the row declares is the one under test, so a difference between
    // the holder and the control cannot be some other declared effect firing.
    expect(PYRAMIDS.effects).toEqual([{ kind: 'growth-food', amount: 1 }]);
    expect(isWonder(PYRAMIDS)).toBe(true);

    const records = playTurns(board, 3);
    const first = recordAt(records, 0);
    const second = recordAt(records, 1);

    // The wonder completes on turn 2 — once, for city 0 — and the two cities are still
    // IDENTICAL at that point: growth runs before production in the turn pipeline, so a
    // wonder finished this turn cannot help this turn. That is the pipeline's order made
    // visible, and it is what makes the next turn's divergence attributable to the
    // wonder rather than to the shields it was bought with.
    const produced = producedEventsOf(first.events).filter(
      (event) => event.item.kind === 'building' && event.item.id === PYRAMIDS_ID,
    );
    expect(produced).toHaveLength(1);
    expect(produced[0]).toMatchObject({
      cityId: CITY,
      owner: asPlayerId(0),
      item: { kind: 'building', id: PYRAMIDS_ID },
    });
    expect(cityOf(first.state, CITY).buildings).toEqual([PYRAMIDS_ID]);
    expect(buildingHolder(first.state, PYRAMIDS_ID)?.id).toBe(CITY);
    expect(trajectory(records, CITY)[0]).toEqual([2, 1, 8]);
    expect(trajectory(records, CONTROL)[0]).toEqual([2, 1, 8]);

    // From the next turn the holder grows on 9 and the control does not: 8 + 1 = 9 is
    // the wonder's requirement and one short of the bare 10. The control grows a turn
    // later, from 9 + 1 = 10.
    expect(trajectory(records, CITY)).toEqual([
      [2, 1, 8],
      [3, 2, 0],
      [4, 2, 1],
    ]);
    expect(trajectory(records, CONTROL)).toEqual([
      [2, 1, 8],
      [3, 1, 9],
      [4, 2, 0],
    ]);
    expect(firstGrowthTurn(records, CITY)).toBe(3);
    expect(firstGrowthTurn(records, CONTROL)).toBe(4);
    expect(grewAt(second, CITY)).toEqual([
      { type: 'CityGrew', cityId: CITY, owner: asPlayerId(0), population: 2, foodBox: 0 },
    ]);
    expect(grewAt(second, CONTROL)).toEqual([]);
    expect(reducedRule(1, 8, 1, 1)).toEqual([2, 0]);
    expect(reducedRule(1, 8, 1, 0)).toEqual([1, 9]);
    expect(reducedRule(1, 9, 1, 0)).toEqual([2, 0]);

    // Before the fix the wonder's holder had the control's trajectory exactly: the
    // wonder was inert, which is what this case exists to prevent from returning.
    const old = playTurns(board, 3, NO_BUILDINGS);
    expect(trajectory(old, CITY)).toEqual(trajectory(records, CONTROL));
    expect(trajectory(old, CITY)).not.toEqual(trajectory(records, CITY));
    // The blind run cannot even build the wonder — the effect it declared was the only
    // effect it had, and with the row unreadable the wonder is not a building at all.
    expect(cityOf(recordAt(old, 2).state, CITY).buildings).toEqual([]);
    expect(hashValue(recordAt(old, 2).state)).not.toBe(hashValue(recordAt(records, 2).state));
  });

  it('holds the MIN_GROWTH_FOOD floor under every shipped combination, and cannot grow a city instantly', () => {
    // The universe is complete and pinned: the shipped catalog declares `growth-food`
    // on exactly these two rows, and the sweep below is all four of their subsets.
    expect(GROWTH_FOOD_ROWS.map((row) => String(row.id)).sort()).toEqual(['granary', 'pyramids']);
    expect(EVERY_GROWTH_FOOD_COMBINATION).toHaveLength(4);
    expect(reductionOf(GROWTH_FOOD_ROWS)).toBe(2);

    const rec = recorder();
    const boxes = [0, 1, 5, 7, 8, 9, 10, 11, 14, 15, 23, 26, 40];

    for (const combination of EVERY_GROWTH_FOOD_COMBINATION) {
      const reduction = reductionOf(combination);
      const ids = combination.map((row) => row.id);
      const label = `[${ids.map(String).join(', ') || 'none'}]`;

      for (const foodBox of boxes) {
        const state = growthBoard({ buildings: ids, foodBox });
        const surplus = cityYields(state, RULESET, CITY).foodSurplus;
        // The engine's surplus is the one the oracle is fed, so the comparison cannot
        // be against a number the fixture never makes.
        rec.check(surplus === 2, `${label} box ${String(foodBox)}: surplus ${String(surplus)}`);
        rec.check(
          cityYields(state, RULESET, CONTROL).foodSurplus === surplus,
          `${label} box ${String(foodBox)}: the control's surplus moved`,
        );

        const expected = reducedRule(1, foodBox, surplus, reduction);
        const after = cityOf(applyGrowth(state, RULESET).state, CITY);
        rec.check(
          after.population === expected[0] && after.foodBox === expected[1],
          `${label} box ${String(foodBox)}: got pop ${String(after.population)} box ${String(
            after.foodBox,
          )}, expected pop ${String(expected[0])} box ${String(expected[1])}`,
        );

        // The floor, as a property of the requirement itself: never below
        // `MIN_GROWTH_FOOD`, never fractional, never `NaN` — so nothing that divides by
        // it can divide by zero, and a city can always eventually grow.
        const needed = Math.max(MIN_GROWTH_FOOD, foodBoxSize(1) - reduction);
        rec.check(
          Number.isInteger(needed) && needed >= MIN_GROWTH_FOOD,
          `${label}: the requirement at one citizen is ${String(needed)}`,
        );
        rec.check(
          cityGrowthTarget(buildingCatalog(RULESET), cityOf(state, CITY), foodBoxSize(1)) ===
            needed,
          `${label}: the engine's requirement is not ${String(needed)}`,
        );
      }

      // The boundary is exact, at every combination: one food short of the reduced
      // requirement nothing grows, and at the requirement it grows. That is what makes
      // the reduction *fully* applied rather than partly, at every shipped amount.
      const threshold = Math.max(MIN_GROWTH_FOOD, foodBoxSize(1) - reduction);
      const base = growthBoard({ buildings: ids });
      rec.check(
        cityOf(applyGrowth(withFoodIn(base, CITY, 1, threshold - 3), RULESET).state, CITY)
          .population === 1,
        `${label}: the city grew one food short of ${String(threshold)}`,
      );
      rec.check(
        cityOf(applyGrowth(withFoodIn(base, CITY, 1, threshold - 2), RULESET).state, CITY)
          .population === 2,
        `${label}: the city did not grow at exactly ${String(threshold)}`,
      );
    }

    expect(failuresOf(rec)).toEqual([]);

    // NOTHING GROWS INSTANTLY. A city that works no tile at all makes exactly what its
    // own citizens eat — a surplus of 0 — and an empty box therefore stays empty
    // whatever the city holds: a granary, the Pyramids, or both. Growth is bought with
    // food, so there is no building in the catalog that can grow a city for free.
    const idle = growthBoard({
      buildings: GROWTH_FOOD_ROWS.map((row) => row.id),
      population: 1,
      tiles: 0,
    });
    expect(cityYields(idle, RULESET, CITY).foodSurplus).toBe(0);
    expect(cityYields(idle, RULESET, CONTROL).foodSurplus).toBe(0);
    expect(cityOf(applyGrowth(idle, RULESET).state, CITY)).toMatchObject({
      population: 1,
      foodBox: 0,
    });
    expect(applyGrowth(idle, RULESET).events).toEqual([]);

    // ... and two food does not buy a citizen either, at the *reduced* requirement: the
    // granary plus the Pyramids need 8, and a city with an empty box and a surplus of 2
    // has 2. Nothing about the reduction removes the accumulating.
    const oneShort = growthBoard({ buildings: GROWTH_FOOD_ROWS.map((row) => row.id) });
    expect(cityYields(oneShort, RULESET, CITY).foodSurplus).toBe(2);
    const oneShortAfter = applyGrowth(oneShort, RULESET);
    expect(cityOf(oneShortAfter.state, CITY)).toMatchObject({ population: 1, foodBox: 2 });
    expect(oneShortAfter.events).toEqual([]);
    expect(Math.max(MIN_GROWTH_FOOD, foodBoxSize(1) - reductionOf(GROWTH_FOOD_ROWS))).toBe(8);
    expect(2).toBeLessThan(8);

    // THE FLOOR, DRIVEN TO ITS LIMIT. Shipped content cannot reach it — the most it
    // declares is 2 food against a requirement of 10 — so the attack is a foreign view
    // declaring 1200: the requirement floors at 1, the city grows by exactly the food
    // it had over that one (`(box + surplus) / 1` citizens, no more), and the loop
    // terminates instead of running forever the way a threshold of 0 would.
    const stacking = Array.from({ length: 12 }, (_, index): BuildingDef => ({
      id: asBuildingId(`adversarial-growth-${String(index)}`),
      name: `Adversarial growth ${String(index)}`,
      cost: 1,
      maintenance: 0,
      effects: [{ kind: 'growth-food', amount: 100 }],
    }));
    const stackedCatalog = [...buildingCatalog(RULESET), ...stacking];
    const stackedView: RulesetView = { ...RULESET, buildings: stackedCatalog };
    const stackedBoard = withBuildings(
      growthBoard({ foodBox: 12 }),
      CITY,
      stacking.map((row) => row.id),
    );
    const stackedCity = cityOf(stackedBoard, CITY);
    const stackedEffects = cityBuildingEffects(stackedCatalog, stackedCity);

    expect(stackedEffects.growthFood).toBe(1200);
    expect(cityGrowthTarget(stackedCatalog, stackedCity, foodBoxSize(1))).toBe(MIN_GROWTH_FOOD);
    expect(growthFoodNeeded(foodBoxSize(1), stackedEffects)).toBe(MIN_GROWTH_FOOD);
    // The reduction really does overshoot: unfloored, the requirement would be -1190.
    expect(foodBoxSize(1) - stackedEffects.growthFood).toBeLessThan(MIN_GROWTH_FOOD);

    const spurt = applyGrowth(stackedBoard, stackedView);
    expect(cityYields(stackedBoard, stackedView, CITY).foodSurplus).toBe(2);
    // 12 + 2 = 14 food at a requirement of 1: fourteen more citizens and a box of
    // exactly 0. A requirement of 0 would have made this loop unbounded.
    expect(cityOf(spurt.state, CITY)).toMatchObject({ population: 15, foodBox: 0 });
    expect(grewEventsOf(spurt.events, CITY)).toEqual([
      { type: 'CityGrew', cityId: CITY, owner: asPlayerId(0), population: 15, foodBox: 0 },
    ]);
    // The control, on the same board and with the same food, holds none of the stacked
    // rows: it grows once on the bare curve (12 + 2 = 14 over 10, carrying 4) while the
    // city next door grows fourteen times. The floor bounds the spurt; it does not
    // invent food.
    expect(cityOf(spurt.state, CONTROL)).toMatchObject({ population: 2, foodBox: 4 });
    expect(grewEventsOf(spurt.events, CONTROL)).toEqual([
      { type: 'CityGrew', cityId: CONTROL, owner: asPlayerId(1), population: 2, foodBox: 4 },
    ]);

    // THE FLOOR, OVER HOSTILE INPUTS. `growthFoodNeeded` is total: a requirement that
    // is `NaN`, negative or fractional still comes back a whole number >= 1, so no
    // consumer can divide by zero or put a fraction into a hashed threshold.
    const requirements = [Number.NaN, Number.NEGATIVE_INFINITY, -5, 0, 0.5, 1, 10, 10.5, 1e9];
    const declared = [0, 1, 2, 10, 1e9];
    let checked = 0;
    for (const value of requirements) {
      for (const amount of declared) {
        const result = growthFoodNeeded(value, effectTotals([{ kind: 'growth-food', amount }]));
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(MIN_GROWTH_FOOD);
        expect(result).not.toBe(0);
        checked += 1;
      }
    }
    expect(checked).toBe(requirements.length * declared.length);
    expect(MIN_GROWTH_FOOD).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 3. One implementation of availability
 * ------------------------------------------------------------------ */

/** The resource ids connected for `playerId`, re-derived from `isConnected`. */
const resourceSets = (state: GameState, playerId: PlayerId): readonly ResourceId[] =>
  CATALOG.resources
    .filter((row) => isConnected(state, RULESET, playerId, row.id))
    .map((row) => row.id);

/** The *names* the REPL prints for a player's connected resources, in catalog order. */
const connectedNames = (state: GameState, playerId: PlayerId): readonly string[] =>
  CATALOG.resources
    .filter((row) => isConnected(state, RULESET, playerId, row.id))
    .map((row) => row.name);

describe('3. one implementation of availability — no second code path', () => {
  it('has every availability asker agree, on boards with and without a connection', () => {
    const rec = recorder();
    const items = itemUniverse();
    const gated: ProductionItem = { kind: 'unit', id: GATED_UNIT };

    const boards: readonly (readonly [string, GameState, boolean])[] = [
      [
        'road reaches the iron',
        built(
          settled()
            .setTile(8, 5, 'hills')
            .addResource(8, 5, STRATEGIC)
            .addImprovement(6, 5, ROAD)
            .addImprovement(7, 5, ROAD),
        ),
        true,
      ],
      [
        'no road at all',
        built(settled().setTile(8, 5, 'hills').addResource(8, 5, STRATEGIC)),
        false,
      ],
      [
        'road stops beside the iron',
        built(
          settled().setTile(7, 5, 'hills').addResource(7, 5, STRATEGIC).addImprovement(6, 5, ROAD),
        ),
        true,
      ],
    ];

    for (const [label, state, expectConnected] of boards) {
      rec.check(
        isConnected(state, RULESET, asPlayerId(0), GATED_RESOURCE) === expectConnected,
        `${label}: the engine's connection is not ${String(expectConnected)}`,
      );

      for (const city of state.cities) {
        const gate = resourceGate(state, RULESET, city.owner, gated);
        const menu = cityProductionOptions(state, RULESET, city.id).some(
          (item) => itemKey(item) === itemKey(gated),
        );
        const applied = applyCommand(
          state,
          city.owner,
          { type: 'SetProduction', cityId: city.id, item: gated },
          RULESET,
        );
        const planned = planSetProduction(state, RULESET, city.owner, city.id, gated);

        rec.check(
          (gate.kind === 'open') === applied.ok,
          `${label}: city ${String(city.id)} — the gate says ${gate.kind} but the applier ` +
            `says ok=${String(applied.ok)}`,
        );
        rec.check(
          menu === planned.ok && planned.ok === applied.ok,
          `${label}: city ${String(city.id)} — menu ${String(menu)}, plan ${String(
            planned.ok,
          )}, applier ${String(applied.ok)}`,
        );

        if (!applied.ok) {
          rec.check(
            applied.error.kind === 'resource-not-connected',
            `${label}: city ${String(city.id)} — refused as ${applied.error.kind}`,
          );
          if (applied.error.kind === 'resource-not-connected') {
            rec.check(
              applied.error.resource === GATED_RESOURCE,
              `${label}: the refusal names ${String(applied.error.resource)}`,
            );
          }
        }

        // The whole universe, both directions, on this board.
        for (const item of items) {
          const offered = cityProductionOptions(state, RULESET, city.id).some(
            (option) => itemKey(option) === itemKey(item),
          );
          const accepted = applyCommand(
            state,
            city.owner,
            { type: 'SetProduction', cityId: city.id, item },
            RULESET,
          ).ok;
          rec.check(
            offered === accepted,
            `${label}: city ${String(city.id)} ${itemKey(item)} — offered ${String(
              offered,
            )} but accepted ${String(accepted)}`,
          );
        }
      }
    }

    // Non-vacuity: the boards must differ in connectedness, and the menu must both
    // offer and hide the gated unit.
    const [roadState, noRoadState] = [boards[0]?.[1], boards[1]?.[1]];
    expect(roadState).toBeDefined();
    expect(noRoadState).toBeDefined();
    if (roadState === undefined || noRoadState === undefined) return;
    expect(
      cityProductionOptions(roadState, RULESET, asCityId(0)).some(
        (item) => itemKey(item) === itemKey(gated),
      ),
    ).toBe(true);
    expect(
      cityProductionOptions(noRoadState, RULESET, asCityId(0)).some(
        (item) => itemKey(item) === itemKey(gated),
      ),
    ).toBe(false);
    expect(failuresOf(rec)).toEqual([]);
  });

  /**
   * The connection is monotone under play, which is what makes the completion-time
   * asymmetry in `production.ts` (a building is re-checked, a unit is not)
   * unreachable rather than merely untested: roads are only ever added
   * (`withoutImprovement` has no caller outside tests) and cities are only ever
   * founded, so the reached set can only grow.
   */
  it('proves the connection is monotone under play, so a gate cannot close before completion', () => {
    const rec = recorder();
    const prng = makePrng(99);
    let state = mustStart(3);
    const improvementsAtStart = state.improvements.length;
    let previous: readonly ResourceId[] | undefined;

    // A job has to be allowed to finish, so the policy ends the turn whenever a
    // worker is mid-job — moving a working unit would cancel it, and a walk that
    // never completed anything would prove nothing.
    const policy = (current: GameState): Offer | undefined => {
      if (current.units.some((unit) => unit.work !== undefined)) {
        const actor = civIdsOf(current)[0];
        return actor === undefined ? undefined : { player: actor, cmd: { type: 'EndTurn' } };
      }
      const offers = offersFor(current);
      const preferred = [
        offers.filter((offer) => offer.cmd.type === 'StartWork'),
        offers.filter((offer) => offer.cmd.type === 'FoundCity'),
        offers.filter((offer) => offer.cmd.type === 'MoveUnit'),
        offers,
      ].find((list) => list.length > 0);
      return preferred === undefined ? undefined : preferred[prng() % preferred.length];
    };

    for (let step = 0; step < 60; step += 1) {
      for (const player of state.players) {
        if (player.kind !== 'civ') continue;
        const connectedNow = resourceSets(state, player.id);
        if (previous !== undefined) {
          for (const resource of previous) {
            rec.check(
              connectedNow.includes(resource),
              `step ${String(step)}: player ${String(player.id)} lost ${String(resource)}`,
            );
          }
        }
        previous = connectedNow;
      }

      rec.check(
        state.improvements.length >= improvementsAtStart,
        `step ${String(step)}: the improvement list shrank`,
      );

      const chosen = policy(state);
      if (chosen === undefined) break;
      const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
      if (!outcome.ok) {
        rec.check(false, `step ${String(step)}: ${cmdKey(chosen.cmd)} was refused`);
        break;
      }
      state = outcome.value.state;
      rec.check(isHashable(state), `step ${String(step)}: the state is unhashable`);
    }

    const gained = state.improvements.length - improvementsAtStart;
    const roadTiles = state.improvements.filter((entry) => entry.kind === ROAD).length;
    console.log(
      `connection monotonicity: ${String(gained)} improvement(s) gained, ${String(
        roadTiles,
      )} road tile(s), ${String(state.cities.length)} city/cities`,
    );
    expect(failuresOf(rec)).toEqual([]);
    // Non-vacuity: the walk has to have built something.
    expect(gained).toBeGreaterThan(0);
    expect(roadTiles).toBeGreaterThan(0);
  });

  it("compares the REPL's printed claim with the engine's own answer, through the real CLI", () => {
    const cliPath = fileURLToPath(new URL('../../headless/src/cli.ts', import.meta.url));
    const observed: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'civts-m4c-adversarial-'));

    try {
      for (const seed of [1, 2, 42]) {
        // The golden harness's own scenario shape (tiny, two civilizations), because
        // that is what the CLI is run with below — the in-process state has to be the
        // same world the REPL is looking at, or the comparison is meaningless.
        const settings: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed };
        const started = newGame(seed, settings, RULESET);
        if (!started.ok) throw new Error(`newGame(${String(seed)}) failed`);
        const state = started.value;
        const settler = state.units.find(
          (unit) => unit.owner === asPlayerId(0) && unitDef(RULESET, unit.type)?.role === 'settler',
        );
        if (settler === undefined) throw new Error(`seed ${String(seed)} has no settler`);

        const founded = applyCommand(
          state,
          asPlayerId(0),
          { type: 'FoundCity', unitId: settler.id },
          RULESET,
        );
        if (!founded.ok) throw new Error(`seed ${String(seed)}: the settler could not found`);
        const after = founded.value.state;

        const scriptPath = join(directory, `session-${String(seed)}.txt`);
        writeFileSync(
          scriptPath,
          `${[`found ${String(settler.id)}`, 'city 0', 'quit'].join('\n')}\n`,
          'utf8',
        );

        const result = spawnSync(
          process.execPath,
          [
            tsxCliPath(),
            cliPath,
            'play',
            '--seed',
            String(seed),
            '--map-size',
            'tiny',
            '--civs',
            '2',
            '--script',
            scriptPath,
          ],
          { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
        );

        expect(result.status, `the CLI failed for seed ${String(seed)}:\n${result.stderr}`).toBe(0);
        const line = result.stdout
          .split('\n')
          .find((candidate) => candidate.trimStart().startsWith('resources:'));
        expect(line, `seed ${String(seed)}: the city view printed no resources line`).toBeDefined();
        if (line === undefined) continue;

        const engineNames = connectedNames(after, asPlayerId(0));
        const claimsNone = line.includes('none connected');
        observed.push(`${String(seed)}: [${engineNames.join(', ')}] vs "${line.trim()}"`);

        if (engineNames.length === 0) {
          expect(claimsNone, `seed ${String(seed)}: the REPL claims a connection: ${line}`).toBe(
            true,
          );
        } else {
          expect(claimsNone, `seed ${String(seed)}: the REPL claims none: ${line}`).toBe(false);
          for (const name of engineNames) {
            expect(line, `seed ${String(seed)}: the REPL omits ${name}: ${line}`).toContain(name);
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    console.log(`REPL vs engine: ${observed.join(' || ')}`);
    // Non-vacuity: at least one session must have had something connected, or the
    // comparison is only ever about the empty set.
    expect(observed.some((entry) => !entry.includes('none connected'))).toBe(true);
    expect(observed).toHaveLength(3);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * 4. Wonders
 * ------------------------------------------------------------------ */

/** A city queued on the wonder with enough shields to finish it this turn. */
const wonderCity = (): { population: number; shields: number; production: ProductionItem } => ({
  population: 2,
  shields: PYRAMIDS.cost,
  production: { kind: 'building', id: PYRAMIDS_ID },
});

describe('4. wonders — globally unique, never double-built, lost only by bankruptcy', () => {
  it('resolves a SAME-TURN race between two civilizations to exactly one holder, in both city-id orders', () => {
    const results: string[] = [];

    for (const order of ['A-first', 'B-first'] as const) {
      const base = capitals();
      const state = built(
        order === 'A-first'
          ? base.addCity(0, [5, 5], wonderCity()).addCity(1, [20, 20], wonderCity())
          : base.addCity(1, [20, 20], wonderCity()).addCity(0, [5, 5], wonderCity()),
      );

      const outcome = applyProduction(state, RULESET);
      const holders = outcome.state.cities.filter((city) => city.buildings.includes(PYRAMIDS_ID));
      const produced = producedEventsOf(outcome.events).filter(
        (event) => event.item.kind === 'building' && event.item.id === PYRAMIDS_ID,
      );
      const loser = outcome.state.cities.find((city) => !city.buildings.includes(PYRAMIDS_ID));

      results.push(
        `${order}: holders=[${holders.map((city) => String(city.id)).join(',')}] ` +
          `produced=${String(produced.length)}`,
      );

      // Exactly one holder, exactly one completion, and it is the lowest city id —
      // the pass visits cities in id order and re-reads the state as it goes, which
      // is the whole mechanism that makes the race safe.
      expect(holders).toHaveLength(1);
      expect(produced).toHaveLength(1);
      expect(holders[0]?.id).toBe(asCityId(0));
      expect(buildingHolder(outcome.state, PYRAMIDS_ID)?.id).toBe(asCityId(0));

      // The loser keeps its shields and loses only the entry: nothing was charged
      // for a wonder it did not get.
      expect(loser).toBeDefined();
      if (loser === undefined) continue;
      expect(loser.production).toBeUndefined();
      const before = cityOf(state, loser.id);
      const yieldNow = cityYields(state, RULESET, loser.id);
      const winnerYield = cityYields(state, RULESET, asCityId(0));
      const expectedShields =
        asCityId(0) === loser.id
          ? before.shields + winnerYield.shields - PYRAMIDS.cost
          : before.shields + yieldNow.shields;
      expect(loser.shields).toBe(expectedShields);

      // And no city anywhere may start it now.
      for (const city of outcome.state.cities) {
        expect(mayStartBuilding(outcome.state, buildingCatalog(RULESET), city, PYRAMIDS_ID)).toBe(
          false,
        );
        expect(
          cityProductionOptions(outcome.state, RULESET, city.id).some(
            (item) => itemKey(item) === `building:${String(PYRAMIDS_ID)}`,
          ),
        ).toBe(false);
      }
    }

    console.log(`wonder race: ${results.join(' | ')}`);
    expect(results).toHaveLength(2);
  });

  it('never double-builds over a walk, and counts the wonder exactly once in the world', () => {
    const rec = recorder();
    const prng = makePrng(7);
    // A city one shield short of the wonder, so the walk really completes it.
    let state = withArmy(
      built(
        capitals().addCity(0, [5, 5], {
          population: 2,
          shields: PYRAMIDS.cost - 1,
          production: { kind: 'building', id: PYRAMIDS_ID },
        }),
      ),
      2,
    );
    let completions = 0;

    for (let step = 0; step < 40; step += 1) {
      const holders = state.cities.filter((city) => city.buildings.includes(PYRAMIDS_ID));
      rec.check(
        holders.length <= 1,
        `step ${String(step)}: ${String(holders.length)} cities hold the wonder`,
      );

      // Counted exactly once: the world's growth-food total is the number of
      // granaries plus the wonder, if it stands at all.
      const granaries = state.cities.filter((city) => city.buildings.includes(GRANARY.id)).length;
      const worldTotal = state.cities
        .map((city) => cityBuildingEffects(buildingCatalog(RULESET), city).growthFood)
        .reduce((sum, value) => sum + value, 0);
      rec.check(
        worldTotal === granaries + (holders.length === 1 ? 1 : 0),
        `step ${String(step)}: the world's growth-food is ${String(worldTotal)} but ` +
          `${String(granaries)} granary/granaries and ${String(holders.length)} wonder(s) ` +
          'account for another number',
      );

      const offers = offersFor(state);
      const preferred = [
        offers.filter((offer) => offer.cmd.type === 'StartWork'),
        offers.filter((offer) => offer.cmd.type === 'MoveUnit'),
        offers.filter((offer) => offer.cmd.type === 'FoundCity'),
        offers,
      ].find((list) => list.length > 0);
      const chosen = preferred === undefined ? undefined : preferred[prng() % preferred.length];
      if (chosen === undefined) break;
      const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
      if (!outcome.ok) break;
      completions += producedEventsOf(outcome.value.events).filter(
        (event) => event.item.kind === 'building' && event.item.id === PYRAMIDS_ID,
      ).length;
      state = outcome.value.state;
      rec.check(isHashable(state), `step ${String(step)}: the state is unhashable`);
    }

    const holders = state.cities.filter((city) => city.buildings.includes(PYRAMIDS_ID));
    console.log(
      `wonder walk: ${String(state.cities.length)} cities, ${String(completions)} completion(s), ` +
        `${String(holders.length)} holder(s)`,
    );
    expect(failuresOf(rec)).toEqual([]);
    expect(completions).toBe(1);
    expect(holders).toHaveLength(1);
  });

  it('becomes buildable again after the bankruptcy that disbanded it', () => {
    // No gold income at all (every tenth of commerce to luxuries) and a treasury of
    // zero, against maintenance the city cannot pay: there is no billable unit to
    // sell, so the shortfall takes the wonder itself.
    const board = built(
      capitals()
        .setTreasury(0, 0)
        .setRates(0, { tax: 0, science: 0, luxury: RATE_TOTAL })
        .addCity(0, [5, 5], { population: 2, buildings: [PYRAMIDS_ID] })
        .addCity(1, [20, 20], { population: 2 }),
    );

    expect(buildingHolder(board, PYRAMIDS_ID)?.id).toBe(asCityId(0));
    expect(
      mayStartBuilding(board, buildingCatalog(RULESET), cityOf(board, asCityId(1)), PYRAMIDS_ID),
    ).toBe(false);

    const outcome = applyEconomy(board, RULESET);
    const shortfall = shortfallEventsOf(outcome.events)[0];
    expect(shortfall).toBeDefined();
    expect(shortfall?.unpaid).toBe(PYRAMIDS_MAINTENANCE);
    expect(disbandEventsOf(outcome.events)).toEqual([]);

    expect(buildingHolder(outcome.state, PYRAMIDS_ID)).toBeUndefined();
    expect(cityOf(outcome.state, asCityId(0)).buildings).toEqual([]);
    expect(playerOf(outcome.state, asPlayerId(0))?.treasury).toBe(0);
    for (const city of outcome.state.cities) {
      expect(mayStartBuilding(outcome.state, buildingCatalog(RULESET), city, PYRAMIDS_ID)).toBe(
        true,
      );
    }
    expect(
      cityProductionOptions(outcome.state, RULESET, asCityId(1)).some(
        (item) => itemKey(item) === `building:${String(PYRAMIDS_ID)}`,
      ),
    ).toBe(true);
    expect(PYRAMIDS_MAINTENANCE).toBeGreaterThan(0);
  });

  it('refuses the second city’s start with the typed reason while the first stands', () => {
    const board = built(
      capitals()
        .addCity(0, [5, 5], { population: 2, buildings: [PYRAMIDS_ID] })
        .addCity(1, [20, 20], { population: 2 }),
    );
    const item: ProductionItem = { kind: 'building', id: PYRAMIDS_ID };

    const refused = applyCommand(
      board,
      asPlayerId(1),
      { type: 'SetProduction', cityId: asCityId(1), item },
      RULESET,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.kind).toBe('wonder-already-built');
      if (refused.error.kind === 'wonder-already-built') {
        expect(refused.error.holder).toBe(asCityId(0));
      }
    }

    // The holder itself is refused as already-built, not as a wonder race: the two
    // reasons have different fixes and the message has to say which one it is.
    const own = applyCommand(
      board,
      asPlayerId(0),
      { type: 'SetProduction', cityId: asCityId(0), item },
      RULESET,
    );
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.error.kind).toBe('already-built');
  });
});

/* ------------------------------------------------------------------ *
 * 5. Connection, hand-computed
 * ------------------------------------------------------------------ */

/** Every improvement kind standing anywhere on the board. */
const improvementKinds = (state: GameState): readonly string[] =>
  state.improvements.map((entry) => String(entry.kind));

describe('5. connection — hand-computed against the frozen BFS', () => {
  /**
   * A board with both capitals founded, configured by the case. Cities are added
   * last, after the case has set its terrain, because a capital can stand on hills.
   */
  const connectionBoard = (configure: (builder: ScenarioBuilder) => ScenarioBuilder): GameState =>
    built(
      configure(capitals()).addCity(0, [5, 5], { population: 1 }).addCity(1, [20, 20], {
        population: 1,
      }),
    );

  it('connects a complete chain, and refuses one broken in the middle', () => {
    const complete = connectionBoard((builder) =>
      builder
        .setTile(8, 5, 'hills')
        .addResource(8, 5, STRATEGIC)
        .addImprovement(6, 5, ROAD)
        .addImprovement(7, 5, ROAD),
    );
    // Same geometry, but the road at (7,5) is missing: (8,5) is unreached, so the
    // resource beyond it is not adjacent to anything reached either.
    const broken = connectionBoard((builder) =>
      builder
        .setTile(9, 5, 'hills')
        .addResource(9, 5, STRATEGIC)
        .addImprovement(6, 5, ROAD)
        .addImprovement(8, 5, ROAD),
    );

    expect(resourceSets(complete, asPlayerId(0))).toEqual([STRATEGIC]);
    expect(resourceSets(broken, asPlayerId(0))).toEqual([]);
    expect(isConnected(broken, RULESET, asPlayerId(0), STRATEGIC)).toBe(false);
    // The gate follows the walk, which is the point of the case.
    expect(
      applyCommand(
        broken,
        asPlayerId(0),
        { type: 'SetProduction', cityId: asCityId(0), item: { kind: 'unit', id: GATED_UNIT } },
        RULESET,
      ).ok,
    ).toBe(false);
  });

  it('connects a resource on the city tile with no road anywhere', () => {
    const onCentre = connectionBoard((builder) =>
      builder.setTile(5, 5, 'hills').addResource(5, 5, STRATEGIC),
    );
    expect(resourceSets(onCentre, asPlayerId(0))).toEqual([STRATEGIC]);
    expect(improvementKinds(onCentre)).toEqual([]);
    // A strategic resource is not terrain: it adds nothing to the tile.
    expect(bonusYieldsAt(onCentre, RULESET, at(5, 5))).toEqual({
      food: 0,
      shields: 0,
      commerce: 0,
    });
  });

  it('connects two resources sharing a tile, and only the bonus one changes the tile', () => {
    const shared = connectionBoard((builder) =>
      builder
        .setTile(7, 5, 'hills')
        .addResource(7, 5, STRATEGIC)
        .addResource(7, 5, LUXURY)
        .addImprovement(6, 5, ROAD),
    );
    const set = resourceSets(shared, asPlayerId(0));
    expect(set).toContain(STRATEGIC);
    expect(set).toContain(LUXURY);
    expect(bonusYieldsAt(shared, RULESET, at(7, 5))).toEqual({ food: 0, shields: 0, commerce: 0 });

    // A bonus resource is terrain: it adds its yields on a tile no road reaches.
    const bonusRow = CATALOG.resources.find((row) => row.kind === 'bonus' && row.yields.food > 0);
    expect(bonusRow).toBeDefined();
    if (bonusRow === undefined) return;
    const role = bonusRow.allowedRoles[0];
    expect(role).toBeDefined();
    if (role === undefined) return;
    const bonus = connectionBoard((builder) =>
      builder.setTile(11, 11, role).addResource(11, 11, BONUS),
    );
    expect(isConnected(bonus, RULESET, asPlayerId(0), BONUS)).toBe(false);
    expect(bonusYieldsAt(bonus, RULESET, at(11, 11))).toEqual(bonusRow.yields);
  });

  it('connects 8-way, endpoints inclusive, with no path length limit', () => {
    // A purely diagonal chain: only 8-way adjacency reaches (9,9) from (5,5).
    const diagonal = connectionBoard((builder) =>
      builder
        .setTile(9, 9, 'hills')
        .addResource(9, 9, STRATEGIC)
        .addImprovement(6, 6, ROAD)
        .addImprovement(7, 7, ROAD)
        .addImprovement(8, 8, ROAD),
    );
    expect(resourceSets(diagonal, asPlayerId(0))).toEqual([STRATEGIC]);

    // A long chain: 19 road tiles between the capital and the resource, with no
    // road on either endpoint.
    let long = settled().setTile(25, 5, 'hills').addResource(25, 5, STRATEGIC);
    for (let x = 6; x <= 24; x += 1) long = long.addImprovement(x, 5, ROAD);
    const longState = built(long);
    expect(resourceSets(longState, asPlayerId(0))).toEqual([STRATEGIC]);
  });

  it('grants a barbarian city’s owner nothing', () => {
    const barbarian = built(
      capitals()
        .addBarbarianPlayer()
        .setTile(8, 5, 'hills')
        .addResource(8, 5, STRATEGIC)
        .addImprovement(6, 5, ROAD)
        .addUnit(2, MILITARY, [30, 30])
        .addCity(2, [7, 5], { population: 1 }),
    );
    const barbarianId = asPlayerId(2);
    expect(playerOf(barbarian, barbarianId)?.kind).toBe('barbarian');
    expect(resourceSets(barbarian, barbarianId)).toEqual([]);
    expect(isConnected(barbarian, RULESET, barbarianId, STRATEGIC)).toBe(false);
    expect(resourceGate(barbarian, RULESET, barbarianId, { kind: 'unit', id: GATED_UNIT })).toEqual(
      {
        kind: 'blocked',
        resource: STRATEGIC,
      },
    );

    // The city right beside the iron may not build the gated unit, because its
    // owner has no economy and therefore no connections.
    const barbarianCity = barbarian.cities.find((city) => city.owner === barbarianId);
    expect(barbarianCity).toBeDefined();
    if (barbarianCity === undefined) return;
    const refused = applyCommand(
      barbarian,
      barbarianId,
      { type: 'SetProduction', cityId: barbarianCity.id, item: { kind: 'unit', id: GATED_UNIT } },
      RULESET,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe('resource-not-connected');
  });
});

/* ------------------------------------------------------------------ *
 * 6. Money still conserves with maintenance in play
 * ------------------------------------------------------------------ */

/**
 * The contract's split, restated: `rate` tenths of `commerce` to each channel,
 * floored, and the remainder of the three divisions to gold.
 */
const contractSplit = (
  commerce: number,
  rates: { tax: number; science: number; luxury: number },
): { gold: number; beakers: number; luxuries: number } => {
  const tax = Math.floor((commerce * rates.tax) / RATE_TOTAL);
  const science = Math.floor((commerce * rates.science) / RATE_TOTAL);
  const luxury = Math.floor((commerce * rates.luxury) / RATE_TOTAL);
  return { gold: tax + (commerce - (tax + science + luxury)), beakers: science, luxuries: luxury };
};

/**
 * The buildings `disbandBuildings` would take to cover `amount`, re-derived here
 * from its documented rule: cities in descending id order, each city's list from the
 * end, zero-maintenance rows skipped, until the maintenance taken covers the amount.
 */
const expectedBuildingLosses = (
  state: GameState,
  playerId: PlayerId,
  amount: number,
): readonly string[] => {
  const lost: string[] = [];
  let owed = amount;
  const cities = state.cities
    .filter((city) => city.owner === playerId)
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const city of cities) {
    for (let index = city.buildings.length - 1; index >= 0 && owed > 0; index -= 1) {
      const id = city.buildings[index];
      if (id === undefined) continue;
      const maintenance = maintenanceOf(catalogRow(id));
      if (maintenance <= 0) continue;
      lost.push(`${String(city.id)}:${String(id)}`);
      owed -= maintenance;
    }
  }
  return lost;
};

interface MaintenanceTotals {
  turns: number;
  playerTurns: number;
  maintenancePaid: number;
  maintenanceTurns: number;
  incomeGold: number;
  disbands: number;
  shortfalls: number;
  unpaid: number;
  buildingLosses: number;
  minTreasury: number;
}

interface MaintenanceRun {
  readonly failures: readonly string[];
  readonly totals: MaintenanceTotals;
  readonly finals: readonly GameState[];
}

/**
 * Run `turns` turns on `board` and check, every turn and for every civilization:
 * the income and the upkeep the events report are exactly what the contract's rules
 * produce from the state the money loop saw; the ledger identity
 * `treasury + income - upkeep + covered + unpaid` holds to the piece; the treasury
 * is never negative; and every building that disappeared is one `disbandBuildings`
 * would have taken for that turn's unpaid shortfall.
 */
const maintenanceSweep = (board: GameState, turns: number, label: string): MaintenanceRun => {
  const rec = recorder();
  const totals: MaintenanceTotals = {
    turns: 0,
    playerTurns: 0,
    maintenancePaid: 0,
    maintenanceTurns: 0,
    incomeGold: 0,
    disbands: 0,
    shortfalls: 0,
    unpaid: 0,
    buildingLosses: 0,
    minTreasury: Number.POSITIVE_INFINITY,
  };
  let state = board;

  for (let turn = 0; turn < turns; turn += 1) {
    totals.turns += 1;
    const where = (extra: string): string => `${label} turn ${String(turn)}: ${extra}`;

    // The documented pipeline, replicated (growth, production, money, refill), so
    // the money loop's own input state is observable here rather than guessed at.
    const grown = applyGrowth(state, RULESET).state;
    const produced = applyProduction(grown, RULESET).state;
    const economy = applyEconomy(produced, RULESET);

    const replicated: GameState = {
      ...economy.state,
      units: economy.state.units.map(refilled),
      turn: economy.state.turn + 1,
    };
    const pipeline = advanceTurn(state, RULESET);
    rec.check(
      hashValue(replicated) === hashValue(pipeline.state),
      where('the replicated pipeline differs from advanceTurn'),
    );
    rec.check(
      hashValue(moneyEventsOf(pipeline.events)) === hashValue(moneyEventsOf(economy.events)),
      where("the pipeline's money events are not the money loop's own"),
    );

    const incomes = incomeEventsOf(economy.events);
    const upkeeps = upkeepEventsOf(economy.events);
    const disbands = disbandEventsOf(economy.events);
    const shortfalls = shortfallEventsOf(economy.events);

    for (const player of state.players) {
      if (player.kind !== 'civ') continue;
      totals.playerTurns += 1;

      const income = incomes.find((event) => event.playerId === player.id);
      const upkeep = upkeeps.find((event) => event.playerId === player.id);
      rec.check(income !== undefined && upkeep !== undefined, where('a ledger line is missing'));
      if (income === undefined || upkeep === undefined) continue;

      const cities = produced.cities.filter((city) => city.owner === player.id);
      let gold = 0;
      let beakers = 0;
      let luxuries = 0;
      let maintenance = 0;
      for (const city of cities) {
        const commerce = cityYields(produced, RULESET, city.id).commerce;
        const split = contractSplit(commerce, player.rates);
        rec.check(
          split.gold + split.beakers + split.luxuries === commerce,
          where(`city ${String(city.id)}: the channels do not add up to ${String(commerce)}`),
        );
        gold += split.gold;
        beakers += split.beakers;
        luxuries += split.luxuries;
        for (const building of city.buildings) {
          maintenance += maintenanceOf(catalogRow(building));
        }
      }

      const units = produced.units.filter((unit) => unit.owner === player.id).length;
      const support =
        Math.max(0, units - (FREE_UNITS_PER_CITY * cities.length + FREE_UNITS_BASE)) *
        UNIT_SUPPORT_COST;

      rec.check(
        income.gold === gold && income.beakers === beakers && income.luxuries === luxuries,
        where(
          `IncomeCollected [${String(income.gold)},${String(income.beakers)},${String(
            income.luxuries,
          )}] but the contract's split gives [${String(gold)},${String(beakers)},${String(
            luxuries,
          )}]`,
        ),
      );
      rec.check(
        upkeep.maintenance === maintenance &&
          upkeep.unitSupport === support &&
          upkeep.gold === maintenance + support,
        where(
          `UpkeepPaid ${JSON.stringify(upkeep)} but the contract says ${String(
            maintenance,
          )} maintenance + ${String(support)} support`,
        ),
      );

      const mine = disbands.filter((event) => event.playerId === player.id);
      const covered = mine.reduce((sum, event) => sum + event.saved, 0);
      const shortfall = shortfalls.find((event) => event.playerId === player.id);
      const unpaid = shortfall === undefined ? 0 : shortfall.unpaid;
      const after = playerOf(economy.state, player.id);
      rec.check(after !== undefined, where('a civilization vanished'));
      if (after === undefined) continue;

      rec.check(
        after.treasury === player.treasury + income.gold - upkeep.gold + covered + unpaid,
        where(
          `the ledger does not balance: ${String(player.treasury)} + ${String(
            income.gold,
          )} - ${String(upkeep.gold)} + ${String(covered)} + ${String(unpaid)} != ${String(
            after.treasury,
          )}`,
        ),
      );
      rec.check(
        Number.isInteger(after.treasury) && after.treasury >= 0,
        where(`the treasury is ${String(after.treasury)}`),
      );
      rec.check(
        after.beakers === player.beakers + income.beakers &&
          after.luxuries === player.luxuries + income.luxuries,
        where('the inert pools did not take the split'),
      );

      // The buildings that disappeared, in the **order the documented rule reads
      // them** (cities in descending id order, each city's list from the end), so
      // the comparison below is about the rule and not about how the surviving
      // state happens to be stored.
      const afterCounts = new Map<string, number>();
      for (const city of economy.state.cities) {
        if (city.owner !== player.id) continue;
        for (const id of city.buildings) {
          const key = `${String(city.id)}:${String(id)}`;
          afterCounts.set(key, (afterCounts.get(key) ?? 0) + 1);
        }
      }
      const taken: string[] = [];
      const citiesDesc = produced.cities
        .filter((city) => city.owner === player.id)
        .sort((a, b) => Number(b.id) - Number(a.id));
      for (const city of citiesDesc) {
        for (let index = city.buildings.length - 1; index >= 0; index -= 1) {
          const id = city.buildings[index];
          if (id === undefined) continue;
          const key = `${String(city.id)}:${String(id)}`;
          const stillThere = afterCounts.get(key) ?? 0;
          if (stillThere > 0) {
            afterCounts.set(key, stillThere - 1);
            continue;
          }
          taken.push(key);
        }
      }
      totals.buildingLosses += taken.length;
      if (taken.length > 0) {
        rec.check(
          unpaid > 0,
          where(`${String(taken.length)} building(s) were lost without an unpaid shortfall`),
        );
        rec.check(
          taken.join(',') === expectedBuildingLosses(produced, player.id, unpaid).join(','),
          where(
            `buildings taken [${taken.join(',')}] but the documented rule gives ` +
              `[${expectedBuildingLosses(produced, player.id, unpaid).join(',')}]`,
          ),
        );
      }

      if (upkeep.maintenance > 0) totals.maintenanceTurns += 1;
      totals.maintenancePaid += upkeep.maintenance;
      totals.incomeGold += income.gold;
      totals.disbands += mine.length;
      totals.shortfalls += shortfall === undefined ? 0 : 1;
      totals.unpaid += unpaid;
      totals.minTreasury = Math.min(totals.minTreasury, after.treasury);
    }

    rec.check(isHashable(economy.state), where('the post-money state is unhashable'));

    const acting = civIdsOf(state)[0];
    if (acting === undefined) break;
    const ended = applyCommand(state, acting, { type: 'EndTurn' }, RULESET);
    rec.check(ended.ok, where('EndTurn was refused'));
    if (!ended.ok) break;
    state = ended.value.state;
  }

  return { failures: rec.problems, totals, finals: [state] };
};

describe('6. money — conserved with maintenance in play, treasury never negative', () => {
  it('accounts for every gold piece over 120 turns with maintenance in play', () => {
    const affordable = ORDINARY_ROWS.find((row) => maintenanceOf(row) > 0);
    expect(affordable).toBeDefined();
    if (affordable === undefined) return;
    const bill = maintenanceOf(affordable);
    expect(bill).toBeGreaterThan(0);

    const board = built(
      capitals()
        .setTreasury(0, STARTING_TREASURY)
        .setTreasury(1, STARTING_TREASURY)
        .addCity(0, [5, 5], { population: 3, buildings: [affordable.id] })
        .addCity(0, [9, 9], { population: 2, buildings: [affordable.id] })
        .addCity(1, [20, 20], { population: 3, buildings: [affordable.id] })
        .addCity(1, [24, 24], { population: 2, buildings: [affordable.id] }),
    );

    const run = maintenanceSweep(board, 120, 'sustained');
    console.log('m4c sustained maintenance totals:', JSON.stringify(run.totals));
    expect(run.failures).toEqual([]);

    // Non-vacuity: maintenance was really charged on every single player-turn, gold
    // really moved, and nothing was lost because nothing went unpaid.
    expect(run.totals.turns).toBe(120);
    expect(run.totals.playerTurns).toBe(240);
    expect(run.totals.maintenanceTurns).toBe(run.totals.playerTurns);
    expect(run.totals.maintenancePaid).toBe(2 * 2 * bill * 120);
    expect(run.totals.incomeGold).toBeGreaterThan(0);
    expect(run.totals.shortfalls).toBe(0);
    expect(run.totals.buildingLosses).toBe(0);
    expect(run.finals[0]?.cities.every((city) => city.buildings.length === 1)).toBe(true);
    expect(run.finals[0]?.players.every((player) => player.treasury >= 0)).toBe(true);
  }, 300_000);

  it('conserves while maintenance bankrupts its owner and is paid with the buildings themselves', () => {
    const expensive = [...ORDINARY_ROWS]
      .filter((row) => maintenanceOf(row) > 0)
      .sort((a, b) => maintenanceOf(b) - maintenanceOf(a))[0];
    expect(expensive).toBeDefined();
    if (expensive === undefined) return;
    expect(maintenanceOf(expensive)).toBeGreaterThanOrEqual(2);

    let board = built(
      capitals()
        .setTreasury(0, 0)
        .setTreasury(1, 0)
        .setRates(0, { tax: 0, science: 0, luxury: RATE_TOTAL })
        .setRates(1, { tax: 0, science: 0, luxury: RATE_TOTAL })
        .addCity(0, [5, 5], { population: 3 })
        .addCity(0, [9, 9], { population: 3, buildings: [expensive.id] })
        .addCity(0, [13, 13], { population: 3, buildings: [expensive.id] })
        .addCity(1, [20, 20], { population: 3 }),
    );
    for (const player of board.players) {
      if (player.kind !== 'civ') continue;
      for (let n = 0; n < 12; n += 1) {
        board = spawnUnitAt(board, MILITARY, player.id, player.startingTile).state;
      }
    }

    const run = maintenanceSweep(board, 60, 'bankrupt');
    console.log('m4c bankrupt maintenance totals:', JSON.stringify(run.totals));
    expect(run.failures).toEqual([]);

    // Non-vacuity, all of it: the load was unpayable, units were sold, and the
    // buildings themselves paid for the rest.
    expect(run.totals.maintenancePaid).toBeGreaterThan(0);
    expect(run.totals.shortfalls).toBeGreaterThan(0);
    expect(run.totals.unpaid).toBeGreaterThan(0);
    expect(run.totals.disbands).toBeGreaterThan(0);
    expect(run.totals.buildingLosses).toBeGreaterThan(0);
    expect(run.totals.minTreasury).toBe(0);
    expect(run.finals[0]?.players.every((player) => player.treasury >= 0)).toBe(true);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * 7. Determinism, in-process and in a fresh process
 * ------------------------------------------------------------------ */

interface Recording {
  readonly seed: number;
  readonly mapSize: string;
  readonly civCount: number;
  readonly spawns: readonly {
    readonly owner: number;
    readonly type: string;
    readonly tile: number;
  }[];
  readonly commands: readonly { readonly player: number; readonly cmd: Command }[];
}

interface Replay {
  readonly hash: string;
  readonly gold: readonly number[];
  readonly connected: readonly string[];
  readonly buildings: number;
  readonly improvements: number;
  readonly units: number;
}

const replayLine = (replay: Replay): string =>
  [
    replay.hash,
    replay.gold.join(','),
    replay.connected.join('+'),
    String(replay.buildings),
    String(replay.improvements),
    String(replay.units),
  ].join(' ');

/**
 * Record a **deliberate**, deterministic game rather than a random walk: found a
 * city with every civilization's settler, put the first worker on a job (walking it
 * until one is legal) and let the turns run until the improvement stands, queue a
 * building in a city, then pad with moves and turn ends. The point is that the
 * replay really reaches the M4c state it compares — a walk that never completed an
 * improvement would compare two empty improvement lists.
 *
 * A job must be allowed to finish, so the job loop ends the turn whenever the
 * worker is mid-job: moving a working unit cancels it.
 */
const recordGame = (seed: number, padding: number): Recording => {
  let state = mustStart(seed, 2);
  const spawns: { owner: number; type: string; tile: number }[] = [];
  for (const player of state.players) {
    if (player.kind !== 'civ') continue;
    for (let n = 0; n < 3; n += 1) {
      const spawned = spawnUnitAt(state, MILITARY, player.id, player.startingTile);
      state = spawned.state;
      spawns.push({
        owner: Number(player.id),
        type: String(MILITARY),
        tile: Number(player.startingTile),
      });
    }
  }

  const commands: { player: number; cmd: Command }[] = [];
  const push = (player: PlayerId, cmd: Command): boolean => {
    const outcome = applyCommand(state, player, cmd, RULESET);
    if (!outcome.ok) return false;
    commands.push({ player: Number(player), cmd });
    state = outcome.value.state;
    return true;
  };

  for (const player of civIdsOf(state)) {
    const settler = state.units.find(
      (unit) => unit.owner === player && unitDef(RULESET, unit.type)?.role === 'settler',
    );
    if (settler !== undefined) push(player, { type: 'FoundCity', unitId: settler.id });
  }

  const workerOf = (player: PlayerId): Unit | undefined =>
    state.units.find(
      (unit) => unit.owner === player && unitDef(RULESET, unit.type)?.role === 'worker',
    );

  const improvementsAtStart = state.improvements.length;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (state.improvements.length > improvementsAtStart) break;
    const actor = civIdsOf(state)[0];
    if (actor === undefined) break;
    const worker = workerOf(actor);
    if (worker === undefined) break;
    if (worker.work !== undefined) {
      push(actor, { type: 'EndTurn' });
      continue;
    }
    const actions = [...unitActions(state, RULESET, worker.id)];
    const start = actions.find((action) => action.type === 'StartWork');
    if (start !== undefined) {
      push(actor, start);
      continue;
    }
    const move = actions.find((action) => action.type === 'MoveUnit');
    if (move !== undefined) {
      push(actor, move);
      continue;
    }
    push(actor, { type: 'EndTurn' });
  }

  // Queue a building where it is legal, then pad with moves and turns so the walk
  // covers unit, city and money commands at once.
  for (const city of state.cities) {
    const item: ProductionItem = { kind: 'building', id: GRANARY.id };
    push(city.owner, { type: 'SetProduction', cityId: city.id, item });
  }

  const prng = makePrng(seed * 7 + 1);
  while (commands.length < padding) {
    const actor = civIdsOf(state)[0];
    if (actor === undefined) break;
    const offers = offersFor(state);
    const moves = offers.filter((offer) => offer.cmd.type === 'MoveUnit');
    const jobInFlight = state.units.some((unit) => unit.work !== undefined);
    const useMove = !jobInFlight && moves.length > 0 && commands.length % 3 !== 2;
    if (useMove) {
      const chosen = moves[prng() % moves.length];
      if (chosen === undefined) break;
      if (!push(chosen.player, chosen.cmd)) break;
      continue;
    }
    if (!push(actor, { type: 'EndTurn' })) break;
  }

  return { seed, mapSize: 'duel', civCount: 2, spawns, commands };
};

const replay = (recording: Recording): Replay => {
  let state = mustStart(recording.seed, recording.civCount);
  for (const spawn of recording.spawns) {
    state = spawnUnitAt(
      state,
      asUnitTypeId(spawn.type),
      asPlayerId(spawn.owner),
      asTileIndex(spawn.tile),
    ).state;
  }
  for (const entry of recording.commands) {
    const outcome = applyCommand(state, asPlayerId(entry.player), entry.cmd, RULESET);
    if (!outcome.ok) {
      throw new Error(
        `recorded command refused: ${JSON.stringify(entry.cmd)} -> ${JSON.stringify(outcome.error)}`,
      );
    }
    state = outcome.value.state;
  }
  return {
    hash: hashValue(state),
    gold: state.players.map((player) => player.treasury),
    connected: [...resourceSets(state, asPlayerId(0))].sort(),
    buildings: state.cities.reduce((sum, city) => sum + city.buildings.length, 0),
    improvements: state.improvements.length,
    units: state.units.length,
  };
};

const tsxCliPath = (): string => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch (cause) {
    throw new Error(
      'the fresh-process check needs the `tsx` devDependency: ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
};

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The child program: the same recording, replayed by a brand-new Node process. */
const childScript = (recording: Recording): string => `
import {
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitTypeId,
  newGame,
  spawnUnit,
  isConnected,
  DEFAULT_SETTINGS,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const recording = JSON.parse(${JSON.stringify(JSON.stringify(recording))});
const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const settings = {
  ...DEFAULT_SETTINGS,
  mapSize: recording.mapSize,
  civCount: recording.civCount,
  seed: recording.seed,
};
const started = newGame(recording.seed, settings, ruleset);
if (!started.ok) throw new Error('newGame failed');
let state = started.value;

for (const spawn of recording.spawns) {
  const def = ruleset.units.find((unit) => unit.id === spawn.type);
  if (def === undefined) throw new Error('no unit type ' + String(spawn.type));
  state = spawnUnit(state, def, asPlayerId(spawn.owner), asTileIndex(spawn.tile)).state;
}

for (const entry of recording.commands) {
  const outcome = applyCommand(state, asPlayerId(entry.player), entry.cmd, ruleset);
  if (!outcome.ok) throw new Error('recorded command refused: ' + JSON.stringify(entry.cmd));
  state = outcome.value.state;
}

const connected = CATALOG.resources
  .filter((row) => isConnected(state, ruleset, asPlayerId(0), row.id))
  .map((row) => row.id)
  .sort();

console.log('RESULT ' + [
  hashValue(state),
  state.players.map((player) => player.treasury).join(','),
  connected.join('+'),
  String(state.cities.reduce((sum, city) => sum + city.buildings.length, 0)),
  String(state.improvements.length),
  String(state.units.length),
].join(' '));
`;

describe('7. determinism — in-process and in a fresh process', () => {
  it('replays a game with cities and improvements to the same state, twice in-process', () => {
    const recording = recordGame(5, 70);
    const first = replay(recording);
    const second = replay(recording);

    expect(second).toEqual(first);
    // Non-vacuity: the recording has to have reached the state it compares.
    expect(recording.commands.length).toBeGreaterThan(40);
    expect(first.improvements).toBeGreaterThan(0);
    expect(first.units).toBeGreaterThan(0);
    console.log(
      `m4c recording: ${String(recording.commands.length)} commands, ${replayLine(first)}`,
    );
  }, 180_000);

  it('reproduces the same line in a fresh process', () => {
    const recording = recordGame(17, 70);
    const expected = replay(recording);

    const result = spawnSync(process.execPath, [tsxCliPath(), '-e', childScript(recording)], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(
      result.status,
      `the fresh process failed:\n${result.stderr}${
        result.error === undefined ? '' : result.error.message
      }`,
    ).toBe(0);

    const lines = result.stdout
      .split('\n')
      .filter((candidate) => candidate.startsWith('RESULT '))
      .map((candidate) => candidate.slice('RESULT '.length).trim());
    expect(lines).toHaveLength(1);

    const observed = lines[0] ?? '';
    console.log(`fresh process: ${observed} | in-process: ${replayLine(expected)}`);
    // The whole line, not only the hash: a hash collision could hide a different
    // connected set, and the resource and improvement paths are what M4c added.
    expect(observed).toBe(replayLine(expected));
    expect(expected.improvements).toBeGreaterThan(0);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * 8. Are the goldens still a real gate?
 * ------------------------------------------------------------------ */

describe('8. goldens: still a real gate, and what covers what', () => {
  it('stores exactly the hashes this build produces, with the resource list inside the hashed input', () => {
    const stored = loadGoldens();
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    const goldenState = (seed: number): GameState => {
      const settings: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed };
      const result = newGame(seed, settings, RULESET);
      if (!result.ok) throw new Error(`golden newGame(${String(seed)}) failed`);
      return result.value;
    };

    const computed = [1, 42, 1337].map((seed) => hashValue(goldenState(seed)));
    console.log('m4c golden hashes:', computed.join(' '));

    // The M4c pins, recomputed here without the harness and without the
    // regeneration env var: SCHEMA_VERSION 6, the map's `resources` list inside the
    // hashed input, and nothing else moved.
    expect(computed).toEqual(['b348542b99463975', '282dc8ea55459c0f', '549641adc3c31b67']);
    expect(stored.entries.map((entry) => entry.hash)).toEqual(computed);
    expect(SCHEMA_VERSION).toBe(6);
    expect(stored.nodeMajor).toBe(Number(process.versions.node.split('.')[0]));

    // The field is really inside the digest, which is what makes the rehash an M4c
    // rehash rather than an incidental one.
    const state = goldenState(42);
    expect(state.map.resources.length).toBeGreaterThan(0);
    const perturbed = {
      ...state,
      map: { ...state.map, resources: state.map.resources.slice(0, -1) },
    };
    expect(hashValue(perturbed)).not.toBe(hashValue(state));
  });
});

/* ------------------------------------------------------------------ *
 * What is permanent, and what is only this file
 * ------------------------------------------------------------------ *
 *
 * The M4c invariants this file attacks, and where else they are checked:
 *
 * - **Keystone** (generators vs applier): permanent. `m2-adversarial.test.ts`,
 *   `m3-adversarial.test.ts` and `m4b-adversarial.test.ts` all sweep it in both
 *   directions over real games; `packages/core/test/actions.test.ts` sweeps the
 *   planner/applier agreement for the setters. This file adds the *production* half
 *   (menu vs planner vs applier over the whole item universe) which had no
 *   adversarial sweep before — `actions.test.ts` covers it per-command.
 * - **The resource gate**: permanent in `packages/core/test/resources.test.ts` and
 *   `packages/testing/test/scenarios.test.ts` (the M4c resource scenario), and in
 *   `packages/core/test/actions.test.ts` for the option list. This file is the only
 *   place the gate is checked against `cityProductionOptions` and `applyCommand`
 *   *on the same state, for every item*.
 * - **Effects exact and compounding**: permanent. `packages/core/test/buildings.test.ts`
 *   pins `applyEffectPct`, `effectTotals` and the sum-first rule directly;
 *   `scenarios.test.ts` pins the marketplace/library/barracks/walls/factory
 *   timeline with the floor-each alternative named. The exhaustive 256-subset sweep
 *   and the *count* of discriminating subsets is only here.
 * - **Malformed effects refused**: permanent in `packages/rules/test/rules.test.ts`.
 * - **Wonder uniqueness, including the same-turn race**: the same-turn race is
 *   **only here** and in `packages/core/test/production.test.ts` (which covers two
 *   cities in one pass); the general rule is permanent in `buildings.test.ts`,
 *   `production.test.ts` and the M4c wonder scenario in `scenarios.test.ts`.
 * - **Connection**: permanent in `packages/core/test/resources.test.ts` (broken
 *   chain, adjacency, barbarians) and `scenarios.test.ts`. The hand-computed
 *   two-resources-on-a-tile and barbarian-city cases are also only here.
 * - **Money conservation with maintenance**: permanent for the money loop in
 *   `m4b-adversarial.test.ts`; the M4c addition — a real `TreasuryShortfall` and a
 *   real building loss over many turns, with the taken buildings checked against
 *   the documented rule — is **only here** plus the M4c maintenance scenario in
 *   `scenarios.test.ts`.
 * - **Determinism in a fresh process**: permanent in `m2-adversarial.test.ts`,
 *   `m3-adversarial.test.ts`, `m4a-adversarial.test.ts`, `m4b-adversarial.test.ts`
 *   and `adversarial.test.ts`.
 * - **Goldens as a gate**: permanent. `golden.test.ts` is the gate, and
 *   `m3-adversarial.test.ts` proves it refuses to rewrite itself (it copies the
 *   harness, corrupts a hash, and asserts the file on disk is unchanged). This file
 *   only recomputes the three hashes.
 * - **FINDING 1 (`growth-food` unwired)**: **closed, and now pinned in three
 *   places.** `packages/core/test/growth.test.ts` (Z1) is the unit-level guard —
 *   `applyGrowth` against the reduced threshold, the multi-growth loop, the floor and
 *   the starvation branch; `packages/testing/test/scenarios.test.ts` pins the growth
 *   timeline in a played scenario; and section 2b here is the integration guard: the
 *   effect applied side by side with an unchanged control, through the command layer,
 *   through the multi-growth loop and through carry-over alone, on the Pyramids'
 *   holder and at the floor. Before the fix, nothing in the repo went red when the
 *   effect was inert; that is what these three exist to prevent from recurring.
 *
 * ## The mutation check (run by hand, reverted immediately)
 *
 * A green suite proves nothing until it has been shown to go red. Two mutations were
 * made by hand, each reverted with the file's sha256 verified byte-identical
 * afterwards (`cities.ts` `554cef54…` and `buildings.ts` `e2b0c5b0…` before and
 * after):
 *
 * 1. **Compound flooring broken** — `cityYields` floored each building's percentage
 *    on its own instead of summing the percentages and flooring once. RED in three
 *    files: `packages/core/test/buildings.test.ts` ("compounds two multipliers by
 *    summing their percentages first"), this file's 256-subset sweep, and
 *    `packages/testing/test/scenarios.test.ts` (the M4c effect scenario).
 *    `packages/core/test/cities.test.ts` stayed green, so the compounding rule is
 *    pinned by those three and not by the cities module's own test.
 * 2. **Wonder uniqueness removed** — `mayStartBuilding`'s third step ("no city
 *    anywhere may start a held wonder") was replaced by `return true`, so the
 *    completion-time re-check in `production.ts` could double-build. RED in four
 *    files: `packages/core/test/buildings.test.ts`,
 *    `packages/core/test/production.test.ts`, `packages/testing/test/scenarios.test.ts`,
 *    and three of this file's wonder cases (the same-turn race, the typed refusal,
 *    and the rebuild after bankruptcy). The "never double-builds over a walk" case
 *    stayed green under this mutation, which is worth knowing: with only one city
 *    ever queueing the wonder it counts completions rather than testing uniqueness —
 *    the race case is what carries that rule here.
 *
 * ### 3. The growth-food wiring (Z2's re-verification of the FINDING 1 fix)
 *
 * The wiring was reverted by hand exactly as it was: `growth.ts`' `growthTarget`
 * became `foodBoxSize(population)` again, so the threshold stopped consulting
 * `cityGrowthTarget` — the pre-fix behaviour, and nothing else. Reverted with
 * `growth.ts` byte-identical afterwards (sha256 `edb00229f81177a6…` before and after).
 * RED, exactly where it should be:
 *
 * - **This file: 6 of its 27 cases.** Section 2's "FINDING 1, closed" (the granary
 *   city must grow at 9 while the identical control holds at 9 of 10), and all five of
 *   section 2b's cases — the exact-turn trajectory, the twelve-turn command-layer
 *   trajectory, the multi-growth and carry-over-only boards, the Pyramids completed
 *   through production, and the floor sweep (whose per-combination oracle expects the
 *   reduced boundary the mutated engine no longer has).
 * - **`packages/testing/test/m3-adversarial.test.ts`:** the long-run conservation
 *   sweep fails with **182 distinct problems** (59 on seed 1, 79 on seed 42, 44 on
 *   seed 1337), 103 of them the "food bookkeeping" line — the transcription there
 *   spends the city's *own* reduced requirement, so the mutated engine and the
 *   contract disagree on turn after turn. That is the migration in that file being
 *   load-bearing rather than cosmetic.
 * - **`packages/headless/test/repl.test.ts`:** the new "prints the growth threshold
 *   the engine will use" case fails (`7/9` becomes `7/10`), which is the REPL half of
 *   the finding — before Z2's change to `repl.ts` the view printed the bare curve and
 *   this case did not exist.
 * - **`packages/testing/test/golden.test.ts`: still green, 9/9.** That is the useful
 *   negative result: a golden state is `newGame` at turn 0, so no growth pass runs in
 *   it and the growth-food wiring **cannot** move a golden hash. The three hashes that
 *   did move (`6f2e1f2a…`/`93a436cc…`/`ed23a69c…` -> `b348542b…`/`282dc8ea…`/
 *   `549641ad…`) are therefore **M4c's own rehash** — `SCHEMA_VERSION` 5 -> 6 and the
 *   map's `resources` list entering the hashed input, both pinned by section 8 above —
 *   and not an unreported side effect of the fix. Re-running the golden harness with
 *   the wiring reverted still passes 9/9 against the same three stored hashes, and no
 *   other pinned hash literal in the repo moved either (this file's section 8,
 *   `m3-adversarial.test.ts`'s golden pin, and both files' in-process/fresh-process
 *   determinism cases all stayed green), so **there is no hash movement attributable
 *   to the growth-food fix, and nothing Z1 failed to report**: the movement on disk is
 *   the M4c rehash that section 8 asserts field by field.
 *
 * **The goldens did not move under any of the three mutations.** With wonder
 * uniqueness entirely gone, `packages/testing/test/golden.test.ts` still passed 9/9 —
 * because a golden state is `newGame` at turn 0 and carries no buildings, no
 * maintenance, no shortfall and no connection. The goldens are a real gate for what
 * they cover (generation, state shape, the determinism of the whole pipeline, the M4c
 * `resources` list now that it is inside the hashed input, and — via
 * `m3-adversarial.test.ts`' "fails on a wrong hash and leaves the file on disk
 * untouched" — the harness's refusal to auto-write), but they are **not** the gate
 * for any M4c rule: buildings, wonders, effects, maintenance and connectivity are
 * gated by the tests named above and by nothing else. That is the honest answer to
 * "are the goldens still a real gate": yes for the schema and the generator, no for
 * this milestone's mechanics, which is why the M4c scenario and these sweeps exist.
 */
