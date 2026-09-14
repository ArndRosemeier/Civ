/**
 * `route.ts` — **the route query**: the fewest single steps from a unit to a tile.
 *
 * ## Why this is engine work
 *
 * `MoveUnit` is one adjacent step (`commands.ts`, `planMove`: a non-adjacent
 * destination is `invalid-argument` naming the distance). "Click a far tile and the
 * unit walks there" therefore needs a search, and a search is a *plan*, not a
 * rule — but the plan has to be made of steps the engine accepts, or the UI ends up
 * holding a route the applier refuses halfway along it.
 *
 * So this module exists to be the ONE route query, in the engine, next to the
 * movement rule it is built out of. It is deliberately not in `packages/web`:
 * `docs/UI-OVERHAUL.md` §7.4 records the owner's decision (shape (b) — a route query
 * in the engine, the destination held as UI intent), and §4.4a records why the
 * alternative was worse — the rule-scanner (`m8-adversarial.spec.ts`) flags every
 * line in `packages/web/src` that combines a rule word with arithmetic, and a route
 * search is exactly that shape.
 *
 * ## What it does NOT state, which is the whole point
 *
 * **Every "may the unit step there?" answer in here comes from `planMove`.** This
 * file never reads a terrain's `moveCost`, never asks whether terrain is
 * `impassable`, never looks for a unit or a city on a tile, and never compares a
 * cost against a movement allowance. It asks the engine, through the same evaluator
 * `applyCommand` refuses with and the same one `unitMoveOptions` and `unitActions`
 * filter with, on a *probe state* — the real state with this one unit standing on
 * the tile being expanded.
 *
 * The class of defect that avoids is the project's oldest one: two statements of a
 * rule that can disagree. A second movement rule here — "hills cost two", "an enemy
 * blocks" — would be free to drift from `planMove`, and the symptom would be a unit
 * that walks a route the applier then refuses mid-journey, in front of a player. The
 * AI made the same choice for the same reason (`ai/smart.ts` `stepsToTile`), and it
 * is the reason a search is allowed in the first place.
 *
 * ## The probe: this unit relocated, nothing else lifted off the board
 *
 * `planMove` reads the mover's position in exactly one clause — "is this a single
 * step?" — and every other clause is a fact about the **destination**: its terrain,
 * whether another player's unit or city holds it, and whether the unit can afford
 * it. A search that spans more than one tile therefore has to move the unit as it
 * expands, which is what the probe is.
 *
 * **The rest of the world stays on the board**, and that is a decision rather than
 * an omission: an enemy-occupied tile is not enterable (`planMove` refuses it with
 * `occupied-by-enemy`, because the command that answers it is `AttackUnit`), so a
 * route must go *around* a rival — a route through one would be a route the player
 * cannot execute, and the owner's decision 2 (`docs/UI-OVERHAUL.md` §8: a distant
 * enemy does nothing, no goto-then-attack) makes "arrive beside it and fight" a
 * different feature, not a hole this query should paper over.
 *
 * A *friendly* unit on a tile is not a wall — Civ 3 stacks, and `planMove` says so —
 * so leaving other friendly units on the board changes no answer. That is worth
 * stating because the AI's search does lift them (`searchStateFor`), and the two
 * searches differ there for a reason that is about the AI's question and not this
 * one's: it is looking for "is this city ever reachable", so it treats a rival army
 * in the way as passable ground and asks only the *city* rule against the goal.
 *
 * ## The movement budget each step is asked with, and why it is the unit's full one
 *
 * `planMove` decides affordability against `unit.movementLeft` — what the unit has
 * left *this turn*. A goto is a commitment across turns, so that is the wrong
 * question to ask about the fourth step: a tile a unit cannot afford with one point
 * left is a tile it can afford next turn, when `EndTurn` has refilled it. The probe
 * therefore carries the unit's **full movement for its type**, read from the ruleset
 * (`UnitDef.movement` — the same number `turn.ts` `refillMovement` writes into
 * `movementLeft` at every turn boundary, so it is the engine's own statement of
 * "what a fresh turn gives this unit", not a figure invented here).
 *
 * What that buys is a query that is a function of the world and the unit, and not of
 * the moment it was asked: the same board gives the same route whether the unit has
 * spent its movement or not, which is what lets a caller re-ask it cheaply —
 * `docs/UI-OVERHAUL.md` §8 requires exactly that, because noticing that a route has
 * been invalidated is how a goto is cancelled rather than silently recomputed.
 *
 * What it costs is stated plainly: **this query answers "is there a way", not "is
 * there a way this turn".** Whether a particular step can be taken *now* is a
 * different question, and it is asked of the engine where it belongs — a caller
 * dispatches the step only when `unitActions` offers it, and waits for the next turn
 * when it does not.
 *
 * ## Why the search runs backwards, from the destination
 *
 * Enterability is a property of the **destination tile alone**: the probe puts the
 * unit on whichever tile is expanding, so no answer depends on where the question
 * was asked from. The board is therefore a graph whose edges are adjacency and whose
 * *nodes* are enterable or not, and a breadth-first search from the destination
 * gives every tile that can reach it, in fewest steps.
 *
 * Two properties follow, and the second is the one a caller needs:
 *
 * 1. **A tile is reachable exactly when a forward search says so.** Both searches
 *    answer "does a shortest path exist", and that answer does not depend on which
 *    end of an undirected graph of this shape the search started from.
 * 2. **The route is a function of `(board, unit, destination)`** — it does not
 *    depend on the start — because the parent links form one tree rooted at the
 *    destination. So the route from the second tile of a route is **exactly** the tail
 *    of the route from the first, tie-breaking included. A caller that stores a route
 *    and re-asks from the tile it has reached can therefore compare the two for
 *    *equality* and get a meaningful answer: any difference means the world moved, not
 *    that the search changed its mind about equal-length paths. That is what makes
 *    "the route the player committed to is gone" a checkable fact rather than a guess.
 *
 *    **On the direction, honestly.** The property is *structural* here and only
 *    structural: with one tree rooted at the destination, the tail *is* the route, by
 *    construction. A forward search would have to earn it, and it is worth recording
 *    that a mutation which replaced this search with a forward one was **not** caught
 *    by the tests: measured over 31 432 `(unit, destination)` pairs on duel boards at
 *    seeds 1, 7, 31337, 4242 and 99, a forward breadth-first search returned a tail
 *    which was its own route from the second tile in every case tried. So the direction
 *    is chosen for the guarantee rather than to fix an observed failure — a forward
 *    search that grew a heuristic, a start-dependent tie-break or a cache keyed on
 *    anything but the destination could lose the property silently, and the caller
 *    leaning on it (`docs/UI-OVERHAUL.md` §8's "notice an invalidation") would then
 *    cancel gotos for no reason.
 *
 * The search is deterministic: tiles are visited in ascending index order, a tile is
 * settled once, and no clock, no RNG and no floating point is involved (PLAN.md
 * §5.3). Two calls on one state return the same route.
 *
 * ## What it deliberately does not do
 *
 * - **It does not consult fog.** Visibility is not a legality rule in this engine
 *   (`actions.ts`: "Fog is not a legality rule in M2"), so a route may cross ground
 *   the player has never seen. That is the engine's answer rather than an oversight,
 *   and it is precisely why a goto can be invalidated later by something the player
 *   could not see — the case `docs/UI-OVERHAUL.md` §8 decision 4 is about.
 * - **It does not route to a tile beside a target.** `AttackUnit` is a single
 *   adjacent action and goto-then-attack is not in the design (decision 2), so the
 *   only destination this query accepts is a tile the unit may stand on.
 * - **It is not exposed to the AI.** `ai/smart.ts` still holds its own search, with
 *   its own probe, its own goal set and its own caching, and this module does not
 *   replace it: that search is a measured hot path (11.4 M → 2.2 M `planMove` calls
 *   per game after its memoisation) and the six goldens were taken through it.
 *   Unifying the two is a real follow-up and is recorded as such in
 *   `docs/KNOWN-ISSUES.md`, rather than pretended away here.
 */

import { planMove, type GameError } from './commands.js';
import type { TileIndex, UnitId } from './ids.js';
import { inBounds, indexToX, indexToY, neighbors8, tileIndex, type RulesetView } from './map.js';
import { err, ok, type Result } from './result.js';
import type { GameState } from './state.js';
import { unitById, unitDef, type Unit } from './units.js';

/**
 * A route: one legal step at a time from where the unit stands to `to`.
 *
 * `steps` **excludes the unit's current tile** and is ordered — `steps[0]` is the
 * next single step, and the last entry is `to`. Empty when the unit is already
 * there, which is "a route of no steps" and not a failure.
 */
export interface RoutePlan {
  readonly unit: Unit;
  readonly to: TileIndex;
  readonly steps: readonly TileIndex[];
}

/** A tile the search has not settled. Distance `0` is real, so the sentinel is negative. */
const UNSET = -1;

/**
 * The engine's reason for an unreachable destination, in one sentence, naming both
 * tiles: `invalid-argument` is the member `planMove` itself uses for "this
 * destination is not a destination you can name" (a non-adjacent `MoveUnit`), so a
 * route query refusing a destination uses the same member rather than inventing one.
 */
const noRoute = (from: number, to: number): string =>
  `no route from tile ${String(from)} to tile ${String(to)}: every sequence of single ` +
  'steps between them is refused by the movement rule';

/**
 * The fewest single steps from `unitId`'s tile to `to`, in order, or the reason
 * there is no route.
 *
 * Fails with the same `GameError` members `planMove` uses for the questions they
 * share — an unknown unit, an absent player, a non-integer or off-map index — and
 * with `invalid-argument` (the engine's member for "this argument is not
 * acceptable") when the destination is a real tile that simply cannot be reached.
 * A unit already standing on `to` is `ok` with no steps.
 *
 * Asking about a unit the state does not hold is an error rather than an empty
 * route, unlike `unitActions`' empty list: "nothing can happen" and "there is no
 * such unit" are different answers, and a caller that conflated them would report a
 * vanished unit as an unreachable destination.
 */
export const planRoute = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
  to: TileIndex,
): Result<RoutePlan, GameError> => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return err({ kind: 'unknown-unit', unitId });
  // The same actor rule `planMove`'s four-argument form applies: a per-unit query
  // acts as the unit's own owner, and a state whose owner is missing from `players`
  // has no legal actor at all.
  if (!state.players.some((player) => player.id === unit.owner)) {
    return err({ kind: 'unknown-player', playerId: unit.owner });
  }
  if (!Number.isInteger(to)) {
    return err({
      kind: 'invalid-argument',
      detail: `"to" must be an integer tile index (got ${String(to)})`,
    });
  }
  if (!inBounds(state.map, indexToX(state.map, to), indexToY(state.map, to))) {
    return err({ kind: 'out-of-bounds', to });
  }

  const destination = to;
  if (unit.tile === destination) return ok({ unit, to: destination, steps: [] });

  const def = unitDef(ruleset, unit.type);
  if (def === undefined) {
    return err({
      kind: 'invalid-argument',
      detail: `the ruleset defines no unit type "${String(unit.type)}", so no movement budget can be read for it`,
    });
  }
  if (!Number.isInteger(def.movement) || def.movement < 0) {
    return err({
      kind: 'invalid-argument',
      detail:
        `unit type "${String(unit.type)}" has a non-integer or negative movement ` +
        `(${String(def.movement)})`,
    });
  }

  const map = state.map;
  const size = map.terrain.length;

  /**
   * The probe: this unit standing on `here`, with a full turn's movement.
   *
   * `planMove` reads the mover's position, so this is the only way to ask "may I step
   * from here to there?" about a tile the unit has not reached yet — and it is cheap,
   * because nothing but one row of `units` differs from the state the caller handed in.
   */
  const probe = (here: TileIndex): GameState => ({
    ...state,
    units: state.units.map((each) =>
      each.id === unit.id ? { ...each, tile: here, movementLeft: def.movement } : each,
    ),
  });

  /**
   * The **destination's own** enterability, asked before the search starts.
   *
   * Every other node in the search is checked when it is discovered — the step onto it
   * is the thing being tested — but the destination is the search's *root*, and a root
   * is discovered by nobody. Without this check the search returns a route that ends on
   * a tile the engine refuses: a rival standing on the destination, a rival city on it,
   * or impassable ground. That is not hypothetical. It is what this query did before
   * the check existed, and the test that caught it is `walksTheRoute`, which applies
   * every returned step through `applyCommand` and was refused at the last one
   * (`occupied-by-enemy`, tile 31).
   *
   * Asked from a neighbour, because the answer does not depend on which one asks (see
   * the module note on enterability being a property of the destination tile); a tile
   * with no neighbours at all cannot be entered.
   */
  const neighbourOfDestination = neighbors8(map, destination)[0];
  if (
    neighbourOfDestination === undefined ||
    !planMove(probe(neighbourOfDestination), ruleset, unit.owner, unit.id, destination).ok
  ) {
    return err({ kind: 'invalid-argument', detail: noRoute(unit.tile, destination) });
  }

  const distance = new Int32Array(size).fill(UNSET);

  // `onward[tile]` is the tile to step onto *from* `tile` on the way to the
  // destination: the parent link of a tree rooted at the destination, pointing at
  // the root. One tree, so a route's own tail is the route from its second tile.
  const onward = new Int32Array(size);
  const queue = new Int32Array(size);

  distance[Number(destination)] = 0;
  queue[0] = Number(destination);
  let head = 0;
  let tail = 1;

  while (head < tail) {
    const at = queue[head];
    head += 1;
    if (at === undefined) break;
    const settled = distance[at];
    if (settled === undefined) break;
    const here = tileIndex(map.width, indexToX(map, at), indexToY(map, at));
    const from = probe(here);
    for (const step of neighbors8(map, here)) {
      const index = Number(step);
      if (distance[index] !== UNSET) continue;
      // The one place this module decides anything, and it decides nothing: the
      // engine's own evaluator, asked about the destination tile.
      if (!planMove(from, ruleset, unit.owner, unit.id, step).ok) continue;
      distance[index] = settled + 1;
      onward[index] = at;
      queue[tail] = index;
      tail += 1;
    }
  }

  const start = Number(unit.tile);
  if (distance[start] === UNSET) {
    return err({ kind: 'invalid-argument', detail: noRoute(unit.tile, destination) });
  }

  const steps: TileIndex[] = [];
  let at = start;
  while (at !== Number(destination)) {
    const next = onward[at];
    // A settled tile that is not the root always has a parent, and the root ends the
    // loop, so this arm is a guard against a broken invariant rather than a case a
    // caller can reach. It reports rather than spinning.
    if (next === undefined || distance[next] === UNSET) {
      return err({
        kind: 'invalid-argument',
        detail:
          `the route search for tile ${String(destination)} produced no parent for tile ` +
          String(at),
      });
    }
    steps.push(tileIndex(map.width, indexToX(map, next), indexToY(map, next)));
    at = next;
  }
  return ok({ unit, to: destination, steps });
};
