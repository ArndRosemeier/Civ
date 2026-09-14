/**
 * `ui/problem.ts` — every reason the engine can give, rendered, and never blank.
 *
 * ## What this test is for, and the hole it closes
 *
 * The order channel (`main.ts`, `Shell.orderStatus`) shows whatever `problemText` returns for a
 * refused command or a cancelled goto. If it ever returned an empty string, the channel would be
 * blank — which is exactly the defect `docs/UI-OVERHAUL.md` §1.4 measured: *a click that does
 * nothing and says nothing is indistinguishable from a frozen game*. So "never blank, whatever the
 * engine says" is the property, and `SAMPLES` is a **`Record<GameError['kind'], GameError>`**: a new
 * refusal member in `commands.ts` does not compile until it is sampled here, and every assertion
 * below then covers it automatically.
 *
 * The renderer is deliberately *not* exhaustive per kind (`problem.ts` says why: 40 hand-written
 * sentences would be prose about rules this package does not own, and `assertNever` would take the
 * channel dark on an engine change). What the table buys is the half that matters: totality is
 * checked here, by a test, instead of being asserted by a `default` arm nobody looks at.
 *
 * The two classified cases below are the ones a player meets on a *map* — the movement rule's own
 * reason, and the engine's own sentence for a destination it will not accept — and they are pinned
 * because they are the sentences Phase 4 actually shows.
 */

import { describe, expect, it } from 'vitest';
import {
  asBuildingId,
  asCityId,
  asGovernmentId,
  asImprovementId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  type GameError,
} from '@civts/core';

import { problemText } from '../../src/ui/problem.js';

const UNIT = asUnitId(3);
const OTHER = asPlayerId(1);
const CITY = asCityId(2);
const TILE = asTileIndex(41);

/** One of every refusal the engine can state. Exhaustive by construction, not by review. */
const SAMPLES: Readonly<Record<GameError['kind'], GameError>> = {
  'unknown-unit': { kind: 'unknown-unit', unitId: UNIT },
  'unknown-player': { kind: 'unknown-player', playerId: OTHER },
  'not-your-unit': { kind: 'not-your-unit', unitId: UNIT, owner: OTHER },
  'out-of-bounds': { kind: 'out-of-bounds', to: TILE },
  impassable: { kind: 'impassable', unitId: UNIT, to: TILE },
  'not-enough-movement': { kind: 'not-enough-movement', unitId: UNIT, needed: 2, available: 1 },
  'occupied-by-enemy': { kind: 'occupied-by-enemy', unitId: UNIT, to: TILE },
  'not-a-settler': { kind: 'not-a-settler', unitId: UNIT },
  'not-on-land': { kind: 'not-on-land', unitId: UNIT, tile: TILE },
  'city-too-close': {
    kind: 'city-too-close',
    unitId: UNIT,
    tile: TILE,
    cityId: CITY,
    distance: 2,
    minDistance: 4,
  },
  'unknown-city': { kind: 'unknown-city', cityId: CITY },
  'not-your-city': { kind: 'not-your-city', cityId: CITY, owner: OTHER },
  'tile-not-workable': { kind: 'tile-not-workable', cityId: CITY, tile: TILE },
  'tile-worked-by-another-city': {
    kind: 'tile-worked-by-another-city',
    cityId: CITY,
    tile: TILE,
    byCityId: asCityId(5),
  },
  'duplicate-worked-tile': { kind: 'duplicate-worked-tile', cityId: CITY, tile: TILE },
  'too-many-worked-tiles': {
    kind: 'too-many-worked-tiles',
    cityId: CITY,
    requested: 9,
    allowed: 3,
  },
  'unknown-production-item': {
    kind: 'unknown-production-item',
    item: { kind: 'building', id: asBuildingId('nonesuch') },
  },
  'already-built': { kind: 'already-built', cityId: CITY, building: asBuildingId('granary') },
  'resource-not-connected': {
    kind: 'resource-not-connected',
    cityId: CITY,
    owner: OTHER,
    item: { kind: 'unit', id: asUnitTypeId('warrior') },
    resource: asResourceId('iron'),
  },
  'tech-required': {
    kind: 'tech-required',
    cityId: CITY,
    owner: OTHER,
    item: { kind: 'building', id: asBuildingId('library') },
    tech: asTechId('literature'),
  },
  'wonder-already-built': {
    kind: 'wonder-already-built',
    cityId: CITY,
    building: asBuildingId('pyramids'),
    holder: asCityId(5),
  },
  'not-a-worker': { kind: 'not-a-worker', unitId: UNIT },
  'already-working': {
    kind: 'already-working',
    unitId: UNIT,
    improvement: asImprovementId('mine'),
  },
  'not-working': { kind: 'not-working', unitId: UNIT },
  'unknown-improvement': { kind: 'unknown-improvement', improvement: asImprovementId('nonesuch') },
  'improvement-not-allowed': {
    kind: 'improvement-not-allowed',
    unitId: UNIT,
    tile: TILE,
    improvement: asImprovementId('mine'),
    role: 'ocean',
  },
  'already-improved': {
    kind: 'already-improved',
    tile: TILE,
    improvement: asImprovementId('mine'),
  },
  'improvement-tech-required': {
    kind: 'improvement-tech-required',
    unitId: UNIT,
    tile: TILE,
    improvement: asImprovementId('mine'),
    tech: asTechId('bronze-working'),
  },
  'unknown-tech': { kind: 'unknown-tech', tech: asTechId('nonesuch') },
  'tech-already-known': { kind: 'tech-already-known', tech: asTechId('pottery') },
  'tech-prerequisites-unmet': {
    kind: 'tech-prerequisites-unmet',
    tech: asTechId('literature'),
    missing: [asTechId('pottery')],
  },
  'unit-cannot-attack': { kind: 'unit-cannot-attack', unitId: UNIT, attack: 0 },
  'nothing-to-attack': { kind: 'nothing-to-attack', unitId: UNIT, target: TILE },
  'target-stacked': { kind: 'target-stacked', unitId: UNIT, target: TILE, defenders: 2 },
  'tile-owned-by-another-player': {
    kind: 'tile-owned-by-another-player',
    unitId: UNIT,
    tile: TILE,
    owner: OTHER,
  },
  'tile-owned-by-another-player-city': {
    kind: 'tile-owned-by-another-player-city',
    cityId: CITY,
    tile: TILE,
    owner: OTHER,
  },
  'unknown-government': {
    kind: 'unknown-government',
    government: asGovernmentId('senate'),
    known: [asGovernmentId('despotism')],
  },
  'government-tech-required': {
    kind: 'government-tech-required',
    government: asGovernmentId('monarchy'),
    tech: asTechId('monarchy'),
  },
  'game-over': {
    kind: 'game-over',
    condition: 'conquest',
    winner: OTHER,
    turn: 42,
    command: 'MoveUnit',
  },
  'invalid-argument': { kind: 'invalid-argument', detail: 'this destination is not a destination' },
};

const EVERY_ERROR = Object.values(SAMPLES);

describe('problemText: every refusal the engine can state', () => {
  it('renders one of each, and none of them blank', () => {
    expect(EVERY_ERROR).toHaveLength(40);
    const blank = EVERY_ERROR.filter((error) => problemText(error).trim() === '');
    expect(blank, 'a refusal that renders as nothing is a channel that looks broken').toEqual([]);
  });

  it('gives the unclassified reasons the engine\u2019s own name, and nothing invented', () => {
    // Twelve kinds get a sentence of their own (the ones a player meets through a map order or a
    // goto — `problem.ts` lists them and says why the rest do not get one). Everything else must
    // come back as the engine's own `kind` in a fixed, recognisable shape: that arm is what keeps a
    // new engine refusal *visible* rather than silently blank, so it is pinned exactly rather than
    // by a substring that a rewrite could satisfy while saying something false.
    const classified = new Set([
      'invalid-argument',
      'not-enough-movement',
      'impassable',
      'occupied-by-enemy',
      'out-of-bounds',
      'unknown-unit',
      'not-your-unit',
      'unknown-player',
      'nothing-to-attack',
      'target-stacked',
      'unit-cannot-attack',
      'game-over',
    ]);
    for (const error of EVERY_ERROR) {
      const text = problemText(error);
      if (classified.has(error.kind)) {
        expect(text, `${error.kind} fell through to the fallback arm`).not.toContain(
          `(${error.kind})`,
        );
        continue;
      }
      expect(text, `${error.kind} is rendered as something other than its own reason`).toBe(
        `the engine refused it (${error.kind})`,
      );
    }
  });

  it('prints the engine\u2019s own sentence for the two reasons a map order meets', () => {
    // `invalid-argument` IS prose the engine wrote (`planMove` for a destination it will not name,
    // `route.ts` for one it cannot reach), so it is printed whole rather than paraphrased — this is
    // the sentence a player reads after clicking ground the unit cannot reach.
    expect(
      problemText({
        kind: 'invalid-argument',
        detail: 'no route from tile 24 to tile 31: every sequence of single steps is refused',
      }),
    ).toBe(
      'the engine refused it: no route from tile 24 to tile 31: every sequence of single steps is refused',
    );
    // And the movement rule's numbers are the engine's, quoted rather than recomputed.
    expect(
      problemText({ kind: 'not-enough-movement', unitId: UNIT, needed: 2, available: 1 }),
    ).toContain('2');
    expect(
      problemText({ kind: 'not-enough-movement', unitId: UNIT, needed: 2, available: 1 }),
    ).toContain('1');
  });
});
