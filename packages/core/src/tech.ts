/**
 * The tech tree's *rules* — what a tech costs, what it requires, what knowing it
 * unlocks, and what a turn does with a civilization's beakers.
 * See docs/INTERFACES.md M5 ("The tech tree", "Research", "Gating"), PLAN.md §5.3
 * (determinism) and §5.4 (data layout).
 *
 * This module is the **one** statement of the research rules, for the reason
 * `commands.ts` states about legality: the turn pipeline, `SetResearch`'s planner
 * and a future AI all have to answer "may this be researched, and what does it
 * cost?", and a second answer somewhere else would agree only until somebody
 * edited one of them. So the price of a tech, its missing prerequisites, whether it
 * is already known, what it unlocks and what happens to a surplus are all stated
 * here — and `commands.ts` and `turn.ts` *call* that statement rather than
 * restating it.
 *
 * ## The beaker-ordering question, answered once and in one place
 *
 * The frozen contract fixes the turn order as work, growth, production,
 * **research**, the money loop, refill, `turn += 1`, and then says research
 * "accumulate[s] the beakers the money loop has **not yet** credited — the split
 * happens in the money step, so research must read the pool the split just filled",
 * with an explicit instruction to report the ambiguity rather than pick a reading
 * silently if the ordering makes the pool ambiguous.
 *
 * Taken literally, the two halves disagree: research is step 4 and the split is
 * step 5, so research cannot read a pool that this turn's split fills *later*. There
 * are exactly two candidate readings and only one of them is consistent with the
 * frozen order, so the question resolves rather than being a free choice:
 *
 * 1. **The pipeline-delay reading — implemented here.** `PlayerState.beakers` has
 *    exactly one writer (the money loop, the only place a beaker is ever added) and
 *    exactly one spender (this step). Research therefore reads the pool *as the
 *    previous turn's money loop left it*: beakers produced in turn N are available to
 *    research at the start of turn N+1, so **a tech completes at the start of a turn
 *    from beakers banked at the end of the last one.** Under this reading the
 *    contract's phrase is exactly right and worth spelling out: research must not
 *    credit itself anything, because the split has not run yet — and if research also
 *    read this turn's science it would be counted twice, once by the split that
 *    banked it and once by the research step that spent it.
 * 2. **Running research after the money loop.** Reading "the pool the split just
 *    filled" literally means research happens *after* step 5, which is a different
 *    pipeline. Rejected: the order is contractual and explicit about research being
 *    step 4, and reordering a frozen pipeline is precisely the silent pick the
 *    contract warns against.
 *
 * What the frozen order is *for* also falls out of reading 1, which is the evidence
 * that it is the intended one rather than a convenient one: research sits after
 * production so that a science-multiplying building completed this turn contributes
 * to this turn (M4c's rule that an effect finished this turn applies this turn), and
 * it sits before the money loop so that no beaker is both credited and spent in the
 * same step. A library finished in turn N multiplies turn N's science, which lands in
 * the pool at the end of turn N and can complete a tech on turn N+1: the effect is
 * felt the turn it is built and nothing is double-credited. **Do not "fix" this by
 * moving the research step after the money loop** — that would spend each turn's
 * collection the instant it arrived, which is the double-credited/uncredited beaker
 * the contract's conservation invariants exist to catch.
 *
 * There is deliberately no second accumulator anywhere in this module: it writes
 * `beakers` only by *subtracting* a completed tech's cost, and `economy.ts` is the
 * only thing that ever adds to it.
 *
 * ## What one turn of research does
 *
 * - **Nothing being researched** → nothing happens at all: the pool stays banked (a
 *   player may stockpile), no event is emitted, and the state comes back unchanged.
 * - **Researching, pool below the cost** → nothing happens; the pool is untouched.
 * - **Researching, pool at or above the cost** → the tech becomes known (appended and
 *   kept **sorted and unique**), the cost is subtracted, the remainder **stays in the
 *   pool**, `researching` is **removed** — the key is absent, never `undefined`, the
 *   M3 rule — and one `TechResearched` event is emitted. The player chooses the next
 *   tech with `SetResearch`, and the remainder is already banked, so it is carried
 *   into whatever that choice is: that is the contract's "carry the remainder into
 *   whatever is researched next".
 * - **At most one tech per player per turn**, the same rule production states for
 *   items and for the same reason: a hand-built state with a thousand beakers must
 *   not complete half the tree in one step while the event list and the state have to
 *   stay in step. Leftover beakers stay in the pool and can buy the next tech next
 *   turn.
 * - **Barbarians are skipped**: they have no economy, so nothing ever credits their
 *   pool (`economy.ts` skips them for exactly that reason), and this module mirrors
 *   that rule rather than inventing a second one.
 * - **A tech whose prerequisite list is not satisfied never completes.** The contract
 *   says that is impossible by construction — a tech can only be selected when its
 *   prerequisites are known, and a known tech is never un-known — and asks for the
 *   invariant to be asserted anyway. It is asserted *structurally* here: the
 *   completion path is unreachable unless the same readiness check `SetResearch`
 *   consults returns "ready", so a hand-built state with an unsatisfied prerequisite
 *   is reported as `stuck` instead of completing.
 *
 * ## Gating
 *
 * M5's gating section gives units, buildings, improvements and resources an optional
 * `requiresTech`. This module owns the **read** half of that rule — `requiresTechOf`,
 * `unmetTechRequirement` and `techUnlocks` — so that "is this tech requirement
 * satisfied?" has one implementation wherever it is enforced, and `techUnlocks`
 * answers "what does completing this tech unlock?" from the catalogs rather than from
 * a hand-written list. Enforcement belongs where production and build legality are
 * already decided (`commands.ts`' `planSetProduction`/`planStartWork`), which is the
 * contract's requirement: the generator and the applier must consult the same rule.
 * **No shipped row declares `requiresTech` yet**, so in this build `techUnlocks`
 * honestly returns `[]` for every tech; the readers below are total, so they work
 * unchanged the moment content declares one.
 *
 * ## Determinism
 *
 * Integers only: costs are integers (validation requires `>= 1`), the comparison is
 * `<`/`-`, and players are visited in `players` array order — the same order the money
 * loop uses — so the event stream is a deterministic function of the state. No RNG, no
 * clock, no transcendentals (PLAN.md §5.3).
 *
 * ## Provenance
 *
 * This module adds **no numbers of its own**: every cost comes from a rules row
 * (`TechSpec.cost`) and every prerequisite from a rules row (`TechSpec.requires`), and
 * those M5 rows are `placeholder(...)` in `@civts/rules` — our own tuned values,
 * **not** traced to Civ 3. The rules *this* module states (one writer and one spender
 * of the pool, one completion per player per turn, the remainder carried, the pipeline
 * delay above) are the engine's own placeholder rules, chosen to be playable and
 * honest about what they are.
 */

import type { GameEvent } from './commands.js';
import { asTechId, type PlayerId, type TechId } from './ids.js';
import type { RulesetView } from './map.js';
import { err, ok, type Result } from './result.js';
import type { GameState, PlayerState } from './state.js';

/**
 * The engine's structural view of a **tech row**.
 *
 * `era` is a plain `string` here and an ordered vocabulary (`EraId` in
 * `@civts/rules`) in content, and that split is deliberate: nothing in the engine
 * orders eras. Research prices a tech, checks its prerequisites and spends beakers;
 * only validation (`checkTechEras`) and a UI that groups the tree by age need to know
 * that `ancient` comes before `medieval`. Widening the field here is what stops the
 * engine from acquiring a second opinion about era order.
 *
 * A validated `@civts/rules` `TechSpec` satisfies this interface — it carries every
 * field below plus `provenance`, which the engine never reads — exactly as
 * `UnitSpec`/`UnitDef` and `ResourceSpec`/`ResourceDef` are related.
 */
export interface TechDef {
  readonly id: TechId;
  readonly name: string;
  /** The era the row belongs to. Opaque to the engine; ordered in content. */
  readonly era: string;
  /** Beakers to research it. Validation requires an integer `>= 1`. */
  readonly cost: number;
  /** Direct prerequisites; empty for a root of the tree. */
  readonly requires: readonly TechId[];
}

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Does this look like a tech row? The shape half of the total read below, written
 * because a `RulesetView` arrives from outside this build: a test's structural
 * stand-in, a save file's ruleset, a hand-built object. A row that is not a tech row
 * names no tech, and this check is what says so without a cast — the idiom
 * `resources.ts`' `isTileResource` uses.
 */
const isTechRow = (row: unknown): row is TechDef => {
  if (!isRecord(row)) return false;
  if (!('id' in row) || !('cost' in row) || !('requires' in row)) return false;
  return (
    typeof row['id'] === 'string' &&
    typeof row['cost'] === 'number' &&
    Array.isArray(row['requires']) &&
    Array.from<unknown>(row['requires']).every((required) => typeof required === 'string')
  );
};

/**
 * The tech catalog of a ruleset, in catalog order — and **the one place this module
 * reads it**.
 *
 * `RulesetView` does not declare `techs`, and this function is why it does not have
 * to: the tree is read structurally, exactly as `resourceCatalog` (`map.ts`) reads an
 * optional `resources`, so a view written before M5 is still a view the engine can run
 * a game from. Such a view simply has no techs: nothing can be researched, a
 * `researching` id no row describes is reported as unknown, and a player's beakers stay
 * banked. That is a *game without research*, not an unanswerable question — the same
 * judgement `buildings` and `resources` made, and the reason that field is optional
 * while a **catalog** (in `@civts/rules`) is required to state `techs: []` explicitly.
 *
 * Data order, never RNG order, so any "first match" derived from it is deterministic.
 * When `RulesetView` grows a declared `techs?: readonly TechDef[]` (the gating
 * workstream wants the tree next to the rows that require it), this read keeps working
 * unchanged: it narrows each row structurally and never depended on the declaration.
 */
export const techCatalog = (ruleset: RulesetView): readonly TechDef[] => {
  const view: unknown = ruleset;
  const field = isRecord(view) ? view['techs'] : undefined;
  if (!Array.isArray(field)) return [];
  // `Array.isArray` narrows to `any[]`, which would leak `any` into every read below;
  // `Array.from<unknown>` re-types it without a cast, and `filter` then narrows each
  // entry honestly.
  return Array.from<unknown>(field).filter(isTechRow);
};

/** The row `id` names, or `undefined` when this ruleset defines no such tech. */
export const techDef = (ruleset: RulesetView, id: TechId): TechDef | undefined =>
  techCatalog(ruleset).find((tech) => tech.id === id);

/**
 * The beakers this ruleset charges for `id`, or `undefined` when there is no honest
 * price to charge — either no row names the tech, or the row's `cost` is not a whole
 * number of at least one beaker.
 *
 * The second half matters because a `RulesetView` is not necessarily a *validated*
 * catalog: validation rejects a fractional or free cost, but a hand-built view can
 * carry one, and "research it for `0.5` beakers" or "research it for free" is not a
 * rule this engine has. Returning `undefined` puts such a row in the same category as
 * an unknown id — **not researchable** — rather than inventing a price for it.
 */
export const techCostOf = (ruleset: RulesetView, id: TechId): number | undefined => {
  const cost = techDef(ruleset, id)?.cost;
  return cost !== undefined && Number.isInteger(cost) && cost >= 1 ? cost : undefined;
};

/**
 * Ids in canonical order: **ascending by code unit, with duplicates removed**.
 *
 * This is the order `PlayerState.techs` is stored in and the order every reader sees.
 * It is stated once, here, because the list is part of every state hash: two states
 * with the same known techs in a different order would hash differently while meaning
 * the same thing, and the contract's "sorted and unique" is what forbids it.
 *
 * Code-unit order, not `localeCompare`: a locale-dependent comparison is exactly the
 * ambient, environment-dependent answer PLAN.md §5.3 forbids, and it would make a
 * save's hash depend on the machine that read it.
 */
const compareTechIds = (a: TechId, b: TechId): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** `ids` normalised: deduplicated, then sorted by `compareTechIds`. */
const normalizeTechs = (ids: readonly TechId[]): readonly TechId[] =>
  [...new Set(ids)].sort(compareTechIds);

/**
 * The tech ids a player knows — a **total** read of `PlayerState.techs`, in canonical
 * order.
 *
 * On every state this build assembled, that is the field unchanged and already sorted.
 * The checks are for a state that did *not* come from this build: `techs` arrived in
 * schema version 7, so a save written by M4c has no such field at all, and a hand-built
 * state can carry anything. Reading such a state as "knows nothing" is the only true
 * thing to say about it, and it is the same reading `improvements.ts` and `resources.ts`
 * apply to their own fields — with one difference that is itself the point: a *missing*
 * tech list is not an error here either, because the alternative (throwing inside a
 * legality check `applyCommand` calls) would turn a stale save into a crash.
 *
 * The result is normalised, so a reader gets the contract's order even from a state
 * that was written unsorted.
 */
export const knownTechs = (player: PlayerState): readonly TechId[] => {
  const field: unknown = player.techs;
  if (!Array.isArray(field)) return [];
  return normalizeTechs(
    Array.from<unknown>(field).filter((id: unknown): id is TechId => typeof id === 'string'),
  );
};

/** Does this player already know `id`? */
export const knowsTech = (player: PlayerState, id: TechId): boolean =>
  knownTechs(player).some((known) => known === id);

/**
 * What this player is researching, read **totally**: `undefined` when the key is
 * absent, and also when it is present but is not a string.
 *
 * The distinction the contract cares about is preserved exactly — "nothing is being
 * researched" is the *absence* of the key — and this function is the only place that
 * decides what a present-but-unusable value means (the same answer: nothing this engine
 * can research). It never returns `undefined` *as a value to store*: see
 * `withResearching`/`withoutResearching`, the only writers of the key, which omit it
 * rather than writing `undefined` into it.
 */
export const researchingOf = (player: PlayerState): TechId | undefined => {
  const field: unknown = player.researching;
  return typeof field === 'string' ? asTechId(field) : undefined;
};

/**
 * `player` with `tech` set as the tech being researched — one of the only two writers
 * of the `researching` key.
 *
 * A rebuild by spread rather than a field-by-field reconstruction, matching `SetRates`'
 * `{ ...player, rates }`: a player is written by several commands, and one of them
 * spelling out every field would be a second, silently incomplete copy of
 * `PlayerState`.
 */
export const withResearching = (player: PlayerState, tech: TechId): PlayerState => ({
  ...player,
  researching: tech,
});

/**
 * `player` with the `researching` key **removed**, not set to `undefined`.
 *
 * This is the M3 rule the contract repeats for M5, and this function is the one place
 * it is implemented: "not researching" is an absent key, because a key holding
 * `undefined` cannot survive a JSON save/load round trip and `canonicalize` refuses it,
 * so such a state was never hashable to begin with. A player who was already
 * researching nothing comes back equal to the input.
 */
export const withoutResearching = (player: PlayerState): PlayerState => {
  const { researching, ...rest } = player;
  // Nothing to clear: a player who is already researching nothing comes back as the
  // *same object*, which is what lets `applyResearch` report an idle turn by identity
  // (`outcome.state === state`) rather than by a deep comparison.
  if (researching === undefined) return player;
  // `rest` genuinely lacks the key — this is a rest-destructure, not an assignment of
  // `undefined` — and a value that is present but unusable (a hand-edited file) is
  // dropped by the same branch, because the only thing worth keeping is a selection
  // this engine can name.
  return rest;
};

/**
 * Why a tech may not be researched — the typed answer, never a throw.
 *
 * Four members, and every one of them is a state a caller has to render:
 * `unknown-tech` (this ruleset defines no such tech, or defines one with no usable
 * price), `already-known` (it is in `techs`), `unmet-prerequisite` (one or more direct
 * prerequisites are missing, listed) and `nothing-being-researched` (the question "what
 * am I researching?" asked of a player who is not researching anything).
 */
export type ResearchProblem =
  | { readonly kind: 'unknown-tech'; readonly tech: TechId }
  | { readonly kind: 'already-known'; readonly tech: TechId }
  | {
      readonly kind: 'unmet-prerequisite';
      readonly tech: TechId;
      /** The direct prerequisites this player does not know, in canonical order. */
      readonly missing: readonly TechId[];
    }
  | { readonly kind: 'nothing-being-researched' };

/**
 * The direct prerequisites of `tech` that `player` does not know, in canonical order.
 *
 * Taking a `TechDef` rather than an id makes "the tech does not exist" unrepresentable
 * here — resolving an id is `techDef`'s job, and a function that also had to answer for
 * an unknown tech would be a second place deciding what "unknown" means.
 *
 * Only **direct** prerequisites are listed, and that is complete rather than a shortcut:
 * a tech can only become known by completing its own prerequisites first, so "every
 * direct prerequisite is known" already implies the whole transitive closure. Asking for
 * the closure here would be a second, hand-derived copy of the graph — free to disagree
 * with the rows it duplicates.
 */
export const missingPrerequisites = (player: PlayerState, tech: TechDef): readonly TechId[] =>
  normalizeTechs(tech.requires.filter((required) => !knowsTech(player, required)));

/** The two possible answers to "is this tech researchable by this player?". */
type ResearchReadiness =
  | { readonly kind: 'ready'; readonly tech: TechId; readonly cost: number }
  | { readonly kind: 'blocked'; readonly problem: ResearchProblem };

/**
 * The readiness check — **the one implementation** of "may this player research this
 * tech, and what does it cost?".
 *
 * `researchProblem` (the planner's question) and `applyResearch` (the pipeline's) are two
 * *renderings* of this function's answer, never two answers: a planner that accepted
 * something the pipeline refused, or the reverse, is exactly the generator/applier
 * disagreement the keystone invariant exists to forbid (INTERFACES.md invariant 1). The
 * cheapness of the two wrappers is the point.
 *
 * The order of the checks is the order a caller can fix them in: an id this ruleset does
 * not describe is not a research choice at all; a tech already known is not a choice
 * either; and only then is a *missing prerequisite* the answer.
 */
const readinessOf = (
  ruleset: RulesetView,
  player: PlayerState,
  tech: TechId,
): ResearchReadiness => {
  const def = techDef(ruleset, tech);
  const cost = techCostOf(ruleset, tech);
  if (def === undefined || cost === undefined) {
    return { kind: 'blocked', problem: { kind: 'unknown-tech', tech } };
  }
  if (knowsTech(player, tech)) {
    return { kind: 'blocked', problem: { kind: 'already-known', tech } };
  }

  const missing = missingPrerequisites(player, def);
  if (missing.length > 0) {
    return { kind: 'blocked', problem: { kind: 'unmet-prerequisite', tech, missing } };
  }

  return { kind: 'ready', tech, cost };
};

/**
 * Why `player` may not research `tech`, or `undefined` when it may.
 *
 * This is the evaluator `SetResearch`'s planner is built on (`commands.ts` maps its
 * answer to the matching `GameError`), so legality has one implementation and the
 * command layer has none of its own.
 */
export const researchProblem = (
  ruleset: RulesetView,
  player: PlayerState,
  tech: TechId,
): ResearchProblem | undefined => {
  const readiness = readinessOf(ruleset, player, tech);
  return readiness.kind === 'blocked' ? readiness.problem : undefined;
};

/**
 * What `playerId` is researching and what it costs, or the typed reason there is
 * nothing to research.
 *
 * Uses all four members of `ResearchProblem`: a player who is researching nothing is
 * `nothing-being-researched`, and a `researching` id this ruleset cannot price (an
 * unknown id, a row with no usable cost) or that the player somehow already knows is
 * reported as exactly that rather than being mistaken for "nothing".
 *
 * A player id the state does not define is `nothing-being-researched` as well: a player
 * who does not exist is not researching anything, and inventing a fifth answer
 * ("unknown player") for a *query* — where `GameError` already owns "the actor does not
 * exist" for commands — would be a rule with two homes.
 */
export const currentResearch = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): Result<TechDef, ResearchProblem> => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) return err({ kind: 'nothing-being-researched' });

  const tech = researchingOf(player);
  if (tech === undefined) return err({ kind: 'nothing-being-researched' });

  const readiness = readinessOf(ruleset, player, tech);
  if (readiness.kind === 'blocked') return err(readiness.problem);

  const def = techDef(ruleset, tech);
  if (def === undefined) return err({ kind: 'unknown-tech', tech });
  return ok(def);
};

/**
 * What one player's research phase decided — the typed answer `applyResearch` acts on,
 * exposed so a UI, an AI or a test can ask the same question the turn pipeline asks
 * without re-deriving the rule.
 *
 * Every member is reachable from a state an engine can be handed, which is why the
 * union is five wide rather than two:
 *
 * - `nothing-being-researched` — the key is absent; the pool is banked.
 * - `accumulating` — a tech is selected and the pool does not cover it yet. `needed` is
 *   the remainder still to come, carried so a UI can show "3 turns" without repeating
 *   the subtraction.
 * - `completed` — the pool covered the cost. `beakers` is what **stays** in the pool
 *   (the carried remainder), never the pool before the payment.
 * - `stuck` — a `researching` id this ruleset cannot price, or one the player already
 *   knows, or (impossible by construction, asserted anyway) one whose prerequisites are
 *   not satisfied. Nothing is spent and nothing is written; see `applyResearch`.
 */
export type ResearchStep =
  | { readonly kind: 'nothing-being-researched' }
  | {
      readonly kind: 'accumulating';
      readonly tech: TechId;
      readonly cost: number;
      readonly beakers: number;
      readonly needed: number;
    }
  | {
      readonly kind: 'completed';
      readonly tech: TechId;
      readonly cost: number;
      readonly beakers: number;
    }
  | { readonly kind: 'stuck'; readonly tech: TechId; readonly problem: ResearchProblem };

/**
 * The beakers a player has banked, read totally.
 *
 * A pool that is not an integer is not a pool this engine can compare against a cost, so
 * it reads as `0` — the same totality discipline `turn.ts` applies to a unit whose type
 * the ruleset does not define, and for the same reason: a hand-built or half-corrupt state
 * must not be able to make the turn pipeline throw. A *negative* integer is left as it is
 * (it is a number, and `< cost` answers for it honestly); note that nothing here ever
 * *writes* a pool except on completion, where the result is `>= 0` by construction.
 */
const beakersOf = (player: PlayerState): number => {
  const field: unknown = player.beakers;
  return typeof field === 'number' && Number.isInteger(field) ? field : 0;
};

/**
 * One player's research phase, as a typed answer.
 *
 * Deliberately **pure and total**: it reads the state, never writes it, and has an answer
 * for every state it can be handed — including one whose `researching` id no catalog row
 * describes (`stuck`) and one whose beakers are not an integer (banked as `0`).
 *
 * The pipeline-delay reading documented at the top of this module is what makes this
 * function read `player.beakers` and nothing else: it does not collect, does not split
 * commerce, and does not look at cities. The money loop owns all of that, and it runs
 * after this step for exactly that reason.
 */
export const researchStep = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): ResearchStep => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) return { kind: 'nothing-being-researched' };

  const tech = researchingOf(player);
  if (tech === undefined) return { kind: 'nothing-being-researched' };

  const readiness = readinessOf(ruleset, player, tech);
  if (readiness.kind === 'blocked') return { kind: 'stuck', tech, problem: readiness.problem };

  const beakers = beakersOf(player);
  if (beakers < readiness.cost) {
    return {
      kind: 'accumulating',
      tech,
      cost: readiness.cost,
      beakers,
      needed: readiness.cost - beakers,
    };
  }

  return { kind: 'completed', tech, cost: readiness.cost, beakers: beakers - readiness.cost };
};

/** What `applyResearch` decided: the state after the research phase, and its events. */
export interface ResearchOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * The research step of the turn pipeline — one pass over every civilization, in
 * `players` order.
 *
 * Pure: `state` is never modified, the result is built from fresh objects, and the same
 * `(state, ruleset)` always yields an equal result. It is a *transition*, not a command:
 * `revision` and `turn` are untouched, and the RNG is not read — `turn.ts` owns the order
 * of a turn and calls this as step 4 of it, between production and the money loop.
 *
 * Which players are visited, and what each outcome does:
 *
 * - **Barbarians are skipped**, mirroring the money loop: they have no economy, so their
 *   pool is never credited and there is nothing to spend. (A hand-built state with a
 *   barbarian `researching` a tech simply does not progress, which is the same inert
 *   answer their `rates` and `treasury` already give.)
 * - **`completed`** writes the tech into `techs` (sorted and unique, through the same
 *   normalisation every reader uses), subtracts the cost from the pool, **removes** the
 *   `researching` key, and emits one `TechResearched`.
 * - **Anything else** leaves that player's row *reference-identical*: no event, no write,
 *   and — because the players array is only rebuilt when something changed — an untouched
 *   state comes back as the same object, which is what makes "nothing being researched
 *   costs nothing" observable by identity as well as by value.
 *
 * `stuck` deserves one more sentence, because it is the only branch that could look like a
 * silent half-failure: the tech is **not** dropped and the pool is **not** touched. The
 * engine does not edit a player's declared intent to repair a catalog it does not
 * recognise, and the player is not trapped — `SetResearch` overwrites the key for any
 * tech that *is* researchable, without consulting the current value at all. The step
 * reports the condition (`researchStep`) so it is observable rather than silent, which is
 * the standing requirement's "checkable in flight" clause applied to the one case that
 * cannot progress.
 */
export const applyResearch = (state: GameState, ruleset: RulesetView): ResearchOutcome => {
  let current = state;
  const events: GameEvent[] = [];

  for (const player of state.players) {
    if (player.kind !== 'civ') continue;

    const step = researchStep(current, ruleset, player.id);
    if (step.kind !== 'completed') continue;

    const updated = withoutResearching({
      ...player,
      techs: normalizeTechs([...knownTechs(player), step.tech]),
      beakers: step.beakers,
    });

    current = {
      ...current,
      players: current.players.map((each) => (each.id === player.id ? updated : each)),
    };
    events.push({
      type: 'TechResearched',
      playerId: player.id,
      tech: step.tech,
      // The price and the remainder are carried on the event so a consumer can check
      // the carry-over rule from the event stream alone — the same reading M4b's
      // `UpkeepPaid` takes of a bill, and the reason this payload is more than the
      // contract's `{ player, tech }` minimum.
      cost: step.cost,
      beakers: step.beakers,
    });
  }

  return { state: current, events };
};

/* ------------------------------------------------------------------ *
 * Gating — the read half of M5's `requiresTech`
 * ------------------------------------------------------------------ */

/**
 * The tech a catalog row declares it requires, read **totally** from any row.
 *
 * M5's gating section lets units, buildings, improvements and resources declare
 * `requiresTech?: TechId`. This is the one read of that field, and it takes `unknown`
 * because the field's *declaration* will land on four different interfaces in a later
 * change: reading it structurally here means the gate can be wired without this module
 * needing a second opinion about where the field lives, and a row that does not declare
 * one honestly requires nothing.
 *
 * Absent means "no tech requirement", which is also what a non-string value means: a
 * requirement this engine cannot name is not a requirement it can check, and the
 * alternative — treating garbage as a gate nothing satisfies — would silently hide
 * content behind a typo.
 */
export const requiresTechOf = (row: unknown): TechId | undefined => {
  if (!isRecord(row)) return undefined;
  const field = row['requiresTech'];
  return typeof field === 'string' ? asTechId(field) : undefined;
};

/**
 * The tech this player still needs before a row that requires it becomes available, or
 * `undefined` when the requirement is satisfied (or absent).
 *
 * **This is the single implementation of "is this tech requirement met?"** — the gate
 * the contract says must be enforced where production and build legality are decided, so
 * that the generator (what a city may be *set* to build) and the applier (what
 * `applyProduction` will complete) cannot disagree. Callers pass the row's
 * `requiresTechOf(...)` straight in, and the returned id is the one to name in the
 * refusal.
 */
export const unmetTechRequirement = (
  player: PlayerState,
  requiresTech: TechId | undefined,
): TechId | undefined =>
  requiresTech === undefined || knowsTech(player, requiresTech) ? undefined : requiresTech;

/** The four catalogs a `requiresTech` may appear in, in the order `techUnlocks` reports. */
export const TECH_UNLOCK_KINDS = ['unit', 'building', 'improvement', 'resource'] as const;

export type TechUnlockKind = (typeof TECH_UNLOCK_KINDS)[number];

/** One catalog row that becomes available when a tech is known. */
export interface TechUnlock {
  readonly kind: TechUnlockKind;
  /** The row's id. `string` because the four id spaces are different brands. */
  readonly id: string;
}

const unlockRowsOf = (
  ruleset: RulesetView,
): readonly (readonly [TechUnlockKind, readonly unknown[]])[] => [
  ['unit', ruleset.units],
  // `buildings` and `resources` are optional on `RulesetView` — see the field notes in
  // `map.ts` — so a view without them unlocks nothing from that catalog rather than
  // making this read partial.
  ['building', ruleset.buildings ?? []],
  ['improvement', ruleset.improvements],
  ['resource', ruleset.resources ?? []],
];

/**
 * Every catalog row that requires `tech` — the contract's "what a completion unlocks".
 *
 * Derived from the catalogs, never from a list written by hand beside them: a second,
 * hand-maintained inventory of "what masonry unlocks" is precisely the kind of fact with
 * two writers that the M2 rule forbids, and it would go stale the first time a row
 * gained a `requiresTech`.
 *
 * The order is stated and stable: units, then buildings, then improvements, then
 * resources (`TECH_UNLOCK_KINDS`), catalog order within each — so two runs over the same
 * ruleset report identically, and a report or a test can be read without sorting.
 *
 * In this build no shipped row declares `requiresTech`, so this returns `[]` for every
 * tech of the shipped catalog. That is the honest answer, and `tech.test.ts` covers the
 * function with rows that *do* declare one, so the reader is tested rather than merely
 * present.
 */
export const techUnlocks = (ruleset: RulesetView, tech: TechId): readonly TechUnlock[] =>
  unlockRowsOf(ruleset).flatMap(([kind, rows]) =>
    rows.flatMap((row) => {
      if (requiresTechOf(row) !== tech) return [];
      if (!isRecord(row) || typeof row['id'] !== 'string') return [];
      return [{ kind, id: row['id'] }];
    }),
  );

/**
 * The tech ids `tech` directly requires, or `[]` when this ruleset does not define it.
 *
 * A small convenience for a caller that wants the edge rather than the whole row — the
 * UI's "what leads here" and a test's graph walk both do — and it keeps them from reading
 * `TechDef.requires` through a `find` of their own.
 */
export const prerequisitesOf = (ruleset: RulesetView, tech: TechId): readonly TechId[] =>
  techDef(ruleset, tech)?.requires ?? [];
