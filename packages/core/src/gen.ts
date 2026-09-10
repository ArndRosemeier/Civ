/**
 * Deterministic map generation. See docs/INTERFACES.md (W1) and PLAN.md 5.3
 * (determinism) / 5.4 (data layout).
 *
 * Two properties drive the design:
 *
 * 1. **Terrain is position-determined.** Elevation and moisture come from an
 *    integer hash of `(x, y, salt)`, never from the RNG stream. The same
 *    coordinates always produce the same value, so the map is reproducible and
 *    independent of iteration order or of how many RNG draws happened earlier.
 * 2. **Sea level is a quantile, not a constant.** All elevations are computed,
 *    ranked, and the lowest `OCEAN_PERMILLE` of them become water; the
 *    mountain/hill cut-offs are quantiles of the *land* elevations. Deriving the
 *    thresholds from the data keeps the land ratio stable across seeds and
 *    rulesets, so no elevation magic number ever needs tuning.
 *
 * Everything is integer arithmetic (`Math.imul`, `Math.floor`, IEEE `+ - * /`);
 * transcendentals and ambient randomness are lint-banned in this package and
 * would break the state-hash guarantee anyway.
 */

import { asTileIndex, type TerrainId, type TileIndex } from './ids.js';
import {
  TERRAIN_BY_ROLE,
  distance8,
  neighbors8,
  type GameMap,
  type RulesetView,
  type TerrainRole,
  type TerrainYields,
} from './map.js';
import { nextBelow, seedRng, type RngState } from './rng.js';

export interface GenOptions {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly civCount: number;
}

export interface GeneratedWorld {
  readonly map: GameMap;
  readonly rng: RngState; // RNG state AFTER generation consumed its draws
  readonly starts: readonly TileIndex[]; // exactly civCount distinct, passable, on land
}

/* ------------------------------------------------------------------ *
 * Tuning constants. Every one of these is an *area fraction* (a quantile
 * parameter), never an elevation value: the actual thresholds are derived
 * from the generated elevations at runtime.
 * ------------------------------------------------------------------ */

/** Share of all tiles that becomes water (per mille) — land stays ~38%. */
const OCEAN_PERMILLE = 620;
/** Share of land that becomes mountains, taken from the highest elevations. */
const MOUNTAIN_LAND_PERMILLE = 120;
/** Share of land that becomes hills, taken from the next-highest elevations. */
const HILL_LAND_PERMILLE = 220;
/** Share of lowland that is grassland rather than plains (per mille). */
const GRASSLAND_LOWLAND_PERMILLE = 550;

/** Minimum Chebyshev distance between two starts: never adjacent, never equal. */
const MIN_START_DISTANCE = 2;
/** How many of the best-scoring tiles the RNG may draw the first start from. */
const START_POOL = 24;
/**
 * Land fragments smaller than this are not accepted as homelands *when enough
 * proper land remains*: greedy max-min spreading would otherwise happily strand
 * a civilization on a two-tile islet that the noise happened to leave behind.
 */
const MIN_START_COMPONENT = 8;

/* ------------------------------------------------------------------ *
 * Fixed-point helpers. Noise is Q12: FIX represents 1.0, so a value in
 * [0, FIX) is a fraction in [0, 1). Q12 keeps every intermediate product
 * below 2^31, so `Math.imul` stays exact and results cannot vary between
 * JS engines.
 * ------------------------------------------------------------------ */

const FIX_BITS = 12;
const FIX = 1 << FIX_BITS; // 4096

/** Octave lattice spacings in tiles and their weights (largest scale first). */
const OCTAVE_CELLS = [16, 8, 4, 2] as const;
const OCTAVE_WEIGHTS = [8, 4, 2, 1] as const;
const OCTAVE_WEIGHT_TOTAL = 15; // 8 + 4 + 2 + 1

/** Distinct feature salts so elevation and moisture are independent fields. */
const SALT_ELEVATION = 0x1b873593;
const SALT_MOISTURE = 0xcc9e2d51;

/** Mix three 32-bit integers into one well-avalanched unsigned 32-bit value. */
const mix32 = (a: number, b: number, c: number): number => {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1);
  h = (h ^ Math.imul(c | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = h ^ (h >>> 15);
  return h >>> 0;
};

/** Integer hash of a lattice point: the whole basis of the noise fields. */
const hashAt = (x: number, y: number, salt: number): number => mix32(x, y, salt);

/** Lattice value at integer coordinates, as Q12 in [0, FIX). */
const latticeAt = (ix: number, iy: number, salt: number): number => hashAt(ix, iy, salt) >>> 20;

/** Smoothstep `3t² - 2t³` on a Q12 fraction; removes lattice creases. */
const smoothStep = (t: number): number => {
  const squared = Math.imul(t, t) >>> FIX_BITS; // Q12
  const inner = 3 * FIX - 2 * t; // Q12, always positive for t <= FIX
  return Math.imul(squared, inner) >>> FIX_BITS;
};

/** Linear interpolation of two Q12 values with a Q12 weight. */
const lerp = (a: number, b: number, t: number): number => a + Math.floor(Math.imul(b - a, t) / FIX);

/** Bilinear value noise at tile `(x, y)` with lattice spacing `cell`. */
const valueNoise = (x: number, y: number, cell: number, salt: number): number => {
  const ix = Math.floor(x / cell);
  const iy = Math.floor(y / cell);
  const tx = smoothStep(Math.floor(((x - ix * cell) * FIX) / cell));
  const ty = smoothStep(Math.floor(((y - iy * cell) * FIX) / cell));

  const top = lerp(latticeAt(ix, iy, salt), latticeAt(ix + 1, iy, salt), tx);
  const bottom = lerp(latticeAt(ix, iy + 1, salt), latticeAt(ix + 1, iy + 1, salt), tx);
  return lerp(top, bottom, ty);
};

/** Multi-octave (fractional Brownian) value noise, Q12 in [0, FIX). */
const fbm = (x: number, y: number, seedSalt: number, featureSalt: number): number => {
  let sum = 0;
  for (let octave = 0; octave < OCTAVE_CELLS.length; octave++) {
    const cell = OCTAVE_CELLS[octave] ?? 1;
    const weight = OCTAVE_WEIGHTS[octave] ?? 1;
    sum += weight * valueNoise(x, y, cell, mix32(seedSalt, featureSalt, octave));
  }
  return Math.floor(sum / OCTAVE_WEIGHT_TOTAL);
};

/**
 * Edge falloff, Q12 in [0, FIX]: 0 at the map centre, FIX at the border, with a
 * squared (Chebyshev) profile so land tends to form one coherent interior
 * landmass instead of touching the edges.
 */
const edgeFalloff = (x: number, y: number, width: number, height: number): number => {
  const spanX = width > 1 ? width - 1 : 1;
  const spanY = height > 1 ? height - 1 : 1;
  const dx = Math.abs(2 * x - (width - 1));
  const dy = Math.abs(2 * y - (height - 1));
  const d = Math.max(Math.floor((dx * FIX) / spanX), Math.floor((dy * FIX) / spanY));
  return Math.imul(d, d) >>> FIX_BITS;
};

/** `arr[i]`, but fails loudly instead of silently degrading to `undefined`. */
const at = <T>(arr: readonly T[], i: number): T => {
  const value = arr[i];
  if (value === undefined) {
    throw new RangeError(`generateWorld: index ${String(i)} is out of range`);
  }
  return value;
};

/** Resolve every terrain role generation can emit, or fail with the role name. */
const resolveRoleIds = (
  ruleset: RulesetView,
): { readonly [R in TerrainRole]: TerrainId } => {
  const pick = (role: TerrainRole): TerrainId => {
    const def = TERRAIN_BY_ROLE(ruleset, role);
    if (def === undefined) {
      throw new Error(`generateWorld: ruleset is missing terrain role "${role}"`);
    }
    return def.id;
  };
  return {
    ocean: pick('ocean'),
    coast: pick('coast'),
    grassland: pick('grassland'),
    plains: pick('plains'),
    hills: pick('hills'),
    mountains: pick('mountains'),
  };
};

/** Weighted yields, used only to prefer richer start tiles. */
const tileScore = (yields: TerrainYields | undefined): number =>
  yields === undefined ? 0 : 2 * yields.food + yields.shields + yields.commerce;

/** Yields of a tile plus its 8 neighbours — a crude "is this a good capital" score. */
const startScore = (
  map: GameMap,
  yieldsById: ReadonlyMap<TerrainId, TerrainYields>,
  index: number,
): number => {
  const own = map.terrain[index];
  let score = own === undefined ? 0 : tileScore(yieldsById.get(own));
  for (const neighbour of neighbors8(map, index)) {
    const id = map.terrain[neighbour];
    if (id !== undefined) score += tileScore(yieldsById.get(id));
  }
  return score;
};

/** Size of the connected land component (8-way) each tile belongs to; 0 = water. */
const landComponentSizes = (map: GameMap, isWater: readonly boolean[]): number[] => {
  const count = map.terrain.length;
  const componentOf: number[] = new Array<number>(count).fill(-1);
  const stack: number[] = [];
  let components = 0;

  for (let start = 0; start < count; start++) {
    if (isWater[start] !== false || at(componentOf, start) >= 0) continue;
    const id = components;
    components += 1;
    componentOf[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      for (const neighbour of neighbors8(map, current)) {
        if (isWater[neighbour] !== false || at(componentOf, neighbour) >= 0) continue;
        componentOf[neighbour] = id;
        stack.push(neighbour);
      }
    }
  }

  const sizes: number[] = new Array<number>(components).fill(0);
  for (let i = 0; i < count; i++) {
    const id = at(componentOf, i);
    if (id >= 0) sizes[id] = at(sizes, id) + 1;
  }

  const perTile: number[] = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    const id = at(componentOf, i);
    if (id >= 0) perTile[i] = at(sizes, id);
  }
  return perTile;
};

/**
 * Generate a world.
 *
 * Deterministic for a given `(options, ruleset)`: same seed, same map, same
 * starts, same returned RNG state. Throws when the ruleset lacks a terrain role
 * generation needs, or when the map cannot host `civCount` spread-out starts
 * (W3 converts both into typed `SetupError`s).
 */
export const generateWorld = (opts: GenOptions, ruleset: RulesetView): GeneratedWorld => {
  const { width, height, seed, civCount } = opts;

  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`generateWorld: width must be a positive integer, got ${String(width)}`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError(`generateWorld: height must be a positive integer, got ${String(height)}`);
  }
  if (!Number.isInteger(seed)) {
    throw new RangeError(`generateWorld: seed must be an integer, got ${String(seed)}`);
  }
  if (!Number.isInteger(civCount) || civCount <= 0) {
    throw new RangeError(`generateWorld: civCount must be a positive integer, got ${String(civCount)}`);
  }

  const roleIds = resolveRoleIds(ruleset); // throws early on a missing role
  const count = width * height;
  const seedSalt = mix32(seed | 0, 0x2545f491, 0x4b7a70e9);

  // 1. Elevation field: hashed value noise shaped by the edge falloff.
  const elevation: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const base = fbm(x, y, seedSalt, SALT_ELEVATION);
    elevation.push(Math.floor((base * (FIX - edgeFalloff(x, y, width, height))) / FIX));
  }

  // 2. Sea level by quantile: `order` is every tile ranked by (elevation, index),
  //    so the sea level is simply the elevation at rank `oceanCount - 1` — a
  //    threshold derived from the data, never a tuned constant. Everything below
  //    it floods, and tiles sitting exactly on the threshold are flooded in index
  //    order until the target count is reached, so the land ratio is exact and
  //    independent of sort stability.
  const order: number[] = [];
  for (let i = 0; i < count; i++) order.push(i);
  order.sort((a, b) => {
    const ea = at(elevation, a);
    const eb = at(elevation, b);
    return ea === eb ? a - b : ea - eb;
  });

  const oceanCount = Math.floor((count * OCEAN_PERMILLE) / 1000);
  const isWater: boolean[] = new Array<boolean>(count).fill(false);
  if (oceanCount > 0) {
    const seaLevel = at(elevation, at(order, oceanCount - 1));
    let flooded = 0;
    for (const index of order) {
      if (at(elevation, index) < seaLevel) {
        isWater[index] = true;
        flooded += 1;
      }
    }
    for (const index of order) {
      if (flooded >= oceanCount) break;
      if (at(elevation, index) === seaLevel && !isWater[index]) {
        isWater[index] = true;
        flooded += 1;
      }
    }
  }
  const landRank = order.slice(oceanCount);

  // 3. Land by quantile of land elevation: highest -> mountains, next -> hills.
  const mountainCount = Math.floor((landRank.length * MOUNTAIN_LAND_PERMILLE) / 1000);
  const hillCount = Math.floor((landRank.length * HILL_LAND_PERMILLE) / 1000);
  const lowlandCount = landRank.length - mountainCount - hillCount;

  const roleByIndex: TerrainRole[] = new Array<TerrainRole>(count).fill('ocean');
  for (const [rank, index] of landRank.entries()) {
    if (rank < lowlandCount) continue; // lowland: decided by moisture below
    roleByIndex[index] = rank < lowlandCount + hillCount ? 'hills' : 'mountains';
  }

  // 4. Lowland split by a second (moisture) noise field, cut by quantile:
  //    the wettest GRASSLAND_LOWLAND_PERMILLE become grassland, the rest plains.
  const lowlands: { readonly index: number; readonly moisture: number }[] = [];
  for (const [rank, index] of landRank.entries()) {
    if (rank >= lowlandCount) break;
    const x = index % width;
    const y = Math.floor(index / width);
    lowlands.push({ index, moisture: fbm(x, y, seedSalt, SALT_MOISTURE) });
  }
  lowlands.sort((a, b) => (a.moisture === b.moisture ? a.index - b.index : a.moisture - b.moisture));
  const plainsCount = lowlands.length - Math.floor((lowlands.length * GRASSLAND_LOWLAND_PERMILLE) / 1000);
  for (const [rank, tile] of lowlands.entries()) {
    roleByIndex[tile.index] = rank < plainsCount ? 'plains' : 'grassland';
  }

  const terrain: TerrainId[] = [];
  for (const role of roleByIndex) terrain.push(roleIds[role]);
  const map: GameMap = { width, height, terrain };

  // 5. Second pass: water touching land (8-way) becomes coast, the rest ocean.
  for (let i = 0; i < count; i++) {
    if (isWater[i] !== true) continue;
    const touchesLand = neighbors8(map, i).some((neighbour) => isWater[neighbour] === false);
    terrain[i] = touchesLand ? roleIds.coast : roleIds.ocean;
  }

  // 6. Starts: distinct passable land tiles, spread out by greedy max-min
  //    distance, preferring better yields, ties broken by index.
  const impassableById = new Map<TerrainId, boolean>();
  const yieldsById = new Map<TerrainId, TerrainYields>();
  for (const def of ruleset.terrains) {
    impassableById.set(def.id, def.impassable);
    yieldsById.set(def.id, def.yields);
  }

  const candidates: { readonly index: number; readonly score: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (isWater[i] !== false) continue;
    const id = terrain[i];
    if (id === undefined) continue;
    if (impassableById.get(id) !== false) continue; // unknown id => not a legal start
    candidates.push({ index: i, score: startScore(map, yieldsById, i) });
  }

  // Drop fragments too small to be a homeland, but only while enough candidates
  // remain — an archipelago map must still be able to host its civilizations.
  const componentSize = landComponentSizes(map, isWater);
  const onProperLand = candidates.filter(
    (candidate) => at(componentSize, candidate.index) >= MIN_START_COMPONENT,
  );
  const sites = onProperLand.length >= civCount ? onProperLand : candidates;

  if (sites.length < civCount) {
    throw new Error(
      `generateWorld: too few valid start candidates (found ${String(sites.length)}, ` +
        `need ${String(civCount)})`,
    );
  }

  // Best-scoring first, then lowest index: the order also serves as the
  // tie-break for every later greedy step.
  sites.sort((a, b) => (a.score === b.score ? a.index - b.index : b.score - a.score));

  // RNG: the first start is drawn from the top of the scored pool, so the seed
  // genuinely influences where civilizations begin. Everything after that is
  // the deterministic greedy spread below, which appends no further draws.
  let rng: RngState = seedRng(seed);
  const poolSize = Math.min(START_POOL, sites.length);
  const draw = nextBelow(rng, poolSize);
  rng = draw[1];
  const first = at(sites, draw[0]);

  const starts: TileIndex[] = [asTileIndex(first.index)];
  const minDistance: number[] = [];
  for (const candidate of sites) {
    minDistance.push(distance8(map, candidate.index, first.index));
  }

  while (starts.length < civCount) {
    let bestSlot = -1;
    let bestDistance = -1;
    let bestScore = 0;
    for (const [slot, candidate] of sites.entries()) {
      const d = at(minDistance, slot);
      if (d < MIN_START_DISTANCE) continue; // too close, or already taken
      if (d > bestDistance || (d === bestDistance && candidate.score > bestScore)) {
        bestSlot = slot;
        bestDistance = d;
        bestScore = candidate.score;
      }
    }
    if (bestSlot < 0) {
      throw new Error(
        `generateWorld: too few valid start candidates (found ${String(sites.length)}, need ` +
          `${String(civCount)} at distance >= ${String(MIN_START_DISTANCE)})`,
      );
    }

    const chosen = at(sites, bestSlot);
    starts.push(asTileIndex(chosen.index));
    for (const [slot, candidate] of sites.entries()) {
      const d = distance8(map, candidate.index, chosen.index);
      if (d < at(minDistance, slot)) minDistance[slot] = d;
    }
  }

  return { map, rng, starts };
};
