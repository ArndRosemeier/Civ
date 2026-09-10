/**
 * Legal actions — the single source of truth for "what may this player do now?",
 * shared by the AI, the UI and the tests (PLAN.md §5.2, PLAN.md §5.3's "one
 * source of truth for legality, so UI and AI cannot disagree with the engine").
 * See docs/INTERFACES.md, M2 ("Core — commands, errors, legal actions") and M3
 * ("Commands (added to the frozen union)").
 *
 * Design notes:
 *
 * - **Legality is not restated here.** Every candidate tile is filtered through
 *   `planMove`, and `FoundCity` is offered only when `planFoundCity` — the same
 *   evaluators `applyCommand` refuses with — accepts it, so a yielded action
 *   cannot be one the engine would reject. That is the keystone property
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
 * - **Cities are queried, not enumerated.** `legalActions` offers `FoundCity` for
 *   every settler that can found one, because founding is a *unit's* action: the
 *   unit either can or cannot, and the command space is one entry per unit.
 *   `SetWorkedTiles` and `SetProduction` are deliberately **not** yielded: a
 *   production item is a content choice and an assignment is a search space
 *   (`C(radius, population)` candidates, not an action list), so a generator that
 *   yielded "the" assignment would be advertising an arbitrary subset as if it
 *   were the whole of what is legal — the most dangerous kind of incomplete
 *   generator, because it looks complete. Their legality is still stated once, in
 *   `planSetWorkedTiles` / `planSetProduction`, and `actions.test.ts` sweeps a
 *   candidate universe of both legal and illegal choices through those evaluators
 *   against `applyCommand` in both directions.
 * - **Deterministic order.** Units are visited in `state.units` order (sorted by
 *   id, INTERFACES.md M2); each unit yields `FoundCity` (when it can found) and
 *   then its moves, sorted ascending by tile index; `EndTurn` is last. Two calls
 *   on the same state yield identical sequences — a precondition for the AI, for
 *   transcripts and for state hashes.
 * - **Fog is not a legality rule in M2.** Whether a tile is explored never
 *   affects a unit's options (INTERFACES.md M2, "Fog"): visibility is a rendering
 *   concern for `textview`, not a movement constraint. Nor is it one in M3 —
 *   founding a city does not require that the player has "seen" the site, only
 *   that the settler is standing on it.
 * - **`legalActions` is lazy.** It is a generator so a caller that wants the
 *   first legal action (the REPL, a scripted scenario, a search that prunes)
 *   never materialises the whole space (PLAN.md §5.2).
 */

import { planFoundCity, planMove, type Command } from './commands.js';
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
 * Every command `unitId` can currently issue, in order: `FoundCity` first — a
 * settler's defining action, and the one that ends its life as a unit — then one
 * `MoveUnit` per tile in `unitMoveOptions` order.
 *
 * A unit's actions are its own: `EndTurn` is a *player* action, not something a
 * unit does, so it is yielded by `legalActions` alone. Neither are the two city
 * commands — see the module note on why they are queries rather than enumerated
 * actions. An unknown unit has no actions; the empty list is the answer, not an
 * error, because asking about a unit that is not there is a question the UI asks
 * every frame.
 *
 * `FoundCity` is offered exactly when `planFoundCity` accepts it, acting as the
 * unit's own owner — so a settler is not offered a city it cannot found (a
 * non-settler, a settler on water, or one too close to an existing city), and a
 * settler that has already founded one is not in `state.units` at all to be
 * asked.
 */
export const unitActions = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): readonly Command[] => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return [];

  const found: readonly Command[] = planFoundCity(state, ruleset, unit.owner, unitId).ok
    ? [{ type: 'FoundCity', unitId }]
    : [];

  const moves: readonly Command[] = unitMoveOptions(state, ruleset, unitId).map((to): Command => ({
    type: 'MoveUnit',
    unitId,
    to,
  }));

  return [...found, ...moves];
};

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
