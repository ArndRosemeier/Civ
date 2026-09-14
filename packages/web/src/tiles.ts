/**
 * Terrain tile sprites — presentation assets for the Canvas map.
 *
 * Each shipped terrain id has one square texture. The renderer paints that image into
 * `tileRect`; fog and borders stay vector overlays. Unit and city markers are drawn on top.
 */

import coastUrl from '../assets/tiles/tile-coast.png';
import grasslandUrl from '../assets/tiles/tile-grassland.png';
import hillsUrl from '../assets/tiles/tile-hills.png';
import mountainsUrl from '../assets/tiles/tile-mountains.png';
import oceanUrl from '../assets/tiles/tile-ocean.png';
import plainsUrl from '../assets/tiles/tile-plains.png';

/** The six terrain ids the shipped ruleset paints. */
export const TERRAIN_TILE_IDS = [
  'grassland',
  'plains',
  'hills',
  'mountains',
  'ocean',
  'coast',
] as const;

export type TerrainTileId = (typeof TERRAIN_TILE_IDS)[number];

/** One decoded image per terrain id, ready for `drawImage`. */
export type TerrainSprites = Readonly<Partial<Record<string, CanvasImageSource>>>;

const TILE_URLS: Readonly<Record<TerrainTileId, string>> = {
  grassland: grasslandUrl,
  plains: plainsUrl,
  hills: hillsUrl,
  mountains: mountainsUrl,
  ocean: oceanUrl,
  coast: coastUrl,
};

/** Decode one PNG URL into an `HTMLImageElement` that is ready to paint. */
const decodeTile = async (url: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
};

/**
 * Load every shipped terrain texture once, before the first frame.
 *
 * Failure is loud: a missing or corrupt tile is a broken build, not a silent flat colour.
 */
export const loadTerrainSprites = async (): Promise<TerrainSprites> => {
  const entries = await Promise.all(
    TERRAIN_TILE_IDS.map(async (id) => {
      const image = await decodeTile(TILE_URLS[id]);
      return [id, image] as const;
    }),
  );
  return Object.fromEntries(entries);
};
