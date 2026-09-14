/**
 * Borders — the tile-ownership layer, and the one place "who owns this tile" is
 * decided.
 * See docs/INTERFACES.md M9 ("Borders"), PLAN.md §5.3 (determinism) and §5.4
 * (data layout).
 *
 * ## What this module is for
 *
 * M9's contract asks for a map layer — `readonly tileOwner`, `-1` for unowned and
 * otherwise a `PlayerId` — and then states the rule that makes it safe:
 *
 * > Ownership is recomputed from culture every turn (a pure function of cities +
 * > culture), NOT accumulated incrementally — a derived value that is also stored
 * > is a value that can drift.
 *
 * So the module is built around **one pure function**, `computeTileOwner`, which
 * answers "what should the ownership layer be?" from the cities and their culture
 * alone. Everything else here is a read of that answer or the act of writing it
 * into a state, and the whole engine asks *this* module rather than re-deriving a
 * radius or a threshold:
 *
 * - `planFoundCity` refuses a site on another player's tile (`foreignOwnerAt`);
 * - `planSetWorkedTiles` refuses a tile another player owns (`foreignOwnerAt`);
 * - `autoAssignWorkedTiles` skips such a tile, so a growing city never takes one;
 * - `production.ts`, `economy.ts` and `cities.ts` need nothing: the ownership layer
 *   reaches them through `workedTiles`, which is already validated.
 *
 * That is the keystone discipline the contract names — "all enforced in ONE place
 * and asked from everywhere" — and it is why the foreign-ownership test is a
 * function here rather than an `if` at each of the three sites.
 *
 * ## Why the thresholds are catalog values and not constants here
 *
 * `claimedRadius` reads `BorderDef.borderRadius2Culture` / `borderRadius3Culture`, which
 * `@civts/rules` ships as `placeholder(...)` rows and `RulesetPatch.culture` can
 * move. The standing requirement's third clause is explicit that every magnitude a
 * system introduces lives in the catalog so it can be swept, and M6b had to
 * retrofit exactly this for combat; a border threshold written as a literal here
 * would be that debt a second time. `cultureRulesOf` is the single read of the
 * section, total over a view that declares none (the degenerate rule below).
 *
 * ## Determinism
 *
 * - Cities are visited in a **stated** order: culture descending, then city id
 *   ascending. The id half is the contract's tie-break in as many words ("ties go
 *   to the LOWER city id — never to iteration order, because M5 proved
 *   catalog/iteration order is a real input to behaviour").
 * - Tiles are visited in ascending index order inside a radius, because
 *   `cityRadius` emits them that way.
 * - Nothing here reads the RNG, a clock or the environment, and no integer here is
 *   ever a fraction: culture, radii and thresholds are whole numbers.
 *
 * ## `tileOwner` is stored as a plain `number[]`, and why
 *
 * The contract offers the choice — "store it as a plain array of numbers when
 * serializing, never as a typed array with implicit byte order, and say which you
 * chose and why" — and this module chooses the plain array for the *state itself*,
 * not merely for serialization. A `number[]` **is** JSON, so the state stays
 * exactly what a save file is (PLAN.md §4.3: "a save file is the state, verbatim")
 * and `canonicalize` hashes the same bytes whether the state came from a live game
 * or from `JSON.parse`. An `Int8Array` would hash identically **today** — the
 * hasher's `numericView` reads it element by element in index order, not as bytes —
 * but it would put a non-JSON value inside `GameState`, which is the property this
 * project has leaned on three times (settings, goldens, the save panel) and which
 * an endianness-dependent serializer would break the first time somebody reached
 * for one.
 */

import type { City } from './cities.js';
import type { PlayerId, TileIndex } from './ids.js';
import { inBounds, indexToX, indexToY, isLandAt, tileIndex, type RulesetView } from './map.js';
import type { GameState } from './state.js';

/**
 * The ownership layer's "nobody owns this tile" value.
 *
 * `-1` rather than `undefined`, `null` or a sentinel `PlayerId`, because the layer
 * is an array of **numbers** in the state and because a hole in a JSON array cannot
 * survive a save/load round trip as the same thing (it becomes `null`, which
 * `canonicalize` refuses). It cannot collide with a real player: ids are indices
 * into `state.players` and start at 0.
 */
export const UNOWNED = -1;

/**
 * **The border magnitudes a ruleset declares** — the engine's structural view of
 * `@civts/rules`' `BorderSpec`, minus `provenance` (a field the engine never reads),
 * exactly as `CaptureDef` mirrors `CaptureSpec` and `CombatDef` mirrors `CombatSpec`.
 *
 * Two numbers, and both of them are the contract's:
 *
 * The two fields carry the **catalog's own names** (`borderRadius2Culture` /
 * `borderRadius3Culture`) rather than a shorter engine spelling, deliberately: they are read
 * straight out of `CultureSpec` by name, and two names for one number is the drift this
 * codebase's discipline exists to prevent. "Which row does this come from?" is answerable by
 * reading the field.
 *
 * - `borderRadius2Culture` — the city culture at which the claimed radius becomes 2;
 * - `borderRadius3Culture` — the city culture at which it becomes 3.
 *
 * "Radius 1 at culture 0" is **not** a field, deliberately: it is the rule's floor,
 * not a magnitude. A sweepable "radius 1 threshold" that could be set above zero
 * would describe a city with no territory at all, which is a different rule rather
 * than a different number — the same distinction `cities.ts` draws between
 * `capturedPopulation`'s arithmetic (the floor and the minimum of one citizen) and
 * its divisor (the sweepable knob).
 */
export interface BorderDef {
  /** City culture at which the claimed radius becomes 2 (integer `>= 1`). */
  readonly borderRadius2Culture: number;
  /** City culture at which the claimed radius becomes 3 (integer `>= 1`). */
  readonly borderRadius3Culture: number;
}

/**
 * **What the borders do when the ruleset declares no culture section.**
 *
 * A *degenerate* rule, deliberately unlike the shipped table and deliberately not a
 * second copy of it: both thresholds are the largest safe integer, so **every** city
 * claims radius 1 for ever and no city ever reaches radius 2. That is the least
 * territorial reading of "this ruleset says nothing about culture" — the exact
 * counterpart of `NO_CAPTURE_RULES`' "a sack costs the city no citizens".
 *
 * **Why not the shipped numbers?** Because a fallback that reproduced today's values
 * would be the dual-source bug M6b and M7 exist to remove, wearing a new costume:
 * moving the catalog's `borderRadius2Culture` would then leave every border that arrived
 * through a section-less view — a hand-built fixture, an M2-era structural view, a
 * foreign object — expanding on a number nobody can see or sweep. An absent section
 * must *change what borders do*, and `borders.test.ts` asserts that it does.
 *
 * A real game never meets this: `validateRuleset` requires the catalog's `culture`
 * section, so every state built through `newGame` claims tiles under declared rules.
 */
export const NO_BORDER_RULES: BorderDef = {
  borderRadius2Culture: Number.MAX_SAFE_INTEGER,
  borderRadius3Culture: Number.MAX_SAFE_INTEGER,
};

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A positive whole threshold, or `undefined` for anything this engine cannot read. */
const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;

/**
 * **The border magnitudes a ruleset declares** — the one read of them.
 *
 * The section is read *structurally*, through `unknown`, exactly as `combatRulesOf`
 * reads a view's `combat` and `captureRulesOf` reads a view's `capture`:
 * `RulesetView` (in `map.ts`) is the engine's structural view and does not declare
 * `culture`, while `@civts/rules`' validated `Ruleset` carries it, and a hand-built
 * fixture may carry anything at all. Reading it this way means the numbers reach a
 * border from content without this package depending on `rules`, and without a cast.
 *
 * **Absent is not "use the shipped values"** — see `NO_BORDER_RULES`. A value that
 * is present but unreadable (a string, a fraction, a zero, a negative) reads as the
 * degenerate threshold rather than as a `NaN` that would poison `claimedRadius` and
 * then the ownership layer and then every state hash.
 *
 * A section whose two thresholds are *inconsistent* (radius 3 reached before radius
 * 2) is a data error, and it is `validateRuleset`'s to report — not this reader's,
 * which stays total: `claimedRadius` simply never observes radius 2, because the
 * radius-3 test is asked first.
 */
export const cultureRulesOf = (ruleset: RulesetView): BorderDef => {
  const view: unknown = ruleset;
  const section = isRecord(view) ? view['culture'] : undefined;
  if (!isRecord(section)) return NO_BORDER_RULES;

  return {
    // Read by the **catalog's own field names** — `CultureSpec.borderRadius2Culture` /
    // `borderRadius3Culture`, which `validateRuleset` checks — and `BorderDef` carries those
    // same names for exactly this reason: a reader that looked for a shorter spelling would
    // find nothing in a section that declares these, and would silently return the degenerate
    // threshold instead. Every city would then claim radius 1, and a fixture written to test a
    // two-ring border would test a one-ring border while every threshold assertion still
    // passed. That is what happened while this wave was being built; `NO_BORDER_RULES`' own
    // doc, and the M9 check in `m9-m10-adversarial.test.ts`, are what make it impossible to
    // confuse again.
    borderRadius2Culture:
      positiveInteger(section['borderRadius2Culture']) ?? NO_BORDER_RULES.borderRadius2Culture,
    borderRadius3Culture:
      positiveInteger(section['borderRadius3Culture']) ?? NO_BORDER_RULES.borderRadius3Culture,
  };
};

/**
 * The radius a city of `culture` culture claims, as a whole number of tiles of
 * Chebyshev distance: 1 below `rules.borderRadius2Culture`, 2 below `rules.borderRadius3Culture`,
 * 3 from `rules.borderRadius3Culture` up.
 *
 * The three-row table in INTERFACES.md M9, written once. Culture the engine cannot
 * read (a fraction, a negative, `NaN`) is read as `0` — the same totality rule every
 * other numeric read in this codebase takes — so a hand-built state claims the
 * radius-1 ring rather than a radius decided by an artefact.
 *
 * The radius-3 test is asked **first**, so an inconsistent catalog (3 before 2)
 * degrades to "radius 3 counts as 2", never to a radius that is neither.
 */
export const claimedRadius = (rules: BorderDef, culture: number): number => {
  const whole = Number.isInteger(culture) && culture > 0 ? culture : 0;
  if (whole >= rules.borderRadius3Culture) return 3;
  if (whole >= rules.borderRadius2Culture) return 2;
  return 1;
};

/**
 * **The ownership layer for `state`, as a pure function of its cities and their
 * culture** — the one statement of the border rule, and the definition the stored
 * `GameState.tileOwner` must always equal.
 *
 * Per city, in the stated order:
 *
 * 1. **Culture descending.** The contract's rule is "a tile inside two cities' ranges
 *    belongs to the city with MORE culture", so the strongest claimant goes first and
 *    keeps what it takes.
 * 2. **City id ascending.** The contract's tie-break, named as such: "ties go to the
 *    LOWER city id — never to iteration order, because M5 proved catalog/iteration
 *    order is a real input to behaviour". Sorting by id makes the tie-break a
 *    property of the *data*, not of how `state.cities` happens to be ordered; a
 *    hand-built state whose list is shuffled therefore still computes the same layer,
 *    which is what makes the `tile-owner-matches-culture` invariant meaningful rather
 *    than a tautology about array order.
 * 3. **Tile index ascending** inside the radius, which is `cityRadius`' own order.
 *
 * A tile already claimed is **not** re-claimed, which is the whole of "more culture
 * wins": the cities that could take it later have strictly less culture, or equal
 * culture and a higher id, and neither may take it from the holder.
 *
 * The result is a fresh array of length `width * height`. A city whose centre is off
 * the map claims nothing (`cityRadius` answers `[]`), and a state whose `map` carries
 * no tiles at all yields an empty array rather than throwing.
 */
export const computeTileOwner = (
  state: GameState,
  ruleset: RulesetView,
  cities: readonly City[] = state.cities,
): readonly number[] => {
  const rules = cultureRulesOf(ruleset);
  const owner = new Array<number>(state.map.width * state.map.height).fill(UNOWNED);

  const claimants = [...cities].sort(
    (a, b) => wholeCulture(b.culture) - wholeCulture(a.culture) || Number(a.id) - Number(b.id),
  );

  for (const city of claimants) {
    const radius = claimedRadius(rules, city.culture);
    for (const tile of radiusTiles(state, city.tile, radius)) {
      const index = Number(tile);
      if (owner[index] !== UNOWNED) continue;
      owner[index] = Number(city.owner);
    }
  }

  return owner;
};

/**
 * The tiles within `radius` of `centre`, in ascending index order — `cityRadius`'
 * own shape, generalised over the radius.
 *
 * `cityRadius` is `CITY_RADIUS`-shaped (a square with its four corners cut, 21 tiles
 * at radius 2) and is the definition of "the tiles a city works", which must not
 * change with culture: a city's *working* radius is M3's and is fixed. What culture
 * grows is the *claimed* radius, and it is the same shape one or two rings wider.
 *
 * The centre is included at every radius — it is the tile the city stands on, and a
 * border that excluded its own city would be a claim on the fields around a hole.
 * The four corners of the box are cut at every radius, exactly as `cityRadius` cuts
 * them: a claim ring with its corners would take a tile diagonally two tiles away
 * while missing the orthogonal one beside it, which reads as a bug even though it is
 * a shape.
 *
 * Row-major by construction (the `dy`/`dx` loops walk the box in index order), so the
 * caller's "first writer wins" is a function of the data. An off-map centre claims
 * nothing: `inBounds` answers `false` for the whole box and the answer is `[]`, the
 * same reading `cityRadius` takes.
 */
const radiusTiles = (state: GameState, centre: TileIndex, radius: number): readonly TileIndex[] => {
  const out: TileIndex[] = [];
  const { width } = state.map;
  const cx = indexToX(state.map, Number(centre));
  const cy = indexToY(state.map, Number(centre));
  if (!inBounds(state.map, cx, cy)) return out;

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (Math.abs(dx) === radius && Math.abs(dy) === radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(state.map, x, y)) continue;
      out.push(tileIndex(width, x, y));
    }
  }
  return out;
};

/** A city's culture as a whole number, read totally (0 for anything else). */
const wholeCulture = (culture: number): number =>
  Number.isInteger(culture) && culture > 0 ? culture : 0;

/**
 * `state` with its ownership layer recomputed from culture — **the only writer of
 * `GameState.tileOwner`**.
 *
 * Three call sites, and saying which is the point of the function existing:
 * `commands.ts` after a city is founded or a city changes hands (`FoundCity`,
 * `AttackUnit`'s capture), and `turn.ts` after the culture step, because culture
 * grows every turn and a threshold can be crossed on any of them. `barbarians.ts`
 * reaches the capture site the same way a player does — the barbarian step applies
 * its sacks through `applyCommand` — so no fourth site is needed.
 *
 * **A state whose layer is already right is returned as the same object.** Not a
 * micro-optimisation for its own sake: `tileOwner` is inside every state hash, and
 * returning a fresh array on every command would make `revision`-based comparisons
 * and object-identity checks in the planner see churn where nothing moved. The
 * comparison is element-wise over the same length, so it is also the check that the
 * previous state *had* a well-formed layer.
 */
export const withOwnership = (state: GameState, ruleset: RulesetView): GameState => {
  const next = computeTileOwner(state, ruleset);
  const previous = state.tileOwner;
  if (sameOwnership(previous, next)) return state;
  return { ...state, tileOwner: next };
};

/** Element-wise equality of two ownership layers (length first). */
export const sameOwnership = (a: readonly number[] | undefined, b: readonly number[]): boolean => {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * The **civilization** that owns `tile`, or `undefined` when nobody does.
 *
 * The barbarians are a player (M3) and own tiles like anybody else, so this answers
 * with their id when they hold ground — from a captured city, the one way they can.
 * "Is this tile somebody *else's*?" is `foreignOwnerAt` below, which is the question
 * the two rules actually ask.
 *
 * A tile off the map, a fractional index, or an index the layer does not cover
 * answers `undefined` — "nobody owns a tile that is not there", which is the total
 * reading the same `inBounds` discipline gives every other tile read.
 */
export const ownerAt = (state: GameState, tile: TileIndex): PlayerId | undefined => {
  const index = Number(tile);
  if (!Number.isInteger(index) || index < 0 || index >= state.tileOwner.length) return undefined;
  const owner = state.tileOwner[index];
  if (owner === undefined || owner === UNOWNED) return undefined;
  return owner as PlayerId;
};

/**
 * **The one implementation of "this tile belongs to somebody else"** — the rule two
 * laws are built on:
 *
 * > a city may not be founded on a tile owned by another player;
 * > a tile owned by another player may not be WORKED by your city.
 *
 * Asked by `planFoundCity`, `planSetWorkedTiles` and `autoAssignWorkedTiles`, so the
 * three cannot disagree about what "foreign" means. That is the contract's "all
 * enforced in ONE place and asked from everywhere", and it is why this is a function
 * and not an `owner !== playerId` comparison written three times.
 *
 * **A tile owned by a player the state does not contain is foreign to everyone**,
 * including to a caller whose own id is missing: the alternative — treating an
 * unresolvable owner as "yours" — would let a corrupt state hand land to anybody.
 * `@civts/sim`'s `tile-owner-is-a-player` invariant is what reports such a layer;
 * this read stays total.
 *
 * **Units may cross foreign territory.** There is deliberately no check in
 * `planMove`: M9's contract says so in as many words ("units MAY cross foreign
 * territory (there is no war-declaration system at alpha; say so at the rule site
 * rather than pretending the omission is a design choice)"), and this is that rule
 * site. A border is a claim on *land use* — settlement and tile-work — not a wall;
 * whether crossing one should require a declaration of war is a diplomacy feature
 * this alpha does not have, and the omission is named here rather than left for a
 * reader to infer from a missing `if`.
 */
export const foreignOwnerAt = (
  state: GameState,
  tile: TileIndex,
  playerId: PlayerId,
): PlayerId | undefined => {
  const owner = ownerAt(state, tile);
  if (owner === undefined) return undefined;
  return owner === playerId ? undefined : owner;
};

/*
 * **There used to be a `claimedLandCount` here, and it was deleted (Q3's F3 residue).**
 *
 * It counted the entries of `tileOwner` that are not `UNOWNED` — the union of every city's
 * claim — and its doc comment called that "the denominator of the domination victory's land
 * share". Both halves were wrong for a reader: the domination rule divides by the **map's**
 * land (`map.ts`' `landTileCount`, and the AMENDMENT at the end of `docs/INTERFACES.md` rules
 * that the *map's* land is the correct denominator), and **nothing in the repository called
 * the function at all** (`grep -rn "claimedLandCount" --include=*.ts .` matched only its own
 * declaration). An exported helper with no reader whose comment states a rule the engine does
 * not implement is a trap for the next reader — the cost of keeping it is a future agent
 * "wiring it up" because it looks like the missing piece. It is deleted rather than reworded,
 * and this note is what a `git log -S` would otherwise have to explain.
 *
 * The numerator the rule does use is `ownedLandTiles` below, and it stays.
 */

/**
 * **How many tiles `playerId` owns** — every claimed tile, land and water alike.
 *
 * Read straight off the ownership layer: it counts the entries of `tileOwner` that name this
 * player, and it is **not** filtered by terrain. A claim is a geometric disc
 * (`computeTileOwner` above has no terrain filter), so a city on the coast claims its bay as
 * well as its fields — measured on real AI-played games, water is not a rare corner case: it is
 * about 40 % of every border in play (see `ownedLandTiles` below for the figures and the
 * instrument).
 *
 * `repl.ts` reads it for the "your borders reach N tiles" line, which is a statement about the
 * border rather than about the victory rule, and there the all-terrain reading is the right
 * one. **The victory rule does not read it**: `ownedLandTiles` is the domination numerator, so
 * the name of this function is the only thing about it that says "land".
 */

/**
 * **How many of `playerId`'s owned tiles are LAND** — the numerator of the domination
 * victory's land share, and the count that makes the numerator and the denominator the same
 * *kind* of thing.
 *
 * `landTileCount(state.map, ruleset)` is the denominator: the map's land. Counting owned
 * *water* in the numerator would compare two different quantities — a player could hold a third
 * of the world's land and reach the threshold on the strength of the sea inside its borders —
 * and every document, the AMENDMENT at the end of `docs/INTERFACES.md` included, states the
 * rule as a share of the map's land. So this asks `isLandAt` (`map.ts`) of every owned tile:
 * **one predicate**, the same one `landTileCount` counts with, so the numerator and the
 * denominator cannot come to different views of what land is. It used to carry a private copy of
 * that three-line rule (Q3's F5, R2's R2-F3); the copy is deleted and this is what replaced it.
 *
 * A layer of the wrong length (a hand-built state) counts what is there rather than throwing,
 * and answers `0` for a layer that is absent — the total reading `@civts/sim`'s invariants
 * report properly. `tileOwner` indices outside the map's terrain are not land, which is
 * `isLandAt`'s own answer for a tile nobody can describe.
 *
 * **How much this differs from `ownedLandCount` is a measurement, not a guess**
 * (`scripts/probes/land-numerator-probe.ts`): over eight AI-played `tiny` games at 200 turns,
 * 713 of 1,793 owned tiles — 39.8 % — were water, so the two numbers are far apart in play even
 * though the rule's *verdict* has never turned on the difference.
 */
export const ownedLandTiles = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): number => {
  const id = Number(playerId);
  let total = 0;
  for (let index = 0; index < state.tileOwner.length; index += 1) {
    if (state.tileOwner[index] !== id) continue;
    if (isLandAt(state.map, ruleset, index)) total += 1;
  }
  return total;
};
export const ownedLandCount = (state: GameState, playerId: PlayerId): number => {
  const id = Number(playerId);
  let total = 0;
  for (const owner of state.tileOwner) if (owner === id) total += 1;
  return total;
};
