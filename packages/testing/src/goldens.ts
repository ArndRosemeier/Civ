/**
 * Golden state files — the regression gate for engine determinism
 * (PLAN.md §5.3, §10; docs/INTERFACES.md W4).
 *
 * A golden is a stored map from a named scenario to a state hash. The guarantee
 * it encodes is deliberately narrow, exactly as PLAN.md §5.3 scopes it:
 * **identical hashes are guaranteed for a pinned `(engine revision, Node
 * major)`.** The file therefore records `nodeMajor`, and a Node upgrade is an
 * intentional rehash rather than a mystery diff.
 *
 * Design rules that keep a golden worth having:
 *
 * - **Missing or different ⇒ the caller fails; nothing is written here.** These
 *   functions never decide to "fix" a mismatch. Writing happens only when a
 *   caller (the golden test, under an explicit opt-in) asks for it. A golden
 *   that rewrites itself on mismatch cannot fail, and therefore cannot detect
 *   anything.
 * - **A damaged file is loud, never "missing".** Malformed JSON, a wrong field
 *   type, a bad digest or an empty entry list all throw. Treating corruption as
 *   absence would let a truncated file silently pass as "no goldens yet".
 * - **Every read is validated.** `loadGoldens` is the only reader, so a file
 *   cannot be half-parsed by a caller that trusts the disk.
 *
 * The file is committed: it is data, not a build artifact. IO lives here, in
 * `testing`, so `packages/core` stays free of it (PLAN.md §5.3).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GoldenEntry {
  readonly name: string;
  readonly hash: string;
}

export interface GoldenFile {
  readonly note: string;
  readonly nodeMajor: number;
  readonly entries: readonly GoldenEntry[];
}

/** FNV-1a 64 digests are 16 lowercase hex characters (`hashValue`). */
const HASH_PATTERN = /^[0-9a-f]{16}$/;

/**
 * `packages/testing/goldens/state.json`, resolved from *this module* rather than
 * from the working directory, so the path is the same for a test run, a CLI run
 * from the repo root, and a run from inside the package.
 */
export function goldensPath(): string {
  return fileURLToPath(new URL('../goldens/state.json', import.meta.url));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `Array.isArray` narrows to `any[]`, which would leak `any` into the parser and
 * defeat the point of validating unknown data. `Array.from<unknown>` re-types it
 * as `unknown[]` without a cast.
 */
const unknownArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? Array.from<unknown>(value) : undefined;

const malformed = (path: string, reason: string): never => {
  throw new Error(
    `golden file ${path} is malformed: ${reason}. ` +
      'Fix it, or delete it and regenerate intentionally, recording a ' +
      '"rehash: <reason>" note in the commit message.',
  );
};

const parseEntry = (raw: unknown, path: string, index: number): GoldenEntry => {
  if (!isRecord(raw)) return malformed(path, `entries[${String(index)}] must be an object`);

  const name = raw['name'];
  if (typeof name !== 'string' || name === '') {
    return malformed(path, `entries[${String(index)}].name must be a non-empty string`);
  }

  const hash = raw['hash'];
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    return malformed(
      path,
      `entries[${String(index)}].hash must be 16 lowercase hex characters (got ${JSON.stringify(hash)})`,
    );
  }

  return { name, hash };
};

/** Strict parser for the on-disk shape; used by both the reader and the writer. */
const parseGoldenFile = (raw: unknown, path: string): GoldenFile => {
  if (!isRecord(raw)) return malformed(path, 'expected a JSON object');

  const note = raw['note'];
  if (typeof note !== 'string') return malformed(path, 'field "note" must be a string');

  const nodeMajor = raw['nodeMajor'];
  if (typeof nodeMajor !== 'number' || !Number.isInteger(nodeMajor) || nodeMajor < 0) {
    return malformed(path, 'field "nodeMajor" must be a non-negative integer');
  }

  const rawEntries = unknownArray(raw['entries']);
  if (rawEntries === undefined) return malformed(path, 'field "entries" must be an array');
  if (rawEntries.length === 0) {
    return malformed(
      path,
      'field "entries" must not be empty — a golden with no entries cannot fail, so it proves nothing',
    );
  }

  const entries = rawEntries.map((item, index) => parseEntry(item, path, index));

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) return malformed(path, `duplicate entry name "${entry.name}"`);
    seen.add(entry.name);
  }

  return { note, nodeMajor, entries };
};

/**
 * Read the committed golden file.
 *
 * Returns `undefined` **only** when the file is genuinely absent — callers are
 * expected to treat that as a failure (regenerate intentionally), never as
 * "nothing to check". Anything unreadable or malformed throws.
 */
export function loadGoldens(): GoldenFile | undefined {
  const path = goldensPath();
  if (!existsSync(path)) return undefined;

  const text = readFileSync(path, 'utf8');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return malformed(path, `not valid JSON (${detail})`);
  }

  return parseGoldenFile(raw, path);
}

/**
 * Write the golden file (creating `goldens/` if needed).
 *
 * The value is validated before anything touches the disk, so a broken
 * regeneration cannot replace a good file with a malformed one. `JSON.stringify`
 * with a fixed key order keeps the diff of an intentional rehash readable.
 */
export function saveGoldens(file: GoldenFile): void {
  const path = goldensPath();
  const ordered = parseGoldenFile(
    {
      note: file.note,
      nodeMajor: file.nodeMajor,
      entries: file.entries.map((entry) => ({ name: entry.name, hash: entry.hash })),
    },
    path,
  );

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}
