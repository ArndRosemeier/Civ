/**
 * Cities — settlements on the map, their 21-tile working radius, and the yields
 * they produce. See docs/INTERFACES.md M3 ("State shape", "City geometry and
 * yields"), PLAN.md §5.3 (determinism) and §5.4 (data layout).
 *
 * Design notes:
 *
 * - **Cities are an array, not a record.** `GameState.cities` is a `readonly
 *   City[]` kept sorted by `id`, exactly like `units`: numeric keys in a
 *   `Record` become strings in JSON, and iteration order would then be a
 *   property of the key set rather than of the game. Creation order is what
 *   makes state hashes stable.
 * - **The assignment is state, not a derivation.** Which tiles a city works is
 *   stored in `workedTiles`; `cityYields` *reads* it. It deliberately does not
 *   fill in an assignment of its own for citizens the stored list does not
 *   cover: a second, invisible assignment algorithm inside a getter could
 *   disagree with the stored one, with `SetWorkedTiles`, and with the rule that
 *   two cities may not work the same tile — and it would make a player's choice
 *   of one tile silently produce the output of four. `autoAssignWorkedTiles`
 *   below is the one definition of "the best tiles", for callers that want to
 *   *write* an assignment (founding a city, or assigning a new citizen).
 * - **Yields are integers.** Every number here is a plain integer sum of the
 *   ruleset's integer terrain yields (PLAN.md §5.3): no fractions, no floats, no
 *   randomness, nothing that could differ between engines.
 * - **Every number is placeholder.** The radius shape, the centre's floor of
 *   1/1/1, the 2 food a citizen eats and the ordering `autoAssignWorkedTiles`
 *   uses are all chosen to be playable and are **not** sourced from Civ 3. Each
 *   one says so where it is declared.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O. Every function is
 * a pure read of the state or the ruleset it is handed.
 */

import type { BuildingId, CityId, PlayerId, TileIndex, UnitTypeId } from './ids.js';
import {
  inBounds,
  indexToX,
  indexToY,
  tileIndex,
  type RulesetView,
  type TerrainYields,
} from './map.js';
import type { GameState } from './state.js';

/**
 * The engine's structural view of a *building* type, mirroring
 * `@civts/rules`' `BuildingSpec` (which carries this plus `provenance`, a field
 * the engine never reads). `core` cannot depend on the content package, so it
 * declares what it reads — the same arrangement as `TerrainDef`/`UnitDef`.
 *
 * M3 reads exactly one field: `cost`, the shields an item costs.
 */
export interface BuildingDef {
  readonly id: BuildingId;
  readonly name: string;
  /** Production cost in shields. */
  readonly cost: number;
}

/**
 * One entry of a city's production queue: a unit type or a building type.
 *
 * A tagged union rather than a bare `BuildingId | UnitTypeId`, because the two
 * id spaces are different (and a unit and a building may well share a name).
 * `production.itemCost` resolves the tag through the matching catalog.
 */
export type ProductionItem =
  | { readonly kind: 'unit'; readonly id: UnitTypeId }
  | { readonly kind: 'building'; readonly id: BuildingId };

/**
 * A city as it exists in the world — plain data inside `GameState`, and
 * therefore part of every state hash: changing this shape changes the persisted
 * shape and needs a `SCHEMA_VERSION` bump and an intentional golden rehash.
 */
export interface City {
  /** Dense, assigned in creation order; `cities` is sorted by it. */
  readonly id: CityId;
  readonly owner: PlayerId;
  readonly name: string;
  /** The city centre. Always worked, and free — it costs no citizen. */
  readonly tile: TileIndex;
  /** Citizens, >= 1 (a city is never empty). */
  readonly population: number;
  /** Progress toward the next growth; carried over, never silently reset. */
  readonly foodBox: number;
  /** Stored production, in shields. */
  readonly shields: number;
  /**
   * The head of the queue. **Absent** — never present-and-`undefined` — when the
   * city is building nothing.
   *
   * Optional rather than `ProductionItem | undefined`, and that distinction is
   * load-bearing rather than stylistic: with `exactOptionalPropertyTypes` on,
   * `production?: ProductionItem` makes "absent" the *only* way to say "nothing
   * being built", so `{ ..., production: undefined }` is a compile error. The
   * other spelling compiles and produces a state that `hashValue` throws on —
   * `canonicalize` refuses `undefined` by design, because a key holding
   * `undefined` cannot survive a JSON save/load round trip, so such a state was
   * never genuinely serialisable. That bug has now blocked hashing three times
   * (M1's `Settings.ruleset`, M3's `FoundCity`, M3's queue promotion); making the
   * property optional is what turns the bug class into something the typechecker
   * rejects instead of a runtime throw in a golden test.
   */
  readonly production?: ProductionItem;
  /** The rest of the queue, FIFO. */
  readonly queue: readonly ProductionItem[];
  readonly buildings: readonly BuildingId[];
  /** Excludes the centre; length <= `population`. */
  readonly workedTiles: readonly TileIndex[];
}

/**
 * A city may not be founded closer than this to another city, measured in
 * Chebyshev distance (`distance8`). 2 is a **placeholder** rule: it is the
 * smallest distance that keeps two city centres from being adjacent, which is
 * what the radius geometry needs to stay legible, and it is not a sourced Civ 3
 * spacing rule.
 */
export const MIN_CITY_DISTANCE = 2;

/**
 * The city working radius, in tiles of Chebyshev distance. 2 is a
 * **placeholder**: it produces the classic 21-tile shape (see `cityRadius`) and
 * is not traced to a source.
 */
export const CITY_RADIUS = 2;

/**
 * Food each citizen eats per turn, subtracted from a city's food to give
 * `foodSurplus`. 2 is a **placeholder**: it is the smallest value that makes a
 * city on plains (1 food) need a worked tile to break even, which is what makes
 * citizen assignment matter at all. It is not a sourced Civ 3 figure.
 */
export const FOOD_PER_CITIZEN = 2;

/**
 * The floor on the centre's yields: a city centre always produces at least this
 * much, whatever its terrain says. 1 is a **placeholder** (a city on a
 * zero-yield tile must still be able to feed itself a little), and it applies to
 * the centre only — worked tiles contribute exactly what their terrain gives.
 */
const CENTRE_MIN_YIELD = 1;

/** The yield triple a city with no resolvable tiles produces. */
const NO_YIELDS: CityYields = { food: 0, shields: 0, commerce: 0, foodSurplus: 0 };

/** What a city produces in one turn, and what is left after its citizens eat. */
export interface CityYields {
  readonly food: number;
  readonly shields: number;
  readonly commerce: number;
  /** `food - FOOD_PER_CITIZEN * population`; may be negative (starvation). */
  readonly foodSurplus: number;
}

/**
 * The building catalog of a ruleset, in catalog order. A view that carries no
 * building catalog answers `[]`: `RulesetView.buildings` is optional because the
 * M2-era views that predate buildings are still valid views — they simply have
 * nothing to build, and this is the one place that decides what "no buildings"
 * means.
 */
export const buildingCatalog = (ruleset: RulesetView): readonly BuildingDef[] =>
  ruleset.buildings ?? [];

/** The building type `id`, or `undefined` when the ruleset does not define it. */
export const buildingDef = (ruleset: RulesetView, id: BuildingId): BuildingDef | undefined =>
  buildingCatalog(ruleset).find((def) => def.id === id);

/**
 * The city with this id, or `undefined`.
 *
 * `cities` is sorted by id, so a binary search would be legal; a linear scan is
 * used instead because it stays correct if that invariant is ever violated and
 * because city counts are small by design (PLAN.md §5.4).
 */
export const cityById = (state: GameState, id: CityId): City | undefined =>
  state.cities.find((city) => city.id === id);

/**
 * Every city owned by `playerId`, in id order (the order of `state.cities`).
 * Empty when the player owns none — the common answer, and not an error.
 */
export const citiesOf = (state: GameState, playerId: PlayerId): readonly City[] =>
  state.cities.filter((city) => city.owner === playerId);

/** The city whose *centre* is `tile`, or `undefined`. Cities are not stacked. */
export const cityAt = (state: GameState, tile: TileIndex): City | undefined =>
  state.cities.find((city) => city.tile === tile);

/**
 * The tiles a city centred on `tile` works: every tile with
 * `max(|dx|, |dy|) <= CITY_RADIUS` except the four corners, where both offsets
 * are exactly the radius. That is 25 - 4 = **21 tiles** in open country, and
 * fewer near a map edge, where the box is clipped to the map.
 *
 * The shape (a square with its corners cut) is a **placeholder** rule: it is
 * chosen because it is the classic city-radius shape and because it keeps a
 * city's reach symmetric and readable, not because it was traced to a source.
 *
 * The centre is included: it is inside the radius, it is always worked, and it
 * is the one tile a citizen never has to pay for — `workedTiles` is what
 * excludes it, not this function.
 *
 * Returned in ascending tile-index order (row-major, so the order is a property
 * of the loop and not of a comparison), and empty for a centre that is not on
 * the map: a radius around a tile that does not exist is not a set of tiles that
 * do.
 */
export const cityRadius = (state: GameState, tile: TileIndex): readonly TileIndex[] => {
  const map = state.map;
  const cx = indexToX(map, tile);
  const cy = indexToY(map, tile);
  if (!inBounds(map, cx, cy)) return [];

  const out: TileIndex[] = [];
  for (let dy = -CITY_RADIUS; dy <= CITY_RADIUS; dy += 1) {
    for (let dx = -CITY_RADIUS; dx <= CITY_RADIUS; dx += 1) {
      // The four corners of the square box are not part of the radius.
      if (Math.abs(dx) === CITY_RADIUS && Math.abs(dy) === CITY_RADIUS) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(map, x, y)) continue;
      out.push(tileIndex(map.width, x, y));
    }
  }
  return out;
};

/**
 * The terrain yields of one tile, or `undefined` when the tile is off the map or
 * its terrain id is not in the ruleset.
 */
const tileYields = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): TerrainYields | undefined => {
  const id = state.map.terrain[tile];
  if (id === undefined) return undefined;
  return ruleset.terrains.find((def) => def.id === id)?.yields;
};

/**
 * What a city produces this turn: its centre plus every tile it works, and the
 * food left after its citizens eat.
 *
 * - The **centre is always worked and free**, and its terrain yields are floored
 *   at `CENTRE_MIN_YIELD` in each category (placeholder) so that a city on a
 *   barren tile still produces something.
 * - Every other entry of `workedTiles` contributes its terrain's yields exactly,
 *   integers only.
 * - At most `population` tiles are counted, in the stored order: one citizen
 *   works one tile. Entries a city could not legally work — its own centre, a
 *   repeated tile, a tile outside `cityRadius`, or one past the citizen count —
 *   are **ignored** rather than counted, so a hand-built or foreign state cannot
 *   inflate a city's output through this function. `SetWorkedTiles` is where such
 *   a list is *rejected*; this is a read, and its job is to stay total.
 * - Citizens that `workedTiles` does not cover work nothing: see the module note
 *   on why this getter does not invent an assignment.
 * - `foodSurplus` is `food - FOOD_PER_CITIZEN * population` and may be negative,
 *   which is a starvation signal (`applyGrowth` owns what happens next).
 * - An unknown `cityId` yields all zeros rather than throwing: callers that want
 *   to know whether the city exists ask `cityById`, and a pure read of a city
 *   that is not there has no honest answer but "nothing".
 */
export const cityYields = (state: GameState, ruleset: RulesetView, cityId: CityId): CityYields => {
  const city = cityById(state, cityId);
  if (city === undefined) return NO_YIELDS;

  const centre = tileYields(state, ruleset, city.tile);
  let food = Math.max(CENTRE_MIN_YIELD, centre?.food ?? 0);
  let shields = Math.max(CENTRE_MIN_YIELD, centre?.shields ?? 0);
  let commerce = Math.max(CENTRE_MIN_YIELD, centre?.commerce ?? 0);

  const inside = new Set<number>(cityRadius(state, city.tile));
  const counted = new Set<number>([Number(city.tile)]);

  for (const tile of city.workedTiles) {
    if (counted.size > city.population) break;
    const index = Number(tile);
    if (!inside.has(index)) continue;
    if (counted.has(index)) continue;

    // The citizen is spent whether or not the tile's terrain is one this
    // ruleset describes: the tile is worked, it just yields nothing here.
    counted.add(index);
    const yields = tileYields(state, ruleset, tile);
    if (yields === undefined) continue;
    food += yields.food;
    shields += yields.shields;
    commerce += yields.commerce;
  }

  return { food, shields, commerce, foodSurplus: food - FOOD_PER_CITIZEN * city.population };
};

/**
 * The tiles `autoAssignWorkedTiles` would give `count` citizens of a city, best
 * first: the "auto-assign the best-yielding radius tiles" rule of M3's
 * `FoundCity`, in one place so a founder and a growth step cannot disagree about
 * what "best" means.
 *
 * - Ranking is **food, then shields, then commerce, then lowest tile index** — a
 *   deliberate *placeholder* ordering, not a sourced one. Food comes first
 *   because the failure mode a brand-new city must not have is starving.
 * - Tiles are excluded when they are the centre, already listed by this city, or
 *   listed by any *other* city: a tile worked by one city may not be worked by
 *   another, and this helper must not hand out a tile someone else claims.
 *   (Claims are read from `workedTiles` only; it never derives another city's
 *   assignment, because there is nothing derived to read.)
 * - `count` defaults to the city's population, so a founder writes
 *   `workedTiles: autoAssignWorkedTiles(state, ruleset, city.id)`.
 * - Nothing is written back: like every other function here this is a pure read,
 *   and the caller decides whether the result becomes state.
 * - An unknown `cityId` yields `[]`.
 */
export const autoAssignWorkedTiles = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
  count?: number,
): readonly TileIndex[] => {
  const city = cityById(state, cityId);
  if (city === undefined) return [];

  const want = count ?? city.population;
  if (want <= 0) return [];

  const claimed = new Set<number>([Number(city.tile)]);
  for (const other of state.cities) {
    if (other.id === city.id) continue;
    for (const tile of other.workedTiles) claimed.add(Number(tile));
  }
  for (const tile of city.workedTiles) claimed.add(Number(tile));

  const candidates = cityRadius(state, city.tile).filter((tile) => !claimed.has(Number(tile)));

  const rank = (tile: TileIndex): TerrainYields =>
    tileYields(state, ruleset, tile) ?? { food: 0, shields: 0, commerce: 0 };

  candidates.sort((a, b) => {
    const ya = rank(a);
    const yb = rank(b);
    if (ya.food !== yb.food) return yb.food - ya.food;
    if (ya.shields !== yb.shields) return yb.shields - ya.shields;
    if (ya.commerce !== yb.commerce) return yb.commerce - ya.commerce;
    return a - b;
  });

  return candidates.slice(0, want);
};
