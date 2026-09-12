/**
 * Buildings — what a building does to the city that holds it, what it costs its
 * owner to keep, and the one rule that makes a wonder unique.
 * See docs/INTERFACES.md M4c ("Building maintenance and effects", "Wonders v1"),
 * PLAN.md §5.3 (determinism) and §5.4 (data layout).
 *
 * The frozen contract, in full:
 *
 * - `BuildingSpec` carries a required `maintenance` (gold per turn, integer
 *   `>= 0`), a required `effects` list and an optional `wonder: true`.
 * - The effect union is closed: `commerce-multiplier` (marketplace),
 *   `beaker-multiplier` (library), `shield-multiplier` (factory) and
 *   `growth-food` (granary). Multipliers are **integer percentages applied with a
 *   floor**.
 * - **Effects apply only to the city that holds the building** and to no other
 *   city, of the same owner or otherwise.
 * - Several multipliers of the same kind in one city **compound by summing the
 *   percentages first and flooring once**.
 * - `growth-food` reduces the food a city needs to grow, **floored at a minimum of
 *   1**.
 * - A wonder is a building with `wonder: true`: **globally unique** — once any
 *   city anywhere holds it, no other city may start it — and never rebuilt,
 *   because M4c has no destruction. "Unique" and "never rebuilt" are therefore the
 *   *same* rule here, and this module says so rather than implying a demolition
 *   mechanic it does not have. The one way a wonder is lost is bankruptcy, which
 *   takes the buildings a player can no longer pay for; after that it is buildable
 *   again, and that is the only reading under which "never rebuilt" and "unique"
 *   can come apart at all.
 *
 * Design notes:
 *
 * - **This is the one place an effect is computed.** `cityBuildingEffects` turns a
 *   city's `buildings` list into four running totals, `applyEffectPct` is the only
 *   place a percentage is applied to a number, and `growthFoodNeeded` is the only
 *   place the granary's reduction is computed. `cities.ts` (commerce and shields),
 *   `economy.ts` (beakers) and whatever consumes the growth reduction all *ask*
 *   this module instead of re-reading `effects` themselves — the M2 lesson about
 *   two writers of the explored layer, applied to a different layer. A second
 *   reader would be free to disagree about the sum-first rule, and "free to
 *   disagree" is how a milestone gets two answers to one question.
 * - **The percentages are summed *first* and floored *once*, loudly.** Two 25%
 *   commerce multipliers on 3 commerce give `floor(3 * 150 / 100) = 4`; applying
 *   them one after the other floors twice and gives
 *   `floor(floor(3 * 125 / 100) * 125 / 100) = floor(3 * 1.25) = 3`. The two
 *   readings genuinely differ — not always, which is what makes the bug easy to
 *   introduce and hard to notice — so which one the engine implements is
 *   observable in a state hash. Summing first is the contract's rule, `effectTotals`
 *   below is where it is implemented, and `applyEffectPct` is the single floor.
 * - **`growth-food` cannot make a city unable to grow.** The reduced requirement
 *   floors at `MIN_GROWTH_FOOD`, so a granary can never drive the threshold to zero
 *   — a city would otherwise grow without bound inside one turn's growth loop —
 *   and a consumer that divides by it cannot divide by zero.
 * - **The catalog is a parameter, not a `RulesetView`.** Every function below takes
 *   the building rows (`buildingCatalog(ruleset)`, the one place "a view with no
 *   buildings has none" is decided) rather than the whole view, because
 *   `cities.ts` imports this module for the effect totals: taking the view here
 *   would mean reading `RulesetView.buildings` in two places *and* a two-way
 *   runtime import between the two modules. The building *lookup* used throughout
 *   is `buildingRow`, which `cities.ts`' buildingDef delegates to, so "find the row
 *   with this id" is stated once as well.
 * - **A row this engine cannot read declares nothing.** `validateRuleset` refuses a
 *   negative, fractional or unknown effect, and the shipped `BuildingSpec` requires
 *   every field; the guards in `effectTotals` and `maintenanceOf` are for a row
 *   that did *not* come through validation (a hand-built view, a foreign ruleset, a
 *   JSON round trip). Such a row is read as declaring nothing rather than being
 *   allowed to write a negative or fractional number into a city's output — the
 *   same reading `economy.ts` takes of a maintenance it cannot read and
 *   `production.ts` of a cost it cannot price.
 * - **M5: a building row that declares `requiresTech` is gated elsewhere, and
 *   deliberately not here.** `mayStartBuilding` below answers the M4c question this
 *   module owns — "is this row unique in the world, and does this city lack it?" —
 *   and adding a tech test to it would be a second implementation of a question
 *   `resources.ts`' `productionGate` already answers for every kind of item, free to
 *   disagree with the menu and the completion pass that ask *that*. A tech-gated
 *   building is refused by both of them (and, once the owed wiring lands, by
 *   `commands.ts`' `planSetProduction`); nothing here reads the field, which is also
 *   why no row below claims it.
 * - **Every number this module adds is a placeholder of ours.** `MIN_GROWTH_FOOD`
 *   is the only constant here, and it is unsourced and chosen to be playable — see
 *   its own note. The magnitudes of the effects (`pct`, `amount`) are *content*,
 *   declared by `@civts/rules` rows that are `placeholder(...)`; nothing here is
 *   presented as Civ 3's, and no Civ 3 building effect is claimed to be reproduced.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O, and no floating-point
 * arithmetic beyond the `Math.floor` of an integer-percentage scaling. Every
 * function is a pure read of the state, the catalog or both.
 */

import type { BuildingDef, City } from './cities.js';
import type { BuildingId, CityId, PlayerId } from './ids.js';
import type { BuildingEffect } from './map.js';
import type { GameState } from './state.js';

/* ------------------------------------------------------------------ *
 * The catalog read
 * ------------------------------------------------------------------ */

/**
 * The building row `id` names in `catalog`, or `undefined` when the catalog does
 * not describe it — the engine's **one** "find the row with this id" read.
 *
 * `cities.ts`' `buildingDef` delegates here (it adds nothing but the
 * `buildingCatalog(ruleset)` call that resolves a view to rows), so a caller with
 * a catalog in hand and a caller with a ruleset view cannot disagree about what a
 * lookup means — including the two answers that matter: a row is found, or it is
 * not, and "not found" is `undefined` rather than a default row.
 */
export const buildingRow = (
  catalog: readonly BuildingDef[],
  id: BuildingId,
): BuildingDef | undefined => catalog.find((def) => def.id === id);

/* ------------------------------------------------------------------ *
 * Effect totals — summed percentages, floored once
 * ------------------------------------------------------------------ */

/**
 * What a set of buildings does to the city that holds them, as **totals** rather
 * than as numbers already applied:
 *
 * - `commercePct` / `beakerPct` / `shieldPct` are the summed integer percentages
 *   of every multiplier of that kind. They are *not* floored here — the floor
 *   happens once, in `applyEffectPct`, after every contribution is in.
 * - `growthFood` is the summed `amount` of every `growth-food` effect: the food the
 *   city's growth requirement is reduced by (`growthFoodNeeded`).
 *
 * Keeping the totals separate from their application is what makes the
 * sum-first-floor-once rule mechanical rather than a habit: there is no floor to
 * accidentally apply early, because this type has no floor in it at all.
 */
export interface BuildingEffects {
  readonly commercePct: number;
  readonly beakerPct: number;
  readonly shieldPct: number;
  readonly growthFood: number;
}

/** What a city with no buildings — or with buildings that declare nothing — has. */
export const NO_BUILDING_EFFECTS: BuildingEffects = {
  commercePct: 0,
  beakerPct: 0,
  shieldPct: 0,
  growthFood: 0,
};

/**
 * A whole, strictly positive number, or 0.
 *
 * `validateRuleset` refuses a negative or fractional `pct`/`amount`, so this guard
 * exists for the row that did not come through validation. A percentage of 0 and a
 * percentage this engine cannot read are the same thing to a multiplier — no bonus
 * — and reading it that way is what keeps a `NaN` or a negative out of a city's
 * yields, which are part of every state hash.
 */
const positiveWhole = (value: number): number => (Number.isInteger(value) && value > 0 ? value : 0);

/**
 * Whether `value` is something this module can read as a list of effects.
 *
 * M4c made `BuildingDef.effects` a required field, so a row that has none at all is
 * a compile error at every *typed* construction site — but it is not impossible at
 * runtime: a hand-built view, a foreign catalog, or a ruleset row written before
 * M4c all reach these reads as plain objects. The engine's answer to such a row is
 * "no effects" rather than an exception thrown from inside `cityYields`, which would
 * surface as a crash in the middle of a turn (see `cityBuildingEffects`).
 */
const isEffectList = (value: unknown): value is readonly BuildingEffect[] => Array.isArray(value);

/**
 * Every effect in `effects`, summed per kind — the **one** implementation of the
 * compound rule.
 *
 * **Sum first, floor once.** The returned percentages are plain sums of integer
 * percentages; nothing here floors, and `applyEffectPct` floors the result exactly
 * once. Breaking the sum apart into per-building applications would silently
 * implement the *other* reading of the contract, which gives different numbers (see
 * the module note for a worked example) and therefore a different state hash.
 *
 * An effect whose kind this engine does not know contributes nothing: the switch
 * below matches the four kinds of the closed union, and a foreign row carrying a
 * fifth falls through rather than throwing. An effect whose value is fractional or
 * negative contributes nothing, for the reason `positiveWhole` states.
 */
export const effectTotals = (effects: readonly BuildingEffect[]): BuildingEffects => {
  let commercePct = 0;
  let beakerPct = 0;
  let shieldPct = 0;
  let growthFood = 0;

  for (const effect of effects) {
    switch (effect.kind) {
      case 'commerce-multiplier':
        commercePct += positiveWhole(effect.pct);
        break;
      case 'beaker-multiplier':
        beakerPct += positiveWhole(effect.pct);
        break;
      case 'shield-multiplier':
        shieldPct += positiveWhole(effect.pct);
        break;
      case 'growth-food':
        growthFood += positiveWhole(effect.amount);
        break;
    }
  }

  return { commercePct, beakerPct, shieldPct, growthFood };
};

/**
 * The totals for **one city**: every effect of every building that city holds, and
 * nothing from any other city.
 *
 * This is the whole of "effects apply only to their own city". The list read is
 * `city.buildings` — the state's own record of what was built here — so a building
 * another city holds, a building the ruleset describes but nobody built, and a
 * building the same *player* holds elsewhere all contribute exactly nothing. A
 * building id the catalog does not describe is skipped, the same reading
 * `playerMaintenance` takes and `production.ts` takes of an item it cannot price.
 *
 * `city.buildings` may legitimately list several buildings, including several with
 * the same kind of multiplier; `effectTotals` above is what makes that sum once.
 *
 * Total on a row this engine cannot read: a `def` whose `effects` is not an array at
 * all (a hand-built view, a foreign catalog, a row from before M4c) contributes no
 * effects rather than throwing inside `cityYields`. Required fields make that
 * unreachable through the typechecker, which is exactly why the read is written to
 * survive it: the alternative is a ruleset defect surfacing as a crash in the middle
 * of a turn rather than as a city with no bonus. The same reading `maintenanceOf`
 * takes of a `maintenance` that is not a count.
 */
export const cityBuildingEffects = (
  catalog: readonly BuildingDef[],
  city: City,
): BuildingEffects => {
  const effects: BuildingEffect[] = [];
  for (const id of city.buildings) {
    const def = buildingRow(catalog, id);
    if (def === undefined) continue;
    // A type predicate rather than `Array.isArray` inline: the latter narrows to
    // `any[]`, which would put an unchecked value into the city's totals and is
    // refused by this project's lint. The read is the same one; only the narrowing
    // is stated as the project states it elsewhere.
    const declared: unknown = def.effects;
    if (isEffectList(declared)) effects.push(...declared);
  }
  return effectTotals(effects);
};

/**
 * `value` with `pct` percent added — `floor(value * (100 + pct) / 100)` — the
 * **one** place an integer percentage is applied to a number in this engine.
 *
 * Integer arithmetic throughout: the product and the division are exact in
 * IEEE-754 for every value this engine can hold (a city's commerce, shields or
 * beakers are small integers), and `Math.floor` of that division is the contract's
 * floor. Applying the multipliers of a city therefore happens in three places —
 * commerce and shields in `cities.ts`, beakers in `economy.ts` — but with one
 * implementation, so none of them can round differently.
 *
 * Total, because the caller may be holding a state that did not come from this
 * build:
 *
 * - a value that is not a finite positive number scales to 0, the honest answer for
 *   a hand-built city whose yields are `NaN` or negative — a scaled negative would
 *   be a yield no city can produce;
 * - a `pct` that is missing, fractional or negative is read as no bonus rather than
 *   as a fractional or negative multiplier, exactly as `effectTotals` reads one.
 *
 * The result is always a non-negative whole number for a finite input, which is
 * what keeps a multiplier from putting a fraction into a hashed yield.
 */
export const applyEffectPct = (value: number, pct: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const bonus = Number.isInteger(pct) && pct > 0 ? pct : 0;
  return Math.floor((value * (100 + bonus)) / 100);
};

/* ------------------------------------------------------------------ *
 * Growth food — the granary
 * ------------------------------------------------------------------ */

/**
 * The least food a city can need to grow. 1 is a **placeholder**: it is unsourced
 * and chosen to be playable — every city must be able to grow *eventually*, so no
 * combination of buildings can make the requirement unreachable — and it is **not**
 * a Civ 3 figure. Civ 3's granary keeps a food reserve rather than shrinking the
 * growth requirement, so this is this engine's own placeholder reading of the
 * `growth-food` effect and no Civ 3 number is being reproduced.
 *
 * It is also the reason a consumer dividing by the requirement cannot divide by
 * zero: the threshold is never 0.
 */
export const MIN_GROWTH_FOOD = 1;

/**
 * The food a city must accumulate to grow, after its `growth-food` effects:
 * `max(MIN_GROWTH_FOOD, needed - growthFood)`.
 *
 * `needed` is the caller's own box size for that city's population (`growth.ts`'
 * `foodBoxSize(population)`), which this module deliberately does not import: the
 * growth curve is `growth.ts`' business, and composing the two here would make this
 * module a second statement of the threshold formula. What this function owns is
 * the *reduction* and its floor.
 *
 * A `needed` that is not a finite number is read as the floor, and the result is
 * floored like every other threshold in this engine, so the answer is always a
 * whole number >= `MIN_GROWTH_FOOD`.
 */
export const growthFoodNeeded = (needed: number, effects: BuildingEffects): number => {
  const base = Number.isFinite(needed) ? Math.floor(needed) : MIN_GROWTH_FOOD;
  return Math.max(MIN_GROWTH_FOOD, base - Math.max(0, effects.growthFood));
};

/**
 * The composition a caller with a city's *population* in hand wants:
 * `growthFoodNeeded(needed, cityBuildingEffects(catalog, city))`.
 *
 * It adds no rule of its own — it is the pair above, in the order they must be
 * applied — and it exists so the growth path has one call to make for one city
 * rather than two lines that a later reader could put in the other order.
 *
 * **Who has to call it.** Three of M4c's four effect kinds are already applied inside
 * the reads that own them (`commerce-multiplier` and `shield-multiplier` in
 * `cities.ts`' `cityYields`, `beaker-multiplier` in `economy.ts`' `playerIncome`),
 * because in each case the effect scales a number that read already computes. Growth
 * food is the exception: the threshold is *not* a yield, it is
 * `growth.ts`' `foodBoxSize(population)`, which lives in a module this one does not
 * own.
 *
 * **`applyGrowth` calls it** (M4c's growth-food wiring, the fix to a contract
 * violation this module had recorded rather than implied: while the threshold was the
 * bare `foodBoxSize(population)`, the granary and the Pyramids were declared, read,
 * validated and applied to nothing). `growth.ts` composes this function with its own
 * curve, `repl.ts` asks it for the threshold it prints, and the M4c acceptance
 * evidence for it is `packages/core/test/growth.test.ts` plus section 2b of
 * `packages/testing/test/m4c-adversarial.test.ts` — the second of which fails if this
 * function stops being consulted.
 */
export const cityGrowthTarget = (
  catalog: readonly BuildingDef[],
  city: City,
  needed: number,
): number => growthFoodNeeded(needed, cityBuildingEffects(catalog, city));

/* ------------------------------------------------------------------ *
 * Maintenance — what a building costs to keep
 * ------------------------------------------------------------------ */

/**
 * The gold `def` costs its owner each turn: its declared `maintenance`, or 0 when
 * the row declares none this engine can read.
 *
 * `validateRuleset` requires an integer `>= 0`, and the shipped `BuildingSpec`
 * requires the field, so on every row that came through validation this is simply
 * `def.maintenance`. The read is deliberately **total** anyway, for the row that
 * did not: a missing field, a fraction, a negative number or a string all mean
 * "this row declares no maintenance", never a fractional or negative bill. M4b read
 * the same field structurally and for the same reason; this is that read, moved to
 * the module that owns what a building costs.
 *
 * The widening to `unknown` is what makes it a check rather than a comparison the
 * typechecker (rightly) calls unnecessary: the parameter's type says `number`, and
 * the whole point is that a foreign or older row may not obey it.
 */
export const maintenanceOf = (def: BuildingDef): number => {
  const declared: unknown = def.maintenance;
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : 0;
};

/**
 * What one city's buildings cost each turn, in the order of `city.buildings`.
 *
 * Nothing is de-duplicated: M3 refuses to build one building twice in a city, and a
 * hand-built duplicate is billed twice because it *is* two entries — saying so is
 * cheaper than inventing a de-duplication rule the state shape does not have. A row
 * the catalog does not describe costs nothing.
 */
export const cityMaintenance = (catalog: readonly BuildingDef[], city: City): number => {
  let total = 0;
  for (const id of city.buildings) {
    const def = buildingRow(catalog, id);
    if (def === undefined) continue;
    total += maintenanceOf(def);
  }
  return total;
};

/**
 * What every city of `playerId` costs to keep, summed in `state.cities` order (a
 * city the player does not own contributes nothing).
 *
 * The money loop's `buildingMaintenance` delegates here, so the sum a player's
 * upkeep is charged has exactly one implementation — the number a player sees in
 * `UpkeepPaid` cannot drift from the number `disbandBuildings` reasons about.
 */
export const playerMaintenance = (
  state: GameState,
  catalog: readonly BuildingDef[],
  playerId: PlayerId,
): number => {
  let total = 0;
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    total += cityMaintenance(catalog, city);
  }
  return total;
};

/* ------------------------------------------------------------------ *
 * Wonders — globally unique, and the only way one is lost
 * ------------------------------------------------------------------ */

/**
 * Is this row a **wonder**? The key is present and `true`, or it is absent — a
 * `false` is not how this project spells "not a wonder", and `validateRuleset`
 * rejects one (M4c: "optional `wonder: true`").
 */
export const isWonder = (def: BuildingDef): boolean => def.wonder === true;

/**
 * The city that holds `id`, **anywhere in the world**, or `undefined` when no city
 * does. The whole-map read the wonder rule is stated in terms of.
 *
 * A linear scan of `state.cities` rather than anything cleverer, for the reason
 * `cityById` gives: city counts are small by design, and a scan stays correct if
 * the "sorted by id" invariant is ever violated. `state.cities` order is the
 * answer's order, so the *first* holder is a deterministic city rather than
 * whichever one a map iteration happened to reach.
 */
export const buildingHolder = (state: GameState, id: BuildingId): City | undefined =>
  state.cities.find((city) => city.buildings.includes(id));

/**
 * May `city` **start** building `id`? The one statement of the rule the planner
 * (`SetProduction`), the REPL's option list and `production.ts`' completion path
 * all apply:
 *
 * 1. the catalog must describe the row at all — an id nothing describes is not
 *    something a city can be told to build;
 * 2. the city must not already hold it (M3: building one twice is a typed refusal,
 *    never a silent no-op);
 * 3. a **wonder** must not be held by *any* city anywhere. Since step 2 has already
 *    ruled out this city, any holder at all is another city — which is exactly
 *    M4c's "once ANY city anywhere holds it, no other city may start it".
 *
 * Step 3 is also the whole of "never rebuilt": with no destruction in M4c, a wonder
 * that is lost (by bankruptcy — see `disbandBuildings`) leaves `city.buildings`
 * everywhere, and this test stops finding a holder, so the row becomes startable
 * again. There is deliberately no separate "was it ever built" record: one would be
 * a second answer to the same question, and M4c's contract says outright that
 * uniqueness and "never rebuilt" are the same rule here rather than two.
 */
export const mayStartBuilding = (
  state: GameState,
  catalog: readonly BuildingDef[],
  city: City,
  id: BuildingId,
): boolean => {
  const def = buildingRow(catalog, id);
  if (def === undefined) return false;
  if (city.buildings.includes(id)) return false;
  return !isWonder(def) || buildingHolder(state, id) === undefined;
};

/**
 * The building rows `city` may start **as far as a ruleset-free reading can tell**,
 * in catalog order: the set `mayStartBuilding` accepts — the row is described, the
 * city does not already hold it, and no city anywhere holds a wonder of that id.
 *
 * **This is not the production menu, and it is not "what the applier accepts".** It
 * has no `RulesetView`, so it cannot see either gating dimension: an unmet
 * `requiresTech` and an unconnected `requiresResource` are asked of
 * `resources.ts`' `productionGate`, which is the one verdict the planner
 * (`SetProduction`), the completion pass and the menu all ask. `actions.ts`'
 * `cityProductionOptions` is the menu, and it filters these rows through that gate
 * — so a row can be *startable* here and absent there, which is exactly the case
 * M6 made reachable by giving a shipped building (the temple, on Ceremonial Burial)
 * a tech requirement. Use this reader for the questions it can answer — "is this
 * row described, unheld, and not another city's wonder?" — and the gate for the
 * ones it cannot. (Its doc comment used to claim it *was* the menu and could never
 * disagree with the applier; M4c's `requiresResource` for units and M6's
 * `requiresTech` for buildings each made that false, and the `m4c-adversarial`
 * keystone sweep asserts the corrected equivalence.)
 *
 * Built by filtering the catalog through `mayStartBuilding` rather than restating
 * its checks, and in catalog order (data order): the ruleset's own editorial order,
 * identical on every run, and not a property of this filter.
 */
export const availableBuildings = (
  state: GameState,
  catalog: readonly BuildingDef[],
  city: City,
): readonly BuildingDef[] =>
  catalog.filter((def) => mayStartBuilding(state, catalog, city, def.id));

/* ------------------------------------------------------------------ *
 * Losing a building — the one destruction in M4c
 * ------------------------------------------------------------------ */

/** One building a player lost, and the maintenance it was paying for it. */
export interface BuildingLoss {
  /** The city it stood in. */
  readonly cityId: CityId;
  /** What was lost. */
  readonly building: BuildingId;
  /** The gold per turn it was costing, which the player no longer owes. */
  readonly maintenance: number;
}

/** What `disbandBuildings` did: the state after it, and every building it took. */
export interface BuildingLossOutcome {
  readonly state: GameState;
  /** Empty when there was nothing to take. */
  readonly lost: readonly BuildingLoss[];
}

/**
 * `state` without the buildings `playerId` can no longer pay for, plus the list of
 * what was taken.
 *
 * **This is the one way a building is ever lost in M4c** (INTERFACES.md M4c,
 * "Wonders v1": "A wonder costs maintenance like any other building, so bankruptcy
 * can disband it; if that happens it becomes buildable again. That is the one way a
 * wonder is lost"). It exists because a building that costs gold every turn is a
 * building a broke civilization cannot keep, and `economy.ts` calls it for exactly
 * that reason — from the bankruptcy branch, once unit disbanding has taken
 * everything the army could pay with. A wonder is not special-cased anywhere here:
 * it is a row in `city.buildings` like any other, which is why losing one and
 * finding it startable again are the same event seen from two sides.
 *
 * The choice of *which* buildings, stated once and deterministic:
 *
 * - cities in **descending id order**, and within a city the buildings list **from
 *   the end**: the most recently completed goes first. That is the reading
 *   `economy.ts`' bankruptcy takes of units ("the highest-id unit goes first"), and
 *   the state's `buildings` array is append-ordered, so "most recent" is a fact
 *   about the state rather than a guess;
 * - a building whose maintenance is unreadable or zero is **skipped**: losing it
 *   would take an asset and buy nothing, exactly as disbanding a *free* unit would
 *   (M4b states that rule for units);
 * - buildings are taken **until the maintenance they were costing covers
 *   `amount`**, so the amount a player sheds is the amount it failed to pay. The
 *   last one may overshoot, which is the documented reading of "until it is
 *   covered"; a partial building is not a thing.
 *
 * Pure, and total on `amount`: a non-integer, zero or negative `amount` takes
 * nothing and returns the input state itself. `lost` is `[]` in that case, so a
 * caller cannot mistake "nothing was owed" for "something was destroyed".
 *
 * **The gold is not credited.** `economy.ts` keeps the unpaid shortfall reported in
 * its own event and does *not* add these maintenance savings to the turn's
 * collections: the loss is what bankruptcy costs the player, not a payment it made.
 * Crediting it would make `TreasuryShortfall` unreachable outright — every
 * shortfall would be coverable by demolishing the buildings that caused it — and
 * that unreachability is precisely the M4b debt M4c exists to close.
 */
export const disbandBuildings = (
  state: GameState,
  catalog: readonly BuildingDef[],
  playerId: PlayerId,
  amount: number,
): BuildingLossOutcome => {
  const owedAtMost = Number.isInteger(amount) && amount > 0 ? amount : 0;
  if (owedAtMost === 0) return { state, lost: [] };

  const cities = state.cities
    .filter((city) => city.owner === playerId)
    .sort((a, b) => Number(b.id) - Number(a.id));

  // A per-city working copy of the buildings list, so the state's own arrays are
  // never touched. Cities the player does not own are simply absent from the map,
  // and the rebuild below leaves them exactly as they were.
  const remaining = new Map<number, BuildingId[]>();
  for (const city of cities) remaining.set(Number(city.id), [...city.buildings]);

  let owed = owedAtMost;
  const lost: BuildingLoss[] = [];

  for (const city of cities) {
    const list = remaining.get(Number(city.id));
    if (list === undefined) continue;

    for (let index = list.length - 1; index >= 0 && owed > 0; index -= 1) {
      const id = list[index];
      if (id === undefined) continue;

      const def = buildingRow(catalog, id);
      const maintenance = def === undefined ? 0 : maintenanceOf(def);
      if (maintenance <= 0) continue;

      list.splice(index, 1);
      owed -= maintenance;
      lost.push({ cityId: city.id, building: id, maintenance });
    }
  }

  if (lost.length === 0) return { state, lost: [] };

  return {
    state: {
      ...state,
      cities: state.cities.map((city) => {
        const kept = remaining.get(Number(city.id));
        return kept === undefined ? city : { ...city, buildings: kept };
      }),
    },
    lost,
  };
};
