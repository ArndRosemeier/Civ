import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BUILDING_EFFECT_KINDS,
  RESOURCE_KINDS,
  TERRAIN_ROLES,
  UNIT_ROLES,
  asBuildingId,
  asImprovementId,
  asResourceId,
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
  IMPROVEMENT_KINDS,
  provenanceSections,
  summarizeProvenance,
  validateRuleset,
  type BuildingSpec,
  type Catalog,
  type ImprovementSpec,
  type ProvenanceSection,
  type ResourceSpec,
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
    const r = validateRuleset(
      { terrains: [], units: [], buildings: [], improvements: [], resources: [] },
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
  it('counts every row exactly once, terrain, unit, building, improvement and resource alike', () => {
    const s = summarizeProvenance(CATALOG);
    expect(s.total).toBe(
      CATALOG.terrains.length +
        UNITS.length +
        BUILDINGS.length +
        IMPROVEMENTS.length +
        RESOURCES.length,
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
        RESOURCES.length,
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
          RESOURCES.length,
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
    });
  });
});
