/** Neighbour-aware terrain artwork. Presentation only; never reads the game's RNG. */
import type { GameState } from '@civts/core';

export const ART_SIZE = 96;
export const TERRAIN_ART_CACHE_LIMIT = 384;

/** Unknown neighbours repeat the known centre: artwork must not disclose unexplored land. */
export const terrainNeighbourhood = (
  state: GameState,
  viewer: number,
  x: number,
  y: number,
): readonly string[] => {
  const centre = state.map.terrain[y * state.map.width + x] ?? 'unknown';
  const result: string[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      const tile = ny * state.map.width + nx;
      result.push(
        nx >= 0 &&
          ny >= 0 &&
          nx < state.map.width &&
          ny < state.map.height &&
          state.explored[viewer]?.[tile] === true
          ? (state.map.terrain[tile] ?? centre)
          : centre,
      );
    }
  }
  return result;
};

export const isWaterArt = (terrain: string): boolean => terrain === 'coast' || terrain === 'ocean';

/** Blend only the outside quarter of a tile. Its centre keeps its own terrain. */
export const edgeWeight = (coordinate: number): number => {
  const t = Math.max(0, 1 - Math.min(coordinate, 1 - coordinate) * 4);
  return (t * t * (3 - 2 * t)) / 2;
};

export interface TerrainArtwork {
  tile(neighbours: readonly string[], x: number, y: number): CanvasImageSource | undefined;
}

/**
 * Composite decoded textures once per neighbourhood, then reuse the small canvas on every frame.
 * Texture coordinates run across the world rather than being mirrored independently per tile.
 * Shared edges use the same samples and blend weights, including four-way corners.
 */
export const createTerrainArtwork = (
  sprites: Readonly<Partial<Record<string, CanvasImageSource>>>,
): TerrainArtwork => {
  const textures = new Map<string, Uint8ClampedArray>();
  for (const [id, sprite] of Object.entries(sprites)) {
    if (sprite === undefined) continue;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ART_SIZE * 2;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Terrain artwork requires a 2D canvas');
    // Mirror a texture into a periodic 2×2 patch. Opposite patch edges now meet without a seam.
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        ctx.save();
        ctx.translate(dx === 0 ? 0 : ART_SIZE * 2, dy === 0 ? 0 : ART_SIZE * 2);
        ctx.scale(dx === 0 ? 1 : -1, dy === 0 ? 1 : -1);
        ctx.drawImage(sprite, 0, 0, ART_SIZE, ART_SIZE);
        ctx.restore();
      }
    }
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Calm the old fluorescent shallows and yellow plains while retaining the source's detail.
    const grade =
      id === 'coast'
        ? { colour: [50, 120, 142], strength: 0.75 }
        : id === 'grassland'
          ? { colour: [92, 118, 58], strength: 0.25 }
          : id === 'plains'
            ? { colour: [150, 130, 90], strength: 0.3 }
            : undefined;
    if (grade !== undefined) {
      for (let p = 0; p < pixels.length; p += 4) {
        for (let c = 0; c < 3; c += 1) {
          pixels[p + c] = Math.round(
            (pixels[p + c] ?? 0) * (1 - grade.strength) + (grade.colour[c] ?? 0) * grade.strength,
          );
        }
      }
    }
    textures.set(id, pixels);
  }
  const cache = new Map<string, HTMLCanvasElement>();
  return {
    tile(neighbours, x, y) {
      const centre = neighbours[4] ?? 'unknown';
      if (!textures.has(centre)) return undefined;
      const phaseX = x % 2;
      const phaseY = y % 2;
      const key = JSON.stringify([phaseX, phaseY, neighbours]);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ART_SIZE;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('Terrain artwork requires a 2D canvas');
      const pixels = ctx.createImageData(ART_SIZE, ART_SIZE);
      const textureSize = ART_SIZE * 2;
      for (let py = 0; py < ART_SIZE; py += 1) {
        for (let px = 0; px < ART_SIZE; px += 1) {
          const u = (px + 0.5) / ART_SIZE;
          const v = (py + 0.5) / ART_SIZE;
          const wx = edgeWeight(u);
          const wy = edgeWeight(v);
          const ix = u < 0.5 ? 0 : 2;
          const iy = v < 0.5 ? 0 : 2;
          const contributors = [4, ix + 3, 1 + iy * 3, ix + iy * 3];
          const weights = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];
          const tx = phaseX * ART_SIZE + px;
          const ty = phaseY * ART_SIZE + py;
          const offset = (ty * textureSize + tx) * 4;
          const land = [0, 0, 0];
          const water = [0, 0, 0];
          let landWeight = 0;
          let waterWeight = 0;
          for (let i = 0; i < contributors.length; i += 1) {
            const id = neighbours[contributors[i] ?? 4] ?? centre;
            const texture = textures.get(id) ?? textures.get(centre);
            const weight = weights[i] ?? 0;
            const wet = isWaterArt(id);
            if (wet) waterWeight += weight;
            else landWeight += weight;
            for (let c = 0; c < 3; c += 1) {
              const bucket = wet ? water : land;
              bucket[c] = (bucket[c] ?? 0) + (texture?.[offset + c] ?? 0) * weight;
            }
          }
          const destination = (py * ART_SIZE + px) * 4;
          // World-space grain is continuous at tile edges and makes beaches less mechanical.
          const grain = ((tx * 13 + ty * 7 + ((tx * ty) % 17)) % 11) - 5;
          // Periodic world-space waves bend the shoreline across tile boundaries. Applying the
          // same field on BOTH sides prevents the straight stair-step edges of square autotiles.
          const coastBend =
            Math.sin((tx * Math.PI) / ART_SIZE) * Math.cos((ty * Math.PI) / ART_SIZE) * 0.28 +
            Math.sin(((tx + ty) * Math.PI) / ART_SIZE) * 0.12;
          const shoreline = landWeight - waterWeight + coastBend;
          for (let c = 0; c < 3; c += 1) {
            let colour =
              shoreline > 0
                ? (land[c] ?? 0) / Math.max(landWeight, 0.001)
                : (water[c] ?? 0) / Math.max(waterWeight, 0.001);
            if (landWeight > 0 && waterWeight > 0) {
              if (shoreline > -0.03 && shoreline < 0.15) {
                colour = ([205, 188, 132][c] ?? 0) + grain;
              } else if (shoreline > -0.09 && shoreline <= -0.03) {
                colour = ([185, 221, 210][c] ?? 0) + grain;
              } else if (shoreline > -0.3 && shoreline <= -0.09) {
                colour = colour * 0.6 + ([61, 163, 169][c] ?? 0) * 0.4;
              }
            }
            pixels.data[destination + c] = Math.round(colour);
          }
          pixels.data[destination + 3] = 255;
        }
      }
      ctx.putImageData(pixels, 0, 0);
      if (cache.size >= TERRAIN_ART_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, canvas);
      return canvas;
    },
  };
};
