/**
 * `sim` — run the game headlessly, in batches, and report what happened.
 * `sweep` — vary **one** catalog number and measure the difference it makes.
 *
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first". That section is
 * the specification this file exists to serve, and its rules are worth restating here
 * because every decision below follows from one of them:
 *
 * 1. **Runnable without a UI, at scale, deterministically.** The whole command is a
 *    pure function of its flags: seeds, settings, an (optionally overridden) catalog
 *    and a policy. There is no clock, no `Math.random`, no ambient state, and no
 *    console inside the builders — `runSimCommand` returns the text it would print.
 *    Two runs of the same flags produce byte-identical output, which the tests pin.
 * 2. **Observable.** The report is built from `@civts/sim`'s structured result
 *    (`BatchResult`, `TurnMetrics`, `Violation`, `MetricAggregate`) — every per-turn
 *    number the engine produced, plus the invariants' verdict.
 * 3. **Tunable.** `--override <section>.<id>.<field>=<value>` changes a catalog
 *    magnitude for a whole batch without editing content, and it runs through
 *    `applyOverrides` → `validateRuleset`, so an override that would produce an
 *    invalid ruleset fails exactly as a hand-edited catalog would.
 * 4. **Checkable in flight.** The registered invariants run on every turn of every
 *    run; a violation is reported **by name, with its seed and turn**, loudly, and
 *    the command exits non-zero. `--fault` injects a deliberately failing invariant
 *    so that the reporting path itself can be exercised end to end.
 * 5. **A failure the result can carry (M7d).** A policy that throws while planning is caught
 *    by the policy itself (a policy is required to be *total*), so what it returns is a
 *    partial turn — and that is indistinguishable from a turn in which the AI had nothing to
 *    say. The record is a **field of every report this file builds** (`plannerFailures`,
 *    required and empty when there are none, exactly like `violations`), it is rendered
 *    loudly on both the text and `--json` paths, and it **fails the run**: a batch or a
 *    tournament containing one exits 1. The stderr warning stayed, but it is no longer the
 *    only evidence — a reader holding only the structured value can tell a partial turn from
 *    a quiet one.
 *
 * ## ONE source of truth for output
 *
 * The standing requirement's "Reporting" paragraph is the rule this module is built
 * around: *human-readable and machine-readable output from ONE source of truth: a
 * structured result value plus a text renderer over it. The text renderer must never
 * compute a figure the structured value does not contain.*
 *
 * So the shape of this file is always the same, three steps:
 *
 * ```
 *   run…        → a structured report value   (buildSimReport / runBalanceSweep)
 *   render…     → text, reading only that value (renderSimReport / renderSweepReport)
 *   --json      → canonicalize(the same value)  (sorted keys, diffable)
 * ```
 *
 * Every number the text prints is a field of the report — including the totals, the
 * per-run horizon sums and the sweep's deltas, which are computed **in the builder**
 * and stored, never re-derived by the renderer. The renderer's only arithmetic is
 * column padding and `toFixed(2)` on a stored mean. That division exists because a
 * previous reporting path in this project computed its own figures and disagreed with
 * the engine (see the M2 provenance summary): a renderer that can compute can be
 * wrong, and a renderer that cannot compute cannot.
 *
 * ## Integers, means, and summation order
 *
 * Everything the engine measures is an integer, and this module only adds integers.
 * A mean is therefore always `sum / count` where `sum` is an exact integer total
 * (carried beside the mean so a reader can check it): integer addition is exact in
 * IEEE-754 doubles below 2^53, so *no* aggregate here depends on the order the terms
 * were folded in. `MetricTotal` states this in the same words. The one place
 * summation order could matter — the batch's own aggregates — is `@civts/sim`'s
 * `aggregateRuns`, which folds in canonical `(seed, turn, playerId)` order and says so.
 *
 * ## Provenance
 *
 * This file introduces **no game magnitude**. Every number a sweep varies is read out
 * of `@civts/rules`' catalog (`readKnob` reads the shipped value *from the row*), and
 * the catalog's own provenance travels into the report, so a sweep table can never
 * present a guessed number as Civ 3's. The only numbers written here are:
 *
 * - **guards on this command's own loops** — how many seeds and how many sweep values
 *   one invocation will start (`MAX_SEEDS_PER_BATCH`, `MAX_SWEEP_VALUES`) — which are
 *   about the CLI, not about the game, and are documented as such;
 * - **default experiment parameters** — a default seed set, turn count, sample stride
 *   and sweep grid — which are *experiment* choices, not rules: they decide what is
 *   measured, not what is true in the world.
 */

import {
  IMPROVEMENT_KINDS,
  MAP_DIMENSIONS,
  MAP_SIZES,
  TERRAIN_ROLES,
  UNIT_ROLES,
  asResourceId,
  err,
  loadSettings,
  ok,
  type GameOutcome,
  type MapSize,
  type Provenance,
  type Result,
  asTechId,
  fullHitPoints,
  type Settings,
  type SettingsIssue,
  type UnitDomain,
  type VictoryConditionId,
  terrainDefenseBonus,
} from '@civts/core';
import {
  CATALOG,
  RESOURCE_KINDS,
  validateRuleset,
  type Catalog,
  type Ruleset,
  type RulesetError,
} from '@civts/rules';
import {
  A3_TOURNAMENT_EVIDENCE,
  CORE_INVARIANTS,
  DEFAULT_TOURNAMENT_BUDGET_MS,
  DO_NOTHING_POLICY,
  MEASURED_METRIC_FIELDS,
  SIMPLE_POLICY,
  formatOverrideError,
  runBatch,
  runTournament,
  seatPlan,
  smartPolicy,
  tournamentVerdict,
  tryApplyOverrides,
  type BatchResult,
  type BuildingPatch,
  type ImprovementPatch,
  type Invariant,
  type MeasuredMetricField,
  type MetricAggregate,
  type OverrideError,
  type OverrideSection,
  type Policy,
  type PlannerFailure,
  type PlannerPhase,
  type ResourcePatch,
  type RulesetPatch,
  type SimulationResult,
  type StopReason,
  type TerrainPatch,
  type TournamentResult,
  type TournamentTotals,
  type TournamentOutcomeDistribution,
  type TurnMetrics,
  type UnitPatch,
  type Violation,
  type WinCount,
  type YieldsPatch,
} from '@civts/sim';
import { canonicalize, hashValue } from '@civts/testing';

import { parseIntFlag } from './repl.js';

/* ------------------------------------------------------------------ *
 * Guards and defaults — this command's own numbers, not the game's
 * ------------------------------------------------------------------ */

/**
 * How many games one `sim` invocation will start.
 *
 * A guard on *this loop*, in the same spirit as `MAX_STEPS_PER_UNIT` in
 * `@civts/sim`'s policy: the contract asks for "a batch of 50+ games … in a bounded
 * time", and a typed `--seeds 1..100000` would otherwise start a run that nobody can
 * stop. It is not a rule of the game and it changes nothing about a run that is
 * started; it only refuses to start an absurd one, with a message saying so.
 */
const MAX_SEEDS_PER_BATCH = 500;

/** How many knob values one `sweep` invocation will run. Guard, not a rule. */
const MAX_SWEEP_VALUES = 32;

/** The seed set a `sim` run uses when `--seeds` is absent. Default experiment input. */
const DEFAULT_SEED_SPEC = '1..10';

/** Turns per game when `--turns` is absent. Default experiment input. */
const DEFAULT_TURNS = 20;

/** Metrics sampling stride when `--sample-every` is absent. */
const DEFAULT_SAMPLE_EVERY = 1;

/**
 * The policies the CLI can run, by the names its flags accept.
 *
 * One list, because "which strategies exist" is one fact: `--policy` takes one for a whole
 * batch of games, `--seats` takes one per seat for a tournament, and a name that is legal
 * in one place and not the other would be a second statement of the same list waiting to
 * drift.
 *
 * - `smart` — M7's real opponent (`SMART_POLICY`, `packages/sim/src/ai/`), the strategy a
 *   tournament is about and the default in every seat when `--seats` is absent;
 * - `simple` — the placeholder policy M7 replaces, still runnable because a real AI has to
 *   be measured *against* something;
 * - `none` — `DO_NOTHING_POLICY`: the control, which returns no commands at all.
 *
 * The order is the order `--help` prints them in: the real AI, then what it replaces, then
 * the control.
 */
export const SIM_POLICIES = ['smart', 'simple', 'none'] as const;
export type SimPolicyName = (typeof SIM_POLICIES)[number];

/** `UnitSpec.domain`'s two values. A type's domain, not a game magnitude. */
const UNIT_DOMAINS: readonly UnitDomain[] = ['land', 'sea'];

/**
 * The metrics the per-run and per-sweep tables show at the horizon, in reading order.
 *
 * These are the four the standing requirement's acceptance line names — "cities
 * founded, population, treasury, units built by turn N" — and they are shown *beside*
 * the full per-metric aggregate table, never instead of it. `cities` is a count of
 * cities standing, which in this engine is also the number founded: nothing removes a
 * city (M4c's bankruptcy disbands units, not cities).
 */
export const HORIZON_METRICS: readonly MeasuredMetricField[] = [
  'cities',
  'population',
  'treasury',
  'units',
];

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

export const SIM_USAGE = `usage: civts sim [--seeds <spec>] [--map-size <size>] [--civs <int>]
                 [--turns <int>] [--policy <name>] [--sample-every <int>]
                 [--override <section>.<id>.<field>=<value>]... [--fault <name>]... [--json]

  --seeds <spec>      which games to run: a list, ranges, or both — "1..50", "3",
                      "1,4,7", "1..3,9" (default ${DEFAULT_SEED_SPEC}; ascending; a seed
                      listed twice is run twice, because it was asked for twice)
  --map-size <size>   one of ${MAP_SIZES.join('|')} (default tiny)
  --civs <int>        civilizations per game (default 2)
  --turns <int>       turns to play per game, at least 1 (default ${String(DEFAULT_TURNS)})
  --policy <name>     ${SIM_POLICIES.join('|')} — "smart" is M7's real opponent, "simple" is the
                      placeholder it replaces and "none" is the do-nothing control
                      (default simple)
  --sample-every <n>  sample metrics every n turns (default ${String(DEFAULT_SAMPLE_EVERY)})
  --override <p>=<v>  change ONE catalog number for the whole batch, repeatable:
                        --override units.settler.cost=4
                        --override buildings.granary.maintenance=2
                        --override terrains.grassland.yields.shields=2
                      applied before validation, so an override that would produce an
                      invalid ruleset is refused exactly as a hand-edited catalog is
  --fault <name>      append a deliberately failing invariant named <name>: a self-test
                      of the violation path, so the gate can be watched firing end to
                      end. It changes nothing about the game. Repeatable.
  --json              print one canonical JSON report (recursively sorted keys,
                      byte-stable for the same flags) instead of the text report

Exit codes:
  0  every run played and every invariant held, and every turn was decided by its policy
  1  something the flags describe could not be run (a ruleset that fails validation),
     or a run broke an invariant — the violation is printed loudly, naming itself, its
     seed and its turn — or a policy threw while planning (a PLANNER FAILURE, which is
     the same kind of fact: the run is not evidence). Both are counted like a violation
     and reported in the --json report as "violations" / "plannerFailures"
  2  the flags themselves are unusable (syntax, an unknown id or field, a bad number)
`;

export const SWEEP_USAGE = `usage: tsx scripts/balance-sweep.ts [--knob <section>.<id>.<field>]
                                     [--values <spec>] [--seeds <spec>] [--turns <int>]
                                     [--map-size <size>] [--civs <int>] [--policy <name>]
                                     [--sample-every <int>] [--json]

  --knob <path>       the ONE catalog number to vary, as a dotted patch path, e.g.
                      units.settler.cost or buildings.factory.maintenance. Its shipped
                      value and its provenance are read out of @civts/rules' catalog,
                      so the table can never present a guess as Civ 3's.
  --values <spec>     the values to run the same seed set under: a list and/or ranges,
                      e.g. "1,2,3,5,8" or "1..8" (ascending, unique)
  --seeds <spec>      seed set, identical for every value (default: the caller's default
                      experiment — see the header of scripts/balance-sweep.ts)
  --turns <int>       turns to play per game (default: the caller's default experiment)
  --map-size <size>   one of ${MAP_SIZES.join('|')} (default tiny)
  --civs <int>        civilizations per game (default 2)
  --policy <name>     ${SIM_POLICIES.join('|')} (default simple)
  --sample-every <n>  sample metrics every n turns (default ${String(DEFAULT_SAMPLE_EVERY)})
  --json              print the sweep's structured report as canonical JSON

The sweep runs the SAME seeds, settings and policy under each value, so every
difference in the table is the knob's. Each row is summed at the horizon (the last
sampled turn) over every run and every civilization, and compared against the shipped
catalog run with no override at all.

Exit codes: 0 = every row ran and held its invariants and no policy threw while planning;
1 = a row broke an invariant (printed loudly), a policy threw while planning (a planner
failure, printed loudly too), or a value produced an invalid ruleset (reported as a
rejected row); 2 = the flags themselves are unusable.
`;

/* ------------------------------------------------------------------ *
 * Errors, the way the rest of this CLI reports them
 * ------------------------------------------------------------------ */

/**
 * A failure the command refuses to run: the lines to print, and what to exit with.
 *
 * `lines` are already prefixed the way this CLI prints them (`error: …`,
 * `settings error: …`, `ruleset error: …`), so `cli.ts` does no formatting of its own
 * and the two commands cannot drift in how a failure reads. `usage` is present exactly
 * when the failure is the *flags*' fault (exit 2), which is when printing the usage
 * block actually helps.
 */
export interface SimCommandFailure {
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly usage: string | undefined;
}

const failure = (exitCode: number, lines: readonly string[], usage?: string): SimCommandFailure =>
  usage === undefined ? { exitCode, lines, usage: undefined } : { exitCode, lines, usage };

/** `Reason` for a thrown value, without pretending to know its type. */
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'a non-Error value was thrown';

/** One validated-ruleset error, rendered. The CLI's `map`/`play` wording, verbatim. */
export const formatRulesetError = (e: RulesetError): string => {
  switch (e.kind) {
    case 'empty-catalog':
      return `empty catalog: ${e.catalog}`;
    case 'duplicate-id':
      return `duplicate id in ${e.catalog}: ${e.id}`;
    case 'placeholder-in-cited-only':
      return `placeholder row in cited-only mode: ${e.catalog}/${e.id} (${e.note})`;
    case 'invalid-value':
      return `invalid value: ${e.catalog}/${e.id}.${e.field} — ${e.detail}`;
    case 'missing-role':
      return `no terrain fills role "${e.role}"`;
    // M5: a prerequisite cycle is refused at validation time, and it is rendered as
    // the loop it is (`a -> b -> a`) rather than as a set of rows, because the loop is
    // what the operator has to break. The wording is `golden.test.ts`'s, verbatim: the
    // two renderers exist because one is shipped and one is a test helper, and a
    // reader comparing a CLI failure with a golden failure must see the same sentence.
    case 'tech-cycle':
      return `tech prerequisite cycle in ${e.catalog}: ${e.detail}`;
  }
};

/** One settings issue, rendered exactly as `map`/`play` render it. */
export const formatSettingsIssue = (issue: SettingsIssue): string =>
  `${issue.path === '' ? '<root>' : issue.path}: ${issue.message}`;

/* ------------------------------------------------------------------ *
 * `--override`: one text assignment → one typed patch
 * ------------------------------------------------------------------ */

/**
 * A `--override` value: what the flag said, and the plain value it named.
 *
 * The CLI is text in, so a value is `integer`, `boolean` or `text` — and each *field*
 * decides which of those it will accept. That split is deliberate: it is what lets
 * `--override units.settler.cost=four` be refused with "cost takes an integer" rather
 * than being quietly accepted as a string and shipped to `validateRuleset` as a
 * ruleset whose cost is unrepresentable.
 */
type KnobValue =
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string };

/** One parsed `--override`: `section.id.field=value`, with the parts it addressed. */
interface OverrideAssignment {
  /** The flag's own text, so every message can quote what was actually typed. */
  readonly text: string;
  readonly section: OverrideSection;
  readonly id: string;
  /** The patch field, dotted for a nested one: `cost`, `yields.shields`. */
  readonly field: string;
  readonly value: KnobValue;
}

const INTEGER_TEXT = /^-?\d+$/;
const FAULT_NAME = /^[a-z][a-z0-9-]*$/;

const isOverrideSection = (name: string): name is OverrideSection =>
  OVERRIDE_SECTIONS_LOOKUP.some((candidate) => candidate === name);

/**
 * The catalog sections a patch may address, in the order `@civts/sim` walks them.
 *
 * M6b added `combat`, and it is listed here rather than treated as a special case
 * because "which sections exist" is one fact: a section the applier can merge and the
 * CLI cannot spell is a knob a sweep reads about in `--help` and then cannot turn.
 * M7 adds `capture` — the second singleton — for exactly that reason, one milestone
 * after the argument was first made.
 */
const OVERRIDE_SECTIONS_LOOKUP: readonly OverrideSection[] = [
  'terrains',
  'units',
  'buildings',
  'improvements',
  'resources',
  'combat',
  'capture',
];

/** Parse one flag value into the plain value it names. */
const parseKnobValue = (raw: string): Result<KnobValue, string> => {
  const text = raw.trim();
  if (text === 'true') return ok({ kind: 'boolean', value: true });
  if (text === 'false') return ok({ kind: 'boolean', value: false });
  if (INTEGER_TEXT.test(text)) {
    const value = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(value)) return err(`value "${raw}" is out of range`);
    return ok({ kind: 'integer', value });
  }
  if (text === '') return err('the value after "=" is empty');
  return ok({ kind: 'text', value: text });
};

/**
 * The row id a singleton section is addressed by.
 *
 * `combat` is one section of nine numbers, not a list of rows — so `--override
 * combat.wallsBonusPct=100` names the section and the field and no id at all, and this
 * is the id the rest of the module (which speaks `section.id.field` everywhere, and the
 * provenance report prints that way too) sees. Written as the constant the rules package
 * files the same row under, so a report and a flag call the one section by the one name.
 */
const COMBAT_ROW_ID = 'combat';

/**
 * The row id the **capture** section is addressed by (M7).
 *
 * The same argument as `COMBAT_ROW_ID`: one section of one magnitude has no id of its
 * own, and the section's name is the id the rest of the module speaks.
 */
const CAPTURE_ROW_ID = 'capture';

/**
 * **M9+M10's singleton sections**, named for the same reason `COMBAT_ROW_ID` and
 * `CAPTURE_ROW_ID` are: each is a table of related magnitudes with no row id of its own, so
 * the override record and the knob syntax need a name to file it under, and the catalog's
 * own field name is the honest one.
 *
 * The three join `readNumeric`/`readProvenance` so a balance sweep can move them — which is
 * the *whole point* of M9 and M10 putting their magnitudes in the catalog in the first
 * place: a border threshold, a score weight or a victory condition that no sweep can turn
 * is a knob nobody will ever tune.
 */
const CULTURE_ROW_ID = 'culture';
const SCORE_ROW_ID = 'score';
const VICTORY_ROW_ID = 'victory';

/**
 * The sections that are **one row rather than a list of rows**, by their own names.
 *
 * A list rather than a chain of `if (section === 'combat')` branches, because "which
 * sections are singletons" is one fact about the catalog — the same argument this file
 * makes for `OVERRIDE_SECTIONS_LOOKUP`, and the same reason M6b centralised it. M7's
 * `capture` section is the second member, and adding it here is the whole of what makes
 * `--knob capture.populationDivisor` work.
 */
const SINGLETON_SECTIONS: readonly { readonly section: OverrideSection; readonly id: string }[] = [
  { section: 'combat', id: COMBAT_ROW_ID },
  { section: 'capture', id: CAPTURE_ROW_ID },
];

const parseOverride = (text: string): Result<OverrideAssignment, string> => {
  const equals = text.indexOf('=');
  if (equals < 0) {
    return err(
      `--override expects <section>.<id>.<field>=<value> (or <section>.<field>=<value> for ` +
        `a singleton section: ${SINGLETON_SECTIONS.map((s) => s.section).join(', ')}), ` +
        `got "${text}"`,
    );
  }

  const path = text.slice(0, equals);
  const parts = path.split('.');
  const section = parts[0] ?? '';
  if (!isOverrideSection(section)) {
    return err(
      `--override names section "${section}", which is not one of ` +
        `${OVERRIDE_SECTIONS_LOOKUP.join('|')} (in "${text}")`,
    );
  }
  // The singleton sections, each of which has two spellings for one address:
  //
  // - `combat.<field>` — the short one, and the one the flag documents;
  // - `combat.combat.<field>` — the long one, spelled the way the provenance report
  //   prints the row (`<section>.<id>`), so a reader who copies the printed name gets
  //   what they copied rather than "that is not a row id".
  //
  // A path naming any *other* id (`combat.walls.rollBound`) is refused here rather than
  // accepted as an id the applier would then fail to find: the section is one row, and
  // the honest answer is that there is no row to name. M7's `capture` section is
  // addressed the same way, through the same branch, because the rule is about the
  // section's *shape* and not about which section it is.
  const singleton = SINGLETON_SECTIONS.find((candidate) => candidate.section === section);
  if (singleton !== undefined) {
    const rest = parts.slice(1);
    const named = rest.length === 2 && rest[0] === singleton.id;
    const field = named ? (rest[1] ?? '') : rest.join('.');
    if ((!named && rest.length !== 1) || field === '') {
      return err(
        `--override expects ${singleton.section}.<field>=<value> — the ${singleton.section} ` +
          `section is one row of numbers rather than a list of rows, so there is no id to ` +
          `name (in "${text}")`,
      );
    }
    const value = parseKnobValue(text.slice(equals + 1));
    if (!value.ok) return value;
    return ok({ text, section, id: singleton.id, field, value: value.value });
  }

  const id = parts[1] ?? '';
  const field = parts.slice(2).join('.');
  if (parts.length < 3 || id === '' || field === '') {
    return err(
      `--override expects <section>.<id>.<field>=<value> (a section, a row id and a field), ` +
        `got "${text}"`,
    );
  }

  const value = parseKnobValue(text.slice(equals + 1));
  if (!value.ok) return value;
  return ok({ text, section, id, field, value: value.value });
};

const wantsInteger = (a: OverrideAssignment): Result<number, string> =>
  a.value.kind === 'integer'
    ? ok(a.value.value)
    : err(`--override ${a.text}: ${a.field} takes an integer, got "${a.text.split('=')[1] ?? ''}"`);

const wantsBoolean = (a: OverrideAssignment): Result<boolean, string> =>
  a.value.kind === 'boolean'
    ? ok(a.value.value)
    : err(`--override ${a.text}: ${a.field} takes true or false`);

const wantsText = (a: OverrideAssignment): Result<string, string> =>
  a.value.kind === 'text'
    ? ok(a.value.value)
    : err(`--override ${a.text}: ${a.field} takes a bare word (no quotes)`);

/** One of a fixed set of words — how every enumerated catalog field is set. */
const wantsOneOf = <T extends string>(
  a: OverrideAssignment,
  allowed: readonly T[],
): Result<T, string> => {
  if (a.value.kind !== 'text') {
    return err(`--override ${a.text}: ${a.field} takes one of ${allowed.join('|')}`);
  }
  const found = allowed.find((candidate) => candidate === a.value.value);
  if (found === undefined) {
    return err(`--override ${a.text}: "${a.value.value}" is not one of ${allowed.join('|')}`);
  }
  return ok(found);
};

/** The fields a patch may address, per section — the same lists `@civts/sim` merges. */
const TERRAIN_FIELDS: readonly string[] = [
  'role',
  'name',
  'moveCost',
  'defenseBonusPct',
  // M6's spelling of the same magnitude; the applier sets both from either name, and
  // leaving it off this list refused the flag with a message that claimed the field was
  // unsettable when it was only unspellable *here*.
  'defenseBonus',
  'yields.food',
  'yields.shields',
  'yields.commerce',
  'impassable',
];
const UNIT_FIELDS: readonly string[] = [
  'role',
  'name',
  'attack',
  'defense',
  'movement',
  'cost',
  'domain',
  'requiresResource',
  // M6's two combat/monopoly fields. They were missing from this list while the patch
  // type already carried them, so the CLI refused a flag the applier would have honoured
  // — and, worse, refused it with "not settable from the CLI", which reads as a statement
  // about the *engine* rather than about this list.
  'hitPoints',
  'requiresTech',
];
/**
 * M6b's nine combat magnitudes, in the catalog's own order.
 *
 * They are the fields the `combat` section may be patched with, and the list exists so
 * that `--override combat.rollbown=10` is refused with the nine names that would have
 * worked rather than silently accepted: a knob that was never applied is indistinguishable
 * from a knob with no effect, which is the whole reason M6b moved these numbers into the
 * catalog in the first place.
 */
const COMBAT_FIELDS: readonly string[] = [
  'fortifyBonusPct',
  'cityDefenseBonusPct',
  'wallsBonusPct',
  'veteranAttackPct',
  'maxExperience',
  'rollBound',
  'damagePerRound',
  'minWinPct',
  'maxWinPct',
];
/**
 * M7's capture section — one magnitude, and the list exists for the same reason.
 *
 * `--override capture.populationDivizor=4` must be refused with the name that would have
 * worked, not accepted and ignored: a knob that was never applied is indistinguishable
 * from a knob with no effect, which is the failure mode this whole surface exists to
 * prevent.
 */
const CAPTURE_FIELDS: readonly string[] = ['populationDivisor'];
const BUILDING_FIELDS: readonly string[] = ['name', 'cost', 'maintenance', 'wonder'];
const IMPROVEMENT_FIELDS: readonly string[] = [
  'kind',
  'name',
  'turns',
  'yields.food',
  'yields.shields',
  'yields.commerce',
];
const RESOURCE_FIELDS: readonly string[] = [
  'name',
  'kind',
  'yields.food',
  'yields.shields',
  'yields.commerce',
];

const notSettable = (a: OverrideAssignment, fields: readonly string[]): string =>
  `--override ${a.text}: ${a.section}.${a.id}.${a.field} is not settable from the CLI; ` +
  `settable fields are ${fields.join(', ')}`;

/**
 * The `yields` partial a group of assignments names.
 *
 * Written channel by channel rather than by writing into an index signature, for the
 * reason `@civts/sim`'s `overrides.ts` gives for its own merges: a field renamed in the
 * catalog becomes a compile error here instead of a silently ignored key.
 */
const yieldsPatch = (list: readonly OverrideAssignment[]): Result<YieldsPatch, string> => {
  let patch: YieldsPatch = {};
  for (const a of list) {
    const channel = a.field.slice('yields.'.length);
    const value = wantsInteger(a);
    if (!value.ok) return value;
    switch (channel) {
      case 'food':
        patch = { ...patch, food: value.value };
        break;
      case 'shields':
        patch = { ...patch, shields: value.value };
        break;
      case 'commerce':
        patch = { ...patch, commerce: value.value };
        break;
      default:
        return err(
          `--override ${a.text}: "${a.field}" is not a yield channel; the channels are ` +
            `food, shields, commerce`,
        );
    }
  }
  return ok(patch);
};

/** Split a group into the plain fields and the `yields.*` ones, keeping both orders. */
const splitYields = (
  list: readonly OverrideAssignment[],
): {
  readonly plain: readonly OverrideAssignment[];
  readonly yields: readonly OverrideAssignment[];
} => ({
  plain: list.filter((a) => !a.field.startsWith('yields.')),
  yields: list.filter((a) => a.field.startsWith('yields.')),
});

const terrainPatch = (list: readonly OverrideAssignment[]): Result<TerrainPatch, string> => {
  const split = splitYields(list);
  let patch: TerrainPatch = {};
  for (const a of split.plain) {
    switch (a.field) {
      case 'role': {
        const value = wantsOneOf(a, TERRAIN_ROLES);
        if (!value.ok) return value;
        patch = { ...patch, role: value.value };
        break;
      }
      case 'name': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, name: value.value };
        break;
      }
      case 'moveCost': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        patch = { ...patch, moveCost: value.value };
        break;
      }
      case 'defenseBonusPct':
      case 'defenseBonus': {
        // One magnitude, two spellings: the applier sets both names from either, so the
        // CLI sets both too rather than picking one and leaving the engine reading the
        // other. (`core/combat.ts`' `terrainDefenseBonus` prefers `defenseBonus`.)
        const value = wantsInteger(a);
        if (!value.ok) return value;
        patch = { ...patch, defenseBonusPct: value.value, defenseBonus: value.value };
        break;
      }
      case 'impassable': {
        const value = wantsBoolean(a);
        if (!value.ok) return value;
        patch = { ...patch, impassable: value.value };
        break;
      }
      default:
        return err(notSettable(a, TERRAIN_FIELDS));
    }
  }
  if (split.yields.length === 0) return ok(patch);
  const merged = yieldsPatch(split.yields);
  if (!merged.ok) return merged;
  return ok({ ...patch, yields: merged.value });
};

const unitPatch = (list: readonly OverrideAssignment[]): Result<UnitPatch, string> => {
  let patch: UnitPatch = {};
  for (const a of list) {
    switch (a.field) {
      case 'role': {
        const value = wantsOneOf(a, UNIT_ROLES);
        if (!value.ok) return value;
        patch = { ...patch, role: value.value };
        break;
      }
      case 'name': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, name: value.value };
        break;
      }
      case 'domain': {
        const value = wantsOneOf(a, UNIT_DOMAINS);
        if (!value.ok) return value;
        patch = { ...patch, domain: value.value };
        break;
      }
      case 'requiresResource': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, requiresResource: asResourceId(value.value) };
        break;
      }
      case 'requiresTech': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, requiresTech: asTechId(value.value) };
        break;
      }
      case 'attack':
      case 'defense':
      case 'movement':
      case 'cost':
      case 'hitPoints': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        if (a.field === 'attack') patch = { ...patch, attack: value.value };
        else if (a.field === 'defense') patch = { ...patch, defense: value.value };
        else if (a.field === 'movement') patch = { ...patch, movement: value.value };
        else if (a.field === 'hitPoints') patch = { ...patch, hitPoints: value.value };
        else patch = { ...patch, cost: value.value };
        break;
      }
      default:
        return err(notSettable(a, UNIT_FIELDS));
    }
  }
  return ok(patch);
};

const buildingPatch = (list: readonly OverrideAssignment[]): Result<BuildingPatch, string> => {
  let patch: BuildingPatch = {};
  for (const a of list) {
    switch (a.field) {
      case 'name': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, name: value.value };
        break;
      }
      case 'cost': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        patch = { ...patch, cost: value.value };
        break;
      }
      case 'maintenance': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        patch = { ...patch, maintenance: value.value };
        break;
      }
      case 'wonder': {
        const value = wantsBoolean(a);
        if (!value.ok) return value;
        if (!value.value) {
          return err(
            `--override ${a.text}: "wonder" may only be set to true — "false" is not how this ` +
              `project spells "not a wonder"`,
          );
        }
        patch = { ...patch, wonder: true };
        break;
      }
      default:
        return err(notSettable(a, BUILDING_FIELDS));
    }
  }
  return ok(patch);
};

const improvementPatch = (
  list: readonly OverrideAssignment[],
): Result<ImprovementPatch, string> => {
  const split = splitYields(list);
  let patch: ImprovementPatch = {};
  for (const a of split.plain) {
    switch (a.field) {
      case 'kind': {
        const value = wantsOneOf(a, IMPROVEMENT_KINDS);
        if (!value.ok) return value;
        patch = { ...patch, kind: value.value };
        break;
      }
      case 'name': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, name: value.value };
        break;
      }
      case 'turns': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        patch = { ...patch, turns: value.value };
        break;
      }
      default:
        return err(notSettable(a, IMPROVEMENT_FIELDS));
    }
  }
  if (split.yields.length === 0) return ok(patch);
  const merged = yieldsPatch(split.yields);
  if (!merged.ok) return merged;
  return ok({ ...patch, yields: merged.value });
};

const resourcePatch = (list: readonly OverrideAssignment[]): Result<ResourcePatch, string> => {
  const split = splitYields(list);
  let patch: ResourcePatch = {};
  for (const a of split.plain) {
    switch (a.field) {
      case 'kind': {
        const value = wantsOneOf(a, RESOURCE_KINDS);
        if (!value.ok) return value;
        patch = { ...patch, kind: value.value };
        break;
      }
      case 'name': {
        const value = wantsText(a);
        if (!value.ok) return value;
        patch = { ...patch, name: value.value };
        break;
      }
      default:
        return err(notSettable(a, RESOURCE_FIELDS));
    }
  }
  if (split.yields.length === 0) return ok(patch);
  const merged = yieldsPatch(split.yields);
  if (!merged.ok) return merged;
  return ok({ ...patch, yields: merged.value });
};

/**
 * The singleton `combat` section's patch: nine plain integers and no nesting.
 *
 * No row id is consulted, because there is no row to look up: the parser refuses any
 * `combat` path that names an id other than the section's own, so every assignment
 * reaching here is already a field of the one row.
 */
const combatPatch = (
  list: readonly OverrideAssignment[],
): Result<NonNullable<RulesetPatch['combat']>, string> => {
  let patch: NonNullable<RulesetPatch['combat']> = {};
  for (const a of list) {
    const found = COMBAT_FIELDS.find((candidate) => candidate === a.field);
    if (found === undefined) return err(notSettable(a, COMBAT_FIELDS));
    const value = wantsInteger(a);
    if (!value.ok) return value;
    // Field by field, so a renamed catalog field is a compile error here rather than a
    // key the applier silently ignores.
    switch (found) {
      case 'fortifyBonusPct':
        patch = { ...patch, fortifyBonusPct: value.value };
        break;
      case 'cityDefenseBonusPct':
        patch = { ...patch, cityDefenseBonusPct: value.value };
        break;
      case 'wallsBonusPct':
        patch = { ...patch, wallsBonusPct: value.value };
        break;
      case 'veteranAttackPct':
        patch = { ...patch, veteranAttackPct: value.value };
        break;
      case 'maxExperience':
        patch = { ...patch, maxExperience: value.value };
        break;
      case 'rollBound':
        patch = { ...patch, rollBound: value.value };
        break;
      case 'damagePerRound':
        patch = { ...patch, damagePerRound: value.value };
        break;
      case 'minWinPct':
        patch = { ...patch, minWinPct: value.value };
        break;
      case 'maxWinPct':
        patch = { ...patch, maxWinPct: value.value };
        break;
    }
  }
  return ok(patch);
};

/**
 * The singleton `capture` section's patch (M7): one plain integer and no nesting.
 *
 * Written out rather than folded into `combatPatch` because the two sections are
 * different rows of different shapes, and a generic "patch a singleton" helper would have
 * to be keyed by a runtime field name — which is exactly the cast-shaped hole
 * `@civts/sim`'s merges avoid. No row id is consulted here either, for the reason
 * `combatPatch` states: the parser refuses any `capture` path that names an id other than
 * the section's own, so every assignment reaching here is a field of the one row.
 */
const capturePatch = (
  list: readonly OverrideAssignment[],
): Result<NonNullable<RulesetPatch['capture']>, string> => {
  let patch: NonNullable<RulesetPatch['capture']> = {};
  for (const a of list) {
    const found = CAPTURE_FIELDS.find((candidate) => candidate === a.field);
    if (found === undefined) return err(notSettable(a, CAPTURE_FIELDS));
    const value = wantsInteger(a);
    if (!value.ok) return value;
    switch (found) {
      case 'populationDivisor':
        patch = { ...patch, populationDivisor: value.value };
        break;
    }
  }
  return ok(patch);
};

/** One section's assignments, grouped by row id, in ascending id order. */
const sectionRecord = <P>(
  assignments: readonly OverrideAssignment[],
  merge: (list: readonly OverrideAssignment[]) => Result<P, string>,
): Result<Readonly<Record<string, P>>, string> => {
  const byId = new Map<string, OverrideAssignment[]>();
  for (const a of assignments) {
    const list = byId.get(a.id);
    if (list === undefined) byId.set(a.id, [a]);
    else list.push(a);
  }

  let record: Readonly<Record<string, P>> = {};
  for (const id of [...byId.keys()].sort()) {
    const merged = merge(byId.get(id) ?? []);
    if (!merged.ok) return merged;
    record = { ...record, [id]: merged.value };
  }
  return ok(record);
};

/**
 * Every `--override` as one `RulesetPatch`, or the first thing wrong with one of them.
 *
 * Two-stage on purpose: the flag's *syntax* is checked here, and the patch's
 * *semantics* (does that row exist, may that field be set, is the result a valid
 * ruleset) is `applyOverrides`' and `validateRuleset`'s job — the same functions a
 * hand-edited catalog goes through. A second opinion here would be a second set of
 * rules about what an override may do, which is exactly the drift this project keeps
 * ruling out.
 */
export const buildRulesetPatch = (
  assignments: readonly OverrideAssignment[],
): Result<RulesetPatch, string> => {
  const of = (section: OverrideSection): readonly OverrideAssignment[] =>
    assignments.filter((a) => a.section === section);

  const terrains = sectionRecord(of('terrains'), terrainPatch);
  if (!terrains.ok) return terrains;
  const units = sectionRecord(of('units'), unitPatch);
  if (!units.ok) return units;
  const buildings = sectionRecord(of('buildings'), buildingPatch);
  if (!buildings.ok) return buildings;
  const improvements = sectionRecord(of('improvements'), improvementPatch);
  if (!improvements.ok) return improvements;
  const resources = sectionRecord(of('resources'), resourcePatch);
  if (!resources.ok) return resources;
  // The singleton section goes through the same one builder; `sectionRecord` is not used
  // because there is one row and it has a fixed name, so grouping by id would only
  // re-derive the constant this module already knows.
  const combat = combatPatch(of('combat'));
  if (!combat.ok) return combat;
  // M7's capture section, through its own builder, for the same reason the combat globals
  // have one: there is one row and it has a fixed name.
  const capture = capturePatch(of('capture'));
  if (!capture.ok) return capture;

  return ok({
    ...(assignments.some((a) => a.section === 'terrains') ? { terrains: terrains.value } : {}),
    ...(assignments.some((a) => a.section === 'units') ? { units: units.value } : {}),
    ...(assignments.some((a) => a.section === 'buildings') ? { buildings: buildings.value } : {}),
    ...(assignments.some((a) => a.section === 'improvements')
      ? { improvements: improvements.value }
      : {}),
    ...(assignments.some((a) => a.section === 'resources') ? { resources: resources.value } : {}),
    ...(assignments.some((a) => a.section === 'combat') ? { combat: combat.value } : {}),
    ...(assignments.some((a) => a.section === 'capture') ? { capture: capture.value } : {}),
  });
};

/* ------------------------------------------------------------------ *
 * `--seeds` / `--values`: an integer spec
 * ------------------------------------------------------------------ */

/**
 * A list of whole numbers written as text: `3`, `1,4,7`, `1..50`, or a mix.
 *
 * The result is **ascending**, and duplicates are kept: the batch's own contract is
 * that "a caller that lists a seed twice asked for two games", and silently
 * de-duplicating here would change a batch (and its row count) behind the caller's
 * back. Ranges are inclusive at both ends, and a reversed range is an error rather
 * than a silent empty set — "I asked for 50 games and got none" is the outcome worth
 * refusing.
 */
export const parseIntegerSpec = (
  raw: string,
  flag: string,
  cap: number,
): Result<readonly number[], string> => {
  const items = raw.split(',');
  const values: number[] = [];

  for (const item of items) {
    const text = item.trim();
    if (text === '') return err(`${flag} has an empty entry in "${raw}"`);

    const range = text.split('..');
    if (range.length > 2) return err(`${flag} entry "${text}" is not a number or a range`);

    const first = range[0] ?? '';
    const parsed = parseIntFlag(flag, first);
    if (!parsed.ok) return err(`${parsed.error} (in "${raw}")`);

    if (range.length === 1) {
      values.push(parsed.value);
      continue;
    }

    const last = parseIntFlag(flag, range[1] ?? '');
    if (!last.ok) return err(`${last.error} (in "${raw}")`);
    if (last.value < parsed.value) {
      return err(
        `${flag} range "${text}" counts downwards; write ` +
          `${String(last.value)}..${String(parsed.value)}`,
      );
    }
    for (let value = parsed.value; value <= last.value; value += 1) values.push(value);
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return err(`${flag} named no values`);
  if (sorted.length > cap) {
    return err(
      `${flag} names ${String(sorted.length)} values; this command starts at most ` +
        `${String(cap)} (narrow the spec, or run it more than once)`,
    );
  }
  return ok(sorted);
};

/** `--seeds` for a batch. */
export const parseSeedSpec = (raw: string): Result<readonly number[], string> =>
  parseIntegerSpec(raw, '--seeds', MAX_SEEDS_PER_BATCH);

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

/** Flags as parsed — absent means "leave the default alone", not "zero". */
export interface SimFlags {
  readonly seeds: readonly number[] | undefined;
  /** The seed spec as typed, so the report can quote what was asked for. */
  readonly seedSpec: string | undefined;
  readonly mapSize: MapSize | undefined;
  readonly civCount: number | undefined;
  readonly turns: number | undefined;
  readonly policy: SimPolicyName | undefined;
  readonly sampleEvery: number | undefined;
  readonly overrides: readonly string[];
  readonly faults: readonly string[];
  readonly json: boolean;
}

const SIM_VALUE_FLAGS: readonly string[] = [
  '--seeds',
  '--map-size',
  '--civs',
  '--turns',
  '--policy',
  '--sample-every',
  '--override',
  '--fault',
];

export const parseSimArgs = (args: readonly string[]): Result<SimFlags, string> => {
  let seeds: readonly number[] | undefined;
  let seedSpec: string | undefined;
  let mapSize: MapSize | undefined;
  let civCount: number | undefined;
  let turns: number | undefined;
  let policy: SimPolicyName | undefined;
  let sampleEvery: number | undefined;
  let json = false;
  const overrides: string[] = [];
  const faults: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined) break;

    if (flag === '--json') {
      json = true;
      continue;
    }
    if (!SIM_VALUE_FLAGS.includes(flag)) return err(`unknown option for sim: "${flag}"`);

    const raw = args[i + 1];
    if (raw === undefined) return err(`${flag} needs a value`);
    i += 1; // consume the value

    switch (flag) {
      case '--seeds': {
        const parsed = parseSeedSpec(raw);
        if (!parsed.ok) return parsed;
        seeds = parsed.value;
        seedSpec = raw.trim();
        break;
      }
      case '--map-size': {
        const size = MAP_SIZES.find((candidate) => candidate === raw);
        if (size === undefined) {
          return err(`--map-size expects one of ${MAP_SIZES.join('|')}, got "${raw}"`);
        }
        mapSize = size;
        break;
      }
      case '--policy': {
        const name = SIM_POLICIES.find((candidate) => candidate === raw);
        if (name === undefined) {
          return err(`--policy expects one of ${SIM_POLICIES.join('|')}, got "${raw}"`);
        }
        policy = name;
        break;
      }
      case '--turns':
      case '--civs':
      case '--sample-every': {
        const parsed = parseIntFlag(flag, raw);
        if (!parsed.ok) return err(parsed.error);
        if (flag === '--turns') turns = parsed.value;
        else if (flag === '--civs') civCount = parsed.value;
        else sampleEvery = parsed.value;
        break;
      }
      case '--override':
        overrides.push(raw);
        break;
      case '--fault': {
        const name = raw.trim();
        if (!FAULT_NAME.test(name)) {
          return err(
            `--fault expects a kebab-case invariant name (like "gold-conservation"), got "${raw}"`,
          );
        }
        faults.push(name);
        break;
      }
      default:
        return err(`unknown option for sim: "${flag}"`);
    }
  }

  if (turns !== undefined && turns < 1) {
    return err(
      `--turns must be at least 1, got ${String(turns)} (a batch of zero turns measures nothing)`,
    );
  }
  if (sampleEvery !== undefined && sampleEvery < 1) {
    return err(`--sample-every must be at least 1, got ${String(sampleEvery)}`);
  }

  return ok({
    seeds,
    seedSpec,
    mapSize,
    civCount,
    turns,
    policy,
    sampleEvery,
    overrides,
    faults,
    json,
  });
};

/* ------------------------------------------------------------------ *
 * Running the batch
 * ------------------------------------------------------------------ */

/**
 * One policy, by the name the CLI's flags give it.
 *
 * The three names map to the three shipped policies by name and nothing else: `smart` is
 * M7's real opponent, `simple` the placeholder it replaces, `none` the do-nothing control.
 * A switch rather than a map, so adding a name to `SIM_POLICIES` without saying which
 * policy it runs is a type error rather than an `undefined` reaching a run.
 *
 * ## Why `smart` is built **fresh** here rather than reusing `SMART_POLICY`
 *
 * Since M7d a policy carries a **failure record** — `PolicyReport`, the typed evidence that it
 * threw while planning — and that record is *cumulative for the instance*: it keeps the first
 * failure of each pass, for as long as the object lives. `SMART_POLICY` is a module-level
 * singleton, so two CLI invocations in one process would share one record, and the second
 * invocation could not report a pass the first one had already failed (the record has no
 * second entry for that pass, by design — see `PolicyReport`). A diagnostic that can only fire
 * once per process is exactly the kind of half-wired evidence M7d exists to end.
 *
 * So each command builds its own instance, and `runSimulation`'s baseline rule (a run reports the
 * throws that happened *after* it started, read from the policy's monotone count and from the
 * records that appeared while it played) then subtracts nothing: what an invocation reports is what
 * happened during that invocation. Note that this is about the *invocation*, not about one game —
 * the batch and the tournament hand this one instance to **every seat of every run** of the command,
 * which is exactly the reused-instance case the runner's second baseline exists for (H1/G2-1:
 * a game must not be handed an earlier game's turn and pass). The policy is stateless in every
 * other respect — its decisions are a pure function of `(state, playerId, ruleset, weights)`, which
 * is why two instances produce byte-identical games — so this changes the games not at all and the
 * evidence for the better. The singleton stays exported (`@civts/sim`'s `SMART_POLICY`) for
 * callers that want the shared one, and the two are constructed identically.
 */
const policyOf = (name: SimPolicyName): Policy => {
  switch (name) {
    case 'smart':
      return smartPolicy();
    case 'simple':
      return SIMPLE_POLICY;
    case 'none':
      return DO_NOTHING_POLICY;
  }
};

/**
 * A deliberately failing invariant, appended by `--fault`.
 *
 * It exists so the violation path can be *seen* end to end — the batch loop records
 * it, the report names it with the seed and the turn, the banner shouts and the exit
 * code is non-zero — without waiting for a real defect to appear. It is a self-test of
 * the reporting path, not a game rule, and it changes nothing about the world: `name`
 * is the caller's, so a report says which probe fired.
 */
const faultInvariant = (name: string): Invariant => ({
  name,
  description: 'A deliberately failing invariant (--fault): a self-test of the violation path.',
  check: () => [
    `injected fault: the invariant named "${name}" fails on purpose (--fault), so the violation ` +
      `path can be seen to fire end to end`,
  ],
});

/* ------------------------------------------------------------------ *
 * The structured report
 * ------------------------------------------------------------------ */

/** An exact integer total for one metric, with the mean derived from it. */
export interface MetricTotal {
  readonly metric: MeasuredMetricField;
  /** How many rows were summed. */
  readonly count: number;
  /**
   * The exact integer total. Integer addition is exact in IEEE-754 doubles below
   * 2^53, so this sum does not depend on the order the terms were folded in — which is
   * what lets `mean` be a division of two exact quantities rather than an accumulated
   * average (an accumulated average *would* be order-dependent).
   */
  readonly sum: number;
  /** `sum / count`, or 0 when nothing was summed. */
  readonly mean: number;
}

/**
 * A violation, qualified with the game it happened in — and, for a sweep, with the
 * swept value whose batch produced it.
 *
 * `value` is OPTIONAL and the key is **omitted** when there is none (a plain `sim`
 * run sweeps nothing): a key written as `undefined` is not representable in canonical
 * JSON, so the `--json` report could not be produced at all.
 */
export interface ReportedViolation {
  readonly seed: number;
  readonly turn: number;
  readonly invariant: string;
  readonly message: string;
  /** The swept knob value this batch ran, when the report comes from a sweep. */
  readonly value?: number;
}

/**
 * **One planner failure, qualified with the game it happened in** — M7d's evidence, as a report
 * carries it.
 *
 * `plannerFailures` is a field of the engine's results (`SimulationResult`, and the aggregate on
 * `TournamentResult`), and the engine's record already says **who** (`policy`), **when**
 * (`turn`, `playerId`), **where** (`phase`, `detail`) and **what** (`error`). The one thing it
 * cannot say is *which game*, because a `SimulationResult` is one game and does not name
 * itself inside its own records — so the report qualifies each record with its `seed`, exactly
 * as it does for a violation, and `value` when the report comes from a sweep.
 *
 * **The record is about the run it is filed under**, which is a property of the engine's seam
 * rather than of this file: a policy instance is reusable — `SMART_POLICY` is a singleton, and this
 * CLI hands one instance to every seat of every run — so a record taken from the policy's
 * first-per-pass memory could name a turn and a pass from an invocation that had already finished.
 * The runner collects each run's own throws (`@civts/sim`'s "Carrying a planner failure", H1/G2-1),
 * so what arrives here is this game's turn, pass, player and detail. The report copies them.
 *
 * The M7d acceptance line asks for exactly this: a tournament containing a planner failure
 * "exits non-zero and says **which game, turn and phase** failed". Every field here is copied
 * from the engine's record rather than recomputed, `value` is **optional and omitted** when
 * there is none (an explicit `undefined` is not representable in canonical JSON), and nothing
 * in this report ever filters, caps or averages the list.
 *
 * `phase` and `detail` are optional too, and for the same reason `value` is: the engine's own
 * `PlannerFailure` carries them only when the policy could say where its throw happened. A record
 * that cannot say is rendered as saying less — never given a placeholder that reads like a pass
 * name, and never given another run's. In practice the shipped AI always knows: it records its
 * own pass as it plans.
 */
export interface ReportedPlannerFailure {
  readonly seed: number;
  readonly policy: string;
  readonly turn: number;
  readonly playerId: number;
  readonly phase?: PlannerPhase;
  readonly detail?: string;
  readonly error: string;
  /** The swept knob value this batch ran, when the report comes from a sweep. */
  readonly value?: number;
}

/** The experiment the report describes — everything a run is a function of. */
export interface SimParameters {
  readonly mapSize: string;
  readonly width: number;
  readonly height: number;
  readonly civCount: number;
  readonly maxTurns: number;
  readonly policy: string;
  readonly sampleEvery: number;
  /** The seed spec as typed (`1..50`), for the report's own provenance. */
  readonly seedSpec: string;
  /** The seeds actually run, ascending. */
  readonly seeds: readonly number[];
}

/** The ruleset the numbers came from: without it, a balance figure means nothing. */
export interface SimRulesetReport {
  readonly fidelity: string;
  /** `hashValue` of the catalog as overridden — the exact content that produced the runs. */
  readonly hash: string;
  readonly overrideCount: number;
  /** `section.id.field: before -> after` for every override named, in patch order. */
  readonly applied: readonly string[];
  readonly patch: RulesetPatch;
}

/** One game's summary. */
export interface SimRunReport {
  readonly seed: number;
  readonly turnsPlayed: number;
  readonly stoppedBecause: StopReason;
  /**
   * **What ended this run, or that nothing did** — the engine's own outcome, read from
   * `SimulationResult.outcome` (P1). Required and always present, in both arms of the union.
   *
   * A batch is a list of games like a tournament is, and its rows carried only `stoppedBecause`:
   * `'game-over'` said a game had ended and never which condition ended it or who won, which is
   * the same hole the tournament report had. The seat's policy name here is the batch's single
   * `--policy` (`SimParameters.policy`), because a batch seats one policy in every chair — the
   * rotation, and the reason a seat total is meaningful there, belongs to the tournament.
   */
  readonly outcome: GameOutcomeReport;
  readonly finalHash: string;
  readonly metricRows: number;
  /** The last turn sampled; 0 when a run produced no rows. */
  readonly finalTurn: number;
  /** `HORIZON_METRICS` sums over this run's final sampled rows (one per civilization). */
  readonly horizon: readonly MetricTotal[];
  /** The final sampled rows themselves, for a JSON consumer that wants every detail. */
  readonly final: readonly TurnMetrics[];
  /**
   * **Registry checks this run really ran**, read from `SimulationResult.invariantChecks`
   * (F2) — the per-run term the batch total is summed from, carried so a reader can see
   * *which* run contributed what rather than only the sum. A decided run contributes
   * `turnsPlayed × count`, like any other, now that the registry is checked before the
   * game-over break; it contributed one registry less while it was not.
   */
  readonly invariantChecks: number;
  readonly violations: readonly ReportedViolation[];
  /**
   * Planner failures this run reported — empty for a run the AI actually played.
   *
   * Required and always present, exactly like `violations`: M7d's whole point is that a reader
   * holding only this value can tell a **partial turn** from a **quiet one**, and a field a
   * report might omit is a field a reader has to remember to check for.
   */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
}

export interface SimInvariantReport {
  readonly names: readonly string[];
  readonly count: number;
  /**
   * **Whole-registry checks the runs really ran**, summed from each run's own
   * `SimulationResult.invariantChecks` (F2). It is a count, not `turnsPlayed × count`:
   * the product over-reports by one whole registry per decided game, because the runner
   * used to break on the deciding turn *before* checking it. The field's own doc comment
   * said "one per turn played" while the loop skipped the turn that ended the game —
   * `sim-cli.test.ts` now pins the counted figure on a fixture whose runs really end, so
   * the arithmetic and the claim cannot drift apart again.
   */
  readonly checks: number;
  readonly violations: number;
}

export interface SimTotals {
  readonly runs: number;
  readonly turnsPlayed: number;
  readonly metricRows: number;
  readonly violatingRuns: number;
  /**
   * How many runs reported at least one planner failure.
   *
   * The mirror of `violatingRuns`, and stored for the same reason: the banner a reader sees
   * names a count of runs, and the renderer must print that count rather than compute it.
   */
  readonly plannerFailingRuns: number;
  readonly horizonTurnMin: number;
  readonly horizonTurnMax: number;
  /** True when runs stopped on different turns, so the horizon sums mix horizons. */
  readonly horizonVaries: boolean;
}

/**
 * The whole `sim` report — the one value the text renderer and `--json` both read.
 *
 * `status` and `exitCode` are *part of* the value rather than something the caller
 * works out afterwards, so "did this batch hold?" has exactly one answer and the
 * renderer never decides anything.
 *
 * Since M7d the status has **three** ways to fail, and they are one word each so a pipeline
 * reading `status` needs no arithmetic: `violations` (an invariant broke), `planner-failures`
 * (a policy threw while planning, so a game in this batch is not a measurement of the AI) and
 * `ok`. Both failure statuses exit 1 — a planner failure is *counted like a violation*, per
 * M7d's own words, because either one means the batch is not evidence — and the two are told
 * apart by which array in the report is non-empty, which is what `--json` is for.
 */
export interface SimReport {
  readonly kind: 'civts-sim-report';
  readonly reportVersion: number;
  readonly status: 'ok' | 'violations' | 'planner-failures';
  readonly exitCode: number;
  readonly parameters: SimParameters;
  readonly ruleset: SimRulesetReport;
  readonly totals: SimTotals;
  readonly invariants: SimInvariantReport;
  readonly aggregates: readonly MetricAggregate[];
  /** `HORIZON_METRICS` counted over every run's final sampled rows. */
  readonly horizonTotals: readonly MetricTotal[];
  readonly runs: readonly SimRunReport[];
  /** Every violation in the batch, ascending by seed then turn. */
  readonly violations: readonly ReportedViolation[];
  /**
   * Every planner failure in the batch, in run order — the batch-level aggregate M7d requires
   * (`batch.ts` explains why the *engine's* `BatchResult` carries them per run instead of
   * summarising them: a batch's job is to fold metric rows, and this is not a row).
   */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
  /**
   * The batch's win counts, **the engine's own `WinCount[]`** rather than a restatement of it:
   * one row per victory condition a run reached, ordered by condition id, each naming every
   * player that won it (`byPlayer`) and how many games ended level (`draws`). The key is absent
   * — omitted, never `[]` — while no run in the batch ended, which is the honest report for a
   * batch of games that all reached their horizon.
   *
   * Since P1 each row carries the winners rather than a single `winner`: the old field kept the
   * first winner of the condition and dropped the rest, so a batch of five cultural wins split
   * 3–2 read as `winner: 0` — a count that could not say who won, which is the same defect the
   * tournament report had.
   */
  readonly wins?: readonly WinCount[];
}

/**
 * The version of the batch report's shape.
 *
 * - 1 — M7b/M7d: the parameters, the ruleset, the totals, the invariants, the aggregates, the
 *   horizon totals, the runs, the violations, the planner failures and the win counts.
 * - 2 — **P1: each run's own ending.** `runs[]` gains `outcome` (the condition, the winner, the
 *   seat and the policy that played it, or an explicit "no outcome"), and `wins` rows now carry
 *   every winner (`byPlayer`) instead of a single one. Bumped for the same reason the tournament
 *   report's version was: a consumer parsing version 1 read a runs table in which "how did this
 *   run end?" was unanswerable, and a version that did not move would let it do so silently.
 *
 * **Q1/F2 added `runs[].invariantChecks` without moving the version, and that is deliberate.**
 * A field *added* to a shape breaks no reading of it: a version-2 consumer that never looks at
 * the new key reads exactly what it read before, and one that wants the per-run check count can
 * now find it instead of dividing the batch total. What did change meaning under the same name is
 * `invariants.checks` — it is a **count** of the checks the runs ran rather than
 * `Σ turnsPlayed × count` — and that is the repair itself, not a new shape: for every run whose
 * deciding turn was already being checked the two agreed, and where they disagreed the old figure
 * was the wrong one. Recorded here rather than in a version bump because a consumer cannot act on
 * the difference: the numbers it would have compared are the numbers this report now states.
 */
export const SIM_REPORT_VERSION = 2;

/** Exact integer totals for `metrics`, over `rows`, in the order given. */
const metricTotals = (
  rows: readonly TurnMetrics[],
  metrics: readonly MeasuredMetricField[],
): readonly MetricTotal[] =>
  metrics.map((metric) => {
    let sum = 0;
    for (const row of rows) sum += row[metric];
    const count = rows.length;
    return { metric, count, sum, mean: count === 0 ? 0 : sum / count };
  });

/**
 * The rows of a run's **horizon**: its highest sampled turn.
 *
 * Not "the last rows of the array" (that would rely on the sampler's ordering) and not
 * `finalState.turn` (with `sampleEvery > 1` the last sample is behind the final state):
 * the horizon is the latest turn the metrics actually describe, which is what every
 * number in this report that says "by turn N" means.
 */
const horizonRows = (result: SimulationResult): readonly TurnMetrics[] => {
  let last = 0;
  for (const row of result.metrics) if (row.turn > last) last = row.turn;
  return result.metrics.filter((row) => row.turn === last);
};

const reportedViolations = (
  seed: number,
  violations: readonly Violation[],
  knobValue?: number,
): readonly ReportedViolation[] =>
  violations.map((violation) => ({
    seed,
    turn: violation.turn,
    invariant: violation.invariant,
    message: violation.message,
    ...(knobValue === undefined ? {} : { value: knobValue }),
  }));

/**
 * The engine's planner-failure records, qualified with the seed of the run that reported them.
 *
 * The same shape of transformation `reportedViolations` performs, and for the same reason: the
 * engine's record is about a *turn*, the report has to say *which game*. Nothing is added,
 * dropped or recomputed — the six fields are copied — and `value` follows the same
 * omit-when-absent rule, so the report stays canonicalisable.
 */
const reportedPlannerFailures = (
  seed: number,
  failures: readonly PlannerFailure[],
  knobValue?: number,
): readonly ReportedPlannerFailure[] =>
  failures.map((failure) => ({
    seed,
    policy: failure.policy,
    turn: failure.turn,
    playerId: failure.playerId,
    // Omitted, never written as `undefined`: the engine's record carries these only when the
    // policy could say where its throw happened, and `canonicalize` refuses an explicit
    // `undefined` outright. Built in the order the type declares, so the canonical writer's
    // sorted keys and a reader's eye agree.
    ...(failure.phase === undefined ? {} : { phase: failure.phase }),
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    error: failure.error,
    ...(knobValue === undefined ? {} : { value: knobValue }),
  }));

export interface SimReportInput {
  readonly batch: BatchResult;
  readonly parameters: SimParameters;
  readonly ruleset: SimRulesetReport;
  readonly invariantNames: readonly string[];
}

/**
 * Turn a batch into the report. **Every figure the text prints is computed here.**
 *
 * The sums (`raw`, per run, per horizon, per invariant) are the only arithmetic; each
 * is an integer fold or a division of one, and each is stored, so the renderer can be
 * read as a formatting function and nothing else.
 */
export const buildSimReport = (input: SimReportInput): SimReport => {
  // A batch seats the same policy in every chair (`SimParameters.policy`), so the seat labels the
  // shared outcome builder resolves are that name for every seat of the game. Built from the
  // parameters rather than restated, so a run's winner is named with the policy that really
  // played it.
  const seatLabels = Array.from(
    { length: input.parameters.civCount },
    () => input.parameters.policy,
  );
  const seatIndices = Array.from({ length: input.parameters.civCount }, (_, seat) => seat);

  const runs: readonly SimRunReport[] = input.batch.runs.map((run) => {
    const rows = horizonRows(run);
    return {
      seed: run.seed,
      turnsPlayed: run.turnsPlayed,
      stoppedBecause: run.stoppedBecause,
      // The engine's own outcome, with the winner's seat resolved to the policy in it.
      outcome: gameOutcomeReport(run, seatIndices, seatLabels),
      finalHash: run.finalHash,
      metricRows: run.metrics.length,
      finalTurn: rows[0]?.turn ?? 0,
      horizon: metricTotals(rows, HORIZON_METRICS),
      final: rows,
      invariantChecks: run.invariantChecks,
      violations: reportedViolations(run.seed, run.violations),
      plannerFailures: reportedPlannerFailures(run.seed, run.plannerFailures),
    };
  });

  const violations = runs.flatMap((run) => run.violations);
  const violatingRuns = runs.filter((run) => run.violations.length > 0).length;
  // The M7d channel, folded the same way: flat over the runs, in run order, never filtered.
  const plannerFailures = runs.flatMap((run) => run.plannerFailures);
  const plannerFailingRuns = runs.filter((run) => run.plannerFailures.length > 0).length;
  const turnsPlayed = runs.reduce((total, run) => total + run.turnsPlayed, 0);
  const metricRows = runs.reduce((total, run) => total + run.metricRows, 0);
  const invariantCount = input.invariantNames.length;
  // **Counted, never derived** (F2): the figure comes from what each run's registry really
  // did. The old `turnsPlayed * invariantCount` product was larger than the truth on any
  // batch containing a decided game — by one whole registry per such game — so the
  // denominator under "zero violations" was a claim about the loop rather than a reading of
  // it. There is no multiplication here for that reason, not merely for elegance.
  const checks = runs.reduce((total, run) => total + run.invariantChecks, 0);
  const horizonTurns = runs.map((run) => run.finalTurn).filter((turn) => turn > 0);
  const horizonTurnMin = horizonTurns.length === 0 ? 0 : Math.min(...horizonTurns);
  const horizonTurnMax = horizonTurns.length === 0 ? 0 : Math.max(...horizonTurns);
  const allHorizonRows = runs.flatMap((run) => run.final);

  return {
    kind: 'civts-sim-report',
    reportVersion: SIM_REPORT_VERSION,
    // A broken invariant is reported first (it is the more specific defect), and either one
    // means the batch is not evidence — so both exit 1. See the type's own note.
    status:
      violations.length > 0 ? 'violations' : plannerFailures.length > 0 ? 'planner-failures' : 'ok',
    exitCode: violations.length > 0 || plannerFailures.length > 0 ? 1 : 0,
    parameters: input.parameters,
    ruleset: input.ruleset,
    totals: {
      runs: runs.length,
      turnsPlayed,
      metricRows,
      violatingRuns,
      plannerFailingRuns,
      horizonTurnMin,
      horizonTurnMax,
      horizonVaries: horizonTurnMin !== horizonTurnMax,
    },
    invariants: {
      names: input.invariantNames,
      count: invariantCount,
      checks,
      violations: violations.length,
    },
    aggregates: input.batch.aggregates,
    horizonTotals: metricTotals(allHorizonRows, HORIZON_METRICS),
    runs,
    violations,
    plannerFailures,
    // The key is *omitted* when the batch has no win counts — never written holding
    // `undefined` (unsurvivable JSON) and never as `[]` (which would claim victories
    // were counted while the engine has no victory condition).
    ...(input.batch.wins === undefined ? {} : { wins: input.batch.wins }),
  };
};

/* ------------------------------------------------------------------ *
 * The text renderer — formatting only
 * ------------------------------------------------------------------ */

/** `!` column width for the violation banner. Layout, not data. */
const BANNER_WIDTH = 80;

/** What a violating batch is called, singular and plural. */
const RUN_SUBJECT: readonly [string, string] = ['run', 'runs'];

const bannerRule = (): string => '!'.repeat(BANNER_WIDTH);

/**
 * The loud banner: which property broke, in which seed, on which turn.
 *
 * A violation is the one output that must not be missed, so it names itself, the run
 * and the turn, and it says plainly what the run did about it (the runner stops a
 * violating run on the turn that broke, so the final state *is* the broken state).
 */
const violationBannerLines = (
  subject: readonly [string, string],
  runs: number,
  violatingRuns: number,
  violations: readonly ReportedViolation[],
): readonly string[] => {
  const lines: string[] = [bannerRule()];
  lines.push(
    `!! ${String(violations.length)} INVARIANT ${violations.length === 1 ? 'VIOLATION' : 'VIOLATIONS'} ` +
      `in ${String(violatingRuns)} of ${String(runs)} ${runs === 1 ? subject[0] : subject[1]}`,
  );
  lines.push('!!');
  for (const violation of violations) {
    const where =
      violation.value === undefined
        ? `seed ${String(violation.seed)}, turn ${String(violation.turn)}`
        : `knob ${String(violation.value)}, seed ${String(violation.seed)}, turn ` +
          String(violation.turn);
    lines.push(`!!   ${where} — ${violation.invariant}`);
    lines.push(`!!     ${violation.message}`);
  }
  lines.push('!!');
  lines.push(
    '!! a run stops on the first turn that breaks a property, so the state it ended on IS',
  );
  lines.push('!! the state that broke; the same violations are in the --json report');
  lines.push(bannerRule());
  return lines;
};

/**
 * Where in a turn a planner failure happened, as one clause — and **only as much as is known**.
 *
 * The engine's record carries `phase` and `detail` whenever the policy could say where its throw
 * happened, which is every record the shipped AI writes (it tracks its own pass as it plans). They
 * are absent only on a record that reports less than it knows, and the honest rendering of that is
 * to say less: a placeholder such as `unknown pass` would read like a pass name and invite a reader
 * to believe the engine has a pass called that, which is exactly the "plausible claim about the AI"
 * this project treats as the worst outcome. So the clause shrinks, and both renderers — the stderr
 * warning and the text banner — call this one function so they cannot shrink differently.
 */
const plannerPassText = (failure: ReportedPlannerFailure): string => {
  if (failure.phase === undefined) {
    return failure.detail === undefined
      ? 'at an unrecorded point in the turn'
      : `at an unrecorded point in the turn (${failure.detail})`;
  }
  return failure.detail === undefined
    ? `in the ${failure.phase} pass`
    : `in the ${failure.phase} pass (${failure.detail})`;
};

/**
 * **The banner M7d added: a policy threw while planning, and the run is not clean evidence.**
 *
 * Modelled on `violationBannerLines` deliberately — same rule, same shape, same place in the
 * output — because the two are the same kind of fact: a run in this set is not what the report
 * otherwise implies it is. The differences are the ones that matter to a reader:
 *
 * - it says **which game** (the seed), because a planner failure is qualified per game exactly
 *   as a violation is, and "the AI threw" without a seed is not actionable in a batch of 500;
 * - it says the failure **does not stop the run**: a violating run ends on the turn that broke,
 *   so its numbers stop there, while a partial turn keeps playing — which is precisely why the
 *   metrics of such a game look plausible and why the record has to be printed rather than
 *   inferred from a short run;
 * - it names the pass, the player and the error, which are the engine's own fields — and the
 *   pass only when the record carries one: a record that cannot say where the throw happened
 *   prints what it knows rather than a placeholder that reads like a pass name (see
 *   `ReportedPlannerFailure`);
 * - and the turn it prints is the turn of **this** game's throw, because the runner files each
 *   run's own records (`@civts/sim`'s "Carrying a planner failure", H1/G2-1) — a reused policy
 *   instance's earlier turn is not this game's, and is not printed here.
 *
 * It is rendered from the report's `plannerFailures` — the structured value — never from the
 * policies, so the text and `--json` cannot disagree about what happened.
 */
const plannerFailureBannerLines = (
  subject: readonly [string, string],
  runs: number,
  failingRuns: number,
  failures: readonly ReportedPlannerFailure[],
): readonly string[] => {
  const lines: string[] = [bannerRule()];
  lines.push(
    `!! ${String(failures.length)} PLANNER ${failures.length === 1 ? 'FAILURE' : 'FAILURES'} ` +
      `in ${String(failingRuns)} of ${String(runs)} ${runs === 1 ? subject[0] : subject[1]}`,
  );
  lines.push('!!');
  for (const failure of failures) {
    const where =
      failure.value === undefined
        ? `seed ${String(failure.seed)}, turn ${String(failure.turn)}`
        : `knob ${String(failure.value)}, seed ${String(failure.seed)}, turn ` +
          String(failure.turn);
    lines.push(
      `!!   ${where} — ${failure.policy}, player ${String(failure.playerId)}, ` +
        plannerPassText(failure),
    );
    lines.push(`!!     ${failure.error}`);
  }
  lines.push('!!');
  lines.push(
    '!! a policy has no legitimate way to throw, so this is a defect in the AI, not a quiet',
  );
  lines.push(
    '!! turn: the commands decided before the throw were applied and the run continued, which',
  );
  lines.push(
    '!! is why its metrics look plausible. One line per seat that failed a planning pass —',
  );
  lines.push(
    '!! not one per turn — and a run taking part in a batch or a tournament FAILS (exit 1);',
  );
  lines.push('!! the same records are in the --json report, as "plannerFailures".');
  lines.push(bannerRule());
  return lines;
};

const padRight = (text: string, width: number): string => text.padEnd(width);

const metricWidth = MEASURED_METRIC_FIELDS.reduce(
  (width, metric) => Math.max(width, metric.length),
  0,
);

const meanText = (mean: number): string => mean.toFixed(2);

const aggregateLines = (aggregates: readonly MetricAggregate[]): readonly string[] => {
  const lines = [
    `  ${padRight('metric', metricWidth + 2)}${'count'.padStart(8)}${'sum'.padStart(10)}` +
      'mean'.padStart(10) +
      'median'.padStart(9) +
      'min'.padStart(9) +
      'max'.padStart(9),
  ];
  for (const aggregate of aggregates) {
    lines.push(
      `  ${padRight(aggregate.metric, metricWidth + 2)}${String(aggregate.count).padStart(8)}` +
        `${String(aggregate.sum).padStart(10)}${meanText(aggregate.mean).padStart(10)}` +
        `${String(aggregate.median).padStart(9)}${String(aggregate.min).padStart(9)}` +
        String(aggregate.max).padStart(9),
    );
  }
  return lines;
};

const horizonLines = (totals: readonly MetricTotal[]): readonly string[] => {
  const lines = [
    `  ${padRight('metric', metricWidth + 2)}${'rows'.padStart(6)}${'sum'.padStart(10)}${'mean'.padStart(10)}`,
  ];
  for (const total of totals) {
    lines.push(
      `  ${padRight(total.metric, metricWidth + 2)}${String(total.count).padStart(6)}` +
        `${String(total.sum).padStart(10)}${meanText(total.mean).padStart(10)}`,
    );
  }
  return lines;
};

/** One run's horizon total, by metric — a lookup of a stored value, never a sum. */
const horizonOf = (run: SimRunReport, metric: MeasuredMetricField): MetricTotal | undefined =>
  run.horizon.find((total) => total.metric === metric);

const runTableLines = (runs: readonly SimRunReport[]): readonly string[] => {
  const column = 12;
  const stopWidth = 13;
  // As wide as the widest ending label of this batch, so a long condition name cannot run into
  // the metrics beside it. Layout, not data: the label is composed from `run.outcome`'s fields.
  const outcomeWidth =
    runs.reduce((width, run) => Math.max(width, outcomeLabel(run.outcome).length), 0) + 2;
  // Header and rows are built from one width list, so a column can never drift away
  // from the value under it.
  const row = (
    seed: string,
    turns: string,
    stop: string,
    outcome: string,
    turn: string,
    cells: readonly string[],
    hash: string,
  ): string =>
    `  ${seed.padStart(6)} ${turns.padStart(5)}  ${padRight(stop, stopWidth)}` +
    `${padRight(outcome, outcomeWidth)}${turn.padStart(4)}  ` +
    `${cells.map((cell) => cell.padStart(column)).join('')}  ${hash}`;

  const lines = [
    row(
      'seed',
      'turns',
      'stop',
      'outcome',
      'turn',
      HORIZON_METRICS.map((metric) => metric),
      'final hash',
    ),
  ];
  for (const run of runs) {
    // A metric the run's stored horizon does not carry prints as `—`, never as a `0`
    // this renderer would have invented.
    const cells = HORIZON_METRICS.map((metric) => {
      const total = horizonOf(run, metric);
      return total === undefined ? '—' : String(total.sum);
    });
    lines.push(
      row(
        String(run.seed),
        String(run.turnsPlayed),
        run.stoppedBecause,
        outcomeLabel(run.outcome),
        String(run.finalTurn),
        cells,
        run.finalHash,
      ),
    );
  }
  return lines;
};

const rulesetLines = (ruleset: SimRulesetReport): readonly string[] => {
  const lines = [
    `ruleset     ${ruleset.fidelity} fidelity, hash ${ruleset.hash}, ` +
      `${String(ruleset.overrideCount)} override${ruleset.overrideCount === 1 ? '' : 's'}`,
  ];
  for (const note of ruleset.applied) lines.push(`  override  ${note}`);
  return lines;
};

/**
 * The text report: one line per stored field, in the order a reader asks the questions.
 *
 * The renderer performs no arithmetic over game numbers — no totals, no averages, no
 * deltas. It pads columns and formats stored means, and that is all it can do, which is
 * the point: a renderer that cannot compute cannot disagree with the engine.
 */
export const renderSimReport = (report: SimReport): string => {
  const lines: string[] = [];

  if (report.violations.length > 0) {
    lines.push(
      ...violationBannerLines(
        RUN_SUBJECT,
        report.totals.runs,
        report.totals.violatingRuns,
        report.violations,
      ),
    );
    lines.push('');
  }

  // M7d: the same treatment for a planner failure, from the report's own field. A reader of
  // the *text* report sees it too — the stderr warning is not the only evidence any more, and
  // a `--json` consumer is not the only reader who needs to know.
  if (report.plannerFailures.length > 0) {
    lines.push(
      ...plannerFailureBannerLines(
        RUN_SUBJECT,
        report.totals.runs,
        report.totals.plannerFailingRuns,
        report.plannerFailures,
      ),
    );
    lines.push('');
  }

  lines.push(
    `civts sim — ${String(report.totals.runs)} ${report.totals.runs === 1 ? 'game' : 'games'} in one batch`,
    '',
    `seeds       ${report.parameters.seedSpec} (${String(report.parameters.seeds.length)} runs, ascending)`,
    `settings    ${report.parameters.mapSize} ${String(report.parameters.width)}x` +
      `${String(report.parameters.height)}, ${String(report.parameters.civCount)} civs, ` +
      `${String(report.parameters.maxTurns)} turns max, sampleEvery ` +
      String(report.parameters.sampleEvery),
    `policy      ${report.parameters.policy}`,
    ...rulesetLines(report.ruleset),
    `totals      ${String(report.totals.runs)} ${plural(report.totals.runs, 'run')}, ` +
      `${String(report.totals.turnsPlayed)} ${plural(report.totals.turnsPlayed, 'turn')} played, ` +
      `${String(report.totals.metricRows)} metric ${plural(report.totals.metricRows, 'row')}, ` +
      `${String(report.invariants.checks)} invariant ${plural(report.invariants.checks, 'check')}`,
    '',
    'per-metric aggregates (every sampled turn of every run, every civilization):',
    ...aggregateLines(report.aggregates),
    '',
    `horizon (the last sampled turn of each run: ${String(report.totals.horizonTurnMin)}..` +
      `${String(report.totals.horizonTurnMax)}), summed over every run and civilization:`,
    ...horizonLines(report.horizonTotals),
  );

  if (report.totals.horizonVaries) {
    lines.push(
      '  note: runs stopped on different turns, so these sums mix horizons — the runs table ' +
        "below names each run's own turn",
    );
  }

  lines.push('', 'runs (ascending seed):', ...runTableLines(report.runs), '');

  lines.push(
    `invariants  ${String(report.invariants.count)} named predicates, ` +
      `${String(report.invariants.checks)} checks, ${String(report.invariants.violations)} violations`,
  );
  lines.push(`  checked: ${report.invariants.names.join(', ')}`);
  // The second half of the pass condition, on its own line and always printed — a reader must
  // not have to notice an *absence* of a banner to know the AI played every turn.
  lines.push(
    `planners    ${
      report.plannerFailures.length === 0
        ? 'no planner failures — every turn of every run was decided by its policy'
        : `${String(report.plannerFailures.length)} ` +
          `${report.plannerFailures.length === 1 ? 'failure' : 'failures'} in ` +
          `${String(report.totals.plannerFailingRuns)} of ${String(report.totals.runs)} ` +
          `${plural(report.totals.runs, 'run')} — the AI did not play part of those games`
    }`,
  );

  // The batch's own census of endings, when any run reached a condition: one line per condition,
  // printing the winners the row carries (P1) rather than a single one of them. A condition that
  // ended game(s) level says so, and `batch.test.ts` asserts the two figures add up to the count.
  if (report.wins !== undefined) {
    for (const win of report.wins) {
      const winners = win.byPlayer
        .map((row) => `player ${String(row.playerId)} ${String(row.wins)}`)
        .join(', ');
      const drawn = win.draws === 0 ? '' : `, ${String(win.draws)} drawn`;
      lines.push(
        `  wins: ${win.outcome} ${String(win.count)}${winners === '' ? '' : ` (${winners})`}${drawn}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
};

/**
 * The banner alone, for the `--json` path: the machine-readable report is on stdout and
 * the shout goes to stderr, so a pipeline that parses stdout still sees the warning.
 */
export const renderViolationBanner = (report: SimReport): string =>
  report.violations.length === 0
    ? ''
    : `${violationBannerLines(RUN_SUBJECT, report.totals.runs, report.totals.violatingRuns, report.violations).join('\n')}\n`;

/* ------------------------------------------------------------------ *
 * The `sim` command
 * ------------------------------------------------------------------ */

export interface SimCommandOutput {
  readonly report: SimReport | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The seam that makes the `sim` command's failure channel *testable end to end*, and nothing
 * else — the same seam, for the same reason, as `TournamentCommandOptions` documents at length
 * (a warning nobody can trigger from a test is a warning nobody can keep honest, and the shipped
 * AI only throws on a board the engine would never build). It changes no default: an absent map,
 * the empty map and `undefined` all resolve to `policyOf(name)`, and it is deliberately not a
 * CLI flag.
 */
export interface SimCommandOptions {
  /** A policy in place of the shipped one named by `--policy`, for tests that inject a fault. */
  readonly policyOverrides?: ReadonlyMap<string, Policy>;
}

/**
 * `civts sim …`, with no I/O: the caller writes `stdout`/`stderr` and exits `exitCode`.
 *
 * Returning the text rather than printing it is what makes the command testable in
 * process (and what keeps the "one source of truth" rule true end to end): the report
 * builder cannot print, and the printer cannot compute.
 */
export const runSimCommand = (
  args: readonly string[],
  options: SimCommandOptions = {},
): Result<SimCommandOutput, SimCommandFailure> => {
  if (args.includes('-h') || args.includes('--help')) {
    return ok({ report: undefined, stdout: SIM_USAGE, stderr: '', exitCode: 0 });
  }

  const flags = parseSimArgs(args);
  if (!flags.ok) return err(failure(2, [`error: ${flags.error}`], SIM_USAGE));

  // `--override` is parsed before anything runs: a typo in one flag should not cost a
  // batch of games, and the message names the assignment that was actually typed.
  const assignments: OverrideAssignment[] = [];
  for (const text of flags.value.overrides) {
    const parsed = parseOverride(text);
    if (!parsed.ok) return err(failure(2, [`error: ${parsed.error}`], SIM_USAGE));
    assignments.push(parsed.value);
  }
  const patch = buildRulesetPatch(assignments);
  if (!patch.ok) return err(failure(2, [`error: ${patch.error}`], SIM_USAGE));

  const layer: Record<string, unknown> = {};
  if (flags.value.mapSize !== undefined) layer['mapSize'] = flags.value.mapSize;
  if (flags.value.civCount !== undefined) layer['civCount'] = flags.value.civCount;

  const settings = loadSettings(layer);
  if (!settings.ok) {
    return err(
      failure(
        2,
        settings.error.map((issue) => `settings error: ${formatSettingsIssue(issue)}`),
        SIM_USAGE,
      ),
    );
  }

  const overridden = tryApplyOverrides(CATALOG, patch.value);
  if (!overridden.ok)
    return err(failure(2, [overrideFailureLine(assignments, overridden.error)], SIM_USAGE));

  const validated = validateRuleset(overridden.value.catalog, settings.value.fidelity);
  if (!validated.ok) {
    return err(
      failure(
        1,
        validated.error.map((e) => `ruleset error: ${formatRulesetError(e)}`),
        undefined,
      ),
    );
  }

  const seeds = flags.value.seeds ?? defaultSeeds();
  const seedSpec = flags.value.seedSpec ?? DEFAULT_SEED_SPEC;
  const maxTurns = flags.value.turns ?? DEFAULT_TURNS;
  const sampleEvery = flags.value.sampleEvery ?? DEFAULT_SAMPLE_EVERY;
  const policyName = flags.value.policy ?? 'simple';
  const policy = options.policyOverrides?.get(policyName) ?? policyOf(policyName);
  const invariants: readonly Invariant[] = [
    ...CORE_INVARIANTS,
    ...flags.value.faults.map((name) => faultInvariant(name)),
  ];

  const parameters: SimParameters = {
    mapSize: settings.value.mapSize,
    width: MAP_DIMENSIONS[settings.value.mapSize].width,
    height: MAP_DIMENSIONS[settings.value.mapSize].height,
    civCount: settings.value.civCount,
    maxTurns,
    policy: policy.name,
    sampleEvery,
    seedSpec,
    seeds,
  };

  // One instance per invocation, shared by every seat of every run in the batch — that is what
  // `civPolicies` means, and `policyOf` above is where the instance is built, with the reasoning.
  // Since M7d a policy carries the typed record of any throw it caught while planning and that
  // record is cumulative for the instance, which is exactly why `runSimulation` takes a baseline
  // before its first turn: the report has to say what happened *in this run*. Nothing reads the
  // policies after the batch — the evidence is the report's own `plannerFailures` field.
  const batchPolicies = civPolicies(policy, settings.value.civCount);

  let batch: BatchResult;
  try {
    batch = runBatch({
      seeds,
      settings: settings.value,
      ruleset: validated.value,
      policies: batchPolicies,
      maxTurns,
      sampleEvery,
      invariants,
    });
  } catch (cause) {
    return err(failure(1, [`error: ${messageOf(cause)}`], undefined));
  }

  const report = buildSimReport({
    batch,
    parameters,
    ruleset: {
      fidelity: validated.value.fidelity,
      hash: hashValue(overridden.value.catalog),
      overrideCount: overridden.value.applied.length,
      applied: overridden.value.applied,
      patch: patch.value,
    },
    invariantNames: invariants.map((invariant) => invariant.name),
  });

  const json = flags.value.json;
  // The warnings go to stderr on BOTH paths — a result that is parsed by a pipeline is
  // exactly the one nobody would otherwise read a warning above. See
  // `plannerFailureWarning` for why a caught planner error needs one at all, and note that
  // since M7d it is no longer the only evidence: the same records are a field of the report
  // (and a banner in its text form), and they fail the batch's exit code.
  return ok({
    report,
    stdout: json ? `${canonicalize(report)}\n` : renderSimReport(report),
    stderr: `${json ? renderViolationBanner(report) : ''}${plannerFailureWarning(report.plannerFailures)}`,
    exitCode: report.exitCode,
  });
};

/**
 * `1 run` / `2 runs`: a count with its noun in the right number.
 *
 * Formatting, not data — the count itself is always the report's field, and this only
 * decides whether the line reads like English.
 */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`);

/** The default seed set. Parsed rather than written as a literal list, so it stays one fact. */
const defaultSeeds = (): readonly number[] => parseDefaultSeedSpec(DEFAULT_SEED_SPEC);

const parseDefaultSeedSpec = (spec: string): readonly number[] => {
  const parsed = parseSeedSpec(spec);
  if (!parsed.ok)
    throw new Error(`the CLI's own default seed spec "${spec}" is unusable: ${parsed.error}`);
  return parsed.value;
};

/**
 * One policy per civilization.
 *
 * The shipped policies are **stateless** — `chooseCommands` reads the state it is given
 * and its own RNG stream, and holds nothing between calls — so one instance can serve
 * every player, and swapping it mid-batch is impossible. If a future policy keeps
 * state, it must be constructed per player here rather than shared.
 */
const civPolicies = (policy: Policy, civCount: number): readonly Policy[] =>
  Array.from({ length: civCount }, () => policy);

/**
 * **A planner that threw, said out loud on stderr.**
 *
 * `SMART_POLICY` catches a thrown planner error, records it, and returns the commands it had
 * decided before the throw — which is the right contract (a policy that throws takes a
 * twenty-seed tournament down with it) but leaves a turn that is *indistinguishable from a
 * turn in which the AI had nothing to say*: same legal command list, same metrics, same
 * invariants, same plausible hash. M7c gave that record a type and a reader; **M7d wired it
 * into the results**, so this warning is no longer the only evidence, and this function is no
 * longer the only reader.
 *
 * It takes the **report's own `plannerFailures`** — the structured value's field, already
 * qualified with the seed of each game — rather than re-asking the policies. That is the M2
 * rule applied to a warning: a renderer that reads a second source can disagree with the
 * report it is printed beside, and the failure mode would be a warning on a green report or,
 * far worse, a clean-looking report whose warning was computed from a policy the run never
 * used.
 *
 * The lines go to **stderr**, on both paths — text and `--json` — because a result a pipeline
 * parses is exactly the result nobody would otherwise read a warning above. The report itself
 * carries the same records (a banner in the text report, `plannerFailures` in the JSON), and
 * the run's exit code is now part of the verdict: a failed planner makes the run fail.
 */
export const plannerFailureWarning = (failures: readonly ReportedPlannerFailure[]): string => {
  const lines = failures.map((failure) => {
    const where =
      failure.value === undefined
        ? `in game ${String(failure.seed)}`
        : `in the run at knob ${String(failure.value)}, game ${String(failure.seed)}`;
    return (
      `${where}, ${failure.policy} threw while planning on turn ${String(failure.turn)} for ` +
      `player ${String(failure.playerId)}, ${plannerPassText(failure)}: ` +
      `${failure.error} — it returned the commands decided before the throw, so the run ` +
      'continued and its numbers describe a game in which part of a turn was not played'
    );
  });
  if (lines.length === 0) return '';
  return [
    'WARNING: the policy reported a planner failure — this run is not a clean one.',
    ...lines,
    '',
  ].join('\n');
};

/** The `--override` line for a patch the catalog refused, naming what was typed. */
const overrideFailureLine = (
  assignments: readonly OverrideAssignment[],
  error: OverrideError,
): string => {
  // An `unknown-section` complaint names no row (there is no section to have a row in),
  // so it is matched on the section alone; every other kind carries an id.
  const culprit = assignments.find(
    (a) =>
      a.section === error.section &&
      (error.kind === 'unknown-section' || a.id === error.id) &&
      (error.kind !== 'unknown-field' || a.field === error.field),
  );
  const what = culprit === undefined ? 'the override' : `--override ${culprit.text}`;
  return `error: ${what}: ${formatOverrideError(error)}`;
};

/* ------------------------------------------------------------------ *
 * `tournament` — the same policies across seeds, with the seats rotated
 *
 * The M7 contract's second CLI command, built the way `sim` is built and for the same
 * reason: a structured value (`TournamentReport`, which embeds `@civts/sim`'s own
 * `TournamentResult` rather than restating it), a text renderer that only formats it, and
 * `--json` for `canonicalize` of that same value. No figure in this section is computed by
 * the renderer: the renderer pads columns, prints stored numbers, and nothing else.
 * ------------------------------------------------------------------ */

/**
 * The seeds a tournament plays when `--seeds` is absent: **two games**.
 *
 * ## Why the default is small, and what the large run costs
 *
 * The M7 command shipped with A3's twenty-seed experiment as its default, which made
 * `civts run` — the plainest verb this CLI has, and one that used to print "the M7 self-play
 * harness is not built yet" — start a **multi-minute** job (its measured cost is recorded once,
 * in `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE`, and printed into this command's `--help` from
 * there; see `A3_TOURNAMENT_TURNS`). A default is what happens when nobody decided
 * anything, so the thing it does by accident has to be cheap and *stated*: two games is
 * seconds, and two games is also the shortest experiment whose seat rotation completes with
 * the default two seats (`seatPlan`: over `n` games every one of `n` policies plays every
 * seat). A one-game default would report a rotation that had not happened.
 *
 * A3's experiment is asked for **explicitly** — it is not gone, it is no longer implicit:
 *
 * ```
 *   civts tournament --seeds 1..20 --turns 100
 *   pnpm tournament:evidence        # the same run, with the structured result and wall time
 * ```
 *
 * The flags and the report are the same either way: the report always states the seed spec and
 * the horizon it used, so a two-game smoke run can never be mistaken for the twenty-seed one.
 */
export const DEFAULT_TOURNAMENT_SEED_SPEC = '1..2';

/**
 * Turns per game when `--turns` is absent: **ten**.
 *
 * A smoke horizon, not a full game. It is enough for the real AI to settle, put its first
 * cities to work and open its research — the machinery the command exists to drive — and it is
 * short enough that the default run finishes in seconds, which is the property that matters
 * for a default. A run that measures *strategy* wants a full arc and says so with `--turns`;
 * see `A3_TOURNAMENT_TURNS`, which is the horizon the milestone's evidence uses.
 */
export const DEFAULT_TOURNAMENT_TURNS = 10;

/**
 * A3's seed set: the twenty seeds the alpha acceptance line names.
 *
 * Exported, and printed in `--help`, so that "the large run must be asked for" is a *stated*
 * requirement rather than a missing default: a reader who wants the evidence run is told the
 * exact flags, and `scripts/tournament-evidence.ts` runs precisely this.
 */
export const A3_TOURNAMENT_SEED_SPEC = '1..20';

/**
 * A3's horizon: a hundred turns.
 *
 * A tournament is about a *game*, not a probe: the AI has to settle, expand, research, build
 * and fight, and a horizon too short to reach those measures the opening instead of the
 * strategy. A hundred turns is a complete arc at this engine's scale — the real policy has
 * founded its cities, worked its land, finished its early tech tree and fielded an army well
 * inside it. It is expensive, which is exactly why it is not the default: what A3's twenty
 * seeds cost at this horizon — per game, for the whole run, against the bound they are judged
 * against, with the headroom left under it — is recorded **once**, in `@civts/sim`'s
 * `A3_TOURNAMENT_EVIDENCE`, and this file prints that record into `--help` rather than restating
 * a figure that the next improvement to the AI would invalidate (which it did twice; the bound
 * and its own reasoning are on `DEFAULT_TOURNAMENT_BUDGET_MS`). Two hundred turns is affordable
 * too, at roughly twice the cost per game; `--turns` moves the horizon, and the report always
 * states the one it used, so two runs cannot be compared by accident.
 */
export const A3_TOURNAMENT_TURNS = 100;

/**
 * The seat list when `--seats` is absent: the real AI in **every** seat.
 *
 * That is a self-play tournament, which is what M7 asks this command to be and what
 * "replacing `SIMPLE_POLICY` as the default in tournaments" means. `--seats smart,none`
 * is the comparison against the do-nothing control, and `--seats simple,none` the older
 * placeholder — all three names are in `SIM_POLICIES`, so the flags and the help text
 * cannot disagree about what a policy is called.
 */
const DEFAULT_TOURNAMENT_SEAT = 'smart' as const;

export const TOURNAMENT_USAGE = `usage: civts tournament [--seeds <spec>] [--seats <name,...>]
                            [--map-size <size>] [--civs <int>] [--turns <int>]
                            [--budget-ms <int>]
                            [--override <section>.<id>.<field>=<value>]...
                            [--fault <name>]... [--json]

  --seeds <spec>      which games to play: a list, ranges, or both — "1..2", "3", "1,4,7"
                      (default ${DEFAULT_TOURNAMENT_SEED_SPEC}; ascending; a seed listed twice is played
                      twice, and the two plays are different seatings)
  --seats <list>      the policy for each seat, left to right: "smart,none", or
                      "smart,smart" for self-play (a policy may repeat). Each name is one of
                      ${SIM_POLICIES.join('|')} (default: ${DEFAULT_TOURNAMENT_SEAT} in every seat)
  --map-size <size>   one of ${MAP_SIZES.join('|')} (default tiny)
  --civs <int>        civilizations per game — which is also the number of seats (default 2)
  --turns <int>       turns to play per game, at least 1 (default ${String(DEFAULT_TOURNAMENT_TURNS)})
  --budget-ms <int>   the budget the whole run is judged against, in milliseconds
                      (default ${String(DEFAULT_TOURNAMENT_BUDGET_MS)}). A run that exceeds it SAYS SO and still plays
                      every seed: the seed set is never trimmed to fit a budget
  --override <p>=<v>  change ONE catalog number for the whole tournament, repeatable — the
                      same flag "civts sim" takes, through the same override machinery
  --fault <name>      append a deliberately failing invariant named <name>: a self-test of
                      the violation path, so the pass/fail condition can be watched firing
                      end to end. It changes nothing about the game. Repeatable.
  --json              print one canonical JSON report (recursively sorted keys) instead of
                      the text report. Every field is a pure function of the flags except
                      two: the measured elapsed time, and — when a run is over budget — the
                      amount it is over by, which is derived from it. Those two are the
                      harness's own measurement, and nothing about a game depends on them

THE DEFAULT RUN IS SMALL ON PURPOSE: ${DEFAULT_TOURNAMENT_SEED_SPEC} is two games of
${String(DEFAULT_TOURNAMENT_TURNS)} turns — seconds, not minutes — because "run" and "tournament" are the same
command and a plain invocation must not start an experiment nobody asked for. A3's experiment,
the twenty seeds of a hundred turns the acceptance line names, is therefore asked for
EXPLICITLY:

  civts tournament --seeds ${A3_TOURNAMENT_SEED_SPEC} --turns ${String(A3_TOURNAMENT_TURNS)}
  pnpm tournament:evidence        the same run, printing the structured result and wall time

Its cost is recorded once, in \`@civts/sim\`'s \`A3_TOURNAMENT_EVIDENCE\` — the measured figures
and the bound they are judged against, so this text cannot go stale on its own and neither can
any other site that quotes it:

  ${A3_TOURNAMENT_EVIDENCE.summary}

Both are the same command; only the horizon differs, and the report always states the one it
used, so a smoke run cannot be mistaken for the evidence run.

Seats ROTATE. In game i, seat s is played by seat-list entry (s + i) mod seats, so over
enough games every policy plays every seat, and no strategy is ever measured from one
position only. A policy that only wins from seat 0 has not been tested; this command cannot
be asked to test it that way.

Exit codes:
  0  every game held every invariant, no policy threw while planning, and the run was
     within budget
  1  a game broke an invariant — ZERO violations AND zero planner failures is the pass
     condition, not a statistic;
     the violation is printed loudly, naming itself, its seed and its turn — or a policy
     threw while planning, which is counted the same way as an invariant violation
     because a game the AI walked out of is not a measurement of the AI. The failure is
     printed loudly too, naming the game, the turn and the pass, and it is in the
     --json report as "plannerFailures"
  2  the flags themselves are unusable (syntax, an unknown policy, a seat list that does
     not match the number of civilizations, a bad number)
  3  every invariant held, but the run took longer than the budget it was given
`;

/** Flags as parsed — absent means "leave the default alone", not "zero". */
export interface TournamentFlags {
  readonly seeds: readonly number[] | undefined;
  /** The seed spec as typed, so the report can quote what was asked for. */
  readonly seedSpec: string | undefined;
  /** The policy per seat, left to right, as `--seats` named them. */
  readonly seats: readonly SimPolicyName[] | undefined;
  readonly mapSize: MapSize | undefined;
  readonly civCount: number | undefined;
  readonly turns: number | undefined;
  readonly budgetMs: number | undefined;
  readonly overrides: readonly string[];
  readonly faults: readonly string[];
  readonly json: boolean;
}

const TOURNAMENT_VALUE_FLAGS: readonly string[] = [
  '--seeds',
  '--seats',
  '--map-size',
  '--civs',
  '--turns',
  '--budget-ms',
  '--override',
  '--fault',
];

/**
 * One `--seats` value: a comma-separated list of policy names, in seat order.
 *
 * Parsed here rather than inside the command so a typo costs no games — the same rule
 * `--override` follows. An empty entry is refused instead of skipped: `--seats smart,,none`
 * is a typo, and quietly dropping the empty one would seat a policy the caller did not name.
 */
const parseSeatList = (raw: string): Result<readonly SimPolicyName[], string> => {
  const names: SimPolicyName[] = [];
  for (const entry of raw.split(',')) {
    const name = entry.trim();
    if (name === '') {
      return err(
        `--seats has an empty entry in "${raw}" — it takes one policy name per seat, like ` +
          `"smart,${SIM_POLICIES[1]}"`,
      );
    }
    const known = SIM_POLICIES.find((candidate) => candidate === name);
    if (known === undefined) {
      return err(
        `--seats expects a comma-separated list of ${SIM_POLICIES.join('|')}, got "${name}"`,
      );
    }
    names.push(known);
  }
  return ok(names);
};

export const parseTournamentArgs = (args: readonly string[]): Result<TournamentFlags, string> => {
  let seeds: readonly number[] | undefined;
  let seedSpec: string | undefined;
  let seats: readonly SimPolicyName[] | undefined;
  let mapSize: MapSize | undefined;
  let civCount: number | undefined;
  let turns: number | undefined;
  let budgetMs: number | undefined;
  let json = false;
  const overrides: string[] = [];
  const faults: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined) break;

    if (flag === '--json') {
      json = true;
      continue;
    }
    if (!TOURNAMENT_VALUE_FLAGS.includes(flag)) {
      return err(`unknown option for the tournament: "${flag}"`);
    }

    const raw = args[i + 1];
    if (raw === undefined) return err(`${flag} needs a value`);
    i += 1; // consume the value

    switch (flag) {
      case '--seeds': {
        const parsed = parseSeedSpec(raw);
        if (!parsed.ok) return parsed;
        seeds = parsed.value;
        seedSpec = raw.trim();
        break;
      }
      case '--seats': {
        const parsed = parseSeatList(raw);
        if (!parsed.ok) return parsed;
        seats = parsed.value;
        break;
      }
      case '--map-size': {
        const size = MAP_SIZES.find((candidate) => candidate === raw);
        if (size === undefined) {
          return err(`--map-size expects one of ${MAP_SIZES.join('|')}, got "${raw}"`);
        }
        mapSize = size;
        break;
      }
      case '--turns':
      case '--civs':
      case '--budget-ms': {
        const parsed = parseIntFlag(flag, raw);
        if (!parsed.ok) return err(parsed.error);
        if (flag === '--turns') turns = parsed.value;
        else if (flag === '--civs') civCount = parsed.value;
        else budgetMs = parsed.value;
        break;
      }
      case '--override':
        overrides.push(raw);
        break;
      case '--fault': {
        const name = raw.trim();
        if (!FAULT_NAME.test(name)) {
          return err(
            `--fault expects a kebab-case invariant name (like "gold-conservation"), got "${raw}"`,
          );
        }
        faults.push(name);
        break;
      }
      default:
        return err(`unknown option for the tournament: "${flag}"`);
    }
  }

  if (turns !== undefined && turns < 1) {
    return err(
      `--turns must be at least 1, got ${String(turns)} (a tournament of zero turns measures nothing)`,
    );
  }
  if (budgetMs !== undefined && budgetMs < 0) {
    return err(
      `--budget-ms must be zero or more, got ${String(budgetMs)} (a negative budget is a ` +
        'verdict no run can satisfy)',
    );
  }

  return ok({
    seeds,
    seedSpec,
    seats,
    mapSize,
    civCount,
    turns,
    budgetMs,
    overrides,
    faults,
    json,
  });
};

/* ---- the structured report ---- */

/** The experiment the tournament report describes. */
export interface TournamentParameters {
  readonly mapSize: string;
  readonly width: number;
  readonly height: number;
  readonly civCount: number;
  readonly maxTurns: number;
  /** The policy names by seat, left to right — the list the rotation permutes. */
  readonly seats: readonly string[];
  /** The seed spec as typed (`1..2` by default, `1..20` for A3's run), for the report's own provenance. */
  readonly seedSpec: string;
  /** The seeds actually played, ascending. */
  readonly seeds: readonly number[];
}

/**
 * Who won a game, and the seat — and the policy — they won it from.
 *
 * Carried by **both** reports the CLI produces: the tournament's games and the batch's runs
 * (`civt` sim). The two differ in how a seat is filled — a tournament rotates a policy list
 * across seats, a batch seats one policy in every chair — and not in what a winner is, so there
 * is one type and one builder (`gameOutcomeReport`) rather than two that could disagree.
 *
 * **`playerId` and `seat` are the same number in this engine, and both are carried on
 * purpose.** `PlayerId` *is* the index into `state.players` (the M3 invariant `explored` and
 * every per-player array depend on), barbarians are appended after the civilizations, and
 * `civPlayers` decides that only a civilization may win — so a winner's id is always a seat of
 * the rotation. They are kept apart because "player 1 won" and "seat 1 won" are different
 * claims to a reader of a tournament report: the rotation is indexed by seat, and a report that
 * printed only the engine id would leave a reader to work out that the two coincide.
 * `seatPolicy` is the fact the seat total cannot tell you — **which policy sat there in this
 * game**, which is what makes "seat 1 won 8 of 20" a statement about a position rather than
 * about a strategy.
 */
export interface GameWinnerReport {
  /** The winning civilization's `PlayerId`. */
  readonly playerId: number;
  /** The seat that player was — its position in the rotation. */
  readonly seat: number;
  /** The policy that played that seat **in this game**, as the seats column labels it. */
  readonly seatPolicy: string;
}

/**
 * **How one game ended** — the field the tournament report was missing.
 *
 * The report carried `stoppedBecause` and nothing else, so a run could prove games *ended*
 * (`'game-over'`) while being unable to name the condition that ended them or the winner. A3
 * requires "at least one victory condition demonstrated ending a real game", and an ending
 * nobody can name is not a demonstration — which is what the alpha audit measured.
 *
 * The shape is **derived from the engine's own `GameOutcome`** (`SimulationResult.outcome`,
 * which `runner.ts` reads from `gameOutcomeOf`) and never recomputed here: `condition`, `kind`,
 * `turn` and the winner are the engine's values, and the only work done here is resolving the
 * winner's seat to the policy label the rotation put there. A second implementation of the
 * victory rule in a *report* is exactly the disagreement this project keeps hunting.
 *
 * Absence is spelled as a union arm rather than as a `null`-holding key: `ended: false` is "no
 * outcome — the run stopped before any condition held", which is the ordinary end of a
 * turn-limited run, and the row still names the engine's stop reason beside it. `text` is a
 * stored sentence so that no renderer has to compose one.
 */
export type GameOutcomeReport =
  | {
      readonly ended: true;
      /**
       * The engine's own reading: `victory` when a player won, `draw` when the game was level.
       *
       * Typed as the engine's `GameOutcome['kind']` rather than narrowed to the two the runner
       * writes, because `defeat` is a **viewer's** word (`outcomeFor` answers it for a player who
       * is watching, and a run has no seat) — so narrowing here would be a second statement of
       * which values a run's outcome can take. `runner.ts` states that rule where it builds the
       * value.
       */
      readonly kind: GameOutcome['kind'];
      readonly condition: VictoryConditionId;
      /** The turn the condition first held — the engine's `outcome.turn`. */
      readonly turn: number;
      /** The winner and their seat; **absent** for a draw, which has no winner. */
      readonly winner?: GameWinnerReport;
      /** One line naming the ending, for a text renderer and for `--json` readers alike. */
      readonly text: string;
    }
  | {
      readonly ended: false;
      /** One line saying so, naming the stop reason and the horizon that was reached. */
      readonly text: string;
    };

/** One game's summary, with the seating the rotation gave it. */
export interface TournamentGameReport {
  readonly seed: number;
  /** The policy playing each seat of **this** game — the rotation, spelled out. */
  readonly seats: readonly string[];
  readonly turnsPlayed: number;
  readonly stoppedBecause: StopReason;
  /**
   * **What ended this game, or that nothing did** — read from the engine's own outcome.
   *
   * Required and always present, in both arms: a game in which no condition held carries
   * `ended: false` and says so, rather than leaving a reader to infer it from a missing key.
   */
  readonly outcome: GameOutcomeReport;
  readonly finalHash: string;
  readonly metricRows: number;
  readonly violations: readonly ReportedViolation[];
  /**
   * Planner failures this game reported, qualified with its seed — required and always present.
   *
   * This is the field that answers "which game?" for a tournament-level failure, which is why
   * the records travel per game as well as flat: M7d's acceptance line is that a tournament
   * containing one "says which game, turn and phase failed".
   */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
}

/** The budget, and the verdict on it — stored, so the renderer prints rather than decides. */
export interface TournamentBudgetReport {
  readonly budgetMs: number;
  readonly elapsedMs: number;
  readonly withinBudget: boolean;
  /** `max(0, elapsedMs - budgetMs)`: how far over, or `0`. */
  readonly overByMs: number;
  /** One line, with no figure in it: the numbers are the fields above. */
  readonly verdict: string;
}

/** The pass/fail condition and the budget's verdict, as one value. */
export interface TournamentVerdictReport {
  /**
   * The pass/fail condition: zero invariant violations **and** zero planner failures.
   *
   * M7d widened it deliberately. A policy is required to be total, so a game in which the
   * planner threw is not a weak measurement of the AI — it is not a measurement of it — and A3
   * claims the AI plays a **complete** game unaided. `@civts/sim`'s `tournamentVerdict` is where
   * the condition is computed, once; this report only carries its answer.
   */
  readonly passed: boolean;
  readonly withinBudget: boolean;
  /** `passed && withinBudget` — what A3's evidence needs. */
  readonly accepted: boolean;
  readonly games: number;
  readonly violations: number;
  readonly violatingGames: number;
  /** Planner failures across the tournament, counted like a violation (M7d). */
  readonly plannerFailures: number;
  /** How many games had at least one planner failure. */
  readonly gamesWithPlannerFailures: number;
  /** One line naming both verdicts, for the report's last line. */
  readonly summary: string;
}

/** One seat's figures: its horizon totals, and the aggregates over all of its rows. */
export interface TournamentSeatReport {
  readonly seat: number;
  readonly games: number;
  readonly policies: readonly string[];
  /** `HORIZON_METRICS` summed over this seat's final sampled rows, one per game. */
  readonly horizon: readonly MetricTotal[];
  /** Every measured metric over every sampled row of this seat (from the engine's totals). */
  readonly aggregates: readonly MetricAggregate[];
}

/** One policy's figures, across every seat it played. */
export interface TournamentPolicyReport {
  readonly policy: string;
  readonly policyIndex: number;
  /**
   * What to print for this policy: its name, plus `#index` when the seat list names the
   * same policy twice.
   *
   * A seat list may repeat a policy — `--seats smart,smart` is a self-play tournament — and
   * two *tuned* instances of one policy share a name (`smartPolicy({...})` is named
   * `smart`), so `smart` and `smart` would otherwise print as two identical rows and a
   * weight comparison would look like a bug. The label is built here rather than by the
   * renderer, because a report's labels are part of the structured value like its figures.
   */
  readonly label: string;
  readonly games: number;
  /** Games played in each seat, indexed by seat. */
  readonly seatGames: readonly number[];
  readonly horizon: readonly MetricTotal[];
  readonly aggregates: readonly MetricAggregate[];
}

/**
 * The whole tournament report — the one value the text renderer and `--json` both read.
 *
 * `totals` is `@civts/sim`'s own `TournamentTotals`, embedded rather than restated: the
 * per-seat and per-policy aggregates in this report *are* the engine's, not a second
 * opinion about them. That includes **`totals.outcomes`** (P1) — the census of what ended
 * each game, wins by seat included — which is counted once, in the engine-adjacent package,
 * from each run's own engine-read outcome, so the text block below the games table and a
 * `--json` consumer cannot disagree about it.
 */
export interface TournamentReport {
  readonly kind: 'civts-tournament-report';
  readonly reportVersion: number;
  /**
   * `planner-failures` is M7d's own value, and it exists because the two defects need
   * different work: `violations` says the engine or a policy broke a stated property, while
   * `planner-failures` says the AI stopped playing mid-turn and the games it "played" are not
   * evidence about it. Both exit 1 — a planner failure is *counted like a violation* — and a
   * pipeline that wants them apart reads this field, which is what a machine-readable status
   * is for. A run that is over budget *and* failed reports the failure first, as before.
   */
  readonly status: 'ok' | 'violations' | 'planner-failures' | 'over-budget';
  readonly exitCode: number;
  readonly parameters: TournamentParameters;
  readonly ruleset: SimRulesetReport;
  readonly budget: TournamentBudgetReport;
  readonly verdict: TournamentVerdictReport;
  readonly invariants: SimInvariantReport;
  readonly totals: TournamentTotals;
  readonly seats: readonly TournamentSeatReport[];
  readonly policies: readonly TournamentPolicyReport[];
  /** Every game, ascending by seed. */
  readonly games: readonly TournamentGameReport[];
  /** Every violation in the tournament, ascending by seed then turn. */
  readonly violations: readonly ReportedViolation[];
  /**
   * Every planner failure in the tournament, in game order — `@civts/sim`'s own aggregate
   * (`TournamentResult.plannerFailures`), qualified with each game's seed. Never filtered,
   * capped or averaged, for the same reason `violations` is not.
   */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
}

/**
 * The version of the tournament report's shape.
 *
 * - 1 — M7b/M7d: the parameters, the ruleset, the budget, the verdict, the totals, the seats,
 *   the policies, the games, the violations and the planner failures.
 * - 2 — **P1: the outcome census.** Each `games[]` row gains `outcome` (the condition, the
 *   winner, the seat and the policy that played it, or an explicit "no outcome"), and
 *   `totals.outcomes` gains the distribution — counts by condition with zeros included, the
 *   no-outcome count, wins by seat and the engine's stop reasons. Bumped because a consumer
 *   parsing version 1 would read a games table in which "how did this game end?" is
 *   unanswerable, and a version number that did not move would let it do so silently.
 */
export const TOURNAMENT_REPORT_VERSION = 2;

/**
 * What a tournament's unit of work is called in the violation banner.
 *
 * A tournament plays **games**, not runs: the batch command's banner ("in 3 of 20 runs")
 * is right for `sim` and would be wrong here, and one word is cheaper than a reader
 * wondering whether "runs" means the same thing in the two reports.
 */
const TOURNAMENT_SUBJECT: readonly [string, string] = ['game', 'games'];

/** One game's horizon rows for one seat: the last sampled turn, that civilization only. */
const seatHorizonRows = (game: SimulationResult, seat: number): readonly TurnMetrics[] =>
  horizonRows(game).filter((row) => Number(row.playerId) === seat);

/** The seat-list entry a policy index names, or a thrown message about an impossible plan. */
const seatNameOf = (names: readonly string[], index: number): string => {
  const name = names[index];
  if (name === undefined) {
    throw new Error(
      `internal: the seat rotation named seat-list entry ${String(index)} of ` +
        `${String(names.length)}, which the rotation cannot produce`,
    );
  }
  return name;
};

/**
 * What to print for each policy of a seat list: the name, and `#index` when the list names
 * one policy more than once (see `TournamentPolicyReport.label`).
 */
const policyLabels = (names: readonly string[]): readonly string[] =>
  names.map((name, index) =>
    names.filter((candidate) => candidate === name).length > 1 ? `${name} #${String(index)}` : name,
  );

export interface TournamentReportInput {
  readonly result: TournamentResult;
  readonly parameters: TournamentParameters;
  readonly ruleset: SimRulesetReport;
  readonly invariantNames: readonly string[];
}

/**
 * One game's outcome, read from the engine's own value.
 *
 * **This function decides nothing about victory.** `condition`, `kind`, `turn` and the winner
 * are `SimulationResult.outcome` — the runner's read of `gameOutcomeOf`, which is the one
 * statement of the victory rule (`core/victory.ts`). The only work done here is *naming*: the
 * winner's seat, and the policy the rotation put in it, so a report can say "seat 1, smart #1"
 * without a reader having to consult the seat plan, and one English sentence per game so that
 * no renderer composes one.
 *
 * A game with no outcome is spelled `ended: false` and says which engine reason stopped it and
 * after how many turns — the honest "no outcome, the run reached its horizon" that a
 * turn-limited run must report rather than an inferred absence.
 *
 * An absent arm is impossible by construction: `seatPlan` seats every policy in every game, so
 * a winner the plan does not seat is thrown as an internal error rather than printed as a game
 * that somehow ended without a position to end it from.
 */
const gameOutcomeReport = (
  game: SimulationResult,
  seatsInGame: readonly number[],
  labels: readonly string[],
): GameOutcomeReport => {
  const outcome = game.outcome;

  if (outcome === undefined) {
    return {
      ended: false,
      text:
        `no outcome — the run stopped at ${game.stoppedBecause} after ` +
        `${String(game.turnsPlayed)} ${plural(game.turnsPlayed, 'turn')} with the game still in play`,
    };
  }

  const winnerSeat = outcome.winner;
  if (winnerSeat === null) {
    return {
      ended: true,
      kind: outcome.kind,
      condition: outcome.condition,
      turn: outcome.turn,
      text:
        `${outcome.condition} — the game ended level on turn ${String(outcome.turn)}: ` +
        'the condition held and named no winner',
    };
  }

  const playerId = Number(winnerSeat);
  const policyIndex = seatsInGame[playerId];
  if (policyIndex === undefined) {
    throw new Error(
      `internal: seed ${String(game.seed)} reported winner ${String(playerId)}, which is not one ` +
        `of the ${String(seatsInGame.length)} seats the rotation seats`,
    );
  }
  const seatPolicy = seatNameOf(labels, policyIndex);

  return {
    ended: true,
    kind: outcome.kind,
    condition: outcome.condition,
    turn: outcome.turn,
    winner: { playerId, seat: playerId, seatPolicy },
    text:
      `${outcome.condition} — player ${String(playerId)} won on turn ${String(outcome.turn)}, ` +
      `from seat ${String(playerId)} (${seatPolicy})`,
  };
};

/**
 * Turn a tournament result into the report. **Every figure the text prints is computed
 * here** (or is a field of the engine's result), and the renderer below only formats.
 *
 * The horizon is `sim`'s own definition — the last sampled turn of a game, read by the same
 * `horizonRows` helper the batch and the sweep use — so "by turn N" means the same thing in
 * all three reports. The full per-metric aggregates travel in `totals`; the text leads with
 * the horizon because that is the figure a balance decision reads first, and a reader who
 * wants all sixteen columns has `--json`.
 */
export const buildTournamentReport = (input: TournamentReportInput): TournamentReport => {
  const result = input.result;
  const names = input.parameters.seats;
  const plan = seatPlan(names.length, result.games.length);
  // What each policy is called in this report — see `TournamentPolicyReport.label`.
  const labels = policyLabels(names);

  const games: readonly TournamentGameReport[] = result.games.map((game, index) => {
    const seatsInGame = plan[index];
    if (seatsInGame === undefined) {
      throw new Error(
        `internal: the seat plan has no entry for game ${String(index)} of ${String(result.games.length)}`,
      );
    }
    return {
      seed: game.seed,
      seats: seatsInGame.map((policyIndex) => seatNameOf(labels, policyIndex)),
      turnsPlayed: game.turnsPlayed,
      stoppedBecause: game.stoppedBecause,
      // The engine's own outcome, with the winner's seat resolved to the policy that played it.
      // Read, never re-derived — see `gameOutcomeReport`.
      outcome: gameOutcomeReport(game, seatsInGame, labels),
      finalHash: game.finalHash,
      metricRows: game.metrics.length,
      violations: reportedViolations(game.seed, game.violations),
      plannerFailures: reportedPlannerFailures(game.seed, game.plannerFailures),
    };
  });

  const seats: readonly TournamentSeatReport[] = result.totals.seats.map((totals) => ({
    seat: totals.seat,
    games: totals.games,
    policies: totals.policies,
    horizon: metricTotals(
      result.games.flatMap((game) => seatHorizonRows(game, totals.seat)),
      HORIZON_METRICS,
    ),
    aggregates: totals.aggregates,
  }));

  const policies: readonly TournamentPolicyReport[] = result.totals.policies.map((totals) => ({
    policy: totals.policy,
    policyIndex: totals.policyIndex,
    label: seatNameOf(labels, totals.policyIndex),
    games: totals.games,
    seatGames: totals.seatGames,
    horizon: metricTotals(
      result.games.flatMap((game, index) => {
        const seatsInGame = plan[index];
        if (seatsInGame === undefined) {
          throw new Error(
            `internal: the seat plan has no entry for game ${String(index)} of ${String(result.games.length)}`,
          );
        }
        const seat = seatsInGame.indexOf(totals.policyIndex);
        if (seat < 0) {
          throw new Error(
            `internal: policy ${String(totals.policyIndex)} is seated nowhere in game ${String(index)}`,
          );
        }
        return seatHorizonRows(game, seat);
      }),
      HORIZON_METRICS,
    ),
    aggregates: totals.aggregates,
  }));

  const violations = games.flatMap((game) => game.violations);
  const plannerFailures = games.flatMap((game) => game.plannerFailures);
  const verdict = tournamentVerdict(result);
  const invariantCount = input.invariantNames.length;
  // Counted, never derived — the same rule the batch report follows, and for the same reason:
  // a tournament of decided games is where the old product was wrong by the most.
  const checks = result.games.reduce((total, game) => total + game.invariantChecks, 0);

  const invariantSentence =
    verdict.violations === 0
      ? `every invariant held in all ${String(verdict.games)} ${plural(verdict.games, 'game')}`
      : `${String(verdict.violations)} invariant ${plural(verdict.violations, 'violation')} in ` +
        `${String(verdict.violatingGames)} of ${String(verdict.games)} games — a tournament that ` +
        'mostly holds its invariants has found a bug';
  // M7d's half of the pass condition, stated in the verdict's own sentence as well as in the
  // boolean: a reader of the last line must not have to notice an absence to know the AI played.
  const plannerSentence =
    verdict.plannerFailures === 0
      ? 'no planner failures — every turn of every game was decided by its policy'
      : `${String(verdict.plannerFailures)} planner ` +
        `${plural(verdict.plannerFailures, 'failure')} in ` +
        `${String(verdict.gamesWithPlannerFailures)} of ${String(verdict.games)} games — the ` +
        'policy threw while planning, and a policy has no legitimate way to throw, so those ' +
        'games are not measurements of the AI';
  const budgetSentence = verdict.withinBudget
    ? 'within budget'
    : 'OVER BUDGET, with every seed still played';

  const status: TournamentReport['status'] =
    verdict.violations > 0
      ? 'violations'
      : verdict.plannerFailures > 0
        ? 'planner-failures'
        : verdict.withinBudget
          ? 'ok'
          : 'over-budget';

  return {
    kind: 'civts-tournament-report',
    reportVersion: TOURNAMENT_REPORT_VERSION,
    status,
    // A broken invariant is a defect, an overrun is a slow run, and a planner failure is a
    // defect in the AI: they exit differently so that a pipeline can tell them apart, and a
    // run that is over budget *and* broken reports the defect. A planner failure shares exit
    // 1 with a violation because M7d counts it like one — either way this tournament is not
    // evidence — and the two are distinguished by `status` and by which field is non-empty.
    exitCode: status === 'over-budget' ? 3 : status === 'ok' ? 0 : 1,
    parameters: input.parameters,
    ruleset: input.ruleset,
    budget: {
      budgetMs: result.budgetMs,
      elapsedMs: result.elapsedMs,
      withinBudget: result.withinBudget,
      overByMs: Math.max(0, result.elapsedMs - result.budgetMs),
      verdict: result.withinBudget
        ? 'within budget'
        : 'OVER BUDGET — every seed of the stated set was still played (the seed set is never trimmed to fit)',
    },
    verdict: {
      passed: verdict.passed,
      withinBudget: verdict.withinBudget,
      accepted: verdict.accepted,
      games: verdict.games,
      violations: verdict.violations,
      violatingGames: verdict.violatingGames,
      plannerFailures: verdict.plannerFailures,
      gamesWithPlannerFailures: verdict.gamesWithPlannerFailures,
      summary: `${invariantSentence}; ${plannerSentence}; ${budgetSentence}`,
    },
    invariants: {
      names: input.invariantNames,
      count: invariantCount,
      checks,
      violations: violations.length,
    },
    totals: result.totals,
    seats,
    policies,
    games,
    violations,
    plannerFailures,
  };
};

/* ---- the text renderer ---- */

/** One group of the tables below: a heading, then the stored horizon totals under it. */
const tournamentGroupLines = (
  heading: string,
  horizon: readonly MetricTotal[],
): readonly string[] => [heading, ...horizonLines(horizon)];

const tournamentGameLines = (games: readonly TournamentGameReport[]): readonly string[] => {
  const seatsWidth = games.reduce(
    (width, game) => Math.max(width, game.seats.join(', ').length),
    0,
  );
  // The outcome column is as wide as the widest label this report has, so a long condition name
  // cannot run into the hash beside it. Layout, not data — the label itself is composed from
  // fields of `game.outcome`.
  const outcomeWidth =
    games.reduce((width, game) => Math.max(width, outcomeLabel(game.outcome).length), 0) + 2;
  // Header and rows are built from one width list, so a column can never drift away from
  // the value under it.
  const header =
    `  ${padRight('seed', 6)}${padRight('seats', seatsWidth + 2)}${padRight('turns', 7)}` +
    `${padRight('stop', 13)}${padRight('outcome', outcomeWidth)}${padRight('rows', 6)}final hash`;
  const lines = [header];
  for (const game of games) {
    lines.push(
      `  ${padRight(String(game.seed), 6)}${padRight(game.seats.join(', '), seatsWidth + 2)}` +
        `${padRight(String(game.turnsPlayed), 7)}${padRight(game.stoppedBecause, 13)}` +
        padRight(outcomeLabel(game.outcome), outcomeWidth) +
        `${padRight(String(game.metricRows), 6)}${game.finalHash}`,
    );
  }
  return lines;
};

/**
 * The short label the games table prints for one game's outcome.
 *
 * Composed from the stored fields (`condition`, the winner's `seat`) and nothing else — no
 * figure here is derived, and the long sentence a reader wants is `outcome.text`, which travels
 * verbatim in `--json`. A game that never ended says so in words rather than leaving a blank.
 */
const outcomeLabel = (outcome: GameOutcomeReport): string => {
  if (!outcome.ended) return 'no outcome';
  return outcome.winner === undefined
    ? `${outcome.condition} (level)`
    : `${outcome.condition} seat ${String(outcome.winner.seat)}`;
};

/**
 * The outcome census, printed from the report's own field — every figure below is a counted
 * value of `report.totals.outcomes`, and this function performs no arithmetic on any of them.
 *
 * It exists because the timings and the pass/fail verdict are both silent about *how* a
 * tournament ended: a run in which all twenty games ended the same way, or in which one seat won
 * every one of them, reads exactly like a healthy mix. The distribution is where those two
 * questions — which conditions actually fire, and whether a seat is an advantage — are answered
 * by counts rather than by impression, and the zeros are printed deliberately: a condition that
 * never fired is a finding, not an absence.
 */
const tournamentOutcomeLines = (outcomes: TournamentOutcomeDistribution): readonly string[] => {
  const lines: string[] = [
    '',
    `outcomes    ${String(outcomes.endedGames)} of ${String(outcomes.games)} ` +
      `${plural(outcomes.games, 'game')} ended by a victory condition, ` +
      `${String(outcomes.noOutcomeGames)} with no outcome; counted once, in @civts/sim's ` +
      "totals.outcomes, from each game's own engine-read outcome:",
    `  ${padRight('condition', 14)}${padRight('games', 7)}${padRight('wins', 6)}draws`,
  ];

  for (const row of outcomes.conditions) {
    lines.push(
      `  ${padRight(row.condition, 14)}${padRight(String(row.games), 7)}` +
        `${padRight(String(row.wins), 6)}${String(row.draws)}`,
    );
  }
  lines.push(
    `  ${padRight('no outcome', 14)}${padRight(String(outcomes.noOutcomeGames), 7)}` +
      `${padRight('0', 6)}0`,
  );

  lines.push('  wins by seat — the position, not the strategy:');
  for (const seat of outcomes.seats) {
    lines.push(
      `    seat ${String(seat.seat)} — ${String(seat.wins)} of ${String(seat.games)} ` +
        `${plural(seat.games, 'game')} won; played by ${seat.policies.join(', ')}`,
    );
  }

  lines.push('  stop reasons — why each game left the loop:');
  for (const reason of outcomes.stopReasons) {
    lines.push(`    ${padRight(reason.stoppedBecause, 14)}${String(reason.games)}`);
  }

  // The sentence is emitted **only** when the data says it: a run with one ending says nothing
  // about the conditions being unreachable, and a report that always carried the line would be
  // claiming a finding it had not measured.
  if (outcomes.games > 0 && outcomes.noOutcomeGames === outcomes.games) {
    lines.push(
      '  FINDING       every game in this run reached its horizon and none ended by a victory',
      '                condition, so this run is evidence that no condition can be reached here',
      '                (at this horizon and this catalog) — a finding, not a table of outcomes',
    );
  }

  return lines;
};

/**
 * The text tournament report: one line per stored field.
 *
 * The renderer performs no arithmetic over game numbers — no totals, no averages, no
 * deltas — and it prints no figure the structured value does not carry. The budget line is
 * the one place a number is *formatted* (`elapsedMs.toFixed(1)`, exactly as the batch
 * report formats a stored mean) and the verdict lines are stored strings, so this function
 * cannot disagree with the value it was handed.
 */
export const renderTournamentReport = (report: TournamentReport): string => {
  const lines: string[] = [];

  if (report.violations.length > 0) {
    lines.push(
      ...violationBannerLines(
        TOURNAMENT_SUBJECT,
        report.totals.games,
        report.verdict.violatingGames,
        report.violations,
      ),
      '',
    );
  }

  // M7d: the tournament's own failure banner, from the report's field, so a reader of the text
  // report learns which game failed without parsing anything.
  if (report.plannerFailures.length > 0) {
    lines.push(
      ...plannerFailureBannerLines(
        TOURNAMENT_SUBJECT,
        report.totals.games,
        report.verdict.gamesWithPlannerFailures,
        report.plannerFailures,
      ),
      '',
    );
  }

  // The label column is as wide as the widest label this report has, so a long policy name
  // cannot run into the figure beside it. Layout, not data.
  const labelWidth =
    report.policies.reduce((width, policy) => Math.max(width, policy.label.length), 0) + 2;

  lines.push(
    `civts tournament — ${String(report.totals.games)} ` +
      `${plural(report.totals.games, 'game')}, ${String(report.parameters.civCount)} seats, ` +
      report.policies.map((policy) => policy.label).join(' vs '),
    '',
    `seeds       ${report.parameters.seedSpec} (${String(report.parameters.seeds.length)} games, ascending)`,
    `settings    ${report.parameters.mapSize} ${String(report.parameters.width)}x` +
      `${String(report.parameters.height)}, ${String(report.parameters.civCount)} civs, ` +
      `${String(report.parameters.maxTurns)} turns max`,
    `seats       ${report.parameters.seats.join(', ')} — rotated one seat per game, so every ` +
      'policy plays every seat over enough games',
    ...rulesetLines(report.ruleset),
    `totals      ${String(report.totals.turnsPlayed)} ` +
      `${plural(report.totals.turnsPlayed, 'turn')} played, ` +
      `${String(report.totals.metricRows)} metric ${plural(report.totals.metricRows, 'row')}, ` +
      `${String(report.invariants.checks)} invariant ${plural(report.invariants.checks, 'check')}`,
    '',
    `budget      ${String(report.budget.budgetMs)}ms stated, ` +
      `${report.budget.elapsedMs.toFixed(1)}ms elapsed — ${report.budget.verdict}`,
  );

  if (!report.budget.withinBudget) {
    lines.push(`            over by ${report.budget.overByMs.toFixed(1)}ms`);
  }

  lines.push('', `per seat — at the horizon (the last sampled turn of each game):`);
  for (const seat of report.seats) {
    lines.push(
      ...tournamentGroupLines(
        `  seat ${String(seat.seat)} — ${String(seat.games)} ${plural(seat.games, 'game')}, played by ` +
          `${seat.policies.join(', ')}:`,
        seat.horizon,
      ),
    );
  }

  lines.push('', 'per policy — at the horizon, in every seat it played:');
  for (const policy of report.policies) {
    lines.push(
      ...tournamentGroupLines(
        `  ${padRight(policy.label, labelWidth)}${String(policy.games)} ` +
          `${plural(policy.games, 'game')}, seats ${policy.seatGames.join('/')}` +
          ' (games per seat, by seat):',
        policy.horizon,
      ),
    );
  }

  lines.push('', 'games (ascending seed, with the policy each seat was played by):');
  lines.push(...tournamentGameLines(report.games));
  lines.push(...tournamentOutcomeLines(report.totals.outcomes));

  lines.push(
    '',
    `invariants  ${String(report.invariants.count)} named predicates, ` +
      `${String(report.invariants.checks)} checks, ${String(report.invariants.violations)} violations`,
    `  checked: ${report.invariants.names.join(', ')}`,
    // M7d's count, on its own line and always printed — the other half of the pass condition.
    `planners    ${String(report.verdict.plannerFailures)} planner ` +
      `${plural(report.verdict.plannerFailures, 'failure')} in ` +
      `${String(report.verdict.gamesWithPlannerFailures)} of ${String(report.totals.games)} ` +
      plural(report.totals.games, 'game'),
    '',
    `verdict     ${report.verdict.summary}`,
  );

  return `${lines.join('\n')}\n`;
};

/** The banner alone, for the `--json` path: the report on stdout, the shout on stderr. */
export const renderTournamentBanner = (report: TournamentReport): string =>
  report.violations.length === 0
    ? ''
    : `${violationBannerLines(
        TOURNAMENT_SUBJECT,
        report.totals.games,
        report.verdict.violatingGames,
        report.violations,
      ).join('\n')}\n`;

/* ---- the command ---- */

export interface TournamentCommandOutput {
  readonly report: TournamentReport | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** The default seat list: the real AI in every seat. */
const defaultSeats = (civCount: number): readonly SimPolicyName[] =>
  Array.from({ length: civCount }, () => DEFAULT_TOURNAMENT_SEAT);

/**
 * `civts tournament …`, with no I/O: the caller writes `stdout`/`stderr` and exits
 * `exitCode`, exactly as `runSimCommand` is wired.
 *
 * It shares the `sim` command's override machinery, its fault injection and its report
 * discipline, so a catalog number overridden here means what it means there, and the
 * tournament cannot grow a second set of rules about what a knob is.
 */
/**
 * The seam that makes the failure channel *testable end to end*, and nothing else.
 *
 * A warning nobody can trigger from a test is a warning nobody can keep honest: the shipped
 * policy only throws on a state the engine would never build, and the fault cannot be injected
 * from outside this module. So `policyOverrides` lets a test hand this command a policy that
 * throws — a defective AI, if you like — and lets it exercise the whole path: the run, the
 * recorded failure, the warning on stderr and the exit code beside it. It changes no default:
 * an absent map, the empty map and `undefined` all resolve to `policyOf(name)`.
 *
 * It is deliberately *not* a CLI flag. A user-facing way to swap a policy in from a string is a
 * second seat-name mechanism, and `SIM_POLICIES` already exists.
 */
export interface TournamentCommandOptions {
  /** Policies by seat name, in place of the shipped ones — for tests that inject a fault. */
  readonly policyOverrides?: ReadonlyMap<string, Policy>;
}

export const runTournamentCommand = (
  args: readonly string[],
  options: TournamentCommandOptions = {},
): Result<TournamentCommandOutput, SimCommandFailure> => {
  if (args.includes('-h') || args.includes('--help')) {
    return ok({ report: undefined, stdout: TOURNAMENT_USAGE, stderr: '', exitCode: 0 });
  }

  const flags = parseTournamentArgs(args);
  if (!flags.ok) return err(failure(2, [`error: ${flags.error}`], TOURNAMENT_USAGE));

  const assignments: OverrideAssignment[] = [];
  for (const text of flags.value.overrides) {
    const parsed = parseOverride(text);
    if (!parsed.ok) return err(failure(2, [`error: ${parsed.error}`], TOURNAMENT_USAGE));
    assignments.push(parsed.value);
  }
  const patch = buildRulesetPatch(assignments);
  if (!patch.ok) return err(failure(2, [`error: ${patch.error}`], TOURNAMENT_USAGE));

  const layer: Record<string, unknown> = {};
  if (flags.value.mapSize !== undefined) layer['mapSize'] = flags.value.mapSize;
  if (flags.value.civCount !== undefined) layer['civCount'] = flags.value.civCount;

  const settings = loadSettings(layer);
  if (!settings.ok) {
    return err(
      failure(
        2,
        settings.error.map((issue) => `settings error: ${formatSettingsIssue(issue)}`),
        TOURNAMENT_USAGE,
      ),
    );
  }

  const seatNames = flags.value.seats ?? defaultSeats(settings.value.civCount);
  if (seatNames.length !== settings.value.civCount) {
    return err(
      failure(
        2,
        [
          `error: --seats names ${String(seatNames.length)} ` +
            `${seatNames.length === 1 ? 'policy' : 'policies'} (${seatNames.join(', ')}) but the game has ` +
            `${String(settings.value.civCount)} civilizations — every seat needs exactly one ` +
            'policy, and a policy may repeat (--seats smart,smart)',
        ],
        TOURNAMENT_USAGE,
      ),
    );
  }

  const overridden = tryApplyOverrides(CATALOG, patch.value);
  if (!overridden.ok)
    return err(failure(2, [overrideFailureLine(assignments, overridden.error)], TOURNAMENT_USAGE));

  const validated = validateRuleset(overridden.value.catalog, settings.value.fidelity);
  if (!validated.ok) {
    return err(
      failure(
        1,
        validated.error.map((e) => `ruleset error: ${formatRulesetError(e)}`),
        undefined,
      ),
    );
  }

  const seeds = flags.value.seeds ?? parseDefaultSeedSpec(DEFAULT_TOURNAMENT_SEED_SPEC);
  const seedSpec = flags.value.seedSpec ?? DEFAULT_TOURNAMENT_SEED_SPEC;
  const maxTurns = flags.value.turns ?? DEFAULT_TOURNAMENT_TURNS;
  const invariants: readonly Invariant[] = [
    ...CORE_INVARIANTS,
    ...flags.value.faults.map((name) => faultInvariant(name)),
  ];

  const parameters: TournamentParameters = {
    mapSize: settings.value.mapSize,
    width: MAP_DIMENSIONS[settings.value.mapSize].width,
    height: MAP_DIMENSIONS[settings.value.mapSize].height,
    civCount: settings.value.civCount,
    maxTurns,
    seats: seatNames.map((name) => policyOf(name).name),
    seedSpec,
    seeds,
  };

  // One instance per seat, one instance per invocation, held here rather than built inline at
  // the call: since M7d a policy carries the typed record of any throw it caught while planning,
  // the record is cumulative for the instance, and the report has to be able to say what
  // happened *in this tournament*. `policyOf` above is where that instance is built, with the
  // reasoning; `options.policyOverrides` is the test seam (the shipped AI only throws on a board
  // the engine would never build, so a failure path no test can trigger is a path nobody keeps
  // honest).
  const seatPolicies = seatNames.map(
    (name) => options.policyOverrides?.get(name) ?? policyOf(name),
  );

  let result: TournamentResult;
  try {
    result = runTournament(
      {
        seeds,
        settings: settings.value,
        ruleset: validated.value,
        policies: seatPolicies,
        maxTurns,
        ...(flags.value.budgetMs === undefined ? {} : { budgetMs: flags.value.budgetMs }),
      },
      // The registry is handed to the harness, not to the frozen options: `--fault` is a
      // self-test of *this command's* violation path, and the pass/fail condition is what
      // it exists to exercise.
      { invariants },
    );
  } catch (cause) {
    return err(failure(1, [`error: ${messageOf(cause)}`], undefined));
  }

  const report = buildTournamentReport({
    result,
    parameters,
    ruleset: {
      fidelity: validated.value.fidelity,
      hash: hashValue(overridden.value.catalog),
      overrideCount: overridden.value.applied.length,
      applied: overridden.value.applied,
      patch: patch.value,
    },
    invariantNames: invariants.map((invariant) => invariant.name),
  });

  const json = flags.value.json;
  // On stderr on both paths, for the reason `plannerFailureWarning` states: a run whose games
  // are a hash of partly-unplayed turns is not one a reader should have to ask about. Since
  // M7d it is no longer the only evidence — the same records are `plannerFailures` in the
  // report (and a banner in its text form) and they set the exit code.
  return ok({
    report,
    stdout: json ? `${canonicalize(report)}\n` : renderTournamentReport(report),
    stderr: `${json ? renderTournamentBanner(report) : ''}${plannerFailureWarning(report.plannerFailures)}`,
    exitCode: report.exitCode,
  });
};

/* ------------------------------------------------------------------ *
 * The balance sweep
 * ------------------------------------------------------------------ */

/**
 * The default experiment a sweep command runs when its flags say nothing.
 *
 * It is a parameter rather than a constant in this file because the *experiment* is
 * the caller's: `scripts/balance-sweep.ts` names the knob it wants to demonstrate, the
 * grid it wants to sweep and the batch it wants to sweep it on, and this module only
 * knows how to run one.
 */
export interface SweepCommandDefaults {
  /** The dotted patch path swept when `--knob` is absent: `units.settler.cost`. */
  readonly knob: string;
  /** The values swept when `--values` is absent (ascending, unique). */
  readonly values: readonly number[];
  /** The seed spec used when `--seeds` is absent. */
  readonly seedSpec: string;
  /** Turns per game when `--turns` is absent. */
  readonly turns: number;
}

/** The catalog row a knob addresses, with the shipped value read out of it. */
export interface SweepKnob {
  readonly field: string;
  readonly section: OverrideSection;
  readonly id: string;
  readonly setting: string;
  readonly shipped: number;
  readonly provenanceKind: 'cited' | 'placeholder';
  readonly provenanceDetail: string;
}

export interface SweepFlags {
  readonly knob: string | undefined;
  readonly values: readonly number[] | undefined;
  readonly seeds: readonly number[] | undefined;
  readonly seedSpec: string | undefined;
  readonly mapSize: MapSize | undefined;
  readonly civCount: number | undefined;
  readonly turns: number | undefined;
  readonly policy: SimPolicyName | undefined;
  readonly sampleEvery: number | undefined;
  readonly json: boolean;
}

const SWEEP_VALUE_FLAGS: readonly string[] = [
  '--knob',
  '--values',
  '--seeds',
  '--map-size',
  '--civs',
  '--turns',
  '--policy',
  '--sample-every',
];

export const parseSweepArgs = (args: readonly string[]): Result<SweepFlags, string> => {
  let knob: string | undefined;
  let values: readonly number[] | undefined;
  let seeds: readonly number[] | undefined;
  let seedSpec: string | undefined;
  let mapSize: MapSize | undefined;
  let civCount: number | undefined;
  let turns: number | undefined;
  let policy: SimPolicyName | undefined;
  let sampleEvery: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined) break;

    if (flag === '--json') {
      json = true;
      continue;
    }
    if (!SWEEP_VALUE_FLAGS.includes(flag)) return err(`unknown option for the sweep: "${flag}"`);

    const raw = args[i + 1];
    if (raw === undefined) return err(`${flag} needs a value`);
    i += 1;

    switch (flag) {
      case '--knob':
        knob = raw.trim();
        break;
      case '--values': {
        const parsed = parseIntegerSpec(raw, '--values', MAX_SWEEP_VALUES);
        if (!parsed.ok) return parsed;
        values = [...new Set(parsed.value)].sort((a, b) => a - b);
        break;
      }
      case '--seeds': {
        const parsed = parseSeedSpec(raw);
        if (!parsed.ok) return parsed;
        seeds = parsed.value;
        seedSpec = raw.trim();
        break;
      }
      case '--map-size': {
        const size = MAP_SIZES.find((candidate) => candidate === raw);
        if (size === undefined) {
          return err(`--map-size expects one of ${MAP_SIZES.join('|')}, got "${raw}"`);
        }
        mapSize = size;
        break;
      }
      case '--policy': {
        const name = SIM_POLICIES.find((candidate) => candidate === raw);
        if (name === undefined) {
          return err(`--policy expects one of ${SIM_POLICIES.join('|')}, got "${raw}"`);
        }
        policy = name;
        break;
      }
      case '--turns':
      case '--civs':
      case '--sample-every': {
        const parsed = parseIntFlag(flag, raw);
        if (!parsed.ok) return err(parsed.error);
        if (flag === '--turns') turns = parsed.value;
        else if (flag === '--civs') civCount = parsed.value;
        else sampleEvery = parsed.value;
        break;
      }
      default:
        return err(`unknown option for the sweep: "${flag}"`);
    }
  }

  if (turns !== undefined && turns < 1) {
    return err(`--turns must be at least 1, got ${String(turns)}`);
  }
  if (sampleEvery !== undefined && sampleEvery < 1) {
    return err(`--sample-every must be at least 1, got ${String(sampleEvery)}`);
  }
  return ok({ knob, values, seeds, seedSpec, mapSize, civCount, turns, policy, sampleEvery, json });
};

/** One numeric field of one catalog row, read out of the catalog. */
const readNumeric = (
  catalog: Catalog,
  section: OverrideSection,
  id: string,
  field: string,
): Result<number, string> => {
  const unknown = (known: readonly string[]): Result<number, string> =>
    err(`${section}.${id} is not a catalog row (known ids: ${known.join(', ')})`);
  const notNumeric = (): Result<number, string> =>
    err(`${section}.${id}.${field} is not a number this sweep can read`);

  switch (section) {
    case 'units': {
      const row = catalog.units.find((candidate) => String(candidate.id) === id);
      if (row === undefined) return unknown(catalog.units.map((candidate) => String(candidate.id)));
      switch (field) {
        case 'attack':
          return ok(row.attack);
        case 'defense':
          return ok(row.defense);
        case 'movement':
          return ok(row.movement);
        case 'cost':
          return ok(row.cost);
        case 'hitPoints':
          // The engine's own reader, so the number this sweep reports as "shipped" is the
          // number a battle would use: `fullHitPoints` is what `maxHitPointsOf` applies to
          // a live unit, and it treats a row that declares nothing as 1.
          return ok(fullHitPoints(row));
        default:
          return notNumeric();
      }
    }
    case 'buildings': {
      const row = catalog.buildings.find((candidate) => String(candidate.id) === id);
      if (row === undefined)
        return unknown(catalog.buildings.map((candidate) => String(candidate.id)));
      switch (field) {
        case 'cost':
          return ok(row.cost);
        case 'maintenance':
          return ok(row.maintenance);
        default:
          return notNumeric();
      }
    }
    case 'terrains': {
      const row = catalog.terrains.find((candidate) => String(candidate.id) === id);
      if (row === undefined)
        return unknown(catalog.terrains.map((candidate) => String(candidate.id)));
      switch (field) {
        case 'moveCost':
          return ok(row.moveCost);
        case 'defenseBonusPct':
          return ok(row.defenseBonusPct);
        case 'defenseBonus':
          // M6's spelling of the same magnitude, read through the reader the engine uses
          // so the two names cannot report different numbers.
          return ok(terrainDefenseBonus(row));
        case 'yields.food':
          return ok(row.yields.food);
        case 'yields.shields':
          return ok(row.yields.shields);
        case 'yields.commerce':
          return ok(row.yields.commerce);
        default:
          return notNumeric();
      }
    }
    case 'improvements': {
      const row = catalog.improvements.find((candidate) => String(candidate.id) === id);
      if (row === undefined) {
        return unknown(catalog.improvements.map((candidate) => String(candidate.id)));
      }
      switch (field) {
        case 'turns':
          return ok(row.turns);
        case 'yields.food':
          return ok(row.yields.food);
        case 'yields.shields':
          return ok(row.yields.shields);
        case 'yields.commerce':
          return ok(row.yields.commerce);
        default:
          return notNumeric();
      }
    }
    case 'resources': {
      const row = catalog.resources.find((candidate) => String(candidate.id) === id);
      if (row === undefined)
        return unknown(catalog.resources.map((candidate) => String(candidate.id)));
      switch (field) {
        case 'yields.food':
          return ok(row.yields.food);
        case 'yields.shields':
          return ok(row.yields.shields);
        case 'yields.commerce':
          return ok(row.yields.commerce);
        default:
          return notNumeric();
      }
    }
    case 'combat': {
      // The one section that is a row rather than a list of rows: its id is its own name,
      // and its fields are the nine magnitudes. `readKnob` is what makes
      // `--knob combat.wallsBonusPct` sweepable at all, and the shipped value it reports
      // comes from here — out of the catalog, never from a literal in this file.
      if (id !== COMBAT_ROW_ID) return unknown([COMBAT_ROW_ID]);
      switch (field) {
        case 'fortifyBonusPct':
          return ok(catalog.combat.fortifyBonusPct);
        case 'cityDefenseBonusPct':
          return ok(catalog.combat.cityDefenseBonusPct);
        case 'wallsBonusPct':
          return ok(catalog.combat.wallsBonusPct);
        case 'veteranAttackPct':
          return ok(catalog.combat.veteranAttackPct);
        case 'maxExperience':
          return ok(catalog.combat.maxExperience);
        case 'rollBound':
          return ok(catalog.combat.rollBound);
        case 'damagePerRound':
          return ok(catalog.combat.damagePerRound);
        case 'minWinPct':
          return ok(catalog.combat.minWinPct);
        case 'maxWinPct':
          return ok(catalog.combat.maxWinPct);
        default:
          return notNumeric();
      }
    }
    case 'capture': {
      // M7's singleton, addressed the same way the combat globals are: no row id beyond
      // the section's own name, and the shipped value read *out of the catalog* so a
      // `--knob capture.populationDivisor` sweep can never restate the number.
      if (id !== CAPTURE_ROW_ID) return unknown([CAPTURE_ROW_ID]);
      switch (field) {
        case 'populationDivisor':
          return ok(catalog.capture.populationDivisor);
        default:
          return notNumeric();
      }
    }
    // M9: the government rows are a *row* section, so the field is a plain name and the
    // value comes out of the row — including the three caps, which are spelled
    // `rateCaps.<slider>` because that is how the row nests them.
    case 'governments': {
      const row = catalog.governments.find((candidate) => String(candidate.id) === id);
      if (row === undefined) {
        return unknown(catalog.governments.map((candidate) => String(candidate.id)));
      }
      switch (field) {
        case 'rateCaps.tax':
          return ok(row.rateCaps.tax);
        case 'rateCaps.science':
          return ok(row.rateCaps.science);
        case 'rateCaps.luxury':
          return ok(row.rateCaps.luxury);
        case 'freeUnitsPerCity':
          return ok(row.freeUnitsPerCity);
        case 'unitSupportCost':
          return ok(row.unitSupportCost);
        case 'happinessModifier':
          return ok(row.happinessModifier);
        default:
          return notNumeric();
      }
    }
    // M9's culture section. The unhappy ladder is **not** sweepable as a single number —
    // it is a list, and `parseOverride` addresses one field — so a sweep that wants it
    // moved uses a JSON patch. Saying so here rather than reporting a bare "not a number"
    // is the difference between a limitation and a mystery.
    case 'culture': {
      if (id !== CULTURE_ROW_ID) return unknown([CULTURE_ROW_ID]);
      switch (field) {
        case 'borderRadius2Culture':
          return ok(catalog.culture.borderRadius2Culture);
        case 'borderRadius3Culture':
          return ok(catalog.culture.borderRadius3Culture);
        case 'luxuriesPerHappyCitizen':
          return ok(catalog.culture.luxuriesPerHappyCitizen);
        case 'happyPerLuxuryResource':
          return ok(catalog.culture.happyPerLuxuryResource);
        default:
          return notNumeric();
      }
    }
    // M10's five weights.
    case 'score': {
      if (id !== SCORE_ROW_ID) return unknown([SCORE_ROW_ID]);
      switch (field) {
        case 'perPopulation':
          return ok(catalog.score.perPopulation);
        case 'perCity':
          return ok(catalog.score.perCity);
        case 'perTech':
          return ok(catalog.score.perTech);
        case 'perCulture':
          return ok(catalog.score.perCulture);
        case 'perWonder':
          return ok(catalog.score.perWonder);
        default:
          return notNumeric();
      }
    }
    // M10's four thresholds.
    case 'victory': {
      if (id !== VICTORY_ROW_ID) return unknown([VICTORY_ROW_ID]);
      switch (field) {
        case 'dominationLandPct':
          return ok(catalog.victory.dominationLandPct);
        case 'dominationPopPct':
          return ok(catalog.victory.dominationPopPct);
        case 'culturalVictoryCulture':
          return ok(catalog.victory.culturalVictoryCulture);
        case 'scoreVictoryTurn':
          return ok(catalog.victory.scoreVictoryTurn);
        default:
          return notNumeric();
      }
    }
  }
};

/** One catalog row's provenance, read from the row itself. */
const readProvenance = (
  catalog: Catalog,
  section: OverrideSection,
  id: string,
): Result<Provenance, string> => {
  switch (section) {
    case 'units': {
      const row = catalog.units.find((candidate) => String(candidate.id) === id);
      return row === undefined ? err(`units.${id} is not a catalog row`) : ok(row.provenance);
    }
    case 'buildings': {
      const row = catalog.buildings.find((candidate) => String(candidate.id) === id);
      return row === undefined ? err(`buildings.${id} is not a catalog row`) : ok(row.provenance);
    }
    case 'terrains': {
      const row = catalog.terrains.find((candidate) => String(candidate.id) === id);
      return row === undefined ? err(`terrains.${id} is not a catalog row`) : ok(row.provenance);
    }
    case 'improvements': {
      const row = catalog.improvements.find((candidate) => String(candidate.id) === id);
      return row === undefined
        ? err(`improvements.${id} is not a catalog row`)
        : ok(row.provenance);
    }
    case 'resources': {
      const row = catalog.resources.find((candidate) => String(candidate.id) === id);
      return row === undefined ? err(`resources.${id} is not a catalog row`) : ok(row.provenance);
    }
    case 'combat': {
      // The section's own provenance, which the report prints beside the set of nine: a
      // reader has to be able to see that a swept combat number is a placeholder of ours
      // and not a citation.
      return id === COMBAT_ROW_ID
        ? ok(catalog.combat.provenance)
        : err(
            `combat.${id} is not a catalog row (the section is one row, named "${COMBAT_ROW_ID}")`,
          );
    }
    case 'capture': {
      // M7's section provenance, printed beside the divisor for the same reason: a reader
      // has to be able to see that a swept capture number is a placeholder of ours and not
      // a citation.
      return id === CAPTURE_ROW_ID
        ? ok(catalog.capture.provenance)
        : err(
            `capture.${id} is not a catalog row (the section is one row, named ` +
              `"${CAPTURE_ROW_ID}")`,
          );
    }
    case 'governments': {
      const row = catalog.governments.find((candidate) => String(candidate.id) === id);
      return row === undefined ? err(`governments.${id} is not a catalog row`) : ok(row.provenance);
    }
    case 'culture': {
      return id === CULTURE_ROW_ID
        ? ok(catalog.culture.provenance)
        : err(
            `culture.${id} is not a catalog row (the section is one row, named ` +
              `"${CULTURE_ROW_ID}")`,
          );
    }
    case 'score': {
      return id === SCORE_ROW_ID
        ? ok(catalog.score.provenance)
        : err(
            `score.${id} is not a catalog row (the section is one row, named ` +
              `"${SCORE_ROW_ID}")`,
          );
    }
    case 'victory': {
      return id === VICTORY_ROW_ID
        ? ok(catalog.victory.provenance)
        : err(
            `victory.${id} is not a catalog row (the section is one row, named ` +
              `"${VICTORY_ROW_ID}")`,
          );
    }
  }
};

/**
 * The knob a sweep varies: the row it addresses, **its shipped value read from the
 * row**, and the row's own provenance.
 *
 * Reading the shipped value out of the catalog (rather than accepting it as a
 * parameter) is what keeps the catalog the single home of every game magnitude: the
 * sweep *reports* the number content already declares, and the provenance travels with
 * it, so a table can never present an unsourced number as Civ 3's.
 */
export const readKnob = (catalog: Catalog, field: string): Result<SweepKnob, string> => {
  const parsed = parseOverride(`${field}=0`);
  if (!parsed.ok) return err(parsed.error);
  const { section, id } = parsed.value;
  const setting = parsed.value.field;

  const shipped = readNumeric(catalog, section, id, setting);
  if (!shipped.ok) return shipped;

  const provenance = readProvenance(catalog, section, id);
  if (!provenance.ok) return provenance;

  return ok({
    field,
    section,
    id,
    setting,
    shipped: shipped.value,
    provenanceKind: provenance.value.kind,
    provenanceDetail:
      provenance.value.kind === 'cited' ? provenance.value.source : provenance.value.note,
  });
};

/** One metric's change under a swept value, against the shipped catalog's own run. */
export interface MetricDelta {
  readonly metric: MeasuredMetricField;
  /** The value's own horizon sum. */
  readonly sum: number;
  /** `sum` minus the shipped run's sum. Integer subtraction, exact. */
  readonly delta: number;
}

/** A measured sweep row: one value, one batch, and what it measured. */
export interface SweepValueRow {
  readonly kind: 'measured';
  readonly value: number;
  /** True for the row whose value is the catalog's own. */
  readonly shipped: boolean;
  readonly overrides: readonly string[];
  readonly rulesetHash: string;
  readonly runs: number;
  readonly turnsPlayed: number;
  readonly horizonTurnMin: number;
  readonly horizonTurnMax: number;
  readonly violations: readonly ReportedViolation[];
  /** Planner failures these runs reported (M7d) — empty when the policy played every turn. */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
  readonly horizons: readonly MetricTotal[];
  readonly deltas: readonly MetricDelta[];
}

/** A value that cannot be run at all — reported, never silently dropped. */
export interface SweepRejectedRow {
  readonly kind: 'rejected';
  readonly value: number;
  readonly shipped: boolean;
  readonly reason: string;
}

export type SweepRow = SweepValueRow | SweepRejectedRow;

/** The shipped-catalog run every value is compared against. */
export interface SweepBaseline {
  readonly overrides: readonly string[];
  readonly rulesetHash: string;
  readonly runs: number;
  readonly turnsPlayed: number;
  readonly horizonTurnMin: number;
  readonly horizonTurnMax: number;
  readonly violations: readonly ReportedViolation[];
  /** Planner failures the baseline runs reported (M7d). */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
  readonly horizons: readonly MetricTotal[];
}

/** How far one metric moved across the whole sweep. */
export interface SweepEffect {
  readonly metric: MeasuredMetricField;
  /** The smallest horizon sum any row (baseline included) measured. */
  readonly min: number;
  /** The largest. */
  readonly max: number;
  /** `max - min`. Zero means this knob did not move this metric at all. */
  readonly spread: number;
}

/**
 * How much work the sweep did, as *stored* counts.
 *
 * The banner's sentence ("in 4 of 30 runs") is a figure like any other, so it is a field
 * of the report and the renderer only prints it, in the same way the `sim` report stores
 * its own `totals`.
 */
export interface SweepTotals {
  /** Measured runs across every swept value (the baseline is a control, not a row). */
  readonly runs: number;
  /** Of those, how many runs stopped on a broken property. */
  readonly violatingRuns: number;
  /** Of those, how many reported at least one planner failure (M7d). */
  readonly plannerFailingRuns: number;
}

export interface SweepReport {
  readonly kind: 'civts-balance-sweep';
  readonly reportVersion: number;
  /**
   * `planner-failures` is M7d's value, for the reason the `sim` and tournament reports give:
   * a knob's effect measured on games the AI walked out of is not a measurement of the knob.
   * The precedence is stated rather than implied — a value the catalog refused is reported
   * first (nothing ran), then a broken invariant (the more specific defect), then a planner
   * failure — and it is the same precedence the other two reports use for the last two.
   */
  readonly status: 'ok' | 'violations' | 'planner-failures' | 'rejected-values';
  readonly exitCode: number;
  readonly knob: SweepKnob;
  readonly parameters: SimParameters;
  readonly baseline: SweepBaseline;
  readonly rows: readonly SweepRow[];
  readonly totals: SweepTotals;
  readonly effects: readonly SweepEffect[];
  /** `no-measurable-effect` is the honest verdict for a sweep that proves nothing. */
  readonly verdict: 'moves-metrics' | 'no-measurable-effect';
  readonly violations: readonly ReportedViolation[];
  /** Every planner failure in the sweep, in row order — the same records, flat. */
  readonly plannerFailures: readonly ReportedPlannerFailure[];
}

export const SWEEP_REPORT_VERSION = 1;

export interface BalanceSweepOptions {
  readonly catalog: Catalog;
  readonly settings: Settings;
  readonly seeds: readonly number[];
  readonly seedSpec: string;
  readonly policies: readonly Policy[];
  readonly maxTurns: number;
  readonly sampleEvery: number;
  readonly knob: SweepKnob;
  readonly values: readonly number[];
}

const horizonSummary = (
  runs: readonly SimulationResult[],
  knobValue?: number,
): Pick<
  SweepBaseline,
  | 'runs'
  | 'turnsPlayed'
  | 'horizonTurnMin'
  | 'horizonTurnMax'
  | 'violations'
  | 'plannerFailures'
  | 'horizons'
> => {
  const turns: number[] = [];
  for (const run of runs) {
    const rows = horizonRows(run);
    if (rows.length > 0) turns.push(rows[0]?.turn ?? 0);
  }
  return {
    runs: runs.length,
    turnsPlayed: runs.reduce((total, run) => total + run.turnsPlayed, 0),
    horizonTurnMin: turns.length === 0 ? 0 : Math.min(...turns),
    horizonTurnMax: turns.length === 0 ? 0 : Math.max(...turns),
    violations: runs.flatMap((run) => reportedViolations(run.seed, run.violations, knobValue)),
    // M7d: carried through the sweep's own summaries too, for the same reason the violations
    // are — a sweep whose rows drop the failure would report a table of numbers measured on
    // games the AI walked out of, with nothing in the table saying so.
    plannerFailures: runs.flatMap((run) =>
      reportedPlannerFailures(run.seed, run.plannerFailures, knobValue),
    ),
    horizons: metricTotals(
      runs.flatMap((run) => horizonRows(run)),
      HORIZON_METRICS,
    ),
  };
};

/**
 * The sweep itself: the same seeds, settings and policy under each value of one knob.
 *
 * Three properties make the table mean something, and each is a deliberate choice:
 *
 * 1. **One knob.** Every row's patch names exactly one assignment, so a difference
 *    between rows cannot be anything else.
 * 2. **A baseline run with no override at all.** Deltas are measured against the
 *    shipped catalog, and the row whose value *is* the shipped value is marked, so the
 *    table shows its own control. (That row and the baseline should measure identical
 *    numbers; the sweep does not assume it, it displays it.)
 * 3. **The whole seed set, every value.** Seeds are the same list for every row (the
 *    batch sorts them ascending), so no row is measured on an easier world.
 *
 * A value that cannot produce a valid ruleset becomes a **rejected row** with the
 * engine's own reason — reported, never dropped, because a table that silently omits a
 * value is a table that lies about what was swept.
 */
export const runBalanceSweep = (options: BalanceSweepOptions): Result<SweepReport, string> => {
  const baselineRuleset = validateRuleset(options.catalog, options.settings.fidelity);
  if (!baselineRuleset.ok) {
    return err(
      `the shipped catalog does not validate: ${baselineRuleset.error.map(formatRulesetError).join('; ')}`,
    );
  }

  const batchFor = (ruleset: Ruleset): BatchResult =>
    runBatch({
      seeds: options.seeds,
      settings: options.settings,
      ruleset,
      policies: options.policies,
      maxTurns: options.maxTurns,
      sampleEvery: options.sampleEvery,
    });

  const baselineRuns = batchFor(baselineRuleset.value);
  const baseline: SweepBaseline = {
    overrides: [],
    rulesetHash: hashValue(options.catalog),
    ...horizonSummary(baselineRuns.runs, options.knob.shipped),
  };
  const baselineSums = new Map<MeasuredMetricField, number>(
    baseline.horizons.map((total) => [total.metric, total.sum]),
  );

  const rows: SweepRow[] = options.values.map((value) => {
    const shipped = value === options.knob.shipped;
    const assignment = parseOverride(`${options.knob.field}=${String(value)}`);
    if (!assignment.ok) return { kind: 'rejected', value, shipped, reason: assignment.error };
    const patch = buildRulesetPatch([assignment.value]);
    if (!patch.ok) return { kind: 'rejected', value, shipped, reason: patch.error };

    const overridden = tryApplyOverrides(options.catalog, patch.value);
    if (!overridden.ok) {
      return { kind: 'rejected', value, shipped, reason: formatOverrideError(overridden.error) };
    }
    const validated = validateRuleset(overridden.value.catalog, options.settings.fidelity);
    if (!validated.ok) {
      return {
        kind: 'rejected',
        value,
        shipped,
        reason: validated.error.map(formatRulesetError).join('; '),
      };
    }

    const summary = horizonSummary(batchFor(validated.value).runs, value);
    return {
      kind: 'measured',
      value,
      shipped,
      overrides: overridden.value.applied,
      rulesetHash: hashValue(overridden.value.catalog),
      runs: summary.runs,
      turnsPlayed: summary.turnsPlayed,
      horizonTurnMin: summary.horizonTurnMin,
      horizonTurnMax: summary.horizonTurnMax,
      violations: summary.violations,
      plannerFailures: summary.plannerFailures,
      horizons: summary.horizons,
      deltas: summary.horizons.map((total) => ({
        metric: total.metric,
        sum: total.sum,
        delta: total.sum - (baselineSums.get(total.metric) ?? 0),
      })),
    };
  });

  const effects = HORIZON_METRICS.map((metric) => {
    const sums = [
      baseline.horizons.find((total) => total.metric === metric)?.sum ?? 0,
      ...rows.flatMap((row) =>
        row.kind === 'measured'
          ? [row.horizons.find((total) => total.metric === metric)?.sum ?? 0]
          : [],
      ),
    ];
    const min = Math.min(...sums);
    const max = Math.max(...sums);
    return { metric, min, max, spread: max - min };
  });

  const violations = [
    ...baseline.violations,
    ...rows.flatMap((row) => (row.kind === 'measured' ? row.violations : [])),
  ];
  const plannerFailures = [
    ...baseline.plannerFailures,
    ...rows.flatMap((row) => (row.kind === 'measured' ? row.plannerFailures : [])),
  ];
  const rejected = rows.filter((row) => row.kind === 'rejected').length;
  const measured = rows.filter((row): row is SweepValueRow => row.kind === 'measured');
  const totals = {
    runs: measured.reduce((total, row) => total + row.runs, 0),
    // A run is identified by the value it ran and the seed it played: one seed can break
    // a property under one swept value and hold it under another.
    violatingRuns: measured.reduce(
      (total, row) => total + new Set(row.violations.map((violation) => violation.seed)).size,
      0,
    ),
    // The same identification for M7d's channel: (knob value, seed) pairs, because a policy
    // can fail under one swept value and play the same seed cleanly under another.
    plannerFailingRuns: measured.reduce(
      (total, row) =>
        total +
        new Set(
          row.plannerFailures.map((failure) => `${String(failure.value)}:${String(failure.seed)}`),
        ).size,
      0,
    ),
  };
  const status: SweepReport['status'] =
    rejected > 0
      ? 'rejected-values'
      : violations.length > 0
        ? 'violations'
        : plannerFailures.length > 0
          ? 'planner-failures'
          : 'ok';

  return ok({
    kind: 'civts-balance-sweep',
    reportVersion: SWEEP_REPORT_VERSION,
    status,
    // A rejected value is a flag error (2), a broken invariant or a planner failure makes the
    // table not evidence (1), and both failure statuses share the code for M7d's reason.
    exitCode: rejected > 0 ? 2 : violations.length > 0 || plannerFailures.length > 0 ? 1 : 0,
    knob: options.knob,
    parameters: {
      mapSize: options.settings.mapSize,
      width: MAP_DIMENSIONS[options.settings.mapSize].width,
      height: MAP_DIMENSIONS[options.settings.mapSize].height,
      civCount: options.settings.civCount,
      maxTurns: options.maxTurns,
      policy: options.policies[0]?.name ?? 'none',
      sampleEvery: options.sampleEvery,
      seedSpec: options.seedSpec,
      seeds: options.seeds,
    },
    baseline,
    rows,
    totals,
    effects,
    verdict: effects.every((effect) => effect.spread === 0)
      ? 'no-measurable-effect'
      : 'moves-metrics',
    violations,
    plannerFailures,
  });
};

const deltaText = (delta: number): string => (delta > 0 ? `+${String(delta)}` : String(delta));

/** The sweep's text report — the same "formatting only" rule as `renderSimReport`. */
export const renderSweepReport = (report: SweepReport): string => {
  const lines: string[] = [];
  if (report.violations.length > 0) {
    lines.push(
      ...violationBannerLines(
        RUN_SUBJECT,
        report.totals.runs,
        report.totals.violatingRuns,
        report.violations,
      ),
      '',
    );
  }
  // M7d: a swept table measured on games the AI walked out of says so in the same place the
  // violation banner goes, and with the same shape.
  if (report.plannerFailures.length > 0) {
    lines.push(
      ...plannerFailureBannerLines(
        RUN_SUBJECT,
        report.totals.runs,
        report.totals.plannerFailingRuns,
        report.plannerFailures,
      ),
      '',
    );
  }

  const column = 12;
  const tableHeader =
    `  ${padRight('value', 14)}` +
    HORIZON_METRICS.map((metric) => `${metric.padStart(column)}${'delta'.padStart(8)}`).join('');

  lines.push(
    `balance sweep — ${report.knob.field} (the catalog's "${report.knob.setting}" of ` +
      `${report.knob.section}.${report.knob.id})`,
    '',
    `  shipped value      ${String(report.knob.shipped)} (read from the catalog, not from this script)`,
    `  provenance         ${report.knob.provenanceKind} — ${report.knob.provenanceDetail}`,
    `  seed set           ${report.parameters.seedSpec} (${String(report.parameters.seeds.length)} runs ` +
      `per value, the same set for every value)`,
    `  settings           ${report.parameters.mapSize} ${String(report.parameters.width)}x` +
      `${String(report.parameters.height)}, ${String(report.parameters.civCount)} civs, ` +
      `${String(report.parameters.maxTurns)} turns max, policy ${report.parameters.policy}, ` +
      `sampleEvery ${String(report.parameters.sampleEvery)}`,
    `  baseline           the shipped catalog with no override, hash ${report.baseline.rulesetHash}`,
    `  measured           ${HORIZON_METRICS.join(', ')}, summed at the horizon over every run and ` +
      'civilization',
    '',
    tableHeader,
  );

  const baselineCells = HORIZON_METRICS.map((metric) => {
    const total = report.baseline.horizons.find((carried) => carried.metric === metric);
    const sum = total === undefined ? '—' : String(total.sum);
    return `${sum.padStart(column)}${'—'.padStart(8)}`;
  }).join('');
  lines.push(`  ${padRight('as shipped', 14)}${baselineCells}`);

  // A row whose runs stopped early is measured at a shorter horizon, so its sums are
  // not comparable with the rest: it is marked, and the marker is explained below.
  const star = (row: SweepValueRow): string =>
    row.horizonTurnMin === report.baseline.horizonTurnMin &&
    row.horizonTurnMax === report.baseline.horizonTurnMax
      ? ''
      : ' *';
  let starred = false;

  for (const row of report.rows) {
    if (row.kind === 'rejected') {
      lines.push(`  ${padRight(String(row.value), 14)}REJECTED: ${row.reason}`);
      continue;
    }
    const cells = row.deltas
      .map((delta) => `${String(delta.sum).padStart(column)}${deltaText(delta.delta).padStart(8)}`)
      .join('');
    const mark = star(row);
    if (mark !== '') starred = true;
    const label = row.shipped ? `${String(row.value)} (shipped)` : String(row.value);
    lines.push(`  ${padRight(label, 14)}${cells}${mark}`);
  }

  lines.push('');
  if (starred) {
    lines.push(
      "  * this value's runs ended on a different turn (a run stops on the turn that breaks a",
      '    property), so its numbers are summed over a different horizon and are not',
      '    comparable with the rows above',
      '',
    );
  }

  const horizonNote =
    report.baseline.horizonTurnMin === report.baseline.horizonTurnMax
      ? `turn ${String(report.baseline.horizonTurnMin)}`
      : `turn ${String(report.baseline.horizonTurnMin)}..${String(report.baseline.horizonTurnMax)}`;
  lines.push(
    `  horizon            the last sampled turn of a run (${horizonNote} for the baseline)`,
  );
  lines.push(
    `  knob               only this one number changes between rows: ${report.knob.field}`,
  );
  lines.push('');

  if (report.verdict === 'no-measurable-effect') {
    lines.push(
      '  VERDICT: NO MEASURABLE EFFECT — every swept value measured identical horizon sums for',
      '           every metric above. This sweep proves nothing about the knob; pick another',
      '           one, a wider value range, or a longer run.',
    );
  } else {
    const parts = report.effects.map(
      (effect) =>
        `${effect.metric} ${String(effect.min)}..${String(effect.max)} (spread ${String(effect.spread)})`,
    );
    lines.push(`  VERDICT: the knob moves the measured metrics — ${parts.join(', ')}`);
  }

  if (report.rows.some((row) => row.kind === 'rejected')) {
    lines.push(
      '',
      '  NOTE: a rejected value could not produce a valid ruleset; its reason is above.',
    );
  }
  if (report.violations.length > 0) {
    lines.push(
      '',
      '  NOTE: a value whose runs broke an invariant is measured only up to the turn that broke,',
      '        so its horizon is shorter than the others — read those rows with the banner above.',
    );
  }
  if (report.plannerFailures.length > 0) {
    // Deliberately unlike the violation note: a planner failure does *not* shorten a run, so the
    // horizon is unaffected — which is exactly why the table looks normal and the banner is the
    // only thing that says these games were not played by the AI end to end.
    lines.push(
      '',
      '  NOTE: a value whose runs reported a planner failure was measured on games where the AI',
      '        stopped playing part of a turn. The horizon is unaffected (a planner failure does',
      '        not stop a run), so the numbers above look ordinary — read them with the banner.',
    );
  }

  return `${lines.join('\n')}\n`;
};

export interface SweepCommandOutput {
  readonly report: SweepReport | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The `scripts/balance-sweep.ts` entry point, with no I/O: flags in, text out.
 *
 * It lives here, beside the `sim` command, so the sweep runs through exactly the same
 * override machinery (and the same structured-report discipline) as the flag the CLI
 * exposes — a sweep with its own private override path would be a second set of rules
 * about what a knob may be.
 */
export const runSweepCommand = (
  args: readonly string[],
  defaults: SweepCommandDefaults,
): Result<SweepCommandOutput, SimCommandFailure> => {
  if (args.includes('-h') || args.includes('--help')) {
    return ok({ report: undefined, stdout: SWEEP_USAGE, stderr: '', exitCode: 0 });
  }

  const flags = parseSweepArgs(args);
  if (!flags.ok) return err(failure(2, [`error: ${flags.error}`], SWEEP_USAGE));

  const knobField = flags.value.knob ?? defaults.knob;
  const values = flags.value.values ?? defaults.values;
  if (values.length === 0) {
    return err(failure(2, ['error: the sweep has no values to run'], SWEEP_USAGE));
  }

  const layer: Record<string, unknown> = {};
  if (flags.value.mapSize !== undefined) layer['mapSize'] = flags.value.mapSize;
  if (flags.value.civCount !== undefined) layer['civCount'] = flags.value.civCount;

  const settings = loadSettings(layer);
  if (!settings.ok) {
    return err(
      failure(
        2,
        settings.error.map((issue) => `settings error: ${formatSettingsIssue(issue)}`),
        SWEEP_USAGE,
      ),
    );
  }

  const knob = readKnob(CATALOG, knobField);
  if (!knob.ok) return err(failure(2, [`error: ${knob.error}`], SWEEP_USAGE));

  const policy = policyOf(flags.value.policy ?? 'simple');
  let report: Result<SweepReport, string>;
  try {
    report = runBalanceSweep({
      catalog: CATALOG,
      settings: settings.value,
      seeds: flags.value.seeds ?? parseDefaultSeedSpec(defaults.seedSpec),
      seedSpec: flags.value.seedSpec ?? defaults.seedSpec,
      policies: civPolicies(policy, settings.value.civCount),
      maxTurns: flags.value.turns ?? defaults.turns,
      sampleEvery: flags.value.sampleEvery ?? DEFAULT_SAMPLE_EVERY,
      knob: knob.value,
      values,
    });
  } catch (cause) {
    return err(failure(1, [`error: ${messageOf(cause)}`], undefined));
  }
  if (!report.ok) return err(failure(1, [`error: ${report.error}`], undefined));

  const json = flags.value.json;
  return ok({
    report: report.value,
    stdout: json ? `${canonicalize(report.value)}\n` : renderSweepReport(report.value),
    // The sweep puts its shout on `--json`'s stderr only (its text report carries the banners
    // itself), and since M7d that includes the planner-failure banner beside the violation one.
    stderr:
      json && (report.value.violations.length > 0 || report.value.plannerFailures.length > 0)
        ? sweepBanner(report.value)
        : '',
    exitCode: report.value.exitCode,
  });
};

/** The sweep's banner for the `--json` path (stderr), shared with the text report. */
const sweepBanner = (report: SweepReport): string =>
  `${
    report.violations.length === 0
      ? ''
      : `${violationBannerLines(
          RUN_SUBJECT,
          report.totals.runs,
          report.totals.violatingRuns,
          report.violations,
        ).join('\n')}\n`
  }${
    report.plannerFailures.length === 0
      ? ''
      : `${plannerFailureBannerLines(
          RUN_SUBJECT,
          report.totals.runs,
          report.totals.plannerFailingRuns,
          report.plannerFailures,
        ).join('\n')}\n`
  }`;

/* ------------------------------------------------------------------ *
 * One small export for the flag tests — nothing here is a second implementation
 * ------------------------------------------------------------------ */

/** Parse one `--override` text. Exported so the flag tests can assert what it means. */
export const parseOverrideText = (text: string): Result<OverrideAssignment, string> =>
  parseOverride(text);
