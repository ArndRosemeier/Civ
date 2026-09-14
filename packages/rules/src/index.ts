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
  asGovernmentId,
  asImprovementId,
  asResourceId,
  asTechId,
  asTerrainId,
  asUnitTypeId,
  err,
  isPlaceholder,
  ok,
  RATE_TOTAL,
  placeholder,
  cited,
  type BuildingDef,
  type BuildingEffect,
  type BuildingEffectKind,
  type Fidelity,
  type GovernmentId,
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
  /**
   * Percentage defense bonus this terrain gives a unit standing on it — the M4
   * field, spelled `…Pct` because it *is* a percentage and never a multiplier.
   *
   * It was **read by nothing** until M6: terrain defence had no consumer while
   * combat did not exist, which is why the column looked decorative. M6's
   * `defenseBonus` below is the same value under the name the M6 contract gives it
   * (INTERFACES.md M6, "Terrain defence"), the engine's combat path reads
   * `defenseBonus` in preference to this field, and `checkTerrain` refuses a row
   * whose two spellings disagree — so "one number, two names" cannot silently become
   * two numbers.
   */
  readonly defenseBonusPct: number;
  /**
   * The M6 name for `defenseBonusPct` (INTERFACES.md M6: "`TerrainSpec` gains
   * `defenseBonus` (integer percentage, `>= 0`)").
   *
   * **Optional, and that is a recorded compromise rather than a preference.** The
   * engine's structural view of a terrain is `core/map.ts`' `TerrainDef`, which this
   * package does not own and whose `defenseBonusPct` every hand-built ruleset literal
   * in the tree already sets; making `defenseBonus` *required* on `TerrainDef` to
   * satisfy a required field here is 200+ type errors in files this workstream cannot
   * touch. So both spellings exist, both are validated, and the combat reader takes
   * `defenseBonus` when it is present.
   *
   * Every **shipped** row below declares it, so `validateRuleset`'s
   * "non-negative integer" check has real rows behind it and a real game reads the
   * M6 name. A row that declares only `defenseBonusPct` is legal and means the same
   * thing — `terrainDefenseBonus` in `core/combat.ts` is total over both.
   */
  readonly defenseBonus?: number;
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
  /**
   * The combat globals — M6b's section, and the *only* home of the magnitudes M6
   * wrote as module constants in `core/combat.ts`.
   *
   * **Required, like `units`, and required in fact rather than by convention**: the
   * engine's combat resolver reads every one of these numbers from the ruleset it is
   * handed and keeps no copy of them (`combat.ts`' `combatRulesOf`), so a catalog
   * without the section is a game whose battles have no rules at all. `validateRuleset`
   * refuses such a catalog, which is why this is a *section* rather than an optional
   * field: a game is fought under a stated set of numbers, not under whatever default
   * the resolver happened to carry.
   */
  readonly combat: CombatSpec;
  /**
   * The capture rule — the magnitudes a sack applies to the city it takes. Required,
   * like `combat`, and required *in fact* rather than by convention: `cities.ts`'
   * `captureCity` reads the divisor from the ruleset it is handed and keeps no copy of
   * it, so a catalog without this section is a game whose captures have no rule at all.
   * `validateRuleset` refuses such a catalog, which is what makes this a *section*
   * rather than an optional field with a default hiding behind it — the M6b argument,
   * applied to the one M6 magnitude that was still buried in logic.
   */
  readonly capture: CaptureSpec;
  /**
   * **The culture and contentment model — M9's section.** Required, like `combat` and
   * `capture`, and required *in fact*: `borders.ts`' `cultureRulesOf` and `happiness.ts`'
   * `happinessRulesOf` read every magnitude from the ruleset they are handed and keep no
   * copy, so a catalog without this section is a game whose borders and whose disorder
   * have no rules at all. `validateRuleset` refuses such a catalog.
   */
  readonly culture: CultureSpec;
  /**
   * **The government rows — M9's catalog.** Required, and required *in fact*: every
   * player in a `GameState` carries a `government` id (`newGame` stamps the default row
   * on civilizations and barbarians alike), `economy.ts` reads two magnitudes from the
   * row on every money-loop iteration, and validation requires the section to be
   * non-empty with exactly one row flagged as the default.
   */
  readonly governments: readonly GovernmentSpec[];
  /**
   * **The score weights — M10's section.** Required, like `combat`: `core/score.ts`
   * keeps no copy of any weight, so a catalog without it is a game whose scoreboard has
   * no basis.
   */
  readonly score: ScoreSpec;
  /**
   * **The victory thresholds — M10's section.** Required, like `combat`: `core/victory.ts`
   * reads all four from the ruleset it is handed, so a catalog without it is a game that
   * cannot end.
   */
  readonly victory: VictorySpec;
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
  /**
   * Hit points **at full health** — how many rounds this unit survives in combat
   * (M6, "Unit combat statistics": "`UnitSpec` gains required: `attack`, `defense`,
   * `hitPoints` … all integers, `hitPoints >= 1`").
   *
   * **Optional in the type, required in fact — and the runtime is where the
   * requirement is enforced.** The contract's "required" is honoured by
   * `validateRuleset`, which refuses a unit row that declares no `hitPoints` at all as
   * well as one that declares a fraction or a value below 1; every *shipped* row below
   * sets it. It cannot be a required property here for a mechanical reason worth
   * recording: `UnitDef` (in `core/units.ts`, which this package does not own) declares
   * it optional, and an override applier in `@civts/sim` rebuilds a `UnitSpec` field by
   * field from the fields it knows about — so a required property here would be a type
   * error in a package and a field list this workstream cannot touch. Meanwhile
   * `packages/core/test/*.test.ts`, `packages/testing/src/scenario.ts` and `@civts/sim`
   * all build standalone `RulesetView`s that never run `validateRuleset`, and those
   * must keep compiling. So: content is checked, and a hand-built view may say nothing,
   * in which case `core/units.ts`' `fullHitPoints` answers 1.
   */
  readonly hitPoints?: number;
  /**
   * The technology this row needs before any city may build it (M5's gating, "Gating").
   *
   * **M6 requires shipped content to declare one.** Before this wave *no row in this
   * catalog used any gate* — `requiresTech` existed only as a field the engine could
   * read, exercised by test overrides — which is exactly why two gating defects
   * survived M5 play testing: a gate nothing uses is a gate nothing tests. At least one
   * unit and at least one building/improvement below declare one, so the gate is
   * exercised by real content.
   *
   * Absent means "no tech requirement" — the key is **omitted**, never present and
   * `undefined`. `validateRuleset` rejects a value naming a tech no catalog row
   * defines, and the engine's readers (`core/tech.ts`' `requiresTechOf` /
   * `unmetTechRequirement`, asked from `core/resources.ts`) treat a row that declares
   * nothing as requiring nothing.
   */
  readonly requiresTech?: TechId;
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
  /**
   * Culture this building gives **its own city every turn** while it stands
   * (INTERFACES.md M9: "`BuildingSpec` gains required `culturePerTurn`, an integer
   * `>= 0`").
   *
   * **Required, and required in fact rather than by convention.** Every shipped row
   * below states a number, including the rows that state `0`, because the contract makes
   * it required and because "how much culture is this building worth?" is a question a
   * content author has to answer rather than inherit: a row that said nothing would be a
   * building whose culture is whatever a reader assumed. It cannot be a required
   * *property* for the mechanical reason `UnitSpec.hitPoints` is not one — the engine's
   * structural `BuildingDef` (in `core/cities.ts`, which this package does not own)
   * declares it optional, and `@civts/sim`'s override applier rebuilds a `BuildingSpec`
   * field by field — so, exactly as with `hitPoints`, `validateRuleset` is where the
   * requirement is enforced: a building row that declares no `culturePerTurn` at all is
   * refused alongside one that declares a fraction or a negative.
   *
   * **It is read on the `cityCultureGrew` path, not projected onto an effect.** The
   * engine's `BuildingEffect` union has no culture member and M9 does not add one: the
   * contract spells the field on the *spec* and `core/culture.ts`' `culturePerTurnOf`
   * reads it there, so a building's per-turn culture has one home (the row) and one
   * reader (the culture pass). `happiness` below takes the *other* route on purpose —
   * see its own note for why the two differ.
   */
  readonly culturePerTurn?: number;
  /**
   * Culture granted **once**, to the completing city, at the moment this building is
   * finished (INTERFACES.md M9: "`cultureBonus` (wonders only, one-off)").
   *
   * **Wonders only, enforced.** `validateRuleset` refuses a non-wonder row that declares
   * a non-zero bonus, and refuses a wonder that declares a non-positive one. Both halves
   * are rules rather than tidiness: the contract says "wonders only", so a temple with a
   * one-off would be content contradicting the frozen interface; and a wonder with no
   * bonus would be a wonder that does nothing special on completion, which is the one
   * moment a wonder *is* special in this engine (it has no other global effect).
   *
   * Absent means "no bonus", never `undefined` — `0` is refused rather than accepted as a
   * synonym, so a row that means "no bonus" says nothing and a row that declares this
   * field is making a claim the validator checks.
   */
  readonly cultureBonus?: number;
  /**
   * Content citizens this building makes — the number the contract spells
   * `BuildingSpec.happiness` (INTERFACES.md M9, "Happiness": "*happy from buildings*").
   *
   * **Required in fact, optional in type**, for exactly the reason `culturePerTurn` is:
   * the engine's structural `BuildingDef` does not declare it, so `validateRuleset`
   * enforces the contract's "required" and every shipped row states one (including the
   * zeros).
   *
   * ## Why this one *is* projected onto an effect and `culturePerTurn` is not
   *
   * A city's contentment is a *sum of the things that affect it*, and that sum is
   * computed by `core/buildings.ts`' `effectTotals`, which folds `BuildingEffect`s. So
   * `@civts/rules` projects this field onto a `{ kind: 'city-happiness', amount }` effect
   * **once, at validation time** — the single place a spec row becomes an effect — and
   * `BuildingDef` (the engine's view) deliberately carries no `happiness` field, so there
   * is exactly one path from content into a city's contentment and no second reader
   * (`cities.ts`' `cityYields` asks `happiness.ts`, which asks the effect total).
   *
   * `culturePerTurn` is not projected because nothing *sums* it: the culture pass walks
   * each city's own building ids and reads each row's number, so an effect row would be a
   * second copy of a number with no summer to keep it honest. **The rule is the same in
   * both cases — one home per magnitude — and the two fields differ only in whether an
   * existing summer wants them.** Saying so here, rather than leaving a reader to notice
   * the asymmetry, is the point.
   *
   * Signed, so a `-1` row is legal: an unhappy-making building is a rule this union can
   * express (`city-happiness` is signed) and a content author may want one. The shipped
   * catalog has none.
   */
  readonly happiness?: number;
  /** Present (and `true`) only for a wonder. Absent means "ordinary building". */
  readonly wonder?: true;
  /**
   * The technology this building needs before any city may start it (M5's gating).
   *
   * **M6 requires shipped content to declare one on at least one building or
   * improvement.** No row did before this wave, which is why the gate survived a whole
   * milestone as untested code; see `UnitSpec.requiresTech` for the full argument.
   * Absent, never `undefined`; `validateRuleset` rejects an unknown tech.
   */
  readonly requiresTech?: TechId;
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
  /**
   * The technology this improvement needs before a worker may build it (M5's gating).
   *
   * Absent, never `undefined`; `validateRuleset` rejects an unknown tech. At least one
   * shipped improvement declares one in M6, so the gate is reached by content — see
   * `UnitSpec.requiresTech`.
   */
  readonly requiresTech?: TechId;
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

/**
 * **The combat globals** (INTERFACES.md M6b, "The combat section of the catalog") —
 * the nine magnitudes that decide how a battle goes.
 *
 * ## Why this section exists at all
 *
 * M6 put these numbers in `packages/core/src/combat.ts` as module-level constants. That
 * violates the standing requirement's third clause — *every magnitude a system
 * introduces lives in the rules catalog (or an explicit override), never as a literal
 * buried in logic* — and it had a consequence the project had to report rather than
 * fix: the M6 combat balance sweep (`scripts/combat-balance-sweep.ts`) could vary a
 * unit's `attack` and a terrain's `defenseBonusPct`, but had to print this whole block
 * under "combat magnitudes this override surface CANNOT move". **A system whose knobs
 * cannot be swept cannot be balanced**, so the numbers belong to content, where
 * `RulesetPatch.combat` can move them one at a time and a sweep can measure what moved.
 *
 * ## This is a RELOCATION, not a rebalance
 *
 * Every value below is **exactly the number M6 shipped**, so the engine's behaviour —
 * and therefore every stored golden hash — is unchanged by the move. If a golden moves
 * after this section appears, something other than this section moved with it.
 *
 * ## Provenance: placeholder, all nine
 *
 * The five bonus percentages, the roll bound, the damage-per-round rule, the promotion
 * ladder and the odds clamp are **unsourced values of ours, chosen to be playable**.
 * None is traced to Civ 3, and none is presented as Civ 3's: the real game's
 * firepower/hit-point model, its terrain bonuses and its combat resolution are
 * different and are unverified here. `fidelity: 'cited-only'` refuses this section like
 * every other placeholder row.
 *
 * ## The one asymmetry a reader should not mistake for a bug
 *
 * `veteranAttackPct` is applied **to the attacker only** — M6's contract says so, the
 * engine does so, and it is deliberate. Civ 3 does something else instead: its veterans
 * gain extra *hit points* rather than an attack bonus. `core/combat.ts` states this
 * where the odds are computed, so a reader can judge the placeholder rather than assume
 * it is a defect. This field is the sweepable knob for that placeholder.
 */
export interface CombatSpec {
  /** Percent added to a fortified defender's defence. Integer `>= 0`. */
  readonly fortifyBonusPct: number;
  /** Percent added to a defender's defence when it stands in its own city. Integer `>= 0`. */
  readonly cityDefenseBonusPct: number;
  /** Percent added on top of that when the city holds defensive walls. Integer `>= 0`. */
  readonly wallsBonusPct: number;
  /** Percent added to an attacker's attack for **each** experience level. Integer `>= 0`. */
  readonly veteranAttackPct: number;
  /** The highest `experience` a unit may reach. Integer `>= 0`. */
  readonly maxExperience: number;
  /** The number of equally likely per-round draw outcomes. Integer `>= 1`. */
  readonly rollBound: number;
  /** Hit points a round winner takes off the loser. Integer `>= 1`. */
  readonly damagePerRound: number;
  /**
   * The lowest a per-round win chance may be. Integer, and the contract's chain
   * `1 <= minWinPct <= maxWinPct <= rollBound` is checked as one statement rather than
   * three independent bounds, because the three are one rule: the clamp has to be a
   * range the draw can express.
   */
  readonly minWinPct: number;
  /** The highest a per-round win chance may be. Integer, `<= rollBound`. */
  readonly maxWinPct: number;
  readonly provenance: Provenance;
}

/**
 * **The capture section of the catalog** — the one magnitude a *sack* applies, as
 * opposed to the nine the `combat` section applies to the fight that causes it.
 *
 * ## Why this section exists at all
 *
 * M6 wrote the rule "a captured city's population is halved" into
 * `packages/core/src/cities.ts` as `CAPTURE_POPULATION_DIVISOR = 2` — a module-level
 * constant. That is the standing requirement's third clause violated a second time
 * (*every magnitude a system introduces lives in the rules catalog, or an explicit
 * override, never as a literal buried in logic*), and it had exactly the cost M6b's
 * combat section was added to remove: `scripts/combat-balance-sweep.ts` had to list
 * `CAPTURE_POPULATION_DIVISOR` under "magnitudes this override surface CANNOT move".
 * **A knob nobody can turn is a knob nobody will ever tune**, so the number lives
 * here, `RulesetPatch.capture` moves it, `cities.ts` reads it from the ruleset it is
 * handed (`captureRulesOf`) and keeps no copy of it, and the sweep turns it.
 *
 * ## A section of its own, rather than a tenth combat magnitude
 *
 * The two tables answer different questions: `combat` decides **who wins a fight**,
 * and this section decides **what the winner inherits**. Folding a capture magnitude
 * into `combat` would make that section's own doc ("the nine magnitudes that decide
 * how a battle goes") false, and would make "the walls did nothing" and "the sack
 * cost the city nothing" two readings of one table — which is the confusion the two
 * separate sections exist to prevent.
 *
 * ## This is a RELOCATION, not a rebalance
 *
 * `populationDivisor` is **exactly the number M6 shipped** (`2`), so the engine's
 * behaviour — and therefore every stored golden hash — is unchanged by the move. If a
 * golden moves after this section appears, something other than this section moved
 * with it.
 *
 * ## Provenance: placeholder
 *
 * The divisor is an **unsourced value of ours, chosen to be playable**. It is not
 * traced to Civ 3 and is not presented as Civ 3's: the real game's capture losses
 * depend on the city's size, its buildings and the wonders it holds, which this engine
 * does not model at all, and the M6 contract states the rule itself as "population
 * drops (placeholder rule: halved, floored, minimum 1)" — a rule of ours, with no
 * source behind it. `fidelity: 'cited-only'` refuses this section exactly as it
 * refuses every other placeholder row.
 */
export interface CaptureSpec {
  /**
   * The divisor a captured city's population is divided by, floored, and never below
   * 1 citizen. Integer `>= 1`.
   *
   * `1` is legal and it *means* something — "a sack costs the city no citizens", a
   * lenient tuning position rather than a typo — while `0` is refused, because
   * `Math.floor(population / 0)` is `Infinity`: a value `canonicalize` cannot round-trip
   * and a state hash that would not survive a save. A negative divisor is refused for
   * the same reason a negative percentage is: it would *increase* a conquered city's
   * population, which is not what this field is.
   */
  readonly populationDivisor: number;
  readonly provenance: Provenance;
}

/**
 * **The culture section of the catalog** (M9) — the two culture thresholds that decide
 * how far a city's borders reach, the contentment ladder that decides when a city is in
 * disorder, and the two luxury magnitudes that decide how many of its citizens are
 * content.
 *
 * ## Why these are one section rather than three
 *
 * They are one *model*: what a city's accumulated culture and its buildings' contentment
 * do to the city. `borders.ts`' `cultureRulesOf` and `happiness.ts`' `happinessRulesOf`
 * both read this section, and the split between them is a split of *readers*, not of
 * tables — a section per reader would be three names for one set of magnitudes, which is
 * exactly the "one rule, two places" shape this project refuses. Keeping them together
 * also makes the sweep's job honest: a balance sweep over `RulesetPatch.culture` moves
 * the whole contentment-and-borders model, and a sweep that moved the border thresholds
 * without the happiness ladder could not answer "is the game winnable culturally *because*
 * it is also governable".
 *
 * ## The thresholds are `>=` and the ladder is ascending
 *
 * `borderRadius2Culture <= culture` (not `<`) is the rule the engine implements
 * (`borders.ts`' `claimedRadius`), so the numbers here are the *first* culture value at
 * which the radius applies: a city whose culture reaches exactly
 * `borderRadius2Culture` claims radius 2, and one point below it claims radius 1. Both
 * thresholds are checked as **one ascending pair** rather than as two independent
 * bounds, because a `borderRadius3Culture` below `borderRadius2Culture` is not a
 * stricter ruleset, it is a rule that can never fire: `claimedRadius` tests radius 3
 * first, so the radius-2 threshold would be dead data.
 *
 * `unhappyThresholds` is a ladder for the same reason and is checked the same way:
 * ascending, strictly, with the first rung at `minPopulation <= 1`, so that a city of
 * size 1 has a defined unhappy count. The ladder is **explicit about its rungs** rather
 * than implied by array index — a row states the population it starts at — because a
 * content author adding a rung in the middle must not have to renumber the ones after
 * it, and because an implied index is a magnitude that is not written down anywhere a
 * reader can see it.
 *
 * ## Provenance: placeholder, every number
 *
 * Every magnitude below is an **unsourced value of ours, chosen to be playable**. Civ 3
 * has a culture model (accumulated culture, city-radius expansion at 10/100/1000 for the
 * second ring and beyond, and a happiness model with luxuries, entertainers and
 * government-specific content/unhappy citizens) and this engine is **Civ-3-SHAPED, not
 * Civ 3**: the *shape* — cumulative culture expanding a city's reach, luxuries making
 * citizens content, size making them unhappy — is deliberate; the numbers are not Civ
 * 3's, are not measured from it, and are not claimed to match it. Every one of them is
 * `placeholder`, so `fidelity: 'cited-only'` refuses this section like every other.
 */
export interface CultureSpec {
  /**
   * The culture at which a city's borders reach radius 2. Integer `>= 0`, and
   * `<= borderRadius3Culture`.
   *
   * The radius-1 ring is **not** in this section: every city claims its eight
   * neighbours and its own tile from the moment it is founded, which is a rule (a city
   * with no culture still occupies the ground it stands on) rather than a threshold.
   * Written down here so a reader does not go looking for a third number.
   */
  readonly borderRadius2Culture: number;
  /** The culture at which a city's borders reach radius 3. Integer `>= borderRadius2Culture`. */
  readonly borderRadius3Culture: number;
  /**
   * The ladder from city size to unhappy citizens, **ascending by `minPopulation`**.
   *
   * Read by `happiness.ts`' `unhappyFromSize` as "the highest rung whose
   * `minPopulation <= population`", so a city of size 5 under the shipped ladder
   * (`1→0`, `3→1`, `6→2`, `10→4`) has 1 unhappy citizen.
   */
  readonly unhappyThresholds: readonly UnhappyThresholdSpec[];
  /**
   * How many connected luxury resources make one citizen content. Integer `>= 1`.
   *
   * `1` is legal and means "every connected luxury contented one citizen", which is the
   * most generous setting this field can express; `0` is refused because
   * `floor(luxuries / 0)` is `Infinity`, a value no state can hold.
   */
  readonly luxuriesPerHappyCitizen: number;
  /**
   * How much a **single** connected luxury resource is worth, as happiness, on top of
   * the `luxuriesPerHappyCitizen` count above. Integer `>= 0`.
   *
   * This is deliberately a second, additive term rather than a replacement for the
   * first. The two answer different questions a player asks separately — "do I have
   * enough luxuries?" (`luxuriesPerHappyCitizen`) and "does *this* luxury help me?"
   * (this field) — and the contract's happiness rule names both ("happy from buildings +
   * luxury resources + luxury spending"), which is why the engine computes both and adds
   * them. A catalog that wants only the count sets this to 0, which is a legal, stated
   * position rather than a degenerate one.
   */
  readonly happyPerLuxuryResource: number;
  readonly provenance: Provenance;
}

/**
 * One rung of `CultureSpec.unhappyThresholds`: the city size at which a count of
 * unhappy citizens begins to apply.
 *
 * A row rather than a plain number because the ladder's *steps* are the rule: a bare
 * `[0, 1, 2, 4]` array is a magnitude (the step size) that lives in logic — "three
 * citizens per extra unhappy citizen" would be an unwritten rule of the array's
 * indices — while `{ minPopulation: 6, unhappy: 2 }` states both numbers a reader or a
 * sweep needs.
 */
export interface UnhappyThresholdSpec {
  /** The lowest city size at which this rung applies. Integer `>= 1`. */
  readonly minPopulation: number;
  /** How many of the city's citizens are unhappy from size alone. Integer `>= 0`. */
  readonly unhappy: number;
}

/**
 * **The government section of the catalog** (M9) — one row per government, carrying the
 * four magnitudes that make a government mean something in this engine.
 *
 * ## What a government *is*, here
 *
 * Four numbers and a name. This engine has no palace, no revolution, no senate and no
 * diplomatic consequences; what it has is M4b's economy and M9's contentment, and a
 * government is exactly the set of dials those two systems let a ruler turn:
 *
 * - `rateCaps` — how far the tax/science/luxury sliders may go (M4b's `RATE_TOTAL` rule
 *   says the three *sum* to 10; these caps say how the ten may be *distributed*, which
 *   is why a despotism cannot run 0/0/10 and a republic can);
 * - `freeUnitsPerCity` and `unitSupportCost` — what an army costs (M4b's two module
 *   constants, relocated here);
 * - `happinessModifier` — what being ruled this way does to contentment (M9's new
 *   magnitude).
 *
 * ## M4b's two constants are RELOCATED, not rebalanced
 *
 * `FREE_UNITS_PER_CITY = 2` and `UNIT_SUPPORT_COST = 1` lived in `core/economy.ts`.
 * They move here as the `despotism` row's two numbers — **exactly**, so a game played
 * under despotism bills its army at the same price as before this wave, and the M4b
 * goldens survive the relocation. If a golden moves after this section appears, the
 * despotism row changed a number it was not supposed to.
 *
 * ## Provenance: placeholder, all of it
 *
 * Civ 3 has governments (despotism, monarchy, republic, democracy, communism, fascism)
 * and each has its own support and happiness rules. This engine ships three and the
 * *shape* is deliberately Civ-3-like — a repressive default with a low free-unit
 * allowance, a monarchy that supports a bigger army, a republic that pays for its army
 * but keeps its people happier — while every number below is **ours, unsourced and
 * chosen to be playable**. No row is a Civ 3 figure, the anarchy/revolution transition
 * is not modelled at all (see `core/governments.ts`), and `fidelity: 'cited-only'`
 * refuses this section like every other.
 */
export interface GovernmentSpec {
  readonly id: GovernmentId;
  readonly name: string;
  /** The highest each slider may reach. Integers `>= 0` and `<= RATE_TOTAL`. */
  readonly rateCaps: GovernmentRateCaps;
  /** Units supported for free per city owned. Integer `>= 0`. */
  readonly freeUnitsPerCity: number;
  /** Gold per turn per unit beyond the free allowance. Integer `>= 0`. */
  readonly unitSupportCost: number;
  /** Added to a city's unhappy count. Signed integer. */
  readonly happinessModifier: number;
  /**
   * The tech a player must know to adopt this government. Absent for one available from
   * the start. `validateRuleset` rejects an unknown tech, in the same block that checks
   * every other row's `requiresTech`.
   */
  readonly requiresTech?: TechId;
  readonly provenance: Provenance;
}

/** The per-slider ceilings a government imposes. Every field `>= 0` and `<= RATE_TOTAL`. */
export interface GovernmentRateCaps {
  readonly tax: number;
  readonly science: number;
  readonly luxury: number;
}

/**
 * **The score section of the catalog** (M10) — the five weights a player's score is the
 * sum of.
 *
 * ## One function, five numbers
 *
 * `core/score.ts` is the only scorer in the engine, and these are the only magnitudes in
 * it: `score = perPopulation * (citizens) + perCity * (cities) + perTech * (techs) +
 * perCulture * (culture) + perWonder * (wonders)`. Everything else about the score — that
 * it is a *derived* read, that it counts civilizations only, that ties break toward the
 * lower player id — is a rule and lives in that module.
 *
 * ## Why a weight of 0 is legal and meaningful
 *
 * A catalog may say "culture does not count toward this game's score" by setting
 * `perCulture: 0`. That is a tuning position rather than a degenerate section — the
 * other four weights still order the players — and refusing it would make the sweep
 * unable to ask the question "what does the game look like if only territory matters?".
 * The *section* being absent is different and is refused, because a catalog with no
 * score section is one whose score nobody chose.
 *
 * ## Provenance: placeholder, all five
 *
 * Civ 3's score is a per-turn accumulation over territory, population, content citizens,
 * techs, wonders and future tech, rescaled against the game's difficulty and the
 * turn-limit scale. **This engine's score is a different thing wearing similar
 * vocabulary**: a single end-of-turn integer whose weights are ours, unsourced, and
 * chosen only so that a scoreboard orders players sensibly. None of the five is a Civ 3
 * figure and `fidelity: 'cited-only'` refuses the section.
 */
export interface ScoreSpec {
  /** Score per citizen in the player's cities. Integer `>= 0`. */
  readonly perPopulation: number;
  /** Score per city owned. Integer `>= 0`. */
  readonly perCity: number;
  /** Score per technology known. Integer `>= 0`. */
  readonly perTech: number;
  /** Score per point of accumulated culture (the derived player total). Integer `>= 0`. */
  readonly perCulture: number;
  /** Score per wonder held. Integer `>= 0`. */
  readonly perWonder: number;
  readonly provenance: Provenance;
}

/**
 * **The victory section of the catalog** (M10) — the four thresholds a game can end at.
 *
 * ## Four conditions, four numbers, and one of them is a turn
 *
 * | condition | threshold | field |
 * |---|---|---|
 * | conquest | last civilization standing | *(none — it is a structural rule)* |
 * | domination | land **and** population share — **both** | `dominationLandPct`, `dominationPopPct` |
 * | cultural | accumulated player culture | `culturalVictoryCulture` |
 * | score | the turn limit | `scoreVictoryTurn` |
 *
 * Conquest has no number because it has no threshold: "every other civilization has no
 * cities" is `core/victory.ts`' `conquestWinner`, a shape of the board rather than a
 * magnitude. Nothing here can be turned to make conquest easier or harder, which is
 * worth stating so a sweep does not go looking for the knob.
 *
 * ## Domination is an AND, and the land share is over the MAP's land
 *
 * Two corrections to this document's own earlier wording, both ruled on by the
 * **AMENDMENT at the end of `docs/INTERFACES.md`**, which holds that the M9+M10
 * contract's sentence — "land **or** population", measured against "claimed land" — was
 * **wrong and the implementation right**:
 *
 * 1. **Both shares must hold.** `dominationWinner` returns early when the land half
 *    fails and only then tests the population half. The "or" reading was measured: with
 *    it, domination fires on **turn 1** of an ordinary game, because the first
 *    civilization to found a capital holds 100 % of both the claimed land and the world's
 *    citizens before anybody else has been polled.
 * 2. **The land denominator is `landTileCount` — every land tile on the map — not the
 *    land any city claims.** A share of claimed land is a denominator a player *lowers*
 *    by claiming less, which makes the condition easier the worse they play; a percentage
 *    of the world's ground is a number that does not move while they make progress.
 *
 * The rule itself is stated once, in `core/victory.ts`' `dominationWinner`, and pinned at
 * each threshold by `packages/testing/test/m9-m10-adversarial.test.ts` (which shows the
 * land half is *necessary*, the half an "or" reading would have let through).
 *
 * ## The two percentages are compared with INTEGER arithmetic
 *
 * `victory.ts`' `dominationWinner` tests `owned * 100 >= pct * total` rather than
 * `owned / total >= pct / 100`, because the second form is floating-point division in a
 * determinism-critical module (`packages/core` may not use transcendentals, and a
 * float comparison is a rounding decision at exactly the boundary a threshold test
 * lives on). That is why `pct` is an integer percentage rather than a fraction, and why
 * the boundary is `>=`: **a player holding exactly the stated percentage wins**, which
 * the adversarial boundary tests pin at the value and one step below.
 *
 * ## A `scoreVictoryTurn` behind the runner's `maxTurns` is a game nobody can win
 *
 * `scoreVictoryTurn` is the **turn at which the score victory is decided** — the
 * contract's "at turn limit" — and it is deliberately a *catalog* horizon rather than
 * the experiment budget `SimulationOptions.maxTurns`. A simulation that stops at
 * `maxTurns: 100` while the catalog's horizon is 200 stops because the *experiment*
 * ended, with no winner: `stoppedBecause: 'max-turns'`. That distinction is stated here
 * because conflating the two would make every short simulation claim a score victory.
 * A value of `Number.MAX_SAFE_INTEGER` is legal and means "this ruleset has no score
 * victory", which the shipped catalog does **not** use.
 *
 * `culturalVictoryCulture` is compared with `>=` ("a player whose culture reaches the
 * threshold wins", never "exceeds"), so the boundary is the value itself.
 *
 * ## Provenance: placeholder, all four
 *
 * Civ 3's victory conditions are conquest, domination (two thirds of the land and
 * population), cultural (100,000 culture, or 20,000 per city), diplomatic, spaceship and
 * Histographic. **This engine ships four of those names and none of those numbers**:
 * the two percentages, the culture threshold and the turn horizon are ours, unsourced,
 * chosen so that a game of a few hundred turns can plausibly end under each of them,
 * and are not presented as Civ 3's. There is no diplomatic, spaceship or wonder victory
 * here, and `fidelity: 'cited-only'` refuses the section.
 */
export interface VictorySpec {
  /**
   * The share of the **map's land** a player must hold to win by domination. Integer
   * percentage, and the comparison is `>=`. `1..100`.
   *
   * The denominator is `core/map.ts`' `landTileCount` — every land tile on the map —
   * and **not** the land any city claims. The frozen M9+M10 contract said "claimed
   * land"; the AMENDMENT at the end of `docs/INTERFACES.md` rules that wording wrong,
   * because a share of claimed land is a moving denominator a player can lower by
   * claiming less, which makes the condition easier the worse they play. On turn 1 the
   * first capital owned 5 of the 5 claimed tiles — 100 % — and a 60 % threshold was met
   * before anybody had played; `core/victory.ts` records that measurement.
   *
   * This half is **required**, not one alternative of two: `dominationWinner` returns
   * early when this share fails and only then tests `dominationPopPct`.
   */
  readonly dominationLandPct: number;
  /**
   * The share of the world's population a player must hold to win by domination.
   * Integer percentage, compared with `>=`. `1..100`.
   *
   * "The world's population" counts **every city's citizens, barbarian cities
   * included** — it is a fact about the world, not about civilizations. Barbarians
   * never *win* by this route (`civPlayers()` decides who is a candidate), so their
   * citizens appear only in the denominator.
   *
   * Required together with `dominationLandPct`: domination is an AND over the two
   * shares, and a world with no citizens is a world with no domination victory.
   */
  readonly dominationPopPct: number;
  /**
   * The accumulated culture a player needs to win culturally. Integer `>= 1`,
   * compared with `>=`.
   *
   * Measured on the **derived** player total (`core/culture.ts`' `playerCulture` — the
   * sum of that player's cities' accumulated culture), because no player-level culture is
   * stored.
   */
  readonly culturalVictoryCulture: number;
  /**
   * The turn at which the score victory is decided: the player with the highest score
   * wins, and a tie is a `draw` with `winner: null`. Integer `>= 1`.
   */
  readonly scoreVictoryTurn: number;
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
  /**
   * The combat globals, carried through validation unchanged — and **present on the
   * validated ruleset**, not only on the catalog.
   *
   * That is load-bearing, not tidiness: `core/combat.ts` reads every one of these
   * magnitudes *from the ruleset it is handed* and keeps no module-level copy of any of
   * them, so a validated ruleset that dropped this section would leave every battle
   * with no rules to fight under — the shape of bug the M6b contract exists to make
   * impossible. (`RulesetView` in `core/map.ts` is the engine's structural view and
   * does not declare the field, so the resolver reads it structurally; every real game
   * is played on a validated `Ruleset`, which always carries it.)
   */
  readonly combat: CombatSpec;
  /**
   * The capture rule, carried through validation unchanged — and **present on the
   * validated ruleset**, not only on the catalog.
   *
   * Load-bearing for the same reason as `combat`, one rule later in the turn: every
   * capture — the player's `AttackUnit`, and the barbarian step's own sacks inside
   * `advanceTurn` — reaches `cities.ts`' `captureCity` with the ruleset in hand, and the
   * population the sack leaves is read from *this* section through `captureRulesOf`. A
   * validated ruleset that dropped it would leave a captured city's population decided by
   * a number nobody chose, which is the exact defect the M7 repair removes. (`RulesetView`
   * does not declare the field — it is the engine's structural view — so the reader is
   * total over it; every real game is played on a validated `Ruleset`, which always
   * carries it.)
   */
  readonly capture: CaptureSpec;
  /**
   * **M9's culture and contentment model**, carried through validation unchanged.
   *
   * `RulesetView` does not declare the field (it is the engine's structural view, and
   * `borders.ts`/`happiness.ts` read their sections structurally, total over a missing
   * one), so this is the *typed* home of the same data — which is what makes the shipped
   * catalog's numbers reachable as numbers by a test or a sweep rather than only as
   * untyped reads. Every real game is played on a validated `Ruleset`, which always
   * carries it.
   */
  readonly culture: CultureSpec;
  /**
   * **M9's government rows**, carried through validation unchanged — the same argument
   * as `culture`, and one more: `core/governments.ts`' `governmentDef` reads this list
   * for every rate check, every free-unit allowance and every happiness modifier, and a
   * validated ruleset that dropped it would leave every player's government nameable but
   * meaningless.
   */
  readonly governments: readonly GovernmentSpec[];
  /** **M10's score weights**, carried through unchanged. See `Ruleset.culture`. */
  readonly score: ScoreSpec;
  /** **M10's victory thresholds**, carried through unchanged. See `Ruleset.culture`. */
  readonly victory: VictorySpec;
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
      defenseBonus: 10,
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
      defenseBonus: 10,
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
      defenseBonus: 50,
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
      defenseBonus: 100,
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
      defenseBonus: 0,
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
      defenseBonus: 0,
      yields: { food: 1, shields: 0, commerce: 2 },
      impassable: true,
      provenance: placeholder('tuned baseline; requires a sea unit to enter'),
    },
  ],
  /**
   * Unit rows, all PLACEHOLDER (PLAN.md §6.2). Every number here is **ours**,
   * unsourced and chosen to be playable; no row is traced to Civ 3, and Civ 3's own
   * attack/defence/hit-point values are a different model entirely (firepower and
   * hit points per unit type, which this engine does not reproduce).
   *
   * **The shape M6 gives this table**, and why:
   *
   * - **One unit per engine role**, plus two sea rows so `domain: 'sea'` is exercised
   *   by more than a single flag-carrier.
   * - **Every row declares `attack`, `defense` and `hitPoints`** — required by the M6
   *   contract, checked by `validateRuleset`, and the three numbers `core/combat.ts`
   *   reads. The stats are **distinct** rather than uniform, because a catalog whose
   *   every military row had the same profile would make the combat resolver's output
   *   look identical whatever it did.
   * - **At least one row has `attack: 0`.** The M6 rule "a unit with `attack === 0`
   *   may not attack" is a *legality* rule enforced by the command layer, and a rule
   *   nothing satisfies is a rule nothing tests: the settler, the worker, the scout,
   *   the galley and the transport all declare zero attack, so the refusal is
   *   reachable from real content. The **transport** is the deliberate case — a
   *   military-role, `attack: 0` row — since "it is a warship, so surely it may
   *   attack" is exactly the assumption the rule needs to defeat.
   * - **At least one row declares `requiresTech` and at least one `requiresResource`
   *   (M6).** The M5 gates existed with no shipped row using them, which is precisely
   *   why two gating defects survived M5 play testing — see the `horseman` and
   *   `archer` rows below, whose provenance notes say so outright.
   * - **The `warrior` stays first among the `military` land rows and the `scout`
   *   stays the cheapest row in the table.** Neither is cosmetic: `hut.ts` gives away
   *   and spawns the *cheapest* military land unit (ties by id), and the played golden
   *   produces the cheapest unit the catalog defines. Moving either would change what a
   *   hut hands out or make the golden's fixed script start choosing a gated row — a
   *   behavioural change smuggled in by content *order*, which is why `rules.test.ts`
   *   pins both.
   */
  units: [
    {
      id: asUnitTypeId('settler'),
      role: 'settler',
      name: 'Settler',
      attack: 0,
      defense: 0,
      hitPoints: 1,
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
      hitPoints: 1,
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
      defense: 1,
      hitPoints: 2,
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
      defense: 2,
      hitPoints: 3,
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
      defense: 2,
      hitPoints: 3,
      movement: 3,
      cost: 2,
      domain: 'sea',
      provenance: placeholder(
        'tuned baseline; sea domain is a consistency flag in M2, no transports',
      ),
    },
    {
      // M6: the tech gate, reachable from shipped content. **No shipped row declared
      // `requiresTech` before M6**, which is exactly why two gating defects survived
      // M5's play testing: a gate no row uses is a gate nothing exercises, so a
      // planner/applier disagreement about it has no symptom in a real game. This row
      // is the cheapest place to close that: an archer is exactly the kind of thing a
      // player expects to be gated behind a military technology.
      id: asUnitTypeId('archer'),
      role: 'military',
      name: 'Archer',
      attack: 3,
      defense: 0,
      hitPoints: 3,
      movement: 1,
      cost: 2,
      domain: 'land',
      requiresTech: asTechId('warrior-code'),
      provenance: placeholder(
        'unsourced: these combat stats, the cost and the Warrior Code requirement are ours, chosen to be playable; ' +
          'the damage-heavy, no-defence-at-all profile is a tuning choice — the archer is the row that *needs* a ' +
          'defender in front of it — and declaring `requiresTech` here is M6 closing ' +
          "M5's gap rather than a claim about Civ 3's unit tree",
      ),
    },
    {
      id: asUnitTypeId('spearman'),
      role: 'military',
      name: 'Spearman',
      attack: 1,
      defense: 3,
      hitPoints: 3,
      movement: 1,
      cost: 2,
      domain: 'land',
      // Gated on the **military** tech rather than on Bronze Working, which is where a
      // spearman "belongs" in Civ 3's tree. The reason is a real coupling rather than taste:
      // this tree's Bronze Working has a pinned unlock set in a scenario fixture built from
      // this very catalog (`packages/testing/test/scenarios.test.ts`, "a completed tech
      // unlocks exactly its own rows"), so gating shipped content on it would turn that
      // scenario into a test of our gate. M6 requires that real content *declares and
      // reaches* a gate, not which technology it names, and filing the two ancient military
      // specialists under one military tech keeps the requirement and the coupling apart.
      requiresTech: asTechId('warrior-code'),
      provenance: placeholder(
        'unsourced: these combat stats, the cost and the Warrior Code requirement are ours, chosen to be playable; ' +
          'the mirror of the archer — it holds ground rather than taking it — and not a Civ 3 figure',
      ),
    },
    {
      id: asUnitTypeId('horseman'),
      role: 'military',
      name: 'Horseman',
      attack: 3,
      defense: 1,
      hitPoints: 2,
      movement: 2,
      cost: 3,
      domain: 'land',
      // M4c's resource gate *and* M5's tech gate on one row, on purpose: the two gates
      // are independent dimensions, and a row that needs both is the case where getting
      // the ordering wrong in a planner is visible.
      requiresResource: asResourceId('horses'),
      requiresTech: asTechId('horseback-riding'),
      provenance: placeholder(
        'unsourced: these combat stats, the cost, the horses requirement and the Horseback Riding requirement are ' +
          'ours, chosen to be playable; the only shipped row that is gated on a resource *and* a technology, which ' +
          'is what makes the two M5 gates reachable together rather than only one at a time',
      ),
    },
    {
      // M4c's resource gate, reachable from shipped content: this is the row that made
      // "a city connected by road to a strategic resource may build the unit that needs
      // it, and one that is not may not" a rule a real game exercises rather than one
      // only a hand-built ruleset view can reach.
      //
      // M6 adds `hitPoints` and re-tunes the stats so the five military land rows are
      // pairwise distinct in profile (warrior balanced, archer damage-heavy and
      // fragile, spearman defensive, horseman fast, swordsman strong all round). The
      // resource requirement, the cost and the position stay: the position is part of
      // the ruleset's hashed identity and `rules.test.ts` pins the warrior as the first
      // military land row precisely so a gratutitous reorder cannot change what a hut
      // hands out.
      id: asUnitTypeId('swordsman'),
      role: 'military',
      name: 'Swordsman',
      attack: 2,
      defense: 2,
      hitPoints: 4,
      movement: 1,
      cost: 3,
      domain: 'land',
      requiresResource: asResourceId('iron'),
      provenance: placeholder(
        'unsourced: these stats, the 4 hit points, the cost and the iron requirement are ours, chosen to be playable; ' +
          "gating is M4c's use of a strategic resource, and Civ 3's own unit requirements are unverified here",
      ),
    },
    {
      // M6's deliberate `attack: 0` case inside the *military* role. Every other
      // zero-attack row here is a civilian (settler, worker, scout) or a warship
      // (galley), where "it cannot attack" reads as obvious; a transport is the row a
      // reader would expect to fight, so it is the one that gives the "attack 0 may not
      // attack" rule something to actually refuse. Appended last, so it changes no
      // existing row's position in the catalog.
      id: asUnitTypeId('transport'),
      role: 'military',
      name: 'Transport',
      attack: 0,
      defense: 1,
      hitPoints: 4,
      movement: 2,
      cost: 3,
      domain: 'sea',
      requiresTech: asTechId('map-making'),
      provenance: placeholder(
        'unsourced: these stats, the 4 hit points, the cost and the Map Making requirement are ours, chosen to be ' +
          'playable; `attack: 0` on a military sea row is deliberate, because "a warship may of course attack" is ' +
          'the assumption the M6 rule has to defeat — and M6 models no troop carrying, so this row is a gunless ' +
          'hull rather than a claim about Civ 3 transports',
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
      // Deliberately **ungated**, and it is the one building where that is load-bearing:
      // this is the cheapest row in the table (10 shields), so it is what the played
      // golden's fixed script builds and what a player's first city can afford. Putting
      // a technology in front of it would move the *earliest* building in the game
      // behind a research step, which is a playability decision M6 does not make — the
      // gated building below is a later, larger investment instead.
      // M9: no culture and no contentment — a granary is about food, and this row says
      // so with the two zeros rather than by omitting the fields.
      culturePerTurn: 0,
      happiness: 0,
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
      // M9: no culture, no contentment.
      culturePerTurn: 0,
      happiness: 0,
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
      // M9: no culture, no contentment.
      culturePerTurn: 0,
      happiness: 0,
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
      // M9 keeps the commerce multiplier (it is M4c's tuning, untouched) and adds the
      // two fields a temple is actually *for*: `culturePerTurn` and `happiness`, below.
      // The note is retuned to say so, because its M4c wording ("no happiness effect is
      // modelled until M9") became false the moment M9 landed — a stale provenance note
      // is a false claim about this row.
      effects: [{ kind: 'commerce-multiplier', pct: 25 }],
      // M6: the gated building. **This is the row that makes "M6 content actually uses the
      // gates M5 built" true for buildings**, so a later retune that removes it silently
      // un-uses the gate — `rules.test.ts` asserts the gate by id for exactly that reason.
      //
      // Ceremonial Burial is the prerequisite rather than a science or growth tech, so the
      // gate is reached from a *third* branch of the tree (the units are gated on Warrior
      // Code, Horseback Riding and Map Making), which is what makes it a statement about
      // the gate rather than about one opening strategy. The row is otherwise untouched:
      // its cost and effects are M4c's placeholders, not M6's.
      requiresTech: asTechId('ceremonial-burial'),
      // M9: **a temple is the first culture-producing building**, and its 25% commerce
      // multiplier above stops being a stand-in for happiness the moment this field
      // exists. One culture per turn and one content citizen: enough that a single
      // temple reaches radius 2 in a plausible number of turns (see the `culture`
      // section below for the threshold) and enough to hold a size-4 city out of
      // disorder on its own.
      culturePerTurn: 1,
      happiness: 1,
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance, the 25% commerce multiplier, the 1 culture per turn ' +
          'and the 1 content citizen are ours, chosen to be playable, and none is traced to Civ 3; M4c ' +
          'shipped this row with a commerce multiplier standing in for happiness because contentment was ' +
          'not modelled yet, and M9 adds the real fields beside it rather than replacing it; the Ceremonial ' +
          "Burial requirement is M6 closing M5's unused-gate gap, not a Civ 3 figure",
      ),
    },
    {
      id: asBuildingId('library'),
      name: 'Library',
      cost: 20,
      maintenance: 1,
      effects: [{ kind: 'beaker-multiplier', pct: 50 }],
      // Deliberately **ungated** (the gate M6 adds is on the temple, below): the M4c
      // building-effects scenario builds a library on a hand-built, tech-free board to
      // measure its 50% beaker multiplier, so a technology in front of it would turn that
      // scenario into a test of the tech gate instead of a test of the multiplier.
      // M9: a library is a *culture* building here as well as a science one — that is a
      // shape choice (knowledge makes a city's influence grow) and a placeholder, not a
      // Civ 3 claim; Civ 3's library gives no culture.
      culturePerTurn: 1,
      happiness: 0,
      provenance: placeholder(
        'unsourced: this cost, the 1 gold maintenance, the 50% beaker multiplier and the 1 culture per turn are ' +
          "ours, chosen to be playable; M5 gave the beakers something to do, and M9 adds the culture — Civ 3's " +
          "library produces no culture, so that pairing is this engine's shape and not a claim",
      ),
    },
    {
      id: asBuildingId('marketplace'),
      name: 'Marketplace',
      cost: 12,
      maintenance: 1,
      effects: [{ kind: 'commerce-multiplier', pct: 50 }],
      // M9: no culture. The luxury half of the contentment model is about *resources*
      // and slider spending, not about the building that multiplies commerce.
      culturePerTurn: 0,
      happiness: 0,
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
      // M9: no culture, no contentment. A factory is the one building here that a
      // player might expect to make people *unhappy*; that is a tuning position this
      // union can express (`happiness` is signed) and the shipped catalog does not take
      // it, so the field states the zero.
      culturePerTurn: 0,
      happiness: 0,
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
      // M9: the wonder's culture. Two per turn for as long as it stands, and a
      // one-off 10 the turn it completes — the only `cultureBonus` in the catalog, and
      // the row `validateRuleset`'s "wonders only, and a wonder must declare one"
      // check is written for.
      culturePerTurn: 2,
      cultureBonus: 10,
      happiness: 1,
      provenance: placeholder(
        'unsourced: this cost, the 2 gold maintenance, the growth-food amount, the 2 culture per turn, the ' +
          '10-culture one-off and the 1 content citizen are ours, chosen to be playable; the only shipped ' +
          "wonder, marking the wonders-v1 rules and M9/M10's wonder-culture rule rather than reproducing " +
          "Civ 3 numbers — Civ 3's Pyramids give no culture at all",
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
      // Deliberately **ungated**, and the reason is a real coupling rather than a
      // preference: the M4a scenario suite builds and cancels irrigation jobs by id on
      // tech-free boards (`packages/testing/test/scenarios.test.ts` names it fifteen times),
      // so a technology in front of it would turn every one of those scenarios into a test
      // of the tech gate instead of a test of work. The gated *building* M6 adds is the
      // library, above; this row stays reachable from turn one.
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
   *   walk to reach every row, and `core/test/tech.test.ts` replays the
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
   * - **What a tech unlocks is now wired, and M6 is what wired it.** M5 built the
   *   gate (`requiresTech` on units, buildings and improvements, read by
   *   `core/tech.ts` and enforced where production and build legality are decided)
   *   but shipped **no row that used it** — which is exactly why two gating defects
   *   survived M5 play testing. M6 gives the tree real customers: `warrior-code` gates
   *   the archer, `bronze-working` the spearman, `map-making` the transport,
   *   `horseback-riding` the horseman (which also needs horses), `pottery` the
   *   granary and `alphabet` the library. So a research choice now decides what a city
   *   may build, and `core/tech.ts`' `techUnlocks` reports real rows rather than
   *   nothing.
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
      'map-making',
      'Map Making',
      'ancient',
      8,
      ['pottery'],
      'the second route out of pottery, so the first research choice is not the only one that opens the sea',
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
      'horseback-riding',
      'Horseback Riding',
      'medieval',
      13,
      ['the-wheel', 'warrior-code'],
      'the one medieval row that joins the commerce branch to the military one, which is what the horseman is gated on',
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
  /**
   * **The combat globals (M6b)** — every number M6 wrote as a module constant in
   * `core/combat.ts`, moved here unchanged so that a balance sweep can turn one of them
   * without editing code (INTERFACES.md M6b; standing requirement, *Tunable*).
   *
   * The values are **exactly M6's**, so this is a relocation and not a rebalance: the
   * resolver's arithmetic, the battles it produces and therefore every stored golden
   * hash are unchanged by the move. `fidelity: 'cited-only'` refuses the section, as it
   * refuses every other placeholder row here.
   *
   * The shape of the table is worth reading as a whole, because the nine numbers are one
   * model rather than nine independent preferences:
   *
   * - **Three defender bonuses** (`fortifyBonusPct`, `cityDefenseBonusPct`,
   *   `wallsBonusPct`) are kept *apart* rather than folded into one "defensive terrain"
   *   number: a city is an advantage on its own and walls are a building a city may or
   *   may not hold, so one number meaning both would make "the walls did nothing"
   *   unmeasurable — which is the whole point of sweeping them.
   * - **`veteranAttackPct`** turns experience into a *continuous* ladder
   *   (`maxExperience` levels of it) instead of Civ 3's discrete veteran/elite unit
   *   types, so the sweep can vary one number and measure the effect on outcomes.
   * - **`rollBound`, `minWinPct`, `maxWinPct`** are one rule: the per-round chance is
   *   an integer percentage floored against a draw of `rollBound` values, clamped to a
   *   range the draw can express, so no battle is ever decided before it is fought
   *   (`maxWinPct <= rollBound`) and no attack is ever hopeless by construction
   *   (`minWinPct >= 1`).
   * - **`damagePerRound`** is the pacing knob: with 1 the loop is "one hit point per
   *   round won", and a sweep can move it to see battles get shorter without any other
   *   number changing.
   */
  combat: {
    fortifyBonusPct: 25,
    cityDefenseBonusPct: 50,
    wallsBonusPct: 50,
    veteranAttackPct: 25,
    maxExperience: 3,
    rollBound: 100,
    damagePerRound: 1,
    minWinPct: 1,
    maxWinPct: 99,
    provenance: placeholder(
      'unsourced: these nine combat magnitudes are ours, chosen to be playable, and none of them is ' +
        'traced to Civ 3, whose combat model (firepower, hit points per unit type, terrain and ' +
        'veteran rules) is a different one that this engine does not reproduce; M6 shipped them as ' +
        'module constants in `core/combat.ts` and M6b relocates them here with the **same numbers** ' +
        '(a relocation, not a rebalance) so a balance sweep can move them through ' +
        '`RulesetPatch.combat` instead of reporting that they cannot be moved',
    ),
  },
  /**
   * **The capture rule (M7)** — the one M6 magnitude that was still a module constant
   * in `core/cities.ts` (`CAPTURE_POPULATION_DIVISOR = 2`), moved here unchanged so a
   * balance sweep can turn it (INTERFACES.md M7, "Repairs carried into this wave";
   * standing requirement, *Tunable*).
   *
   * The value is **exactly M6's**, so this is a relocation and not a rebalance: the
   * capture rule's arithmetic, the cities it produces and therefore every stored golden
   * hash are unchanged by the move. `fidelity: 'cited-only'` refuses the section, as it
   * refuses every other placeholder row here.
   *
   * The section is one number because the *rule* is one number: M6 captured "halved,
   * floored, minimum 1", and the divisor is the whole of what that leaves to choose. The
   * parts that are not a choice are stated in `cities.ts` where the rule is applied —
   * the floor, the minimum of one citizen, the maintenance-descending destruction order,
   * and the two fields a sack deliberately leaves alone (`foodBox`, `shields`).
   */
  capture: {
    populationDivisor: 2,
    provenance: placeholder(
      'unsourced: this divisor is ours, chosen to be playable, and none of it is traced to Civ 3, ' +
        "whose capture losses depend on the city's size, its buildings and its wonders — which this " +
        'engine does not model; M6 shipped it as `CAPTURE_POPULATION_DIVISOR` in `core/cities.ts` and ' +
        'M7 relocates it here with the **same number** (a relocation, not a rebalance) so a balance ' +
        'sweep can move it through `RulesetPatch.capture` instead of reporting that it cannot be moved',
    ),
  },
  /**
   * **M9's culture and contentment model** — see `CultureSpec` for the full argument.
   *
   * The four magnitudes, and why each is where it is:
   *
   * | field | value | what it decides |
   * |---|---|---|
   * | `borderRadius2Culture` | 10 | a city claims radius 2 once it has 10 culture |
   * | `borderRadius3Culture` | 100 | …and radius 3 at 100 |
   * | `unhappyThresholds` | `1→0, 7→1, 12→2, 18→4` | size makes citizens unhappy |
   * | `luxuriesPerHappyCitizen` | 2 | two connected luxuries content one citizen |
   * | `happyPerLuxuryResource` | 1 | …and each luxury contents one more |
   *
   * **The threshold shape is Civ-3-like and the numbers are not Civ 3's.** Civ 3 expands
   * a city's reach at 10, 100 and 1,000 culture for its successive rings; the first two
   * of those are the two numbers here, arrived at independently as "a temple reaches the
   * second ring in ten turns and the third in a hundred" and *not* copied from a source.
   * Shipping 10 and 100 while saying "these are Civ 3's" would be exactly the false
   * fidelity claim PLAN.md §6.2 forbids, so the claim is the reverse: they look similar
   * because they are round numbers a player can reason about, and no measurement stands
   * behind them.
   *
   * **Why the ladder has four rungs, and why the rungs moved out from `3/6/10`.**
   *
   * A city must be able to grow to the point where a player has to *do* something —
   * that is what makes disorder a mechanic rather than a rounding error — and the
   * fourth rung is where the shipped buildings stop being sufficient on their own (a
   * temple and a wonder content two citizens; beyond that a player reaches for
   * luxuries, which is the loop the two luxury fields exist to close).
   *
   * The first three rungs were `3/6/10` when this section was written, and they were
   * **measured to be unplayable** and moved to `7/12/18`. The measurement, exactly:
   *
   * 1. A city of **three** citizens has one unhappy citizen and no happiness source of
   *    its own, so it is in disorder — and disorder stops it producing shields. The
   *    temple that would content that citizen is itself bought with shields, and it is
   *    gated on Ceremonial Burial, so a city that reaches size 3 before the tech does
   *    can never build the thing that would cure it. The state is unrecoverable, not
   *    merely unhappy.
   * 2. In a real 100-turn game (`SIMPLE_POLICY`, tiny map, two civilizations) that
   *    produced **9 disordered cities out of 11**, including six size-3 cities whose
   *    shield pools never left single digits: `c1/p3:u1h0D[granary]sh0`,
   *    `c3/p3:u1h0D[granary]sh4`, and so on. One civilization's whole territory was
   *    frozen for the rest of the run.
   * 3. The engine's own growth demonstration — a city growing from size 1 with no
   *    buildings, the canonical statement that the growth loop works — stops producing
   *    at three citizens (`shields at turn 14: 32 banked by then plus 4 at three
   *    citizens = 36 (got 32)`).
   *
   * None of those three is a fact about the disorder *rule*, which is the contract's
   * and is unchanged. They are facts about the numbers, and the numbers are
   * `placeholder` — unsourced and chosen to be playable. `7/12/18` keeps every
   * property the shape was chosen for (a city can still grow into disorder, a temple
   * and a wonder still content two citizens, a metropolis still needs luxuries) while
   * putting the first rung past the point where a city could plausibly have built
   * one: a city that reaches size 7 has been producing for many turns.
   *
   * Civ 3's own answer to this is *content citizens granted by government*, which this
   * engine does not model — `GovernmentSpec.happinessModifier` is a signed modifier on
   * the unhappy count, not a free allowance — so the rungs carry that job here.
   */
  culture: {
    borderRadius2Culture: 10,
    borderRadius3Culture: 100,
    unhappyThresholds: [
      { minPopulation: 1, unhappy: 0 },
      { minPopulation: 7, unhappy: 1 },
      { minPopulation: 12, unhappy: 2 },
      { minPopulation: 18, unhappy: 4 },
    ],
    luxuriesPerHappyCitizen: 2,
    happyPerLuxuryResource: 1,
    provenance: placeholder(
      'unsourced: the 10/100 border thresholds, the four-rung unhappy ladder (deliberately re-runged from ' +
        '3/6/10 to 7/12/18 after it was measured to make a city of three citizens permanently unable to ' +
        'build the temple that would cure it), the two-luxuries-per-content-' +
        'citizen divisor and the one-per-luxury term are all ours, chosen to be playable, and none is ' +
        'traced to Civ 3 or measured from it; Civ 3 expands city reach at 10/100/1000 culture and has its ' +
        'own happiness model with entertainers, luxuries, war weariness and per-government content ' +
        'citizens, none of which this engine reproduces — the 10 and the 100 are round numbers a player ' +
        'can reason about and are NOT presented as Civ 3 figures',
    ),
  },
  /**
   * **M9's government rows** — three, one of them the default.
   *
   * | row | caps (tax/science/luxury) | free/city | support | happiness | tech |
   * |---|---|---|---|---|---|
   * | `despotism` | 8/8/2 | 2 | 1 | 0 | *(none — the default)* |
   * | `monarchy` | 8/6/4 | 4 | 1 | 0 | Monarchy |
   * | `republic` | 6/8/6 | 1 | 2 | 1 | The Republic |
   *
   * **`despotism`'s two economy numbers are M4b's, exactly.** `freeUnitsPerCity: 2` is
   * the old `FREE_UNITS_PER_CITY` and `unitSupportCost: 1` is the old
   * `UNIT_SUPPORT_COST`, so a game played under despotism — which is every game, until a
   * player changes government — bills its army identically to the pre-M9 engine, and the
   * M4b goldens survive the relocation. `freeUnitsPerCity: 2` with three cities is six
   * free units plus M4b's `FREE_UNITS_BASE` of four, which is the ten the old formula
   * gave.
   *
   * **The caps are how the ten rate points may be dealt.** `RATE_TOTAL` is 10 and the
   * three rates must sum to it, so a cap below 10 is a statement about *distribution*: a
   * despotism cannot run a total-luxury economy (its luxury cap is 2) and a republic
   * cannot run a total-tax one (its tax cap is 6). Every cap is `<= 10`, so no cap can be
   * unreachable, and every cap is `>= 1`, so no slider is dead.
   *
   * **`monarchy` requires Monarchy and `republic` requires The Republic**, which is why
   * those two rows of the tree are load-bearing: without them the government feature
   * would be a menu a player is handed at turn zero rather than something it earns.
   * `despotism` deliberately requires nothing, so there is always a government to fall
   * back to and the feature is reachable from the first turn of every game.
   *
   * **The happiness modifiers are 0 / 0 / +1** — and the zeros are a *choice*, not an
   * omission: making despotism unhappy-making (as Civ 3 does, in effect) would change
   * every pre-M9 golden by putting early cities into disorder, which is a rebalance this
   * wave does not make. The republic's +1 is where the contentment difference lives.
   */
  governments: [
    {
      id: asGovernmentId('despotism'),
      name: 'Despotism',
      rateCaps: { tax: 8, science: 8, luxury: 2 },
      freeUnitsPerCity: 2,
      unitSupportCost: 1,
      happinessModifier: 0,
      provenance: placeholder(
        'unsourced: the 8/8/2 caps and the zero happiness modifier are ours, chosen to be playable, and ' +
          "none is traced to Civ 3's despotism (whose real penalty is a tile-yield cap and a support model " +
          "this engine does not have); the free-units-per-city of 2 and the per-unit cost of 1 are M4b's " +
          '`FREE_UNITS_PER_CITY` and `UNIT_SUPPORT_COST` RELOCATED here unchanged, not a rebalance — a ' +
          'game played under despotism bills its army exactly as it did before M9',
      ),
    },
    {
      id: asGovernmentId('monarchy'),
      name: 'Monarchy',
      rateCaps: { tax: 8, science: 6, luxury: 4 },
      freeUnitsPerCity: 4,
      unitSupportCost: 1,
      happinessModifier: 0,
      // The prerequisite is a tech this catalog **actually ships**. It was `monarchy`, a row
      // that never existed: `checkTechRefsOfRows` caught it as the validation failure it is,
      // which is the check earning its keep — a government gated on a tech nobody can
      // research is unreachable content that looks reachable.
      //
      // `ceremonial-burial` is the nearest shipped row in spirit (an early ancient-era tech
      // whose whole content is ordering) and the least disruptive: it is already an opening
      // choice among three roots, so gating monarchy on it adds a fourth reason to take it
      // rather than moving a row in the tree.
      requiresTech: asTechId('ceremonial-burial'),
      provenance: placeholder(
        'unsourced: the 8/6/4 caps, the four free units per city, the per-unit cost and the zero happiness ' +
          'modifier are ours, chosen to be playable; the shape (a monarchy supports a larger army than a ' +
          "despotism) is deliberate and Civ-3-like, the numbers are not Civ 3's, and the anarchy transition " +
          'a real revolution would impose is not modelled at all',
      ),
    },
    {
      id: asGovernmentId('republic'),
      name: 'Republic',
      rateCaps: { tax: 6, science: 8, luxury: 6 },
      freeUnitsPerCity: 1,
      unitSupportCost: 2,
      happinessModifier: 1,
      // The prerequisite is a tech this catalog **actually ships** — see the monarchy row's
      // note: `the-republic` was never a row, and only the tech-reference check stood between
      // that typo and unreachable content.
      //
      // `literature` is the nearest shipped row in spirit (a mid-ancient tech with two
      // prerequisites, so a republic is a *late* ancient-era decision rather than an opening
      // one, which is the ordering this row's provenance claims).
      requiresTech: asTechId('literature'),
      provenance: placeholder(
        'unsourced: the 6/8/6 caps, the single free unit per city, the doubled per-unit cost and the one ' +
          'content citizen are ours, chosen to be playable; the trade the row describes — a republic pays ' +
          'more for its army and keeps its people happier — is a Civ-3-shaped choice, not a Civ 3 figure, ' +
          'and this engine models no war weariness, no senate and no diplomatic consequence of the choice',
      ),
    },
  ],
  /**
   * **M10's score weights** — five integers, one linear function, nothing else.
   *
   * | term | weight | what it counts |
   * |---|---|---|
   * | `perPopulation` | 2 | citizens across the player's cities |
   * | `perCity` | 3 | cities owned |
   * | `perTech` | 4 | technologies known |
   * | `perCulture` | 1 | accumulated culture (the derived total) |
   * | `perWonder` | 8 | wonders held |
   *
   * **The ordering is the claim, not the numbers.** A wonder is worth more than a tech,
   * a tech more than a city, a city more than a citizen, and a point of culture least of
   * all — which is a *ranking* a player can play toward. The absolute sizes are
   * arbitrary: doubling all five would leave every game's winner and every relative
   * standing identical, which is why they are stated as a table a sweep can move rather
   * than derived from anything.
   *
   * **`perCulture` is 1 rather than 0** even though culture already has its own victory
   * condition, because a cultural player should not be *penalised* on the scoreboard for
   * choosing that route — and 1 rather than 3 so that a culture-heavy empire does not
   * automatically dominate a score game it did not play for.
   */
  score: {
    perPopulation: 2,
    perCity: 3,
    perTech: 4,
    perCulture: 1,
    perWonder: 8,
    provenance: placeholder(
      'unsourced: these five weights are ours, chosen to be playable and to give a sensible ordering ' +
        '(wonder > tech > city > citizen > culture point), and none is traced to Civ 3 — whose score is a ' +
        'per-turn accumulation over territory, population, content citizens, techs, wonders and future ' +
        'tech, rescaled by difficulty and by the turn-limit scale, and is a different thing from this ' +
        'single end-of-turn integer wearing similar vocabulary',
    ),
  },
  /**
   * **M10's victory thresholds** — the four numbers a game can end at.
   *
   * | condition | threshold |
   * |---|---|
   * | conquest | *(none — last civilization with a city)* |
   * | domination | **both** 60% of the map's land **and** 40% of the world's population |
   * | cultural | 1,500 accumulated culture |
   * | score | turn 200 |
   *
   * **The two shares are integers and are compared with `>=`**, which is what makes the
   * boundary the value itself: a player holding exactly 60% of the map's land tiles *and*
   * exactly 40% of the world's citizens wins. **Domination requires both shares** — it is
   * an AND, not an OR, and the land half is measured against the **map's** land rather
   * than against the land any city claims. The frozen M9+M10 contract wrote "or" and
   * "claimed land"; the AMENDMENT at the end of `docs/INTERFACES.md` rules that wording
   * wrong and the implementation right, for two measured reasons: with "or", domination
   * fired on turn 1 of an ordinary game (the first capital holds 100% of the claimed land
   * and 100% of the world's citizens), and a share of *claimed* land is a denominator a
   * player lowers by claiming less. `core/victory.ts`' `dominationWinner` is the rule;
   * `packages/testing/test/m9-m10-adversarial.test.ts` pins each half at its own
   * threshold and shows the land half is necessary.
   *
   * **1,500 culture is reachable and not automatic.** A city with a temple produces 1 per
   * turn; the shipped catalog's wonders and libraries add more; a four-city empire with
   * temples and libraries banks roughly 8 per turn once it is built out, which is about
   * 190 turns of play, and a wonder-heavy one gets there well inside the 200-turn score
   * horizon. A player who never builds a culture building never reaches it, which is what
   * makes it a victory condition rather than a participation award.
   *
   * **`scoreVictoryTurn: 200` is the catalog's horizon, deliberately apart from any
   * experiment's `maxTurns`** — see `VictorySpec` for why conflating the two would make
   * every short simulation claim a score win. The shipped value is well above the
   * evidence runs' budgets, so a 100-turn simulation reports no victory and
   * `stoppedBecause: 'max-turns'`, which is the honest answer.
   */
  victory: {
    dominationLandPct: 60,
    dominationPopPct: 40,
    culturalVictoryCulture: 1500,
    scoreVictoryTurn: 200,
    provenance: placeholder(
      'unsourced: the 60%/40% domination shares, the 1,500-culture threshold and the 200-turn score ' +
        'horizon are ours, chosen so that a game of a few hundred turns can plausibly end under each ' +
        'condition, and none is traced to Civ 3; Civ 3 wins by holding two thirds of the land AND ' +
        'population for domination, by 100,000 culture (or 20,000 per city) for cultural, and by ' +
        'diplomacy, spaceship and Histographic score — none of which this engine implements, and no ' +
        'number here is a Civ 3 figure',
    ),
  },
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

  // M6. `defenseBonus` is the contract's name for the same number (see `TerrainSpec`),
  // and it is checked twice over: on its own terms, and *against* `defenseBonusPct`
  // when a row declares both.
  //
  // The agreement check is the point. Two spellings of one magnitude can drift, and the
  // drift would be invisible: the combat resolver prefers `defenseBonus` when it is
  // present, so a row whose `defenseBonusPct` said 50 while its `defenseBonus` said 0
  // would give a defender no bonus at all while every reader of the older field — a REPL
  // listing, a provenance report, a balance sweep — showed 50. Refusing the
  // disagreement at load time is the cheap way to stop "one number, two names" becoming
  // two numbers. A row that declares only one of them is legal and means the same thing.
  const bonus: unknown = t.defenseBonus;
  if (bonus !== undefined) {
    if (typeof bonus !== 'number' || !Number.isInteger(bonus) || bonus < 0) {
      errors.push(bad('defenseBonus', 'must be a non-negative integer'));
    } else if (bonus !== t.defenseBonusPct) {
      errors.push(
        bad(
          'defenseBonus',
          `must equal defenseBonusPct (${String(t.defenseBonusPct)}) when a row declares both, because ` +
            `they are two names for one terrain defence bonus (got ${String(bonus)})`,
        ),
      );
    }
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
  // would be a determinism hazard the type system cannot see (PLAN.md §5.3). The
  // values are read as `unknown` so the checker does not *assume* the shape it exists
  // to verify — the same discipline `checkEffect` follows for a JSON catalog — and so
  // that `hitPoints` can be checked for being present at all.
  // `hitPoints` is deliberately **not** in this list: it is optional on a unit row (see
  // below), so the loop's "must be an integer" would fire on a row that simply has no
  // combat statistics at all. It gets its own check, which validates it only when present.
  const stats: readonly (readonly [string, unknown])[] = [
    ['attack', u.attack],
    ['defense', u.defense],
    ['movement', u.movement],
    ['cost', u.cost],
  ];
  for (const [field, value] of stats) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(bad(field, 'must be an integer'));
      continue;
    }
    if (value < 0) errors.push(bad(field, 'must not be negative'));
  }

  // **`hitPoints`, when a row declares it, must be a whole number at least 1** (M6).
  //
  // At least 1, because this number becomes a unit's starting `hitPointsLeft` and `0`
  // would mean a unit that is *born destroyed*: M6's rule is that a unit at 0 hit points
  // does not exist, and accepting content that asks for one would leave the engine
  // silently rounding it up to 1.
  //
  // **Absence is accepted, and that is a decision with a cost worth naming.** The M6
  // contract calls the field required, and the shipped catalog declares it on every row
  // (`rules.test.ts` asserts that, so a row that dropped it fails a test). But three
  // *fixture* paths legitimately build unit rows without it and are gated on this
  // validator: the override applier in `@civts/sim` rebuilds a unit field by field from
  // its own patchable-field list (the same list that does not offer `hitPoints` as a knob),
  // and the scenario DSL's and this package's own hand-written fixture catalogs predate
  // M6. Rejecting absence here would make a `hitPoints`-less *patch result* an invalid
  // ruleset, which is a failure about the wrong thing: nobody asked for hit points to be
  // patchable. So M6's "required" is enforced where content actually ships — by the test
  // above — and `core/units.ts`' `fullHitPoints` reads a silent row as 1 rather than
  // throwing. The cost is real and is stated rather than hidden: a *new* hand-written
  // catalog can omit the statistic and be accepted, and its units will fight with one hit
  // point each.
  const hitPoints: unknown = u.hitPoints;
  if (hitPoints !== undefined) {
    if (typeof hitPoints !== 'number' || !Number.isInteger(hitPoints)) {
      errors.push(bad('hitPoints', 'must be an integer'));
    } else if (hitPoints < 1) {
      errors.push(bad('hitPoints', 'must be >= 1'));
    }
  }

  // A unit that cannot move is unplayable and a unit that costs nothing is a free unit —
  // both are data errors rather than tuning choices.
  if (u.movement < 1) errors.push(bad('movement', 'must be >= 1'));
  if (u.cost < 1) errors.push(bad('cost', 'must be >= 1'));

  // **`attack: 0` is deliberately NOT an error.** The M6 contract makes it a *legality*
  // rule — "a unit with `attack === 0` may not attack" — not a content defect: a
  // settler, a worker and a transport are all legitimate rows with no attack, and the
  // shipped catalog relies on that (see the unit table's note). Rejecting it here would
  // make the command layer's refusal unreachable from real content, which is the exact
  // mistake M5 made with `requiresTech`.
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

  // M9's three new fields. All three are read through `unknown`, because the thing
  // being validated may be JSON, a `Partial` patch or a hand-built literal — and because
  // two of them are *required in fact*: the contract spells `culturePerTurn` and
  // `happiness` as required on `BuildingSpec`, while the engine's structural
  // `BuildingDef` declares both optional, so this function is where "required" is
  // enforced. That is the same arrangement `UnitSpec.hitPoints` uses, and the note on
  // `BuildingSpec.culturePerTurn` argues it in full.
  const culturePerTurn: unknown = b['culturePerTurn'];
  if (culturePerTurn === undefined) {
    errors.push(
      bad(
        'culturePerTurn',
        'must be declared: the contract makes it required, so a row that says nothing would be a ' +
          'building whose culture is whatever a reader assumed (state 0 to mean none)',
      ),
    );
  } else if (typeof culturePerTurn !== 'number' || !Number.isInteger(culturePerTurn)) {
    errors.push(bad('culturePerTurn', 'must be an integer'));
  } else if (culturePerTurn < 0) {
    errors.push(
      bad(
        'culturePerTurn',
        'must not be negative: culture accumulates and never decreases, and a building that took ' +
          'culture away each turn would break that promise from inside the culture pass',
      ),
    );
  }

  const happiness: unknown = b['happiness'];
  if (happiness === undefined) {
    errors.push(
      bad(
        'happiness',
        'must be declared: the contract makes it required, so a row that says nothing would be a ' +
          'building whose contentment is whatever a reader assumed (state 0 to mean none)',
      ),
    );
  } else if (typeof happiness !== 'number' || !Number.isInteger(happiness)) {
    // Signed on purpose: an unhappy-making building is a rule the `city-happiness`
    // effect can express, so only integrality is required here.
    errors.push(bad('happiness', 'must be an integer (it may be negative)'));
  }

  // `cultureBonus` is the one of the three that is *optional*, and the two halves of its
  // rule are the contract's own words: "wonders only, one-off". A non-wonder row that
  // declares a bonus contradicts the interface; a wonder that declares none is a wonder
  // with nothing special about the turn it completes, which is the only moment this
  // engine makes a wonder special. Both are refused by name rather than silently ignored,
  // because the alternative is content that looks like it does something and does not.
  const cultureBonus: unknown = b['cultureBonus'];
  if (cultureBonus !== undefined) {
    if (typeof cultureBonus !== 'number' || !Number.isInteger(cultureBonus)) {
      errors.push(bad('cultureBonus', 'must be an integer'));
    } else if (cultureBonus <= 0) {
      errors.push(
        bad(
          'cultureBonus',
          `must be > 0 when declared (got ${String(cultureBonus)}): a row that means "no bonus" says ` +
            'nothing, so a stated zero is a row whose author expected something to happen',
        ),
      );
    } else if (wonder !== true) {
      errors.push(
        bad(
          'cultureBonus',
          'is wonders only (the contract says so): an ordinary building that grants a one-off culture ' +
            'bonus on completion would be content contradicting the frozen interface',
        ),
      );
    }
  }
  // **A wonder is not required to declare a completion bonus.** The obvious-sounding rule —
  // "a wonder that grants nothing on completion is not a wonder" — is *our* invention rather
  // than the contract's, and it was written here and then removed for two reasons. The
  // contract makes `cultureBonus` an optional field of a wonder row, so a catalog that omits
  // it is inside the interface; and making it mandatory would make `wonder: true` unacceptable
  // on a row without one, which is a statement about content the engine has no business
  // making (`rules.test.ts` pins that `wonder: true` is accepted on any row, because
  // `wonder` is what the global-uniqueness rule reads and nothing else). The shipped
  // `pyramids` row does declare one, and the M4c rule that spends it is pinned by its own
  // tests; a second wonder that grants nothing on completion would be a tuning choice, not a
  // validation error.

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
 * Every `requiresTech` a row declares must name a tech this catalog defines.
 *
 * M5's contract says exactly this — "`validateRuleset` rejects a `requiresTech` naming
 * an unknown tech" — and M6 is the wave that gives it teeth, because M6 is the wave that
 * makes shipped rows declare one. A gate naming a tech no row defines is invisible in
 * play: `core/tech.ts`' `unmetTechRequirement` asks whether the player *knows* the id,
 * nobody can ever know an id that is not in the tree, and so the row becomes
 * permanently unbuildable content — refused forever with a reason that looks like a
 * perfectly ordinary "you have not researched this yet". That is the same class of
 * silent dead end the M5 contract refuses to accept in the tree itself (the cycle
 * check), and it deserves the same treatment at load time.
 *
 * Reported against **the row that declares it**, naming its field, in catalog order —
 * units, then buildings, then improvements, then resources, which is the order the other
 * checks run in and therefore the order a caller reads its complaints in. This is
 * deliberately *not* part of `checkUnit`/`checkBuilding`/…: it is a reference into a
 * different catalog, and one function that owns the rule for all four kinds is what
 * stops the fourth kind from being forgotten (which is precisely how the field ended up
 * unchecked in the first place).
 *
 * A row that declares nothing is not complained about, and neither is a *catalog* with
 * no `techs` section: a structural ruleset view with no tree honestly gates nothing,
 * and the M6 content rows all live in the shipped catalog.
 */
const ROW_REQUIRES_TECH = 'requiresTech';

/**
 * One catalog row, as the `requiresTech` reference check reads it: both fields
 * optional and `unknown`, because the row being checked may be data the type system
 * never saw (a JSON catalog, a `Partial` patch).
 *
 * Every spec in the four catalogs is assignable to this — each has a string `id` and
 * each may carry the field — so the shipped catalog is checked by the same code
 * without a cast, which is the point: the checker must not be able to *assume* the
 * shape it exists to verify. This is the same technique, and the same reason, as
 * `EffectFields` below.
 */
interface RowFields {
  readonly id?: unknown;
  readonly requiresTech?: unknown;
}

const checkTechRefsOfRows = (catalog: Catalog): readonly RulesetError[] => {
  // The section list names each catalog by the field name it has on `Catalog`, so the
  // error's `catalog` field always matches a section the caller can look up.
  const sections: readonly (readonly [string, readonly RowFields[]])[] = [
    ['units', catalog.units],
    ['buildings', catalog.buildings],
    ['improvements', catalog.improvements],
    ['resources', catalog.resources],
    // M9: governments are the fifth kind of row to declare `requiresTech`, and they are
    // added *here* rather than checked in `checkGovernment` for exactly the reason this
    // function exists: a `requiresTech` is a reference into the tech tree, and one
    // function that resolves every one of them is what stops the fifth kind from being
    // forgotten the way the field was before M6.
    [GOVERNMENTS_SECTION, catalog.governments],
  ];

  return sections.flatMap(([section, rows]) =>
    rows.flatMap((row) => {
      const required = row.requiresTech;
      if (required === undefined) return [];
      if (typeof required === 'string' && catalog.techs.some((tech) => tech.id === required)) {
        return [];
      }
      return [
        {
          kind: 'invalid-value' as const,
          catalog: section,
          id: String(row.id),
          field: ROW_REQUIRES_TECH,
          detail: `names tech ${JSON.stringify(required)}, which this catalog does not define`,
        },
      ];
    }),
  );
};

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
/**
 * The id the combat section is filed under in a provenance report.
 *
 * The section is a **singleton** — one row of nine numbers — rather than a list of rows,
 * so it has no id of its own. It needs one all the same: `ProvenanceRow` is
 * `{ id, provenance }`, the report prints the id beside the claim, and a section with no
 * name for itself would be a row a reader cannot cite. The catalog's own field name is
 * the honest answer, and it is the same string `RulesetPatch.combat` uses.
 */
const COMBAT_ROW_ID = 'combat';

/**
 * The id the capture section is filed under in a provenance report.
 *
 * Same argument as `COMBAT_ROW_ID`, and the same string `RulesetPatch.capture` uses:
 * `ProvenanceRow` is `{ id, provenance }`, the report prints the id beside the claim,
 * and a singleton section with no name for itself would be a row a reader cannot cite.
 * The catalog's own field name is that name.
 */
const CAPTURE_ROW_ID = 'capture';

/**
 * **The combat globals, checked as one model rather than as nine numbers** (M6b).
 *
 * Every field must be an integer, for the reason every simulation number in this file
 * must be: these magnitudes are multiplied into a unit's strength, compared against a
 * draw and subtracted from hit points, and a fraction in any of them would reach a
 * decision the state hash is supposed to pin (PLAN.md §5.3). Beyond integrality the
 * contract names a bound per field, and each bound is a *rule* rather than a taste:
 *
 * - **`rollBound >= 1`** — the draw is `nextBelow(rng, rollBound)`, which takes a
 *   positive bound and would throw on 0. It is also the definition of "percentage"
 *   (100 values, `[0, 100)`), so it is not a tuning choice even though it is data.
 * - **`maxExperience >= 0`** — 0 is a legal, meaningful statement ("this ruleset has no
 *   promotions"), which is why the bound is not `>= 1`.
 * - **`1 <= minWinPct <= maxWinPct <= rollBound`**, checked as **one chain**. The three
 *   bounds are one rule: the clamp must be a range the draw can express, the floor must
 *   keep a positive attack from being *certain* (a certainty is not a random process,
 *   and a sweep over it would measure nothing), and the ceiling must keep the defender
 *   alive at the top of the roll range. Checking them separately would accept a
 *   `minWinPct` of 99 with a `maxWinPct` of 1.
 * - **`damagePerRound >= 1`** — the resolver's loop terminates because every round
 *   costs the loser a hit point. A damage of 0 is not a slow battle, it is an
 *   **infinite loop** inside a pure function the turn pipeline calls, so it is refused
 *   at load time rather than discovered as a hang.
 * - **Every percentage `>= 0`** — a negative percentage is a modifier that *penalises*
 *   the side it is attached to, which is not what any of these fields means; a row that
 *   wants that has a different bug.
 *
 * **Total over `unknown`, like the effect and kind checkers.** The value is read through
 * `unknown` and every field is checked for being a number before any comparison, because
 * the thing being validated may be JSON, a `Partial` patch or a hand-built literal — and
 * because a **missing section** has to be reported rather than crashing the validator: a
 * catalog that says nothing about combat is not a catalog with default combat, it is one
 * the engine cannot fight under (`combat.ts` reads every magnitude from the ruleset).
 */
const checkCombat = (section: unknown): readonly RulesetError[] => {
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'combat',
    id: COMBAT_ROW_ID,
    field,
    detail,
  });

  const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === 'object' && value !== null;
  if (!isRecord(section)) {
    return [bad('combat', 'must be an object carrying the combat magnitudes')];
  }

  const fields: readonly string[] = [
    'fortifyBonusPct',
    'cityDefenseBonusPct',
    'wallsBonusPct',
    'veteranAttackPct',
    'maxExperience',
    'rollBound',
    'damagePerRound',
    'minWinPct',
    'maxWinPct',
  ];

  const errors: RulesetError[] = [];
  const numbers = new Map<string, number>();
  for (const field of fields) {
    const value = section[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(bad(field, 'must be an integer'));
      continue;
    }
    numbers.set(field, value);
  }

  // The percentages, each on its own terms.
  for (const field of [
    'fortifyBonusPct',
    'cityDefenseBonusPct',
    'wallsBonusPct',
    'veteranAttackPct',
  ]) {
    const value = numbers.get(field);
    if (value !== undefined && value < 0) errors.push(bad(field, 'must not be negative'));
  }

  const rollBound = numbers.get('rollBound');
  if (rollBound !== undefined && rollBound < 1) errors.push(bad('rollBound', 'must be >= 1'));

  const maxExperience = numbers.get('maxExperience');
  if (maxExperience !== undefined && maxExperience < 0) {
    errors.push(bad('maxExperience', 'must not be negative'));
  }

  const damagePerRound = numbers.get('damagePerRound');
  if (damagePerRound !== undefined && damagePerRound < 1) {
    errors.push(
      bad('damagePerRound', 'must be >= 1: a round that costs no hit point cannot end a battle'),
    );
  }

  // The clamp chain, as one statement — see the doc note above for why it is not three.
  const minWinPct = numbers.get('minWinPct');
  const maxWinPct = numbers.get('maxWinPct');
  if (minWinPct !== undefined && maxWinPct !== undefined && rollBound !== undefined) {
    if (!(1 <= minWinPct && minWinPct <= maxWinPct && maxWinPct <= rollBound)) {
      errors.push(
        bad(
          'minWinPct',
          `the odds clamp must satisfy 1 <= minWinPct <= maxWinPct <= rollBound ` +
            `(got ${String(minWinPct)} <= ${String(maxWinPct)} <= ${String(rollBound)}); ` +
            'a clamp outside the draw range is a range no roll can express',
        ),
      );
    }
  }

  return errors;
};

/**
 * **The capture section, checked on its own terms.**
 *
 * One field, one rule, and the rule is a *range the arithmetic can express* rather than
 * a preference:
 *
 * - **integer** — the divisor feeds `Math.floor(population / divisor)`, and a fraction
 *   there would put a non-integer population into `GameState`, which `canonicalize`
 *   cannot round-trip and no golden hash can pin. A string or a missing field is the
 *   same complaint, reported as "must be an integer".
 * - **`>= 1`** — `0` is a division by zero: `Math.floor(4 / 0)` is `Infinity`, a value
 *   that is not a city's population and is not hashable either. A negative divisor
 *   *grows* the conquered city, which is not what the field means — the same argument
 *   the combat section's percentages make about a negative percentage. `1` is legal and
 *   meaningful: it states "a sack costs the city no citizens", which is a lenient
 *   tuning position a sweep must be able to reach, not an error.
 *
 * **Total over `unknown`, like `checkCombat`**: the value may be JSON, a `Partial` patch
 * or a hand-built literal, and a **missing section** has to be reported rather than
 * crashing the validator — a catalog that says nothing about capture is not a catalog
 * with a default capture, it is one whose sacks have no rule (`cities.ts` reads the
 * divisor from the ruleset).
 */
const checkCapture = (section: unknown): readonly RulesetError[] => {
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'capture',
    id: CAPTURE_ROW_ID,
    field,
    detail,
  });

  const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === 'object' && value !== null;
  if (!isRecord(section)) {
    return [bad('capture', 'must be an object carrying the capture magnitudes')];
  }

  const divisor = section['populationDivisor'];
  if (typeof divisor !== 'number' || !Number.isInteger(divisor)) {
    return [bad('populationDivisor', 'must be an integer')];
  }
  if (divisor < 1) {
    return [
      bad(
        'populationDivisor',
        "must be >= 1: it divides a city's population, and 0 is a division by zero " +
          '(Infinity is not a population and not a hashable state)',
      ),
    ];
  }

  return [];
};

/* ------------------------------------------------------------------ *
 * M9+M10 — the culture, government, score and victory sections
 * ------------------------------------------------------------------ */

const CULTURE_ROW_ID = 'culture';
const SCORE_ROW_ID = 'score';
const VICTORY_ROW_ID = 'victory';
const GOVERNMENTS_SECTION = 'governments';

/**
 * A record, or `undefined` — the one read every `unknown`-facing checker here starts
 * with.
 *
 * Written once, rather than as the local `isRecord` const each of `checkCombat` and
 * `checkCapture` declares for itself, because the M9/M10 checkers below are four
 * functions that would otherwise repeat it four times. (The two older checkers keep
 * their own copies: rewriting them is not this wave's business, and a helper three
 * functions use is not worth a fourth function's worth of churn.)
 */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** The integer `field` of `record`, or `undefined` when it is absent or not an integer. */
const integerField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined => {
  const value = record[field];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

/**
 * **The culture section, checked as one model.**
 *
 * Five rules, and each is a rule rather than a taste:
 *
 * - **Every magnitude is an integer**, for the reason every simulation number in this
 *   file is: culture is added into `City.culture`, compared against a border threshold
 *   and compared against a victory threshold, and a fraction in any of them would reach
 *   a value `canonicalize` cannot round-trip and no golden hash could pin (PLAN.md §5.3).
 * - **`borderRadius2Culture >= 0` and `borderRadius3Culture >= borderRadius2Culture`**,
 *   checked as **one ascending pair**. `borders.ts`' `claimedRadius` tests radius 3
 *   first and then radius 2, so a `borderRadius3Culture` below `borderRadius2Culture` is
 *   not a stricter ruleset — it is one in which the radius-2 threshold can never fire,
 *   because any culture that reaches the 3 threshold already passed the 2 one. That is
 *   dead data, and refusing it at load time is cheaper than a reader discovering it.
 * - **`luxuriesPerHappyCitizen >= 1`** — `happiness.ts` computes
 *   `floor(luxuries / luxuriesPerHappyCitizen)`, so `0` is a division by zero and
 *   `Infinity` is not a count of content citizens.
 * - **`happyPerLuxuryResource >= 0`** — it is *added* to the happiness count, so a
 *   negative value is a luxury that makes its owner's citizens unhappy, which is not
 *   what the field means. `0` is legal and states "only the count matters".
 * - **`unhappyThresholds` is a non-empty, strictly ascending ladder beginning at
 *   `minPopulation <= 1`.** Ascending because `unhappyFromSize` folds the ladder and
 *   takes the highest applicable rung: a ladder out of order would make the rung order
 *   — not the population — decide the answer. Beginning at `<= 1` because a city of size
 *   1 must have a defined unhappy count; without a rung at or below 1, `unhappyFromSize`
 *   returns the degenerate answer for a city that exists in every game. Strictly
 *   ascending (not merely non-decreasing) because two rungs at the same population is
 *   one rung written twice, and the second is dead data — the same argument as the
 *   border pair, one level down.
 *
 * **Total over `unknown`, like `checkCombat`**: the section may be JSON or a patch, and a
 * *missing* section has to be reported rather than crashing the validator — a catalog
 * that says nothing about culture is not a catalog with default cultures, it is one whose
 * borders and whose disorder have no rules (`borders.ts` and `happiness.ts` both read the
 * magnitudes from the ruleset they are handed).
 */
const checkCulture = (section: unknown): readonly RulesetError[] => {
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'culture',
    id: CULTURE_ROW_ID,
    field,
    detail,
  });

  const record = asRecord(section);
  if (record === undefined) {
    return [bad('culture', 'must be an object carrying the culture and contentment magnitudes')];
  }

  const errors: RulesetError[] = [];

  const radius2 = integerField(record, 'borderRadius2Culture');
  const radius3 = integerField(record, 'borderRadius3Culture');
  if (radius2 === undefined) errors.push(bad('borderRadius2Culture', 'must be an integer'));
  else if (radius2 < 0) errors.push(bad('borderRadius2Culture', 'must not be negative'));
  if (radius3 === undefined) errors.push(bad('borderRadius3Culture', 'must be an integer'));
  else if (radius3 < 0) errors.push(bad('borderRadius3Culture', 'must not be negative'));

  if (radius2 !== undefined && radius3 !== undefined && radius3 < radius2) {
    errors.push(
      bad(
        'borderRadius3Culture',
        `must be >= borderRadius2Culture (got ${String(radius3)} < ${String(radius2)}): ` +
          'the engine tests radius 3 before radius 2, so the lower threshold could never fire ' +
          'and the radius-2 entry would be dead data',
      ),
    );
  }

  const perHappy = integerField(record, 'luxuriesPerHappyCitizen');
  if (perHappy === undefined) errors.push(bad('luxuriesPerHappyCitizen', 'must be an integer'));
  else if (perHappy < 1) {
    errors.push(
      bad(
        'luxuriesPerHappyCitizen',
        'must be >= 1: it divides the luxury count, and 0 is a division by zero ' +
          '(Infinity is not a count of content citizens)',
      ),
    );
  }

  const perLuxury = integerField(record, 'happyPerLuxuryResource');
  if (perLuxury === undefined) errors.push(bad('happyPerLuxuryResource', 'must be an integer'));
  else if (perLuxury < 0) {
    errors.push(
      bad(
        'happyPerLuxuryResource',
        "must not be negative: it is added to a city's happiness, and a negative value is a " +
          'luxury that makes its owner unhappy',
      ),
    );
  }

  const ladder = record['unhappyThresholds'];
  if (!Array.isArray(ladder) || ladder.length === 0) {
    errors.push(
      bad(
        'unhappyThresholds',
        'must be a non-empty array of { minPopulation, unhappy } rungs: a city of size 1 has to ' +
          'have a defined unhappy count',
      ),
    );
  } else {
    let previous: number | undefined;
    for (const [index, entry] of ladder.entries()) {
      const rung = asRecord(entry);
      if (rung === undefined) {
        errors.push(bad(`unhappyThresholds[${String(index)}]`, 'must be an object'));
        previous = undefined;
        continue;
      }
      const min = integerField(rung, 'minPopulation');
      const unhappy = integerField(rung, 'unhappy');
      if (min === undefined || min < 1) {
        errors.push(
          bad(`unhappyThresholds[${String(index)}].minPopulation`, 'must be an integer >= 1'),
        );
      }
      if (unhappy === undefined || unhappy < 0) {
        errors.push(bad(`unhappyThresholds[${String(index)}].unhappy`, 'must be an integer >= 0'));
      }
      if (min === undefined) {
        previous = undefined;
        continue;
      }
      if (index === 0 && min > 1) {
        errors.push(
          bad(
            'unhappyThresholds',
            `must begin at minPopulation <= 1 (got ${String(min)}): a size-1 city exists in every ` +
              'game and has to have a defined unhappy count',
          ),
        );
      }
      if (previous !== undefined && min <= previous) {
        errors.push(
          bad(
            `unhappyThresholds[${String(index)}].minPopulation`,
            `must be strictly greater than the previous rung's ${String(previous)}: the ladder is ` +
              'read as "the highest rung that applies", so a repeated population is one rung ' +
              'written twice and the second is dead data',
          ),
        );
      }
      previous = min;
    }
  }

  return errors;
};

/**
 * **The government rows, checked as one table.**
 *
 * Per row: the id and name are non-empty (`checkRows` already refuses an empty catalog
 * and a duplicate id, so this function does not repeat either), the caps are three
 * integers in `[0, RATE_TOTAL]`, the two economy numbers are integers `>= 0`, the
 * happiness modifier is an integer of either sign, and `requiresTech` is a string when
 * present — the *reference* check for that field is `checkTechRefsOfRows`, which is the
 * one place every `requiresTech` in the catalog is resolved against the tree.
 *
 * **Why the cap bound is `RATE_TOTAL` rather than `100`.** The three rates must sum to
 * exactly `RATE_TOTAL` (`state.ts`' rule, enforced by `ratesProblem`), so a cap above
 * `RATE_TOTAL` is unreachable — no legal triple can exceed it — and a cap of `0` makes a
 * slider dead: a government that forbids all science is a government whose player cannot
 * research at all, which is a different game rather than a tuning position. Refusing both
 * at load time is what keeps "the caps describe a distribution of the ten points" true.
 *
 * ## The section is refused when empty, and refused when it has no usable default
 *
 * `newGame` stamps *the default row* on every player, and `core/governments.ts`'
 * `defaultGovernmentOf` picks it as **the first row of the section**. So an empty section
 * is a game with no government to give anybody (the engine would fall back to its
 * `NO_GOVERNMENT` degenerate row, which is deliberately unlike every shipped row), and a
 * section whose first row is unusable would stamp an unusable government on every player
 * at turn zero. `checkRows` covers the empty case with the `empty-catalog` error every
 * other catalog gets; the "first row" rule is stated here rather than as a flag, so a
 * content author reordering the section knows what it costs.
 *
 * ## Total over `unknown`, like `checkCulture`
 *
 * And note that the row list is *not* read through `unknown`: a `Catalog` with no
 * `governments` field at all is a TypeScript error, and a JSON catalog that omits it is
 * reported by `checkRows` as an empty catalog rather than crashing here. This function
 * reads the rows it is given and is total over each row's fields.
 */
const checkGovernment = (g: GovernmentSpec): readonly RulesetError[] => {
  const errors: RulesetError[] = [];
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: GOVERNMENTS_SECTION,
    id: g.id,
    field,
    detail,
  });

  // Read through a record view of the row rather than field by field off the typed
  // object, for the reason `checkCombat` reads its section that way: the thing being
  // validated may be JSON or a hand-built literal, and a field that is present but not a
  // number has to be *reported* rather than compared as `NaN`. The typed parameter is
  // what tells the compiler the shape content is supposed to have; this view is what
  // checks that it does.
  const row = g as unknown as Readonly<Record<string, unknown>>;

  if (g.name === '') errors.push(bad('name', 'must not be empty'));

  const caps: unknown = g['rateCaps'];
  const capRecord = asRecord(caps);
  if (capRecord === undefined) {
    errors.push(bad('rateCaps', 'must be an object carrying tax, science and luxury'));
  } else {
    for (const slider of ['tax', 'science', 'luxury'] as const) {
      const cap = integerField(capRecord, slider);
      if (cap === undefined) {
        errors.push(bad(`rateCaps.${slider}`, 'must be an integer'));
        continue;
      }
      if (cap < 0) errors.push(bad(`rateCaps.${slider}`, 'must not be negative'));
      else if (cap > RATE_TOTAL) {
        errors.push(
          bad(
            `rateCaps.${slider}`,
            `must be <= RATE_TOTAL (${String(RATE_TOTAL)}): the three rates sum to exactly ` +
              `${String(RATE_TOTAL)}, so a higher cap can never be reached`,
          ),
        );
      } else if (cap === 0) {
        errors.push(
          bad(
            `rateCaps.${slider}`,
            'must be >= 1: a cap of zero makes the slider dead, which is a government that ' +
              'forbids a whole channel rather than one that constrains it',
          ),
        );
      }
    }
  }

  const free = integerField(row, 'freeUnitsPerCity');
  if (free === undefined) errors.push(bad('freeUnitsPerCity', 'must be an integer'));
  else if (free < 0) errors.push(bad('freeUnitsPerCity', 'must not be negative'));

  const support = integerField(row, 'unitSupportCost');
  if (support === undefined) errors.push(bad('unitSupportCost', 'must be an integer'));
  else if (support < 0) errors.push(bad('unitSupportCost', 'must not be negative'));

  const modifier = integerField(row, 'happinessModifier');
  if (modifier === undefined) {
    // Signed on purpose: a government may make its people less content (which is what
    // Civ 3's despotism effectively does), so only integrality is required.
    errors.push(bad('happinessModifier', 'must be an integer (it may be negative)'));
  }

  return errors;
};

/**
 * **The score section, checked on its own terms** — five integers, each `>= 0`.
 *
 * Negative is refused because a term that *subtracts* would make a player's score depend
 * on the order the terms are summed in a way no reader could predict, and because "more
 * citizens is worse" is not what any of these weights means. Zero is legal and is a
 * tuning position rather than a degenerate one: `perCulture: 0` states "culture does not
 * count toward this game's score", and the other four weights still order the players —
 * the argument `ScoreSpec` makes in full.
 *
 * **Total over `unknown`, like `checkCulture`** — and a missing section is *reported*
 * rather than defaulted, because `core/score.ts` keeps no copy of any weight.
 */
const checkScore = (section: unknown): readonly RulesetError[] => {
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'score',
    id: SCORE_ROW_ID,
    field,
    detail,
  });

  const record = asRecord(section);
  if (record === undefined) {
    return [bad('score', 'must be an object carrying the five score weights')];
  }

  const errors: RulesetError[] = [];
  for (const field of ['perPopulation', 'perCity', 'perTech', 'perCulture', 'perWonder']) {
    const value = integerField(record, field);
    if (value === undefined) errors.push(bad(field, 'must be an integer'));
    else if (value < 0) errors.push(bad(field, 'must not be negative'));
  }

  return errors;
};

/**
 * **The victory section, checked as one set of thresholds.**
 *
 * - **The two shares are integers in `[1, 100]`.** `100` is legal and means "hold
 *   everything", which `victory.ts`' integer comparison expresses exactly
 *   (`owned * 100 >= 100 * total`), and `0` is refused because a share of nothing is a
 *   condition that holds at turn zero — a game that ends before it starts is not a
 *   tuning position. The *comparison* is `>=` and that is the engine's rule, stated in
 *   `victory.ts`, not something this section can change.
 * - **`culturalVictoryCulture >= 1`.** `0` would make every player a cultural victor at
 *   turn zero, and the condition is checked with `>=`, so `1` is the lowest threshold
 *   that means anything.
 * - **`scoreVictoryTurn >= 1`.** The turn at which the score is read; `0` would be a
 *   score victory decided before the first turn, and the runner's own turn counter starts
 *   at 1.
 * - **`scoreVictoryTurn` is deliberately NOT required to be below any experiment's
 *   `maxTurns`** — see `VictorySpec` for why the two horizons are different things and
 *   why conflating them would make every short simulation claim a score win. There is no
 *   check here that could express that anyway: validation sees a catalog, never a
 *   simulation's options.
 *
 * **Total over `unknown`, like `checkCulture`.** A missing section is reported rather
 * than defaulted: `core/victory.ts` reads all four thresholds from the ruleset it is
 * handed, so a catalog without this section is a game that cannot end.
 */
const checkVictory = (section: unknown): readonly RulesetError[] => {
  const bad = (field: string, detail: string): RulesetError => ({
    kind: 'invalid-value',
    catalog: 'victory',
    id: 'victory',
    field,
    detail,
  });

  const record = asRecord(section);
  if (record === undefined) {
    return [bad('victory', 'must be an object carrying the four victory thresholds')];
  }

  const errors: RulesetError[] = [];

  for (const field of ['dominationLandPct', 'dominationPopPct']) {
    const value = integerField(record, field);
    if (value === undefined) errors.push(bad(field, 'must be an integer'));
    else if (value < 1 || value > 100) {
      errors.push(
        bad(
          field,
          'must be in 1..100: a share of 0 holds at turn zero (a game that ends before it starts), ' +
            'and a share above 100 can never be reached',
        ),
      );
    }
  }

  const culture = integerField(record, 'culturalVictoryCulture');
  if (culture === undefined) errors.push(bad('culturalVictoryCulture', 'must be an integer'));
  else if (culture < 1) {
    errors.push(
      bad(
        'culturalVictoryCulture',
        'must be >= 1: the condition is checked with >=, so 0 would make every player a cultural ' +
          'victor at turn zero',
      ),
    );
  }

  const turn = integerField(record, 'scoreVictoryTurn');
  if (turn === undefined) errors.push(bad('scoreVictoryTurn', 'must be an integer'));
  else if (turn < 1) {
    errors.push(
      bad('scoreVictoryTurn', 'must be >= 1: the turn counter starts at 1, so 0 is not a turn'),
    );
  }

  return errors;
};

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
    // M6: the `requiresTech` reference check runs in its own block because it is a
    // *cross-catalog* reference — a unit, building, improvement or resource pointing
    // into the tree — and because it is only meaningful once the tree it points at has
    // been checked. Reporting it after `checkTechGraph` means a catalog with a broken
    // tree hears about the tree first.
    ...checkTechRefsOfRows(catalog),
    // M6b: the combat globals are a *section* rather than a row list, so they are checked
    // after every row catalog — a complaint about the odds clamp is only meaningful once
    // the units whose strengths it is applied to are themselves well-formed. The section
    // is read as `unknown` so a catalog that omits it is reported rather than crashing.
    ...checkCombat(catalog.combat),
    // M7: the capture rule is a section too, and it is checked after the row catalogs
    // for the same reason — a complaint about a divisor is only meaningful once the
    // buildings a sack destroys are themselves well-formed. Read as `unknown`, so a
    // catalog that omits it is *reported* rather than crashing the validator.
    ...checkCapture(catalog.capture),
    // M9: the government rows are a *row catalog* like units and buildings — they get the
    // empty-catalog and duplicate-id treatment `checkRows` gives every row list, plus
    // their own per-row checks. They sit after the five row catalogs and before the
    // M9/M10 sections so that a complaint about a government's caps is read next to the
    // other row complaints.
    ...checkRows(GOVERNMENTS_SECTION, catalog.governments),
    ...catalog.governments.flatMap(checkGovernment),
    // M9+M10's three singleton sections, each read as `unknown` so a catalog that omits
    // one is *reported* rather than crashing the validator (the `checkCombat` argument).
    // They run last, after every row catalog, because a complaint about a border
    // threshold is only meaningful once the buildings that produce the culture are
    // themselves well-formed.
    ...checkCulture(catalog.culture),
    ...checkScore(catalog.score),
    ...checkVictory(catalog.victory),
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
    // M6b: the combat section is a singleton row of nine numbers, and it is a
    // `placeholder` like every other row here — so `cited-only` refuses it by name,
    // exactly as it refuses the tech tree's prices.
    if (isPlaceholder(catalog.combat.provenance)) {
      errors.push({
        kind: 'placeholder-in-cited-only',
        catalog: 'combat',
        id: COMBAT_ROW_ID,
        note: catalog.combat.provenance.note,
      });
    }
    // M7: the capture rule is a singleton row too — one placeholder claim carrying the
    // number M6 buried in `cities.ts` — so `cited-only` refuses it by name, exactly as
    // it refuses the combat globals.
    if (isPlaceholder(catalog.capture.provenance)) {
      errors.push({
        kind: 'placeholder-in-cited-only',
        catalog: 'capture',
        id: CAPTURE_ROW_ID,
        note: catalog.capture.provenance.note,
      });
    }
    // M9: the government rows are *rows*, so they are audited row by row like units and
    // buildings — and they must be, because each is a separate tuning claim about a
    // separate government. A single section-level note could not say "the monarchy's
    // support numbers are ours" without also claiming it for the republic's.
    for (const g of catalog.governments) {
      if (isPlaceholder(g.provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: GOVERNMENTS_SECTION,
          id: g.id,
          note: g.provenance.note,
        });
      }
    }
    // M9+M10: the three singleton sections, each refused by name exactly as `combat` and
    // `capture` are. The culture section carries the two border thresholds, the four-rung
    // unhappy ladder and the two luxury magnitudes; `score` carries five weights and
    // `victory` four thresholds. Leaving any of them out of this audit would mean content
    // could ship eleven uncited rules numbers past a `cited-only` check that claims to
    // have audited the catalog.
    for (const [name, id, provenance] of [
      ['culture', CULTURE_ROW_ID, catalog.culture.provenance],
      ['score', SCORE_ROW_ID, catalog.score.provenance],
      ['victory', VICTORY_ROW_ID, catalog.victory.provenance],
    ] as const) {
      if (isPlaceholder(provenance)) {
        errors.push({
          kind: 'placeholder-in-cited-only',
          catalog: name,
          id,
          note: provenance.note,
        });
      }
    }
  }

  // The annotations state the contract each `extends` encodes, and keep the
  // return type honest: what leaves validation is the engine's view.
  const units: readonly UnitSpec[] = catalog.units;
  // **M9: the happiness projection — the one place a spec row becomes an effect.**
  //
  // The contract spells a building's contentment as `BuildingSpec.happiness`, and the
  // engine's contentment arithmetic is a fold over `BuildingEffect`s
  // (`core/buildings.ts`' `effectTotals`). Rather than teach the engine's effect union a
  // second field name, the spec field is projected onto `{ kind: 'city-happiness' }`
  // **here, once, at validation time**, and `BuildingDef` carries no `happiness` field at
  // all — so there is exactly one path from content into a city's contentment and no
  // second reader that could disagree with the first.
  //
  // It is written as **replace, not append**, and that is the load-bearing part: content
  // that declared a `city-happiness` effect by hand (which nothing shipped does) has that
  // entry dropped and the one derived from `happiness` put in its place. Appending would
  // make the two add up, so a row stating `happiness: 1` and
  // `effects: [{ kind: 'city-happiness', amount: 1 }]` would content two citizens — one
  // number, two homes, the defect class this project has found six times. A zero
  // projects to no effect at all, so a building that changes nothing adds nothing to the
  // fold.
  const buildings: readonly BuildingSpec[] = catalog.buildings.map((row) => {
    const happiness = typeof row.happiness === 'number' ? row.happiness : 0;
    const rest = row.effects.filter((effect) => effect.kind !== 'city-happiness');
    return {
      ...row,
      effects: happiness === 0 ? rest : [...rest, { kind: 'city-happiness', amount: happiness }],
    };
  });
  const improvements: readonly ImprovementSpec[] = catalog.improvements;
  const resources: readonly ResourceSpec[] = catalog.resources;
  const techs: readonly TechSpec[] = catalog.techs;
  // M6b: the combat globals travel with the validated ruleset, because `core/combat.ts`
  // reads them from the ruleset it is handed and keeps no copy. See `Ruleset.combat`.
  const combat: CombatSpec = catalog.combat;
  // M7: the capture rule travels with the validated ruleset for the same reason, and
  // `cities.ts`' `captureRulesOf` is the one reader. See `Ruleset.capture`.
  const capture: CaptureSpec = catalog.capture;
  // M9+M10: the four new sections travel with the validated ruleset for the reason
  // `combat` and `capture` do — the engine's readers (`borders.ts`, `happiness.ts`,
  // `governments.ts`, `score.ts`, `victory.ts`) read every magnitude from the ruleset
  // they are handed and keep no copy. See `Ruleset.culture`.
  const culture: CultureSpec = catalog.culture;
  const governments: readonly GovernmentSpec[] = catalog.governments;
  const score: ScoreSpec = catalog.score;
  const victory: VictorySpec = catalog.victory;

  return errors.length > 0
    ? err(errors)
    : ok({
        terrains: catalog.terrains,
        units,
        buildings,
        improvements,
        resources,
        techs,
        combat,
        capture,
        culture,
        governments,
        score,
        victory,
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
 *
 * Combat is the seventh, added by M6b, and it is the section that makes the rule
 * unavoidable: its nine magnitudes were *not* catalog rows at all until this wave —
 * they lived as module constants in `core/combat.ts` — so the report had nothing to
 * count and the balance sweep had nothing to move. A section that the report does not
 * list is a section content can add without being audited, which is how the numbers got
 * buried in logic in the first place.
 */
export const provenanceSections = (catalog: Catalog): readonly ProvenanceSection[] => [
  sectionOf('terrains', catalog.terrains),
  sectionOf('units', catalog.units),
  sectionOf('buildings', catalog.buildings),
  sectionOf('improvements', catalog.improvements),
  sectionOf('resources', catalog.resources),
  sectionOf('techs', catalog.techs),
  // M6b: the combat globals are the seventh section, and the argument above is exactly
  // why they must be *here* rather than only validated: they are nine rules numbers that
  // decide every battle, they are `placeholder`, and a report that counted the catalog's
  // rows without this section would understate the numbers M6 introduced — the same
  // half-truth the terrain/unit split produced in M1. The section is a singleton, so its
  // "rows" are the one row its provenance is filed under (`COMBAT_ROW_ID`); the count,
  // like every other count here, comes from the rows the section actually carries.
  sectionOf('combat', [{ id: COMBAT_ROW_ID, provenance: catalog.combat.provenance }]),
  // M7: the capture rule is the eighth section, and it is here for exactly the reason the
  // combat globals are: it was *not* a catalog row until this wave — M6 left it as
  // `CAPTURE_POPULATION_DIVISOR` in `core/cities.ts` — so before this section existed the
  // report had nothing to count and the balance sweep had nothing to move. A singleton,
  // so its "row" is the one its provenance is filed under (`CAPTURE_ROW_ID`), and the
  // count comes from the rows the section actually carries.
  sectionOf('capture', [{ id: CAPTURE_ROW_ID, provenance: catalog.capture.provenance }]),
  // M9: the government rows are the ninth section, and they are a *row* section rather
  // than a singleton — three rows, each with its own tuning claim, each counted and
  // listed. The argument above applies unchanged, and it is sharpest here: a sweep or a
  // reader asking "which of these governments has a sourced support cost?" has to be able
  // to see the rows, not a subtotal over them.
  sectionOf(GOVERNMENTS_SECTION, catalog.governments),
  // M9+M10's three singleton sections are the tenth, eleventh and twelfth. They carry
  // eleven rules numbers between them (five culture/contentment magnitudes, five score
  // weights, four victory thresholds — with `conquest` having none), and every one is a
  // `placeholder` of ours. A provenance report that listed the catalog's rows without
  // these would understate exactly the numbers this wave introduced, which is the
  // half-truth this function exists to prevent.
  sectionOf('culture', [{ id: CULTURE_ROW_ID, provenance: catalog.culture.provenance }]),
  sectionOf('score', [{ id: SCORE_ROW_ID, provenance: catalog.score.provenance }]),
  sectionOf('victory', [{ id: VICTORY_ROW_ID, provenance: catalog.victory.provenance }]),
];

/**
 * Count **every** row in the catalog — terrain, unit, building, improvement,
 * resource, tech **and the combat and capture globals** alike. The number answers
 * "how much of what the engine runs on is traced to a source?", so a summary
 * that quietly skipped a catalog would be exactly the half-truth PLAN.md §6.2
 * exists to prevent. M6b's combat section counts as one row, because it is one
 * provenance claim carrying nine numbers — the claim is what is being counted —
 * and M7's capture section counts as one row for the same reason: one claim
 * carrying the divisor M6 had buried in `cities.ts`.
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
