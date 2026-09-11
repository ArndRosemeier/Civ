import { describe, expect, it } from 'vitest';
import { generateWorld, type GenOptions } from '../src/gen.js';
import {
  asResourceId,
  asTerrainId,
  asTileIndex,
  type ResourceId,
  type TerrainId,
} from '../src/ids.js';
import {
  compareTileResources,
  distance8,
  neighbors8,
  type GameMap,
  type ResourceDef,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
  type TileResource,
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
 *
 * `resources` is **optional** on the engine's view (M4c), so the first parameter
 * form below deliberately omits the key: a view written before resources existed
 * is a valid view that simply has none. Passing rows is what the resource cases
 * do, and `rulesetWith` spells that out.
 */
const view = (terrains: readonly TerrainDef[]): RulesetView => ({
  terrains,
  units: [],
  improvements: [],
  fidelity: 'tuned',
});

/** The same view, but carrying a resource catalog — the M4c half of the shape. */
const viewWithResources = (
  terrains: readonly TerrainDef[],
  resources: readonly ResourceDef[],
): RulesetView => ({ ...view(terrains), resources });

/* ------------------------------------------------------------------ *
 * A stand-in resource catalog: one row per kind, one row on water only,
 * and overlapping terrain restrictions, so the placement cases below
 * exercise every branch the generator has (a role allowed by one row, a
 * role allowed by two, and a row that can only go somewhere no land unit
 * could ever stand).
 * ------------------------------------------------------------------ */

const RESOURCE_ROWS: readonly ResourceDef[] = [
  {
    id: asResourceId('iron'),
    name: 'Iron',
    kind: 'strategic',
    yields: { food: 0, shields: 0, commerce: 0 },
    allowedRoles: ['hills', 'mountains'],
  },
  {
    id: asResourceId('gems'),
    name: 'Gems',
    kind: 'luxury',
    yields: { food: 0, shields: 0, commerce: 0 },
    allowedRoles: ['hills', 'mountains'],
  },
  {
    id: asResourceId('wheat'),
    name: 'Wheat',
    kind: 'bonus',
    yields: { food: 1, shields: 0, commerce: 0 },
    allowedRoles: ['grassland', 'plains'],
  },
  {
    id: asResourceId('fish'),
    name: 'Fish',
    kind: 'bonus',
    yields: { food: 1, shields: 0, commerce: 0 },
    allowedRoles: ['coast'],
  },
];

const ROW_BY_ID = new Map<ResourceId, ResourceDef>(RESOURCE_ROWS.map((row) => [row.id, row]));

const RULESET: RulesetView = view(TERRAINS);
const RESOURCED: RulesetView = viewWithResources(TERRAINS, RESOURCE_ROWS);
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

/**
 * M4c's placement contract, which is the whole of what the *catalog* and the *map
 * shape* promise about resources: where a pair may sit, in what order the pairs
 * are stored, and that the same seed produces the same world. Nothing here says
 * anything about connection or gating — those are gameplay rules with their own
 * one implementation, and a placement test that implied them would be a second
 * statement of a rule that is not the generator's.
 */
describe('generateWorld — resources', () => {
  /** The row a placed pair names; a pair naming an unknown row fails loudly. */
  const rowOf = (pair: TileResource): ResourceDef => {
    const row = ROW_BY_ID.get(pair.resource);
    if (row === undefined) throw new Error(`no stand-in row for resource "${pair.resource}"`);
    return row;
  };

  const SEEDS = [1, 42, 1337, 90210] as const;

  it('places nothing when the ruleset ships no resource catalog — and still carries the key', () => {
    // `RulesetView.resources` is optional, so an M2-era structural view is a world
    // with no resources in it rather than an error. The key is present and empty:
    // it is part of `GameMap`, and therefore of every state hash, so "no resources"
    // must be spelled by an empty list rather than by an absent field.
    const world = generateWorld(BASE, RULESET);

    expect(world.map.resources).toEqual([]);
    expect('resources' in world.map).toBe(true);
    expect(Object.keys(world.map).sort()).toEqual([
      'height',
      'huts',
      'resources',
      'terrain',
      'width',
    ]);
  });

  it('places something, and only on tiles whose role the row allows', () => {
    for (const seed of SEEDS) {
      const world = generateWorld({ ...BASE, seed }, RESOURCED);
      expect(world.map.resources.length).toBeGreaterThan(0);

      for (const pair of world.map.resources) {
        const row = rowOf(pair);
        const role = roleAt(world.map, pair.tile);

        // A defined role, and one the row lists: `allowedRoles` is a placement
        // rule, and a resource on a role its row does not allow would be content
        // that contradicts itself.
        expect(role).toBeDefined();
        expect(role === undefined ? [] : [...row.allowedRoles]).toContain(role);
      }
    }
  });

  it('never places a resource on a start tile or on a hut', () => {
    // The two exclusions are the contract's, and they are different hazards: a
    // start tile must be free for the civilization that begins there, and a hut is
    // entered by a unit while a resource is connected from a city, so a shared tile
    // would be a rule nobody could state cleanly.
    for (const seed of SEEDS) {
      const world = generateWorld({ ...BASE, seed }, RESOURCED);
      expect(world.map.huts.length).toBeGreaterThan(0); // non-vacuous: there are huts to avoid

      for (const pair of world.map.resources) {
        expect(world.starts).not.toContain(pair.tile);
        expect(world.map.huts).not.toContain(pair.tile);
      }
    }
  });

  it('stores the pairs sorted by (tile, resource), with no duplicates and one per tile', () => {
    // The order is part of the contract because the list is hashed, and "at most
    // one resource per tile" is what makes the second key a tie-break rather than a
    // rule about stacking. `compareTileResources` is the one statement of the
    // order, so this compares against it rather than restating it.
    for (const seed of SEEDS) {
      const world = generateWorld({ ...BASE, seed }, RESOURCED);
      const pairs = world.map.resources;
      const sorted = [...pairs].sort(compareTileResources);

      expect(pairs).toEqual(sorted);
      expect(new Set(pairs.map((p) => `${String(p.tile)}:${p.resource}`)).size).toBe(pairs.length);
      expect(new Set(pairs.map((p) => Number(p.tile))).size).toBe(pairs.length);
      for (const pair of pairs) {
        expect(pair.tile).toBeGreaterThanOrEqual(0);
        expect(pair.tile).toBeLessThan(world.map.terrain.length);
      }
    }
  });

  it('gives every shipped row a tile somewhere, on a map big enough to hold them', () => {
    // The generator gives each row at least one copy where its terrain allows, so a
    // catalog that ships a resource is a resource that exists in the world — not a
    // row only a hand-built map could produce. (`fish` is the interesting case: it
    // is the row whose only allowed role is water.)
    for (const seed of SEEDS) {
      const world = generateWorld({ ...BASE, seed }, RESOURCED);
      const placed = new Set(world.map.resources.map((p) => p.resource));

      for (const row of RESOURCE_ROWS) expect([...placed]).toContain(row.id);
    }
  });

  it('puts a water-only row on water, which is where no road could ever go', () => {
    // The generator does not care whether a unit could stand on the tile — that is
    // not a placement rule in M4c, and a bonus resource is explicitly "just
    // terrain". Asserted because a generator that quietly restricted resources to
    // passable land would break nothing else in this file.
    const world = generateWorld({ ...BASE, seed: 42 }, RESOURCED);
    const fish = world.map.resources.filter((p) => p.resource === asResourceId('fish'));

    expect(fish.length).toBeGreaterThan(0);
    for (const pair of fish) expect(roleAt(world.map, pair.tile)).toBe('coast');
  });

  it('is deterministic: two runs of the same seed place the same pairs', () => {
    for (const seed of SEEDS) {
      const a = generateWorld({ ...BASE, seed }, RESOURCED);
      const b = generateWorld({ ...BASE, seed }, RESOURCED);
      expect(a.map.resources).toEqual(b.map.resources);
      // …and the stored pairs are deep-equal, not merely the same length.
      expect(a.map.resources.map((p) => `${String(p.tile)}:${p.resource}`)).toEqual(
        b.map.resources.map((p) => `${String(p.tile)}:${p.resource}`),
      );
    }
  });

  it('moves the resources when the seed changes', () => {
    // Not every seed pair need differ in principle, so this asserts only that
    // placement is seed-dependent at all: a fixed layout would be indistinguishable
    // from a hard-coded one.
    const layouts = SEEDS.map((seed) =>
      generateWorld({ ...BASE, seed }, RESOURCED)
        .map.resources.map((p) => `${String(p.tile)}:${p.resource}`)
        .join(','),
    );
    expect(new Set(layouts).size).toBeGreaterThan(1);
  });

  it('scales the resource count with the map rather than with luck', () => {
    const sizes = [
      [20, 20],
      [40, 40],
      [80, 80],
    ] as const;
    const counts = sizes.map(
      ([width, height]) =>
        generateWorld({ width, height, seed: 42, civCount: 3 }, RESOURCED).map.resources.length,
    );

    // Every map holds at least one copy of every row (the `max(1, …)` floor), and a
    // bigger world holds more.
    expect(pick(counts, 0)).toBeGreaterThanOrEqual(RESOURCE_ROWS.length);
    expect(pick(counts, 1)).toBeGreaterThanOrEqual(pick(counts, 0));
    expect(pick(counts, 2)).toBeGreaterThan(pick(counts, 1));
  });

  it('does not disturb the terrain, the starts or the huts, which are drawn before it', () => {
    // Resources are the last thing generation does. A catalog that ships resources
    // must not move the world: the terrain is position-determined (never drawn), the
    // starts are chosen before the huts, and the huts are drawn before the
    // resources — so adding a resource catalog changes the pairs and nothing else.
    const without = generateWorld(BASE, RULESET);
    const withResources = generateWorld(BASE, RESOURCED);

    expect(withResources.map.terrain).toEqual(without.map.terrain);
    expect(withResources.starts).toEqual(without.starts);
    expect(withResources.map.huts).toEqual(without.map.huts);
    expect(without.map.resources).toEqual([]);
    expect(withResources.map.resources.length).toBeGreaterThan(0);
  });
});

/**
 * The comparator the stored list is ordered by, pinned on its own.
 *
 * The generator's list is checked against `compareTileResources` above, and that
 * check is **self-referential**: a comparator that was consistently wrong would
 * sort every list "correctly". So the order is stated here as a known answer — tile
 * first, then resource id — including the tie case a generated map cannot produce
 * (two rows on one tile), because `map.ts` writes that rule for hand-built maps too
 * and `(tile, resource)` is only a total order if the tie-break is one.
 */
describe('compareTileResources — the one statement of the pair order', () => {
  const pair = (tile: number, resource: string): TileResource => ({
    tile: asTileIndex(tile),
    resource: asResourceId(resource),
  });

  it('orders by tile first, so a later tile loses to an earlier one whatever the ids', () => {
    // 'chromium' < 'iron' as strings, so if the id were compared first this pair
    // would flip and the stored order would no longer be "tile first".
    const earlierTile = pair(3, 'iron');
    const laterTile = pair(9, 'chromium');

    expect(compareTileResources(earlierTile, laterTile)).toBeLessThan(0);
    expect(compareTileResources(laterTile, earlierTile)).toBeGreaterThan(0);
  });

  it('breaks a tie on one tile by the resource id, and calls a pair equal to itself', () => {
    expect(compareTileResources(pair(4, 'iron'), pair(4, 'wheat'))).toBeLessThan(0);
    expect(compareTileResources(pair(4, 'wheat'), pair(4, 'iron'))).toBeGreaterThan(0);
    // Equal, not merely "not less": `sort` needs a real zero to leave an existing
    // (duplicate-free) list untouched, and "no duplicates" is asserted through the
    // comparator's own notion of sameness elsewhere in this file.
    expect(compareTileResources(pair(4, 'iron'), pair(4, 'iron'))).toBe(0);
  });

  it('sorts a shuffled list into the known order, tile then id', () => {
    const shuffled = [pair(9, 'wheat'), pair(3, 'iron'), pair(4, 'wheat'), pair(3, 'gems')];

    expect([...shuffled].sort(compareTileResources)).toEqual([
      pair(3, 'gems'),
      pair(3, 'iron'),
      pair(4, 'wheat'),
      pair(9, 'wheat'),
    ]);
  });

  it('is antisymmetric on every pair of a hand-built list', () => {
    const pairs = [pair(0, 'iron'), pair(0, 'wheat'), pair(7, 'gems'), pair(12, 'fish')];

    for (const a of pairs) {
      for (const b of pairs) {
        // `sign`, not the numbers themselves: an antisymmetric comparison may
        // return any negative or positive value, and pinning the magnitudes would
        // be pinning an implementation detail rather than the order. The two signs
        // are *added* rather than one negated on purpose — `-0` is a distinct value
        // to the matcher, and a pair compared against itself legitimately gives `0`.
        expect(Math.sign(compareTileResources(a, b)) + Math.sign(compareTileResources(b, a))).toBe(
          0,
        );
      }
    }
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
