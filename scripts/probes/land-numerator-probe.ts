/**
 * R1's probe: **is the domination numerator's land-versus-water reading observable?**
 *
 * **Written before R1's repair, and kept as the instrument that justified it.** At the time,
 * `dominationWinner` (`packages/core/src/victory.ts`) divided `ownedLandCount(player)` — every
 * tile the player's cities claim, water included — by `landTileCount(map, ruleset)`, the map's
 * land. Every document stated the rule as a share of the map's **land**, so the all-terrain
 * numerator was either a latent divergence or a distinction without a difference. R1 ruled it a
 * divergence and made the engine divide `ownedLandTiles` (the land-filtered numerator, R2
 * re-read at `victory.ts:268`); the readings below are what that decision rests on, and they
 * have not moved.
 *
 * This probe measures, instead of arguing. Four questions, in the order printed:
 *
 * 1. **What does a claim look like?** Every tile of a real generated map's borders, split into
 *    land and water — the geometric disc of `computeTileOwner` has no terrain filter, so a
 *    coastal city claims its bay.
 * 2. **Do the two readings ever differ in play?** For AI-played games, how many water tiles sit
 *    inside a civilization's borders in the final state — `ownedLandCount` against
 *    `ownedLandTiles`, per player.
 * 3. **Would a verdict have moved?** The domination land half evaluated both ways on those
 *    states, at the shipped threshold *and* at the smallest legal one.
 * 4. **What about the hand-built fixture?** The board `m9-m10-adversarial.test.ts` demonstrates
 *    domination on, with the greatest threshold each reading satisfies.
 *
 * Read the two counts as: a row where `owned == ownedLand` says the readings coincide on *that*
 * state, and a nonzero difference says they do not. The engine's numerator is the land-only one,
 * so what these numbers establish is the **magnitude** of the difference and that no verdict
 * observed in play turned on it — not that the distinction has gone away.
 *
 * Usage: `npx tsx scripts/probes/land-numerator-probe.ts`
 */

import {
  DEFAULT_SETTINGS,
  applyCommand,
  asCityId,
  asTileIndex,
  civPlayers,
  isWaterRole,
  landTileCount,
  newGame,
  terrainAtIndex,
  withOwnership,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { SMART_POLICY, applyOverrides, runSimulation } from '@civts/sim';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset: Ruleset = validated.value;

/** Is the tile at `index` land, by the ruleset's own terrain rows? `landTileCount`'s rule. */
const isLand = (state: GameState, view: RulesetView, index: number): boolean => {
  const terrain = terrainAtIndex(state.map, index);
  if (terrain === undefined) return false;
  const def = view.terrains.find((row) => row.id === terrain);
  return def !== undefined && !isWaterRole(def.role);
};

/** What one player's border is made of: the rule's numerator, both readings. */
interface BorderReading {
  readonly player: PlayerId;
  readonly owned: number;
  readonly ownedLand: number;
  readonly water: number;
}

const bordersOf = (state: GameState, view: RulesetView): readonly BorderReading[] =>
  civPlayers(state).map((player) => {
    let owned = 0;
    let ownedLand = 0;
    for (let index = 0; index < state.tileOwner.length; index += 1) {
      if (state.tileOwner[index] !== Number(player.id)) continue;
      owned += 1;
      if (isLand(state, view, index)) ownedLand += 1;
    }
    return { player: player.id, owned, ownedLand, water: owned - ownedLand };
  });

const lines: string[] = [];

/* ---- 1. What a claim looks like ------------------------------------- */

lines.push('1. CLAIMS ON REAL GENERATED MAPS (a geometric disc, no terrain filter)');
for (const [mapSize, seed] of [
  ['tiny', 42],
  ['duel', 1],
] as const) {
  const run = runSimulation({
    seed,
    settings: { ...DEFAULT_SETTINGS, mapSize, civCount: 2 },
    ruleset,
    policies: [SMART_POLICY, SMART_POLICY],
    maxTurns: 60,
  });
  const state = run.finalState;
  const land = landTileCount(state.map, ruleset);
  const total = state.map.width * state.map.height;
  lines.push(
    `  ${mapSize} seed ${String(seed)}, after ${String(run.turnsPlayed)} turns: ` +
      `${String(land)} land of ${String(total)} tiles (${String(
        Math.round((land * 1000) / total) / 10,
      )} % land, the rule's denominator)`,
  );
  for (const reading of bordersOf(state, ruleset)) {
    lines.push(
      `    player ${String(reading.player)}: owns ${String(reading.owned)} tiles ` +
        `(${String(reading.ownedLand)} land + ${String(reading.water)} water), ` +
        `land share ${reading.ownedLand === 0 ? '0' : String(Math.round((reading.ownedLand * 1000) / land) / 10)} % ` +
        `of the map's land`,
    );
  }
}

/* ---- 2. Does it ever reach an AI-played game? ----------------------- */

const GAMES = 8;
const TURNS = 200;
lines.push('');
lines.push(
  `2. WATER INSIDE BORDERS AT THE END OF ${String(GAMES)} AI-PLAYED GAMES ` +
    `(tiny, seeds 1..${String(GAMES)}, smart vs smart, ${String(TURNS)} turns)`,
);
let gamesWithWater = 0;
let playersWithWater = 0;
let waterTotal = 0;
let ownedTotal = 0;
let ownedLandTotal = 0;
let decided = 0;
for (let seed = 1; seed <= GAMES; seed += 1) {
  const run = runSimulation({
    seed,
    settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 },
    ruleset,
    policies: [SMART_POLICY, SMART_POLICY],
    maxTurns: TURNS,
  });
  const readings = bordersOf(run.finalState, ruleset);
  const water = readings.reduce((totalWater, reading) => totalWater + reading.water, 0);
  ownedTotal += readings.reduce((totalOwned, reading) => totalOwned + reading.owned, 0);
  ownedLandTotal += readings.reduce((totalLand, reading) => totalLand + reading.ownedLand, 0);
  waterTotal += water;
  playersWithWater += readings.filter((reading) => reading.water > 0).length;
  if (water > 0) gamesWithWater += 1;
  const outcome = run.outcome;
  if (outcome !== undefined) decided += 1;
  lines.push(
    `  seed ${String(seed)}: ${String(run.turnsPlayed)} turns, ` +
      `${outcome === undefined ? 'no outcome' : `${outcome.condition} (player ${String(outcome.winner)})`}, ` +
      `borders ${readings
        .map((reading) => `${String(reading.ownedLand)}+${String(reading.water)}w`)
        .join(' / ')}`,
  );
}
lines.push(
  `  totals: ${String(gamesWithWater)} of ${String(GAMES)} games and ` +
    `${String(playersWithWater)} borders hold at least one water tile; ` +
    `${String(waterTotal)} water tiles across ${String(ownedTotal)} owned tiles ` +
    `(${String(ownedLandTotal)} land). ${String(decided)} of ${String(GAMES)} games ended.`,
);

/* ---- 3. Would the verdict move on those states? --------------------- */

lines.push('');
lines.push('3. THE DOMINATION ARM, BOTH READINGS OF THE NUMERATOR');

/** Would the land half hold with this numerator, at `pct` of the map's land? */
const landHalfHolds = (
  state: GameState,
  view: RulesetView,
  numerator: number,
  pct: number,
): boolean => numerator * 100 >= pct * landTileCount(state.map, view);

for (let seed = 1; seed <= GAMES; seed += 1) {
  const run = runSimulation({
    seed,
    settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 },
    ruleset,
    policies: [SMART_POLICY, SMART_POLICY],
    maxTurns: TURNS,
  });
  const state = run.finalState;
  const land = landTileCount(state.map, ruleset);
  for (const reading of bordersOf(state, ruleset)) {
    // The shipped threshold, and the smallest legal one — a hand-built fixture's `1`, where a
    // 45-versus-20 tile difference is the difference between a satisfied half and a refused one.
    const shippedBoth = landHalfHolds(state, ruleset, reading.owned, 60);
    const shippedLand = landHalfHolds(state, ruleset, reading.ownedLand, 60);
    const anyBoth = landHalfHolds(state, ruleset, reading.owned, 1);
    const anyLand = landHalfHolds(state, ruleset, reading.ownedLand, 1);
    if (shippedBoth !== shippedLand || anyBoth !== anyLand) {
      lines.push(
        `  seed ${String(seed)} player ${String(reading.player)}: **the verdict moves** — ` +
          `land ${String(land)}; at 60 % all-tiles ${String(shippedBoth)} vs land-only ${String(shippedLand)}, ` +
          `at 1 % ${String(anyBoth)} vs ${String(anyLand)}`,
      );
    }
  }
}
const verdictMoves = lines.filter((line) => line.includes('the verdict moves')).length;
lines.push(
  `  land halves the all-tiles and land-only readings disagree on, over these ${String(GAMES)} ` +
    `AI-played games: ${String(verdictMoves)}` +
    (verdictMoves === 0
      ? ' — so at these thresholds the filter changes no verdict on a real board'
      : ''),
);

/* ---- 4. The hand-built board domination is demonstrated on ----------- */

/**
 * `m9-m10-adversarial.test.ts`'s domination fixture, rebuilt here field for field: the board
 * the AMENDMENT names when it says domination "is demonstrated only on hand-built boards with
 * patched thresholds". This is the one place in the suite where the land half of the rule is
 * *reached*, so it is the place a numerator change would show up as a different boundary.
 */
lines.push('');
lines.push(
  '4. THE m9-m10 DOMINATION FIXTURE (tiny seed 9, thresholds patched to land 1 % / pop 50 %)',
);

const wide = { borderRadius2Culture: 1, borderRadius3Culture: 2 };
const fixtureRules: Ruleset = (() => {
  const patched = validateRuleset(
    applyOverrides(CATALOG, {
      culture: wide,
      victory: { dominationLandPct: 1, dominationPopPct: 50 },
    }),
    'tuned',
  );
  if (!patched.ok) throw new Error('the patched catalog does not validate');
  return patched.value;
})();

/**
 * Rebuild the fixture board for one seed, and report both readings of its numerator.
 *
 * `m9-m10-adversarial.test.ts` demonstrates domination on **two** such boards — seed 9 (the
 * boundary walk at its own threshold) and seed 47 (the `winnerOf` demonstration that the
 * condition ends a game) — so both are measured: a numerator change that moved either one is a
 * change to the evidence, whether or not the test that reads it still passes.
 */
const fixtureReading = (seed: number): string => {
  const settings = { ...DEFAULT_SETTINGS, seed, mapSize: 'tiny', civCount: 2 } as const;
  const started = newGame(seed, settings, ruleset);
  if (!started.ok) throw new Error(`newGame(${String(seed)}) failed`);
  const firstCiv = civPlayers(started.value)[0];
  if (firstCiv === undefined) throw new Error('the fixture has no civilization 0');
  const settler = started.value.units.find(
    (unit) => unit.owner === firstCiv.id && unit.type === 'settler',
  );
  if (settler === undefined) throw new Error('the fixture player has no settler');
  const found = applyCommand(
    started.value,
    firstCiv.id,
    { type: 'FoundCity', unitId: settler.id },
    ruleset,
  );
  if (!found.ok) throw new Error('the fixture city was refused');
  // Culture 2 puts the city at radius 3 under the patched table, and re-materialises the layer.
  const grown = withOwnership(
    {
      ...found.value.state,
      cities: found.value.state.cities.map((city) => ({ ...city, culture: 2 })),
    },
    fixtureRules,
  );
  const centre = grown.cities[0];
  const rival = civPlayers(grown)[1];
  if (centre === undefined || rival === undefined)
    throw new Error('the fixture board is incomplete');
  const both = withOwnership(
    {
      ...grown,
      cities: [
        ...grown.cities,
        {
          ...centre,
          id: asCityId(Number(centre.id) + 200),
          owner: rival.id,
          tile: asTileIndex(Number(centre.tile) + 6),
        },
      ],
    },
    fixtureRules,
  );

  const land = landTileCount(both.map, fixtureRules);
  let owned = 0;
  let ownedLand = 0;
  for (let index = 0; index < both.tileOwner.length; index += 1) {
    if (both.tileOwner[index] !== Number(firstCiv.id)) continue;
    owned += 1;
    if (isLand(both, fixtureRules, index)) ownedLand += 1;
  }
  /** The greatest whole percentage of the map's land a numerator satisfies. */
  const maxPct = (numerator: number): number => {
    let best = 0;
    for (let pct = 1; pct <= 100; pct += 1) if (numerator * 100 >= pct * land) best = pct;
    return best;
  };
  const maxBoth = maxPct(owned);
  const maxLand = maxPct(ownedLand);
  return (
    `  seed ${String(seed)}: player 0 holds ${String(owned)} tiles ` +
    `(${String(ownedLand)} land + ${String(owned - ownedLand)} water) of ${String(land)} land tiles; ` +
    `greatest land threshold satisfied — all-tiles ${String(maxBoth)} %, land-only ${String(maxLand)} % ` +
    `(the fixture patches the threshold to 1 %, so the boundary is ` +
    `${maxBoth === maxLand ? 'unchanged' : 'MOVED BY ' + String(maxBoth - maxLand) + ' POINT(S)'})`
  );
};

for (const seed of [9, 47]) lines.push(fixtureReading(seed));
lines.push(
  '  (both are read by m9-m10-adversarial.test.ts: seed 9 walks the land boundary, seed 47 ' +
    'shows domination ending a game — the numbers are reported here so a moved boundary is ' +
    'visible even though the tests derive them from the engine and would still pass)',
);

process.stdout.write(`${lines.join('\n')}\n`);
