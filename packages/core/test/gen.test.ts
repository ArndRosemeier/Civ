import { describe, expect, it } from 'vitest';
import { generateWorld, type GenOptions } from '../src/gen.js';
import { asTerrainId, type TerrainId } from '../src/ids.js';
import {
  distance8,
  neighbors8,
  type GameMap,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { nextUint32, seedRng } from '../src/rng.js';

// A local stand-in ruleset: generation only needs the structural view, so the
// test does not depend on any other workstream's content package.
const TERRAINS: readonly TerrainDef[] = [
  {
    id: asTerrainId('ocean'),
    role: 'ocean',
    name: 'Ocean',
    moveCost: 1,
    defenseBonusPct: 10,
    yields: { food: 1, shields: 0, commerce: 0 },
    impassable: true,
  },
  {
    id: asTerrainId('coast'),
    role: 'coast',
    name: 'Coast',
    moveCost: 1,
    defenseBonusPct: 10,
    yields: { food: 1, shields: 0, commerce: 2 },
    impassable: false,
  },
  {
    id: asTerrainId('grassland'),
    role: 'grassland',
    name: 'Grassland',
    moveCost: 1,
    defenseBonusPct: 10,
    yields: { food: 2, shields: 0, commerce: 0 },
    impassable: false,
  },
  {
    id: asTerrainId('plains'),
    role: 'plains',
    name: 'Plains',
    moveCost: 1,
    defenseBonusPct: 10,
    yields: { food: 1, shields: 1, commerce: 0 },
    impassable: false,
  },
  {
    id: asTerrainId('hills'),
    role: 'hills',
    name: 'Hills',
    moveCost: 2,
    defenseBonusPct: 50,
    yields: { food: 1, shields: 1, commerce: 0 },
    impassable: false,
  },
  {
    id: asTerrainId('mountains'),
    role: 'mountains',
    name: 'Mountains',
    moveCost: 3,
    defenseBonusPct: 100,
    yields: { food: 0, shields: 1, commerce: 1 },
    impassable: true,
  },
];

/**
 * A `RulesetView` around a terrain catalog, with no units and no improvements.
 *
 * `RulesetView.units` is required (M2's post-review amendment) and
 * `RulesetView.improvements` is required from M4a on, and an empty catalog is how
 * a view says "none of those" — which is exactly what generation needs: it
 * resolves terrain roles and never looks at a unit or an improvement. Spelling the
 * construction once keeps every view in this file honest instead of three copies of
 * a literal that could drift apart.
 */
const view = (terrains: readonly TerrainDef[]): RulesetView => ({
  terrains,
  units: [],
  improvements: [],
  fidelity: 'tuned',
});

const RULESET: RulesetView = view(TERRAINS);
const KNOWN_IDS = new Set<TerrainId>(TERRAINS.map((t) => t.id));
const DEF_BY_ID = new Map<TerrainId, TerrainDef>(TERRAINS.map((t) => [t.id, t]));

const BASE: GenOptions = { width: 40, height: 40, seed: 42, civCount: 4 };

const pick = <T>(arr: readonly T[], i: number): T => {
  const value = arr[i];
  if (value === undefined) throw new Error(`test helper: index ${String(i)} is out of range`);
  return value;
};

const roleAt = (map: GameMap, index: number): TerrainRole | undefined => {
  const id = map.terrain[index];
  return id === undefined ? undefined : DEF_BY_ID.get(id)?.role;
};

const isWater = (map: GameMap, index: number): boolean => {
  const role = roleAt(map, index);
  return role === 'ocean' || role === 'coast';
};

const waterCount = (world: ReturnType<typeof generateWorld>): number => {
  let n = 0;
  for (let i = 0; i < world.map.terrain.length; i++) if (isWater(world.map, i)) n += 1;
  return n;
};

describe('generateWorld — determinism', () => {
  it('produces an identical terrain array for the same seed', () => {
    const a = generateWorld(BASE, RULESET);
    const b = generateWorld({ ...BASE }, RULESET);

    expect(a.map.terrain).toEqual(b.map.terrain);
    expect(a.map.terrain).toHaveLength(BASE.width * BASE.height);
    expect(a.map.width).toBe(BASE.width);
    expect(a.map.height).toBe(BASE.height);
    expect(a.starts).toEqual(b.starts);
    expect(a.rng).toEqual(b.rng);
  });

  it('produces a different map for a different seed', () => {
    const a = generateWorld({ ...BASE, seed: 42 }, RULESET);
    const b = generateWorld({ ...BASE, seed: 43 }, RULESET);

    expect(a.map.terrain).not.toEqual(b.map.terrain);
    const differing = a.map.terrain.filter((id, i) => id !== b.map.terrain[i]).length;
    expect(differing).toBeGreaterThan(100);
  });

  it('is reproducible for a spread of seeds and map sizes', () => {
    const sizes: readonly (readonly [number, number])[] = [
      [24, 24],
      [40, 24],
      [31, 17],
    ];
    for (const seed of [1, 2, 42, 1337, -7]) {
      for (const [width, height] of sizes) {
        const opts: GenOptions = { width, height, seed, civCount: 3 };
        const a = generateWorld(opts, RULESET);
        const b = generateWorld(opts, RULESET);
        expect(a.map.terrain).toEqual(b.map.terrain);
        expect(a.starts).toEqual(b.starts);
        expect(a.map.terrain).toHaveLength(width * height);
      }
    }
  });

  it('does not depend on civCount: terrain comes from hashes, not the RNG stream', () => {
    const two = generateWorld({ ...BASE, civCount: 2 }, RULESET);
    const six = generateWorld({ ...BASE, civCount: 6 }, RULESET);

    expect(six.map.terrain).toEqual(two.map.terrain);
    // The greedy spread is deterministic, so the smaller game's starts are a
    // prefix of the larger game's.
    expect(six.starts.slice(0, 2)).toEqual(two.starts);
  });
});

describe('generateWorld — terrain structure', () => {
  it('floods a stable ~62% of tiles whatever the seed (quantile sea level)', () => {
    const counts = [1, 42, 1337, 90210].map((seed) =>
      waterCount(generateWorld({ ...BASE, seed }, RULESET)),
    );
    for (const count of counts) expect(count).toBe(pick(counts, 0));

    const fraction = pick(counts, 0) / (BASE.width * BASE.height);
    expect(fraction).toBeGreaterThan(0.6);
    expect(fraction).toBeLessThan(0.65);
  });

  it('holds the land ratio for small as well as large maps', () => {
    for (const [width, height] of [
      [13, 13],
      [20, 35],
      [60, 60],
    ] as const) {
      const world = generateWorld({ width, height, seed: 42, civCount: 2 }, RULESET);
      const fraction = waterCount(world) / (width * height);
      expect(fraction).toBeGreaterThan(0.58);
      expect(fraction).toBeLessThan(0.66);
    }
  });

  it('makes a water tile coast exactly when it touches land', () => {
    const world = generateWorld(BASE, RULESET);
    let coast = 0;
    let ocean = 0;

    for (let i = 0; i < world.map.terrain.length; i++) {
      const role = roleAt(world.map, i);
      if (role !== 'ocean' && role !== 'coast') continue;

      const touchesLand = neighbors8(world.map, i).some((n) => {
        const neighbourRole = roleAt(world.map, n);
        return (
          neighbourRole !== undefined && neighbourRole !== 'ocean' && neighbourRole !== 'coast'
        );
      });
      expect(role).toBe(touchesLand ? 'coast' : 'ocean');
      if (role === 'coast') coast += 1;
      else ocean += 1;
    }

    // Both water roles must actually occur, otherwise the assertion above is vacuous.
    expect(coast).toBeGreaterThan(0);
    expect(ocean).toBeGreaterThan(0);
  });

  it('emits only ruleset terrain ids, uses every land role, and keeps land/water disjoint', () => {
    const world = generateWorld(BASE, RULESET);
    const counts = new Map<TerrainRole, number>();
    for (const id of world.map.terrain) {
      expect(KNOWN_IDS.has(id)).toBe(true);
      const role = DEF_BY_ID.get(id)?.role;
      if (role !== undefined) counts.set(role, (counts.get(role) ?? 0) + 1);
    }

    for (const role of ['ocean', 'coast', 'grassland', 'plains', 'hills', 'mountains'] as const) {
      expect(counts.get(role) ?? 0).toBeGreaterThan(0);
    }
    expect(
      (counts.get('ocean') ?? 0) +
        (counts.get('coast') ?? 0) +
        (counts.get('grassland') ?? 0) +
        (counts.get('plains') ?? 0) +
        (counts.get('hills') ?? 0) +
        (counts.get('mountains') ?? 0),
    ).toBe(world.map.terrain.length);
  });
});

describe('generateWorld — starting positions', () => {
  it('returns exactly civCount starts', () => {
    for (const civCount of [1, 2, 4, 8]) {
      const world = generateWorld({ width: 60, height: 60, seed: 7, civCount }, RULESET);
      expect(world.starts).toHaveLength(civCount);
    }
  });

  it('places every start on land, on a passable tile, inside the map', () => {
    for (const seed of [3, 42, 99, 2024]) {
      const world = generateWorld({ ...BASE, seed }, RULESET);
      expect(world.starts).toHaveLength(BASE.civCount);

      for (const start of world.starts) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThan(world.map.terrain.length);

        const role = roleAt(world.map, start);
        expect(role).toBeDefined();
        expect(role === 'ocean' || role === 'coast').toBe(false);

        const id = world.map.terrain[start];
        expect(id).toBeDefined();
        expect(id === undefined ? true : DEF_BY_ID.get(id)?.impassable).toBe(false);
      }
    }
  });

  it('keeps starts mutually distinct and non-adjacent (distance > 1)', () => {
    for (const seed of [5, 42, 321]) {
      const world = generateWorld({ width: 60, height: 60, seed, civCount: 6 }, RULESET);
      expect(new Set(world.starts).size).toBe(world.starts.length);

      for (let i = 0; i < world.starts.length; i++) {
        for (let j = i + 1; j < world.starts.length; j++) {
          const d = distance8(world.map, pick(world.starts, i), pick(world.starts, j));
          expect(d).toBeGreaterThan(1);
        }
      }
    }
  });

  it('spreads a crowded map as far apart as it can', () => {
    const world = generateWorld({ width: 30, height: 30, seed: 8, civCount: 2 }, RULESET);
    const [a, b] = world.starts;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a !== undefined && b !== undefined) {
      expect(distance8(world.map, a, b)).toBeGreaterThan(2);
    }
  });
});

describe('generateWorld — goody huts', () => {
  it('places at least one hut, ascending, distinct and inside the map', () => {
    const world = generateWorld(BASE, RULESET);
    const huts = world.map.huts;

    expect(huts.length).toBeGreaterThan(0);
    expect([...huts]).toEqual([...huts].sort((a, b) => a - b)); // ascending
    expect(new Set(huts).size).toBe(huts.length); // no tile has two huts
    for (const hut of huts) {
      expect(hut).toBeGreaterThanOrEqual(0);
      expect(hut).toBeLessThan(world.map.terrain.length);
    }
  });

  it('puts every hut on passable land and never on a start tile', () => {
    for (const seed of [1, 42, 1337, 90210]) {
      const world = generateWorld({ ...BASE, seed }, RULESET);

      for (const hut of world.map.huts) {
        // Land, not water.
        expect(isWater(world.map, hut)).toBe(false);
        const role = roleAt(world.map, hut);
        expect(role).toBeDefined();

        // Enterable: a hut inside a mountain range could never be reached, so it
        // would be map decoration pretending to be a reward.
        const id = world.map.terrain[hut];
        expect(id).toBeDefined();
        expect(id === undefined ? true : DEF_BY_ID.get(id)?.impassable).toBe(false);

        // Never on a start: a civilization must not begin the game standing on a
        // hut it would consume before anyone could see it.
        expect(world.starts).not.toContain(hut);
      }
    }
  });

  it('scales the hut count with the map, and reproduces it exactly for a seed', () => {
    const sizes = [
      [20, 20],
      [40, 40],
      [60, 60],
    ] as const;

    const counts = sizes.map(
      ([width, height]) =>
        generateWorld({ width, height, seed: 42, civCount: 3 }, RULESET).map.huts.length,
    );

    // More tiles, more huts (the placeholder is one per HUT_TILES_PER_HUT tiles).
    expect(pick(counts, 0)).toBeGreaterThan(0);
    expect(pick(counts, 1)).toBeGreaterThan(pick(counts, 0));
    expect(pick(counts, 2)).toBeGreaterThan(pick(counts, 1));

    // Same seed, same huts — placement draws from the returned RNG state.
    const a = generateWorld({ ...BASE, seed: 5 }, RULESET);
    const b = generateWorld({ ...BASE, seed: 5 }, RULESET);
    expect(a.map.huts).toEqual(b.map.huts);
  });

  it('moves the huts when the seed changes', () => {
    // Not every seed pair need differ in principle, so this asserts only that the
    // placement is seed-dependent at all: a fixed layout would be indistinguishable
    // from a hard-coded one.
    const layouts = [1, 2, 3, 4].map((seed) =>
      generateWorld({ ...BASE, seed }, RULESET).map.huts.join(','),
    );
    expect(new Set(layouts).size).toBeGreaterThan(1);
  });

  it('does not disturb terrain or starts, which are drawn before it', () => {
    // Huts consume RNG draws after the starts, so the world's terrain (hashed, not
    // drawn) and the chosen starts are exactly what they were: the step is
    // additive.
    const world = generateWorld(BASE, RULESET);
    const again = generateWorld(BASE, RULESET);
    expect(again.map.terrain).toEqual(world.map.terrain);
    expect(again.starts).toEqual(world.starts);
    expect(again.map.huts).toEqual(world.map.huts);
  });
});

describe('generateWorld — rng state', () => {
  it('returns the advanced state, identical for the same seed', () => {
    const a = generateWorld(BASE, RULESET);
    const b = generateWorld({ ...BASE }, RULESET);

    expect(a.rng).toEqual(b.rng);
    expect(a.rng).not.toEqual(seedRng(BASE.seed));
    // The returned state is a real RNG state, usable downstream.
    expect(nextUint32(a.rng)[0]).toBe(nextUint32(a.rng)[0]);
    expect(nextUint32(a.rng)[1]).not.toEqual(seedRng(BASE.seed));
  });

  it('returns a different advanced state for a different seed', () => {
    const a = generateWorld({ ...BASE, seed: 5 }, RULESET);
    const b = generateWorld({ ...BASE, seed: 6 }, RULESET);
    expect(a.rng).not.toEqual(b.rng);
  });
});

describe('generateWorld — failure modes', () => {
  it('throws when a required terrain role is missing from the ruleset', () => {
    const withoutMountains: RulesetView = view(TERRAINS.filter((t) => t.role !== 'mountains'));
    expect(() => generateWorld(BASE, withoutMountains)).toThrow(/missing terrain role "mountains"/);
  });

  it('throws when no tile can host a start', () => {
    const allImpassable: RulesetView = view(TERRAINS.map((t) => ({ ...t, impassable: true })));
    expect(() => generateWorld(BASE, allImpassable)).toThrow(/too few valid start candidates/);
  });

  it('rejects nonsensical options instead of guessing', () => {
    expect(() => generateWorld({ ...BASE, width: 0 }, RULESET)).toThrow(RangeError);
    expect(() => generateWorld({ ...BASE, height: -1 }, RULESET)).toThrow(RangeError);
    expect(() => generateWorld({ ...BASE, civCount: 0 }, RULESET)).toThrow(RangeError);
    expect(() => generateWorld({ ...BASE, seed: 1.5 }, RULESET)).toThrow(RangeError);
  });
});

describe('generateWorld — coherence', () => {
  it('keeps the map edges mostly water and the interior coherent', () => {
    const world = generateWorld(BASE, RULESET);
    let edgeWater = 0;
    let edgeTiles = 0;
    for (let y = 0; y < world.map.height; y++) {
      for (let x = 0; x < world.map.width; x++) {
        const onEdge =
          x === 0 || y === 0 || x === world.map.width - 1 || y === world.map.height - 1;
        if (!onEdge) continue;
        edgeTiles += 1;
        if (isWater(world.map, y * world.map.width + x)) edgeWater += 1;
      }
    }
    // Falloff must push edges to ocean: comfortably above the 62% global rate.
    expect(edgeWater / edgeTiles).toBeGreaterThan(0.9);
  });

  it('keeps every start on a proper landmass, not on a detached islet', () => {
    const componentSizes = (world: ReturnType<typeof generateWorld>): readonly number[] => {
      const map = world.map;
      const seen = new Set<number>();
      const sizes: number[] = [];
      for (let i = 0; i < map.terrain.length; i++) {
        if (seen.has(i) || isWater(map, i)) continue;
        const stack: number[] = [i];
        seen.add(i);
        let size = 0;
        while (stack.length > 0) {
          const current = stack.pop();
          if (current === undefined) continue;
          size += 1;
          for (const n of neighbors8(map, current)) {
            if (seen.has(n) || isWater(map, n)) continue;
            seen.add(n);
            stack.push(n);
          }
        }
        sizes.push(size);
      }
      return sizes.sort((a, b) => b - a);
    };

    const componentOfTile = (world: ReturnType<typeof generateWorld>): Map<number, number> => {
      const map = world.map;
      const owner = new Map<number, number>();
      let id = 0;
      for (let i = 0; i < map.terrain.length; i++) {
        if (owner.has(i) || isWater(map, i)) continue;
        const stack: number[] = [i];
        owner.set(i, id);
        while (stack.length > 0) {
          const current = stack.pop();
          if (current === undefined) continue;
          for (const n of neighbors8(map, current)) {
            if (owner.has(n) || isWater(map, n)) continue;
            owner.set(n, id);
            stack.push(n);
          }
        }
        id += 1;
      }
      return owner;
    };

    for (const seed of [1, 42, 1337, 90210]) {
      const world = generateWorld({ ...BASE, seed }, RULESET);
      const sizes = componentSizes(world);
      // Coherence: the falloff must produce one dominant landmass, not confetti.
      expect(pick(sizes, 0)).toBeGreaterThan(100);

      const owner = componentOfTile(world);
      const sizeById = new Map<number, number>();
      owner.forEach((id, tile) => {
        if (!isWater(world.map, tile)) sizeById.set(id, (sizeById.get(id) ?? 0) + 1);
      });
      for (const start of world.starts) {
        const id = owner.get(start);
        expect(id).toBeDefined();
        expect(id === undefined ? 0 : (sizeById.get(id) ?? 0)).toBeGreaterThanOrEqual(8);
      }
    }
  });
});
