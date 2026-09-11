/**
 * Legal actions — the single source of truth for "what may this player do now?",
 * shared by the AI, the UI and the tests (PLAN.md §5.2, PLAN.md §5.3's "one
 * source of truth for legality, so UI and AI cannot disagree with the engine").
 * See docs/INTERFACES.md, M2 ("Core — commands, errors, legal actions"), M3
 * ("Commands (added to the frozen union)") and M4a ("Workers", "Commands").
 *
 * Design notes:
 *
 * - **Legality is not restated here.** Every candidate tile is filtered through
 *   `planMove`, `FoundCity` is offered only when `planFoundCity` — the same
 *   evaluators `applyCommand` refuses with — accepts it, and M4a's two work
 *   commands are offered only where `planStartWork` / `planCancelWork` accept
 *   them. So a yielded action cannot be one the engine would reject. That is the
 *   keystone property (INTERFACES.md, invariant 1, as amended): the UI cannot
 *   offer a move that fails, and the AI cannot waste a decision on one.
 * - **The agreement runs both ways.** These generators are the *complete*
 *   statement of what a player may do, not merely a sound subset: every command
 *   `applyCommand` accepts for a real player is one of these. Where the two could
 *   disagree the applier was made total (`EndTurn` in `commands.ts`), not the
 *   generator silent — an adversarial sweep found `legalActions` yielding an
 *   `EndTurn` that `applyCommand` refused when a unit's type was missing from the
 *   ruleset, and the honest fix is for the turn to apply. `actions.test.ts`
 *   asserts both directions on every board it builds, that state included, and
 *   M4a's work commands extend the sweep to five generators rather than three.
 * - **`StartWork` is enumerated over the catalog, and that is complete.** The
 *   command names an improvement kind, so "every way this worker may start work"
 *   is exactly "every kind this ruleset can build here" — a finite list read from
 *   `improvementCatalog`, filtered by `planStartWork`, which is the applier's own
 *   evaluator. Duplicate ids in a foreign catalog are collapsed, because the
 *   applier's accepted set has one `StartWork` per *distinct* kind and a generator
 *   that yielded the same command twice would be advertising a choice that is not
 *   there.
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
 * - **The work commands *are* yielded**, unlike the two city setters, and the
 *   difference is not an inconsistency: a worker's job is one entry per catalog
 *   row — the unit either can start *that* job here or it cannot — so the
 *   enumeration is the whole space, not a sample of it. `CancelWork` is a single
 *   question about the unit's own state, and it is legal exactly when the unit is
 *   working.
 * - **Deterministic order.** Units are visited in `state.units` order (sorted by
 *   id, INTERFACES.md M2); each unit yields `FoundCity` (when it can found), then
 *   one `StartWork` per accepted catalog kind, then `CancelWork` (when it is
 *   working), then its moves, sorted ascending by tile index; `EndTurn` is last.
 *   The own-tile actions come before the moves because a move *relocates* the unit
 *   and relocation cancels a job (M4a) — the irreversible side effect sits last,
 *   after the choices that keep the unit where it is. Two calls on the same state
 *   yield identical sequences — a precondition for the AI, for transcripts and for
 *   state hashes.
 * - **Fog is not a legality rule in M2.** Whether a tile is explored never
 *   affects a unit's options (INTERFACES.md M2, "Fog"): visibility is a rendering
 *   concern for `textview`, not a movement constraint. Nor is it one in M3 —
 *   founding a city does not require that the player has "seen" the site, only
 *   that the settler is standing on it — nor in M4a, where a worker improves the
 *   tile it stands on and nothing asks who else has looked at it.
 * - **`legalActions` is lazy.** It is a generator so a caller that wants the
 *   first legal action (the REPL, a scripted scenario, a search that prunes)
 *   never materialises the whole space (PLAN.md §5.2).
 */

import {
  planCancelWork,
  planFoundCity,
  planMove,
  planStartWork,
  type Command,
} from './commands.js';
import { improvementCatalog, type ImprovementId } from './improvements.js';
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
 * Every command `unitId` can currently issue, in order:
 *
 * 1. `FoundCity` — a settler's defining action, and the one that ends its life as
 *    a unit;
 * 2. one `StartWork` per improvement this ruleset can build where the unit stands,
 *    in catalog order (M4a) — a worker's defining action, and one that commits the
 *    rest of its turn;
 * 3. `CancelWork` when the unit is working — the way back out of a job;
 * 4. one `MoveUnit` per tile in `unitMoveOptions` order.
 *
 * The own-tile actions come before the moves because a move relocates the unit and
 * *relocation cancels an in-flight job* (M4a): the destructive act is listed last,
 * after everything that leaves the unit where it is. `CancelWork` is inside that
 * own-tile group because a caller scanning the list for "what can this unit do
 * here?" should see the whole answer before the list starts offering to walk away.
 *
 * A unit's actions are its own: `EndTurn` is a *player* action, not something a
 * unit does, so it is yielded by `legalActions` alone. Neither are the two city
 * commands — see the module note on why they are queries rather than enumerated
 * actions. An unknown unit has no actions; the empty list is the answer, not an
 * error, because asking about a unit that is not there is a question the UI asks
 * every frame.
 *
 * Every command below is offered exactly when the applier's own evaluator accepts
 * it: `planFoundCity`, `planStartWork`, `planCancelWork`, `planMove` — acting as
 * the unit's own owner, since a per-unit query has no acting player. So a settler
 * is not offered a city it cannot found, a scout is not offered a mine, a worker
 * standing on grassland is not offered a mine, a worker on an already-mined hill
 * is not offered that mine again, and a worker with no movement left is offered no
 * job at all.
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

  // One candidate per *distinct* catalog kind, in catalog order, each decided by
  // `planStartWork` — the evaluator `applyCommand` refuses with. The applier's
  // accepted set is exactly this set, which is what makes the enumeration complete
  // rather than a sample: a job is named by its kind, and a kind is a finite list.
  const kinds: readonly ImprovementId[] = [
    ...new Set(improvementCatalog(ruleset).map((def) => def.id)),
  ];
  const started: readonly Command[] = kinds
    .filter((kind) => planStartWork(state, ruleset, unit.owner, unitId, kind).ok)
    .map((kind): Command => ({ type: 'StartWork', unitId, kind }));

  const cancelled: readonly Command[] = planCancelWork(state, unit.owner, unitId).ok
    ? [{ type: 'CancelWork', unitId }]
    : [];

  const moves: readonly Command[] = unitMoveOptions(state, ruleset, unitId).map((to): Command => ({
    type: 'MoveUnit',
    unitId,
    to,
  }));

  return [...found, ...started, ...cancelled, ...moves];
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
