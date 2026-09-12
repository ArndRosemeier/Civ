/**
 * Production — what a city's shields buy, and when an item is finished.
 * See docs/INTERFACES.md M3 ("Production"), PLAN.md §5.3 (determinism) and
 * §5.4 (data layout).
 *
 * Design notes:
 *
 * - **Shields are a city's, not an item's.** `City.shields` is one pool that
 *   accumulates every turn and is spent when it covers the current item's cost;
 *   the remainder is carried over to whatever is built next. Switching what a
 *   city builds therefore keeps the investment it already made, which is both the
 *   simpler model and the honest one for a state shape with a single `shields`
 *   field (INTERFACES.md M3's `City` declares no per-item progress).
 * - **An item is completed at most once per turn.** With `shields` in the
 *   hundreds (a hand-built state) several items could be afforded at once; the
 *   contract says completing an item, consuming it and promoting the next queue
 *   entry, and one completion per city per turn is what keeps `CityProduced`
 *   events and the state in step. Leftover shields stay in the pool and are
 *   spent next turn.
 * - **A unit is placed where the city is.** The centre is the natural tile (M2
 *   allows a player's own units to stack, so a city that already holds one can
 *   still produce another). If another player's unit holds the centre — a state
 *   the command layer cannot reach, since a moving unit may not enter an enemy
 *   tile — the unit appears on the first adjacent tile, in ascending index order,
 *   that holds no unit of another player; if there is no such tile at all the item
 *   is *not* completed and the shields stay banked for next turn. Two readings are
 *   stated rather than left to the reader: "free" means "holds no unit of another
 *   player" because stacking one's own units is legal in M2, so a friendly stack is
 *   somewhere the produced unit may legally stand; and the fallback consults
 *   neither terrain nor unit domain, because half a placement rule would put a
 *   galley on grass and claim a mechanism nothing else in the engine has (M4 owns
 *   domains). The branch exists so the pass is total on hand-built states and saves.
 * - **A building that is already built is not completed twice.** `SetProduction`
 *   refuses such an item (a `GameError`, per the contract), so this only arises
 *   from a hand-built state or a queue that names the same building twice. The
 *   redundant entry is dropped and *nothing is charged*: no item was produced, so
 *   taking its cost would be silently burning shields on a no-op.
 * - **M4c: a wonder is completed at most once in the world.** The same reading as
 *   the bullet above, applied to a building *another* city holds: the queue entry
 *   is dropped, nothing is charged, and no second copy can appear. Both refusals
 *   are `buildings.ts`' `mayStartBuilding` asked with the state as it stands at the
 *   moment of completion — one rule, asked twice (once by the planner that offers
 *   the item, once here), rather than two rules that have to be kept in step. A
 *   wonder lost to bankruptcy leaves `city.buildings` everywhere, so the same test
 *   starts accepting it again, which is the whole of "buildable again".
 * - **M5: the availability gate is one rule with two askers, and this pass is the
 *   second.** `resources.ts`' `productionGate` answers whether an item is buildable
 *   *for this owner at all* — `open`, `tech-required` (naming the tech) or `blocked`
 *   (naming the resource) — and the completion pass asks it exactly as it already
 *   asks `mayStartBuilding`. A city whose queue holds an item the gate refuses is
 *   **not** charged and **not** completed: the shields stay banked and the item waits,
 *   which is the truthful answer while a tech a player holds can only grow. What this
 *   pass is *not* is a second opinion: it asks the same function `actions.ts`' menu
 *   asks, so a queue entry the menu would never have offered cannot be produced here
 *   either. M4c deliberately re-checked the resource half only in a comment
 *   ("provably unreachable: roads are only ever added"); M5 turns that into a check
 *   and extends it to the tech half, and M5's integration wave landed the planner's
 *   own wiring — `planSetProduction` asks the same verdict and refuses with the typed
 *   `tech-required`, so the gate now has the three askers `resources.ts` names rather
 *   than two askers and an owed patch. (This bullet said the wiring was still owed
 *   until that landed; `resources.ts`' wiring note says the same.)
 * - **M6: a captured city builds nothing, and that is visible here.** `cities.ts`'
 *   `captureCity` clears the production head and the queue — the conquering player has
 *   not ordered anything — so this pass finds a city with no `production` key and no
 *   queue, banks its shields (they are not in the capture rule's list of what changes)
 *   and completes nothing. There is no branch for it here, and that is the point: the
 *   capture rule is stated once, in `cities.ts`, and this module simply obeys the state
 *   it is handed rather than re-implementing "a captured city's queue is empty". A
 *   placement-wait and a gate refusal bank shields in the same way, so the three cases
 *   share one code path — and `production.test.ts` pins the captured case by number, so
 *   a future "clear the queue here too" would fail a test rather than pass review.
 * - **Integers only** (PLAN.md §5.3), and no ambient state: costs come from the
 *   ruleset, yields from `cityYields`, and nothing here draws from the RNG or
 *   reads a clock.
 * - **Provenance: this module adds no numbers of its own.** Every cost is a row of
 *   the ruleset (`UnitDef.cost` / `BuildingDef.cost`), and those M3 rows are
 *   `placeholder(...)` in `@civts/rules` — our own tuned values, **not** traced to
 *   Civ 3, where shield costs are per-item and depend on difficulty and era. What
 *   *is* this module's own rule — a single shield pool per city, spent on one item
 *   and carried over — is an engine decision the state shape implies (M3's `City`
 *   has one `shields` field), recorded here as a placeholder rule rather than
 *   presented as a Civ 3 mechanic. Likewise "one completion per city per turn".
 */

import {
  buildingCatalog,
  buildingDef,
  cityById,
  cityYields,
  type City,
  type ProductionItem,
} from './cities.js';
// M4c: the wonder/uniqueness half of "may this city build this". A value import,
// and a one-way edge — `buildings.ts` imports `City`/`BuildingDef` from `cities.ts`
// type-only — so the production pass keeps one implementation of the rule instead
// of a second copy of it here.
import { mayStartBuilding } from './buildings.js';
import type { GameEvent } from './commands.js';
import type { CityId, TileIndex } from './ids.js';
import { neighbors8, type RulesetView } from './map.js';
// M5: the availability gate, asked here and in `actions.ts`' menu so the two cannot
// disagree about what a city may build. A value import from `resources.ts`, which is
// a leaf of the reachability graph: it imports `buildings.ts`, `improvements.ts`,
// `units.ts` and `tech.ts`, none of which imports this module, so the edge stays
// one-way. `resources.ts` also imports `cities.ts` *type-only* for the same reason.
import { productionGate } from './resources.js';
import type { GameState } from './state.js';
import { spawnUnit, unitDef, unitsOnTile } from './units.js';

/**
 * What `item` costs in shields, or `undefined` when this ruleset cannot build it.
 *
 * A cost is only usable when it is a positive whole number of shields. A
 * fractional cost would put a fraction into `City.shields` (part of every state
 * hash, so `canonicalize` would reject it, PLAN.md §5.3), and a cost of zero or
 * less would complete the item on the turn it was queued for free — neither is a
 * row a ruleset can mean, and `validateRuleset` rejects both. A foreign or
 * hand-built view can still carry one, so the check lives here as well as in the
 * catalog validator: this is the function that decides, and "cannot be built" is
 * the answer rather than a wrong number.
 */
export const itemCostOf = (ruleset: RulesetView, item: ProductionItem): number | undefined => {
  const cost =
    item.kind === 'unit' ? unitDef(ruleset, item.id)?.cost : buildingDef(ruleset, item.id)?.cost;

  return cost !== undefined && Number.isInteger(cost) && cost > 0 ? cost : undefined;
};

/**
 * What `item` costs, as the contract's plain `number`: an item this ruleset
 * cannot build costs 0, which is the "unpriced" reading of a query that has no
 * failure channel. Callers that must *decide* something with the answer use
 * `itemCostOf` above, where "cannot be built" is distinguishable from "free".
 */
export const itemCost = (ruleset: RulesetView, item: ProductionItem): number =>
  itemCostOf(ruleset, item) ?? 0;

/** What one production pass did: the state after it, and what each city finished. */
export interface ProductionOutcome {
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
 * Where a unit built by `city` appears: the city centre, or — when another
 * player's unit is standing there — the first adjacent tile that holds no unit
 * of another player, in ascending tile-index order.
 *
 * `undefined` means there is nowhere to put it, and the caller leaves the item
 * unfinished rather than placing a unit inside an enemy stack.
 */
const placementTile = (state: GameState, city: City): TileIndex | undefined => {
  const blocked = (tile: TileIndex): boolean =>
    unitsOnTile(state, tile).some((unit) => unit.owner !== city.owner);

  if (!blocked(city.tile)) return city.tile;

  // Sorted rather than relying on the order `neighbors8` happens to emit: the
  // chosen tile is part of the state (and of the `CityProduced` event), so the
  // guarantee is stated here instead of inferred from another module's loop.
  const neighbours = [...neighbors8(state.map, city.tile)].sort((a, b) => a - b);
  return neighbours.find((tile) => !blocked(tile));
};

/**
 * The fields a completion path changes besides the queue itself: the shield pool,
 * and a building that has just joined the city. `production` and `queue` are
 * excluded from the type rather than merely ignored, so a caller cannot quietly
 * reintroduce a head that `promote` is about to decide.
 */
type CityCompletion = Omit<Partial<City>, 'production' | 'queue'>;

/**
 * The city after its queue head was consumed: the next queue entry becomes the
 * head, and the head that was just built is gone.
 *
 * The consumed head is removed with `delete`, never overwritten with
 * `production: undefined`. `City.production` is optional for exactly this reason:
 * with `exactOptionalPropertyTypes` on, "absent" is the only representable way to
 * say "nothing is being built", so the `undefined` spelling is a compile error
 * rather than a state that `hashValue` throws on and that a JSON save/load round
 * trip would silently change. Carrying the old city through a spread and then
 * deleting the key is deliberate: a spread alone would copy the *stale* head
 * through when the queue runs dry, leaving the city building the item it just
 * finished, for ever.
 *
 * `updates` carries the caller's other changes, so the removal lives in one place
 * instead of at each of the three completion paths.
 */
const promote = (city: City, updates: CityCompletion): City => {
  const result = { ...city, ...updates };
  delete result.production;

  const queue = [...city.queue];
  const next = queue.shift();
  return next === undefined ? { ...result, queue } : { ...result, production: next, queue };
};

/**
 * Apply one turn of production to **every** city, in city-id order.
 *
 * For each city: `shields += cityYields(...).shields`, then, if the city is
 * building something this ruleset can price and the pool now covers it, the item
 * is completed — a unit is spawned on the city centre at full movement, or a
 * building joins `buildings` — the cost leaves the pool, the item leaves the
 * queue and the next queue entry becomes `production`. A city with nothing
 * building simply stores its shields; an item that is unaffordable, unpriceable,
 * or a building the city already has, is left where it is.
 *
 * The input state is never modified, and the pass is a function of the state
 * alone: city order is by id, tile order is ascending, and no choice here depends
 * on iteration order or on the RNG.
 */
export const applyProduction = (state: GameState, ruleset: RulesetView): ProductionOutcome => {
  let current = state;
  const events: GameEvent[] = [];

  for (const cityId of cityIdsInOrder(state)) {
    const city = cityById(current, cityId);
    if (city === undefined) continue;

    const shields = city.shields + cityYields(current, ruleset, cityId).shields;
    const item = city.production;

    if (item === undefined) {
      current = withCity(current, { ...city, shields });
      continue;
    }

    // M5's third gating dimension, asked at the moment of completion as well as where
    // the order is decided — the same "one rule, two askers" arrangement the building
    // rule below already has, and for the same reason: a queue built before a tech
    // was known, a hand-edited save, or a state this build did not assemble can hold
    // an entry the gate refuses, and completing it would put an item on the map that
    // the player may not have.
    //
    // The response is the **waiting** one, not the dropping one: nothing was
    // produced, so nothing is charged, the shields stay banked, and the item
    // completes on the turn the tech lands (or the road reaches the resource). A tech
    // a player holds only ever grows, as does a road network — a city is never
    // destroyed and no tech is ever un-learned — so an entry this refuses is one the
    // planner would have refused and "later" is the truthful answer rather than
    // "never". Nothing is emitted, exactly as the placement-wait below emits nothing:
    // no item was produced, and a `CityProduced` event for a city that produced
    // nothing would be a lie in the event stream.
    //
    // M4c left this as a *comment* rather than a check, because re-asking the
    // resource gate was provably unreachable for a state the command layer could
    // build ("roads are only ever added"). M5 makes it a check, and M5's integration
    // wave closed the other half of the wiring: `planSetProduction` now asks this same
    // verdict, so the gate is not merely enforced twice by this pass but by the
    // planner that offers the item as well — one rule, three askers.
    if (productionGate(current, ruleset, city.owner, item).kind !== 'open') {
      current = withCity(current, { ...city, shields });
      continue;
    }

    const cost = itemCostOf(ruleset, item);
    if (cost === undefined || shields < cost) {
      current = withCity(current, { ...city, shields });
      continue;
    }

    if (item.kind === 'building') {
      // M4c: `mayStartBuilding` is the one statement of "may this city have this
      // building", and this is the second place that must agree with it — the
      // planner that *offers* the item (`SetProduction`) and the pass that
      // *completes* it. Two readings would be the M2 bug class again: a queue
      // decided before a wonder was finished elsewhere, or a hand-built state, can
      // hold an entry the rules no longer allow, and completing it would put a
      // **second** copy of a globally unique wonder on the map.
      //
      // The refusals it covers are the two this module already documented — a
      // building the city has (M3's typed `already-built`, unreachable here except
      // from a hand-built state or a queue naming one row twice) and, since M4c, a
      // **wonder any city anywhere already holds**. Either way nothing was
      // produced, so nothing is charged: the entry is dropped and the pool funds
      // whatever comes next.
      if (!mayStartBuilding(current, buildingCatalog(ruleset), city, item.id)) {
        current = withCity(current, promote(city, { shields }));
        continue;
      }

      current = withCity(
        current,
        promote(city, { shields: shields - cost, buildings: [...city.buildings, item.id] }),
      );
      events.push({
        type: 'CityProduced',
        cityId,
        owner: city.owner,
        item,
        shields: shields - cost,
      });
      continue;
    }

    const def = unitDef(ruleset, item.id);
    const tile = def === undefined ? undefined : placementTile(current, city);
    if (def === undefined || tile === undefined) {
      // Unreachable through the command layer (the cost resolved, so the type
      // exists; and a city centre is only blocked by an enemy unit, which cannot
      // stand on it). Kept total: the item waits, the shields stay banked.
      current = withCity(current, { ...city, shields });
      continue;
    }

    const spawned = spawnUnit(current, def, city.owner, tile);
    current = withCity(spawned.state, promote(city, { shields: shields - cost }));
    events.push({
      type: 'CityProduced',
      cityId,
      owner: city.owner,
      item,
      shields: shields - cost,
      unitId: spawned.unit.id,
      tile,
    });
  }

  return { state: current, events };
};
