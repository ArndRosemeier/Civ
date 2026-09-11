/**
 * Rules data catalogues, with mandatory provenance. See PLAN.md 6.1 / 6.2.
 *
 * Content is plain immutable data referencing ids. `loadRuleset` validates the
 * whole graph once at startup; everything downstream then works by id. This is
 * what makes later "Civ 3-exact number packs" possible without engine changes.
 *
 * NOTE: values here are PLACEHOLDER (tuned), not claimed Civ 3-accurate.
 */

import {
  BUILDING_EFFECT_KINDS,
  IMPROVEMENT_KINDS,
  RESOURCE_KINDS,
  TERRAIN_ROLES,
  UNIT_ROLES,
  asBuildingId,
  asImprovementId,
  asResourceId,
  asTechId,
  asTerrainId,
  asUnitTypeId,
  err,
  isPlaceholder,
  ok,
  placeholder,
  cited,
  type BuildingDef,
  type BuildingEffect,
  type BuildingEffectKind,
  type Fidelity,
  type ImprovementDef,
  type ImprovementKind,
  type Provenance,
  type ResourceDef,
  type ResourceKind,
  type Result,
  type TechDef,
  type TechId,
  type TerrainId,
  type TerrainRole,
  type UnitDef,
  type UnitRole,
} from '@civts/core';

/**
 * The unit roles, re-exported so content code and the engine agree by
 * construction: `UnitRole` is a `core` concept (it appears in `SetupError`), and
 * duplicating the list here would let the two drift.
 */
export { UNIT_ROLES };
export type { UnitRole };

/**
 * The improvement kinds and their ids, re-exported from `core` for the same
 * reason: `ImprovementKind` is a `core` concept (the engine's structural
 * `ImprovementDef` carries it), so a second list here would be a second answer to
 * "what may a worker build?" — free to drift from the one `validateRuleset` and
 * the engine actually use. Content code and the engine therefore cannot disagree
 * about the set of kinds by construction.
 */
export { IMPROVEMENT_KINDS };
export type { ImprovementKind };

/**
 * The resource kinds and the building-effect kinds, re-exported from `core` for
 * exactly the reason above: the engine's structural views (`ResourceDef`,
 * `BuildingEffect`) carry them, `validateRuleset` refuses a row whose kind is not
 * in the list, and the engine's readers switch on the same names. A second list
 * here would be a second answer to "what may a resource be?" and "what may a
 * building do?", free to drift from the one the engine actually implements.
 */
export { RESOURCE_KINDS, BUILDING_EFFECT_KINDS };
export type { ResourceKind, BuildingEffect, BuildingEffectKind };

export interface Yields {
  readonly food: number;
  readonly shields: number;
  readonly commerce: number;
}

export interface TerrainSpec {
  readonly id: TerrainId;
  /**
   * The engine role this terrain fills. Generation asks the ruleset for terrain
   * *by role* (`TERRAIN_BY_ROLE`), so the role is data the ruleset must carry —
   * not something derivable from the id at the call site. With it, a validated
   * `Ruleset` is structurally a `RulesetView`.
   */
  readonly role: TerrainRole;
  readonly name: string;
  /** Movement points consumed when entering. Ignored when `impassable`. */
  readonly moveCost: number;
  /** Percentage defense bonus, e.g. 50 means +50%. */
  readonly defenseBonusPct: number;
  readonly yields: Yields;
  readonly impassable: boolean;
  readonly provenance: Provenance;
}

export interface Catalog {
  readonly terrains: readonly TerrainSpec[];
  readonly units: readonly UnitSpec[];
  /**
   * The building catalog. Required, like `units`: a catalog that ships no
   * buildings says so with `buildings: []`, which validation rejects as an
   * empty catalog — exactly the treatment an empty unit or terrain catalog
   * gets. Buildings are what M3 production spends shields on, and every row
   * carries provenance like every other rules row (PLAN.md §6.2).
   */
  readonly buildings: readonly BuildingSpec[];
  /**
   * The improvement catalog. Required, like `units` and `buildings`, and for the
   * same reason: `RulesetView.improvements` is required, because M4a's
   * `cityYields` reads it for every worked tile — so a catalog that left it out
   * would not be a view the engine could compute city output from. A catalog that
   * ships no improvements says so with `improvements: []`, and validation rejects
   * that as an empty catalog like any other (PLAN.md §6.2).
   */
  readonly improvements: readonly ImprovementSpec[];
  /**
   * The resource catalog. Required, like the three catalogs above, and for the
   * same reason with one M4c twist: `RulesetView.resources` is *optional* (an
   * old structural view is still a valid view), but a **catalog** that omits it
   * would be content that silently ships nothing where the milestone asks for
   * resources — so a catalog says `resources: []` and validation rejects that as
   * an empty catalog, exactly as it does for units, buildings and improvements
   * (PLAN.md §6.2).
   */
  readonly resources: readonly ResourceSpec[];
  /**
   * The tech tree. Required, like the four catalogs above, and for the same reason
   * with the M4c resource twist: `RulesetView` does not *declare* `techs` (the
   * engine reads the tree through `core/tech.ts`'s `techCatalog`, which is total
   * and treats "no tech catalog" as "no techs"), but a **catalog** that omitted it
   * would be content that silently ships no research where the milestone asks for
   * a tree — so a catalog says `techs: []` and validation rejects that as an empty
   * catalog, exactly as it does for units, buildings, improvements and resources
   * (PLAN.md §6.2).
   */
  readonly techs: readonly TechSpec[];
}

/**
 * A unit type. As with terrain, the numbers are **placeholder** until a row is
 * traced to a source (PLAN.md §6.2): every M2 row is `placeholder(...)`, and
 * `cited-only` validation rejects them.
 *
 * It `extends` the engine's structural `UnitDef` (minus provenance) rather than
 * restating its fields: that is the compile-time proof that what the content
 * package ships is what the engine reads — a renamed or retyped field in
 * `UnitDef` breaks this declaration instead of breaking a far-away call site.
 * The only thing content adds is `provenance`, which is required, so a spec
 * without it does not compile — the honesty rule is enforced by the compiler,
 * not by review.
 */
export interface UnitSpec extends UnitDef {
  readonly provenance: Provenance;
}

/**
 * A building type — what a city's shields can be spent on besides units, what it
 * costs its owner every turn once it stands, and what it does for the city that
 * holds it.
 *
 * M3 needed exactly one number from this row: `cost`, the shields
 * `production.itemCost` charges for `{ kind: 'building', id }`. **M4c adds the
 * three fields that make a building more than a shield sink**, and all three are
 * required so a row cannot quietly do nothing:
 *
 * - **`maintenance`** — gold the building costs its owner per turn, read by the
 *   money loop (`economy.ts`, which summed a structurally-declared `maintenance`
 *   during M4b precisely so this wave could fill it in). It must be a
 *   non-negative integer; `0` is how a row says "this one is free", which is a
 *   tuning choice rather than a missing value.
 * - **`effects`** — what the building does to **its own city** (see
 *   `core`'s `BuildingEffect`). Multipliers are integer percentages applied with
 *   a floor, and several of a kind in one city sum before a **single** floor.
 *   A row with `effects: []` is legal and means "this building currently does
 *   nothing but cost shields and gold" — an honest row for content whose real
 *   effect belongs to a later milestone, and better than inventing one.
 * - **`wonder`** — `true` marks a **wonder**: globally unique (once any city
 *   anywhere holds it, no city may start it), and never destroyed in M4c, so
 *   "unique" and "never rebuilt" are the same rule. A wonder costs maintenance
 *   like any other building, which is the one way it can be lost: bankruptcy
 *   disbands it and it becomes buildable again. Optional and `true`-only — with
 *   `exactOptionalPropertyTypes`, "not a wonder" is the *absence* of the key,
 *   never a key holding `false` (a `false` in a JSON catalog is rejected by
 *   validation).
 *
 * As with `UnitSpec`, the row `extends` the engine's structural `BuildingDef`
 * (see `cities.ts`) so the compile-time proof that content ships what the engine
 * reads is the type itself, and `provenance` is required — a row without one
 * does not compile.
 */
export interface BuildingSpec extends BuildingDef {
  /** Gold per turn this building costs its owner; integer `>= 0`. */
  readonly maintenance: number;
  /** What it does for its own city; `[]` is "nothing yet", not "unknown". */
  readonly effects: readonly BuildingEffect[];
  /** Present (and `true`) only for a wonder. Absent means "ordinary building". */
  readonly wonder?: true;
  readonly provenance: Provenance;
}

/**
 * A resource type — what `generateWorld` may place on the map, and (for a
 * strategic row) what a unit's `requiresResource` may name.
 *
 * `yields` is meaningful for `kind: 'bonus'` only, where it is added to the tile
 * the resource sits on, on top of terrain and improvements; every other kind
 * declares zeros and validation rejects a non-zero delta on one of them. A bonus
 * resource is *just terrain*: it is not gated, and it needs no road connection.
 *
 * `allowedRoles` is a **placement** rule: it says which terrain a resource may be
 * put on at generation. It is deliberately not checked against the terrain
 * catalog, for the same reason an improvement's roles are not: content may
 * legitimately restrict a resource to a role this particular catalog happens not
 * to ship, and reporting that as a data error would force content to be written
 * in one order. It is checked for *emptiness*, because a row that lists no
 * terrain is not "anywhere", it is "nowhere".
 *
 * As with every other spec, the row `extends` the engine's structural
 * `ResourceDef` (see `map.ts`) and requires `provenance`. **Luxury resources have
 * no happiness effect in M4c**: they are placed, connected and counted, and
 * nothing reads them for contentment until M9. Saying that plainly is the point —
 * a luxury row that implied a happiness mechanic would be a claim the engine does
 * not keep.
 *
 * **Every number below is placeholder**: costs, maintenance, effect sizes, bonus
 * yields and terrain restrictions are ours, chosen to be playable, and no row is
 * presented as Civ 3's (PLAN.md §6.2). `cited-only` rejects every one of them.
 */
export interface ResourceSpec extends ResourceDef {
  readonly provenance: Provenance;
}

/**
 * A tile improvement — what a worker spends its turns building, and what that
 * does to the tile it sits on (INTERFACES.md M4a, "Rules — improvement catalog").
 *
 * `yields` is a **delta**, not a replacement: a mine adds shields to a hill
 * rather than turning the hill into something else, which is why
 * `core`'s `ImprovementDef.yields` is applied as a sum and clamped at zero per
 * component.
 *
 * As with `UnitSpec` and `BuildingSpec`, the row `extends` the engine's
 * structural `ImprovementDef` so the compile-time proof that content ships what
 * the engine reads is the type itself, and `provenance` is required — a row
 * without one does not compile.
 *
 * **Every number below is placeholder.** Worker turn counts, yield deltas and
 * terrain restrictions are guesses chosen to be playable, and the provenance note
 * on each row says outright that the value is unsourced and ours rather than Civ
 * 3's (PLAN.md §6.2). `fidelity: 'cited-only'` rejects every one of them.
 */
export interface ImprovementSpec extends ImprovementDef {
  readonly provenance: Provenance;
}

/**
 * The eras, **in progression order, earliest first** — an ordered vocabulary, not
 * a free string (INTERFACES.md M5, "The tech tree").
 *
 * The order is data because two checks are stated in terms of it: a tech may not
 * sit in an *earlier* era than something it requires (so the tree cannot run
 * backwards in time), and a UI that lists eras must list them in the same order
 * the catalog claims. Four eras rather than Civ 3's exact set, and their names are
 * ours: this is a placeholder vocabulary chosen to be playable, and nothing here
 * is claimed to match Civ 3's ages.
 *
 * The list lives here rather than in `core` because nothing in the engine orders
 * eras: `core/tech.ts` reads `TechDef`'s `era` as an opaque label (it prices a
 * tech, checks its prerequisites and spends beakers), and only content and
 * validation care what the labels are. That is the same split `ImprovementKind`
 * deliberately does *not* take — there the engine's own ordering rule needs the
 * kind, so the kind list is a `core` concept. A future UI that draws the tree
 * imports this list from `@civts/rules`.
 */
export const ERAS = ['ancient', 'medieval', 'industrial', 'modern'] as const;

export type EraId = (typeof ERAS)[number];

/**
 * A technology — one node of the tree: what it costs in beakers, what it requires
 * before it may be researched, and which era it belongs to.
 *
 * `requires` lists **direct** prerequisites only. The tree's transitive closure is
 * derived (`core/tech.ts`'s `researchProblem` asks whether every direct
 * prerequisite is known, which is enough because a tech can only become known by
 * completing its own prerequisites first), and a row that listed the whole closure
 * would be a second, hand-maintained copy of the graph — free to disagree with the
 * rows it duplicates.
 *
 * As with the other specs, the row `extends` the engine's structural `TechDef`
 * (`core/tech.ts`), which is the compile-time proof that content ships exactly
 * what the engine reads, and `provenance` is required — a row without one does not
 * compile (PLAN.md §6.2).
 *
 * **Provenance: every shipped row is `placeholder`.** The costs, the eras and the
 * prerequisite graph in `CATALOG` are ours — unsourced values chosen so the tree
 * is playable and research has a real choice at the start — and no row is traced
 * to Civ 3's tech tree, its costs or its ages. `fidelity: 'cited-only'` rejects
 * all of them, which is the check that keeps that honest.
 */
export interface TechSpec extends TechDef {
  /** The era this tech belongs to; one of `ERAS`, checked at validation. */
  readonly era: EraId;
  readonly provenance: Provenance;
}

export type RulesetError =
  | { readonly kind: 'empty-catalog'; readonly catalog: string }
  | { readonly kind: 'duplicate-id'; readonly catalog: string; readonly id: string }
  | {
      readonly kind: 'placeholder-in-cited-only';
      readonly catalog: string;
      readonly id: string;
      readonly note: string;
    }
  | {
      readonly kind: 'invalid-value';
      readonly catalog: string;
      readonly id: string;
      readonly field: string;
      readonly detail: string;
    }
  /** No terrain in the catalog fills this role, so generation cannot run. */
  | { readonly kind: 'missing-role'; readonly role: TerrainRole }
  /**
   * The tech prerequisites contain a cycle — a tech that, directly or through
   * other techs, requires itself.
   *
   * This gets its own member rather than riding on `invalid-value` because it is
   * the one tree defect that is **not visible in any single row**: every row of
   * the cycle is internally well-formed, each names a tech that exists, and the
   * cost is a plausible integer. A play test therefore cannot surface it as an
   * error — the game simply never lets research progress past the cycle — which is
   * exactly why it is a load-time validation error with the cycle spelled out
   * (INTERFACES.md M5: "the cycle check is not optional").
   *
   * `cycle` is the loop's ids **in prerequisite order**, with the id it returns to
   * repeated at the end (`a -> b -> a` is `[a, b, a]`), so the message names the
   * cycle rather than merely asserting one exists. `detail` is the same loop as a
   * printable string, because a caller that only renders `detail` must not lose
   * the information.
   */
  | {
      readonly kind: 'tech-cycle';
      readonly catalog: string;
      readonly cycle: readonly TechId[];
      readonly detail: string;
    };

export interface Ruleset {
  readonly terrains: readonly TerrainSpec[];
  readonly units: readonly UnitSpec[];
  readonly buildings: readonly BuildingSpec[];
  readonly improvements: readonly ImprovementSpec[];
  readonly resources: readonly ResourceSpec[];
  /**
   * The tech tree, carried through validation unchanged — and **present on the
   * validated ruleset**, not only on the catalog. That is load-bearing rather than
   * tidiness: `validateRuleset`'s output *is* the engine's `RulesetView`
   * (INTERFACES.md W4: "a validated `Ruleset` is structurally the engine's
   * `RulesetView`, with no adapter in between"), and the research step can only
   * price a tech if the tree reaches it. A validated ruleset that dropped `techs`
   * would leave every game researching something no rule can cost, which is the
   * shape of bug the "no adapter" rule exists to make impossible.
   */
  readonly techs: readonly TechSpec[];
  readonly fidelity: Fidelity;
}

/**
 * One tech row, with its provenance built in rather than typed out seventeen
 * times.
 *
 * The `why` argument is the row's own reason for existing as it does ("the first
 * choice a player makes is which of three roots to open with"), and the rest of
 * the note is the part that must never be forgotten: every row says out loud that
 * its cost, its era and its prerequisites are **unsourced values of ours chosen to
 * be playable**, which is PLAN.md §6.2's rule. Building the note here makes it
 * impossible to add a tech row that omits that claim, and it keeps the seventeen
 * rows below readable as a *shape* — which is the thing a reader has to check
 * (roots, branches, depth, era layering) — rather than as a hundred lines of
 * repeated boilerplate.
 */
const techRow = (
  id: string,
  name: string,
  era: EraId,
  cost: number,
  requires: readonly string[],
  why: string,
): TechSpec => ({
  id: asTechId(id),
  name,
  era,
  cost,
  requires: requires.map((required) => asTechId(required)),
  provenance: placeholder(
    `unsourced: ${why}; the ${String(cost)}-beaker cost, the era and the prerequisites of this row are ` +
      'ours, chosen to be playable rather than measured, and nothing in this tree is traced to Civ 3',
  ),
});

/** Placeholder catalog: shape is intentional, numbers are ours (PLAN.md 6.2). */
export const CATALOG: Catalog = {
  terrains: [
    {
      id: asTerrainId('grassland'),
      role: 'grassland',
      name: 'Grassland',
      moveCost: 1,
      defenseBonusPct: 10,
      yields: { food: 2, shields: 1, commerce: 1 },
      impassable: false,
      provenance: placeholder('tuned baseline; not verified against Civ 3'),
    },
    {
      id: asTerrainId('plains'),
      role: 'plains',
      name: 'Plains',
      moveCost: 1,
      defenseBonusPct: 10,
      yields: { food: 1, shields: 2, commerce: 1 },
      impassable: false,
      provenance: placeholder('tuned baseline; not verified against Civ 3'),
    },
    {
      id: asTerrainId('hills'),
      role: 'hills',
      name: 'Hills',
      moveCost: 2,
      defenseBonusPct: 50,
      yields: { food: 0, shields: 2, commerce: 0 },
      impassable: false,
      provenance: placeholder('tuned baseline; not verified against Civ 3'),
    },
    {
      id: asTerrainId('mountains'),
      role: 'mountains',
      name: 'Mountains',
      moveCost: 3,
      defenseBonusPct: 100,
      yields: { food: 0, shields: 0, commerce: 0 },
      impassable: true,
      provenance: placeholder('tuned baseline; impassable, as in Civ 3 (unverified)'),
    },
    {
      id: asTerrainId('ocean'),
      role: 'ocean',
      name: 'Ocean',
      moveCost: 1,
      defenseBonusPct: 0,
      yields: { food: 1, shields: 0, commerce: 0 },
      impassable: true,
      provenance: placeholder('tuned baseline; requires a sea unit to enter'),
    },
    {
      id: asTerrainId('coast'),
      role: 'coast',
      name: 'Coast',
      moveCost: 1,
      defenseBonusPct: 0,
      yields: { food: 1, shields: 0, commerce: 2 },
      impassable: true,
      provenance: placeholder('tuned baseline; requires a sea unit to enter'),
    },
  ],
  /**
   * Unit rows, all PLACEHOLDER (PLAN.md §6.2): the *shape* is deliberate — one
   * unit per engine role, plus a sea unit so the domain flag is exercised — and
   * every number is ours, not Civ 3's. M2 only needs the settler (`newGame`
   * places one per player) and a role for each later milestone to build on.
   */
  units: [
    {
      id: asUnitTypeId('settler'),
      role: 'settler',
      name: 'Settler',
      attack: 0,
      defense: 0,
      movement: 2,
      cost: 3,
      domain: 'land',
      provenance: placeholder(
        'tuned baseline; slower and far more expensive in Civ 3 (unverified)',
      ),
    },
    {
      id: asUnitTypeId('worker'),
      role: 'worker',
      name: 'Worker',
      attack: 0,
      defense: 0,
      movement: 2,
      cost: 2,
      domain: 'land',
      provenance: placeholder('tuned baseline; terrain improvement arrives in M4'),
    },
    {
      id: asUnitTypeId('scout'),
      role: 'scout',
      name: 'Scout',
      attack: 0,
      defense: 0,
      movement: 3,
      cost: 1,
      domain: 'land',
      provenance: placeholder('tuned baseline; the fast recon unit M2 fog can explore with'),
    },
    {
      id: asUnitTypeId('warrior'),
      role: 'military',
      name: 'Warrior',
      attack: 1,
      defense: 1,
      movement: 1,
      cost: 1,
      domain: 'land',
      provenance: placeholder('tuned baseline; combat stats are unused until M6'),
    },
    {
      id: asUnitTypeId('galley'),
      role: 'military',
      name: 'Galley',
      attack: 0,
      defense: 1,
      movement: 3,
      cost: 2,
      domain: 'sea',
      provenance: placeholder(
        'tuned baseline; sea domain is a consistency flag in M2, no transports',
      ),
    },
    {
      // M4c's resource gate, reachable from shipped content: this is the one row
      // that declares `requiresResource`, so "a city connected by road to a
      // strategic resource may build the unit that needs it, and one that is not
      // may not" is a rule a real game exercises rather than one only a hand-built
      // ruleset view can reach. It is **appended deliberately**, and the reason is
      // recorded rather than left as a habit: at the time it was added `hut.ts` gave
      // away and spawned "the first `military`-role land unit in catalog order", so
      // appending was what kept the free unit the warrior. That reader is now
      // canonical — "the **cheapest** `military`-role land unit, ties broken by id"
      // — and the swordsman costs 3 against the warrior's 1, so appending is no
      // longer load-bearing for hut rewards; it is kept because the REPL lists
      // catalog rows in data order and because the order is part of the ruleset's
      // hashed identity, where a gratuitous move would be a behaviour change nobody
      // could see in a diff.
      id: asUnitTypeId('swordsman'),
      role: 'military',
      name: 'Swordsman',
      attack: 2,
      defense: 2,
      movement: 1,
      cost: 3,
      domain: 'land',
      requiresResource: asResourceId('iron'),
      provenance: placeholder(
        'unsourced: these stats, the cost and the iron requirement are ours, chosen to be playable; ' +
          "gating is M4c's only use of a strategic resource, and Civ 3's own unit requirements are unverified here",
      ),
    },
  ],
  /**
   * Building rows — all PLACEHOLDER, and the numbers are *ours*, not Civ 3's.
   *
   * M4c gives every row the three fields that make a building a building:
   * `maintenance` (gold per turn), `effects` (what it does for its own city) and,
   * for a wonder, `wonder: true`. The *shape* of this table is deliberate:
   *
   * - **Every row declares at least one effect**, so no shipped building is a
   *   pure shield-and-gold sink. Where the effect union has no kind that matches
   *   what the building is *for* — walls are about defense (M6), a temple about
   *   contentment (M9) — the row still declares a placeholder effect and its
   *   provenance note says outright that the effect is a stand-in. An empty table
   *   would be a false claim of a different kind: that the building does nothing.
   * - **Several rows declare `maintenance > 0`**, which is what makes
   *   `TreasuryShortfall` reachable from *shipped* content rather than only from a
   *   hand-built ruleset view (that was M4b's accepted debt, and closing it is one
   *   of this wave's acceptance criteria). The granary is deliberately the free
   *   one: the first building an early city can afford should not be the thing
   *   that bankrupts it.
   * - **`wonder: true` on one row** — the Pyramids — so the wonders-v1 rules
   *   (globally unique; never rebuilt; lost only by bankruptcy, after which it is
   *   buildable again) are reachable from a real game, not only from a test's
   *   stand-in.
   *
   * The costs are chosen to be playable against this catalog's city output
   * (roughly a handful of shields per turn early on), which makes a building a
   * several-turn investment rather than the one-turn purchase a 1-3 shield unit
   * is. That relationship is a tuning choice, not a sourced one: no row below is
   * traced to Civ 3, and the real costs, upkeep and effects there are unverified.
   */
  buildings: [
    {
      id: asBuildingId('granary'),
      name: 'Granary',
      cost: 10,
      maintenance: 0,
      effects: [{ kind: 'growth-food', amount: 1 }],
      provenance: placeholder(
        'unsourced: cost, zero maintenance and the growth-food amount are ours, chosen to be playable; ' +
          'the one building here that is free to keep, so an early city is never bankrupted by its first build',
      ),
    },
    {
      id: asBuildingId('barracks'),
      name: 'Barracks',
      cost: 12,
      maintenance: 1,
      // Stand-in, and the note says so: what a barracks is *for* is veteran
      // units, and combat is M6. A shield multiplier is the nearest placeholder
      // the M4c effect union offers, and it is NOT a claim about Civ 3.
      effects: [{ kind: 'shield-multiplier', pct: 25 }],
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance and the 25% shield placeholders are ours; ' +
          'the veteran-unit effect a barracks is really for arrives with combat in M6, so this multiplier is a stand-in',
      ),
    },
    {
      id: asBuildingId('walls'),
      name: 'City Walls',
      cost: 15,
      maintenance: 1,
      // Same stand-in discipline as the barracks: defense is M6, so the row
      // declares a placeholder shield multiplier and says it is one.
      effects: [{ kind: 'shield-multiplier', pct: 25 }],
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance and the 25% shield placeholders are ours; ' +
          'no defensive effect is modelled until combat arrives in M6, so this multiplier is a stand-in, not a claim',
      ),
    },
    {
      id: asBuildingId('temple'),
      name: 'Temple',
      cost: 15,
      maintenance: 1,
      // A temple is about contentment, which is M9; the commerce multiplier is
      // the placeholder the union offers and the note says exactly that.
      effects: [{ kind: 'commerce-multiplier', pct: 25 }],
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance and the 25% commerce placeholders are ours; ' +
          'no happiness effect is modelled until M9, so this multiplier is a stand-in, not a claim',
      ),
    },
    {
      id: asBuildingId('library'),
      name: 'Library',
      cost: 20,
      maintenance: 1,
      effects: [{ kind: 'beaker-multiplier', pct: 50 }],
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance and the 50% beaker placeholders are ours, chosen to be playable; ' +
          'beakers themselves accumulate and do nothing until research arrives in M5',
      ),
    },
    {
      id: asBuildingId('marketplace'),
      name: 'Marketplace',
      cost: 12,
      maintenance: 1,
      effects: [{ kind: 'commerce-multiplier', pct: 50 }],
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance and the 50% commerce placeholders are ours, chosen to be playable; ' +
          'M4c models commerce multipliers and nothing else about trade',
      ),
    },
    {
      id: asBuildingId('factory'),
      name: 'Factory',
      cost: 25,
      maintenance: 3,
      effects: [{ kind: 'shield-multiplier', pct: 50 }],
      provenance: placeholder(
        'unsourced: this cost, the 3 gold maintenance and the 50% shield placeholders are ours, chosen to be playable; ' +
          'no pollution, power or population cost is modelled',
      ),
    },
    {
      id: asBuildingId('pyramids'),
      name: 'Pyramids',
      cost: 30,
      maintenance: 2,
      effects: [{ kind: 'growth-food', amount: 1 }],
      // M4c's wonders v1: globally unique, never rebuilt, and lost only by the
      // one thing that can destroy a building here — bankruptcy (which disbands
      // it, after which it is buildable again).
      wonder: true,
      provenance: placeholder(
        'unsourced: this cost, the 2 gold maintenance and the growth-food amount are ours, chosen to be playable; ' +
          'the only shipped wonder, marking the wonders-v1 rules rather than reproducing Civ 3 numbers',
      ),
    },
  ],
  /**
   * Tile improvement rows — all PLACEHOLDER, every number ours (PLAN.md §6.2).
   *
   * The *shape* is deliberate: one row per engine kind, so each value of
   * `IMPROVEMENT_KINDS` is exercised by the shipped catalog rather than only by a
   * test's stand-in. The numbers are tuning choices, not sourced figures:
   *
   * - **`turns`** is small (2-3 worker turns) because a worker's whole job is one
   *   improvement, and a build that outlasts the early game is not playable at
   *   this scale. Civ 3's own worker turn counts are unverified here and are not
   *   reproduced.
   * - **`yields`** is a single +1 in one component, which is the smallest delta
   *   that is visible in a city's per-turn output at this catalog's terrain
   *   values. A delta in *two* components would double the effect of one worker
   *   turn and make the placeholder numbers do more work than they can support.
   * - **`allowedRoles`** follows the terrain each improvement is about: a mine
   *   needs rock (hills, mountains), irrigation needs flat, workable land
   *   (grassland, plains), and a road may be built anywhere a land unit can go —
   *   including mountains, which are impassable to *movement* in M4a but are land
   *   all the same. None of the three includes a water role, because M4a's worker
   *   is a land unit with no sea transport.
   *
   * **What these rows deliberately do not claim.** Civ 3's road changes movement
   * cost; M4a does not model road movement at all (it is M4b's, with the economy),
   * so the road row's effect here is commerce and its provenance note says so
   * rather than implying a movement discount that does not exist. Resource
   * connection, irrigation-under-rail, and every other Civ 3 improvement
   * interaction are likewise absent, not silently approximated.
   */
  improvements: [
    {
      id: asImprovementId('road'),
      kind: 'road',
      name: 'Road',
      turns: 2,
      yields: { food: 0, shields: 0, commerce: 1 },
      allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
      provenance: placeholder(
        'unsourced: this delta and turn count are ours, chosen to be playable; ' +
          'Civ 3 roads also cut movement, which M4a does not model',
      ),
    },
    {
      id: asImprovementId('mine'),
      kind: 'mine',
      name: 'Mine',
      turns: 3,
      yields: { food: 0, shields: 1, commerce: 0 },
      allowedRoles: ['hills', 'mountains'],
      provenance: placeholder(
        'unsourced: this delta and turn count are ours, chosen to be playable; ' +
          'not traced to Civ 3 and not claimed to match it',
      ),
    },
    {
      id: asImprovementId('irrigation'),
      kind: 'irrigation',
      name: 'Irrigation',
      turns: 2,
      yields: { food: 1, shields: 0, commerce: 0 },
      allowedRoles: ['grassland', 'plains'],
      provenance: placeholder(
        'unsourced: this delta and turn count are ours, chosen to be playable; ' +
          'Civ 3 restricts irrigation by water access, which M4a does not model',
      ),
    },
  ],
  /**
   * Resource rows — all PLACEHOLDER, every number ours (PLAN.md §6.2).
   *
   * The *shape* is deliberate: all three values of `RESOURCE_KINDS` are exercised
   * by real rows, so a game played on this catalog has a strategic resource that
   * can gate a unit, luxuries that are placed and connected (and, in M4c,
   * **counted and read by nothing** — happiness is M9), and bonus resources that
   * are pure terrain.
   *
   * What each row is for:
   *
   * - **`iron`, `horses`** — strategic. Terrain-restricted to rock and to open
   *   ground respectively, so the two are found in different country: a
   *   civilization that can build one gated unit is not automatically able to
   *   build every one of them.
   * - **`gems`, `wines`** — luxury. Placed, connected and counted; **nothing reads
   *   them for contentment until M9**, and saying so here is the point rather than
   *   a disclaimer.
   * - **`wheat` (land) and `fish` (coast)** — bonus: they add their `yields` to
   *   the tile they sit on, on top of terrain and improvements, and they are
   *   **not gated and not connected** — they are terrain. `fish` sits on water on
   *   purpose: a bonus resource is the only kind that can live where no road can
   *   go, which is exactly the difference between a bonus row and the other two.
   *
   * `allowedRoles` names the terrain each resource belongs on, and every role
   * listed is one this catalog ships (the row-level check for that is in
   * `rules.test.ts`, since validation deliberately does not tie content order to
   * the terrain catalog). The numbers are tuning choices: a bonus delta is a
   * single +1 in one component, the smallest change that is visible in a city's
   * per-turn output at these terrain values. None of it is traced to Civ 3, and
   * Civ 3's own resource distribution and yields are unverified here.
   */
  resources: [
    {
      id: asResourceId('iron'),
      name: 'Iron',
      kind: 'strategic',
      yields: { food: 0, shields: 0, commerce: 0 },
      allowedRoles: ['hills', 'mountains'],
      provenance: placeholder(
        'unsourced: this strategic row and its terrain restriction are ours, chosen to be playable; ' +
          'a unit may be gated on it, which is all M4c models about strategic resources',
      ),
    },
    {
      id: asResourceId('horses'),
      name: 'Horses',
      kind: 'strategic',
      yields: { food: 0, shields: 0, commerce: 0 },
      allowedRoles: ['grassland', 'plains'],
      provenance: placeholder(
        'unsourced: this strategic row and its terrain restriction are ours, chosen to be playable; ' +
          'not traced to Civ 3 and not claimed to match it',
      ),
    },
    {
      id: asResourceId('gems'),
      name: 'Gems',
      kind: 'luxury',
      yields: { food: 0, shields: 0, commerce: 0 },
      allowedRoles: ['hills', 'mountains'],
      provenance: placeholder(
        'unsourced: this luxury row and its terrain restriction are ours, chosen to be playable; ' +
          'luxuries have no happiness effect until M9 — they are placed, connected and counted, and nothing reads them yet',
      ),
    },
    {
      id: asResourceId('wines'),
      name: 'Wines',
      kind: 'luxury',
      yields: { food: 0, shields: 0, commerce: 0 },
      allowedRoles: ['grassland', 'plains'],
      provenance: placeholder(
        'unsourced: this luxury row and its terrain restriction are ours, chosen to be playable; ' +
          'luxuries have no happiness effect until M9, so this row is placed and connected and otherwise inert',
      ),
    },
    {
      id: asResourceId('wheat'),
      name: 'Wheat',
      kind: 'bonus',
      yields: { food: 1, shields: 0, commerce: 0 },
      allowedRoles: ['grassland', 'plains'],
      provenance: placeholder(
        'unsourced: this bonus row, its terrain restriction and the +1 food are ours, chosen to be playable; ' +
          'a bonus resource is terrain — it is not gated and needs no road',
      ),
    },
    {
      id: asResourceId('fish'),
      name: 'Fish',
      kind: 'bonus',
      yields: { food: 1, shields: 0, commerce: 0 },
      allowedRoles: ['coast'],
      provenance: placeholder(
        'unsourced: this bonus row, its water restriction and the +1 food are ours, chosen to be playable; ' +
          'placed on coast on purpose, because a bonus resource is the one kind that may sit where no road can go',
      ),
    },
  ],
  /**
   * The tech tree (M5) — our own placeholder tree, and the *shape* is what this
   * table is defending:
   *
   * - **Three roots** (`pottery`, `bronze-working`, `ceremonial-burial`) with no
   *   prerequisites, so the first research decision is a real choice rather than a
   *   formality, and three different openings are playable.
   * - **Four eras in `ERAS` order, each layered on the last.** No tech sits in an
   *   earlier era than something it requires, which is the structural check the
   *   contract asks for (`checkTechEras`) and the reason `ERAS` is ordered data.
   * - **Every tech is reachable**, and reachability is *proved* rather than
   *   asserted: `rules.test.ts` walks the graph from the roots and requires the
   *   walk to reach all seventeen rows, and `core/test/tech.test.ts` replays the
   *   same property through the research rule itself (a player who always
   *   researches something available ends up knowing the whole tree). A tree with
   *   an orphan — or with a cycle, which is the one defect no play test surfaces as
   *   an error — fails `validateRuleset` before a game can start.
   * - **Costs rise by era** (5–9 beakers ancient, 13–18 medieval, 24–28 industrial,
   *   40–45 modern) against early city science of roughly one to four beakers a
   *   turn at the default 6/4/0 rates: an ancient tech is a handful of turns, a
   *   modern one is a long investment. Those numbers are **ours**, chosen to be
   *   playable; they are not Civ 3's research costs, which are per-advance,
   *   difficulty-scaled and unverified here.
   * - **What a tech unlocks is not yet wired.** M5's gating section (`requiresTech`
   *   on units, buildings, improvements and resources, enforced where production
   *   and build legality are decided) is not part of this row set and no row below
   *   claims it: `core/tech.ts`'s `techUnlocks` reads such a field totally and
   *   honestly reports nothing until content declares one. Saying that out loud is
   *   better than a tree whose names imply gates the engine does not enforce.
   */
  techs: [
    techRow(
      'pottery',
      'Pottery',
      'ancient',
      5,
      [],
      'an opening root, so the first research decision is a choice between three paths',
    ),
    techRow(
      'bronze-working',
      'Bronze Working',
      'ancient',
      6,
      [],
      'an opening root, and the head of the military/masonry branch',
    ),
    techRow(
      'ceremonial-burial',
      'Ceremonial Burial',
      'ancient',
      6,
      [],
      'an opening root, and the only way into the literature branch',
    ),
    techRow(
      'alphabet',
      'Alphabet',
      'ancient',
      7,
      ['pottery'],
      'the shared trunk of the three medieval science branches, so pottery pays off twice',
    ),
    techRow(
      'warrior-code',
      'Warrior Code',
      'ancient',
      5,
      ['bronze-working'],
      'cheap on purpose: the military opening must compete with the science one',
    ),
    techRow(
      'the-wheel',
      'The Wheel',
      'ancient',
      8,
      ['pottery'],
      'the commerce branch, costing more beakers than the science one it competes with',
    ),
    techRow(
      'masonry',
      'Masonry',
      'ancient',
      9,
      ['bronze-working'],
      'the expensive ancient tech, and the gate in front of iron working',
    ),
    techRow(
      'iron-working',
      'Iron Working',
      'medieval',
      14,
      ['bronze-working', 'masonry'],
      'two ancient prerequisites, so the medieval era cannot be reached by one branch alone',
    ),
    techRow(
      'mathematics',
      'Mathematics',
      'medieval',
      16,
      ['alphabet', 'masonry'],
      'joins the science trunk to the masonry branch, which is what makes the early choice matter later',
    ),
    techRow(
      'currency',
      'Currency',
      'medieval',
      13,
      ['the-wheel', 'alphabet'],
      'the cheaper medieval row, reachable from either of two ancient openings through alphabet',
    ),
    techRow(
      'literature',
      'Literature',
      'medieval',
      15,
      ['alphabet', 'ceremonial-burial'],
      'the only row that needs ceremonial burial, so the third root is not decorative',
    ),
    techRow(
      'feudalism',
      'Feudalism',
      'medieval',
      18,
      ['warrior-code', 'iron-working'],
      'the most expensive medieval row: the military line has to reach the era it sits in first',
    ),
    techRow(
      'engineering',
      'Engineering',
      'industrial',
      26,
      ['mathematics', 'iron-working'],
      'the first industrial row, requiring both the science and the metal half of the medieval era',
    ),
    techRow(
      'banking',
      'Banking',
      'industrial',
      24,
      ['currency', 'feudalism'],
      'the money branch, deliberately cheaper than engineering so the two industrial openings differ',
    ),
    techRow(
      'education',
      'Education',
      'industrial',
      28,
      ['literature', 'mathematics'],
      'the science branch, the most expensive industrial row, and one of the two routes to the modern era',
    ),
    techRow(
      'steam-power',
      'Steam Power',
      'modern',
      40,
      ['engineering', 'banking'],
      'a modern row, priced so that reaching it is a game-long investment rather than a formality',
    ),
    techRow(
      'electricity',
      'Electricity',
      'modern',
      45,
      ['steam-power', 'education'],
      'the last row, requiring the modern row before it as well as the science branch',
    ),
  ],
};

/**
 * Referenced from a cited row to document the intended shape of a real source
 * entry. Kept exported so the provenance CLI can show a cited example.
 */
export const CITED_EXAMPLE: Provenance = cited(
  'https://example.invalid/civ3-rules',
  'illustrative only: replace with a real source before marking any row cited',
);

const checkRows = (
  catalogName: string,
  rows: readonly { readonly id: string; readonly provenance: Provenance }[],
): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  if (rows.length === 0) errors.push({ kind: 'empty-catalog', catalog: catalogName });

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      errors.push({ kind: 'duplicate-id', catalog: catalogName, id: row.id });
    }
    seen.add(row.id);
  }
  return errors;
};

const checkTerrain = (t: TerrainSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'terrains',
    id: t.id,
    field,
    detail,
  });

  if (!t.impassable && t.moveCost < 1)
    errors.push(bad('moveCost', 'must be >= 1 for passable terrain'));
  if (!Number.isInteger(t.moveCost)) errors.push(bad('moveCost', 'must be an integer'));
  for (const [field, value] of Object.entries(t.yields)) {
    if (!Number.isInteger(value)) errors.push(bad(`yields.${field}`, 'must be an integer'));
    if (value < 0) errors.push(bad(`yields.${field}`, 'must not be negative'));
  }
  if (!Number.isInteger(t.defenseBonusPct) || t.defenseBonusPct < 0) {
    errors.push(bad('defenseBonusPct', 'must be a non-negative integer'));
  }
  return errors;
};

/**
 * Every role the engine can ask for must be filled by at least one terrain:
 * generation resolves terrain through `TERRAIN_BY_ROLE`, so a catalog with a
 * hole in it makes `newGame` fail with `missing-terrain-role` at the far end of
 * the pipeline. Reporting it here — once, at load time, naming the role — keeps
 * that failure from surfacing as a runtime surprise, and one error per missing
 * role means a partially-filled catalog is fixed in a single pass.
 *
 * Reported in `TERRAIN_ROLES` order so the message is stable across runs.
 */
const checkRoles = (rows: readonly { readonly role: TerrainRole }[]): readonly RulesetError[] =>
  TERRAIN_ROLES.filter((role) => !rows.some((row) => row.role === role)).map((role) => ({
    kind: 'missing-role',
    role,
  }));

/**
 * The terrain roles that count as "water a sea unit can be on". M2 needs the
 * `domain` flag to be *consistent*, not transports: a sea row is only meaningful
 * if the catalog provides water for it to enter.
 */
const SEA_ENTRY_ROLES: readonly TerrainRole[] = ['ocean', 'coast'];

const checkUnit = (u: UnitSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'units',
    id: u.id,
    field,
    detail,
  });

  // Every stat is a simulation number, so it must be an integer: a float here
  // would be a determinism hazard the type system cannot see (PLAN.md §5.3).
  const stats: readonly (readonly [string, number])[] = [
    ['attack', u.attack],
    ['defense', u.defense],
    ['movement', u.movement],
    ['cost', u.cost],
  ];
  for (const [field, value] of stats) {
    if (!Number.isInteger(value)) errors.push(bad(field, 'must be an integer'));
    if (value < 0) errors.push(bad(field, 'must not be negative'));
  }

  // A unit that cannot move is unplayable, and a unit that costs nothing is a
  // free unit — both are data errors rather than tuning choices.
  if (u.movement < 1) errors.push(bad('movement', 'must be >= 1'));
  if (u.cost < 1) errors.push(bad('cost', 'must be >= 1'));

  return errors;
};

/**
 * A sea unit needs water to enter. Reported against the *unit* that demands it,
 * naming its `domain` field, because that is the row a caller fixes: the
 * terrain-role audit above reports the same hole from the terrain side, and a
 * catalog with no ocean has two things wrong with it, not one.
 */
const checkSeaUnits = (
  units: readonly UnitSpec[],
  terrains: readonly TerrainSpec[],
): readonly RulesetError[] => {
  const hasWater = terrains.some((t) => SEA_ENTRY_ROLES.includes(t.role));
  if (hasWater) return [];

  return units
    .filter((u) => u.domain === 'sea')
    .map((u) => ({
      kind: 'invalid-value',
      catalog: 'units',
      id: u.id,
      field: 'domain',
      detail: `a sea unit needs water terrain (${SEA_ENTRY_ROLES.join(' or ')}), which this catalog does not provide`,
    }));
};

/**
 * Is this a kind the engine knows? Compares the *strings*, because the kind lists
 * are tuples of string literals and the value tested may be one the type system
 * never saw (a JSON catalog, a `Partial` patch). The plain strings are what both
 * are at runtime; nothing is widened away here.
 *
 * One predicate per kind list rather than one generic "is it in this array"
 * helper: each list belongs to a different catalog, and a generic version would
 * take the list as an argument — the shape that lets the wrong list be passed
 * without the typechecker noticing, since every list is `readonly string[]`.
 */
const isKnownBuildingEffectKind = (kind: string): boolean =>
  BUILDING_EFFECT_KINDS.some((known) => known === kind);

const isKnownResourceKind = (kind: string): boolean =>
  RESOURCE_KINDS.some((known) => known === kind);

/**
 * Is this a kind the engine knows? Compares the *strings*, because
 * `IMPROVEMENT_KINDS` is a tuple of string literals and the value tested may be
 * one the type system never saw (a JSON catalog, a `Partial` patch). The plain
 * strings are what both are at runtime; nothing is widened away here.
 */
const isKnownImprovementKind = (kind: string): boolean =>
  IMPROVEMENT_KINDS.some((known) => known === kind);

/**
 * The fields of one building effect, as validation reads them: everything
 * optional and `unknown`, because the row being checked may be data the type
 * system never saw (a JSON catalog, a `Partial` patch).
 *
 * A `BuildingEffect` is assignable to this — its `kind` is a literal string and
 * its number is a `number` — so the shipped catalog is checked by the same code
 * without a cast, which is the point: the checker must not be able to *assume*
 * the shape it exists to verify.
 */
interface EffectFields {
  readonly kind?: unknown;
  readonly pct?: unknown;
  readonly amount?: unknown;
}

/**
 * One effect of a building row, checked **totally**: `kind` is a known kind, and
 * the number that kind carries is a non-negative integer.
 *
 * Why both halves matter:
 *
 * - **An unknown kind** cannot be applied by anything the engine ships, so a row
 *   carrying one would be a promise nothing keeps. `BuildingEffectKind` makes it
 *   a compile error in content code; a JSON catalog or a `Partial` patch can still
 *   carry one, and validation names the offending kind rather than leaving the
 *   reader to guess which field is wrong.
 * - **A negative or fractional number** is the determinism hazard this file
 *   rejects everywhere else: effects feed city output, which is hashed, so a
 *   fraction there would make a state unhashable (`canonicalize` refuses it).
 *   A negative percentage would also mean a building that *subtracts* output,
 *   which is not a thing M4c offers — a row that wants that has a different bug.
 *
 * `kind` is read through `unknown` first, because the value being tested may be
 * an object the type system never saw, and a `readonly` field read straight off
 * `BuildingEffect` would be a claim the check itself is there to verify.
 */
const checkEffect = (
  catalogName: string,
  id: string,
  effects: readonly EffectFields[],
): readonly RulesetError[] =>
  effects.flatMap((entry, index) => {
    const bad = (field: string, detail: string): RulesetError => ({
      kind: 'invalid-value',
      catalog: catalogName,
      id,
      field: `effects[${String(index)}].${field}`,
      detail,
    });

    const kind: unknown = entry.kind;
    if (typeof kind !== 'string' || !isKnownBuildingEffectKind(kind)) {
      return [
        bad(
          'kind',
          `must be one of ${BUILDING_EFFECT_KINDS.join(', ')} (got ${JSON.stringify(kind)})`,
        ),
      ];
    }

    // `growth-food` carries an amount; every multiplier carries a percentage.
    // Reading the wrong field of the right kind is a data error too, and saying
    // which field is missing is what makes it fixable.
    const value: unknown = kind === 'growth-food' ? entry.amount : entry.pct;
    const field = kind === 'growth-food' ? 'amount' : 'pct';
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return [bad(field, 'must be an integer')];
    }
    if (value < 0) return [bad(field, 'must not be negative')];

    return [];
  });

/**
 * A building row is a shield cost, a maintenance bill and a list of effects, and
 * M4c checks all three:
 *
 * - **`cost`** must be a whole number of shields and at least one. A free
 *   building would let `production.itemCost` complete an item on the turn it is
 *   queued, and a fractional cost would put a fraction in `City.shields`, which is
 *   part of every state hash (PLAN.md §5.3) — a determinism hazard the type system
 *   cannot see, exactly as with a unit's stats.
 * - **`maintenance`** must be a non-negative integer. Non-integer for the same
 *   reason (it feeds the treasury each turn, and the treasury is hashed), negative
 *   because a building that *pays* its owner is not what the field means — the
 *   money loop's upkeep is a sum of bills, and a credit hiding in it would make
 *   "why is my gold wrong?" unanswerable.
 * - **`effects`** must each be a known kind with a non-negative integer number
 *   (`checkEffect`). An **empty list is legal** and honest: it says "this building
 *   currently does nothing but cost shields and gold", which is the right row for
 *   content whose real effect belongs to a later milestone. Rejecting `[]` would
 *   push content into inventing an effect it does not mean.
 * - **`wonder`**, when present, must be exactly `true`. The type makes any other
 *   value a compile error, but a JSON catalog can carry `false` — and an absent
 *   key (not a `false`) is how this project spells "not a wonder", because a key
 *   present with a falsy value is the *same trap* that has cost three bug hunts
 *   here: it survives the typecheck and then meets `canonicalize`, which is happy
 *   with `false` but would not be with `undefined` in its place.
 */
const checkBuilding = (b: BuildingSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'buildings',
    id: b.id,
    field,
    detail,
  });

  if (!Number.isInteger(b.cost)) errors.push(bad('cost', 'must be an integer'));
  if (b.cost < 1) errors.push(bad('cost', 'must be >= 1'));

  if (!Number.isInteger(b.maintenance)) errors.push(bad('maintenance', 'must be an integer'));
  if (b.maintenance < 0) errors.push(bad('maintenance', 'must not be negative'));

  errors.push(...checkEffect('buildings', b.id, b.effects));

  // Read through `unknown` so a hostile row (JSON, a patch) is *checked* rather
  // than trusted: `true` is the only value the field may carry.
  const wonder: unknown = b.wonder;
  if (wonder !== undefined && wonder !== true) {
    errors.push(
      bad(
        'wonder',
        `must be true when present, or the key must be absent (got ${JSON.stringify(wonder)})`,
      ),
    );
  }

  return errors;
};

/**
 * A resource row has to be placeable and has to mean something:
 *
 * - **A known `kind`.** `ResourceKind` makes an unknown one a compile error, but a
 *   JSON catalog can carry one, and the engine's three kinds are not
 *   interchangeable: a `bonus` row's yields are added to a tile and a `strategic`
 *   row's are not, so an unknown kind would be a row nothing could read.
 * - **Each `yields` component a non-negative integer**, for the same two reasons
 *   an improvement's are: a fraction would reach a hashed tile yield, and a
 *   negative delta is a resource that takes food away from the tile it sits on —
 *   not a thing a bonus row means.
 * - **`yields` all zero unless the row is `bonus`.** The contract's own comment is
 *   "bonus only; zeros otherwise", and the difference is observable: bonus yields
 *   are added to a tile, so a *strategic* row that quietly carried `+1 food` would
 *   feed cities as a side effect of being connected. Rejecting it is the cheap way
 *   to keep "what a strategic resource does" to exactly gating.
 * - **A non-empty `allowedRoles`.** A row that lists no terrain is not "anywhere",
 *   it is "nowhere": generation checks membership in this list, so an empty one
 *   would make the resource unplaceable in every game while looking like content.
 * - **A name that is not empty**, like every other row here.
 */
const checkResource = (r: ResourceSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'resources',
    id: r.id,
    field,
    detail,
  });

  if (r.name === '') errors.push(bad('name', 'must not be empty'));

  if (!isKnownResourceKind(r.kind)) {
    errors.push(
      bad('kind', `must be one of ${RESOURCE_KINDS.join(', ')} (got ${JSON.stringify(r.kind)})`),
    );
  }

  for (const [field, value] of Object.entries(r.yields)) {
    if (!Number.isInteger(value)) errors.push(bad(`yields.${field}`, 'must be an integer'));
    if (value < 0) errors.push(bad(`yields.${field}`, 'must not be negative'));
  }

  if (r.kind !== 'bonus') {
    for (const [field, value] of Object.entries(r.yields)) {
      if (value !== 0) {
        errors.push(
          bad(
            `yields.${field}`,
            `must be 0 for a ${r.kind} resource: only a bonus resource yields`,
          ),
        );
      }
    }
  }

  if (r.allowedRoles.length === 0) {
    errors.push(bad('allowedRoles', 'must list at least one terrain role'));
  }

  return errors;
};

/**
 * Every `requiresResource` a unit declares must name a resource this catalog
 * defines.
 *
 * Reported against the **unit** that demands it, naming its `requiresResource`
 * field, because that is the row a caller fixes — the same shape the sea-unit
 * check uses. The alternative reading ("the resource catalog is missing a row")
 * cannot be distinguished from content that simply does not ship that resource,
 * and a unit gated on a resource nothing defines could never be built in any
 * game: it would be dead content, refused silently at the far end of production
 * planning.
 *
 * A unit that declares nothing is not checked and not complained about: M4c ships
 * rows that require no resource, and most rows will never require one.
 */
const checkResourceRefs = (
  units: readonly UnitSpec[],
  resources: readonly ResourceSpec[],
): readonly RulesetError[] =>
  units.flatMap((u) => {
    const required = u.requiresResource;
    if (required === undefined) return [];
    if (resources.some((r) => r.id === required)) return [];

    return [
      {
        kind: 'invalid-value',
        catalog: 'units',
        id: u.id,
        field: 'requiresResource',
        detail: `names resource ${JSON.stringify(required)}, which this catalog does not define`,
      },
    ];
  });

/**
 * An improvement row has to be buildable and has to mean something:
 *
 * - **`turns >= 1` and an integer.** A worker turn count is a simulation number
 *   (it is decremented into `UnitWork.turnsLeft`, which is part of every state
 *   hash), so a fraction would put an unhashable value in the state and a `0`
 *   would mean an improvement that completes the instant it is started — a free
 *   tile, not a job.
 * - **Each `yields` component a non-negative integer.** Non-integer for the same
 *   determinism reason as terrain yields; negative because the contract's
 *   "clamped at zero per component" rule exists for *foreign* data, and a shipped
 *   row that relies on the clamp to stop it subtracting from a tile is a row
 *   whose author meant something else.
 * - **A known `kind`.** `ImprovementKind` makes an unknown one a compile error,
 *   but a catalog can arrive as JSON or from a test's `Partial` patch, and the
 *   engine's ordering (`improvements.ts`' kind rank) is defined in terms of the
 *   known kinds — so an unknown one is rejected here, naming the field, rather
 *   than sorting somewhere arbitrary.
 * - **A non-empty `allowedRoles`.** A row that lists no terrain is not "allowed
 *   anywhere", it is allowed *nowhere*: `StartWork` checks membership in this
 *   list, so an empty one silently makes the improvement unbuildable. "Anywhere"
 *   is spelled by listing the roles.
 *
 * Every other role in `allowedRoles` is deliberately **not** checked against the
 * terrain catalog: an improvement may legitimately be buildable on a role this
 * particular catalog happens not to ship (M4b adds terrain), and reporting that as
 * a data error would force content to be written in one order.
 */
const checkImprovement = (i: ImprovementSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'improvements',
    id: i.id,
    field,
    detail,
  });

  if (!Number.isInteger(i.turns)) errors.push(bad('turns', 'must be an integer'));
  if (i.turns < 1) errors.push(bad('turns', 'must be >= 1'));

  for (const [field, value] of Object.entries(i.yields)) {
    if (!Number.isInteger(value)) errors.push(bad(`yields.${field}`, 'must be an integer'));
    if (value < 0) errors.push(bad(`yields.${field}`, 'must not be negative'));
  }

  if (!isKnownImprovementKind(i.kind)) {
    errors.push(
      bad('kind', `must be one of ${IMPROVEMENT_KINDS.join(', ')} (got ${JSON.stringify(i.kind)})`),
    );
  }

  if (i.allowedRoles.length === 0) {
    errors.push(bad('allowedRoles', 'must list at least one terrain role'));
  }

  return errors;
};

/**
 * One tech row, on its own: a name, an integer cost of at least one beaker, an era
 * from the ordered vocabulary, and prerequisites that are ids rather than nothing.
 *
 * What is **not** checked here is anything about the *graph* — whether `requires`
 * names a tech that exists, whether the eras run backwards, whether the edges form
 * a cycle. Those are properties of the tree as a whole, they are the checks the
 * contract singles out, and they live in the three functions below so that each
 * one states its rule once rather than being re-derived per row.
 */
const checkTech = (tech: TechSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'techs',
    id: tech.id,
    field,
    detail,
  });

  // A cost is a simulation number — it is compared against `PlayerState.beakers`
  // and subtracted from it — so a fraction here would put an unhashable value in
  // the state, exactly as a fractional yield would (PLAN.md §5.3).
  if (!Number.isInteger(tech.cost)) errors.push(bad('cost', 'must be an integer'));
  if (tech.cost < 1) errors.push(bad('cost', 'must be >= 1'));

  if (tech.name === '') errors.push(bad('name', 'must not be empty'));

  if (!ERAS.some((era) => era === tech.era)) {
    errors.push(bad('era', `must be one of ${ERAS.join(', ')} (got ${JSON.stringify(tech.era)})`));
  }

  return errors;
};

/**
 * Every `requires` entry must name a tech this catalog defines.
 *
 * Reported against the *tech that declares the dependency*, naming its `requires`
 * field, because that is the row a caller fixes — the same shape
 * `checkResourceRefs` uses for a unit's `requiresResource`. A prerequisite naming
 * nothing is not a harmless extra: research would ask a question no row can answer
 * and the tech would be permanently unreachable, which is precisely the silent
 * dead-end the cycle check exists to prevent.
 *
 * A tech that requires nothing is not complained about: the roots of the tree are
 * *supposed* to have empty prerequisite lists.
 */
const checkTechRefs = (techs: readonly TechSpec[]): readonly RulesetError[] =>
  techs.flatMap((tech) =>
    tech.requires
      .filter((required) => !techs.some((row) => row.id === required))
      .map((required) => ({
        kind: 'invalid-value' as const,
        catalog: 'techs',
        id: tech.id,
        field: 'requires',
        detail: `names tech ${JSON.stringify(required)}, which this catalog does not define`,
      })),
  );

/**
 * The era of a tech must not precede the era of anything it requires.
 *
 * `ERAS` is an ordered vocabulary precisely so this can be a structural check: a
 * tech that sits in an earlier era than its own prerequisite would make the tree
 * run backwards in time, and a UI that grouped research by era (or an AI that
 * weighed "what is available this age") would then see a tech it cannot possibly
 * have researched yet. Equal eras are legal — two rows of the same era may depend on
 * each other — and an unknown era is reported by `checkTech` rather than here, so
 * this check only orders eras it can actually place.
 */
const checkTechEras = (techs: readonly TechSpec[]): readonly RulesetError[] => {
  const rank = (era: EraId): number => ERAS.findIndex((known) => known === era);

  return techs.flatMap((tech) => {
    const own = rank(tech.era);
    if (own < 0) return [];

    return tech.requires.flatMap((required) => {
      const row = techs.find((candidate) => candidate.id === required);
      if (row === undefined) return [];
      const theirs = rank(row.era);

      return theirs >= 0 && theirs > own
        ? [
            {
              kind: 'invalid-value' as const,
              catalog: 'techs',
              id: tech.id,
              field: 'era',
              detail:
                `is ${tech.era}, which is earlier than ${row.era} — the era of ` +
                `${JSON.stringify(required)}, a tech it requires`,
            },
          ]
        : [];
    });
  });
};

/**
 * Find a cycle in the prerequisites, if there is one — the check the contract
 * calls "not optional".
 *
 * A cycle is the one tree defect that **no play test can surface as an error**:
 * every row in the loop is well-formed, each prerequisite exists, every cost is a
 * plausible integer, and validation without this check passes. The game then simply
 * never offers the looped techs to anyone, forever, with nothing anywhere saying
 * why. So it is a load-time error, and it names the loop (`[a, b, a]`) rather than
 * announcing that "a cycle exists somewhere".
 *
 * The walk is a depth-first search over catalog order, with the classic three
 * colours: `open` marks the nodes on the current path, `closed` the nodes whose
 * whole subtree has been explored without finding one. Rebinding a node that is
 * `open` therefore *is* a cycle, and the ids from that node's position in the path
 * to the end are exactly the loop. Catalog order — never RNG, never a hash of the
 * ids — makes the reported cycle stable across runs, so the same broken catalog
 * always produces the same message.
 *
 * A `requires` entry naming an unknown tech is skipped rather than followed: that
 * is a different error, reported once by `checkTechRefs` against the row that made
 * it, and treating an unknown id as a leaf keeps this function from claiming a
 * cycle that the catalog does not contain.
 */
const findTechCycle = (techs: readonly TechSpec[]): readonly TechId[] | undefined => {
  const byId = new Map<TechId, TechSpec>();
  for (const tech of techs) if (!byId.has(tech.id)) byId.set(tech.id, tech);

  const colour = new Map<TechId, 'open' | 'closed'>();
  const path: TechId[] = [];

  const walk = (id: TechId): readonly TechId[] | undefined => {
    const seen = colour.get(id);
    if (seen === 'closed') return undefined;
    if (seen === 'open') {
      const from = path.indexOf(id);
      return [...path.slice(from < 0 ? 0 : from), id];
    }

    colour.set(id, 'open');
    path.push(id);

    for (const required of byId.get(id)?.requires ?? []) {
      if (!byId.has(required)) continue;
      const cycle = walk(required);
      if (cycle !== undefined) return cycle;
    }

    path.pop();
    colour.set(id, 'closed');
    return undefined;
  };

  for (const tech of techs) {
    const cycle = walk(tech.id);
    if (cycle !== undefined) return cycle;
  }

  return undefined;
};

/** `a -> b -> a`, the printable form of a cycle `findTechCycle` found. */
const cycleDetail = (cycle: readonly TechId[]): string =>
  `prerequisite cycle: ${cycle.map((id) => String(id)).join(' -> ')}`;

/**
 * The tech tree's graph checks — references, era order and the cycle check — run
 * together and reported in that order, so a catalog's first complaint about its
 * tree is the one that stops a game earliest: an unknown prerequisite makes a tech
 * unreachable, a backwards era misorders the whole progression, and a cycle makes
 * part of the tree unreachable forever.
 */
const checkTechGraph = (techs: readonly TechSpec[]): readonly RulesetError[] => {
  const cycle = findTechCycle(techs);
  return [
    ...checkTechRefs(techs),
    ...checkTechEras(techs),
    ...(cycle === undefined
      ? []
      : [{ kind: 'tech-cycle' as const, catalog: 'techs', cycle, detail: cycleDetail(cycle) }]),
  ];
};

/**
 * Validate a catalog. In `cited-only` mode any placeholder row is a hard error,
 * which is what makes "is this Civ 3-shaped or Civ 3-exact?" checkable.
 *
 * Terrains are checked before units, units before buildings, buildings before
 * improvements, improvements before resources, and resources before techs, so the
 * first error a caller sees comes from the catalog that would stop a game
 * earliest: a terrain hole stops generation, a unit hole stops `newGame` placing a
 * settler, and a building, improvement, resource or tech hole only stops
 * production, a worker, a resource placement or research later.
 *
 * The one cross-catalog check is `checkResourceRefs` — a unit's `requiresResource`
 * is a reference into the *resource* catalog — and it stays with the units it is
 * reported against, immediately after the rest of the unit checks, so a caller
 * fixing a broken catalog sees every complaint about that catalog in one place.
 * M5's tree checks are cross-*row* rather than cross-catalog (a tech's `requires`
 * points at other techs, its era is ordered against theirs), so they are grouped at
 * the end of the tech block where every complaint about the tree is together.
 */
export const validateRuleset = (
  catalog: Catalog,
  fidelity: Fidelity,
): Result<Ruleset, readonly RulesetError[]> => {
  const errors: RulesetError[] = [
    ...checkRows('terrains', catalog.terrains),
    ...catalog.terrains.flatMap(checkTerrain),
    ...checkRoles(catalog.terrains),
    ...checkRows('units', catalog.units),
    ...catalog.units.flatMap(checkUnit),
    ...checkSeaUnits(catalog.units, catalog.terrains),
    ...checkResourceRefs(catalog.units, catalog.resources),
    ...checkRows('buildings', catalog.buildings),
    ...catalog.buildings.flatMap(checkBuilding),
    ...checkRows('improvements', catalog.improvements),
    ...catalog.improvements.flatMap(checkImprovement),
    ...checkRows('resources', catalog.resources),
    ...catalog.resources.flatMap(checkResource),
    ...checkRows('techs', catalog.techs),
    ...catalog.techs.flatMap(checkTech),
    // The tree's own checks last: a per-row complaint (a bad cost, an unknown era)
    // is what a caller fixes first, and a graph complaint is only meaningful once
    // the rows it is about are themselves well-formed.
    ...checkTechGraph(catalog.techs),
  ];

  if (fidelity === 'cited-only') {
    for (const t of catalog.terrains) {
      if (isPlaceholder(t.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: 'terrains',
          id: t.id,
          note: t.provenance.note,
        });
      }
    }
    for (const u of catalog.units) {
      if (isPlaceholder(u.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: 'units',
          id: u.id,
          note: u.provenance.note,
        });
      }
    }
    for (const b of catalog.buildings) {
      if (isPlaceholder(b.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: 'buildings',
          id: b.id,
          note: b.provenance.note,
        });
      }
    }
    for (const i of catalog.improvements) {
      if (isPlaceholder(i.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: 'improvements',
          id: i.id,
          note: i.provenance.note,
        });
      }
    }
    for (const r of catalog.resources) {
      if (isPlaceholder(r.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: 'resources',
          id: r.id,
          note: r.provenance.note,
        });
      }
    }
    for (const tech of catalog.techs) {
      if (isPlaceholder(tech.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: 'techs',
          id: tech.id,
          note: tech.provenance.note,
        });
      }
    }
  }

  // The annotations state the contract each `extends` encodes, and keep the
  // return type honest: what leaves validation is the engine's view.
  const units: readonly UnitSpec[] = catalog.units;
  const buildings: readonly BuildingSpec[] = catalog.buildings;
  const improvements: readonly ImprovementSpec[] = catalog.improvements;
  const resources: readonly ResourceSpec[] = catalog.resources;
  const techs: readonly TechSpec[] = catalog.techs;

  return errors.length > 0
    ? err(errors)
    : ok({
        terrains: catalog.terrains,
        units,
        buildings,
        improvements,
        resources,
        techs,
        fidelity,
      });
};

export interface ProvenanceSummary {
  readonly total: number;
  readonly cited: number;
  readonly placeholder: number;
}

/**
 * One row of a provenance report: the id the row is filed under and the claim it
 * makes. Both catalogs' rows have this shape, which is what lets one renderer
 * (and one counter) cover every catalog alike.
 */
export interface ProvenanceRow {
  readonly id: string;
  readonly provenance: Provenance;
}

/**
 * A catalog section — the terrains, the units, or the buildings — with its rows
 * *and* its own count, so a report can print a subtotal beside the rows it was
 * derived from.
 */
export interface ProvenanceSection {
  readonly name: string;
  readonly rows: readonly ProvenanceRow[];
  readonly summary: ProvenanceSummary;
}

const summarizeRows = (rows: readonly ProvenanceRow[]): ProvenanceSummary => {
  const placeholderCount = rows.filter((row) => isPlaceholder(row.provenance)).length;
  return {
    total: rows.length,
    cited: rows.length - placeholderCount,
    placeholder: placeholderCount,
  };
};

const sectionOf = (name: string, rows: readonly ProvenanceRow[]): ProvenanceSection => ({
  name,
  rows,
  summary: summarizeRows(rows),
});

/**
 * The catalog split into the sections it is stored in, in storage order, each
 * carrying its rows and their count.
 *
 * This is the *one* place that decides which rows count toward provenance, and
 * `summarizeProvenance` is literally the sum of what it returns. That is
 * deliberate: the `rules:provenance` CLI printed a total counted over terrains
 * *and* units above a table that listed only the terrain rows, so the report
 * contradicted itself — the half-truth PLAN.md §6.2 exists to prevent. A
 * renderer that iterates these sections cannot repeat it, because there is no
 * second list of rows to disagree with the total.
 *
 * Buildings are a section here for the same reason: adding a catalog to
 * `Catalog` without adding it here would leave new rows uncounted by the report
 * — and unvalidated by the cited-only audit — while the engine already reads
 * their costs.
 *
 * Resources are the fifth section, and the same rule applies to them: M4c's
 * resource rows are `placeholder` rows carrying real rules numbers (bonus yields,
 * terrain restrictions), so a report that counted them without listing them — or
 * listed them under a total that did not count them — would be the exact
 * half-truth this function exists to prevent.
 *
 * Techs are the sixth, and M5 sharpens the point: the tree is seventeen rows of
 * *research costs* — the largest block of new numbers the milestone adds — and every
 * one of them is a `placeholder` row. A provenance report that counted rows without
 * listing the tech rows would understate exactly the numbers this wave introduced,
 * which is why the section list and `summarizeProvenance` are one function's worth of
 * truth rather than two.
 */
export const provenanceSections = (catalog: Catalog): readonly ProvenanceSection[] => [
  sectionOf('terrains', catalog.terrains),
  sectionOf('units', catalog.units),
  sectionOf('buildings', catalog.buildings),
  sectionOf('improvements', catalog.improvements),
  sectionOf('resources', catalog.resources),
  sectionOf('techs', catalog.techs),
];

/**
 * Count **every** row in the catalog — terrain, unit, building, improvement,
 * resource and tech alike. The number answers
 * "how much of what the engine runs on is traced to a source?", so a summary
 * that quietly skipped a catalog would be exactly the half-truth PLAN.md §6.2
 * exists to prevent.
 *
 * Defined as the sum of `provenanceSections`, so a caller that prints this
 * number beside those sections — the CLI does — cannot print a total that
 * disagrees with the rows it lists. Every row is counted, duplicates included:
 * this counts rows, not distinct ids (`checkRows` is what rejects duplicates).
 */
export const summarizeProvenance = (catalog: Catalog): ProvenanceSummary => {
  const sections = provenanceSections(catalog);
  const total = sections.reduce((count, section) => count + section.summary.total, 0);
  const placeholderCount = sections.reduce(
    (count, section) => count + section.summary.placeholder,
    0,
  );
  return { total, cited: total - placeholderCount, placeholder: placeholderCount };
};
