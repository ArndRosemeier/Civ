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
 *    workstream is coded against, so it is an escalation, not an edit.
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
  GameState,
  ImprovementKind,
  PlayerId,
  ResourceId,
  ResourceKind,
  RngState,
  RulesetView,
  Settings,
  TerrainRole,
  TerrainYields,
  UnitDomain,
  UnitRole,
} from '@civts/core';
import type { Ruleset } from '@civts/rules';

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
export type StopReason = 'max-turns' | 'violation' | 'no-commands';

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
  readonly stoppedBecause: StopReason;
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

/** One victory outcome and how many seeds reached it. */
export interface WinCount {
  readonly outcome: string;
  readonly count: number;
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
export type OverrideSection = 'terrains' | 'units' | 'buildings' | 'improvements' | 'resources';

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
}

export interface BuildingPatch {
  readonly name?: string;
  readonly cost?: number;
  /** Gold per turn the building costs its owner. */
  readonly maintenance?: number;
  /** Replaces the effect list wholesale — a list, so a partial of it is ambiguous. */
  readonly effects?: readonly BuildingEffect[];
  /** `true` only. A `false` is not how this project spells "not a wonder". */
  readonly wonder?: true;
}

export interface ImprovementPatch {
  readonly kind?: ImprovementKind;
  readonly name?: string;
  /** Worker turns to complete. */
  readonly turns?: number;
  readonly yields?: YieldsPatch;
  readonly allowedRoles?: readonly TerrainRole[];
}

export interface ResourcePatch {
  readonly name?: string;
  readonly kind?: ResourceKind;
  readonly yields?: YieldsPatch;
  readonly allowedRoles?: readonly TerrainRole[];
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
}
