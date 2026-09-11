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
  IMPROVEMENT_KINDS,
  TERRAIN_ROLES,
  UNIT_ROLES,
  asBuildingId,
  asImprovementId,
  asTerrainId,
  asUnitTypeId,
  err,
  isPlaceholder,
  ok,
  placeholder,
  cited,
  type BuildingDef,
  type Fidelity,
  type ImprovementDef,
  type ImprovementKind,
  type Provenance,
  type Result,
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
 * A building type — what a city's shields can be spent on besides units.
 *
 * M3 needs exactly one number from this row: `cost`, the shields
 * `production.itemCost` charges for `{ kind: 'building', id }`. There is
 * deliberately **no `effect` field yet**: no system exists that could read one,
 * and an empty effect table would be a promise the engine does not keep. The row
 * grows when the system that consumes it does.
 *
 * As with `UnitSpec`, the row `extends` the engine's structural `BuildingDef`
 * (see `cities.ts`) so the compile-time proof that content ships what the engine
 * reads is the type itself, and `provenance` is required — a row without one
 * does not compile.
 */
export interface BuildingSpec extends BuildingDef {
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
  | { readonly kind: 'missing-role'; readonly role: TerrainRole };

export interface Ruleset {
  readonly terrains: readonly TerrainSpec[];
  readonly units: readonly UnitSpec[];
  readonly buildings: readonly BuildingSpec[];
  readonly improvements: readonly ImprovementSpec[];
  readonly fidelity: Fidelity;
}

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
  ],
  /**
   * Building rows — all PLACEHOLDER, and the numbers are *ours*, not Civ 3's.
   *
   * M3 models exactly one property of a building: what it costs in shields.
   * Effects (happiness, growth, defense, science) arrive with the systems that
   * can read them, so a row here claims nothing about what the building does.
   *
   * The costs are chosen to be playable against this catalog's city output
   * (roughly a handful of shields per turn early on), which makes a building a
   * several-turn investment rather than the one-turn purchase a 1-3 shield unit
   * is. That relationship is a tuning choice, not a sourced one: no row below
   * is traced to Civ 3, and the real costs there are unverified.
   */
  buildings: [
    {
      id: asBuildingId('granary'),
      name: 'Granary',
      cost: 10,
      provenance: placeholder(
        'unsourced: this cost is ours, chosen so an early city finishes one in a few turns; no effect in M3',
      ),
    },
    {
      id: asBuildingId('barracks'),
      name: 'Barracks',
      cost: 12,
      provenance: placeholder(
        'unsourced: this cost is ours, chosen to sit just above a granary; no effect in M3',
      ),
    },
    {
      id: asBuildingId('walls'),
      name: 'City Walls',
      cost: 15,
      provenance: placeholder(
        'unsourced: this cost is ours; no defensive effect is modelled until combat arrives in M6',
      ),
    },
    {
      id: asBuildingId('temple'),
      name: 'Temple',
      cost: 15,
      provenance: placeholder(
        'unsourced: this cost is ours; no happiness effect is modelled in M3',
      ),
    },
    {
      id: asBuildingId('library'),
      name: 'Library',
      cost: 20,
      provenance: placeholder(
        'unsourced: this cost is ours, the priciest row here; no science effect; M3 models none',
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
 * A building row is one number as far as M3 is concerned, and that number is a
 * shield cost: it must be a whole number of shields and at least one. A free
 * building would let `production.itemCost` complete an item on the turn it is
 * queued, and a fractional cost would put a fraction in `City.shields`, which is
 * part of every state hash (PLAN.md §5.3) — a determinism hazard the type system
 * cannot see, exactly as with a unit's stats.
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

  return errors;
};

/**
 * Is this a kind the engine knows? Compares the *strings*, because
 * `IMPROVEMENT_KINDS` is a tuple of string literals and the value tested may be
 * one the type system never saw (a JSON catalog, a `Partial` patch). The plain
 * strings are what both are at runtime; nothing is widened away here.
 */
const isKnownImprovementKind = (kind: string): boolean =>
  IMPROVEMENT_KINDS.some((known) => known === kind);

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
 * Validate a catalog. In `cited-only` mode any placeholder row is a hard error,
 * which is what makes "is this Civ 3-shaped or Civ 3-exact?" checkable.
 *
 * Terrains are checked before units, units before buildings, and buildings before
 * improvements, so the first error a caller sees comes from the catalog that
 * would stop a game earliest: a terrain hole stops generation, a unit hole stops
 * `newGame` placing a settler, and a building or improvement hole only stops
 * production or a worker later.
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
    ...checkRows('buildings', catalog.buildings),
    ...catalog.buildings.flatMap(checkBuilding),
    ...checkRows('improvements', catalog.improvements),
    ...catalog.improvements.flatMap(checkImprovement),
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
  }

  // The annotations state the contract each `extends` encodes, and keep the
  // return type honest: what leaves validation is the engine's view.
  const units: readonly UnitSpec[] = catalog.units;
  const buildings: readonly BuildingSpec[] = catalog.buildings;
  const improvements: readonly ImprovementSpec[] = catalog.improvements;

  return errors.length > 0
    ? err(errors)
    : ok({ terrains: catalog.terrains, units, buildings, improvements, fidelity });
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
 */
export const provenanceSections = (catalog: Catalog): readonly ProvenanceSection[] => [
  sectionOf('terrains', catalog.terrains),
  sectionOf('units', catalog.units),
  sectionOf('buildings', catalog.buildings),
  sectionOf('improvements', catalog.improvements),
];

/**
 * Count **every** row in the catalog — terrain, unit, building and improvement
 * alike. The number answers
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
