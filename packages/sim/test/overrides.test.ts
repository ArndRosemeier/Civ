/**
 * Evidence for `applyOverrides` — the balance knob.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" ("Balance
 * knobs"): a sweep must be able to vary one catalog number without editing content,
 * and an override that would produce an invalid ruleset must fail **the same way a
 * hand-edited catalog would**.
 *
 * The tests are written so that each claim is falsifiable rather than decorative:
 *
 * 1. an override changes exactly the field it names, and nothing else in the catalog
 *    — proved by comparing against a *hand-built* control catalog through
 *    `canonicalize`, not by eye;
 * 2. it neither mutates nor tolerates a frozen catalog, and its result hashes (so
 *    there is no key holding `undefined` hiding in it);
 * 3. it preserves what it must not touch — provenance and ids;
 * 4. a bad patch is reported with the section, the id and the alternatives, in both
 *    channels (`tryApplyOverrides`' typed error and `applyOverrides`' message);
 * 5. the record of what was applied is derived from the patch, ordered
 *    deterministically, and independent of the order the patch's keys were written
 *    in;
 * 6. an override that makes the catalog invalid produces the *identical* validation
 *    errors as hand-editing the row — the claim that matters for a sweep, since the
 *    whole point of overriding is to reach values validation would refuse.
 */

import { canonicalize, hashValue } from '@civts/testing';
import { CATALOG, validateRuleset, type Catalog } from '@civts/rules';
import { describe, expect, it } from 'vitest';

import {
  applyOverrides,
  formatOverrideError,
  tryApplyOverrides,
  type OverrideError,
} from '@civts/sim';
import type { RulesetPatch, UnitPatch } from '@civts/sim';

/* ------------------------------------------------------------------ *
 * Fixtures and small helpers
 * ------------------------------------------------------------------ */

const mustFind = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the shipped catalog has no ${what}`);
  return value;
};

/** The first unit row of the shipped catalog, and its id — the sweep's subject. */
const UNIT = mustFind(CATALOG.units[0], 'unit row');
const UNIT_ID = String(UNIT.id);
const TERRAIN = mustFind(CATALOG.terrains[0], 'terrain row');
const TERRAIN_ID = String(TERRAIN.id);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Freeze a catalog graph so any mutation throws (ESM is strict mode). */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/**
 * A patch as a hand-written *JSON* sweep file can spell it: a key the typed shape
 * cannot name (`costs` for `cost`), or a value outside the type (`null`). This is the
 * input `tryApplyOverrides` exists to catch, so the test has to be able to write it —
 * the cast is how the test writes JSON, not a claim about the type.
 */
const jsonPatch = (text: string): RulesetPatch => JSON.parse(text) as RulesetPatch;

const errorOf = (patch: RulesetPatch): OverrideError => {
  const outcome = tryApplyOverrides(CATALOG, patch);
  if (outcome.ok) throw new Error('the patch was accepted but should not have been');
  return outcome.error;
};

/* ------------------------------------------------------------------ *
 * 1. One number, one row
 * ------------------------------------------------------------------ */

describe('a patch changes exactly what it names', () => {
  it('changes one unit cost and nothing else in the whole catalog', () => {
    const raised = applyOverrides(CATALOG, {
      units: { [UNIT_ID]: { cost: UNIT.cost + 5 } },
    });

    // The control is the same edit made by hand, so "nothing else changed" is a
    // comparison against content rather than a list of fields somebody remembered.
    const control: Catalog = {
      ...CATALOG,
      units: CATALOG.units.map((row) =>
        row.id === UNIT.id ? { ...row, cost: row.cost + 5 } : row,
      ),
    };

    expect(canonicalize(raised)).toBe(canonicalize(control));
    expect(canonicalize(raised)).not.toBe(canonicalize(CATALOG));

    const changed = mustFind(
      raised.units.find((row) => row.id === UNIT.id),
      'the overridden unit after the patch',
    );
    expect(changed.cost).toBe(UNIT.cost + 5);
    // Everything else on the row is the row's own value...
    expect({ ...changed, cost: UNIT.cost }).toEqual(UNIT);
    // ...and every other row is the *same object*, so "unchanged" is identity, not
    // deep equality that a nested edit could sneak past.
    for (const row of CATALOG.units) {
      if (row.id === UNIT.id) continue;
      expect(raised.units.find((candidate) => candidate.id === row.id)).toBe(row);
    }
    expect(raised.terrains).toEqual(CATALOG.terrains);
    expect(raised.buildings).toEqual(CATALOG.buildings);
  });

  it('merges a yields partial channel by channel', () => {
    const patched = applyOverrides(CATALOG, {
      terrains: { [TERRAIN_ID]: { yields: { food: TERRAIN.yields.food + 1 } } },
    });
    const row = mustFind(
      patched.terrains.find((candidate) => candidate.id === TERRAIN.id),
      'the overridden terrain',
    );

    expect(row.yields.food).toBe(TERRAIN.yields.food + 1);
    expect(row.yields.shields).toBe(TERRAIN.yields.shields);
    expect(row.yields.commerce).toBe(TERRAIN.yields.commerce);
  });

  it('keeps the row id and its provenance, which are not balance knobs', () => {
    const patched = applyOverrides(CATALOG, { units: { [UNIT_ID]: { cost: 1 } } });
    const row = mustFind(
      patched.units.find((candidate) => candidate.id === UNIT.id),
      'the overridden unit',
    );

    expect(row.id).toBe(UNIT.id);
    // Identity, not deep equality: the row keeps the very provenance object it was
    // written with, so a patch cannot rewrite authorship.
    expect(row.provenance).toBe(UNIT.provenance);
  });

  it('leaves the input untouched, even when it is frozen', () => {
    const before = canonicalize(CATALOG);
    const frozen = structuredClone(CATALOG);
    deepFreeze(frozen);

    // A mutation of the input would throw on the frozen copy (ESM is strict mode).
    const patched = applyOverrides(frozen, { units: { [UNIT_ID]: { cost: UNIT.cost + 1 } } });

    expect(canonicalize(CATALOG)).toBe(before);
    expect(canonicalize(frozen)).toBe(before);
    expect(canonicalize(patched)).not.toBe(before);
  });

  it('produces a catalog that hashes, so no key holds undefined', () => {
    // `canonicalize` refuses a key whose value is `undefined`, and `hashValue` runs
    // it — so hashing the result is the check that the merge never wrote one. A
    // patch that *adds* an optional key (`wonder`) is the interesting case, and so is
    // a JSON patch that spells an absent optional field as `null`: the merge falls
    // back to the row's own value rather than writing the null through.
    const wonderless = mustFind(
      CATALOG.buildings.find((row) => row.wonder === undefined),
      'non-wonder building',
    );
    const patched = applyOverrides(CATALOG, {
      buildings: { [String(wonderless.id)]: { wonder: true, maintenance: 0 } },
    });
    const row = mustFind(
      patched.buildings.find((candidate) => candidate.id === wonderless.id),
      'the overridden building',
    );
    expect(row.wonder).toBe(true);

    const nulled = applyOverrides(
      CATALOG,
      jsonPatch(`{ "units": { "${UNIT_ID}": { "requiresResource": null } } }`),
    );
    const nulledRow = mustFind(
      nulled.units.find((candidate) => candidate.id === UNIT.id),
      'the unit with a nulled optional field',
    );

    expect(Object.keys(nulledRow)).not.toContain('requiresResource');
    expect(nulledRow).toEqual(UNIT);
    expect(() => hashValue(patched)).not.toThrow();
    expect(hashValue(patched)).toMatch(/^[0-9a-f]{16}$/);
    expect(() => hashValue(nulled)).not.toThrow();
    expect(hashValue(applyOverrides(CATALOG, {}))).toBe(hashValue(CATALOG));
  });
});

/* ------------------------------------------------------------------ *
 * 2. A bad patch is reported, not swallowed
 * ------------------------------------------------------------------ */

describe('a patch that does not fit the catalog is reported clearly', () => {
  it('names an unknown unit id, with the ids that do exist', () => {
    const typo = `${UNIT_ID}nope`;
    const error = errorOf({ units: { [typo]: { cost: 1 } } });

    expect(error.kind).toBe('unknown-id');
    if (error.kind !== 'unknown-id') return;
    expect(error.section).toBe('units');
    expect(error.id).toBe(typo);
    expect(error.known).toContain(UNIT_ID);
    expect(error.known).toEqual([...error.known].sort());

    const message = formatOverrideError(error);
    expect(message).toContain('units');
    expect(message).toContain(typo);
    expect(message).toContain(UNIT_ID);
  });

  it('throws from applyOverrides with the same facts, rather than returning the base catalog', () => {
    // The failure mode this pins: an ignored patch would make a sweep report the
    // *unpatched* ruleset's numbers as if they were the override's.
    expect(() => applyOverrides(CATALOG, { units: { ghost: { cost: 1 } } })).toThrow(/ghost/);
    expect(() => applyOverrides(CATALOG, { units: { ghost: { cost: 1 } } })).toThrow(/units/);
    expect(() => applyOverrides(CATALOG, { resources: { oil: { kind: 'strategic' } } })).toThrow(
      /resources\.oil/,
    );
  });

  it('rejects a field the row does not have, so a JSON typo cannot silently do nothing', () => {
    const error = errorOf(jsonPatch(`{ "units": { "${UNIT_ID}": { "costs": 12 } } }`));

    expect(error.kind).toBe('unknown-field');
    if (error.kind !== 'unknown-field') return;
    expect(error.field).toBe('costs');
    expect(error.known).toContain('cost');

    const nested = errorOf(jsonPatch(`{ "units": { "${UNIT_ID}": { "requiresResources": {} } } }`));
    expect(nested.kind).toBe('unknown-field');
  });

  it('rejects a mangled nested yields partial', () => {
    const error = errorOf(
      jsonPatch(`{ "terrains": { "${TERRAIN_ID}": { "yields": { "foods": 2 } } } }`),
    );

    expect(error.kind).toBe('unknown-field');
    if (error.kind !== 'unknown-field') return;
    expect(error.field).toBe('yields.foods');
    expect(error.known).toContain('yields.food');
  });

  it('reports the first bad id deterministically, whatever order the patch was written in', () => {
    const forward = errorOf({ units: { aaa: { cost: 1 }, bbb: { cost: 1 } } });
    const backward = errorOf({ units: { bbb: { cost: 1 }, aaa: { cost: 1 } } });

    expect(forward).toEqual(backward);
    if (forward.kind !== 'unknown-id') return;
    expect(forward.id).toBe('aaa');
  });

  it('accepts a no-op override and records it, because intent is what a sweep keeps', () => {
    const outcome = tryApplyOverrides(CATALOG, { units: { [UNIT_ID]: { cost: UNIT.cost } } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.applied).toEqual([
      `units.${UNIT_ID}.cost: ${String(UNIT.cost)} -> ${String(UNIT.cost)}`,
    ]);
    expect(hashValue(outcome.value.catalog)).toBe(hashValue(CATALOG));
  });
});

/* ------------------------------------------------------------------ *
 * 3. The record
 * ------------------------------------------------------------------ */

describe('the record of what was applied', () => {
  it('names every field the patch set, ordered by section, id and field', () => {
    const building = mustFind(CATALOG.buildings[0], 'building row');
    const outcome = tryApplyOverrides(CATALOG, {
      units: { [UNIT_ID]: { name: 'Renamed', cost: 7 } },
      buildings: { [String(building.id)]: { maintenance: 3 } },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.applied).toEqual([
      `units.${UNIT_ID}.name: ${UNIT.name} -> Renamed`,
      `units.${UNIT_ID}.cost: ${String(UNIT.cost)} -> 7`,
      `buildings.${String(building.id)}.maintenance: ${String(building.maintenance)} -> 3`,
    ]);
  });

  it('does not depend on the order the patch keys were written in', () => {
    const [first, second] = CATALOG.units;
    const a = mustFind(first, 'a unit');
    const b = mustFind(second, 'a second unit');
    const patches: readonly RulesetPatch[] = [
      { units: { [String(a.id)]: { cost: 1 }, [String(b.id)]: { cost: 2 } } },
      { units: { [String(b.id)]: { cost: 2 }, [String(a.id)]: { cost: 1 } } },
    ];

    const records = patches.map((patch) => {
      const outcome = tryApplyOverrides(CATALOG, patch);
      if (!outcome.ok) throw new Error('the patch should apply');
      return canonicalize({ applied: outcome.value.applied, catalog: outcome.value.catalog });
    });

    expect(records[0]).toBe(records[1]);
  });

  it('records nothing for an empty patch, and returns the catalog unchanged', () => {
    const outcome = tryApplyOverrides(CATALOG, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.applied).toEqual([]);
    expect(outcome.value.catalog.terrains).toBe(CATALOG.terrains);
    expect(outcome.value.catalog.units).toBe(CATALOG.units);
  });
});

/* ------------------------------------------------------------------ *
 * 4. An invalid override fails like a hand-edited catalog
 * ------------------------------------------------------------------ */

describe('an override that breaks the rules fails validation', () => {
  /** The edit, made by hand, that the patch below makes through the override path. */
  const handEdited = (
    edit: (row: (typeof CATALOG.units)[number]) => (typeof CATALOG.units)[number],
  ): Catalog => ({
    ...CATALOG,
    units: CATALOG.units.map((row) => (row.id === UNIT.id ? edit(row) : row)),
  });

  const cases: readonly {
    readonly what: string;
    readonly patch: UnitPatch;
    readonly edit: (row: (typeof CATALOG.units)[number]) => (typeof CATALOG.units)[number];
  }[] = [
    { what: 'a shield cost of zero', patch: { cost: 0 }, edit: (row) => ({ ...row, cost: 0 }) },
    { what: 'a negative cost', patch: { cost: -3 }, edit: (row) => ({ ...row, cost: -3 }) },
    { what: 'a fractional cost', patch: { cost: 1.5 }, edit: (row) => ({ ...row, cost: 1.5 }) },
    {
      what: 'zero movement',
      patch: { movement: 0 },
      edit: (row) => ({ ...row, movement: 0 }),
    },
  ];

  for (const { what, patch, edit } of cases) {
    it(`rejects ${what} with the same errors as editing the row by hand`, () => {
      const overridden = applyOverrides(CATALOG, { units: { [UNIT_ID]: patch } });
      const byHand = handEdited(edit);

      const fromOverride = validateRuleset(overridden, 'tuned');
      const fromHand = validateRuleset(byHand, 'tuned');

      expect(fromOverride.ok).toBe(false);
      expect(fromHand.ok).toBe(false);
      if (fromOverride.ok || fromHand.ok) return;
      expect(fromOverride.error).toEqual(fromHand.error);
      expect(fromOverride.error.length).toBeGreaterThan(0);
      expect(fromOverride.error.some((issue) => issue.kind === 'invalid-value')).toBe(true);
    });
  }

  it('still validates when the override is a legal one', () => {
    const overridden = applyOverrides(CATALOG, {
      units: { [UNIT_ID]: { cost: UNIT.cost + 9 } },
      buildings: {
        [String(mustFind(CATALOG.buildings[0], 'building row').id)]: { maintenance: 0 },
      },
    });
    const validated = validateRuleset(overridden, 'tuned');

    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.fidelity).toBe('tuned');
    const row = mustFind(
      validated.value.units.find((candidate) => candidate.id === UNIT.id),
      'the overridden unit in the validated ruleset',
    );
    expect(row.cost).toBe(UNIT.cost + 9);
  });
});
