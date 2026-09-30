import { expect, test } from '@playwright/test';
import {
  asResourceId,
  asTerrainId,
  asTileIndex,
  asImprovementId,
  DEFAULT_SETTINGS,
  newGame,
  type GameState,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { openApp } from './helpers.js';

const rules = validateRuleset(CATALOG, 'tuned');
if (!rules.ok) throw new Error('Invalid shipped rules');
const game = newGame(21, { ...DEFAULT_SETTINGS, civCount: 2 }, rules.value);
if (!game.ok) throw new Error('Cannot create artwork fixture');

/** A presentation fixture containing every supported terrain and map object. */
const width = 12;
const height = 8;
const tile = (x: number, y: number) => asTileIndex(y * width + x);
const fixture: GameState = {
  ...game.value,
  map: {
    width,
    height,
    terrain: Array.from({ length: width * height }, (_, i) => {
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < 2 || (x < 4 && y < 2)) return asTerrainId('ocean');
      if (x < 3 || (x < 5 && y < 2)) return asTerrainId('coast');
      if (x >= 9 && y < 4) return asTerrainId('mountains');
      if (x >= 7 && y < 3) return asTerrainId('hills');
      return asTerrainId(y >= 5 ? 'plains' : 'grassland');
    }),
    huts: [tile(4, 2)],
    resources: [
      { tile: tile(9, 1), resource: asResourceId('iron') },
      { tile: tile(8, 4), resource: asResourceId('horses') },
      { tile: tile(7, 1), resource: asResourceId('gems') },
      { tile: tile(6, 5), resource: asResourceId('wines') },
      { tile: tile(4, 6), resource: asResourceId('wheat') },
      { tile: tile(2, 4), resource: asResourceId('fish') },
    ],
  },
  explored: game.value.players.map(() => Array<boolean>(width * height).fill(true)),
  tileOwner: Array<number>(width * height).fill(-1),
  improvements: [
    ...Array.from({ length: 7 }, (_, x) => ({
      tile: tile(x + 4, 3),
      kind: asImprovementId('road'),
    })),
    { tile: tile(6, 4), kind: asImprovementId('road') },
    { tile: tile(5, 5), kind: asImprovementId('road') },
    { tile: tile(7, 2), kind: asImprovementId('mine') },
    { tile: tile(4, 4), kind: asImprovementId('irrigation') },
    { tile: tile(4, 5), kind: asImprovementId('irrigation') },
  ],
};

test('terrain edges, map objects, artwork coverage and fog isolation', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(
    async ({ state, cities }) => {
      const terrainUrl = '/src/terrain-art.ts';
      const tilesUrl = '/src/tiles.ts';
      const mapUrl = '/src/map-art.ts';
      const renderUrl = '/src/render.ts';
      const unitsUrl = '/src/units.ts';
      const { createTerrainArtwork, terrainNeighbourhood } = (await import(
        terrainUrl
      )) as typeof import('../src/terrain-art.js');
      const { loadTerrainSprites } = (await import(tilesUrl)) as typeof import('../src/tiles.js');
      const { loadMapSprites } = (await import(mapUrl)) as typeof import('../src/map-art.js');
      const { drawFrame } = (await import(renderUrl)) as typeof import('../src/render.js');
      const { loadUnitSprites } = (await import(unitsUrl)) as typeof import('../src/units.js');
      const sprites = await loadTerrainSprites();
      const artwork = createTerrainArtwork(sprites);
      const mapSprites = await loadMapSprites();
      const unitSprites = await loadUnitSprites();
      const canvas = document.createElement('canvas');
      canvas.id = 'artwork-review';
      canvas.width = state.map.width * 64;
      canvas.height = state.map.height * 64;
      canvas.style.cssText = 'display:block;margin:24px auto;max-width:100%;';
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('No canvas');
      const input = {
        state,
        viewer: 0,
        camera: { x: 0, y: 0, zoomNumerator: 2, zoomDenominator: 1 },
        viewport: { width: canvas.width, height: canvas.height },
        units: [],
        cities,
        ownerColour: () => '#d6a65b',
        cursor: null,
        sprites,
        terrainArtwork: artwork,
        mapSprites,
        unitSprites,
      };
      // The state and marker ids are branded in production; JSON transported to a browser has
      // the same numeric representation, so restore the structural input type at this boundary.
      const frame = drawFrame(ctx as unknown as Parameters<typeof drawFrame>[0], input);
      const pixel = (x: number, y: number): number[] =>
        Array.from(ctx.getImageData(x, y, 1, 1).data);
      const seams: number[] = [];
      for (const [x, y] of [
        [6, 0],
        [9, 0],
        [6, 6],
        [1, 6],
      ]) {
        const a = pixel((x ?? 0) * 64 - 1, (y ?? 0) * 64 + 32);
        const b = pixel((x ?? 0) * 64, (y ?? 0) * 64 + 32);
        seams.push(a.slice(0, 3).reduce((sum, value, c) => sum + Math.abs(value - (b[c] ?? 0)), 0));
      }
      const coast = Array.from({ length: 33 }, (_, i) => pixel(3 * 64 - 16 + i, 4 * 64 + 32));
      const repeat = artwork.tile(terrainNeighbourhood(state, 0, 6, 0), 6, 0);
      const cached = repeat === artwork.tile(terrainNeighbourhood(state, 0, 6, 0), 6, 0);
      const hidden = {
        ...state,
        explored: state.explored.map((row) => row.map((_, i) => i === 4 * state.map.width + 4)),
      };
      const changed = {
        ...hidden,
        map: {
          ...hidden.map,
          terrain: hidden.map.terrain.map((id, i) =>
            i === 4 * state.map.width + 5 ? 'ocean' : id,
          ),
        },
      };
      const fogStable =
        JSON.stringify(terrainNeighbourhood(hidden, 0, 4, 4)) ===
        JSON.stringify(terrainNeighbourhood(changed as GameState, 0, 4, 4));
      for (const [i, id] of ['pikeman', 'medieval-infantry', 'knight'].entries()) {
        const image = unitSprites[id];
        if (image !== undefined) ctx.drawImage(image, (7 + i) * 64 + 8, 3 * 64 + 8, 48, 48);
      }
      document.getElementById('civts-app')?.setAttribute('hidden', '');
      const heading = document.createElement('h1');
      heading.textContent = 'CivTS · Terrain & settlements';
      heading.style.cssText = 'text-align:center;font:18px system-ui;color:#eadcbb;margin:24px 0 0';
      document.body.append(heading, canvas);
      return {
        seams,
        coast,
        cached,
        fogStable,
        features: frame.tiles.flatMap((entry) => entry.features ?? []),
        mapIds: Object.keys(mapSprites),
        unitIds: Object.keys(unitSprites),
      };
    },
    {
      state: fixture,
      cities: [
        { tile: tile(5, 3), colour: '#d6a65b', name: 'Aurelia', population: 2 },
        { tile: tile(7, 5), colour: '#d6a65b', name: 'Ravenna', population: 5 },
        { tile: tile(10, 6), colour: '#7995ce', name: 'Athena', population: 9 },
      ],
    },
  );
  expect(
    result.seams.every((delta) => delta < 35),
    JSON.stringify(result.seams),
  ).toBe(true);
  expect(
    result.coast.some(([r, g, b]) => (r ?? 0) > 170 && (g ?? 0) > 170 && (b ?? 255) < 180),
  ).toBe(true);
  expect(result.cached).toBe(true);
  expect(result.fogStable).toBe(true);
  for (const id of [
    'road',
    'mine',
    'irrigation',
    'hut',
    ...CATALOG.resources.map((resource) => String(resource.id)),
  ]) {
    expect(result.features).toContain(id);
  }
  for (const unit of CATALOG.units) expect(result.unitIds).toContain(unit.id);
  expect(result.mapIds).toEqual(
    expect.arrayContaining(['city-village', 'city-town', 'city-capital']),
  );
  await page.locator('#artwork-review').screenshot({ path: '../../.cache/terrain-review.png' });
});

test('the tactical grid is optional and does not change the game', async ({ page }) => {
  await openApp(page);
  const before = await page.evaluate(() => window.__CIVTS__?.stateHash());
  const grid = page.getByRole('button', { name: 'Grid', exact: true });
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: '../../.cache/map-graphics-review.png' });
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'true');
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__CIVTS__?.stateHash())).toBe(before);
});
