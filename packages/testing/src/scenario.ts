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
 *   city already has, more worked tiles than citizens — has **no** member in
 *   `SetupError`. Those throw a descriptive `Error` at the offending call where
 *   the world already knows the answer, and at `build()` for the checks that need
 *   the assembled map (terrain under a hut, the geometry of a worked tile).
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
  MAP_DIMENSIONS,
  MIN_CITY_DISTANCE,
  SCHEMA_VERSION,
  TERRAIN_BY_ROLE,
  applyCommand,
  asCityId,
  asPlayerId,
  asTileIndex,
  asUnitId,
  autoAssignWorkedTiles,
  buildingDef,
  cityRadius,
  distance8,
  err,
  inBounds,
  indexToX,
  indexToY,
  itemCostOf,
  loadSettings,
  ok,
  seedRng,
  tileIndex,
  unitCatalog,
  unitDef,
  type BuildingId,
  type City,
  type CityId,
  type Command,
  type Fidelity,
  type GameError,
  type GameEvent,
  type GameMap,
  type GameState,
  type PlayerKind,
  type PlayerState,
  type ProductionItem,
  type Result,
  type RulesetView,
  type Settings,
  type SettingsIssue,
  type SetupError,
  type TerrainId,
  type TerrainRole,
  type TileIndex,
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
  addUnit(playerIndex: number, type: UnitTypeId, at: readonly [number, number]): ScenarioBuilder;
  /** State a city outright (M3) — the only way a scenario can have a queue at all. */
  addCity(playerIndex: number, at: readonly [number, number], options?: CitySetup): ScenarioBuilder;
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

/** A player the scenario asked for: its name and whether it is a civilization. */
interface PlayerPlacement {
  readonly name: string;
  readonly kind: PlayerKind;
}

/** A goody hut the scenario asked for, in the coordinates it was written in. */
interface HutPlacement {
  readonly x: number;
  readonly y: number;
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
    map: { width: world.width, height: world.height, terrain, huts },
    players,
    nextUnitId: units.length,
    units,
    explored,
    nextCityId: 0,
    cities: [],
  };

  // Cities, in creation order, so ids are dense and `cities` stays sorted by id.
  // A city is added to a *working* state before its worked tiles are resolved, so
  // `autoAssignWorkedTiles` and `cityRadius` can see it (the same order
  // `FoundCity` writes: create the city, then assign its citizens) and so each
  // city's claims are visible to the next one's assignment.
  let state = base;
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

  const builder: ScenarioBuilder = {
    addPlayer(name) {
      if (name.trim() === '') {
        throw new Error('scenario builder: addPlayer needs a non-empty name');
      }
      world.players.push({ name, kind: 'civ' });
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
      world.players.push({ name, kind: 'barbarian' });
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
