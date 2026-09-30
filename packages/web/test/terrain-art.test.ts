import { describe, expect, it } from 'vitest';
import { asTerrainId, DEFAULT_SETTINGS, newGame } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { edgeWeight, terrainNeighbourhood } from '../src/terrain-art.js';
import { MAP_ART } from '../src/map-art.js';
import { UNIT_SPRITE_IDS } from '../src/units.js';

const rules = validateRuleset(CATALOG, 'tuned');
if (!rules.ok) throw new Error('Invalid rules');
const game = newGame(21, DEFAULT_SETTINGS, rules.value);
if (!game.ok) throw new Error('Cannot create game');

describe('terrain artwork', () => {
  it('never uses the terrain of unexplored neighbours or the opposite map edge', () => {
    const state = {
      ...game.value,
      map: {
        ...game.value.map,
        width: 2,
        height: 2,
        terrain: ['grassland', 'ocean', 'mountains', 'plains'].map(asTerrainId),
      },
      explored: [[true, false, false, false]],
    };
    expect(terrainNeighbourhood(state, 0, 0, 0)).toEqual(Array<string>(9).fill('grassland'));
    const known = { ...state, explored: [[true, true, true, true]] };
    expect(terrainNeighbourhood(known, 0, 0, 0)).toEqual([
      'grassland',
      'grassland',
      'grassland',
      'grassland',
      'grassland',
      'ocean',
      'grassland',
      'mountains',
      'plains',
    ]);
  });

  it('keeps terrain centres intact and meets neighbours symmetrically at edges', () => {
    expect(edgeWeight(0.5)).toBe(0);
    expect(edgeWeight(0.25)).toBe(0);
    expect(edgeWeight(0)).toBe(0.5);
    expect(edgeWeight(1)).toBe(0.5);
    for (const fraction of [0.01, 0.1, 0.2]) {
      expect(edgeWeight(fraction)).toBeCloseTo(edgeWeight(1 - fraction));
    }
  });

  it('covers every shipped resource and unit, including the medieval additions', () => {
    for (const resource of CATALOG.resources) expect(MAP_ART[resource.id]).toContain('<svg');
    for (const unit of CATALOG.units) expect(UNIT_SPRITE_IDS).toContain(unit.id);
  });
});
