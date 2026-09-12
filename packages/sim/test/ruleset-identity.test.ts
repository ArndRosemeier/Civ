/**
 * **The row-order contract, asserted rather than assumed.**
 *
 * `docs/INTERFACES.md`'s frozen "STANDING REQUIREMENT — simulation-first" section is
 * the authority here, and its adversarial verification found that catalog **row order
 * is silently an input to the game**: `gen.ts` draws the map RNG once per resource row
 * *in row order*, so the same seed under the same rows in another order places
 * different resources before any player has moved. That coupling is deliberate and is
 * safe for exactly one reason:
 *
 * > **two catalogs that differ only in row order are two different RULESETS by
 * > identity**, because `hashValue(validateRuleset(catalog))` covers row order.
 *
 * Which is what makes an M11 replay against the wrong ordering *detectable* — the two
 * runs' identities differ — instead of silently producing a different game under what
 * looks like the same ruleset. **That safety is a checked contract or it is an
 * accident**, and an accident is what this file removes: it pins the property against
 * the shipped content, in both directions.
 *
 * ## What is asserted, and why each half is needed
 *
 * 1. **Row order reaches the identity, in every section.** Reversing, rotating or
 *    deterministically shuffling any one section's rows yields a different ruleset
 *    hash — and the three arrangements differ from *each other* too, so the property
 *    is "a permutation is visible", not "a reversal is visible". A reversal alone
 *    would not distinguish a hash that covers order from one that is merely
 *    reversal-sensitive (an involutive artefact of how the encoder happens to fold a
 *    list), which is why the shuffle is here rather than left to review.
 * 2. **The permutations are real permutations.** Each arrangement is a re-ordering of
 *    the *same rows* — same multiset, same length, no row added, dropped or edited —
 *    so a differing hash is attributable to the order and nothing else.
 * 3. **The identity is a function of the rows, not of the order they were computed
 *    in.** Re-applying the inverse permutation returns the shipped hash exactly, and a
 *    catalog **rebuilt** with the same rows in the same order — fresh array objects,
 *    fresh row objects — hashes identically. That is the converse the contract needs:
 *    without it, "permuting a section moves the hash" would be satisfied by a hash
 *    that also moved for irrelevant reasons, and a replay would fail for noise rather
 *    than for a real mismatch.
 * 4. **The shipped identity itself is pinned**, together with the measured pair the
 *    requirement quotes (`e69bfbaab6d3bba4` as shipped; `0b6d39501ac57528` with
 *    `resources` and `units` reversed), so a reader can see that this file is talking
 *    about the real catalog and the real numbers rather than about a property that
 *    holds vacuously on an empty list.
 *
 * `packages/core/test/gen.test.ts` pins the *world* half of the same contract (the
 * resource placement loop that the row order reaches) and the reversal case for every
 * section; this file adds the shuffle, the mutual distinctness, the inverse, the
 * rebuilt-catalog converse and the shipped identities. The two are deliberately
 * separate readerships: one is a reader of the generator, this one is a reader of the
 * ruleset's identity.
 *
 * Nothing here changes engine behaviour: it is a property of `@civts/rules`' catalog
 * and `@civts/testing`'s hasher, asserted from `@civts/sim`'s test tree because `sim`
 * is the package that depends on all three.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import { canonicalize, hashValue } from '@civts/testing';

/* ------------------------------------------------------------------ *
 * The sections, and permutations of them
 * ------------------------------------------------------------------ */

type Section = 'terrains' | 'units' | 'buildings' | 'improvements' | 'resources' | 'techs';

/** Declared in the catalog's own field order, which is also the reading order below. */
const SECTIONS: readonly Section[] = [
  'terrains',
  'units',
  'buildings',
  'improvements',
  'resources',
  // M5's tech tree is the sixth catalog section, and it is a section here rather than a
  // special case for the reason this file exists: its rows reach the validated ruleset,
  // so their *order* is part of the identity a replay compares. Seventeen shipped rows
  // make the three arrangements below distinct, so the non-vacuity guard holds.
  'techs',
];

const validated = (catalog: Catalog, label: string): Ruleset => {
  const result = validateRuleset(catalog, 'tuned');
  if (!result.ok) {
    throw new Error(
      `${label} does not validate: ${result.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return result.value;
};

const hashOf = (catalog: Catalog, label: string): string => hashValue(validated(catalog, label));

const SHIPPED: Ruleset = validated(CATALOG, 'the shipped catalog');
const SHIPPED_HASH = hashValue(SHIPPED);

/** The row at `index`, or a loud failure — `noUncheckedIndexedAccess` without a cast. */
const at = <T>(rows: readonly T[], index: number): T => {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`the fixture has no row ${String(index)} of ${String(rows.length)}`);
  }
  return row;
};

/**
 * `rows` rearranged so that the result's `i`th entry is the input's `order[i]`th.
 *
 * The order is a list of source indices rather than a comparator, because the property
 * under test is about *arrangement*: a sort would be a different arrangement on
 * different engines (a stable sort of equal keys), which is the very class of
 * dependence this contract is about.
 */
const arrange = <T>(rows: readonly T[], order: readonly number[]): readonly T[] =>
  order.map((index) => at(rows, index));

const identityOrder = (count: number): readonly number[] =>
  Array.from({ length: count }, (_, index) => index);

/**
 * A deterministic shuffle: Fisher–Yates over an LCG, with the seed a constant of this
 * file. **Not `Math.random`** — the arrangement has to be the same on every run and
 * every machine for "this arrangement differs" to be a statement about the arrangement
 * — and the LCG is integer-only, so it is exact in every JavaScript engine.
 */
const shuffleOrder = (count: number, seed: number): readonly number[] => {
  const order = [...identityOrder(count)];
  let state = seed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    const left = at(order, index);
    const right = at(order, other);
    order[index] = right;
    order[other] = left;
  }
  return order;
};

/** The permutation that undoes `order`: `inverseOf(order)` arranged by `order` is the identity. */
const inverseOf = (order: readonly number[]): readonly number[] => {
  const inverse = new Array<number>(order.length).fill(0);
  for (let position = 0; position < order.length; position += 1) {
    inverse[at(order, position)] = position;
  }
  return inverse;
};

/** `count` reversed: the arrangement `gen.test.ts` and the requirement's note both quote. */
const reverseOrder = (count: number): readonly number[] => [...identityOrder(count)].reverse();

/** A rotation: a permutation that is neither the identity nor the reverse for count >= 3. */
const rotateOrder = (count: number): readonly number[] =>
  identityOrder(count).map((index) => (index + 1) % count);

interface Arrangement {
  readonly label: string;
  readonly order: (count: number) => readonly number[];
}

/**
 * Three arrangements, chosen so the evidence is not one arrangement's artefact: a
 * reversal (involutive), a rotation (a cycle), and a shuffle (neither, and distinct
 * from both for every section length the shipped catalog has). Two of the three are
 * *not* self-inverse, so a hash that only noticed reversing would fail here.
 */
const ARRANGEMENTS: readonly Arrangement[] = [
  { label: 'reversed', order: reverseOrder },
  { label: 'rotated', order: rotateOrder },
  { label: 'shuffled', order: (count) => shuffleOrder(count, 0x2) },
];

/**
 * `catalog` with `section`'s rows rearranged.
 *
 * One branch per section rather than a computed key: a computed spread would need a
 * cast to get back into `Catalog`, and a cast here would hide exactly the mistake this
 * helper could make — arranging `terrains` and assigning the result to `units`. Each
 * branch instead calls `arrange` on the section's *own* typed array, so the types do
 * the checking and there is no assertion anywhere in this file.
 */
const arranged = (catalog: Catalog, section: Section, order: readonly number[]): Catalog => {
  switch (section) {
    case 'terrains':
      return { ...catalog, terrains: arrange(catalog.terrains, order) };
    case 'units':
      return { ...catalog, units: arrange(catalog.units, order) };
    case 'buildings':
      return { ...catalog, buildings: arrange(catalog.buildings, order) };
    case 'improvements':
      return { ...catalog, improvements: arrange(catalog.improvements, order) };
    case 'resources':
      return { ...catalog, resources: arrange(catalog.resources, order) };
    case 'techs':
      return { ...catalog, techs: arrange(catalog.techs, order) };
  }
};

/**
 * `section`'s rows, as a list whose element type is deliberately not narrowed.
 *
 * The loops below apply *one* arrangement to every section in turn, and the five row
 * types have nothing in common except being rows; reading them as `unknown` is what
 * lets the loop be written once. Nothing here inspects a row's fields — the whole
 * subject is the list's *order* — so there is no information to lose.
 */
const rowsOf = (catalog: Catalog, section: Section): readonly unknown[] => {
  switch (section) {
    case 'terrains':
      return catalog.terrains;
    case 'units':
      return catalog.units;
    case 'buildings':
      return catalog.buildings;
    case 'improvements':
      return catalog.improvements;
    case 'resources':
      return catalog.resources;
    case 'techs':
      return catalog.techs;
  }
};

/**
 * The rows' canonical forms, sorted — the row **set**, with array order deliberately
 * erased.
 *
 * `canonicalize` preserves array order (it is the state hasher's encoder, and a state's
 * lists are ordered data), so it cannot be the equality used to say "these are the same
 * rows in a different order". Sorting the per-row encodings is that statement: same
 * length, same rows, same field values, any arrangement.
 */
const rowMultiset = (rows: readonly unknown[]): readonly string[] =>
  rows.map((row) => canonicalize(row)).sort();

/* ------------------------------------------------------------------ *
 * The identities the requirement quotes, measured on shipped content
 * ------------------------------------------------------------------ */

describe('the shipped ruleset identity, as the standing requirement quotes it', () => {
  it('is a real 16-hex-character digest, reproduced by an independent validation', () => {
    expect(SHIPPED_HASH).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf(CATALOG, 'the shipped catalog again')).toBe(SHIPPED_HASH);
  });

  it('is 7cf57f33400a00f6, and c2d3d7665e3a17ce with resources and units reversed', () => {
    // These two numbers are the requirement's own measured fact, and pinning them is
    // what ties the property below to the real catalog. **If this assertion fails, the
    // catalog's content or order moved**: that is either an intentional content change
    // (in which case re-measure both numbers *and* expect the golden state hashes to
    // have moved with them, which is a deliberate rehash) or an inadvertent reorder
    // (which is the bug this file exists to catch, and is not a rehash at all).
    //
    // **They were re-measured exactly once, for M5, and both halves of that rule held.**
    // The cause is a *content* change, not a reorder: the validated ruleset gained
    // `techs` (sixth section, seventeen rows), so `hashValue` sees a key it did not see
    // before. The previous pins were `e69bfbaab6d3bba4` and `0b6d39501ac57528`; the
    // golden state hashes moved in the same wave and were rehashed through the harness's
    // opt-in path, which is the corroboration the paragraph above asks for. No row was
    // reordered, and the arrangement property below is asserted unchanged.
    //
    // **M6 re-measured them a second time, for the same two reasons M5 did.** The cause
    // is content again, not order: M6 gives every terrain row the `defenseBonus` spelling
    // of its defence percentage, gives every unit row real combat statistics
    // (`hitPoints`), adds four unit rows (archer, spearman, horseman, transport), two
    // techs (map-making, horseback-riding) and the tech gates the M6 contract requires
    // shipped content to declare, and gives the temple a `requiresTech`. The pins were
    // `c06c522342e59cfc` and `b6d9de8d3bed6ba0`. The golden state hashes moved in the same
    // wave (SCHEMA_VERSION 7 -> 8) and were regenerated through the harness's opt-in path,
    // which is the same corroboration: a golden hash movement with no shape change would
    // be a semantic bug, and this is neither. No row was reordered — the three-arrangement
    // sweep below still passes, which is what says so.
    //
    // **M6b re-measured them a third time, and this is the first movement that is NOT a
    // rehash.** The cause is content again — the catalog gained its required `combat`
    // section (nine magnitudes plus a provenance note), so the validated ruleset carries a
    // key `hashValue` never saw before, and the previous pins were `01bc03c374363110` and
    // `5db0937200bb25b0`. What makes this one different is the *state* goldens: they did
    // NOT move, because the nine numbers are the ones M6 already used and the resolver's
    // arithmetic is unchanged — the section is a relocation, so identity moved while
    // behaviour did not. A state golden moving here would mean something other than the
    // section moved with it. No row was reordered; the arrangement sweep below still
    // passes, and the non-vacuity assertions over the rebuild now cover `combat` too.
    //
    // **M7 re-measured them a fourth time, and it is the second movement that is not a
    // rehash — the same shape of change one milestone later.** The catalog gained its
    // required `capture` section (one magnitude plus a provenance note), so the validated
    // ruleset carries one more key, and the pins were `9d1440035de55f86` and
    // `22f3d14aea97575e`. The state goldens did NOT move again, and for the same reason:
    // the divisor is M6's own 2 and the capture arithmetic (`floor(population / divisor)`,
    // never below one) is unchanged, so `core/cities.ts` now *reads* a number it used to
    // *hold*. Identity moved because the ruleset says one more thing; behaviour did not,
    // because it says the same thing. A state golden moving here would mean the
    // relocation had become a retune. No row was reordered — the arrangement sweep below
    // still passes — and the rebuild's non-vacuity assertions now cover `capture` as well.
    expect(SHIPPED_HASH).toBe('7cf57f33400a00f6');
    const reversedUnits = arranged(CATALOG, 'units', reverseOrder(CATALOG.units.length));
    const reversedBoth = arranged(
      reversedUnits,
      'resources',
      reverseOrder(CATALOG.resources.length),
    );
    expect(hashOf(reversedBoth, 'resources and units reversed')).toBe('c2d3d7665e3a17ce');
  });
});

/* ------------------------------------------------------------------ *
 * 1 + 2. Every section, every arrangement
 * ------------------------------------------------------------------ */

describe('row order is part of the ruleset identity, in every catalog section', () => {
  it('moves the hash for a reversal, a rotation and a shuffle — and the three differ from each other', () => {
    // Non-vacuity first: every section must have at least three rows, or "rotated" and
    // "reversed" could coincide and the distinctness below would be vacuous.
    for (const section of SECTIONS) {
      expect(CATALOG[section].length).toBeGreaterThanOrEqual(3);
    }

    for (const section of SECTIONS) {
      const rows = rowsOf(CATALOG, section);
      const hashes = new Map<string, string>();

      for (const arrangement of ARRANGEMENTS) {
        const order = arrangement.order(rows.length);

        // Non-vacuity: a real permutation — same length, same rows, same multiset, so
        // the hash difference below is the ORDER and not an edited row.
        expect(order).toHaveLength(rows.length);
        expect([...order].sort((a, b) => a - b)).toEqual(identityOrder(rows.length));
        expect(rowMultiset(arrange(rows, order))).toEqual(rowMultiset(rows));
        // ...and not the identity itself, or the case would restate the shipped hash.
        expect(order).not.toEqual(identityOrder(rows.length));

        const moved = arranged(CATALOG, section, order);
        const movedHash = hashOf(moved, `${section} ${arrangement.label}`);
        expect(movedHash).not.toBe(SHIPPED_HASH);

        // The inverse arrangement returns the shipped catalog exactly: the difference
        // is the order and not a reformatting the validator does on the way through.
        expect(
          hashOf(
            arranged(moved, section, inverseOf(order)),
            `${section} ${arrangement.label} undone`,
          ),
        ).toBe(SHIPPED_HASH);

        hashes.set(arrangement.label, movedHash);
      }

      // The three arrangements must be three DIFFERENT permutations of this section, or
      // "three different identities" below would be an arithmetic impossibility rather
      // than a property of the hash. Checked first, so a future row count that made two
      // arrangements coincide fails here — where the message is "pick another seed" —
      // instead of as a mysterious hash collision.
      const distinctArrangements = new Set(
        ARRANGEMENTS.map((arrangement) => arrangement.order(rows.length).join(',')),
      );
      expect(distinctArrangements.size).toBe(ARRANGEMENTS.length);

      // ...and then: distinct arrangements have distinct identities. This is the property
      // the contract needs — "a permutation is visible", not "a reversal is visible". A
      // hash that folded a list in a way that noticed only reversal would pass the
      // `not.toBe(SHIPPED_HASH)` checks above and fail here.
      expect(new Set(hashes.values()).size).toBe(distinctArrangements.size);
    }
  });

  it('is visible when every section moves at once, and differs from moving any one section', () => {
    const allAtOnce: Catalog = SECTIONS.reduce(
      (catalog, section) => arranged(catalog, section, shuffleOrder(CATALOG[section].length, 0x2)),
      CATALOG,
    );
    const allHash = hashOf(allAtOnce, 'every section shuffled');
    expect(allHash).not.toBe(SHIPPED_HASH);

    // Distinct from each single-section shuffle, so "all at once" is not a restatement
    // of one of them.
    for (const section of SECTIONS) {
      const one = arranged(CATALOG, section, shuffleOrder(CATALOG[section].length, 0x2));
      expect(hashOf(one, `${section} shuffled`)).not.toBe(allHash);
    }

    // Undoing every one of them returns the shipped identity: all six permutations
    // compose back to the shipped catalog and to nothing else.
    const undone = SECTIONS.reduce((catalog, section) => {
      const order = shuffleOrder(CATALOG[section].length, 0x2);
      return arranged(catalog, section, inverseOf(order));
    }, allAtOnce);
    expect(hashOf(undone, 'every shuffle undone')).toBe(SHIPPED_HASH);
  });
});

/* ------------------------------------------------------------------ *
 * 3 + 4. The converse: identical rows in identical order are one identity
 * ------------------------------------------------------------------ */

describe('a catalog rebuilt row for row has the shipped identity', () => {
  it('does not move the hash when the arrays and the row objects are fresh', () => {
    // The converse the contract needs. A hash that moved here would make an M11 replay
    // fail for a reason that is not a ruleset difference at all — the same rows, read
    // into new objects, which is what parsing a save or a patch does.
    const rebuilt: Catalog = {
      terrains: CATALOG.terrains.map((row) => ({ ...row })),
      units: CATALOG.units.map((row) => ({ ...row })),
      buildings: CATALOG.buildings.map((row) => ({ ...row })),
      improvements: CATALOG.improvements.map((row) => ({ ...row })),
      resources: CATALOG.resources.map((row) => ({ ...row })),
      techs: CATALOG.techs.map((row) => ({ ...row })),
      // M6b's `combat` section is a singleton rather than a list of rows, so it is cloned
      // as an object. It is in this rebuild for the same reason every section is: the
      // identity a replay compares is the *whole* validated ruleset, and a rebuild that
      // quietly dropped the combat globals would be comparing a different game.
      combat: { ...CATALOG.combat },
      // M7's `capture` section is the second singleton, cloned for the same reason: the
      // identity a replay compares is the whole validated ruleset, and the divisor a sack
      // applies is part of what a game is played under.
      capture: { ...CATALOG.capture },
    };
    // Non-vacuity: the rebuild really is a different object graph.
    expect(rebuilt.terrains).not.toBe(CATALOG.terrains);
    expect(at(rebuilt.terrains, 0)).not.toBe(at(CATALOG.terrains, 0));
    expect(rebuilt).not.toBe(CATALOG);
    expect(rebuilt.combat).not.toBe(CATALOG.combat);
    expect(rebuilt.capture).not.toBe(CATALOG.capture);

    expect(hashOf(rebuilt, 'the rebuilt catalog')).toBe(SHIPPED_HASH);
    // ...and the arrangement is still the shipped one, section by section, so the
    // equality is not a hash that ignores order entirely.
    for (const section of SECTIONS) {
      expect(canonicalize(rebuilt[section])).toBe(canonicalize(CATALOG[section]));
    }
  });

  it('keeps the identity stable across repeated validation, and moves it for a one-row edit', () => {
    // The other direction, so "rebuilt catalogs hash the same" cannot be satisfied by a
    // hash that ignores catalog content: changing a row's own value moves the identity,
    // while re-validating the same rows does not.
    expect(hashOf(CATALOG, 'third validation')).toBe(SHIPPED_HASH);
    expect(hashOf(CATALOG, 'fourth validation')).toBe(SHIPPED_HASH);

    const firstTerrain = at(CATALOG.terrains, 0);
    const edited: Catalog = {
      ...CATALOG,
      terrains: [
        { ...firstTerrain, name: `${firstTerrain.name} (edited)` },
        ...CATALOG.terrains.slice(1),
      ],
    };
    expect(hashOf(edited, 'a terrain renamed')).not.toBe(SHIPPED_HASH);
    // The edit is the only difference: the rows are the same rows in the same order.
    expect(edited.terrains).toHaveLength(CATALOG.terrains.length);

    // **The singleton sections are inside the identity too** (M7). A section that the
    // rebuild carried but the hash ignored would make a replay compare two games played
    // under different capture rules — which is exactly the class of bug this file exists
    // for, and the reason the `capture` divisor is worth one assertion of its own rather
    // than a line in a list.
    const otherDivisor: Catalog = {
      ...CATALOG,
      capture: { ...CATALOG.capture, populationDivisor: CATALOG.capture.populationDivisor + 1 },
    };
    expect(hashOf(otherDivisor, 'the capture divisor moved')).not.toBe(SHIPPED_HASH);
    const otherWalls: Catalog = {
      ...CATALOG,
      combat: { ...CATALOG.combat, wallsBonusPct: CATALOG.combat.wallsBonusPct + 1 },
    };
    expect(hashOf(otherWalls, 'the walls bonus moved')).not.toBe(SHIPPED_HASH);
  });
});
