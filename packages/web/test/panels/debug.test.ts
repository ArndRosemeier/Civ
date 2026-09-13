/**
 * The debug panel's facts: the hash first (it is the contractual `State hash` status) and the
 * internals read straight off the state.
 *
 * The point of asserting the internals rather than only the hash is that a debug panel showing a
 * number that is *not* in the state is worse than no debug panel: it would send somebody looking
 * for a bug that does not exist. Every fact here is checked against the field it comes from.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asPlayerId,
  asUnitId,
  newGame,
  type GameState,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';
import { debugFacts } from '../../src/panels/debug.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(123, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const STATE: GameState = started.value;
const P0 = asPlayerId(0);

const fact = (label: string, state: GameState = STATE): string => {
  const found = debugFacts(state, RULESET, P0, hashValue(state)).find((row) => row.label === label);
  if (found === undefined) throw new Error(`no debug fact named ${label}`);
  return found.value;
};

describe('debugFacts', () => {
  it("leads with the state hash, which is the engine's own", () => {
    const facts = debugFacts(STATE, RULESET, P0, hashValue(STATE));
    expect(facts[0]?.label).toBe('State hash');
    expect(facts[0]?.value).toBe(hashValue(STATE));
    expect(facts[0]?.value).toMatch(/^[0-9a-f]+$/);
  });

  it("reports the state's own counters", () => {
    expect(fact('Turn')).toBe('1');
    expect(fact('Revision')).toBe('0');
    expect(fact('Seed')).toBe('123');
    expect(fact('Schema version')).toBe(String(STATE.schemaVersion));
    expect(fact('Units')).toBe(String(STATE.units.length));
    expect(fact('Cities')).toBe('0');
    expect(fact('Players')).toBe('3');
    expect(fact('Civilizations')).toBe('2');
    expect(fact('Improvements')).toBe('0');
  });

  it("reports the map's dimensions and the terrain array it actually holds", () => {
    expect(fact('Map')).toContain(String(STATE.map.width));
    expect(fact('Map')).toContain(String(STATE.map.height));
    expect(fact('Terrain ids')).toBe(String(STATE.map.terrain.length));
    expect(fact('Resources placed')).toBe(String(STATE.map.resources.length));
  });

  it('reports all four RNG words, because a wrong RNG is a wrong game', () => {
    expect(fact('Rng')).toBe(
      `${String(STATE.rng.a)}/${String(STATE.rng.b)}/${String(STATE.rng.c)}/${String(STATE.rng.d)}`,
    );
  });

  it("reports the ruleset's fidelity, which is a read of the ruleset, not of the state", () => {
    expect(fact('Ruleset fidelity')).toBe(RULESET.fidelity);
  });

  it("counts the acting player's explored tiles out of the whole map", () => {
    const value = fact('Explored by the acting player');
    const [explored, tiles] = value.split(' / ');
    expect(Number(explored)).toBeGreaterThan(0);
    expect(Number(tiles)).toBe(STATE.map.width * STATE.map.height);
  });

  it('moves when the game moves, and the hash moves with it', () => {
    const applied = applyCommand(STATE, P0, { type: 'FoundCity', unitId: asUnitId(0) }, RULESET);
    if (!applied.ok) throw new Error('founding the first city was refused');
    const after = applied.value.state;
    expect(fact('Cities', after)).toBe('1');
    expect(fact('Revision', after)).toBe(String(after.revision));
    expect(fact('State hash', after)).not.toBe(fact('State hash'));
  });
});
