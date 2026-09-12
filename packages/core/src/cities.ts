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
 *   randomness, nothing that could differ between engines. M4c's building
 *   multipliers keep that property: they are integer percentages applied with one
 *   `Math.floor` (`buildings.ts`' `applyEffectPct`), never a float that reaches the
 *   state.
 * - **A tile's worth and a building's effect each have one owner elsewhere.**
 *   What a *worked tile* produces is `tileYieldsWithResources` (terrain +
 *   improvements + bonus resources), and what a city's *buildings* do to its output
 *   is `cityBuildingEffects`/`applyEffectPct`. This module composes them into a
 *   city's triple and re-implements neither: M2 lost a bug hunt to two writers of
 *   one layer, and a second copy of either rule here would be that bug again with a
 *   different name.
 * - **Every number is placeholder.** The radius shape, the centre's floor of
 *   1/1/1, the 2 food a citizen eats and the ordering `autoAssignWorkedTiles`
 *   uses are all chosen to be playable and are **not** sourced from Civ 3. Each
 *   one says so where it is declared. The M4c effect *magnitudes* are content
 *   (`@civts/rules` rows, all `placeholder(...)`), not numbers this module owns.
 *
 * Nothing here reads ambient state: no RNG, no clock, no I/O. Every function is
 * a pure read of the state or the ruleset it is handed.
 */

import type { BuildingId, CityId, PlayerId, TileIndex, UnitTypeId } from './ids.js';
// The building-effect totals — the *only* place a building's effect on a city is
// computed (M4c). A value import, and the one runtime edge between these two
// modules: `buildings.ts` imports `BuildingDef` and `City` from here *type-only*,
// so the edge runs one way and there is no cycle for `state.ts`' import order to
// have to survive.
// `isWonder` and `maintenanceOf` are the M6 capture rule's two reads of a row — a
// wonder is never destroyed by capture, and the maintenance-descending order is the
// rule the destruction is reported in. Both are asked of `buildings.ts` (the module
// that owns what a building costs to keep and what makes one a wonder) rather than
// re-derived here: `wonder === true` written a second time is a second answer to one
// question, and the M2 bug class (two writers of the explored layer) is exactly that.
import {
  applyEffectPct,
  buildingRow,
  cityBuildingEffects,
  isWonder,
  maintenanceOf,
} from './buildings.js';
import {
  inBounds,
  indexToX,
  indexToY,
  tileIndex,
  type BuildingEffect,
  type RulesetView,
  type TerrainYields,
} from './map.js';
// M6b: a capture folds fog for the city's new owner, exactly as a move folds it for the
// unit that moved. `visibleTiles` is the one statement of what a player can see and
// `withExplored` the one writer of the explored layer (fog.ts' own rule), so this module
// *asks* for the fold rather than re-implementing one — the same discipline the M2
// two-writers bug taught, and the reason `commands.ts`' `movedState` reads these two as
// well. Type-only in the other direction: `fog.ts` imports `GameState` from `state.ts`,
// which does not import this module at runtime.
import { visibleTiles, withExplored } from './fog.js';
// The tile read a *worked* tile gets: terrain plus improvements plus bonus
// resources. This module is the one that composes a city out of tiles, so it is
// the place that asks for the whole of a tile's worth; `improvements.ts` owns the
// terrain-plus-improvements half and `resources.ts` the composition, each stated
// once. `cities.ts` deliberately does not re-walk either list itself.
import { tileYieldsWithResources } from './resources.js';
import type { GameState } from './state.js';

/**
 * The engine's structural view of a *building* type, mirroring
 * `@civts/rules`' `BuildingSpec` (which carries this plus `provenance`, a field
 * the engine never reads). `core` cannot depend on the content package, so it
 * declares what it reads — the same arrangement as `TerrainDef`/`UnitDef`, and the
 * same fields: a row that could omit one of them would be a building the engine
 * could not cost, keep or apply.
 *
 * M3 read exactly one field: `cost`, the shields an item costs. **M4c adds the
 * three that make a building a building**, and each one has a single reader:
 *
 * - `maintenance` — gold per turn, read by `buildings.ts`' `maintenanceOf` and
 *   summed into a player's upkeep by `economy.ts`. `0` is how a row says "free to
 *   keep", which is a tuning choice; `validateRuleset` requires an integer `>= 0`.
 * - `effects` — what it does for **its own city only**. Every effect is computed in
 *   `buildings.ts` (`cityBuildingEffects`), which is the one place the
 *   sum-first-floor-once rule for multipliers lives; `[]` is a legal, honest row
 *   and means "this building currently does nothing but cost shields and gold".
 * - `wonder` — present and `true` only for a wonder, and **absent** otherwise:
 *   never a key holding `false`, which is the same trap as an explicit `undefined`
 *   one step removed (a falsy key survives neither a JSON round trip nor a
 *   reviewer's eye). The rules it turns on are stated once, in `buildings.ts`.
 */
export interface BuildingDef {
  readonly id: BuildingId;
  readonly name: string;
  /** Production cost in shields. */
  readonly cost: number;
  /** Gold per turn this building costs its owner; integer `>= 0`. */
  readonly maintenance: number;
  /** What it does for its own city; `[]` is "nothing yet", not "unknown". */
  readonly effects: readonly BuildingEffect[];
  /** Present (and `true`) only for a wonder. Absent means "ordinary building". */
  readonly wonder?: true;
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
 *
 * Every reader below passes the result on rather than reading
 * `ruleset.buildings` again, so "a view with no buildings has none" is stated once
 * even though the callers live in three modules (`buildings.ts` takes the catalog
 * as a parameter, for exactly that reason — see its module note).
 */
export const buildingCatalog = (ruleset: RulesetView): readonly BuildingDef[] =>
  ruleset.buildings ?? [];

/**
 * The building type `id`, or `undefined` when the ruleset does not define it.
 *
 * The lookup itself is `buildings.ts`' `buildingRow`, the engine's one "find the
 * row with this id"; this function adds nothing but the step that resolves a
 * *view* to a catalog, so a caller holding a ruleset and a caller holding rows
 * cannot disagree about what a lookup means.
 */
export const buildingDef = (ruleset: RulesetView, id: BuildingId): BuildingDef | undefined =>
  buildingRow(buildingCatalog(ruleset), id);

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
 * The terrain yields of one tile, **without improvements and without resources**,
 * or `undefined` when the tile is off the map or its terrain id is not in the
 * ruleset.
 *
 * This is the *terrain* read, and only the city centre uses it: the centre is not
 * a worked tile, so M4a's improvements do not touch it (INTERFACES.md M4a,
 * "Yields with improvements"). A worked tile asks `tileYieldsWithResources`
 * (`resources.ts`, which composes `improvements.ts`' `tileYields`) instead — one
 * statement of "what is this tile worth", in the modules that own improvements and
 * resources.
 */
const terrainYields = (
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
 *   barren tile still produces something. **Improvements do not touch it**: the
 *   centre is not a worked tile, so a mine on a city's own tile changes nothing
 *   (M4a, "Yields with improvements"). Its floor is read from the *terrain*
 *   alone, which is why it uses `terrainYields` and not the tile read below.
 * - Every other entry of `workedTiles` contributes what the tile is worth in this
 *   state — its terrain's yields, plus every improvement's delta, plus every bonus
 *   resource's delta — clamped at zero per component. That composition is
 *   `tileYieldsWithResources` (`resources.ts`), which builds on `tileYields`
 *   (`improvements.ts`); this function asks for it once and never re-walks either
 *   list, so "what is this tile worth" has one implementation.
 * - **A city's buildings then multiply what it produces** (M4c): the summed
 *   `commerce-multiplier` percentage scales `commerce` and the summed
 *   `shield-multiplier` percentage scales `shields`, each with **one** floor, via
 *   `applyEffectPct`. The percentages of several buildings of the same kind are
 *   summed *before* that single floor (`cityBuildingEffects`), never applied one
 *   after another — flooring twice is a different number, and `buildings.ts`'
 *   module note works the example through. Only buildings **this city holds**
 *   contribute: a marketplace next door, or a barracks elsewhere in the same
 *   empire, changes nothing here.
 * - `food` is not multiplied by anything: M4c's union has no food multiplier, and
 *   the granary's `growth-food` shrinks the *requirement* instead
 *   (`cityGrowthTarget`), which is why it does not appear in this triple.
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

  const centre = terrainYields(state, ruleset, city.tile);
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
    const yields = tileYieldsWithResources(state, ruleset, tile);
    if (yields === undefined) continue;
    food += yields.food;
    shields += yields.shields;
    commerce += yields.commerce;
  }

  // M4c: this city's own buildings scale what it produces, with one floor each.
  // `food` is deliberately not among them (see above).
  const effects = cityBuildingEffects(buildingCatalog(ruleset), city);
  shields = applyEffectPct(shields, effects.shieldPct);
  commerce = applyEffectPct(commerce, effects.commercePct);

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

  // What the tile is actually worth in this state: terrain, improvements **and
  // bonus resources**, so a citizen values a tile as it is — a mine already built
  // inside the radius, or a bonus resource on it, ranks above the bare terrain it
  // sits on. Ranking the bare terrain would make the assignment blind to
  // everything a worker has done and to everything the map gave the tile, which is
  // exactly the state M4a and M4c add.
  const rank = (tile: TileIndex): TerrainYields =>
    tileYieldsWithResources(state, ruleset, tile) ?? { food: 0, shields: 0, commerce: 0 };

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

/* ------------------------------------------------------------------ *
 * M6 — capture: what a city becomes when it changes hands
 *
 * `commands.ts`' `AttackUnit` decides *when* a city is captured (an undefended
 * city on an adjacent tile, attacked by a unit with attack left to spend). What a
 * captured city *is* afterwards is stated here, once, because this module owns the
 * `City` shape and every field the capture changes: ownership, population, the
 * building list, the production head, the queue and the worked tiles.
 *
 * The rules, in the order the contract states them, and the reading each one takes
 * of a field the contract does not mention:
 *
 * 1. **Ownership changes** to the attacker's player. There is no "no owner" state:
 *    a city is always somebody's, which is what makes `citiesOf` total.
 * 2. **Population is halved, floored, at a minimum of 1** — `capturedPopulation`
 *    below. Placeholder, unsourced, ours.
 * 3. **Buildings are destroyed deterministically**, and **a wonder is never
 *    destroyed by capture**: a wonder is globally unique (M4c), so destroying one
 *    would silently make it buildable again — `production.ts`' completion pass asks
 *    the same uniqueness rule, and it would find no holder. The *order* the
 *    destroyed buildings are reported in is maintenance-descending, with ties going
 *    to the most recently completed (`city.buildings` is append-ordered), which is
 *    the deterministic ordering M6 names; **which** buildings go is *all* of the
 *    non-wonder ones, because a capture has no amount to cover — unlike bankruptcy
 *    demolition, whose order is a *stopping* rule ("take rows until the maintenance
 *    they cost covers what went unpaid", `buildings.ts`' `disbandBuildings`). Two
 *    consequences of that difference are stated rather than glossed:
 *    a zero-maintenance building **is** destroyed by capture (bankruptcy skips such
 *    a row, because taking a free asset buys no gold — a capture is not buying
 *    anything), and a wonder **is** kept here while bankruptcy can take one (M4c:
 *    losing a wonder to bankruptcy is the one way it is lost). The two rules share
 *    an ordering and a shape; they are not the same rule, and the contract's
 *    parenthetical "(maintenance-descending)" is the part that is shared.
 * 4. **The production head and the queue are cleared**, so the captured city builds
 *    nothing until its new owner says what it should build. `production` is
 *    *omitted* — never written as `undefined`, the spelling that cannot survive
 *    canonical JSON (see `City.production`).
 * 5. **The worked tiles are cleared**: the citizens the old owner assigned are not
 *    the new owner's, and the tiles are freed for whoever claims them next
 *    (`autoAssignWorkedTiles` reads claims from `workedTiles` alone, so a stale list
 *    would keep handing tiles to a city that no longer works them).
 * 6. **The city is NOT razed.** It keeps its id, its name and its centre tile, and
 *    it stays in `state.cities` — a city vanishing is a state the engine cannot
 *    express anyway (`city-food-conservation` in `@civts/sim` says plainly that
 *    "cities are founded, never removed").
 * 7. **Tile improvements and roads stay.** Nothing here reads `state.improvements`:
 *    sacking a city is not a reason for a mine outside it to disappear, and the
 *    contract says so outright.
 *
 * Two fields the contract does not list are deliberately **left alone**, and saying
 * so is the point of mentioning them: `foodBox` and `shields` are the city's stored
 * food and its stored production, and both survive the change of hands. A capture is
 * specified as ownership + population + buildings + queue + worked tiles, and
 * inventing a sixth change ("the granary is emptied", "the shield pool is looted")
 * would be inventing a rule rather than implementing one.
 *
 * Nothing here reads ambient state: no RNG (a capture is not a random event), no
 * clock, no I/O. `captureCity` is a pure rebuild of the state it is handed.
 * ------------------------------------------------------------------ */

/**
 * The divisor a captured city's population is reduced by. 2 is a **placeholder**:
 * unsourced, chosen to be playable, and **not** a Civ 3 figure — the M6 contract
 * states the rule ("halved, floored, minimum 1") without a source, and the real
 * game's capture losses depend on the city's size and its buildings, which this
 * engine does not model.
 */
export const CAPTURE_POPULATION_DIVISOR = 2;

/**
 * The population a city of `population` citizens has after being captured:
 * `max(1, floor(population / CAPTURE_POPULATION_DIVISOR))`.
 *
 * Floored **once**, on the halved value (the M4c compounding rule's cousin: two
 * floors in a row is a different number, and someone will otherwise "simplify"
 * this). Total on purpose — a hand-built or foreign state can carry a population
 * that is not a positive whole number, and the answer for such a city is the
 * minimum rather than a fraction that `canonicalize` would reject.
 */
export const capturedPopulation = (population: number): number => {
  const whole = Number.isInteger(population) && population > 0 ? population : 1;
  return Math.max(1, Math.floor(whole / CAPTURE_POPULATION_DIVISOR));
};

/**
 * The buildings `city` loses when it is captured, in the order they are destroyed:
 * **every non-wonder row**, ordered by maintenance descending, ties going to the
 * most recently completed.
 *
 * The order is deterministic and is part of the event a capture emits, so the same
 * capture of the same city reports the same list in the same sequence on every run
 * — which is what makes it assertable, and what the M6 contract's
 * "deterministically … (maintenance-descending)" asks for. A row whose maintenance
 * is zero is not skipped (see the section note: a capture is not paying a bill), and
 * a row the catalog does not describe is destroyed as well — the city is holding an
 * entry nothing can keep or apply, and a sack is exactly where such an entry goes;
 * it orders as maintenance 0.
 *
 * A duplicate id in `city.buildings` is destroyed twice, because it *is* two entries
 * — the same reading `cityMaintenance` takes of a duplicate.
 */
export const buildingsLostToCapture = (
  catalog: readonly BuildingDef[],
  city: City,
): readonly BuildingId[] =>
  city.buildings
    .map((id, index) => {
      const def = buildingRow(catalog, id);
      return {
        id,
        index,
        maintenance: def === undefined ? 0 : maintenanceOf(def),
        // A wonder is never destroyed by capture: it is globally unique, so losing it
        // here would make it silently buildable again (M4c's uniqueness rule reads
        // only the cities that hold it). `isWonder` is `buildings.ts`' read, not a
        // second one here.
        kept: def !== undefined && isWonder(def),
      };
    })
    .filter((entry) => !entry.kept)
    .sort(
      (a, b) =>
        // Maintenance descending: the biggest bill goes first. Ties by descending list
        // position — the most recently completed first — which is deterministic
        // because `city.buildings` is append-ordered.
        b.maintenance - a.maintenance || b.index - a.index,
    )
    .map((entry) => entry.id);

/** What a capture did: the state after it, the city as it now stands, and what was destroyed. */
export interface CityCapture {
  readonly state: GameState;
  /** The captured city, with its new owner — the same object the state's list holds. */
  readonly city: City;
  /** The buildings the sack took, in destruction order. Empty is a legal answer. */
  readonly destroyed: readonly BuildingId[];
}

/**
 * `state` with `cityId` transferred to `owner` — **the whole of M6's capture rule**,
 * and the one place it is written down.
 *
 * `undefined` means the state holds no such city: a caller cannot conquer a city
 * that is not there, and the honest answer to "what did capturing it do?" is
 * nothing at all. *Whether* the capture is legal (adjacency, an undefended tile, a
 * unit with attack left) is not this function's question — it is
 * `commands.ts`' `planAttackUnit`, and mixing the two would give legality a second
 * home.
 *
 * **It bumps `revision`, and folds fog. Both were M6 review findings, and both are
 * repairs rather than features.**
 *
 * `revision` exists to say *"the state changed"*, and a sack changes it more than most
 * commands: a city changes hands, a population drops, buildings are destroyed. M6 left
 * the bump to `commands.ts`' `applyCapture` — which is correct for a player's command
 * but means a capture applied by the *engine* (the barbarian step inside `advanceTurn`)
 * changed the world without moving the counter. Two sacks can land in one turn (a
 * civilization's `AttackUnit`, then the barbarian step), so the counter has to be able
 * to move twice, and the fact "this state changed" belongs to the rule that changes it.
 * **One bump, exactly**, which is why `applyCapture` no longer adds its own: a capture
 * that bumped twice would make `revision` disagree with the number of things applied.
 *
 * Fog is folded the way every other state change folds it — `visibleTiles` for the new
 * owner, through `withExplored`, the single writer of the explored layer. The reading is
 * the one `movedState` takes: a capture is not a *fog* question (whether the attacker
 * could see the city is not a legality rule, and never has been), it is a *memory*
 * question — the conqueror now holds a city there, so what its units can see from where
 * they stand is folded in exactly as a step folds it. M6 argued that the attacker's
 * adjacent unit had already folded its own sight; that is true for the *attacker* and
 * not for the engine's own captures, and "the tile changed hands but nobody recorded it"
 * is not a state this project wants to be able to reach.
 */
export const captureCity = (
  state: GameState,
  catalog: readonly BuildingDef[],
  cityId: CityId,
  owner: PlayerId,
): CityCapture | undefined => {
  const city = cityById(state, cityId);
  if (city === undefined) return undefined;

  const destroyed = buildingsLostToCapture(catalog, city);
  const gone = new Set<BuildingId>(destroyed);

  const captured: City = {
    id: city.id,
    owner,
    name: city.name,
    tile: city.tile,
    population: capturedPopulation(city.population),
    // Untouched by design — see the section note: the contract's list of what capture
    // changes does not include the stored food or the stored shields.
    foodBox: city.foodBox,
    shields: city.shields,
    // The head is *omitted*: the queue is cleared, so nothing is being built, and
    // `production: undefined` is the one spelling this state cannot represent.
    queue: [],
    buildings: city.buildings.filter((id) => !gone.has(id)),
    workedTiles: [],
  };

  const sacked: GameState = {
    ...state,
    revision: state.revision + 1,
    cities: state.cities.map((each) => (each.id === cityId ? captured : each)),
  };

  // The fold reads the *post-capture* state: the city's new owner is what `visibleTiles`
  // filters on now, and a capture that moves the city to a player whose units are
  // standing there is exactly the case this records.
  return {
    state: withExplored(sacked, owner, visibleTiles(sacked, owner)),
    city: captured,
    destroyed,
  };
};
