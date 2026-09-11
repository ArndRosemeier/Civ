/**
 * The turn pipeline — the single definition of what "a turn" means.
 * See docs/INTERFACES.md M3 and M4a ("advanceTurn order"), PLAN.md §5.3
 * (determinism).
 *
 * `advanceTurn` is the only place the order exists, and the order is part of the
 * frozen contract:
 *
 * 1. work progress for every unit (unit-id order), then
 * 2. growth for every city (city-id order), then
 * 3. production for every city (city-id order), then
 * 4. research for every civilization (player-id order) — M5, then
 * 5. the money loop for every civilization (player-id order) — M4b, then
 * 6. every unit's movement refilled, then
 * 7. `turn += 1`.
 *
 * Why it is a module rather than a branch of `EndTurn`: the ordering is the kind
 * of rule that quietly gets re-derived. The CLI, a scenario harness, a "skip
 * turns" convenience and a future AI all want to advance the world, and if any of
 * them re-implemented *work, growth, production, refill, turn* in its own words,
 * the game would have several definitions of a turn that agree only until
 * somebody edits one. So the pipeline is exported, `EndTurn` calls it, and nothing
 * else spells the order out.
 *
 * Design notes:
 *
 * - **Work runs first, before growth and production, and that is the point of the
 *   order.** An improvement finished this turn must contribute to *this* turn's
 *   yields: a mine that completes on turn 12 adds its shield to the city that
 *   works the tile on turn 12, not on turn 13. Growth and production both read
 *   `cityYields`, which is where improvements enter a city's output, so completing
 *   a job after either of them would silently delay it by a turn. This is
 *   observable (the shield total of the completing turn differs) and it is why the
 *   step is number one — **do not "fix" this order into growth-first**, and
 *   `commands.test.ts` pins the exact numbers so a reordering has to change a test
 *   on purpose.
 * - **Growth runs before production, and that is observable too.** A city that
 *   grows during a turn has one more citizen (and one more worked tile, assigned
 *   by growth) *before* its shields are counted, so the turn a city grows is also
 *   the turn it produces slightly more. The reverse order would be equally
 *   implementable and would give different numbers — which is exactly why the
 *   contract fixes the order and why `commands.test.ts` pins it.
 * - **The refill is total.** A unit whose type the ruleset does not define is
 *   carried over untouched rather than given a guessed budget or refusing the
 *   turn: M2's adversarial sweep found `legalActions` yielding `EndTurn` for a
 *   state with such a unit, and a generator and an applier that disagree is a
 *   bug. There is no honest movement number for a type nothing describes.
 * - **The work step is total as well, and it is not gated on the type.** A job is
 *   a property of the *unit*, not of its type: a state whose worker's `type` is
 *   absent from the ruleset still has a job with a tile and a count, and the job
 *   completes on the turn it owes — the improvement is built by the state's own
 *   record of it. Reading the catalog here (to re-check `allowedRoles`, say) would
 *   make an unresolvable type also freeze work in place, which is the sort of
 *   silent half-failure the refill's totality exists to avoid. The catalog decides
 *   what an improvement *does* (in `cityYields`), never whether the work happened.
 * - **The money loop runs between research and the refill (M4b), and that is
 *   observable in both directions.** Production has already added a finished unit
 *   to `state.units`, so the turn a unit appears is the turn its owner starts paying
 *   support for it; and the refill runs after bankruptcy, so a unit disbanded this
 *   turn is gone before anything gives it movement back. The full argument is on
 *   `advanceTurn` below, where the order is written; nothing else in the pipeline
 *   reads a treasury or a rate, and `turn.ts` still knows nothing about how money is
 *   counted (`economy.ts` owns that).
 * - **Research runs between production and the money loop (M5), and the beaker
 *   ordering question that raises is answered in `tech.ts`, not here.** The short
 *   version, because the position is what this file decides: research spends the pool
 *   the *previous* turn's money loop left, and the money loop that runs after it is
 *   the only thing that ever adds to the pool. Research therefore cannot credit itself
 *   anything, and no beaker is credited and spent in the same step. The long version —
 *   why that is the only reading consistent with the frozen order, what the rejected
 *   reading was, and why a science-multiplying building finished this turn still
 *   contributes to this turn — is the module note at the top of `tech.ts`. **Do not
 *   move this step after the money loop to "fix" it**; that is the double-credit the
 *   contract warns about.
 * - **`revision` is not touched here.** It counts *applied commands* (M2
 *   invariant 2), and advancing a turn is one step of one command: `applyCommand`
 *   bumps it exactly once. This keeps the pipeline usable by a caller that is not
 *   a command (a test, a future "advance N turns" harness) without inventing
 *   revisions.
 * - **Events, not diffs.** The events returned are the *world's* events — whose
 *   job finished, who grew, who starved, what was produced — in pipeline order.
 *   `TurnEnded` is not among them: it names the acting player and belongs to the
 *   command layer, which appends it after these. There is no event for a job that
 *   merely lost a turn: that is visible in the state's `turnsLeft`, and a per-turn
 *   line per worker would say nothing a caller can act on. The whole list is plain
 *   data, so an event log is as hashable and as reproducible as the state it came
 *   from.
 *
 * Deterministic and pure: every ordering is stated (unit id, city id, ascending
 * tile), no ambient state is read, and the input state is never modified.
 */

import type { GameEvent } from './commands.js';
// M4b's step of the pipeline. `economy.ts` imports `GameEvent` from `commands.ts`
// type-only, so this is the only runtime edge in the pair and there is no cycle.
import { applyEconomy } from './economy.js';
import { applyGrowth } from './growth.js';
import { withImprovement } from './improvements.js';
import type { RulesetView } from './map.js';
import { applyProduction } from './production.js';
import type { GameState } from './state.js';
// M5's step of the pipeline. `tech.ts` imports `GameEvent` from `commands.ts`
// type-only, so — like `economy.ts` above — this is the only runtime edge in the pair
// and there is no cycle.
import { applyResearch } from './tech.js';
import { unitDef, withoutWork, type Unit } from './units.js';

/** The state after a turn, and everything that happened during it. */
export interface TurnOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * Pay one turn of every unit's job, in **unit-id order** — sorted explicitly, so a
 * hand-built state whose `units` array is unsorted still pays its jobs in the
 * order the contract names — completing the ones that reach zero.
 *
 * - **A job's last turn builds the improvement.** `withImprovement` adds the
 *   `(tile, kind)` pair to the state — idempotently and in the order
 *   `improvements.ts` fixes — so a job that completes twice (which cannot happen
 *   in one pass, but could in a hand-built state whose pair list already carries
 *   it) still leaves one entry, and the hash cannot depend on how often it was
 *   built.
 * - **Completion is read off the job, not the catalog.** See the module note: a
 *   type the ruleset cannot resolve does not freeze work, and an improvement kind
 *   the catalog does not describe is still recorded as built. What it *yields* is
 *   the catalog's business (`cityYields`), and an unknown kind yields nothing.
 * - **`turnsLeft` that is not a positive count is treated as due.** A hand-built
 *   state — or an edited save — can carry `0`, a negative number, or something
 *   that is not a number at all; the job finishes this turn rather than writing a
 *   non-integer count back into the state, which would make it unhashable. The
 *   command layer never produces such a value (`planStartWork` refuses a catalog
 *   row whose `turns` is not a usable count).
 * - **A job naming a tile that is not a whole index is carried over, not
 *   completed.** Completion writes the `(tile, kind)` pair into
 *   `state.improvements`, and this is the one place the pipeline could put a value
 *   into the state that no command produced — so a malformed tile leaves the unit
 *   exactly as it was, the same "leave it alone rather than guess" reading the
 *   movement refill takes for a type the ruleset cannot resolve. No command can
 *   create such a job (`planStartWork` requires the unit's tile to be a whole
 *   index on the map), so this only ever fires for a hand-built or corrupted
 *   state, and it never silently drops the job the way a cancellation would.
 * - **The unit is idle afterwards**, by `withoutWork` — the key is removed, never
 *   written as `undefined`. That also releases the worker to start another job on
 *   the same turn it finishes one (movement is refilled at step 5, and `StartWork`
 *   requires movement), which is a **placeholder** reading of "a worker does one
 *   thing at a time": it is chosen to be playable and is not sourced from Civ 3.
 */
const advanceWork = (state: GameState): TurnOutcome => {
  let working = state;
  const events: GameEvent[] = [];
  const units: Unit[] = [];

  // Sorted explicitly rather than trusting the array, exactly as `applyGrowth`
  // sorts city ids: `state.units` *is* sorted by id on every state the engine
  // built, but the contract says "in unit-id order", and this makes that true of a
  // hand-built state too — the rebuilt array is then sorted by construction.
  const inIdOrder = [...state.units].sort((a, b) => Number(a.id) - Number(b.id));

  for (const unit of inIdOrder) {
    const work = unit.work;
    if (work === undefined) {
      units.push(unit);
      continue;
    }

    const turnsLeft = work.turnsLeft - 1;
    if (turnsLeft > 0) {
      units.push({ ...unit, work: { ...work, turnsLeft } });
      continue;
    }

    if (!Number.isInteger(Number(work.tile))) {
      units.push(unit);
      continue;
    }

    units.push(withoutWork(unit));
    working = withImprovement(working, work.tile, work.kind);
    events.push({
      type: 'WorkCompleted',
      unitId: unit.id,
      kind: work.kind,
      tile: work.tile,
    });
  }

  return { state: { ...working, units }, events };
};

/**
 * Refill every unit's movement to its type's movement, leaving a unit whose type
 * the ruleset cannot resolve exactly as it is. Units are visited in `state.units`
 * order (sorted by id), which keeps the rebuilt array sorted by construction.
 *
 * A unit that is working is refilled like any other: a job costs the movement it
 * spent *starting* (`StartWork` zeroes it) and nothing per turn — a **placeholder**
 * rule of ours, since M4a fixes only the starting cost. The refill gives a worker
 * the movement to walk away (cancelling the job) or, once the job completes, to
 * start the next one on the same turn.
 */
const refillMovement = (state: GameState, ruleset: RulesetView): GameState => {
  const units: readonly Unit[] = state.units.map((unit) => {
    const def = unitDef(ruleset, unit.type);
    return def === undefined ? unit : { ...unit, movementLeft: def.movement };
  });
  return { ...state, units };
};

/**
 * Advance the world by exactly one turn: work progress for every unit, then
 * growth for every city, then production for every city, then **research** for every
 * civilization, then **the money loop**, then refill movement, then `turn += 1` — in
 * that order, for the reasons in the module note (the first step is first because an
 * improvement finished this turn pays out this turn).
 *
 * M5's step sits *after production and before the money loop*, and both halves of
 * that placement are the contract's:
 *
 * - **After production**, because production can complete a science-multiplying
 *   building (a library, say) this turn, and M4c's rule is that an effect finished
 *   this turn contributes to this turn: the money loop that runs two steps later
 *   reads `cityYields`, which is where a building's `beaker-multiplier` enters, so
 *   the library multiplies the science of the very turn it is finished.
 * - **Before the money loop**, which is what makes the pool unambiguous. Research
 *   spends what is banked when the step runs — i.e. what the *previous* turn's money
 *   loop left — and the money loop that follows is the only thing that ever adds to
 *   the pool. So the beakers a turn's cities produce cannot be spent by the same
 *   turn's research step: the science this library multiplied lands in the pool at the
 *   end of the turn and can complete a tech at the start of the next one. That is the
 *   pipeline-delay reading, worked out in full — including the reading the contract's
 *   phrasing invites and why it is rejected — at the top of `tech.ts`. **Do not move
 *   this step after the money loop**: that would spend each turn's collection the
 *   instant it arrived, the double-credited beaker the contract's conservation
 *   invariants exist to catch.
 *
 * M4b's step is *after research and before the refill*, and both halves of that
 * placement are observable:
 *
 * - **After production** (and after M5's research, which produces no gold and no
 *   upkeep), so a unit produced this turn costs support **from the turn it appears**.
 *   Production has just added it to `state.units`, and the money loop counts every
 *   unit its owner has — so the turn a city finishes a unit is also the turn its owner
 *   starts paying for it. Running the money loop first would hand out a free turn of
 *   support to every unit ever built, which is both a different game and a number the
 *   acceptance evidence would pin. (The same argument the work step makes for running
 *   first: the step that *creates* the thing must come before the step that charges
 *   for it.)
 * - **Before the refill**, because the refill is the last thing a turn does to the
 *   world before `turn += 1`, and bankruptcy must not be able to bring a unit back
 *   that a *later* step has already touched. A disbanded unit is gone for good —
 *   there is nothing left to refill, and the refill simply does not see it. (The
 *   refill is also total over the units it does see, so the two orders cannot
 *   disagree about a unit's movement; the difference is only whether a unit
 *   disbanded this turn still exists when the refill runs, and "gone" is the
 *   honest answer.)
 *
 * The event list is in pipeline order — work, growth, production, research, money —
 * so a consumer reads what was built, then what was researched, then what both cost.
 *
 * Pure: the returned state is a fresh object built from `state`, which is never
 * modified, and the same `(state, ruleset)` always yields an equal result.
 */
export const advanceTurn = (state: GameState, ruleset: RulesetView): TurnOutcome => {
  const worked = advanceWork(state);
  const grown = applyGrowth(worked.state, ruleset);
  const produced = applyProduction(grown.state, ruleset);
  // M5, step 4: what each civilization's banked beakers buy. Reads the pool the
  // money loop below has not touched yet — that is the point of the position, not an
  // oversight; see the module note above and `tech.ts`'s.
  const researched = applyResearch(produced.state, ruleset);
  // M4b, step 5: income, upkeep and bankruptcy for every civilization.
  const paid = applyEconomy(researched.state, ruleset);
  const refilled = refillMovement(paid.state, ruleset);

  return {
    state: { ...refilled, turn: refilled.turn + 1 },
    events: [
      ...worked.events,
      ...grown.events,
      ...produced.events,
      ...researched.events,
      ...paid.events,
    ],
  };
};
