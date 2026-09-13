/**
 * The shapes `@civts/sim` is built from — **types only, no behaviour**.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" and its
 * "`@civts/sim` contract — FROZEN" block, which this file transcribes.
 *
 * Three things about this file are worth stating before the first interface, so a
 * reader knows which parts of it are frozen and which are a proposal between
 * workstreams:
 *
 * 1. **The frozen shapes are copied field-for-field.** `Invariant`,
 *    `InvariantContext`, `Policy`, `PolicyContext`, `SimulationOptions` and
 *    `SimulationResult` are the contract's, verbatim: same names, same optionality,
 *    same `readonly` modifiers. A change here is a change to a contract another
 *    workstream is coded against, so it is an escalation, not an edit. M7d amended
 *    `SimulationResult` deliberately and in writing (the amendment block at the end of
 *    `docs/INTERFACES.md`, which also names the owner of every consumer) — that is the
 *    only way a shape in this file changes, and `plannerFailures` is the amendment.
 * 2. **The rest of the file is the contract's prose made concrete.** The contract
 *    *names* `TurnMetrics`, `Violation`, `BatchOptions`, `BatchResult` and
 *    `RulesetPatch` and says what each must carry ("per turn, per civilization …
 *    population, city count, unit count, treasury, beakers, luxuries, per-channel
 *    income, maintenance, units supported, food/shield/commerce totals, buildings
 *    held, and the state hash"; "seeds, aggregate"; "a deep-partial of the catalog
 *    by id") without printing the shapes. The field names below follow that prose
 *    literally — `cities`, `units`, `unitsSupported`, `incomeGold`, … — rather than
 *    inventing vocabulary, because two halves of a contract that disagree on a field
 *    name are two contracts.
 * 3. **Types only.** Nothing in this file computes, reads a state or imports a
 *    value: it is the vocabulary the modules that do the work agree on. The
 *    behaviour lives in `invariants.ts` (the registry), `overrides.ts` (the balance
 *    knobs) and the modules the other workstreams add beside them.
 *
 * On determinism (PLAN.md §5.3, and the standing requirement's "runnable without a
 * UI, at scale, deterministically"): every number here is an **integer count,
 * total or pool** derived from game state, and nothing in this file is a float.
 * Overrides carry catalog magnitudes — shield costs, movement points, gold — which
 * are integers by the rules package's validation, and never a probability or a rate
 * the engine would have to sample.
 */

import type {
  BuildingEffect,
  Command,
  GameEvent,
  GameOutcome,
  GameState,
  ImprovementKind,
  PlayerId,
  ResourceId,
  ResourceKind,
  RngState,
  RulesetView,
  Settings,
  TechId,
  TerrainRole,
  TerrainYields,
  UnitDomain,
  UnitRole,
} from '@civts/core';
import type { Ruleset } from '@civts/rules';

// **The one import here that is not a shape of this file's own vocabulary, and why it is
// type-only.** M7d's amendment (docs/INTERFACES.md, "AMENDMENT to the frozen simulation
// result") gives `SimulationResult` a field of type `readonly PlannerFailure[]`, and
// `PlannerFailure` is declared in `ai/smart.ts` beside the only code that produces one.
// Restating the shape here would be a second declaration of a contract field set — and two
// halves of a contract that disagree on a field name are two contracts, which is the exact
// failure this file's header warns about. The import is `import type`, so under
// `verbatimModuleSyntax` it is erased completely: `types.ts` still contributes no runtime
// edge to the module graph, and `ai/smart.ts`'s own (type-only) import of `PolicyContext`
// from this file stays a type cycle rather than a runtime one.
import type { PlannerFailure } from './ai/smart.js';

/* ------------------------------------------------------------------ *
 * Invariants — the frozen contract
 * ------------------------------------------------------------------ */

/**
 * A named, machine-checkable property of a state.
 *
 * `check` **returns** violations and never throws. That is the whole design: a run
 * then reports *every* broken property at once instead of dying on the first, and
 * the name travels with the message so a failure says which property broke rather
 * than only that something did.
 */
export interface Invariant {
  /** Stable, kebab-case; appears in output. */
  readonly name: string;
  /** One line, plain language. */
  readonly description: string;
  /** Violations, empty = holds. */
  readonly check: (ctx: InvariantContext) => readonly string[];
}

/**
 * What a check is allowed to look at.
 *
 * `previous` is what makes *transition* invariants expressible — "gold changed by
 * exactly income minus upkeep" is not a property of a state, it is a property of a
 * step — and a conservation invariant that cannot see the previous state is not a
 * conservation invariant. It is `undefined` on the first turn, so every check that
 * needs it must say what it does when it is absent.
 *
 * Both rulesets travel together deliberately: `ruleset` is the validated content
 * (the same object `validateRuleset` returned, and what a caller overrode with a
 * patch), while `rulesetView` is the engine's structural read of it. A check that
 * needs "is this row a wonder?" reads the same bytes either way, and passing both
 * means no check has to construct one from the other.
 */
export interface InvariantContext {
  readonly state: GameState;
  /** Absent on the first turn. */
  readonly previous: GameState | undefined;
  readonly ruleset: Ruleset;
  readonly rulesetView: RulesetView;
  /** What just happened. */
  readonly events: readonly GameEvent[];
  readonly turn: number;
}

/**
 * One recorded failure: which invariant broke, on which turn, and the check's own
 * message for it.
 *
 * The shape is flat and JSON-round-trippable, because a violation is evidence that
 * has to survive being written to a file and read back by a different process (the
 * batch/report half of the standing requirement).
 */
export interface Violation {
  /** The `name` of the invariant that returned the message. */
  readonly invariant: string;
  /** The turn whose check produced it. */
  readonly turn: number;
  /** The violation string the check returned. */
  readonly message: string;
}

/* ------------------------------------------------------------------ *
 * Policies — the frozen contract
 * ------------------------------------------------------------------ */

/**
 * A strategy. **The AI is a replaceable `Policy`, never hard-wired into the
 * engine** — M7's self-play needs to swap strategies, and balance work needs to run
 * the same seed under different ones.
 */
export interface Policy {
  readonly name: string;
  readonly chooseCommands: (ctx: PolicyContext) => readonly Command[];
}

/**
 * What a policy is given: the state, whose turn it is, the rules, and **its own**
 * RNG stream.
 *
 * `rng` is per-policy and derived from the seed — **never** `state.rng`. If a policy
 * consumed the state's stream, changing the AI would change the world, and two
 * policies could not be compared on the same seed, which is the entire point of
 * having policies at all. A policy that wants randomness takes `rng`, folds it into
 * its decisions, and leaves the world's stream exactly where it found it.
 */
export interface PolicyContext {
  readonly state: GameState;
  readonly playerId: PlayerId;
  readonly ruleset: Ruleset;
  readonly rng: RngState;
}

/* ------------------------------------------------------------------ *
 * Running a simulation — the frozen contract
 * ------------------------------------------------------------------ */

/** Why a run stopped. Part of `SimulationResult`, named so callers can match on it. */
/**
 * Why a run stopped.
 *
 * `'game-over'` is M10's addition, and it is a **success**, not a failure: a run that
 * reaches a victory condition stops there because the engine refuses to play a finished
 * game (see `turn.ts` on the early return and `finished-game-does-not-advance` in
 * `@civts/sim`'s registry). Before M10 an ended game was reported as `'no-commands'` —
 * every command refused with `game-over`, so no command applied — which described the
 * *symptom* and hid the fact that the run had produced a winner. It exists so a batch can
 * say how many games ended and how.
 */
export type StopReason = 'max-turns' | 'violation' | 'no-commands' | 'game-over';

export interface SimulationOptions {
  readonly seed: number;
  readonly settings: Settings;
  readonly ruleset: Ruleset;
  /** By player index; barbarians are never polled. */
  readonly policies: readonly Policy[];
  readonly maxTurns: number;
  /** The registry to check every turn; the core registry when absent. */
  readonly invariants?: readonly Invariant[];
  /** Metrics sampling stride, default 1. */
  readonly sampleEvery?: number;
}

export interface SimulationResult {
  readonly seed: number;
  readonly turnsPlayed: number;
  readonly finalHash: string;
  readonly finalState: GameState;
  readonly metrics: readonly TurnMetrics[];
  readonly violations: readonly Violation[];
  /**
   * **Every planner failure a policy reported while this run polled it, oldest first — each one
   * naming a throw that actually happened in *this* run.**
   *
   * M7c made a thrown planner error a typed `PlannerFailure` instead of a silence, and the
   * verifier found the fix real but **unwired**: the CLI printed a warning to stderr while
   * this result carried nothing, so a reader holding only the structured result could not
   * tell a **partial turn** from a **quiet one**. That is the same silent-failure class one
   * layer up — a game in which the planner threw is a game whose numbers describe an AI that
   * was not playing, and the record of it has to be *in the result* rather than in a warning
   * beside it.
   *
   * **A failure recorded before this run started is not reported here**, and a pass that throws on
   * every turn of the run contributes one entry per seat rather than one per turn. The runner reads
   * each policy's own `failureCount` as its baseline and collects only when that count moves *during*
   * the run — that is the **whether**, and the count is the only monotone thing a policy hands out —
   * and it takes the **records** from the policy's own latest-per-pass list, which every throw of the
   * run has rewritten. Both halves matter, and the second is the one a reader can be misled by: a
   * policy instance is reusable (`SMART_POLICY` is a singleton, and the batch, the tournament and the
   * CLI each hand **one instance to every seat of every run**), so its first-per-pass list is a
   * memory of *earlier* runs as well as this one, and a run that re-threw in a pass an earlier run
   * had recorded would otherwise report that earlier run's turn, pass, player and detail — a real
   * throw, located in a game that had already finished. H1/G2-1. `runner.ts`'s "Carrying a planner
   * failure" states the whole rule, including why a run has to be measured against the count *and*
   * why the record comes from the latest-per-pass list.
   *
   * **Required and always present, an empty array when there are none** — exactly how
   * `violations` works, so a consumer cannot forget it. Not optional: an optional field is
   * one a producer may forget and a consumer may skip, which is how the M7c record came to
   * be read by nobody. And never `undefined`: a key written with an explicit `undefined` is
   * unhashable (`canonicalize` refuses it by design) and this project has paid for that
   * mistake three times — the fix belongs in the producer and the type, never in the hasher.
   *
   * A **non-empty** value means the run is not valid evidence: the policy is required to be
   * total, so a throw is a defect in the AI, and `tournamentVerdict` fails the tournament
   * that contains one. Unlike a violation it does **not** stop the run — see `runner.ts` on
   * why a partial turn is still a complete, hashable game, while a violated state is a state
   * that broke and has to be inspected where it happened.
   */
  readonly plannerFailures: readonly PlannerFailure[];
  readonly stoppedBecause: StopReason;
  /**
   * **How the game ended**, read from the final state through `gameOutcomeOf` (M10).
   *
   * `undefined` — the key omitted, never written as `undefined` — means the game was
   * still in play when the run stopped, which is the normal outcome of a turn-limited
   * run. It is derived on the read rather than stored during the run for the contract's
   * own reason: an outcome is "a DERIVED value on the result/state read, never a stored
   * flag that can disagree with the board", and the final state is right here.
   *
   * The `turn` is the state's own turn, the same convention every other row in this file
   * follows, so "the game ended on turn 14" is checkable against `finalState.turn`.
   */
  readonly outcome?: GameOutcome;
}

/* ------------------------------------------------------------------ *
 * Metrics — the contract's prose, made concrete
 * ------------------------------------------------------------------ */

/**
 * One turn's numbers for one civilization — what the standing requirement's
 * "observable" means in practice: a system emits structured state it did not have
 * before, so its effect can be *measured* rather than eyeballed.
 *
 * Every field is an integer count, total or pool. That is not a coincidence and it
 * is load-bearing for the batch half: an integer sum is exact in IEEE-754 doubles
 * up to 2^53, so a mean computed from these rows cannot depend on summation order
 * (see `MetricAggregate`).
 *
 * The **stable key** of a row is `(turn, playerId)`; `hash` is the *whole-state*
 * hash at that turn, so it repeats across the civilizations sampled in the same
 * turn. It is carried anyway because the contract asks for it: a metric row whose
 * state cannot be pinned is a number nobody can reproduce.
 *
 * `beakers` and `luxuries` are honest about being **inert**: they accumulate and
 * nothing spends them until M5 and M9. They are reported because a channel that
 * silently discarded its output would be worse than one that visibly banks it.
 */
export interface TurnMetrics {
  readonly turn: number;
  readonly playerId: PlayerId;
  /** Citizens, summed over this civilization's cities. */
  readonly population: number;
  readonly cities: number;
  /** Units owned by this civilization. */
  readonly units: number;
  readonly treasury: number;
  readonly beakers: number;
  readonly luxuries: number;
  /** This turn's gold from `IncomeCollected`. */
  readonly incomeGold: number;
  /** This turn's beakers from `IncomeCollected` (a pool, not a rate). */
  readonly incomeBeakers: number;
  /** This turn's luxuries from `IncomeCollected` (a pool, not a rate). */
  readonly incomeLuxuries: number;
  /** Building maintenance billed this turn (`UpkeepPaid.maintenance`). */
  readonly maintenance: number;
  /** Unit support billed this turn, in gold (`UpkeepPaid.unitSupport`). */
  readonly unitSupport: number;
  /** Units beyond the free allowance — the count the support gold is charged on. */
  readonly unitsSupported: number;
  /** Food produced this turn, summed over this civilization's cities. */
  readonly food: number;
  /** Shields produced this turn, summed over this civilization's cities. */
  readonly shields: number;
  /** Commerce produced this turn, summed over this civilization's cities. */
  readonly commerce: number;
  /** Building rows held, summed over this civilization's cities. */
  readonly buildings: number;
  /** The whole-state hash at this turn (see the note above). */
  readonly hash: string;
}

/**
 * Mean/median/min/max for one metric across a batch.
 *
 * **Order-independence, stated rather than hoped for.** The contract requires that
 * aggregation never depend on object key order or on floating-point summation
 * order, and those are two separate guarantees:
 *
 * - *Object key order*: aggregation runs over an **ordered list of metric names**
 *   (the batch module's own fixed reading order — a list, never the key order of an
 *   object, which is insertion order) and over rows in ascending
 *   `(seed, turn, playerId)` order. Two runs that agree on the data therefore agree
 *   on the report byte for byte.
 * - *Summation order*: every aggregated value is an **integer**, and integer
 *   addition is exact in doubles below 2^53, so the sum is the same number however
 *   the terms are ordered. `sum` is carried beside `mean` so a reader can check
 *   `mean === sum / count` and that the sum is a whole number, instead of having to
 *   trust an accumulated average. `median` comes off a sorted copy with the
 *   even-count rule stated by the aggregator (the lower middle value is the
 *   reproducible choice: it is a value that really occurred), and `min`/`max` are
 *   folds.
 */
export interface MetricAggregate {
  /** The `TurnMetrics` field this aggregate describes. */
  readonly metric: string;
  /** How many values went into it. */
  readonly count: number;
  /** The exact integer total. */
  readonly sum: number;
  /** `sum / count`, or 0 when the batch is empty. */
  readonly mean: number;
  /** The lower middle value on an even count. */
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/**
 * One victory outcome and how many seeds reached it.
 *
 * M10 fills this in. It was declared for M5 with the note that the key was *absent* while
 * the engine had no victory condition — "a `wins: []` would claim victories were counted
 * and none happened" — and that is now false in the other direction: there are four
 * conditions, so a batch that reported no wins would be hiding them.
 *
 * `outcome` is the **condition id**, not a prose label, so a consumer counting these is
 * counting the same vocabulary `GameOutcome.condition` uses. `winner` is the seat, so
 * "who won" is answerable without walking the runs.
 */
export interface WinCount {
  readonly outcome: string;
  readonly count: number;
  readonly winner: PlayerId | null;
}

export interface BatchOptions {
  /** The seeds to run, each a whole game. */
  readonly seeds: readonly number[];
  readonly settings: Settings;
  readonly ruleset: Ruleset;
  /** By player index; barbarians are never polled. */
  readonly policies: readonly Policy[];
  readonly maxTurns: number;
  readonly invariants?: readonly Invariant[];
  readonly sampleEvery?: number;
}

export interface BatchResult {
  /** Per-seed results, in ascending seed order. */
  readonly runs: readonly SimulationResult[];
  /** One row per metric, in the aggregator's fixed metric order. */
  readonly aggregates: readonly MetricAggregate[];
  /**
   * Win counts, ordered by outcome name. **Absent** — the key omitted, never a key
   * holding `undefined` — while the engine has no victory condition, which is the
   * honest report for M5: a `wins: []` would claim victories were counted and none
   * happened.
   */
  readonly wins?: readonly WinCount[];
}

/* ------------------------------------------------------------------ *
 * Balance knobs — the contract's prose, made concrete
 * ------------------------------------------------------------------ */

/** The catalog sections a patch may address, by the catalog's own field names. */
export type OverrideSection =
  | 'terrains'
  | 'units'
  | 'buildings'
  | 'improvements'
  | 'resources'
  /** M6b: the combat globals — one section, not a record of rows. See `CombatPatch`. */
  | 'combat'
  /** M7: the capture rule — the second singleton section. See `CapturePatch`. */
  | 'capture'
  /** M9: the culture and contentment model — the third singleton section. See `CulturePatch`. */
  | 'culture'
  /** M9: the government rows — a *row* section, like units and buildings. See `GovernmentPatch`. */
  | 'governments'
  /** M10: the score weights — the fourth singleton section. See `ScorePatch`. */
  | 'score'
  /** M10: the victory thresholds — the fifth singleton section. See `VictoryPatch`. */
  | 'victory';

/** A partial of a yield triple: a patch may set one channel without the others. */
export type YieldsPatch = Partial<TerrainYields>;

/**
 * What may be overridden on a terrain row.
 *
 * `id` is not here because the id **is** the key a patch addresses the row by, and
 * `provenance` is not here on purpose: provenance is content authorship, not a
 * balance knob, and a patch that could rewrite it could turn a placeholder into a
 * claim of Civ 3 accuracy without anyone noticing. An overridden row keeps the
 * provenance it was written with, and the override record names what a patch
 * actually changed.
 *
 * Every field is optional and every field is a whole number or a flag — the
 * magnitudes live in the catalog, so a sweep varies them here rather than editing
 * content (standing requirement: "Tunable").
 */
export interface TerrainPatch {
  readonly role?: TerrainRole;
  readonly name?: string;
  readonly moveCost?: number;
  readonly defenseBonusPct?: number;
  readonly yields?: YieldsPatch;
  readonly impassable?: boolean;
  /**
   * The M6 spelling of `defenseBonusPct` — terrain defence (INTERFACES.md M6,
   * "Terrain defence").
   *
   * Both spellings are patchable, and the applier treats them as **one magnitude**:
   * naming either sets both, because `core/combat.ts`' `terrainDefenseBonus` reads
   * `defenseBonus` in preference to `defenseBonusPct`. A patch that moved only the
   * older name would therefore change nothing a battle can see — a sweep that reports
   * "no effect" for a reason that is not the game's is worse than no sweep at all.
   */
  readonly defenseBonus?: number;
}

export interface UnitPatch {
  readonly role?: UnitRole;
  readonly name?: string;
  readonly attack?: number;
  readonly defense?: number;
  /** Movement points per turn. */
  readonly movement?: number;
  /** Shield cost. */
  readonly cost?: number;
  readonly domain?: UnitDomain;
  /**
   * The resource this unit requires (M4c). It can be set or changed, but **not
   * removed**: "no requirement" is the absence of the key, and this type has no
   * spelling for clearing it.
   */
  readonly requiresResource?: ResourceId;
  /**
   * Hit points at full health (M6, "Unit combat statistics").
   *
   * It is here because a combat balance sweep is exactly what M6 asks for, and hit
   * points are the magnitude that decides how long a battle runs: without this field a
   * sweep could vary attack and defence but not the one number that changes the
   * *distribution* rather than the odds. The applier carries the row's value across
   * when a patch names something else — see `overrides.ts`' `mergeUnit`, where a
   * rebuild that forgot this field would silently reset every unit in the world to one
   * hit point.
   */
  readonly hitPoints?: number;
  /**
   * The technology this row needs before any city may build it (M5's gating).
   *
   * Set or changed, never removed, for the reason `requiresResource` states.
   */
  readonly requiresTech?: TechId;
}

export interface BuildingPatch {
  readonly name?: string;
  readonly cost?: number;
  /** Gold per turn the building costs its owner. */
  readonly maintenance?: number;
  /** Replaces the effect list wholesale — a list, so a partial of it is ambiguous. */
  readonly effects?: readonly BuildingEffect[];
  /**
   * Culture this building gives its own city each turn (M9).
   *
   * Patchable because it is a magnitude the standing requirement puts in the catalog, and
   * because a balance sweep has to be able to ask "what does the game look like if a
   * temple is worth three culture instead of one?" — which is exactly the question the
   * border thresholds below need answered in order to be tuned at all.
   */
  readonly culturePerTurn?: number;
  /**
   * The one-off culture this building grants on completion (M9).
   *
   * Patchable, and it cannot be *removed* by a patch for the reason `requiresResource`
   * states: a `??` merge can set a value, never delete a key. That is the right
   * limitation rather than a gap — the catalog is where "this wonder has no bonus" is
   * decided, and a sweep that wants a wonder without one patches the bonus to a value
   * `validateRuleset` accepts and reads the difference.
   */
  readonly cultureBonus?: number;
  /** Content citizens this building makes (M9). Signed: an unhappy-making row is legal. */
  readonly happiness?: number;
  /** `true` only. A `false` is not how this project spells "not a wonder". */
  readonly wonder?: true;
  /** The technology a city must know before it may build this (M5's gating). */
  readonly requiresTech?: TechId;
}

export interface ImprovementPatch {
  readonly kind?: ImprovementKind;
  readonly name?: string;
  /** Worker turns to complete. */
  readonly turns?: number;
  readonly yields?: YieldsPatch;
  readonly allowedRoles?: readonly TerrainRole[];
  /** The technology a worker must know before it may build this (M5's gating). */
  readonly requiresTech?: TechId;
}

export interface ResourcePatch {
  readonly name?: string;
  readonly kind?: ResourceKind;
  readonly yields?: YieldsPatch;
  readonly allowedRoles?: readonly TerrainRole[];
}

/**
 * What may be overridden on the catalog's **`combat` section** (M6b, "The combat
 * section of the catalog").
 *
 * ## Why this is a section of fields and not a record of rows
 *
 * Every other section here is `Record<id, Patch>` because a catalog row is addressed by
 * an id. The combat globals are a **singleton**: nine magnitudes that describe one
 * model, with no id to key them by (`@civts/rules`' `CombatSpec` has no `id` field —
 * its provenance is filed under the section's own name). So the patch is one flat
 * `Partial<CombatSpec>`, and `overrides.ts` reports an unknown key here exactly as it
 * reports an unknown field inside a row: naming `wallsBonusPCT` (a capital T) must be a
 * *report*, never a silent no-op — a sweep whose knob was never applied reports "no
 * effect", which is the single most expensive wrong answer this package can give.
 *
 * ## What each field is for, and what it is *not*
 *
 * These nine numbers decide every battle (see `core/combat.ts`). They arrive here as
 * one section because M6 buried them in that module as constants, which made them
 * unsweepable; `scripts/combat-balance-sweep.ts` sweeps them, and its report names
 * which one it moved. **None of them is a Civ 3 figure** — the catalog's own provenance
 * note says so, and the veteran asymmetry (`veteranAttackPct` applies to attackers only,
 * where Civ 3 gives veterans extra hit points) is documented where the odds are
 * computed.
 *
 * ## The one field with a rule attached
 *
 * `minWinPct`/`maxWinPct`/`rollBound` are one clamp, and `validateRuleset` checks
 * `1 <= minWinPct <= maxWinPct <= rollBound`. A patch that moves `rollBound` below
 * `maxWinPct` therefore produces a catalog that **fails validation**, exactly as a
 * hand-edited catalog would: overrides are applied *before* `validateRuleset` on
 * purpose, so an impossible sweep value is refused rather than blessed.
 */
export interface CombatPatch {
  /** Percent added to a fortified defender's defence. */
  readonly fortifyBonusPct?: number;
  /** Percent added to a defender's defence when it stands in its own city. */
  readonly cityDefenseBonusPct?: number;
  /** Percent added on top of that when that city holds defensive walls. */
  readonly wallsBonusPct?: number;
  /** Percent added to an attacker's attack for each experience level. */
  readonly veteranAttackPct?: number;
  /** The highest `experience` a unit may reach; `0` disables promotion. */
  readonly maxExperience?: number;
  /** How many equally likely outcomes a per-round draw has. */
  readonly rollBound?: number;
  /** Hit points a round winner takes off the loser; must be `>= 1`. */
  readonly damagePerRound?: number;
  /** The lowest a per-round win chance may be. */
  readonly minWinPct?: number;
  /** The highest a per-round win chance may be. */
  readonly maxWinPct?: number;
}

/**
 * What may be overridden on the catalog's **`capture` section** (M7, "Repairs carried
 * into this wave").
 *
 * ## Why a section of fields rather than a record of rows
 *
 * Exactly the `CombatPatch` argument, one milestone later: the capture rule is a
 * **singleton** — one magnitude that describes one rule, with no id to key it by
 * (`@civts/rules`' `CaptureSpec` has no `id` field; its provenance is filed under the
 * section's own name `capture`). So the patch is a flat `Partial<CaptureSpec>`, and
 * `overrides.ts` reports an unknown key here the way it reports an unknown field inside a
 * row: naming `populationDivisor` with a typo must be a *report*, never a silent no-op,
 * because a sweep whose knob was never applied reports "no effect" — the most expensive
 * wrong answer this package can give.
 *
 * ## What the field is for, and what it is *not*
 *
 * `populationDivisor` decides what a captured city has left. It arrives here because M6
 * wrote it into `core/cities.ts` as `CAPTURE_POPULATION_DIVISOR = 2`, a module constant,
 * which made it the one combat-adjacent magnitude the M6b sweep still had to list under
 * "cannot move" — and a knob nobody can turn is a knob nobody will ever tune.
 * `scripts/combat-balance-sweep.ts` sweeps it now and its report names what it moved.
 * **It is not a Civ 3 figure**: the catalog's own provenance note says so, and the real
 * game's capture losses depend on a city's size and holdings, which this engine does not
 * model.
 *
 * ## The one rule attached to it
 *
 * `populationDivisor` must be an integer `>= 1`, and `validateRuleset` refuses anything
 * else — `0` because `floor(population / 0)` is `Infinity`, which is neither a population
 * nor a hashable state. A patch that sets `0` therefore produces a catalog that **fails
 * validation**, exactly as a hand-edited catalog would: overrides are applied *before*
 * `validateRuleset` on purpose, so an impossible sweep value is refused rather than
 * blessed. `1` is accepted and means "a sack costs the city no citizens".
 */
export interface CapturePatch {
  /** The divisor a captured city's population is divided by; integer `>= 1`. */
  readonly populationDivisor?: number;
}

/**
 * **M9's culture and contentment model** — the third singleton section, and the one the
 * border and disorder magnitudes live in.
 *
 * ## Six fields, and why a sweep wants all six
 *
 * The two border thresholds decide **when a city's reach grows**; the unhappy ladder and
 * the three luxury magnitudes decide **when a city stops producing**. They are the two
 * halves of one question ("what does a developed city look like?") and a sweep that could
 * move only one of them would be measuring an incoherent game. So the patch surface names
 * every field of the section except `provenance`.
 *
 * ## `unhappyThresholds` replaces the ladder wholesale
 *
 * A list, so a partial of it is ambiguous — the same choice `BuildingPatch.effects`
 * makes, and for the same reason: "the ladder, with the third rung changed" is not a
 * thing a merge can express without an index, and an index-addressed patch of a list
 * whose *order is the rule* would let a caller write a ladder that validation refuses.
 * A sweep that wants one rung moved restates the ladder, and `validateRuleset` checks it
 * — ascending, non-empty, beginning at `minPopulation <= 1` — exactly as it checks a
 * hand-written catalog's.
 *
 * ## The rules validation attaches
 *
 * `borderRadius3Culture >= borderRadius2Culture >= 0`, `luxuriesPerHappyCitizen >= 1`,
 * `happyPerLuxuryResource >= 0`, and an ascending ladder. A patch that breaks any of them
 * produces a catalog that **fails validation**, exactly as a hand-edited catalog would:
 * overrides are applied *before* `validateRuleset` on purpose, so an impossible sweep
 * value is refused rather than blessed.
 */
export interface CulturePatch {
  /** The culture at which a city's borders reach radius 2. Integer `>= 0`. */
  readonly borderRadius2Culture?: number;
  /** The culture at which a city's borders reach radius 3. Integer `>= borderRadius2Culture`. */
  readonly borderRadius3Culture?: number;
  /** The size-to-unhappy ladder, **replaced wholesale**. See the note above. */
  readonly unhappyThresholds?: readonly UnhappyThresholdPatch[];
  /** Connected luxuries needed per content citizen. Integer `>= 1`. */
  readonly luxuriesPerHappyCitizen?: number;
  /** Happiness each connected luxury is worth on its own. Integer `>= 0`. */
  readonly happyPerLuxuryResource?: number;
}

/** One rung of a patched `CulturePatch.unhappyThresholds`. */
export interface UnhappyThresholdPatch {
  readonly minPopulation?: number;
  readonly unhappy?: number;
}

/**
 * **M9's government rows** — a *row* section, patchable by id exactly as units and
 * buildings are.
 *
 * ## Why a patch wants this
 *
 * The government table is where M4b's two economy constants now live (the `despotism`
 * row) and where the rate caps and the happiness modifiers live. The single most
 * interesting balance question M9 raises — "what happens if a despotism supports four
 * units per city instead of two?" — is a one-field patch on one row, and before this
 * surface existed the answer would have been "edit the catalog".
 *
 * ## `id` and `provenance` are not patchable
 *
 * The module-wide rule: the id is the key a row is addressed by, and provenance is
 * authorship rather than a magnitude. `requiresTech` **is** patchable, and it can be set
 * but never removed (a `??` merge) — a sweep may gate a government behind a tech, and
 * un-gating one is a catalog edit. That asymmetry is stated rather than hidden, and it is
 * the same one `UnitPatch.requiresResource` has.
 *
 * ## The rules validation attaches
 *
 * Every cap an integer in `[1, RATE_TOTAL]`, the two economy numbers integers `>= 0`, the
 * happiness modifier an integer of either sign, and — where the row declares one — a
 * `requiresTech` that names a tech the catalog defines. A patch that breaks any of them
 * produces a catalog that fails validation.
 */
export interface GovernmentPatch {
  readonly name?: string;
  /** The per-slider ceilings. Partial, so a sweep may move one slider's cap. */
  readonly rateCaps?: GovernmentRateCapsPatch;
  /** Units supported free per city owned. Integer `>= 0`. */
  readonly freeUnitsPerCity?: number;
  /** Gold per turn per unit beyond the free allowance. Integer `>= 0`. */
  readonly unitSupportCost?: number;
  /** Added to a city's unhappy count. Signed integer. */
  readonly happinessModifier?: number;
  /** The technology this government requires. Set or changed, never removed. */
  readonly requiresTech?: TechId;
}

/** A partial of a government's rate caps, so one slider may move alone. */
export interface GovernmentRateCapsPatch {
  readonly tax?: number;
  readonly science?: number;
  readonly luxury?: number;
}

/**
 * **M10's score weights** — the fourth singleton section.
 *
 * Five magnitudes and no rule of their own beyond "integers `>= 0`"
 * (`validateRuleset`'s check). A sweep patches one weight to ask "does the scoreboard
 * still order the players the way the game played out?", which is the only question a
 * score model can usefully be tuned against.
 */
export interface ScorePatch {
  readonly perPopulation?: number;
  readonly perCity?: number;
  readonly perTech?: number;
  readonly perCulture?: number;
  readonly perWonder?: number;
}

/**
 * **M10's victory thresholds** — the fifth singleton section, and the one a sweep will
 * reach for first, because "where does this game end?" is the question every other
 * balance number is measured against.
 *
 * Four magnitudes, each with the rule `validateRuleset` attaches: the two shares are
 * integers in `[1, 100]`, the culture threshold is an integer `>= 1`, and the score turn
 * is an integer `>= 1`. A patch that sets `culturalVictoryCulture` to 0 produces a catalog
 * that **fails validation** rather than a game every player wins at turn zero.
 *
 * **`scoreVictoryTurn` is a catalog horizon, not an experiment's budget.** A patch that
 * moves it changes when the score victory fires; it does not change when a *simulation*
 * stops. `SimulationOptions.maxTurns` is the experiment's own limit, and the two are
 * deliberately separate values that a sweep can move independently.
 */
export interface VictoryPatch {
  readonly dominationLandPct?: number;
  readonly dominationPopPct?: number;
  readonly culturalVictoryCulture?: number;
  readonly scoreVictoryTurn?: number;
}

/**
 * A **deep-partial of the catalog, addressed by id** — the balance knob the
 * standing requirement asks for ("every magnitude it introduces lives in the rules
 * catalog … or an explicit override").
 *
 * A record keyed by id rather than a list of rows, so a sweep reads like
 * `{ units: { warrior: { cost: 15 } } }` — one number, one place — and so a typo is
 * a *reported* unknown id instead of a silently unmatched row. The trade is stated
 * because it is real: a JavaScript object literal cannot hold the same key twice, so
 * a patch that names one id twice keeps the last write and there is nothing left to
 * report. A `Record` is also unordered, which is exactly right here — overrides are
 * looked up by id, so the *result* cannot depend on how the patch was written.
 *
 * The patch is applied **before** `validateRuleset`, so an override that would
 * produce an invalid ruleset fails exactly the way a hand-edited catalog would — a
 * cost of `0`, a negative maintenance, a movement of `0` — rather than being blessed
 * because it arrived through the override path.
 */
export interface RulesetPatch {
  readonly terrains?: Readonly<Record<string, TerrainPatch>>;
  readonly units?: Readonly<Record<string, UnitPatch>>;
  readonly buildings?: Readonly<Record<string, BuildingPatch>>;
  readonly improvements?: Readonly<Record<string, ImprovementPatch>>;
  readonly resources?: Readonly<Record<string, ResourcePatch>>;
  /**
   * The combat globals (M6b) — **partial**, so a sweep moves one magnitude at a time and
   * leaves the rest exactly as the catalog declares them.
   *
   * A partial of the section rather than a whole replacement, and that is the same rule
   * every other field here follows: a patch that had to restate all nine numbers would
   * make "move `wallsBonusPct` and change nothing else" impossible to write down, and a
   * sweep built on it would be measuring its own boilerplate as much as the knob.
   *
   * ## Every field of the section is patchable, and that is checked
   *
   * M6's review found the same class of bug twice in the row merges — `mergeUnit` dropped
   * `hitPoints` and `mergeTerrain` dropped `defenseBonus`, so a patch naming any *other*
   * field of those rows silently reset the dropped one. The rule this package now holds
   * itself to is stated in `overrides.ts`: **a field a patch does not name keeps the value
   * the row has**, every patchable field is written out explicitly in the merge, and a
   * field the surface does not support is *reported*. `CombatPatch` names all nine, and
   * `overrides.test.ts` asserts field by field that moving one leaves the other eight
   * untouched.
   *
   * ## What is still unsupported, reported rather than ignored
   *
   * The catalog's **`techs`** section has no patch surface at all (M5's tree is not
   * sweepable here; `scripts/tech-balance-sweep.ts` measures that gap and prints it), and
   * overrides.ts reports a patch that names it instead of dropping it on the floor. That
   * is the one remaining hole in "every catalog magnitude is reachable from a patch", and
   * it is named rather than left for a sweep to discover as a zero.
   */
  readonly combat?: CombatPatch;
  /**
   * The capture rule (M7) — **partial**, so a sweep moves the divisor and leaves the rest
   * of the catalog exactly as the author wrote it.
   *
   * M7 added this field for the reason M6b added `combat`: the magnitude had been a
   * module constant in `core/cities.ts`, and the combat sweep had to report that it could
   * not be moved. `CapturePatch` names the whole section (one field), and
   * `overrides.test.ts` asserts that moving it leaves the combat section untouched, so a
   * capture sweep cannot be measuring a combat change by accident.
   */
  readonly capture?: CapturePatch;
  /**
   * M9's culture and contentment model — **partial**, so a sweep moves one border
   * threshold and leaves the contentment ladder exactly as the catalog declares it.
   *
   * Added to this surface for the reason M6b added `combat` and M7 added `capture`: M9's
   * border thresholds, unhappy ladder and luxury magnitudes are the largest block of new
   * rules numbers this wave introduces, and a knob no sweep can turn is a knob nobody will
   * ever tune. `overrides.test.ts` asserts field by field that moving one leaves the
   * others untouched.
   */
  readonly culture?: CulturePatch;
  /**
   * M9's government rows — addressed **by id**, like units and buildings, because they are
   * rows. See `GovernmentPatch`.
   */
  readonly governments?: Readonly<Record<string, GovernmentPatch>>;
  /** M10's score weights — partial, one weight at a time. See `ScorePatch`. */
  readonly score?: ScorePatch;
  /** M10's victory thresholds — partial, one threshold at a time. See `VictoryPatch`. */
  readonly victory?: VictoryPatch;
}
