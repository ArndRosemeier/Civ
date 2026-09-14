/**
 * P2's probe: **how many invariant checks does a run really perform?**
 *
 * The two structured reports (`civts sim`, `civts tournament`) carry an `invariants.checks` field,
 * and the A3 evidence quotes it as the denominator for "zero violations" — 86,975 checks in the
 * 20-seed, 150-turn run.
 *
 * **This probe was written to measure a defect that has since been repaired (P2's F2).** Then, the
 * runner's loop read the game-over condition *before* it ran the registry and broke on the turn
 * that ended the game, so a game decided by a victory condition had its final turn counted as
 * checked while it was handed to no predicate; both reports derived the figure as
 * `turnsPlayed * invariantCount` and over-reported by `invariantCount` per decided game. The
 * registry now runs **before** the game-over break (`runner.ts`) and both reports **count** what
 * ran instead of deriving it, so the numbers below are expected to agree.
 *
 * The instrument is unchanged, because that is exactly what makes it worth keeping: a one-invariant
 * registry whose `check` records every turn it is handed is installed in a run, and the turns it saw
 * are compared with `turnsPlayed` **by measurement rather than by reading the loop**. `skipped 0`
 * on every line is the repaired behaviour; a non-zero `skipped` is F2 coming back, and the closing
 * lines print the comparison the defect was about rather than a remembered verdict about it.
 *
 * Both arms are measured, because the claim is about the difference between them:
 * a game that ends by a **condition** and a game that ends at the **turn limit**.
 *
 * Usage: `npx tsx scripts/probes/invariant-check-count-probe.ts`
 */

import { DEFAULT_SETTINGS } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  DO_NOTHING_POLICY,
  SMART_POLICY,
  runSimulation,
  type Invariant,
  type Policy,
} from '@civts/sim';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

let seen: number[] = [];
const counter: Invariant = {
  name: 'p2-check-counter',
  description: 'counts the turns the registry is really handed (a P2 verification instrument)',
  check: (ctx) => {
    seen.push(ctx.turn);
    return [];
  },
};

const lines: string[] = [];
lines.push(
  'a game decided by a VICTORY CONDITION (smart vs the do-nothing control, duel, 80 turns)',
);

/** One measured run: what it played, and what the registry was really handed. */
interface Reading {
  readonly seed: number;
  readonly stopped: string;
  readonly turnsPlayed: number;
  readonly checks: number;
  readonly skipped: number;
}

const decidedRuns: Reading[] = [];
for (const seed of [1, 2, 3]) {
  seen = [];
  const result = runSimulation({
    seed,
    settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
    ruleset,
    policies: [SMART_POLICY, DO_NOTHING_POLICY],
    maxTurns: 80,
    invariants: [counter],
  });
  const ending = result.outcome;
  const reading: Reading = {
    seed,
    stopped: result.stoppedBecause,
    turnsPlayed: result.turnsPlayed,
    checks: seen.length,
    skipped: result.turnsPlayed - seen.length,
  };
  decidedRuns.push(reading);
  lines.push(
    `  seed ${String(seed)}: ${reading.stopped}, turnsPlayed ${String(reading.turnsPlayed)}, ` +
      `outcome ${ending === undefined ? 'none' : `${ending.condition} on turn ${String(ending.turn)}`}, ` +
      `checks really run ${String(reading.checks)}, ` +
      `the derived figure would be ${String(reading.turnsPlayed)} ` +
      `(turnsPlayed x 1 invariant), ` +
      `skipped ${String(reading.skipped)}, turns seen ${seen.join(',')}`,
  );
}

lines.push('');
lines.push('a game stopped by the TURN LIMIT (nobody has a command, 5 turns)');
seen = [];
const idle: readonly Policy[] = [DO_NOTHING_POLICY, DO_NOTHING_POLICY];
const limited = runSimulation({
  seed: 5,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
  ruleset,
  policies: idle,
  maxTurns: 5,
  invariants: [counter],
});
lines.push(
  `  stopped ${limited.stoppedBecause}, turnsPlayed ${String(limited.turnsPlayed)}, ` +
    `checks really run ${String(seen.length)}, skipped ${String(limited.turnsPlayed - seen.length)}, ` +
    `turns seen ${seen.join(',')}`,
);

// The closing claim is **computed from the readings above**, never restated: the line this used to
// print asserted the pre-repair arithmetic ("35 checks over-reported per decided game") while its
// own `skipped 0` column said the opposite, which is a printed claim contradicting the measurement
// beside it. The arithmetic below is the same one at the shipped registry size of 35.
const SHIPPED_REGISTRY_SIZE = 35;
const skippedTotal = decidedRuns.reduce((total, run) => total + run.skipped, 0);
const overReported = skippedTotal * SHIPPED_REGISTRY_SIZE;

lines.push('');
lines.push(
  'what the reports report for the same runs, at the shipped registry size of 35 ' +
    '(the figure is counted, not derived, since Q1/F2):',
);
lines.push(
  `  decided runs measured: ${String(decidedRuns.length)}, each of ${decidedRuns
    .map((run) => String(run.turnsPlayed))
    .join('/')} played turns; turns handed to no predicate: ${String(skippedTotal)}`,
);
if (overReported === 0) {
  lines.push(
    `  so on these runs a derived total (turnsPlayed x 35) and the counted one agree exactly: ` +
      `0 checks over-reported, and the real count is ` +
      `${String(decidedRuns.reduce((total, run) => total + run.checks, 0) * SHIPPED_REGISTRY_SIZE)} ` +
      `against a derived ` +
      `${String(decidedRuns.reduce((total, run) => total + run.turnsPlayed, 0) * SHIPPED_REGISTRY_SIZE)}.`,
  );
} else {
  lines.push(
    `  so a derived total (turnsPlayed x 35) would over-report by ${String(overReported)} checks ` +
      `across these runs — the deciding turn is not reaching the registry, which is P2's F2 ` +
      `defect returning.`,
  );
}
lines.push(
  '  history: before the repair the registry ran *after* the game-over break, and the deciding ' +
    'turn of a decided game was handed to no predicate, so those runs were over-reported by ' +
    'exactly 35 checks each. That is what the `skipped` column exists to detect; today it reads 0.',
);

process.stdout.write(`${lines.join('\n')}\n`);
