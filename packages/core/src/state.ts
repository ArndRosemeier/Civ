/**
 * Game state assembly — the one place a `GameState` comes into existence.
 * See docs/INTERFACES.md (W3, and M2's "Core — units, movement, fog"),
 * PLAN.md 5.3 (determinism) / 5.4 (data layout) and docs/ENGINE.md (state
 * layout, determinism).
 *
 * Design notes:
 *
 * - **`GameState` is plain, JSON-serialisable data.** No classes, no hidden
 *   state, no derived caches — a save file is the state, verbatim (PLAN.md 4.3).
 * - **All randomness is carried *inside* the state.** `newGame` takes the RNG
 *   state generation returned and stores it, so every future draw is
 *   reproducible from the seed alone.
 * - **Failure is typed, never thrown.** Map generation signals a bad ruleset or
 *   an unhostable map by throwing; `newGame` is the boundary that converts those
 *   into `SetupError` values so callers (CLI, UI, goldens) react to a reason
 *   rather than to a stack trace. The unit-role check runs *before* generation
 *   for the same reason.
 * - **A new game is populated, not empty.** Every civilization gets a settler on
 *   its starting tile and — since M4b — a worker on the first free tile beside it,
 *   plus an `explored` row covering what those units can see, so M2's first legal
 *   action and M4a's first job are both available immediately and the starting
 *   position is never "somewhere in the fog". The barbarian player (M3) is
 *   appended to `players` and gets neither: it is a player identity for the units
 *   a hut will later spawn, not a civilization.
 * - **Money is state, and every player has the fields.** `treasury`, `rates`,
 *   `beakers` and `luxuries` (M4b) live on `PlayerState`, so a save file still *is*
 *   the game and the money loop needs no side table. Barbarians carry them too,
 *   inert, for the same reason they carry an `explored` row: one shape for every
 *   player, and `PlayerId` stays an index into `players`.
 * - **Knowledge is state too (M5).** `techs` (a sorted, unique list) and the
 *   optional `researching` key live on `PlayerState` for the same reason the money
 *   fields do: research is a property of a player, it is hashed with the state, and
 *   it survives a save without a side table. `newGame` writes `techs: []` for every
 *   player and **omits** `researching` — absence is what "not researching" means,
 *   never a key holding `undefined` (see `PlayerState.techs`).
 * - **Resources ride on the map, not on the state (M4c).** `newGame` stores the
 *   generated `GameMap` verbatim, so the resources `generateWorld` placed come
 *   with it — there is no second list here and nothing for setup to re-derive.
 *   That is the same boundary M4a drew the other way round for improvements:
 *   terrain, huts and resources are what the *world* is (generation decides them
 *   once), while improvements, units and cities are what a civilization *did*
 *   (gameplay decides them afterwards). Putting resources on the state would make
 *   `{ ...state, map: generateWorld(...) }` — regenerate the world, keep the
 *   resources — a state nobody could explain.
 */

import { generateWorld, type GeneratedWorld } from './gen.js';
// M9: the one function that decides who owns which tile. `newGame` calls it for the
// (empty) starting layer, so the layer a fresh game carries comes from the same rule
// every later recomputation uses — never from a literal written out here.
import { computeTileOwner } from './borders.js';
// Type-only: `GameState` gains `cities` in M3, and this module never calls into
// `cities.ts` at runtime (the city *helpers* are the callers' business). The
// import is erased, so the type-only edge cannot become a runtime cycle.
import type { City } from './cities.js';
// Value imports, not type-only: `newGame` folds each player's sight into its
// explored row through these, so `fog.ts` stays the single owner of the radius and
// the single writer of the explored layer. There is no runtime cycle — `fog.ts`
// imports `GameState` from here with `import type`, which erases.
import { visibleTiles, withExplored } from './fog.js';
// Type-only: `GameState` gains `improvements` in M4a, and this module never calls
// into `improvements.ts` at runtime (the improvement *helpers* are the callers'
// business). The import is erased, so the type-only edge cannot become a runtime
// cycle — `improvements.ts` imports `GameState` from here the same way.
import type { TileImprovement } from './improvements.js';
import {
  asPlayerId,
  asTileIndex,
  asUnitId,
  type GovernmentId,
  type PlayerId,
  type TechId,
  type TileIndex,
} from './ids.js';
import {
  TERRAIN_BY_ROLE,
  TERRAIN_ROLES,
  neighbors8,
  terrainAtIndex,
  type GameMap,
  type RulesetView,
  type TerrainRole,
} from './map.js';
import { err, ok, type Result } from './result.js';
// M9: the one read of "which government does a new player start under", asked rather
// than restated as a literal here. A `asGovernmentId('despotism')` written in this file
// would be a second opinion about content, and it would be the wrong one the moment the
// catalog's first government row changed.
import { defaultGovernmentOf } from './governments.js';
import type { RngState } from './rng.js';
import { MAP_DIMENSIONS, type Settings } from './settings.js';
// M6: `fullHitPoints` is the one reader of a unit definition's `hitPoints`, so
// `newGame` cannot invent a starting health of its own that disagrees with the value
// `spawnUnit` gives a unit produced during play.
import { fullHitPoints, unitCatalog, type Unit, type UnitDef, type UnitRole } from './units.js';

/**
 * Bumped whenever the persisted shape of `GameState` changes incompatibly.
 *
 * - 1 — M1: terrain, players, RNG.
 * - 2 — M2: adds `nextUnitId`, `units` and `explored`. Additive fields still
 *   change *every* state hash, which is why the goldens were regenerated in the
 *   same commit (INTERFACES.md, "Core — units, movement, fog").
 * - 3 — M3: adds `nextCityId` and `cities` to the state, `kind` to a player and
 *   a barbarian player to the player list, and `huts` to the map. Additive
 *   again, and every hash moves again for the same reason; the goldens were
 *   regenerated intentionally, through the harness's documented path, in the
 *   same commit (INTERFACES.md M3, "State shape").
 * - 4 — M4a: adds `improvements` to the state. Additive a third time — the field
 *   is empty at `newGame`, and an empty array in the hashed JSON is still a new
 *   key, so every existing hash moves. Regenerated intentionally, through the
 *   harness's documented path (`CIVTS_WRITE_GOLDENS=1`), in the same commit, with
 *   a `rehash:` line in the commit message (INTERFACES.md M4a, "Where
 *   improvements live").
 * - 5 — M4b: adds `treasury`, `rates`, `beakers` and `luxuries` to `PlayerState`
 *   (the money loop), and `newGame` now gives every civilization a worker as well
 *   as its settler — a *behavioural* change that moves the starting `units` array
 *   and every player's `explored` row, on top of the four new keys. Regenerated
 *   intentionally, through the harness's documented path, in the same commit, with
 *   a `rehash:` line in the commit message (INTERFACES.md M4b, "State shape").
 * - 6 — M4c: `GameMap` gains `resources`, the sparse `(tile, resource)` list
 *   generation places. The state's *own* fields are unchanged this time — no new
 *   `GameState` key, no new `PlayerState` key — but `map` is inside the state and
 *   is hashed with it, so a new map key moves every hash exactly as a new state
 *   key would, and the version records that deliberately rather than leaving the
 *   change implicit. Additive, a fourth time in a row (the field is a fresh array
 *   of pairs, and an empty-or-not map key is still a new key in the hashed JSON),
 *   so the goldens were regenerated through the harness's documented path
 *   (`CIVTS_WRITE_GOLDENS=1`) in the same commit, with a `rehash:` line
 *   (INTERFACES.md M4c, "Resources" and "Migration owners").
 * - 7 — M5: `PlayerState` gains `techs` (the techs a player knows, sorted by id and
 *   unique) and `researching` (the tech being researched, an **optional** key that is
 *   absent when nothing is being researched). Additive again — two new `PlayerState`
 *   keys, no `GameState` key and no map key — but the state's shape is still what
 *   `canonicalize` hashes, so every golden hash moves and the version records it.
 *   Regenerated intentionally, through the harness's documented path
 *   (`CIVTS_WRITE_GOLDENS=1`) in the same commit, with a `rehash:` line
 *   (INTERFACES.md M5, "Research").
 * - 8 — M6: `Unit` gains `hitPointsLeft` (required in the contract; `units.ts` records
 *   why it is *optional on the engine's view* while `UnitSpec` requires it) plus the two
 *   omitted-when-default keys `experience` and `fortified`. `newGame` writes
 *   `hitPointsLeft` on every unit it places and writes **neither** of the optional two,
 *   because a starting settler has taken no damage, earned no promotion and is not
 *   dug in. That is one new key per starting unit on top of a shape change, so every
 *   golden hash moves and the version records it — regenerated intentionally, through
 *   the harness's documented path (`CIVTS_WRITE_GOLDENS=1`) in the same commit, with a
 *   `rehash:` line (INTERFACES.md M6, "Units in play").
 * - 9 — **M9+M10, one wave and one bump** (INTERFACES.md: "These two milestones share a
 *   state-schema change, so they land as ONE wave: one `SCHEMA_VERSION` bump, one golden
 *   regeneration, one rehash"). Three new keys:
 *
 *   - `City.culture` — accumulated culture, a whole number, never decreasing;
 *   - `PlayerState.government` — required, so every player row gains a key;
 *   - `GameState.tileOwner` — the ownership layer, `width * height` integers, an
 *     all-`-1` row at `newGame`.
 *
 *   The third is the one worth flagging: it is a **dense array of 2 800 entries on the
 *   shipped `tiny` map** inside every hashed state, where every previous schema change
 *   added a handful of keys. It is deliberately not summarised, elided or hashed
 *   separately — a layer that is part of the state is part of the state's identity, and
 *   a save that lost it would be a save whose borders came back from somewhere else.
 *   Regenerated intentionally, through the harness's documented path
 *   (`CIVTS_WRITE_GOLDENS=1`) in the same commit, with a `rehash:` line (INTERFACES.md
 *   M9+M10, "Acceptance evidence": "A played golden that INCLUDES a victory").
 */
export const SCHEMA_VERSION = 9;

/** What a player *is*: a civilization, or the barbarians. */
export type PlayerKind = 'civ' | 'barbarian';

/**
 * The three sliders that divide a civilization's commerce: **tax** to gold,
 * **science** to beakers, **luxury** to luxuries. Each is a number of *tenths* of
 * the commerce split — see `RATE_TOTAL`.
 *
 * The rate rule (integers `>= 0` summing to exactly `RATE_TOTAL`) is stated once,
 * in `economy.ts`'s `ratesProblem`; the command layer refuses a triple that breaks
 * it and the split reads whatever the state carries. Nothing here constrains the
 * numbers: this type is the *shape* of the field, and a state is only as valid as
 * the command that wrote it.
 */
export interface Rates {
  readonly tax: number;
  readonly science: number;
  readonly luxury: number;
}

/**
 * The three rates sum to exactly this — the denominator of the split, which is
 * why the split is exact integer arithmetic.
 *
 * 10 is a **placeholder**: it is unsourced, chosen to be playable (ten slider
 * steps are enough to express a strategy and few enough to see at a glance), and it
 * is **not** a Civ 3 figure — Civ 3's sliders are percentages of a different
 * commerce model entirely, and this engine's split is its own. What it buys here is
 * arithmetic: every rate is a tenth, so each channel's share is
 * `commerce * tenths / 10`, floored, with the remainder to gold (`splitCommerce`).
 */
export const RATE_TOTAL = 10;

/**
 * The rates every player starts with — see `RATE_TOTAL` for the denominator.
 *
 * 6/4/0 is a **placeholder**: it is unsourced and chosen to be playable. Gold is
 * the only channel M4b *acts* on (it pays upkeep and can go bankrupt), so the
 * default leans toward it; science banks beakers for M5's research; luxury is 0
 * because happiness arrives in M9 and luxury commerce spent today would be thrown
 * away with nothing to show for it. It is not a sourced Civ 3 default — Civ 3's
 * starting allocation depends on the government and the difficulty.
 */
export const DEFAULT_RATES: Rates = { tax: 6, science: 4, luxury: 0 };

/**
 * Gold a civilization starts with. 10 is a **placeholder**: it is unsourced and
 * chosen to be playable — with the free unit allowance (`economy.ts`) it is enough
 * to found a first city from a standing start without ever being forced into
 * bankruptcy on turn one, and small enough that a player notices upkeep once the
 * army grows. It is not a sourced Civ 3 figure.
 *
 * Barbarians start with 0: they have no economy at all (INTERFACES.md M4b, "The
 * money loop"), so there is nothing for them to hold.
 */
export const STARTING_TREASURY = 10;

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string; // "Player 1".."Player N" for the civs, "Barbarians" for the rest
  readonly color: string; // '#rrggbb', from a fixed palette, deterministic
  readonly startingTile: TileIndex;
  /**
   * M3: barbarians are a *player* rather than a special case outside the array,
   * because `PlayerId` is the player's index into `players` and `explored` is
   * row-indexed by it. Anything that means "how many civilizations" must ask
   * `civPlayers`, never `players.length` (INTERFACES.md M3, "State shape").
   */
  readonly kind: PlayerKind;
  /**
   * M4b: the player's gold. Income adds, upkeep subtracts, and it **never goes
   * negative** — a treasury that would go below zero floors at 0 and the shortfall
   * is paid by disbanding units (`economy.ts`, `applyEconomy`). A debt field was
   * deliberately not invented: an unpaid shortfall is reported in a
   * `TreasuryShortfall` event, not carried as state.
   *
   * Barbarians hold 0 and never change.
   */
  readonly treasury: number;
  /**
   * M4b: how this player's commerce divides between gold, beakers and luxuries.
   * Written by `SetRates` and read once a turn by `applyEconomy`, which is why a
   * rate change can only affect collections that have not happened yet.
   *
   * Every player carries one, barbarians included, so "the rates sum to
   * `RATE_TOTAL`" is a statement about every row of `players` rather than about
   * some of them; a barbarian's is inert because barbarians have no commerce.
   */
  readonly rates: Rates;
  /**
   * M4b: beakers banked so far. M4b left this **inert** — nothing spent them, so
   * the number accumulated and did nothing — and **M5 spends it**: the research step
   * of the turn pipeline (`tech.ts`) completes the tech being researched when this
   * pool covers its cost, subtracting the cost and leaving the remainder in the pool.
   *
   * It has exactly one *writer* (the money loop's science split) and exactly one
   * *spender* (research), which is what makes the pool unambiguous; the reading that
   * follows from the frozen step order — research reads the pool the *previous*
   * turn's split left, so a tech completes at the start of a turn from beakers banked
   * at the end of the last one — is argued out in full at the top of `tech.ts`.
   */
  readonly beakers: number;
  /**
   * M4b: luxuries banked so far. **Inert in M4b** — nothing reads them until M9
   * (happiness). Same reasoning as `beakers`.
   */
  readonly luxuries: number;
  /**
   * M5: the techs this player knows, **sorted by id (UTF-16 code-unit order) and
   * unique** — the order is part of the contract because the list is inside every
   * state hash, so the same knowledge written in a different order would be a
   * different save.
   *
   * Required and never absent: "knows nothing" is `techs: []`, an *empty array*, the
   * same way "no cities" is an empty `cities` list. `newGame` writes `[]` for every
   * player, barbarians included — one shape for every row of `players`, exactly as
   * M4b gave them all a `treasury` — even though barbarians can never research
   * anything.
   *
   * Every reader goes through `tech.ts`' `knownTechs`, which normalises what it reads
   * (so a hand-written or older save cannot present an unsorted list as canonical) and
   * treats a missing or malformed field as "knows nothing" rather than throwing inside
   * a legality check.
   */
  readonly techs: readonly TechId[];
  /**
   * M5: the tech this player is researching, or **an absent key** when nothing is
   * being researched.
   *
   * Optional, never `ProductionItem | undefined`-style union, and the distinction is
   * load-bearing rather than stylistic — the same argument `City.production` records:
   * with `exactOptionalPropertyTypes` on, `researching?: TechId` makes *absence* the
   * only way to spell "not researching", so `{ ..., researching: undefined }` is a
   * compile error. The other spelling compiles and yields a state `hashValue` throws
   * on, because `canonicalize` refuses `undefined` by design: a key holding `undefined`
   * cannot survive a JSON save/load round trip, so such a state was never genuinely
   * serialisable. That bug class has blocked hashing three times; the type is what
   * stops a fourth.
   *
   * The two writers are `tech.ts`' `withResearching` (set by `SetResearch`) and
   * `withoutResearching` (removed on completion) — one place each, so neither the
   * command layer nor the pipeline can write `undefined` into it by accident.
   */
  readonly researching?: TechId;
  /**
   * M9: the government this player is ruled by — **required**, never absent, and part
   * of every state hash.
   *
   * Required rather than optional for the reason the contract gives it as
   * `PlayerState.government: GovernmentId` (required): every player is *ruled by
   * something*, and an absent field would make "what are this player's rate caps?"
   * unanswerable for exactly the players nobody thought about — which is the shape of
   * bug the M4b note on `rates` describes ("every player carries one, barbarians
   * included, so 'the rates sum to `RATE_TOTAL`' is a statement about every row of
   * `players` rather than about some of them"). Barbarians carry one too, inert, for
   * that same reason: one shape for every row of `players`.
   *
   * `newGame` writes the catalog's **first** government row for every player
   * (`governments.ts`' `defaultGovernmentOf`), which is despotism in the shipped
   * catalog; `SetGovernment` is the only thing that changes it afterwards. A player
   * whose id names a government this ruleset does not describe is read as the default
   * one (`governments.ts`' `governmentOf`) and *reported* by `@civts/sim`'s
   * `government-is-in-catalog` invariant — a save loaded under a different ruleset is a
   * real case, and it should not be a crash inside a legality check.
   */
  readonly government: GovernmentId;
}

export interface GameState {
  readonly schemaVersion: number;
  readonly revision: number; // 0 at newGame; increments on every applied command (M2+)
  readonly turn: number; // 1 at newGame
  readonly seed: number;
  readonly settings: Settings;
  readonly rng: RngState;
  readonly map: GameMap;
  readonly players: readonly PlayerState[];
  /**
   * The id the next created unit will take. Monotonic, never reused, and part of
   * the state so that id assignment is a function of creation order alone.
   */
  readonly nextUnitId: number;
  /** Every unit in the world, sorted by `id` (see `units.ts`). */
  readonly units: readonly Unit[];
  /**
   * The explored layer, one row per player indexed by `PlayerId`, each of length
   * `width * height`. *Visible* tiles are derived from unit positions on demand
   * and never stored — this is the memory of what a player has seen (M2 "Fog").
   *
   * One row per player, barbarians included: `PlayerId` is the index into
   * `players`, and the barbarian player sees nothing (it owns no units at the
   * start), which is exactly an all-false row rather than a missing one.
   */
  readonly explored: readonly (readonly boolean[])[];
  /**
   * The id the next founded city will take. Monotonic, never reused, and part of
   * the state so that id assignment is a function of creation order alone.
   */
  readonly nextCityId: number;
  /**
   * Every city in the world, sorted by `id` (see `cities.ts`). Empty at
   * `newGame`: cities are founded by `FoundCity`, not by setup.
   */
  readonly cities: readonly City[];
  /**
   * Every improvement built on a tile, as a **sparse** list of `(tile, kind)`
   * pairs sorted by `(tile, kind)` with no duplicates (see `improvements.ts`).
   *
   * Empty at `newGame`: nothing is built by setup, and a worker (M4a) is the only
   * thing that will write here. It lives on the *state* rather than on `GameMap`
   * so that regenerating a map cannot silently keep or drop what a civilization
   * built on it — the map is what the world is, this is what was done to it
   * (INTERFACES.md M4a, "Where improvements live").
   *
   * Sparse by design: most tiles never carry an improvement, and a dense array
   * over the largest map would be 32 400 entries of almost entirely nothing.
   * Absence of a pair *is* "nothing here" — there is no sentinel "none" id.
   */
  readonly improvements: readonly TileImprovement[];
  /**
   * M9: the **tile-ownership layer** — one entry per tile, row-major, length
   * `width * height`. `-1` (`borders.ts`' `UNOWNED`) means nobody owns it; any other
   * value is the `PlayerId` that does.
   *
   * ## Why it is on the state and not on `GameMap`
   *
   * `improvements` above establishes the rule: the map is what the world *is*
   * (generation decides terrain, huts and resources), while this is what a
   * civilization *did* to it, and a regenerated map must not inherit the borders of
   * the game it replaced. A border belongs to a player's cities, so it lives beside
   * them.
   *
   * ## A stored value that cannot drift, and why that is not a contradiction
   *
   * The contract is emphatic: "Ownership is recomputed from culture every turn (a pure
   * function of cities + culture), NOT accumulated incrementally — a derived value that
   * is also stored is a value that can drift."
   *
   * Both halves are honoured, and the distinction is exact rather than rhetorical:
   * this field is **not** a second source of truth, it is the *materialised output* of
   * `borders.ts`' `computeTileOwner(state, ruleset)` — a pure function of the cities and
   * their culture that never reads the previous layer. `withOwnership` is its **only
   * writer**, and it calls that function; no command, pipeline step or save loader ever
   * edits an entry by hand, because there is no code path that could. What is stored is
   * therefore not an accumulation but a cache of a pure computation, and the
   * `tile-owner-matches-culture` invariant in `@civts/sim` recomputes the function on
   * every checked state and reports a mismatch by name. **That invariant is what makes
   * this field safe to store**, and it is the reason the materialisation is worth having:
   * every border question in the game (`foreignOwnerAt`, three times a turn) would
   * otherwise walk every city's radius.
   *
   * ## Why a plain `number[]` and not an `Int8Array`
   *
   * The contract offers the choice and asks for the reason. A `number[]` **is** JSON, so
   * the state remains exactly what a save file is (PLAN.md §4.3), and `canonicalize`
   * hashes the same bytes whether the state came from a live game or from
   * `JSON.parse`. An `Int8Array` would hash identically today — the hasher's
   * `numericView` reads it element by element in index order, not as bytes — but it
   * would put a non-JSON value inside `GameState` and would make the state's hash depend
   * on a serializer's byte order the first time anybody reached for one. The layer is
   * also *written* by comparing it element-wise (`sameOwnership`), which is a read no
   * typed array makes cheaper in any way that matters at this size.
   *
   * Required, never absent, and `newGame` writes it — an all-`UNOWNED` layer, since no
   * city exists at setup. A state whose layer is missing or of the wrong length is
   * reported by `tile-owner-length`, and every read here stays total for one.
   */
  readonly tileOwner: readonly number[];
}

export type SetupError =
  | { readonly kind: 'missing-terrain-role'; readonly role: TerrainRole }
  | { readonly kind: 'missing-unit-role'; readonly role: UnitRole }
  | { readonly kind: 'no-valid-starts'; readonly civCount: number }
  | { readonly kind: 'too-few-start-candidates' };

/**
 * Player colours, indexed by player index. A fixed palette (no RNG, no time),
 * so a given seed always paints the same civilization the same colour.
 * Sixteen entries cover the largest supported civilization count
 * (`Settings.civCount` is capped at 16), making the fallback unreachable.
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

/** Colour for player `index`; cycles the palette if a caller exceeds it. */
const playerColor = (index: number): string =>
  PLAYER_COLORS[index % PLAYER_COLORS.length] ?? COLOR_FALLBACK;

/**
 * The barbarian player's name and colour.
 *
 * A fixed colour rather than the next palette entry: the palette belongs to the
 * civilizations, and a barbarian painted in a civilization's colour would make
 * `textview`'s legend and any future minimap lie about who owns a band of
 * warriors. It is distinct from every palette entry, so "every player's colour is
 * unique" still holds.
 */
const BARBARIAN_NAME = 'Barbarians';
const BARBARIAN_COLOR = '#3f3f46';

/**
 * The civilizations in a game — every player that is not the barbarian one.
 *
 * This is the answer to "how many civilizations are there?" (M3: "anything that
 * means 'how many civilizations' must use `civPlayers`, never `players.length`"),
 * and the player list to iterate for anything a civilization does — placing a
 * settler, numbering starts, painting civ colours. `players` stays the full list
 * because `PlayerId` *is* the index into it, which is what makes `explored` and
 * every owner reference line up.
 */
export const civPlayers = (state: GameState): readonly PlayerState[] =>
  state.players.filter((player) => player.kind === 'civ');

/**
 * The first terrain role a ruleset is missing, in the canonical role order
 * (`TERRAIN_ROLES`), or `undefined` when every role generation can emit is
 * available. Checking here — before generation runs — is what turns a thrown
 * generator error into a typed `SetupError`, and it reports the same role the
 * generator would have complained about.
 */
const firstMissingRole = (ruleset: RulesetView): TerrainRole | undefined => {
  for (const role of TERRAIN_ROLES) {
    if (TERRAIN_BY_ROLE(ruleset, role) === undefined) return role;
  }
  return undefined;
};

/**
 * The roles every player starts with. `newGame` places one of these per
 * civilization, in this order, so the **settler** is the role a ruleset must
 * supply — a civilization with no unit at all has no legal action and no game —
 * and the **worker** (M4b) is the role that makes the improvement system
 * reachable from turn one rather than after a city has produced one.
 *
 * Why the worker is *optional* and the settler is not: the two absences are not
 * the same failure. A view with no settler cannot start a playable game, which is
 * what `missing-unit-role` reports. A view with no worker is a game without
 * workers — every M2-era structural ruleset in the tree is exactly that, and the
 * honest reading of "newGame gives each civilization a settler and a worker" is
 * that it places the worker *the ruleset offers*; inventing one, or refusing to
 * start a game over a role nothing can build anyway, would both be worse. The
 * shipped `@civts/rules` catalog defines a worker, so every real game has one.
 */
const STARTING_UNIT_ROLES = ['settler', 'worker'] as const;

/**
 * The first unit of `role` in the ruleset's catalog, or `undefined` when the
 * ruleset provides none. Catalog order is data order, never RNG order, so which
 * unit type becomes the starting unit is deterministic.
 */
const firstUnitOfRole = (ruleset: RulesetView, role: UnitRole): UnitDef | undefined =>
  unitCatalog(ruleset).find((unit) => unit.role === role);

/**
 * Movement a freshly placed starting unit gets: its own type's movement, or 0 for
 * a value the engine cannot use.
 *
 * The same totality rule `units.ts`' `fullMovement` applies to a spawn, restated
 * here because `newGame` builds its units by hand (there is no state to spawn into
 * yet). A fractional or negative budget would otherwise be written straight into
 * the state, where `canonicalize` would reject it and the game would be unhashable
 * before the first turn.
 */
const startingMovement = (def: UnitDef): number =>
  Number.isInteger(def.movement) && def.movement > 0 ? def.movement : 0;

/**
 * Hit points a freshly placed starting unit gets (M6).
 *
 * Full health, which is what "a unit that has just been created" means everywhere else
 * in the engine — `units.ts`' `spawnUnit` sets the same value for the same reason.
 * `newGame` builds its units by hand (there is no state to spawn into yet), so this is
 * one of the two places a *new* unit's health is decided; keeping it consistent with
 * `spawnUnit` is the whole point of it being a named function rather than a literal.
 *
 * The totality rule `fullHitPoints` states applies here too, and for a sharper reason
 * than movement: a `hitPointsLeft` of `0` written into a fresh state would be a live
 * unit at zero hit points — the state M6 says must not exist and `@civts/sim` names as
 * an invariant. A definition the engine cannot read therefore yields 1, never 0.
 */
const startingHitPoints = (def: UnitDef): number => fullHitPoints(def);

/**
 * Whether a land unit may stand on `tile`: the ruleset describes its terrain and
 * that terrain is not impassable.
 *
 * This is the engine's own rule for *entering* a tile — it is exactly what
 * `planMove` refuses on — applied to the one place a unit is placed without a
 * move. Water is excluded because the catalog marks it impassable (a sea unit
 * would need a different rule; `newGame` places settlers and workers, which are
 * not sea units), and an undescribed terrain is excluded for the same reason
 * `production.ts` will not price an item nothing describes.
 */
const standable = (map: GameMap, ruleset: RulesetView, tile: TileIndex): boolean => {
  const terrain = terrainAtIndex(map, Number(tile));
  if (terrain === undefined) return false;
  const def = ruleset.terrains.find((candidate) => candidate.id === terrain);
  return def !== undefined && !def.impassable;
};

/**
 * Where a civilization's second starting unit goes: the first tile, in ascending
 * index order, that is adjacent to its start tile, standable and free.
 *
 * Adjacency rather than the start tile itself because the settler is already
 * standing there, and **occupied is never allowed**: stacking a player's own units
 * is legal in M2 (and `production.ts` relies on it), but a *starting* placement
 * that quietly put two units on one tile would make "every civilization starts
 * with a settler and a worker" true on paper and false on the board. Ascending
 * index order — not `neighbors8`' row-major box order, which starts at the
 * top-left — is what makes the choice reproducible and readable.
 *
 * `undefined` when there is no such tile: see the caller, which places nothing
 * rather than inventing an exception.
 *
 * The shape — "the tile itself if it is free, else the lowest-index free
 * neighbour" — is the one `production.ts`'s own `placementTile` uses for a unit
 * finished in a city. They are two functions rather than one because that one
 * reads a built `GameState` and asks about *other owners'* units, while this runs
 * during state assembly against a set of tiles already claimed; both sort the
 * neighbours ascending, because the chosen tile is part of the state.
 */
const freeNeighbourOf = (
  map: GameMap,
  ruleset: RulesetView,
  start: TileIndex,
  occupied: ReadonlySet<number>,
): TileIndex | undefined => {
  const candidates = [...neighbors8(map, Number(start))].sort((a, b) => Number(a) - Number(b));
  return candidates.find((tile) => !occupied.has(Number(tile)) && standable(map, ruleset, tile));
};

/**
 * A fresh, entirely unexplored fog layer: one row per player, each of length
 * `width * height` so every row is directly indexable by tile.
 *
 * This only allocates the rows. *What gets marked on them* is decided by
 * `fog.ts` alone — see `initialFog` below.
 */
const blankFog = (map: GameMap, players: readonly PlayerState[]): readonly (readonly boolean[])[] =>
  players.map(() => new Array<boolean>(map.width * map.height).fill(false));

/**
 * The fog layer a new game starts with: each player's row is exactly what that
 * player's own units can see, and no more.
 *
 * `fog.ts` owns both halves of this rule — `VISIBILITY_RADIUS` is the only
 * statement of how far a unit sees, and `withExplored` is the only writer of the
 * explored layer — so this *asks* those functions instead of re-deriving a
 * neighbourhood box here. An earlier version kept a second constant
 * (`START_EXPLORED_RADIUS`) and walked the box itself, which made `state.ts` a
 * second writer of the explored layer: two statements of one rule, free to drift
 * apart, and a mismatch would start a game with fog inside a unit's own sight or
 * with memory of tiles it never saw. Now the radius cannot drift, because there is
 * only one of it.
 *
 * Folding `visibleTiles` into `withExplored` is also exactly what the command
 * layer does when a unit moves (`movedState` in `commands.ts`), so a new game and
 * a played turn grow memory by the same mechanism.
 */
const initialFog = (state: GameState): GameState => {
  let current = state;
  for (const player of state.players) {
    current = withExplored(current, player.id, visibleTiles(current, player.id));
  }
  return current;
};

/** `generateWorld` reports how many candidate tiles it found in this shape. */
const FOUND_COUNT = /found (\d+)/;

/**
 * Translate a generation failure into a `SetupError`. `newGame` never lets an
 * exception escape, so this is total.
 *
 * - `found 0` means there was no legal start tile at all — `no-valid-starts`.
 * - Anything else (some candidates, but too few or too clustered for the
 *   requested count) is `too-few-start-candidates`.
 *
 * The final branch is also the landing place for an unexpected generator
 * failure: the `SetupError` union has no "internal error" member, and a
 * *recognisably* failed setup is more useful to a caller than a crash. The two
 * reachable failures above are precise; this fallback only absorbs inputs that
 * `parseSettings` and `MAP_DIMENSIONS` cannot produce.
 */
const classifyGenerationFailure = (cause: unknown, civCount: number): SetupError => {
  const found = cause instanceof Error ? FOUND_COUNT.exec(cause.message)?.[1] : undefined;
  return found === '0'
    ? { kind: 'no-valid-starts', civCount }
    : { kind: 'too-few-start-candidates' };
};

/**
 * Start a new game.
 *
 * `seed` is authoritative for generation; `settings` is stored verbatim in the
 * resulting state (callers that sweep seeds — self-play, goldens — pass the
 * swept seed here rather than mutating settings). Dimensions come from
 * `MAP_DIMENSIONS[settings.mapSize]`, the civilization count from
 * `settings.civCount`.
 *
 * Deterministic: the same `(seed, settings, ruleset)` always yields an equal
 * state. Never throws for a bad ruleset or an unhostable map — those come back
 * as `SetupError` values.
 */
export const newGame = (
  seed: number,
  settings: Settings,
  ruleset: RulesetView,
): Result<GameState, SetupError> => {
  const missingRole = firstMissingRole(ruleset);
  if (missingRole !== undefined) return err({ kind: 'missing-terrain-role', role: missingRole });

  // The units every player starts with are resolved *before* generation, for the
  // same reason the terrain roles are: a ruleset that cannot populate the board
  // should be reported as a typed setup failure, not discovered halfway through
  // assembling a state. The settler is mandatory (M2); the worker is placed only
  // when the ruleset offers one (M4b — see `STARTING_UNIT_ROLES`).
  const startingDefs: UnitDef[] = [];
  for (const role of STARTING_UNIT_ROLES) {
    const def = firstUnitOfRole(ruleset, role);
    if (def === undefined) {
      if (role === 'settler') return err({ kind: 'missing-unit-role', role });
      continue;
    }
    startingDefs.push(def);
  }

  const dimensions = MAP_DIMENSIONS[settings.mapSize];
  const civCount = settings.civCount;

  let world: GeneratedWorld;
  try {
    world = generateWorld(
      { width: dimensions.width, height: dimensions.height, seed, civCount },
      ruleset,
    );
  } catch (cause) {
    return err(classifyGenerationFailure(cause, civCount));
  }

  // Defensive: the generator promises exactly `civCount` starts. If that
  // contract were ever broken, report it as a setup failure rather than
  // assembling a state with the wrong number of players.
  if (world.starts.length < civCount) return err({ kind: 'no-valid-starts', civCount });

  // Player ids are the player's index in `players`, which is also the marker
  // `textview.describe` paints on a start tile; `name` carries the human-facing
  // "Player 1".."Player N" numbering required by INTERFACES.md.
  //
  // M4b: every player carries the money fields, civilizations and barbarians
  // alike. `DEFAULT_RATES` is shared between them on purpose: it is a constant the
  // engine never mutates (a rate change rebuilds the player's object), and one
  // shared value cannot drift from itself.
  const civs: readonly PlayerState[] = world.starts.map((startingTile, index) => ({
    id: asPlayerId(index),
    name: `Player ${String(index + 1)}`,
    color: playerColor(index),
    startingTile,
    kind: 'civ',
    treasury: STARTING_TREASURY,
    rates: DEFAULT_RATES,
    beakers: 0,
    luxuries: 0,
    // M5: a new civilization knows no techs. `[]` rather than an absent field, for
    // the reason `cities` and `improvements` are empty arrays: the key is part of
    // every state hash, and "knows nothing" is a real value, not a missing one.
    // `researching` is deliberately **not** written here: a new player is
    // researching nothing, and that is the *absence* of the key (see `PlayerState`).
    techs: [],
    // M9: every player is ruled by the catalog's first government — despotism in the
    // shipped catalog, and `rules.test.ts` pins that by id so a reordering of the
    // section is a test failure rather than a silent change to every game's opening.
    // Read, never restated: see the `governments.js` import above.
    government: defaultGovernmentOf(ruleset).id,
  }));

  // M3: barbarians are a player, appended after the civilizations, so that
  // `players.length === civCount + 1` and every `PlayerId` is still an index into
  // this array (which `explored` and every `owner` field rely on).
  //
  // They are a player *identity*, not a civilization: they have no homeland and
  // `newGame` gives them no settler (a barbarian settler would be nonsense), and
  // their units only appear later, when a hut spawns a band of them. Their
  // `startingTile` is therefore the map's first goody hut — a real land tile no
  // civilization starts on, and the place M3's barbarians actually come from —
  // falling back to tile 0 only on a degenerate map with no hut at all, where the
  // field is a formality nothing reads. Every "how many civilizations" question
  // goes through `civPlayers`, never through this field or `players.length`.
  const barbarianTile = world.map.huts[0] ?? asTileIndex(0);
  const barbarians: PlayerState = {
    id: asPlayerId(civs.length),
    name: BARBARIAN_NAME,
    color: BARBARIAN_COLOR,
    startingTile: barbarianTile,
    kind: 'barbarian',
    // No economy at all (M4b): 0 gold, and the pools stay 0 because nothing ever
    // adds to them. The fields are present rather than absent because `PlayerState`
    // has one shape for every player — the same reading `explored` takes, where the
    // barbarian gets a row of nothing rather than a missing row.
    treasury: 0,
    rates: DEFAULT_RATES,
    beakers: 0,
    luxuries: 0,
    // M5: one shape for every player, barbarians included — an empty tech list they
    // can never add to, because `applyResearch` skips them exactly as the money loop
    // does. The field is present rather than absent for the same reason `explored`
    // gives them a row of nothing rather than a missing row.
    techs: [],
    // M9: barbarians carry a government too, inert — one shape for every row of
    // `players`, the same reading `rates` and `techs` above take.
    government: defaultGovernmentOf(ruleset).id,
  };
  const players: readonly PlayerState[] = [...civs, barbarians];

  // Every civilization starts with a settler on its own start tile and a worker on
  // the first free standable tile beside it (M4b, "Starting units"); barbarians
  // get nothing, because a barbarian settler would be nonsense and a barbarian
  // worker could only improve land nobody owns.
  //
  // Ids are handed out in creation order (`0..`), so the array is sorted by id by
  // construction and `nextUnitId` is simply how many units exist — no counter to
  // keep in sync and nothing ambient to store. `occupied` starts with every start
  // tile, so a worker can never be placed on a settler — its own or another
  // civilization's.
  const occupied = new Set<number>(civs.map((player) => Number(player.startingTile)));
  const units: Unit[] = [];
  const place = (owner: PlayerId, def: UnitDef, tile: TileIndex): void => {
    units.push({
      id: asUnitId(units.length),
      type: def.id,
      owner,
      tile,
      movementLeft: startingMovement(def),
      // M6: a starting unit begins at full health. `experience` and `fortified` are
      // deliberately **not** written — a fresh settler has earned no promotion and is
      // not dug in, and this state spells both of those facts by the key being ABSENT,
      // never by writing `undefined` or a `0`/`false` placeholder (see `units.ts`).
      hitPointsLeft: startingHitPoints(def),
    });
    occupied.add(Number(tile));
  };

  for (const player of civs) {
    const settler = startingDefs[0];
    if (settler === undefined) continue; // unreachable: the settler is mandatory
    place(player.id, settler, player.startingTile);

    const worker = startingDefs[1];
    if (worker === undefined) continue;
    // A start whose neighbours are all water, impassable or occupied leaves the
    // worker unplaced. That is a defensive branch no generated map reaches (starts
    // are picked on coherent land), and the alternative — stacking the worker on
    // the settler — would break the placement rule this file just stated while
    // claiming to satisfy it.
    const tile = freeNeighbourOf(world.map, ruleset, player.startingTile, occupied);
    if (tile === undefined) continue;
    place(player.id, worker, tile);
  }

  // Fog: one row per player, indexed by `PlayerId`. Each start sees its
  // surroundings; what a unit sees later is derived from its position and folded
  // into these rows by movement (M2 "Fog"). Both the blank rows and the folding
  // go through `fog.ts`, which owns the rule. The barbarian player owns no unit,
  // so `visibleTiles` answers "nothing" for it and its row stays blank — an
  // all-false row is a player that has seen nothing, which is true.
  const seeded: GameState = {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    turn: 1,
    seed,
    settings,
    rng: world.rng,
    map: world.map,
    players,
    nextUnitId: units.length,
    units,
    explored: blankFog(world.map, players),
    // M3: no city exists at setup. `FoundCity` is the only creator, and it takes
    // `nextCityId` as the id — 0 here, so the first city founded in a game is
    // city 0.
    nextCityId: 0,
    cities: [],
    // M4a: nothing is built at setup. Improvements are what a worker does to the
    // world after the game starts (`StartWork`), so the honest starting value is
    // an empty list — and it is an *empty array*, never `undefined`, because the
    // key is part of every state hash and `canonicalize` refuses `undefined`.
    improvements: [],
    // M9: the ownership layer, materialised from a world with no cities. `newGame`
    // writes it **here** rather than leaving it to the first turn, because it is a
    // required key of the state: a hash taken before anybody has moved would otherwise
    // have to spell "no ownership layer", and a state that later grew one would differ
    // from it by a key rather than by a value. The initial layer is
    // `computeTileOwner`'s output for an empty city list, produced by the one function
    // that owns the border rule (`borders.ts`) rather than by an all-`-1` literal
    // written out again here — a literal would be right today and wrong the moment a
    // city could be founded at setup. The empty array immediately below is a
    // placeholder for that one call, two lines down: `computeTileOwner` wants a
    // `GameState`, and `seeded` is the state it is being built into.
    tileOwner: [],
  };

  return ok(initialFog({ ...seeded, tileOwner: computeTileOwner(seeded, ruleset) }));
};
