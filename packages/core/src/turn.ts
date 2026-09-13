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
 * 4. **culture** for every city (city-id order) — M9, then
 * 5. research for every civilization (player-id order) — M5, then
 * 6. the money loop for every civilization (player-id order) — M4b, then
 * 7. the barbarian step (unit-id order) — M6, then
 * 8. every unit's movement refilled, then
 * 9. **the ownership layer recomputed** from the cities — M9, then
 * 10. `turn += 1`.
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
 * - **The barbarian step runs between the money loop and the refill (M6), and both
 *   halves of that position are observable.** Barbarians have no policy (M6: "Barbarians
 *   are ENGINE behaviour, not a policy"), so this is the only place their units ever
 *   act, and `barbarians.ts` owns what they do.
 *   - *After the money loop*, because the money loop is the turn's ledger for the
 *     civilizations. A barbarian can take a city away from one of them — capture is
 *     "the point of barbarians" — and the turn it does so is the turn its former owner
 *     still collects that city's gold, because the bill was read from the world as it
 *     stood two steps earlier. Running the barbarian step first would silently move a
 *     captured city's revenue to the following turn, and the acceptance evidence pins
 *     that number.
 *   - *Before the refill*, because an attack costs a unit **all** of its remaining
 *     movement. The refill is the last thing a turn does to the world, so it hands back
 *     what a barbarian spent: a band that attacked this turn still has a full budget
 *     when the next turn's step reads it — one action per turn, as M6 intends. With the
 *     refill first, every barbarian would spend *next* turn's movement on this turn's
 *     attack and act once every two turns.
 *   - It draws nothing from any policy's stream: the step's only randomness is a
 *     battle's, and `applyCommand` → `combat.ts` takes it from `state.rng`.
 * - **`revision` is not touched here.** It counts *applied commands* (M2
 *   invariant 2), and advancing a turn is one step of one command: `applyCommand`
 *   bumps it exactly once. This keeps the pipeline usable by a caller that is not
 *   a command (a test, a future "advance N turns" harness) without inventing
 *   revisions. It stays true with M6's step: a barbarian's action is *applied* by
 *   `applyCommand` — that is how it is guaranteed to be the same combat and movement
 *   path a civilization uses — but nobody issued it as a command, so the step hands
 *   back the revision it was given (`barbarians.ts` says this too).
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
// M6's step of the pipeline. This is the one step that must reach *into* the command
// layer at runtime — "a barbarian's battle is the same combat path a civilization's is"
// means calling `applyCommand`, not re-resolving a battle out of `combat.ts` — so this
// pair is a cycle (`commands.ts → turn.ts → barbarians.ts → commands.ts`) where the
// other steps all keep the edge type-only. It is safe because the cycle is entered only
// at call time: `barbarians.ts` reads the applier's bindings inside function bodies and
// never while modules are being evaluated, so both directions work whichever one is
// imported first. `barbarians.ts`' module note argues this at length.
import { advanceBarbarians } from './barbarians.js';
// M9: the ownership layer's one writer. This module never computes a border — it asks
// `borders.ts` to recompute the whole layer from the cities, which is what makes the
// stored layer a cache of a pure function rather than an accumulation. A value import,
// and a one-way edge at runtime: `borders.ts` imports `turn.ts` not at all.
import { withOwnership } from './borders.js';
// M9: the culture step. `culture.ts` owns the per-turn accumulation and the one-off
// wonder bonus; this module decides only *when* the accumulation runs.
import { applyCulture } from './culture.js';
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
// M9: the victory *rule*, asked before the first step so that a finished game cannot
// advance. `victory.ts` imports `turn.ts` not at all, so the edge is one-way.
import { gameOutcomeOf } from './victory.js';
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
 *   the same turn it finishes one (movement is refilled at the end of the turn —
 *   step 7 — and `StartWork` requires movement), which is a **placeholder** reading
 *   of "a worker does one
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
 * civilization, then **the money loop**, then **the barbarian step**, then refill
 * movement, then `turn += 1` — in that order, for the reasons in the module note (the
 * first step is first because an improvement finished this turn pays out this turn).
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
 * M6's step is *after the money loop and before the refill* — the contract fixes that
 * position, and both halves of it are observable. The module note above argues them;
 * the short version is that a civilization still collects a city's gold on the turn a
 * barbarian takes it (the ledger was read two steps earlier), and that an attack, which
 * costs a unit all of its movement, is paid for out of *this* turn's budget because the
 * refill that hands the budget back runs after it. `barbarians.ts` decides what the
 * barbarians do; this function only decides when, and the step is a no-op for a state
 * whose barbarian player owns no units (which is every state `newGame` builds).
 *
 * The event list is in pipeline order — work, growth, production, research, money,
 * barbarians — so a consumer reads what was built, then what was researched, then what
 * both cost, then what the barbarians did about it.
 *
 * Pure: the returned state is a fresh object built from `state`, which is never
 * modified, and the same `(state, ruleset)` always yields an equal result.
 */
export const advanceTurn = (state: GameState, ruleset: RulesetView): TurnOutcome => {
  // **M9: a finished game does not advance.** `EndTurn` is the one command the
  // victory gate in `commands.ts` still accepts on a finished game (it is how a runner
  // *reports* the ending rather than how it plays on), so the pipeline itself has to be
  // the thing that refuses to move the world once a condition holds — otherwise the
  // turn counter would keep climbing and the outcome's own `turn` would stop being the
  // turn the game ended on.
  //
  // It is asked **first**, before any step, for the same reason `applyCommand`'s gate is
  // asked before its `switch`: one check covers every step, and no future step can be
  // added in a place this misses. The returned state is the input object itself — not a
  // copy — so an `EndTurn` on a finished game is provably a no-op, and `EndTurn`'s
  // `revision` bump in the command layer is the only thing that moves (which is
  // correct: a command *was* applied, and it changed only the command counter).
  if (gameOutcomeOf(state, ruleset) !== null) return { state, events: [] };

  const worked = advanceWork(state);
  const grown = applyGrowth(worked.state, ruleset);
  const produced = applyProduction(grown.state, ruleset);
  // M9, step 4: **culture**, in city-id order. It sits after production and before
  // research, which is the contract's position and is observable in both directions:
  // a culture-producing building completed this turn banks its first culture this turn
  // (the M4c rule, applied one step later in the same direction as growth, production
  // and research), and nothing about culture is read by the research step, so the
  // position costs nothing on the other side. A wonder's *one-off* bonus does **not**
  // come from here — `production.ts` applies it at the moment of completion, for
  // exactly the same reason.
  const cultured = applyCulture(produced.state, ruleset);
  // M5, step 5: what each civilization's banked beakers buy. Reads the pool the
  // money loop below has not touched yet — that is the point of the position, not an
  // oversight; see the module note above and `tech.ts`'s.
  const researched = applyResearch(cultured.state, ruleset);
  // M4b, step 6: income, upkeep and bankruptcy for every civilization.
  const paid = applyEconomy(researched.state, ruleset);
  // M6, step 6: the barbarians' turn. Engine behaviour with no policy behind it, run
  // *after* the money loop (so a city a barbarian captures this turn still paid its
  // former owner this turn) and *before* the refill (so the movement an attack spends
  // is this turn's, and the band is refilled at the end of it like every other unit).
  // Moving this call changes outcomes in both directions — `turn.test.ts` pins both.
  const barbarians = advanceBarbarians(paid.state, ruleset);
  const refilled = refillMovement(barbarians.state, ruleset);
  // M9, step 8: the ownership layer, recomputed from the cities and their culture —
  // which are exactly what the culture step above just moved. It runs *after* the
  // barbarian step so that a city a barbarian captured this turn transfers its claim on
  // this turn rather than the next one, and *before* the turn increments because the
  // layer is a property of the turn that produced it.
  //
  // This is the second of this module's three writes to the layer and neither of them
  // computes a border: `borders.ts`' `withOwnership` recomputes from the cities, so
  // there is one rule and no accumulation to drift (the state's own doc says why the
  // materialisation is safe at all).
  const owned = withOwnership(refilled, ruleset);

  return {
    state: { ...owned, turn: owned.turn + 1 },
    events: [
      ...worked.events,
      ...grown.events,
      ...produced.events,
      ...cultured.events,
      ...researched.events,
      ...paid.events,
      ...barbarians.events,
    ],
  };
};
