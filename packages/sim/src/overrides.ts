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
  CaptureSpec,
  Catalog,
  CombatSpec,
  ImprovementSpec,
  ResourceSpec,
  TerrainSpec,
  UnitSpec,
} from '@civts/rules';

import type {
  BuildingPatch,
  CapturePatch,
  CombatPatch,
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
    }
  /**
   * The patch names a *section* this surface cannot patch at all — `techs`, or a typo
   * such as `unit`.
   *
   * **This variant exists because silence was the alternative**, and silence is the
   * failure this package cares most about: a patch carrying `{ techs: { pottery: {...} } }`
   * (a JSON file written by hand or by a model) used to be accepted and *ignored*, because
   * the applier only ever read the five keys it knew about. A sweep built on such a patch
   * would report "no effect" for a knob that was never applied — the M6b contract's own
   * motivating failure mode, one level up from the field checks below.
   */
  | {
      readonly kind: 'unknown-section';
      /** The key the patch carried. */
      readonly section: string;
      /** The sections a patch may address, ascending. */
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
    case 'unknown-section':
      return (
        `override addresses the section "${error.section}", which this surface cannot patch ` +
        `(patchable sections: ${error.known.join(', ')}). ${UNPATCHABLE_SECTIONS_NOTE}`
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

/**
 * The catalog sections **whose rows** a patch addresses by id, in the order a patch is
 * walked and a record is written.
 *
 * `combat` is deliberately absent: it is a section a patch may address (see
 * `PATCH_SECTIONS`) but it is *one row of nine numbers with no id*, so walking it as a
 * `Record<id, Patch>` would be walking a shape it does not have. M7's `capture` section is
 * absent for the same reason, one row later. Both are merged after these five, which is
 * also the order the catalog declares its sections in and the order `provenanceSections`
 * reports them.
 */
export const OVERRIDE_SECTIONS: readonly OverrideSection[] = [
  'terrains',
  'units',
  'buildings',
  'improvements',
  'resources',
];

/**
 * **The one id the combat section is recorded under.**
 *
 * The section has no id of its own (see `@civts/rules`' `CombatSpec`), but the override
 * *record* is a list of `section.id.field` lines, so a section that filed its changes
 * under no name would print lines like `combat..wallsBonusPct: 50 -> 100`. The catalog's
 * own field name is the honest id, and it is the same string `@civts/rules` files the
 * section's provenance under.
 */
const COMBAT_ROW_ID = 'combat';

/**
 * **The one id the capture section is recorded under** (M7).
 *
 * Same argument as `COMBAT_ROW_ID`: the section is one row of one magnitude with no id of
 * its own, the override record is a list of `section.id.field` lines, and the catalog's own
 * field name is the honest id — the same string `@civts/rules` files the section's
 * provenance under.
 */
const CAPTURE_ROW_ID = 'capture';

/**
 * Every section a patch may address, ascending — the *whole* surface, row sections and
 * the singletons together.
 *
 * It exists to be compared against the keys a patch really carries. That comparison is
 * M6b's other half of "reported, never ignored": the field-level checks below catch a
 * mangled key inside a row, and this one catches a mangled *section* — `{ techs: {...} }`,
 * `{ unit: {...} }` — which used to be accepted silently, because the applier only ever
 * read the keys it knew about.
 */
export const PATCH_SECTIONS: readonly OverrideSection[] = [
  ...OVERRIDE_SECTIONS,
  'combat',
  'capture',
];

/**
 * The catalog sections **no patch can address**, named rather than left implicit.
 *
 * `techs` is the only one: M5's tree is not sweepable through `RulesetPatch`, which
 * `scripts/tech-balance-sweep.ts` measures and prints. Every other catalog section is
 * reachable — including M6b's combat globals, which is the point of this wave. A section
 * in neither list would be a section a patch could name and silently drop, so the two
 * lists are asserted to partition the catalog in `overrides.test.ts`.
 */
export const UNPATCHABLE_SECTIONS: readonly string[] = ['techs'];

/**
 * What `formatOverrideError` appends to an `unknown-section` complaint, so the one caller
 * that has to guess why its patch was refused hears the *known* reason as well: `techs` is
 * a real catalog section, and the answer to "why can I not patch it?" is "because nothing
 * implements it yet", not "because you spelled it wrong".
 */
const UNPATCHABLE_SECTIONS_NOTE =
  `The catalog also carries ${UNPATCHABLE_SECTIONS.join(', ')}, which no patch can move: ` +
  'that gap is measured and reported rather than papered over';

/**
 * Field lists, typed against their patch so a typo in a name is a **compile error**.
 *
 * They are the one statement of "what a patch may touch", and they are compared at
 * runtime against the keys a patch really carries — so a mangled JSON patch cannot
 * silently no-op. Widening each list to `readonly string[]` (below) is an ordinary
 * widening assignment, not a cast: the typed list stays the source of truth.
 *
 * **Every field of every patch type belongs in the list it is typed against, and
 * M6 is where that stopped being a formality.** The unit list had no `hitPoints`, so
 * `mergeUnit` — which rebuilds each row field by field — dropped it: a patch naming
 * any *other* unit field silently reset the world's hit points, and a patch naming
 * `hitPoints` was refused as an unknown field, which made M6's combat statistics
 * unsweepable exactly where M6 asks for a combat balance sweep. The lists below are
 * the patch types' own `keyof` sets, so a field added to a patch type without a
 * matching list entry fails the compile rather than going quietly unsweepable.
 */
const TERRAIN_FIELDS: readonly (keyof TerrainPatch)[] = [
  'role',
  'name',
  'moveCost',
  'defenseBonusPct',
  // M6's name for the same magnitude. Both are patchable, and `mergeTerrain` sets
  // both, because `core/combat.ts` reads `defenseBonus` in preference to the older
  // spelling — a patch that moved only one of the two would change nothing a battle
  // can see.
  'defenseBonus',
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
  // M6.
  'hitPoints',
  // M5, unwired until M6: a tech-gated row has to be sweepable, and a rebuild that
  // dropped `requiresTech` would silently un-gate a gated unit.
  'requiresTech',
];
const BUILDING_FIELDS: readonly (keyof BuildingPatch)[] = [
  'name',
  'cost',
  'maintenance',
  'effects',
  'wonder',
  'requiresTech',
];
const IMPROVEMENT_FIELDS: readonly (keyof ImprovementPatch)[] = [
  'kind',
  'name',
  'turns',
  'allowedRoles',
  'requiresTech',
];
const RESOURCE_FIELDS: readonly (keyof ResourcePatch)[] = ['name', 'kind', 'allowedRoles'];
/**
 * M6b's combat globals — **all nine**, and the `keyof` typing is what keeps it all nine.
 *
 * The section is a singleton, so its fields are addressed without an id; see `CombatPatch`
 * in `types.ts` for why. What matters here is the same rule every other list follows: a
 * magnitude this surface can move is named *explicitly*, and a magnitude it cannot move is
 * reported rather than dropped. M6's review found `mergeUnit` and `mergeTerrain` silently
 * resetting `hitPoints` and `defenseBonus` because their field lists were incomplete; a
 * `keyof` list makes that a compile error next time.
 */
const COMBAT_FIELDS: readonly (keyof CombatPatch)[] = [
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

/**
 * M7's capture rule — **the whole section**, which `keyof` is what keeps whole.
 *
 * One field today (`populationDivisor`), and the same rule every other list follows: a
 * magnitude this surface can move is named *explicitly*, and a magnitude it cannot move is
 * reported rather than dropped. The list is `keyof CapturePatch`, so a field added to the
 * section in `types.ts` is a compile error here until it is named — which is exactly how
 * M6's silent `hitPoints` reset would have been caught.
 */
const CAPTURE_FIELDS: readonly (keyof CapturePatch)[] = ['populationDivisor'];

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
    // M6's spelling of the same magnitude, recorded separately when a patch names it:
    // the record is about what a sweep said, and "defenseBonus" and "defenseBonusPct"
    // are different keys even though the merge treats them as one number.
    ['defenseBonus', row.defenseBonus, patch.defenseBonus],
    ['impassable', row.impassable, patch.impassable],
  ]);
  recordYields(notes, 'terrains', id, row.yields, patch.yields);

  // One magnitude, two names: whichever the patch named is written to **both**, so the
  // engine's two readers (`terrainDefenseBonus` prefers `defenseBonus`; `validateRuleset`
  // refuses a row whose spellings disagree) cannot end up looking at different numbers.
  const nextDefenseBonus = patch.defenseBonus ?? patch.defenseBonusPct ?? row.defenseBonus;

  return ok({
    id: row.id,
    role: patch.role ?? row.role,
    name: patch.name ?? row.name,
    moveCost: patch.moveCost ?? row.moveCost,
    defenseBonusPct: patch.defenseBonus ?? patch.defenseBonusPct ?? row.defenseBonusPct,
    yields: mergeYields(row.yields, patch.yields),
    impassable: patch.impassable ?? row.impassable,
    // Absent stays absent: a hand-built row that declares only the older spelling comes
    // back declaring only the older spelling, never a key holding `undefined`.
    ...(nextDefenseBonus === undefined ? {} : { defenseBonus: nextDefenseBonus }),
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
    // M6: hit points, and M5's tech gate. Both are recorded like every other field, and
    // both are carried across below — the rebuild is explicit, so a field this list
    // forgets is a field the override *deletes*.
    ['hitPoints', row.hitPoints, patch.hitPoints],
    ['requiresTech', row.requiresTech, patch.requiresTech],
  ]);

  const requiresResource = patch.requiresResource ?? row.requiresResource;
  const requiresTech = patch.requiresTech ?? row.requiresTech;
  return ok({
    id: row.id,
    role: patch.role ?? row.role,
    name: patch.name ?? row.name,
    attack: patch.attack ?? row.attack,
    defense: patch.defense ?? row.defense,
    movement: patch.movement ?? row.movement,
    cost: patch.cost ?? row.cost,
    domain: patch.domain ?? row.domain,
    // M6's combat statistics are part of the row, not a fixture of the combat module:
    // dropping `hitPoints` here would reset every unit's health to the reader's
    // fallback, and dropping `requiresTech` would silently un-gate a gated row.
    ...(row.hitPoints === undefined && patch.hitPoints === undefined
      ? {}
      : { hitPoints: patch.hitPoints ?? row.hitPoints }),
    // Absent stays absent — never a key holding `undefined`, which no JSON round trip
    // and no hash would survive (`canonicalize` rejects it by design).
    ...(requiresResource === undefined ? {} : { requiresResource }),
    ...(requiresTech === undefined ? {} : { requiresTech }),
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
    ['requiresTech', row.requiresTech, patch.requiresTech],
  ]);

  const wonder = patch.wonder ?? row.wonder;
  const requiresTech = patch.requiresTech ?? row.requiresTech;
  return ok({
    id: row.id,
    name: patch.name ?? row.name,
    cost: patch.cost ?? row.cost,
    maintenance: patch.maintenance ?? row.maintenance,
    effects: patch.effects ?? row.effects,
    ...(wonder === undefined ? {} : { wonder }),
    ...(requiresTech === undefined ? {} : { requiresTech }),
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
    ['requiresTech', row.requiresTech, patch.requiresTech],
  ]);
  recordYields(notes, 'improvements', id, row.yields, patch.yields);

  const requiresTech = patch.requiresTech ?? row.requiresTech;
  return ok({
    id: row.id,
    kind: patch.kind ?? row.kind,
    name: patch.name ?? row.name,
    turns: patch.turns ?? row.turns,
    yields: mergeYields(row.yields, patch.yields),
    allowedRoles: patch.allowedRoles ?? row.allowedRoles,
    ...(requiresTech === undefined ? {} : { requiresTech }),
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

/**
 * M6b: the combat globals, merged **field by field** like every row above.
 *
 * The section is written out rather than spread for the reason the module note gives at
 * the top: a generic merge over an index signature needs a cast to put the result back
 * into a typed value, and a cast is where a renamed catalog field goes unnoticed. Every
 * field of `CombatSpec` except `provenance` appears below, `provenance` is carried through
 * untouched (authorship is not a magnitude — see the module note), and a patch key that is
 * not one of the nine is **reported** with the nine named. That last part is what makes a
 * sweep trustworthy: a knob whose name was misspelled is an error, never a measured
 * "no effect".
 *
 * The record lines use `COMBAT_ROW_ID` for the id half, so a reader of the override record
 * sees `combat.combat.wallsBonusPct: 50 -> 100` — section, the section's own id, field —
 * which is the same shape every other section's lines have and is what
 * `scripts/combat-balance-sweep.ts` prints as the knob's receipt.
 */
const mergeCombat = (
  row: CombatSpec,
  patch: CombatPatch,
  notes: string[],
): Result<CombatSpec, OverrideError> => {
  const bad = unknownFieldOf('combat', COMBAT_ROW_ID, Object.keys(patch), COMBAT_FIELDS);
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'combat', COMBAT_ROW_ID, [
    ['fortifyBonusPct', row.fortifyBonusPct, patch.fortifyBonusPct],
    ['cityDefenseBonusPct', row.cityDefenseBonusPct, patch.cityDefenseBonusPct],
    ['wallsBonusPct', row.wallsBonusPct, patch.wallsBonusPct],
    ['veteranAttackPct', row.veteranAttackPct, patch.veteranAttackPct],
    ['maxExperience', row.maxExperience, patch.maxExperience],
    ['rollBound', row.rollBound, patch.rollBound],
    ['damagePerRound', row.damagePerRound, patch.damagePerRound],
    ['minWinPct', row.minWinPct, patch.minWinPct],
    ['maxWinPct', row.maxWinPct, patch.maxWinPct],
  ]);

  return ok({
    fortifyBonusPct: patch.fortifyBonusPct ?? row.fortifyBonusPct,
    cityDefenseBonusPct: patch.cityDefenseBonusPct ?? row.cityDefenseBonusPct,
    wallsBonusPct: patch.wallsBonusPct ?? row.wallsBonusPct,
    veteranAttackPct: patch.veteranAttackPct ?? row.veteranAttackPct,
    maxExperience: patch.maxExperience ?? row.maxExperience,
    rollBound: patch.rollBound ?? row.rollBound,
    damagePerRound: patch.damagePerRound ?? row.damagePerRound,
    minWinPct: patch.minWinPct ?? row.minWinPct,
    maxWinPct: patch.maxWinPct ?? row.maxWinPct,
    // Not patchable, and carried through by name so the omission is visible: a patch that
    // could rewrite provenance could promote a placeholder to a claim of Civ 3 accuracy
    // with nobody noticing.
    provenance: row.provenance,
  });
};

/** The combat section merged, or the catalog's own section when the patch says nothing. */
const mergeCombatSection = (
  row: CombatSpec,
  patch: CombatPatch | undefined,
  notes: string[],
): Result<CombatSpec, OverrideError> =>
  patch === undefined ? ok(row) : mergeCombat(row, patch, notes);

/**
 * M7: the capture rule, merged **field by field** like the combat section above.
 *
 * Written out rather than spread for the module's stated reason: a generic merge over an
 * index signature needs a cast to put the result back into a typed value, and a cast is
 * where a renamed catalog field goes unnoticed. Every field of `CaptureSpec` except
 * `provenance` appears below, `provenance` is carried through untouched (authorship is not
 * a magnitude), and a patch key that is not one of the section's fields is **reported**
 * with the real names — so a sweep whose knob was misspelled is an error rather than a
 * measured "no effect".
 *
 * The record lines use `CAPTURE_ROW_ID` for the id half, so a reader of the override record
 * sees `capture.capture.populationDivisor: 2 -> 4` — section, the section's own id, field —
 * which is the shape every other section's lines have and what
 * `scripts/combat-balance-sweep.ts` prints as the knob's receipt.
 */
const mergeCapture = (
  row: CaptureSpec,
  patch: CapturePatch,
  notes: string[],
): Result<CaptureSpec, OverrideError> => {
  const bad = unknownFieldOf('capture', CAPTURE_ROW_ID, Object.keys(patch), CAPTURE_FIELDS);
  if (bad !== undefined) return err(bad);

  recordFields(notes, 'capture', CAPTURE_ROW_ID, [
    ['populationDivisor', row.populationDivisor, patch.populationDivisor],
  ]);

  return ok({
    populationDivisor: patch.populationDivisor ?? row.populationDivisor,
    provenance: row.provenance,
  });
};

/** The capture section merged, or the catalog's own section when the patch says nothing. */
const mergeCaptureSection = (
  row: CaptureSpec,
  patch: CapturePatch | undefined,
  notes: string[],
): Result<CaptureSpec, OverrideError> =>
  patch === undefined ? ok(row) : mergeCapture(row, patch, notes);

/**
 * The first section a patch names that this surface cannot address, if any.
 *
 * Sorted, so a patch with two bad keys always reports the same one — the same determinism
 * argument `unknownFieldOf` and `patchSection` make for their own orders. A section that is
 * *known but unpatchable* (`techs`) is reported here like any other unknown key, with
 * `UNPATCHABLE_SECTIONS_NOTE` explaining that it is a real catalog section with no patch
 * support yet, so the caller is not left guessing whether a typo or a gap refused the patch.
 */
const firstUnknownSection = (patch: RulesetPatch): OverrideError | undefined => {
  const known: readonly string[] = stringNames(PATCH_SECTIONS);
  for (const key of Object.keys(patch).sort()) {
    if (!known.includes(key)) return { kind: 'unknown-section', section: key, known };
  }
  return undefined;
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

  // M6b: **the first thing checked, and the reason it is first.** A patch that names a
  // section this surface cannot address (`techs`, or a typo) must be *reported* rather than
  // half-applied: reporting it before any merge means a caller never sees a partial record
  // beside an error, and the message names every section that *is* patchable so the fix is
  // in the error itself. The check is over the keys the patch really carries, which is what
  // catches data the type system never saw — a JSON file written by hand or by a model.
  const unknownSection = firstUnknownSection(patch);
  if (unknownSection !== undefined) return err(unknownSection);

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

  // M6b: the combat globals last, matching the catalog's own section order. An absent
  // `patch.combat` returns the catalog's **same object**, so a patch that does not mention
  // the section cannot be observed to have touched it — and, crucially, cannot *drop* it:
  // the section is carried onto the rebuilt catalog below whatever the patch says. That is
  // the bug this wire is here to avoid: a rebuild that forgot a section would leave every
  // battle in a swept game fighting under `NO_COMBAT_RULES`, and the sweep would report a
  // large effect from a knob that was never applied.
  const combat = mergeCombatSection(catalog.combat, patch.combat, notes);
  if (!combat.ok) return combat;

  // M7: the capture rule last, after the combat globals it follows in the catalog. The
  // same wire, for the same reason: an absent `patch.capture` returns the catalog's **same
  // object**, so a patch that does not mention the section cannot be observed to have
  // touched it — and cannot *drop* it either, which would leave every sack in a swept game
  // reducing populations under `NO_CAPTURE_RULES` and reporting a large effect from a knob
  // that was never applied.
  const capture = mergeCaptureSection(catalog.capture, patch.capture, notes);
  if (!capture.ok) return capture;

  return ok({
    catalog: {
      terrains: terrains.value,
      units: units.value,
      buildings: buildings.value,
      improvements: improvements.value,
      resources: resources.value,
      combat: combat.value,
      capture: capture.value,
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
