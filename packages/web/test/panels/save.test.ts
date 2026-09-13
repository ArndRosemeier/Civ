/**
 * Save and load: the payload round-trips, the hash is the identity, and a payload that is not
 * ours is refused rather than half-installed.
 *
 * The property M8 names — "save/load … must round-trip `stateHash()` unchanged" — is asserted
 * here at the level this module owns: the string a save writes parses back to a state whose
 * `hashValue` is the hash that was stored with it. The loader's *fail-closed* behaviour (hash
 * mismatch ⇒ restore the previous state) is the same check run at load time, and it is exercised
 * with a tampered payload.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asBuildingId,
  asCityId,
  asPlayerId,
  asUnitId,
  newGame,
  type GameState,
  type ProductionItem,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';
import { SAVE_KEY, SAVE_SCHEMA, parseSave, serializeSave } from '../../src/panels/save.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(99, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const P0 = asPlayerId(0);

/** A *played* state, so the round trip covers entities rather than only the opening board. */
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

describe('serializeSave / parseSave', () => {
  it('round-trips a played state exactly, and to the same engine hash', () => {
    const hash = hashValue(STATE);
    const parsed = parseSave(serializeSave(STATE, hash));
    if (parsed === undefined) throw new Error('a save this module wrote did not parse');
    expect(parsed.state).toEqual(STATE);
    expect(parsed.hash).toBe(hash);
    expect(hashValue(parsed.state)).toBe(hash);
    expect(parsed.schema).toBe(SAVE_SCHEMA);
  });

  it('writes plain JSON that the hash covers, with no undefined anywhere', () => {
    const text = serializeSave(STATE, hashValue(STATE));
    expect(text).not.toContain('undefined');
    expect(JSON.parse(text)).toBeTruthy();
  });

  it('keeps the save under one documented key', () => {
    expect(SAVE_KEY).toBe('civts.save.v1');
  });

  it('refuses text that is not JSON', () => {
    expect(parseSave('not json at all')).toBeUndefined();
    expect(parseSave('')).toBeUndefined();
  });

  it('refuses a payload that is not a save of this schema', () => {
    expect(parseSave('{}')).toBeUndefined();
    expect(parseSave('[1,2,3]')).toBeUndefined();
    expect(parseSave('null')).toBeUndefined();
    expect(
      parseSave(JSON.stringify({ schema: SAVE_SCHEMA + 1, hash: 'x', state: STATE })),
    ).toBeUndefined();
    expect(parseSave(JSON.stringify({ schema: SAVE_SCHEMA, state: STATE }))).toBeUndefined();
    expect(
      parseSave(JSON.stringify({ schema: SAVE_SCHEMA, hash: 7, state: STATE })),
    ).toBeUndefined();
  });

  it('refuses a state whose shape the engine could not run', () => {
    const missing = JSON.stringify({ schema: SAVE_SCHEMA, hash: 'h', state: { map: {} } });
    expect(parseSave(missing)).toBeUndefined();

    const truncatedMap = JSON.stringify({
      schema: SAVE_SCHEMA,
      hash: 'h',
      state: { ...STATE, map: { ...STATE.map, terrain: [] } },
    });
    expect(parseSave(truncatedMap)).toBeUndefined();

    const noUnits = JSON.stringify({
      schema: SAVE_SCHEMA,
      hash: 'h',
      state: { ...STATE, units: 'two' },
    });
    expect(parseSave(noUnits)).toBeUndefined();
  });

  it('detects a tampered state, which is what makes the load check meaningful', () => {
    const hash = hashValue(STATE);
    const file = parseSave(serializeSave(STATE, hash));
    if (file === undefined) throw new Error('a save this module wrote did not parse');
    const tampered: GameState = { ...file.state, turn: file.state.turn + 1 };
    expect(hashValue(tampered)).not.toBe(file.hash);
  });
});
