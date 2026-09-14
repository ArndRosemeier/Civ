/**
 * P2's own instrument: **is the outcome aggregate honest, and is it order-independent?**
 *
 * The tournament report's new `totals.outcomes` block is a fold over the games. P1 wrote it;
 * this probe is the verifier's independent read of it, and it asks four questions the report's
 * own tests cannot ask of themselves:
 *
 * 1. **Does a permuted seed list change anything?** Two whole tournaments are played, one with
 *    the seeds ascending and one scrambled, and the *whole* result is compared — the census,
 *    the per-game outcomes and the final hashes.
 * 2. **Is the census independent of the order it is handed the games in?** The aggregate is
 *    re-run over the same `(game, seat-plan)` **pairs** in a different order, which is the
 *    question "does an aggregate whose order depends on iteration order" is really about — a
 *    permuted seed list does not test it, because the harness sorts the list before it starts.
 * 3. **Does an independent recount agree?** Condition counts, wins by seat and draws are counted
 *    here from the per-game records, from scratch, and compared with the report's own block.
 * 4. **Is the "no outcome" bucket really the turn-limit games?** Cross-checked against each
 *    game's own `stoppedBecause` and `turnsPlayed`, not trusted.
 *
 * The fixture is chosen for one property: its games **end**, cheaply. `smart` against the
 * do-nothing control on a `duel` map reaches conquest in tens of turns, so a census with
 * non-zero rows is available at a cost a verifier can pay repeatedly. What it demonstrates is
 * stated rather than implied: it shows the *fold* is honest over deciding games, and nothing
 * about how two real AIs play each other — that is the 20-seed evidence run's job.
 *
 * Usage: `npx tsx scripts/probes/outcome-aggregate-probe.ts`
 */

import { DEFAULT_SETTINGS } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  DO_NOTHING_POLICY,
  SMART_POLICY,
  outcomeDistributionOf,
  runTournament,
  seatPlan,
  type Policy,
  type SimulationResult,
  type TournamentOutcomeDistribution,
  type TournamentResult,
} from '@civts/sim';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const ASCENDING: readonly number[] = [1, 2, 3, 4, 5, 6];
const SCRAMBLED: readonly number[] = [6, 3, 1, 5, 2, 4];
const TURNS = 80;
const policies: readonly Policy[] = [SMART_POLICY, DO_NOTHING_POLICY];

const run = (seeds: readonly number[]): TournamentResult =>
  runTournament({
    seeds,
    settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
    ruleset,
    policies,
    maxTurns: TURNS,
  });

const gameLine = (result: TournamentResult): string =>
  result.games
    .map((game) => {
      const outcome = game.outcome;
      const ending =
        outcome === undefined
          ? 'none'
          : `${outcome.condition}/${
              outcome.winner === null ? 'draw' : String(Number(outcome.winner))
            }/t${String(outcome.turn)}`;
      return `${String(game.seed)}:${game.stoppedBecause}:${String(game.turnsPlayed)}:${ending}:${game.finalHash}`;
    })
    .join('\n  ');

/** A recount of the census, written here, from the per-game records alone. */
interface Recount {
  readonly ended: number;
  readonly noOutcome: number;
  readonly byCondition: readonly (readonly [string, number])[];
  readonly bySeat: readonly (readonly [number, number])[];
  readonly draws: number;
  readonly noOutcomeNotMaxTurns: readonly number[];
  readonly noOutcomeWrongTurns: readonly number[];
  readonly endedNotGameOver: readonly number[];
  readonly gameOverNotEnded: readonly number[];
}

const recount = (games: readonly SimulationResult[]): Recount => {
  const conditions = new Map<string, number>();
  const seats = new Map<number, number>();
  let ended = 0;
  let draws = 0;
  const noOutcomeNotMaxTurns: number[] = [];
  const noOutcomeWrongTurns: number[] = [];
  const endedNotGameOver: number[] = [];
  const gameOverNotEnded: number[] = [];

  for (const game of games) {
    const outcome = game.outcome;
    if (outcome === undefined) {
      if (game.stoppedBecause !== 'max-turns') noOutcomeNotMaxTurns.push(game.seed);
      if (game.turnsPlayed !== TURNS) noOutcomeWrongTurns.push(game.seed);
      continue;
    }
    ended += 1;
    if (game.stoppedBecause !== 'game-over') endedNotGameOver.push(game.seed);
    conditions.set(outcome.condition, (conditions.get(outcome.condition) ?? 0) + 1);
    if (outcome.winner === null) {
      draws += 1;
    } else {
      const seat = Number(outcome.winner);
      seats.set(seat, (seats.get(seat) ?? 0) + 1);
    }
  }
  for (const game of games) {
    if (game.stoppedBecause === 'game-over' && game.outcome === undefined) {
      gameOverNotEnded.push(game.seed);
    }
  }

  return {
    ended,
    noOutcome: games.length - ended,
    byCondition: [...conditions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    bySeat: [...seats.entries()].sort((a, b) => a[0] - b[0]),
    draws,
    noOutcomeNotMaxTurns,
    noOutcomeWrongTurns,
    endedNotGameOver,
    gameOverNotEnded,
  };
};

const report = (census: TournamentOutcomeDistribution): string =>
  [
    `games ${String(census.games)} ended ${String(census.endedGames)} ` +
      `no-outcome ${String(census.noOutcomeGames)}`,
    `conditions ${census.conditions
      .map(
        (row) => `${row.condition}=${String(row.games)}/${String(row.wins)}w/${String(row.draws)}d`,
      )
      .join(' ')}`,
    `seats ${census.seats.map((seat) => `${String(seat.seat)}=${String(seat.wins)}`).join(' ')}`,
    `stop reasons ${census.stopReasons
      .map((row) => `${row.stoppedBecause}=${String(row.games)}`)
      .join(' ')}`,
  ].join('; ');

const lines: string[] = [];

/* 1. A permuted seed list must change nothing at all. */
const ascending = run(ASCENDING);
const scrambled = run(SCRAMBLED);

lines.push('1. PERMUTED SEED LIST');
lines.push(`  ascending seeds  ${ASCENDING.join(',')}`);
lines.push(`  scrambled seeds  ${SCRAMBLED.join(',')}`);
lines.push(`  games (ascending, seed order as reported)`);
lines.push(`  ${gameLine(ascending)}`);
lines.push(`  games (scrambled)`);
lines.push(`  ${gameLine(scrambled)}`);
lines.push(`  per-game records identical   ${String(gameLine(ascending) === gameLine(scrambled))}`);
lines.push(
  `  census identical             ${String(
    JSON.stringify(ascending.totals.outcomes) === JSON.stringify(scrambled.totals.outcomes),
  )}`,
);
lines.push(`  census                       ${report(ascending.totals.outcomes)}`);

/* 2. The aggregate, re-run over the same pairs in a different order. */
const plan = seatPlan(policies.length, ascending.games.length);
const pairs = ascending.games.map((game, index) => ({ game, seats: plan[index] }));
const order = [3, 0, 5, 1, 4, 2];
const permutedGames: SimulationResult[] = [];
const permutedPlan: (readonly number[])[] = [];
let permuteFault = '';
for (const index of order) {
  const pair = pairs[index];
  if (pair === undefined || pair.seats === undefined) {
    permuteFault = `the fixture has no game ${String(index)}`;
    break;
  }
  permutedGames.push(pair.game);
  permutedPlan.push(pair.seats);
}

const permutedCensus =
  permuteFault === '' ? outcomeDistributionOf(permutedGames, permutedPlan, policies) : undefined;

lines.push('');
lines.push('2. PERMUTED AGGREGATE INPUT ORDER (the same games, handed over in another order)');
lines.push(`  permutation index order      ${order.join(',')}`);
lines.push(
  `  census identical             ${
    permutedCensus === undefined
      ? permuteFault
      : String(JSON.stringify(permutedCensus) === JSON.stringify(ascending.totals.outcomes))
  }`,
);

/* 3. An independent recount of the same games. */
lines.push('');
lines.push('3. INDEPENDENT RECOUNT (this script, from the per-game records)');
for (const [label, result] of [
  ['ascending', ascending],
  ['scrambled', scrambled],
] as const) {
  const counted = recount(result.games);
  const census = result.totals.outcomes;
  const sameConditions =
    JSON.stringify(counted.byCondition) ===
    JSON.stringify(
      census.conditions
        .filter((row) => row.games > 0)
        .map((row): readonly [string, number] => [row.condition, row.games])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
  const sameSeats =
    JSON.stringify(counted.bySeat) ===
    JSON.stringify(
      census.seats
        .filter((seat) => seat.wins > 0)
        .map((seat): readonly [number, number] => [seat.seat, seat.wins])
        .sort((a, b) => a[0] - b[0]),
    );
  lines.push(
    `  ${label}: ended ${String(counted.ended)} / no-outcome ${String(counted.noOutcome)}`,
  );
  lines.push(`    conditions match the report   ${String(sameConditions)}`);
  lines.push(`    wins by seat match the report ${String(sameSeats)}`);
  lines.push(
    `    draws agree                   ${String(counted.draws === census.conditions.reduce((total, row) => total + row.draws, 0))}`,
  );
}

/* 4. The no-outcome bucket, cross-checked per game. */
lines.push('');
lines.push('4. THE "NO OUTCOME" BUCKET, CROSS-CHECKED PER GAME');
for (const [label, result] of [
  ['ascending', ascending],
  ['scrambled', scrambled],
] as const) {
  const counted = recount(result.games);
  lines.push(
    `  ${label}: no outcome but stop !== max-turns ${JSON.stringify(counted.noOutcomeNotMaxTurns)}; ` +
      `no outcome but turnsPlayed !== ${String(TURNS)} ${JSON.stringify(counted.noOutcomeWrongTurns)}; ` +
      `ended but stop !== game-over ${JSON.stringify(counted.endedNotGameOver)}; ` +
      `game-over but no outcome ${JSON.stringify(counted.gameOverNotEnded)}`,
  );
}

lines.push('');
lines.push(
  `budget ms ${String(ascending.budgetMs)} elapsed ms ${String(Math.round(ascending.elapsedMs))}`,
);
lines.push(
  `violations ${String(ascending.violations.length)} planner failures ${String(ascending.plannerFailures.length)}`,
);

process.stdout.write(`${lines.join('\n')}\n`);
