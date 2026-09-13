/**
 * `TurnMetrics` — the standing requirement's "Observable", in code.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (point 2,
 * "Observable") and its "`@civts/sim` contract" ("`TurnMetrics` (per turn, per
 * civilization) must be enough to balance from").
 *
 * ## What this module is for
 *
 * A balance change can only be judged from numbers, so every turn of every
 * simulation produces one `TurnMetrics` row **per civilization** — population,
 * cities, units, the three money pools, this turn's three income channels, upkeep
 * and its two halves, the support count, the three yield totals, the buildings
 * held, and the whole-state hash. "It seems to work" is not evidence; a metric is.
 *
 * ## Where every number comes from
 *
 * **Every figure is read from an engine export, never re-derived here.** That rule
 * is the same one the M2 provenance summary broke (a text renderer that computed a
 * figure its structured value did not contain, and the two disagreed), so it is
 * stated rather than assumed:
 *
 * - stock counts (`population`, `cities`, `units`, `buildings`) are folds over
 *   `citiesOf` / `state.units`, and the city list itself comes from `citiesOf`;
 * - the yield totals are `cityYields(...)` summed per city — the engine's own
 *   definition of what a city produces, including improvements, bonus resources and
 *   building multipliers;
 * - `incomeGold`/`incomeBeakers`/`incomeLuxuries` are the turn's own
 *   `IncomeCollected` line for that player, and `maintenance`/`unitSupport` are its
 *   `UpkeepPaid` line: **what the turn actually billed**, not a second opinion about
 *   it. `playerIncome`/`playerUpkeep` are the fallback for a state that a turn did
 *   not produce (see `incomeOf` below);
 * - `unitsSupported` is `unitSupport(...).supported` — the free-allowance rule has
 *   one definition (`economy.ts`) and this is a read of it;
 * - `hash` is `hashValue(state)`, the same canonical-JSON FNV-1a 64 the golden and
 *   replay paths use, so a row can be reproduced from the state it describes.
 *
 * ## Key order, and why "structured" is not "sorted by name"
 *
 * A row's keys are written in the order `TurnMetrics` declares them, and
 * `METRIC_KEY_ORDER` states that order once. It is a **fixed, declared** order — the
 * contract's own reading order (identity, then stocks, then this turn's flows) —
 * never the iteration order of an object built ad hoc, which is what makes
 * `JSON.stringify(row)` byte-stable for two rows that measure the same thing. A
 * name-sorted order would be a different, equally fixed order that reads badly
 * (`beakers` before `cities` before…), so "sorted" here means *deterministic and
 * declared*, and the batch half aggregates over `MEASURED_METRIC_FIELDS` (a list)
 * rather than over any object's keys.
 *
 * ## Integers, and the summation question
 *
 * Every measured field is an **integer count, total or pool**: the engine is
 * integer-only (PLAN.md §5.3) and this module only adds integers up. That is what
 * lets `batch.ts` promise a mean that does not depend on summation order — integer
 * addition is exact in IEEE-754 doubles below 2^53, so the associativity that
 * floating-point addition lacks never arises. `hash` is the one string.
 *
 * ## What this module deliberately does NOT measure (M7d)
 *
 * `SimulationResult.plannerFailures` is **not** a field of `TurnMetrics`, and it must never
 * become one. Every column here is a per-turn, per-civilization *measurement of the world* —
 * population, cities, income, the state hash — and a planner failure is not a property of the
 * world at all: it is a property of the run's **evidence**, saying that some turn of this game
 * was not decided by the AI the run claims to measure. Giving it a row would be wrong three
 * ways: it is not per-civilization (the record already names its `playerId`), it has no
 * meaningful mean (the M7d contract counts it like a *violation*, and a violation has no mean
 * either), and it would put a column that is not an integer count into `MEASURED_METRIC_FIELDS`,
 * which `batch.test.ts` checks is exactly the set of aggregate columns.
 *
 * So the two guards this module owns are unchanged by M7d, and that is the point: the row
 * shape, `METRIC_KEY_ORDER`, `MEASURED_METRIC_FIELDS` and every aggregate folded from them are
 * byte-identical to what they were before the field existed. The failure is carried on the
 * *result* (`types.ts` explains the shape, `runner.ts` how it is read out of the policy,
 * `tournament.ts` how it becomes a verdict), which is where a per-run fact belongs — and the
 * tests in `runner.test.ts` and `batch.test.ts` pin that the carrier exists, is required, and
 * is empty rather than absent when nothing failed.
 *
 * ## Provenance
 *
 * No game magnitude is introduced here and nothing here is claimed to be Civ 3's:
 * the numbers are the engine's, and the only thresholds behind them live in the
 * catalog as `placeholder` rows.
 */

import {
  citiesOf,
  cityYields,
  civPlayers,
  playerIncome,
  playerUpkeep,
  unitSupport,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { hashValue } from '@civts/testing';

import type { TurnMetrics } from './types.js';

/* ------------------------------------------------------------------ *
 * The row's fields, in the one order they are written and read
 * ------------------------------------------------------------------ */

/**
 * The measured columns of a row: everything that is a number *about the game*
 * rather than an identifier of the row.
 *
 * Excluded, deliberately:
 *
 * - `turn` and `playerId` are the row's **key** — what it is, not what it
 *   measured — so averaging them would average coordinates;
 * - `hash` is a string, and a mean over hex is not a number.
 *
 * The list is the batch aggregator's reading order and the completeness guard: a
 * field added to `TurnMetrics` and not added here is caught by
 * `batch.test.ts` (it walks a real row's keys), rather than silently never being
 * aggregated — which is exactly how a balance report comes to omit the one column
 * that mattered.
 */
export type MeasuredMetricField = Exclude<keyof TurnMetrics, 'turn' | 'playerId' | 'hash'>;

export const MEASURED_METRIC_FIELDS: readonly MeasuredMetricField[] = [
  'population',
  'cities',
  'units',
  'treasury',
  'beakers',
  'luxuries',
  'incomeGold',
  'incomeBeakers',
  'incomeLuxuries',
  'maintenance',
  'unitSupport',
  'unitsSupported',
  'food',
  'shields',
  'commerce',
  'buildings',
];

/** The fields that identify a row: which turn, and which civilization. */
export const IDENTITY_METRIC_FIELDS: readonly (keyof TurnMetrics)[] = ['turn', 'playerId'];

/**
 * Every key of a `TurnMetrics` row, in the order the row is written.
 *
 * The row literal in `buildRow` is written in this order too, and
 * `runner.test.ts` / `batch.test.ts` assert `Object.keys(row)` equals this list —
 * so the two cannot drift, and `JSON.stringify` of a row is stable because of it.
 */
export const METRIC_KEY_ORDER: readonly (keyof TurnMetrics)[] = [
  ...IDENTITY_METRIC_FIELDS,
  ...MEASURED_METRIC_FIELDS,
  'hash',
];

/* ------------------------------------------------------------------ *
 * The turn's ledger, read from its events
 * ------------------------------------------------------------------ */

/** Every `IncomeCollected` line of a transition that names this player. */
const incomeLines = (
  events: readonly GameEvent[],
  playerId: PlayerId,
): readonly Extract<GameEvent, { type: 'IncomeCollected' }>[] =>
  events.flatMap((event) =>
    event.type === 'IncomeCollected' && event.playerId === playerId ? [event] : [],
  );

/** Every `UpkeepPaid` line of a transition that names this player. */
const upkeepLines = (
  events: readonly GameEvent[],
  playerId: PlayerId,
): readonly Extract<GameEvent, { type: 'UpkeepPaid' }>[] =>
  events.flatMap((event) =>
    event.type === 'UpkeepPaid' && event.playerId === playerId ? [event] : [],
  );

/** What one player collected this turn: the ledger line, or the engine's own read. */
interface IncomeReading {
  readonly gold: number;
  readonly beakers: number;
  readonly luxuries: number;
}

/**
 * The player's income this turn.
 *
 * **The events are authoritative**, because they are what the turn really banked:
 * the money loop emits one `IncomeCollected` line per civilization per turn,
 * zero amounts included, so a line's absence means the transition was not a turn
 * (`runner.ts` samples after `advanceTurn`, so it always is one) or was not a
 * transition at all — a UI or a report sampling "now" has no event list in hand.
 * That second case is what the fallback is for: `playerIncome` is the engine's own
 * read of what the state implies, and it is the honest answer for a state no turn
 * produced. It is a *fallback*, not a second source of truth — when the ledger has
 * spoken, the ledger is what is reported.
 *
 * Several lines for one player would mean a transition that ran the money loop
 * twice, which `CORE_INVARIANTS` reports as a violation; summing them here keeps the
 * reader total (integer addition, so the order they arrived in cannot matter).
 */
const incomeOf = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  events: readonly GameEvent[],
): IncomeReading => {
  const lines = incomeLines(events, playerId);
  if (lines.length === 0) return playerIncome(state, ruleset, playerId);

  let gold = 0;
  let beakers = 0;
  let luxuries = 0;
  for (const line of lines) {
    gold += line.gold;
    beakers += line.beakers;
    luxuries += line.luxuries;
  }
  return { gold, beakers, luxuries };
};

/** What one player paid this turn, in the two halves the ledger names. */
interface UpkeepReading {
  readonly maintenance: number;
  readonly unitSupport: number;
}

/** The player's upkeep this turn: the `UpkeepPaid` line, or the engine's own read. */
const upkeepOf = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  events: readonly GameEvent[],
): UpkeepReading => {
  const lines = upkeepLines(events, playerId);
  if (lines.length === 0) return playerUpkeep(state, ruleset, playerId);

  let maintenance = 0;
  let unitSupport = 0;
  for (const line of lines) {
    maintenance += line.maintenance;
    unitSupport += line.unitSupport;
  }
  return { maintenance, unitSupport };
};

/* ------------------------------------------------------------------ *
 * One row
 * ------------------------------------------------------------------ */

/**
 * The row for one civilization, given the whole-state `hash` the caller already
 * computed or read.
 *
 * The hash is a *parameter* rather than computed here so that `sampleTurn` can
 * hash a state once for every civilization of a turn instead of once per row: the
 * hash is a property of the world, and the rows of one turn deliberately share it
 * (the contract says so — "the whole-state hash at this turn").
 */
const buildRow = (
  state: GameState,
  playerId: PlayerId,
  ruleset: RulesetView,
  events: readonly GameEvent[],
  hash: string,
): TurnMetrics => {
  const cities = citiesOf(state, playerId);
  const player = state.players.find((candidate) => candidate.id === playerId);

  let population = 0;
  let buildings = 0;
  let food = 0;
  let shields = 0;
  let commerce = 0;
  for (const city of cities) {
    population += city.population;
    buildings += city.buildings.length;
    const yields = cityYields(state, ruleset, city.id);
    food += yields.food;
    shields += yields.shields;
    commerce += yields.commerce;
  }

  const units = state.units.filter((unit) => unit.owner === playerId).length;
  const income = incomeOf(state, ruleset, playerId, events);
  const upkeep = upkeepOf(state, ruleset, playerId, events);

  return {
    turn: state.turn,
    playerId,
    population,
    cities: cities.length,
    units,
    // A player id the state does not carry reads as zeros: this is a read with no
    // failure channel, and "nothing" is the answer `playerIncome` gives such an id
    // too. It is unreachable from `sampleTurn`, which samples players the state
    // holds.
    treasury: player?.treasury ?? 0,
    beakers: player?.beakers ?? 0,
    luxuries: player?.luxuries ?? 0,
    incomeGold: income.gold,
    incomeBeakers: income.beakers,
    incomeLuxuries: income.luxuries,
    maintenance: upkeep.maintenance,
    unitSupport: upkeep.unitSupport,
    unitsSupported: unitSupport(state, ruleset, playerId).supported,
    food,
    shields,
    commerce,
    buildings,
    hash,
  };
};

/* ------------------------------------------------------------------ *
 * The entry points
 * ------------------------------------------------------------------ */

/**
 * One civilization's row for the state as it stands now.
 *
 * `events` is the transition this state is the end of — the turn's ledger, used for
 * the three income channels and the two upkeep halves. Pass `[]` for a state that no
 * transition produced (a UI sampling "now"): the income and upkeep readings then come
 * from `playerIncome`/`playerUpkeep`, which is the same answer the state's own
 * numbers imply.
 *
 * The hash is taken here (`hashValue(state)`), which is right for a single row and
 * wasteful for a whole turn — `sampleTurn` is the entry point for that.
 */
export const playerMetrics = (
  state: GameState,
  playerId: PlayerId,
  ruleset: RulesetView,
  events: readonly GameEvent[],
): TurnMetrics => buildRow(state, playerId, ruleset, events, hashValue(state));

/**
 * Every civilization's row for the state as it stands now, in **player-id order**.
 *
 * `civPlayers` decides who is measured — barbarians are a player but not a
 * civilization, and the contract's row set is "per turn, per civilization" — and
 * the order is the one that list already has, so two samplings of the same state
 * produce the same rows in the same order (a precondition for comparing a batch).
 *
 * One hash for the whole turn: the state is a property of the world, not of a
 * civilization, and hashing it once per row would be the same string computed N
 * times.
 */
export const sampleTurn = (
  state: GameState,
  ruleset: RulesetView,
  events: readonly GameEvent[],
): readonly TurnMetrics[] => {
  const hash = hashValue(state);
  return civPlayers(state).map((player) => buildRow(state, player.id, ruleset, events, hash));
};
