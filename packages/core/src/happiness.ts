/**
 * Happiness — how content a city's citizens are, and the one verdict everything
 * else asks for.
 * See docs/INTERFACES.md M9 ("Happiness"), PLAN.md §5.3 (determinism) and §5.4
 * (data layout).
 *
 * ## The rule, in the contract's words
 *
 * > Each city's citizens are happy, content or unhappy. `happiness.ts` computes it as
 * > a PURE function of the city and its owner's state (never stored as a count that
 * > can drift) …
 * >
 * > **Disorder is real**: if unhappy > happy, the city is in CIVIL DISORDER — it
 * > produces no shields, no beakers and no gold that turn, growth food is not
 * > accumulated, and the state says so. That is the cross-system integration A2 asks
 * > for, so it must touch growth, production AND the money loop, each asking the ONE
 * > verdict rather than re-deriving it.
 *
 * This module is that one verdict. `happinessOf` returns the two counts, `isDisordered`
 * is the comparison stated once, and `cityYields` in `cities.ts` — the single function
 * production, the money loop and growth all read a city's output from — is where the
 * consequence is applied. **No system re-derives the verdict**, which is exactly what
 * the contract asks for and what `m9-m10-adversarial.test.ts` checks by sweeping many
 * seeds and turns for a disagreement between the two.
 *
 * ## Nothing is stored
 *
 * There is deliberately no `City.unhappyCitizens` field, no `City.disorder` flag and
 * no cache keyed by revision. Every number below is recomputed from the state on
 * demand, for the contract's own reason: "never stored as a count that can drift".
 * The engine's *state* says a city is in disorder the way it says a unit is out of
 * movement — by the fact that its yields are zero — and the readable form of that fact
 * is `happinessOf`, which any consumer (the UI panel, a test, `@civts/sim`) can ask.
 * The cost is recomputation; the benefit is that there is no second number to
 * disagree with the first, which is the defect class this project has found six times.
 *
 * ## The magnitudes, all from the catalog
 *
 * | magnitude | catalog | read by |
 * |---|---|---|
 * | unhappy citizens from size | `CultureSpec.unhappyThresholds` | `baseUnhappy` |
 * | contentment from luxuries **banked** | `CultureSpec.luxuriesPerHappyCitizen` | `happinessOf` |
 * | contentment from luxury **resources** connected | `CultureSpec.happyPerLuxuryResource` | `happinessOf` |
 * | contentment from buildings | `BuildingSpec.effects` (`city-happiness`) | `cityBuildingEffects` |
 * | the government's own modifier | `GovernmentSpec.happinessModifier` | `governments.ts` |
 *
 * Every one of those is a `placeholder(...)` row in `@civts/rules` and every one is
 * reachable through `RulesetPatch`, so the standing requirement's third clause holds
 * for M9's happiness the way M6b had to retrofit it for combat. **None is a Civ 3
 * figure** and nothing here claims one: Civ 3's contentment model counts unhappy
 * faces from size, difficulty, war weariness, overcrowding and a stack of buildings,
 * and this engine models the size, building, luxury and government terms only — the
 * rest is absent, not approximated.
 *
 * ## Determinism
 *
 * Integers only. No RNG, no clock, no transcendental, no ambient state: every
 * function is a pure read of a `GameState` and a ruleset. Cities are never visited in
 * a loop here (every function takes one city), so there is no iteration order to
 * state.
 */

import { cityBuildingEffects } from './buildings.js';
import { buildingCatalog, cityById, type City } from './cities.js';
import { governmentHappiness } from './governments.js';
import type { CityId, PlayerId, ResourceId } from './ids.js';
import { resourceDef, type RulesetView } from './map.js';
import { connected } from './resources.js';
import type { GameState, PlayerState } from './state.js';

/**
 * One rung of the "unhappy citizens come from city size" ladder: at **`minPopulation`
 * citizens and above**, this many of them are unhappy.
 *
 * A ladder rather than a formula (`floor(population / n)`), and the choice is the
 * standing requirement's third clause made concrete: a formula's `n` is a magnitude
 * buried in arithmetic, while a ladder is a table a sweep can move one row at a time —
 * and it can express a *non-linear* curve (Civ 3's own does not rise one-per-citizen,
 * which a formula of one number cannot say).
 *
 * The rows are **ascending by `minPopulation`**, and `validateRuleset` refuses a
 * catalog where they are not: an unsorted ladder is not a data error a player would
 * ever see (the reader takes the highest matching row either way) but it *is* a sign
 * that somebody meant something else, and this project's rule is that a table whose
 * order is load-bearing says so where it is written.
 */
export interface UnhappyThreshold {
  /** The population at which this rung starts to apply (integer `>= 1`). */
  readonly minPopulation: number;
  /** How many of those citizens are unhappy (integer `>= 0`). */
  readonly unhappy: number;
}

/**
 * **The happiness magnitudes a ruleset declares** — the engine's structural view of
 * the happiness half of `@civts/rules`' `CultureSpec`, minus `provenance` (a field the
 * engine never reads).
 *
 * Three fields, each with one reader in this module (see the module table above).
 * Both `cultureRulesOf` here and `borders.ts`' `cultureRulesOf` read the *same*
 * catalog section — deliberately, because the section is one section and two
 * independent readers of two halves of it would be free to disagree about what a
 * malformed section means. They read disjoint fields, so neither can shadow the
 * other; the duplication is of the *access pattern*, not of a number.
 */
export interface HappinessDef {
  /** Ascending ladder: at `minPopulation` and above, `unhappy` citizens are unhappy. */
  readonly unhappyThresholds: readonly UnhappyThreshold[];
  /**
   * Banked luxuries per happy citizen. Each whole `luxuriesPerHappyCitizen` in the
   * player's luxury pool makes one citizen of each of its cities happy.
   *
   * **A pool threshold, not a rate** — and that is a deliberate reading of the frozen
   * M4b shape rather than of M9's prose. M4b's money loop adds each turn's luxury
   * *income* to a growing pool (`PlayerState.luxuries`) exactly as it does for
   * beakers, and M5 spent beakers as a pool with no notion of a per-turn rate. So
   * luxuries are spent as a pool too, and a player's total luxury spending over the
   * game is what buys contentment. The alternative — dividing the *rate* by this
   * number — would need a second magnitude (a per-turn happiness count) that no
   * catalog section declares, and would leave the pool as inert as it was in M4b.
   */
  readonly luxuriesPerHappyCitizen: number;
  /** Happy citizens per distinct luxury resource the player has connected (integer `>= 0`). */
  readonly happyPerLuxuryResource: number;
}

/**
 * **What happiness does when the ruleset declares no culture section.**
 *
 * A *degenerate* rule, and deliberately unlike the shipped table, for the reason
 * `NO_BORDER_RULES` and `NO_CAPTURE_RULES` give: the empty ladder means **nothing ever
 * makes anybody unhappy**, so no city a structural view describes is ever in disorder.
 * That is the least disruptive reading of "this ruleset says nothing about happiness"
 * — the exact counterpart of `NO_CAPTURE_RULES`' "a sack costs the city no citizens" —
 * and it is what keeps every M2–M8 fixture in the tree (which all predate happiness)
 * producing exactly the yields it produced before M9.
 *
 * **Why not the shipped numbers?** Because a fallback that reproduced today's ladder
 * would be the dual-source bug M6b and M7 remove, one milestone later and in a new
 * costume: moving `unhappyThresholds` in the catalog would then leave every city in a
 * section-less view rioting under a table nobody can see or sweep. An absent section
 * must *change what happiness does*, and `happiness.test.ts` asserts that it does. A
 * real game never meets this: `validateRuleset` requires the catalog's `culture`
 * section, so every state built through `newGame` has citizens with feelings.
 */
export const NO_HAPPINESS_RULES: HappinessDef = {
  unhappyThresholds: [],
  luxuriesPerHappyCitizen: Number.MAX_SAFE_INTEGER,
  happyPerLuxuryResource: 0,
};

/** The counts a city's citizens are divided into. */
export interface Happiness {
  /** Citizens who want something to change. */
  readonly unhappy: number;
  /** Citizens who are enjoying themselves. */
  readonly happy: number;
  /**
   * The citizens who are neither: `population - unhappy - happy`, floored at 0.
   *
   * Carried rather than left to the caller to subtract, because the subtraction is
   * the one place a reader could accidentally apply a different clamp — and because
   * the UI's city panel shows all three (the contract asks for it), so "the third
   * number" has one home.
   */
  readonly content: number;
  /** `unhappy > happy` — the disorder verdict, and the one comparison in this module. */
  readonly disordered: boolean;
}

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A whole number at least `min`, or `undefined` for anything this engine cannot read. */
const wholeAtLeast = (value: unknown, min: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;

/**
 * One ladder row, read structurally, or `undefined` when the entry is not a row.
 *
 * A row needs a usable `minPopulation`; a row without one is dropped rather than
 * defaulted, because defaulting it to 0 would make one malformed entry apply to every
 * city in the world.
 */
const thresholdRow = (value: unknown): UnhappyThreshold | undefined => {
  if (!isRecord(value)) return undefined;
  const minPopulation = wholeAtLeast(value['minPopulation'], 1);
  if (minPopulation === undefined) return undefined;
  return { minPopulation, unhappy: wholeAtLeast(value['unhappy'], 0) ?? 0 };
};

/**
 * **The happiness magnitudes a ruleset declares** — the one read of them, total over a
 * view that declares nothing (see `NO_HAPPINESS_RULES`).
 *
 * Read through `unknown`, exactly as `combatRulesOf`, `captureRulesOf` and `borders.ts`'
 * `cultureRulesOf` read their sections, so content reaches this module without `core`
 * depending on `rules` and without a cast. A value that is present but unreadable
 * (a string, a fraction, a negative, a `NaN`) reads as the degenerate value rather than
 * poisoning a count of citizens and then every state hash.
 */
export const happinessRulesOf = (ruleset: RulesetView): HappinessDef => {
  const view: unknown = ruleset;
  const section = isRecord(view) ? view['culture'] : undefined;
  if (!isRecord(section)) return NO_HAPPINESS_RULES;

  const raw = section['unhappyThresholds'];
  const unhappyThresholds: UnhappyThreshold[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const row = thresholdRow(entry);
      if (row !== undefined) unhappyThresholds.push(row);
    }
  }

  return {
    unhappyThresholds,
    luxuriesPerHappyCitizen:
      wholeAtLeast(section['luxuriesPerHappyCitizen'], 1) ??
      NO_HAPPINESS_RULES.luxuriesPerHappyCitizen,
    happyPerLuxuryResource:
      wholeAtLeast(section['happyPerLuxuryResource'], 0) ??
      NO_HAPPINESS_RULES.happyPerLuxuryResource,
  };
};

/**
 * The rung of `thresholds` that applies at `population`: the one with the **highest**
 * `minPopulation` that `population` reaches.
 *
 * Written as a fold over the whole ladder rather than "the last row that matches on the
 * way through", so a catalog whose rows are out of order (which `validateRuleset`
 * refuses but a hand-built view may carry) still gives the highest applicable rung
 * rather than whichever row happened to come last. `0` for a ladder with no applicable
 * rung, which is the honest answer for a small city and for an empty table.
 */
export const unhappyFromSize = (
  thresholds: readonly UnhappyThreshold[],
  population: number,
): number => {
  const citizens = Number.isInteger(population) && population >= 1 ? population : 1;
  let unhappy = 0;
  let best = 0;
  for (const row of thresholds) {
    if (row.minPopulation > citizens) continue;
    if (row.minPopulation < best) continue;
    best = row.minPopulation;
    unhappy = Number.isInteger(row.unhappy) && row.unhappy > 0 ? row.unhappy : 0;
  }
  return unhappy;
};

/** The player with this id, or `undefined` — the same read every other module makes. */
const playerById = (state: GameState, playerId: PlayerId): PlayerState | undefined =>
  state.players.find((player) => player.id === playerId);

/**
 * How many **distinct luxury resources** `playerId` has connected.
 *
 * Connection is `resources.ts`' `connected` — the one implementation of "a road
 * reaches it" — filtered to rows whose `kind` is `'luxury'`. Asking anything else here
 * would be a second answer to a question that already has one, and the luxury half of
 * it is the M4c promise this milestone is meant to cash: `RESOURCE_KINDS`' doc says in
 * as many words that luxuries are "placed, connected and counted, and nothing reads
 * them for happiness until M9".
 *
 * Distinct *kinds*, not occurrences: two gems are one luxury. That is a reading stated
 * rather than implied, and it is the one `connected`' own return type (a `Set`) makes
 * natural — and it is why this is `connected(...)` and not a count of map entries.
 */
export const connectedLuxuries = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): number => {
  let count = 0;
  for (const resource of connected(state, ruleset, playerId)) {
    if (isLuxury(resourceDef(ruleset, resource))) count += 1;
  }
  return count;
};

/** Is this resource row a luxury? Total over an id the ruleset does not describe. */
const isLuxury = (def: { readonly kind: string } | undefined): boolean =>
  def !== undefined && def.kind === 'luxury';

/**
 * The happy citizens a player's **luxury spending** buys, in each of its cities:
 * `floor(luxuries / rules.luxuriesPerHappyCitizen)`.
 *
 * Signed input is read as none — a pool this engine cannot read (negative, fractional,
 * `NaN`) buys no contentment rather than a fractional number of happy citizens.
 */
export const luxuryHappyCitizens = (rules: HappinessDef, luxuries: number): number => {
  if (!Number.isInteger(luxuries) || luxuries <= 0) return 0;
  return Math.floor(luxuries / rules.luxuriesPerHappyCitizen);
};

/**
 * **The whole happiness rule for one city** — the pure function the contract names.
 *
 * In order:
 *
 * 1. **Unhappy from size** — `unhappyFromSize(rules.unhappyThresholds, city.population)`.
 * 2. **Plus the government's modifier** — a repressive order makes more citizens
 *    unhappy, a liberal one fewer (`governments.ts`' `happinessModifier`), signed.
 * 3. **Minus the city's own buildings' contentment** — the summed `city-happiness`
 *    amount of the buildings *this* city holds (`cityBuildingEffects`, the one place a
 *    building's effect on a city is computed). A temple next door helps nobody, which is
 *    that function's own stated rule and not a second one here.
 *    Floored at 0: a very content city has no unhappy citizens, not negative ones.
 * 4. **Happy** = the owner's luxury spending (`luxuryHappyCitizens`) plus
 *    `rules.happyPerLuxuryResource` for each distinct luxury resource it has connected.
 * 5. **Content** = `population - unhappy - happy`, floored at 0.
 * 6. **Disordered** — `unhappy > happy`, the contract's own comparison, stated once.
 *
 * **An unknown city is content and not disordered**, all counts zero. That is the
 * total answer for "a city that is not there" — the same reading `cityById` gives any
 * caller — and it means a consumer that asks about a stale id gets "nothing is wrong"
 * rather than a thrown error inside a legality check.
 *
 * **`luxuryResources` is an optional pre-computed count**, and it exists for one
 * reason: `connected` walks the map, and `happinessOf` is asked several times per city
 * per turn by different systems (production, the money loop, growth, the UI). A caller
 * that is already walking the map for a player — the culture pipeline step — passes the
 * count so the walk happens once; a caller that is not leaves it out and pays for one
 * walk. **The number is the same either way**: both paths call `connectedLuxuries`, so
 * there is no second implementation to disagree, only an optional memo of its result.
 */
export const happinessOf = (
  state: GameState,
  ruleset: RulesetView,
  city: City,
  luxuryResources?: number,
): Happiness => {
  const rules = happinessRulesOf(ruleset);
  const owner = playerById(state, city.owner);

  // An unknown owner is read as the degenerate government's modifier (0) and no
  // luxury spending, rather than as an exception: `unit-owner-exists` and its
  // `city` sibling in `@civts/sim` are what *report* such a state.
  const modifier = owner === undefined ? 0 : governmentHappiness(ruleset, owner);
  const luxuries = owner === undefined ? 0 : owner.luxuries;
  const resources =
    luxuryResources ?? (owner === undefined ? 0 : connectedLuxuries(state, ruleset, city.owner));

  const fromBuildings = cityBuildingEffects(buildingCatalog(ruleset), city).happiness;

  const unhappy = Math.max(
    0,
    unhappyFromSize(rules.unhappyThresholds, city.population) + modifier - fromBuildings,
  );
  const happy = luxuryHappyCitizens(rules, luxuries) + rules.happyPerLuxuryResource * resources;
  const population = Number.isInteger(city.population) ? Math.max(0, city.population) : 0;
  const content = Math.max(0, population - unhappy - happy);

  return { unhappy, happy, content, disordered: unhappy > happy };
};

/**
 * **Is this city in civil disorder?** — the one verdict, asked of `happinessOf`.
 *
 * This is the function `cities.ts`' `cityYields` calls, and it is the *only* place
 * outside this module that the disorder rule is expressed at all: production, growth
 * and the money loop all reach it through `cityYields`, so there is no second
 * derivation for the three to disagree with. Sweeping for exactly that disagreement is
 * the headline check in `m9-m10-adversarial.test.ts`.
 */
export const isDisordered = (state: GameState, ruleset: RulesetView, cityId: CityId): boolean => {
  const city = cityById(state, cityId);
  if (city === undefined) return false;
  return happinessOf(state, ruleset, city).disordered;
};

/**
 * **Every city of `playerId` that is in disorder**, in `state.cities` order (sorted by
 * id). Empty for a player with no cities and for an unknown player.
 *
 * The contract asks for this read in as many words: "`sim` must be able to detect a
 * player stuck permanently in disorder (a policy that never fixes happiness is a
 * policy bug, and it should be visible)". So it is a named function rather than a
 * filter each caller writes, and `@civts/sim` registers
 * `disorder-is-visible-in-the-state` beside it — a run whose cities are disordered turn
 * after turn reports it by name instead of leaving a player's silence to be guessed at.
 */
export const disorderedCities = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly City[] =>
  state.cities.filter(
    (city) => city.owner === playerId && happinessOf(state, ruleset, city).disordered,
  );

/** A resource id that names a luxury row in this ruleset — a read for the UI's panel. */
export const isLuxuryResource = (ruleset: RulesetView, resource: ResourceId): boolean =>
  isLuxury(resourceDef(ruleset, resource));
