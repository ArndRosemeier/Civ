/**
 * Type-safe settings. See PLAN.md 4.6.
 *
 * Single source of truth: one schema. Layers (defaults -> file -> CLI) are
 * deep-merged as plain data and then PARSED, so unknown keys are rejected and
 * ranges are enforced rather than trusted. After parsing, `Settings` is
 * immutable and no casts remain except branding at this boundary.
 */

import * as v from 'valibot';
import { err, ok, type Result } from './result.js';

export const MAP_SIZES = ['duel', 'tiny', 'small', 'standard', 'large', 'huge'] as const;
export type MapSize = (typeof MAP_SIZES)[number];

export const DIFFICULTIES = [
  'chieftain',
  'warlord',
  'regent',
  'monarch',
  'emperor',
  'deity',
] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const FIDELITY_MODES = ['tuned', 'cited-only'] as const;
export type Fidelity = (typeof FIDELITY_MODES)[number];

/** Map dimensions per size. PLACEHOLDER values (see PLAN.md 6.2), tuned by play. */
export const MAP_DIMENSIONS: Record<MapSize, { readonly width: number; readonly height: number; readonly maxCivs: number }> = {
  duel: { width: 40, height: 40, maxCivs: 2 },
  tiny: { width: 60, height: 60, maxCivs: 4 },
  small: { width: 80, height: 80, maxCivs: 6 },
  standard: { width: 100, height: 100, maxCivs: 8 },
  large: { width: 140, height: 140, maxCivs: 12 },
  huge: { width: 180, height: 180, maxCivs: 16 },
};

const SettingsSchema = v.strictObject({
  mapSize: v.picklist(MAP_SIZES),
  civCount: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(16)),
  seed: v.pipe(v.number(), v.integer()),
  difficulty: v.picklist(DIFFICULTIES),
  fidelity: v.picklist(FIDELITY_MODES),
  ai: v.strictObject({
    aggression: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    expandFast: v.boolean(),
  }),
  debug: v.strictObject({
    cheats: v.boolean(),
    revealMap: v.boolean(),
  }),
  ruleset: v.optional(v.string()),
});

export type Settings = v.InferOutput<typeof SettingsSchema>;

export interface SettingsIssue {
  readonly path: string;
  readonly message: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mapSize: 'tiny',
  civCount: 2,
  seed: 1,
  difficulty: 'regent',
  fidelity: 'tuned',
  ai: { aggression: 0.5, expandFast: false },
  debug: { cheats: false, revealMap: false },
};

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const deepMerge = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // An explicit `undefined` means "not set", not "set to undefined": a layer
    // must not be able to stub a key out. `undefined` is not representable in
    // canonical JSON, so a settings value carrying it cannot be hashed at all.
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
};

/**
 * `v.optional` accepts an explicit `undefined` and then *keeps the key*, so
 * parsing `{ ruleset: undefined }` would yield `{ ruleset: undefined }`. That
 * is not the correct representation of "not set" (`exactOptionalPropertyTypes`:
 * for `ruleset?: string`, absent is the only encoding of unset), and it is not
 * representable in canonical JSON either — a state built from such settings
 * throws in `hashValue`, which would take down the golden/replay path. The
 * natural CLI wiring `loadSettings(config, { ruleset: flag.ruleset })` hits
 * this whenever the flag is absent, so the parsed output is normalized here.
 *
 * `ruleset` is the schema's only optional key; `deepMerge` above already drops
 * undefined-valued entries from every layer, and this is the second belt for
 * the direct-`parseSettings` path. If another optional key is ever added to
 * `SettingsSchema`, normalize it here too.
 */
const withoutUndefinedOptionalKeys = (parsed: Settings): Settings => {
  const out: Settings = { ...parsed };
  if (out.ruleset === undefined) delete out.ruleset;
  return out;
};

const issuePath = (issue: v.BaseIssue<unknown>): string =>
  (issue.path ?? [])
    .map((item) => {
      const key: unknown = (item as { key?: unknown }).key;
      return typeof key === 'string' || typeof key === 'number' ? String(key) : '';
    })
    .filter((segment) => segment !== '')
    .join('.');

/** Cross-field constraints that a per-field schema cannot express. */
export const refineSettings = (s: Settings): Result<Settings, readonly SettingsIssue[]> => {
  const issues: SettingsIssue[] = [];
  const max = MAP_DIMENSIONS[s.mapSize].maxCivs;
  if (s.civCount > max) {
    issues.push({
      path: 'civCount',
      message: `mapSize "${s.mapSize}" supports at most ${String(max)} civilizations (got ${String(s.civCount)})`,
    });
  }
  return issues.length > 0 ? err(issues) : ok(s);
};

/** Parse unknown input into validated settings. Unknown keys are rejected. */
export const parseSettings = (input: unknown): Result<Settings, readonly SettingsIssue[]> => {
  const parsed = v.safeParse(SettingsSchema, input);
  if (!parsed.success) {
    return err(parsed.issues.map((i) => ({ path: issuePath(i), message: i.message })));
  }
  return refineSettings(withoutUndefinedOptionalKeys(parsed.output));
};

/**
 * Layered configuration: defaults, then each patch layer in order (file, CLI).
 * Pure, and specified by types rather than by convention.
 */
export const loadSettings = (
  ...layers: readonly (Record<string, unknown> | undefined)[]
): Result<Settings, readonly SettingsIssue[]> => {
  let acc: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const layer of layers) {
    if (layer !== undefined) acc = deepMerge(acc, layer);
  }
  return parseSettings(acc);
};
