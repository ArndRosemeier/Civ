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
 * - Unit support (**M9: read from the government**): the first
 *   `government.freeUnitsPerCity * cityCount + FREE_UNITS_BASE` units are free; each
 *   unit beyond that costs `government.unitSupportCost` gold. Only civilizations' units
 *   count — barbarians have no economy. M4b wrote the two per-government numbers as
 *   module constants here and said in their own comments that Civ 3's support is
 *   government-dependent and that this engine did not model it; M9 is the milestone
 *   that does, so those constants are gone (see the note where they were).
 * - Bankruptcy: a treasury that would go below zero floors at **0** and the
 *   shortfall is paid by **disbanding units**, deterministically: repeatedly
 *   remove the highest-id unit of that player until the shortfall is covered or
 *   no unit remains that can pay. Each removal emits `UnitDisbanded`. The
 *   treasury NEVER goes negative; if the shortfall survives every disband, the
 *   unpaid amount is reported in a `TreasuryShortfall` event rather than
 *   invented as a debt field. **M4c adds the other half of the bill**: a player
 *   whose buildings outrun its income loses the buildings it could not pay for
 *   (`buildings.ts`' `disbandBuildings`, most recently completed first, until
 *   their maintenance covers what went unpaid) — a wonder included, since a wonder
 *   is a building that bills gold like any other. That loss is a *consequence* of
 *   the unpaid bill, not a payment against it: see the ledger identity below.
 * - **A city's building effects are its own** (M4c): the summed
 *   `commerce-multiplier` of the buildings it holds is already inside the commerce
 *   `cityYields` reports (so the rates split multiplied commerce), and this module
 *   applies the summed `beaker-multiplier` to that city's beaker channel, with one
 *   floor, through `buildings.ts`' `applyEffectPct`. No effect of one city reaches
 *   another, and no effect is computed here: `buildings.ts` owns that rule.
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
 *   supported unit saves that unit's `government.unitSupportCost` of this turn's upkeep,
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
 * - **A building lost to bankruptcy buys no gold, and the identity above is why.**
 *   M4c's `disbandBuildings` removes buildings from a broke player's cities, but
 *   their maintenance is **not** added to `covered`: the player did not pay with
 *   them, it *lost* them, and the gold it failed to pay is still reported unpaid.
 *   Crediting the demolition instead would make every shortfall coverable by
 *   tearing down the very buildings that caused it — `shortfall <= maintenance +
 *   unitSupport` always holds — so `TreasuryShortfall` would become unreachable
 *   from **any** content, which is precisely the M4b debt the contract says M4c
 *   exists to close. What the loss buys is the *next* turn: the maintenance is gone
 *   from `buildingMaintenance`, so a player that sheds its unaffordable buildings
 *   stops bleeding. The ledger identity is therefore unchanged by M4c, and the
 *   tests can keep checking it to the gold.
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
 *   government-dependent (despotism supports a number of units *per city* free, and
 *   free support changes with the government) and **M9 models the shape of it** — the
 *   per-city allowance and the per-unit cost are `GovernmentSpec` rows — while the
 *   specific numbers remain ours: `FREE_UNITS_BASE` and every shipped row are
 *   placeholders, NOT Civ 3's table.
 */

import { buildingCatalog, cityYields } from './cities.js';
// M4c: what a building costs to keep, what its beaker effect does to a city's
// science, and the one way a building is lost. A value import, and a one-way edge
// (`buildings.ts` imports `BuildingDef`/`City` from `cities.ts` type-only and
// nothing from here), so the money loop's own import graph stays acyclic.
import {
  applyEffectPct,
  cityBuildingEffects,
  disbandBuildings,
  playerMaintenance,
} from './buildings.js';
// Type-only: this module produces events and never calls into the command layer,
// so the edge is erased and `commands.ts` (which imports `ratesProblem` from here
// as a *value*) cannot form a runtime cycle.
import type { GameEvent } from './commands.js';
// M9: a government's rate caps and its support numbers, read from the spec and from
// nowhere else. `rateCapProblem` composes `rateCapsOf` with M4b's own rule rather than
// restating a cap, and `freeUnitAllowance`/`unitSupport` below take their two magnitudes
// from `freeUnitsPerCity`/`unitSupportCost` — the M4b module constants that used to sit
// in this file are gone, and the comment where they were says why.
import {
  freeUnitsPerCity as governmentFreeUnitsPerCity,
  governmentOf,
  rateCapsOf,
  unitSupportCost as governmentUnitSupportCost,
} from './governments.js';
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
 * Tuning constants — and M9's move of two of them into the catalog
 * ------------------------------------------------------------------ */

/**
 * **M4b's per-city free support is gone from this module (M9).** It is
 * `GovernmentSpec.freeUnitsPerCity` now, read through `governments.ts`'
 * `freeUnitsPerCity(ruleset, player)`.
 *
 * The M4b comment that used to sit here said the quiet part out loud — "it is **not**
 * a Civ 3 figure, whose free support is a per-government number this engine does not
 * model" — and M9 is the milestone that makes the engine model it. Keeping a copy here
 * as well would be exactly the defect M6b had to retrofit for combat: a magnitude in
 * the catalog *and* a magnitude in logic, free to disagree, and a sweep that moved one
 * of them would measure nothing.
 */

/**
 * Units a civilization supports for free **before it owns any city** — the base term
 * of M4b's allowance formula, and the one part of it that is genuinely not a
 * government's business.
 *
 * It is deliberately **not** a catalog field, and that is a reading rather than an
 * omission. The contract's government row names two magnitudes — `freeUnitsPerCity` and
 * `unitSupportCost` — and this is neither: it is the floor that keeps a civilization
 * with no cities from paying for the units it starts with. A per-government base would
 * be a fourth number no contract names, and the sweep of a government's support rule is
 * already available through the per-city term (set it to 0 and the base is all that
 * remains).
 *
 * 4 is a **placeholder**: unsourced, chosen to be playable. A new game hands every
 * civilization a settler and a worker (M4b, "Starting units"), and 4 leaves room for a
 * scout and a defender too, so a player is never forced into bankruptcy — and never has
 * its starting units disbanded — before it has founded its first city and can earn
 * anything. It is not a sourced Civ 3 number.
 */
export const FREE_UNITS_BASE = 4;

/**
 * **M4b's per-unit support cost is gone from this module (M9)**, for the same reason
 * and with the same words as `FREE_UNITS_PER_CITY` above: it is
 * `GovernmentSpec.unitSupportCost` now, read through `governments.ts`'
 * `unitSupportCost(ruleset, player)`.
 */

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
 * The **government's** half of the rate rule, as a refusal: which slider is over this
 * player's cap, and by how much.
 *
 * A second function rather than a clause inside `ratesProblem`, because the two answer
 * different questions and a caller often wants only one of them. `ratesProblem` is "is
 * this a well-formed triple at all?" — a question about arithmetic that has one answer
 * for every player in the game and is asked by the command layer, the CLI and the UI.
 * This is "may *this player* set it?" — a question about a government, asked only where
 * a player's own sliders move. Folding the cap into `ratesProblem` would make the answer
 * to the first question depend on whose turn it is, which is exactly the kind of
 * coupling that makes two callers disagree.
 *
 * **Both are still one rule at the command site**: `planSetRates` below asks
 * `ratesProblem` and then this, and a refusal names the cap. The `SetRates` doc in
 * `commands.ts` states that the caps are a *conjunct* of M4b's rule rather than a
 * replacement for it, and this is the conjunct.
 *
 * A player this ruleset cannot resolve a government for is governed by
 * `governments.ts`' degenerate rule, whose caps are `RATE_TOTAL` — so an unresolvable
 * player is capped only by the total rule, which is what M4b did for everybody.
 */
export const rateCapProblem = (
  rates: Rates,
  player: PlayerState,
  ruleset: RulesetView,
): string | undefined => {
  const caps = rateCapsOf(ruleset, player);
  const parts: readonly (readonly [string, number, number])[] = [
    ['tax', rateField(rates, 'tax') ?? 0, caps.tax],
    ['science', rateField(rates, 'science') ?? 0, caps.science],
    ['luxury', rateField(rates, 'luxury') ?? 0, caps.luxury],
  ];

  for (const [name, value, cap] of parts) {
    if (value > cap) {
      return (
        `${name} is capped at ${String(cap)} by the ${governmentOf(ruleset, player).name} ` +
        `government (asked for ${String(value)})`
      );
    }
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
 * The units `playerId` may keep without paying: the **government's**
 * `freeUnitsPerCity` per city it owns, plus `FREE_UNITS_BASE` — M4b's formula, in the
 * one place it is written down, with M9's per-government term read from the spec.
 *
 * A city count read from `state.cities` by owner, so a player with no cities still has
 * its `FREE_UNITS_BASE`. The count is a whole number by construction (it is a length)
 * and the per-city term is a whole number by validation, so nothing here can produce a
 * fraction.
 *
 * This is the function `unitSupport` bills against **and** the one a UI asks to show
 * "you are supporting 3 of 6 units" — one formula, two askers, rather than a
 * presentation of the rule beside the rule.
 */
export const freeUnitAllowance = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): number => {
  const cities = state.cities.filter((city) => city.owner === playerId).length;
  const player = state.players.find((candidate) => candidate.id === playerId);
  // A player the state does not contain still has an allowance: the degenerate
  // government's per-city term, so the read is total for a caller that asked about a
  // stale id. `unit-owner-exists` in `@civts/sim` is what reports such a state.
  const perCity = player === undefined ? 2 : governmentFreeUnitsPerCity(ruleset, player);
  return perCity * cities + FREE_UNITS_BASE;
};

/** What a player's army costs this turn, and the counts behind the number. */
export interface UnitSupport {
  /** Every unit the player owns. */
  readonly units: number;
  /** How many of them are free (`freeUnitAllowance`). */
  readonly free: number;
  /** How many are over the allowance and therefore billable. */
  readonly supported: number;
  /** `supported * the player's government's `unitSupportCost``. */
  readonly gold: number;
}

/**
 * What `playerId`'s units cost in this state — the contract's rule: the first
 * `freeUnitAllowance` units are free, every unit beyond that costs
 * the player's government's `unitSupportCost` gold.
 *
 * Which units are "the free ones" is not stored and does not need to be: the cost
 * is uniform, so the bill depends only on the *count*. That is also what makes the
 * disband rule below well defined — removing any one supported unit saves exactly
 * one unit's cost.
 */
export const unitSupport = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): UnitSupport => {
  const units = ownedUnits(state, playerId).length;
  const free = freeUnitAllowance(state, ruleset, playerId);
  const supported = Math.max(0, units - free);
  const player = state.players.find((candidate) => candidate.id === playerId);
  const cost = player === undefined ? 1 : governmentUnitSupportCost(ruleset, player);
  return { units, free, supported, gold: supported * cost };
};

/**
 * What `playerId`'s buildings cost each turn: the sum of every owned city's
 * buildings' maintenance, in city-id order (the order of `state.cities`).
 *
 * The sum itself is `buildings.ts`' `playerMaintenance` — the module that owns what
 * a building costs — and this function is the money loop's thin, named entry point
 * to it, so `UpkeepPaid`'s `maintenance` and the buildings `disbandBuildings`
 * reasons about are the same number computed once. The catalog is resolved here
 * through `buildingCatalog`, the one place "a view with no buildings has none" is
 * decided.
 *
 * A building id the ruleset does not describe costs nothing — the same reading
 * `production.ts` gives an item it cannot price. Nothing is charged twice for the
 * same row in the same city: a city's `buildings` list is its own set (M3 refuses
 * to build one twice), and a hand-built duplicate is billed twice because it *is*
 * two entries; saying so is cheaper than inventing a de-duplication rule the state
 * shape does not have.
 */
export const buildingMaintenance = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): number => playerMaintenance(state, buildingCatalog(ruleset), playerId);

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
  const support = unitSupport(state, ruleset, playerId).gold;
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
 * - **M4c: the city's own library scales its beakers.** After the split, this
 *   city's summed `beaker-multiplier` percentage is applied to its **beaker
 *   channel** with one floor (`applyEffectPct`), so the library of a city raises
 *   that city's science and nothing else's — not the player's other cities, and not
 *   its gold or its luxuries. Beakers still do nothing until M5; a library makes an
 *   inert pool fill faster, which is stated rather than implied.
 * - **The commerce those beakers came from is already multiplied.** A
 *   `commerce-multiplier` (marketplace) is applied inside `cityYields`, because it
 *   scales *commerce* — which the rates then divide — rather than one channel. So a
 *   city with both a marketplace and a library multiplies twice on purpose, once
 *   per effect, each with its own single floor.
 * - **No building adds gold directly.** The contract's income line allows for
 *   "building/improvement gold effects"; M4c's effect union has none, so today this
 *   term is exactly the cities' gold share plus nothing. Stated here rather than
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
  const catalog = buildingCatalog(ruleset);

  let gold = 0;
  let beakers = 0;
  let luxuries = 0;

  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    const split = splitCommerce(cityYields(state, ruleset, city.id).commerce, rates);
    // This city's own buildings, and only this city's: `cityBuildingEffects` reads
    // `city.buildings`.
    const effects = cityBuildingEffects(catalog, city);
    gold += split.gold;
    beakers += applyEffectPct(split.beakers, effects.beakerPct);
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
 *    the government's `unitSupportCost`, the last capped at what remains), emitting
 *    `UnitDisbanded` per removal and `TreasuryShortfall` for whatever could not be
 *    covered. The treasury is exactly 0 afterwards — never negative — and the
 *    ledger identity in the module note holds to the gold. Whatever is still unpaid
 *    then costs the player **buildings** (M4c): `disbandBuildings` takes the most
 *    recently completed ones, a wonder included, until their maintenance covers the
 *    unpaid amount. That loss changes the state without a ledger line of its own —
 *    see the *known gap* below.
 *
 * **Known gap, stated rather than implied.** Losing buildings is visible in the
 * state (`city.buildings` shrinks) and in the next turn's `UpkeepPaid.maintenance`,
 * but it emits **no event of its own**: `GameEvent` is declared in `commands.ts`
 * and has no building-loss member, and adding one is a change to a frozen union
 * this module does not own. The contract's own words for the branch are
 * `UnitDisbanded` plus `TreasuryShortfall`, both of which are emitted exactly as
 * before, so nothing here is *mis*-reported; what is missing is a line a reader of
 * the stream alone could use. Recorded as M4c debt in the report rather than
 * papered over, and the `BuildingLoss` list `disbandBuildings` returns is the shape
 * such an event would carry.
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
    const support = unitSupport(current, ruleset, player.id);

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
    // M9: one unit's cost is the *government's* — `unitSupportCost` — not M4b's
    // constant. Read once, outside the loop, because a disband never changes a
    // player's government: the number is the same on every iteration and a second
    // read inside would be a second place the two could differ.
    const perUnit = governmentUnitSupportCost(ruleset, player);

    while (covered < shortfall) {
      if (unitSupport(current, ruleset, player.id).supported <= 0) break;
      const victim = highestIdUnit(current, player.id);
      if (victim === undefined) break;

      const saved = Math.min(perUnit, shortfall - covered);
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

      // M4c: the bill it could not pay also costs it the buildings that ran it up.
      // A building that bills gold every turn is a building a broke civilization
      // cannot keep, and this is the *only* place anything is ever destroyed in
      // M4c — which is what makes INTERFACES.md's "a bankrupted wonder becomes
      // buildable again" reachable at all, since nothing else removes a building
      // from `city.buildings`.
      //
      // `buildings.ts`' `disbandBuildings` owns *which* buildings go (most recently
      // completed first, zero-maintenance rows skipped, until their combined
      // maintenance covers `unpaid`) and why. The gold is deliberately **not**
      // credited to `covered`: see the module note's ledger identity, and
      // `disbandBuildings`' own note for why crediting it would make
      // `TreasuryShortfall` — the branch M4c exists to make reachable —
      // unreachable again.
      current = disbandBuildings(current, buildingCatalog(ruleset), player.id, unpaid).state;
    }
  }

  return { state: current, events };
};
