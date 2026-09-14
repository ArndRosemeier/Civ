/**
 * Unit sprites — presentation assets for the Canvas map markers.
 *
 * Each shipped unit type id has one transparent PNG. The renderer paints it on the
 * unit's tile with a small owner-colour badge; missing types fall back to the old
 * triangle marker.
 */

import archerUrl from '../assets/units/unit-archer.png';
import galleyUrl from '../assets/units/unit-galley.png';
import horsemanUrl from '../assets/units/unit-horseman.png';
import scoutUrl from '../assets/units/unit-scout.png';
import settlerUrl from '../assets/units/unit-settler.png';
import spearmanUrl from '../assets/units/unit-spearman.png';
import swordsmanUrl from '../assets/units/unit-swordsman.png';
import transportUrl from '../assets/units/unit-transport.png';
import warriorUrl from '../assets/units/unit-warrior.png';
import workerUrl from '../assets/units/unit-worker.png';

/** The ten unit type ids the shipped ruleset paints. */
export const UNIT_SPRITE_IDS = [
  'settler',
  'worker',
  'scout',
  'warrior',
  'galley',
  'archer',
  'spearman',
  'horseman',
  'swordsman',
  'transport',
] as const;

export type UnitSpriteId = (typeof UNIT_SPRITE_IDS)[number];

/** One decoded image per unit type id, ready for `drawImage`. */
export type UnitSprites = Readonly<Partial<Record<string, CanvasImageSource>>>;

const UNIT_URLS: Readonly<Record<UnitSpriteId, string>> = {
  settler: settlerUrl,
  worker: workerUrl,
  scout: scoutUrl,
  warrior: warriorUrl,
  galley: galleyUrl,
  archer: archerUrl,
  spearman: spearmanUrl,
  horseman: horsemanUrl,
  swordsman: swordsmanUrl,
  transport: transportUrl,
};

/** Decode one PNG URL into an `HTMLImageElement` that is ready to paint. */
const decodeUnit = async (url: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
};

/**
 * Load every shipped unit sprite once, before the first frame.
 *
 * Failure is loud: a missing or corrupt sprite is a broken build, not a silent triangle.
 */
export const loadUnitSprites = async (): Promise<UnitSprites> => {
  const entries = await Promise.all(
    UNIT_SPRITE_IDS.map(async (id) => {
      const image = await decodeUnit(UNIT_URLS[id]);
      return [id, image] as const;
    }),
  );
  return Object.fromEntries(entries);
};
