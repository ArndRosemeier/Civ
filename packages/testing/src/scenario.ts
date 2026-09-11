/**
 * The scenario DSL: hand-built worlds, run as tests — M2's acceptance evidence.
 * See docs/INTERFACES.md M2 ("Scenario DSL", "M2 acceptance criteria"),
 * PLAN.md §8.3 (the DSL) and §10 ("the scenario suite doubles as milestone
 * acceptance").
 *
 * Why a builder exists at all: a scenario that is meant to prove *a rule* must
 * not be at the mercy of map generation. `newGame` picks starts by greedy
 * max-min distance across generated terrain, so a test written against it says
 * "some unit, somewhere, if this seed produced hills". The builder below lets a
 * scenario state the world outright — terrain by role, a unit on an exact tile —
 * so a failure means the rule moved, not the map.
 *
 * Design decisions (each is a decision, not an accident):
 *
 * - **The builder records roles; `build()` resolves them.** `fillTerrain` /
 *   `setTile` store a `TerrainRole`, and `build` resolves each role through
 *   `TERRAIN_BY_ROLE` exactly as `gen.ts` does. A role the ruleset does not
 *   define therefore fails *at build time* as the typed
 *   `{ kind: 'missing-terrain-role' }` that `newGame` also returns — which is the
 *   only failure `build()`'s frozen `Result<GameState, SetupError>` can express.
 * - **Map dimensions come from `settings.mapSize`** (`MAP_DIMENSIONS`). The
 *   frozen `Scenario` interface has no width/height field, so `duel` (40x40) is
 *   the smallest world a scenario can ask for; coordinates are validated against
 *   it, so a typo cannot silently land off the map.
 * - **Tiles default to `grassland`**; `fillTerrain` replaces the whole map and
 *   `setTile` overrides one tile. Last write to a tile wins.
 * - **The player list is authoritative for `civCount`.** `addPlayer` calls, not
 *   `settings.civCount`, decide how many civilizations exist, and `build()`
 *   writes `civCount = players.length` into the state, so the state can never
 *   claim a count it does not have. A patch that *names* a contradictory
 *   `civCount` is refused rather than silently ignored.
 * - **A player's `startingTile` is where its first unit stands.** `addPlayer`
 *   takes no tile, and `PlayerState.startingTile` is persisted (so it is part of
 *   every hash); inventing an arbitrary tile would put a lie in the state, so a
 *   player with no unit makes `build()` fail loudly instead.
 * - **Units get dense ids in creation order and full movement**, so
 *   `nextUnitId === units.length` and `units` is sorted by id — the invariants
 *   `newGame` establishes.
 * - **Fog memory starts empty.** The builder has no pre-history, so every player
 *   begins with an all-`false` explored row. The only thing that ever writes to
 *   it is a move, which folds in what the unit sees *after* the step (that is
 *   when `applyCommand` derives visibility). That is what makes "fog expands as a
 *   unit moves" an exactly computable assertion instead of a guess.
 *
 * M3 extends the same builder, additively, because the milestone's acceptance
 * evidence is not expressible without it: the map was assembled with `huts: []`
 * literally — so no scenario could place a hut, and no scenario-level hut test
 * was possible at all — and `City` had no producer in the DSL, so the only city a
 * scenario could get was one founded by a `FoundCity` in `run` (population 1,
 * empty queue, no stored shields). Three methods close that gap:
 *
 * - **`addHut(x, y)` places a goody hut.** Huts are map facts, and `huts` is
 *   sorted ascending at build time (`GameMap.huts`' contract). The two rules
 *   `generateWorld` applies when it places huts are checked where they can be:
 *   duplicate tiles and off-map coordinates at the call, and "on land, and
 *   enterable" at `build()` — because the terrain under a hut is only final once
 *   every `setTile` has run, and a hut inside impassable terrain is one no unit
 *   could ever enter, which is map decoration pretending to be a reward.
 * - **`addCity(playerIndex, at, options)` states a city outright**: its citizens,
 *   food box, shield pool, assignment, buildings, and the head and tail of its
 *   production queue. The queue is the reason this exists at all — M3 ships no
 *   command that appends to a queue (M4 owns that), so "the next queue entry
 *   becomes the head" is only reachable from a hand-built city. `options` are
 *   our own conveniences, not new rules: an omitted `population` is 1 and an
 *   omitted `workedTiles` is `autoAssignWorkedTiles`, which is exactly what
 *   `FoundCity` (commands.ts) writes; an explicit `workedTiles` is validated
 *   against the engine's own `cityRadius` and against the other cities' claims,
 *   so a scenario cannot state a city the command layer could never produce.
 * - **`addBarbarianPlayer()` adds the barbarian *identity*, not a civilization.**
 *   A hut's band needs a `kind: 'barbarian'` player to own it (`hut.ts` finds it
 *   by kind, and with none the band degrades to `nothing`), and `newGame` appends
 *   exactly one such player. It is named and coloured like `newGame`'s — a name
 *   of "Barbarians" and the fixed `#3f3f46` — and, as in `newGame`, it needs no
 *   unit: its `startingTile` is the map's first hut, falling back to tile 0 on a
 *   world with no hut at all. `civCount` counts *civilizations*, so a world with
 *   two `addPlayer` calls and a barbarian player still has `civCount: 2` and
 *   `players.length === civCount + 1`, exactly as `newGame` leaves it.
 *
 * Those three methods are the whole of M3's change here; the `Scenario`
 * interface itself is untouched (a scenario already names its `seed` through
 * `settings`, which is what a hut reward is driven by).
 *
 * M4a extends the builder once more, for the same reason:
 *
 * - **`addImprovement(x, y, kind)` places a tile improvement.** The state field
 *   it writes, `GameState.improvements`, is a *sparse sorted pair list* (M4a,
 *   "Where improvements live"), and the builder had no producer for it at all —
 *   so no scenario could start from a tile a worker had already improved, and the
 *   "building it again is refused" rule (`already-improved`) had no hand-built
 *   world to be asserted against. Like `addHut`, the cheap half of the rule is
 *   checked at the call (the coordinates are on the map, the ruleset defines the
 *   kind, the same pair is not asked for twice) and the half that needs the
 *   finished map is checked in `build()` (the terrain under the tile must be in
 *   that improvement's `allowedRoles` — the same rule `StartWork` enforces, so a
 *   scenario cannot state a tile the command layer could never produce).
 *
 *   The pairs are folded in through the engine's own `withImprovement`, never by
 *   appending to an array here: the ordering (`(tile, kind)`, ascending) and the
 *   "no duplicate pairs" invariant are the *contract* of that field because the
 *   list is hashed, and the module that owns it is the module that establishes
 *   it. The fold also happens **before** cities are built, because
 *   `autoAssignWorkedTiles` ranks a tile by what it is *worth* — improvements
 *   included — so a hand-built world must have its improvements in place before a
 *   city's citizens are assigned, exactly as a played world does.
 *
 *   The `Scenario` interface itself is still untouched, and so is the runner: the
 *   builder gained one method (additive — a scenario written against M2 or M3
 *   keeps compiling, and `addImprovement` is the only new name on the surface),
 *   the runner's behaviour did not change, and the events M4a added
 *   (`WorkStarted`/`WorkCancelled`/`WorkCompleted`) reach a scenario through the
 *   event list `ScenarioRunResult` already carried. The only other edits here are
 *   case labels in the two message tables below, so that a refused worker command
 *   reads as `<verb>: <reason>` rather than as an unrecognised error.
 *
 * M4b extends the builder for the third time, and the reason is the same one
 * again — the milestone's acceptance evidence is not expressible without it:
 *
 * - **`setTreasury(playerIndex, gold)` states a starting balance.** The money loop
 *   only ever *moves* a treasury, so "does this player go bankrupt on turn 3?"
 *   depends entirely on where it starts, and a scenario that could not say
 *   "start with 5 gold" could not stage a bankruptcy at all. The value must be an
 *   integer `>= 0`: the engine never lets a treasury go below zero (`economy.ts`'
 *   bankruptcy floors it at 0 and reports a `TreasuryShortfall`), so a hand-built
 *   world carrying a negative one would be a world the command layer cannot
 *   produce. The default is `STARTING_TREASURY`, exactly as `newGame` sets it.
 * - **`setRates(playerIndex, rates)` states how that player's commerce divides.**
 *   The rule is not restated here: `ratesProblem` — the function `planSetRates`
 *   refuses with, so a slider UI and this builder give the same reason — is asked,
 *   and a triple that is not three integers `>= 0` summing to `RATE_TOTAL` throws
 *   at the call, naming the actual sum. The default is `DEFAULT_RATES`, again as
 *   `newGame` leaves it.
 * - **`setPools(playerIndex, { beakers, luxuries })` states the two inert pools.**
 *   They accumulate and nothing spends them until M5/M9, so their only observable
 *   role today is that the split's other two channels are *accounted for*; a
 *   scenario that wants "the pools started at 4 and grew by exactly the split"
 *   needs a way to state the start. Both default to 0.
 *
 * The three are one mechanical change to the world with three names rather than
 * one `setMoney(..., partial)` because each validates a different rule and each
 * failure is a different mistake by the author. Barbarians are refused by all
 * three: `applyEconomy` skips them ("barbarians have no economy"), so a barbarian
 * treasury would be a number nothing reads — a hand-built world that *looks* like
 * it is measuring money and is not. Every civilization gets all four fields
 * (`treasury`, `rates`, `beakers`, `luxuries`) whether or not a scenario mentions
 * them, so `PlayerState` has one shape and the state stays hashable.
 *
 * M4c extends the builder for the fourth time, additively, for the same reason as
 * always — three of the wave's five acceptance scenarios are not writable without
 * it. Three methods, one per fact of the world the DSL could not state:
 *
 * - **`addResource(x, y, id)` places a resource on a tile.** `GameMap.resources` is
 *   what generation put on the terrain, and the builder assembled its map with no
 *   `resources` field at all — so no scenario could start from a world where a
 *   strategic resource was reachable, and the resource gate (the M4c rule that a
 *   unit demanding a resource may only be built where its owner has that resource
 *   *connected*) had no hand-built world to be asserted against. Like
 *   `addImprovement`, the cheap half of the rule is checked at the call (the
 *   coordinates are on the map, the ruleset defines the id, the same *pair* is not
 *   asked for twice) and the half that needs the finished map is checked in
 *   `build()` (the terrain under the tile must be in that row's `allowedRoles`, and
 *   the tile must not carry a goody hut — two of the three placement guarantees
 *   `gen.ts` gives).
 *
 *   **Two of the generator's guarantees are deliberately not enforced**, and the
 *   reasons are stated rather than left to a reader to discover:
 *
 *   1. *A start tile may carry a resource.* `gen.ts` never places one on a start
 *      tile, but a hand-built world has no generation and no pre-history: a
 *      player's `startingTile` here is simply where its first unit stands, and
 *      `FoundCity` founds exactly where the settler stands — so the most natural
 *      way to write "a resource on the city tile itself", which M4c's acceptance
 *      evidence asks for, would be refused if the rule were imposed.
 *   2. *Two resources may share one tile.* `gen.ts` places at most one per tile;
 *      `map.ts`' `TileResource` list is a `(tile, resource)` pair list, so a
 *      hand-built map can state two, and `resources.ts` sums a tile's bonus
 *      deltas precisely because "a hand-built map is not bound by the generator's
 *      rule". The acceptance evidence names this world outright, so the builder
 *      must be able to write it — and it does reject the same *pair* twice, which
 *      is an authoring mistake rather than a second resource.
 *
 *   The list is folded through the engine's own comparator (`compareTileResources`)
 *   rather than sorted here: `(tile, resource)` ascending is `GameMap.resources`'
 *   contract because the list is hashed, and the module that states the order is
 *   the module that imposes it.
 * - **`addBuilding(cityIndex, building)` gives a city a building.** `addCity`'s
 *   `buildings` option already states one at the moment the city is created, and
 *   that is unchanged; what was missing is the world in which a building stands in
 *   a city the scenario has already finished describing — which is what the wonder
 *   rules need ("once ANY city anywhere holds it, no city may start it"), and what
 *   the maintenance scenario needs to state a city whose buildings outrun its
 *   income. The catalog check is `addCity`'s; on top of it this refuses a building
 *   the city already holds (the engine's typed `already-built`, which is a refusal
 *   and not a silent no-op) and a **wonder** another city already holds (the
 *   engine's global-uniqueness rule, which no legal game can produce two copies
 *   of). Calls append, so a city's `buildings` order is the order the scenario
 *   wrote them in — the order `production.ts` appends on completion, and therefore
 *   the order `disbandBuildings` reads backwards when a bankruptcy takes the most
 *   recently completed first.
 * - **`connectRoad(from, to)` connects two tiles by road.** A resource is connected
 *   for a player when some city of that player reaches it through a path of
 *   road-improved tiles, so "a city connected by road to a strategic resource" is
 *   the *world* the acceptance evidence needs, and writing it as a chain of
 *   `addImprovement` calls is a fact about the shipped catalog's road id and about
 *   the 8-way geometry, restated by every scenario. This method reads the road
 *   **kind** off the catalog (exactly as `resources.ts` does, so a ruleset that
 *   calls its road `highway` still works and no scenario depends on the id), walks
 *   a deterministic 8-way line from `from` to `to` inclusive, and records the road
 *   on every tile of it — skipping the tiles that already carry that improvement,
 *   because a road is a road and two roads meeting is not a second road. It is
 *   *not* a statement of the connection rule: the rule has one implementation
 *   (`resources.ts`' `connected`), and this only writes the world it reads.
 *
 * The `Scenario` interface itself is untouched for the fourth time (no new field,
 * no changed signature), the runner is unchanged, and `addResource`/`addBuilding`/
 * `connectRoad` are the only new names on the builder's surface — so a scenario
 * written against M2, M3, M4a or M4b keeps compiling. Said out loud because the
 * assignment asked: what M4c extends here is the **builder**, not the frozen
 * `Scenario` interface.
 *
 * The one other edit is a *migration*, not an extension: `describeGameError`'s
 * message table gained the two error members M4c added to `GameError`
 * (`resource-not-connected` and `wonder-already-built`). Without those case labels
 * a scenario that hits the new refusals — which is exactly what the resource
 * evidence does — reports `unrecognised error` and throws away the one thing that
 * makes the refusal useful, so the table follows the union it describes.
 *
 * Failure channels — the frozen signature is narrower than the builder's needs,
 * so the split is stated here rather than discovered by a caller:
 *
 * - `build()` returns `Result<GameState, SetupError>` (frozen). `SetupError`'s
 *   variants describe *generation* failures, and a hand-built map generates
 *   nothing; the one that applies here is `missing-terrain-role`.
 *   `missing-unit-role` — the variant M2 added for `newGame`'s starting settler —
 *   is not reachable from here either: the builder places exactly the units the
 *   scenario names, so a ruleset that defines no unit of the requested type is
 *   reported by the `addUnit` call that named it (below), not by `build()`.
 * - Everything else an author can get wrong — a `setTile` outside the map, an
 *   `addUnit` for a player that was never added or for a unit type the ruleset
 *   does not define, fewer than two civilizations, a `settings.civCount` that
 *   contradicts the player list, a player with no unit, a hut on water or on
 *   impassable terrain, a city for a player that was never added, a city within
 *   `MIN_CITY_DISTANCE` of another, a worked tile outside the radius or claimed
 *   by another city, a production item this ruleset cannot price, a building the
 *   city already has, more worked tiles than citizens, an `addImprovement` for a
 *   kind this ruleset does not define or for the same pair twice — has **no**
 *   member in `SetupError`. Those throw a descriptive `Error` at the offending
 *   call where the world already knows the answer, and at `build()` for the checks
 *   that need the assembled map (terrain under a hut, an improvement whose
 *   `allowedRoles` does not include its tile's role, the geometry of a worked
 *   tile).
 *   A scenario is code: a mistake in it should fail at the line that made it, or
 *   as near to it as the information allows. (Escalated for M2: scenarios built
 *   from untrusted data would need a `bad-scenario-setup` variant, or a wider
 *   error union on `build()`.)
 * - A scenario whose *settings* do not parse is refused by `defineScenario`, and
 *   again by `runScenario` — a `Scenario` is structurally constructible without
 *   `defineScenario`, so the runner cannot assume the check already happened.
 *
 * The runner:
 *
 * - `runScenario` validates the built-in `CATALOG` through `validateRuleset` (the
 *   frozen signature takes no ruleset). `runScenarioAgainst` is the same runner
 *   against a ruleset the caller supplies — the seam a test needs to exercise a
 *   custom catalog and the setup-failure path.
 * - `scenario.run` commands are applied **as the first player**, in order: M2 has
 *   no active-player field, so "the scenario's player" is player 0 by
 *   definition. A scenario that needs another actor probes with `applyCommand`
 *   from its own `assert`, which is also how an expected *refusal* is asserted
 *   (a refused command in `run` is a failure, not an expectation).
 * - A refused `run` command is reported as a failing assertion naming the command
 *   and the typed error, and ends the run: a refusal leaves the state untouched,
 *   so carrying on would only pile up identical failures.
 * - A scenario with no assertions at all is reported as **failed**. A green run
 *   that asserts nothing is exactly the vacuous evidence the rest of this repo
 *   refuses to accept (cf. the golden harness's non-vacuity checks).
 * - A scenario *failure* never throws: the result carries `passed`, the
 *   per-assertion `{ ok, message }` list, the final state, its `hashValue` digest
 *   and the events the commands emitted. Only a bug in the scenario's own code
 *   (setup, `assert`, or the settings it names) throws.
 */

import {
  DEFAULT_RATES,
  MAP_DIMENSIONS,
  MIN_CITY_DISTANCE,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  TERRAIN_BY_ROLE,
  applyCommand,
  asCityId,
  asPlayerId,
  asTileIndex,
  asUnitId,
  autoAssignWorkedTiles,
  buildingDef,
  cityRadius,
  compareTileResources,
  distance8,
  err,
  improvementCatalog,
  improvementDef,
  inBounds,
  indexToX,
  indexToY,
  isWonder,
  itemCostOf,
  loadSettings,
  ok,
  ratesProblem,
  resourceCatalog,
  resourceDef,
  seedRng,
  tileIndex,
  unitCatalog,
  unitDef,
  withImprovement,
  type BuildingId,
  type City,
  type CityId,
  type Command,
  type Fidelity,
  type GameError,
  type GameEvent,
  type GameMap,
  type GameState,
  type ImprovementId,
  type PlayerKind,
  type PlayerState,
  type ProductionItem,
  type Rates,
  type ResourceId,
  type Result,
  type RulesetView,
  type Settings,
  type SettingsIssue,
  type SetupError,
  type TerrainId,
  type TerrainRole,
  type TileIndex,
  type TileResource,
  type Unit,
  type UnitDef,
  type UnitTypeId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { hashValue } from './hash.js';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** One assertion's outcome, with the sentence a human reads when it is `false`. */
export interface ScenarioAssertion {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * The city an `addCity` call states, as the scenario wants it.
 *
 * Every field is optional and every default mirrors what the engine itself
 * writes, so an omitted field cannot mean something the command layer could not
 * produce: `population` 1 and `foodBox`/`shields` 0 are what `FoundCity` creates,
 * an omitted `workedTiles` is `autoAssignWorkedTiles` (also what `FoundCity`
 * writes), and `production` omitted means "building nothing" — the key is
 * *absent* on the city, never present-and-`undefined`, because a state cannot
 * carry an `undefined` value into canonical JSON (`City.production`'s note in
 * `cities.ts`).
 *
 * These are builder conveniences, not rules: this module adds no numbers to the
 * game. The one ordering decision it takes — `workedTiles` is listed
 * best-first-ish because it is used verbatim, and `cityYields` counts the first
 * `population` entries — is the engine's own reading of that field.
 */
export interface CitySetup {
  readonly name?: string;
  readonly population?: number;
  readonly foodBox?: number;
  readonly shields?: number;
  readonly production?: ProductionItem;
  readonly queue?: readonly ProductionItem[];
  readonly buildings?: readonly BuildingId[];
  readonly workedTiles?: readonly TileIndex[];
}

/**
 * The two inert pools a `setPools` call may state (M4b). Both optional: an
 * omitted field keeps the value the builder already holds for that player (0
 * unless an earlier call set it), which is what makes the method usable for
 * "raise the luxuries and leave the beakers alone".
 */
export interface PoolSetup {
  readonly beakers?: number;
  readonly luxuries?: number;
}

/** The world under construction. Every method returns the builder, so `setup` can chain. */
export interface ScenarioBuilder {
  addPlayer(name: string): ScenarioBuilder;
  /**
   * Append the barbarian player (M3) — a player *identity* for the units a hut
   * spawns, not a civilization. At most one may exist (`hut.ts` spawns a band
   * into the first player of that kind), it never counts toward
   * `settings.civCount`, and it needs no unit: its `startingTile` is the map's
   * first hut, or tile 0 on a world with no hut — the same fallback `newGame`
   * uses. `name` defaults to `newGame`'s "Barbarians".
   */
  addBarbarianPlayer(name?: string): ScenarioBuilder;
  fillTerrain(role: TerrainRole): ScenarioBuilder;
  setTile(x: number, y: number, role: TerrainRole): ScenarioBuilder;
  /** Place a goody hut on a land tile (M3). Duplicate tiles throw here; water throws at `build()`. */
  addHut(x: number, y: number): ScenarioBuilder;
  /**
   * Place a tile improvement (M4a) — the state a worker leaves behind, stated
   * outright. The kind is an `ImprovementId` (what `StartWork` takes and what
   * `state.improvements` holds), so a scenario names it exactly as the command
   * does. Coordinates off the map, a kind this ruleset does not define, and the
   * same pair twice throw here; a kind that may not be built on that tile's
   * terrain role throws at `build()`, where the terrain is final.
   */
  addImprovement(x: number, y: number, kind: ImprovementId): ScenarioBuilder;
  /**
   * Place a resource on a tile (M4c) — a *map* fact, like a hut, and the only way
   * a scenario can give a player something to connect. Coordinates off the map, an
   * id this ruleset does not define, and the same `(tile, resource)` pair twice
   * throw here; a tile whose terrain role is not in that row's `allowedRoles`, and
   * a tile that carries a goody hut, throw at `build()`, where the terrain and the
   * huts are final. Two **different** resources on one tile are allowed (see the
   * module note: `gen.ts` places at most one, and a hand-built map may state two).
   */
  addResource(x: number, y: number, resource: ResourceId): ScenarioBuilder;
  /**
   * Give the city `addCity` created at `cityIndex` a building (M4c). Appends, so a
   * city's `buildings` list is the order the scenario wrote them in. A building
   * this ruleset does not define, a building the city already holds (the engine's
   * own `already-built`), and a **wonder** another city already holds (its
   * global-uniqueness rule) throw here, at the call that named them.
   */
  addBuilding(cityIndex: number, building: BuildingId): ScenarioBuilder;
  /**
   * Connect two tiles by road (M4c): the road improvement every tile on a
   * deterministic 8-way line between them carries, endpoints included. The road is
   * found by `kind` in this ruleset's improvement catalog, so no scenario depends
   * on the shipped id; a ruleset with no road row throws here. This writes a world
   * — it does not decide whether anything is *connected* (`resources.ts` owns that
   * rule, and it is the only implementation of it).
   */
  connectRoad(from: readonly [number, number], to: readonly [number, number]): ScenarioBuilder;
  addUnit(playerIndex: number, type: UnitTypeId, at: readonly [number, number]): ScenarioBuilder;
  /** State a city outright (M3) — the only way a scenario can have a queue at all. */
  addCity(playerIndex: number, at: readonly [number, number], options?: CitySetup): ScenarioBuilder;
  /**
   * State a civilization's starting gold (M4b). The money loop only ever *moves* a
   * treasury, so this is the only way a scenario can say "on the brink", "solvent"
   * or "already broke". Must be an integer `>= 0` (the engine never lets one go
   * negative); defaults to `STARTING_TREASURY`, as `newGame` leaves it. Refused for
   * the barbarian player, which has no economy.
   */
  setTreasury(playerIndex: number, gold: number): ScenarioBuilder;
  /**
   * State a civilization's tax/science/luxury split (M4b). The rule — three
   * integers `>= 0` summing to `RATE_TOTAL` — is the engine's own
   * (`ratesProblem`), and a triple that breaks it throws here with the actual sum.
   * Defaults to `DEFAULT_RATES`. Refused for the barbarian player (its rates are
   * inert).
   */
  setRates(playerIndex: number, rates: Rates): ScenarioBuilder;
  /**
   * State the two inert pools (M4b): `beakers` and `luxuries`, which accumulate
   * and are spent by nothing until M5/M9. Each must be an integer `>= 0`; an
   * omitted field keeps what it had (0 at the start). Refused for the barbarian
   * player.
   */
  setPools(playerIndex: number, pools: PoolSetup): ScenarioBuilder;
  build(): Result<GameState, SetupError>;
}

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * A settings patch, layered over `DEFAULT_SETTINGS` by `loadSettings` (which is
 * also where it is validated, unknown keys included).
 *
 * The frozen interface writes `Partial<...>`; it is a *deep* partial here because
 * that is what the layering genuinely accepts — a patch may change one key of
 * `ai` without restating the rest — and a plain `Partial<Settings>` is assignable
 * to this type, so no scenario written against the frozen spelling stops
 * compiling.
 */
export type ScenarioSettings = DeepPartial<Settings>;

/** A world, its script and its expectations — data, not bespoke test code. */
export interface Scenario {
  readonly name: string;
  readonly settings?: ScenarioSettings;
  readonly setup: (b: ScenarioBuilder) => ScenarioBuilder;
  readonly run?: readonly Command[];
  readonly assert?: (after: GameState, ruleset: RulesetView) => readonly ScenarioAssertion[];
}

/**
 * What a run reports. `{ passed, assertions, finalState, hash }` is the set the
 * frozen signature names; `name` and `events` are additive, and `events` is what
 * lets a test assert the engine's own account of a step (a `UnitMoved` carries
 * the `cost` it actually paid) rather than re-deriving it.
 *
 * `finalState` and `hash` are `undefined` only when the world could not be built
 * at all — there is no state then, and reporting a fabricated one would be worse
 * than reporting none.
 */
export interface ScenarioRunResult {
  readonly name: string;
  readonly passed: boolean;
  readonly assertions: readonly ScenarioAssertion[];
  readonly finalState: GameState | undefined;
  readonly hash: string | undefined;
  readonly events: readonly GameEvent[];
}

/* ------------------------------------------------------------------ *
 * Constants and small helpers
 * ------------------------------------------------------------------ */

/** Tiles a scenario world starts as, before `fillTerrain` / `setTile`. */
const DEFAULT_FILL_ROLE: TerrainRole = 'grassland';

/**
 * A game needs at least two civilizations: `Settings.civCount` is `>= 2` in the
 * settings schema, so a one-player "game" could not be represented as valid
 * settings and would be a state the rest of the engine has never been asked to
 * handle.
 */
const MIN_PLAYERS = 2;

/**
 * Player colours, indexed by player index — the same deterministic palette
 * `newGame` paints with. `state.ts` keeps its copy private, so the sixteen values
 * are repeated here rather than reached for; exporting the palette from `core` is
 * the fix, and it is reported as an escalation for M2 (PLAN.md §6.2 keeps the
 * *content* honest, and this is content).
 *
 * A scenario's colours never reach a golden: scenarios build their own worlds and
 * are compared with each other, not with `newGame` output.
 */
const PLAYER_COLORS: readonly string[] = [
  '#d12f2f', // red
  '#2f6fd1', // blue
  '#2f9e44', // green
  '#e8b400', // gold
  '#8b2fc9', // purple
  '#00a0a0', // teal
  '#e06b00', // orange
  '#5a3b1e', // brown
  '#c2258f', // magenta
  '#4b5563', // slate
  '#7bbf2a', // lime
  '#1f3b73', // navy
  '#b03060', // maroon
  '#00897b', // sea green
  '#9a7b1f', // olive
  '#6b7280', // grey
];

const COLOR_FALLBACK = '#000000';

const playerColor = (index: number): string =>
  PLAYER_COLORS[index % PLAYER_COLORS.length] ?? COLOR_FALLBACK;

/**
 * The barbarian player's name and colour, mirroring `newGame` (`state.ts`): a
 * fixed colour rather than the next palette entry, because the palette belongs to
 * the civilizations and a band painted in a civilization's colour would make a
 * rendering lie about who owns it. Duplicated here for the same reason the
 * palette is — `state.ts` keeps both private — and reported as the same
 * escalation: export them from `core`.
 */
const BARBARIAN_NAME = 'Barbarians';
const BARBARIAN_COLOR = '#3f3f46';

/**
 * The terrain roles that are water. `hut.ts` and `commands.ts` each keep their
 * own copy of these two words (the engine's role vocabulary, not content), and
 * the builder needs the same reading to refuse a hut on an ocean tile — the
 * "land only" half of M3's hut placement rule.
 */
const WATER_ROLES: readonly TerrainRole[] = ['ocean', 'coast'];

const formatSettingsIssues = (issues: readonly SettingsIssue[]): string =>
  issues
    .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
    .join('; ');

/** `(x, y) [tile n]` — the coordinates *and* the index, so a message cannot be misread. */
const formatTile = (tile: TileIndex, map: GameMap): string =>
  `(${String(indexToX(map, tile))}, ${String(indexToY(map, tile))}) [tile ${String(tile)}]`;

/** `unit "warrior"` / `building "granary"` — a production item, named by kind and id. */
const describeItem = (item: ProductionItem): string => `${item.kind} "${item.id}"`;

const describeCommand = (command: Command, map: GameMap): string => {
  switch (command.type) {
    case 'MoveUnit':
      return `MoveUnit unit ${String(command.unitId)} to ${formatTile(command.to, map)}`;
    case 'EndTurn':
      return 'EndTurn';
    case 'FoundCity':
      return `FoundCity by unit ${String(command.unitId)}`;
    case 'SetWorkedTiles':
      return `SetWorkedTiles city ${String(command.cityId)} to [${command.tiles
        .map((tile) => formatTile(tile, map))
        .join(', ')}]`;
    case 'SetProduction':
      return `SetProduction city ${String(command.cityId)} to ${describeItem(command.item)}`;
    // M4a's two worker verbs. They name the unit and the improvement, so a
    // refused `run` command reads as "which worker, which job" rather than as
    // "some command was refused".
    case 'StartWork':
      return `StartWork by unit ${String(command.unitId)} on improvement "${command.kind}"`;
    case 'CancelWork':
      return `CancelWork by unit ${String(command.unitId)}`;
    // Unreachable for today's union; kept total so a command added elsewhere
    // degrades to a vague message instead of breaking this module's build.
    default:
      return 'unrecognised command';
  }
};

const describeGameError = (error: GameError): string => {
  switch (error.kind) {
    case 'unknown-unit':
      return `unknown-unit (no unit ${String(error.unitId)})`;
    case 'unknown-player':
      return `unknown-player (no player ${String(error.playerId)})`;
    case 'not-your-unit':
      return `not-your-unit (unit ${String(error.unitId)} belongs to player ${String(error.owner)})`;
    case 'out-of-bounds':
      return `out-of-bounds (tile ${String(error.to)} is not on this map)`;
    case 'impassable':
      return `impassable (unit ${String(error.unitId)} cannot enter tile ${String(error.to)})`;
    case 'not-enough-movement':
      return (
        `not-enough-movement (unit ${String(error.unitId)} needs ${String(error.needed)}, ` +
        `has ${String(error.available)})`
      );
    case 'occupied-by-enemy':
      return `occupied-by-enemy (tile ${String(error.to)} holds another player's unit)`;
    // M3's city errors. Each names the fix rather than only the refusal, because a
    // scenario author reads these messages to find out what the world they built
    // is missing.
    case 'not-a-settler':
      return `not-a-settler (unit ${String(error.unitId)} is not an unused settler)`;
    case 'not-on-land':
      return `not-on-land (unit ${String(error.unitId)} stands on water at tile ${String(error.tile)})`;
    case 'city-too-close':
      return (
        `city-too-close (tile ${String(error.tile)} is ${String(error.distance)} from city ` +
        `${String(error.cityId)}, closer than the minimum ${String(error.minDistance)})`
      );
    case 'unknown-city':
      return `unknown-city (no city ${String(error.cityId)})`;
    case 'not-your-city':
      return `not-your-city (city ${String(error.cityId)} belongs to player ${String(error.owner)})`;
    case 'tile-not-workable':
      return `tile-not-workable (city ${String(error.cityId)} cannot work tile ${String(error.tile)})`;
    case 'tile-worked-by-another-city':
      return (
        `tile-worked-by-another-city (city ${String(error.byCityId)} already works tile ` +
        `${String(error.tile)}, which city ${String(error.cityId)} asked for)`
      );
    case 'duplicate-worked-tile':
      return `duplicate-worked-tile (city ${String(error.cityId)} listed tile ${String(error.tile)} twice)`;
    case 'too-many-worked-tiles':
      return (
        `too-many-worked-tiles (city ${String(error.cityId)} asked for ${String(error.requested)} ` +
        `tiles with ${String(error.allowed)} citizen(s))`
      );
    case 'unknown-production-item':
      return `unknown-production-item (${describeItem(error.item)} is not buildable)`;
    case 'already-built':
      return `already-built (city ${String(error.cityId)} already has "${error.building}")`;
    // M4c's two production refusals. Each names the fix, because the two are
    // genuinely different answers: "build a road (or a city nearer)" versus
    // "someone else finished the wonder first" — and a message that said only
    // "refused" would leave a scenario author re-deriving which of the two their
    // world produced. `resource-not-connected` names the resource and whose
    // connection was missing (they are two facts: connection is the *player's*),
    // and `wonder-already-built` names the holder when the state knows one.
    case 'resource-not-connected':
      return (
        `resource-not-connected (${describeItem(error.item)} requires "${error.resource}", which ` +
        `player ${String(error.owner)} has not connected to city ${String(error.cityId)})`
      );
    case 'wonder-already-built':
      return (
        `wonder-already-built (city ${String(error.cityId)} may not start "${error.building}"` +
        `${error.holder === undefined ? '' : `, which city ${String(error.holder)} already holds`})`
      );
    // M4a's worker refusals. Each names the improvement and the tile or role that
    // decided it, because "why can this worker not dig here?" is the question a
    // scenario author is asking.
    case 'not-a-worker':
      return `not-a-worker (unit ${String(error.unitId)} is not a worker)`;
    case 'already-working':
      return (
        `already-working (unit ${String(error.unitId)} is already building ` +
        `"${error.improvement}"; cancel it first)`
      );
    case 'not-working':
      return `not-working (unit ${String(error.unitId)} has no job to cancel)`;
    case 'unknown-improvement':
      return `unknown-improvement ("${error.improvement}" is not buildable in this ruleset)`;
    case 'improvement-not-allowed':
      return (
        `improvement-not-allowed ("${error.improvement}" cannot be built on "${error.role}" at ` +
        `tile ${String(error.tile)}, where unit ${String(error.unitId)} stands)`
      );
    case 'already-improved':
      return `already-improved (tile ${String(error.tile)} already carries "${error.improvement}")`;
    case 'invalid-argument':
      return `invalid-argument (${error.detail})`;
    default:
      return 'unrecognised error';
  }
};

const describeSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `missing-terrain-role ("${error.role}"): the ruleset defines no terrain for that role`;
    case 'missing-unit-role':
      return `missing-unit-role ("${error.role}"): the ruleset defines no unit for that role`;
    case 'no-valid-starts':
      return `no-valid-starts (${String(error.civCount)} civilizations)`;
    case 'too-few-start-candidates':
      return 'too-few-start-candidates';
    default:
      return 'unrecognised setup error';
  }
};

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

/** A unit the scenario asked for, before ids and tiles are handed out. */
interface UnitPlacement {
  readonly playerIndex: number;
  readonly def: UnitDef;
  readonly x: number;
  readonly y: number;
}

/**
 * A player the scenario asked for: its name, whether it is a civilization, and
 * (M4b) the money fields it starts with.
 *
 * `treasury`/`rates`/`beakers`/`luxuries` are resolved to the numbers the state
 * will carry the moment the player is added — `newGame`'s own starting values
 * (`STARTING_TREASURY`, `DEFAULT_RATES`, two zero pools) for a civilization, and
 * the same shape with a zero treasury for the barbarian player — so a scenario
 * that says nothing about money still gets a state with all four fields and the
 * state keeps one shape for every player.
 */
interface PlayerPlacement {
  readonly name: string;
  readonly kind: PlayerKind;
  treasury: number;
  rates: Rates;
  beakers: number;
  luxuries: number;
}

/** A goody hut the scenario asked for, in the coordinates it was written in. */
interface HutPlacement {
  readonly x: number;
  readonly y: number;
}

/**
 * A tile improvement the scenario asked for (M4a), in the coordinates it was
 * written in. Kept as `(x, y, kind)` rather than a resolved pair so the terrain
 * under the tile is only consulted in `build()`, once every `setTile` has run —
 * the same reason `HutPlacement` is coordinates.
 */
interface ImprovementPlacement {
  readonly x: number;
  readonly y: number;
  readonly kind: ImprovementId;
}

/**
 * A resource the scenario asked for (M4c), in the coordinates it was written in —
 * the same reason `HutPlacement`/`ImprovementPlacement` keep coordinates: the
 * terrain under the tile is only final in `build()`.
 *
 * Two entries with the same `(x, y)` and different `resource` are two resources on
 * one tile, which a hand-built map may state (see the module note) and which M4c's
 * acceptance evidence names; the same pair twice is refused at the call.
 */
interface ResourcePlacement {
  readonly x: number;
  readonly y: number;
  readonly resource: ResourceId;
}

/**
 * A city the scenario asked for, with every option resolved to the value the
 * state will carry. `workedTiles` keeps "the author named them" distinct from
 * "the builder assigns them": `undefined` means the latter, and an explicitly
 * empty list means "this city works nothing", which is a different choice.
 */
interface CityPlacement {
  readonly playerIndex: number;
  readonly x: number;
  readonly y: number;
  readonly name: string | undefined;
  readonly population: number;
  readonly foodBox: number;
  readonly shields: number;
  readonly production: ProductionItem | undefined;
  readonly queue: readonly ProductionItem[];
  readonly buildings: readonly BuildingId[];
  readonly workedTiles: readonly TileIndex[] | undefined;
}

/** The mutable world the builder records into. */
interface BuilderWorld {
  readonly ruleset: RulesetView;
  /** The patch as written; kept to catch a `civCount` that contradicts the players. */
  readonly patch: ScenarioSettings;
  readonly width: number;
  readonly height: number;
  readonly roles: TerrainRole[];
  readonly players: PlayerPlacement[];
  readonly placements: UnitPlacement[];
  readonly huts: HutPlacement[];
  /** M4a: the improvements the scenario asked for, in the order it asked. */
  readonly improvements: ImprovementPlacement[];
  /** M4c: the resources the scenario asked for, in the order it asked. */
  readonly resources: ResourcePlacement[];
  readonly cities: CityPlacement[];
}

/**
 * The city `id`'s placeholder name — `City 1`, `City 2`, … numbered by id.
 *
 * A duplicate of `commands.ts`' private `cityName`, and the same **placeholder**
 * scheme (`FoundCity`'s naming is ours; Civ 3 draws from per-civilization lists
 * this project does not ship). It is repeated rather than reached for because the
 * builder must produce the same state shape the engine does; exporting the
 * scheme from `core` is the fix, and it joins the palette/barbarian-colour
 * escalation for M2/M3.
 */
const cityName = (id: CityId): string => `City ${String(Number(id) + 1)}`;

/**
 * The worked tiles an explicit `addCity(..., { workedTiles })` asked for, checked
 * against the engine's own rules and returned.
 *
 * This is `planSetWorkedTiles`' rule set (commands.ts), applied to a hand-built
 * city: at most one tile per citizen, no tile listed twice, no tile outside
 * `cityRadius`, never the centre (always worked, costs no citizen), and never a
 * tile another city already works. Stating a city the command layer could not
 * produce would be a scenario measuring a world the game cannot reach, which is
 * worse than a loud authoring error.
 *
 * It runs inside `build()` rather than at the `addCity` call because the radius
 * is geometry over the assembled map and the claims of the other cities are only
 * final once the whole list is known.
 */
const checkedWorkedTiles = (
  state: GameState,
  city: City,
  tiles: readonly TileIndex[],
): readonly TileIndex[] => {
  const label = `scenario builder: addCity(..., { workedTiles }) for city ${String(Number(city.id))}`;

  if (tiles.length > city.population) {
    throw new Error(
      `${label} lists ${String(tiles.length)} tile(s) for ${String(city.population)} citizen(s) — ` +
        'one citizen works one tile',
    );
  }

  const inside = new Set<number>(cityRadius(state, city.tile).map(Number));
  const centre = Number(city.tile);
  const listed = new Set<number>();

  for (const tile of tiles) {
    const index = Number(tile);
    if (!Number.isInteger(index)) {
      throw new Error(`${label} needs integer tile indices (got ${String(tile)})`);
    }
    if (index === centre) {
      throw new Error(
        `${label} lists the city centre (${String(index)}), which is always worked and costs no ` +
          'citizen — it must not be listed',
      );
    }
    if (!inside.has(index)) {
      throw new Error(
        `${label} lists tile ${String(index)}, which is outside the 21-tile radius of the city at ` +
          `tile ${String(centre)}`,
      );
    }
    const other = state.cities.find(
      (candidate) =>
        candidate.id !== city.id &&
        candidate.workedTiles.some((worked) => Number(worked) === index),
    );
    if (other !== undefined) {
      throw new Error(
        `${label} lists tile ${String(index)}, which city ${String(Number(other.id))} already ` +
          'works; a tile worked by one city may not be worked by another',
      );
    }
    if (listed.has(index)) {
      throw new Error(`${label} lists tile ${String(index)} twice`);
    }
    listed.add(index);
  }

  return tiles;
};

/**
 * Every tile on the deterministic 8-way line from `from` to `to`, both endpoints
 * included — the shape `connectRoad` writes.
 *
 * One step per tile: the x and y coordinates each move one tile toward the target
 * (so a diagonal target is walked diagonally), which makes consecutive tiles
 * 8-adjacent and therefore a path the connection walk in `resources.ts` can
 * actually cross. Deterministic by construction — no RNG, no search, no tie to
 * break — and it terminates because every step strictly reduces the distance to the
 * target in at least one axis. Both endpoints are checked to be on the map by the
 * caller, and a coordinate that is not a number is off the map (`inBounds` says so),
 * so no `NaN` can be walked.
 */
const roadPath = (
  from: readonly [number, number],
  to: readonly [number, number],
): readonly (readonly [number, number])[] => {
  const path: (readonly [number, number])[] = [[from[0], from[1]]];
  let x = from[0];
  let y = from[1];
  while (x !== to[0] || y !== to[1]) {
    x += Math.sign(to[0] - x);
    y += Math.sign(to[1] - y);
    path.push([x, y]);
  }
  return path;
};

/**
 * Turn the recorded world into a `GameState`, or into the one `SetupError` a
 * hand-built map can produce.
 *
 * Authoring errors throw (see the module note): they are mistakes in the
 * scenario, and the failure to report is "you wrote this wrong", which
 * `SetupError` has no way to say.
 */
const buildState = (world: BuilderWorld): Result<GameState, SetupError> => {
  // `civCount` counts *civilizations*: the barbarian player is a player identity,
  // not a civilization (M3's "anything that means 'how many civilizations' must
  // use `civPlayers`, never `players.length`"), and `newGame` leaves
  // `players.length === civCount + 1`.
  const civCount = world.players.filter((player) => player.kind === 'civ').length;
  if (civCount < MIN_PLAYERS) {
    throw new Error(
      `scenario builder: a world needs at least ${String(MIN_PLAYERS)} players, where "player" ` +
        `means a civilization (Settings.civCount is >= ${String(MIN_PLAYERS)}); the barbarian ` +
        `player is a unit identity rather than one of them, and ${String(civCount)} addPlayer ` +
        'call(s) were made',
    );
  }

  const patchCivCount = world.patch.civCount;
  if (patchCivCount !== undefined && patchCivCount !== civCount) {
    throw new Error(
      `scenario builder: settings.civCount is ${String(patchCivCount)} but ` +
        `${String(civCount)} players were added with addPlayer — the player list decides the civ ` +
        'count, so drop the patch key or make the two agree',
    );
  }

  // Roles resolve to terrain ids here, once, in row-major order: the first role
  // the ruleset cannot supply is the one reported, and the message names it
  // rather than a tile (the tile is where the author looks, the role is what is
  // missing).
  const size = world.width * world.height;
  const terrain = new Array<TerrainId>(size);
  const idByRole = new Map<TerrainRole, TerrainId>();
  for (let index = 0; index < size; index += 1) {
    const role = world.roles[index] ?? DEFAULT_FILL_ROLE;
    const cached = idByRole.get(role);
    if (cached !== undefined) {
      terrain[index] = cached;
      continue;
    }
    const def = TERRAIN_BY_ROLE(world.ruleset, role);
    if (def === undefined) return err({ kind: 'missing-terrain-role', role });
    idByRole.set(role, def.id);
    terrain[index] = def.id;
  }

  // Goody huts: land only, enterable, and ascending (`GameMap.huts`' contract).
  // The two placement rules are `generateWorld`'s: a hut on water is not a hut
  // this engine places, and a hut inside impassable terrain is one no unit could
  // ever enter — decoration pretending to be a reward. Which tiles are huts is
  // final by now (every `fillTerrain`/`setTile` has run), which is why the check
  // lives here rather than at `addHut`.
  const huts: TileIndex[] = [];
  for (const hut of world.huts) {
    const index = tileIndex(world.width, hut.x, hut.y);
    const role = world.roles[index] ?? DEFAULT_FILL_ROLE;
    if (WATER_ROLES.includes(role)) {
      throw new Error(
        `scenario builder: addHut(${String(hut.x)}, ${String(hut.y)}) puts a hut on "${role}" — ` +
          'huts sit on land only',
      );
    }
    const def = TERRAIN_BY_ROLE(world.ruleset, role);
    if (def === undefined) return err({ kind: 'missing-terrain-role', role });
    if (def.impassable) {
      throw new Error(
        `scenario builder: addHut(${String(hut.x)}, ${String(hut.y)}) puts a hut on impassable ` +
          `"${role}" — no unit could ever enter it`,
      );
    }
    huts.push(asTileIndex(index));
  }
  huts.sort((a, b) => Number(a) - Number(b));

  // M4c resources, in the order `GameMap.resources`' contract fixes: `(tile,
  // resource)` ascending. The sort is the engine's own comparator rather than a
  // comparison written here, because the order is part of a hashed field's contract
  // and the module that states it is the module that imposes it.
  //
  // Two of the three placement guarantees `gen.ts` gives are checked here, and only
  // because they are knowable now: the tile's role must be one the row lists, and
  // the tile must not carry a goody hut. The third — "never on a start tile" — is
  // deliberately *not* enforced; see the module note (a hand-built world has no
  // pre-history, a player's start tile is where its first unit stands, and M4c's
  // acceptance evidence asks for a resource on a city tile).
  const resources: TileResource[] = [];
  for (const placed of world.resources) {
    const index = tileIndex(world.width, placed.x, placed.y);
    const role = world.roles[index] ?? DEFAULT_FILL_ROLE;
    const def = resourceDef(world.ruleset, placed.resource);
    if (def === undefined) {
      throw new Error(
        `scenario builder: addResource(${String(placed.x)}, ${String(placed.y)}, ` +
          `"${placed.resource}") names a resource this ruleset does not define, so nothing could ` +
          'connect to it; add the row to the ruleset or drop the call',
      );
    }
    if (!def.allowedRoles.includes(role)) {
      throw new Error(
        `scenario builder: addResource(${String(placed.x)}, ${String(placed.y)}, ` +
          `"${placed.resource}") puts it on "${role}", which is not in its allowedRoles ` +
          `(${def.allowedRoles.join(', ')}) — gen.ts would never place it there, so the world is ` +
          'one generation cannot produce',
      );
    }
    if (huts.some((hut) => Number(hut) === index)) {
      throw new Error(
        `scenario builder: addResource(${String(placed.x)}, ${String(placed.y)}, ` +
          `"${placed.resource}") puts it on a goody hut — generateWorld never places a resource ` +
          'and a hut on one tile',
      );
    }
    resources.push({ tile: asTileIndex(index), resource: placed.resource });
  }
  resources.sort(compareTileResources);

  // Creation order is id order (dense ids, sorted array — the `newGame`
  // invariant), and a player's first placement is the tile it "started" on.
  const units: Unit[] = [];
  const startByPlayer = new Map<number, TileIndex>();
  for (const placement of world.placements) {
    const tile = tileIndex(world.width, placement.x, placement.y);
    if (!startByPlayer.has(placement.playerIndex)) {
      startByPlayer.set(placement.playerIndex, tile);
    }
    units.push({
      id: asUnitId(units.length),
      type: placement.def.id,
      owner: asPlayerId(placement.playerIndex),
      tile,
      movementLeft: placement.def.movement,
    });
  }

  // The barbarian player needs no unit and has no homeland, so its `startingTile`
  // falls back to the map's first hut — a real land tile no civilization starts
  // on, and the place a band actually comes from — and then to tile 0 on a
  // degenerate world with no hut at all. That is `newGame`'s rule exactly.
  const barbarianTile = huts[0] ?? asTileIndex(0);
  const players: PlayerState[] = world.players.map((placed, index) => {
    const startingTile = startByPlayer.get(index);
    if (startingTile === undefined && placed.kind === 'civ') {
      throw new Error(
        `scenario builder: player ${String(index)} ("${placed.name}") has no unit, so the world has ` +
          `no tile it started on; add one with addUnit(${String(index)}, ...) — a hand-built world ` +
          'has no pre-history to fall back on',
      );
    }
    return {
      id: asPlayerId(index),
      name: placed.name,
      color: placed.kind === 'barbarian' ? BARBARIAN_COLOR : playerColor(index),
      startingTile: startingTile ?? barbarianTile,
      // `kind` is part of the persisted shape and is therefore spelled out rather
      // than defaulted (`civPlayers` and `hut.ts` read it).
      kind: placed.kind,
      // M4b: the money fields, every player, every time — `PlayerState` has one
      // shape and `treasury`/`rates`/`beakers`/`luxuries` are part of every state
      // hash. The values are resolved at the moment the player was added (a
      // `setTreasury`/`setRates`/`setPools` call is the only writer), so a
      // scenario's `setup` reads top to bottom like the world it describes.
      treasury: placed.treasury,
      rates: placed.rates,
      beakers: placed.beakers,
      luxuries: placed.luxuries,
    };
  });

  // The civilizations decide `civCount`; the rest of the patch layers over the
  // defaults exactly as it does for the CLI (defaults -> patch -> parse).
  const resolved = loadSettings({ ...world.patch, civCount });
  if (!resolved.ok) {
    throw new Error(
      `scenario builder: settings cannot be resolved for ${String(civCount)} civilizations — ` +
        formatSettingsIssues(resolved.error),
    );
  }

  // Fog memory starts empty and only ever grows (see the module note): the
  // builder has no history, so claiming any tile was seen would invent one.
  const explored: readonly (readonly boolean[])[] = players.map(() =>
    new Array<boolean>(size).fill(false),
  );

  const base: GameState = {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    turn: 1,
    seed: resolved.value.seed,
    settings: resolved.value,
    rng: seedRng(resolved.value.seed),
    map: { width: world.width, height: world.height, terrain, huts, resources },
    players,
    nextUnitId: units.length,
    units,
    explored,
    nextCityId: 0,
    cities: [],
    // M4a: nothing is built here yet — the scenario's own improvements are folded
    // in immediately below, through the engine's `withImprovement`, so the field
    // starts as the empty array every honest state starts with and the ordering
    // and uniqueness rules of a hashed field are established by the module that
    // owns them.
    improvements: [],
  };

  // M4a improvements, before any city exists (see the module note: a city's
  // citizens are assigned by what a tile is *worth*, improvements included).
  //
  // The rule that needs the finished map is the terrain one: which roles a tile
  // carries is only final once every `fillTerrain`/`setTile` has run, and the role
  // must be one the improvement's catalog row allows — the same rule `StartWork`
  // enforces, so a hand-built world cannot contain a mine on grassland, a tile the
  // command layer could never produce.
  //
  // The catalog lookup is repeated from `addImprovement` on purpose: this loop is
  // the only writer of the field, and a pair no row describes contributes no
  // yields at all, so a scenario asserting "the mine added a shield" would be
  // asserting about a mine the engine cannot see. `addImprovement` reports it at
  // the line that named the kind; this states it where the pair is written.
  let state = base;
  for (const placed of world.improvements) {
    const index = tileIndex(world.width, placed.x, placed.y);
    const role = world.roles[index] ?? DEFAULT_FILL_ROLE;
    const def = improvementDef(world.ruleset, placed.kind);
    if (def === undefined) {
      throw new Error(
        `scenario builder: addImprovement(${String(placed.x)}, ${String(placed.y)}, ` +
          `"${placed.kind}") names an improvement this ruleset does not define, so nothing would ` +
          'read its yields; add the row to the ruleset or drop the call',
      );
    }
    if (!def.allowedRoles.includes(role)) {
      throw new Error(
        `scenario builder: the improvement "${placed.kind}" at (${String(placed.x)}, ` +
          `${String(placed.y)}) — placed by addImprovement or connectRoad — is on "${role}", ` +
          `which is not in its allowedRoles ` +
          `(${def.allowedRoles.join(', ')}) — StartWork would refuse this tile, so the world is ` +
          'one the command layer cannot produce',
      );
    }
    state = withImprovement(state, asTileIndex(index), placed.kind);
  }

  // Cities, in creation order, so ids are dense and `cities` stays sorted by id.
  // A city is added to a *working* state before its worked tiles are resolved, so
  // `autoAssignWorkedTiles` and `cityRadius` can see it (the same order
  // `FoundCity` writes: create the city, then assign its citizens) and so each
  // city's claims are visible to the next one's assignment.
  for (let index = 0; index < world.cities.length; index += 1) {
    const placed = world.cities[index];
    if (placed === undefined) continue;

    const id = asCityId(index);
    const founded: City = {
      id,
      owner: asPlayerId(placed.playerIndex),
      name: placed.name ?? cityName(id),
      tile: tileIndex(world.width, placed.x, placed.y),
      population: placed.population,
      foodBox: placed.foodBox,
      shields: placed.shields,
      // Absent, never present-and-`undefined`: `City.production` is optional for
      // exactly this reason (see `cities.ts`), and a present-but-undefined key
      // could not survive canonical JSON, so the state would be unhashable.
      ...(placed.production === undefined ? {} : { production: placed.production }),
      queue: [...placed.queue],
      buildings: [...placed.buildings],
      workedTiles: [],
    };

    state = { ...state, cities: [...state.cities, founded] };
    const workedTiles =
      placed.workedTiles === undefined
        ? autoAssignWorkedTiles(state, world.ruleset, id)
        : checkedWorkedTiles(state, founded, placed.workedTiles);
    state = {
      ...state,
      cities: state.cities.map((city) => (city.id === id ? { ...city, workedTiles } : city)),
    };
  }

  return ok({ ...state, nextCityId: state.cities.length });
};

/**
 * Start a builder for a world of the dimensions `settings.mapSize` names.
 *
 * Not part of the frozen surface, but the assignment's point: a test that wants
 * to inspect a hand-built world directly (rather than only through
 * `runScenario`'s final state) needs to make one, and a test that wants a custom
 * ruleset cannot get one through `runScenario`. Invalid settings throw here, at
 * construction, rather than surfacing as a broken world later.
 */
export const createScenarioBuilder = (
  ruleset: RulesetView,
  settingsPatch: ScenarioSettings = {},
): ScenarioBuilder => {
  const resolved = loadSettings(settingsPatch);
  if (!resolved.ok) {
    throw new Error(`scenario builder: invalid settings — ${formatSettingsIssues(resolved.error)}`);
  }

  const dimensions = MAP_DIMENSIONS[resolved.value.mapSize];
  const world: BuilderWorld = {
    ruleset,
    patch: settingsPatch,
    width: dimensions.width,
    height: dimensions.height,
    roles: new Array<TerrainRole>(dimensions.width * dimensions.height).fill(DEFAULT_FILL_ROLE),
    players: [],
    placements: [],
    huts: [],
    improvements: [],
    resources: [],
    cities: [],
  };

  const checkTile = (x: number, y: number): void => {
    if (!inBounds(world, x, y)) {
      throw new Error(
        `scenario builder: (${String(x)}, ${String(y)}) is outside this world's ` +
          `${String(world.width)}x${String(world.height)} map (mapSize "${resolved.value.mapSize}"); ` +
          'set mapSize in the scenario settings for a different size',
      );
    }
  };

  /** A player index argument, checked the same way for every method that takes one. */
  const checkPlayerIndex = (method: string, playerIndex: number): void => {
    const known = world.players.length;
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= known) {
      throw new Error(
        `scenario builder: ${method}(${String(playerIndex)}, ...) needs a player index in ` +
          `[0, ${String(known - 1)}]; ${String(known)} player(s) have been added with addPlayer ` +
          'or addBarbarianPlayer',
      );
    }
  };

  /** A whole, non-negative count the state will carry (`population`, `foodBox`, `shields`). */
  const checkCount = (method: string, field: string, value: number, min: number): void => {
    if (!Number.isInteger(value) || value < min) {
      throw new Error(
        `scenario builder: ${method} needs an integer ${field} >= ${String(min)} (got ${String(value)})`,
      );
    }
  };

  /**
   * A *city* index, checked the way `checkPlayerIndex` checks a player's: a city
   * index is the position of an `addCity` call, which is also the city's own
   * `CityId` (`build()` hands ids out in creation order), so the two spellings name
   * the same city and this is the one place the range is decided.
   */
  const checkCityIndex = (method: string, cityIndex: number): void => {
    const known = world.cities.length;
    if (!Number.isInteger(cityIndex) || cityIndex < 0 || cityIndex >= known) {
      throw new Error(
        `scenario builder: ${method}(${String(cityIndex)}, ...) needs the index of a city that has ` +
          `been added with addCity, in [0, ${String(known - 1)}]; ${String(known)} city/cities ` +
          'have been added so far',
      );
    }
  };

  /**
   * The player a `setTreasury`/`setRates`/`setPools` call is about, checked twice:
   * the index has to name a player that was added, and that player has to be a
   * *civilization*.
   *
   * The second half is a rule of the engine's, not a convenience: `applyEconomy`
   * skips every non-civilization outright ("barbarians have no economy"), so a
   * barbarian's `treasury`/`beakers`/`luxuries` are numbers nothing ever reads and
   * its `rates` are never consulted. A scenario that could state them would be a
   * scenario that *looks* like it is measuring money while measuring nothing, so
   * the honest answer is a loud authoring error at the call.
   */
  const moneyPlayer = (method: string, playerIndex: number): PlayerPlacement => {
    checkPlayerIndex(method, playerIndex);
    const placed = world.players[playerIndex];
    if (placed === undefined) {
      // Unreachable: `checkPlayerIndex` has already proved the index is in range.
      throw new Error(`scenario builder: ${method} needs a player index that names a player`);
    }
    if (placed.kind !== 'civ') {
      throw new Error(
        `scenario builder: ${method}(${String(playerIndex)}, ...) names the barbarian player ` +
          `("${placed.name}"), which has no economy at all — it collects nothing, pays nothing ` +
          'and its rates are never read, so the value would be a number no rule touches',
      );
    }
    return placed;
  };

  const builder: ScenarioBuilder = {
    addPlayer(name) {
      if (name.trim() === '') {
        throw new Error('scenario builder: addPlayer needs a non-empty name');
      }
      // M4b: the money fields `newGame` writes, so a scenario that says nothing
      // about money still describes a state the engine can produce.
      world.players.push({
        name,
        kind: 'civ',
        treasury: STARTING_TREASURY,
        rates: DEFAULT_RATES,
        beakers: 0,
        luxuries: 0,
      });
      return builder;
    },

    addBarbarianPlayer(name = BARBARIAN_NAME) {
      if (name.trim() === '') {
        throw new Error('scenario builder: addBarbarianPlayer needs a non-empty name');
      }
      if (world.players.some((player) => player.kind === 'barbarian')) {
        throw new Error(
          'scenario builder: this world already has a barbarian player; there is one of them ' +
            '(a hut band is owned by the first player of that kind), as there is in a `newGame` world',
        );
      }
      // Zero gold and the default rates, exactly as `newGame` leaves a barbarian:
      // the fields are present (one shape for every player) and inert.
      world.players.push({
        name,
        kind: 'barbarian',
        treasury: 0,
        rates: DEFAULT_RATES,
        beakers: 0,
        luxuries: 0,
      });
      return builder;
    },

    setTreasury(playerIndex, gold) {
      const placed = moneyPlayer('setTreasury', playerIndex);
      if (!Number.isInteger(gold) || gold < 0) {
        throw new Error(
          `scenario builder: setTreasury needs an integer gold >= 0 (got ${String(gold)}); the ` +
            'engine never lets a treasury go below zero — bankruptcy floors it at 0 and reports ' +
            'the unpaid part in a TreasuryShortfall event — so a negative balance is not a state ' +
            'the command layer can produce',
        );
      }
      placed.treasury = gold;
      return builder;
    },

    setRates(playerIndex, rates) {
      const placed = moneyPlayer('setRates', playerIndex);
      // The engine's own statement of the rule, asked rather than restated: this
      // is the same function `planSetRates` refuses a `SetRates` with, so the
      // builder and the command layer cannot disagree about what a rate triple is.
      const problem = ratesProblem(rates);
      if (problem !== undefined) {
        throw new Error(
          `scenario builder: setRates(${String(playerIndex)}, ...) is not a legal split — ` +
            `${problem}; the three rates are tenths of the commerce split and must sum to ` +
            `exactly RATE_TOTAL = ${String(RATE_TOTAL)}`,
        );
      }
      // A fresh object with exactly the three fields, exactly as `planSetRates`
      // writes it: a foreign payload's extra keys must not reach the hashed state.
      placed.rates = { tax: rates.tax, science: rates.science, luxury: rates.luxury };
      return builder;
    },

    setPools(playerIndex, pools) {
      const placed = moneyPlayer('setPools', playerIndex);
      const beakers = pools.beakers ?? placed.beakers;
      const luxuries = pools.luxuries ?? placed.luxuries;
      checkCount('setPools', 'beakers', beakers, 0);
      checkCount('setPools', 'luxuries', luxuries, 0);
      placed.beakers = beakers;
      placed.luxuries = luxuries;
      return builder;
    },

    fillTerrain(role) {
      world.roles.fill(role);
      return builder;
    },

    setTile(x, y, role) {
      checkTile(x, y);
      world.roles[tileIndex(world.width, x, y)] = role;
      return builder;
    },

    addHut(x, y) {
      checkTile(x, y);
      const index = tileIndex(world.width, x, y);
      if (world.huts.some((hut) => tileIndex(world.width, hut.x, hut.y) === index)) {
        throw new Error(
          `scenario builder: addHut(${String(x)}, ${String(y)}) is called twice for one tile; a ` +
            'tile holds one hut or none',
        );
      }
      // Land and impassability are checked in `build()`: a later `setTile` can
      // still change what this tile is, so the answer is not known yet.
      world.huts.push({ x, y });
      return builder;
    },

    addImprovement(x, y, kind) {
      checkTile(x, y);

      // A kind this ruleset does not describe would be a pair nothing can price —
      // `improvementDef` would answer `undefined` and the tile would contribute no
      // yields — so a scenario asserting "the mine added a shield" would be
      // asserting about a mine the engine cannot see. Reported here, where the
      // author wrote the kind, exactly as `addUnit` reports an unknown unit type.
      if (improvementDef(world.ruleset, kind) === undefined) {
        const known = improvementCatalog(world.ruleset)
          .map((improvement) => improvement.id)
          .join(', ');
        throw new Error(
          `scenario builder: the ruleset defines no improvement "${kind}"` +
            (known === '' ? ' (it defines no improvements)' : ` (it defines: ${known})`),
        );
      }

      // The same pair twice is an authoring mistake and not a second improvement:
      // `state.improvements` holds unique pairs (`withImprovement` is idempotent),
      // so a repeated call would silently place nothing and the scenario would
      // measure a world it did not describe.
      if (
        world.improvements.some(
          (placed) => placed.x === x && placed.y === y && placed.kind === kind,
        )
      ) {
        throw new Error(
          `scenario builder: addImprovement(${String(x)}, ${String(y)}, "${kind}") is called twice ` +
            'for one tile; a tile holds a given improvement once (several *different* kinds may ' +
            'share it)',
        );
      }

      // The terrain role is checked in `build()`: a later `setTile` can still
      // change what this tile is, so the answer is not known yet.
      world.improvements.push({ x, y, kind });
      return builder;
    },

    addResource(x, y, resource) {
      checkTile(x, y);

      // An id this ruleset does not describe would be a pair nothing can connect
      // to: `connected` reads the map's pairs against the catalog, so a scenario
      // asserting "the iron gated the swordsman" would be asserting about a
      // resource the engine cannot see. Reported here, where the author wrote the
      // id, exactly as `addImprovement` reports an unknown kind.
      if (resourceDef(world.ruleset, resource) === undefined) {
        const known = resourceCatalog(world.ruleset)
          .map((def) => def.id)
          .join(', ');
        throw new Error(
          `scenario builder: the ruleset defines no resource "${resource}"` +
            (known === '' ? ' (it defines no resources)' : ` (it defines: ${known})`),
        );
      }

      // The same *pair* twice is an authoring mistake: `GameMap.resources` is a
      // pair list, and a second identical pair would be one resource written twice
      // rather than a second resource. Two *different* resources on one tile are a
      // world a hand-built map may state (see the module note), so they are allowed.
      if (
        world.resources.some(
          (placed) => placed.x === x && placed.y === y && placed.resource === resource,
        )
      ) {
        throw new Error(
          `scenario builder: addResource(${String(x)}, ${String(y)}, "${resource}") is called twice ` +
            'for one tile; a tile holds a given resource once (a *different* resource may share ' +
            'the tile, as `map.ts` says a hand-built map may)',
        );
      }

      // The terrain role and the huts under this tile are checked in `build()`: a
      // later `setTile`/`addHut` can still change the answer, so it is not known yet.
      world.resources.push({ x, y, resource });
      return builder;
    },

    addBuilding(cityIndex, building) {
      checkCityIndex('addBuilding', cityIndex);
      const placed = world.cities[cityIndex];
      if (placed === undefined) {
        // Unreachable: `checkCityIndex` has already proved the index is in range.
        throw new Error('scenario builder: addBuilding needs an index that names a city');
      }

      const def = buildingDef(world.ruleset, building);
      if (def === undefined) {
        throw new Error(
          `scenario builder: the ruleset defines no building "${building}", so no city can hold it`,
        );
      }

      // The engine's own `already-built` refusal, stated at the call: M3 made
      // "build it twice" a typed error rather than a silent no-op, so a hand-built
      // city holding two copies would be a city the command layer cannot produce.
      if (placed.buildings.includes(building)) {
        throw new Error(
          `scenario builder: addBuilding(${String(cityIndex)}, "${building}") is called for a city ` +
            'that already holds it; building one twice is refused by the engine, not a silent no-op',
        );
      }

      // M4c's wonder rule, at the call: a wonder is globally unique — "once ANY
      // city anywhere holds it, no city may start it" — so a hand-built world with
      // two copies is a world no legal game can reach.
      if (
        isWonder(def) &&
        world.cities.some((city, index) => index !== cityIndex && city.buildings.includes(building))
      ) {
        throw new Error(
          `scenario builder: addBuilding(${String(cityIndex)}, "${building}") would be a second copy ` +
            `of a wonder — a wonder is globally unique, and no city may start one another city holds`,
        );
      }

      // Appended, so a city's `buildings` order is the order this scenario wrote
      // them in: the order `production.ts` appends on completion, and therefore the
      // order `disbandBuildings` reads backwards (most recently completed first).
      world.cities[cityIndex] = { ...placed, buildings: [...placed.buildings, building] };
      return builder;
    },

    connectRoad(from, to) {
      const [fromX, fromY] = from;
      const [toX, toY] = to;
      checkTile(fromX, fromY);
      checkTile(toX, toY);

      // The road is a *kind*, not an id: `resources.ts`' connection walk reads its
      // roads off the catalog the same way, so renaming the shipped row cannot
      // disconnect a civilization and no scenario has to know the shipped id.
      const road = improvementCatalog(world.ruleset).find((def) => def.kind === 'road');
      if (road === undefined) {
        throw new Error(
          'scenario builder: connectRoad needs a road improvement in this ruleset — a ruleset that ' +
            'defines no row of kind "road" has no tile a connection walk could cross',
        );
      }

      for (const [x, y] of roadPath(from, to)) {
        // A road is a road: two segments meeting is not a second road, so a tile
        // that already carries this improvement is skipped rather than reported the
        // way `addImprovement` reports the same call twice (that refusal is for an
        // author who wrote one call twice, which is a different mistake).
        if (
          world.improvements.some(
            (placed) => placed.x === x && placed.y === y && placed.kind === road.id,
          )
        ) {
          continue;
        }
        world.improvements.push({ x, y, kind: road.id });
      }
      return builder;
    },

    addUnit(playerIndex, type, at) {
      checkPlayerIndex('addUnit', playerIndex);

      const def = unitDef(world.ruleset, type);
      if (def === undefined) {
        const knownTypes = unitCatalog(world.ruleset)
          .map((unit) => unit.id)
          .join(', ');
        throw new Error(
          `scenario builder: the ruleset defines no unit type "${type}"` +
            (knownTypes === '' ? ' (it defines no units at all)' : ` (it defines: ${knownTypes})`),
        );
      }

      const [x, y] = at;
      checkTile(x, y);
      world.placements.push({ playerIndex, def, x, y });
      return builder;
    },

    addCity(playerIndex, at, options = {}) {
      checkPlayerIndex('addCity', playerIndex);

      const [x, y] = at;
      checkTile(x, y);

      // `FoundCity` refuses a site closer than `MIN_CITY_DISTANCE` (Chebyshev) to
      // *any* city, of either owner, so a hand-built world that put two cities
      // closer than that would be a world the command layer cannot produce — and
      // their radii would overlap in a way no game can reach. The distance is the
      // engine's own `distance8`, not a second Chebyshev formula.
      const site = tileIndex(world.width, x, y);
      for (const city of world.cities) {
        const other = tileIndex(world.width, city.x, city.y);
        const distance = distance8({ width: world.width }, site, other);
        if (distance < MIN_CITY_DISTANCE) {
          throw new Error(
            `scenario builder: addCity(${String(x)}, ${String(y)}) is ${String(distance)} tile(s) ` +
              `from the city at (${String(city.x)}, ${String(city.y)}), closer than ` +
              `MIN_CITY_DISTANCE = ${String(MIN_CITY_DISTANCE)}`,
          );
        }
      }

      const population = options.population ?? 1;
      const foodBox = options.foodBox ?? 0;
      const shields = options.shields ?? 0;
      checkCount('addCity', 'population', population, 1);
      checkCount('addCity', 'foodBox', foodBox, 0);
      checkCount('addCity', 'shields', shields, 0);

      const buildings = options.buildings ?? [];
      const queue = options.queue ?? [];
      const production = options.production;
      const items: readonly ProductionItem[] =
        production === undefined ? queue : [production, ...queue];

      for (const building of buildings) {
        if (buildingDef(world.ruleset, building) === undefined) {
          throw new Error(
            `scenario builder: the ruleset defines no building "${building}", so no city can hold it`,
          );
        }
      }

      for (const item of items) {
        // A hand-built city may only be asked to build something this ruleset can
        // price: an item it cannot price would sit at the head of the queue for
        // ever (`production.ts` leaves such an item alone), and a scenario would
        // then assert nothing about a completion that never came.
        if (itemCostOf(world.ruleset, item) === undefined) {
          const knownItems = [
            ...unitCatalog(world.ruleset).map((unit) => `unit "${unit.id}"`),
            ...[...(world.ruleset.buildings ?? [])].map((built) => `building "${built.id}"`),
          ].join(', ');
          throw new Error(
            `scenario builder: addCity cannot queue ${describeItem(item)} — the ruleset cannot ` +
              `price it` +
              (knownItems === ''
                ? ' (it defines nothing buildable)'
                : ` (it defines: ${knownItems})`),
          );
        }
        if (item.kind === 'building' && buildings.includes(item.id)) {
          throw new Error(
            `scenario builder: addCity queues building "${item.id}", which the city already has; ` +
              'building it twice is refused by the engine, not a silent no-op',
          );
        }
      }

      const workedTiles = options.workedTiles;
      if (workedTiles !== undefined) {
        // Cheap half of the assignment's legality, checkable without the map:
        // one citizen works one tile, and no tile may be listed twice. The
        // geometric half (inside the radius, off the centre, unclaimed by
        // another city) runs in `build()`, where the radius exists.
        if (workedTiles.length > population) {
          throw new Error(
            `scenario builder: addCity lists ${String(workedTiles.length)} worked tile(s) for ` +
              `${String(population)} citizen(s) — one citizen works one tile`,
          );
        }
        const listed = new Set<number>();
        for (const tile of workedTiles) {
          if (!Number.isInteger(Number(tile))) {
            throw new Error(
              `scenario builder: addCity needs integer tile indices for workedTiles (got ${String(tile)})`,
            );
          }
          if (listed.has(Number(tile))) {
            throw new Error(
              `scenario builder: addCity lists tile ${String(Number(tile))} twice in workedTiles`,
            );
          }
          listed.add(Number(tile));
        }
      }

      world.cities.push({
        playerIndex,
        x,
        y,
        name: options.name,
        population,
        foodBox,
        shields,
        production,
        queue,
        buildings,
        workedTiles,
      });
      return builder;
    },

    build() {
      return buildState(world);
    },
  };

  return builder;
};

/* ------------------------------------------------------------------ *
 * Definition and execution
 * ------------------------------------------------------------------ */

/**
 * Name a scenario and check the settings it declares, once, at definition time.
 *
 * `defineScenario` is the sanctioned constructor, so a settings typo fails where
 * it is written instead of inside a run. The returned value is the scenario
 * itself: this validates, it does not wrap.
 */
export const defineScenario = (scenario: Scenario): Scenario => {
  if (scenario.name.trim() === '') {
    throw new Error('defineScenario: a scenario needs a non-empty name (a failing run reports it)');
  }
  const resolved = loadSettings(scenario.settings ?? {});
  if (!resolved.ok) {
    throw new Error(
      `scenario "${scenario.name}": invalid settings — ${formatSettingsIssues(resolved.error)}`,
    );
  }
  return scenario;
};

/**
 * The built-in ruleset at `fidelity`, validated the way every other entry point
 * validates it. A failure here is not a scenario failure: it means the shipped
 * catalog is broken (or that `cited-only` was asked for while every row is still
 * a placeholder), so it throws rather than being folded into a run result.
 */
const rulesetForFidelity = (fidelity: Fidelity): RulesetView => {
  const validated = validateRuleset(CATALOG, fidelity);
  if (!validated.ok) {
    const hint =
      fidelity === 'cited-only'
        ? ' — every row of the shipped catalog is a placeholder, so no scenario can run at ' +
          '"cited-only" until rows are sourced (PLAN.md §6.2)'
        : '';
    const details = validated.error.map((error) => JSON.stringify(error)).join('; ');
    throw new Error(
      `scenario runner: the built-in ruleset catalog does not validate at fidelity ` +
        `"${fidelity}"${hint}: ${details}`,
    );
  }
  return validated.value;
};

/**
 * Run `scenario` against `ruleset` — the seam `runScenario` cannot express,
 * because the frozen signature names no ruleset and the built-in catalog is
 * therefore the only one it can reach.
 */
export const runScenarioAgainst = (scenario: Scenario, ruleset: RulesetView): ScenarioRunResult => {
  const builder = createScenarioBuilder(ruleset, scenario.settings ?? {});
  const built = scenario.setup(builder).build();

  if (!built.ok) {
    return {
      name: scenario.name,
      passed: false,
      assertions: [{ ok: false, message: `setup failed: ${describeSetupError(built.error)}` }],
      finalState: undefined,
      hash: undefined,
      events: [],
    };
  }

  const assertions: ScenarioAssertion[] = [];
  const events: GameEvent[] = [];
  let current = built.value;

  // M2 has no active-player field, so the scenario's actor is player 0 by
  // definition; `build()` guarantees the array is not empty, and the check is
  // here so the runner cannot be reached with a world it cannot command.
  const actor = current.players[0]?.id;
  if (actor === undefined) {
    assertions.push({
      ok: false,
      message: 'the scenario world has no players, so no command can be applied to it',
    });
  } else {
    const commands = scenario.run ?? [];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      if (command === undefined) continue;

      const applied = applyCommand(current, actor, command, ruleset);
      if (!applied.ok) {
        assertions.push({
          ok: false,
          message:
            `run[${String(index)}] ${describeCommand(command, current.map)} was refused: ` +
            describeGameError(applied.error),
        });
        break;
      }
      current = applied.value.state;
      events.push(...applied.value.events);
    }
  }

  if (scenario.assert !== undefined) {
    assertions.push(...scenario.assert(current, ruleset));
  }

  // Non-vacuity: a scenario that checks nothing passes forever and detects
  // nothing, which is the failure mode the golden harness refuses on the hashing
  // side. A milestone's acceptance evidence must not be able to pass that way.
  if (assertions.length === 0) {
    assertions.push({
      ok: false,
      message:
        'the scenario asserts nothing, so a passing run would prove nothing; add an `assert` ' +
        'callback (or `run` commands) that checks the rule under test',
    });
  }

  return {
    name: scenario.name,
    passed: assertions.every((assertion) => assertion.ok),
    assertions,
    finalState: current,
    hash: hashValue(current),
    events,
  };
};

/**
 * Run a scenario against the built-in ruleset (`@civts/rules`' `CATALOG`,
 * validated at the fidelity the scenario's settings ask for).
 *
 * Settings are re-checked here as well as in `defineScenario`, because a
 * `Scenario` is a plain object and can be written literally; the runner must not
 * assume the check happened. A failure throws — it is a bug in the scenario, not
 * a result of running it.
 */
export const runScenario = (scenario: Scenario): ScenarioRunResult => {
  const resolved = loadSettings(scenario.settings ?? {});
  if (!resolved.ok) {
    throw new Error(
      `scenario "${scenario.name}": invalid settings — ${formatSettingsIssues(resolved.error)}`,
    );
  }
  return runScenarioAgainst(scenario, rulesetForFidelity(resolved.value.fidelity));
};
