import { describe, expect, it } from 'vitest';
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
    const r = parseSettings({ ...DEFAULT_SETTINGS, ai: { aggression: 0.5, expandFast: false, bogus: true } });
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
    const r = parseSettings({ ...DEFAULT_SETTINGS, mapSize: 'small', civCount: MAP_DIMENSIONS.small.maxCivs });
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
