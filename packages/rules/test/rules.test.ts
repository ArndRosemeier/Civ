import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BUILDING_EFFECT_KINDS,
  RESOURCE_KINDS,
  TERRAIN_ROLES,
  UNIT_ROLES,
  asBuildingId,
  asImprovementId,
  asResourceId,
  asTechId,
  asTerrainId,
  asUnitTypeId,
  fullHitPoints,
  isPlaceholder,
  type BuildingEffect,
  type BuildingEffectKind,
  type ImprovementKind,
  type Provenance,
  type ResourceKind,
  type ResourceId,
  type TechId,
  type UnitRole,
} from '@civts/core';
import {
  CATALOG,
  CITED_EXAMPLE,
  ERAS,
  IMPROVEMENT_KINDS,
  provenanceSections,
  summarizeProvenance,
  validateRuleset,
  type BuildingSpec,
  type CaptureSpec,
  type Catalog,
  type CombatSpec,
  type EraId,
  type ImprovementSpec,
  type ProvenanceSection,
  type ResourceSpec,
  type TechSpec,
  type TerrainSpec,
  type UnitSpec,
} from '../src/index.js';

/** The catalog's unit rows, and the ones with a sea domain. */
const UNITS = CATALOG.units;
const LAND_UNITS = UNITS.filter((u) => u.domain === 'land');
/** The catalog's building rows. M3 production spends shields on these. */
const BUILDINGS = CATALOG.buildings;
/** The catalog's improvement rows. M4a's workers build these. */
const IMPROVEMENTS = CATALOG.improvements;
/** The catalog's resource rows. M4c's generation places these. */
const RESOURCES = CATALOG.resources;
/** The catalog's tech rows. M5's research spends beakers on these. */
const TECHS = CATALOG.techs;
/**
 * M6b's combat globals — the seventh provenance row, and the only section that is **one
 * row of nine numbers** rather than a list of rows. It is written as a count here (rather
 * than inlined as `1` in six arithmetic expressions) for the same reason the others are
 * aliased: the report's total and its sections must agree, and a section whose row count
 * was written in six places would be a section free to disagree with itself.
 */
const COMBAT_ROWS = 1;
const COMBAT = CATALOG.combat;
/**
 * M7's capture rule — the eighth provenance row, and the second section that is one row
 * rather than a list. Aliased for the same reason `COMBAT_ROWS` is: the report's total and
 * its sections must agree, and a row count written in six places is free to disagree with
 * itself.
 */
const CAPTURE_ROWS = 1;
const CAPTURE = CATALOG.capture;

/**
 * The catalog with one unit row replaced. Written as a function rather than a
 * `{ ...CATALOG, units: [...] }` literal at each call site so a change to the
 * catalog's shape cannot make one of the cases below silently stop testing.
 */
const withUnit = (id: string, patch: Partial<UnitSpec>): Catalog => ({
  ...CATALOG,
  units: UNITS.map((u) => (u.id === id ? { ...u, ...patch } : u)),
});

/**
 * The catalog with one building row replaced — the building counterpart of
 * `withUnit`, and the only way the cases below reach a broken building row
 * without restating the whole catalog.
 */
const withBuilding = (id: string, patch: Partial<BuildingSpec>): Catalog => ({
  ...CATALOG,
  buildings: BUILDINGS.map((b) => (b.id === id ? { ...b, ...patch } : b)),
});

/**
 * The catalog with one improvement row replaced — the improvement counterpart of
 * `withUnit`/`withBuilding`.
 *
 * `patch` is `Partial<ImprovementSpec>`, which allows **any** `kind` string, so
 * the unknown-kind case below reaches validation the way a JSON catalog would
 * rather than through a cast.
 */
const withImprovementRow = (id: string, patch: Partial<ImprovementSpec>): Catalog => ({
  ...CATALOG,
  improvements: IMPROVEMENTS.map((i) => (i.id === id ? { ...i, ...patch } : i)),
});

/**
 * The catalog with one resource row replaced — the resource counterpart of the
 * three helpers above, and the only way the cases below reach a broken resource
 * row without restating the whole catalog.
 *
 * `patch` is `Partial<ResourceSpec>`, which allows **any** `kind` string, so the
 * unknown-kind case reaches validation the way a JSON catalog would rather than
 * through a cast — the same discipline `withImprovementRow` states.
 */
const withResourceRow = (id: string, patch: Partial<ResourceSpec>): Catalog => ({
  ...CATALOG,
  resources: RESOURCES.map((r) => (r.id === id ? { ...r, ...patch } : r)),
});

/**
 * The catalog with one tech row replaced — the tech counterpart of the four helpers
 * above.
 *
 * `patch` is `Partial<TechSpec>`, which allows **any** `era` string and **any**
 * `requires` list, so the unknown-era and unknown-prerequisite cases reach validation
 * the way a JSON catalog would rather than through a cast — and the cycle cases use
 * only ids this catalog really ships, which is *more* realistic than a fabricated
 * one: the defect a play test cannot surface is a graph that looks perfectly normal
 * row by row.
 */
const withTech = (id: string, patch: Partial<TechSpec>): Catalog => ({
  ...CATALOG,
  techs: TECHS.map((t) => (t.id === id ? { ...t, ...patch } : t)),
});

/**
 * The catalog with **two** tech rows replaced, which is what a cycle needs: one
 * edited row cannot close a loop through a third row's edges.
 */
const withTechs = (patches: readonly (readonly [string, Partial<TechSpec>])[]): Catalog => ({
  ...CATALOG,
  techs: TECHS.map((t) => {
    const patch = patches.find(([id]) => id === t.id);
    return patch === undefined ? t : { ...t, ...patch[1] };
  }),
});

/**
 * The catalog with one terrain row replaced — the terrain counterpart of `withUnit` and
 * friends, added in M6 because that is when a terrain row grew a field the validator has
 * to police (`defenseBonus`). `patch` is `Partial<TerrainSpec>`, so the cases below reach
 * a broken row the way a JSON catalog would rather than through a cast.
 */
/**
 * What a terrain case may change. Wider than `Partial<TerrainSpec>` in exactly one place:
 * `defenseBonus` accepts an explicit `undefined`, which means **"this row must carry no
 * such key at all"**. That is a state `exactOptionalPropertyTypes` forbids anyone to write,
 * and it is the state a pre-M6 catalog has, so the helper below is where it is reached —
 * the same argument `withRawWonder` makes about `wonder: false`.
 */
interface TerrainPatch {
  readonly role?: TerrainSpec['role'];
  readonly name?: string;
  readonly moveCost?: number;
  readonly defenseBonusPct?: number;
  readonly yields?: TerrainSpec['yields'];
  readonly impassable?: boolean;
  readonly defenseBonus?: number | undefined;
}

/**
 * The catalog with one terrain row patched.
 *
 * `Object.assign` rather than a spread, because a spread cannot *remove* a key: the M6
 * case this helper exists for is a row that must not carry `defenseBonus` even though the
 * shipped row does, and `Object.assign` skips `undefined` sources while a spread would
 * copy an explicit `undefined` across. The cast is a claim about data the builder cannot
 * prove (every shipped row does declare the field), not a way to quiet a type error — the
 * same distinction `withRawEffects` draws.
 */
/**
 * A copy of a terrain row with the M6 name **removed**.
 *
 * Neither a spread nor `Object.assign` can drop a key: a rest-pattern copy writes the
 * removed key back, and an `Object.assign` whose source carries `defenseBonus: undefined`
 * still creates the key (`'defenseBonus' in row` reports it as present). `delete` on an
 * *optional* property is the one spelling that really removes it, and the callers assert
 * `'defenseBonus' in row === false` afterwards, so the removal is checked rather than
 * trusted — this is the same trap the state writers in `core/units.ts` are built around,
 * reached here deliberately because "the row has no such key" is the input under test.
 */
const withoutTerrainBonus = (row: TerrainSpec): TerrainSpec => {
  const copy = { ...row };
  delete copy.defenseBonus;
  return copy;
};

/** The same thing for a unit row's `hitPoints` — a row with no combat statistics at all. */
const withoutHitPoints = (row: UnitSpec): UnitSpec => {
  const copy = { ...row };
  delete copy.hitPoints;
  return copy;
};

const withTerrainRow = (id: string, patch: TerrainPatch): Catalog => ({
  ...CATALOG,
  terrains: CATALOG.terrains.map((t) => (t.id === id ? Object.assign({}, t, patch) : t)),
});

/**
 * The catalog with one row's `requiresTech` replaced by raw data (M6).
 *
 * Same reasoning as `withRawEffects`: the interesting failures are the ones the type
 * system cannot express — a number, an object, an id no row defines — and the field has
 * to be reached the way a malformed JSON catalog reaches it. The value is written through
 * a cast on a *spread row*, which is a claim about data the checker is about to verify
 * rather than a way to quiet a type error, exactly as `withRawWonder` argues.
 */
const withRawRequiresTech = (
  section: 'units' | 'buildings' | 'improvements' | 'resources',
  id: string,
  value: unknown,
): Catalog => {
  const patched = (rows: readonly { readonly id: string }[]): readonly { readonly id: string }[] =>
    rows.map((row) => (row.id === id ? ({ ...row, requiresTech: value } as typeof row) : row));
  switch (section) {
    case 'units':
      return { ...CATALOG, units: patched(UNITS) as readonly UnitSpec[] };
    case 'buildings':
      return { ...CATALOG, buildings: patched(BUILDINGS) as readonly BuildingSpec[] };
    case 'improvements':
      return { ...CATALOG, improvements: patched(IMPROVEMENTS) as readonly ImprovementSpec[] };
    case 'resources':
      return { ...CATALOG, resources: patched(RESOURCES) as readonly ResourceSpec[] };
  }
};

/** The cycle ids a rejected catalog reported, or `undefined` if it was accepted. */
const cycleOf = (catalog: Catalog): readonly string[] | undefined => {
  const r = validateRuleset(catalog, 'tuned');
  if (r.ok) return undefined;
  const cycle = r.error.find((e) => e.kind === 'tech-cycle');
  return cycle?.kind === 'tech-cycle' ? cycle.cycle.map(String) : undefined;
};

/**
 * The fields of one raw effect row — the shape a **JSON catalog** has, where
 * nothing has been narrowed to `BuildingEffect` yet. Every field is optional and
 * `unknown` on purpose: the validator's job is to establish what these are.
 */
interface RawEffect {
  readonly kind?: unknown;
  readonly pct?: unknown;
  readonly amount?: unknown;
}

/**
 * The catalog with one building row's `effects` replaced by raw data.
 *
 * The cast is deliberate and is the *point* of the cases that use it:
 * `BuildingEffect` is a closed union, so an effect the validator must reject —
 * an unknown kind, a missing `pct` — cannot be written in typed content code at
 * all. A case that could typecheck its way in would not be testing the check, so
 * it goes in the way real bad data does: as values the type system never saw.
 * `RawEffect` is assignable *from* `BuildingEffect`, which is what makes the cast
 * a narrowing of data rather than a way to silence a type error.
 */
const withRawEffects = (id: string, effects: readonly RawEffect[]): Catalog => ({
  ...CATALOG,
  buildings: BUILDINGS.map((b) =>
    b.id === id ? { ...b, effects: effects as readonly BuildingEffect[] } : b,
  ),
});

/**
 * The catalog with one building row carrying a `wonder` value the type forbids —
 * `false`, which JSON can carry and `BuildingSpec` cannot. Same reasoning as
 * `withRawEffects`: the only route to the value being checked is data the type
 * system never produced.
 */
const withRawWonder = (id: string, value: boolean): Catalog => ({
  ...CATALOG,
  buildings: BUILDINGS.map((b) => (b.id === id ? ({ ...b, wonder: value } as BuildingSpec) : b)),
});

/** The field names of `invalid-value` errors, or the kind for every other error. */
const fieldsOf = (errors: readonly { kind: string; field?: string }[]): readonly string[] =>
  errors.map((e) => e.field ?? e.kind);

describe('ruleset validation', () => {
  it('accepts the placeholder catalog in tuned mode', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
  });

  it('refuses placeholder rows in cited-only mode', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.every((e) => e.kind === 'placeholder-in-cited-only')).toBe(true);
      const first = r.error[0];
      expect(first?.kind).toBe('placeholder-in-cited-only');
      if (first?.kind === 'placeholder-in-cited-only') {
        expect(first.id).toBe('grassland');
        expect(first.catalog).toBe('terrains');
      }
      // Unit rows are placeholders too, so cited-only rejects them as well.
      expect(
        r.error.some((e) => e.kind === 'placeholder-in-cited-only' && e.catalog === 'units'),
      ).toBe(true);
    }
  });

  it('reports a duplicate id', () => {
    const dup = { ...CATALOG, terrains: [...CATALOG.terrains, ...CATALOG.terrains] };
    const r = validateRuleset(dup, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.kind === 'duplicate-id')).toBe(true);
  });

  it('reports an empty catalog', () => {
    // Every section spelled out, `techs` and M6b's `combat` included: a `Catalog` that
    // *omits* a row section would not compile, which is the point of the field being
    // required — "ships none" is written as `[]`, and validation rejects it like any
    // other empty catalog. `combat` and M7's `capture` are singletons rather than lists,
    // so they are spelled out as the sections they are; the missing-section case has its
    // own tests below.
    const r = validateRuleset(
      {
        terrains: [],
        units: [],
        buildings: [],
        improvements: [],
        resources: [],
        techs: [],
        combat: CATALOG.combat,
        capture: CATALOG.capture,
      },
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]?.kind).toBe('empty-catalog');
  });

  it('rejects a non-integer or negative yield', () => {
    const first = CATALOG.terrains[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const broken = {
      ...CATALOG,
      terrains: [{ ...first, yields: { food: -1, shields: 0.5, commerce: 0 } }],
    };
    const r = validateRuleset(broken, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.error.map((e) => (e.kind === 'invalid-value' ? e.field : e.kind));
      expect(fields).toContain('yields.food');
      expect(fields).toContain('yields.shields');
    }
  });

  it('rejects a passable terrain with moveCost below 1', () => {
    const first = CATALOG.terrains[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const r = validateRuleset(
      { ...CATALOG, terrains: [{ ...first, moveCost: 0, impassable: false }] },
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.some((e) => e.kind === 'invalid-value' && e.field === 'moveCost')).toBe(true);
  });
});

describe('unit catalog', () => {
  it('provides a unit for every engine role', () => {
    for (const role of UNIT_ROLES) {
      expect(UNITS.some((u) => u.role === role)).toBe(true);
    }
  });

  it('has a settler the engine can start a game with', () => {
    const settler = UNITS.find((u) => u.role === 'settler');
    expect(settler).toBeDefined();
    expect(settler?.movement).toBeGreaterThanOrEqual(1);
  });

  it('is honest about provenance: every row is a placeholder, none cited', () => {
    for (const u of UNITS) expect(u.provenance.kind).toBe('placeholder');
  });

  it('exposes the roles it validates against', () => {
    // `UNIT_ROLES` is re-exported from core, so content code and the engine
    // cannot drift apart on what a role is.
    expect([...UNIT_ROLES]).toEqual(['settler', 'worker', 'scout', 'military']);
  });

  it('requires provenance by type — a spec without one does not compile', () => {
    expectTypeOf<UnitSpec['provenance']>().toEqualTypeOf<Provenance>();
    expectTypeOf<UnitSpec['role']>().toEqualTypeOf<UnitRole>();
  });

  it('rejects a duplicate unit id', () => {
    const r = validateRuleset({ ...CATALOG, units: [...UNITS, ...UNITS] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dupes = r.error.filter((e) => e.kind === 'duplicate-id');
      expect(dupes.length).toBeGreaterThan(0);
      for (const d of dupes) expect(d.catalog).toBe('units');
    }
  });

  it('rejects a non-integer stat', () => {
    const r = validateRuleset(withUnit('warrior', { attack: 1.5, defense: 0.5 }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(fieldsOf(r.error)).toContain('attack');
      expect(fieldsOf(r.error)).toContain('defense');
      expect(r.error.every((e) => e.kind === 'invalid-value' && e.catalog === 'units')).toBe(true);
    }
  });

  it('rejects a negative stat', () => {
    const r = validateRuleset(withUnit('warrior', { defense: -1 }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'units',
        id: asUnitTypeId('warrior'),
        field: 'defense',
        detail: 'must not be negative',
      });
    }
  });

  it('rejects movement below 1, and a non-integer movement', () => {
    const zero = validateRuleset(withUnit('scout', { movement: 0 }), 'tuned');
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(fieldsOf(zero.error)).toContain('movement');
      expect(zero.error.every((e) => e.kind !== 'empty-catalog')).toBe(true);
    }

    const fractional = validateRuleset(withUnit('scout', { movement: 1.5 }), 'tuned');
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fieldsOf(fractional.error)).toContain('movement');
  });

  it('rejects a cost below 1, and a non-integer cost', () => {
    const free = validateRuleset(withUnit('worker', { cost: 0 }), 'tuned');
    expect(free.ok).toBe(false);
    if (!free.ok)
      expect(free.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'units',
        id: asUnitTypeId('worker'),
        field: 'cost',
        detail: 'must be >= 1',
      });

    const fractional = validateRuleset(withUnit('worker', { cost: 0.5 }), 'tuned');
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fieldsOf(fractional.error)).toContain('cost');
  });

  it('rejects a sea unit in a catalog with no water terrain', () => {
    const land = CATALOG.terrains.filter((t) => t.role !== 'ocean' && t.role !== 'coast');
    const r = validateRuleset({ ...CATALOG, terrains: land }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The hole is reported twice on purpose: once from the terrain side (the
      // role audit) and once against the unit that demands water.
      expect(r.error).toContainEqual({ kind: 'missing-role', role: 'ocean' });
      expect(r.error).toContainEqual({ kind: 'missing-role', role: 'coast' });
      expect(r.error.some((e) => e.kind === 'invalid-value' && e.field === 'domain')).toBe(true);
    }
  });

  it('accepts a sea unit when the catalog provides water', () => {
    expect(UNITS.some((u) => u.domain === 'sea')).toBe(true);
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
  });

  it('accepts a land-only unit catalog without water units', () => {
    const r = validateRuleset({ ...CATALOG, units: LAND_UNITS }, 'tuned');
    expect(r.ok).toBe(true);
  });

  /* ---------------- M6: the combat statistics ---------------- */

  it('declares whole-number combat statistics on every row, and at least one hit point', () => {
    // The contract makes attack/defense/hitPoints required on `UnitSpec`. `hitPoints`
    // cannot be a required *property* (see its field doc), so validation is where the
    // requirement lives — which means "no shipped row omits it" is the assertion that
    // proves the requirement is satisfied by real content rather than only by the type.
    for (const u of UNITS) {
      expect(u.hitPoints, `${u.id} must declare hitPoints`).toBeDefined();
      expect(Number.isInteger(u.attack)).toBe(true);
      expect(Number.isInteger(u.defense)).toBe(true);
      expect(Number.isInteger(u.hitPoints)).toBe(true);
      expect(u.attack).toBeGreaterThanOrEqual(0);
      expect(u.defense).toBeGreaterThanOrEqual(0);
      expect(u.hitPoints).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives the military rows DISTINCT statistics, so the resolver’s output varies', () => {
    // The statistics have to actually distinguish the rows: if every military row read
    // 2/2/3 then `resolveCombat` would return the same odds whatever it computed, and a
    // battle scenario could not tell a working resolver from a broken one.
    // Every military row is distinct on all three numbers. The archer and the horseman are
    // the near miss that makes this worth asserting: they share attack and defence (3/1) and
    // differ only in hit points and mobility, which is a *deliberate* pair — the same fighter
    // with and without a horse, gated differently — so a test that only compared
    // attack/defence would call the table fine and a test that compared nothing would call
    // any table fine.
    const military = UNITS.filter((u) => u.role === 'military');
    const profiles = military.map(
      (u) => `${String(u.attack)}/${String(u.defense)}/${String(u.hitPoints)}`,
    );
    expect(military.length).toBeGreaterThanOrEqual(5);
    expect(new Set(profiles).size).toBe(profiles.length);

    // And the land rows are pairwise distinct on attack/defence too, so no two of them are
    // the same fighter.
    const land = military.filter((u) => u.domain === 'land');
    const landStats = land.map((u) => `${String(u.attack)}/${String(u.defense)}`);
    expect(new Set(landStats).size).toBe(landStats.length);
  });

  it('ships units with attack 0, so "no attack, no attack order" has content behind it', () => {
    // The M6 rule is a legality rule, not a footnote: a unit with `attack === 0` may not
    // attack at all. A rule no shipped row can trigger is a rule nothing tests — the exact
    // mistake M5 made with `requiresTech` — so zero-attack content is required, and at
    // least one of them is in the `military` role, where "surely a warship may attack" is
    // the assumption the rule has to defeat.
    const unarmed = UNITS.filter((u) => u.attack === 0);
    expect(unarmed.length).toBeGreaterThanOrEqual(2);
    expect(unarmed.some((u) => u.role === 'military')).toBe(true);
    // And validation accepts them: `attack: 0` is content, not a defect.
    expect(validateRuleset(CATALOG, 'tuned').ok).toBe(true);
  });

  it('rejects a fractional combat statistic, naming the field', () => {
    const r = validateRuleset(withUnit('warrior', { attack: 1.5, defense: 0.5 }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(fieldsOf(r.error)).toContain('attack');
      expect(fieldsOf(r.error)).toContain('defense');
    }
  });

  it('rejects a negative combat statistic', () => {
    const r = validateRuleset(withUnit('warrior', { defense: -1 }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'units',
        id: asUnitTypeId('warrior'),
        field: 'defense',
        detail: 'must not be negative',
      });
    }
    expect(validateRuleset(withUnit('warrior', { attack: -1 }), 'tuned').ok).toBe(false);
  });

  it('rejects a hitPoints below 1 — zero is a unit that is born destroyed', () => {
    // A unit's `hitPointsLeft` starts at this number, and M6's rule is that a unit at 0 hit
    // points does not exist. So `0` is refused rather than rounded up to 1: content that
    // asks for a unit that is already destroyed is a content error, not a value to repair
    // silently.
    for (const broken of [0, -1]) {
      const r = validateRuleset(withUnit('warrior', { hitPoints: broken }), 'tuned');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContainEqual({
          kind: 'invalid-value',
          catalog: 'units',
          id: asUnitTypeId('warrior'),
          field: 'hitPoints',
          detail: 'must be >= 1',
        });
      }
    }
  });

  it('accepts a row that omits hitPoints, and reads it as one hit point', () => {
    // The documented compromise (see `checkUnit`): absence is accepted because the override
    // applier and the fixture catalogs in this tree rebuild unit rows without it, and
    // rejecting it would fail those paths for a reason that has nothing to do with combat.
    // What is asserted here is that absence is *read* rather than assumed: the engine's
    // totality rule turns a silent row into exactly one hit point, and never into zero.
    // `withoutHitPoints` (above) really removes the key — see its note for why a spread and
    // `Object.assign` both fail to — and the assertion below checks the removal rather than
    // trusting it, because a row that kept `hitPoints: undefined` would be a different input.
    const omitted: Catalog = {
      ...CATALOG,
      units: CATALOG.units.map((u) => (u.id === asUnitTypeId('warrior') ? withoutHitPoints(u) : u)),
    };
    const warriorRow = omitted.units.find((u) => u.id === asUnitTypeId('warrior'));
    expect('hitPoints' in (warriorRow ?? {})).toBe(false);
    const r = validateRuleset(omitted, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const warrior = r.value.units.find((u) => u.id === asUnitTypeId('warrior'));
      expect('hitPoints' in (warrior ?? {})).toBe(false);
      expect(fullHitPoints(warrior)).toBe(1);
    }
  });

  it('rejects a fractional hitPoints', () => {
    const r = validateRuleset(withUnit('warrior', { hitPoints: 2.5 }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(fieldsOf(r.error)).toContain('hitPoints');
  });

  /* ---------------- M6: terrain defence ---------------- */

  it('gives every terrain row the M6 defenseBonus, equal to its defenseBonusPct', () => {
    // Two names for one magnitude. The shipped rows declare both and agree, so a
    // disagreement is a content error the validator catches; the assertion here pins the
    // agreement at the content level as well, so a row that quietly dropped one of them
    // fails a test rather than only being tolerated by the reader's fallback.
    for (const t of CATALOG.terrains) {
      expect(t.defenseBonus, `${t.id} must declare defenseBonus`).toBeDefined();
      expect(Number.isInteger(t.defenseBonus)).toBe(true);
      expect(t.defenseBonus).toBeGreaterThanOrEqual(0);
      expect(t.defenseBonus).toBe(t.defenseBonusPct);
    }
  });

  it('rejects a negative or fractional terrain defense bonus, under either name', () => {
    for (const broken of [-10, 1.5]) {
      const byPct = validateRuleset(
        withTerrainRow(asTerrainId('hills'), { defenseBonusPct: broken, defenseBonus: undefined }),
        'tuned',
      );
      expect(byPct.ok).toBe(false);
      if (!byPct.ok) expect(fieldsOf(byPct.error)).toContain('defenseBonusPct');

      const byM6Name = validateRuleset(
        withTerrainRow(asTerrainId('hills'), { defenseBonus: broken }),
        'tuned',
      );
      expect(byM6Name.ok).toBe(false);
      if (!byM6Name.ok) expect(fieldsOf(byM6Name.error)).toContain('defenseBonus');
    }
  });

  it('rejects a row whose two spellings of the terrain bonus disagree', () => {
    // This is the check that makes "one number, two names" safe: the combat reader prefers
    // `defenseBonus`, so a row that said 50 in `defenseBonusPct` and 0 in `defenseBonus`
    // would fight as though the terrain gave nothing while every report of the older field
    // showed 50. Refused at load time instead.
    const r = validateRuleset(
      withTerrainRow(asTerrainId('hills'), { defenseBonusPct: 50, defenseBonus: 25 }),
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find((e) => e.kind === 'invalid-value' && e.field === 'defenseBonus');
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.id).toBe(asTerrainId('hills'));
        expect(error.detail).toContain('must equal defenseBonusPct (50)');
      }
    }
  });

  it('accepts a terrain row that declares only defenseBonusPct — and defaults it to 0', () => {
    // The fallback the combat reader relies on: a view whose rows predate M6 — every
    // hand-built `TerrainDef` in this tree — is legal, and "declares nothing" means no
    // terrain defence rather than an error. The row is written out in full rather than
    // patched, because `TerrainSpec.defenseBonus` is an optional *property* and
    // `exactOptionalPropertyTypes` forbids spelling its absence as an explicit `undefined`.
    const hills = CATALOG.terrains.find((t) => t.id === asTerrainId('hills'));
    expect(hills).toBeDefined();
    if (hills === undefined) return;
    const withoutM6Name = withoutTerrainBonus(hills);
    expect('defenseBonus' in withoutM6Name).toBe(false);
    const onlyPct = validateRuleset({ ...CATALOG, terrains: [withoutM6Name] }, 'tuned');
    // Rejected only for the *roles* the trimmed catalog no longer covers, never for the
    // missing field: that is the point of the case.
    const complaints = onlyPct.ok ? [] : fieldsOf(onlyPct.error);
    expect(complaints).not.toContain('defenseBonus');
    expect(complaints).not.toContain('defenseBonusPct');
  });

  /* ---------------- M4c: the resource gate ---------------- */

  it('gates shipped units on a shipped strategic resource, and names both', () => {
    // M4c's resource gating has to be reachable from *shipped* content, not only
    // from a hand-built ruleset view — the same lesson M4b's accepted debt taught
    // about maintenance. Asserted by value, so it cannot silently regress to "no
    // shipped unit requires anything" while the engine still claims to gate.
    const gated = UNITS.filter((u) => u.requiresResource !== undefined);
    // In catalog order, which is the order the table declares them.
    expect(gated.map((u) => u.id)).toEqual([asUnitTypeId('horseman'), asUnitTypeId('swordsman')]);
    // Every requirement names a real strategic resource: a gate on a bonus or a luxury
    // would be a gate M4c's `resourceGate` cannot satisfy, since those are never
    // "connected" as strategic resources are.
    for (const unit of gated) {
      const resource = RESOURCES.find((r) => r.id === unit.requiresResource);
      expect(resource, `${unit.id} requires a row that exists`).toBeDefined();
      expect(resource?.kind).toBe('strategic');
    }
    const horseman = gated.find((u) => u.id === asUnitTypeId('horseman'));
    const swordsman = gated.find((u) => u.id === asUnitTypeId('swordsman'));
    expect(horseman?.requiresResource).toBe(asResourceId('horses'));
    expect(swordsman?.requiresResource).toBe(asResourceId('iron'));
  });

  it('keeps the first military land row ungated, so huts still hand out the warrior', () => {
    // `hut.ts` gives away and spawns the *cheapest* `military`-role land row (ties by id).
    // A gated or more expensive row placed above the warrior would make huts hand out a
    // unit a city may not even be able to build — a behavioural change smuggled in by
    // content *order*. Pinned here because nothing else would notice.
    const militaryLand = UNITS.filter((u) => u.role === 'military' && u.domain === 'land');
    const firstMilitaryLand = militaryLand[0];
    expect(firstMilitaryLand?.id).toBe(asUnitTypeId('warrior'));
    expect(firstMilitaryLand?.requiresResource).toBeUndefined();
    expect(firstMilitaryLand?.requiresTech).toBeUndefined();
    // …and it stays the cheapest row that can fight, which is the other half of "what a
    // hut hands out".
    const cheapest = [...militaryLand].sort((a, b) => a.cost - b.cost)[0];
    expect(cheapest?.id).toBe(asUnitTypeId('warrior'));

    // The whole table's cheapest row is the scout, which is what the played golden's fixed
    // script produces and what `hut.ts` calls the cheapest unit a catalog defines. It must
    // stay ungated too, or the golden's script would be refused by a gate it cannot pass.
    const cheapestAny = [...UNITS].sort((a, b) => a.cost - b.cost)[0];
    expect(cheapestAny?.id).toBe(asUnitTypeId('scout'));
    expect(cheapestAny?.requiresTech).toBeUndefined();
    expect(cheapestAny?.requiresResource).toBeUndefined();
  });

  /* ---------------- M6: the tech gate is USED, not merely available ---------------- */

  it('ships at least one unit with requiresTech, and one row gated on both gates', () => {
    // The M6 requirement, verbatim: "M6 content must actually use the gates M5 built. No
    // shipped row declares `requiresTech` today, which is exactly why two gating defects
    // survived play testing." So the assertion is *not* "the field exists" — it is "shipped
    // rows declare it", by id and by named tech, so it cannot quietly go back to nothing.
    const gated = UNITS.filter((u) => u.requiresTech !== undefined);
    expect(gated.length).toBeGreaterThanOrEqual(2);

    const archer = UNITS.find((u) => u.id === asUnitTypeId('archer'));
    expect(archer?.requiresTech).toBe(asTechId('warrior-code'));
    // Every named tech is a row the tree really defines, which is what `validateRuleset`
    // enforces and what makes `techUnlocks` report something.
    for (const unit of gated) {
      expect(TECHS.some((t) => t.id === unit.requiresTech)).toBe(true);
    }

    // The row that carries both gates: a resource *and* a technology. They are independent
    // dimensions, and this is the case where getting their order wrong in a planner shows.
    const horseman = UNITS.find((u) => u.id === asUnitTypeId('horseman'));
    expect(horseman?.requiresResource).toBe(asResourceId('horses'));
    expect(horseman?.requiresTech).toBe(asTechId('horseback-riding'));
  });

  it('carries requiresTech through the type, as an absent key when it is unset', () => {
    expectTypeOf<UnitSpec['requiresTech']>().toEqualTypeOf<TechId | undefined>();
    for (const u of UNITS.filter((unit) => unit.requiresTech === undefined)) {
      expect('requiresTech' in u).toBe(false);
    }
  });

  it('ships a gated BUILDING too, so the requirement is not met by units alone', () => {
    // "At least one new gated unit and one gated building/improvement must declare
    // `requiresTech`" — the building half, asserted by id so a later retune cannot silently
    // un-use the gate while the engine still claims to gate production.
    const gated = BUILDINGS.filter((b) => b.requiresTech !== undefined);
    expect(gated.length).toBeGreaterThanOrEqual(1);
    const temple = BUILDINGS.find((b) => b.id === asBuildingId('temple'));
    expect(temple?.requiresTech).toBe(asTechId('ceremonial-burial'));
    // Every named tech is a row the tree really defines — the same guarantee the unit half
    // gets from `validateRuleset`, stated here so a broken reference fails a *content* test
    // as well as a validation one.
    for (const building of gated) {
      expect(TECHS.some((t) => t.id === building.requiresTech)).toBe(true);
    }
  });

  it('keeps the cheapest building ungated, so the first thing a city can build always can be', () => {
    // The played golden sets its city to produce the cheapest building in the catalog on a
    // board with no technologies, and a *player* in the same position would be stuck with an
    // empty production list if the cheapest row were gated. Pinned by value: the cheapest
    // row is the granary and it requires nothing.
    const cheapest = [...BUILDINGS].sort((a, b) => a.cost - b.cost)[0];
    expect(cheapest?.id).toBe(asBuildingId('granary'));
    expect(cheapest?.requiresTech).toBeUndefined();

    // …and the gated building is strictly more expensive, so the gate cannot be the only
    // reason it is not built first.
    const temple = BUILDINGS.find((b) => b.id === asBuildingId('temple'));
    expect(temple?.cost).toBeGreaterThan(cheapest?.cost ?? 0);
  });

  it('rejects a building requiresTech that names no row in the tech catalog', () => {
    const r = validateRuleset(withRawRequiresTech('buildings', 'temple', 'philosophy'), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'buildings',
        id: asBuildingId('temple'),
        field: 'requiresTech',
        detail: 'names tech "philosophy", which this catalog does not define',
      });
    }
  });

  it('rejects an improvement requiresTech that names no row in the tech catalog', () => {
    const r = validateRuleset(withRawRequiresTech('improvements', 'mine', 'philosophy'), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find((e) => e.kind === 'invalid-value' && e.field === 'requiresTech');
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.id).toBe(asImprovementId('mine'));
        expect(error.catalog).toBe('improvements');
      }
    }
  });

  it('rejects a resource requiresTech that names no row in the tech catalog', () => {
    const r = validateRuleset(
      withRawRequiresTech('resources', 'iron', asTechId('philosophy')),
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find((e) => e.kind === 'invalid-value' && e.field === 'requiresTech');
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.catalog).toBe('resources');
        expect(error.detail).toContain('philosophy');
      }
    }
  });

  it('rejects a unit requiresTech that names no row in the tech catalog', () => {
    const r = validateRuleset(withRawRequiresTech('units', 'archer', 'philosophy'), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'units',
        id: asUnitTypeId('archer'),
        field: 'requiresTech',
        detail: 'names tech "philosophy", which this catalog does not define',
      });
    }
  });

  it('rejects a requiresResource that names no row in the resource catalog', () => {
    const r = validateRuleset(
      withUnit('warrior', { requiresResource: asResourceId('mithril') }),
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'units',
        id: asUnitTypeId('warrior'),
        field: 'requiresResource',
        detail: 'names resource "mithril", which this catalog does not define',
      });
    }
  });

  it('rejects the shipped swordsman once the resource it demands is removed', () => {
    // The same check, reached through shipped content rather than a patch: delete
    // iron and the row that requires it becomes unbuildable content, which is
    // exactly what validation exists to refuse.
    const noIron = {
      ...CATALOG,
      resources: RESOURCES.filter((r) => r.id !== asResourceId('iron')),
    };
    const r = validateRuleset(noIron, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find(
        (e) => e.kind === 'invalid-value' && e.field === 'requiresResource',
      );
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.id).toBe(asUnitTypeId('swordsman'));
        expect(error.catalog).toBe('units');
      }
    }
  });

  it('accepts a unit that requires nothing, and one that requires a shipped row', () => {
    expect(validateRuleset(withUnit('warrior', {}), 'tuned').ok).toBe(true);
    expect(
      validateRuleset(withUnit('warrior', { requiresResource: asResourceId('horses') }), 'tuned')
        .ok,
    ).toBe(true);
  });

  it('carries requiresResource through the type, as an absent key when it is unset', () => {
    expectTypeOf<UnitSpec['requiresResource']>().toEqualTypeOf<ResourceId | undefined>();
  });

  it('is unchanged by validation: the same rows come back out', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.units).toEqual([...UNITS]);
      // A validated ruleset carries units, so it satisfies the engine's view.
      expect(r.value.units.every((u) => u.provenance.kind === 'placeholder')).toBe(true);
    }
  });
});

describe('building catalog', () => {
  it('provides a handful of buildings, which is what M3 production needs', () => {
    expect(BUILDINGS.length).toBeGreaterThanOrEqual(3);
    for (const b of BUILDINGS) {
      expect(b.name).not.toBe('');
      expect(b.cost).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(b.cost)).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = BUILDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The provenance warning at the top of INTERFACES.md M3 is the point of this
   * test: every building row is `placeholder`, and its note has to *say* the
   * number is ours rather than claiming Civ 3. "Looks right" is not provenance.
   */
  it('is honest about provenance: every row is a placeholder that says so', () => {
    for (const b of BUILDINGS) {
      expect(b.provenance.kind).toBe('placeholder');
      if (b.provenance.kind === 'placeholder') {
        // The note has to *say* it: unsourced, and ours rather than Civ 3's.
        const note = b.provenance.note.toLowerCase();
        expect(note).toContain('unsourced');
        expect(note).toContain('ours');
      }
    }
  });

  it('requires provenance by type — a spec without one does not compile', () => {
    expectTypeOf<BuildingSpec['provenance']>().toEqualTypeOf<Provenance>();
    expectTypeOf<BuildingSpec['cost']>().toEqualTypeOf<number>();
  });

  it('rejects a duplicate building id', () => {
    const r = validateRuleset({ ...CATALOG, buildings: [...BUILDINGS, ...BUILDINGS] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dupes = r.error.filter((e) => e.kind === 'duplicate-id');
      // The second copy of each row is the duplicate, so one error per building.
      expect(dupes).toHaveLength(BUILDINGS.length);
      expect(dupes.map((d) => d.catalog)).toEqual(BUILDINGS.map(() => 'buildings'));
    }
  });

  it('rejects a free building and a fractional cost', () => {
    const free = validateRuleset(withBuilding('granary', { cost: 0 }), 'tuned');
    expect(free.ok).toBe(false);
    if (!free.ok) {
      expect(free.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'buildings',
        id: asBuildingId('granary'),
        field: 'cost',
        detail: 'must be >= 1',
      });
    }

    const fractional = validateRuleset(withBuilding('granary', { cost: 1.5 }), 'tuned');
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fieldsOf(fractional.error)).toContain('cost');
  });

  it('reports an empty buildings catalog the way it reports any empty catalog', () => {
    const r = validateRuleset({ ...CATALOG, buildings: [] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ kind: 'empty-catalog', catalog: 'buildings' });
    }
  });

  it('refuses placeholder buildings in cited-only mode', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const buildingsInCitedOnly = r.error.filter(
        (e) => e.kind === 'placeholder-in-cited-only' && e.catalog === 'buildings',
      );
      expect(buildingsInCitedOnly).toHaveLength(BUILDINGS.length);
    }
  });

  it('is carried through validation, so the engine can cost a building', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.buildings).toEqual([...BUILDINGS]);
      // A validated ruleset's `buildingSpec`s are structurally the engine's
      // `BuildingDef`s: the cost `itemCost` reads is present and is an integer.
      for (const b of r.value.buildings) expect(Number.isInteger(b.cost)).toBe(true);
    }
  });

  /* ---------------- M4c: maintenance, effects and wonders ---------------- */

  it('bills real maintenance, pinned by value, so a shortfall is reachable from content', () => {
    // M4b's accepted debt, closed. `TreasuryShortfall.unpaid` was unreachable from
    // shipped content because no catalog building declared a maintenance, so the
    // branch was covered only by a hand-built ruleset view. These assertions are
    // by value: the aggregate could be satisfied by any row, and the point is
    // which rows a real game is billed for.
    const billing = BUILDINGS.filter((b) => b.maintenance > 0);
    expect(billing.length).toBeGreaterThanOrEqual(3);

    const ids = billing.map((b) => b.id);
    expect(ids).toContain(asBuildingId('barracks'));
    expect(ids).toContain(asBuildingId('library'));

    expect(BUILDINGS.find((b) => b.id === asBuildingId('barracks'))?.maintenance).toBe(1);
    // …and the granary is deliberately free: the first building an early city can
    // afford must not be the one that bankrupts it.
    expect(BUILDINGS.find((b) => b.id === asBuildingId('granary'))?.maintenance).toBe(0);

    for (const b of BUILDINGS) {
      expect(Number.isInteger(b.maintenance)).toBe(true);
      expect(b.maintenance).toBeGreaterThanOrEqual(0);
    }
  });

  it('declares at least one effect for every row, and reaches every effect kind', () => {
    // Two properties, both deliberate. "At least one effect" means no shipped
    // building is a pure shield-and-gold sink; "every kind" means each member of
    // the closed union is exercised by real content rather than only by a test's
    // stand-in. Where the kind is a stand-in for what the building is really for
    // (walls, barracks, temple) the row's provenance note says so out loud.
    for (const b of BUILDINGS) expect(b.effects.length).toBeGreaterThan(0);

    const kinds = new Set<BuildingEffectKind>(
      BUILDINGS.flatMap((b) => b.effects.map((e) => e.kind)),
    );
    expect([...BUILDING_EFFECT_KINDS].every((kind) => kinds.has(kind))).toBe(true);
  });

  it('marks exactly one shipped row as a wonder, and leaves the key off every other row', () => {
    // `wonder: true` is what makes the global-uniqueness rule apply, so the catalog
    // has to say which rows carry it. The second half matters as much: "not a
    // wonder" is the *absence* of the key, never a key holding `false` — a present
    // falsy key is the same trap that has cost this project three bug hunts, one
    // step away from the `undefined` that cannot survive a JSON round trip.
    expect(BUILDINGS.filter((b) => b.wonder === true).map((b) => b.id)).toEqual([
      asBuildingId('pyramids'),
    ]);
    for (const b of BUILDINGS) {
      if (b.wonder === true) continue;
      expect('wonder' in b).toBe(false);
    }
  });

  it('costs a wonder maintenance like any other building, which is the one way it is lost', () => {
    const pyramids = BUILDINGS.find((b) => b.id === asBuildingId('pyramids'));
    expect(pyramids?.wonder).toBe(true);
    expect(pyramids?.maintenance).toBe(2);
  });

  it('requires maintenance, effects and wonder by type', () => {
    expectTypeOf<BuildingSpec['maintenance']>().toEqualTypeOf<number>();
    expectTypeOf<BuildingSpec['effects']>().toEqualTypeOf<readonly BuildingEffect[]>();
    expectTypeOf<BuildingSpec['wonder']>().toEqualTypeOf<true | undefined>();
  });

  it('rejects a negative and a fractional maintenance', () => {
    const negative = validateRuleset(withBuilding('temple', { maintenance: -1 }), 'tuned');
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'buildings',
        id: asBuildingId('temple'),
        field: 'maintenance',
        detail: 'must not be negative',
      });
    }

    const fractional = validateRuleset(withBuilding('temple', { maintenance: 0.5 }), 'tuned');
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) {
      expect(fractional.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'buildings',
        id: asBuildingId('temple'),
        field: 'maintenance',
        detail: 'must be an integer',
      });
    }

    // Zero is legal and means "free to keep" — it is the granary's shipped value,
    // and rejecting it would make the honest row unrepresentable.
    expect(validateRuleset(withBuilding('temple', { maintenance: 0 }), 'tuned').ok).toBe(true);
  });

  it('rejects an unknown effect kind, naming the kinds it knows', () => {
    // The union makes this a compile error in content code, so the route in is
    // data — a JSON catalog, or a patch like this one.
    const r = validateRuleset(withRawEffects('library', [{ kind: 'happiness', pct: 10 }]), 'tuned');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find(
        (e) =>
          e.kind === 'invalid-value' && e.catalog === 'buildings' && e.field === 'effects[0].kind',
      );
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.id).toBe(asBuildingId('library'));
        expect(error.detail).toContain('commerce-multiplier');
        expect(error.detail).toContain('growth-food');
        expect(error.detail).toContain('happiness');
      }
    }
  });

  it('rejects a negative or fractional effect number, per field', () => {
    const negative = validateRuleset(
      withRawEffects('library', [{ kind: 'beaker-multiplier', pct: -10 }]),
      'tuned',
    );
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'buildings',
        id: asBuildingId('library'),
        field: 'effects[0].pct',
        detail: 'must not be negative',
      });
    }

    const fractional = validateRuleset(
      withRawEffects('library', [{ kind: 'beaker-multiplier', pct: 12.5 }]),
      'tuned',
    );
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fieldsOf(fractional.error)).toContain('effects[0].pct');

    // `growth-food` carries `amount`, and the checker reads the right field for the
    // kind rather than one field for every effect.
    const negativeAmount = validateRuleset(
      withRawEffects('granary', [{ kind: 'growth-food', amount: -1 }]),
      'tuned',
    );
    expect(negativeAmount.ok).toBe(false);
    if (!negativeAmount.ok) {
      expect(negativeAmount.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'buildings',
        id: asBuildingId('granary'),
        field: 'effects[0].amount',
        detail: 'must not be negative',
      });
    }

    const fractionalAmount = validateRuleset(
      withRawEffects('granary', [{ kind: 'growth-food', amount: 1.5 }]),
      'tuned',
    );
    expect(fractionalAmount.ok).toBe(false);
    if (!fractionalAmount.ok)
      expect(fieldsOf(fractionalAmount.error)).toContain('effects[0].amount');
  });

  it('rejects a multiplier with no pct at all, and one with an amount instead', () => {
    const missing = validateRuleset(
      withRawEffects('library', [{ kind: 'beaker-multiplier' }]),
      'tuned',
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(fieldsOf(missing.error)).toContain('effects[0].pct');

    // The wrong field for the kind is a data error too: a `pct` on a `growth-food`
    // row says the author meant a multiplier, and silently reading 0 would be a
    // building that does nothing where one that does something was intended.
    const wrongField = validateRuleset(
      withRawEffects('granary', [{ kind: 'growth-food', pct: 25 }]),
      'tuned',
    );
    expect(wrongField.ok).toBe(false);
    if (!wrongField.ok) expect(fieldsOf(wrongField.error)).toContain('effects[0].amount');
  });

  it('accepts a zero percentage and an empty effect list — both are honest rows', () => {
    expect(
      validateRuleset(withRawEffects('library', [{ kind: 'beaker-multiplier', pct: 0 }]), 'tuned')
        .ok,
    ).toBe(true);
    // An empty list says "this building currently does nothing but cost shields
    // and gold". Rejecting it would push content into inventing an effect it does
    // not mean.
    expect(validateRuleset(withBuilding('temple', { effects: [] }), 'tuned').ok).toBe(true);
  });

  it('declares whole numbers on every shipped effect, read through the right field', () => {
    // The effect numbers reach a city's output, which is hashed, so a fraction
    // there would make a state unhashable. Checked per kind rather than with one
    // field name for every row, because that is the mistake the checker itself
    // could make: `pct` and `amount` are both numbers.
    for (const b of BUILDINGS) {
      for (const e of b.effects) {
        const value = e.kind === 'growth-food' ? e.amount : e.pct;
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('rejects a fractional number on every shipped effect row that has one', () => {
    // The shipped catalog is checked field by field rather than only in aggregate:
    // a fractional percentage in a real row would reach a hashed city yield.
    for (const b of BUILDINGS) {
      const bad = b.effects.map((e) =>
        e.kind === 'growth-food' ? { kind: e.kind, amount: 0.5 } : { kind: e.kind, pct: 0.5 },
      );
      expect(validateRuleset(withRawEffects(b.id, bad), 'tuned').ok).toBe(false);
    }
  });

  it('rejects wonder: false — the spelling JSON can carry and the type cannot', () => {
    const r = validateRuleset(withRawWonder('granary', false), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find(
        (e) => e.kind === 'invalid-value' && e.catalog === 'buildings' && e.field === 'wonder',
      );
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.id).toBe(asBuildingId('granary'));
        expect(error.detail).toContain('must be true when present');
      }
    }

    // …and the value the type *does* allow is accepted, on any row.
    expect(validateRuleset(withRawWonder('granary', true), 'tuned').ok).toBe(true);
    expect(validateRuleset(CATALOG, 'tuned').ok).toBe(true);
  });
});

describe('resource catalog', () => {
  it('covers all three kinds the engine understands', () => {
    // Every kind the engine knows is exercised by a shipped row, so a game played
    // on this catalog really does place a strategic resource, a luxury and a bonus
    // resource rather than relying on a test's stand-in for any of them.
    for (const kind of RESOURCE_KINDS) {
      expect(RESOURCES.some((r) => r.kind === kind)).toBe(true);
    }
    expect(RESOURCES.length).toBeGreaterThanOrEqual(3);
  });

  it('has unique ids, and a name on every row', () => {
    const ids = RESOURCES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RESOURCES) expect(r.name).not.toBe('');
  });

  it('restricts each row to terrains this catalog ships, with no empties and no repeats', () => {
    // `allowedRoles` is where generation may place a row, so a role no terrain
    // fills is content that can never appear on any map. Validation checks the
    // list is non-empty (an empty one is "nowhere", not "anywhere"); that every
    // role named is real is a *content* property, asserted here.
    const roles: readonly string[] = TERRAIN_ROLES;
    for (const r of RESOURCES) {
      expect(r.allowedRoles.length).toBeGreaterThan(0);
      for (const role of r.allowedRoles) {
        expect(roles).toContain(role);
        expect(CATALOG.terrains.some((t) => t.role === role)).toBe(true);
      }
      expect(new Set(r.allowedRoles).size).toBe(r.allowedRoles.length);
    }
  });

  it('gives yields to bonus rows only, and zeros everywhere else', () => {
    for (const r of RESOURCES) {
      for (const value of [r.yields.food, r.yields.shields, r.yields.commerce]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        if (r.kind !== 'bonus') expect(value).toBe(0);
      }
    }
    // A bonus resource is *just terrain*: it is the one kind whose yields are
    // added to the tile, so at least one shipped row has to carry a real delta.
    const bonus = RESOURCES.filter((r) => r.kind === 'bonus');
    expect(bonus.length).toBeGreaterThan(0);
    for (const r of bonus) {
      expect(r.yields.food + r.yields.shields + r.yields.commerce).toBeGreaterThan(0);
    }
  });

  it('says out loud that luxuries do nothing until M9', () => {
    for (const r of RESOURCES.filter((row) => row.kind === 'luxury')) {
      expect(r.provenance.kind).toBe('placeholder');
      if (r.provenance.kind === 'placeholder') expect(r.provenance.note).toContain('M9');
    }
  });

  it('is honest about provenance: every row is a placeholder that says so', () => {
    for (const r of RESOURCES) {
      expect(r.provenance.kind).toBe('placeholder');
      if (r.provenance.kind === 'placeholder') {
        const note = r.provenance.note.toLowerCase();
        expect(note).toContain('unsourced');
        expect(note).toContain('ours');
      }
    }
  });

  it('requires provenance by type — a spec without one does not compile', () => {
    expectTypeOf<ResourceSpec['provenance']>().toEqualTypeOf<Provenance>();
    expectTypeOf<ResourceSpec['kind']>().toEqualTypeOf<ResourceKind>();
    expectTypeOf<ResourceSpec['yields']>().toEqualTypeOf<{
      readonly food: number;
      readonly shields: number;
      readonly commerce: number;
    }>();
  });

  it('rejects a duplicate resource id', () => {
    const r = validateRuleset({ ...CATALOG, resources: [...RESOURCES, ...RESOURCES] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dupes = r.error.filter((e) => e.kind === 'duplicate-id');
      expect(dupes).toHaveLength(RESOURCES.length);
      expect(dupes.map((d) => d.catalog)).toEqual(RESOURCES.map(() => 'resources'));
    }
  });

  it('rejects an unknown kind', () => {
    // Same route in as the unknown improvement kind: the type makes it a compile
    // error in content code, so the case is spelled as a patch.
    const r = validateRuleset(withResourceRow('iron', { kind: 'bonusx' as ResourceKind }), 'tuned');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find(
        (e) => e.kind === 'invalid-value' && e.catalog === 'resources' && e.field === 'kind',
      );
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.detail).toContain('strategic, luxury, bonus');
        expect(error.detail).toContain('bonusx');
      }
    }
  });

  it('rejects a negative and a fractional yield', () => {
    const bad = validateRuleset(
      withResourceRow('wheat', { yields: { food: -1, shields: 0.5, commerce: 0 } }),
      'tuned',
    );

    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'resources',
        id: asResourceId('wheat'),
        field: 'yields.food',
        detail: 'must not be negative',
      });
      expect(bad.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'resources',
        id: asResourceId('wheat'),
        field: 'yields.shields',
        detail: 'must be an integer',
      });
      // One error per broken field, not one per row.
      expect(fieldsOf(bad.error)).not.toContain('yields.commerce');
    }
  });

  it('rejects a yield on a row that does not yield — bonus only, zeros otherwise', () => {
    // A strategic row that quietly carried +1 food would feed cities as a side
    // effect of being connected, which is not what a strategic resource is for.
    for (const id of ['iron', 'horses']) {
      const r = validateRuleset(
        withResourceRow(id, { yields: { food: 1, shields: 0, commerce: 0 } }),
        'tuned',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const error = r.error.find(
          (e) =>
            e.kind === 'invalid-value' && e.field === 'yields.food' && e.catalog === 'resources',
        );
        expect(error).toBeDefined();
        if (error?.kind === 'invalid-value')
          expect(error.detail).toContain('only a bonus resource');
      }
    }

    const luxury = validateRuleset(
      withResourceRow('gems', { yields: { food: 0, shields: 0, commerce: 2 } }),
      'tuned',
    );
    expect(luxury.ok).toBe(false);
    if (!luxury.ok) expect(fieldsOf(luxury.error)).toContain('yields.commerce');
  });

  it('rejects a resource allowed on no terrain', () => {
    const r = validateRuleset(withResourceRow('iron', { allowedRoles: [] }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'resources',
        id: asResourceId('iron'),
        field: 'allowedRoles',
        detail: 'must list at least one terrain role',
      });
    }
  });

  it('reports an empty resources catalog the way it reports any empty catalog', () => {
    const r = validateRuleset({ ...CATALOG, resources: [] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ kind: 'empty-catalog', catalog: 'resources' });
    }
  });

  it('refuses placeholder resources in cited-only mode', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const inCitedOnly = r.error.filter(
        (e) => e.kind === 'placeholder-in-cited-only' && e.catalog === 'resources',
      );
      expect(inCitedOnly).toHaveLength(RESOURCES.length);
    }
  });

  it('is carried through validation, so generation can read a row', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.resources).toEqual([...RESOURCES]);
      // A validated ruleset's `resources` are structurally the engine's
      // `ResourceDef`s — every field generation reads is present.
      for (const row of r.value.resources) {
        expect(Number.isInteger(row.yields.food)).toBe(true);
        expect(row.allowedRoles.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('improvement catalog', () => {
  it('provides at least one row per engine kind', () => {
    // The shipped catalog is the content the CLI and the golden harness run on,
    // so every kind the engine understands must be exercised by a real row rather
    // than only by a test's stand-in.
    for (const kind of IMPROVEMENT_KINDS) {
      expect(IMPROVEMENTS.some((i) => i.kind === kind)).toBe(true);
    }
    expect(IMPROVEMENTS.length).toBeGreaterThanOrEqual(3);
  });

  it('has the three rows the milestone asks for, with unique ids', () => {
    const ids = IMPROVEMENTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['road', 'mine', 'irrigation']) {
      expect(ids).toContain(asImprovementId(id));
    }
  });

  it('restricts each row to terrains that exist in the catalog', () => {
    // `allowedRoles` is checked for emptiness by validation; that every role it
    // names is a role this catalog actually ships is a content property, asserted
    // here — a mine on a role no terrain fills would be unbuildable in every game.
    const roles: readonly string[] = TERRAIN_ROLES;
    for (const i of IMPROVEMENTS) {
      expect(i.allowedRoles.length).toBeGreaterThan(0);
      for (const role of i.allowedRoles) {
        expect(roles).toContain(role);
        expect(CATALOG.terrains.some((t) => t.role === role)).toBe(true);
      }
      expect(new Set(i.allowedRoles).size).toBe(i.allowedRoles.length);
    }
  });

  it('never lets a shipped row subtract: every delta is a non-negative integer', () => {
    // The engine clamps at zero per component for *foreign* data; a shipped row
    // that relied on that clamp would be a row whose author meant something else.
    for (const i of IMPROVEMENTS) {
      expect(Number.isInteger(i.turns)).toBe(true);
      expect(i.turns).toBeGreaterThanOrEqual(1);
      expect(i.name).not.toBe('');
      for (const value of [i.yields.food, i.yields.shields, i.yields.commerce]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is honest about provenance: every row is a placeholder that says so', () => {
    // The provenance warning at the top of INTERFACES.md M3 applies verbatim to
    // M4a: worker turn counts, improvement yields and terrain restrictions are all
    // guesses, and each note has to *say* the value is unsourced and ours rather
    // than Civ 3's. "Looks right" is not provenance.
    for (const i of IMPROVEMENTS) {
      expect(i.provenance.kind).toBe('placeholder');
      if (i.provenance.kind === 'placeholder') {
        const note = i.provenance.note.toLowerCase();
        expect(note).toContain('unsourced');
        expect(note).toContain('ours');
      }
    }
  });

  it('requires provenance by type — a spec without one does not compile', () => {
    expectTypeOf<ImprovementSpec['provenance']>().toEqualTypeOf<Provenance>();
    expectTypeOf<ImprovementSpec['kind']>().toEqualTypeOf<ImprovementKind>();
    expectTypeOf<ImprovementSpec['turns']>().toEqualTypeOf<number>();
  });

  it('rejects a duplicate improvement id', () => {
    const r = validateRuleset(
      { ...CATALOG, improvements: [...IMPROVEMENTS, ...IMPROVEMENTS] },
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dupes = r.error.filter((e) => e.kind === 'duplicate-id');
      expect(dupes).toHaveLength(IMPROVEMENTS.length);
      expect(dupes.map((d) => d.catalog)).toEqual(IMPROVEMENTS.map(() => 'improvements'));
    }
  });

  it('rejects a turn count below 1, and a non-integer turn count', () => {
    const zero = validateRuleset(withImprovementRow('mine', { turns: 0 }), 'tuned');
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'improvements',
        id: asImprovementId('mine'),
        field: 'turns',
        detail: 'must be >= 1',
      });
    }

    const fractional = validateRuleset(withImprovementRow('mine', { turns: 1.5 }), 'tuned');
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) {
      expect(fractional.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'improvements',
        id: asImprovementId('mine'),
        field: 'turns',
        detail: 'must be an integer',
      });
    }
  });

  it('rejects a negative and a fractional yield delta', () => {
    const bad = validateRuleset(
      withImprovementRow('mine', { yields: { food: -1, shields: 0.5, commerce: 0 } }),
      'tuned',
    );

    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'improvements',
        id: asImprovementId('mine'),
        field: 'yields.food',
        detail: 'must not be negative',
      });
      expect(bad.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'improvements',
        id: asImprovementId('mine'),
        field: 'yields.shields',
        detail: 'must be an integer',
      });
      // The commerce component is fine, so it is not complained about: one error
      // per broken field, not one per row.
      expect(fieldsOf(bad.error)).not.toContain('yields.commerce');
    }
  });

  it('rejects an unknown kind', () => {
    // `ImprovementKind` makes this a compile error in content code, so the route
    // in is data — a JSON catalog or, as here, a patch. The engine's ordering is
    // defined in terms of the known kinds, so an unknown one is refused by name.
    const r = validateRuleset(
      withImprovementRow('mine', { kind: 'farm' as ImprovementKind }),
      'tuned',
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const error = r.error.find(
        (e) => e.kind === 'invalid-value' && e.catalog === 'improvements' && e.field === 'kind',
      );
      expect(error).toBeDefined();
      if (error?.kind === 'invalid-value') {
        expect(error.detail).toContain('road, mine, irrigation');
        expect(error.detail).toContain('farm');
      }
    }
  });

  it('rejects an improvement allowed on no terrain', () => {
    // An empty `allowedRoles` is not "anywhere", it is "nowhere": `StartWork`
    // checks membership, so the row would be silently unbuildable.
    const r = validateRuleset(withImprovementRow('road', { allowedRoles: [] }), 'tuned');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'improvements',
        id: asImprovementId('road'),
        field: 'allowedRoles',
        detail: 'must list at least one terrain role',
      });
    }
  });

  it('reports an empty improvements catalog the way it reports any empty catalog', () => {
    const r = validateRuleset({ ...CATALOG, improvements: [] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ kind: 'empty-catalog', catalog: 'improvements' });
      // Nothing else is wrong with this catalog, so the one complaint is the hole.
      expect(r.error).toEqual([{ kind: 'empty-catalog', catalog: 'improvements' }]);
    }
  });

  it('refuses placeholder improvements in cited-only mode', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const improvementsInCitedOnly = r.error.filter(
        (e) => e.kind === 'placeholder-in-cited-only' && e.catalog === 'improvements',
      );
      expect(improvementsInCitedOnly).toHaveLength(IMPROVEMENTS.length);
    }
  });

  it('is carried through validation, so the engine can read a row', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.improvements).toEqual([...IMPROVEMENTS]);
      // A validated ruleset carries improvements, so it satisfies the engine's
      // `RulesetView` — which is what lets `cityYields` read a delta at all.
      for (const i of r.value.improvements) {
        expect(Number.isInteger(i.turns)).toBe(true);
        expect(Number.isInteger(i.yields.food)).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * M5 — the tech tree
 * ------------------------------------------------------------------ */

describe('tech catalog', () => {
  it('ships a tree, not a token row', () => {
    // The milestone's own bar: enough techs that early choices matter, across at
    // least two eras. Asserted as a *shape* rather than a count, so a retune that
    // adds rows does not have to edit a number here — but a tree that collapsed to
    // one row would fail.
    expect(TECHS.length).toBeGreaterThanOrEqual(8);
    const eras = new Set(TECHS.map((t) => t.era));
    expect(eras.size).toBeGreaterThanOrEqual(2);
  });

  it('has unique ids, a name on every row, and a cost of at least one beaker', () => {
    const ids = TECHS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tech of TECHS) {
      expect(tech.name).not.toBe('');
      expect(Number.isInteger(tech.cost)).toBe(true);
      expect(tech.cost).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses only eras from the ordered vocabulary, and orders ERAS earliest first', () => {
    // `ERAS` is the order the era check reads, so it is pinned by value: a list
    // silently reordered would make "a tech may not sit in an earlier era than
    // something it requires" mean something else while still passing every other
    // test in this file.
    expect([...ERAS]).toEqual(['ancient', 'medieval', 'industrial', 'modern']);
    for (const tech of TECHS) {
      expect(ERAS).toContain(tech.era);
    }
  });

  it('never makes a tech earlier than something it requires', () => {
    const rank = (era: EraId): number => ERAS.findIndex((known) => known === era);
    for (const tech of TECHS) {
      for (const required of tech.requires) {
        const row = TECHS.find((t) => t.id === required);
        expect(row, `${String(tech.id)} requires an unknown tech`).toBeDefined();
        if (row === undefined) continue;
        expect(
          rank(tech.era),
          `${String(tech.id)} (${tech.era}) must not precede ${String(row.id)} (${row.era})`,
        ).toBeGreaterThanOrEqual(rank(row.era));
      }
    }
  });

  it('is honest about provenance: every row is a placeholder that says the value is ours', () => {
    for (const tech of TECHS) {
      expect(tech.provenance.kind).toBe('placeholder');
      // The detail has to carry the claim, not just the kind: an unsourced number
      // presented without saying so is the half-truth PLAN.md §6.2 exists to stop.
      if (tech.provenance.kind === 'placeholder') {
        expect(tech.provenance.note).toContain('unsourced');
        expect(tech.provenance.note).toContain('playable');
      }
    }
  });

  it('refuses placeholder tech rows in cited-only mode, naming the rows', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const techRows = r.error.filter(
        (e) => e.kind === 'placeholder-in-cited-only' && e.catalog === 'techs',
      );
      expect(techRows.length).toBe(TECHS.length);
    }
  });

  it('requires provenance by type — a spec without one does not compile', () => {
    expectTypeOf<TechSpec['provenance']>().toEqualTypeOf<Provenance>();
    expectTypeOf<TechSpec['era']>().toEqualTypeOf<EraId>();
  });

  it('reports an empty tech catalog the way it reports any empty catalog', () => {
    const r = validateRuleset({ ...CATALOG, techs: [] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ kind: 'empty-catalog', catalog: 'techs' });
    }
  });

  it('rejects a duplicate tech id', () => {
    const r = validateRuleset({ ...CATALOG, techs: [...TECHS, ...TECHS] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dupes = r.error.filter((e) => e.kind === 'duplicate-id');
      expect(dupes.length).toBeGreaterThan(0);
      for (const d of dupes) expect(d.catalog).toBe('techs');
    }
  });

  it('rejects a cost below 1, and a non-integer cost', () => {
    const free = validateRuleset(withTech('pottery', { cost: 0 }), 'tuned');
    expect(free.ok).toBe(false);
    if (!free.ok) {
      expect(free.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'techs',
        id: asTechId('pottery'),
        field: 'cost',
        detail: 'must be >= 1',
      });
    }

    const fractional = validateRuleset(withTech('pottery', { cost: 2.5 }), 'tuned');
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fieldsOf(fractional.error)).toContain('cost');
  });

  it('rejects an unknown era, naming the eras it knows', () => {
    const r = validateRuleset(withTech('pottery', { era: 'bronze-age' as EraId }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const era = r.error.find((e) => e.kind === 'invalid-value' && e.field === 'era');
      expect(era?.kind).toBe('invalid-value');
      if (era?.kind === 'invalid-value') {
        expect(era.id).toBe(asTechId('pottery'));
        expect(era.detail).toContain('ancient');
        expect(era.detail).toContain('modern');
      }
    }
  });

  it('rejects a requires that names a tech the catalog does not define', () => {
    const r = validateRuleset(withTech('alphabet', { requires: [asTechId('mithril')] }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({
        kind: 'invalid-value',
        catalog: 'techs',
        id: asTechId('alphabet'),
        field: 'requires',
        detail: 'names tech "mithril", which this catalog does not define',
      });
    }
  });

  it('rejects a tech placed in an earlier era than something it requires', () => {
    // A row the era check exists for: `steam-power` is `modern` in the shipped tree
    // and requires `engineering` and `banking` (both `industrial`), so moving *it* to
    // `ancient` makes the requirement come from the future. Everything else about
    // every row is untouched, which is what makes this a check on ordering rather
    // than on the rows.
    const r = validateRuleset(withTech('steam-power', { era: 'ancient' }), 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const era = r.error.find((e) => e.kind === 'invalid-value' && e.field === 'era');
      expect(era?.kind).toBe('invalid-value');
      if (era?.kind === 'invalid-value') {
        expect(era.catalog).toBe('techs');
        expect(era.id).toBe(asTechId('steam-power'));
        // The detail names both ends and the row responsible, so the refusal is
        // actionable without a lookup.
        expect(era.detail).toContain('ancient');
        expect(era.detail).toContain('industrial');
        expect(era.detail).toContain('engineering');
      }
    }
  });

  it('accepts a requirement in the same era — only *earlier* is wrong', () => {
    // Both rows are `ancient`, so the requirement does not come from the future and
    // the era check has nothing to say. Pinned from this side because the rule is
    // "not earlier than" — an ordering relation, not "strictly later" — and a check
    // written the other way would reject most of the shipped tree.
    const r = validateRuleset(
      withTech('the-wheel', { requires: [asTechId('warrior-code')] }),
      'tuned',
    );
    expect(r.ok).toBe(true);
  });

  it('converts validation of the shipped catalog: the tree comes back out', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Carried through *unchanged and by identity*: the research step reads this
      // list, and a validated ruleset that dropped or copied it would be a second
      // answer to "what does this tech cost?".
      expect(r.value.techs).toBe(CATALOG.techs);
      expect(r.value.techs.length).toBe(TECHS.length);
    }
  });
});

describe('the tech tree is a tree', () => {
  /** Every catalog tech id, in catalog order. */
  const ids = TECHS.map((t) => t.id);

  /** The rows a tech requires, resolved (a `requires` naming nothing is reported separately). */
  const requiresOf = (id: string): readonly string[] =>
    TECHS.find((t) => String(t.id) === id)?.requires.map(String) ?? [];

  /**
   * The techs reachable from the roots by repeatedly taking anything whose
   * prerequisites are all reached — which is the exact walk a player does.
   *
   * Returns the reached ids **in the order the walk found them**, so a caller can
   * also assert that the tree has real breadth (three roots, several branches)
   * rather than one long chain that happens to cover every row.
   */
  const reachableFromRoots = (): readonly string[] => {
    const reached = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of ids) {
        const key = String(id);
        if (reached.has(key)) continue;
        if (requiresOf(key).every((required) => reached.has(required))) {
          reached.add(key);
          grew = true;
        }
      }
    }
    return [...reached];
  };

  it('has at least two roots, so the first research decision is a real choice', () => {
    const roots = TECHS.filter((t) => t.requires.length === 0);
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });

  it('reaches every tech from the roots — no orphan on the tree', () => {
    // The reachability proof the milestone asks for. `validateRuleset` already
    // rejects a cycle and an unknown prerequisite, so what is left to prove is that
    // the *edges* connect: a row whose prerequisites can never be met (a parent with
    // a parent that does not exist, or a branch hanging off nothing) would leave
    // research permanently stuck on part of the tree without any single row looking
    // wrong.
    const reached = reachableFromRoots();
    expect([...reached].sort()).toEqual([...ids].sort());

    // And the order the walk found them in is a *topological* order: by the time a
    // row is reached, everything it requires was reached earlier, which is exactly
    // what a player's research sequence has to be. A leaf (like `electricity`, the
    // last row of the tree) is not a defect — it is the end of a branch.
    const seen = new Set<string>();
    for (const id of reached) {
      for (const required of requiresOf(id)) {
        expect(seen.has(required), `${id} was reached before its prerequisite ${required}`).toBe(
          true,
        );
      }
      seen.add(id);
    }
    // The tree has a top: at least one row that nothing requires, or the "tree" would
    // be a cycle-free set of rows with no goal in it.
    const leaves = ids.filter(
      (id) => !ids.some((other) => requiresOf(String(other)).includes(String(id))),
    );
    expect(leaves.length).toBeGreaterThanOrEqual(1);
    expect(leaves.length).toBeLessThan(ids.length);
  });

  it('is wide enough that early choices matter: several rows share a prerequisite', () => {
    // "Early choices matter" made checkable: at least one tech of the earliest era is
    // required by two or more *different* later rows, so choosing which branch to
    // open with is a decision with consequences rather than a queue.
    const early = TECHS.filter((t) => t.era === ERAS[0]);
    const fanOut = early.filter(
      (t) => ids.filter((other) => requiresOf(String(other)).includes(String(t.id))).length >= 2,
    );
    expect(fanOut.length).toBeGreaterThanOrEqual(2);
  });

  it('is a DAG: no tech requires itself, directly or through other rows', () => {
    // The property the cycle check exists for, stated independently of the
    // validator: walking prerequisites from every row terminates without revisiting
    // a row on the current path.
    const walk = (id: string, path: readonly string[]): boolean => {
      if (path.includes(id)) return false;
      return requiresOf(id).every((required) => walk(required, [...path, id]));
    };
    for (const id of ids) {
      expect(walk(String(id), []), `${String(id)} participates in a cycle`).toBe(true);
    }
  });
});

describe('the tech prerequisite cycle check', () => {
  it('accepts the shipped tree — the check is not vacuous noise', () => {
    expect(cycleOf(CATALOG)).toBeUndefined();
  });

  it('rejects a self-loop, naming the tech twice', () => {
    const cycle = cycleOf(withTech('pottery', { requires: [asTechId('pottery')] }));
    expect(cycle).toEqual(['pottery', 'pottery']);
  });

  it('rejects a two-row cycle and names the loop in order', () => {
    // The exact defect a play test cannot surface as an error: both rows look
    // ordinary, each prerequisite exists, both costs are plausible — and the game
    // simply never lets research past them.
    const cycle = cycleOf(
      withTechs([
        ['pottery', { requires: [asTechId('alphabet')] }],
        ['alphabet', { requires: [asTechId('pottery')] }],
      ]),
    );
    expect(cycle).toBeDefined();
    expect(cycle?.length).toBe(3);
    expect(cycle?.[0]).toBe(cycle?.[2]);
    expect(new Set(cycle?.slice(0, 2))).toEqual(new Set(['pottery', 'alphabet']));
  });

  it('reports the cycle as its own error kind, with the loop in the message', () => {
    const r = validateRuleset(
      withTechs([
        ['pottery', { requires: [asTechId('alphabet')] }],
        ['alphabet', { requires: [asTechId('pottery')] }],
      ]),
      'tuned',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;

    const cycle = r.error.find((e) => e.kind === 'tech-cycle');
    expect(cycle?.kind).toBe('tech-cycle');
    if (cycle?.kind !== 'tech-cycle') return;
    expect(cycle.catalog).toBe('techs');
    expect(cycle.cycle.length).toBe(3);
    // The detail names the loop, which is what makes the refusal actionable rather
    // than "somewhere in this catalog there is a cycle".
    expect(cycle.detail).toContain(' -> ');
    for (const id of cycle.cycle.slice(0, 2)) expect(cycle.detail).toContain(String(id));
  });

  it('rejects a longer cycle through several rows', () => {
    // potter -> alphabet -> mathematics -> pottery
    const cycle = cycleOf(
      withTechs([
        ['pottery', { requires: [asTechId('mathematics')] }],
        ['alphabet', { requires: [asTechId('pottery')] }],
        ['mathematics', { requires: [asTechId('alphabet')] }],
      ]),
    );
    expect(cycle).toBeDefined();
    expect(cycle?.length).toBe(4);
    expect(new Set(cycle?.slice(0, 3))).toEqual(new Set(['pottery', 'alphabet', 'mathematics']));
  });

  it('is not confused by a diamond, which is a tree with two paths to one row', () => {
    // The shape most likely to look like a cycle to a careless check: two branches
    // that rejoin. A cycle check that flagged "already visited" instead of "on the
    // current path" would reject this perfectly ordinary tree.
    expect(validateRuleset(CATALOG, 'tuned').ok).toBe(true);
    const r = validateRuleset(
      withTech('education', { requires: [asTechId('banking'), asTechId('currency')] }),
      'tuned',
    );
    expect(r.ok).toBe(true);
  });

  it('does not follow a requires that names nothing when looking for a cycle', () => {
    // An unknown prerequisite is `invalid-value`'s business, reported once against the
    // row that named it. Claiming a *cycle* as well would be two errors for one defect,
    // and the wrong one first.
    const cycle = cycleOf(withTech('alphabet', { requires: [asTechId('mithril')] }));
    expect(cycle).toBeUndefined();
  });
});

describe('terrain role coverage', () => {
  it('accepts the full catalog: every engine role is provided', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const role of TERRAIN_ROLES) {
        expect(r.value.terrains.some((t) => t.role === role)).toBe(true);
      }
    }
  });

  it('reports a missing-role for a role no terrain provides', () => {
    const withoutOcean = {
      ...CATALOG,
      terrains: CATALOG.terrains.filter((t) => t.role !== 'ocean'),
      units: LAND_UNITS,
    };
    const r = validateRuleset(withoutOcean, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ kind: 'missing-role', role: 'ocean' });
      // Nothing else is wrong with this catalog, so the role is the only complaint.
      expect(r.error.every((e) => e.kind === 'missing-role')).toBe(true);
    }
  });

  it('reports every missing role, in canonical TERRAIN_ROLES order', () => {
    // Land units only: with a sea unit in the catalog the missing water would
    // also (correctly) be reported against that unit, which is a different
    // property — covered in "rejects a sea unit in a catalog with no water
    // terrain" below.
    const landOnly = {
      ...CATALOG,
      terrains: CATALOG.terrains.filter((t) => t.role !== 'ocean' && t.role !== 'coast'),
      units: LAND_UNITS,
    };
    const r = validateRuleset(landOnly, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual([
        { kind: 'missing-role', role: 'ocean' },
        { kind: 'missing-role', role: 'coast' },
      ]);
    }
  });

  it('covers a role even when the terrain id is not the role name', () => {
    // The old workaround read the role off the id, which only worked because the
    // placeholder ids happen to be the role names. Coverage is by `role`, so an
    // id that names something else is still a valid provider.
    const savanna = asTerrainId('savanna');
    const renamed = CATALOG.terrains.map((t) =>
      t.role === 'grassland' ? { ...t, id: savanna } : t,
    );

    const r = validateRuleset({ ...CATALOG, terrains: renamed }, 'tuned');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.terrains.some((t) => t.id === savanna && t.role === 'grassland')).toBe(true);
      for (const role of TERRAIN_ROLES) {
        expect(r.value.terrains.some((t) => t.role === role)).toBe(true);
      }
    }
  });
});

describe('provenance summary', () => {
  it('counts every row exactly once, terrain, unit, building, improvement, resource, tech, combat and capture alike', () => {
    const s = summarizeProvenance(CATALOG);
    expect(s.total).toBe(
      CATALOG.terrains.length +
        UNITS.length +
        BUILDINGS.length +
        IMPROVEMENTS.length +
        RESOURCES.length +
        TECHS.length +
        COMBAT_ROWS +
        CAPTURE_ROWS,
    );
    expect(s.cited + s.placeholder).toBe(s.total);
    // The improvement rows are counted, not merely present: the report's sections
    // and its total come from one function precisely because they once disagreed
    // (M2 F4), so a catalog added to `Catalog` without a section would show up
    // here as a total that is too small.
    expect(s.total).toBeGreaterThan(CATALOG.terrains.length + UNITS.length + BUILDINGS.length);
  });

  it('is honest about the current state: nothing is cited yet', () => {
    const s = summarizeProvenance(CATALOG);
    expect(s.cited).toBe(0);
    expect(s.placeholder).toBe(
      CATALOG.terrains.length +
        UNITS.length +
        BUILDINGS.length +
        IMPROVEMENTS.length +
        RESOURCES.length +
        TECHS.length +
        COMBAT_ROWS +
        CAPTURE_ROWS,
    );
  });

  /**
   * The report `rules:provenance` prints is built from `provenanceSections`, and
   * the total it prints is built from `summarizeProvenance` — which is the sum of
   * those sections, nothing else. These tests pin that they cover the same rows:
   * the table used to list only terrain rows under a total that already counted
   * the unit rows, so the report contradicted itself (PLAN.md §6.2).
   */
  describe('sections', () => {
    /** Look a section up by name; a missing section fails the assertions below. */
    const sectionOf = (catalog: Catalog, name: string): ProvenanceSection | undefined =>
      provenanceSections(catalog).find((s) => s.name === name);

    it('covers every row of every catalog exactly once', () => {
      const ids = provenanceSections(CATALOG).flatMap((s) => s.rows.map((r) => r.id));
      expect(ids).toEqual([
        ...CATALOG.terrains.map((t) => t.id),
        ...UNITS.map((u) => u.id),
        ...BUILDINGS.map((b) => b.id),
        ...IMPROVEMENTS.map((i) => i.id),
        ...RESOURCES.map((r) => r.id),
        ...TECHS.map((t) => t.id),
        // M6b's section is one row, filed under the section's own name (it has no id of
        // its own — see `CombatSpec`). It is listed *last* because that is where the
        // catalog declares it, and a report whose order disagreed with the catalog's
        // would be a report a reader has to reconcile.
        'combat',
        // M7's capture rule: one row, filed under the section's own name, listed last for
        // the same reason — the order is the catalog's.
        'capture',
      ]);
    });

    it('adds up to the summary, so the printed table cannot disagree with the total', () => {
      const sections = provenanceSections(CATALOG);
      const summary = summarizeProvenance(CATALOG);

      const total = sections.reduce((n, s) => n + s.summary.total, 0);
      const placeholder = sections.reduce((n, s) => n + s.summary.placeholder, 0);

      expect(sections.map((s) => s.name)).toEqual([
        'terrains',
        'units',
        'buildings',
        'improvements',
        'resources',
        'techs',
        'combat',
        'capture',
      ]);
      expect(total).toBe(summary.total);
      expect(placeholder).toBe(summary.placeholder);
      expect(summary.cited).toBe(summary.total - summary.placeholder);
    });

    it('counts each section against its own rows', () => {
      for (const s of provenanceSections(CATALOG)) {
        expect(s.summary.total).toBe(s.rows.length);
        expect(s.summary.placeholder).toBe(
          s.rows.filter((r) => isPlaceholder(r.provenance)).length,
        );
        expect(s.summary.cited + s.summary.placeholder).toBe(s.summary.total);
      }
      expect(sectionOf(CATALOG, 'terrains')?.summary.total).toBe(CATALOG.terrains.length);
      expect(sectionOf(CATALOG, 'units')?.summary.total).toBe(UNITS.length);
      expect(sectionOf(CATALOG, 'buildings')?.summary.total).toBe(BUILDINGS.length);
      expect(sectionOf(CATALOG, 'improvements')?.summary.total).toBe(IMPROVEMENTS.length);
      // M4c's rows are counted by the same function and listed by the same
      // renderer: the resource catalog is the fifth section, and a row of it that
      // the report forgot would show up here as a total that is too small.
      expect(sectionOf(CATALOG, 'resources')?.summary.total).toBe(RESOURCES.length);
      expect(sectionOf(CATALOG, 'resources')?.summary.placeholder).toBe(RESOURCES.length);
      // M5's rows, same function, same renderer: the tech catalog is the sixth
      // section. This is the assertion that would have caught the M2 F4 defect for
      // the tree — a `Catalog` section added without a matching section here shows
      // up as a summary that counts rows the table never lists.
      expect(sectionOf(CATALOG, 'techs')?.summary.total).toBe(TECHS.length);
      expect(sectionOf(CATALOG, 'techs')?.summary.placeholder).toBe(TECHS.length);
      // M6b's combat globals: one row, one placeholder claim, counting the section the
      // engine's battles are fought under. The section is the reason this file's aliases
      // exist at all — a `Catalog` field that the report did not count would be a set of
      // magnitudes content could add without ever being audited, which is exactly how the
      // nine numbers spent M6 buried in `combat.ts` as module constants.
      expect(sectionOf(CATALOG, 'combat')?.summary.total).toBe(COMBAT_ROWS);
      expect(sectionOf(CATALOG, 'combat')?.summary.placeholder).toBe(COMBAT_ROWS);
      expect(sectionOf(CATALOG, 'combat')?.rows.map((r) => r.id)).toEqual(['combat']);
      // M7's capture rule: one row, one placeholder claim. This is the assertion that makes
      // the relocation auditable — the divisor left `core/cities.ts` and arrived in a
      // section the report counts, so it is visible to a reader and to a sweep.
      expect(sectionOf(CATALOG, 'capture')?.summary.total).toBe(CAPTURE_ROWS);
      expect(sectionOf(CATALOG, 'capture')?.summary.placeholder).toBe(CAPTURE_ROWS);
      expect(sectionOf(CATALOG, 'capture')?.rows.map((r) => r.id)).toEqual(['capture']);
    });

    it('counts a cited unit row as cited, not as a missing row', () => {
      // One cited unit row: the ratio moves by exactly one, and the section that
      // holds it reports it — provenance is a property of the row, not of which
      // catalog the row lives in.
      const cited: Catalog = {
        ...CATALOG,
        units: UNITS.map((u) => (u.id === 'scout' ? { ...u, provenance: CITED_EXAMPLE } : u)),
      };

      const summary = summarizeProvenance(cited);
      expect(summary.total).toBe(
        CATALOG.terrains.length +
          UNITS.length +
          BUILDINGS.length +
          IMPROVEMENTS.length +
          RESOURCES.length +
          TECHS.length +
          COMBAT_ROWS +
          CAPTURE_ROWS,
      );
      expect(summary.cited).toBe(1);
      expect(summary.placeholder).toBe(summary.total - 1);

      // The terrain and building sections are untouched; the unit section carries
      // the one cited row.
      expect(sectionOf(cited, 'terrains')?.summary.cited).toBe(0);
      expect(sectionOf(cited, 'units')?.summary.cited).toBe(1);
      expect(sectionOf(cited, 'units')?.summary.placeholder).toBe(UNITS.length - 1);
      expect(sectionOf(cited, 'buildings')?.summary.cited).toBe(0);
      expect(sectionOf(cited, 'improvements')?.summary.cited).toBe(0);
      expect(sectionOf(cited, 'resources')?.summary.cited).toBe(0);
      expect(sectionOf(cited, 'techs')?.summary.cited).toBe(0);
      expect(sectionOf(cited, 'combat')?.summary.cited).toBe(0);
      expect(sectionOf(cited, 'capture')?.summary.cited).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ *
 * M6b — the combat globals, in the catalog where a sweep can move them
 * ------------------------------------------------------------------ */

describe('the combat globals (M6b)', () => {
  /** `CATALOG` with one or more combat magnitudes replaced. */
  const withCombat = (patch: Partial<CombatSpec>): Catalog => ({
    ...CATALOG,
    combat: { ...CATALOG.combat, ...patch },
  });

  /** The `combat` fields validation complained about, ascending as reported. */
  const combatProblems = (patch: Partial<CombatSpec>): readonly string[] => {
    const r = validateRuleset(withCombat(patch), 'tuned');
    return r.ok
      ? []
      : r.error.flatMap((e) =>
          e.kind === 'invalid-value' && e.catalog === 'combat' ? [e.field] : [],
        );
  };

  it('ships the nine M6 magnitudes unchanged — a relocation, not a rebalance', () => {
    // **These are M6's numbers**, written here so that the move from module constants to
    // the catalog is visible as a move and not as a retune: if the section ever changes a
    // value, this test changes on purpose or it fails. (The engine's *behaviour* is what
    // the golden hashes pin; this pins the table itself.)
    expect(COMBAT.fortifyBonusPct).toBe(25);
    expect(COMBAT.cityDefenseBonusPct).toBe(50);
    expect(COMBAT.wallsBonusPct).toBe(50);
    expect(COMBAT.veteranAttackPct).toBe(25);
    expect(COMBAT.maxExperience).toBe(3);
    expect(COMBAT.rollBound).toBe(100);
    expect(COMBAT.damagePerRound).toBe(1);
    expect(COMBAT.minWinPct).toBe(1);
    expect(COMBAT.maxWinPct).toBe(99);
  });

  it('is placeholder, unsourced, and says so in its own provenance note', () => {
    // The M6b provenance rule: the new rows are still `placeholder`, chosen to be
    // playable, and the note has to say that the numbers came from `core/combat.ts` and
    // that no Civ 3 model is reproduced — a reader must not be able to mistake a
    // relocation for a citation.
    expect(isPlaceholder(COMBAT.provenance)).toBe(true);
    expect(COMBAT.provenance.note).toContain('unsourced');
    expect(COMBAT.provenance.note).toContain('relocation');
    expect(COMBAT.provenance.note).toContain('Civ 3');
  });

  it('reaches the validated ruleset unchanged, so the engine reads content and not a copy', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The *same object*: the resolver is handed one section, and nothing between content
    // and the engine re-creates it.
    expect(r.value.combat).toBe(CATALOG.combat);
  });

  it('refuses a non-integer magnitude, naming the field', () => {
    expect(combatProblems({ fortifyBonusPct: 12.5 })).toEqual(['fortifyBonusPct']);
    expect(combatProblems({ cityDefenseBonusPct: 0.5 })).toEqual(['cityDefenseBonusPct']);
    expect(combatProblems({ wallsBonusPct: 1.0000001 })).toEqual(['wallsBonusPct']);
    expect(combatProblems({ veteranAttackPct: 2.5 })).toEqual(['veteranAttackPct']);
    expect(combatProblems({ maxExperience: 1.5 })).toEqual(['maxExperience']);
    expect(combatProblems({ rollBound: 99.5 })).toEqual(['rollBound']);
    expect(combatProblems({ damagePerRound: 1.5 })).toEqual(['damagePerRound']);
    expect(combatProblems({ minWinPct: 0.5 })).toEqual(['minWinPct']);
    expect(combatProblems({ maxWinPct: 98.5 })).toEqual(['maxWinPct']);
    // A whole section of fractions is nine complaints, not one: each field is checked on
    // its own terms so a caller fixes all of them in one pass.
    expect(
      combatProblems({
        fortifyBonusPct: 0.5,
        cityDefenseBonusPct: 0.5,
        wallsBonusPct: 0.5,
        veteranAttackPct: 0.5,
        maxExperience: 0.5,
        rollBound: 0.5,
        damagePerRound: 0.5,
        minWinPct: 0.5,
        maxWinPct: 0.5,
      }),
    ).toHaveLength(9);
  });

  it('refuses a draw with no outcomes, an impossible promotion cap and a harmless round', () => {
    // `rollBound` is the denominator of every odds figure and the bound of the draw:
    // `nextBelow(rng, rollBound)` takes a positive bound, so 0 is not a small number here
    // but a throw inside the resolver.
    // Two complaints, not one, and that is the honest answer: a draw with no outcomes also
    // breaks the clamp, so a caller hears about both rather than about the first one a loop
    // happened to reach.
    expect(combatProblems({ rollBound: 0 })).toEqual(['rollBound', 'minWinPct']);
    expect(combatProblems({ rollBound: -100 })).toContain('rollBound');
    // 0 is a *legal* `maxExperience` — "this ruleset has no promotions" — so the bound is
    // `>= 0` and only a negative value is refused.
    expect(combatProblems({ maxExperience: 0 })).toEqual([]);
    expect(combatProblems({ maxExperience: -1 })).toEqual(['maxExperience']);
    // A round that costs no hit point cannot end a battle: this is the one bound whose
    // absence would be an infinite loop rather than a wrong number.
    expect(combatProblems({ damagePerRound: 0 })).toEqual(['damagePerRound']);
    expect(combatProblems({ damagePerRound: -1 })).toContain('damagePerRound');
  });

  it('refuses a negative percentage, because a bonus that subtracts is a different rule', () => {
    expect(combatProblems({ fortifyBonusPct: -1 })).toEqual(['fortifyBonusPct']);
    expect(combatProblems({ cityDefenseBonusPct: -50 })).toEqual(['cityDefenseBonusPct']);
    expect(combatProblems({ wallsBonusPct: -1 })).toEqual(['wallsBonusPct']);
    expect(combatProblems({ veteranAttackPct: -25 })).toEqual(['veteranAttackPct']);
    // Zero is allowed everywhere a percentage is: "this ruleset gives no bonus for that"
    // is a statement a balance sweep has to be able to make.
    expect(combatProblems({ fortifyBonusPct: 0, wallsBonusPct: 0, veteranAttackPct: 0 })).toEqual(
      [],
    );
  });

  it('checks the odds clamp as ONE chain rather than three independent bounds', () => {
    // The three fields are one rule — the clamp must be a range the draw can express —
    // and the discriminating cases are the ones a per-field check would wave through:
    // a floor of 0 (a battle that can be lost before it is fought), a floor above the
    // ceiling, and a ceiling above the draw's range.
    expect(combatProblems({ minWinPct: 0 })).toEqual(['minWinPct']);
    expect(combatProblems({ minWinPct: 60, maxWinPct: 50 })).toEqual(['minWinPct']);
    expect(combatProblems({ maxWinPct: 101 })).toEqual(['minWinPct']);
    expect(combatProblems({ rollBound: 50 })).toEqual(['minWinPct']);
    // And the boundary that IS legal: a clamp that exactly fills the draw.
    expect(combatProblems({ minWinPct: 1, maxWinPct: 100, rollBound: 100 })).toEqual([]);
  });

  it('refuses the section in cited-only mode, like every other placeholder row', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(
      r.error.some(
        (e) =>
          e.kind === 'placeholder-in-cited-only' && e.catalog === 'combat' && e.id === 'combat',
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * M7 — the capture rule, in the catalog where a sweep can move it
 * ------------------------------------------------------------------ */

describe('the capture rule (M7)', () => {
  /** `CATALOG` with the capture section replaced by a patch of it. */
  const withCapture = (patch: Partial<CaptureSpec>): Catalog => ({
    ...CATALOG,
    capture: { ...CATALOG.capture, ...patch },
  });

  /** The `capture` fields validation complained about, ascending as reported. */
  const captureProblems = (patch: Partial<CaptureSpec>): readonly string[] => {
    const r = validateRuleset(withCapture(patch), 'tuned');
    return r.ok
      ? []
      : r.error.flatMap((e) =>
          e.kind === 'invalid-value' && e.catalog === 'capture' ? [e.field] : [],
        );
  };

  it("ships M6's divisor unchanged — a relocation, not a rebalance", () => {
    // **This is M6's number.** `CAPTURE_POPULATION_DIVISOR = 2` lived in
    // `packages/core/src/cities.ts` until M7 moved it here, and the whole claim of that
    // move is that the *value* did not move with it: if this assertion changes, the move
    // became a retune and the five golden state hashes would have to move with it.
    expect(CAPTURE.populationDivisor).toBe(2);
  });

  it('is placeholder, unsourced, and says so in its own provenance note', () => {
    // The provenance rule M6b established for the combat globals, applied to the last
    // magnitude M6 left in logic: a reader must not be able to mistake a relocation for a
    // citation, and the note has to name both the old home and the absence of a source.
    expect(isPlaceholder(CAPTURE.provenance)).toBe(true);
    expect(CAPTURE.provenance.note).toContain('unsourced');
    expect(CAPTURE.provenance.note).toContain('relocation');
    expect(CAPTURE.provenance.note).toContain('Civ 3');
  });

  it('reaches the validated ruleset unchanged, so the engine reads content and not a copy', () => {
    const r = validateRuleset(CATALOG, 'tuned');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The *same object*: `cities.ts`' `captureRulesOf` reads the section off the ruleset a
    // capture is played under, and nothing between content and the engine re-creates it.
    expect(r.value.capture).toBe(CATALOG.capture);
  });

  it('counts as one provenance row, so the report cannot forget the number it moved', () => {
    // The section is listed in `provenanceSections` — the *one* place that decides which
    // rows count — which is what makes the relocation auditable rather than a number moved
    // somewhere the report does not look.
    const section = provenanceSections(CATALOG).find((each) => each.name === 'capture');
    expect(section?.rows.map((row) => row.id)).toEqual(['capture']);
    expect(section?.summary).toEqual({ total: 1, cited: 0, placeholder: 1 });
    expect(summarizeProvenance(CATALOG).total).toBe(
      provenanceSections(CATALOG).reduce((count, each) => count + each.summary.total, 0),
    );
  });

  it('refuses a non-integer divisor, naming the field', () => {
    expect(captureProblems({ populationDivisor: 2.5 })).toEqual(['populationDivisor']);
    expect(captureProblems({ populationDivisor: 1.0000001 })).toEqual(['populationDivisor']);
  });

  it('refuses a divisor below 1, because 0 is a division by zero', () => {
    // `Math.floor(4 / 0)` is `Infinity`, which is neither a population nor a value
    // `canonicalize` will hash; a negative divisor would *grow* the conquered city, which
    // is not what the field means.
    expect(captureProblems({ populationDivisor: 0 })).toEqual(['populationDivisor']);
    expect(captureProblems({ populationDivisor: -2 })).toEqual(['populationDivisor']);
    // The boundary that IS legal, and the reading it has: "a sack costs the city no
    // citizens" is a lenient tuning position a sweep must be able to reach.
    expect(captureProblems({ populationDivisor: 1 })).toEqual([]);
  });

  it('reports a missing section and a section of the wrong shape rather than crashing', () => {
    // The validator reads the section as `unknown` for this reason: a catalog that says
    // nothing about capture is not a catalog with a default capture — it is one a sack
    // cannot be applied under, and the engine's reader would fall back to `NO_CAPTURE_RULES`.
    //
    // Both inputs below are written the way the validator really receives a bad catalog —
    // as *plain data*, out of a hand-written fixture, a JSON file or a model's answer — and
    // the one cast is how this test writes JSON rather than a claim about the type: nothing
    // here can be a `Catalog` literal, because a `Catalog` literal with no `capture` or a
    // string `capture` does not compile, which is the field's whole point.
    const asJson = (record: Record<string, unknown>): Catalog =>
      JSON.parse(JSON.stringify(record)) as Catalog;

    const absent: Record<string, unknown> = { ...CATALOG };
    delete absent['capture'];
    expect('capture' in absent).toBe(false);

    for (const input of [absent, { ...CATALOG, capture: 'capture' }]) {
      const r = validateRuleset(asJson(input), 'tuned');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.some((e) => e.kind === 'invalid-value' && e.catalog === 'capture')).toBe(
          true,
        );
      }
    }
  });

  it('refuses the section in cited-only mode, like every other placeholder row', () => {
    const r = validateRuleset(CATALOG, 'cited-only');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(
      r.error.some(
        (e) =>
          e.kind === 'placeholder-in-cited-only' && e.catalog === 'capture' && e.id === 'capture',
      ),
    ).toBe(true);
  });
});
