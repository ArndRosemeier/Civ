/**
 * The browser's save format is the **engine's** save format.
 *
 * `packages/web/test/panels/save.test.ts` pins the behaviour this panel's loader has always had
 * (the round trip, the refusals, one `localStorage` key). This file pins the thing M11 added,
 * which that test cannot see by itself: *which* format is on the wire. A round trip through one
 * file's own writer and reader is satisfied by any format at all — this module could have kept
 * its own envelope and still passed every assertion beside it.
 *
 * So the assertions here are comparisons against `@civts/core`, not against this package:
 *
 * - the string `serializeSave` produces is **byte-for-byte** `serialize`'s — one serializer,
 *   not two that happen to agree;
 * - the payload is the engine's four keys, version and identity, so `civts load` reads a save
 *   this app wrote;
 * - a payload that is *not* that format is refused with a typed reason, including the app's own
 *   former `{ schema, hash, state }` envelope — the format that used to live in `save.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SAVE_VERSION,
  SCHEMA_VERSION,
  applyCommand,
  asBuildingId,
  asCityId,
  asPlayerId,
  asUnitId,
  deserialize,
  formatSaveError,
  newGame,
  payloadOf,
  serialize,
  type GameState,
  type ProductionItem,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

import {
  SAVE_KEY,
  SAVE_SCHEMA,
  parseSave,
  readSave,
  serializeSave,
  webCodec,
} from '../../src/panels/save.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(99, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const P0 = asPlayerId(0);

/** A *played* state, so the payload covers entities rather than only the opening board. */
const played = applyCommand(started.value, P0, { type: 'FoundCity', unitId: asUnitId(0) }, RULESET);
if (!played.ok) throw new Error('founding the first city was refused');
const granary: ProductionItem = { kind: 'building', id: asBuildingId('granary') };
const queued = applyCommand(
  played.value.state,
  P0,
  { type: 'SetProduction', cityId: asCityId(0), item: granary },
  RULESET,
);
if (!queued.ok) throw new Error('setting production was refused');
const STATE: GameState = queued.value.state;
const HASH = hashValue(STATE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The parsed payload, without a cast: a test that has to cast is a test that proves nothing. */
const payloadOfText = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('the save is not an object');
  return parsed;
};

describe('the save the browser writes is the engine’s save', () => {
  it('is the engine’s own serializer, byte for byte', () => {
    // The whole claim in one assertion: not "the two agree", but "there is one of them".
    expect(serializeSave(STATE, HASH)).toBe(serialize(STATE, webCodec()));
    // …and it is the engine's payload object, field for field.
    expect(payloadOfText(serializeSave(STATE, HASH))).toEqual(
      JSON.parse(JSON.stringify(payloadOf(STATE, webCodec()))),
    );
  });

  it('carries the engine’s four keys, version and engine identity', () => {
    const payload = payloadOfText(serializeSave(STATE, HASH));
    expect(Object.keys(payload).sort()).toEqual(['engine', 'hash', 'state', 'version']);
    expect(payload['version']).toBe(SAVE_VERSION);
    expect(payload['hash']).toBe(HASH);
    // The engine block names the schema the state itself carries, so a save cannot claim one
    // version in the envelope and another in the state.
    expect(payload['engine']).toMatchObject({ schemaVersion: SCHEMA_VERSION });
    expect(payload['engine']).toMatchObject({ schemaVersion: STATE.schemaVersion });
    // Absent, never `undefined` — the rule holds on the wire, where it actually matters.
    expect(serializeSave(STATE, HASH)).not.toContain('undefined');
  });

  it('has no version of its own to drift: SAVE_SCHEMA is the engine’s', () => {
    // The old `SAVE_SCHEMA = 1` was this file's own number. It is now the engine's constant, so a
    // build that bumped the format cannot leave a stale second copy behind.
    expect(SAVE_SCHEMA).toBe(SAVE_VERSION);
    expect(SAVE_KEY).toBe('civts.save.v1');
  });

  it('is readable by the engine’s deserializer, and hashes back to the same value', () => {
    const text = serializeSave(STATE, HASH);
    const loaded = deserialize(text, webCodec());
    if (!loaded.ok) throw new Error(`the engine refused the app's own save: ${loaded.error.kind}`);
    expect(loaded.value).toEqual(STATE);
    expect(hashValue(loaded.value)).toBe(HASH);
    // The same value `stateHash()` reports, which is what makes the panel's `Saved (hash …)` line
    // and the file agree by construction.
    expect(loaded.value).toEqual(STATE);
  });

  it('refuses to write a payload whose hash is not the state’s own', () => {
    // The old format wrote whatever hash it was handed, so a caller that passed the hash of a
    // different state wrote a file that lied — and only the next load found out.
    expect(() => serializeSave(STATE, '0000000000000000')).toThrow(/hash/);
    expect(() => serializeSave(STATE, '')).toThrow(/hash/);
  });
});

describe('readSave answers with the engine’s typed error', () => {
  const text = serializeSave(STATE, HASH);
  const payload = payloadOfText(text);
  const state = payload['state'];
  if (!isRecord(state)) throw new Error('the payload has no state object');
  const units = state['units'];
  if (!Array.isArray(units)) throw new Error('the state has no units list');

  /** Every way the file can be wrong, and the `kind` the engine must answer with. */
  const CASES: readonly { readonly why: string; readonly text: string; readonly kind: string }[] = [
    { why: 'not JSON at all', text: '{ not json', kind: 'malformed-json' },
    { why: 'not a payload', text: '[]', kind: 'not-a-payload' },
    {
      why: 'no version',
      text: JSON.stringify({ ...payload, version: undefined }),
      kind: 'missing-field',
    },
    {
      why: 'a version from the future',
      text: JSON.stringify({ ...payload, version: 99 }),
      kind: 'unknown-version',
    },
    {
      why: 'no state',
      text: JSON.stringify({ ...payload, state: undefined }),
      kind: 'missing-field',
    },
    {
      why: 'a hash that is not the state’s',
      text: JSON.stringify({ ...payload, hash: 'ffffffffffffffff' }),
      kind: 'hash-mismatch',
    },
    {
      why: 'a state that is not an object',
      text: JSON.stringify({ ...payload, state: 7 }),
      kind: 'wrong-type',
    },
    {
      why: 'a tile off the map',
      text: JSON.stringify({
        ...payload,
        state: { ...state, units: [{ ...units[0], tile: 10 ** 6 }] },
      }),
      kind: 'out-of-range',
    },
    {
      why: 'a state with a field removed',
      text: JSON.stringify({
        ...payload,
        state: Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'units')),
      }),
      kind: 'missing-field',
    },
    // The app's own former envelope: this build has one format, so the one it used to write is a
    // foreign file now. It fails as a *missing version*, which is the honest description.
    {
      why: 'the app’s old envelope',
      text: JSON.stringify({ schema: SAVE_SCHEMA, hash: HASH, state }),
      kind: 'missing-field',
    },
  ];

  for (const { why, text: broken, kind } of CASES) {
    it(`refuses ${why} with a typed reason`, () => {
      const read = readSave(broken);
      expect(read.ok, why).toBe(false);
      if (read.ok) return;
      expect(read.error.kind, why).toBe(kind);
      // Every refusal is a sentence, not an empty line: the panel shows this text to a user.
      expect(formatSaveError(read.error).length, why).toBeGreaterThan(0);
      // …and the `undefined`-or-file reader agrees, so both entry points refuse the same files.
      expect(parseSave(broken), why).toBeUndefined();
    });
  }

  it('reads a payload written where there is no Node — `nodeMajor` absent, not null', () => {
    // The engine block's `nodeMajor` is written only where there *is* a Node, so the browser's own
    // saves carry no such key. A loader that demanded it would refuse every save this app writes,
    // and one that demanded `null` would be the absent-versus-undefined rule paid for a fifth time.
    const engine = payload['engine'];
    if (!isRecord(engine)) throw new Error('the payload has no engine block');
    const withoutNode = Object.fromEntries(
      Object.entries(engine).filter(([key]) => key !== 'nodeMajor'),
    );
    const read = readSave(JSON.stringify({ ...payload, engine: withoutNode }));
    if (!read.ok) throw new Error(`a browser-shaped save was refused: ${read.error.kind}`);
    expect(read.value.state).toEqual(STATE);
    // The engine block is not part of the hash: the state is, and it is unchanged.
    expect(read.value.hash).toBe(HASH);
  });

  it('accepts the save the browser wrote, and reports the engine’s hash for it', () => {
    const read = readSave(text);
    if (!read.ok) throw new Error(`the app's own save was refused: ${read.error.kind}`);
    expect(read.value.schema).toBe(SAVE_VERSION);
    expect(read.value.hash).toBe(HASH);
    expect(read.value.state).toEqual(STATE);
    expect(parseSave(text)?.state).toEqual(STATE);
  });
});
