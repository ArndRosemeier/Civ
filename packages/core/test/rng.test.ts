/**
 * `rng.ts` — the seeded draw stream, and the bounds it must refuse.
 *
 * Two properties are pinned here, both of them load-bearing for state hashes:
 *
 * 1. **The draw sequence for every supported bound is frozen.** The known-answer
 *    values below are the current output of `seedRng`/`nextUint32`/`nextBelow`/
 *    `nextInt`/`shuffle`/`drawMany`; the committed goldens
 *    (`packages/testing/goldens/state.json`) are built on top of them, so a
 *    change here silently rewrites every saved game's hash.
 * 2. **An unsupported bound is refused loudly** with a `RangeError` instead of
 *    being handed to the rejection sampler. `bound > 2 ** 32` used to make
 *    `limit = Math.floor(UINT32_RANGE / bound) * bound` collapse to `0`, so no
 *    draw could ever be accepted and the `for (;;)` loop spun forever — a
 *    process hang reachable from the public API, e.g. `nextInt(rng, 0, 10 ** 10)`.
 *    `bound === UINT32_RANGE` stays valid and costs exactly one draw, because
 *    every uint32 is `< 2 ** 32`.
 */

import { describe, expect, it } from 'vitest';
import {
  drawMany,
  nextBelow,
  nextInt,
  nextUint32,
  seedRng,
  shuffle,
  type RngState,
} from '../src/index.js';

const UINT32_RANGE = 4294967296; // 2 ** 32

/** Run `call`, requiring it to throw, and hand back the error for inspection. */
const thrown = (call: () => unknown): Error => {
  try {
    call();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error(`expected an Error, got ${String(cause)}`);
  }
  throw new Error('expected the call to throw, but it returned a value');
};

describe('rng: bounds that must be refused', () => {
  it('throws RangeError for a bound above the generator range instead of looping forever', () => {
    const state = seedRng(1);
    const tooWide: readonly number[] = [
      UINT32_RANGE + 1,
      2 ** 33,
      10 ** 10,
      Number.MAX_SAFE_INTEGER,
    ];

    for (const bound of tooWide) {
      const error = thrown(() => nextBelow(state, bound));
      expect(error, `bound ${String(bound)}`).toBeInstanceOf(RangeError);
      // The message must name both the rejected bound and the supported maximum.
      expect(error.message).toContain(String(bound));
      expect(error.message).toContain(String(UINT32_RANGE));
    }
  });

  it('throws RangeError for non-positive and non-integer bounds', () => {
    const state = seedRng(2);
    const invalid: readonly number[] = [
      0,
      -0,
      -1,
      -UINT32_RANGE,
      0.5,
      1.5,
      UINT32_RANGE + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MIN_VALUE,
    ];

    for (const bound of invalid) {
      expect(() => nextBelow(state, bound), `bound ${String(bound)}`).toThrow(RangeError);
    }
  });

  it('propagates the bound guard through nextInt and drawMany', () => {
    const state = seedRng(3);

    expect(() => nextInt(state, 0, 10 ** 10)).toThrow(RangeError);
    // A span of 1 + 2 ** 32 is one past the widest supported bound.
    expect(() => nextInt(state, 0, UINT32_RANGE)).toThrow(RangeError);
    expect(() => nextInt(state, -1, UINT32_RANGE - 1)).toThrow(RangeError);
    expect(() => nextInt(state, 5, 4)).toThrow(RangeError);
    expect(() => drawMany(state, 3, 2 ** 33)).toThrow(RangeError);

    // Refusing a bound must not have consumed anything from the caller's state.
    expect(nextUint32(state)[0]).toBe(nextUint32(seedRng(3))[0]);
  });
});

describe('rng: bounds that must keep working', () => {
  it('supports bound === 2 ** 32 on exactly one draw', () => {
    for (const seed of [0, 1, 42, 1337]) {
      const state = seedRng(seed);
      const draw = nextBelow(state, UINT32_RANGE);
      const raw = nextUint32(state);

      // Every uint32 is < 2 ** 32, so nothing can be rejected: the value *is*
      // the raw draw and the state advances by exactly one step.
      expect(draw[0], `seed ${String(seed)}`).toBe(raw[0]);
      expect(draw[1]).toEqual(raw[1]);
      expect(Number.isInteger(draw[0])).toBe(true);
      expect(draw[0]).toBeGreaterThanOrEqual(0);
      expect(draw[0]).toBeLessThan(UINT32_RANGE);
    }
  });

  it('consumes no draws for bound === 1', () => {
    const state = seedRng(7);
    const unit = nextBelow(state, 1);

    expect(unit[0]).toBe(0);
    expect(unit[1]).toEqual(state);

    // Not merely equal: the untouched state still produces the original stream.
    let cursor: RngState = unit[1];
    for (let i = 0; i < 25; i += 1) {
      const draw = nextBelow(cursor, 1);
      expect(draw[0]).toBe(0);
      cursor = draw[1];
    }
    expect(cursor).toEqual(state);
    expect(nextUint32(unit[1])[0]).toBe(nextUint32(state)[0]);
  });

  it('returns an integer inside [0, bound) for every supported bound', () => {
    const bounds: readonly number[] = [
      1,
      2,
      3,
      7,
      10,
      255,
      256,
      1000,
      65536,
      2 ** 31,
      UINT32_RANGE - 1,
      UINT32_RANGE,
    ];

    let state = seedRng(2024);
    for (const bound of bounds) {
      for (let i = 0; i < 200; i += 1) {
        const draw = nextBelow(state, bound);
        state = draw[1];
        expect(Number.isInteger(draw[0]), `bound ${String(bound)}`).toBe(true);
        expect(draw[0]).toBeGreaterThanOrEqual(0);
        expect(draw[0]).toBeLessThan(bound);
      }
    }
  });

  it('keeps nextInt inclusive on both ends, and free for a degenerate range', () => {
    const state = seedRng(9);

    let cursor: RngState = state;
    for (let i = 0; i < 500; i += 1) {
      const draw = nextInt(cursor, -5, 5);
      cursor = draw[1];
      expect(Number.isInteger(draw[0])).toBe(true);
      expect(draw[0]).toBeGreaterThanOrEqual(-5);
      expect(draw[0]).toBeLessThanOrEqual(5);
    }

    // min === max is a span of exactly 1: the answer is certain and costs nothing.
    const degenerate = nextInt(state, 9, 9);
    expect(degenerate[0]).toBe(9);
    expect(degenerate[1]).toEqual(state);

    const widest = nextInt(state, 0, UINT32_RANGE - 1);
    expect(widest[0]).toBeGreaterThanOrEqual(0);
    expect(widest[0]).toBeLessThan(UINT32_RANGE);
  });
});

describe('rng: frozen draw sequence', () => {
  it('reproduces the pinned stream for small bounds', () => {
    const belowThrees: number[] = [];
    let cursor = seedRng(42);
    for (let i = 0; i < 8; i += 1) {
      const draw = nextBelow(cursor, 3);
      belowThrees.push(draw[0]);
      cursor = draw[1];
    }

    expect(belowThrees).toEqual([1, 1, 1, 1, 2, 2, 0, 2]);
    expect(cursor).toEqual({ a: -581921931, b: -328199690, c: 1345977439, d: -1260157918 });
  });

  it('reproduces the pinned raw uint32 stream', () => {
    const values: number[] = [];
    let cursor = seedRng(42);
    for (let i = 0; i < 8; i += 1) {
      const draw = nextUint32(cursor);
      values.push(draw[0]);
      cursor = draw[1];
    }

    expect(values).toEqual([
      3730666837, 1786513705, 1450338100, 2191736338, 3785014133, 2792630042, 2559606165,
      3613948625,
    ]);
    expect(cursor).toEqual({ a: -581921931, b: -328199690, c: 1345977439, d: -1260157918 });
  });

  it('reproduces the pinned values of the composite helpers', () => {
    expect(nextBelow(seedRng(2024), 1000000)[0]).toBe(193798);
    expect(nextBelow(seedRng(1), UINT32_RANGE)[0]).toBe(647275419);
    expect(nextInt(seedRng(7), -5, 5)[0]).toBe(2);
    expect(drawMany(seedRng(5), 5, 100)[0]).toEqual([84, 61, 10, 35, 27]);
    expect(shuffle(seedRng(99), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])[0]).toEqual([
      4, 7, 8, 6, 3, 10, 1, 2, 9, 5,
    ]);
  });

  it('is a pure function of its state for every helper', () => {
    const state = seedRng(11);
    expect(nextUint32(state)).toEqual(nextUint32(state));
    expect(nextBelow(state, 97)).toEqual(nextBelow(state, 97));
    expect(nextBelow(state, UINT32_RANGE)).toEqual(nextBelow(state, UINT32_RANGE));
    expect(nextInt(state, -3, 3)).toEqual(nextInt(state, -3, 3));
    expect(drawMany(state, 4, 13)).toEqual(drawMany(state, 4, 13));
    expect(shuffle(state, ['a', 'b', 'c', 'd'])).toEqual(shuffle(state, ['a', 'b', 'c', 'd']));
  });
});
