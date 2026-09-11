/**
 * M4b adversarial review (V4: integration owner for M4b, then adversarial
 * review) — an attempt to FALSIFY the frozen M4b contracts in docs/INTERFACES.md
 * ("M4b contracts — FROZEN (the money loop)"), not to confirm them.
 *
 * This file was written after driving `pnpm verify` green from a red gate, so it
 * starts from the code that exists rather than from the prose. What it attacks,
 * and what each attack found:
 *
 * 1. **The keystone, now six generators.** `unitMoveOptions`, `unitActions`,
 *    `legalActions`, `planStartWork`/`planCancelWork` and — M4b's addition —
 *    `planSetRates` must agree with `applyCommand` in *both* directions. The sweep
 *    walks real generated games (with workers, settlers, armies, cities and
 *    bankruptcies in them) and checks soundness for everything the generators yield
 *    and completeness against an exhaustive candidate universe: every tile for
 *    `MoveUnit`, `FoundCity`, one `StartWork` per catalog kind, `CancelWork`,
 *    `EndTurn` per player, and — for the sixth — the whole legal rate space plus a
 *    hostile list of malformed payloads.
 * 2. **Money conservation, the milestone's central claim.** Over 100+ turns on
 *    several seeds, with cities, production, rate changes and mass bankruptcy, every
 *    player's gold is *re-derived from the emitted events* each turn and compared to
 *    the state: the split is recomputed from the contract's own rule (floor each
 *    channel, remainder to gold) rather than by calling `splitCommerce`, upkeep is
 *    recomputed from `FREE_UNITS_PER_CITY`/`FREE_UNITS_BASE`/`UNIT_SUPPORT_COST` and
 *    the player's own cities and units, and the ledger identity
 *    `treasuryAfter - treasuryBefore === income - upkeep + covered + unpaid` is
 *    asserted to the gold every turn. The pipeline's *placement* is checked too: the
 *    state `applyEconomy` returns, refilled and turned over, hashes equal to what
 *    `advanceTurn` produces.
 * 3. **Treasury never negative**, attacked with 180 units on one board, zero income,
 *    three civilizations bankrupt simultaneously, a player with nothing left to
 *    disband, and a state whose treasury the engine cannot read as gold at all.
 * 4. **Bankruptcy determinism**: identical seeds give identical disband sequences and
 *    identical final gold; the same money facts presented in a different array order
 *    (and the same state round-tripped through JSON) disband the same units; and
 *    barbarians are never dissolved, never charged and never counted on anyone's
 *    bill.
 * 5. **Rates**: a change moves the rates and *nothing else* (asserted by reverting the
 *    rates and comparing hashes), never re-collects a banked turn, takes effect for
 *    the next collection, and an illegal triple — negative, fractional, wrong sum,
 *    non-numeric, or a payload that is not an object at all — is refused with the
 *    typed error and leaves the state hash unchanged.
 * 6. **Starting units** on every map size and every civilization count the settings
 *    allow: exactly one settler and one worker per civilization, barbarians none,
 *    nobody on an impassable or occupied tile.
 * 7. **Determinism** in-process and in a fresh process (`npx tsx -e`) over a
 *    money-heavy recorded game: the same seed and the same commands give the same
 *    hash, the same gold for every player and the same disband count. The hashes are
 *    printed.
 * 8. **Whether the goldens are still a real gate**, and which of the invariants above
 *    are checked by something *permanent* rather than only by this file. The audit is
 *    in the closing comment, and where a gap exists it is named rather than papered
 *    over.
 *
 * Findings, stated here so they are not only in the review report:
 *
 * - **One defect, fixed at the source.** `applyCommand(…, { type: 'SetRates', rates:
 *   … })` used to *throw a `TypeError`* — "Cannot read properties of null (reading
 *   'tax')" — when the payload carried `null`, or no `rates` key at all, where every
 *   other malformed command payload in the engine comes back as a typed `GameError`.
 *   `ratesProblem` documented the opposite ("every check below is written to survive
 *   that rather than to trust the type at runtime"), so the totality was owed and not
 *   delivered; `packages/core/src/economy.ts` now reads each rate through a total
 *   `rateField`, and section 5 below pins the typed refusal so a regression is a test
 *   failure rather than a crash in a caller. Nothing that previously succeeded changed
 *   behaviour.
 * - **`TreasuryShortfall` is unreachable from a shipped game.** With the current
 *   catalog, building maintenance is 0, so a shortfall can never exceed what
 *   disbanding every billable unit saves — `unpaid` was 0 on every turn of every sweep
 *   here (450+ player-turns, 1000+ disbands). The branch is correct and is covered by
 *   `packages/core/test/economy.test.ts` against a hand-built maintenance-declaring
 *   ruleset view; what this file adds is the honest boundary, and the other half of it:
 *   the branch *is* reachable the moment a catalog declares maintenance, which is
 *   M4c's job. Asserted, not assumed.
 * - **"Changing rates affects future turns only" is an ambiguity the code resolves in
 *   one direction and this file pins.** A rate change does not recollect, refund or
 *   recompute anything, and there is no moment "after this turn's collection" for a
 *   player to act in — the money loop is the *last* step of the turn — so a change made
 *   during turn N is read by the collection that ends turn N. The alternative
 *   (deferring the write by a turn) would need a pending-rates field the frozen state
 *   shape does not have. Section 5 pins the implemented reading with a twin comparison
 *   so it cannot change silently in either direction.
 * - **No other finding.** The keystone held in both directions on every state swept;
 *   the money loop conserved every gold piece with zero discrepancies; the treasury
 *   never went negative under any attack; the starting-unit contract held on all 84
 *   generated games across the six map sizes and every legal civilization count.
 *
 * Evidence quality, stated so this file is not oversold:
 *
 * - Every sweep is *seeded* (a local integer-hash PRNG, never `Math.random`), so a
 *   failing run reproduces exactly; nothing here reads a clock.
 * - The money checks do **not** trust the module under test for the arithmetic: the
 *   split, the support bill and the maintenance sum are all re-derived here from the
 *   contract's stated rules and the exported placeholder constants.
 * - Provenance: nothing here blesses a number as Civ 3's. The free allowance, the
 *   support cost, `RATE_TOTAL` and the starting treasury are read from `@civts/core`
 *   as the project's own **placeholders**; no number is presented as Civ 3's, and the
 *   catalog's rows are read rather than restated.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RATES,
  DEFAULT_SETTINGS,
  FREE_UNITS_BASE,
  FREE_UNITS_PER_CITY,
  MAP_DIMENSIONS,
  MAP_SIZES,
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
  asPlayerId,
  asTileIndex,
  cityYields,
  legalActions,
  neighbors8,
  newGame,
  planSetRates,
  spawnUnit,
  terrainAtIndex,
  unitActions,
  unitDef,
  type BuildingDef,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type MapSize,
  type PlayerId,
  type Rates,
  type RulesetView,
  type Settings,
  type TileIndex,
  type Unit,
  type UnitDef,
  type UnitRole,
  type UnitTypeId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { loadGoldens } from '../src/goldens.js';
import {
  canonicalize,
  createScenarioBuilder,
  hashValue,
  type ScenarioBuilder,
} from '../src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures and small helpers
 * ------------------------------------------------------------------ */

/** The real, validated content the CLI runs on — not a hand-made view. */
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
const unitOfRole = (role: UnitRole): UnitDef => {
  const def = RULESET.units.find((unit) => unit.role === role);
  if (def === undefined) throw new Error(`the shipped catalog defines no ${role}-role unit`);
  return def;
};

const SETTLER: UnitDef = unitOfRole('settler');
const WORKER: UnitDef = unitOfRole('worker');
const MILITARY: UnitDef = unitOfRole('military');

const DUEL: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/**
 * The settings a sweep asks for. The map size is derived from the civilization count
 * rather than fixed, because `MAP_DIMENSIONS` caps how many civilizations a size can
 * host and `refineSettings` refuses the rest — a fixture must live inside the rules the
 * CLI enforces, not beside them.
 */
const settingsFor = (seed: number, civCount: number = DUEL.civCount): Settings => ({
  ...DUEL,
  mapSize: civCount <= MAP_DIMENSIONS[DUEL.mapSize].maxCivs ? DUEL.mapSize : 'tiny',
  seed,
  civCount,
});

/** A generated game — the shipped `newGame` path, never a hand-built state. */
const startedState = (seed: number, civCount: number = DUEL.civCount): GameState => {
  const result = newGame(seed, settingsFor(seed, civCount), RULESET);
  if (!result.ok) {
    throw new Error(`newGame(${String(seed)}) failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

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

/**
 * A stable key for a command, so two generators can be compared as sets. The switch
 * is exhaustive on purpose: a new `Command` variant that is not keyed here is a
 * *typecheck* failure rather than a silently equal pair of different commands — and
 * M4b's `SetRates` is keyed by its *triple*, because two rate commands naming
 * different splits are different commands.
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

/** A readable rendering of a refusal, for a sweep's failure message. */
const errorText = (error: GameError): string => JSON.stringify(error);

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

/** Every treasury in the state, in player order — the money a replay compares. */
const goldsOf = (state: GameState): readonly number[] => state.players.map((p) => p.treasury);

const END_TURN: Command = { type: 'EndTurn' };

const playersOf = (state: GameState): readonly PlayerId[] => state.players.map((p) => p.id);

const civIdsOf = (state: GameState): readonly PlayerId[] =>
  state.players.filter((player) => player.kind === 'civ').map((player) => player.id);

const playerOf = (state: GameState, playerId: PlayerId): GameState['players'][number] | undefined =>
  state.players.find((player) => player.id === playerId);

/**
 * The every-state invariants M4b is responsible for, checked wherever a state is
 * observed by any sweep in this file: a treasury, a beaker count and a luxury count
 * that is a whole number and never negative (the contract makes the treasury's
 * non-negativity an explicit invariant, and a `NaN` in any of the three would make the
 * state unhashable — the bug class that has bitten this project three times), and a
 * rates triple that still sums to `RATE_TOTAL`.
 */
const checkMoneyShape = (rec: Recorder, state: GameState, where: string): void => {
  for (const player of state.players) {
    const money = [player.treasury, player.beakers, player.luxuries];
    rec.check(
      money.every((value) => Number.isInteger(value) && value >= 0),
      `${where}: player ${String(player.id)} holds [${money.map(String).join(',')}]; ` +
        'every money field must be a whole number >= 0',
    );
    const rates = [player.rates.tax, player.rates.science, player.rates.luxury];
    rec.check(
      rates.every((value) => Number.isInteger(value) && value >= 0) &&
        player.rates.tax + player.rates.science + player.rates.luxury === RATE_TOTAL,
      `${where}: player ${String(player.id)} holds rates [${rates.map(String).join(',')}] ` +
        `which do not sum to ${String(RATE_TOTAL)}`,
    );
  }
};

/* ------------------------------------------------------------------ *
 * The contract's own arithmetic, re-derived here (never called from the module)
 * ------------------------------------------------------------------ */

/**
 * `splitCommerce`'s rule, restated from the contract rather than called: `rate` tenths
 * of `commerce` to each channel, floored, and **the remainder of the three integer
 * divisions to gold**. `floored` is carried out so a caller can check that no channel
 * over-counts its share — with a well-formed triple the three channels add up to exactly
 * the commerce that was split, which is the "no gold invented or destroyed by
 * round-off" half of the milestone's central claim.
 */
interface ContractSplit {
  readonly gold: number;
  readonly beakers: number;
  readonly luxuries: number;
  readonly floored: number;
}

const contractSplit = (commerce: number, rates: Rates): ContractSplit => {
  const tax = Math.floor((commerce * rates.tax) / RATE_TOTAL);
  const science = Math.floor((commerce * rates.science) / RATE_TOTAL);
  const luxury = Math.floor((commerce * rates.luxury) / RATE_TOTAL);
  const floored = tax + science + luxury;
  return { gold: tax + (commerce - floored), beakers: science, luxuries: luxury, floored };
};

/** The support bill the contract's placeholder formula describes. */
const contractSupport = (units: number, cities: number): number =>
  Math.max(0, units - (FREE_UNITS_PER_CITY * cities + FREE_UNITS_BASE)) * UNIT_SUPPORT_COST;

/**
 * What a building row declares as maintenance, read structurally — the same read
 * `economy.ts` makes, restated so the sum in the sweep is not the module agreeing with
 * itself. The shipped catalog declares none (effects are M4c's), which is why the
 * unpaid-shortfall branch is unreachable from a real game.
 *
 * `UpkeepDef` is a test-local extension of `BuildingDef`, not a field added to the real
 * type — M4c owns that shape. It exists so a row can *declare* maintenance in this file
 * without a cast, which is what makes the "reachable only through a maintenance-declaring
 * catalog" half of the finding checkable.
 */
interface UpkeepDef extends BuildingDef {
  readonly maintenance: number;
}

const declaredMaintenance = (def: BuildingDef): number => {
  if (!('maintenance' in def)) return 0;
  const declared: unknown = def.maintenance;
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : 0;
};

/** A temple row for the tests that need the unpaid-shortfall branch to be reachable. */
const temple = (maintenance: number): UpkeepDef => ({
  id: asBuildingId('temple'),
  name: 'Temple',
  cost: 10,
  maintenance,
});

/* ------------------------------------------------------------------ *
 * Money-event readers. The event stream is the ledger, so these are how the sweeps
 * below re-derive what a turn did.
 * ------------------------------------------------------------------ */

type IncomeEvent = Extract<GameEvent, { type: 'IncomeCollected' }>;
type UpkeepEvent = Extract<GameEvent, { type: 'UpkeepPaid' }>;
type DisbandEvent = Extract<GameEvent, { type: 'UnitDisbanded' }>;
type ShortfallEvent = Extract<GameEvent, { type: 'TreasuryShortfall' }>;

const incomeEventsOf = (events: readonly GameEvent[]): readonly IncomeEvent[] =>
  events.flatMap((event) => (event.type === 'IncomeCollected' ? [event] : []));

const upkeepEventsOf = (events: readonly GameEvent[]): readonly UpkeepEvent[] =>
  events.flatMap((event) => (event.type === 'UpkeepPaid' ? [event] : []));

const disbandEventsOf = (events: readonly GameEvent[]): readonly DisbandEvent[] =>
  events.flatMap((event) => (event.type === 'UnitDisbanded' ? [event] : []));

const shortfallEventsOf = (events: readonly GameEvent[]): readonly ShortfallEvent[] =>
  events.flatMap((event) => (event.type === 'TreasuryShortfall' ? [event] : []));

const isMoneyEvent = (
  event: GameEvent,
): event is IncomeEvent | UpkeepEvent | DisbandEvent | ShortfallEvent =>
  event.type === 'IncomeCollected' ||
  event.type === 'UpkeepPaid' ||
  event.type === 'UnitDisbanded' ||
  event.type === 'TreasuryShortfall';

/** The money events only, in order — what the pipeline's tail must be. */
const moneyEventsOf = (events: readonly GameEvent[]): readonly GameEvent[] =>
  events.filter(isMoneyEvent);

/* ------------------------------------------------------------------ *
 * 1. The keystone, six generators, over played games
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
 * Every rate triple this engine accepts, in a fixed order: the whole space of three
 * non-negative integers summing to `RATE_TOTAL`, which is 66 commands at
 * `RATE_TOTAL = 10`. Enumerating it is what makes the sixth generator's check
 * *complete* rather than a sample.
 */
const legalRateTriples = (): readonly Rates[] => {
  const triples: Rates[] = [];
  for (let tax = 0; tax <= RATE_TOTAL; tax += 1) {
    for (let science = 0; tax + science <= RATE_TOTAL; science += 1) {
      triples.push({ tax, science, luxury: RATE_TOTAL - tax - science });
    }
  }
  return triples;
};

/**
 * Payloads the engine must refuse, one per way the rule can break: a negative field, a
 * fractional field, a sum that is too small and one that is too large, a non-numeric
 * field, and a payload that is not a rates object at all.
 *
 * The last group is built from JSON rather than written as an object literal, because
 * "the payload is not a shape the type allows" is precisely what a command file, a save
 * from a newer client or a hand-written script produces — and it is the case that used
 * to crash rather than refuse (see the file header).
 */
const malformedRateCommands = (): readonly (readonly [string, Command])[] => {
  const jsonCommand = (payload: string): Command => JSON.parse(payload) as Command;
  return [
    ['negative tax', { type: 'SetRates', rates: { tax: -1, science: 5, luxury: 6 } }],
    ['negative luxury', { type: 'SetRates', rates: { tax: 5, science: 6, luxury: -1 } }],
    ['fractional tax', { type: 'SetRates', rates: { tax: 1.5, science: 4, luxury: 4.5 } }],
    ['sum 9', { type: 'SetRates', rates: { tax: 3, science: 3, luxury: 3 } }],
    ['sum 11', { type: 'SetRates', rates: { tax: 4, science: 4, luxury: 3 } }],
    ['all zero', { type: 'SetRates', rates: { tax: 0, science: 0, luxury: 0 } }],
    ['huge sum', { type: 'SetRates', rates: { tax: 100, science: 100, luxury: 100 } }],
    ['string field', jsonCommand('{"type":"SetRates","rates":{"tax":"6","science":4,"luxury":0}}')],
    ['null field', jsonCommand('{"type":"SetRates","rates":{"tax":null,"science":4,"luxury":6}}')],
    ['missing field', jsonCommand('{"type":"SetRates","rates":{"tax":6,"science":4}}')],
    ['null payload', jsonCommand('{"type":"SetRates","rates":null}')],
    ['absent payload', jsonCommand('{"type":"SetRates"}')],
    ['array payload', jsonCommand('{"type":"SetRates","rates":[6,4,0]}')],
    ['string payload', jsonCommand('{"type":"SetRates","rates":"6/4/0"}')],
  ];
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
  endTurns: number;
  rateAccepted: number;
  rateRefused: number;
  malformedRefused: number;
  rateCommandsYielded: number;
  disbands: number;
  shortfalls: number;
}

interface KeystoneRun {
  readonly failures: readonly string[];
  readonly totals: KeystoneTotals;
}

/** The armies the sweeps need to make bankruptcy reachable. */
const withArmy = (state: GameState, perPlayer: number): GameState => {
  let current = state;
  for (const player of state.players) {
    if (player.kind !== 'civ') continue;
    for (let n = 0; n < perPlayer; n += 1) {
      current = spawnUnit(current, MILITARY, player.id, player.startingTile).state;
    }
  }
  return current;
};

/**
 * The keystone sweep's fixed, deterministic policy. Its whole job is to reach the
 * interesting states: found cities (commerce to split, cities to support), and pay turns
 * (production, growth, support and bankruptcy).
 */
const chooseCommand = (
  offers: readonly Offer[],
  step: number,
  prng: () => number,
): Offer | undefined => {
  const founds = offers.filter((offer) => offer.cmd.type === 'FoundCity');
  const ends = offers.filter((offer) => offer.cmd.type === 'EndTurn');

  const pick = <T>(list: readonly T[]): T | undefined => list[prng() % list.length];

  // A six-step cycle: found a city, end, end, end, end, sometimes found another.
  const cycle = step % 6;
  if ((cycle === 0 || cycle === 5) && founds.length > 0) return pick(founds);
  if (ends.length > 0) return pick(ends);
  return pick(offers);
};

/**
 * Walk real games forward and check, at every state, both directions of the keystone
 * property across all six generators:
 *
 * - **soundness**: every action `legalActions`/`unitActions` yields applies, bumps
 *   `revision` by exactly one, and emits at least one event;
 * - **completeness**: every command `applyCommand` accepts is yielded by *both*
 *   generators. The candidate universe is exhaustive where the space is finite: every
 *   tile index for `MoveUnit` (not just the 8 neighbours), `FoundCity`, one `StartWork`
 *   per catalog kind, `CancelWork`, and `EndTurn` per player.
 *
 * The sixth generator is `planSetRates`, and it is checked as a *query* rather than
 * through `legalActions`: M4b's contract has `actions.ts` deliberately yield no
 * `SetRates` (66 slider moves per player per call, invisible in the event stream), so
 * the property that can be asserted is the one that matters — the applier's accepted set
 * over the whole rate space, and over a hostile list of malformed payloads, is exactly
 * the planner's, with the same typed refusal. This sweep also asserts the policy half:
 * no `SetRates` is *ever* yielded by either enumerating generator.
 *
 * A small extra army is spawned so bankruptcy actually happens during the walk — a
 * disbanded unit, a treasury floored at 0 and a rate change are all states this sweep
 * therefore reaches.
 */
const keystoneSweep = (seeds: readonly number[], steps: number): KeystoneRun => {
  const rec = recorder();
  const legalRates = legalRateTriples();
  const malformed = malformedRateCommands();

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
    endTurns: 0,
    rateAccepted: 0,
    rateRefused: 0,
    malformedRefused: 0,
    rateCommandsYielded: 0,
    disbands: 0,
    shortfalls: 0,
  };

  expect(legalRates.length).toBe(((RATE_TOTAL + 1) * (RATE_TOTAL + 2)) / 2);

  for (const seed of seeds) {
    let state = withArmy(startedState(seed), 6);
    const prng = makePrng(seed);
    const where = (step: number, extra: string): string =>
      `seed ${String(seed)} step ${String(step)}: ${extra}`;

    for (let step = 0; step < steps; step += 1) {
      totals.states += 1;
      const frozenHash = hashValue(state);
      deepFreeze(state);
      checkMoneyShape(rec, state, where(step, 'before the read-only sweep'));

      const offers: Offer[] = [];

      for (const player of state.players) {
        const legal = new Set<string>();

        for (const cmd of legalActions(state, RULESET, player.id)) {
          const key = cmdKey(cmd);
          legal.add(key);
          totals.legalYielded += 1;
          if (cmd.type === 'SetRates') totals.rateCommandsYielded += 1;

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
          checkMoneyShape(rec, outcome.value.state, where(step, `after ${key}`));
          offers.push({ player: player.id, cmd });
        }

        /**
         * The sixth generator, over its whole accepted space. `planSetRates` *is* the
         * applier's decision (the `SetRates` case calls it), so what this half proves is
         * the totality the file header's finding is about, plus the refusal *reason*: a
         * malformed payload must come back as `invalid-argument`, never as a crash.
         */
        for (const triple of legalRates) {
          const plan = planSetRates(state, player.id, triple);
          const applied = applyCommand(
            state,
            player.id,
            { type: 'SetRates', rates: triple },
            RULESET,
          );
          rec.check(
            plan.ok && applied.ok,
            where(
              step,
              `a legal rate triple ${JSON.stringify(triple)} was refused ` +
                `(plan ok=${String(plan.ok)}, applied ok=${String(applied.ok)})`,
            ),
          );
          if (applied.ok) {
            totals.rateAccepted += 1;
            const actor = playerOf(applied.value.state, player.id);
            rec.check(
              actor !== undefined &&
                actor.rates.tax === triple.tax &&
                actor.rates.science === triple.science &&
                actor.rates.luxury === triple.luxury,
              where(
                step,
                `SetRates ${JSON.stringify(triple)} did not write the triple it was given`,
              ),
            );
            rec.check(applied.value.events.length === 0, where(step, 'SetRates emitted an event'));
          } else {
            totals.rateRefused += 1;
          }
        }

        for (const [label, cmd] of malformed) {
          const plan = planSetRates(
            state,
            player.id,
            cmd.type === 'SetRates' ? cmd.rates : DEFAULT_RATES,
          );
          const applied = applyCommand(state, player.id, cmd, RULESET);
          if (!applied.ok) totals.malformedRefused += 1;
          rec.check(!applied.ok, where(step, `the ${label} rate payload was accepted`));
          rec.check(
            !plan.ok && !applied.ok,
            where(step, `the planner accepted the ${label} rate payload`),
          );
          if (!applied.ok) {
            rec.check(
              applied.error.kind === 'invalid-argument',
              where(step, `the ${label} rate payload was refused as ${applied.error.kind}`),
            );
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

          /**
           * Ask the applier about one candidate and hold the generators to the answer, in
           * both directions. The equality — not just "accepted implies yielded" — is the
           * property: a generator that offers what the applier refuses is exactly as
           * broken as one that hides what it accepts.
           */
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

          const kinds = [...new Set(RULESET.improvements.map((def) => def.id))];
          for (const kind of kinds) {
            const cmd: Command = { type: 'StartWork', unitId: unit.id, kind };
            totals.workCandidates += 1;
            if (compare(cmd)) totals.workAccepted += 1;
            if (mine.has(cmdKey(cmd))) totals.workYielded += 1;
          }

          const cancel: Command = { type: 'CancelWork', unitId: unit.id };
          totals.workCandidates += 1;
          if (compare(cancel)) totals.workAccepted += 1;

          const foundCity: Command = { type: 'FoundCity', unitId: unit.id };
          totals.unitCandidates += 1;
          if (compare(foundCity)) totals.applierAccepted += 1;

          // Every tile, not just the neighbours: a generator that forgot one shows up
          // here rather than in a review.
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

        totals.endTurns += 1;
        const endTurn = applyCommand(state, player.id, END_TURN, RULESET);
        rec.check(
          endTurn.ok === legal.has('EndTurn'),
          where(
            step,
            `EndTurn accepted=${String(endTurn.ok)} but legalActions yielded=${String(
              legal.has('EndTurn'),
            )}`,
          ),
        );
      }

      rec.check(
        hashValue(state) === frozenHash,
        where(step, 'the read-only sweep mutated the state'),
      );

      // The walk itself: one command, applied for real, on the state everything above
      // only read.
      const chosen = chooseCommand(offersFor(state), step, prng);
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
      totals.disbands += disbandEventsOf(outcome.value.events).length;
      totals.shortfalls += shortfallEventsOf(outcome.value.events).length;
      checkMoneyShape(rec, state, where(step, 'after an applied command'));
      rec.check(isHashable(state), where(step, 'the resulting state cannot be hashed'));
    }
  }

  return { failures: rec.problems, totals };
};

describe('1. keystone — six generators agree with the applier, in both directions', () => {
  it('holds over played games with workers, cities and armies, rate space included', () => {
    const { failures, totals } = keystoneSweep([1, 2, 3, 5, 8, 13], 8);

    console.log('m4b keystone totals:', JSON.stringify(totals));
    expect(failures).toEqual([]);

    // Non-vacuity, stated as counts: a sweep that never saw a rate command, never
    // accepted or refused one, or never disbanded anything would pass while proving
    // nothing about the milestone it is reviewing.
    expect(totals.states).toBeGreaterThan(0);
    expect(totals.legalYielded).toBeGreaterThan(0);
    expect(totals.generatorApplied).toBe(totals.legalYielded);
    expect(totals.movesAccepted).toBe(totals.movesYielded);
    expect(totals.workCandidates).toBeGreaterThan(0);
    expect(totals.workYielded).toBe(totals.workAccepted);
    expect(totals.rateAccepted).toBeGreaterThan(0);
    expect(totals.rateRefused).toBe(0); // every legal triple applies
    expect(totals.malformedRefused).toBeGreaterThan(0);
    // The policy decision `actions.ts` documents, asserted rather than assumed: the
    // enumerating generators yield no rate command at all.
    expect(totals.rateCommandsYielded).toBe(0);
    expect(totals.endTurns).toBeGreaterThan(0);
    // Money really moved during the walk, so the shapes above were reached.
    expect(totals.disbands).toBeGreaterThan(0);
    // The finding in the header: with a maintenance-free catalog, `unpaid` cannot
    // happen (a shortfall never exceeds what the billable units can cover).
    expect(totals.shortfalls).toBe(0);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * 2. Money conservation over 100+ turns
 * ------------------------------------------------------------------ */

interface MoneyTotals {
  turns: number;
  playerTurns: number;
  citiesFounded: number;
  rateChanges: number;
  unitsAtMoneyStep: number;
  incomeGold: number;
  incomeBeakers: number;
  incomeLuxuries: number;
  commerceSplit: number;
  disbands: number;
  shortfalls: number;
  bankruptPlayerTurns: number;
  zeroTreasuryTurns: number;
  minTreasury: number;
}

interface MoneyRun {
  readonly failures: readonly string[];
  readonly totals: MoneyTotals;
  readonly finals: readonly GameState[];
}

/** One unit, refilled by the documented rule, for the pipeline replication below. */
const refilled = (unit: Unit): Unit => {
  const def = unitDef(RULESET, unit.type);
  return def === undefined ? unit : { ...unit, movementLeft: def.movement };
};

/**
 * Play `turns` turns on each seed, with armies, cities, production and rate changes in
 * the mix, and check the money loop every single turn:
 *
 * - **the events are the computation**: `IncomeCollected`/`UpkeepPaid` must equal the
 *   split and the support bill this file re-derives from the contract's own rules and
 *   the state the loop reads (growth and production already applied);
 * - **the split conserves commerce**: per city, the three channels add up to exactly the
 *   commerce that was split, and the floored channels never exceed it — the round-off
 *   rule that has to hold for gold not to be invented or destroyed;
 * - **the ledger identity**: `treasuryAfter - treasuryBefore === income - upkeep +
 *   covered + unpaid`, to the gold, for every civilization on every turn;
 * - **the treasury never goes negative**, every money field stays a whole number, and
 *   the pools take exactly this turn's beakers and luxuries;
 * - **the pipeline's placement**: `applyEconomy`'s result, refilled and turned over,
 *   hashes equal to `advanceTurn`'s state, and the money event tail is the same list —
 *   so the money loop cannot be moved ahead of production or behind the refill.
 *
 * The pre-turn policy founds cities and sets production, so commerce exists and armies
 * grow until they bankrupt their owners. It never starts work, which is what makes the
 * pipeline replication exact: with no job in flight, the work step is the identity, and
 * the sweep asserts that precondition rather than assuming it.
 */
const moneySweep = (seeds: readonly number[], turns: number, civCount: number): MoneyRun => {
  const rec = recorder();
  const totals: MoneyTotals = {
    turns: 0,
    playerTurns: 0,
    citiesFounded: 0,
    rateChanges: 0,
    unitsAtMoneyStep: 0,
    incomeGold: 0,
    incomeBeakers: 0,
    incomeLuxuries: 0,
    commerceSplit: 0,
    disbands: 0,
    shortfalls: 0,
    bankruptPlayerTurns: 0,
    zeroTreasuryTurns: 0,
    minTreasury: Number.POSITIVE_INFINITY,
  };
  const finals: GameState[] = [];
  const rateChoices: readonly Rates[] = [
    { tax: 0, science: 0, luxury: RATE_TOTAL },
    { tax: 2, science: 3, luxury: 5 },
    { tax: RATE_TOTAL, science: 0, luxury: 0 },
    { tax: 5, science: 5, luxury: 0 },
  ];

  for (const seed of seeds) {
    let state = withArmy(startedState(seed, civCount), 14);
    const prng = makePrng(seed);
    const where = (turn: number, extra: string): string =>
      `seed ${String(seed)} turn ${String(turn)}: ${extra}`;

    for (let turn = 0; turn < turns; turn += 1) {
      totals.turns += 1;

      // --- pre-turn commands: cities to earn with, production to grow armies, and the
      // occasional slider move. Every one goes through `applyCommand` and is verified.
      for (const player of state.players) {
        if (player.kind !== 'civ') continue;
        const playerId = player.id;

        const ownCityCount = state.cities.filter((city) => city.owner === playerId).length;
        const founds = [...legalActions(state, RULESET, playerId)].filter(
          (cmd) => cmd.type === 'FoundCity',
        );
        if (founds.length > 0 && ownCityCount < 3) {
          const chosen = founds[prng() % founds.length];
          if (chosen !== undefined) {
            const outcome = applyCommand(state, playerId, chosen, RULESET);
            if (outcome.ok) {
              state = outcome.value.state;
              totals.citiesFounded += 1;
            }
          }
        }

        for (const city of state.cities.filter((candidate) => candidate.owner === playerId)) {
          const item =
            ownCityCount < 3
              ? ({ kind: 'unit', id: SETTLER.id } as const)
              : ({ kind: 'unit', id: MILITARY.id } as const);
          const outcome = applyCommand(
            state,
            playerId,
            { type: 'SetProduction', cityId: city.id, item },
            RULESET,
          );
          if (outcome.ok) state = outcome.value.state;
        }

        if (turn % 17 === 3) {
          const rates = rateChoices[prng() % rateChoices.length];
          if (rates !== undefined) {
            const outcome = applyCommand(state, playerId, { type: 'SetRates', rates }, RULESET);
            if (outcome.ok) {
              state = outcome.value.state;
              totals.rateChanges += 1;
            }
          }
        }
      }

      const before = state;
      rec.check(
        before.units.every((unit) => unit.work === undefined),
        where(turn, 'the conservation sweep must not have a job in flight'),
      );

      // --- the documented pipeline, replicated: growth, then production, then money.
      const grown = applyGrowth(before, RULESET).state;
      const produced = applyProduction(grown, RULESET).state;
      const economy = applyEconomy(produced, RULESET);
      totals.unitsAtMoneyStep += produced.units.length;

      const replicated: GameState = {
        ...economy.state,
        units: economy.state.units.map(refilled),
        turn: economy.state.turn + 1,
      };
      const pipeline = advanceTurn(before, RULESET);
      rec.check(
        hashValue(replicated) === hashValue(pipeline.state),
        where(turn, 'the replicated pipeline (growth, production, money, refill) differs'),
      );
      rec.check(
        hashValue(moneyEventsOf(pipeline.events)) === hashValue(economy.events),
        where(turn, "the pipeline's money events are not the money loop's own list"),
      );

      // --- the money loop, player by player.
      const incomes = incomeEventsOf(economy.events);
      const upkeeps = upkeepEventsOf(economy.events);
      const allDisbands = disbandEventsOf(economy.events);
      const allShortfalls = shortfallEventsOf(economy.events);

      const civIds = civIdsOf(produced).map(Number);
      rec.check(
        incomes.map((event) => Number(event.playerId)).join(',') === civIds.join(','),
        where(
          turn,
          `IncomeCollected names [${incomes.map((e) => String(e.playerId)).join(',')}] ` +
            `rather than [${civIds.join(',')}]`,
        ),
      );
      rec.check(
        upkeeps.map((event) => Number(event.playerId)).join(',') === civIds.join(','),
        where(turn, 'UpkeepPaid does not visit every civilization, in player-id order'),
      );
      for (const event of [...allDisbands, ...allShortfalls, ...incomes, ...upkeeps]) {
        const owner = playerOf(state, event.playerId);
        rec.check(
          owner?.kind === 'civ',
          where(turn, `a money event names player ${String(event.playerId)}, not a civilization`),
        );
      }

      for (const player of before.players) {
        if (player.kind !== 'civ') continue;
        totals.playerTurns += 1;

        const income = incomes.filter((event) => event.playerId === player.id)[0];
        const upkeep = upkeeps.filter((event) => event.playerId === player.id)[0];
        rec.check(
          income !== undefined && upkeep !== undefined,
          where(turn, `player ${String(player.id)} has no ledger line`),
        );
        if (income === undefined || upkeep === undefined) continue;

        // The split, re-derived per city from the contract's rule.
        let gold = 0;
        let beakers = 0;
        let luxuries = 0;
        let maintenance = 0;
        const ownedCities = produced.cities.filter((city) => city.owner === player.id);
        for (const city of ownedCities) {
          const commerce = cityYields(produced, RULESET, city.id).commerce;
          const split = contractSplit(commerce, player.rates);
          rec.check(
            split.floored <= commerce,
            where(
              turn,
              `city ${String(city.id)}: the floored channels (${String(split.floored)}) ` +
                `exceed its commerce (${String(commerce)})`,
            ),
          );
          rec.check(
            split.gold + split.beakers + split.luxuries === commerce,
            where(
              turn,
              `city ${String(city.id)}: the channels [${String(split.gold)},${String(
                split.beakers,
              )},${String(split.luxuries)}] do not add up to its commerce (${String(commerce)})`,
            ),
          );
          totals.commerceSplit += commerce;
          gold += split.gold;
          beakers += split.beakers;
          luxuries += split.luxuries;
          for (const building of city.buildings) {
            const def = RULESET.buildings?.find((row) => row.id === building);
            if (def !== undefined) maintenance += declaredMaintenance(def);
          }
        }
        rec.check(
          gold === income.gold && beakers === income.beakers && luxuries === income.luxuries,
          where(
            turn,
            `player ${String(player.id)}: IncomeCollected [${String(income.gold)},${String(
              income.beakers,
            )},${String(income.luxuries)}] but the contract's split of ` +
              `${String(ownedCities.length)} city/cities gives [${String(gold)},${String(
                beakers,
              )},${String(luxuries)}]`,
          ),
        );
        totals.incomeGold += income.gold;
        totals.incomeBeakers += income.beakers;
        totals.incomeLuxuries += income.luxuries;

        // The support bill, re-derived from the placeholder constants and the state.
        const units = produced.units.filter((unit) => unit.owner === player.id);
        const support = contractSupport(units.length, ownedCities.length);
        rec.check(
          upkeep.units === units.length &&
            upkeep.unitSupport === support &&
            upkeep.maintenance === maintenance &&
            upkeep.gold === maintenance + support,
          where(
            turn,
            `player ${String(player.id)}: UpkeepPaid ${JSON.stringify(upkeep)} does not match ` +
              `${String(units.length)} units, ${String(ownedCities.length)} cities, ` +
              `maintenance ${String(maintenance)}, support ${String(support)}`,
          ),
        );

        // Bankruptcy, and the identity that says no gold was invented or lost.
        const disbands = allDisbands.filter((event) => event.playerId === player.id);
        const covered = disbands.reduce((sum, event) => sum + event.saved, 0);
        const shortfallEvent = allShortfalls.filter((event) => event.playerId === player.id)[0];
        const unpaid = shortfallEvent === undefined ? 0 : shortfallEvent.unpaid;
        const settled = player.treasury + income.gold - upkeep.gold;
        const after = playerOf(economy.state, player.id);
        rec.check(
          after !== undefined,
          where(turn, 'a civilization vanished during the money loop'),
        );
        if (after === undefined) continue;

        rec.check(
          after.treasury === player.treasury + income.gold - upkeep.gold + covered + unpaid,
          where(
            turn,
            `player ${String(player.id)}: the ledger does not balance — treasury ` +
              `${String(player.treasury)} -> ${String(after.treasury)}, income ${String(
                income.gold,
              )}, upkeep ${String(upkeep.gold)}, covered ${String(covered)}, unpaid ${String(
                unpaid,
              )}`,
          ),
        );
        rec.check(
          after.treasury >= 0 && Number.isInteger(after.treasury),
          where(turn, `player ${String(player.id)}: treasury is ${String(after.treasury)}`),
        );
        rec.check(
          after.beakers === player.beakers + income.beakers &&
            after.luxuries === player.luxuries + income.luxuries,
          where(
            turn,
            `player ${String(player.id)}: the inert pools did not take this turn's split`,
          ),
        );

        if (settled >= 0) {
          rec.check(
            disbands.length === 0 && unpaid === 0,
            where(turn, `player ${String(player.id)} disbanded units without a shortfall`),
          );
        } else {
          const shortfall = -settled;
          totals.bankruptPlayerTurns += 1;
          rec.check(
            covered + unpaid === shortfall,
            where(
              turn,
              `player ${String(player.id)}: shortfall ${String(shortfall)} but covered ` +
                `${String(covered)} + unpaid ${String(unpaid)}`,
            ),
          );
          rec.check(
            after.treasury === 0,
            where(
              turn,
              `player ${String(player.id)}: a bankrupt treasury ended at ${String(after.treasury)}`,
            ),
          );
          // Highest id first, one unit each, and every victim really was that player's —
          // the documented disband order.
          let previous = Number.POSITIVE_INFINITY;
          for (const event of disbands) {
            const id = Number(event.unitId);
            rec.check(
              id < previous,
              where(
                turn,
                `player ${String(player.id)}: disbanded ${String(id)} after ${String(previous)}`,
              ),
            );
            previous = id;
            const victim = produced.units.find((unit) => unit.id === event.unitId);
            rec.check(
              victim !== undefined && victim.owner === player.id,
              where(turn, `player ${String(player.id)}: disbanded a unit it did not own`),
            );
            rec.check(
              victim !== undefined && victim.type === event.unitType && victim.tile === event.tile,
              where(turn, `player ${String(player.id)}: the disband event misdescribes its victim`),
            );
            rec.check(
              event.saved === UNIT_SUPPORT_COST || covered === shortfall, // the last disband of a turn may be capped
              where(turn, `player ${String(player.id)}: a disband saved ${String(event.saved)}`),
            );
          }
          rec.check(
            economy.state.units.filter((unit) => unit.owner === player.id).length ===
              units.length - disbands.length,
            where(
              turn,
              `player ${String(player.id)}: the disband count does not match the units lost`,
            ),
          );
        }

        totals.disbands += disbands.length;
        totals.shortfalls += shortfallEvent === undefined ? 0 : 1;
        totals.minTreasury = Math.min(totals.minTreasury, after.treasury);
        if (after.treasury === 0) totals.zeroTreasuryTurns += 1;
      }

      checkMoneyShape(rec, economy.state, where(turn, 'after the money loop'));

      // --- and the same turn through the applier, which is the path a player uses.
      const acting = civIdsOf(before)[0];
      if (acting !== undefined) {
        const end = applyCommand(before, acting, END_TURN, RULESET);
        rec.check(end.ok, where(turn, 'EndTurn was refused'));
        if (end.ok) {
          rec.check(
            hashValue(end.value.state) ===
              hashValue({ ...pipeline.state, revision: before.revision + 1 }),
            where(turn, 'EndTurn did not produce the pipeline state'),
          );
          checkMoneyShape(rec, end.value.state, where(turn, 'after EndTurn'));
          rec.check(
            isHashable(end.value.state),
            where(turn, 'the state after EndTurn is unhashable'),
          );
          state = end.value.state;
        } else {
          break;
        }
      }
    }

    finals.push(state);
  }

  return { failures: rec.problems, totals, finals };
};

describe('2. money conservation — income minus upkeep equals the delta, every turn', () => {
  it('accounts for every gold piece over 120 turns on three seeds, with cities and mass bankruptcy', () => {
    const { failures, totals, finals } = moneySweep([3, 11, 29], 120, 3);

    console.log('m4b money totals:', JSON.stringify(totals));
    expect(failures).toEqual([]);

    // Non-vacuity: money has to have moved, in both directions, or "conservation" is a
    // statement about zero. Cities earned, upkeep bit, and units were disbanded.
    expect(totals.playerTurns).toBeGreaterThanOrEqual(300);
    expect(totals.citiesFounded).toBeGreaterThan(0);
    expect(totals.commerceSplit).toBeGreaterThan(0);
    expect(totals.incomeGold).toBeGreaterThan(0);
    expect(totals.incomeLuxuries).toBeGreaterThan(0);
    expect(totals.rateChanges).toBeGreaterThan(0);
    expect(totals.disbands).toBeGreaterThan(0);
    expect(totals.bankruptPlayerTurns).toBeGreaterThan(0);
    expect(totals.zeroTreasuryTurns).toBeGreaterThan(0);
    expect(totals.minTreasury).toBe(0);
    // The finding in the header, asserted: with a catalog that declares no building
    // maintenance, a shortfall can never exceed what disbanding every billable unit
    // saves, so the unpaid branch is unreachable from a real game.
    expect(totals.shortfalls).toBe(0);

    for (const state of finals) {
      expect(state.players.every((player) => player.treasury >= 0)).toBe(true);
      expect(isHashable(state)).toBe(true);
    }
  }, 300_000);

  it('reaches the unpaid branch only through a catalog that declares maintenance', () => {
    // The other half of the finding: the branch is not dead code, it is M4c's. A foreign
    // ruleset view that declares a temple's maintenance makes it reachable, with the
    // shipped catalog's own content otherwise, and the numbers are pinned so the claim
    // is checkable rather than argued.
    const maintained: RulesetView = {
      ...RULESET,
      buildings: [temple(2)],
    };
    const built = createScenarioBuilder(maintained, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, MILITARY.id, [5, 5])
      .addUnit(1, MILITARY.id, [30, 30])
      .setTreasury(0, 0)
      .setTreasury(1, 0)
      // No gold income at all: every coin of commerce goes to luxuries, so the temple's
      // maintenance is a shortfall nothing can cover — there is no billable unit (one
      // unit is inside the allowance) and no gold in the treasury.
      .setRates(0, { tax: 0, science: 0, luxury: RATE_TOTAL })
      .addCity(0, [7, 7], { population: 1, buildings: [asBuildingId('temple')] })
      .build();
    if (!built.ok) {
      throw new Error(`the maintenance fixture must build: ${JSON.stringify(built.error)}`);
    }

    const outcome = applyEconomy(built.value, maintained);
    const income = incomeEventsOf(outcome.events)[0];
    const upkeep = upkeepEventsOf(outcome.events)[0];
    const shortfall = shortfallEventsOf(outcome.events)[0];

    expect(income?.gold).toBe(0);
    expect(upkeep?.maintenance).toBe(2);
    expect(upkeep?.unitSupport).toBe(0);
    expect(upkeep?.gold).toBe(2);
    expect(upkeep?.units).toBe(1);
    expect(upkeep?.freeUnits).toBe(FREE_UNITS_PER_CITY + FREE_UNITS_BASE);
    // Nothing to disband buys nothing, so the whole two gold is unpaid — and the
    // treasury floors at 0 rather than going negative.
    expect(disbandEventsOf(outcome.events)).toEqual([]);
    expect(shortfall?.unpaid).toBe(2);
    expect(playerOf(outcome.state, asPlayerId(0))?.treasury).toBe(0);
    expect(isHashable(outcome.state)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Treasury never negative — trying hard
 * ------------------------------------------------------------------ */

/**
 * A board of `civCount` civilizations, each with `unitsPerPlayer` units stacked on one
 * tile, `treasury` gold, no city (so income is exactly zero), and optionally a
 * barbarian horde. Hand-built through the scenario builder, so the unit count is a
 * parameter rather than something a generated map happens to allow.
 */
const stackBoard = (options: {
  readonly mapSize: MapSize;
  readonly civCount: number;
  readonly unitsPerPlayer: number;
  readonly treasury: number;
  readonly barbarianUnits: number;
}): GameState => {
  let builder: ScenarioBuilder = createScenarioBuilder(RULESET, {
    mapSize: options.mapSize,
    civCount: options.civCount,
  });
  for (let index = 0; index < options.civCount; index += 1) {
    builder = builder.addPlayer(`Civ ${String(index + 1)}`);
  }
  builder = builder.fillTerrain('grassland');
  for (let index = 0; index < options.civCount; index += 1) {
    for (let n = 0; n < options.unitsPerPlayer; n += 1) {
      builder = builder.addUnit(index, MILITARY.id, [4 + index * 6, 4]);
    }
    builder = builder.setTreasury(index, options.treasury);
  }
  if (options.barbarianUnits > 0) {
    builder = builder.addBarbarianPlayer();
    for (let n = 0; n < options.barbarianUnits; n += 1) {
      builder = builder.addUnit(options.civCount, MILITARY.id, [30, 30]);
    }
  }

  const built = builder.build();
  if (!built.ok) throw new Error(`the stack fixture must build: ${JSON.stringify(built.error)}`);
  return built.value;
};

describe('3. treasury never negative', () => {
  it('holds with 180 units, zero income and three bankruptcies in the same turn', () => {
    const rec = recorder();
    const board = stackBoard({
      // 'duel' hosts at most two civilizations, so three simultaneous bankruptcies need
      // the next size up: a fixture has to be a settings combination the CLI allows.
      mapSize: 'tiny',
      civCount: 3,
      unitsPerPlayer: 60,
      treasury: 0,
      barbarianUnits: 0,
    });
    const acting = asPlayerId(0);

    // The first turn is the brutal one: 60 units each against an allowance of
    // FREE_UNITS_BASE, and no city to earn a coin.
    let state = board;
    let afterFirstTurn = -1;
    for (let turn = 0; turn < 6; turn += 1) {
      const before = state;
      const outcome = applyCommand(state, acting, END_TURN, RULESET);
      if (!outcome.ok) throw new Error(`EndTurn refused on turn ${String(turn)}`);
      state = outcome.value.state;

      for (const player of state.players) {
        rec.check(
          player.treasury >= 0 && Number.isInteger(player.treasury),
          `turn ${String(turn)}: player ${String(player.id)} ended with ${String(player.treasury)}`,
        );
        rec.check(
          player.treasury === 0,
          `turn ${String(turn)}: player ${String(player.id)} was broke and ended with gold`,
        );
      }

      const disbands = disbandEventsOf(outcome.value.events);
      if (turn === 0) afterFirstTurn = state.units.length;
      rec.check(
        disbands.length > 0 || turn > 0,
        `turn ${String(turn)}: a 60-unit board disbanded nothing on its first turn`,
      );
      // Every removal really was that player's own unit, taken in descending id order.
      const seen = new Map<number, number>();
      for (const event of disbands) {
        const previous = seen.get(Number(event.playerId));
        rec.check(
          previous === undefined || Number(event.unitId) < previous,
          `turn ${String(turn)}: disband order is not descending for player ${String(
            event.playerId,
          )}`,
        );
        seen.set(Number(event.playerId), Number(event.unitId));
        const victim = before.units.find((unit) => unit.id === event.unitId);
        rec.check(
          victim !== undefined && victim.owner === event.playerId,
          `turn ${String(turn)}: a disband names a unit that player did not own`,
        );
      }

      // Every civilization ends the turn at exactly its free allowance, because nothing
      // can be disbanded past it (removing a free unit buys nothing).
      const expected = before.players.filter((p) => p.kind === 'civ').length * FREE_UNITS_BASE;
      rec.check(
        state.units.length === expected,
        `turn ${String(turn)}: ${String(state.units.length)} units survived, expected ${String(
          expected,
        )}`,
      );
      rec.check(isHashable(state), `turn ${String(turn)}: the state is unhashable`);
      checkMoneyShape(rec, state, `turn ${String(turn)}`);
    }

    // Discriminating: the board really did start with 180 units, and the first turn
    // really did destroy 168 of them.
    expect(board.units.length).toBe(180);
    expect(afterFirstTurn).toBe(3 * FREE_UNITS_BASE);
    expect(rec.problems).toEqual([]);
  });

  it('keeps a fraction-or-NaN treasury out of the state it writes back', () => {
    // A hand-built state (a save edited by a human, a foreign client) whose treasury the
    // engine cannot read as gold. The money loop's reads are total by design: a
    // non-integer is read as 0 rather than allowed to poison every later subtraction, and
    // the state it writes back is integral and hashable. Pinned because the alternative —
    // a fraction surviving into the state — is the unhashable bug class.
    const rec = recorder();
    const board = stackBoard({
      mapSize: 'duel',
      civCount: 2,
      unitsPerPlayer: 2,
      treasury: 5,
      barbarianUnits: 0,
    });
    const poisoned: GameState = {
      ...board,
      players: board.players.map((player) =>
        player.kind === 'civ' ? { ...player, treasury: Number.NaN } : player,
      ),
    };
    expect(isHashable(poisoned)).toBe(false);

    const outcome = applyEconomy(poisoned, RULESET);
    expect(playerOf(outcome.state, asPlayerId(0))?.treasury).toBe(0);
    expect(isHashable(outcome.state)).toBe(true);
    checkMoneyShape(rec, outcome.state, 'after a NaN-treasury turn');

    // The same for a fractional treasury, this time beside a rate triple that is not a
    // rate at all. The money loop owns the treasury and rewrites it integrally; it does
    // *not* own the rates, so the poison it does not own stays exactly where it was —
    // which is the honest boundary, and it is asserted rather than glossed over: put the
    // one field the loop is not allowed to touch back and the state hashes again, so
    // nothing the loop *wrote* can be a fraction.
    const fractional: GameState = {
      ...board,
      players: board.players.map((player) =>
        player.kind === 'civ'
          ? {
              ...player,
              treasury: 2.5,
              rates: { tax: Number.NaN, science: Number.NaN, luxury: Number.NaN },
            }
          : player,
      ),
    };
    expect(isHashable(fractional)).toBe(false);

    const fractioned = applyEconomy(fractional, RULESET);
    expect(playerOf(fractioned.state, asPlayerId(0))?.treasury).toBe(0);
    expect(isHashable(fractioned.state)).toBe(false); // the rates I poisoned, not the money

    const repaired: GameState = {
      ...fractioned.state,
      players: fractioned.state.players.map((player) =>
        player.kind === 'civ' ? { ...player, rates: DEFAULT_RATES } : player,
      ),
    };
    expect(isHashable(repaired)).toBe(true);
    checkMoneyShape(rec, repaired, 'after a fractional-treasury turn');

    expect(rec.problems).toEqual([]);
  });

  it('floors at zero and reports the whole shortfall when there is nothing to disband', () => {
    // Zero units, zero gold, and a maintenance-declaring catalog: this is the only shape
    // in which "nothing can be disbanded and the shortfall remains" can happen (see the
    // header's finding), so it is the shape that pins step 6 of the contract.
    const maintained: RulesetView = {
      ...RULESET,
      buildings: [temple(3)],
    };
    const built = createScenarioBuilder(maintained, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, WORKER.id, [5, 5])
      .addUnit(1, WORKER.id, [30, 30])
      .setTreasury(0, 0)
      .setRates(0, { tax: 0, science: 0, luxury: RATE_TOTAL })
      .addCity(0, [7, 7], { population: 1, buildings: [asBuildingId('temple')] })
      .build();
    if (!built.ok) throw new Error('the shortfall fixture must build');

    const outcome = applyEconomy(built.value, maintained);
    expect(shortfallEventsOf(outcome.events)).toEqual([
      { type: 'TreasuryShortfall', playerId: asPlayerId(0), unpaid: 3 },
    ]);
    expect(playerOf(outcome.state, asPlayerId(0))?.treasury).toBe(0);
    // Nothing was destroyed to pay for it: the treasury is 0, not negative, and the
    // unpaid amount is said rather than invented as a debt field.
    expect('debt' in (playerOf(outcome.state, asPlayerId(0)) ?? {})).toBe(false);
    expect(canonicalize(outcome.state)).not.toContain('debt');
  });
});

/* ------------------------------------------------------------------ *
 * 4. Bankruptcy determinism, and barbarians
 * ------------------------------------------------------------------ */

interface BankruptcyRun {
  readonly disbands: readonly string[];
  readonly gold: readonly number[];
  readonly hash: string;
}

/**
 * Play a fixed bankruptcy script on a deterministically built board and report the
 * disband sequence (per player, in order, with the gold each saved), the final gold of
 * every player and the final hash — the three things that must not wobble.
 */
const runBankruptcy = (seed: number, turns: number): BankruptcyRun => {
  let state = withArmy(startedState(seed), 12);
  const disbands: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const acting = playersOf(state)[0];
    if (acting === undefined) break;
    const outcome = applyCommand(state, acting, END_TURN, RULESET);
    if (!outcome.ok) throw new Error(`EndTurn refused at turn ${String(turn)}`);
    for (const event of disbandEventsOf(outcome.value.events)) {
      disbands.push(
        `${String(event.playerId)}:${String(event.unitId)}:${String(event.saved)}:${String(
          Number(event.tile),
        )}`,
      );
    }
    state = outcome.value.state;
  }
  return { disbands, gold: goldsOf(state), hash: hashValue(state) };
};

describe('4. bankruptcy determinism', () => {
  it('gives identical seeds the identical disband sequence and the identical final gold', () => {
    const first = runBankruptcy(17, 8);
    const second = runBankruptcy(17, 8);

    expect(first.disbands.length).toBeGreaterThan(0);
    expect(second.disbands).toEqual(first.disbands);
    expect(second.gold).toEqual(first.gold);
    expect(second.hash).toBe(first.hash);

    // And a different seed really is a different game, so the agreement above is not two
    // runs of an empty script.
    const other = runBankruptcy(18, 8);
    expect(other.hash).not.toBe(first.hash);
  });

  it('disbands the same units for the same state however it is reached or presented', () => {
    const board = withArmy(startedState(23), 10);
    const settled = (state: GameState): readonly string[] => {
      let current = state;
      const sequence: string[] = [];
      for (let turn = 0; turn < 4; turn += 1) {
        const acting = playersOf(current)[0];
        if (acting === undefined) break;
        const outcome = applyCommand(current, acting, END_TURN, RULESET);
        if (!outcome.ok) throw new Error('EndTurn refused');
        for (const event of disbandEventsOf(outcome.value.events)) {
          sequence.push(`${String(event.playerId)}:${String(event.unitId)}:${String(event.saved)}`);
        }
        current = outcome.value.state;
      }
      return sequence;
    };

    const direct = settled(board);
    expect(direct.length).toBeGreaterThan(0);

    // (a) The same state, round-tripped through JSON: same state, different object
    // identity, and — because the state really is equal — the same hash.
    const roundTripped: GameState = JSON.parse(JSON.stringify(board)) as GameState;
    expect(hashValue(roundTripped)).toBe(hashValue(board));
    expect(settled(roundTripped)).toEqual(direct);

    // (b) The same money facts in a different *presentation*: the units and players
    // arrays reversed. The arrays are ordered state, so the hash moves — but no disband
    // decision may depend on array order, only on ids and ownership.
    const reversed: GameState = {
      ...board,
      units: [...board.units].reverse(),
      players: [...board.players].reverse(),
    };
    expect(hashValue(reversed)).not.toBe(hashValue(board));
    expect(settled(reversed)).toEqual(direct);

    // A third route to the same facts: the same units, reached in a different creation
    // order. Ids are assigned in creation order, so the *state* differs — what must not
    // differ is the rule (highest id of that owner first), which is checked by comparing
    // each run's sequence against its own descending-id expectation.
    for (const run of [direct, settled(roundTripped), settled(reversed)]) {
      const perPlayer = new Map<string, number>();
      for (const entry of run) {
        const [player, id] = entry.split(':');
        if (player === undefined || id === undefined) continue;
        const previous = perPlayer.get(player);
        expect(previous === undefined || Number(id) < previous).toBe(true);
        perPlayer.set(player, Number(id));
      }
    }
  });

  it('never disbands or charges a barbarian, and never bills its units to anyone', () => {
    // A civilization with one unit and no gold, beside a barbarian horde of forty. If
    // barbarian units were counted on anyone's bill, or charged to the barbarians, this
    // board is where it would show: the civilizations would go bankrupt paying for a
    // horde they do not own, and the horde would be dissolved.
    const board = stackBoard({
      mapSize: 'duel',
      civCount: 2,
      unitsPerPlayer: 1,
      treasury: 0,
      barbarianUnits: 40,
    });
    const barbarian = board.players.find((player) => player.kind === 'barbarian');
    expect(barbarian).toBeDefined();
    if (barbarian === undefined) return;
    const horde = board.units.filter((unit) => unit.owner === barbarian.id).length;
    expect(horde).toBe(40);

    let state = board;
    for (let turn = 0; turn < 5; turn += 1) {
      const acting = playersOf(state)[0];
      if (acting === undefined) break;
      const outcome = applyCommand(state, acting, END_TURN, RULESET);
      if (!outcome.ok) throw new Error('EndTurn refused');
      state = outcome.value.state;

      // No money event of any kind names the barbarian player, and every civilization's
      // bill counts only its own unit.
      for (const event of outcome.value.events.filter(isMoneyEvent)) {
        expect(event.playerId, `turn ${String(turn)}: a money event names the barbarians`).not.toBe(
          barbarian.id,
        );
      }
      for (const event of upkeepEventsOf(outcome.value.events)) {
        expect(event.units).toBe(1);
        expect(event.freeUnits).toBe(FREE_UNITS_BASE);
        expect(event.unitSupport).toBe(0);
      }

      const after = playerOf(state, barbarian.id);
      expect(after?.treasury).toBe(0);
      expect(after?.beakers).toBe(0);
      expect(after?.luxuries).toBe(0);
      expect(state.units.filter((unit) => unit.owner === barbarian.id)).toHaveLength(horde);
      for (const player of state.players) {
        if (player.kind !== 'civ') continue;
        expect(state.units.filter((unit) => unit.owner === player.id)).toHaveLength(1);
        expect(player.treasury).toBe(0);
      }
      expect(isHashable(state)).toBe(true);
    }
  });

  it('collects nothing for a barbarian city — nobody earns another player’s commerce', () => {
    // Two cities earning real commerce: one Roman, one barbarian. If the income sum were
    // taken over *all* cities rather than the player's own, Rome would collect the
    // barbarians' commerce and this comparison would fail.
    const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .addBarbarianPlayer()
      .fillTerrain('grassland')
      .addUnit(0, MILITARY.id, [4, 4])
      .addUnit(1, MILITARY.id, [30, 30])
      .setTreasury(0, 0)
      .setTreasury(1, 0)
      .addCity(0, [6, 6], { population: 2 })
      .addCity(2, [12, 12], { population: 2 })
      .build();
    if (!built.ok) {
      throw new Error(`the barbarian-city fixture must build: ${JSON.stringify(built.error)}`);
    }

    const roman = built.value.cities[0];
    const barbarianCity = built.value.cities[1];
    expect(roman).toBeDefined();
    expect(barbarianCity).toBeDefined();
    if (roman === undefined || barbarianCity === undefined) return;
    const barbarianCommerce = cityYields(built.value, RULESET, barbarianCity.id).commerce;
    expect(barbarianCommerce).toBeGreaterThan(0); // the board is discriminating

    const outcome = applyEconomy(built.value, RULESET);
    const incomes = incomeEventsOf(outcome.events);
    expect(incomes).toHaveLength(2); // both civilizations, and no barbarian line

    const romanCommerce = cityYields(built.value, RULESET, roman.id).commerce;
    const expected = contractSplit(romanCommerce, DEFAULT_RATES);
    const rome = incomes.filter((event) => Number(event.playerId) === 0)[0];
    const carthage = incomes.filter((event) => Number(event.playerId) === 1)[0];
    expect(rome?.gold).toBe(expected.gold);
    expect(rome?.beakers).toBe(expected.beakers);
    expect(rome?.luxuries).toBe(expected.luxuries);
    // Carthage has no city of its own, so it earns nothing even though a barbarian city
    // stands on the map.
    expect(carthage?.gold).toBe(0);
    expect(carthage?.beakers).toBe(0);
    expect(playerOf(outcome.state, asPlayerId(2))?.treasury).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Rates
 * ------------------------------------------------------------------ */

/** A hand-built board with one city earning known commerce, for the rate tests. */
const rateBoard = (treasury: number): GameState => {
  const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .addUnit(0, WORKER.id, [4, 4])
    .addUnit(1, WORKER.id, [30, 30])
    .setTreasury(0, treasury)
    .setRates(0, DEFAULT_RATES)
    .addCity(0, [6, 6], { population: 2 })
    .build();
  if (!built.ok) throw new Error(`the rate fixture must build: ${JSON.stringify(built.error)}`);
  return built.value;
};

const cityCommerce = (state: GameState): number => {
  const city = state.cities[0];
  if (city === undefined) throw new Error('the rate fixture must hold a city');
  return cityYields(state, RULESET, city.id).commerce;
};

describe('5. rates', () => {
  it('moves the rates and nothing else — asserted by reverting them and comparing hashes', () => {
    const board = rateBoard(7);
    const P0 = asPlayerId(0);
    const before = hashValue(board);

    const outcome = applyCommand(
      board,
      P0,
      { type: 'SetRates', rates: { tax: 0, science: 0, luxury: RATE_TOTAL } },
      RULESET,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.state.revision).toBe(board.revision + 1);
    expect(outcome.value.events).toEqual([]); // M3's setter precedent: the payload is the record
    expect(hashValue(board)).toBe(before); // the input was not touched

    // Put the old rates back by hand, with the revision restored: the result must hash
    // equal to the original state. Any other field having moved — a treasury, a pool, a
    // unit, the map — shows up as a hash difference here.
    const original = playerOf(board, P0);
    const reverted: GameState = {
      ...outcome.value.state,
      revision: board.revision,
      players: outcome.value.state.players.map((player) =>
        player.id === P0 ? { ...player, rates: original?.rates ?? DEFAULT_RATES } : player,
      ),
    };
    expect(hashValue(reverted)).toBe(before);

    // The actor's money is carried over exactly, and the other player is untouched.
    const actorAfter = playerOf(outcome.value.state, P0);
    expect(actorAfter?.treasury).toBe(original?.treasury);
    expect(actorAfter?.beakers).toBe(original?.beakers);
    expect(actorAfter?.luxuries).toBe(original?.luxuries);
    expect(playerOf(outcome.value.state, asPlayerId(1))).toEqual(playerOf(board, asPlayerId(1)));
  });

  it('refuses an illegal rate with the typed error and leaves the state hash unchanged', () => {
    const board = rateBoard(7);
    const P0 = asPlayerId(0);
    const before = hashValue(board);

    const illegal: readonly (readonly [string, Command])[] = [
      ['negative', { type: 'SetRates', rates: { tax: -1, science: 5, luxury: 6 } }],
      ['fractional', { type: 'SetRates', rates: { tax: 1.5, science: 4, luxury: 4.5 } }],
      ['sum 9', { type: 'SetRates', rates: { tax: 3, science: 3, luxury: 3 } }],
      ['sum 11', { type: 'SetRates', rates: { tax: 4, science: 4, luxury: 3 } }],
      [
        'string field',
        JSON.parse('{"type":"SetRates","rates":{"tax":"6","science":4,"luxury":0}}') as Command,
      ],
      ['null payload', JSON.parse('{"type":"SetRates","rates":null}') as Command],
      ['absent payload', JSON.parse('{"type":"SetRates"}') as Command],
    ];

    for (const [label, cmd] of illegal) {
      const plan = planSetRates(board, P0, cmd.type === 'SetRates' ? cmd.rates : DEFAULT_RATES);
      const outcome = applyCommand(board, P0, cmd, RULESET);

      expect(outcome.ok, `${label} was accepted`).toBe(false);
      expect(plan.ok, `${label} was accepted by the planner`).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.kind, `${label} was refused as ${outcome.error.kind}`).toBe(
          'invalid-argument',
        );
        if (!plan.ok) expect(plan.error.kind).toBe(outcome.error.kind);
      }
      expect(hashValue(board), `${label} mutated the state`).toBe(before);
      expect(playerOf(board, P0)?.rates).toEqual(DEFAULT_RATES);
    }

    // The wrong-sum case names the actual sum, which is the whole point of the message.
    const wrongSum = applyCommand(
      board,
      P0,
      { type: 'SetRates', rates: { tax: 3, science: 3, luxury: 3 } },
      RULESET,
    );
    expect(wrongSum.ok).toBe(false);
    if (!wrongSum.ok && wrongSum.error.kind === 'invalid-argument') {
      expect(wrongSum.error.detail).toContain('9');
    }

    // A payload carrying extra keys is accepted, and the extra key is *not* copied into
    // the state — a foreign client cannot smuggle a key into the hashed JSON.
    const extra = applyCommand(
      board,
      P0,
      JSON.parse(
        '{"type":"SetRates","rates":{"tax":6,"science":4,"luxury":0,"sneaky":true}}',
      ) as Command,
      RULESET,
    );
    expect(extra.ok).toBe(true);
    if (extra.ok) {
      const actor = playerOf(extra.value.state, P0);
      expect(actor?.rates).toEqual(DEFAULT_RATES);
      expect(Object.keys(actor?.rates ?? {}).sort()).toEqual(['luxury', 'science', 'tax']);
      expect(canonicalize(extra.value.state)).not.toContain('sneaky');
    }
  });

  it('affects the next collection and never re-collects a banked one', () => {
    // The documented reading of "future turns only, never the current one": a rate change
    // is a setting, so nothing already in the treasury, the beakers or the luxuries is
    // recomputed, refunded or recollected — and the collection that has not run yet (the
    // money loop is the last step of a turn, so a player acting during turn N is before
    // it) reads the new rates. Pinned as a twin comparison so the reading cannot change
    // silently in either direction.
    const board = rateBoard(7);
    const P0 = asPlayerId(0);
    const commerce = cityCommerce(board);
    expect(commerce).toBeGreaterThan(0);

    const firstTurn = applyCommand(board, P0, END_TURN, RULESET);
    expect(firstTurn.ok).toBe(true);
    if (!firstTurn.ok) return;

    // Twin A changes the sliders after the first collection; twin B does not.
    const changed = applyCommand(
      firstTurn.value.state,
      P0,
      { type: 'SetRates', rates: { tax: 0, science: 0, luxury: RATE_TOTAL } },
      RULESET,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    // No recollection: the change itself moved no gold.
    expect(playerOf(changed.value.state, P0)?.treasury).toBe(
      playerOf(firstTurn.value.state, P0)?.treasury,
    );

    const a = applyCommand(changed.value.state, P0, END_TURN, RULESET);
    const b = applyCommand(firstTurn.value.state, P0, END_TURN, RULESET);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const incomeA = incomeEventsOf(a.value.events).filter((event) => event.playerId === P0)[0];
    const incomeB = incomeEventsOf(b.value.events).filter((event) => event.playerId === P0)[0];
    expect(incomeA).toBeDefined();
    expect(incomeB).toBeDefined();
    if (incomeA === undefined || incomeB === undefined) return;

    // The changed twin earns no gold at all and banks the commerce as luxuries; the
    // control twin earns its share as gold. Both are exactly the contract's split.
    const allLuxury = contractSplit(commerce, { tax: 0, science: 0, luxury: RATE_TOTAL });
    const control = contractSplit(commerce, DEFAULT_RATES);
    expect(incomeA.gold).toBe(allLuxury.gold);
    expect(incomeA.luxuries).toBe(allLuxury.luxuries);
    expect(incomeB.gold).toBe(control.gold);
    expect(incomeA.gold).toBe(0);
    expect(incomeB.gold).not.toBe(incomeA.gold);

    // The treasury difference is exactly the gold difference — the rate change moved the
    // split, not the arithmetic.
    const treasuryA = playerOf(a.value.state, P0)?.treasury ?? 0;
    const treasuryB = playerOf(b.value.state, P0)?.treasury ?? 0;
    expect(treasuryB - treasuryA).toBe(incomeB.gold - incomeA.gold);
  });

  it('charges support for a unit the turn it appears — production runs before the money loop', () => {
    // The contract's ordering claim, at the pipeline level: "a unit produced this turn
    // costs support from the turn it appears". Twin boards differing in one thing: A's
    // city starts with a full item's worth of shields banked, B's starts with none, so A
    // finishes its unit this turn and B does not. A's `UpkeepPaid.units` must already
    // count it, and its bill must be one unit higher.
    //
    // The item is a settler — the only shipped unit whose cost exceeds the one shield a
    // bare city centre always produces — and the city works no tiles, so its whole output
    // is that floor. B's bank is 0 rather than `cost - 1` on purpose: production adds the
    // city's own shields *before* comparing against the cost, so a bank of `cost - 1`
    // would also complete and the twin would prove nothing.
    const item: UnitDef = SETTLER;
    expect(item.cost).toBeGreaterThan(1);
    const completing = (shields: number): GameState => {
      let builder: ScenarioBuilder = createScenarioBuilder(RULESET, {
        mapSize: 'duel',
        civCount: 2,
      })
        .addPlayer('Rome')
        .addPlayer('Carthage')
        .fillTerrain('grassland')
        .addUnit(0, WORKER.id, [4, 4])
        .addUnit(1, WORKER.id, [30, 30]);
      // Seven Roman units, so the eighth (the one produced this turn) is over the
      // allowance of FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE.
      for (let n = 0; n < 6; n += 1) builder = builder.addUnit(0, MILITARY.id, [4, 5 + n]);
      const built = builder
        .setTreasury(0, 200)
        .addCity(0, [8, 8], {
          population: 1,
          workedTiles: [],
          shields,
          production: { kind: 'unit', id: item.id },
        })
        .build();
      if (!built.ok) {
        throw new Error(`the production fixture must build: ${JSON.stringify(built.error)}`);
      }
      return built.value;
    };

    const shieldCost = item.cost;
    const ready = completing(shieldCost);
    const notReady = completing(0);
    const unitsBefore = ready.units.filter((unit) => Number(unit.owner) === 0).length;
    expect(unitsBefore).toBe(7);
    expect(contractSupport(unitsBefore, 1)).toBe(1); // one over the allowance before
    expect(notReady.units.filter((unit) => Number(unit.owner) === 0).length).toBe(unitsBefore);
    // The twin arithmetic, visible: B's city earns one shield a turn and the item costs
    // more, so B cannot possibly finish it while A has the whole cost banked.
    const cityId = ready.cities[0]?.id;
    expect(cityId).toBeDefined();
    if (cityId !== undefined) {
      expect(cityYields(ready, RULESET, cityId).shields).toBe(1);
      expect(cityYields(notReady, RULESET, cityId).shields).toBe(1);
    }
    expect(shieldCost).toBeGreaterThan(1);

    const a = applyCommand(ready, asPlayerId(0), END_TURN, RULESET);
    const b = applyCommand(notReady, asPlayerId(0), END_TURN, RULESET);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // The twin really is a twin: one completion and one not.
    expect(a.value.events.filter((event) => event.type === 'CityProduced')).toHaveLength(1);
    expect(b.value.events.filter((event) => event.type === 'CityProduced')).toHaveLength(0);
    expect(a.value.state.units.filter((unit) => Number(unit.owner) === 0)).toHaveLength(
      unitsBefore + 1,
    );

    const upkeepA = upkeepEventsOf(a.value.events).filter(
      (event) => event.playerId === asPlayerId(0),
    )[0];
    const upkeepB = upkeepEventsOf(b.value.events).filter(
      (event) => event.playerId === asPlayerId(0),
    )[0];
    expect(upkeepA?.units).toBe(unitsBefore + 1);
    expect(upkeepB?.units).toBe(unitsBefore);
    expect(upkeepA?.unitSupport).toBe(contractSupport(unitsBefore + 1, 1));
    expect(upkeepB?.unitSupport).toBe(contractSupport(unitsBefore, 1));
    expect((upkeepA?.gold ?? 0) - (upkeepB?.gold ?? 0)).toBe(UNIT_SUPPORT_COST);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Starting units on every map size and civilization count
 * ------------------------------------------------------------------ */

describe('6. starting units', () => {
  it('gives exactly one settler and one worker per civilization, on every size and civ count', () => {
    const rec = recorder();
    let games = 0;
    let workers = 0;
    let expectedGames = 0;
    let expectedWorkers = 0;

    for (const mapSize of MAP_SIZES) {
      const maxCivs = MAP_DIMENSIONS[mapSize].maxCivs;
      for (let civCount = 2; civCount <= maxCivs; civCount += 1) {
        expectedGames += 2; // two seeds
        expectedWorkers += 2 * civCount; // one worker per civilization, per seed
        for (const seed of [1, 42]) {
          const settings: Settings = { ...DEFAULT_SETTINGS, mapSize, civCount, seed };
          const result = newGame(seed, settings, RULESET);
          const where = `${mapSize}/${String(civCount)} civs, seed ${String(seed)}`;

          rec.check(result.ok, `${where}: newGame failed`);
          if (!result.ok) continue;
          games += 1;

          const state = result.value;
          const civs = state.players.filter((player) => player.kind === 'civ');
          const barbarians = state.players.filter((player) => player.kind === 'barbarian');
          rec.check(civs.length === civCount, `${where}: ${String(civs.length)} civilizations`);
          rec.check(
            barbarians.length === 1,
            `${where}: ${String(barbarians.length)} barbarian players`,
          );

          const settlers = state.units.filter((unit) => unit.type === SETTLER.id);
          const boards = state.units.filter((unit) => unit.type === WORKER.id);
          workers += boards.length;
          rec.check(
            settlers.length === civCount,
            `${where}: ${String(settlers.length)} settlers for ${String(civCount)} civilizations`,
          );
          rec.check(
            boards.length === civCount,
            `${where}: ${String(boards.length)} workers for ${String(civCount)} civilizations`,
          );

          const claimed = new Set<number>();
          for (const unit of state.units) {
            const tileIndex = Number(unit.tile);
            const owner = playerOf(state, unit.owner);
            rec.check(
              owner?.kind === 'civ',
              `${where}: unit ${String(unit.id)} belongs to a player that is not a civilization`,
            );
            rec.check(
              Number.isInteger(tileIndex) &&
                tileIndex >= 0 &&
                tileIndex < state.map.width * state.map.height,
              `${where}: unit ${String(unit.id)} stands off the map`,
            );
            const terrain = terrainAtIndex(state.map, tileIndex);
            const def = RULESET.terrains.find((candidate) => candidate.id === terrain);
            rec.check(
              def !== undefined && !def.impassable,
              `${where}: unit ${String(unit.id)} stands on impassable or undescribed terrain`,
            );
            rec.check(
              !claimed.has(tileIndex),
              `${where}: two starting units share tile ${String(tileIndex)}`,
            );
            claimed.add(tileIndex);

            const type = unitDef(RULESET, unit.type);
            rec.check(
              type !== undefined && unit.movementLeft === type.movement && unit.movementLeft > 0,
              `${where}: unit ${String(unit.id)} starts with ${String(unit.movementLeft)} movement`,
            );

            if (unit.type === SETTLER.id && owner !== undefined) {
              rec.check(
                unit.tile === owner.startingTile,
                `${where}: a settler is not on its civilization's starting tile`,
              );
            }
            if (unit.type === WORKER.id && owner !== undefined) {
              const neighbours = neighbors8(state.map, Number(owner.startingTile)).map(Number);
              rec.check(
                neighbours.includes(tileIndex) && unit.tile !== owner.startingTile,
                `${where}: a worker is not on a free tile beside its settler`,
              );
            }
          }

          rec.check(
            state.nextUnitId === state.units.length,
            `${where}: nextUnitId is ${String(state.nextUnitId)} for ${String(
              state.units.length,
            )} units`,
          );
          rec.check(
            state.units.every((unit, index) => Number(unit.id) === index),
            `${where}: unit ids are not dense and ordered`,
          );
          rec.check(isHashable(state), `${where}: the starting state is unhashable`);
          checkMoneyShape(rec, state, where);
        }
      }
    }

    // Discriminating, and exact: every size and every legal civilization count was really
    // built, and every worker was really placed (not silently skipped). The expected
    // counts are computed from `MAP_SIZES`/`MAP_DIMENSIONS` rather than written down, so a
    // size added later is covered by construction.
    expect(games).toBe(expectedGames);
    expect(games).toBeGreaterThan(80);
    expect(workers).toBe(expectedWorkers);
    expect(workers).toBeGreaterThan(500);
    expect(rec.problems).toEqual([]);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * 7. Determinism, in-process and in a fresh process
 * ------------------------------------------------------------------ */

interface RecordedSpawn {
  readonly owner: PlayerId;
  readonly type: UnitTypeId;
  readonly tile: TileIndex;
}

interface RecordedCommand {
  readonly player: PlayerId;
  readonly cmd: Command;
}

/**
 * A money game as *data*: the seed, the units to place, and every command in order.
 * Passing this to a child process rather than duplicating the play loop inside a string
 * is what makes "the same commands" literal — the two processes cannot drift apart,
 * because there is only one script.
 */
interface Recording {
  readonly seed: number;
  readonly mapSize: MapSize;
  readonly civCount: number;
  readonly spawns: readonly RecordedSpawn[];
  readonly commands: readonly RecordedCommand[];
}

const recordMoneyGame = (seed: number, steps: number, civCount: number): Recording => {
  const base = startedState(seed, civCount);
  const spawns: RecordedSpawn[] = [];
  let state = base;
  for (const player of base.players) {
    if (player.kind !== 'civ') continue;
    for (let n = 0; n < 10; n += 1) {
      spawns.push({ owner: player.id, type: MILITARY.id, tile: player.startingTile });
      state = spawnUnit(state, MILITARY, player.id, player.startingTile).state;
    }
  }

  const prng = makePrng(seed);
  const commands: RecordedCommand[] = [];
  const rateChoices: readonly Rates[] = [
    { tax: 0, science: 0, luxury: RATE_TOTAL },
    { tax: 3, science: 3, luxury: 4 },
    { tax: RATE_TOTAL, science: 0, luxury: 0 },
  ];

  for (let step = 0; step < steps; step += 1) {
    const acting = playersOf(state)[0];
    if (acting === undefined) break;
    let chosen: RecordedCommand | undefined;

    switch (step % 5) {
      case 0: {
        const founds = [...legalActions(state, RULESET, acting)].filter(
          (cmd) => cmd.type === 'FoundCity',
        );
        const pick = founds[prng() % Math.max(1, founds.length)];
        if (pick !== undefined) chosen = { player: acting, cmd: pick };
        break;
      }
      case 1: {
        const city = state.cities[0];
        if (city !== undefined) {
          chosen = {
            player: acting,
            cmd: {
              type: 'SetProduction',
              cityId: city.id,
              item: { kind: 'unit', id: MILITARY.id },
            },
          };
        }
        break;
      }
      case 2: {
        const rates = rateChoices[prng() % rateChoices.length];
        if (rates !== undefined) chosen = { player: acting, cmd: { type: 'SetRates', rates } };
        break;
      }
      default:
        break;
    }

    if (chosen === undefined) chosen = { player: acting, cmd: END_TURN };

    const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
    if (!outcome.ok) throw new Error(`recording: ${cmdKey(chosen.cmd)} was refused`);
    commands.push(chosen);
    state = outcome.value.state;
  }

  return { seed, mapSize: settingsFor(seed, civCount).mapSize, civCount, spawns, commands };
};

interface ReplayResult {
  readonly hash: string;
  readonly gold: readonly number[];
  readonly disbands: number;
  readonly shortfalls: number;
  readonly units: number;
}

const replay = (recording: Recording): ReplayResult => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    mapSize: recording.mapSize,
    civCount: recording.civCount,
    seed: recording.seed,
  };
  const started = newGame(recording.seed, settings, RULESET);
  if (!started.ok) throw new Error(`replay: newGame failed: ${JSON.stringify(started.error)}`);

  let state = started.value;
  for (const spawn of recording.spawns) {
    state = spawnUnit(state, MILITARY, spawn.owner, spawn.tile).state;
  }

  let disbands = 0;
  let shortfalls = 0;
  for (const entry of recording.commands) {
    const outcome = applyCommand(state, entry.player, entry.cmd, RULESET);
    if (!outcome.ok) {
      throw new Error(`replay: ${cmdKey(entry.cmd)} was refused: ${errorText(outcome.error)}`);
    }
    disbands += disbandEventsOf(outcome.value.events).length;
    shortfalls += shortfallEventsOf(outcome.value.events).length;
    state = outcome.value.state;
  }

  return {
    hash: hashValue(state),
    gold: goldsOf(state),
    disbands,
    shortfalls,
    units: state.units.length,
  };
};

/** The one line the contract under test is: hash, every player's gold, and the counts. */
const replayLine = (result: ReplayResult): string =>
  [
    result.hash,
    result.gold.join(','),
    String(result.disbands),
    String(result.shortfalls),
    String(result.units),
  ].join(' ');

/** `tsx` is a devDependency; a missing install is a broken checkout, so say so. */
const tsxCliPath = (): string => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch (cause) {
    throw new Error(
      'the fresh-process check needs the `tsx` devDependency (resolved as "tsx/cli"): ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
};

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The child program: a *generic* replayer for whatever recording it is handed. It
 * contains no policy and no expectations, so a difference between it and the in-process
 * replay can only come from the engine.
 */
const childScript = (recording: Recording): string => `
import { DEFAULT_SETTINGS, applyCommand, newGame, spawnUnit } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const recording = JSON.parse(${JSON.stringify(JSON.stringify(recording))});
const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const settings = { ...DEFAULT_SETTINGS, mapSize: recording.mapSize, civCount: recording.civCount, seed: recording.seed };
const started = newGame(recording.seed, settings, ruleset);
if (!started.ok) throw new Error('newGame failed: ' + JSON.stringify(started.error));
let state = started.value;

for (const spawn of recording.spawns) {
  const def = ruleset.units.find((unit) => unit.id === spawn.type);
  if (def === undefined) throw new Error('the ruleset defines no unit type ' + String(spawn.type));
  state = spawnUnit(state, def, spawn.owner, spawn.tile).state;
}

let disbands = 0;
let shortfalls = 0;
for (const entry of recording.commands) {
  const outcome = applyCommand(state, entry.player, entry.cmd, ruleset);
  if (!outcome.ok) {
    throw new Error('recorded command refused: ' + JSON.stringify(entry.cmd) + ' -> ' + JSON.stringify(outcome.error));
  }
  for (const event of outcome.value.events) {
    if (event.type === 'UnitDisbanded') disbands += 1;
    if (event.type === 'TreasuryShortfall') shortfalls += 1;
  }
  state = outcome.value.state;
}

const gold = state.players.map((player) => player.treasury).join(',');
console.log('RESULT ' + hashValue(state) + ' ' + gold + ' ' + String(disbands) + ' ' + String(shortfalls) + ' ' + String(state.units.length));
`;

describe('7. determinism — in-process and in a fresh process', () => {
  it('replays a money game to the same hash, the same gold and the same disband count in-process', () => {
    const recording = recordMoneyGame(7, 40, 2);
    const first = replay(recording);
    const second = replay(recording);

    expect(second.hash).toBe(first.hash);
    expect(second.gold).toEqual(first.gold);
    expect(second.disbands).toBe(first.disbands);
    expect(second.units).toBe(first.units);

    // Non-vacuity: money moved — units were disbanded, and every player's gold is pinned
    // by the final state.
    expect(first.disbands).toBeGreaterThan(0);
    expect(first.gold.length).toBe(3);
    console.log(
      `m4b recording: ${String(recording.commands.length)} commands, ${String(
        first.disbands,
      )} disbands, golds ${first.gold.join(',')}, hash ${first.hash}`,
    );
  });

  it('reproduces the same line in a fresh process', () => {
    const recording = recordMoneyGame(21, 40, 3);
    const expected = replay(recording);

    const result = spawnSync(process.execPath, [tsxCliPath(), '-e', childScript(recording)], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const stderr = `${result.stderr}${
      result.error === undefined ? '' : `launch failed: ${result.error.message}`
    }`;
    expect(result.status, `the fresh process failed:\n${stderr}`).toBe(0);

    const lines = result.stdout
      .split('\n')
      .filter((candidate) => candidate.startsWith('RESULT '))
      .map((candidate) => candidate.slice('RESULT '.length).trim());

    expect(lines).toHaveLength(1);
    const observed = lines[0] ?? '';
    console.log(`fresh process: ${observed} | in-process: ${replayLine(expected)}`);

    // The whole line, not just the hash: a hash collision could hide a different ledger,
    // and the gold of every player is the part M4b added.
    expect(observed).toBe(replayLine(expected));
    expect(expected.disbands).toBeGreaterThan(0);
    expect(expected.gold.some((value) => value > 0)).toBe(true);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * 8. Are the goldens still a real gate?
 * ------------------------------------------------------------------ */

/** The golden harness's own scenario shape: tiny map, two civilizations. */
const goldenState = (seed: number): GameState => {
  const settings: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed };
  const result = newGame(seed, settings, RULESET);
  if (!result.ok) throw new Error(`golden newGame(${String(seed)}) failed`);
  return result.value;
};

describe('8. goldens: still a gate, and what they do and do not cover', () => {
  it('stores the hashes this build produces, with the money fields inside the hashed input', () => {
    const stored = loadGoldens();
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    const computed = [1, 42, 1337].map((seed) => hashValue(goldenState(seed)));
    console.log('m4b golden hashes:', computed.join(' '));

    // The gate, recomputed here without the harness: the file on disk must be exactly
    // what this build produces. M4b moved these three hashes deliberately
    // (`SCHEMA_VERSION` 4 -> 5: four money fields on every player, plus M4b's starting
    // worker), through the harness's opt-in path and with a `rehash:` note; nothing else
    // may move them.
    expect(stored.entries.map((entry) => entry.hash)).toEqual(computed);
    expect(stored.entries.map((entry) => entry.name)).toEqual([
      'tiny-civs2-seed1',
      'tiny-civs2-seed42',
      'tiny-civs2-seed1337',
    ]);
    expect(stored.nodeMajor).toBe(Number.parseInt(process.versions.node, 10));

    const state = goldenState(42);
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5);

    // The four new keys are inside the canonical JSON `hashValue` hashes, so a shape
    // change of any of them — added, renamed, removed — trips the gate. This is the check
    // that keeps "the goldens are green" from meaning "the goldens are stale".
    const canonical = canonicalize(state);
    expect(canonical).toContain('"treasury":');
    expect(canonical).toContain('"rates":');
    expect(canonical).toContain('"beakers":0');
    expect(canonical).toContain('"luxuries":0');

    // Not vacuous: perturbing the money in memory moves the hash, and never to a stored
    // value. A golden that cannot fail is worthless.
    const player = state.players[0];
    if (player === undefined) throw new Error('the golden state must hold a player');
    const richer: GameState = {
      ...state,
      players: state.players.map((candidate) =>
        candidate.id === player.id ? { ...candidate, treasury: candidate.treasury + 1 } : candidate,
      ),
    };
    const shifted: GameState = {
      ...state,
      players: state.players.map((candidate) =>
        candidate.id === player.id
          ? { ...candidate, rates: { tax: RATE_TOTAL, science: 0, luxury: 0 } }
          : candidate,
      ),
    };
    expect(hashValue(richer)).not.toBe(hashValue(state));
    expect(hashValue(shifted)).not.toBe(hashValue(state));
    for (const entry of stored.entries) {
      expect(entry.hash).not.toBe(hashValue(richer));
      expect(entry.hash).not.toBe(hashValue(shifted));
    }

    // And the unhashable spelling the project has been bitten by three times is still
    // refused, for the money fields as for every other: a key holding `undefined` cannot
    // survive a JSON round trip, so it must throw rather than hash to something ephemeral.
    expect(() => hashValue({ ...state, players: [{ ...player, treasury: undefined }] })).toThrow();
    expect(() => hashValue({ ...state, players: [{ ...player, beakers: undefined }] })).toThrow();
    expect(() => hashValue({ ...state, players: [{ ...player, rates: undefined }] })).toThrow();
  });

  it('covers the starting money and the starting worker, and no money *behaviour*', () => {
    // The boundary, stated at its M4b width rather than assumed. The golden scenarios hash
    // `newGame` states, so they pin: the four money keys, `SCHEMA_VERSION`, one starting
    // worker per civilization, and the starting treasury at the default rates. They pin
    // **nothing** about a played turn: no state has ever collected income, paid upkeep or
    // disbanded a unit, because none of them has had a turn applied. The conservation
    // evidence is elsewhere (`packages/core/test/economy.test.ts` and section 2 above);
    // this test exists so "the goldens are green" is never read as "the money loop works",
    // and if a golden scenario ever gains a *played* turn this fails and a human learns the
    // coverage changed — which is exactly when a rehash note is owed anyway.
    for (const seed of [1, 42, 1337]) {
      const state = goldenState(seed);
      expect(state.turn).toBe(1);
      expect(state.revision).toBe(0);
      expect(state.cities).toEqual([]);
      expect(state.improvements).toEqual([]);
      for (const player of state.players) {
        expect(player.rates).toEqual(DEFAULT_RATES);
        expect(player.beakers).toBe(0);
        expect(player.luxuries).toBe(0);
        expect(player.treasury).toBe(player.kind === 'civ' ? STARTING_TREASURY : 0);
      }
      const workers = state.units.filter((unit) => unit.type === WORKER.id);
      const civs = state.players.filter((player) => player.kind === 'civ').length;
      expect(workers).toHaveLength(civs);
    }
  });
});

/* ------------------------------------------------------------------ *
 * What is permanent, and what is only here
 * ------------------------------------------------------------------ *
 *
 * The question a review owes an answer to is whether the sweeps above left anything
 * behind. Written out so nobody has to guess, and so a gap is visible rather than implied
 * by a green run.
 *
 * **Checked permanently (this file is not the only thing standing between these
 * invariants and a green gate):**
 *
 * - The rate rule, the split (including remainder-to-gold), the total reads of a malformed
 *   state, the free-allowance formula, the disband order and the ledger identity on
 *   hand-built boards: `packages/core/test/economy.test.ts`.
 * - `SetRates`' legality, its exhaustive 66-triple sweep, its refusals and its
 *   no-event/only-rates-moved behaviour: `packages/core/test/commands.test.ts`.
 * - The starting units (one settler and one worker per civilization, the worker beside its
 *   settler, barbarians with none) and the starting money, for the shipped catalog on the
 *   default settings: `packages/core/test/state.test.ts`.
 * - The M4b acceptance scenarios (bankruptcy with exact ids and gold, a 100+ turn
 *   conservation scenario, the rate split, starting units):
 *   `packages/testing/test/scenarios.test.ts`.
 * - The four money events in the pipeline's event order, and every player's treasury
 *   non-negative and integral after a turn: `packages/testing/test/m3-adversarial.test.ts`
 *   (migrated for M4b) and `packages/core/test/turn.test.ts`.
 * - The golden gate — the three pinned hashes, the `nodeMajor` rule, and the harness's
 *   refusal to auto-write (a copied harness with a corrupted golden must fail *and* leave
 *   the file untouched): `packages/testing/test/golden.test.ts` and
 *   `packages/testing/test/m3-adversarial.test.ts`.
 * - Fresh-process determinism for command-level games:
 *   `packages/testing/test/{m2,m3,m4a}-adversarial.test.ts`.
 *
 * **Checked only here (a one-off check that leaves no test behind would not be
 * verification, so each of these is a test in this file):**
 *
 * 1. money conservation *re-derived from the events* over 100+ turns on several seeds,
 *    with the split, the support bill and the maintenance sum recomputed from the
 *    contract's own rules rather than read back from the module;
 * 2. the pipeline's placement of the money loop, asserted by hashing `applyEconomy`'s
 *    refilled result against `advanceTurn`'s state and comparing the money event tail;
 * 3. the treasury-never-negative attack board (180 units, zero income, three simultaneous
 *    bankruptcies) and the corrupt-treasury/corrupt-rates totality;
 * 4. the *unreachability* of `TreasuryShortfall` under the shipped catalog, and its
 *    reachability through a maintenance-declaring ruleset view — the M4c boundary, pinned
 *    rather than argued;
 * 5. disband determinism across a JSON round trip and across a permuted presentation of
 *    the same state, and the barbarian checks (never charged, never disbanded, its units on
 *    nobody's bill, its city's commerce collected by nobody);
 * 6. the sixth generator's completeness over the whole rate space plus fourteen malformed
 *    payloads, two-directionally against the applier — including the `SetRates` totality
 *    defect this review found and fixed;
 * 7. the rate-change semantics twin (no recollection, next collection reads the new rates)
 *    and the produced-unit-costs-support-this-turn twin;
 * 8. the starting-unit contract on **all six map sizes and every civilization count the
 *    settings allow** (84 generated games), not only the default settings;
 * 9. fresh-process determinism for a *money* game, comparing every player's gold and the
 *    disband count as well as the hash;
 * 10. the explicit statement of what the goldens do *not* cover about money, asserted
 *     rather than assumed.
 */
