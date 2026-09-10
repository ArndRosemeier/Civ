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
  TERRAIN_ROLES,
  UNIT_ROLES,
  asTerrainId,
  asUnitTypeId,
  err,
  isPlaceholder,
  ok,
  placeholder,
  cited,
  type Fidelity,
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
 * Validate a catalog. In `cited-only` mode any placeholder row is a hard error,
 * which is what makes "is this Civ 3-shaped or Civ 3-exact?" checkable.
 *
 * Terrains are checked before units so the first error a caller sees is the
 * terrain one, which is the failure that stops generation earliest.
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
  }

  // The annotation states the contract `UnitSpec extends UnitDef` encodes, and
  // keeps the return type honest: what leaves validation is the engine's view.
  const units: readonly UnitSpec[] = catalog.units;

  return errors.length > 0 ? err(errors) : ok({ terrains: catalog.terrains, units, fidelity });
};

export interface ProvenanceSummary {
  readonly total: number;
  readonly cited: number;
  readonly placeholder: number;
}

/**
 * One row of a provenance report: the id the row is filed under and the claim it
 * makes. Both catalogs' rows have this shape, which is what lets one renderer
 * (and one counter) cover terrains and units alike.
 */
export interface ProvenanceRow {
  readonly id: string;
  readonly provenance: Provenance;
}

/**
 * A catalog section — the terrains, or the units — with its rows *and* its own
 * count, so a report can print a subtotal beside the rows it was derived from.
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
 */
export const provenanceSections = (catalog: Catalog): readonly ProvenanceSection[] => [
  sectionOf('terrains', catalog.terrains),
  sectionOf('units', catalog.units),
];

/**
 * Count **every** row in the catalog — terrain and unit alike. The number answers
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
