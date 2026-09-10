/**
 * Golden replay harness (docs/INTERFACES.md W4; PLAN.md §5.3 determinism,
 * §10 testing tiers).
 *
 * What this file is for: a small, fixed set of worlds whose state hashes are
 * stored in `packages/testing/goldens/state.json`. If map generation, state
 * assembly or the hasher changes behaviour, the hashes move and this test fails
 * with the expected/actual pair. That is the whole value of a golden, so the
 * harness is deliberately built to be **unable to pass by rewriting itself**:
 *
 * - The test never writes unless `CIVTS_WRITE_GOLDENS=1` is set explicitly. A
 *   missing file or a differing hash is a failure, with the regeneration command
 *   in the message plus the reminder that a rehash needs a
 *   `rehash: <reason>` note in the commit message.
 * - The stored `nodeMajor` is compared with the running one. PLAN.md §5.3 scopes
 *   the determinism guarantee to a pinned `(engine revision, Node major)`, so a
 *   Node upgrade is expected to change hashes — and must be an intentional,
 *   recorded rehash rather than a surprise in CI.
 * - The scenarios themselves are checked for non-vacuity: distinct seeds must
 *   produce distinct hashes, and perturbing a state must move its hash. A golden
 *   that cannot fail would pass forever and detect nothing.
 *
 * The ruleset is `@civts/rules`' `CATALOG` (the real content the CLI runs on),
 * put through the same `validateRuleset` the CLI runs — a validated `Ruleset`
 * carries a `role` per terrain and is therefore structurally the engine's
 * `RulesetView`, with no adapter in between.
 */

import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newGame,
  type GameState,
  type RulesetView,
  type Settings,
  type SetupError,
} from '@civts/core';
import { CATALOG, validateRuleset, type RulesetError } from '@civts/rules';
import { hashValue } from '../src/index.js';
import {
  goldensPath,
  loadGoldens,
  saveGoldens,
  type GoldenEntry,
  type GoldenFile,
} from '../src/goldens.js';

/* ------------------------------------------------------------------ *
 * Scenarios (fixed list; changing it changes the golden file, so it is a
 * deliberate act that also needs a rehash note).
 * ------------------------------------------------------------------ */

const GOLDEN_SEEDS = [1, 42, 1337] as const;
const GOLDEN_MAP_SIZE = 'tiny';
const GOLDEN_CIV_COUNT = 2;

const GOLDEN_NOTE =
  'State hashes for packages/testing/test/golden.test.ts ' +
  '(seeds 1, 42, 1337; map size tiny; 2 civilizations). ' +
  'Hashes are only guaranteed for a pinned (engine revision, Node major): ' +
  'changing one requires an intentional regeneration and a "rehash: <reason>" note in the commit message.';

/** Set only by an explicit regeneration run; never by a normal test run. */
const WRITE_MODE = process.env['CIVTS_WRITE_GOLDENS'] === '1';

const REGENERATE_COMMAND = 'CIVTS_WRITE_GOLDENS=1 npx vitest run packages/testing/test/golden.test.ts';
const REHASH_INSTRUCTION = 'and record a "rehash: <reason>" note in the commit message.';

/* ------------------------------------------------------------------ *
 * The ruleset under test
 * ------------------------------------------------------------------ */

const formatRulesetError = (e: RulesetError): string => {
  switch (e.kind) {
    case 'empty-catalog':
      return `empty catalog: ${e.catalog}`;
    case 'duplicate-id':
      return `duplicate id in ${e.catalog}: ${e.id}`;
    case 'placeholder-in-cited-only':
      return `placeholder row in cited-only mode: ${e.catalog}/${e.id} (${e.note})`;
    case 'invalid-value':
      return `invalid value: ${e.catalog}/${e.id}.${e.field} — ${e.detail}`;
    case 'missing-role':
      return `no terrain fills role "${e.role}"`;
  }
};

/**
 * The catalog is validated exactly as the CLI validates it, and the resulting
 * `Ruleset` is used directly: `TerrainSpec.role` makes it structurally the
 * engine's `RulesetView`, so the previous "read the role off the terrain id"
 * adapter is gone. Throwing here rather than defaulting keeps a broken catalog
 * from being reported as a wrong golden hash.
 */
const RULESET: RulesetView = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the placeholder catalog does not validate: ${validated.error.map(formatRulesetError).join('; ')}`,
    );
  }
  return validated.value;
})();

/* ------------------------------------------------------------------ *
 * Building the states under test
 * ------------------------------------------------------------------ */

const settingsFor = (seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  mapSize: GOLDEN_MAP_SIZE,
  civCount: GOLDEN_CIV_COUNT,
  seed,
});

const entryName = (seed: number): string =>
  `${GOLDEN_MAP_SIZE}-civs${String(GOLDEN_CIV_COUNT)}-seed${String(seed)}`;

const formatSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `ruleset is missing terrain role "${error.role}"`;
    case 'no-valid-starts':
      return `no valid starting tile for ${String(error.civCount)} civilizations`;
    case 'too-few-start-candidates':
      return 'too few starting-tile candidates for the requested civilizations';
  }
};

const mustState = (seed: number): GameState => {
  const result = newGame(seed, settingsFor(seed), RULESET);
  if (!result.ok) {
    throw new Error(`golden scenario seed=${String(seed)}: newGame failed — ${formatSetupError(result.error)}`);
  }
  return result.value;
};

/** The hashes this build of the engine produces, in scenario order. */
const actualEntries = (): readonly GoldenEntry[] =>
  GOLDEN_SEEDS.map((seed) => ({ name: entryName(seed), hash: hashValue(mustState(seed)) }));

const runningNodeMajor = (): number => {
  const major = process.versions.node.split('.')[0];
  return major === undefined ? Number.NaN : Number.parseInt(major, 10);
};

/* ------------------------------------------------------------------ *
 * Failure reporting: every path shows expected vs actual and says what an
 * intentional change looks like.
 * ------------------------------------------------------------------ */

const failure = (heading: string, lines: readonly string[]): Error =>
  new Error(
    [
      heading,
      '',
      ...lines,
      '',
      `Regenerate intentionally:\n  ${REGENERATE_COMMAND}`,
      REHASH_INSTRUCTION,
    ].join('\n'),
  );

const missingFileError = (): Error =>
  failure(`golden file missing: ${goldensPath()}`, [
    `expected: the committed golden file with ${String(GOLDEN_SEEDS.length)} entries ` +
      `(${GOLDEN_SEEDS.map((seed) => entryName(seed)).join(', ')})`,
    'actual:   no file at that path',
  ]);

const requireStored = (): GoldenFile => {
  const stored = loadGoldens();
  if (stored === undefined) throw missingFileError();
  return stored;
};

/** Per-entry expected/actual lines, covering missing, extra and differing hashes. */
const diffLines = (
  stored: readonly GoldenEntry[],
  actual: readonly GoldenEntry[],
): readonly string[] => {
  const actualByName = new Map(actual.map((entry) => [entry.name, entry.hash] as const));
  const storedNames = new Set(stored.map((entry) => entry.name));
  const lines: string[] = [];

  for (const entry of stored) {
    const got = actualByName.get(entry.name);
    if (got === undefined) {
      lines.push(`  ${entry.name}: expected ${entry.hash}, actual <no such entry was rebuilt>`);
    } else if (got !== entry.hash) {
      lines.push(`  ${entry.name}: expected ${entry.hash}, actual ${got}`);
    }
  }

  for (const entry of actual) {
    if (!storedNames.has(entry.name)) {
      lines.push(`  ${entry.name}: expected <absent from the golden file>, actual ${entry.hash}`);
    }
  }

  return lines;
};

/* ------------------------------------------------------------------ *
 * The scenarios themselves — always checked, in both modes.
 * ------------------------------------------------------------------ */

describe('golden scenarios', () => {
  it('is deterministic: rebuilding the same seeds reproduces the same hashes', () => {
    expect(actualEntries()).toEqual(actualEntries());
  });

  it('is not vacuous: distinct seeds produce distinct hashes', () => {
    const hashes = actualEntries().map((entry) => entry.hash);
    expect(new Set(hashes).size).toBe(GOLDEN_SEEDS.length);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('would catch a change: perturbing a state moves its hash', () => {
    const state = mustState(42);
    const baseline = hashValue(state);

    // A one-turn difference, and a different world at the same turn: both must
    // move the digest, which is what makes a stored hash meaningful.
    expect(hashValue({ ...state, turn: state.turn + 1 })).not.toBe(baseline);
    expect(hashValue({ ...state, map: mustState(1).map })).not.toBe(baseline);
  });

  it('builds every seed on land with the requested civilization count', () => {
    for (const seed of GOLDEN_SEEDS) {
      const state = mustState(seed);
      expect(state.settings.mapSize).toBe(GOLDEN_MAP_SIZE);
      expect(state.players).toHaveLength(GOLDEN_CIV_COUNT);
      expect(state.seed).toBe(seed);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Comparison with the stored file, or (opt-in) regeneration.
 * ------------------------------------------------------------------ */

if (WRITE_MODE) {
  describe('golden regeneration (CIVTS_WRITE_GOLDENS=1)', () => {
    it('writes the golden file and reads it back unchanged', () => {
      const entries = actualEntries();
      const file: GoldenFile = {
        note: GOLDEN_NOTE,
        nodeMajor: runningNodeMajor(),
        entries: [...entries],
      };

      saveGoldens(file);

      expect(loadGoldens()).toEqual(file);
      console.log(
        `goldens written: ${goldensPath()}\n` +
          'If any hash changed, make sure the commit message carries a "rehash: <reason>" note.',
      );
    });
  });
} else {
  describe('golden file', () => {
    it('exists and was produced by this harness', () => {
      const stored = requireStored();

      if (stored.entries.length !== GOLDEN_SEEDS.length) {
        throw failure(`golden file entry count in ${goldensPath()}`, [
          `expected: ${String(GOLDEN_SEEDS.length)} entries (${GOLDEN_SEEDS.map(entryName).join(', ')})`,
          `actual:   ${String(stored.entries.length)} (${stored.entries.map((entry) => entry.name).join(', ')})`,
        ]);
      }

      if (stored.note !== GOLDEN_NOTE) {
        throw failure(`golden file note differs from the harness note in ${goldensPath()}`, [
          `expected: ${GOLDEN_NOTE}`,
          `actual:   ${stored.note}`,
        ]);
      }

      expect(stored.entries).toHaveLength(GOLDEN_SEEDS.length);
    });

    it('was recorded on the running Node major', () => {
      const stored = requireStored();
      const running = runningNodeMajor();

      if (stored.nodeMajor !== running) {
        throw failure(`golden file recorded on Node major ${String(stored.nodeMajor)}`, [
          `expected: nodeMajor ${String(running)} (the running Node ${process.versions.node})`,
          `actual:   nodeMajor ${String(stored.nodeMajor)} in ${goldensPath()}`,
          '',
          'Hashes are only guaranteed for a pinned (engine revision, Node major), so a Node upgrade',
          'is expected to move them — intentionally, not silently.',
        ]);
      }

      expect(stored.nodeMajor).toBe(running);
    });

    it('reproduces every stored state hash', () => {
      const stored = requireStored();
      const actual = actualEntries();
      const lines = diffLines(stored.entries, actual);

      if (lines.length > 0) {
        throw failure(`golden state hashes differ from ${goldensPath()}`, [
          'expected vs actual:',
          ...lines,
        ]);
      }

      for (const entry of actual) {
        const match = stored.entries.find((storedEntry) => storedEntry.name === entry.name);
        expect(match?.hash).toBe(entry.hash);
      }
    });
  });
}

describe('goldensPath', () => {
  it('points at the committed, package-relative data file', () => {
    const path = goldensPath();
    expect(path.endsWith(join('packages', 'testing', 'goldens', 'state.json'))).toBe(true);
    expect(isAbsolute(path)).toBe(true);
  });
});
