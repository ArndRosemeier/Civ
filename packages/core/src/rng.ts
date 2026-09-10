/**
 * Deterministic pseudo-random number generation. See PLAN.md 5.3.
 *
 * sfc32 (Small Fast Chaotic PRNG): 32-bit integer arithmetic only, so results
 * are bit-identical across runtimes. Deliberately NOT `Math.random`, and
 * deliberately no transcendentals — those vary between JS engines' libm and
 * would break state hashes on a Node upgrade.
 *
 * The generator is a pure function of its state: each draw returns the value
 * and the next state. The engine carries that state inside `GameState`, so a
 * save file fully determines all future randomness.
 */

export interface RngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

const UINT32_RANGE = 4294967296; // 2^32, exactly representable as a double

/** splitmix32, used only to expand a single seed into the four sfc32 words. */
const splitmix32 = (x: number): readonly [number, number] => {
  const next = (x + 0x9e3779b9) | 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = z ^ (z >>> 15);
  return [next, z >>> 0];
};

export const seedRng = (seed: number): RngState => {
  let cursor = seed | 0;
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    const step = splitmix32(cursor);
    cursor = step[0];
    words.push(step[1]);
  }
  return {
    a: (words[0] ?? 0) | 0,
    b: (words[1] ?? 0) | 0,
    c: (words[2] ?? 0) | 0,
    d: (words[3] ?? 0) | 0,
  };
};

/** Draw the next raw 32-bit unsigned integer. */
export const nextUint32 = (s: RngState): readonly [number, RngState] => {
  const a = s.a | 0;
  const b = s.b | 0;
  const c = s.c | 0;
  const d = s.d | 0;

  const t = (((a + b) | 0) + d) | 0;
  const nextD = (d + 1) | 0;
  const nextA = b ^ (b >>> 9);
  const nextB = (c + (c << 3)) | 0;
  const nextC = (((c << 21) | (c >>> 11)) + t) | 0;

  return [t >>> 0, { a: nextA | 0, b: nextB | 0, c: nextC | 0, d: nextD | 0 }];
};

/**
 * Unbiased integer in `[0, bound)`, by rejection sampling.
 * Consumes a variable number of draws — still fully deterministic.
 *
 * `bound` is validated, never trusted: a bound wider than the generator's own
 * range cannot be sampled from single draws. `bound > UINT32_RANGE` used to
 * leave `limit` at 0 — `Math.floor(UINT32_RANGE / bound)` is 0 — so the
 * rejection loop below could never accept a draw and spun forever, hanging the
 * process for a caller like `nextInt(rng, 0, 10 ** 10)`. Such a bound is now
 * rejected loudly instead. `bound === UINT32_RANGE` stays valid: every draw is
 * `< 2 ** 32`, so the loop accepts the first one on exactly one draw, which is
 * why raising this bound must not change any existing draw sequence.
 */
export const nextBelow = (s: RngState, bound: number): readonly [number, RngState] => {
  if (!Number.isInteger(bound) || bound <= 0) {
    throw new RangeError(`nextBelow bound must be a positive integer, got ${String(bound)}`);
  }
  if (bound > UINT32_RANGE) {
    throw new RangeError(
      `nextBelow bound must not exceed the generator range ${String(UINT32_RANGE)} (2 ** 32), got ${String(bound)}`,
    );
  }
  if (bound === 1) return [0, s];

  const limit = Math.floor(UINT32_RANGE / bound) * bound;
  let cursor = s;
  for (;;) {
    const draw = nextUint32(cursor);
    cursor = draw[1];
    if (draw[0] < limit) return [draw[0] % bound, cursor];
  }
};

/** Unbiased integer in `[min, max]` inclusive. */
export const nextInt = (s: RngState, min: number, max: number): readonly [number, RngState] => {
  if (max < min) throw new RangeError(`nextInt: max (${String(max)}) < min (${String(min)})`);
  const draw = nextBelow(s, max - min + 1);
  return [draw[0] + min, draw[1]];
};

/** Fisher-Yates shuffle, returning a new array. Deterministic given the state. */
export const shuffle = <T>(s: RngState, items: readonly T[]): readonly [readonly T[], RngState] => {
  const out = [...items];
  let cursor = s;
  for (let i = out.length - 1; i > 0; i--) {
    const draw = nextBelow(cursor, i + 1);
    cursor = draw[1];
    const j = draw[0];
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return [out, cursor];
};

/** Draw `count` values in `[0, bound)`. Convenience for callers needing several. */
export const drawMany = (
  s: RngState,
  count: number,
  bound: number,
): readonly [readonly number[], RngState] => {
  const out: number[] = [];
  let cursor = s;
  for (let i = 0; i < count; i++) {
    const draw = nextBelow(cursor, bound);
    cursor = draw[1];
    out.push(draw[0]);
  }
  return [out, cursor];
};
