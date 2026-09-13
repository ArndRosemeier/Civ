import {
  asGovernmentId,
  asImprovementId,
  asPlayerId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  hitPointsLeftOf,
  withWork,
  withoutWork,
  type Unit,
} from '@civts/core';
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

/* ------------------------------------------------------------------ *
 * M4a: an ABSENT optional field versus one present holding `undefined`
 *
 * This file has no hand-built `GameState` (nothing here reads the shape), so the
 * M4a migration left its assertions alone. What it *can* pin is the trap the shape
 * change walks past, in the one place where it is observable: the hash. `Unit.work`
 * is optional and must be **absent** when a unit is idle, because a key holding
 * `undefined` is dropped by `JSON.stringify` — the round-tripped state would hash
 * differently, so `canonicalize` refuses it outright rather than letting an
 * unhashable save exist. That bug class cost M2's `Settings.ruleset` and M3's
 * `City.production` a hunt each; this is the loud version of it.
 *
 * M4c: the same answer, for the same reason. `GameMap` gained a required `resources`
 * pair list and `SCHEMA_VERSION` went 5 -> 6, and neither can reach anything here —
 * this file hashes plain JSON, not `GameState`, so no hand-built literal needs the new
 * field and no assertion moves. Where the schema's hashes *are* pinned is where the
 * states are: `golden.test.ts`, and the `m3`/`m4b` adversarial files, which re-pinned
 * their digits to the M4c values.
 * ------------------------------------------------------------------ */

describe('an optional field, absent versus undefined', () => {
  /**
   * An idle worker: `newGame`/`spawnUnit` build this with no `work` key at all.
   *
   * M6 adds `hitPointsLeft`, and a unit the engine creates carries it — so the fixture
   * carries it too, and the assertions below can then make the stronger claim they were
   * always trying to make: `withWork`/`withoutWork` **preserve** the fields that are
   * nothing to do with a job. A rebuild that dropped a wounded worker's remaining hit
   * points would silently heal it, and an absent key in the fixture would have hidden
   * exactly that.
   */
  const idleWorker = (): Unit => ({
    id: asUnitId(0),
    type: asUnitTypeId('worker'),
    owner: asPlayerId(0),
    tile: asTileIndex(5),
    movementLeft: 1,
    hitPointsLeft: 1,
  });

  it('hashes a unit with a job and a unit without one, both JSON-stable', () => {
    const idle = idleWorker();
    const working = withWork(idle, {
      kind: asImprovementId('mine'),
      tile: asTileIndex(5),
      turnsLeft: 2,
    });

    // `withWork`/`withoutWork` are the only two writers of the field, and they
    // rebuild the unit explicitly: the key appears and disappears, and never holds
    // `undefined` in between.
    expect(Object.hasOwn(idle, 'work')).toBe(false);
    expect(Object.hasOwn(working, 'work')).toBe(true);
    expect(Object.hasOwn(withoutWork(working), 'work')).toBe(false);
    expect(withoutWork(working)).toEqual(idle);

    // Attaching or clearing a job is neither a healing event, a promotion nor a
    // fortification (M6): the health the unit had is the health it keeps, and the two
    // omitted-when-default keys stay omitted rather than becoming `undefined`.
    expect(hitPointsLeftOf(working)).toBe(1);
    expect(hitPointsLeftOf(withoutWork(working))).toBe(1);
    for (const unit of [idle, working, withoutWork(working)]) {
      expect(Object.hasOwn(unit, 'experience')).toBe(false);
      expect(Object.hasOwn(unit, 'fortified')).toBe(false);
    }

    // A save is JSON, so the hash of a state and of its round trip must agree —
    // for both shapes, which is exactly what an `undefined` valued key would break.
    for (const unit of [idle, working]) {
      const parsed: unknown = JSON.parse(JSON.stringify(unit));
      expect(parsed).toEqual(unit);
      expect(hashValue(parsed)).toBe(hashValue(unit));
    }
  });

  it('refuses a record whose optional key is present but undefined', () => {
    // The shape of the mistake, built as plain data (a `Unit` literal with this key
    // is a *type* error under `exactOptionalPropertyTypes`, which is half the
    // defence; this is the other half, for a value that arrived as `unknown`).
    const broken: Record<string, unknown> = {
      id: 0,
      type: 'worker',
      owner: 0,
      tile: 5,
      movementLeft: 1,
      work: undefined,
    };

    expect(() => canonicalize(broken)).toThrow(/undefined is not representable/);
    expect(() => hashValue(broken)).toThrow(/canonicalize/);

    // …and the value JSON would have handed back is not the value that was hashed:
    // the key is simply gone. Two different states, which is why the rejection
    // above is the honest behaviour rather than a lost key.
    const survived: unknown = JSON.parse(JSON.stringify(broken));
    expect(survived).not.toHaveProperty('work');
    // The key that was hashed is not the key that comes back, so the two states
    // could never have hashed the same — which is the whole reason for refusing it.
    expect(Object.keys(broken)).toContain('work');
    expect(Object.keys(survived ?? {})).not.toContain('work');
  });
});

/* ------------------------------------------------------------------ *
 * M4b: the money fields are inside the hashed input
 *
 * The M4b shape change adds four fields to every player — `treasury`, `rates`,
 * `beakers`, `luxuries` — and the point of hashing the state is that *nothing* that
 * can differ between two games may be invisible to the hash. A money field the
 * canonical form skipped would make `SetRates` a no-op to the gate, and two saves
 * that bank different gold would collide. The fields are also the newest instance of
 * the trap above: `rates` is a *nested object*, so a hand-built player is one typo
 * away from a key that holds `undefined`, which `canonicalize` refuses.
 *
 * Like the M4a section, this one stays shape-free on purpose: it uses plain records
 * with the money fields' names rather than a hand-built `GameState`, so it keeps
 * testing the hasher and not the engine's state layout.
 * ------------------------------------------------------------------ */

describe('the M4b money fields are part of the hashed input', () => {
  /** One player-shaped record: everything the money loop writes, and nothing else. */
  const player = (money: {
    readonly treasury: number;
    readonly rates: { readonly tax: number; readonly science: number; readonly luxury: number };
    readonly beakers: number;
    readonly luxuries: number;
  }): Record<string, unknown> => ({
    id: 0,
    name: 'Player 1',
    kind: 'civ',
    // M9: a player carries a government. `defaultGovernmentOf` picks the first row of
    // the ruleset's `governments` section, which is `despotism` in the shipped catalog;
    // this literal is a hand-built state, so it states the id rather than deriving it.
    government: asGovernmentId('despotism'),
    treasury: money.treasury,
    rates: money.rates,
    beakers: money.beakers,
    luxuries: money.luxuries,
  });

  const BASE = {
    treasury: 10,
    rates: { tax: 6, science: 4, luxury: 0 },
    beakers: 0,
    luxuries: 0,
  } as const;

  it('hashes each money field independently — none of the four is invisible', () => {
    const digests = new Set<string>([
      hashValue(player(BASE)),
      hashValue(player({ ...BASE, treasury: 11 })),
      hashValue(player({ ...BASE, beakers: 1 })),
      hashValue(player({ ...BASE, luxuries: 1 })),
      hashValue(player({ ...BASE, rates: { tax: 7, science: 3, luxury: 0 } })),
      hashValue(player({ ...BASE, rates: { tax: 7, science: 2, luxury: 1 } })),
      // A rate triple that is *illegal* under `RATE_TOTAL` still has to hash
      // differently from a legal one: the hash describes the state, and refusing
      // illegal rates is the command layer's job, not the canonical form's.
      hashValue(player({ ...BASE, rates: { tax: 11, science: 0, luxury: 0 } })),
    ]);
    expect(digests.size).toBe(7);
    for (const digest of digests) expect(digest).toMatch(HEX64);
  });

  it('is insertion-order independent for the nested rates object', () => {
    // `withMoney` rebuilds a player's object; the canonical form is what makes the
    // *order* those keys happen to be written in irrelevant to the hash.
    const one = { rates: { tax: 6, science: 4, luxury: 0 }, treasury: 10 };
    const other = { treasury: 10, rates: { luxury: 0, tax: 6, science: 4 } };
    expect(canonicalize(one)).toBe(canonicalize(other));
    expect(hashValue(one)).toBe(hashValue(other));
  });

  it('refuses a money field present but undefined, and survives the JSON round trip when absent', () => {
    // The mistake, as plain data: this is what an editing slip or an `unknown` value
    // arriving from a save looks like, and it is the M2 `Settings.ruleset` / M3
    // `City.production` bug class one milestone later.
    const broken: Record<string, unknown> = { ...player(BASE), rates: undefined };
    expect(() => canonicalize(broken)).toThrow(/undefined is not representable/);
    expect(() => hashValue(broken)).toThrow(/canonicalize/);
    // …and JSON hands back the value *without* the key, so the value that would have
    // been reloaded is not the value that was refused: dropping the rejection would
    // not make the two agree, it would only hide the difference.
    const reloaded: unknown = JSON.parse(JSON.stringify(broken));
    expect(reloaded).not.toHaveProperty('rates');

    // The honest spelling round-trips: the same value the engine wrote hashes the
    // same after a save and a reload.
    const intact = player(BASE);
    const parsed: unknown = JSON.parse(JSON.stringify(intact));
    expect(parsed).toEqual(intact);
    expect(hashValue(parsed)).toBe(hashValue(intact));
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
