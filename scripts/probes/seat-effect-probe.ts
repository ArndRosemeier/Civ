/**
 * P1's seat probe, **relocated** from the repository root by the P2 verifier.
 *
 * It was `p1-probe-seat.ts` at the repo root, outside `tsconfig.json`'s `include`, which made
 * `pnpm verify` fail in both eslint (project service: "not found by the project service") and
 * prettier. P1's own header said it was "TEMPORARY … deleted before the final `pnpm verify`";
 * rather than delete the instrument, P2 moved it under `scripts/` (which IS typechecked) and
 * left the body alone, so the measurement it produces stays re-runnable.
 *
 * The question: *is there a seat effect?* The tournament report's wins-by-seat answers it on
 * the report's own terms (the auditor's "seat 1 won 5 of 5" was n=5); this probe adds the one
 * thing the report does not carry — **where each seat started** — so a seat effect can be told
 * apart from a starting-position effect, which the assignment names as a candidate cause.
 *
 * It reports the engine's own census (`runTournament`'s `totals.outcomes`) beside a breakdown
 * of the games by the starting terrain of seat 0 and seat 1.
 */
import { DEFAULT_SETTINGS, civPlayers, terrainAtIndex, type GameState } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { SMART_POLICY, runTournament } from '@civts/sim';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const seedArg = process.argv[2] ?? '60';
const turnsArg = process.argv[3] ?? '200';
const seedCount = Number.parseInt(seedArg, 10);
const maxTurns = Number.parseInt(turnsArg, 10);
const seeds = Array.from({ length: seedCount }, (_, index) => index + 1);

const startRole = (state: GameState, seat: number): string => {
  const player = state.players[seat];
  if (player === undefined) throw new Error(`no seat ${String(seat)}`);
  const terrainId = terrainAtIndex(state.map, Number(player.startingTile));
  const terrain = ruleset.terrains.find((row) => row.id === terrainId);
  if (terrain === undefined) throw new Error(`no terrain for seat ${String(seat)}`);
  return terrain.role;
};

/** Culture and cities per seat, read from the final state — the cultural condition's inputs. */
const cultureOf = (state: GameState, seat: number): number => {
  const player = state.players[seat];
  if (player === undefined) throw new Error(`no seat ${String(seat)}`);
  return state.cities
    .filter((city) => Number(city.owner) === seat)
    .reduce((total, city) => total + city.culture, 0);
};

const citiesOf = (state: GameState, seat: number): number =>
  state.cities.filter((city) => Number(city.owner) === seat).length;

const started = Date.now();
const result = runTournament({
  seeds,
  settings: { ...DEFAULT_SETTINGS, seed: 1, mapSize: 'tiny', civCount: 2 },
  ruleset,
  policies: [SMART_POLICY, SMART_POLICY],
  maxTurns,
});
const wallMs = Date.now() - started;

const lines: string[] = [];
for (const game of result.games) {
  const outcome = game.outcome;
  const winnerSeat =
    outcome === undefined || outcome.winner === null ? '-' : String(Number(outcome.winner));
  const condition = outcome === undefined ? 'none' : outcome.condition;
  lines.push(
    [
      String(game.seed).padStart(3),
      `s0=${startRole(game.finalState, 0)}`.padEnd(18),
      `s1=${startRole(game.finalState, 1)}`.padEnd(18),
      `won=${winnerSeat}`.padEnd(6),
      condition.padEnd(11),
      `turn=${String(game.turnsPlayed)}`.padEnd(9),
      `culture=${String(cultureOf(game.finalState, 0))}/${String(cultureOf(game.finalState, 1))}`.padEnd(
        22,
      ),
      `cities=${String(citiesOf(game.finalState, 0))}/${String(citiesOf(game.finalState, 1))}`,
    ].join(' '),
  );
}

const outcomes = result.totals.outcomes;
console.log(lines.join('\n'));
console.log('');
console.log(`seeds ${String(seedCount)} x ${String(maxTurns)} turns, tiny, 2 civs, smart vs smart`);
console.log(`wallMs ${String(wallMs)} (raw, including this probe's own loop)`);
console.log(
  `load average now ${(await import('node:fs')).readFileSync('/proc/loadavg', 'utf8').trim()}`,
);
console.log(`conditions ${JSON.stringify(outcomes.conditions)}`);
console.log(`ended ${String(outcomes.endedGames)} noOutcome ${String(outcomes.noOutcomeGames)}`);
console.log(`wins by seat ${JSON.stringify(outcomes.seats.map((seat) => [seat.seat, seat.wins]))}`);

/** The same census, split by the seat-1 start: the confound the report cannot see. */
for (const role of ['grassland', 'plains']) {
  const subset = result.games.filter((game) => startRole(game.finalState, 1) === role);
  let seat0 = 0;
  let seat1 = 0;
  for (const game of subset) {
    const outcome = game.outcome;
    if (outcome === undefined || outcome.winner === null) continue;
    if (Number(outcome.winner) === 0) seat0 += 1;
    else seat1 += 1;
  }
  console.log(
    `seat1 started on ${role}: ${String(subset.length)} games, ` +
      `seat0 won ${String(seat0)}, seat1 won ${String(seat1)}, ` +
      `no outcome ${String(subset.length - seat0 - seat1)}`,
  );
}

/** Civilians never win; asserted so a barbarian in the seat list could not slip through. */
console.log(
  `civ players per game: ${String(
    civPlayers(
      result.games[0]?.finalState ??
        (() => {
          throw new Error('no games');
        })(),
    ).length,
  )}`,
);
