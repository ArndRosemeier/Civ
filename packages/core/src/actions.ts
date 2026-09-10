/**
 * Legal actions — the single source of truth for "what may this player do now?",
 * shared by the AI, the UI and the tests (PLAN.md §5.2, PLAN.md §5.3's "one
 * source of truth for legality, so UI and AI cannot disagree with the engine").
 * See docs/INTERFACES.md, M2 ("Core — commands, errors, legal actions").
 *
 * Design notes:
 *
 * - **Legality is not restated here.** Every candidate tile is filtered through
 *   `planMove` — the same evaluator `applyCommand` refuses with — so a yielded
 *   action cannot be one the engine would reject. That is M2's keystone property
 *   (INTERFACES.md, invariant 1, as amended): the UI cannot offer a move that
 *   fails, and the AI cannot waste a decision on one.
 * - **The agreement runs both ways.** These generators are the *complete*
 *   statement of what a player may do, not merely a sound subset: every command
 *   `applyCommand` accepts for a real player is one of these. Where the two could
 *   disagree the applier was made total (`EndTurn` in `commands.ts`), not the
 *   generator silent — an adversarial sweep found `legalActions` yielding an
 *   `EndTurn` that `applyCommand` refused when a unit's type was missing from the
 *   ruleset, and the honest fix is for the turn to apply. `actions.test.ts`
 *   asserts both directions on every board it builds, that state included.
 * - **Deterministic order.** Units are visited in `state.units` order (sorted by
 *   id, INTERFACES.md M2) and a unit's options are sorted ascending by tile
 *   index, so two calls on the same state yield identical sequences — a
 *   precondition for the AI, for transcripts and for state hashes.
 * - **Fog is not a legality rule in M2.** Whether a tile is explored never
 *   affects a unit's options (INTERFACES.md M2, "Fog"): visibility is a rendering
 *   concern for `textview`, not a movement constraint.
 * - **`legalActions` is lazy.** It is a generator so a caller that wants the
 *   first legal action (the REPL, a scripted scenario, a search that prunes)
 *   never materialises the whole space (PLAN.md §5.2).
 */

import { planMove, type Command } from './commands.js';
import type { PlayerId, TileIndex, UnitId } from './ids.js';
import { neighbors8, type RulesetView } from './map.js';
import type { GameState } from './state.js';
import { unitById } from './units.js';

/**
 * Every adjacent tile `unitId` may legally step onto, in ascending tile-index
 * order. Empty when the unit does not exist, when nothing is affordable, or when
 * every neighbour is impassable or held by another player.
 *
 * This is the AI's and the UI's hot path (PLAN.md §5.2 / §5.4: movement options
 * are computed once per unit per turn, not per query), so it is a filtered scan
 * of the 8 neighbours rather than an enumeration of the command space. Legality
 * is decided by the unit's own owner — a per-unit query has no acting player — so
 * a state whose unit belongs to a player missing from `state.players` (corrupt,
 * or hand-built) offers nothing, which is the same answer `applyCommand` gives
 * such an actor. The caching layer PLAN.md §5.4 mentions would key on
 * `state.revision`.
 */
export const unitMoveOptions = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): readonly TileIndex[] => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return [];

  const options = neighbors8(state.map, unit.tile).filter(
    (to) => planMove(state, ruleset, unit.owner, unitId, to).ok,
  );

  // `neighbors8` happens to emit ascending indices; sorting states the guarantee
  // rather than depending on that implementation detail.
  return [...options].sort((a, b) => a - b);
};

/**
 * Every command `unitId` can currently issue, in `unitMoveOptions` order.
 *
 * A unit's actions are its moves: `EndTurn` is a *player* action, not something
 * a unit does, so it is yielded by `legalActions` alone. An unknown unit has no
 * actions — the empty list is the answer, not an error, because asking about a
 * unit that is not there is a question the UI asks every frame.
 */
export const unitActions = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): readonly Command[] =>
  unitMoveOptions(state, ruleset, unitId).map((to): Command => ({ type: 'MoveUnit', unitId, to }));

/**
 * Every command `playerId` may issue right now, lazily: each of that player's
 * units' actions in id order, then one `EndTurn`.
 *
 * A player id that no player in the state carries yields nothing at all — an
 * absent player has no legal actions, and yielding an `EndTurn` that
 * `applyCommand` would refuse as `unknown-player` would break the keystone
 * property for exactly the input a mistyped id produces.
 *
 * `EndTurn` is always legal for a real player: M2 has no turn-order state to
 * violate, and the command layer refuses only what the rules forbid.
 */
export function* legalActions(
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): Generator<Command> {
  if (!state.players.some((player) => player.id === playerId)) return;

  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    for (const action of unitActions(state, ruleset, unit.id)) yield action;
  }

  yield { type: 'EndTurn' };
}
