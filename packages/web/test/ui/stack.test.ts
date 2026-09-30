import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  asTileIndex,
  asUnitId,
  DEFAULT_SETTINGS,
  newGame,
  type GameState,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { nextStackStep, startStack, type StackIntent } from '../../src/ui/stack.js';

const rules = validateRuleset(CATALOG, 'tuned');
if (!rules.ok) throw new Error('Invalid rules');
const ruleset = rules.value;
const game = newGame(7, { ...DEFAULT_SETTINGS, seed: 7, mapSize: 'tiny', civCount: 2 }, ruleset);
if (!game.ok) throw new Error('Invalid fixture');
const original = game.value.units[0];
if (original === undefined) throw new Error('Missing unit');
const member = { ...original, id: asUnitId(100), movementLeft: 0 };
const state: GameState = { ...game.value, units: [...game.value.units, member] };
const ids = [original.id, member.id];
const destination = Array.from(state.map.terrain, (_, i) => asTileIndex(i)).find((to) => {
  const intent = startStack(state, ruleset, ids, to);
  return typeof intent !== 'string' && intent.route.length > 1;
});
if (destination === undefined) throw new Error('Missing route');
const start = () => {
  const intent = startStack(state, ruleset, ids, destination);
  if (typeof intent === 'string') throw new Error(intent);
  return intent;
};

describe('stack movement', () => {
  it('waits for every member before issuing any movement', () => {
    expect(nextStackStep(state, ruleset, start())).toEqual({ kind: 'waiting' });
    expect(state.units.find((unit) => unit.id === original.id)?.tile).toBe(original.tile);
  });
  it('moves only the chosen members together through legal engine commands', () => {
    let current: GameState = {
      ...state,
      units: state.units.map((unit) =>
        ids.includes(unit.id) ? { ...unit, movementLeft: 100 } : unit,
      ),
    };
    let intent: StackIntent = start();
    const untouched = current.units.filter((unit) => !ids.includes(unit.id));
    const steps = intent.route.length + 1;
    for (let i = 0; i < steps; i++) {
      const decision = nextStackStep(current, ruleset, intent);
      if (decision.kind === 'arrived') break;
      expect(decision.kind).toBe('step');
      if (decision.kind !== 'step') throw new Error(decision.kind);
      for (const command of decision.commands) {
        const result = applyCommand(current, original.owner, command, ruleset);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Refused stack command');
        current = result.value.state;
      }
      expect(
        new Set(current.units.filter((unit) => ids.includes(unit.id)).map((unit) => unit.tile))
          .size,
      ).toBe(1);
      intent = decision.intent;
    }
    expect(
      current.units
        .filter((unit) => ids.includes(unit.id))
        .every((unit) => unit.tile === destination),
    ).toBe(true);
    expect(current.units.filter((unit) => !ids.includes(unit.id))).toEqual(untouched);
  });
  it('cancels when a member disappears or leaves the stack', () => {
    const missing = { ...state, units: state.units.filter((unit) => unit.id !== member.id) };
    expect(nextStackStep(missing, ruleset, start()).kind).toBe('cancelled');
    const split = {
      ...state,
      units: state.units.map((unit) =>
        unit.id === member.id ? { ...unit, tile: destination } : unit,
      ),
    };
    expect(nextStackStep(split, ruleset, start()).kind).toBe('cancelled');
  });
});
