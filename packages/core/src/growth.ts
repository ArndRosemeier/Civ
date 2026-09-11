/**
 * Growth — the food box, and what a city does with a surplus or a deficit.
 * See docs/INTERFACES.md M3 ("Growth (food box)"), PLAN.md §5.3 (determinism)
 * and §5.4 (data layout).
 *
 * Design notes:
 *
 * - **A city's food is a box with carry-over.** Food that arrives above the
 *   threshold is not thrown away: it is what the *next* growth will be paid with,
 *   which is why a city that grows does not restart from nothing. The remainder
 *   is observable in the state (`City.foodBox`) and in the `CityGrew` event, so
 *   "how long until the next citizen?" is answerable without replaying the game.
 * - **A surplus never starves, a deficit always draws down.** `foodSurplus >= 0`
 *   only ever adds to the box; a negative one subtracts, and only takes a citizen
 *   when the box would go below zero. At population 1 the city cannot shrink
 *   further, so the box simply resets to 0 — the contract's "never below 1".
 * - **Each growth assigns the new citizen.** A citizen whose tile is unassigned
 *   works nothing (`cityYields` reads the stored assignment and deliberately
 *   invents none), so a city that grew without assigning would produce exactly
 *   what it produced before and starve on the next turn. The tile therefore comes
 *   from `autoAssignWorkedTiles` — the same function `FoundCity` uses — which is
 *   the one definition of "the best tile this city may still take"; the player
 *   can always override the choice with `SetWorkedTiles`.
 * - **Starvation trims the assignment.** Losing a citizen while keeping its tile
 *   would leave `workedTiles.length > population`, which contradicts the city
 *   invariant and would let a shrunken city hold ground another city cannot take.
 *   The *last* entries go, because `autoAssignWorkedTiles` ranks best-first and
 *   appends, so the later entries are the ones a shrinking city can afford to
 *   give up.
 * - **Cities are visited in city-id order**, never in array or object order, so
 *   the pass is a function of the state rather than of how `cities` happens to be
 *   stored. Two cities cannot affect each other's growth rate in M3 (yields do
 *   not read other cities) but the order still decides the order of the events,
 *   which is part of what a caller sees.
 * - **The threshold is the improvement-aware one (M4c).** The box is compared
 *   against `cityGrowthTarget(...)` — `foodBoxSize(population)` reduced by the
 *   city's own `growth-food` effects and floored at `MIN_GROWTH_FOOD` — and never
 *   against the bare `foodBoxSize`. Before M4c's wiring the granary and the
 *   Pyramids were inert: both declare `growth-food`, and nothing compared a food
 *   box against the reduced requirement, so the shipped wonder did nothing at all.
 *   The reduction is computed by `buildings.ts`' `cityGrowthTarget`, which is the
 *   one place the sum-and-floor rule lives; this module composes it with its own
 *   curve rather than re-reading `effects` (the M2 lesson about two writers of one
 *   layer — see `buildings.ts`' module note). **Only the threshold changed**: the
 *   multi-growth loop, the carry-over and the starvation rule below are M3's,
 *   untouched.
 * - **Integer arithmetic only** (PLAN.md §5.3): food, the box and the thresholds
 *   are whole numbers, and nothing here reads the clock, the RNG or the
 *   environment.
 */

import { cityGrowthTarget } from './buildings.js';
import {
  autoAssignWorkedTiles,
  buildingCatalog,
  cityById,
  cityYields,
  type City,
} from './cities.js';
import type { GameEvent } from './commands.js';
import type { CityId } from './ids.js';
import type { RulesetView } from './map.js';
import type { GameState } from './state.js';

/**
 * Food a city needs to grow **from** population 1, and the amount each further
 * citizen adds to that requirement.
 *
 * **Both are placeholders, and they are ours.** They are chosen to be playable:
 * an early city producing the 2-4 food surplus a small worked radius gives grows
 * in about five turns, and each later citizen costs a little more, so growth
 * slows as a city fills its radius without a formula anyone has to tune.
 *
 * They are **not** sourced from Civ 3, and in particular this is **not** Civ IV's
 * `20 + 2*population` — the formula a Civ Fanatics thread titled "city growth
 * mechanics" actually documents, and the trap INTERFACES.md's M3 provenance
 * warning names. Civ 3's real food-box curve is unverified here; when someone
 * verifies it, this constant and the test that pins it are the two places to
 * change.
 */
export const FOOD_BOX_BASE = 10;
export const FOOD_BOX_PER_CITIZEN = 5;

/**
 * The food a city of `population` citizens must accumulate to gain one more,
 * **before any building's `growth-food` reduction**.
 *
 * Linear in population — `FOOD_BOX_BASE + FOOD_BOX_PER_CITIZEN * (population - 1)`
 * — so it is a whole number for every input and cannot produce a fractional
 * threshold that no integer food total would ever reach.
 *
 * This is the *bare* curve: it is what a city with no `growth-food` building needs,
 * and it is the input `cityGrowthTarget` (`buildings.ts`) reduces. `applyGrowth`
 * never compares a food box against this number directly — doing so is exactly the
 * M4c defect that left the granary and the Pyramids inert.
 *
 * Total for garbage input: a non-finite or fractional population is read as at
 * least one citizen (a city is never empty), so a hand-built state cannot make
 * the box requirement zero and grow forever inside a single turn's loop.
 */
export const foodBoxSize = (population: number): number => {
  const citizens = Number.isFinite(population) ? Math.max(1, Math.floor(population)) : 1;
  return FOOD_BOX_BASE + FOOD_BOX_PER_CITIZEN * (citizens - 1);
};

/** What one growth pass did: the state after it, and what happened to each city. */
export interface GrowthOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** Every city id in the state, ascending. The order this module's pass runs in. */
const cityIdsInOrder = (state: GameState): readonly CityId[] =>
  [...state.cities].map((city) => city.id).sort((a, b) => Number(a) - Number(b));

/** `state` with `city` replacing the city of the same id (the cities array is rebuilt). */
const withCity = (state: GameState, city: City): GameState => ({
  ...state,
  cities: state.cities.map((existing) => (existing.id === city.id ? city : existing)),
});

/**
 * Apply one turn of growth to **every** city, in city-id order.
 *
 * For each city, in the contract's terms:
 *
 * 1. `foodSurplus >= 0` — add it to the box. While the box holds enough for the
 *    next citizen, spend that citizen's requirement
 *    (`growthTarget` = `cityGrowthTarget(catalog, city, foodBoxSize(population))`,
 *    the bare curve reduced by this city's own `growth-food` buildings and floored
 *    at `MIN_GROWTH_FOOD`), add the citizen and carry the remainder over. A single
 *    turn can therefore add more than one citizen if the surplus is enormous (a
 *    hand-built state, or a city on a small threshold); the loop always terminates
 *    because each threshold is at least `MIN_GROWTH_FOOD` food and the box only
 *    decreases.
 * 2. `foodSurplus < 0` — subtract it. If the box would go below zero, the city
 *    loses a citizen (never below 1), its assignment is trimmed to the new
 *    population, the box restarts at 0, and a `CityStarved` event is emitted. A
 *    city at population 1 starves every turn it runs a deficit: it has nothing
 *    left to lose, and the box resets each time.
 *
 * Events are emitted in the same city-id order: **one per city per turn**, saying
 * what became of it (`CityGrew` with the new population and the carried-over box,
 * or `CityStarved` with the population it was left at). A growth spurt that added
 * several citizens is one event, not five — the event says where the city ended
 * up, and the people who want the per-citizen story can read two turns' events.
 * The input state is never modified: each city's change builds a new state for the
 * next city to read.
 */
export const applyGrowth = (state: GameState, ruleset: RulesetView): GrowthOutcome => {
  let current = state;
  const events: GameEvent[] = [];

  // Resolved once for the whole pass: the catalog does not change while cities
  // grow, and `buildingCatalog` is the one place "a view with no buildings has
  // none" is decided. Passed down rather than read per city, so every city in this
  // pass is measured against the same content.
  const catalog = buildingCatalog(ruleset);

  for (const cityId of cityIdsInOrder(state)) {
    const city = cityById(current, cityId);
    if (city === undefined) continue;

    const yields = cityYields(current, ruleset, cityId);

    /**
     * The food `population` citizens of **this** city need for one more citizen.
     *
     * The reduction is this city's own (`cityGrowthTarget` reads `city.buildings`,
     * so a granary next door does not help) and it is floored inside
     * `buildings.ts`, which is why this module cannot make the requirement zero —
     * `MIN_GROWTH_FOOD` is the reason the loop below always makes progress.
     */
    const growthTarget = (population: number): number =>
      cityGrowthTarget(catalog, city, foodBoxSize(population));

    // A surplus of exactly zero changes nothing at all: no growth, no
    // starvation, and the box keeps whatever it had (contract: "a surplus >= 0
    // never starves").
    if (yields.foodSurplus === 0) continue;

    if (yields.foodSurplus > 0) {
      let population = city.population;
      let foodBox = city.foodBox + yields.foodSurplus;
      let gained = 0;

      for (;;) {
        const needed = growthTarget(population);
        if (foodBox < needed) break;
        foodBox -= needed;
        population += 1;
        gained += 1;
      }

      if (gained === 0) {
        current = withCity(current, { ...city, foodBox });
        continue;
      }

      // The new citizens are assigned before the state is committed, so this
      // city's own new claims are visible to the next city's pass (and to
      // nothing else: `autoAssignWorkedTiles` reads the *stored* assignment).
      const growing: GameState = withCity(current, { ...city, population, foodBox });
      const assigned = autoAssignWorkedTiles(growing, ruleset, cityId, gained);
      const grown: City = {
        ...city,
        population,
        foodBox,
        workedTiles: [...city.workedTiles, ...assigned],
      };
      current = withCity(growing, grown);
      events.push({
        type: 'CityGrew',
        cityId,
        owner: city.owner,
        population,
        foodBox,
      });
      continue;
    }

    const foodBox = city.foodBox + yields.foodSurplus;
    if (foodBox >= 0) {
      current = withCity(current, { ...city, foodBox });
      continue;
    }

    const population = Math.max(1, city.population - 1);
    current = withCity(current, {
      ...city,
      population,
      foodBox: 0,
      workedTiles: city.workedTiles.slice(0, population),
    });
    events.push({ type: 'CityStarved', cityId, owner: city.owner, population, foodBox: 0 });
  }

  return { state: current, events };
};
