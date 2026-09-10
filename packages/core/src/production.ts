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

import { buildingDef, cityById, cityYields, type City, type ProductionItem } from './cities.js';
import type { GameEvent } from './commands.js';
import type { CityId, TileIndex } from './ids.js';
import { neighbors8, type RulesetView } from './map.js';
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

    const cost = itemCostOf(ruleset, item);
    if (cost === undefined || shields < cost) {
      current = withCity(current, { ...city, shields });
      continue;
    }

    if (item.kind === 'building') {
      if (city.buildings.includes(item.id)) {
        // Nothing was produced, so nothing is charged: the entry is dropped and
        // the pool funds whatever comes next.
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
