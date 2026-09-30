import {
  planRoute,
  unitActions,
  type Command,
  type GameState,
  type RulesetView,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { problemText } from './problem.js';

export interface StackIntent {
  readonly units: readonly UnitId[];
  readonly destination: TileIndex;
  readonly route: readonly TileIndex[];
}

export function startStack(
  state: GameState,
  ruleset: RulesetView,
  units: readonly UnitId[],
  destination: TileIndex,
): StackIntent | string {
  units = [...new Set(units)];
  const first = units[0];
  if (first === undefined) return 'Select units to move first.';
  const result = planRoute(state, ruleset, first, destination, units.slice(1));
  return result.ok ? { units, destination, route: result.value.steps } : problemText(result.error);
}

export function nextStackStep(
  state: GameState,
  ruleset: RulesetView,
  intent: StackIntent,
):
  | { kind: 'step'; commands: readonly Command[]; intent: StackIntent }
  | { kind: 'waiting' }
  | { kind: 'arrived' }
  | { kind: 'cancelled'; reason: string } {
  const planned = startStack(state, ruleset, intent.units, intent.destination);
  if (typeof planned === 'string') return { kind: 'cancelled', reason: planned };
  if (planned.route.length === 0) return { kind: 'arrived' };
  if (
    planned.route.length !== intent.route.length ||
    !planned.route.every((tile, i) => tile === intent.route[i])
  ) {
    return { kind: 'cancelled', reason: 'The route changed. Choose a destination again.' };
  }
  const commands: Command[] = [];
  for (const id of intent.units) {
    const command = unitActions(state, ruleset, id).find(
      (action) => action.type === 'MoveUnit' && action.to === intent.route[0],
    );
    if (command === undefined) return { kind: 'waiting' };
    commands.push(command);
  }
  return { kind: 'step', commands, intent: { ...intent, route: intent.route.slice(1) } };
}
