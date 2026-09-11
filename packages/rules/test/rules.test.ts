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
  isPlaceholder,
  type BuildingEffect,
  type BuildingEffectKind,
  type ImprovementKind,
  type Provenance,
  type ResourceKind,
  type ResourceId,
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
  type Catalog,
  type EraId,
  type ImprovementSpec,
  type ProvenanceSection,
  type ResourceSpec,
  type TechSpec,
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
    // Every section spelled out, `techs` included: a `Catalog` that *omits* a
    // section would not compile, which is the point of the field being required —
    // "ships none" is written as `[]`, and validation rejects it like any other
    // empty catalog.
    const r = validateRuleset(
      { terrains: [], units: [], buildings: [], improvements: [], resources: [], techs: [] },
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

  /* ---------------- M4c: the resource gate ---------------- */

  it('gates exactly one shipped unit, on a shipped strategic resource, and names both', () => {
    // M4c's resource gating has to be reachable from *shipped* content, not only
    // from a hand-built ruleset view — the same lesson M4b's accepted debt taught
    // about maintenance. Asserted by value, so it cannot silently regress to "no
    // shipped unit requires anything" while the engine still claims to gate.
    const gated = UNITS.filter((u) => u.requiresResource !== undefined);
    expect(gated.map((u) => u.id)).toEqual([asUnitTypeId('swordsman')]);
    expect(gated[0]?.requiresResource).toBe(asResourceId('iron'));

    const iron = RESOURCES.find((r) => r.id === asResourceId('iron'));
    expect(iron?.kind).toBe('strategic');
  });

  it('keeps the gated unit last, so "the first military land unit" is still the warrior', () => {
    // `hut.ts` gives away and spawns the first `military`-role land row in catalog
    // order. A gated row inserted above the warrior would make huts hand out a
    // unit a city may not even be able to build — a behavioural change smuggled in
    // by content order. Pinned here because nothing else would notice.
    const firstMilitaryLand = UNITS.find((u) => u.role === 'military' && u.domain === 'land');
    expect(firstMilitaryLand?.id).toBe(asUnitTypeId('warrior'));
    expect(UNITS[UNITS.length - 1]?.id).toBe(asUnitTypeId('swordsman'));
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
  it('counts every row exactly once, terrain, unit, building, improvement, resource and tech alike', () => {
    const s = summarizeProvenance(CATALOG);
    expect(s.total).toBe(
      CATALOG.terrains.length +
        UNITS.length +
        BUILDINGS.length +
        IMPROVEMENTS.length +
        RESOURCES.length +
        TECHS.length,
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
        TECHS.length,
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
          TECHS.length,
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
    });
  });
});
