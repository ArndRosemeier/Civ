import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  asCityId,
  asUnitId,
  type CityId,
  type PlayerId,
  type Settings,
  type TileIndex,
  type UnitId,
} from '../src/index.js';

describe('branded identifiers', () => {
  it('are nominally distinct', () => {
    expectTypeOf<CityId>().not.toEqualTypeOf<UnitId>();
    expectTypeOf<PlayerId>().not.toEqualTypeOf<TileIndex>();
    expectTypeOf<UnitId>().not.toEqualTypeOf<PlayerId>();
  });

  it('still behave as numbers', () => {
    expectTypeOf<PlayerId>().toExtend<number>();
    expectTypeOf<TileIndex>().toExtend<number>();
  });

  it('reject cross-assignment at compile time', () => {
    const city: CityId = asCityId(1);
    const unit: UnitId = asUnitId(2);

    // @ts-expect-error a CityId must not be assignable to a UnitId
    const wrong: UnitId = city;
    // @ts-expect-error a UnitId must not be assignable to a CityId
    const alsoWrong: CityId = unit;
    // @ts-expect-error a raw number must not be assignable to a PlayerId
    const rawWrong: PlayerId = 3;

    expect(wrong).toBe(1);
    expect(alsoWrong).toBe(2);
    expect(rawWrong).toBe(3);
  });
});

describe('settings type surface', () => {
  it('narrows enums to literal unions, not string', () => {
    expectTypeOf<Settings['mapSize']>().toEqualTypeOf<
      'duel' | 'tiny' | 'small' | 'standard' | 'large' | 'huge'
    >();
    expectTypeOf<Settings['fidelity']>().toEqualTypeOf<'tuned' | 'cited-only'>();
  });

  it('requires both nested settings groups', () => {
    expectTypeOf<Settings['ai']>().toHaveProperty('aggression');
    expectTypeOf<Settings['debug']>().toHaveProperty('cheats');
  });
});
