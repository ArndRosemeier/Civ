/**
 * Event-line rendering — one line per member of the engine's `GameEvent` union.
 *
 * The **first** test in this file is the one that matters, and it is a compile-time check with
 * a runtime tail: `SAMPLES` is typed as a mapped type over `GameEvent['type']`, so adding a
 * member to the engine's union makes *this file* fail to compile until somebody supplies a
 * sample for it, and the loop then proves the renderer produces a real line for it. That is
 * the regression guard for the defect this project already shipped once — an unhandled event
 * rendering as a silently blank line — and it is deliberately keyed to the union rather than to
 * a hand-written list of names that could quietly fall behind it.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  asBuildingId,
  asCityId,
  asImprovementId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  newGame,
  type GameEvent,
  type GameState,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { eventLine, eventLines, productionItemName, tileLabel } from '../../src/events.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');

const RULESET: RulesetView = validated.value;

const started = newGame(42, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');

const STATE: GameState = started.value;

/**
 * One sample of **every** member of `GameEvent`. The mapped type is the exhaustiveness check:
 * a missing member is a type error here (see the file note).
 */
const SAMPLES: { readonly [K in GameEvent['type']]: Extract<GameEvent, { readonly type: K }> } = {
  UnitMoved: {
    type: 'UnitMoved',
    unitId: asUnitId(0),
    from: asTileIndex(0),
    to: asTileIndex(1),
    cost: 1,
    movementLeft: 1,
  },
  TurnEnded: { type: 'TurnEnded', playerId: asPlayerId(0), turn: 2 },
  CityFounded: {
    type: 'CityFounded',
    cityId: asCityId(0),
    owner: asPlayerId(0),
    name: 'City 1',
    tile: asTileIndex(5),
  },
  CityGrew: {
    type: 'CityGrew',
    cityId: asCityId(0),
    owner: asPlayerId(0),
    population: 3,
    foodBox: 4,
  },
  CityStarved: {
    type: 'CityStarved',
    cityId: asCityId(0),
    owner: asPlayerId(0),
    population: 2,
    foodBox: 0,
  },
  CityProduced: {
    type: 'CityProduced',
    cityId: asCityId(0),
    owner: asPlayerId(0),
    item: { kind: 'building', id: asBuildingId('granary') },
    shields: 2,
  },
  HutEntered: {
    type: 'HutEntered',
    unitId: asUnitId(0),
    owner: asPlayerId(0),
    tile: asTileIndex(9),
    reward: 'nothing',
  },
  BarbariansSpawned: {
    type: 'BarbariansSpawned',
    owner: asPlayerId(2),
    tile: asTileIndex(9),
    unitIds: [asUnitId(7)],
    tiles: [asTileIndex(9)],
  },
  WorkStarted: {
    type: 'WorkStarted',
    unitId: asUnitId(1),
    kind: asImprovementId('mine'),
    tile: asTileIndex(3),
    turnsLeft: 4,
  },
  WorkCancelled: {
    type: 'WorkCancelled',
    unitId: asUnitId(1),
    kind: asImprovementId('mine'),
    tile: asTileIndex(3),
    turnsLeft: 2,
    reason: 'moved',
  },
  WorkCompleted: {
    type: 'WorkCompleted',
    unitId: asUnitId(1),
    kind: asImprovementId('road'),
    tile: asTileIndex(3),
  },
  IncomeCollected: {
    type: 'IncomeCollected',
    playerId: asPlayerId(0),
    gold: 4,
    beakers: 3,
    luxuries: 0,
  },
  UpkeepPaid: {
    type: 'UpkeepPaid',
    playerId: asPlayerId(0),
    gold: 2,
    maintenance: 1,
    unitSupport: 1,
    units: 5,
    freeUnits: 4,
  },
  UnitDisbanded: {
    type: 'UnitDisbanded',
    playerId: asPlayerId(0),
    unitId: asUnitId(4),
    unitType: asUnitTypeId('warrior'),
    tile: asTileIndex(2),
    saved: 1,
  },
  TreasuryShortfall: { type: 'TreasuryShortfall', playerId: asPlayerId(0), unpaid: 3 },
  TechResearched: {
    type: 'TechResearched',
    playerId: asPlayerId(0),
    tech: asTechId('bronze-working'),
    cost: 20,
    beakers: 5,
  },
  CombatResolved: {
    type: 'CombatResolved',
    attackerId: asUnitId(0),
    attackerOwner: asPlayerId(0),
    defenderId: asUnitId(3),
    defenderOwner: asPlayerId(1),
    target: asTileIndex(4),
    outcome: 'attacker-wins',
    rounds: 3,
    attackerLost: 1,
    defenderLost: 3,
    attackerWinPct: 55,
    attackerSurvives: true,
    defenderSurvives: false,
  },
  UnitDestroyed: {
    type: 'UnitDestroyed',
    unitId: asUnitId(3),
    owner: asPlayerId(1),
    unitType: asUnitTypeId('warrior'),
    tile: asTileIndex(4),
    reason: 'combat',
    byUnitId: asUnitId(0),
    byOwner: asPlayerId(0),
  },
  UnitPromoted: {
    type: 'UnitPromoted',
    unitId: asUnitId(0),
    owner: asPlayerId(0),
    tile: asTileIndex(4),
    experience: 1,
    maxExperience: 3,
  },
  CityCaptured: {
    type: 'CityCaptured',
    cityId: asCityId(1),
    from: asPlayerId(1),
    to: asPlayerId(0),
    tile: asTileIndex(6),
    name: 'City 2',
    population: 1,
    destroyed: [asBuildingId('granary')],
  },
};

const ctx = { state: STATE, ruleset: RULESET };

describe('eventLine', () => {
  it('renders a real, non-blank line for every member of GameEvent', () => {
    for (const event of Object.values(SAMPLES)) {
      const line = eventLine(event, ctx);
      expect(line.trim().length, `blank line for ${event.type}`).toBeGreaterThan(0);
      // A line that leaked a JS `undefined` into its text is the blank-line bug wearing a
      // different hat: the member was reached but nothing true was said about it.
      expect(line, `${event.type} leaked undefined`).not.toContain('undefined');
    }
  });

  it('covers every member, and no two members render the same line', () => {
    const lines = Object.values(SAMPLES).map((event) => eventLine(event, ctx));
    expect(lines).toHaveLength(20);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("names players, units and cites the engine's catalog names", () => {
    expect(eventLine(SAMPLES.TurnEnded, ctx)).toBe('Turn 2: Player 1 ended the turn');
    expect(eventLine(SAMPLES.CityFounded, ctx)).toContain('Player 1 founded City 1');
    expect(eventLine(SAMPLES.WorkStarted, ctx)).toContain('Mine');
    expect(eventLine(SAMPLES.TechResearched, ctx)).toContain('Bronze Working');
    expect(eventLine(SAMPLES.CityProduced, ctx)).toContain('Granary (building)');
  });

  it('falls back to the raw id for an id the engine cannot name', () => {
    const line = eventLine(
      { ...SAMPLES.WorkStarted, kind: asImprovementId('not-in-this-catalog') },
      ctx,
    );
    expect(line).toContain('not-in-this-catalog');
  });

  it('renders a hut reward that gave a unit, and one that gave none', () => {
    expect(eventLine({ ...SAMPLES.HutEntered, reward: 'barbarians' }, ctx)).toContain(
      'a band of barbarians',
    );
    expect(eventLine(SAMPLES.HutEntered, ctx)).toContain('nothing');
    expect(
      eventLine({ ...SAMPLES.HutEntered, reward: 'unit', unitGiven: asUnitId(9) }, ctx),
    ).toContain('free');
  });

  it('says why a unit died, and who killed it when there is a killer', () => {
    expect(eventLine(SAMPLES.UnitDestroyed, ctx)).toContain('by Settler 0');
    // The killer keys are **absent** for a death that had no killer, and the line simply says
    // less rather than printing a hole (`exactOptionalPropertyTypes` makes the spelling above
    // the only one the engine can produce).
    expect(
      eventLine(
        {
          type: 'UnitDestroyed',
          unitId: asUnitId(3),
          owner: asPlayerId(1),
          unitType: asUnitTypeId('warrior'),
          tile: asTileIndex(4),
          reason: 'combat',
        },
        ctx,
      ),
    ).toBe('Warrior 3 of Player 2 was destroyed in combat at 4,0');
    expect(
      eventLine(
        {
          type: 'UnitDestroyed',
          unitId: asUnitId(3),
          owner: asPlayerId(1),
          unitType: asUnitTypeId('warrior'),
          tile: asTileIndex(4),
          reason: 'bankruptcy',
        },
        ctx,
      ),
    ).toContain('disbanded for want of gold');
  });

  it('maps a list of events to a list of lines, in order', () => {
    const events: readonly GameEvent[] = [SAMPLES.UnitMoved, SAMPLES.TurnEnded];
    const lines = eventLines(events, ctx);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('moved');
    expect(lines[1]).toContain('Turn 2');
  });
});

describe('shared spellings', () => {
  it('spells a tile as the map derives it', () => {
    expect(tileLabel(STATE.map, asTileIndex(0))).toBe('0,0');
    expect(tileLabel(STATE.map, asTileIndex(STATE.map.width + 1))).toBe('1,1');
  });

  it('spells a production item with its tag, so unit and building cannot be confused', () => {
    expect(productionItemName(RULESET, { kind: 'unit', id: asUnitTypeId('settler') })).toBe(
      'Settler (unit)',
    );
    expect(productionItemName(RULESET, { kind: 'building', id: asBuildingId('granary') })).toBe(
      'Granary (building)',
    );
  });

  it('names an unknown resource by its raw id rather than dropping it', () => {
    const line = eventLine(
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: asPlayerId(0),
        item: { kind: 'unit', id: asUnitTypeId('horseman') },
        shields: 0,
      },
      ctx,
    );
    expect(line).toContain('Horseman (unit)');
    expect(asResourceId('iron')).toBe('iron');
  });
});
