/**
 * Probe: is the seat asymmetry visible in the STARTING POSITIONS?
 * One turn, do-nothing policies: the world's starts and the tile each seat sits on.
 *
 * ## Where this file came from (P2)
 *
 * This is P1's probe, **relocated** from the repository root (`p1-probe-starts.ts`) by the P2
 * verifier. It sat at the root, outside `tsconfig.json`'s `include`, so `pnpm verify` was RED on
 * it twice over: eslint's project service refused the file ("not found by the project service"),
 * and prettier reported a style issue. It had also never been typechecked, which is why it
 * imported `terrainDef` — a name `@civts/core` does not export — for twenty seeds of nothing.
 * Moved here (where `scripts` is in the typechecker's `include`) and its dead import
 * removed; the body is otherwise P1's, and `scripts/` is deliberately outside the determinism
 * guard (`eslint.config.js`), as its sibling sweeps are.
 */
import { DEFAULT_SETTINGS, civPlayers, terrainAtIndex } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { DO_NOTHING_POLICY, runSimulation } from '@civts/sim';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('bad ruleset');
const ruleset = validated.value;

type Row = {
  seed: number;
  seat: number;
  tile: number;
  role: string;
  food: number;
  shields: number;
  commerce: number;
};
const rows: Row[] = [];
for (let seed = 1; seed <= 20; seed += 1) {
  const result = runSimulation({
    seed,
    settings: { ...DEFAULT_SETTINGS, seed, mapSize: 'tiny', civCount: 2 },
    ruleset,
    policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
    maxTurns: 1,
  });
  for (const player of civPlayers(result.finalState)) {
    const tile = Number(player.startingTile);
    const terrainId = terrainAtIndex(result.finalState.map, tile);
    const terrain = ruleset.terrains.find((row) => row.id === terrainId);
    if (terrain === undefined) throw new Error('no terrain');
    rows.push({
      seed,
      seat: Number(player.id),
      tile,
      role: terrain.role,
      food: terrain.yields.food,
      shields: terrain.yields.shields,
      commerce: terrain.yields.commerce,
    });
  }
}
const sum = (seat: number, key: 'food' | 'shields' | 'commerce'): number =>
  rows.filter((r) => r.seat === seat).reduce((t, r) => t + r[key], 0);
for (const seat of [0, 1]) {
  const mine = rows.filter((r) => r.seat === seat);
  console.log(
    `seat ${String(seat)}: food ${String(sum(seat, 'food'))} shields ` +
      `${String(sum(seat, 'shields'))} commerce ${String(sum(seat, 'commerce'))}` +
      ` roles ${JSON.stringify(
        mine.reduce<Record<string, number>>((acc, r) => {
          acc[r.role] = (acc[r.role] ?? 0) + 1;
          return acc;
        }, {}),
      )}`,
  );
}
console.log(
  'per seed:',
  rows
    .map(
      (r) =>
        `${String(r.seed)}:s${String(r.seat)}=${r.role}/${String(r.food)}${String(r.shields)}` +
        String(r.commerce),
    )
    .join(' '),
);
