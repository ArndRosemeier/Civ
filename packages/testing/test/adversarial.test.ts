/**
 * W5 — adversarial review: falsification tests for the W1–W4 claims.
 * See `docs/INTERFACES.md` §W5 and `PLAN.md` §5.3 (determinism) / §10 (testing).
 *
 * This file is written by a reviewer who did not write the modules under test.
 * Every test here is an attempt to *break* a claim, not to confirm it. Each one
 * therefore names, in its own comment, the observation that would make it fail.
 *
 * Claims under test, and where they are checked:
 *
 * | Claim | Checked by |
 * |---|---|
 * | same seed ⇒ same state, in-process | `determinism` suite |
 * | same seed ⇒ same state, fresh process | `fresh process` test (spawns its own node) |
 * | the committed golden file really encodes this build's output | `golden file` suite |
 * | the golden *can* fail: inputs move the hash | `hash sensitivity` suite |
 * | terrain sanity / starts valid, distinct, on passable land | `terrain sanity` suite |
 * | pure integer RNG, unbiased `nextBelow`, deterministic `shuffle` | `rng` suite |
 * | FNV-1a 64 over UTF-8, canonical JSON, documented rejections | `canonical JSON` suite |
 * | the text renderer is a pure function of `(state, ruleset, options)` | `text renderer` suite |
 *
 * Findings that could **not** be turned into a passing vitest test are reported
 * in the W5 review summary instead — notably the eslint determinism-ban gaps
 * (the ban list does not cover `new Date()`, `Math.exp/tan/atan2/log2/hypot`, or
 * aliased `Math`) and the fact that the ban block only targets
 * `packages/core/src/**`.
 *
 * Two findings that *were* turned into tests have since been fixed in
 * `packages/core/src`: the unbounded `nextBelow` rejection loop for
 * `bound > 2 ** 32` (section 8) and the explicit-`undefined` optional settings
 * value that made a valid `Settings` unhashable (`settings boundary` suite).
 * Those tests now pin the corrected behaviour — a guard and a normalization —
 * rather than the defect, and the draw sequence for every supported bound is
 * pinned in `packages/core/test/rng.test.ts`.
 *
 * Nothing here writes to disk. The golden file is only read; one test asserts
 * its bytes are byte-identical before and after a full build-and-hash pass, so a
 * silently self-healing golden would show up here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAP_DIMENSIONS,
  MAP_SIZES,
  TERRAIN_ROLES,
  asTerrainId,
  describe as describeState,
  distance8,
  drawMany,
  loadSettings,
  neighbors8,
  newGame,
  nextBelow,
  nextInt,
  nextUint32,
  parseSettings,
  seedRng,
  shuffle,
  type GameMap,
  type GameState,
  type MapSize,
  type PlayerState,
  type RulesetView,
  type Settings,
  type TerrainDef,
  type TerrainId,
  type TerrainRole,
} from '@civts/core';
import { CATALOG, type TerrainSpec } from '@civts/rules';
import { canonicalize, fnv1a64, hashValue } from '../src/index.js';
import { goldensPath, loadGoldens } from '../src/goldens.js';

/* ------------------------------------------------------------------ *
 * Shared fixtures.
 *
 * The ruleset adapter duplicates the one in `golden.test.ts` deliberately: the
 * reviewer should not depend on the author's helper, and `TerrainSpec` has no
 * `role` field, so the role has to be derived from the id either way.
 * ------------------------------------------------------------------ */

const roleOf = (id: string): TerrainRole | undefined => TERRAIN_ROLES.find((role) => role === id);

const toTerrainDef = (spec: TerrainSpec): TerrainDef => {
  const role = roleOf(spec.id);
  if (role === undefined) {
    throw new Error(`rules terrain "${spec.id}" names no known terrain role`);
  }
  return {
    id: spec.id,
    role,
    name: spec.name,
    moveCost: spec.moveCost,
    defenseBonusPct: spec.defenseBonusPct,
    yields: spec.yields,
    impassable: spec.impassable,
  };
};

const RULESET: RulesetView = { terrains: CATALOG.terrains.map(toTerrainDef), fidelity: 'tuned' };
const ROLE_BY_ID: ReadonlyMap<TerrainId, TerrainRole> = new Map(
  RULESET.terrains.map((terrain) => [terrain.id, terrain.role] as const),
);
const PASSABLE_BY_ID: ReadonlyMap<TerrainId, boolean> = new Map(
  RULESET.terrains.map((terrain) => [terrain.id, !terrain.impassable] as const),
);

const WATER_ROLES: ReadonlySet<TerrainRole> = new Set<TerrainRole>(['ocean', 'coast']);
const LAND_ROLES: ReadonlySet<TerrainRole> = new Set<TerrainRole>([
  'grassland',
  'plains',
  'hills',
  'mountains',
]);

const settingsFor = (mapSize: MapSize, civCount: number, seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  mapSize,
  civCount,
  seed,
});

const mustState = (mapSize: MapSize, civCount: number, seed: number): GameState => {
  const result = newGame(seed, settingsFor(mapSize, civCount, seed), RULESET);
  if (!result.ok) {
    throw new Error(
      `newGame(${String(seed)}, ${mapSize}, civs=${String(civCount)}) failed: ${result.error.kind}`,
    );
  }
  return result.value;
};

const roleAt = (map: GameMap, index: number): TerrainRole | undefined => {
  const id = map.terrain[index];
  return id === undefined ? undefined : ROLE_BY_ID.get(id);
};

const isWaterAt = (map: GameMap, index: number): boolean => {
  const role = roleAt(map, index);
  return role !== undefined && WATER_ROLES.has(role);
};

const waterTileCount = (map: GameMap): number => {
  let water = 0;
  for (let i = 0; i < map.terrain.length; i += 1) {
    if (isWaterAt(map, i)) water += 1;
  }
  return water;
};

const playerAt = (state: GameState, index: number): PlayerState => {
  const player = state.players[index];
  if (player === undefined) throw new Error(`state has no player at index ${String(index)}`);
  return player;
};

const tileAt = (state: GameState, index: number): TerrainId => {
  const id = state.map.terrain[index];
  if (id === undefined) throw new Error(`state has no tile at index ${String(index)}`);
  return id;
};

const indexOfRole = (state: GameState, role: TerrainRole): number => {
  const index = state.map.terrain.findIndex((id) => ROLE_BY_ID.get(id) === role);
  if (index < 0) throw new Error(`map has no ${role} tile`);
  return index;
};

const withTileReplaced = (state: GameState, index: number, terrainId: TerrainId): GameState => ({
  ...state,
  map: {
    ...state.map,
    terrain: state.map.terrain.map((id, i) => (i === index ? terrainId : id)),
  },
});

const startTiles = (state: GameState): readonly number[] =>
  state.players.map((player) => Number(player.startingTile));

const minStartDistance = (state: GameState): number => {
  const starts = startTiles(state);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < starts.length; i += 1) {
    for (let j = i + 1; j < starts.length; j += 1) {
      const a = starts[i];
      const b = starts[j];
      if (a === undefined || b === undefined) continue;
      min = Math.min(min, distance8(state.map, a, b));
    }
  }
  return min;
};

const HASH_PATTERN = /^[0-9a-f]{16}$/;

const runningNodeMajor = (): number => {
  const major = process.versions.node.split('.')[0];
  return major === undefined ? Number.NaN : Number.parseInt(major, 10);
};

/* ------------------------------------------------------------------ *
 * Fresh-process machinery.
 *
 * A child node process is the only honest way to show that determinism is not
 * an artefact of this process's module instances. `tsx` is resolved through the
 * root `node_modules` (it is a root devDependency) rather than through `npx`,
 * so no package manager or network is involved.
 * ------------------------------------------------------------------ */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const tsxCliPath = (): string => {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
};

/** Run `script` in a brand-new node process; returns its stdout. */
const runFreshProcess = (script: string, timeoutMs: number): string =>
  execFileSync(process.execPath, [tsxCliPath(), '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
  });

interface HashCase {
  readonly mapSize: MapSize;
  readonly civCount: number;
  readonly seed: number;
}

/**
 * Cases shared with the child process. Deliberately includes a second map size
 * and a different civilization count, so the cross-process claim is not just
 * "seed 42 on one map works twice".
 */
const HASH_CASES: readonly HashCase[] = [
  { mapSize: 'tiny', civCount: 2, seed: 1 },
  { mapSize: 'tiny', civCount: 2, seed: 42 },
  { mapSize: 'tiny', civCount: 2, seed: 1337 },
  { mapSize: 'tiny', civCount: 2, seed: 9999 },
  { mapSize: 'tiny', civCount: 4, seed: 7 },
  { mapSize: 'duel', civCount: 2, seed: 42 },
  { mapSize: 'small', civCount: 2, seed: 42 },
];

const caseKey = (testCase: HashCase): string =>
  `${testCase.mapSize}|${String(testCase.civCount)}|${String(testCase.seed)}`;

const inProcessHashes = (): ReadonlyMap<string, string> =>
  new Map(
    HASH_CASES.map(
      (testCase) =>
        [
          caseKey(testCase),
          hashValue(mustState(testCase.mapSize, testCase.civCount, testCase.seed)),
        ] as const,
    ),
  );

/**
 * The child re-derives everything from `@civts/core` + `@civts/rules` and prints
 * one line per case. Paths resolve through the repo `tsconfig.json` because the
 * child's cwd is the repo root.
 */
const freshProcessScript = (cases: readonly HashCase[]): string => `
(async () => {
  const { newGame, DEFAULT_SETTINGS, TERRAIN_ROLES } = await import('@civts/core');
  const { CATALOG } = await import('@civts/rules');
  const { hashValue } = await import('@civts/testing');
  const roleOf = (id) => TERRAIN_ROLES.find((role) => role === id);
  const ruleset = {
    terrains: CATALOG.terrains.map((t) => ({
      id: t.id, role: roleOf(t.id), name: t.name, moveCost: t.moveCost,
      defenseBonusPct: t.defenseBonusPct, yields: t.yields, impassable: t.impassable,
    })),
    fidelity: 'tuned',
  };
  console.log('pid ' + String(process.pid));
  for (const c of ${JSON.stringify(cases)}) {
    const result = newGame(c.seed, { ...DEFAULT_SETTINGS, mapSize: c.mapSize, civCount: c.civCount, seed: c.seed }, ruleset);
    console.log(c.mapSize + ' ' + String(c.civCount) + ' ' + String(c.seed) + ' ' + (result.ok ? hashValue(result.value) : 'SETUP-ERROR'));
  }
})().catch((cause) => { console.error(String(cause)); process.exit(1); });
`;

const asMapSize = (value: string): MapSize => {
  const found = MAP_SIZES.find((size) => size === value);
  if (found === undefined) throw new Error(`child reported unknown map size "${value}"`);
  return found;
};

interface ParsedChildLine extends HashCase {
  readonly hash: string;
}

const parseChildLine = (line: string): ParsedChildLine => {
  const match = /^(\S+) (\d+) (-?\d+) (\S+)$/.exec(line);
  if (match === null) throw new Error(`unrecognised child output: ${JSON.stringify(line)}`);
  const [, mapSize, civCount, seed, hash] = match;
  if (mapSize === undefined || civCount === undefined || seed === undefined || hash === undefined) {
    throw new Error(`unrecognised child output: ${JSON.stringify(line)}`);
  }
  return { mapSize: asMapSize(mapSize), civCount: Number(civCount), seed: Number(seed), hash };
};

/* ================================================================== *
 * 1. Determinism
 * ================================================================== */

describe('adversarial: determinism', () => {
  it('builds the same state twice in-process (hashes, terrain and players)', () => {
    for (const testCase of HASH_CASES) {
      const first = mustState(testCase.mapSize, testCase.civCount, testCase.seed);
      const second = mustState(testCase.mapSize, testCase.civCount, testCase.seed);

      expect(hashValue(second)).toBe(hashValue(first));
      expect(second.map.terrain).toEqual(first.map.terrain);
      expect(second.players).toEqual(first.players);
      expect(second.rng).toEqual(first.rng);
    }
  });

  it('a fresh node process reproduces the same hashes', () => {
    // FAILS IF: generation, hashing or the ruleset adapter depends on anything
    // per-process (module instance, cwd, locale, insertion order, ambient state).
    const stdout = runFreshProcess(freshProcessScript(HASH_CASES), 120_000);
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    const pidLine = lines[0];
    expect(pidLine).toMatch(/^pid \d+$/);
    if (pidLine === undefined || !pidLine.startsWith('pid ')) {
      throw new Error(`child did not report its pid, got: ${JSON.stringify(stdout)}`);
    }
    // A separate process is the whole point of this check.
    expect(Number(pidLine.slice('pid '.length))).not.toBe(process.pid);

    const fromChild = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const parsed = parseChildLine(line);
      expect(parsed.hash).toMatch(HASH_PATTERN);
      fromChild.set(caseKey(parsed), parsed.hash);
    }

    const inProcess = inProcessHashes();
    expect(fromChild.size).toBe(HASH_CASES.length);
    for (const testCase of HASH_CASES) {
      const key = caseKey(testCase);
      expect(fromChild.get(key)).toBe(inProcess.get(key));
    }
  });

  it('hashes independently of key insertion order', () => {
    // FAILS IF: canonicalization stops sorting keys (then an object rebuilt in a
    // different order would hash differently, and saves would stop matching).
    const state = mustState('tiny', 2, 42);
    const reordered: GameState = {
      players: state.players,
      map: state.map,
      rng: state.rng,
      settings: state.settings,
      seed: state.seed,
      turn: state.turn,
      revision: state.revision,
      schemaVersion: state.schemaVersion,
    };
    expect(hashValue(reordered)).toBe(hashValue(state));
  });

  it('keeps the committed goldens on this build', () => {
    // FAILS IF: the committed hashes no longer describe this engine — the golden
    // suite would already be red, and this states the reviewer's own numbers.
    const stored = loadGoldens();
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    expect(stored.nodeMajor).toBe(runningNodeMajor());

    const byName = new Map(stored.entries.map((entry) => [entry.name, entry.hash] as const));
    for (const seed of [1, 42, 1337]) {
      const name = `tiny-civs2-seed${String(seed)}`;
      expect(byName.get(name)).toBe(hashValue(mustState('tiny', 2, seed)));
    }
  });

  it('does not write to the golden file while building and hashing states', () => {
    // FAILS IF: a read path gains a side effect (a golden that rewrites itself
    // cannot fail, so this is a real property, not a formality).
    const before = readFileSync(goldensPath(), 'utf8');
    for (const testCase of HASH_CASES) {
      hashValue(mustState(testCase.mapSize, testCase.civCount, testCase.seed));
    }
    expect(readFileSync(goldensPath(), 'utf8')).toBe(before);
  });
});

/* ================================================================== *
 * 2. Hash sensitivity — the golden can actually fail
 * ================================================================== */

describe('adversarial: hash sensitivity (non-vacuous golden)', () => {
  it('changes when an input changes: seed, map size, civ count', () => {
    // FAILS IF: the digest ignores an input, e.g. reads the map but not the
    // settings, or folds distinct worlds onto one hash.
    const baseline = hashValue(mustState('tiny', 2, 42));

    expect(hashValue(mustState('tiny', 2, 43))).not.toBe(baseline);
    expect(hashValue(mustState('tiny', 3, 42))).not.toBe(baseline);
    expect(hashValue(mustState('duel', 2, 42))).not.toBe(baseline);
    expect(hashValue(mustState('small', 2, 42))).not.toBe(baseline);
  });

  it('changes for every independent field of the state', () => {
    // FAILS IF: a field is dropped from canonicalization (a save could then
    // differ from the state it was hashed from without anyone noticing).
    const state = mustState('tiny', 2, 42);
    const baseline = hashValue(state);
    const first = playerAt(state, 0);

    const mutations: readonly (readonly [string, GameState])[] = [
      ['turn + 1', { ...state, turn: state.turn + 1 }],
      ['revision + 1', { ...state, revision: state.revision + 1 }],
      ['schemaVersion + 1', { ...state, schemaVersion: state.schemaVersion + 1 }],
      ['seed + 1', { ...state, seed: state.seed + 1 }],
      ['rng.a flipped', { ...state, rng: { ...state.rng, a: (state.rng.a ^ 1) | 0 } }],
      ['rng.d + 1', { ...state, rng: { ...state.rng, d: state.rng.d + 1 } }],
      ['settings.civCount + 1', { ...state, settings: { ...state.settings, civCount: 3 } }],
      [
        'settings.ai.aggression 0.5 -> 0.51',
        { ...state, settings: { ...state.settings, ai: { ...state.settings.ai, aggression: 0.51 } } },
      ],
      [
        'settings.mapSize tiny -> duel (map unchanged)',
        { ...state, settings: { ...state.settings, mapSize: 'duel' } },
      ],
      ['map.width + 1 (terrain unchanged)', { ...state, map: { ...state.map, width: 61 } }],
      ['map.height + 1 (terrain unchanged)', { ...state, map: { ...state.map, height: 61 } }],
      [
        'terrain array rotated by one',
        { ...state, map: { ...state.map, terrain: [...state.map.terrain.slice(1), tileAt(state, 0)] } },
      ],
      [
        'players[0].name changed',
        {
          ...state,
          players: [{ ...first, name: `${first.name} II` }, ...state.players.slice(1)],
        },
      ],
      [
        'players[0].color changed',
        { ...state, players: [{ ...first, color: '#ffffff' }, ...state.players.slice(1)] },
      ],
      [
        'players swapped',
        { ...state, players: [...state.players].reverse() },
      ],
    ];

    for (const [label, mutated] of mutations) {
      expect(hashValue(mutated), `mutation "${label}" did not move the hash`).not.toBe(baseline);
    }
  });

  it('changes for a single terrain tile, whatever the tile is', () => {
    // FAILS IF: the hash only covers a map summary (e.g. counts) instead of the
    // full terrain array.
    const state = mustState('tiny', 2, 42);
    const baseline = hashValue(state);

    const cases: readonly (readonly [TerrainRole, TerrainRole])[] = [
      ['grassland', 'plains'],
      ['plains', 'grassland'],
      ['hills', 'mountains'],
      ['mountains', 'hills'],
      ['ocean', 'coast'],
      ['coast', 'ocean'],
    ];

    let checked = 0;
    for (const [from, to] of cases) {
      const index = indexOfRole(state, from);
      const replaced = withTileReplaced(state, index, asTerrainId(to));
      expect(replaced.map.terrain[index]).not.toBe(state.map.terrain[index]);
      expect(
        hashValue(replaced),
        `tile ${String(index)} ${from} -> ${to} did not move the hash`,
      ).not.toBe(baseline);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it('does not depend on array identity for equal content', () => {
    // FAILS IF: the hash becomes identity-based (e.g. via a WeakMap or a counter),
    // which would make two logically identical states hash differently.
    const state = mustState('tiny', 2, 42);
    const clone: GameState = {
      ...state,
      map: { ...state.map, terrain: [...state.map.terrain] },
      players: state.players.map((player) => ({ ...player })),
      settings: { ...state.settings, ai: { ...state.settings.ai }, debug: { ...state.settings.debug } },
      rng: { ...state.rng },
    };
    expect(hashValue(clone)).toBe(hashValue(state));
  });

  it('gives distinct hashes to distinct seeds across a sweep', () => {
    // FAILS IF: the seed stops reaching the generator (all seeds one world), or
    // the digest is coarse enough to collide inside 60 samples.
    const hashes = new Set<string>();
    for (let seed = 0; seed < 60; seed += 1) {
      hashes.add(hashValue(mustState('tiny', 4, seed)));
    }
    expect(hashes.size).toBe(60);
  });
});

/* ================================================================== *
 * 3. Terrain sanity
 * ================================================================== */

const SANITY_SEEDS = [1, 42, 1337, 9999] as const;

describe('adversarial: terrain sanity', () => {
  it('keeps the water fraction inside a believable band, and stable across seeds', () => {
    // FAILS IF: sea level stops being a quantile (a magic elevation constant
    // would give wildly different land ratios per seed, or a flooded world).
    const fractions: number[] = [];
    for (const seed of SANITY_SEEDS) {
      const state = mustState('tiny', 4, seed);
      const tiles = state.map.terrain.length;
      expect(tiles).toBe(MAP_DIMENSIONS.tiny.width * MAP_DIMENSIONS.tiny.height);

      const water = waterTileCount(state.map);
      const fraction = water / tiles;
      fractions.push(fraction);

      expect(fraction, `seed ${String(seed)} water fraction`).toBeGreaterThanOrEqual(0.4);
      expect(fraction, `seed ${String(seed)} water fraction`).toBeLessThanOrEqual(0.8);
      expect(tiles - water, `seed ${String(seed)} land tiles`).toBeGreaterThan(0);
    }

    const spread = Math.max(...fractions) - Math.min(...fractions);
    expect(spread, 'land ratio should be stable across seeds').toBeLessThanOrEqual(0.02);
  });

  it('uses only known roles, and only water roles for water tiles', () => {
    for (const seed of SANITY_SEEDS) {
      const state = mustState('tiny', 4, seed);
      for (let i = 0; i < state.map.terrain.length; i += 1) {
        const role = roleAt(state.map, i);
        expect(role, `tile ${String(i)} has a terrain id outside the ruleset`).toBeDefined();
        if (role !== undefined) {
          expect(WATER_ROLES.has(role) || LAND_ROLES.has(role)).toBe(true);
        }
      }
    }
  });

  it('classifies water exactly as the second pass claims: coast iff touching land', () => {
    // FAILS IF: the coast pass is skipped, off by one, or uses 4-way adjacency.
    for (const seed of SANITY_SEEDS) {
      const state = mustState('tiny', 4, seed);
      const map = state.map;

      for (let i = 0; i < map.terrain.length; i += 1) {
        const role = roleAt(map, i);
        if (role === undefined || !WATER_ROLES.has(role)) continue;

        const touchesLand = neighbors8(map, i).some((neighbour) => {
          const neighbourRole = roleAt(map, neighbour);
          return neighbourRole !== undefined && !WATER_ROLES.has(neighbourRole);
        });

        if (touchesLand) {
          expect(role, `water tile ${String(i)} touches land but is "${role}"`).toBe('coast');
        } else {
          expect(role, `water tile ${String(i)} touches no land but is "${role}"`).toBe('ocean');
        }
      }
    }
  });

  it('produces starts that are valid, distinct and on passable land', () => {
    // FAILS IF: the greedy max-min spread picks a duplicate, a water tile, an
    // impassable tile, or honours a different count than requested.
    for (const seed of SANITY_SEEDS) {
      const state = mustState('tiny', 4, seed);
      const starts = startTiles(state);

      expect(starts).toHaveLength(4);
      expect(new Set(starts).size).toBe(4);
      expect(minStartDistance(state)).toBeGreaterThan(1);

      for (const start of starts) {
        const role = roleAt(state.map, start);
        expect(role, `start ${String(start)} is not on the map`).toBeDefined();
        expect(role !== undefined && LAND_ROLES.has(role), `start ${String(start)} role ${String(role)}`).toBe(true);
        expect(PASSABLE_BY_ID.get(tileAt(state, start)), `start ${String(start)} passability`).toBe(true);
      }
    }
  });

  it('holds those invariants over a wider sweep and across map sizes', () => {
    // FAILS IF: a rare seed reaches a degenerate path — the start spread failing,
    // a tiny island being chosen, or the quantile flooding everything.
    let checked = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const state = mustState('tiny', 4, seed);
      const starts = startTiles(state);
      expect(starts).toHaveLength(4);
      expect(new Set(starts).size).toBe(4);
      expect(minStartDistance(state)).toBeGreaterThan(1);
      for (const start of starts) {
        expect(PASSABLE_BY_ID.get(tileAt(state, start))).toBe(true);
        const role = roleAt(state.map, start);
        expect(role !== undefined && LAND_ROLES.has(role)).toBe(true);
      }
      const water = waterTileCount(state.map);
      expect(water).toBeGreaterThan(0);
      expect(water).toBeLessThan(state.map.terrain.length);
      checked += 1;
    }

    const sizes: readonly (readonly [MapSize, number])[] = [
      ['duel', 2],
      ['tiny', 4],
      ['small', 6],
    ];
    for (const [mapSize, civCount] of sizes) {
      const state = mustState(mapSize, civCount, 42);
      expect(state.players).toHaveLength(civCount);
      expect(minStartDistance(state)).toBeGreaterThan(1);
    }

    expect(checked).toBe(40);
  });

  it('accepts a civilization count beyond the map size capacity (capacity is only checked in settings)', () => {
    // OBSERVED BEHAVIOUR, not a bug claim: `MAP_DIMENSIONS[mapSize].maxCivs` is
    // enforced by `refineSettings`/`parseSettings`, not by `newGame`, so a caller
    // that hand-builds `Settings` can exceed the documented capacity. FAILS IF
    // newGame starts rejecting it (then the cheap settings-boundary check below
    // is the only guard, which is worth knowing).
    const capacity = MAP_DIMENSIONS.duel.maxCivs;
    expect(capacity).toBe(2);

    const state = mustState('duel', 16, 3);
    expect(state.players).toHaveLength(16);

    const parsed = parseSettings({ ...settingsFor('duel', 16, 3) });
    expect(parsed.ok).toBe(false);
  });
});

/* ================================================================== *
 * 4. RNG
 * ================================================================== */

describe('adversarial: seeded RNG', () => {
  it('is a pure function of its state', () => {
    // FAILS IF: a draw mutates hidden state or reads ambient entropy — either
    // would make replays irreproducible.
    const state = seedRng(42);

    const firstUint = nextUint32(state);
    const secondUint = nextUint32(state);
    expect(secondUint[0]).toBe(firstUint[0]);
    expect(secondUint[1]).toEqual(firstUint[1]);

    const firstBelow = nextBelow(state, 7);
    const secondBelow = nextBelow(state, 7);
    expect(secondBelow[0]).toBe(firstBelow[0]);
    expect(secondBelow[1]).toEqual(firstBelow[1]);

    const firstMany = drawMany(state, 5, 100);
    const secondMany = drawMany(state, 5, 100);
    expect(secondMany[0]).toEqual(firstMany[0]);
    expect(secondMany[1]).toEqual(firstMany[1]);

    const firstShuffle = shuffle(state, [1, 2, 3, 4, 5, 6, 7]);
    const secondShuffle = shuffle(state, [1, 2, 3, 4, 5, 6, 7]);
    expect(secondShuffle[0]).toEqual(firstShuffle[0]);
    expect(secondShuffle[1]).toEqual(firstShuffle[1]);
  });

  it('emits integers only, inside the documented ranges', () => {
    // FAILS IF: a float or a negative number appears in the stream — that is a
    // determinism hazard on reload, since floats have no integer round-trip.
    let state = seedRng(31337);
    for (let i = 0; i < 5000; i += 1) {
      const draw = nextUint32(state);
      state = draw[1];
      expect(Number.isInteger(draw[0])).toBe(true);
      expect(draw[0]).toBeGreaterThanOrEqual(0);
      expect(draw[0]).toBeLessThan(4294967296);
    }

    let intState = seedRng(5);
    for (let i = 0; i < 2000; i += 1) {
      const draw = nextInt(intState, -5, 5);
      intState = draw[1];
      expect(Number.isInteger(draw[0])).toBe(true);
      expect(draw[0]).toBeGreaterThanOrEqual(-5);
      expect(draw[0]).toBeLessThanOrEqual(5);
    }

    let belowState = seedRng(6);
    for (let i = 0; i < 2000; i += 1) {
      const draw = nextBelow(belowState, 3);
      belowState = draw[1];
      expect(draw[0]).toBeGreaterThanOrEqual(0);
      expect(draw[0]).toBeLessThan(3);
    }
  });

  it('rejects a non-positive bound and consumes nothing for bound 1', () => {
    const state = seedRng(1);
    expect(() => nextBelow(state, 0)).toThrow(RangeError);
    expect(() => nextBelow(state, -1)).toThrow(RangeError);
    expect(() => nextBelow(state, 1.5)).toThrow(RangeError);
    expect(() => nextInt(state, 5, 4)).toThrow(RangeError);

    const unit = nextBelow(state, 1);
    expect(unit[0]).toBe(0);
    expect(unit[1]).toEqual(state);
  });

  it('is uniform enough for a small modulus (30000 draws of 3)', () => {
    // FAILS IF: rejection sampling is wrong (a modulo bias of the classic
    // `% bound` kind shows up as a spread of several hundred here).
    // Deterministic: the draw sequence is fixed, so this cannot flake.
    const counts = [0, 0, 0];
    let state = seedRng(1234);
    const draws = 30000;
    for (let i = 0; i < draws; i += 1) {
      const draw = nextBelow(state, 3);
      state = draw[1];
      const bucket = counts[draw[0]];
      counts[draw[0]] = bucket === undefined ? 1 : bucket + 1;
    }

    const expected = draws / 3;
    for (const count of counts) {
      expect(Math.abs(count - expected)).toBeLessThan(expected * 0.04);
    }
  });

  it('shuffles deterministically into a permutation', () => {
    // FAILS IF: Fisher-Yates swaps the wrong indices (duplicates or losses).
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const [shuffled] = shuffle(seedRng(99), items);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(shuffled).not.toEqual(items);
  });

  it('expands distinct integer seeds into distinct states', () => {
    // FAILS IF: the seed expansion is degenerate (e.g. ignores the seed for
    // small values, or collapses many seeds onto one state).
    const states = new Set<string>();
    for (let seed = 0; seed < 2000; seed += 1) {
      states.add(JSON.stringify(seedRng(seed)));
    }
    expect(states.size).toBe(2000);
  });
});

/* ================================================================== *
 * 5. Canonical JSON + FNV-1a 64
 * ================================================================== */

/** Independent UTF-8 encoder + FNV-1a 64 loop, used to cross-check `fnv1a64`. */
const referenceFnv1a64 = (text: string): string => {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (codePoint < 0x80) bytes.push(codePoint);
    else if (codePoint < 0x800) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
};

describe('adversarial: canonical JSON + FNV-1a 64', () => {
  it('matches the published FNV-1a 64 vectors', () => {
    // FAILS IF: the offset basis, the prime or the xor/multiply order is wrong.
    // Vectors: offset basis for "", plus the canonical "" / "a" / "b" / "foobar"
    // values published with the FNV reference implementation.
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('b')).toBe('af63df4c8601f1a5');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('hashes UTF-8 bytes, cross-checked against an independent encoder', () => {
    // FAILS IF: the implementation hashes UTF-16 code units instead of UTF-8
    // (then multi-byte characters hash differently on the two paths).
    for (const text of ['', 'a', 'ab', '\u00e9', '\u65e5\u672c\u8a9e', '\u{1f642}', 'a\u0000b']) {
      expect(fnv1a64(text), `fnv1a64(${JSON.stringify(text)})`).toBe(referenceFnv1a64(text));
    }
  });

  it('maps lone surrogates to U+FFFD, but keeps state hashes distinct', () => {
    // OBSERVED BEHAVIOUR (WHATWG TextEncoder replaces lone surrogates): a raw
    // `fnv1a64('\ud800')` collides with `fnv1a64('\ufffd')`. State hashing is not
    // affected, because `canonicalize` JSON-escapes lone surrogates first — this
    // test pins both halves so a change in either is visible.
    expect(fnv1a64('\ud800')).toBe(fnv1a64('\ufffd'));
    expect(hashValue({ s: '\ud800' })).not.toBe(hashValue({ s: '\ufffd' }));
    expect(canonicalize({ s: '\ud800' })).not.toBe(canonicalize({ s: '\ufffd' }));
  });

  it('sorts keys recursively but preserves array order', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ outer: { a: 1, b: 2 } })).toBe(hashValue({ outer: { b: 2, a: 1 } }));
    expect(hashValue([1, 2, 3])).not.toBe(hashValue([3, 2, 1]));
    expect(canonicalize({ b: 1, a: [2, 3] })).toBe('{"a":[2,3],"b":1}');
  });

  it('escapes strings so no value can forge the surrounding structure', () => {
    // FAILS IF: string values are interpolated without JSON quoting, in which
    // case a value containing `","b":` could impersonate another object.
    const forged = { a: '1","b":2' };
    expect(canonicalize(forged)).not.toBe(canonicalize({ a: '1', b: 2 }));
    expect(hashValue(forged)).not.toBe(hashValue({ a: '1', b: 2 }));
    expect(hashValue({ a: '1' })).not.toBe(hashValue({ a: 1 }));
    expect(hashValue(['1'])).not.toBe(hashValue([1]));
  });

  it('rejects everything that is not plain data', () => {
    // FAILS IF: a non-plain value is silently coerced (JSON.stringify would drop
    // undefined and null NaN), because then two different states could hash alike.
    expect(() => canonicalize(undefined)).toThrow(/undefined/);
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalize(Number.NaN)).toThrow(/NaN/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(/-Infinity/);
    expect(() => canonicalize({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalize({ a: Symbol('x') })).toThrow(/symbol/);
    expect(() => canonicalize({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalize(new Date(0))).toThrow(/unsupported object type/);
    expect(() => canonicalize(new (class Foo { readonly a = 1; })())).toThrow(
      /unsupported object type/,
    );
    expect(() => canonicalize(Object.create({ inherited: 1 }))).toThrow(/unsupported object type/);
    expect(() => canonicalize([1, undefined, 3])).toThrow(/undefined/);

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => canonicalize(circular)).toThrow(/circular/);
  });

  it('rejects accessor properties instead of invoking them (the accessor hole, since closed)', () => {
    // FINDING, NOW CLOSED IN `canonical.ts`. This test used to pin the opposite
    // behaviour: `canonicalize` claims state must be plain data and rejects class
    // instances and exotic prototypes — but an object literal with a getter has
    // `Object.prototype` as its prototype, so it was accepted and the getter was
    // *called*. An impure getter therefore made `hashValue` return different
    // digests for the same object, a determinism hole the hasher could not see.
    // `canonicalize` now inspects each property descriptor before reading the
    // value, so a getter is rejected by shape and never runs.
    // FAILS IF: a getter is invoked again (then `calls` moves), or the rejection
    // is dropped for either entry point.
    let calls = 0;
    const impure = {
      get v(): number {
        calls += 1;
        return calls;
      },
    };

    expect(() => canonicalize(impure)).toThrow(/accessor/);
    expect(() => hashValue(impure)).toThrow(/accessor/);
    expect(calls).toBe(0);

    // Nested, and reached through an enclosing plain object.
    expect(() => canonicalize({ outer: impure })).toThrow(/accessor/);
    expect(calls).toBe(0);

    // A setter-only property is rejected too: `Object.keys` yields it, and
    // reading it inside canonicalize would have looked innocent.
    let written = 0;
    const withSetter = {
      set v(_value: number) {
        written += 1;
      },
    };
    expect(() => canonicalize(withSetter)).toThrow(/accessor/);
    expect(written).toBe(0);
  });

  it('documents the other blind spots: -0, typed arrays, non-enumerable keys', () => {
    // All three are intentional (documented in `canonical.ts`) but each means two
    // non-identical JavaScript values share a digest. Recorded so the claim
    // "distinct values hash differently" is not read as stronger than it is.
    expect(hashValue({ x: -0 })).toBe(hashValue({ x: 0 }));
    expect(hashValue({ a: new Int32Array([1, 2]) })).toBe(hashValue({ a: [1, 2] }));

    const hidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(hidden, 'invisible', { value: 99, enumerable: false });
    expect(hashValue(hidden)).toBe(hashValue({ a: 1 }));
  });

  it('produces a 16-character lowercase digest for arbitrary values', () => {
    for (const value of [null, true, false, 0, -1, 'x', [1, 2, 3], { a: { b: [null] } }]) {
      expect(hashValue(value)).toMatch(HASH_PATTERN);
    }
  });
});

/* ================================================================== *
 * 6. Settings boundary
 * ================================================================== */

describe('adversarial: settings boundary', () => {
  it('returns typed errors instead of throwing for hostile rulesets', () => {
    // FAILS IF: a generation failure escapes as an exception — the CLI and the
    // goldens are written against `Result`, not against stack traces.
    const missingAll: RulesetView = { terrains: [], fidelity: 'tuned' };
    const missingMountains: RulesetView = {
      terrains: RULESET.terrains.filter((terrain) => terrain.role !== 'mountains'),
      fidelity: 'tuned',
    };
    const landImpassable: RulesetView = {
      terrains: RULESET.terrains.map((terrain) =>
        WATER_ROLES.has(terrain.role) ? terrain : { ...terrain, impassable: true },
      ),
      fidelity: 'tuned',
    };
    const seaPassable: RulesetView = {
      terrains: RULESET.terrains.map((terrain) => ({
        ...terrain,
        impassable: !WATER_ROLES.has(terrain.role),
      })),
      fidelity: 'tuned',
    };

    const settings = settingsFor('tiny', 4, 5);

    expect(() => newGame(5, settings, missingAll)).not.toThrow();
    const all = newGame(5, settings, missingAll);
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.error.kind).toBe('missing-terrain-role');

    expect(() => newGame(5, settings, missingMountains)).not.toThrow();
    const mountains = newGame(5, settings, missingMountains);
    expect(mountains.ok).toBe(false);
    if (!mountains.ok) expect(mountains.error.kind).toBe('missing-terrain-role');

    const impassable = newGame(5, settings, landImpassable);
    expect(impassable.ok).toBe(false);
    if (!impassable.ok) expect(impassable.error.kind).toBe('no-valid-starts');

    const sea = newGame(5, settings, seaPassable);
    expect(sea.ok).toBe(false);
    if (!sea.ok) expect(sea.error.kind).toBe('no-valid-starts');
  });

  it('does not mutate the settings or the ruleset it is given', () => {
    // FAILS IF: generation sorts or rewrites the caller's arrays in place, which
    // would make the second call with the same objects behave differently.
    const settings = settingsFor('tiny', 4, 11);
    const before = JSON.stringify({ settings, terrains: RULESET.terrains });

    mustState('tiny', 4, 11);
    mustState('small', 6, 12);

    expect(JSON.stringify({ settings, terrains: RULESET.terrains })).toBe(before);
  });

  it('does not keep an explicit undefined optional value (the undefined-ruleset trap, fixed)', () => {
    // FINDING, NOW FIXED. `Settings.ruleset` is optional, and a *layer* that
    // spells it out as undefined — the natural
    // `loadSettings(config, { ruleset: flag.ruleset })` wiring, when the flag is
    // absent — used to survive validation with the key present:
    //   loadSettings({ ruleset: undefined }) -> ok, but `'ruleset' in value`
    // The state built from it was fine, yet `canonicalize` refuses undefined, so
    // `hashValue(state)` threw and took down the golden/replay path.
    // FAILS IF: the key comes back present-and-undefined, if a genuinely set
    // ruleset stops reaching the state, or if normalization perturbs the
    // ordinary path — the committed golden hash below would move.
    const layered = loadSettings({ mapSize: 'tiny', civCount: 2, seed: 42, ruleset: undefined });
    expect(layered.ok).toBe(true);
    if (!layered.ok) return;
    expect(Object.prototype.hasOwnProperty.call(layered.value, 'ruleset')).toBe(false);

    const state = newGame(42, layered.value, RULESET);
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    expect(() => canonicalize(layered.value)).not.toThrow();
    expect(() => hashValue(state.value)).not.toThrow();
    expect(hashValue(state.value)).toMatch(HASH_PATTERN);

    // "Absent" means "unset", so the layered result is the ordinary settings,
    // and the state is the very state the plain path builds: the committed
    // golden for (tiny, civs 2, seed 42) still describes it.
    expect(hashValue(state.value)).toBe(hashValue(mustState('tiny', 2, 42)));
    const stored = loadGoldens();
    const golden = stored?.entries.find((entry) => entry.name === 'tiny-civs2-seed42');
    expect(golden).toBeDefined();
    if (golden !== undefined) expect(hashValue(state.value)).toBe(golden.hash);

    // A ruleset that is really set must still reach the state: the
    // normalization drops "unset", never a value.
    const withRuleset = loadSettings({ mapSize: 'tiny', civCount: 2, seed: 42, ruleset: 'standard' });
    expect(withRuleset.ok).toBe(true);
    if (withRuleset.ok) {
      expect(withRuleset.value.ruleset).toBe('standard');
      const rulesetState = newGame(42, withRuleset.value, RULESET);
      expect(rulesetState.ok).toBe(true);
      if (rulesetState.ok) expect(hashValue(rulesetState.value)).not.toBe(hashValue(state.value));
    }

    // The direct parse path is normalized too: an explicit undefined in the
    // input must not survive as an own key.
    const parsedExplicit = parseSettings({
      ...DEFAULT_SETTINGS,
      mapSize: 'tiny',
      civCount: 2,
      seed: 42,
      ruleset: undefined,
    });
    expect(parsedExplicit.ok).toBe(true);
    if (!parsedExplicit.ok) return;
    expect(Object.prototype.hasOwnProperty.call(parsedExplicit.value, 'ruleset')).toBe(false);
    const parsedState = newGame(42, parsedExplicit.value, RULESET);
    expect(parsedState.ok).toBe(true);
    if (parsedState.ok) {
      expect(() => hashValue(parsedState.value)).not.toThrow();
      expect(hashValue(parsedState.value)).toBe(hashValue(state.value));
    }

    // The ordinary parse path is unchanged: an input without the key produces a
    // Settings with no `ruleset` key at all, which is why the goldens pass.
    const parsed = parseSettings({
      mapSize: 'tiny',
      civCount: 2,
      seed: 42,
      difficulty: 'regent',
      fidelity: 'tuned',
      ai: { aggression: 0.5, expandFast: false },
      debug: { cheats: false, revealMap: false },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.prototype.hasOwnProperty.call(parsed.value, 'ruleset')).toBe(false);
    expect(hashValue(mustState('tiny', 2, 42))).toMatch(HASH_PATTERN);
  });
});

/* ================================================================== *
 * 7. Text renderer
 * ================================================================== */

describe('adversarial: text renderer', () => {
  it('is a pure function of (state, ruleset, options)', () => {
    // FAILS IF: rendering depends on iteration order of a Map built from external
    // data, on ambient state, or on the current time.
    const state = mustState('tiny', 2, 42);
    const first = describeState(state, RULESET);
    const second = describeState(state, RULESET);
    const rebuiltRuleset: RulesetView = {
      terrains: CATALOG.terrains.map(toTerrainDef),
      fidelity: 'tuned',
    };
    const third = describeState(state, rebuiltRuleset);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.split('\n').filter((line) => /[ \t]+$/.test(line))).toEqual([]);
  });

  it('renders every tile of a cropped viewport, clamped to the map', () => {
    // FAILS IF: a viewport is trusted (a hostile or stale viewport would either
    // throw or silently render nothing).
    const state = mustState('tiny', 2, 42);
    const crop = describeState(state, RULESET, { viewport: { x: 10, y: 20, width: 8, height: 4 } });
    const rows = crop
      .split('\n')
      .filter((line) => /^\s*\d+ \|/.test(line));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.replace(/^\s*\d+ \|/, '')).toHaveLength(8);
    }

    for (const viewport of [
      { x: -50, y: -50, width: 4, height: 4 },
      { x: 1000, y: 1000, width: 4, height: 4 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 58, y: 58, width: 99, height: 99 },
    ]) {
      expect(() => describeState(state, RULESET, { viewport })).not.toThrow();
    }
  });

  it('names every terrain role in the legend and marks the starts', () => {
    const state = mustState('tiny', 2, 42);
    const rendered = describeState(state, RULESET);
    for (const role of TERRAIN_ROLES) {
      expect(rendered).toContain(role);
    }
    expect(rendered).toContain('starts:');

    const withoutStarts = describeState(state, RULESET, { showStarts: false });
    expect(withoutStarts).not.toContain('starts:');
    expect(withoutStarts).not.toBe(rendered);
  });
});

/* ================================================================== *
 * 8. Latent hazards found by reading, pinned so they cannot be forgotten
 * ================================================================== */

interface ExecFailure extends Error {
  readonly code?: unknown;
  readonly stdout?: unknown;
}

// `Error` is structurally assignable to `ExecFailure` (every added field is
// optional), so no cast is needed to read the extra fields node attaches.
const asExecFailure = (cause: unknown): ExecFailure | undefined =>
  cause instanceof Error ? cause : undefined;

describe('adversarial: latent hazards (found by reading, since fixed)', () => {
  it('nextBelow() throws RangeError above 2^32 instead of looping forever', () => {
    // FINDING, NOW FIXED. `nextBelow` computed
    // `limit = Math.floor(2 ** 32 / bound) * bound`, which is 0 for
    // bound > 2 ** 32, so no draw could ever be accepted and the `for (;;)` loop
    // held the thread forever. `nextBelow`, `nextInt`, `drawMany` and `shuffle`
    // are all exported, so a caller asking for a range that wide (e.g.
    // `nextInt(rng, 0, 10 ** 10)`) hung the process. The bound is now refused
    // with a `RangeError` before the loop is entered.
    //
    // The in-process assertions below are fast; the out-of-process one is kept
    // because a spinning thread cannot be timed out from inside itself — the
    // child must *exit on its own* with the typed error, and it is the child
    // that would be killed by the 15 s cap if the guard regressed.
    // FAILS IF: the guard disappears, if `2 ** 32` stops working, or if the
    // guard perturbs the draw sequence (the raw-draw comparison below).
    const state = seedRng(1);

    const tooWide: readonly number[] = [4294967297, 2 ** 33, 10 ** 10, Number.MAX_SAFE_INTEGER];
    for (const bound of tooWide) {
      expect(() => nextBelow(state, bound), `bound ${String(bound)}`).toThrow(RangeError);
    }
    expect(() => nextInt(state, 0, 10 ** 10)).toThrow(RangeError);
    expect(() => drawMany(state, 2, 2 ** 33)).toThrow(RangeError);

    // The widest supported bound keeps working, and costs exactly one draw:
    // every uint32 is below 2 ** 32, so nothing is rejected.
    const atLimit = nextBelow(state, 4294967296);
    const raw = nextUint32(state);
    expect(atLimit[0]).toBe(raw[0]);
    expect(atLimit[1]).toEqual(raw[1]);
    expect(atLimit[0]).toBeGreaterThanOrEqual(0);
    expect(atLimit[0]).toBeLessThan(4294967296);

    const script = `
(async () => {
  const { seedRng, nextBelow, nextInt } = await import('@civts/core');
  const state = seedRng(1);
  console.log('bound=2^32 -> ' + String(nextBelow(state, 4294967296)[0]));
  try {
    nextBelow(state, 2 ** 33);
    console.log('bound=2^33 -> NO THROW');
  } catch (cause) {
    console.log('bound=2^33 -> ' + cause.constructor.name);
  }
  try {
    nextInt(state, 0, 10 ** 10);
    console.log('nextInt wide -> NO THROW');
  } catch (cause) {
    console.log('nextInt wide -> ' + cause.constructor.name);
  }
})().catch((cause) => { console.error(String(cause)); process.exit(1); });
`;

    let failure: ExecFailure | undefined;
    let stdout = '';
    try {
      stdout = runFreshProcess(script, 15_000);
    } catch (cause) {
      failure = asExecFailure(cause);
    }

    expect(failure, 'the child hung or crashed instead of reporting RangeError').toBeUndefined();
    expect(stdout).toContain('bound=2^32 ->');
    expect(stdout).toContain('bound=2^33 -> RangeError');
    expect(stdout).toContain('nextInt wide -> RangeError');
    expect(stdout).not.toContain('NO THROW');
  });
});
