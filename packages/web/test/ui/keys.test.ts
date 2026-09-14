/**
 * `ui/keys.ts` — the keyboard contract, tested as the table it is.
 *
 * The interesting assertions here are not "Space selects the next unit" (that is `main.ts`'s job and
 * the e2e suite's, with a real browser and a real focus) but the three properties that make the
 * contract a contract:
 *
 * 1. **Every documented key resolves to its documented action.** Table-driven, so a binding added
 *    without a key — or a key added without an action — fails here rather than in a player's hands.
 * 2. **The deferral rule really defers.** A modifier, a text field and an open panel each take the
 *    session keys away from the app; a test that skipped this would pass on a contract that steals
 *    `Space` from every button on the page.
 * 3. **`Tab` is not in the table.** The brief for this phase says to be careful with the key that
 *    belongs to the browser's own navigation, and the assertion is that nothing here claims it.
 */

import { describe, expect, it } from 'vitest';

import {
  KEY_BINDINGS,
  KEY_HELP,
  mapActionFor,
  mapBindings,
  sessionActionFor,
  sessionBindings,
  type KeyBinding,
  type KeyContext,
} from '../../src/ui/keys.js';

/** A keydown as the module sees one, with everything defaulted to "not held, not in a field". */
const ctx = (key: string, over: Partial<KeyContext> = {}): KeyContext => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  inTextField: false,
  dialogOpen: false,
  ...over,
});

/** Resolve a key through the half of the contract that owns it. */
const resolve = (binding: KeyBinding, key: string): string | undefined =>
  binding.where === 'document' ? sessionActionFor(ctx(key)) : mapActionFor(ctx(key));

describe('the keyboard contract resolves every key it documents', () => {
  it('covers every action with at least one key, and every key with exactly one action', () => {
    const actions = new Set(KEY_BINDINGS.map((binding) => binding.action));
    expect(actions.size, 'the table names no actions at all').toBe(KEY_BINDINGS.length);
    for (const binding of KEY_BINDINGS) {
      expect(binding.keys.length, `${binding.action} documents no key`).toBeGreaterThan(0);
      // A key in two rows would make the answer a function of the table's order, which is the one
      // thing a contract may not be.
      const owners = KEY_BINDINGS.filter((other) =>
        other.keys.some((key) => binding.keys.includes(key)),
      );
      expect(
        owners.map((owner) => owner.action),
        `the key ${binding.printed} is claimed by more than one action`,
      ).toEqual([binding.action]);
    }
  });

  it('resolves each of its keys to its own action', () => {
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        expect(
          resolve(binding, key),
          `the key ${JSON.stringify(key)} (${binding.printed}) did not resolve to ${binding.action}`,
        ).toBe(binding.action);
      }
    }
  });

  it('leaves every key it does not document alone', () => {
    for (const key of ['a', 'q', 'F5', 'PageDown', 'Backspace', '?']) {
      expect(sessionActionFor(ctx(key)), `${key} is not a session key`).toBeUndefined();
      expect(mapActionFor(ctx(key)), `${key} is not a map key`).toBeUndefined();
    }
  });

  it('never claims Tab, which belongs to the browser’s own navigation', () => {
    expect(
      KEY_BINDINGS.flatMap((binding) => binding.keys).includes('Tab'),
      'a binding took Tab: there is no focus trap in this app and the tab order is the contract',
    ).toBe(false);
  });
});

describe('the deferral rule gives the browser, the field and the panel their keys back', () => {
  it('claims nothing while ctrl, meta or alt is held', () => {
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        const held: readonly KeyContext[] = [
          ctx(key, { ctrlKey: true }),
          ctx(key, { metaKey: true }),
          ctx(key, { altKey: true }),
        ];
        for (const event of held) {
          const answer =
            binding.where === 'document' ? sessionActionFor(event) : mapActionFor(event);
          expect(
            answer,
            `${binding.printed} was claimed while a modifier the browser owns was held`,
          ).toBeUndefined();
        }
      }
    }
  });

  it('claims nothing while a text field has focus', () => {
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        const answer =
          binding.where === 'document'
            ? sessionActionFor(ctx(key, { inTextField: true }))
            : mapActionFor(ctx(key, { inTextField: true }));
        expect(answer, `${binding.printed} was claimed inside a text field`).toBeUndefined();
      }
    }
  });

  it('gives the session keys to an open panel, and keeps the map keys — which are view-only', () => {
    for (const binding of sessionBindings()) {
      for (const key of binding.keys) {
        expect(
          sessionActionFor(ctx(key, { dialogOpen: true })),
          `${binding.printed} was claimed while a panel was open, where Enter and Space press its controls`,
        ).toBeUndefined();
      }
    }
    for (const binding of mapBindings()) {
      for (const key of binding.keys) {
        expect(
          mapActionFor(ctx(key, { dialogOpen: true })),
          `${binding.printed} stopped panning or zooming because a side panel was open`,
        ).toBe(binding.action);
      }
    }
  });

  it('splits where it says it splits: no session key resolves on the map, and no map key anywhere', () => {
    for (const binding of sessionBindings()) {
      for (const key of binding.keys) {
        expect(mapActionFor(ctx(key)), `${binding.printed} is also a map key`).toBeUndefined();
      }
    }
    for (const binding of mapBindings()) {
      for (const key of binding.keys) {
        expect(
          sessionActionFor(ctx(key)),
          `${binding.printed} is also a session key`,
        ).toBeUndefined();
      }
    }
  });
});

describe('the help the player reads is the table the app obeys', () => {
  it('documents every binding, and documents nothing that is not one', () => {
    const documented = KEY_HELP.flatMap((section) => section.rows.map((row) => row.keys));
    const real = KEY_BINDINGS.map((binding) => binding.printed);
    expect(documented.slice().sort(), 'the help and the bindings disagree').toEqual(
      real.slice().sort(),
    );
    for (const section of KEY_HELP) {
      expect(
        section.rows.length,
        `the help section "${section.where}" lists no keys`,
      ).toBeGreaterThan(0);
      expect(
        section.note.length,
        `the help section "${section.where}" explains nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('says where each half applies, so the arrows are not read as broken', () => {
    const where = KEY_HELP.map((section) => section.where);
    expect(where, 'the help does not tell the player that the map keys need the map focus').toEqual(
      ['Anywhere', 'On the map'],
    );
    expect(KEY_HELP[1]?.note, 'the help does not say how to give the map the focus').toContain(
      'focus',
    );
  });
});
