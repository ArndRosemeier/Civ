/**
 * The money loop — what a civilization's commerce becomes, what it costs to keep
 * an army standing, and what happens when the treasury cannot pay.
 * See docs/INTERFACES.md M4b ("Rates and the commerce split", "The money loop"),
 * PLAN.md §5.3 (determinism) and §5.4 (data layout).
 *
 * The frozen contract, in full:
 *
 * - Each city's commerce is split by its owner's `Rates`. `RATE_TOTAL` is a
 *   placeholder chosen so the split is exact integer arithmetic: `tax` tenths to
 *   gold, `science` tenths to beakers, `luxury` tenths to luxuries, and the
 *   **remainder from integer division goes to gold** — deterministic and stated,
 *   not "whatever floating point did".
 * - Per turn, per player, in **player-id order**: income (every city's gold
 *   share, plus building/improvement gold effects), then upkeep (building
 *   maintenance plus unit support), then `treasury += income - upkeep`, then
 *   **bankruptcy**.
 * - Unit support (placeholder): the first
 *   `FREE_UNITS_PER_CITY * cityCount + FREE_UNITS_BASE` units are free; each unit
 *   beyond that costs `UNIT_SUPPORT_COST` gold. Only civilizations' units count —
 *   barbarians have no economy.
 * - Bankruptcy: a treasury that would go below zero floors at **0** and the
 *   shortfall is paid by **disbanding units**, deterministically: repeatedly
 *   remove the highest-id unit of that player until the shortfall is covered or
 *   no unit remains that can pay. Each removal emits `UnitDisbanded`. The
 *   treasury NEVER goes negative; if the shortfall survives every disband, the
 *   unpaid amount is reported in a `TreasuryShortfall` event rather than
 *   invented as a debt field.
 *
 * Design notes:
 *
 * - **Integers only.** Every number here is an integer sum, difference or product
 *   of integers (PLAN.md §5.3, docs/ENGINE.md "Economy maths is integer-only"):
 *   no floats, no transcendentals, no RNG, no clock. The one place a fraction
 *   could appear is the split, and it is `Math.floor`ed there and nowhere else —
 *   see `splitCommerce`.
 * - **This module is a transition, not a command.** `applyEconomy` does not touch
 *   `revision`, `turn` or the RNG: `turn.ts` owns the order of a turn and calls
 *   this as one step of it, exactly as it calls growth and production. The
 *   contract's placement is *after production and before the movement refill*, so
 *   a unit produced this turn costs support from the turn it appears — that
 *   ordering is stated in `turn.ts`, which is where the order lives.
 * - **The event stream is the ledger.** `IncomeCollected` and `UpkeepPaid` are
 *   emitted for every civilization on every turn, including a turn whose amount is
 *   zero. M4a suppressed a per-worker "progress" line because the state already
 *   carried it and nothing could act on it; a collection line is different: the
 *   acceptance evidence for M4b is that gold is *accounted for* — income minus
 *   upkeep minus spending equals the delta — and that identity is checkable from
 *   the event stream alone only if the stream is complete. A consumer that finds
 *   zero lines noisy can filter on `gold === 0`; a consumer trying to reconstruct
 *   a *suppressed* line can only guess.
 * - **A disband never saves more than is still owed.** Each removal of a
 *   supported unit saves that unit's `UNIT_SUPPORT_COST` of this turn's upkeep,
 *   and the last one is capped at what remains of the shortfall. Without the cap a
 *   disband worth 1 gold could "cover" a 1-gold shortfall twice over, and the
 *   treasury would have to either discard gold (a lie) or go positive on a turn
 *   the player was broke (also a lie). With it, the identity below is exact.
 * - **The ledger identity, in one line.**
 *   `treasuryAfter - treasuryBefore === income - upkeep + covered + unpaid`,
 *   where `covered` is the sum of every `UnitDisbanded.saved` and `unpaid` is
 *   `TreasuryShortfall.unpaid`. `treasuryAfter` is `max(0, …)` of that sum, so the
 *   treasury can never be negative (asserted as an invariant by the tests) and the
 *   floor is exactly the bankruptcy branch.
 * - **Everything read is read totally.** A player whose `treasury` is missing or
 *   is not a whole number — a hand-built state, a save from before M4b, a JSON
 *   round trip — is read as 0 rather than allowed to put a `NaN` or a fraction
 *   into the state, which `canonicalize` would then reject (the bug class that has
 *   bitten this project three times). `units.ts` takes the same reading for a
 *   movement budget it cannot resolve.
 * - **Provenance: every number in this module is a placeholder of ours.** The free
 *   unit allowance, the support cost and the starting treasury are unsourced and
 *   chosen to be playable; none of them is presented as Civ 3's. Each constant
 *   says so where it is declared, and `RATE_TOTAL` (in `state.ts`, where the
 *   `Rates` shape lives) does too. Civ 3's real support model is
 *   government-dependent (despotism supports a number of units *per city* free,
 *   and free support changes with the government), which this engine does not
 *   model at all: `FREE_UNITS_PER_CITY`/`FREE_UNITS_BASE` are our own flat
 *   approximation, NOT that rule.
 */

import { buildingDef, cityYields, type BuildingDef } from './cities.js';
// Type-only: this module produces events and never calls into the command layer,
// so the edge is erased and `commands.ts` (which imports `ratesProblem` from here
// as a *value*) cannot form a runtime cycle.
import type { GameEvent } from './commands.js';
import type { PlayerId } from './ids.js';
import type { RulesetView } from './map.js';
import {
  DEFAULT_RATES,
  RATE_TOTAL,
  type GameState,
  type PlayerState,
  type Rates,
} from './state.js';
import type { Unit } from './units.js';

/* ------------------------------------------------------------------ *
 * Tuning constants — every one a placeholder of ours
 * ------------------------------------------------------------------ */

/**
 * Units a city supports for free. 2 is a **placeholder**: it is unsourced and
 * chosen to be playable — one unit to defend the city and one to work its land is
 * the smallest garrison that does not make a city a gold sink on the turn it is
 * founded — and it is **not** a Civ 3 figure, whose free support is a
 * per-government number this engine does not model.
 */
export const FREE_UNITS_PER_CITY = 2;

/**
 * Units a civilization supports for free before it owns any city. 4 is a
 * **placeholder**: it is unsourced and chosen to be playable — a new game hands
 * every civilization a settler and a worker (M4b, "Starting units"), and 4 leaves
 * room for a scout and a defender too, so a player is never forced into
 * bankruptcy, and never has its starting units disbanded, before it has founded
 * its first city and can earn anything. It is not a sourced Civ 3 number.
 */
export const FREE_UNITS_BASE = 4;

/**
 * Gold per turn for each unit beyond the free allowance. 1 is a **placeholder**:
 * it is unsourced and chosen to be playable — one gold per unit per turn is
 * enough that a large army visibly drains a treasury while a small one does not —
 * and it is not a sourced Civ 3 figure.
 */
export const UNIT_SUPPORT_COST = 1;

/* ------------------------------------------------------------------ *
 * The commerce split
 * ------------------------------------------------------------------ */

/** How one city's (or one player's) commerce divides between the three channels. */
export interface CommerceSplit {
  /** Gold, added to the treasury this turn. */
  readonly gold: number;
  /**
   * Beakers, added to the player's `beakers` pool. **Inert in M4b**: nothing
   * spends beakers until M5 (research), so this number accumulates and does
   * nothing. Said out loud rather than implied.
   */
  readonly beakers: number;
  /**
   * Luxuries, added to the player's `luxuries` pool. **Inert in M4b**: nothing
   * reads luxuries until M9 (happiness), so this number accumulates and does
   * nothing.
   */
  readonly luxuries: number;
}

/** The split of a city that produces nothing, and the answer for a bad input. */
const NO_COMMERCE: CommerceSplit = { gold: 0, beakers: 0, luxuries: 0 };

/**
 * Split `commerce` into gold, beakers and luxuries at `rates` — the one
 * definition of the commerce split, and **integer arithmetic throughout**.
 *
 * `rate` tenths out of `RATE_TOTAL` means the exact share is
 * `commerce * rate / RATE_TOTAL`, which is generally not a whole number. Each
 * channel takes the `Math.floor` of its own exact share, and the **remainder goes to
 * gold** — the contract's rule, stated here and nowhere else: a city with 3
 * commerce at 5/4/1 takes 1 gold + 1 beaker + 0 luxuries from the floors and the
 * leftover 1 as gold, so the three parts always add up to exactly the commerce
 * that was split (on a well-formed rates triple). The alternative readings —
 * round-half-up, or "whatever floating point did" — would make the split depend
 * on a rounding mode instead of on the state.
 *
 * Total by construction, on any input:
 *
 * - a commerce that is not a positive, finite number splits into nothing (the
 *   honest answer for a hand-built city whose yields are `NaN` or negative —
 *   negative commerce would otherwise put a negative beaker count into the
 *   state);
 * - a rate that is missing, fractional or negative floors to 0 rather than
 *   producing a fractional or negative channel;
 * - a rates triple that does not sum to `RATE_TOTAL` (a hand-built state; the
 *   command layer refuses one, see `ratesProblem`) can only make the three parts
 *   overflow the commerce, and gold then floors at 0 instead of going negative.
 *
 * Nothing here reads the catalog, the state or the clock: it is a pure function
 * of two numbers.
 */
export const splitCommerce = (commerce: number, rates: Rates): CommerceSplit => {
  if (!Number.isFinite(commerce) || commerce <= 0) return NO_COMMERCE;

  const share = (tenths: number): number =>
    Number.isFinite(tenths) ? Math.max(0, Math.floor((commerce * tenths) / RATE_TOTAL)) : 0;

  const gold = share(rates.tax);
  const beakers = share(rates.science);
  const luxuries = share(rates.luxury);

  // The remainder of the three integer divisions, to gold (see above). It is
  // never negative for a rates triple that sums to `RATE_TOTAL`; the clamp is
  // there for a triple that does not, where "gold is not negative" is still the
  // only honest answer.
  const remainder = commerce - gold - beakers - luxuries;
  return { gold: Math.max(0, gold + remainder), beakers, luxuries };
};

/**
 * What is wrong with `rates`, as a human-readable reason, or `undefined` when the
 * triple is one this engine accepts — the single statement of the rate rule, used
 * by `planSetRates` to refuse and by anything that wants to grey out a slider
 * before the player submits it.
 *
 * The rule is the contract's: three **integers, each `>= 0`, summing to exactly
 * `RATE_TOTAL`**. The message names the offending part and, for the sum, the
 * actual total — a refusal that said only "invalid rates" would leave a caller
 * re-deriving which of four conditions it broke.
 *
 * `Rates` is a structural type, so a caller can hand over an object with a
 * missing or non-numeric field — or something that is not an object at all, which
 * is what a JSON command file or a foreign client produces when the payload is
 * `null` or absent. Every check below is written to survive that rather than to
 * trust the type at runtime: the *rule* fails, and it fails as a typed
 * `invalid-argument`, never as a `TypeError` escaping `applyCommand`.
 */
export const ratesProblem = (rates: Rates): string | undefined => {
  const tax = rateField(rates, 'tax');
  const science = rateField(rates, 'science');
  const luxury = rateField(rates, 'luxury');

  let total = 0;
  const parts: readonly (readonly [string, number | undefined])[] = [
    ['tax', tax],
    ['science', science],
    ['luxury', luxury],
  ];

  for (const [name, value] of parts) {
    if (value === undefined || !Number.isInteger(value) || value < 0) {
      return `${name} must be an integer >= 0 (got ${String(value)})`;
    }
    total += value;
  }

  if (total !== RATE_TOTAL) {
    return (
      `the three rates must sum to exactly ${String(RATE_TOTAL)} ` +
      `(got tax ${String(tax)} + science ${String(science)} + ` +
      `luxury ${String(luxury)} = ${String(total)})`
    );
  }

  return undefined;
};

/**
 * Can a value be indexed by a key at all? A type predicate rather than a cast, so
 * `rateField` below can widen to `unknown`, narrow with a real runtime check, and
 * still read a field without asserting a shape nothing verified.
 */
const isIndexable = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

/**
 * One field of a rates triple, read **totally** — `undefined` for anything this
 * engine cannot read a rate out of, including a payload that is not an object at
 * all (`null`, absent, a string, an array).
 *
 * The guard is here rather than in `planSetRates` because the totality belongs to
 * the rule: `applyCommand` and a UI's "is this slider legal?" question both run
 * through `ratesProblem`, and a caller that lied about the type must get the same
 * typed refusal from both. Reading the field through `unknown` is also what keeps
 * this honest under `exactOptionalPropertyTypes`: a rate is a number or it is not
 * a rate, and there is no third case to guess at.
 */
const rateField = (rates: Rates, key: keyof Rates): number | undefined => {
  // Through `unknown` on purpose: the parameter's type says `Rates`, and the whole
  // point of this helper is that the caller may have lied. Widening to `unknown` and
  // narrowing with a real runtime check is what makes the guard a check rather than a
  // comparison the typechecker (rightly) calls unnecessary — and it needs no cast.
  const source: unknown = rates;
  if (!isIndexable(source)) return undefined;
  const value: unknown = source[key];
  return typeof value === 'number' ? value : undefined;
};

/* ------------------------------------------------------------------ *
 * Reads of the state: what a player earns and what it owes
 * ------------------------------------------------------------------ */

/** The player with this id, or `undefined` — the same read the command layer makes. */
const playerById = (state: GameState, playerId: PlayerId): PlayerState | undefined =>
  state.players.find((player) => player.id === playerId);

/**
 * A whole number read out of the state, or 0.
 *
 * The state is typed, so every field below is a `number` at compile time — but a
 * hand-built state, an older save loaded through JSON, or a foreign object can
 * still carry `undefined`, a fraction or a `NaN`, and putting any of those back
 * into the state would make it unhashable (`canonicalize` rejects them by
 * design). A count the engine cannot read is therefore treated as 0, exactly as
 * `units.ts` treats a movement budget it cannot read.
 */
const wholeNumber = (value: number): number => (Number.isInteger(value) ? value : 0);

/** The rates to split at: the player's own, or the defaults for a state without them. */
const ratesOf = (player: PlayerState | undefined): Rates => player?.rates ?? DEFAULT_RATES;

/**
 * Every unit owned by `playerId`, in `state.units` order (sorted by id). Empty for
 * a player that owns none — the common answer, and not an error.
 *
 * Barbarians are not special-cased here: this is a plain ownership read, and it is
 * `applyEconomy` (which skips non-civilizations outright) that decides who has an
 * economy at all.
 */
const ownedUnits = (state: GameState, playerId: PlayerId): readonly Unit[] =>
  state.units.filter((unit) => unit.owner === playerId);

/**
 * The units `playerId` may keep without paying: `FREE_UNITS_PER_CITY` per city it
 * owns, plus `FREE_UNITS_BASE` — the contract's placeholder formula, in the one
 * place it is written down.
 *
 * A city count read from `state.cities` by owner, so a player with no cities still
 * has its `FREE_UNITS_BASE`. The count is a whole number by construction (it is a
 * length), so nothing here can produce a fraction.
 */
export const freeUnitAllowance = (state: GameState, playerId: PlayerId): number => {
  const cities = state.cities.filter((city) => city.owner === playerId).length;
  return FREE_UNITS_PER_CITY * cities + FREE_UNITS_BASE;
};

/** What a player's army costs this turn, and the counts behind the number. */
export interface UnitSupport {
  /** Every unit the player owns. */
  readonly units: number;
  /** How many of them are free (`freeUnitAllowance`). */
  readonly free: number;
  /** How many are over the allowance and therefore billable. */
  readonly supported: number;
  /** `supported * UNIT_SUPPORT_COST`. */
  readonly gold: number;
}

/**
 * What `playerId`'s units cost in this state — the contract's rule: the first
 * `freeUnitAllowance` units are free, every unit beyond that costs
 * `UNIT_SUPPORT_COST` gold.
 *
 * Which units are "the free ones" is not stored and does not need to be: the cost
 * is uniform, so the bill depends only on the *count*. That is also what makes the
 * disband rule below well defined — removing any one supported unit saves exactly
 * one unit's cost.
 */
export const unitSupport = (state: GameState, playerId: PlayerId): UnitSupport => {
  const units = ownedUnits(state, playerId).length;
  const free = freeUnitAllowance(state, playerId);
  const supported = Math.max(0, units - free);
  return { units, free, supported, gold: supported * UNIT_SUPPORT_COST };
};

/**
 * How much a single building costs its owner each turn.
 *
 * M4b **adds no buildings' effects**: the contract says it "sums whatever
 * `maintenance` the catalog already declares", and the catalog declares none —
 * buildings carry a `cost` in shields and nothing else (see `BuildingDef`), because
 * effects are M4c's "buildings & wonders v1". The field is therefore read
 * *structurally*: a row that carries an integer `maintenance > 0` is billed, and a
 * row that carries nothing is billed 0, so M4c can fill the field in without this
 * module changing its mind about what a building costs.
 *
 * The read is total on a foreign row: a missing field, a fraction, a negative
 * number or a string all mean "this row declares no maintenance", never a
 * fractional bill.
 */
const maintenanceOf = (def: BuildingDef): number => {
  if (!('maintenance' in def)) return 0;
  const declared: unknown = def.maintenance;
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : 0;
};

/**
 * What `playerId`'s buildings cost each turn: the sum of every owned city's
 * buildings' maintenance, in city-id order (the order of `state.cities`).
 *
 * A building id the ruleset does not describe costs nothing — the same
 * reading `production.ts` gives an item it cannot price. Nothing is charged twice
 * for the same row in the same city: a city's `buildings` list is its own set
 * (M3 refuses to build one twice), and a hand-built duplicate is billed twice
 * because it *is* two entries; saying so is cheaper than inventing a de-duplication
 * rule the state shape does not have.
 */
export const buildingMaintenance = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): number => {
  let total = 0;
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    for (const building of city.buildings) {
      const def = buildingDef(ruleset, building);
      if (def === undefined) continue;
      total += maintenanceOf(def);
    }
  }
  return total;
};

/** What one player owes this turn: the two halves, and their sum. */
export interface Upkeep {
  /** Building maintenance, summed over the player's cities. */
  readonly maintenance: number;
  /** Unit support in gold (`unitSupport(...).gold`). */
  readonly unitSupport: number;
  /** `maintenance + unitSupport` — the gold this player's upkeep costs. */
  readonly gold: number;
}

/**
 * What `playerId` owes this turn: building maintenance plus unit support, both in
 * gold. The two halves are kept apart because a player that is bankrupt wants to
 * know *which* half broke it — disbanding units fixes one and not the other.
 */
export const playerUpkeep = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): Upkeep => {
  const maintenance = buildingMaintenance(state, ruleset, playerId);
  const support = unitSupport(state, playerId).gold;
  return { maintenance, unitSupport: support, gold: maintenance + support };
};

/**
 * What `playerId` collects this turn: the sum of every owned city's commerce split
 * at the player's rates, summed per channel.
 *
 * - **The split is per city, not per player.** `floor` is applied to each city's
 *   own share and the remainder-to-gold rule is applied per city, which is what the
 *   contract's "each city's commerce is split by the rates" says. Summing the
 *   commerce first and splitting once would give a different — equally defensible,
 *   but *different* — gold total, which is exactly why this one is stated.
 * - **`gold` is this turn's income.** `beakers` and `luxuries` are the same split's
 *   other two channels: they accumulate into the player's pools and do nothing
 *   until M5 and M9 respectively.
 * - **No building or improvement gold effects exist yet.** The contract's income
 *   line mentions them; `BuildingDef` carries no `gold` field and M4c owns effects,
 *   so today this term is exactly the cities' gold share. Stated here rather than
 *   left to be discovered.
 * - An unknown `playerId` collects nothing, and a player with no cities collects
 *   nothing: both are the honest answer for a read that has no failure channel.
 */
export const playerIncome = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): CommerceSplit => {
  const player = playerById(state, playerId);
  if (player === undefined) return NO_COMMERCE;
  const rates = ratesOf(player);

  let gold = 0;
  let beakers = 0;
  let luxuries = 0;

  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    const split = splitCommerce(cityYields(state, ruleset, city.id).commerce, rates);
    gold += split.gold;
    beakers += split.beakers;
    luxuries += split.luxuries;
  }

  return { gold, beakers, luxuries };
};

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

/** The state after one economy step, and everything that happened during it. */
export interface EconomyOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** `state` with `playerId`'s money fields replaced (`players` is rebuilt, not mutated). */
const withMoney = (
  state: GameState,
  playerId: PlayerId,
  money: { readonly treasury: number; readonly beakers: number; readonly luxuries: number },
): GameState => ({
  ...state,
  players: state.players.map((player) =>
    player.id === playerId
      ? {
          ...player,
          treasury: money.treasury,
          beakers: money.beakers,
          luxuries: money.luxuries,
        }
      : player,
  ),
});

/**
 * The highest-id unit owned by `playerId`, or `undefined` when the player owns
 * none — the unit the bankruptcy rule removes first.
 *
 * Written as a fold over `state.units` rather than "the last matching entry", so
 * the answer is the highest *id* even on a hand-built state whose `units` array is
 * not sorted. Ids are unique, so there is no tie to break.
 */
const highestIdUnit = (state: GameState, playerId: PlayerId): Unit | undefined =>
  state.units.reduce<Unit | undefined>((highest, unit) => {
    if (unit.owner !== playerId) return highest;
    if (highest === undefined || Number(unit.id) > Number(highest.id)) return unit;
    return highest;
  }, undefined);

/** `state` without the unit of that id (`units` is rebuilt, not mutated). */
const withoutUnit = (state: GameState, unitId: Unit['id']): GameState => ({
  ...state,
  units: state.units.filter((unit) => unit.id !== unitId),
});

/**
 * Pay one turn of every civilization's economy: income, upkeep, and bankruptcy if
 * the two do not meet — for **every civilization, in player-id order**.
 *
 * Why a separate pass rather than a branch inside production: money is not a
 * city's business. A civilization's treasury is one number fed by every city it
 * owns, and its army is supported by the civilization, not by the city that built
 * it — so the sums have to happen where all the cities are in view. `turn.ts`
 * calls this *after* production and *before* the movement refill, which is what
 * makes a unit produced this turn cost support from the turn it appears.
 *
 * Per player, in this order:
 *
 * 1. **income** — `playerIncome`: every city's commerce split at the player's
 *    rates. Emits `IncomeCollected` (always, even for a zero).
 * 2. **upkeep** — `playerUpkeep`: building maintenance plus unit support. Emits
 *    `UpkeepPaid` (always).
 * 3. **settle** — `treasury += income - upkeep`. A result `>= 0` is written
 *    straight through, along with the turn's beakers and luxuries.
 * 4. **bankruptcy** — a negative result floors at 0 and the shortfall is covered by
 *    disbanding the player's **highest-id** units one at a time (each saving
 *    `UNIT_SUPPORT_COST`, the last capped at what remains), emitting
 *    `UnitDisbanded` per removal and `TreasuryShortfall` for whatever could not be
 *    covered. The treasury is exactly 0 afterwards — never negative — and the
 *    ledger identity in the module note holds to the gold.
 *
 * **Barbarians are skipped entirely.** They are a player (M3) so their units are
 * ordinary units, but the contract is explicit — "barbarians have no economy" — so
 * they collect nothing, pay nothing, are never disbanded, and their treasury and
 * pools stay at 0. Skipping them also keeps this pass from being a way to delete
 * barbarian units by making them broke.
 *
 * Deterministic and pure: players are visited by ascending id, cities by the order
 * of `state.cities` (sorted by id), the disband victim by highest id, and nothing
 * here reads the RNG, a clock or the environment. The input state is never
 * modified.
 */
export const applyEconomy = (state: GameState, ruleset: RulesetView): EconomyOutcome => {
  let current = state;
  const events: GameEvent[] = [];

  // Sorted explicitly rather than trusting the array: `PlayerId` *is* the index
  // into `players` on every state the engine assembled, but the contract says "in
  // player-id order" and this makes that true of a hand-built state too.
  const inIdOrder = [...state.players].sort((a, b) => Number(a.id) - Number(b.id));

  for (const player of inIdOrder) {
    if (player.kind !== 'civ') continue; // barbarians have no economy

    const income = playerIncome(current, ruleset, player.id);
    const upkeep = playerUpkeep(current, ruleset, player.id);
    const support = unitSupport(current, player.id);

    events.push({
      type: 'IncomeCollected',
      playerId: player.id,
      gold: income.gold,
      beakers: income.beakers,
      luxuries: income.luxuries,
    });
    events.push({
      type: 'UpkeepPaid',
      playerId: player.id,
      gold: upkeep.gold,
      maintenance: upkeep.maintenance,
      unitSupport: upkeep.unitSupport,
      units: support.units,
      // The allowance and the billable count travel with the event so a reader can
      // check the placeholder formula without re-deriving it from the state.
      freeUnits: support.free,
    });

    const settled = wholeNumber(player.treasury) + income.gold - upkeep.gold;

    if (settled >= 0) {
      current = withMoney(current, player.id, {
        treasury: settled,
        beakers: wholeNumber(player.beakers) + income.beakers,
        luxuries: wholeNumber(player.luxuries) + income.luxuries,
      });
      continue;
    }

    const shortfall = -settled;
    let covered = 0;

    // Disband until the shortfall is covered or nothing left can pay for it. The
    // loop only removes *supported* units: a free unit's removal saves no gold, so
    // disbanding one would destroy a unit and buy nothing — which is the sort of
    // arbitrary punishment the contract's "until the shortfall is covered" does not
    // ask for.
    while (covered < shortfall) {
      if (unitSupport(current, player.id).supported <= 0) break;
      const victim = highestIdUnit(current, player.id);
      if (victim === undefined) break;

      const saved = Math.min(UNIT_SUPPORT_COST, shortfall - covered);
      current = withoutUnit(current, victim.id);
      covered += saved;
      events.push({
        type: 'UnitDisbanded',
        playerId: player.id,
        unitId: victim.id,
        unitType: victim.type,
        tile: victim.tile,
        saved,
      });
    }

    // Floored at 0: the whole treasury went on the shortfall (see the module note's
    // ledger identity). The pools still take this turn's beakers and luxuries —
    // they are not gold, and a broke treasury does not un-research anything.
    current = withMoney(current, player.id, {
      treasury: 0,
      beakers: wholeNumber(player.beakers) + income.beakers,
      luxuries: wholeNumber(player.luxuries) + income.luxuries,
    });

    const unpaid = shortfall - covered;
    if (unpaid > 0) {
      events.push({ type: 'TreasuryShortfall', playerId: player.id, unpaid });
    }
  }

  return { state: current, events };
};
