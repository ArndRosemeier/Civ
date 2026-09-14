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
  clickUnitAction,
  colourDistance,
  countTilePixels,
  describeColour,
  dispatchLog,
  dragMap,
  drawTraceOf,
  endTurns,
  humanPlayerId,
  authoritativeState,
  mapDescription,
  openApp,
  OPPONENT_OFF,
  pagePointToTile,
  paletteOf,
  parseHexColour,
  readState,
  recordDispatches,
  RULESET,
  sampleCanvasPixel,
  sampleTileColour,
  seedApp,
  selectUnit,
  unitActionButtons,
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
import {
  asTileIndex,
  asUnitId,
  isExplored,
  planMove,
  planRoute,
  unitActions,
  type GameState as EngineState,
  // The ENGINE's `visibleTiles` — what a player can see — is a different function from this
  // suite's `visibleTiles` (which tiles the VIEWPORT covers). They are named apart here on
  // purpose: conflating "in sight" with "on screen" is the mistake `render.ts` records for the
  // renderer, and conflating "in sight" with "explored" is the one the fog leak was made of.
  visibleTiles as tilesInSight,
  type Unit,
} from '@civts/core';
import { humanSeatOf } from '../src/testapi.js';
import { FOG_COLOUR, CITY_COLOUR, terrainColour } from '../src/render.js';
import {
  BASE_TILE_PX,
  clampCamera,
  screenToTile,
  screenToTilePoint,
  tileScreenPx,
} from '../src/view.js';

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

/**
 * The map's box is the layout's, and everything that depends on it follows.
 *
 * The canvas used to be a fixed 720×540 for a stated reason: the viewport the camera is clamped
 * against, the rectangle the renderer walks, and the box the hit-test inverts must be one number.
 * This test exists because that reason survived the change and the *guarantee* did not — the size is
 * now measured from the layout, so "one number" is a property to be checked rather than a constant
 * to be read. Three things have to hold at every window size, and each fails for a different
 * mistake:
 *
 *   1. it is square,
 *   2. it is the largest square the region can hold, and
 *   3. a pointer at its centre resolves to the tile the projection says is under that point.
 *
 * (3) is the load-bearing one. A fluid box can break the inverse mapping in two ways that nothing
 * else in this suite would catch: a camera not re-clamped against the new viewport (so it shows
 * ground past the map's edge), and a hit-test still dividing by a size the renderer no longer used.
 * Both leave every other test passing, because every other test runs at one window size.
 */
test('the map is a fluid square, and the click still lands where the renderer drew after a resize', async ({
  page,
}) => {
  await openApp(page);
  await seedApp(page, SEED);

  /** The canvas box, the region's content box, and what the two should be equal to. */
  const measure = async (): Promise<{
    readonly width: number;
    readonly height: number;
    readonly contentSide: number;
  }> => {
    const box = await canvasBox(page);
    // The region's box model is read from the browser rather than restated here: the paddings and
    // borders that decide how much room the canvas has are the stylesheet's business, and a test
    // that hardcoded them would pass while the canvas sat in a box of a different shape.
    const contentSide = await page.locator("[data-panel='map']").evaluate((region) => {
      const style = getComputedStyle(region);
      const inset = (a: string, b: string): number =>
        parseFloat(style.getPropertyValue(a)) + parseFloat(style.getPropertyValue(b));
      const width = region.clientWidth - inset('padding-left', 'padding-right');
      const height = region.clientHeight - inset('padding-top', 'padding-bottom');
      return Math.min(width, height);
    });
    return { width: box.width, height: box.height, contentSide };
  };

  /**
   * The viewport the app itself clamps against: the measured box, *rounded*.
   *
   * Not a detail. The canvas's laid-out box is fractional (`596.703125` at 1600×700), and
   * `measureCanvas` rounds it before handing it to the camera clamp, the renderer and the hit-test —
   * which is what keeps those three on one number. Comparing a camera against a clamp taken over the
   * unrounded box therefore asks a question the app never answers, and the two answers differ in the
   * second decimal. The rounding is read here rather than duplicated by accident.
   */
  const viewportOf = async (): Promise<{ readonly width: number; readonly height: number }> => {
    const box = await canvasBox(page);
    return { width: Math.round(box.width), height: Math.round(box.height) };
  };

  const sizes = [
    { width: 1280, height: 900 },
    { width: 900, height: 1000 },
    { width: 1600, height: 700 },
  ] as const;
  const sides: number[] = [];

  for (const size of sizes) {
    await page.setViewportSize(size);
    const at = `${String(size.width)}x${String(size.height)}`;
    // Settled before measured: the canvas is sized *by* the region it sits in, and a reading taken
    // mid-reflow would be of the previous arrangement — which is the failure mode this poll turns
    // into a wait instead of a race.
    await expect
      .poll(
        async () => {
          const m = await measure();
          return Math.abs(m.width - m.contentSide) <= 1;
        },
        { message: `the map never filled its region at ${at}`, timeout: 5000 },
      )
      .toBe(true);

    const m = await measure();
    expect(
      Math.abs(m.width - m.height),
      `at ${at} the map is ${String(m.width)}x${String(m.height)}, which is not a square`,
    ).toBeLessThanOrEqual(1);
    // Restated rather than assumed from the poll, so the failure names the number that was wrong.
    expect(
      Math.abs(m.width - m.contentSide),
      `at ${at} the map is ${String(m.width)}px across but the region can hold ` +
        `${String(m.contentSide)}px, so it is not using the room it has`,
    ).toBeLessThanOrEqual(1);

    // The inverse mapping, at this size, against the camera the app is actually using.
    const state = await readState(page);
    const camera = await cameraOf(page);
    const box = await canvasBox(page);
    const centre = { x: box.width / 2, y: box.height / 2 };
    const expected = screenToTile(
      camera,
      { width: state.map.width, height: state.map.height },
      centre,
    );
    expect(expected, `at ${at} the centre of the canvas is not over any tile`).toBeDefined();

    await page.mouse.move(box.x + centre.x, box.y + centre.y);
    await expect
      .poll(async () => mapDescription(page), {
        message: `at ${at} the app never named a tile under the centre of the canvas`,
      })
      .toMatch(new RegExp(`${String(expected?.x)}\\s*,\\s*${String(expected?.y)}\\b`));

    sides.push(Math.round(m.width));
  }

  // The control that makes this a test about a FLUID map. Everything above also passes for a canvas
  // hardcoded to a square small enough to fit the smallest window — square, and the largest square
  // when the region happens to be that size. What cannot pass is a size that never moves, so the
  // size moving is asserted rather than assumed.
  expect(
    new Set(sides).size,
    `the map measured ${JSON.stringify(sides)} at three window sizes, so it is not following the layout`,
  ).toBeGreaterThan(1);

  /*
   * The camera has to be re-clamped, and this is the case that shows it.
   *
   * Assertion (3) above cannot catch a missing re-clamp, and it is worth being precise about why: it
   * compares the app's behaviour against the app's *own* camera, so a camera that is wrong is still
   * inverted consistently — every click lands where a wrong view drew. The failure is instead that
   * the view shows ground past the map's edge, and the way to see it is to compare the camera
   * against the clamp directly.
   *
   * A camera only becomes invalid when the viewport GROWS, so the test has to arrange that rather
   * than hope for it: the view is driven hard against the map's corner at a narrow window (where
   * `clampCamera` allows the largest pan), and the window is then made much wider, which claims
   * more tiles than exist past that corner. Without the re-clamp the camera is left pointing off
   * the map; `clampCamera` is idempotent, so asking whether the app's camera is one the clamp would
   * have produced is exactly the question.
   */
  await page.setViewportSize({ width: 900, height: 1000 });
  await dragMap(page, -4000, -4000);
  await page.setViewportSize({ width: 1600, height: 700 });

  // Polled on the property itself rather than on the canvas box, because the box is laid out by CSS
  // the moment the window changes while the camera is re-clamped by the observer a beat later: a
  // test that waited for the box would read the camera before the thing under test had run, and
  // would pass on a build that never re-clamped at all. That mistake was made here first, and it is
  // the reason this waits on the clamp rather than on a size that is already correct.
  await expect
    .poll(
      async () => {
        const c = await cameraOf(page);
        const s = await readState(page);
        const legal = clampCamera(
          c,
          { width: s.map.width, height: s.map.height },
          await viewportOf(),
        );
        return Math.abs(legal.x - c.x) < 1e-9 && Math.abs(legal.y - c.y) < 1e-9;
      },
      {
        message:
          'the widening resize left the camera un-clamped: the view then shows ground past the ' +
          'map’s edge, and the click inverse goes on faithfully reporting tiles that are not there',
        timeout: 5000,
      },
    )
    .toBe(true);

  // Stated again as a plain reading, so that the number is in the record rather than only in a poll
  // that happened to succeed.
  const settled = await cameraOf(page);
  const settledState = await readState(page);
  expect(
    clampCamera(
      settled,
      { width: settledState.map.width, height: settledState.map.height },
      await viewportOf(),
    ),
    'the camera the app settled on is not one the clamp would produce',
  ).toEqual(settled);
});

/**
 * The unit action popup: one surface, beside the unit, holding only what the map cannot do.
 *
 * Three separate claims, each of which fails for a different mistake:
 *
 *  1. **One surface.** The shell used to build its own `Abilities for unit <id>` group beside the
 *     panel's `Actions for unit <id>` — two lists of one unit's orders, with two labellers (the
 *     shell's ended in `default: return command.type`, so a new command member would have reached a
 *     button as its own type name). Only the panel's group should exist now, and it carries the
 *     frozen M8 name (`docs/INTERFACES.md`: `selected unit actions | group | Actions for unit <id>`).
 *  2. **Nothing that names a tile.** Moving and attacking are map clicks; a button per destination is
 *     what the owner called unnecessary, and it is also why this phase nearly shipped broken: a
 *     starting settler offers eight moves, the group rendered 256×321 px, and a click on a city tile
 *     beneath it was swallowed by one of its own buttons. The label check here is a *proxy* for
 *     `tileNamedBy` — `unitpanel.test.ts` asserts the property itself against the engine, and this
 *     asserts that what reaches the DOM is that list rather than a longer one.
 *  3. **Beside the unit, not on it** — and the map keeps the pointer underneath it. The second half
 *     is the one that matters for playability, so it is measured directly at the unit's own tile
 *     rather than inferred from the popup's geometry.
 */
test('the unit popup is the only surface for a unit’s orders, holds no tile-named order, and leaves the map clickable', async ({
  page,
}) => {
  await openApp(page);
  const state = await seedApp(page, SEED, OPPONENT_OFF);
  const owner = humanPlayerId(state);
  const settler = state.units.find((one) => one.owner === owner);
  if (settler === undefined) throw new Error('the human seat owns no unit to select');
  await selectUnit(page, state, await cameraOf(page), settler.id);

  // (1) Exactly one group for this unit's orders, and it is named the way M8 froze it.
  const orders = page.getByRole('group', { name: /^(Actions|Abilities) for unit / });
  await expect(orders, "more than one group offers this unit's orders").toHaveCount(1);
  await expect(orders).toHaveAccessibleName(`Actions for unit ${String(settler.id)}`);

  // (2) Nothing in it names a tile.
  const labels = await unitActionButtons(page, settler.id).allInnerTexts();
  expect(labels.length, 'the popup offers the settler nothing at all').toBeGreaterThan(0);
  for (const label of labels) {
    expect(
      label.trim(),
      `the popup offers "${label.trim()}", which names a tile — that order belongs to the map`,
    ).not.toMatch(/\d+\s*,\s*\d+/);
  }

  // (3) It sits beside the unit's tile, not over it, and the map still receives clicks there.
  const camera = await cameraOf(page);
  const box = await canvasBox(page);
  const tile = settler.tile;
  const centre = tileCentre(camera, tileX(state, tile), tileY(state, tile));
  const popup = await page.locator("[data-floating='unit-actions']").boundingBox();
  if (popup === null) throw new Error('the unit action popup has no box (is it hidden?)');
  expect(
    centre.x + box.x >= popup.x &&
      centre.x + box.x <= popup.x + popup.width &&
      centre.y + box.y >= popup.y &&
      centre.y + box.y <= popup.y + popup.height,
    'the popup covers the tile it belongs to, so the player cannot see what they are ordering',
  ).toBe(false);

  // The point that decides whether the map stays playable with a menu open — and it has to be a
  // point INSIDE the popup, not merely near it. The popup's own padding is such a point: whatever
  // the map is beneath it, the page must still see the CANVAS there, because only the buttons take
  // the pointer. Probing the unit's tile instead would prove nothing, since (3) has already
  // established the popup is not over that tile — the assertion would be unable to fail.
  //
  // Losing `pointer-events: none` is silent: the menu looks right and quietly eats clicks aimed at
  // the tiles beneath it, which is one of the two ways this phase was broken before the filter
  // removed the eight move buttons.
  const topLeft = { x: popup.x + 2, y: popup.y + 2 };
  const onTop = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    if (element === null) return 'NOTHING';
    return element.tagName === 'CANVAS' ? 'CANVAS' : element.tagName;
  }, topLeft);
  expect(
    onTop,
    'the popup is between the pointer and the map, so the tiles under it cannot be clicked',
  ).toBe('CANVAS');
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

  /*
   * **"Cannot reach" now means "the engine's route query finds no way at all"**, and that is Phase
   * 4's change to this test rather than a weakening of it. A far tile the unit *can* walk to is no
   * longer a refusal: it is a goto, and the state is *supposed* to change when one starts (which is
   * what `goto.spec.ts` asserts). What this test is about — a click the engine turns down must
   * change nothing, and must be visible as a refusal — needs a destination with no route of any
   * length. On this board that is water: a land unit may never stand on it, so `planRoute` refuses
   * it outright, and the engine's own reason reaches the order channel.
   */
  const authoritative = await authoritativeState(page);
  const settler = authoritative.units.find((each) => each.id === unit.id);
  expect(settler, 'the selected unit is not in the authoritative state').toBeDefined();
  if (settler === undefined) return;

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
    if (Math.max(dx, dy) <= 1) return false;
    if (!tileIsClear(state, tile)) return false;
    // The goto's own criterion: no sequence of single steps reaches it, so the click has nothing to
    // start. `planRoute` is the ENGINE's answer, not this test's idea of one.
    return !planRoute(authoritative, RULESET, settler.id, asTileIndex(tile)).ok;
  });
  expect(
    onScreen.length,
    'no tile on screen is out of the unit\u2019s reach by any route, so this test could not tell a ' +
      'refusal from a goto',
  ).toBeGreaterThan(0);
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

/* ------------------------------------------------------------------ *
 * Fog: what the player can see, told apart from what it remembers
 * ------------------------------------------------------------------ */

/**
 * The seed and the turn this file's fog test plays to.
 *
 * Not arbitrary, and not a needle either. The scene it needs is one where **founding the settler's
 * own city takes a rival unit out of the player's sight while its tile stays explored** — the one
 * configuration in which `visibleTiles` (current sight) and `isExplored` (memory) give different
 * answers about a unit, and therefore the only one that can tell the two rules apart from the
 * outside. It was found by asking the engine, not by looking at the canvas: a headless mirror of
 * the app's own turn loop (the human seat ends its turn, `SMART_POLICY` plays the rival) over seeds
 * 1..30 on a `duel` map with 2 civilizations produced that configuration on **28 of 30 seeds**;
 * seed 12 reaches it at turn 23 and holds it for five turns, so the scene is a property of ordinary
 * play rather than a coincidence of one seed. `docs/UI-OVERHAUL.md` §7.8 records the measurement.
 *
 * `endTurns` clicks `End turn` `FOG_TURNS` times, which leaves the app's own counter at
 * `FOG_TURNS + 1` turns played — the assertion below states the turn it actually landed on rather
 * than assuming the convention.
 */
const FOG_SEED = 12;
const FOG_TURNS = 22;

test('fog: a rival the player cannot see is not painted, one it can see is, and one that walks out of sight stops being painted', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  await seedApp(page, FOG_SEED, { mapSize: 'duel', civCount: 2 });
  await endTurns(page, FOG_TURNS);

  // The app's OWN state, through its own save path: the engine's `visibleTiles` and `isExplored`
  // take a `GameState`, and asking them about the browser's game is the whole point — a mirrored
  // copy of the rule in this file is the second notion of "visible" that produced the leak.
  const before = await authoritativeState(page);
  const seat = humanSeatOf(before);
  expect(seat, 'the state names no civilization to play as').toBeDefined();
  if (seat === undefined) return;
  expect(before.turn, 'the game is not at the turn this scene was measured at').toBe(FOG_TURNS + 1);

  const ui = await readState(page);
  const inSight = new Set<number>(tilesInSight(before, seat).map((tile) => Number(tile)));
  const rivals = before.units.filter((unit) => unit.owner !== seat);
  expect(rivals.length, 'the game has no rival units to look at').toBeGreaterThan(0);

  /** The colour the app paints this unit's owner in (the markers' own `colourOfPlayer` read). */
  const ownerColourOf = (owner: number): string => {
    const player = before.players.find((candidate) => candidate.id === owner);
    if (player === undefined) throw new Error(`the state has no player ${String(owner)}`);
    return player.color;
  };

  /** Pan so this tile's centre is on the canvas — a sample taken off the canvas reads nothing. */
  const centreOnCanvas = async (tile: number): Promise<boolean> => {
    await bringTileToCentre(page, ui, tile);
    const camera = await cameraOf(page);
    const box = await canvasBox(page);
    const local = tileCentre(camera, tileX(ui, tile), tileY(ui, tile));
    return local.x >= 0 && local.y >= 0 && local.x < box.width && local.y < box.height;
  };

  /**
   * What one tile reads as: the colour at its centre, and how many of its pixels are exactly
   * `colour`. The two together are the whole instrument — see `countTilePixels` for why a centre
   * sample alone cannot say whether a unit marker is painted.
   */
  const readTile = async (
    tile: number,
    colour: string,
  ): Promise<{ centre: Rgb; matching: number; total: number }> => {
    const camera = await cameraOf(page);
    const x = tileX(ui, tile);
    const y = tileY(ui, tile);
    const centre = await sampleTileColour(page, camera, x, y);
    const counted = await countTilePixels(page, camera, x, y, colour);
    return { centre, matching: counted.matching, total: counted.total };
  };

  /**
   * The first of these tiles the camera can actually put on the canvas, so a candidate near the
   * map's edge (a pan the clamp refuses) cannot be mistaken for a failure of the rule under test.
   * `undefined` when none of them can be brought into view.
   */
  const reachableTile = async (tiles: readonly number[]): Promise<number | undefined> => {
    for (const tile of tiles) {
      if (await centreOnCanvas(tile)) return tile;
    }
    return undefined;
  };

  /** The same choice, for a list of units: the first whose tile can be panned into view. */
  const reachable = async (units: readonly Unit[]): Promise<Unit | undefined> => {
    const tile = await reachableTile(units.map((unit) => Number(unit.tile)));
    return tile === undefined ? undefined : units.find((unit) => Number(unit.tile) === tile);
  };

  /* ------------------- (1) never explored: not painted ------------------- */

  // The defect `docs/UI-OVERHAUL.md` §7.8 records: every unit of every player was marked, the
  // renderer filtered only by viewport, and an unexplored tile was painted flat fog with the enemy
  // drawn on top of it. Measured at game start on every seed tried, all six foreign units of a
  // `small` 4-civ game stood on never-explored ground and all six were drawn.
  const hidden = rivals.filter(
    (unit) => !inSight.has(Number(unit.tile)) && !isExplored(before, seat, unit.tile),
  );
  expect(
    hidden.length,
    'no rival unit was standing on ground the player has never explored at this turn, so this ' +
      'test could not observe the leak it exists for — re-measure the seed and the turn',
  ).toBeGreaterThan(0);

  const hiddenUnit = await reachable(hidden);
  expect(
    hiddenUnit,
    'none of the rivals on never-explored ground could be panned onto the canvas, so nothing ' +
      'about the fog the player sees could be sampled',
  ).toBeDefined();
  if (hiddenUnit === undefined) return;
  const hiddenTile = Number(hiddenUnit.tile);

  const hiddenRead = await readTile(hiddenTile, ownerColourOf(hiddenUnit.owner));
  expect(
    hiddenRead.total,
    `nothing was read from tile ${String(hiddenTile)}, so "no marker there" would be vacuous`,
  ).toBeGreaterThan(0);
  expect(
    hiddenRead.centre,
    `rival ${hiddenUnit.type} (tile ${String(hiddenTile)}) stands on ground the player has NEVER ` +
      `explored, which must be painted flat fog, and its centre reads ` +
      `${describeColour(hiddenRead.centre)} instead of ${FOG_COLOUR}`,
  ).toEqual(parseHexColour(FOG_COLOUR));
  expect(
    hiddenRead.matching,
    `rival ${hiddenUnit.type} (tile ${String(hiddenTile)}) is painted on a tile the player has ` +
      `never explored: ${String(hiddenRead.matching)} of the tile's pixels are its owner's own ` +
      `colour (${ownerColourOf(hiddenUnit.owner)}), which only a unit marker paints`,
  ).toBe(0);

  /* ------------- (2) in sight: painted — the inverse control ------------- */

  // Without this half the test would also pass in a build that painted no units at all: "the centre
  // of a fogged tile is fog" says nothing about whether markers are drawn anywhere. So a rival the
  // player can see RIGHT NOW must be demonstrably painted.
  const seenRivals = rivals.filter((unit) => inSight.has(Number(unit.tile)));
  expect(
    seenRivals.length,
    'no rival unit was in the player’s sight at this turn, so the control half of this test is ' +
      'missing and "the enemy is not painted" would be unfalsifiable',
  ).toBeGreaterThan(0);

  const seenUnit = await reachable(seenRivals.filter((unit) => Number(unit.tile) !== hiddenTile));
  expect(
    seenUnit,
    'no rival unit in the player’s sight could be panned onto the canvas, so the control half of ' +
      'this test could not be taken',
  ).toBeDefined();
  if (seenUnit === undefined) return;
  const seenTile = Number(seenUnit.tile);
  const seenColour = ownerColourOf(seenUnit.owner);

  // The instrument's own precondition, stated: the marker's colour is nowhere near the fog colour,
  // so counting it cannot be confused with the fog a leak would have painted over.
  expect(
    colourDistance(parseHexColour(seenColour), parseHexColour(FOG_COLOUR)),
    `the rival's own colour ${seenColour} is too close to the fog colour ${FOG_COLOUR} for this ` +
      'test to tell a painted marker from an unpainted tile',
  ).toBeGreaterThan(24);

  const paintedRead = await readTile(seenTile, seenColour);
  expect(
    paintedRead.total,
    `nothing was read from tile ${String(seenTile)}, so "a marker is painted" would be vacuous`,
  ).toBeGreaterThan(0);
  expect(
    paintedRead.matching,
    `rival ${seenUnit.type} (tile ${String(seenTile)}) is in the player's sight and is not ` +
      `painted: none of the tile's pixels are its owner's colour (${seenColour})`,
  ).toBeGreaterThan(0);
  expect(
    paintedRead.centre,
    `tile ${String(seenTile)} is in the player's sight and was painted as unexplored fog`,
  ).not.toEqual(parseHexColour(FOG_COLOUR));

  /* -------- (3) remembered but out of sight: the marker must go away ------- */

  // The case that tells the engine's two notions apart. Found a city with the settler — the
  // player's own control, one `FoundCity`, the engine's own command — which consumes the settler
  // and with it the sight that unit contributed. A rival on a tile that is still EXPLORED (memory)
  // must stop being painted if the rule is current sight, and must stay painted if the rule is
  // memory. This is the assertion that fails for an `isExplored` filter.
  const settler = before.units.find((unit) => unit.owner === seat && unit.type.includes('settler'));
  expect(
    settler,
    'the human seat has no settler, so its sight cannot be shrunk in one order',
  ).toBeDefined();
  if (settler === undefined) return;
  await selectUnit(page, ui, await cameraOf(page), Number(settler.id));
  await clickUnitAction(page, Number(settler.id), /found city/i);

  const after = await authoritativeState(page);
  const inSightAfter = new Set<number>(tilesInSight(after, seat).map((tile) => Number(tile)));
  const droppedOut = after.units.filter(
    (unit) =>
      unit.owner !== seat &&
      inSight.has(Number(unit.tile)) &&
      !inSightAfter.has(Number(unit.tile)) &&
      isExplored(after, seat, unit.tile),
  );
  expect(
    droppedOut.length,
    'founding the settler’s city did not take any rival unit out of the player’s sight while ' +
      'leaving its tile explored, so the rule this test exists for was not exercised — the scene ' +
      'premise (seed 12, turn 23) has moved',
  ).toBeGreaterThan(0);

  const gone = await reachable(droppedOut);
  expect(
    gone,
    'no rival that left the player’s sight could be panned onto the canvas, so the rule this ' +
      'test exists for could not be sampled',
  ).toBeDefined();
  if (gone === undefined) return;
  const goneTile = Number(gone.tile);
  const goneColour = ownerColourOf(gone.owner);
  const uiAfter = await readState(page);

  const goneRead = await readTile(goneTile, goneColour);
  expect(
    goneRead.matching,
    `rival ${gone.type} (tile ${String(goneTile)}) left the player's sight but its tile is still ` +
      `EXPLORED, and it is still painted: ${String(goneRead.matching)} of the tile's pixels are ` +
      `its owner's colour (${goneColour}) — an enemy that has walked out of range is drawn, which ` +
      'is what using the fog layer’s MEMORY (`isExplored`) for units would do',
  ).toBe(0);
  // ...and the tile itself is still painted as ground the player remembers: the marker went away
  // because the UNIT went away, not because the tile was fogged over. Without this the assertion
  // above would also pass in a build that painted the whole tile flat fog.
  expect(
    colourDistance(goneRead.centre, parseHexColour(FOG_COLOUR)),
    `tile ${String(goneTile)} is explored and must still be painted as terrain, but its centre ` +
      `reads ${describeColour(goneRead.centre)}, which is the fog colour`,
  ).toBeGreaterThan(24);
  expect(
    colourDistance(
      goneRead.centre,
      parseHexColour(terrainColour(terrainAtTile(uiAfter, goneTile))),
    ),
    `tile ${String(goneTile)} is explored and remembers ${terrainAtTile(
      uiAfter,
      goneTile,
    )}, but its centre reads ${describeColour(
      goneRead.centre,
    )} rather than that terrain's documented colour (${terrainColour(
      terrainAtTile(uiAfter, goneTile),
    )})`,
  ).toBeLessThanOrEqual(TERRAIN_CENTRE_TOLERANCE);

  /* ---- (4) cities: the rule is MEMORY, and it still paints something ---- */

  // Cities are the deliberate exception to (1)-(3), and the two directions are asserted together
  // because a build that simply stopped painting city markers would satisfy the negative half
  // alone. A city the player has explored is remembered and stays on the map (`isExplored`); a
  // rival city on ground the player has never explored is not drawn at all — the same memory rule
  // `render.ts` already states for the border tint ("a border is drawn only on an explored tile").
  const ownCity = after.cities.find((city) => city.owner === seat);
  expect(
    ownCity,
    'the seat founded no city, so "an explored city is painted" could not be checked',
  ).toBeDefined();
  if (ownCity === undefined) return;
  expect(
    isExplored(after, seat, ownCity.tile),
    'the player’s own city is not on an explored tile, so it could not be sampled as a remembered city',
  ).toBe(true);
  expect(
    await centreOnCanvas(Number(ownCity.tile)),
    'the own city could not be panned onto the canvas',
  ).toBe(true);
  const ownCityRead = await readTile(Number(ownCity.tile), CITY_COLOUR);
  expect(
    ownCityRead.matching,
    `the player's own city (tile ${String(ownCity.tile)}) is on an explored tile and its marker is ` +
      `not painted: no pixel of its tile is the city colour ${CITY_COLOUR}`,
  ).toBeGreaterThan(0);

  const unknownCities = after.cities.filter(
    (city) => city.owner !== seat && !isExplored(after, seat, city.tile),
  );
  expect(
    unknownCities.length,
    'no rival city stood on ground the player has never explored at this turn, so "a city the ' +
      'player has not explored is not painted" could not be checked — re-measure the seed and turn',
  ).toBeGreaterThan(0);
  const unknownTile = await reachableTile(unknownCities.map((city) => Number(city.tile)));
  expect(
    unknownTile,
    'no rival city on never-explored ground could be panned onto the canvas, so nothing about it ' +
      'could be sampled',
  ).toBeDefined();
  if (unknownTile === undefined) return;
  const unknownRead = await readTile(unknownTile, CITY_COLOUR);
  expect(
    unknownRead.total,
    `nothing was read from tile ${String(unknownTile)}, so "no city marker there" would be vacuous`,
  ).toBeGreaterThan(0);
  expect(
    unknownRead.matching,
    `a rival city (tile ${String(unknownTile)}) stands on ground the player has never explored ` +
      `and its marker is painted: ${String(unknownRead.matching)} of its tile's pixels are the ` +
      `city colour ${CITY_COLOUR}`,
  ).toBe(0);
});

/* ------------------------------------------------------------------ *
 * Phase 6 — the hover layer
 *
 * The readout is asserted against the engine, for the same reason everything else in this file is:
 * the claim "this tile costs 2 for the selected unit" is the ENGINE's claim (`planMove`), and the
 * claim "3 steps away" is `planRoute`'s. A test that computed either itself would be a second
 * statement of the rules, in the one place this project has banned one (`docs/INTERFACES.md`,
 * "The UI must not contain game rules").
 * ------------------------------------------------------------------ */

/** A box on screen, as `boundingBox()` reports one. */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The engine's answer, or a loud failure so a fixture cannot quietly measure nothing. */
const costOf = (state: EngineState, unitId: number, tile: number): number => {
  const plan = planMove(state, RULESET, asUnitId(unitId), asTileIndex(tile));
  if (!plan.ok) throw new Error(`the engine refuses the fixture move to tile ${String(tile)}`);
  return plan.value.cost;
};

test('hover (phase 6): the tile under the pointer is read out from the engine, and the readout never takes a click meant for the map', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  const ui = await seedApp(page, SEED, OPPONENT_OFF);
  const engine = await authoritativeState(page);
  const seat = humanSeatOf(engine);
  expect(seat, 'the state names no civilization to play as').toBeDefined();
  if (seat === undefined) return;

  // The readout exists from the first frame but is **hidden** until the pointer is over a tile —
  // there is nothing to say about a pointer that is nowhere — so the existence check asks the DOM
  // rather than the accessibility tree: a role query would report "not found" for an element that is
  // deliberately not yet shown. The role-and-name query below is the one a player's screen reader
  // would use, and it is asserted as soon as there is something to read.
  const readout = page.getByRole('status', { name: 'Tile' });
  await expect(
    page.locator("[data-floating='tile-readout']"),
    'the shell built no tile readout',
  ).toHaveCount(1);

  const settler = engine.units.find((unit) => unit.owner === seat && unit.type.includes('settler'));
  expect(settler, 'the fixture seat has no settler').toBeDefined();
  if (settler === undefined) return;
  await selectUnit(page, ui, await cameraOf(page), settler.id);

  /** Pan a tile onto the canvas and hover its centre; report where the readout landed. */
  const hoverTile = async (
    tile: number,
  ): Promise<{ readonly ok: boolean; readonly text: string; readonly box: Box | null }> => {
    await bringTileToCentre(page, ui, tile);
    const camera = await cameraOf(page);
    const box = await canvasBox(page);
    const local = tileCentre(camera, tileX(ui, tile), tileY(ui, tile));
    const onCanvas = local.x >= 0 && local.y >= 0 && local.x < box.width && local.y < box.height;
    if (!onCanvas) return { ok: false, text: '', box: null };
    const point = await tilePagePoint(page, camera, tileX(ui, tile), tileY(ui, tile));
    await page.mouse.move(point.x, point.y);
    await expect(readout).toBeVisible();
    const readoutBox = await readout.boundingBox();
    return { ok: true, text: (await readout.innerText()).trim(), box: readoutBox };
  };

  /* ------------------- (1) yields and the movement cost ------------------- */

  // A destination the engine offers the settler, preferring one that costs 2: a board where every
  // step costs 1 cannot tell "the engine priced this tile" from "the readout always says one".
  const offered = unitActions(engine, RULESET, settler.id).filter(
    (command) => command.type === 'MoveUnit',
  );
  expect(offered.length, 'the fixture settler was offered nowhere to go').toBeGreaterThan(0);
  const destinations = offered.map((command) => ({
    tile: Number(command.to),
    cost: costOf(engine, settler.id, Number(command.to)),
  }));
  const priced = destinations.find((destination) => destination.cost === 2) ?? destinations[0];
  expect(priced, 'the engine offered the settler no priced destination').toBeDefined();
  if (priced === undefined) return;

  const hovered = await hoverTile(priced.tile);
  expect(
    hovered.ok,
    `tile ${String(priced.tile)} could not be panned onto the canvas, so nothing could be hovered`,
  ).toBe(true);
  // `terrainAtTile` is the ENGINE's id for the tile ("grassland"); the readout prints the ruleset's
  // name for it ("Grassland"), so the comparison is case-insensitive — the id is what the state
  // holds, and the name is `CATALOG`'s, which is the same content the browser is running.
  const terrain = terrainAtTile(ui, priced.tile);
  expect(
    hovered.text,
    'the readout does not name the tile it is about, so a player cannot tell what it describes',
  ).toContain(`${String(tileX(ui, priced.tile))},${String(tileY(ui, priced.tile))}`);

  expect(
    hovered.text.toLowerCase(),
    `the readout of tile ${String(priced.tile)} does not name its terrain (${terrain})`,
  ).toContain(terrain.toLowerCase());
  expect(
    hovered.text,
    'the readout does not say what the selected unit would spend: the engine prices this step at ' +
      String(priced.cost),
  ).toContain(`costs ${String(priced.cost)}`);

  // The canvas's own description — the frozen contract's cursor readout — still names the same tile:
  // the hover layer is an ADDITION to it, not a replacement for it.
  expect(
    await mapDescription(page),
    'the hover layer replaced the canvas’s own pointer readout instead of sitting beside it',
  ).toContain(`${String(tileX(ui, priced.tile))},${String(tileY(ui, priced.tile))}`);

  /* ------------- (3) a far, explored tile is a journey, priced ------------ */

  const far = engine.map.terrain.findIndex(
    (_terrain, tile) =>
      isExplored(engine, seat, asTileIndex(tile)) &&
      tile !== Number(settler.tile) &&
      !planMove(engine, RULESET, settler.id, asTileIndex(tile)).ok,
  );
  expect(far, 'no explored far tile exists on the fixture board').toBeGreaterThanOrEqual(0);
  // Asked of the board **as it stands now**: the sections above only hover, but a readout whose
  // expectation was captured before them would be comparing two different boards the moment one of
  // them did anything at all.
  const atFar = await authoritativeState(page);
  const route = planRoute(atFar, RULESET, settler.id, asTileIndex(far));
  if (route.ok && route.value.steps.length > 1) {
    const farHover = await hoverTile(far);
    if (farHover.ok) {
      expect(
        farHover.text,
        `the readout of distant tile ${String(far)} does not give the engine's route length ` +
          `(${String(route.value.steps.length)} steps)`,
      ).toContain(`${String(route.value.steps.length)} steps away`);
    }
  }

  /* ------------- (4) and nothing about ground the player has not seen ----- */

  // The readout is a *tooltip*, and a tooltip that named a rival standing on unexplored ground
  // would be the §7.8 fog leak with a new surface. The vacuity guard first: the state really does
  // know where these units are.
  const hidden = engine.units.filter(
    (unit) => unit.owner !== seat && !isExplored(engine, seat, unit.tile),
  );
  expect(
    hidden.length,
    'no rival stood on unexplored ground on this board, so the fog half of the readout could not ' +
      'be observed — re-measure the seed',
  ).toBeGreaterThan(0);
  const hiddenUnit = hidden.find((unit) => Number(unit.tile) !== priced.tile);
  expect(hiddenUnit, 'the only hidden rival is the tile already hovered').toBeDefined();
  if (hiddenUnit === undefined) return;
  const hiddenHover = await hoverTile(Number(hiddenUnit.tile));
  if (hiddenHover.ok) {
    expect(
      hiddenHover.text,
      'the readout describes ground the player has never explored, which the map itself paints as flat fog',
    ).toContain('unexplored');
    expect(
      hiddenHover.text,
      `the readout named a rival (${hiddenUnit.type}) the player cannot see`,
    ).not.toContain(hiddenUnit.type);
  }

  /* ------------------ (5) and it goes away with the pointer -------------- */

  await page.mouse.move(2, 2);
  await expect(readout, 'the readout stayed on screen after the pointer left the map').toBeHidden();

  /* ---------------- (2) the readout never takes a click ----------------
   * Last, because the click is a real order: it moves a unit.
   *
   * **The hover is taken again here, and that is not tidiness.** Section (5) leaves the pointer off
   * the map, which hides the readout; a hit test at the box it *used* to occupy would then be asking
   * the browser about empty canvas, and the assertion would pass with the readout hit-testable —
   * measured, with `pointer-events: auto` on the readout this block passed until the hover was
   * re-taken. So the readout is put back on screen, its visibility is asserted, and only then is the
   * browser asked what owns the point at its middle.
   */
  const again = await hoverTile(priced.tile);
  expect(again.ok, 'the priced tile could not be hovered a second time').toBe(true);
  await expect(readout, 'the readout is not on screen at the moment of the hit test').toBeVisible();
  expect(again.box, 'the readout has no box to hit-test').not.toBeNull();
  if (again.box === null) return;
  const middle = {
    x: again.box.x + again.box.width / 2,
    y: again.box.y + again.box.height / 2,
  };
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? 'nothing',
      middle,
    ),
    'the tile readout is hit-testable: a box floating over the map that can be hit is a box that ' +
      'eats the clicks aimed at the tiles beneath it',
  ).toBe('CANVAS');

  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (canvas === null) return;
    const counter = { clicks: 0 };
    (window as unknown as { __HOVER_CLICKS__?: { clicks: number } }).__HOVER_CLICKS__ = counter;
    canvas.addEventListener('click', () => {
      counter.clicks += 1;
    });
  });
  await page.mouse.click(middle.x, middle.y);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __HOVER_CLICKS__?: { clicks: number } }).__HOVER_CLICKS__?.clicks ??
        -1,
    ),
    'a click at the middle of the tile readout never reached the canvas, so the readout took a ' +
      'click the player aimed at the map',
  ).toBe(1);
});
