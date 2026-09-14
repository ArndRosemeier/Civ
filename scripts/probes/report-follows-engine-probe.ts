/**
 * P2's probe: **does the report's condition follow the engine's rule when the rule moves?**
 *
 * The claim under test is the one P1's documentation makes: the condition and the winner in a
 * tournament report are the engine's own `gameOutcomeOf` answer, carried through the runner, and
 * are **never re-derived** in the report path. Reading the source is one way to check it; this
 * probe checks it behaviourally, because a second implementation of the victory rule that happened
 * to agree on the shipped catalog would pass a reading and fail this.
 *
 * The method is a falsification. The catalog's cultural threshold is moved out of reach through
 * the same `applyOverrides` surface the balance sweeps use, and the same seed is played twice:
 *
 * - under the shipped catalog the game ends `cultural` on turn 152 (measured);
 * - under the patched one it cannot, so the report must name something else.
 *
 * If the report were re-deriving the condition from a hard-coded threshold, or from any input
 * other than the engine's own read of the board, the first row would survive the patch. It does
 * not. On top of that, every game's reported condition is compared with `gameOutcomeOf` called
 * here, on the game's own `finalState` — an independent read of the board in this process.
 *
 * Usage: `npx tsx scripts/probes/report-follows-engine-probe.ts`
 */

import { DEFAULT_SETTINGS, gameOutcomeOf } from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { SMART_POLICY, applyOverrides, runTournament } from '@civts/sim';

const base = validateRuleset(CATALOG, 'tuned');
if (!base.ok) throw new Error('the shipped catalog does not validate');
const patchedCatalog = validateRuleset(
  applyOverrides(CATALOG, { victory: { culturalVictoryCulture: 1_000_000 } }),
  'tuned',
);
if (!patchedCatalog.ok) throw new Error('the patched catalog does not validate');

const lines: string[] = [];

const play = (label: string, ruleset: Ruleset): void => {
  const result = runTournament({
    seeds: [1],
    settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 },
    ruleset,
    policies: [SMART_POLICY, SMART_POLICY],
    maxTurns: 200,
  });
  for (const game of result.games) {
    const reported = game.outcome;
    const fromBoard = gameOutcomeOf(game.finalState, ruleset);
    lines.push(
      `  ${label}: stopped ${game.stoppedBecause} after ${String(game.turnsPlayed)} turns; ` +
        `report says ${reported === undefined ? 'no outcome' : `${reported.condition} / winner ${String(reported.winner === null ? 'none' : Number(reported.winner))} / turn ${String(reported.turn)}`}; ` +
        `gameOutcomeOf on the final state says ` +
        (fromBoard === null
          ? 'no outcome'
          : `${fromBoard.condition} / winner ${String(fromBoard.winner === null ? 'none' : Number(fromBoard.winner))}`),
    );
    const agrees =
      reported === undefined
        ? fromBoard === null
        : fromBoard !== null &&
          fromBoard.condition === reported.condition &&
          fromBoard.winner === reported.winner;
    lines.push(`    the two agree: ${String(agrees)}`);
    lines.push(
      `    violations ${String(game.violations.length)}, planner failures ${String(game.plannerFailures.length)}`,
    );
  }
  lines.push(
    `    census ${result.totals.outcomes.conditions
      .map((row) => `${row.condition}=${String(row.games)}`)
      .join(' ')}`,
  );
};

lines.push('seed 1, tiny, 2 civs, smart in both seats, 200 turns');
play('shipped catalog', base.value);
play('culturalVictoryCulture = 1,000,000', patchedCatalog.value);

process.stdout.write(`${lines.join('\n')}\n`);
