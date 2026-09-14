/**
 * The schema's own test: the classification and the extraction cannot disagree.
 *
 * `src/ui/schema.ts` deliberately states the same fact twice — once as a table
 * (`COMMAND_PLACEMENT`, which the compiler forces to be total) and once as the switch inside
 * `tileNamedBy` (which the compiler also forces to be exhaustive). The duplication is intentional:
 * the table is what a reader consults and what a future layout queries, while the switch is what
 * *extracts* a tile and has to narrow the union to do it. What must never happen is the two drifting
 * — a row saying `map` while the extractor returns `undefined` would mean a command the schema
 * claims the map can issue and the map silently cannot, which is precisely the class of defect the
 * keystone invariant exists to catch.
 *
 * So this file's job is to be the bridge, and it is deliberately built the same way: `SAMPLES` is a
 * `Record` over `Command['type']`, so **a new command member does not compile until it is sampled
 * here**, and every assertion below then covers it automatically.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  asBuildingId,
  asCityId,
  asGovernmentId,
  asImprovementId,
  asTechId,
  asTileIndex,
  asUnitId,
  cityProductionOptions,
  DEFAULT_SETTINGS,
  legalActions,
  newGame,
  unitActions,
  type Command,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  COMMAND_PLACEMENT,
  enumerationContextsOf,
  enumeratedIn,
  isEnumerated,
  isMapCommand,
  surfaceCounts,
  surfaceOf,
  tileNamedBy,
} from '../../src/ui/schema.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

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
  StartWork: { type: 'StartWork', unitId: asUnitId(1), kind: asImprovementId('mine') },
  CancelWork: { type: 'CancelWork', unitId: asUnitId(1) },
  SetRates: { type: 'SetRates', rates: { tax: 5, science: 3, luxury: 2 } },
  SetResearch: { type: 'SetResearch', tech: asTechId('bronze-working') },
  AttackUnit: { type: 'AttackUnit', unitId: asUnitId(1), target: asTileIndex(9) },
  FortifyUnit: { type: 'FortifyUnit', unitId: asUnitId(1) },
  SetGovernment: { type: 'SetGovernment', government: asGovernmentId('despotism') },
};

const EVERY_COMMAND = Object.values(SAMPLES);

describe('the UI schema', () => {
  it('classifies every command the engine accepts, and no others', () => {
    // The engine's union is exactly these twelve (packages/core/src/commands.ts:408-517). Asserting
    // the count is the cheap half: if a member were added, `SAMPLES` above would not compile, and if
    // the *engine* were the thing that shrank, this catches a stale web-side belief.
    expect(EVERY_COMMAND).toHaveLength(12);
    expect(Object.keys(COMMAND_PLACEMENT).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it('puts exactly one command in permanent chrome, which is the whole argument for a receding UI', () => {
    // The headline claim of docs/UI-OVERHAUL.md §2.C, re-derived rather than restated. If a future
    // change moves a command into `ambient`, this fails and the claim gets re-argued rather than
    // quietly becoming false.
    expect(surfaceCounts()).toEqual({ map: 2, cluster: 4, workspace: 5, ambient: 1 });
    expect(surfaceOf('EndTurn')).toBe('ambient');
  });

  it('splits enumeration by CONTEXT, because a command is only ever enumerated for something', () => {
    // The first version of this test asserted "six and six" from a single global field, and that was
    // wrong in a way no count could reveal: `SetProduction` is enumerated for a CITY by
    // `cityProductionOptions`, while the unit- and player-level generators never yield it. A global
    // boolean had to call that one or the other and could not be right either way —
    // `e2e/keystone.spec.ts:83` had already chosen "enumerated" while this file chose "queried".
    expect(enumeratedIn('unit')).toEqual([
      'MoveUnit',
      'AttackUnit',
      'FoundCity',
      'StartWork',
      'CancelWork',
    ]);
    expect(enumeratedIn('city')).toEqual(['SetProduction']);
    // The player context is the union of the five unit lists plus the turn — measured, not assumed.
    expect(enumeratedIn('player')).toEqual([
      'MoveUnit',
      'AttackUnit',
      'FoundCity',
      'StartWork',
      'CancelWork',
      'EndTurn',
    ]);

    // Five commands are in no list in any context — the choice boards and the search spaces. The
    // union of the three contexts above and these five is all twelve, so nothing is unclassified.
    const never = EVERY_COMMAND.filter((c) => enumerationContextsOf(c.type).length === 0)
      .map((c) => c.type)
      .sort();
    // Sorted for a reason: an unsorted comparison would be asserting the order the SAMPLES happen to
    // be written in, which is not a claim about the schema at all and would fail the moment someone
    // reordered that object for readability.
    expect(never).toEqual(
      ['FortifyUnit', 'SetWorkedTiles', 'SetResearch', 'SetRates', 'SetGovernment'].sort(),
    );

    // The two commands the map issues are both enumerated *for a unit*, which is what lets a map
    // click be an offered action rather than a command the UI invented.
    expect(isMapCommand(SAMPLES['MoveUnit'])).toBe(true);
    expect(isMapCommand(SAMPLES['AttackUnit'])).toBe(true);
    expect(isEnumerated('MoveUnit', 'unit')).toBe(true);
    expect(isEnumerated('AttackUnit', 'unit')).toBe(true);
  });

  it('agrees with the engine about what each context enumerates, asked of the engine itself', () => {
    // A table of names is a belief; this asks the engine. Three separate questions, because there are
    // three separate functions and the whole point of the column is that they answer differently.
    const started = newGame(5, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
    if (!started.ok) throw new Error('newGame failed on the shipped catalog');
    const state = started.value;
    const seat: PlayerId = state.players[0]?.id ?? (0 as PlayerId);

    // --- the PLAYER context: `legalActions`, which ends with one EndTurn -------------------------
    const playerYielded = new Set([...legalActions(state, RULESET, seat)].map((c) => c.type));
    expect(
      playerYielded.size,
      'the engine’s generator yielded nothing, so the assertions below would prove nothing',
    ).toBeGreaterThan(0);
    expect([...playerYielded]).toContain('EndTurn');
    expect([...playerYielded]).toContain('MoveUnit');
    // Everything the player-level generator yields must be labelled as enumerated for the player —
    // labelling `EndTurn` as queried is the mutation this catches, and a count of six cannot.
    for (const type of playerYielded) {
      expect(
        isEnumerated(type, 'player'),
        `the engine enumerates ${type} for the player, but the schema does not`,
      ).toBe(true);
    }

    // --- the UNIT context: `unitActions`, which answers for one unit at a time -------------------
    const settler = state.units.find((unit) => unit.owner === seat && unit.type === 'settler');
    if (settler === undefined) throw new Error('the acting seat has no settler to ask about');
    const unitYielded = new Set(unitActions(state, RULESET, settler.id).map((c) => c.type));
    expect(unitYielded.size).toBeGreaterThan(0);
    for (const type of unitYielded) {
      expect(
        isEnumerated(type, 'unit'),
        `the engine enumerates ${type} for a unit, but the schema does not`,
      ).toBe(true);
    }
    // And the other direction, which is the engine's own design rather than a gap in the UI: the
    // choice boards are in no list, so a unit's list must never contain one.
    for (const type of Object.keys(COMMAND_PLACEMENT) as Command['type'][]) {
      if (!isEnumerated(type, 'unit')) {
        expect(
          unitYielded.has(type),
          `the schema says ${type} is not a unit action, but it is`,
        ).toBe(false);
      }
    }
    // A unit's actions are its own (`actions.ts:127-137`), so the turn is NOT among them — while the
    // player's list ends with exactly one. This pair is the assertion that would fail if the two
    // contexts were collapsed back into a single boolean again.
    expect(unitYielded.has('EndTurn')).toBe(false);
    expect(playerYielded.has('EndTurn')).toBe(true);
    // And the player's list is a strict superset: it carries every unit action plus the turn.
    for (const type of unitYielded) {
      expect(playerYielded.has(type), `the player's list is missing ${type}`).toBe(true);
    }

    // --- the CITY context: `cityProductionOptions`, which is what makes SetProduction a list ------
    const founded = applyCommand(state, seat, { type: 'FoundCity', unitId: settler.id }, RULESET);
    if (!founded.ok) throw new Error('founding the first city was refused');
    // `applyCommand` resolves to a wrapper carrying the new state, not the state itself.
    const afterFounding = founded.value.state;
    const city = afterFounding.cities.find((candidate) => candidate.owner === seat);
    if (city === undefined) throw new Error('founding a city produced no city');
    const items = cityProductionOptions(afterFounding, RULESET, city.id);
    expect(
      items.length,
      'the city was offered nothing to build, so it proved nothing about SetProduction',
    ).toBeGreaterThan(0);
    // Non-vacuous: the city really does hand the UI a list, which is why `SetProduction` is
    // enumerated for a city — the disagreement this test was written to settle.
    expect(isEnumerated('SetProduction', 'city')).toBe(true);
    expect(isEnumerated('SetProduction', 'unit')).toBe(false);
  });

  it('names a tile for exactly the commands whose surface is the map', () => {
    // THE drift check. One direction or the other is the defect: a table row that says `map` with no
    // way to extract the tile is a promise the schema cannot keep, and an extractor that returns a
    // tile for a command the table calls a workspace means the map would act on ground the schema
    // says is not the map's business.
    for (const command of EVERY_COMMAND) {
      const named = tileNamedBy(command);
      if (isMapCommand(command)) {
        expect(named, `${command.type} is a map command but names no tile`).toBeTypeOf('number');
      } else {
        expect(named, `${command.type} is not a map command but names tile ${String(named)}`).toBe(
          undefined,
        );
      }
    }
  });

  it('extracts the destination for a move and the victim for an attack, not the other way round', () => {
    // Asserting only "a number came back" would pass if the two fields were swapped, and a swapped
    // pair would send a unit to the tile it was told to attack. The samples give the two different
    // tile indices (7 and 9) precisely so this can tell them apart.
    expect(tileNamedBy(SAMPLES['MoveUnit'])).toBe(7);
    expect(tileNamedBy(SAMPLES['AttackUnit'])).toBe(9);
    expect(tileNamedBy(SAMPLES['MoveUnit'])).not.toBe(tileNamedBy(SAMPLES['AttackUnit']));
  });

  it('carries a tile field on the map rows and only on those', () => {
    // The row's own claim, checked against the same samples. This is the half of the duplication
    // that a reader of the table actually relies on.
    //
    // `in` rather than a comparison against `undefined`, and the distinction is the project's own
    // rule: a non-map row *omits* `tileField`, it does not set it to `undefined`, because a key
    // whose value is `undefined` does not survive a JSON round trip. The type system agrees — the
    // `as const` table gives those rows a type with no such property at all — so a test that read
    // `.tileField` on them would not even compile.
    for (const [type, placement] of Object.entries(COMMAND_PLACEMENT)) {
      const namesATile = 'tileField' in placement;
      const shouldNameATile = type === 'MoveUnit' || type === 'AttackUnit';
      expect(namesATile, `${type} should${shouldNameATile ? '' : ' not'} carry a tile field`).toBe(
        shouldNameATile,
      );
    }
  });
});
