/**
 * The seam's action reader: `toCommand`, and the one property that makes the keystone invariant
 * testable at the UI layer at all.
 * See docs/INTERFACES.md, M8 ("The test seam", "The keystone invariant") and M9+M10 ("The UI").
 *
 * ## Why this file exists
 *
 * Every control in this app dispatches an **action**, not a command: `panels/*.ts` hand
 * `{ type: 'SetGovernment', government }` to a dispatcher, and `main.ts`' `applyAction` and the
 * installed seam both read that action through `toCommand` before the engine is called. So a
 * command missing from that reader is refused *before* `applyCommand` ever sees it, and the control
 * for it is inert while everything around it looks right: the menu is populated from the engine's
 * catalog, the button is enabled on the engine's own verdict, and the click produces no engine call
 * at all.
 *
 * That is not a hypothetical shape. It is exactly how M9's `SetGovernment` first arrived — the
 * panel said "the engine accepts Despotism as your government" and the click came back `refused`,
 * because `toCommand` had no case for it. The e2e suite caught it (`e2e/m9-m10-ui.spec.ts` reads the
 * recorded dispatch back and compares it against the engine), and this test is the same guard one
 * layer down: it is cheap, it runs in milliseconds, and it fails on the *next* command rather than
 * on the one that already shipped broken.
 *
 * ## How it cannot go stale
 *
 * `SAMPLES` is typed `Readonly<Record<Command['type'], Command>>`. `Command['type']` is the union
 * of every member's tag in `packages/core/src/commands.ts`, so **a command added to the engine is a
 * compile error here until a sample for it is written** — the miss is caught by `tsc`, not by a
 * reviewer noticing. That is the same drift guard `panels/events.test.ts` uses over the event
 * union, and it is why this list is a `Record` over the union rather than an array of cases.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG, validateRuleset } from '@civts/rules';

import {
  asBuildingId,
  asCityId,
  asGovernmentId,
  asImprovementId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  governmentCatalog,
  type Command,
} from '@civts/core';

import { toCommand } from '../src/testapi.js';

/**
 * The shipped, validated content — the same ruleset the app plays on (`main.ts` validates `CATALOG`
 * the same way), so "the engine declares this government" below is a claim about the real catalog.
 */
const RULESET = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) throw new Error('the shipped catalog does not validate');
  return validated.value;
})();

/** One valid action per member of the engine's command union. */
const SAMPLES: Readonly<Record<Command['type'], Command>> = {
  EndTurn: { type: 'EndTurn' },
  MoveUnit: { type: 'MoveUnit', unitId: asUnitId(1), to: asTileIndex(7) },
  FoundCity: { type: 'FoundCity', unitId: asUnitId(1) },
  SetWorkedTiles: {
    type: 'SetWorkedTiles',
    cityId: asCityId(2),
    tiles: [asTileIndex(0), asTileIndex(1)],
  },
  SetProduction: {
    type: 'SetProduction',
    cityId: asCityId(2),
    item: { kind: 'building', id: asBuildingId('granary') },
  },
  StartWork: {
    type: 'StartWork',
    unitId: asUnitId(1),
    kind: asImprovementId('mine'),
  },
  CancelWork: { type: 'CancelWork', unitId: asUnitId(1) },
  SetRates: { type: 'SetRates', rates: { tax: 5, science: 3, luxury: 2 } },
  SetResearch: { type: 'SetResearch', tech: asTechId('bronze-working') },
  AttackUnit: { type: 'AttackUnit', unitId: asUnitId(1), target: asTileIndex(9) },
  FortifyUnit: { type: 'FortifyUnit', unitId: asUnitId(1) },
  SetGovernment: { type: 'SetGovernment', government: asGovernmentId('despotism') },
};

describe('the seam’s action reader', () => {
  it('reads every member of the engine’s command union, field for field', () => {
    // The `Record` type above is the exhaustiveness check: this loop would silently shrink if the
    // list were an array, and a command with no sample is a compile error rather than a gap.
    for (const [type, command] of Object.entries(SAMPLES)) {
      expect(type, 'a sample is filed under the wrong command type').toBe(command.type);
      expect(
        toCommand(command),
        `the seam's action reader does not read ${type}, so every control that dispatches one is ` +
          `inert: the action never reaches the engine and the applier is never asked`,
      ).toEqual(command);
    }
  });

  it('rejects an action that is not a member of the union, and never invents one', () => {
    expect(toCommand(undefined)).toBeUndefined();
    expect(toCommand(null)).toBeUndefined();
    expect(toCommand('EndTurn')).toBeUndefined();
    expect(toCommand([])).toBeUndefined();
    expect(toCommand({})).toBeUndefined();
    expect(toCommand({ type: 'NotACommand' })).toBeUndefined();
    // A member with a missing or wrongly-typed field is not a member, either: nothing is passed
    // through half-read, because a half-read command would be the app finishing a payload the
    // caller did not write.
    expect(toCommand({ type: 'MoveUnit', unitId: 1 })).toBeUndefined();
    expect(toCommand({ type: 'MoveUnit', to: 7 })).toBeUndefined();
    expect(toCommand({ type: 'SetRates', rates: { tax: 5, science: 3 } })).toBeUndefined();
    expect(toCommand({ type: 'SetGovernment' })).toBeUndefined();
    expect(toCommand({ type: 'SetGovernment', government: 3 })).toBeUndefined();
    expect(
      toCommand({ type: 'SetProduction', cityId: 2, item: { kind: 'wonder', id: 'x' } }),
    ).toBeUndefined();
    expect(
      toCommand({ type: 'SetWorkedTiles', cityId: 2, tiles: [asTileIndex(0), 'one'] }),
    ).toBeUndefined();
  });

  it('reads a unit-type production item as the engine’s own branded id', () => {
    // `SetProduction`'s item is the one payload with two shapes, so both are pinned: a building id
    // and a unit-type id are different branded types and a reader that confused them would produce
    // a command the engine could not match against the catalog.
    expect(
      toCommand({
        type: 'SetProduction',
        cityId: asCityId(2),
        item: { kind: 'unit', id: 'settler' },
      }),
    ).toEqual({
      type: 'SetProduction',
      cityId: asCityId(2),
      item: { kind: 'unit', id: asUnitTypeId('settler') },
    });
  });

  it('reads a government id the shipped ruleset actually declares', () => {
    // Not a rule restated here — a check that the sample above is a row of the engine's own catalog,
    // so the loop is exercising a value the engine describes rather than a string this file made up.
    const sample = SAMPLES.SetGovernment;
    if (sample.type !== 'SetGovernment')
      throw new Error('the sample is filed under the wrong type');
    expect(governmentCatalog(RULESET).map((row) => row.id)).toContain(sample.government);
  });
});
