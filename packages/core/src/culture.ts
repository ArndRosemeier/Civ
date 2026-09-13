/**
 * Culture — what a city accumulates, what a wonder grants on completion, and the
 * player total that is *derived* from its cities.
 * See docs/INTERFACES.md M9 ("Culture"), PLAN.md §5.3 (determinism) and §5.4 (data
 * layout).
 *
 * ## The one rule this module exists to keep
 *
 * > `City` gains `culture: number` (accumulated, integer, never decreases). The
 * > player's total is DERIVED by summing their cities — never stored separately,
 * > because two numbers that must agree are two numbers that will disagree (the M2
 * > provenance-summary lesson).
 *
 * So there is no `PlayerState.culture` field anywhere in this codebase, and
 * `playerCulture` below is the only way to ask the question. The ownership layer
 * (`borders.ts`) reads a *city's* culture, the score reads the *player* total through
 * this function, and the victory rule reads it through this function too — three
 * readers, one addition, and nothing to drift.
 *
 * ## When culture is accumulated, and why then
 *
 * The contract fixes the position in the turn pipeline:
 *
 * > Culture accumulates as a pipeline step AFTER production and BEFORE research, so a
 * > temple finished this turn contributes this turn (the M4c rule).
 *
 * `turn.ts` calls `applyCulture` between production and research and says so there.
 * The M4c rule is the reason: an effect finished this turn applies this turn, which
 * is why growth and production run *after* work, why research runs after production,
 * and — one step later in the same direction — why culture runs before research. A
 * culture-producing building completed this turn banks its first culture this turn.
 *
 * ## The magnitudes
 *
 * `BuildingSpec.culturePerTurn` (a per-turn integer) and `BuildingSpec.cultureBonus`
 * (a one-off, wonders only) are catalog rows, `placeholder(...)`, and both are
 * reachable through `RulesetPatch.buildings`. `validateRuleset` requires
 * `culturePerTurn` on every row and refuses a `cultureBonus` on a non-wonder, so a
 * row cannot quietly declare a one-off on an ordinary building. This module owns
 * **no number of its own**: it sums what the rows declare.
 *
 * ## Determinism
 *
 * Integers only, cities visited in ascending city-id order — which makes the event
 * stream a function of the state rather than of how `cities` happens to be stored,
 * exactly as `growth.ts` and `production.ts` state for their own passes. No RNG, no
 * clock, no ambient state.
 */

import { buildingCatalog, cityById, type City } from './cities.js';
import { buildingRow } from './buildings.js';
import type { GameEvent } from './commands.js';
import type { BuildingId, CityId, PlayerId } from './ids.js';
import type { RulesetView } from './map.js';
import type { GameState } from './state.js';

/**
 * A city's culture as a whole number, read **totally**: a value this engine cannot
 * read (missing, fractional, negative, `NaN`) is read as `0`.
 *
 * The same reading `economy.ts`' `wholeNumber` takes of a treasury and `units.ts`
 * takes of a movement budget, and for the same reason: a hand-built state, an older
 * save loaded through JSON or a foreign object can carry anything, and letting it
 * reach the sum would put a `NaN` into a score and then into a state hash that
 * `canonicalize` refuses. Culture "never decreases" is a property of the rules; a
 * corrupt field is a fact about the save, and 0 is the honest total for it.
 */
export const wholeCulture = (culture: number): number =>
  Number.isInteger(culture) && culture > 0 ? culture : 0;

/**
 * **A player's total culture** — the sum of its cities' culture, and the only
 * statement of it.
 *
 * A civilization with no cities has 0 culture, and so does a player the state does not
 * contain: both are the honest answer for a read with no failure channel. Barbarians
 * are not special-cased, because they are not special here — a barbarian city (from a
 * capture) accumulates culture like any other, and `victory.ts` is where "barbarians
 * never win" is enforced, once, rather than twice.
 *
 * The sum is over `state.cities` filtered by owner, so it is O(cities) and does not
 * depend on iteration order: addition of integers is commutative and exact.
 *
 * **The reading this deliberately is not.** "A civilization's lifetime culture" —
 * including the culture of cities it founded and later lost — is a real concept in the
 * games this one is shaped after, and it would be the natural thing to *store*
 * instead. The contract picks the sum of the cities a player holds **now**, and the
 * difference is not academic: a captured city keeps its culture (`cities.ts`'
 * `captureCity`), so a lifetime total would be a second number that diverges from this
 * one the moment a city changes hands — precisely the "two numbers that must agree"
 * failure the contract's own sentence is about. So the victory threshold is measured
 * against what a player holds now, and there is no other total in the engine for it to
 * disagree with.
 */
export const playerCulture = (state: GameState, playerId: PlayerId): number => {
  let total = 0;
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    total += wholeCulture(city.culture);
  }
  return total;
};

/**
 * The culture `id`'s row grants **per turn**, or `0` when this ruleset does not
 * describe it or its value cannot be read.
 *
 * One read, so the culture step cannot price a building differently from a UI panel
 * that shows "this temple earns +2 culture". A row whose `culturePerTurn` is absent
 * (a view from before M9, a hand-built fixture) grants nothing, which is the
 * "declares nothing" reading `buildings.ts` takes of every other optional magnitude.
 */
export const culturePerTurnOf = (ruleset: RulesetView, id: BuildingId): number => {
  const row = buildingRow(buildingCatalog(ruleset), id);
  if (row === undefined) return 0;
  const declared: unknown = row.culturePerTurn;
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : 0;
};

/**
 * The culture a **wonder's completion** grants, once — `BuildingSpec.cultureBonus`, or
 * `0` when this ruleset describes none.
 *
 * Read by `production.ts` at the moment a building joins a city, and applied through
 * `withCultureGain` below so the one-off and the per-turn accumulation write a city's
 * culture the same way. `validateRuleset` refuses a `cultureBonus` on a row that is not
 * a wonder, so "a one-off on completion" cannot quietly become a per-building bonus;
 * this read stays total for a view that never went through validation.
 */
export const cultureBonusOf = (ruleset: RulesetView, id: BuildingId): number => {
  const row = buildingRow(buildingCatalog(ruleset), id);
  if (row === undefined) return 0;
  const declared: unknown = row.cultureBonus;
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : 0;
};

/** `state` with `city`'s culture raised by `gain` (a negative or unreadable gain is a no-op). */
const withCultureGain = (state: GameState, cityId: CityId, gain: number): GameState => {
  if (!Number.isInteger(gain) || gain <= 0) return state;
  const city = cityById(state, cityId);
  if (city === undefined) return state;

  const raised: City = { ...city, culture: wholeCulture(city.culture) + gain };
  return {
    ...state,
    cities: state.cities.map((existing) => (existing.id === cityId ? raised : existing)),
  };
};

/**
 * `state` with `cityId`'s culture raised by `gain` — the **only writer of
 * `City.culture`**, alongside `FoundCity`'s initial `0`.
 *
 * Exported because `production.ts` needs the wonder's one-off at the moment of
 * completion, and a second `culture: city.culture + bonus` written there would be the
 * "one rule, two places" defect this module exists to avoid. A gain this engine cannot
 * read (fractional, negative, `NaN`) is **no gain**, so a foreign catalog row cannot
 * drive a city's culture down — the contract says culture "never decreases", and the
 * one place that could break that promise is a bonus read out of content.
 */
export const withCultureBonus = (state: GameState, cityId: CityId, gain: number): GameState =>
  withCultureGain(state, cityId, gain);

/**
 * `state` with `id`'s **completion bonus** applied to `cityId`'s culture — the read and
 * the write in one call, so no caller can apply an amount it read from a different row.
 *
 * `production.ts` is the only caller, and it exists rather than letting that caller pair
 * `cultureBonusOf` with `withCultureBonus` itself: the pair *is* the rule ("a wonder
 * grants its row's bonus on completion"), and a pair a caller can get half right is a
 * rule with two halves in two places. The returned `applied` is what the event reports,
 * so the event and the state cannot disagree about the amount.
 */
export const applyCompletionBonus = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
  id: BuildingId,
): { readonly state: GameState; readonly applied: number } => {
  const bonus = cultureBonusOf(ruleset, id);
  if (bonus <= 0) return { state, applied: 0 };
  return { state: withCultureGain(state, cityId, bonus), applied: bonus };
};

/** What one culture pass did: the state after it, and what happened to each city. */
export interface CultureOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** Every city id in the state, ascending — the order this pass runs in. */
const cityIdsInOrder = (state: GameState): readonly CityId[] =>
  [...state.cities].map((city) => city.id).sort((a, b) => Number(a) - Number(b));

/**
 * Apply one turn of culture to **every** city, in city-id order.
 *
 * Per city: `culture += sum of its own buildings' culturePerTurn`, and one
 * `CityCultureGrew` event **when the gain is positive**. A city with no
 * culture-producing building gains nothing and emits nothing, on the M4a precedent
 * ("there is deliberately no `WorkProgressed` event: a job losing a turn is visible in
 * the state") — a per-city zero line every turn would be a line that says nothing new,
 * whereas the money loop's zero lines are the *ledger* the M4b evidence is checked
 * against and are there for exactly that reason. Culture has no ledger identity to
 * check, so the event marks the cities that moved.
 *
 * **A city in civil disorder still accumulates culture.** That is a reading stated
 * rather than an oversight, because the contract lists exactly what disorder stops —
 * "shields, beakers, gold, growth food" — and culture is not on the list. A city in
 * revolt is not producing; it is still living somewhere, and its temples still stand.
 * If a later wave wants rioting to halt cultural growth, this is the one line to
 * change and `m9-m10-adversarial.test.ts` pins the current reading by number.
 *
 * The input state is never modified: each city's change builds a new state for the
 * next city to read.
 */
export const applyCulture = (state: GameState, ruleset: RulesetView): CultureOutcome => {
  let current = state;
  const events: GameEvent[] = [];
  const catalog = buildingCatalog(ruleset);

  for (const cityId of cityIdsInOrder(state)) {
    const city = cityById(current, cityId);
    if (city === undefined) continue;

    let gain = 0;
    for (const id of city.buildings) {
      const row = buildingRow(catalog, id);
      const declared: unknown = row?.culturePerTurn;
      if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) {
        gain += declared;
      }
    }

    if (gain <= 0) continue;
    current = withCultureGain(current, cityId, gain);
    events.push({ type: 'CityCultureGrew', cityId, owner: city.owner, gain });
  }

  return { state: current, events };
};
