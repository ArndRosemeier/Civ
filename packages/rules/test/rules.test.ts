import { describe, expect, it } from 'vitest';
import { TERRAIN_ROLES, asTerrainId } from '@civts/core';
import { CATALOG, summarizeProvenance, validateRuleset } from '../src/index.js';

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
    }
  });

  it('reports a duplicate id', () => {
    const dup = { ...CATALOG, terrains: [...CATALOG.terrains, ...CATALOG.terrains] };
    const r = validateRuleset(dup, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.kind === 'duplicate-id')).toBe(true);
  });

  it('reports an empty catalog', () => {
    const r = validateRuleset({ terrains: [] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]?.kind).toBe('empty-catalog');
  });

  it('rejects a non-integer or negative yield', () => {
    const first = CATALOG.terrains[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const broken = {
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

    const r = validateRuleset({ terrains: [{ ...first, moveCost: 0, impassable: false }] }, 'tuned');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((e) => e.kind === 'invalid-value' && e.field === 'moveCost')).toBe(true);
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
      terrains: CATALOG.terrains.filter((t) => t.role !== 'ocean'),
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
    const landOnly = {
      terrains: CATALOG.terrains.filter((t) => t.role !== 'ocean' && t.role !== 'coast'),
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
    const renamed = CATALOG.terrains.map((t) => (t.role === 'grassland' ? { ...t, id: savanna } : t));

    const r = validateRuleset({ terrains: renamed }, 'tuned');
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
  it('counts every row exactly once', () => {
    const s = summarizeProvenance(CATALOG);
    expect(s.total).toBe(CATALOG.terrains.length);
    expect(s.cited + s.placeholder).toBe(s.total);
  });

  it('is honest about the current state: nothing is cited yet', () => {
    const s = summarizeProvenance(CATALOG);
    expect(s.cited).toBe(0);
    expect(s.placeholder).toBeGreaterThan(0);
  });
});
