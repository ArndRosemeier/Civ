/**
 * PROBE — not an assertion. Derives the terrain palette the art actually paints.
 *
 *   CIVTS_PALETTE_PROBE=1 npx playwright test --config playwright.config.ts \
 *     e2e/terrain-palette-probe.spec.ts
 *
 * Why this exists: `TERRAIN_COLOURS` in `src/render.ts` is the colour the renderer
 * *documents* for each terrain, and the e2e suite samples the painted canvas and checks it
 * against that documentation. The sprite commit changed what gets painted without changing
 * the documentation, so the two drifted apart and two tests failed. Adopting the art means
 * deriving the palette from the pixels.
 *
 * It sweeps seeds rather than one game, because a seeded start explores a patch of roughly
 * 6x6 tiles and one patch holds two or three terrains, not six. Only the public seam is
 * used — `seed`, `state`, the canvas — so what this measures is what a player would see.
 *
 * It prints, per terrain: the mean painted centre, the worst tile's distance from that mean,
 * and the pairwise distance between terrains. The spread is what a tolerance has to cover;
 * the separation is what stops that tolerance from making the check vacuous.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  cameraOf,
  canvasBox,
  colourDistance,
  humanPlayerId,
  mapCanvas,
  openApp,
  seedApp,
  terrainAtTile,
  tileCentre,
  tileIsClear,
  visibleTiles,
  type Rgb,
} from './helpers.js';

/**
 * Starting patches hold two terrains each, so the sweep is what finds all six — and the
 * mountains need naming explicitly: only 39 of the first 2500 `tiny` seeds put a mountain inside
 * the starting visibility radius; `MOUNTAIN_SEEDS` is that list, all 39 of them. Found with the engine
 * rather than by guessing: for each seed, count `state.map.terrain[tile]` over the tiles where
 * `state.explored[player][tile]` is true.
 *
 * Every seed is swept. An earlier version stopped as soon as all six terrains had appeared,
 * which for this list happened before the mountain seeds were reached — so mountains rested on
 * 3 tiles and two of the six means were off by a point. See `docs/KNOWN-ISSUES.md` 3.12.
 */
const MOUNTAIN_SEEDS = [
  75, 123, 173, 209, 306, 329, 397, 422, 442, 528, 586, 590, 678, 693, 770, 898, 921, 1006, 1044,
  1052, 1092, 1132, 1168, 1218, 1298, 1299, 1341, 1468, 1680, 1713, 1782, 1933, 1965, 1977, 2121,
  2154, 2277, 2322, 2482,
];
const SEEDS = [...Array.from({ length: 40 }, (_, index) => index + 1), ...MOUNTAIN_SEEDS];

/** One canvas read for many points: a per-tile `evaluate` would be thousands of round trips. */
const samplePoints = async (
  page: Page,
  points: readonly { x: number; y: number }[],
): Promise<Rgb[]> =>
  (await mapCanvas(page)).evaluate((element, pts) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('no canvas');
    const context = element.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    const rect = element.getBoundingClientRect();
    return pts.map((point) => {
      const x = Math.floor((point.x * element.width) / rect.width);
      const y = Math.floor((point.y * element.height) / rect.height);
      const data = context.getImageData(x, y, 1, 1).data;
      return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 };
    });
  }, points);

test('PROBE: derive the painted terrain palette', async ({ page }) => {
  test.skip(
    process.env['CIVTS_PALETTE_PROBE'] !== '1',
    'opt-in probe: set CIVTS_PALETTE_PROBE=1 to run',
  );

  await openApp(page);
  const box = await canvasBox(page);
  const byTerrain = new Map<string, Rgb[]>();

  for (const seed of SEEDS) {
    const state = await seedApp(page, seed);
    const camera = await cameraOf(page);
    const player = humanPlayerId(state);

    const points: { x: number; y: number }[] = [];
    const tiles: number[] = [];
    for (const tile of visibleTiles(state, camera, box)) {
      if (!tileIsClear(state, tile)) continue;
      if (state.explored[player]?.[tile] !== true) continue;
      points.push(tileCentre(camera, tile % state.map.width, Math.floor(tile / state.map.width)));
      tiles.push(tile);
    }
    if (points.length === 0) continue;
    const colours = await samplePoints(page, points);
    colours.forEach((colour, index) => {
      const tile = tiles[index];
      if (tile === undefined || colour.a !== 255) return;
      const terrain = terrainAtTile(state, tile);
      const bucket = byTerrain.get(terrain) ?? [];
      bucket.push(colour);
      byTerrain.set(terrain, bucket);
    });
    // No early exit on purpose: stopping once all six terrains appear is what capped the
    // mountains at n=3, because the first mountain seed arrives before the ones collected for
    // their mountains. Every seed in the list is swept.
  }

  const mean = (values: number[]): number =>
    Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  const rows: {
    terrain: string;
    n: number;
    centre: Rgb;
    worst: number;
    pairwise: number;
    hex: string;
  }[] = [];
  for (const [terrain, samples] of [...byTerrain].sort((a, b) => a[0].localeCompare(b[0]))) {
    const centre: Rgb = {
      r: mean(samples.map((c) => c.r)),
      g: mean(samples.map((c) => c.g)),
      b: mean(samples.map((c) => c.b)),
      a: 255,
    };
    const worst = Math.max(...samples.map((c) => colourDistance(c, centre)));
    // The largest gap between any TWO tiles of this terrain: what "two tiles of the same
    // terrain agree" can legitimately mean once a terrain is a texture rather than a fill.
    let pairwise = 0;
    for (let i = 0; i < samples.length; i += 1) {
      for (let j = i + 1; j < samples.length; j += 1) {
        const a = samples[i];
        const b = samples[j];
        if (a === undefined || b === undefined) continue;
        const d = colourDistance(a, b);
        if (d > pairwise) pairwise = d;
      }
    }
    const hex = `#${[centre.r, centre.g, centre.b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`;
    rows.push({ terrain, n: samples.length, centre, worst, pairwise, hex });
  }

  console.log('\n--- painted terrain palette (default zoom, Manhattan distance) ---');
  for (const row of rows) {
    console.log(
      `${row.terrain.padEnd(11)} n=${String(row.n).padStart(4)}  ` +
        `mean=rgb(${String(row.centre.r)},${String(row.centre.g)},${String(row.centre.b)})  ` +
        `${row.hex}  worst-offset=${row.worst.toFixed(1)}  max-pairwise=${String(row.pairwise)}`,
    );
  }

  console.log('\n--- pairwise distance between terrain means ---');
  let closest = Number.POSITIVE_INFINITY;
  let closestPair = '';
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (a === undefined || b === undefined) continue;
      const d = colourDistance(a.centre, b.centre);
      if (d < closest) {
        closest = d;
        closestPair = `${a.terrain}/${b.terrain}`;
      }
      console.log(`${a.terrain.padEnd(11)} vs ${b.terrain.padEnd(11)} ${d.toFixed(1)}`);
    }
  }

  const worstSpread = Math.max(...rows.map((r) => r.worst));
  console.log(
    `\nterrains found: ${String(rows.length)}; closest pair ${closestPair} at ` +
      `${closest.toFixed(1)}; largest within-terrain spread ${worstSpread.toFixed(1)}`,
  );
  console.log(`headroom = ${(closest / worstSpread).toFixed(2)}x`);
  expect(rows.length).toBeGreaterThan(0);
});
