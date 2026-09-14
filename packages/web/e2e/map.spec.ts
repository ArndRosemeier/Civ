/**
 * W3 — the map: rendering, pan/zoom, pixels, the draw trace and hit-testing.
 * See docs/INTERFACES.md, M8 ("Rendering, and how it is tested (§16.2)") and
 * PLAN.md §16.2.
 *
 * Every assertion here is against one of three authorities, and never against a
 * guess:
 *
 * - the engine's own state, read through `window.__CIVTS__` (`state()`), so a claim
 *   like "that tile is grassland" is the ENGINE's claim;
 * - the app's own projection (`src/view.ts`), so a coordinate this suite computes
 *   is the coordinate the renderer drew and the hit-test inverse-mapped;
 * - the pixels and the draw trace, where the criterion IS the presentation.
 */

import { expect, test } from '@playwright/test';

import {
  bringTileToCentre,
  cameraOf,
  cityDialog,
  foundCity,
  canvasBox,
  clickTile,
  colourDistance,
  describeColour,
  dispatchLog,
  dragMap,
  drawTraceOf,
  humanPlayerId,
  mapDescription,
  openApp,
  pagePointToTile,
  paletteOf,
  parseHexColour,
  readState,
  recordDispatches,
  sampleCanvasPixel,
  sampleTileColour,
  seedApp,
  stateHash,
  terrainAtTile,
  TERRAIN_CENTRE_TOLERANCE,
  TERRAIN_SAME_KIND_TOLERANCE,
  tileCentre,
  tileIsClear,
  tilePagePoint,
  tileX,
  tileY,
  unitActionsGroup,
  unitsOf,
  visibleTiles,
  zoomTo,
  type Rgb,
} from './helpers.js';
import { BASE_TILE_PX, clampCamera, screenToTilePoint, tileScreenPx } from '../src/view.js';

/** A fixed seed, so every claim below is reproducible. */
const SEED = 4242;

/**
 * The seeds this file's palette test sweeps, chosen to cover all six shipped terrains between
 * them. See the comment at the sampling loop: one seed shows three terrains, and the two that
 * were missing were exactly the pair most worth checking.
 */
export const PALETTE_SEEDS = [SEED, 70, 75] as const;
test('A4 map render: the first frame draws tiles, and the draw trace names the tiles and terrains it claims', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  const camera = await cameraOf(page);
  const box = await canvasBox(page);

  const trace = await drawTraceOf(page, state.map.width);
  const size = state.map.width * state.map.height;

  // Non-zero, as the contract requires: a frame that drew nothing is a failure even
  // if the canvas happens to be the colour of the sea.
  expect(trace.length).toBeGreaterThan(0);

  // Every traced tile is on the map, carries the terrain the ENGINE says it does,
  // and is inside the viewport the renderer walked — the trace is a claim about the
  // frame, and a claim about a tile nobody could see would be a stale or invented
  // entry.
  const onScreen = new Set(visibleTiles(state, camera, box));
  for (const entry of trace) {
    expect(entry.tile).toBeGreaterThanOrEqual(0);
    expect(entry.tile).toBeLessThan(size);
    expect(entry.terrain, `trace says tile ${String(entry.tile)} is ${entry.terrain}`).toBe(
      terrainAtTile(state, entry.tile),
    );
    expect(onScreen.has(entry.tile), `tile ${String(entry.tile)} is outside the viewport`).toBe(
      true,
    );
  }

  // The renderer draws what the projection says is visible: every visible tile that
  // the trace covers is one the projection put on screen (the trace may be capped,
  // so containment is asserted in this direction only).
  const drawn = new Set(trace.map((entry) => entry.tile));
  expect(drawn.size).toBe(trace.length);
  expect(drawn.size).toBeLessThanOrEqual(onScreen.size);
});

test('A4 map pan: dragging the map moves the camera and changes which tiles are drawn', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  // Zoom in first so the map is larger than the viewport and panning is possible at
  // all: on a map smaller than the window the camera is centred by design, and a
  // pan that correctly does nothing would look like a failure.
  const zoomed = await zoomTo(page, 1, 1);
  expect(tileScreenPx(zoomed)).toBeGreaterThan(0);

  const before = await cameraOf(page);
  const box = await canvasBox(page);
  const tilesBefore = new Set(
    (await drawTraceOf(page, state.map.width)).map((entry) => entry.tile),
  );

  await dragMap(page, -192, -128);

  const after = await cameraOf(page);
  // The camera moved by the pixels the drag asked for, through the projection's own tile size
  // — asserted against the app's OWN `clampCamera`, so a camera clamped at the map's edge is
  // still exact rather than a tolerance. Dragging left (dx < 0) moves the map left, which moves
  // the camera's origin right along the map (`view.ts` documents the sign: "dx positive drags
  // the map right").
  const size = tileScreenPx(before);
  const extent = { width: state.map.width, height: state.map.height };
  const expected = clampCamera(
    { ...before, x: before.x + 192 / size, y: before.y + 128 / size },
    extent,
    box,
  );
  expect(after.x).toBeCloseTo(expected.x, 5);
  expect(after.y).toBeCloseTo(expected.y, 5);
  expect(
    after.x !== before.x || after.y !== before.y,
    'the map is too small for its viewport to pan at all',
  ).toBe(true);

  const tilesAfter = (await drawTraceOf(page, state.map.width)).map((entry) => entry.tile);
  expect(tilesAfter.length).toBeGreaterThan(0);
  const moved = tilesAfter.some((tile) => !tilesBefore.has(tile));
  expect(moved, 'the drawn tiles did not change after panning').toBe(true);
  for (const tile of tilesAfter) {
    const onScreen = new Set(visibleTiles(state, after, box));
    expect(onScreen.has(tile)).toBe(true);
  }
});

test('A4 map zoom: zooming out draws strictly more tiles, so the trace grows as the map scrolls', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);

  const zoomedIn = await zoomTo(page, 1, 1);
  const inCount = (await drawTraceOf(page, state.map.width)).length;
  expect(inCount).toBeGreaterThan(0);

  const zoomedOut = await zoomTo(page, -1, 2);
  expect(tileScreenPx(zoomedOut)).toBeLessThan(tileScreenPx(zoomedIn));
  const outCount = (await drawTraceOf(page, state.map.width)).length;

  expect(
    outCount,
    `zoomed in drew ${String(inCount)} tiles, zoomed out ${String(outCount)}`,
  ).toBeGreaterThan(inCount);
});

test("rendering: a tile's centre is painted the colour the app documents for its terrain, and two terrains differ", async ({
  page,
}, testInfo) => {
  await openApp(page);
  // The app's OWN palette, if it documents one. Nothing is asserted against a palette invented
  // here: a test that pins colours the renderer never claimed reports a defect that does not
  // exist, and the contract freezes the sample, not the swatches.
  const palette = await paletteOf(page);

  // Sample tiles that are clear (no unit or city painted over the terrain) and explored (fog is
  // a colour of its own, and a fogged tile says nothing about the terrain). Up to two tiles per
  // terrain id, because the second is what proves the mapping is a *function* of terrain.
  //
  // **More than one seed, because one seed does not show every terrain.** This test used to seed
  // once, and at `SEED` the starting patch holds only coast, grassland and ocean — so plains,
  // hills and mountains were never sampled by anything, and a verifier demonstrated the cost:
  // swapping the hills and mountains textures, the closest pair in the palette and the one most
  // worth checking, left this test and `m8-adversarial.spec.ts` **both green**. Seeds 70 and 75
  // were chosen by enumerating the engine (`newGame` over seeds 1..120, terrain ids over
  // `state.explored[player]`): between them they hold all six, and the assertion below refuses to
  // let that coverage quietly go away again.
  const samples = new Map<string, { tile: number; colour: Rgb }[]>();
  for (const seed of PALETTE_SEEDS) {
    const state = await seedApp(page, seed);
    const camera = await cameraOf(page);
    const box = await canvasBox(page);
    const player = humanPlayerId(state);
    for (const tile of visibleTiles(state, camera, box)) {
      if (!tileIsClear(state, tile)) continue;
      if (state.explored[player]?.[tile] !== true) continue;
      const terrain = terrainAtTile(state, tile);
      const bucket = samples.get(terrain) ?? [];
      if (bucket.length >= 2) continue;
      bucket.push({
        tile,
        colour: await sampleTileColour(page, camera, tileX(state, tile), tileY(state, tile)),
      });
      samples.set(terrain, bucket);
    }
  }

  // Every shipped terrain, not merely "something was on screen": a palette check that skipped
  // three of the six would pass while three terrains went unpainted and unnoticed.
  expect(
    [...samples.keys()].sort(),
    'not every shipped terrain was on screen to sample, so this run says nothing about the ones ' +
      'that were missing — extend PALETTE_SEEDS with a seed that shows them',
  ).toEqual(Object.keys(palette ?? {}).sort());

  let compared = 0;
  const seen: { terrain: string; colour: Rgb }[] = [];
  for (const [terrain, bucket] of samples) {
    for (const sample of bucket) {
      expect(
        sample.colour.a,
        `tile ${String(sample.tile)} (${terrain}) has nothing painted at its centre`,
      ).toBe(255);
    }
    const documented = palette?.[terrain];
    if (documented !== undefined) {
      const expected = parseHexColour(documented);
      for (const sample of bucket) {
        const own = colourDistance(sample.colour, expected);
        expect(
          own,
          `tile ${String(sample.tile)} is ${terrain} and sampled ${describeColour(
            sample.colour,
          )}, but the app documents ${documented} for it`,
        ).toBeLessThanOrEqual(TERRAIN_CENTRE_TOLERANCE);

        // What this actually catches, stated precisely because an earlier version of this comment
        // overstated it: a **documentation collision** — two terrains documented so close together
        // that a sample falls within tolerance of both. The absolute bound above cannot see that,
        // because it only ever compares a sample with one colour at a time.
        //
        // What it does NOT do, and a verifier demonstrated by mutation: it will not fire *before*
        // the tolerance bound for a wrong-texture mapping. For every pair in this palette the 44
        // bound fires first — the global minimum of `separation − spread of the painted terrain`
        // is 52, which is above 44 — so a mispainted tile is caught by the line above and never
        // reaches this one. Swapping two terrains' textures fails the tolerance assertion; setting
        // two terrains to the SAME documented colour fails this one and only this one. Both are
        // worth having. They are not the same check, and this comment used to claim they were.
        let nearestTerrain = '';
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const [other, otherHex] of Object.entries(palette ?? {})) {
          if (other === terrain) continue;
          const distance = colourDistance(sample.colour, parseHexColour(otherHex));
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestTerrain = other;
          }
        }
        expect(
          own,
          `tile ${String(sample.tile)} is ${terrain} and sampled ${describeColour(
            sample.colour,
          )}, which is nearer the colour documented for ${nearestTerrain} (${String(
            nearestDistance,
          )}) than the one documented for ${terrain} (${String(own)})`,
        ).toBeLessThan(nearestDistance);
        compared += 1;
      }
    }
    // The same terrain, two places, one colour: a per-tile coincidence would show up here as
    // two samples of the "same" terrain disagreeing. The bound is the measured spread of the
    // widest texture (48, grassland) rather than the old 8, which was written when a terrain was
    // a single fill and every tile of it was the same byte for byte.
    const first = bucket[0];
    const second = bucket[1];
    if (first !== undefined && second !== undefined) {
      expect(
        colourDistance(first.colour, second.colour),
        `two ${terrain} tiles sampled different colours — the mapping is not a function of terrain`,
      ).toBeLessThanOrEqual(TERRAIN_SAME_KIND_TOLERANCE);
    }
    if (first !== undefined) seen.push({ terrain, colour: first.colour });
  }

  if (palette === undefined) {
    testInfo.annotations.push({
      type: 'palette',
      description:
        'the app documents no terrain palette (no __CIVTS__.terrainColours() and no exported record of colours under /src/), so each sample was checked for being painted, for being a function of its terrain, and for two terrains differing — not against a swatch this file invented',
    });
  } else {
    expect(
      compared,
      'the app documents a palette in which none of the sampled terrains appear by name',
    ).toBeGreaterThan(0);
    testInfo.annotations.push({
      type: 'palette',
      description: `every sampled tile matched the app's own documented colour (${String(
        compared,
      )} samples)`,
    });
  }

  // The sample is not vacuous: two terrains must be painted differently, which no
  // constant-colour canvas could satisfy.
  const first = seen[0];
  const different = seen.find((entry) => entry.terrain !== first?.terrain);
  if (first !== undefined && different !== undefined) {
    expect(
      colourDistance(first.colour, different.colour),
      `${first.terrain} and ${different.terrain} were painted the same colour, so the sample proves nothing`,
    ).toBeGreaterThan(24);
  } else {
    expect(
      samples.size,
      'only one terrain was on screen, so "two terrains differ" could not be tested',
    ).toBeGreaterThan(1);
  }
});

test('rendering: the sampled colour changes when the map pans and zooms, so the sample is not constant', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  await zoomTo(page, 1, 1);

  const box = await canvasBox(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const camera = await cameraOf(page);
  const local = { x: point.x - box.x, y: point.y - box.y };
  const tileUnder = pagePointToTile(state, camera, local);
  expect(tileUnder, 'the centre of the canvas is not over a tile').toBeDefined();
  if (tileUnder === undefined) return;

  const before = await sampleCanvasPixel(page, local);

  // Pan so that a tile of a DIFFERENT terrain sits under the same page point. The
  // delta is computed through the app's own projection, so this is a statement about
  // the mapping as well as about the pixels: if the projection were wrong, the wrong
  // tile would land under the point and the colour would not change.
  const hereTerrain = terrainAtTile(state, tileUnder.y * state.map.width + tileUnder.x);
  const target = visibleTiles(state, camera, box)
    .filter((tile) => tileIsClear(state, tile))
    .find((tile) => {
      const terrain = terrainAtTile(state, tile);
      return terrain !== hereTerrain;
    });
  expect(target, 'no tile of a different terrain was on screen to pan to').toBeDefined();
  if (target === undefined) return;

  // The fractional tile under the point, not its floor: the sample is taken at the canvas
  // centre, which is generally part-way through a tile, and a pan computed from the floored
  // coordinate would land the point on a neighbouring tile by exactly that fraction.
  const size = tileScreenPx(camera);
  const exact = screenToTilePoint(camera, local);
  const dx = (tileX(state, target) - exact.x) * size;
  const dy = (tileY(state, target) - exact.y) * size;
  await dragMap(page, -dx, -dy);

  const panned = await cameraOf(page);
  const underNow = pagePointToTile(state, panned, local);
  expect(underNow).toEqual({ x: tileX(state, target), y: tileY(state, target) });
  const after = await sampleCanvasPixel(page, local);
  expect(
    colourDistance(before, after),
    `panning changed the tile under the point from ${hereTerrain} to ${terrainAtTile(
      state,
      target,
    )} but the pixel stayed ${describeColour(before)}`,
  ).toBeGreaterThan(24);

  // And zooming genuinely changes the projection the sample is taken through: the
  // tile size the app reports changes, so the coordinates below are not a fixed
  // screen grid that would make every sample identical by construction.
  // Zoom *out* one step, not in: the app now opens at 2x (`ZOOM_DEFAULT_INDEX` 3) because
  // textured tiles read better there, and the test's own opening `zoomTo` has already climbed to
  // the innermost level. Asking for one more step inward therefore asked for a level that does
  // not exist, and `tileScreenPx` correctly returned the same number — the assertion was testing
  // the ceiling of the zoom range rather than the projection changing.
  //
  // Said plainly: the assertion below is not independently falsifiable, because `zoomSign`
  // already throws when a wheel leaves the tile size unchanged — verified by collapsing every
  // zoom ratio to the same value and watching the helper, not this line, go red. It is kept
  // because it states the requirement where the sample is taken, and it costs nothing.
  const zoomedOut = await zoomTo(page, -1, 1);
  expect(
    tileScreenPx(zoomedOut),
    'the app reports the same tile size at two different zoom levels, so the sampled ' +
      'coordinates are a fixed screen grid and every sample below is the same sample',
  ).not.toBe(tileScreenPx(panned));
  const zoomColour = await sampleCanvasPixel(page, local);
  expect(zoomColour.a).toBe(255);
});

test('hit-testing: a click opens the tile the same projection says is under the point, at a non-zero pan and zoom', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);
  // Found a city through the UI: the city's own accessible name (`City <name>`, frozen) is
  // proof of WHICH TILE the click landed on, which a unit's controls are not — the panel falls
  // back to a default unit when a click clears the selection, so "some controls appeared" would
  // pass for any nearby tile.
  const city = await foundCity(page);
  const founded = await readState(page);

  // A non-zero pan and a non-zero zoom, so the inverse mapping is genuinely exercised: at zoom
  // 1 with the camera at the origin a wrong inverse would still land on the right tile.
  await zoomTo(page, 1, 1);
  await bringTileToCentre(page, founded, city.tile);
  await dragMap(page, -48, -32);

  const camera = await cameraOf(page);
  expect(tileScreenPx(camera), 'the map is at its default zoom').toBeGreaterThan(BASE_TILE_PX);
  expect(
    { x: camera.x, y: camera.y },
    'the camera is at the map’s origin, so the inverse mapping is being tested at the trivial point',
  ).not.toEqual({ x: 0, y: 0 });

  const box = await canvasBox(page);
  const cx = tileX(founded, city.tile);
  const cy = tileY(founded, city.tile);
  const local = tileCentre(camera, cx, cy);
  expect(
    local.x >= 0 && local.y >= 0 && local.x < box.width && local.y < box.height,
    'the city is not on screen after scrolling to it',
  ).toBe(true);

  const point = await tilePagePoint(page, camera, cx, cy);
  const localFromPoint = { x: point.x - box.x, y: point.y - box.y };

  // The SAME mapping, both ways: the point this suite computed is over the city's tile.
  expect(pagePointToTile(founded, camera, localFromPoint)).toEqual({ x: cx, y: cy });

  // The canvas description must name the visible dimensions AND the cursor's tile, updated as
  // the pointer moves (docs/INTERFACES.md, M8 §The accessibility contract) — so the app's own
  // readout has to agree with the projection this suite used: a second inverse mapping is the
  // exact defect §Rendering forbids.
  await page.mouse.move(point.x, point.y);
  const description = await mapDescription(page);
  expect(description, 'the map description names no cursor tile').toMatch(
    new RegExp(`${String(cx)}\\s*,\\s*${String(cy)}\\b`),
  );
  expect(description, 'the map description does not name the map’s dimensions').toContain(
    `${String(founded.map.width)} by ${String(founded.map.height)}`,
  );

  // Clicking it opens that city's screen — and the click is resolved, not snapped: the tile
  // next door opens nothing.
  await clickTile(page, camera, cx, cy);
  await expect(cityDialog(page, city.name)).toBeVisible();

  // Closed the way a player closes it, through the dialog's own control.
  await cityDialog(page, city.name).getByRole('button', { name: /close/i }).click();
  await expect(cityDialog(page, city.name)).toBeHidden();
  const neighbour = [
    { x: cx + 1, y: cy },
    { x: cx - 1, y: cy },
    { x: cx, y: cy + 1 },
    { x: cx, y: cy - 1 },
  ].find((candidate) => {
    if (candidate.x < 0 || candidate.y < 0) return false;
    if (candidate.x >= founded.map.width || candidate.y >= founded.map.height) return false;
    const at = tileCentre(camera, candidate.x, candidate.y);
    return at.x >= 0 && at.y >= 0 && at.x < box.width && at.y < box.height;
  });
  expect(neighbour, 'no neighbouring tile was on screen to mis-click').toBeDefined();
  if (neighbour === undefined) return;
  await clickTile(page, camera, neighbour.x, neighbour.y);
  await expect(
    cityDialog(page, city.name),
    'a click one tile away opened the city screen, so the hit-test is snapping or offset',
  ).toBeHidden();
});

test('refusals: a click the engine would refuse leaves the state exactly as it was', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  const player = humanPlayerId(state);
  const unit = unitsOf(state, player)[0];
  expect(unit, 'the human seat has no unit').toBeDefined();
  if (unit === undefined) return;

  await zoomTo(page, 1, 1);
  await bringTileToCentre(page, state, unit.tile);
  const camera = await cameraOf(page);
  const box = await canvasBox(page);

  // Select the unit through the map, then click a tile it plainly cannot reach: more
  // than one step away, on the same map, so a move to it is not in `unitActions`.
  await clickTile(page, camera, tileX(state, unit.tile), tileY(state, unit.tile));
  await expect(unitActionsGroup(page, unit.id)).toBeVisible();

  const before = await readState(page);
  const hashBefore = await stateHash(page);
  const canRecord = await recordDispatches(page);

  // Only tiles whose CENTRE is inside the canvas: the visible rectangle includes the tiles on
  // its edges, and a click aimed at the centre of one of those would land off the canvas.
  const centreInside = (tile: number): boolean => {
    const local = tileCentre(camera, tileX(state, tile), tileY(state, tile));
    return local.x >= 0 && local.y >= 0 && local.x < box.width && local.y < box.height;
  };
  const onScreen = visibleTiles(state, camera, box).filter((tile) => {
    if (tile === unit.tile || !centreInside(tile)) return false;
    const dx = Math.abs(tileX(state, tile) - tileX(state, unit.tile));
    const dy = Math.abs(tileY(state, tile) - tileY(state, unit.tile));
    return Math.max(dx, dy) > 1 && tileIsClear(state, tile);
  });
  expect(onScreen.length, 'no unreachable tile was on screen').toBeGreaterThan(0);
  const target = onScreen[0];
  if (target === undefined) return;

  await clickTile(page, camera, tileX(state, target), tileY(state, target));

  const after = await readState(page);
  expect(await stateHash(page), 'a refused click changed the engine state').toBe(hashBefore);
  expect(after.revision).toBe(before.revision);

  if (canRecord) {
    const log = await dispatchLog(page);
    for (const entry of log) {
      // A control the engine refuses may still have been *offered* and dispatched:
      // what must never happen is that it reports success.
      const type = JSON.stringify(entry.action);
      expect(
        entry.result,
        `the UI dispatched ${type} and the engine accepted it after a click the engine would refuse`,
      ).toBe('refused');
    }
  }
});

test('A4 map render: the camera and the drawn tiles agree with the projection at every zoom level', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED);
  const box = await canvasBox(page);

  const seen: number[] = [];
  for (let step = 0; step < 4; step += 1) {
    const camera = await cameraOf(page);
    seen.push(tileScreenPx(camera));
    const trace = await drawTraceOf(page, state.map.width);
    const onScreen = new Set(visibleTiles(state, camera, box));
    for (const entry of trace) expect(onScreen.has(entry.tile)).toBe(true);

    // A tile the projection puts on screen is drawn at the page point the projection
    // gives, and the app's own inverse names the same tile there.
    const sampleTile = visibleTiles(state, camera, box).find((tile) => tileIsClear(state, tile));
    if (sampleTile !== undefined) {
      const centre = tileCentre(camera, tileX(state, sampleTile), tileY(state, sampleTile));
      expect(pagePointToTile(state, camera, centre)).toEqual({
        x: tileX(state, sampleTile),
        y: tileY(state, sampleTile),
      });
      const drawn = new Set(trace.map((entry) => entry.tile));
      expect(drawn.has(sampleTile)).toBe(true);
    }
    await zoomTo(page, 1, 1);
  }

  // Four zoom steps moved through distinct projections rather than sitting still.
  expect(new Set(seen).size).toBeGreaterThan(1);
});
