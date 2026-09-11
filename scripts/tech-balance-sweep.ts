#!/usr/bin/env node
/**
 * `scripts/tech-balance-sweep.ts` — M5's balance evidence: what a **tech cost** knob
 * does to a game, measured rather than asserted.
 *
 * Run it with:
 *
 * ```
 *   npx tsx scripts/tech-balance-sweep.ts                       # the default knob and grid
 *   npx tsx scripts/tech-balance-sweep.ts --values 1,2,4,8
 *   npx tsx scripts/tech-balance-sweep.ts --seeds 1..8 --turns 40 --json
 * ```
 *
 * ## What it is for, and why it is a second script
 *
 * `scripts/balance-sweep.ts` is the same loop over a *production* knob
 * (`units.settler.cost`), and this script is deliberately its twin: one catalog number, a
 * fixed seed set, the same settings and policy under every value, and a table whose every
 * figure comes from `@civts/sim`'s structured result. M5's question is different from
 * M4c's, which is why it is a second script rather than a second knob in the first: a
 * shield cost shows up in a *count* (cities), a tech cost shows up in a *timeline* (the
 * turn a technology completes on), and only the second of those needs the beaker ledger
 * read turn by turn.
 *
 * ## The measured effect, and where each number comes from
 *
 * 1. **the turn each technology completes on**, per seed and as a mean, derived from the
 *    beaker pool the money loop banks (see "How a completion is detected");
 * 2. **how many technologies each civilization knows at the horizon** — a *count*, read
 *    off `finalState.players[].techs` rather than inferred from the pool;
 * 3. **the downstream effect on the board** — cities standing and population at the
 *    horizon, which is what a technology is supposed to be *for*.
 *
 * A per-tech turn is only a *mean* over the seeds that completed it, and the column says
 * how many of the runs that was (`n`). A mean over the runs that finished is a different
 * claim from a mean over every run, and the table must not blur them.
 *
 * ## How a completion is detected, and why not from an event
 *
 * The engine emits `TechResearched` carrying the tech id and the price, and that is the
 * ground truth — but it is emitted into the turn's event list, and `SimulationResult`
 * carries `finalState`, `metrics` and `finalHash`, not the events. The metrics are
 * enough, and they are a *structured result* rather than a second listener: for one
 * player `beakers[t] = beakers[t - 1] + incomeBeakers[t] - spent[t]`, so `spent[t]` is
 * arithmetic, and a completion is exactly a turn whose `spent` is a **price the catalog
 * knows**. Each completion is identified by the drop it caused *and* by the price that
 * drop matches; a step matching no price — or matching two technologies at once — is
 * reported as unattributed rather than guessed at. The two cases are kept apart on
 * purpose: the value of this measurement is that a wrong attribution is visible.
 *
 * A completion turn can only be read this way when the trail is sampled **every turn**,
 * so `--sample-every` is honoured but any value above `1` is printed as a caveat — the
 * trail then has gaps and the completion turns would no longer be the engine's.
 *
 * ## The replay, and the cross-check that keeps it honest
 *
 * `SimulationResult` does not carry events, so this script replays each run to reach
 * `advanceTurn`'s own outcome: civilizations in player-id order, each policy's commands
 * applied while `EndTurn` is skipped (the runner owns the turn boundary), then
 * `advanceTurn`, then `sampleTurn` — the runner's loop, restated with the runner's own
 * `policyRngFor` for the policy context. **Every seed is run both ways and the two must
 * agree** on `turnsPlayed`, `finalHash`, the number of metric rows and the final state's
 * own `turn`, before a single figure is reported; a disagreement is printed and exits
 * non-zero instead of becoming a table. That check is what makes a private loop here a
 * reading of the engine's game rather than a second game.
 *
 * ## Where the knob goes, and where it cannot go yet
 *
 * The knob is **one multiplier over every tech's `cost`**, and the shipped cost is *read
 * out of* `@civts/rules`' catalog (`techs[].cost`) and printed with that row's own
 * provenance: this script contains **no game magnitude of its own**. The only numbers
 * written in it are the grid and the default experiment size, which are experiment
 * parameters rather than claims about the game.
 *
 * The multiplier itself is applied by this script, and the reason is a measured fact the
 * report prints rather than a preference: **`RulesetPatch` has no `techs` section**, so
 * `applyOverrides` cannot express this knob yet — it is the first knob in the project the
 * override surface cannot express. The script therefore sends `applyOverrides` an **empty
 * patch** per variant (`patchFor`), so the catalog still takes the override path into
 * `validateRuleset` and the override record is still reported, and the missing section is
 * named in the output. When `techs` lands in `RulesetPatch`, the costs move into
 * `patchFor`'s return value and nothing else here changes: the variant builder is already
 * the override's shape (catalog in, catalog out) and validation already runs after it.
 *
 * ## One thing the table is not
 *
 * **`cities` and `population` are the figures at the horizon, not cumulative.** They come
 * from the last sampled `TurnMetrics` row per civilization, which is the state the
 * horizon left behind; a technology that was researched late may legitimately have no
 * effect on either, and that is a finding the report states rather than hides.
 *
 * ## Provenance
 *
 * Every tech row is a `placeholder`: **unsourced, chosen to be playable**. This script
 * makes **no claim about Civ 3** — the table measures *this project's* numbers against
 * *this project's* engine.
 *
 * ## Reproducibility
 *
 * No clock, no `Math.random`, no ambient input: the report is a function of the flags
 * alone, so the same command prints the same table byte for byte. `--json` prints the
 * same structured value the table is rendered from.
 */

import {
  advanceTurn,
  applyCommand,
  civPlayers,
  loadSettings,
  newGame,
  type GameEvent,
  type GameState,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import {
  applyOverrides,
  policyRngFor,
  runSimulation,
  sampleTurn,
  simplePolicy,
  type Policy,
  type RulesetPatch,
  type TurnMetrics,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * The experiment
 * ------------------------------------------------------------------ */

/**
 * The knob: a multiplier over every tech's shipped `cost`. `1` is the control — the
 * shipped catalog, unscaled — and every other value is that catalog with every price
 * scaled. A multiplier rather than an absolute price because a tech tree is a *ladder*:
 * scaling keeps the order and the ratios, which is what makes one number a knob for the
 * whole tree instead of for one rung of it.
 */
const KNOB = 'techs.*.cost';

const DEFAULTS = {
  values: [1, 2, 4, 8],
  seedSpec: '1,4,5,7,8',
  turns: 40,
  sampleEvery: 1,
} as const;

const USAGE = `tech-balance-sweep — the measured effect of a technology-cost knob

  npx tsx scripts/tech-balance-sweep.ts [options]

  --knob <text>        the knob's label in the report (default "${KNOB}"; the
                       scaling itself is a multiplier over every tech's cost)
  --values <list>      multipliers to run (default ${DEFAULTS.values.join(',')})
  --seeds <spec>       "1,4,7" or "1..10" (default ${DEFAULTS.seedSpec})
  --turns <int>        turns per game, at least 1 (default ${String(DEFAULTS.turns)})
  --sample-every <n>   sample metrics every n turns (default 1; the beaker trail
                       needs every turn, so anything else is reported as a caveat)
  --json               print the structured report instead of the table
  -h, --help           this text
`;

interface Flags {
  readonly knob: string;
  readonly values: readonly number[];
  readonly seedSpec: string;
  readonly turns: number;
  readonly sampleEvery: number;
  readonly json: boolean;
  readonly help: boolean;
}

/* ------------------------------------------------------------------ *
 * The report value — the one source of truth the table is rendered from
 * ------------------------------------------------------------------ */

interface TechPrice {
  readonly id: string;
  readonly name: string;
  readonly shipped: number;
  readonly scaled: number;
}

interface Completion {
  readonly turn: number;
  readonly playerId: number;
  readonly tech: string;
  /** The charge the completion reported. */
  readonly cost: number;
  /** Beakers the completion says were left: the carried remainder. */
  readonly remainder: number;
  /** The pool the previous turn's money loop had banked — what the step spent from. */
  readonly poolBefore: number;
  /** The remainder plus that turn's own collection, which the step could not spend. */
  readonly poolAfter: number;
  /**
   * Whether the event and the pool rows tell the same story:
   * `poolBefore - cost === remainder` (the charge came out of the banked pool) and
   * `event.beakers === remainder` (the event's own remainder is the one the rule gives).
   */
  readonly ledgerAgrees: boolean;
}

interface UnattributedStep {
  readonly turn: number;
  readonly playerId: number;
  readonly spent: number;
  readonly reason: string;
}

interface PlayerRun {
  readonly playerId: number;
  readonly cities: number;
  readonly population: number;
  readonly knownTechs: number;
  readonly known: readonly string[];
}

interface ReplayCheck {
  readonly turnsPlayed: number;
  readonly finalHash: string;
  readonly metricRows: number;
  readonly finalTurn: number;
  readonly agrees: boolean;
}

interface SeedRun {
  readonly seed: number;
  readonly turnsPlayed: number;
  readonly finalHash: string;
  readonly stoppedBecause: string;
  readonly violations: number;
  readonly players: readonly PlayerRun[];
  readonly completions: readonly Completion[];
  readonly unattributed: readonly UnattributedStep[];
  readonly replay: ReplayCheck;
}

/** Per technology across the seeds of one variant. */
interface TechTally {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  /** How many runs completed it, and on which turns (ascending). */
  readonly completedIn: number;
  readonly turns: readonly number[];
  /** The mean completion turn over the runs that finished it — absent when none did. */
  readonly meanTurn?: number;
}

interface Variant {
  readonly label: string;
  readonly multiplier: number;
  readonly costs: readonly TechPrice[];
  /** What `applyOverrides` recorded for this variant's patch. */
  readonly overrideRecord: readonly string[];
  readonly seeds: readonly SeedRun[];
  readonly runs: number;
  readonly meanKnownTechs?: number;
  readonly meanCities?: number;
  readonly meanPopulation?: number;
  readonly techs: readonly TechTally[];
}

interface TechSweepReport {
  readonly knob: string;
  readonly seedSpec: string;
  readonly seeds: readonly number[];
  readonly turns: number;
  readonly sampleEvery: number;
  readonly mapSize: string;
  readonly civCount: number;
  readonly policy: string;
  readonly shippedTechs: readonly TechPrice[];
  /** The missing-section line, or **absent** when the override surface can express the knob. */
  readonly overrideGap?: string;
  readonly variants: readonly Variant[];
  readonly violations: readonly string[];
  readonly caveats: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

const parseFlags = (
  argv: readonly string[],
):
  { readonly ok: true; readonly flags: Flags } | { readonly ok: false; readonly error: string } => {
  let knob: string = KNOB;
  let values: readonly number[] = DEFAULTS.values;
  let seedSpec: string = DEFAULTS.seedSpec;
  let turns: number = DEFAULTS.turns;
  let sampleEvery: number = DEFAULTS.sampleEvery;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    const take = (): string | undefined => {
      if (next === undefined || next.startsWith('--')) return undefined;
      index += 1;
      return next;
    };

    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--knob') {
      const value = take();
      if (value === undefined) return { ok: false, error: '--knob needs a value' };
      knob = value;
      continue;
    }
    if (flag === '--values') {
      const value = take();
      if (value === undefined) return { ok: false, error: '--values needs a value' };
      const parts = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      if (parts.length === 0) return { ok: false, error: '--values needs at least one value' };
      const parsed: number[] = [];
      for (const part of parts) {
        const numeric = Number(part);
        if (!Number.isInteger(numeric) || numeric < 1) {
          return { ok: false, error: `--values must be whole numbers >= 1 (got "${part}")` };
        }
        parsed.push(numeric);
      }
      values = parsed;
      continue;
    }
    if (flag === '--seeds') {
      const value = take();
      if (value === undefined) return { ok: false, error: '--seeds needs a value' };
      seedSpec = value;
      continue;
    }
    if (flag === '--turns' || flag === '--sample-every') {
      const value = take();
      if (value === undefined) return { ok: false, error: `${flag} needs a value` };
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < 1) {
        return { ok: false, error: `${flag} must be a whole number >= 1 (got "${value}")` };
      }
      if (flag === '--turns') turns = numeric;
      else sampleEvery = numeric;
      continue;
    }
    return { ok: false, error: `unknown flag "${String(flag)}"` };
  }

  return { ok: true, flags: { knob, values, seedSpec, turns, sampleEvery, json, help } };
};

/** `"1,4,7"` or `"1..10"` — ascending and duplicate-free. */
const parseSeeds = (spec: string): readonly number[] => {
  const seeds = new Set<number>();
  for (const part of spec.split(',')) {
    const text = part.trim();
    if (text === '') continue;
    const range = /^(\d+)\.\.(\d+)$/.exec(text);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
        throw new Error(`bad seed range "${text}"`);
      }
      for (let seed = from; seed <= to; seed += 1) seeds.add(seed);
      continue;
    }
    const single = Number(text);
    if (!Number.isInteger(single) || single < 0) throw new Error(`bad seed "${text}"`);
    seeds.add(single);
  }
  if (seeds.size === 0) throw new Error('no seeds');
  return [...seeds].sort((left, right) => left - right);
};

/* ------------------------------------------------------------------ *
 * The knob's own shape
 * ------------------------------------------------------------------ */

/**
 * The scale this script's variant builder uses — see "Where the knob goes, and where it
 * cannot go yet". It is `applyOverrides`' shape (a catalog in, a catalog out) and its
 * result goes through the same `validateRuleset` call, so moving the costs into
 * `patchFor` is a one-line change rather than a rewrite.
 *
 * `multiplier === 1` returns the catalog **itself**, so the control variant is the
 * shipped content object for object rather than a copy that happens to hold the same
 * numbers.
 */
const scaleTechCosts = (catalog: Catalog, multiplier: number): Catalog =>
  multiplier === 1
    ? catalog
    : {
        ...catalog,
        techs: catalog.techs.map((tech) => ({ ...tech, cost: tech.cost * multiplier })),
      };

/**
 * The patch `applyOverrides` is given for a variant.
 *
 * **Empty, and that is a finding rather than an oversight**: `RulesetPatch` has no
 * `techs` section, so this knob cannot be expressed as an override yet. The catalog still
 * runs through `applyOverrides` and the record it produced is reported, so the gap is
 * visible in the output instead of hidden behind a variant builder that looks like an
 * override.
 */
const patchFor = (): RulesetPatch => ({});

/**
 * Whether `applyOverrides` can carry a tech cost from the catalog into a run — **asked of
 * the module, never assumed**, because the answer decides whether this table is built on
 * an override or on the catalog directly.
 *
 * Three questions are asked, with the catalog itself as the probe:
 *
 * 1. does a patch that **names** `techs.<id>.cost` survive the merge, or does the merge
 *    drop the section as unknown?
 * 2. does the catalog that comes **out** still have its tech tree (the override merge
 *    rebuilds the catalog from the sections it knows, so a section it does not know is
 *    dropped — silently, since the merge does not reject unknown *sections*);
 * 3. is the result still a ruleset at all (`validateRuleset` reads `catalog.techs`).
 *
 * A `techs` cost is expressible through `applyOverrides` only when all three hold. Today
 * none of them does, and the returned line says exactly which — it is printed in the
 * report rather than worked around silently, because "the knob went through the override
 * path" is a claim this script must not make unless it is true.
 */
const overrideProbe = (): string | undefined => {
  const named = { techs: { pottery: { cost: 5 } } } as RulesetPatch;
  let accepted: Catalog;
  try {
    accepted = applyOverrides(CATALOG, named);
  } catch (error) {
    return (
      `the multiplier is applied by this script: naming a tech cost through applyOverrides ` +
      `throws (${error instanceof Error ? error.message : String(error)}), so this knob is ` +
      `not expressible as an override and the catalog is scaled directly, through the same ` +
      `validateRuleset call an override would have reached.`
    );
  }

  // `Catalog` declares `techs` as required and `applyOverrides` returns a `Catalog`, so
  // the compiler believes the section is there; the runtime is what decides, and the cast
  // is how this check can be written **at all** — the honest reading of a type that says
  // "required" about a section the merge drops.
  const kept = (accepted as { readonly techs?: unknown }).techs !== undefined;
  if (!kept) {
    return (
      `the multiplier is applied by this script, because applyOverrides drops the tech tree: ` +
      `a patch naming techs.pottery.cost is *accepted*, but the catalog that comes back has ` +
      `no techs section at all (the merge rebuilds the catalog from the five sections ` +
      `RulesetPatch declares and silently drops every other one), and validateRuleset then ` +
      `throws on catalog.techs. So no override run of the tech tree exists yet: fixing this ` +
      `means adding techs to RulesetPatch, to OVERRIDE_SECTIONS and to the merge — and the ` +
      `"silently drops" half is the part a patch-section fix alone would not catch.`
    );
  }

  const validated = validateRuleset(accepted, 'tuned');
  if (!validated.ok) {
    return (
      `the multiplier is applied by this script: an override that names techs.pottery.cost ` +
      `produces a catalog validateRuleset rejects (${validated.error
        .map((issue) => issue.kind)
        .join(', ')}), so the tech cost knob cannot reach a run as an override`
    );
  }
  return undefined;
};

/** The shipped price and provenance of one tech, read out of the catalog. */
const shippedTechRow = (
  techId: unknown,
): { readonly cost: number; readonly provenance: string } => {
  const row = CATALOG.techs.find((tech) => String(tech.id) === String(techId));
  if (row === undefined) throw new Error(`the catalog has no tech "${String(techId)}"`);
  return {
    cost: row.cost,
    provenance:
      row.provenance.kind === 'placeholder'
        ? `placeholder (${row.provenance.note})`
        : row.provenance.kind,
  };
};

/* ------------------------------------------------------------------ *
 * One completion detector
 * ------------------------------------------------------------------ */

/**
 * The research completions one run reported, checked against the beaker trail.
 *
 * The event is the ground truth: `TechResearched` carries the tech id, the price it
 * charged and the beakers left afterwards, and it is emitted by the research step
 * itself. This script does not try to *infer* a completion from the pool — two
 * technologies can share a price, and an inference that guessed between them would be a
 * figure the structured result does not contain. What the pool is used for is the
 * **check**: for the turn's own metrics row,
 *
 * ```
 *   poolBefore + incomeBeakers - cost === poolAfter        (the charge was paid)
 *   poolAfter === remainder                                (the carry-over rule holds)
 * ```
 *
 * Because the money loop banks a turn's collection *after* the research step spent the
 * previous turn's pool, `incomeBeakers` is deliberately part of the first equation: the
 * collection arrives after the step and cannot be spent until the next turn. A row that
 * fails either equation is reported as a disagreement rather than averaged in.
 */
const readCompletions = (
  events: readonly GameEvent[],
  metrics: readonly TurnMetrics[],
): { readonly completions: readonly Completion[]; readonly disagreements: readonly string[] } => {
  const completions: Completion[] = [];
  const disagreements: string[] = [];

  // Each player's sampled rows by turn, ascending. A charge is placed on the turn whose
  // row satisfies the engine's own relation:
  //
  //   pool(t) - incomeBeakers(t) === remainder        (income is collected after the step)
  //   pool(t - 1) - cost === remainder                (the step spent the banked pool)
  //
  // so `pool(t - 1) - cost === pool(t) - incomeBeakers(t)`. Both halves are checked and a
  // completion is only used once: two technologies can share a price, the same technology
  // can be researched by both civilizations, and a placement that ignored either would
  // report a figure the structured result does not contain.
  const rowsByPlayer = new Map<number, Map<number, TurnMetrics>>();
  for (const row of metrics) {
    const rows = rowsByPlayer.get(row.playerId);
    if (rows === undefined) rowsByPlayer.set(row.playerId, new Map([[row.turn, row]]));
    else rows.set(row.turn, row);
  }
  const used = new Set<string>();

  for (const event of events) {
    if (event.type !== 'TechResearched') continue;
    const playerId = Number(event.playerId);
    const rows = rowsByPlayer.get(playerId) ?? new Map<number, TurnMetrics>();
    const turns = [...rows.keys()].sort((left, right) => left - right);

    let placed:
      { readonly turn: number; readonly before: number; readonly after: number } | undefined;
    for (const turn of turns) {
      const key = `${String(playerId)}:${String(turn)}`;
      if (used.has(key)) continue;
      const row = rows.get(turn);
      const previous = rows.get(turn - 1);
      if (row === undefined || previous === undefined) continue;
      const remainder = row.beakers - row.incomeBeakers;
      if (previous.beakers - event.cost !== remainder) continue;
      if (remainder !== event.beakers) continue;
      placed = { turn, before: previous.beakers, after: row.beakers };
      used.add(key);
      break;
    }

    if (placed === undefined) {
      disagreements.push(
        `player ${String(event.playerId)} researched ${String(event.tech)} for ` +
          `${String(event.cost)} beakers leaving ${String(event.beakers)}, but no sampled turn ` +
          `satisfies pool(t - 1) - cost === pool(t) - income(t) === ${String(event.beakers)}, so ` +
          `the charge cannot be placed on the trail`,
      );
      continue;
    }

    completions.push({
      turn: placed.turn,
      playerId,
      tech: String(event.tech),
      cost: event.cost,
      remainder: event.beakers,
      poolBefore: placed.before,
      poolAfter: placed.after,
      ledgerAgrees: true,
    });
  }

  return { completions, disagreements };
};

/* ------------------------------------------------------------------ *
 * The runs
 * ------------------------------------------------------------------ */

const settingsFor = (seed: number): Settings => {
  const loaded = loadSettings({ seed });
  if (!loaded.ok) {
    throw new Error(
      `tech-balance-sweep: settings: ${loaded.error.map((issue) => issue.message).join('; ')}`,
    );
  }
  return loaded.value;
};

/**
 * Play one seed exactly as `runSimulation`'s loop does, sampling the rows this script
 * needs a *turn* for.
 *
 * The loop is the runner's, restated with the runner's own `policyRngFor` for the policy
 * context and the runner's own boundary rule (`EndTurn` is the runner's, not the
 * policy's). `runSeed` runs the same seed through `runSimulation` and compares the two:
 * the comparison, not this function's existence, is what makes the reading trustworthy.
 */
const replaySeed = (
  seed: number,
  settings: Settings,
  ruleset: Ruleset,
  maxTurns: number,
  sampleEvery: number,
): {
  readonly metrics: readonly TurnMetrics[];
  readonly turnsPlayed: number;
  readonly state: GameState;
  readonly events: readonly GameEvent[];
} => {
  const created = newGame(seed, settings, ruleset);
  if (!created.ok) {
    throw new Error(`tech-balance-sweep: seed ${String(seed)} could not start a game`);
  }

  const policy: Policy = simplePolicy();
  let state: GameState = created.value;
  const metrics: TurnMetrics[] = [];
  const events: GameEvent[] = [];
  let turnsPlayed = 0;

  for (let step = 0; step < maxTurns; step += 1) {
    for (const player of civPlayers(state)) {
      const ctx = {
        state,
        playerId: player.id,
        ruleset,
        rng: policyRngFor(seed, player.id, state.turn),
      };
      for (const command of policy.chooseCommands(ctx)) {
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, ruleset);
        if (!outcome.ok) continue;
        state = outcome.value.state;
      }
    }
    const advanced = advanceTurn(state, ruleset);
    state = advanced.state;
    events.push(...advanced.events);
    turnsPlayed += 1;
    if ((turnsPlayed - 1) % sampleEvery === 0) {
      metrics.push(...sampleTurn(state, ruleset, advanced.events));
    }
  }

  return { metrics, turnsPlayed, state, events };
};

/** One seed under one variant: the engine's run, this script's replay, and the check. */
const runSeed = (
  seed: number,
  ruleset: Ruleset,
  maxTurns: number,
  sampleEvery: number,
): SeedRun => {
  const settings = settingsFor(seed);
  const policy = simplePolicy();
  const result = runSimulation({
    seed,
    settings,
    ruleset,
    policies: [policy, policy],
    maxTurns,
    ...(sampleEvery === 1 ? {} : { sampleEvery }),
  });

  const replayed = replaySeed(seed, settings, ruleset, maxTurns, sampleEvery);
  const detected = readCompletions(replayed.events, replayed.metrics);
  const unattributed: UnattributedStep[] = detected.disagreements.map((reason, index) => ({
    turn: index,
    playerId: 0,
    spent: 0,
    reason,
  }));

  const players: PlayerRun[] = civPlayers(result.finalState).map((player) => {
    const known = [...player.techs].map(String).sort();
    return {
      playerId: Number(player.id),
      cities: result.finalState.cities.filter((city) => city.owner === player.id).length,
      population: result.finalState.cities
        .filter((city) => city.owner === player.id)
        .reduce((total, city) => total + city.population, 0),
      knownTechs: known.length,
      known,
    };
  });

  return {
    seed,
    turnsPlayed: result.turnsPlayed,
    finalHash: result.finalHash,
    stoppedBecause: result.stoppedBecause,
    violations: result.violations.length,
    players,
    completions: detected.completions,
    unattributed,
    replay: {
      turnsPlayed: replayed.turnsPlayed,
      finalHash: replayed.state === result.finalState ? result.finalHash : 'replay-diverged',
      metricRows: replayed.metrics.length,
      finalTurn: replayed.state.turn,
      agrees:
        replayed.turnsPlayed === result.turnsPlayed &&
        replayed.state.turn === result.finalState.turn &&
        replayed.metrics.length === result.metrics.length &&
        replayed.state.players.every((player, index) => {
          const other = result.finalState.players[index];
          return other !== undefined && player.techs.length === other.techs.length;
        }),
    },
  };
};

const meanOf = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
};

/** A key present only when the value is — never a key holding `undefined`. */
const withOptional = <K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V });

const sumOver = (run: SeedRun, of: (player: PlayerRun) => number): number =>
  run.players.reduce((total, player) => total + of(player), 0);

const tallyTechs = (ruleset: Ruleset, runs: readonly SeedRun[]): readonly TechTally[] =>
  ruleset.techs.map((tech) => {
    const id = String(tech.id);
    const turns: number[] = [];
    for (const run of runs) {
      for (const completion of run.completions) {
        if (completion.tech === id) turns.push(completion.turn);
      }
    }
    turns.sort((left, right) => left - right);
    return {
      id,
      name: tech.name,
      cost: tech.cost,
      completedIn: turns.length,
      turns,
      ...withOptional('meanTurn', meanOf(turns)),
    };
  });

const runVariant = (
  multiplier: number,
  seeds: readonly number[],
  turns: number,
  sampleEvery: number,
): Variant => {
  // The catalog is scaled directly, **not** through `applyOverrides`, because the
  // override merge drops the `techs` section (see `overrideProbe`). `patchFor` is still
  // asked for its patch so the one line that would change is visible beside the call it
  // would replace, and the record it would have produced is what `overrideRecord` holds.
  const scaled = scaleTechCosts(CATALOG, multiplier);
  // Asked so that the one line a fix would change is visible beside the call it would
  // replace, and so the report can say what the override path *would* have recorded.
  const patch: RulesetPatch = patchFor();
  const validated = validateRuleset(scaled, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `tech-balance-sweep: the x${String(multiplier)} catalog does not validate: ` +
        validated.error.map((issue) => issue.kind).join('; '),
    );
  }
  const ruleset: Ruleset = validated.value;

  const runs = seeds.map((seed) => runSeed(seed, ruleset, turns, sampleEvery));
  const control = multiplier === 1;
  return {
    label: control ? `x${String(multiplier)} (control)` : `x${String(multiplier)}`,
    multiplier,
    costs: ruleset.techs.map((tech) => ({
      id: String(tech.id),
      name: tech.name,
      shipped: shippedTechRow(tech.id).cost,
      scaled: tech.cost,
    })),
    // What `applyOverrides` recorded for the patch this variant would send — the empty
    // record, and the reason the missing-section line is printed beside it:
    // `applyOverrides` reports `applied` as the fields a patch *named*, and an empty patch
    // names none. Saying so is the point, so the record is asked of the module rather than
    // written down here.
    overrideRecord:
      (applyOverrides(CATALOG, patch) as { readonly applied?: readonly string[] }).applied ?? [],
    seeds: runs,
    runs: runs.length,
    ...withOptional(
      'meanKnownTechs',
      meanOf(runs.map((run) => sumOver(run, (player) => player.knownTechs))),
    ),
    ...withOptional('meanCities', meanOf(runs.map((run) => sumOver(run, (p) => p.cities)))),
    ...withOptional(
      'meanPopulation',
      meanOf(runs.map((run) => sumOver(run, (player) => player.population))),
    ),
    techs: tallyTechs(ruleset, runs),
  };
};

/* ------------------------------------------------------------------ *
 * Build the report
 * ------------------------------------------------------------------ */

const buildReport = (flags: Flags, seeds: readonly number[]): TechSweepReport => {
  const settings = settingsFor(seeds[0] ?? 1);
  const variants = flags.values.map((value) =>
    runVariant(value, seeds, flags.turns, flags.sampleEvery),
  );

  const violations: string[] = [];
  for (const variant of variants) {
    for (const run of variant.seeds) {
      if (run.violations > 0) {
        violations.push(
          `${variant.label} seed ${String(run.seed)}: ${String(run.violations)} invariant ` +
            `violation(s), run stopped as "${run.stoppedBecause}" after ${String(run.turnsPlayed)} turns`,
        );
      }
      if (!run.replay.agrees) {
        violations.push(
          `${variant.label} seed ${String(run.seed)}: the replay disagrees with runSimulation — ` +
            `runSimulation ${String(run.turnsPlayed)} turns / ${run.finalHash}; replay ` +
            `${String(run.replay.turnsPlayed)} turns / ${run.replay.finalHash}`,
        );
      }
      for (const step of run.unattributed) {
        violations.push(
          `${variant.label} seed ${String(run.seed)} player ${String(step.playerId)} turn ` +
            `${String(step.turn)}: ${String(step.spent)} beakers were spent but ${step.reason}`,
        );
      }
    }
  }

  const caveats: string[] = [];
  if (flags.sampleEvery !== 1) {
    caveats.push(
      `--sample-every ${String(flags.sampleEvery)}: the beaker trail has gaps, so the completion ` +
        `turns below are sampled turns and not necessarily the engine's own turn numbers`,
    );
  }
  const gap = overrideProbe();
  const report: TechSweepReport = {
    knob: flags.knob,
    seedSpec: flags.seedSpec,
    seeds,
    turns: flags.turns,
    sampleEvery: flags.sampleEvery,
    mapSize: settings.mapSize,
    civCount: settings.civCount,
    policy: simplePolicy().name,
    shippedTechs: CATALOG.techs.map((tech) => ({
      id: String(tech.id),
      name: tech.name,
      shipped: tech.cost,
      scaled: tech.cost,
    })),
    ...withOptional('overrideGap', gap),
    variants,
    violations,
    caveats,
  };
  return report;
};

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

const fixed = (value: number, places: number): string => value.toFixed(places);

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

const padStart = (text: string, width: number): string =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text;

const renderReport = (report: TechSweepReport): string => {
  const lines: string[] = [];
  lines.push(`TECH BALANCE SWEEP — knob ${report.knob}`);
  lines.push(
    `experiment: seeds ${report.seedSpec} (${String(report.seeds.length)} runs per value), ` +
      `${String(report.turns)} turns, ${report.mapSize}, ${String(report.civCount)} civs, ` +
      `policy "${report.policy}", sample every ${String(report.sampleEvery)}`,
  );
  lines.push('');

  // The tree as shipped, before any scaling: the rows the knob multiplies.
  lines.push('the shipped technology tree (the knob multiplies these costs)');
  lines.push(`  ${pad('tech', 18)}${padStart('cost', 5)}  ${pad('researched by', 12)}provenance`);
  for (const tech of report.shippedTechs) {
    const row = shippedTechRow(tech.id);
    lines.push(
      `  ${pad(tech.id, 18)}${padStart(String(tech.shipped), 5)}  ${pad('', 12)}${row.provenance}`,
    );
  }
  lines.push('');

  if (report.overrideGap !== undefined) {
    lines.push(`OVERRIDE SURFACE: ${report.overrideGap}`);
    lines.push('');
  }

  // The main table: one row per knob value, the tech timeline across its top.
  const techIds = report.variants[0]?.techs.map((tech) => tech.id) ?? [];
  const header = [
    pad('value', 16),
    padStart('known', 6),
    padStart('cities', 7),
    padStart('pop', 5),
    ...techIds.map((id) => padStart(id.slice(0, 9), 10)),
  ].join(' ');
  lines.push('what the knob moved (mean over the runs of each value)');
  lines.push(`  ${header}`);
  for (const variant of report.variants) {
    const cells = [
      pad(variant.label, 16),
      padStart(variant.meanKnownTechs === undefined ? '-' : fixed(variant.meanKnownTechs, 1), 6),
      padStart(variant.meanCities === undefined ? '-' : fixed(variant.meanCities, 1), 7),
      padStart(variant.meanPopulation === undefined ? '-' : fixed(variant.meanPopulation, 1), 5),
      ...variant.techs.map((tech) =>
        padStart(
          tech.meanTurn === undefined
            ? '-'
            : `${fixed(tech.meanTurn, 1)}/${String(tech.completedIn)}`,
          10,
        ),
      ),
    ];
    lines.push(`  ${cells.join(' ')}`);
  }
  lines.push(
    '  (per-tech cells are "mean completion turn / runs that completed it", over ' +
      `${String(report.variants[0]?.runs ?? 0)} runs per value; "-" means no run completed it)`,
  );
  lines.push('');

  // Per-seed completions, so the mean above can be checked rather than trusted.
  lines.push('the same measurement per run (turn each technology completed on)');
  for (const variant of report.variants) {
    for (const run of variant.seeds) {
      const turns = run.completions
        .map((completion) => `${completion.tech}@${String(completion.turn)}`)
        .join(' ');
      lines.push(
        `  ${pad(`${variant.label} seed ${String(run.seed)}`, 26)}` +
          `${padStart(`known ${String(run.players.reduce((n, p) => n + p.knownTechs, 0))}`, 10)}  ` +
          `${padStart(`cities ${String(run.players.reduce((n, p) => n + p.cities, 0))}`, 11)}  ` +
          `${padStart(`pop ${String(run.players.reduce((n, p) => n + p.population, 0))}`, 8)}  ` +
          (turns === '' ? '(nothing researched)' : turns),
      );
    }
  }
  lines.push('');

  if (report.violations.length > 0) {
    lines.push(
      `VIOLATIONS (${String(report.violations.length)}) — the table above is not evidence`,
    );
    for (const violation of report.violations) lines.push(`  ${violation}`);
    lines.push('');
  }
  for (const caveat of report.caveats) lines.push(`CAVEAT: ${caveat}`);
  if (report.caveats.length > 0) lines.push('');

  return lines.join('\n');
};

/* ------------------------------------------------------------------ *
 * Does the knob prove anything?
 * ------------------------------------------------------------------ */

/**
 * Whether any measured figure moved with the knob.
 *
 * This is the report's own guard against printing a table that *looks* like evidence: a
 * knob whose variants produce identical timelines, identical tech counts and identical
 * boards has demonstrated nothing about the game, whatever the table's shape. The
 * comparison is against the first variant, and every field compared is one the table
 * prints.
 */
const measurableEffect = (report: TechSweepReport): boolean => {
  const first = report.variants[0];
  if (first === undefined) return false;
  const signature = (variant: Variant): string =>
    JSON.stringify([
      variant.meanKnownTechs,
      variant.meanCities,
      variant.meanPopulation,
      variant.techs.map((tech) => [tech.id, tech.turns]),
      variant.seeds.map((run) =>
        run.completions.map((completion) => [completion.tech, completion.turn]),
      ),
    ]);
  const baseline = signature(first);
  return report.variants.some((variant) => signature(variant) !== baseline);
};

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const main = (): number => {
  const parsed = parseFlags(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let seeds: readonly number[];
  try {
    seeds = parseSeeds(parsed.flags.seedSpec);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const report = buildReport(parsed.flags, seeds);

  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
    if (!measurableEffect(report)) {
      process.stdout.write(
        'NO MEASURABLE EFFECT: every value in the grid produced the same timelines, the same ' +
          'technology counts and the same board, so this sweep proves nothing about the knob. ' +
          'A wider grid, more turns, or a different knob is what would.\n',
      );
    }
  }

  return report.violations.length > 0 ? 1 : 0;
};

process.exitCode = main();
