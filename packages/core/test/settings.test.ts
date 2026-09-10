import { describe, expect, it } from 'vitest';
import { canonicalize, hashValue } from '@civts/testing';
import {
  DEFAULT_SETTINGS,
  MAP_DIMENSIONS,
  MAP_SIZES,
  loadSettings,
  parseSettings,
  type Settings,
} from '../src/index.js';

describe('settings parsing', () => {
  it('accepts the defaults', () => {
    const r = parseSettings(DEFAULT_SETTINGS);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, nope: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown nested keys', () => {
    const r = parseSettings({
      ...DEFAULT_SETTINGS,
      ai: { aggression: 0.5, expandFast: false, bogus: true },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a bare string where an enum is required', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, mapSize: 'gigantic' });
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-range aggression', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, ai: { aggression: 1.5, expandFast: false } });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-integer seed', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, seed: 1.5 });
    expect(r.ok).toBe(false);
  });
});

describe('settings cross-field refinement', () => {
  it('rejects civCount above the map capacity', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 8 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error[0]?.path).toBe('civCount');
      expect(r.error[0]?.message).toContain('at most 2');
    }
  });

  it('accepts civCount exactly at capacity', () => {
    const r = parseSettings({
      ...DEFAULT_SETTINGS,
      mapSize: 'small',
      civCount: MAP_DIMENSIONS.small.maxCivs,
    });
    expect(r.ok).toBe(true);
  });

  it('every map size can host at least two civilizations', () => {
    for (const size of MAP_SIZES) {
      expect(MAP_DIMENSIONS[size].maxCivs).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('layered settings', () => {
  it('later layers win, earlier values survive', () => {
    const r = loadSettings({ mapSize: 'small' }, { civCount: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mapSize).toBe('small');
      expect(r.value.civCount).toBe(3);
      expect(r.value.seed).toBe(DEFAULT_SETTINGS.seed);
    }
  });

  it('deep-merges nested objects without dropping siblings', () => {
    const r = loadSettings({ ai: { aggression: 0.9 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ai.aggression).toBe(0.9);
      expect(r.value.ai.expandFast).toBe(DEFAULT_SETTINGS.ai.expandFast);
    }
  });

  it('does not mutate the defaults object', () => {
    const before = structuredClone(DEFAULT_SETTINGS);
    loadSettings({ ai: { aggression: 0.1 } });
    expect(DEFAULT_SETTINGS).toEqual(before);
  });

  it('inherits defaults when no layers are supplied', () => {
    const r = loadSettings();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(DEFAULT_SETTINGS);
  });
});

describe('settings type surface', () => {
  it('exposes no stringly-typed option fields', () => {
    const s: Settings = DEFAULT_SETTINGS;
    const sizes: readonly string[] = [...MAP_SIZES];
    expect(sizes).toContain(s.mapSize);
  });
});

/* ------------------------------------------------------------------ *
 * Optional keys that arrive as an explicit `undefined`.
 *
 * `ruleset?: string` has exactly two states under `exactOptionalPropertyTypes`:
 * a string, or an absent key. "Present and undefined" is a third state that the
 * type does not describe, that `canonicalize` refuses, and that the natural CLI
 * wiring `loadSettings(config, { ruleset: flag.ruleset })` produces whenever the
 * flag is left out — so the parse pipeline must never emit it.
 * ------------------------------------------------------------------ */

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * The hasher is the honest oracle for "no own key holds `undefined`":
 * `canonicalize` refuses that value outright (it is not representable in
 * canonical JSON), so this fails exactly when a key is present-and-undefined.
 *
 * `JSON.stringify` cannot stand in for it — it *drops* an undefined-valued key,
 * so `JSON.stringify({ ruleset: undefined })` is `'{}'` and looks clean. That is
 * why the assertions below go through `canonicalize`/`hashValue` (and why the
 * later round-trip checks are only a secondary guard).
 */
const expectHashable = (value: unknown): void => {
  expect(canonicalize(value)).not.toContain('undefined');
  expect(hashValue(value)).toMatch(/^[0-9a-f]{16}$/);
};

/** Absent, not present-and-undefined: the key must not exist in any sense. */
const expectRulesetAbsent = (settings: Settings): void => {
  expectHashable(settings);
  expect(hasOwn(settings, 'ruleset')).toBe(false);
  expect('ruleset' in settings).toBe(false);
  expect(Object.keys(settings)).not.toContain('ruleset');
};

describe('settings: explicit undefined in the layer pipeline', () => {
  it('does not create a key when a layer spells an optional value out as undefined', () => {
    const r = loadSettings({ ruleset: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expectRulesetAbsent(r.value);
    // The result is the defaults, key for key: an unset optional adds nothing.
    expect(Object.keys(r.value).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('lets an explicit undefined fall through to the defaults for nested objects', () => {
    const whole = loadSettings({ ai: undefined });
    expect(whole.ok).toBe(true);
    if (whole.ok) {
      expect(whole.value.ai).toEqual(DEFAULT_SETTINGS.ai);
      expectHashable(whole.value);
      expectRulesetAbsent(whole.value);
    }

    const field = loadSettings({ ai: { aggression: undefined } });
    expect(field.ok).toBe(true);
    if (field.ok) {
      expect(field.value.ai.aggression).toBe(DEFAULT_SETTINGS.ai.aggression);
      expect(field.value.ai.expandFast).toBe(DEFAULT_SETTINGS.ai.expandFast);
      expectHashable(field.value);
      expectRulesetAbsent(field.value);
    }
  });

  it('does not let a later undefined layer erase a value an earlier layer set', () => {
    const kept = loadSettings({ ruleset: 'tuned' }, { ruleset: undefined });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.ruleset).toBe('tuned');
    expectHashable(kept.value);

    const nested = loadSettings({ ai: { aggression: 0.25 } }, { ai: { aggression: undefined } });
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.value.ai.aggression).toBe(0.25);
      expectHashable(nested.value);
    }
  });

  it('keeps a genuine optional value that is actually set', () => {
    const r = loadSettings({ ruleset: 'standard' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hasOwn(r.value, 'ruleset')).toBe(true);
    expect(r.value.ruleset).toBe('standard');
    expectHashable(r.value);
    expect(canonicalize(r.value)).toContain('"ruleset":"standard"');
  });
});

describe('settings: explicit undefined through parseSettings', () => {
  it('drops an explicitly undefined optional key from the parsed output', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, ruleset: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expectRulesetAbsent(r.value);
    // Secondary guard: serializing must not need to invent anything.
    expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  });

  it('keeps an explicitly set optional key', () => {
    const r = parseSettings({ ...DEFAULT_SETTINGS, ruleset: 'tuned' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ruleset).toBe('tuned');
    expectHashable(r.value);
  });

  it('produces hashable, JSON-round-trippable settings for every accepted shape', () => {
    const cases: readonly unknown[] = [
      DEFAULT_SETTINGS,
      { ...DEFAULT_SETTINGS, ruleset: undefined },
      { ...DEFAULT_SETTINGS, ruleset: 'standard' },
      { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
      { ...DEFAULT_SETTINGS, ai: { aggression: 0, expandFast: true } },
      { ...DEFAULT_SETTINGS, debug: { cheats: true, revealMap: true }, ruleset: undefined },
    ];

    for (const input of cases) {
      const r = parseSettings(input);
      expect(r.ok, `input ${JSON.stringify(input)}`).toBe(true);
      if (!r.ok) continue;
      expectHashable(r.value);
      expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
    }
  });

  it('still rejects unknown keys, including ones valued undefined', () => {
    // The fix must not be "strip undefined-valued input keys before parsing":
    // that would turn a typo in a config file into silence.
    expect(parseSettings({ ...DEFAULT_SETTINGS, bogus: undefined }).ok).toBe(false);
    expect(parseSettings({ ...DEFAULT_SETTINGS, nope: 1 }).ok).toBe(false);
    expect(
      parseSettings({
        ...DEFAULT_SETTINGS,
        ai: { aggression: 0.5, expandFast: false, bogus: undefined },
      }).ok,
    ).toBe(false);
    expect(
      parseSettings({
        ...DEFAULT_SETTINGS,
        debug: { cheats: false, revealMap: false, bogus: true },
      }).ok,
    ).toBe(false);
  });

  it('still enforces every range and enum constraint', () => {
    const rejected: readonly unknown[] = [
      { ...DEFAULT_SETTINGS, mapSize: 'gigantic' },
      { ...DEFAULT_SETTINGS, difficulty: 'god' },
      { ...DEFAULT_SETTINGS, fidelity: 'invented' },
      { ...DEFAULT_SETTINGS, civCount: 1 },
      { ...DEFAULT_SETTINGS, civCount: 2.5 },
      { ...DEFAULT_SETTINGS, civCount: 17 },
      { ...DEFAULT_SETTINGS, seed: 1.5 },
      { ...DEFAULT_SETTINGS, ruleset: 7 },
      { ...DEFAULT_SETTINGS, ai: { aggression: -0.1, expandFast: false } },
      { ...DEFAULT_SETTINGS, ai: { aggression: 1.1, expandFast: false } },
      { ...DEFAULT_SETTINGS, debug: { cheats: 'yes', revealMap: false } },
    ];

    for (const input of rejected) {
      expect(parseSettings(input).ok, `input ${JSON.stringify(input)}`).toBe(false);
    }

    // Boundaries stay accepted, so the rejections above are real constraints
    // rather than a blanket refusal.
    expect(parseSettings({ ...DEFAULT_SETTINGS, civCount: 2 }).ok).toBe(true);
    expect(parseSettings({ ...DEFAULT_SETTINGS, mapSize: 'huge', civCount: 16 }).ok).toBe(true);
    expect(parseSettings({ ...DEFAULT_SETTINGS, ai: { aggression: 0, expandFast: true } }).ok).toBe(
      true,
    );
    expect(parseSettings({ ...DEFAULT_SETTINGS, ai: { aggression: 1, expandFast: true } }).ok).toBe(
      true,
    );
    expect(parseSettings({ ...DEFAULT_SETTINGS, ruleset: '' }).ok).toBe(true);
  });

  it('still enforces the cross-field map capacity rule after normalization', () => {
    const r = parseSettings({
      ...DEFAULT_SETTINGS,
      mapSize: 'duel',
      civCount: 8,
      ruleset: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]?.path).toBe('civCount');
  });
});
