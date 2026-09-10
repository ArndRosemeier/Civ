import { describe, expect, it } from 'vitest';
import {
  assertInvariants,
  canonicalize,
  fnv1a64,
  hashValue,
  runInvariants,
  violation,
  type Invariant,
} from '../src/index.js';

/**
 * Known-answer values were SELF-DERIVED: they are the values this
 * implementation produced when run once (`npx tsx -e "fnv1a64('')"`), then
 * pinned here so any future change to the algorithm fails the suite. They were
 * not copied from an external source reviewer-checked; they coincide with the
 * published FNV-1a 64 test vectors for '' and 'a'.
 */
const KAT_EMPTY = 'cbf29ce484222325';
const KAT_A = 'af63dc4c8601ec8c';

const HEX64 = /^[0-9a-f]{16}$/;

class Widget {
  readonly id = 1;
}

describe('fnv1a64 known answers', () => {
  it('hashes the empty string to the FNV-1a 64 offset basis', () => {
    expect(fnv1a64('')).toBe(KAT_EMPTY);
    expect(KAT_EMPTY).toHaveLength(16);
  });

  it("hashes 'a' to the pinned value", () => {
    expect(fnv1a64('a')).toBe(KAT_A);
  });

  it('is stable across repeated calls', () => {
    expect(fnv1a64('determinism')).toBe(fnv1a64('determinism'));
  });
});

describe('fnv1a64 output shape', () => {
  const inputs = ['', 'a', 'abc', 'foobar', 'héllo wörld', '😀', 'x'.repeat(1000), '\u0000\u001f'];

  it.each(inputs)('returns 16 lowercase hex chars for %j', (input) => {
    const digest = fnv1a64(input);
    expect(digest).toMatch(HEX64);
    expect(digest).toBe(digest.toLowerCase());
  });

  it('distinguishes inputs that differ only in UTF-8 encoding', () => {
    // 'é' as one code point vs. as 'e' + combining acute: same visual text,
    // different UTF-8 bytes, so different digests.
    expect(fnv1a64('\u00e9')).not.toBe(fnv1a64('e\u0301'));
  });

  it('uses UTF-8 bytes, so code points above the BMP matter', () => {
    expect(fnv1a64('\u{1f600}')).not.toBe(fnv1a64('\u{1f601}'));
  });
});

describe('canonicalize', () => {
  it('sorts keys recursively', () => {
    expect(canonicalize({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":4}],"b":2}');
  });

  it('is independent of insertion order at every level', () => {
    expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalize({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 2, 1])).not.toBe(canonicalize([1, 2, 3]));
  });

  it('encodes primitives like JSON', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  it('folds -0 and 0 onto the same canonical form', () => {
    expect(canonicalize({ v: -0 })).toBe(canonicalize({ v: 0 }));
    expect(hashValue({ v: -0 })).toBe(hashValue({ v: 0 }));
  });

  it('handles nested arrays and objects to arbitrary depth', () => {
    const value = { z: [{ b: 1, a: [{ d: [3, 2, 1], c: null }] }], a: 'x' };
    expect(canonicalize(value)).toBe('{"a":"x","z":[{"a":[{"c":null,"d":[3,2,1]}],"b":1}]}');
  });

  it('treats numeric typed arrays like the equivalent number array', () => {
    expect(canonicalize(new Uint8Array([1, 2, 3]))).toBe('[1,2,3]');
    expect(hashValue(new Int32Array([1, 2, 3]))).toBe(hashValue([1, 2, 3]));
  });

  it('treats null-prototype objects as plain records', () => {
    const bare: Record<string, unknown> = {};
    Object.setPrototypeOf(bare, null);
    bare['b'] = 2;
    bare['a'] = 1;
    expect(Object.getPrototypeOf(bare)).toBeNull();
    expect(canonicalize(bare)).toBe('{"a":1,"b":2}');
  });

  it('does not confuse distinct scalars', () => {
    expect(canonicalize({ v: 1 })).not.toBe(canonicalize({ v: '1' }));
    expect(canonicalize({ v: '1' })).not.toBe(canonicalize({ v: true }));
  });
});

describe('canonicalize rejections', () => {
  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['bigint', 1n],
  ])('throws on top-level %s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(/canonicalize/);
  });

  it('throws on disallowed values nested inside objects and arrays', () => {
    expect(() => canonicalize({ a: { b: [1, undefined] } })).toThrow(/canonicalize/);
    expect(() => canonicalize([{ deep: Number.NaN }])).toThrow(/canonicalize/);
    expect(() => canonicalize({ f: (): number => 1 })).toThrow(/canonicalize/);
    expect(() => canonicalize({ s: Symbol('x') })).toThrow(/canonicalize/);
    expect(() => canonicalize({ n: 10n })).toThrow(/canonicalize/);
    expect(() => canonicalize({ big: new BigInt64Array([1n]) })).toThrow(/canonicalize/);
  });

  it('names the offending path in the message', () => {
    expect(() => canonicalize({ a: [{ b: Number.NaN }] })).toThrow(/\$\.a\[0\]\.b/);
  });

  it('throws on non-plain objects rather than silently emptying them', () => {
    expect(() => canonicalize(new Date(0))).toThrow(/canonicalize/);
    expect(() => canonicalize(new Map([['a', 1]]))).toThrow(/canonicalize/);
    expect(() => canonicalize(new Set([1]))).toThrow(/canonicalize/);
    expect(() => canonicalize(/re/)).toThrow(/canonicalize/);
    expect(() => canonicalize(new Widget())).toThrow(/canonicalize/);
    expect(() => canonicalize({ nested: new Widget() })).toThrow(/canonicalize/);
    expect(() => canonicalize(new DataView(new ArrayBuffer(4)))).toThrow(/canonicalize/);
  });

  it('throws on circular references instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/circular/);
  });

  it('allows the same object to appear twice when it is not circular', () => {
    const shared = { a: 1 };
    expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('rejects symbol-keyed properties', () => {
    const withSymbol: Record<symbol, unknown> = { [Symbol('k')]: 1 };
    expect(() => canonicalize(withSymbol)).toThrow(/canonicalize/);
  });
});

describe('canonicalize accessor rejection', () => {
  it('throws on a getter-bearing object instead of invoking the getter', () => {
    let calls = 0;
    const value = {
      data: 1,
      get boom(): number {
        calls += 1;
        return 2;
      },
    };

    expect(() => canonicalize(value)).toThrow(/accessor/);
    // The whole point: hashing must not run arbitrary code, so the getter must
    // not have been called even once on the way to the rejection.
    expect(calls).toBe(0);
  });

  it('names the accessor path in the message', () => {
    const value = {
      a: [{ ok: 1 }],
      c: {
        get deep(): number {
          return 1;
        },
      },
    };
    expect(() => canonicalize(value)).toThrow(/\$\.c\.deep/);
    expect(() => canonicalize(value)).toThrow(/accessor/);
  });

  it('does not invoke a getter even when the getter would throw', () => {
    const value = {
      get nope(): number {
        throw new Error('getter must not run');
      },
    };
    // If canonicalize read the property, this would surface the getter's error
    // message rather than a canonicalize diagnostic.
    expect(() => canonicalize(value)).toThrow(/canonicalize: accessor/);
  });

  it('rejects setter-only accessors as well as getters', () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, 's', {
      set: (): void => undefined,
      enumerable: true,
      configurable: true,
    });
    expect(Object.keys(value)).toStrictEqual(['s']);
    expect(() => canonicalize(value)).toThrow(/accessor/);
  });

  it('rejects a getter nested inside an array element', () => {
    const value = {
      list: [
        {
          get x(): number {
            return 1;
          },
        },
      ],
    };
    expect(() => canonicalize(value)).toThrow(/\$\.list\[0\]\.x/);
  });

  it('still accepts own enumerable data properties, however they were defined', () => {
    const definePropertyBuilt: Record<string, unknown> = {};
    Object.defineProperty(definePropertyBuilt, 'a', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(definePropertyBuilt, 'b', {
      value: 'two',
      enumerable: true,
      writable: true,
      configurable: true,
    });

    // Literal data properties and defineProperty data properties encode
    // identically — the new check must not change the output format.
    expect(canonicalize(definePropertyBuilt)).toBe('{"a":1,"b":"two"}');
    expect(canonicalize(definePropertyBuilt)).toBe(canonicalize({ b: 'two', a: 1 }));
  });

  it('still accepts null-prototype records that carry no accessors', () => {
    const bare: Record<string, unknown> = {};
    Object.setPrototypeOf(bare, null);
    bare['b'] = 2;
    bare['a'] = 1;
    expect(canonicalize(bare)).toBe('{"a":1,"b":2}');
  });

  it('propagates the accessor rejection through hashValue', () => {
    let calls = 0;
    const value = {
      get boom(): number {
        calls += 1;
        return 2;
      },
    };
    expect(() => hashValue(value)).toThrow(/accessor/);
    expect(calls).toBe(0);
  });
});

describe('hashValue', () => {
  it('is fnv1a64 of the canonical form', () => {
    const value = { b: [1, { d: 4, c: 3 }], a: 'x' };
    expect(hashValue(value)).toBe(fnv1a64(canonicalize(value)));
    expect(hashValue(value)).toMatch(HEX64);
  });

  it('is key-order independent', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ x: { a: 1, b: 2 }, y: 3 })).toBe(hashValue({ y: 3, x: { b: 2, a: 1 } }));
  });

  it('is stable for structurally equal but separately built values', () => {
    const build = (): unknown => ({ players: [{ id: 0, name: 'Player 1' }], turn: 1 });
    expect(hashValue(build())).toBe(hashValue(build()));
  });

  it('hashes distinct values differently', () => {
    const values: readonly unknown[] = [
      null,
      true,
      false,
      0,
      1,
      -1,
      '',
      'a',
      'b',
      [],
      [0],
      [1],
      {},
      { a: 1 },
      { a: 2 },
      { b: 1 },
      { a: 1, b: 2 },
      { a: [1, 2] },
      { a: [2, 1] },
      { a: { b: 1 } },
      { a: { b: 1, c: 2 } },
    ];
    const digests = values.map((value) => hashValue(value));
    expect(new Set(digests).size).toBe(values.length);
    for (const digest of digests) {
      expect(digest).toMatch(HEX64);
    }
  });

  it('changes when one nested leaf changes', () => {
    const before = { map: { width: 4, terrain: [1, 2, 3, 4] }, turn: 1 };
    const after = { map: { width: 4, terrain: [1, 2, 3, 5] }, turn: 1 };
    expect(hashValue(before)).not.toBe(hashValue(after));
  });

  it('propagates rejections from canonicalize', () => {
    expect(() => hashValue({ bad: Number.NaN })).toThrow(/canonicalize/);
    expect(() => hashValue(undefined)).toThrow(/canonicalize/);
  });
});

describe('index re-exports', () => {
  it('keeps the invariant machinery alongside the hashing helpers', () => {
    const invariant: Invariant<{ n: number }> = (state) =>
      state.n < 0 ? [violation('negative', `n=${String(state.n)}`)] : [];
    expect(runInvariants({ n: 1 }, [invariant])).toHaveLength(0);
    expect(runInvariants({ n: -1 }, [invariant])).toHaveLength(1);
    expect(() => {
      assertInvariants({ n: -1 }, [invariant]);
    }).toThrow(/negative/);
    expect(() => {
      assertInvariants({ n: 1 }, [invariant]);
    }).not.toThrow();
  });

  it('exports canonicalize, fnv1a64 and hashValue', () => {
    expect(typeof canonicalize).toBe('function');
    expect(typeof fnv1a64).toBe('function');
    expect(typeof hashValue).toBe('function');
  });
});
