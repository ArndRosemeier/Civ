/**
 * Ruleset overrides — the balance knob.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" ("Balance
 * knobs"), PLAN.md §6.2 (content is data, with provenance) and §5.3 (determinism).
 *
 * The contract, in full: `applyOverrides(catalog, patch)` applies a **deep-partial of
 * the catalog by id**, is applied **before** `validateRuleset` so an override that
 * would produce an invalid ruleset fails exactly the way a hand-edited catalog
 * would, and **every override is recorded**, because a balance number without the
 * ruleset that produced it is meaningless.
 *
 * Design notes, and the reasoning behind the choices the contract left open:
 *
 * - **The merge is written out field by field, not spread.** A generic deep merge
 *   over an index signature would need a cast to put the result back into a typed
 *   row, and a cast is exactly where a renamed catalog field would go unnoticed. Each
 *   `merge*` below names every field of its row, so a field added to `@civts/rules`
 *   is a *typecheck* failure here — the compiler, not review, is what says "this
 *   override path still covers the whole row".
 * - **`provenance` and `id` are not patchable.** The id is the key a row is addressed
 *   by, and provenance is authorship rather than a magnitude: a patch that could
 *   rewrite it could promote a placeholder to a claim of Civ 3 accuracy with nobody
 *   noticing. Overridden rows keep the provenance they were written with, and the
 *   override record is what says a magnitude moved.
 * - **An unknown id, and an unknown *field*, are errors.** The id half is the
 *   contract's ("a patch naming an unknown id is reported clearly"). The field half is
 *   the same argument one level down: a sweep file written by hand — or by a model —
 *   that says `{ units: { warrior: { costs: 10 } } }` would otherwise apply nothing and
 *   report a balance effect of zero, which is the worst kind of wrong answer.
 *   TypeScript catches that for a typed caller and cannot catch it for JSON, so the
 *   check lives in the function. Both are reported with the *known* alternatives.
 * - **An untouched row is returned as the same object.** Not a copy: a caller can
 *   compare by identity to see what a patch really changed, and a big catalog costs
 *   one array rebuild rather than a deep clone. The function is pure either way —
 *   nothing is mutated, and the input stays byte-identical (asserted by test).
 * - **The record is derived from the walk, never written twice.** `applied` in the
 *   returned `OverrideOutcome` is a list of `section.id.field: before -> after` lines
 *   produced while merging, so the structured record (the patch) and the human-readable
 *   record cannot disagree — the failure mode the M2 provenance summary was caught by.
 *   Ordering is stated: sections in `OVERRIDE_SECTIONS` order, ids ascending, fields in
 *   each row's declared order.
 * - **No rules values here.** This module moves magnitudes between a catalog and an
 *   override; it does not introduce one. Every number a sweep varies belongs to
 *   `@civts/rules` (where each row is a `placeholder` until sourced), and nothing in
 *   this file is claimed as Civ 3's.
 *
 * Deterministic and pure: no clock, no RNG, no I/O, no mutation, and the result is a
 * function of `(catalog, patch)` alone.
 */

import { err, ok, type Result, type TerrainYields } from '@civts/core';
import type {
  BuildingSpec,
  Catalog,
  ImprovementSpec,
  ResourceSpec,
  TerrainSpec,
  UnitSpec,
} from '@civts/rules';

import type {
  BuildingPatch,
  ImprovementPatch,
  OverrideSection,
  ResourcePatch,
  RulesetPatch,
  TerrainPatch,
  UnitPatch,
  YieldsPatch,
} from './types.js';

/* ------------------------------------------------------------------ *
 * The public error channel
 * ------------------------------------------------------------------ */

/**
 * Why a patch could not be applied.
 *
 * A typed value rather than a thrown string, because a sweep runs dozens of
 * combinations and a typo in one of them should be *reportable* rather than fatal:
 * `tryApplyOverrides` returns this, and `applyOverrides` throws a message rendered
 * from it (`formatOverrideError`) for callers that would rather not thread a Result
 * through. Both channels carry the same facts.
 */
export type OverrideError =
  | {
      readonly kind: 'unknown-id';
      readonly section: OverrideSection;
      readonly id: string;
      /** The ids that *are* in the section, ascending — the fix, not just the fault. */
      readonly known: readonly string[];
    }
  | {
      readonly kind: 'unknown-field';
      readonly section: OverrideSection;
      readonly id: string;
      readonly field: string;
      /** The fields a patch may set on this row, ascending. */
      readonly known: readonly string[];
    };

/** The one rendering of an `OverrideError`, shared by the throw path and any report. */
export const formatOverrideError = (error: OverrideError): string => {
  switch (error.kind) {
    case 'unknown-id':
      return (
        `override addresses ${error.section}.${error.id}, but the catalog has no such row ` +
        `(known ids: ${error.known.join(', ') || 'none'})`
      );
    case 'unknown-field':
      return (
        `override addresses ${error.section}.${error.id}.${error.field}, which is not a field a ` +
        `patch may set (patchable fields: ${error.known.join(', ') || 'none'})`
      );
  }
};

/* ------------------------------------------------------------------ *
 * The record a caller keeps beside a result
 * ------------------------------------------------------------------ */

/** The catalog a patch produced, and the record of what it changed. */
export interface OverrideOutcome {
  /** A new catalog. Untouched rows are the *same objects* as in the input. */
  readonly catalog: Catalog;
  /**
   * `section.id.field: before -> after` for every field the patch set, in
   * `OVERRIDE_SECTIONS` order, ids ascending, fields in declared order.
   *
   * It records the fields the patch *named*, even when the value is the one the row
   * already had: "every override is recorded" is about intent, and a sweep that names
   * a field without moving it should read as a no-op rather than as silence.
   */
  readonly applied: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Field lists — the one place "what may be patched" is written
 * ------------------------------------------------------------------ */

/** The catalog sections, in the order a patch is walked and a record is written. */
export const OVERRIDE_SECTIONS: readonly OverrideSection[] = [
  'terrains',
  'units',
  'buildings',
  'improvements',
  'resources',
];

/**
 * Field lists, typed against their patch so a typo in a name is a **compile error**.
 *
 * They are the one statement of "what a patch may touch", and they are compared at
 * runtime against the keys a patch really carries — so a mangled JSON patch cannot
 * silently no-op. Widening each list to `readonly string[]` (below) is an ordinary
 * widening assignment, not a cast: the typed list stays the source of truth.
 */
const TERRAIN_FIELDS: readonly (keyof TerrainPatch)[] = [
  'role',
  'name',
  'moveCost',
  'defenseBonusPct',
  'impassable',
];
const UNIT_FIELDS: readonly (keyof UnitPatch)[] = [
  'role',
  'name',
  'attack',
  'defense',
  'movement',
  'cost',
  'domain',
  'requiresResource',
];
const BUILDING_FIELDS: readonly (keyof BuildingPatch)[] = [
  'name',
  'cost',
  'maintenance',
  'effects',
  'wonder',
];
const IMPROVEMENT_FIELDS: readonly (keyof ImprovementPatch)[] = [
  'kind',
  'name',
  'turns',
  'allowedRoles',
];
const RESOURCE_FIELDS: readonly (keyof ResourcePatch)[] = ['name', 'kind', 'allowedRoles'];

/** The three channels of a yield partial, in the order a record writes them. */
const YIELDS_FIELDS: readonly (keyof YieldsPatch)[] = ['food', 'shields', 'commerce'];

/** `['yields.food', 'yields.shields', 'yields.commerce']` — the dotted nested names. */
const YIELDS_KEYS: readonly string[] = YIELDS_FIELDS.map((channel) => `yields.${channel}`);

const stringNames = (fields: readonly string[]): readonly string[] => [...fields].sort();

/**
 * The keys a patch may name, per section: its own fields, the `yields` key itself for
 * the sections that carry a yield triple, and that partial's channels as dotted names.
 */
const TERRAIN_ALLOWED: readonly string[] = [...TERRAIN_FIELDS, 'yields', ...YIELDS_KEYS];
const UNIT_ALLOWED: readonly string[] = [...UNIT_FIELDS];
const BUILDING_ALLOWED: readonly string[] = [...BUILDING_FIELDS];
const IMPROVEMENT_ALLOWED: readonly string[] = [...IMPROVEMENT_FIELDS, 'yields', ...YIELDS_KEYS];
const RESOURCE_ALLOWED: readonly string[] = [...RESOURCE_FIELDS, 'yields', ...YIELDS_KEYS];

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

/** Render a patch or catalog value for the record. Plain data in, text out. */
const render = (value: unknown): string => {
  if (typeof value === 'string') return value;
  // `unknown` on purpose: `JSON.stringify(undefined)` really does return `undefined`
  // whatever its signature claims, and a record that says "undefined" beats one that
  // crashes or lies.
  const text: unknown = JSON.stringify(value);
  return typeof text === 'string' ? text : 'undefined';
};

/**
 * Note every field a patch named, with what it was and what it became.
 *
 * `after` is `undefined` when the patch did not name the field, which is how the
 * caller's explicit field list doubles as the record: there is no second walk that
 * could disagree with the merge about what happened. A patch value that is `null` (a
 * hand-written JSON file) is recorded as the value it fell back to, because `??`
 * below is what actually happened.
 */
const recordFields = (
  notes: string[],
  section: OverrideSection,
  id: string,
  fields: readonly (readonly [string, unknown, unknown])[],
): void => {
  for (const [field, before, after] of fields) {
    if (after !== undefined) {
      notes.push(`${section}.${id}.${field}: ${render(before)} -> ${render(after ?? before)}`);
    }
  }
};

/** The dotted keys a patch names, including the channels of its `yields` partial. */
const yieldsKeys = (yields: YieldsPatch | undefined): readonly string[] =>
  yields === undefined ? [] : Object.keys(yields).map((channel) => `yields.${channel}`);

/** The first key a patch names that is not patchable, if any. */
const unknownFieldOf = (
  section: OverrideSection,
  id: string,
  keys: readonly string[],
  allowed: readonly string[],
): OverrideError | undefined => {
  for (const key of [...keys].sort()) {
    if (!allowed.includes(key)) {
      return { kind: 'unknown-field', section, id, field: key, known: stringNames(allowed) };
    }
  }
  return undefined;
};

/** A yield triple with the patch's channels applied; absent channels keep the row's. */
const mergeYields = (base: TerrainYields, patch: YieldsPatch | undefined): TerrainYields =>
  patch === undefined
    ? base
    : {
        food: patch.food ?? base.food,
        shields: patch.shields ?? base.shields,
        commerce: patch.commerce ?? base.commerce,
      };

/** Note the channels a `yields` partial names, in the fixed channel order. */
const recordYields = (
  notes: string[],
  section: OverrideSection,
  id: string,
  before: TerrainYields,
  patch: YieldsPatch | undefined,
): void => {
  if (patch === undefined) return;
  for (const channel of YIELDS_FIELDS) {
    const after = patch[channel];
    if (after !== undefined) {
      notes.push(
        `${section}.${id}.yields.${channel}: ${render(before[channel])} -> ${render(after)}`,
      );
    }
  }
};

/**
 * Apply one section's patches to a copy of its rows, in ascending id order.
 *
 * The order is stated so that the *error* from a patch with several unknown ids is
 * deterministic; the result never depends on it, because each patch touches exactly
 * one row.
 */
const patchSection = <R extends { readonly id: unknown }, P extends object>(
  section: OverrideSection,
  rows: readonly R[],
  patches: Readonly<Record<string, P>> | undefined,
  merge: (row: R, patch: P, notes: string[]) => Result<R, OverrideError>,
  notes: string[],
): Result<readonly R[], OverrideError> => {
  if (patches === undefined) return ok(rows);

  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const merged = new Map<string, R>();

  for (const id of Object.keys(patches).sort()) {
    const row = byId.get(id);
    if (row === undefined) {
      return err({ kind: 'unknown-id', section, id, known: [...byId.keys()].sort() });
    }
    const patch = patches[id];
    if (patch === undefined) continue;

    const next = merge(row, patch, notes);
    if (!next.ok) return next;
    merged.set(id, next.value);
  }

  return ok(rows.map((row) => merged.get(String(row.id)) ?? row));
};

/* ------------------------------------------------------------------ *
 * One merge per catalog section
 * ------------------------------------------------------------------ */

const mergeTerrain = (
  row: TerrainSpec,
  patch: TerrainPatch,
  notes: string[],
): Result<TerrainSpec, OverrideError> => {
  const id = String(row.id);
  const bad = unknownFieldOf(
    'terrains',
    id,
    [...Object.keys(patch), ...yieldsKeys(patch.yields)],
    TERRAIN_ALLOWED,
  );
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'terrains', id, [
    ['role', row.role, patch.role],
    ['name', row.name, patch.name],
    ['moveCost', row.moveCost, patch.moveCost],
    ['defenseBonusPct', row.defenseBonusPct, patch.defenseBonusPct],
    ['impassable', row.impassable, patch.impassable],
  ]);
  recordYields(notes, 'terrains', id, row.yields, patch.yields);

  return ok({
    id: row.id,
    role: patch.role ?? row.role,
    name: patch.name ?? row.name,
    moveCost: patch.moveCost ?? row.moveCost,
    defenseBonusPct: patch.defenseBonusPct ?? row.defenseBonusPct,
    yields: mergeYields(row.yields, patch.yields),
    impassable: patch.impassable ?? row.impassable,
    provenance: row.provenance,
  });
};

const mergeUnit = (
  row: UnitSpec,
  patch: UnitPatch,
  notes: string[],
): Result<UnitSpec, OverrideError> => {
  const id = String(row.id);
  const bad = unknownFieldOf('units', id, Object.keys(patch), UNIT_ALLOWED);
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'units', id, [
    ['role', row.role, patch.role],
    ['name', row.name, patch.name],
    ['attack', row.attack, patch.attack],
    ['defense', row.defense, patch.defense],
    ['movement', row.movement, patch.movement],
    ['cost', row.cost, patch.cost],
    ['domain', row.domain, patch.domain],
    ['requiresResource', row.requiresResource, patch.requiresResource],
  ]);

  const requiresResource = patch.requiresResource ?? row.requiresResource;
  return ok({
    id: row.id,
    role: patch.role ?? row.role,
    name: patch.name ?? row.name,
    attack: patch.attack ?? row.attack,
    defense: patch.defense ?? row.defense,
    movement: patch.movement ?? row.movement,
    cost: patch.cost ?? row.cost,
    domain: patch.domain ?? row.domain,
    // Absent stays absent — never a key holding `undefined`, which no JSON round trip
    // and no hash would survive (`canonicalize` rejects it by design).
    ...(requiresResource === undefined ? {} : { requiresResource }),
    provenance: row.provenance,
  });
};

const mergeBuilding = (
  row: BuildingSpec,
  patch: BuildingPatch,
  notes: string[],
): Result<BuildingSpec, OverrideError> => {
  const id = String(row.id);
  const bad = unknownFieldOf('buildings', id, Object.keys(patch), BUILDING_ALLOWED);
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'buildings', id, [
    ['name', row.name, patch.name],
    ['cost', row.cost, patch.cost],
    ['maintenance', row.maintenance, patch.maintenance],
    ['effects', row.effects, patch.effects],
    ['wonder', row.wonder, patch.wonder],
  ]);

  const wonder = patch.wonder ?? row.wonder;
  return ok({
    id: row.id,
    name: patch.name ?? row.name,
    cost: patch.cost ?? row.cost,
    maintenance: patch.maintenance ?? row.maintenance,
    effects: patch.effects ?? row.effects,
    ...(wonder === undefined ? {} : { wonder }),
    provenance: row.provenance,
  });
};

const mergeImprovement = (
  row: ImprovementSpec,
  patch: ImprovementPatch,
  notes: string[],
): Result<ImprovementSpec, OverrideError> => {
  const id = String(row.id);
  const bad = unknownFieldOf(
    'improvements',
    id,
    [...Object.keys(patch), ...yieldsKeys(patch.yields)],
    IMPROVEMENT_ALLOWED,
  );
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'improvements', id, [
    ['kind', row.kind, patch.kind],
    ['name', row.name, patch.name],
    ['turns', row.turns, patch.turns],
    ['allowedRoles', row.allowedRoles, patch.allowedRoles],
  ]);
  recordYields(notes, 'improvements', id, row.yields, patch.yields);

  return ok({
    id: row.id,
    kind: patch.kind ?? row.kind,
    name: patch.name ?? row.name,
    turns: patch.turns ?? row.turns,
    yields: mergeYields(row.yields, patch.yields),
    allowedRoles: patch.allowedRoles ?? row.allowedRoles,
    provenance: row.provenance,
  });
};

const mergeResource = (
  row: ResourceSpec,
  patch: ResourcePatch,
  notes: string[],
): Result<ResourceSpec, OverrideError> => {
  const id = String(row.id);
  const bad = unknownFieldOf(
    'resources',
    id,
    [...Object.keys(patch), ...yieldsKeys(patch.yields)],
    RESOURCE_ALLOWED,
  );
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'resources', id, [
    ['name', row.name, patch.name],
    ['kind', row.kind, patch.kind],
    ['allowedRoles', row.allowedRoles, patch.allowedRoles],
  ]);
  recordYields(notes, 'resources', id, row.yields, patch.yields);

  return ok({
    id: row.id,
    name: patch.name ?? row.name,
    kind: patch.kind ?? row.kind,
    yields: mergeYields(row.yields, patch.yields),
    allowedRoles: patch.allowedRoles ?? row.allowedRoles,
    provenance: row.provenance,
  });
};

/* ------------------------------------------------------------------ *
 * The entry points
 * ------------------------------------------------------------------ */

/**
 * Apply `patch` to `catalog`, or report the first thing wrong with it.
 *
 * The non-throwing form, and the one a sweep should use: a typo in one combination
 * out of a hundred becomes a reported error rather than a dead batch. Pure, and it
 * does not mutate `catalog` — the input is only read.
 */
export const tryApplyOverrides = (
  catalog: Catalog,
  patch: RulesetPatch,
): Result<OverrideOutcome, OverrideError> => {
  const notes: string[] = [];

  const terrains = patchSection('terrains', catalog.terrains, patch.terrains, mergeTerrain, notes);
  if (!terrains.ok) return terrains;

  const units = patchSection('units', catalog.units, patch.units, mergeUnit, notes);
  if (!units.ok) return units;

  const buildings = patchSection(
    'buildings',
    catalog.buildings,
    patch.buildings,
    mergeBuilding,
    notes,
  );
  if (!buildings.ok) return buildings;

  const improvements = patchSection(
    'improvements',
    catalog.improvements,
    patch.improvements,
    mergeImprovement,
    notes,
  );
  if (!improvements.ok) return improvements;

  const resources = patchSection(
    'resources',
    catalog.resources,
    patch.resources,
    mergeResource,
    notes,
  );
  if (!resources.ok) return resources;

  return ok({
    catalog: {
      terrains: terrains.value,
      units: units.value,
      buildings: buildings.value,
      improvements: improvements.value,
      resources: resources.value,
      // M5's tech tree is carried through **unchanged**, and that is stated rather
      // than left to look like an oversight: `RulesetPatch` has no `techs` section yet,
      // so no patch can move a tech's price through this surface. The catalog is still
      // rebuilt field by field so a future `techs` section is a one-line addition
      // beside this one, and — more importantly — so the validated catalog a sweep
      // runs on stays the tree `@civts/rules` shipped rather than silently losing it.
      // `scripts/tech-balance-sweep.ts` measures the consequence of the missing
      // section and prints it, rather than pretending the knob is reachable.
      techs: catalog.techs,
    },
    applied: notes,
  });
};

/**
 * `tryApplyOverrides`, unwrapped: the catalog a patch produces, or a thrown error
 * naming what the patch got wrong.
 *
 * Throwing is the right channel for this spelling because the frozen signature has no
 * failure channel: a caller that hands over a patch naming an id the catalog does not
 * have has a bug, and silently returning the unpatched catalog would be the worst
 * answer — a sweep would report the *base* ruleset's numbers as if they were the
 * override's. Use `tryApplyOverrides` when the patch comes from a file.
 */
export const applyOverrides = (catalog: Catalog, patch: RulesetPatch): Catalog => {
  const resolved = tryApplyOverrides(catalog, patch);
  if (!resolved.ok) throw new Error(formatOverrideError(resolved.error));
  return resolved.value.catalog;
};
