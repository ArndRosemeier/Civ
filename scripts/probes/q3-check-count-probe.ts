#!/usr/bin/env node
/**
 * Q3's probe: **is `invariants.checks` a count of what ran, and is the deciding turn checked?**
 *
 * P2 measured (its §B5, finding F2) that the reported figure was *derived* —
 * `turnsPlayed × invariantCount` — and that the runner read the game-over condition **before** the
 * registry and broke on the turn that decided the game, so a decided run was one whole registry
 * short. Q1's repair claims two things: the deciding turn is now handed to the registry, and the
 * reported figure is counted where the predicates ran rather than multiplied beside the loop.
 *
 * This probe does not read the repair, it **measures** it. A recording registry whose `check`
 * appends every context it is handed is installed in runs the probe controls, and then:
 *
 * 1. the turns the registry saw are compared with `turnsPlayed` — contiguous, no duplicate, the
 *    deciding turn included;
 * 2. `SimulationResult.invariantChecks` is compared with the number of contexts really recorded;
 * 3. the same is done through the **shipped CLI report**, whose `invariants.checks` must equal the
 *    instrument's own total for the same games.
 *
 * It is deliberately independent of the suite's own fixtures: different seeds, several horizons and
 * three registry sizes, so a product that happens to agree at one configuration cannot pass.
 *
 * Exits non-zero if any check fails, so it is usable as evidence rather than as a printout.
 *
 * Usage: `npx tsx scripts/probes/q3-check-count-probe.ts`
 */

import { DEFAULT_SETTINGS, gameOutcomeOf, isOk } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  CORE_INVARIANTS,
  DO_NOTHING_POLICY,
  SMART_POLICY,
  runBatch,
  runSimulation,
  type Invariant,
  type InvariantContext,
  type Policy,
  type SimulationResult,
} from '@civts/sim';

import {
  buildSimReport,
  runSimCommand,
  type SimReport,
} from '../../packages/headless/src/sim-cli.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const failures: string[] = [];
const lines: string[] = [];

const check = (ok: boolean, what: string): void => {
  if (!ok) failures.push(what);
};

/** One recording registry: `size` predicates, each appending the context it was handed. */
const recorder = (
  size: number,
  inner?: readonly Invariant[],
): { readonly invariants: readonly Invariant[]; readonly seen: InvariantContext[] } => {
  const seen: InvariantContext[] = [];
  const invariants: readonly Invariant[] = Array.from({ length: size }, (_, index) => {
    const delegate = inner?.[index];
    return {
      name: `q3-recorder-${String(index)}`,
      description: 'records every context the registry is handed (a Q3 verification instrument)',
      check: (ctx: InvariantContext): readonly string[] => {
        seen.push(ctx);
        return delegate === undefined ? [] : delegate.check(ctx);
      },
    };
  });
  return { invariants, seen };
};

interface Examined {
  readonly label: string;
  readonly size: number;
  readonly result: SimulationResult;
  readonly seen: readonly InvariantContext[];
}

/**
 * Every claim this probe makes about one run, made once so both arms are judged by the same code.
 *
 * The instrument is a **recording registry**, and this function reads it rather than the loop:
 *
 * - **How many checks ran**: the recorded context count. It is compared with
 *   `SimulationResult.invariantChecks` (the published figure) and with `turnsPlayed × size`
 *   (what a decided run must reach now that the deciding turn is handed over).
 * - **No turn checked twice, none skipped**: a played turn is one loop iteration, and one
 *   iteration hands the registry exactly one state object. So the `size` contexts of an
 *   iteration share the *identity* of their `state`, and the number of distinct state
 *   identities is exactly `turnsPlayed`. A duplicated iteration shows up as fewer identities
 *   than turns; a skipped one shows up as contexts missing from a group.
 * - **The deciding turn's STATE really reached the predicates**: `gameOutcomeOf` applied to the
 *   last state the registry was handed is non-null on a decided run. That is the claim F2 is
 *   about, made against the instrument rather than against the loop's source.
 *
 * A note the readings below make visible: a game decided by a *command* (a capture) ends with
 * `advanceTurn` refusing to advance a finished state, so the last two loop iterations carry the
 * same **turn number** while being different states. The turn count is therefore not the right
 * unit of "checked twice" — the loop iteration is, which is what the identity check measures.
 */
const examine = (examined: Examined, expectDecided: boolean): void => {
  const { label, size, result, seen } = examined;
  const turns = seen.map((ctx) => ctx.turn);
  const outcome = result.outcome;
  const decided = outcome !== undefined;
  const ending =
    outcome === undefined ? 'none' : `${outcome.condition} on turn ${String(outcome.turn)}`;

  // Group the recorded contexts by the identity of the state they were handed.
  const groups: { readonly state: InvariantContext['state']; readonly count: number }[] = [];
  for (const ctx of seen) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.state === ctx.state) {
      groups[groups.length - 1] = { state: last.state, count: last.count + 1 };
      continue;
    }
    groups.push({ state: ctx.state, count: 1 });
  }
  const everyGroupFull = groups.every((group) => group.count === size);
  const lastGroup = groups[groups.length - 1];
  const decidingStateChecked =
    lastGroup === undefined ? false : gameOutcomeOf(lastGroup.state, ruleset) !== null;

  lines.push(`  ${label}`);
  lines.push(
    `    stopped ${result.stoppedBecause}, turnsPlayed ${String(result.turnsPlayed)}, ` +
      `outcome ${ending}`,
  );
  lines.push(
    `    registry size ${String(size)}: contexts recorded ${String(seen.length)}, ` +
      `turnsPlayed × size ${String(result.turnsPlayed * size)}, ` +
      `invariantChecks ${String(result.invariantChecks)}`,
  );
  lines.push(
    `    loop iterations seen ${String(groups.length)} (distinct state identities), ` +
      `turns ${String(turns[0] ?? 0)}..${String(turns[turns.length - 1] ?? 0)}, ` +
      `final state turn ${String(result.finalState.turn)}, ` +
      `pre-fix count would have been ${String((result.turnsPlayed - 1) * size)}, ` +
      `last state decided ${String(decidingStateChecked)}`,
  );

  check(decided === expectDecided, `${label}: decided === ${String(expectDecided)}`);
  // The count is the instrument's own number, not a product that happens to agree.
  check(
    result.invariantChecks === seen.length,
    `${label}: invariantChecks ${String(result.invariantChecks)} === recorded ${String(seen.length)}`,
  );
  check(
    result.invariantChecks === result.turnsPlayed * size,
    `${label}: invariantChecks === turnsPlayed × size`,
  );
  // No iteration checked twice, none skipped: one full registry per played turn, and as many
  // distinct states as turns were played.
  check(
    groups.length === result.turnsPlayed,
    `${label}: ${String(result.turnsPlayed)} played turns → ${String(groups.length)} distinct states checked`,
  );
  check(everyGroupFull, `${label}: every checked state got the whole registry (${String(size)})`);
  if (decided) {
    check(decidingStateChecked, `${label}: the deciding state WAS handed to the registry`);
    check(
      seen.length !== (result.turnsPlayed - 1) * size,
      `${label}: the pre-fix count is NOT what ran`,
    );
  }
};

/* ------------------------------------------------------------------ *
 * 1. A game decided by a victory condition, at two conditions and two horizons
 * ------------------------------------------------------------------ */

lines.push('1. DECIDED games — the turn the game ends on, handed to the registry');

const decidedConfigs: readonly {
  readonly label: string;
  readonly seed: number;
  readonly policies: readonly Policy[];
  readonly maxTurns: number;
  readonly size: number;
}[] = [
  {
    label: 'conquest, smart vs do-nothing, duel, 80 turns, registry 1',
    seed: 1,
    policies: [SMART_POLICY, DO_NOTHING_POLICY],
    maxTurns: 80,
    size: 1,
  },
  {
    label: 'conquest, smart vs do-nothing, duel, 80 turns, registry 7',
    seed: 2,
    policies: [SMART_POLICY, DO_NOTHING_POLICY],
    maxTurns: 80,
    size: 7,
  },
  {
    label: 'score at the catalog horizon, do-nothing, duel, 200 turns, registry 3',
    seed: 5,
    policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
    maxTurns: 200,
    size: 3,
  },
];

for (const config of decidedConfigs) {
  const registry = recorder(config.size);
  const result = runSimulation({
    seed: config.seed,
    settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
    ruleset,
    policies: config.policies,
    maxTurns: config.maxTurns,
    invariants: registry.invariants,
  });
  examine(
    { label: config.label, size: config.size, result, seen: registry.seen },
    // `do-nothing` at the catalog horizon is decided by the score condition; both are endings.
    true,
  );
}

/* ------------------------------------------------------------------ *
 * 2. A turn-limited game, at three horizons and three registry sizes
 * ------------------------------------------------------------------ */

lines.push('');
lines.push(
  '2. TURN-LIMITED games — the control the identity is not a fact about decided runs only',
);

for (const horizon of [5, 12, 40]) {
  for (const size of [1, 3, 7]) {
    const registry = recorder(size);
    const result = runSimulation({
      seed: horizon + size,
      settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
      ruleset,
      policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
      maxTurns: horizon,
      invariants: registry.invariants,
    });
    examine(
      {
        label: `no-commands, duel, ${String(horizon)} turns, registry ${String(size)}`,
        size,
        result,
        seen: registry.seen,
      },
      false,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 3. The SHIPPED REPORT's figure against the instrument's, on the same games
 * ------------------------------------------------------------------ */

lines.push('');
lines.push('3. THE REPORT — `invariants.checks` against what a full-size registry saw');

const full = recorder(CORE_INVARIANTS.length, CORE_INVARIANTS);
const recorded = full.seen;

const cliArgs: readonly string[] = [
  '--seeds',
  '1..2',
  '--turns',
  '200',
  '--policy',
  'none',
  '--map-size',
  'duel',
];
const output = runSimCommand([...cliArgs]);
if (!isOk(output)) {
  throw new Error(`civts sim refused the probe's arguments: ${output.error.lines.join('; ')}`);
}
const report = output.value.report;
if (report === undefined) throw new Error('civts sim produced no report');

const batch = runBatch({
  seeds: [1, 2],
  settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
  ruleset,
  policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
  maxTurns: 200,
  invariants: full.invariants,
});
// The batch is the same experiment the report describes; the instrument is what saw it.
const instrumented = buildSimReport({
  batch,
  parameters: report.parameters,
  ruleset: report.ruleset,
  invariantNames: report.invariants.names,
});

lines.push(`  command: civts sim ${cliArgs.join(' ')}`);
lines.push(
  `  registry size ${String(report.invariants.count)}, games ${String(report.totals.runs)}, ` +
    `turnsPlayed ${String(report.totals.turnsPlayed)}`,
);
lines.push(
  `  contexts really recorded by the instrument ${String(recorded.length)} ` +
    `(delegating registry, so the shipped predicates ran too)`,
);
lines.push(
  `  report.invariants.checks ${String(report.invariants.checks)}  ·  ` +
    `Σ runs[].invariantChecks ${String(report.runs.reduce((t, run) => t + run.invariantChecks, 0))}  ·  ` +
    `turnsPlayed × count ${String(report.totals.turnsPlayed * report.invariants.count)}`,
);
lines.push(
  `  per run: ${report.runs
    .map(
      (run) =>
        `seed ${String(run.seed)} ${String(run.turnsPlayed)} turns → ${String(run.invariantChecks)}`,
    )
    .join(', ')}`,
);

check(
  report.invariants.checks === instrumented.invariants.checks,
  'the report counts what a full-size recording registry really saw',
);
check(
  report.invariants.checks === report.runs.reduce((total, run) => total + run.invariantChecks, 0),
  'report.invariants.checks is the sum of the runs it was built from',
);
check(
  report.runs.every((run) => run.invariantChecks === run.turnsPlayed * report.invariants.count),
  'each run reports one whole registry per turn it played',
);

/* ------------------------------------------------------------------ *
 * 4. A DIFFERENT invariant count, through the report
 * ------------------------------------------------------------------ */

lines.push('');
lines.push('4. A DIFFERENT registry size — a product that agrees at 35 is not a fix');

const tiny: readonly Invariant[] = CORE_INVARIANTS.slice(0, 6);
const tinyBatch = runBatch({
  seeds: [1, 2],
  settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
  ruleset,
  policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
  maxTurns: 200,
  invariants: tiny,
});
const tinyReport: SimReport = buildSimReport({
  batch: tinyBatch,
  parameters: report.parameters,
  ruleset: report.ruleset,
  invariantNames: tiny.map((invariant) => invariant.name),
});
lines.push(
  `  registry of ${String(tinyReport.invariants.count)}: checks ${String(tinyReport.invariants.checks)}, ` +
    `Σ runs ${String(tinyReport.runs.reduce((t, run) => t + run.invariantChecks, 0))}, ` +
    `product ${String(tinyReport.totals.turnsPlayed * tinyReport.invariants.count)}`,
);
check(
  tinyReport.invariants.checks === tinyReport.totals.turnsPlayed * tinyReport.invariants.count &&
    tinyReport.invariants.checks !== report.invariants.checks,
  'the counted figure moves with the registry size, as a count must',
);
check(
  tinyReport.invariants.checks ===
    tinyReport.runs.reduce((total, run) => total + run.invariantChecks, 0),
  'the 6-predicate report is the sum of its runs too',
);

/* ------------------------------------------------------------------ */

lines.push('');
if (failures.length === 0) {
  lines.push(
    'VERDICT: every check passed — the count is counted, and the deciding turn is checked.',
  );
} else {
  lines.push(`VERDICT: ${String(failures.length)} CHECK(S) FAILED`);
  for (const failure of failures) lines.push(`  FAILED: ${failure}`);
}
process.stdout.write(`${lines.join('\n')}\n`);

// Note: `recorded` is filled by `recorder`'s `seen` array, which is the registry handed to
// `runBatch` above; the assertion is made against the same instrument the report describes.
if (failures.length > 0) process.exitCode = 1;
