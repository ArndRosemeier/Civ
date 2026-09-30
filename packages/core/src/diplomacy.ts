import type { PlayerId } from './ids.js';
import type { GameState } from './state.js';
import { err, ok, type Result } from './result.js';

export interface DiplomaticRelation {
  readonly a: PlayerId;
  readonly b: PlayerId;
  readonly status: 'peace' | 'war';
  readonly offer?: PlayerId;
  readonly truceUntil?: number;
}

/** Unrecorded relations in older games retain their existing state of war. */
export const relationOf = (state: GameState, a: PlayerId, b: PlayerId): DiplomaticRelation =>
  state.diplomacy?.find(
    (relation) => relation.a === Math.min(a, b) && relation.b === Math.max(a, b),
  ) ?? { a: a < b ? a : b, b: a < b ? b : a, status: 'war' };

export const atWar = (state: GameState, a: PlayerId, b: PlayerId): boolean => {
  if (a === b) return false;
  if (
    state.players.some(
      (player) => (player.id === a || player.id === b) && player.kind === 'barbarian',
    )
  )
    return true;
  return relationOf(state, a, b).status === 'war';
};

export type DiplomaticOrder = 'DeclareWar' | 'OfferPeace' | 'AcceptPeace';

/** Placeholder treaty duration; the AI respects this buildup window after peace. */
export const PEACE_TREATY_TURNS = 20;

export const changeDiplomacy = (
  state: GameState,
  actor: PlayerId,
  target: PlayerId,
  order: DiplomaticOrder,
): Result<GameState, string> => {
  const from = state.players.find((player) => player.id === actor);
  const to = state.players.find((player) => player.id === target);
  if (from?.kind !== 'civ' || to?.kind !== 'civ' || actor === target)
    return err('Diplomacy requires two different civilizations.');
  const current = relationOf(state, actor, target);
  let next: DiplomaticRelation;
  if (order === 'DeclareWar') {
    if (current.status === 'war') return err('These civilizations are already at war.');
    next = { a: current.a, b: current.b, status: 'war' };
  } else if (order === 'OfferPeace') {
    if (current.status !== 'war') return err('These civilizations are already at peace.');
    if (current.offer === actor) return err('Your peace offer is already pending.');
    next = { ...current, offer: actor };
  } else {
    if (current.status !== 'war' || current.offer !== target)
      return err('There is no peace offer from this civilization to accept.');
    next = {
      a: current.a,
      b: current.b,
      status: 'peace',
      truceUntil: state.turn + PEACE_TREATY_TURNS,
    };
  }
  const diplomacy = [
    ...(state.diplomacy ?? []).filter(
      (relation) => relation.a !== current.a || relation.b !== current.b,
    ),
    next,
  ].sort((a, b) => Number(a.a) - Number(b.a) || Number(a.b) - Number(b.b));
  return ok({ ...state, diplomacy });
};
