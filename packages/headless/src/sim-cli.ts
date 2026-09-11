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
  type MapSize,
  type Provenance,
  type Result,
  type Settings,
  type SettingsIssue,
  type UnitDomain,
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
  CORE_INVARIANTS,
  DO_NOTHING_POLICY,
  MEASURED_METRIC_FIELDS,
  SIMPLE_POLICY,
  formatOverrideError,
  runBatch,
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
  type ResourcePatch,
  type RulesetPatch,
  type SimulationResult,
  type StopReason,
  type TerrainPatch,
  type TurnMetrics,
  type UnitPatch,
  type Violation,
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

/** The policies `--policy` accepts. `none` is the do-nothing control. */
export const SIM_POLICIES = ['simple', 'none'] as const;
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
  --policy <name>     ${SIM_POLICIES.join('|')} — "none" is the do-nothing control the
                      shipped policy is compared against (default simple)
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
  0  every run played and every invariant held
  1  something the flags describe could not be run (a ruleset that fails validation),
     or a run broke an invariant — the violation is printed loudly, naming itself, its
     seed and its turn
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

Exit codes: 0 = every row ran and held its invariants; 1 = a row broke an invariant
(printed loudly) or a value produced an invalid ruleset (reported as a rejected row);
2 = the flags themselves are unusable.
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

/** The catalog sections a patch may address, in the order `@civts/sim` walks them. */
const OVERRIDE_SECTIONS_LOOKUP: readonly OverrideSection[] = [
  'terrains',
  'units',
  'buildings',
  'improvements',
  'resources',
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

const parseOverride = (text: string): Result<OverrideAssignment, string> => {
  const equals = text.indexOf('=');
  if (equals < 0) {
    return err(`--override expects <section>.<id>.<field>=<value>, got "${text}"`);
  }

  const path = text.slice(0, equals);
  const parts = path.split('.');
  const section = parts[0] ?? '';
  const id = parts[1] ?? '';
  const field = parts.slice(2).join('.');
  if (parts.length < 3 || id === '' || field === '') {
    return err(
      `--override expects <section>.<id>.<field>=<value> (a section, a row id and a field), ` +
        `got "${text}"`,
    );
  }
  if (!isOverrideSection(section)) {
    return err(
      `--override names section "${section}", which is not one of ` +
        `${OVERRIDE_SECTIONS_LOOKUP.join('|')} (in "${text}")`,
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
];
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
      case 'defenseBonusPct': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        patch = { ...patch, defenseBonusPct: value.value };
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
      case 'attack':
      case 'defense':
      case 'movement':
      case 'cost': {
        const value = wantsInteger(a);
        if (!value.ok) return value;
        if (a.field === 'attack') patch = { ...patch, attack: value.value };
        else if (a.field === 'defense') patch = { ...patch, defense: value.value };
        else if (a.field === 'movement') patch = { ...patch, movement: value.value };
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

  return ok({
    ...(assignments.some((a) => a.section === 'terrains') ? { terrains: terrains.value } : {}),
    ...(assignments.some((a) => a.section === 'units') ? { units: units.value } : {}),
    ...(assignments.some((a) => a.section === 'buildings') ? { buildings: buildings.value } : {}),
    ...(assignments.some((a) => a.section === 'improvements')
      ? { improvements: improvements.value }
      : {}),
    ...(assignments.some((a) => a.section === 'resources') ? { resources: resources.value } : {}),
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

/** One policy, by the name `--policy` gives it. */
const policyOf = (name: SimPolicyName): Policy =>
  name === 'none' ? DO_NOTHING_POLICY : SIMPLE_POLICY;

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
  readonly finalHash: string;
  readonly metricRows: number;
  /** The last turn sampled; 0 when a run produced no rows. */
  readonly finalTurn: number;
  /** `HORIZON_METRICS` sums over this run's final sampled rows (one per civilization). */
  readonly horizon: readonly MetricTotal[];
  /** The final sampled rows themselves, for a JSON consumer that wants every detail. */
  readonly final: readonly TurnMetrics[];
  readonly violations: readonly ReportedViolation[];
}

export interface SimInvariantReport {
  readonly names: readonly string[];
  readonly count: number;
  /** Whole-registry checks run: one per turn played, per run. */
  readonly checks: number;
  readonly violations: number;
}

export interface SimTotals {
  readonly runs: number;
  readonly turnsPlayed: number;
  readonly metricRows: number;
  readonly violatingRuns: number;
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
 */
export interface SimReport {
  readonly kind: 'civts-sim-report';
  readonly reportVersion: number;
  readonly status: 'ok' | 'violations';
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
  /** The batch's win counts; the key is absent while the engine has no victory condition. */
  readonly wins?: readonly { readonly outcome: string; readonly count: number }[];
}

export const SIM_REPORT_VERSION = 1;

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
  const runs: readonly SimRunReport[] = input.batch.runs.map((run) => {
    const rows = horizonRows(run);
    return {
      seed: run.seed,
      turnsPlayed: run.turnsPlayed,
      stoppedBecause: run.stoppedBecause,
      finalHash: run.finalHash,
      metricRows: run.metrics.length,
      finalTurn: rows[0]?.turn ?? 0,
      horizon: metricTotals(rows, HORIZON_METRICS),
      final: rows,
      violations: reportedViolations(run.seed, run.violations),
    };
  });

  const violations = runs.flatMap((run) => run.violations);
  const violatingRuns = runs.filter((run) => run.violations.length > 0).length;
  const turnsPlayed = runs.reduce((total, run) => total + run.turnsPlayed, 0);
  const metricRows = runs.reduce((total, run) => total + run.metricRows, 0);
  const invariantCount = input.invariantNames.length;
  const checks = runs.reduce((total, run) => total + run.turnsPlayed * invariantCount, 0);
  const horizonTurns = runs.map((run) => run.finalTurn).filter((turn) => turn > 0);
  const horizonTurnMin = horizonTurns.length === 0 ? 0 : Math.min(...horizonTurns);
  const horizonTurnMax = horizonTurns.length === 0 ? 0 : Math.max(...horizonTurns);
  const allHorizonRows = runs.flatMap((run) => run.final);

  return {
    kind: 'civts-sim-report',
    reportVersion: SIM_REPORT_VERSION,
    status: violations.length === 0 ? 'ok' : 'violations',
    exitCode: violations.length === 0 ? 0 : 1,
    parameters: input.parameters,
    ruleset: input.ruleset,
    totals: {
      runs: runs.length,
      turnsPlayed,
      metricRows,
      violatingRuns,
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
  // Header and rows are built from one width list, so a column can never drift away
  // from the value under it.
  const row = (
    seed: string,
    turns: string,
    stop: string,
    turn: string,
    cells: readonly string[],
    hash: string,
  ): string =>
    `  ${seed.padStart(6)} ${turns.padStart(5)}  ${padRight(stop, stopWidth)}` +
    `${turn.padStart(4)}  ${cells.map((cell) => cell.padStart(column)).join('')}  ${hash}`;

  const lines = [
    row(
      'seed',
      'turns',
      'stop',
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

  if (report.wins !== undefined) {
    for (const win of report.wins) {
      lines.push(`  wins: ${win.outcome} ${String(win.count)}`);
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
 * `civts sim …`, with no I/O: the caller writes `stdout`/`stderr` and exits `exitCode`.
 *
 * Returning the text rather than printing it is what makes the command testable in
 * process (and what keeps the "one source of truth" rule true end to end): the report
 * builder cannot print, and the printer cannot compute.
 */
export const runSimCommand = (
  args: readonly string[],
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
  const policy = policyOf(flags.value.policy ?? 'simple');
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

  let batch: BatchResult;
  try {
    batch = runBatch({
      seeds,
      settings: settings.value,
      ruleset: validated.value,
      policies: civPolicies(policy, settings.value.civCount),
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
  return ok({
    report,
    stdout: json ? `${canonicalize(report)}\n` : renderSimReport(report),
    stderr: json ? renderViolationBanner(report) : '',
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

/** The `--override` line for a patch the catalog refused, naming what was typed. */
const overrideFailureLine = (
  assignments: readonly OverrideAssignment[],
  error: OverrideError,
): string => {
  const culprit = assignments.find(
    (a) =>
      a.section === error.section &&
      a.id === error.id &&
      (error.kind !== 'unknown-field' || a.field === error.field),
  );
  const what = culprit === undefined ? 'the override' : `--override ${culprit.text}`;
  return `error: ${what}: ${formatOverrideError(error)}`;
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
}

export interface SweepReport {
  readonly kind: 'civts-balance-sweep';
  readonly reportVersion: number;
  readonly status: 'ok' | 'violations' | 'rejected-values';
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
  'runs' | 'turnsPlayed' | 'horizonTurnMin' | 'horizonTurnMax' | 'violations' | 'horizons'
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
  };
  const status: SweepReport['status'] =
    rejected > 0 ? 'rejected-values' : violations.length > 0 ? 'violations' : 'ok';

  return ok({
    kind: 'civts-balance-sweep',
    reportVersion: SWEEP_REPORT_VERSION,
    status,
    exitCode: rejected > 0 ? 2 : violations.length > 0 ? 1 : 0,
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
    stderr: json && report.value.violations.length > 0 ? sweepBanner(report.value) : '',
    exitCode: report.value.exitCode,
  });
};

/** The sweep's banner for the `--json` path (stderr), shared with the text report. */
const sweepBanner = (report: SweepReport): string =>
  `${violationBannerLines(
    RUN_SUBJECT,
    report.totals.runs,
    report.totals.violatingRuns,
    report.violations,
  ).join('\n')}\n`;

/* ------------------------------------------------------------------ *
 * One small export for the flag tests — nothing here is a second implementation
 * ------------------------------------------------------------------ */

/** Parse one `--override` text. Exported so the flag tests can assert what it means. */
export const parseOverrideText = (text: string): Result<OverrideAssignment, string> =>
  parseOverride(text);
