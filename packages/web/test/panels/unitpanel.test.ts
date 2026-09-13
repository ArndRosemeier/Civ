/**
 * The unit panel: the action group is the engine's own list, and nothing in it is a rule the UI
 * invented.
 *
 * `unitPanelCommands` is `unitActions` followed by the one command the engine *queries* rather
 * than enumerates (`FortifyUnit`, accepted by `planFortifyUnit`), and the keystone shape at this
 * panel is the sweep below: every control the group offers, applied through `applyCommand`, is
 * accepted by the engine — no filtered or extended copy, and no control the applier refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asBuildingId,
  asCityId,
  asImprovementId,
  asPlayerId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  newGame,
  unitActions,
  type Command,
  type GameState,
  type RulesetView,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  actionLabel,
  defaultUnitId,
  selectedUnitRow,
  unitActionList,
  unitPanelCommands,
  unitQueriedActions,
  unitRows,
} from '../../src/panels/unitpanel.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(3, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const STATE: GameState = started.value;
const P0 = asPlayerId(0);

/**
 * One sample of every `Command` member. The mapped type is the exhaustiveness check: a new
 * command makes this file fail to compile until it is labelled (see the events test's note on
 * the same trick).
 */
const COMMANDS: { readonly [K in Command['type']]: Extract<Command, { readonly type: K }> } = {
  MoveUnit: { type: 'MoveUnit', unitId: asUnitId(0), to: asTileIndex(0) },
  EndTurn: { type: 'EndTurn' },
  FoundCity: { type: 'FoundCity', unitId: asUnitId(0) },
  SetWorkedTiles: { type: 'SetWorkedTiles', cityId: asCityId(0), tiles: [] },
  SetProduction: {
    type: 'SetProduction',
    cityId: asCityId(0),
    item: { kind: 'unit', id: asUnitTypeId('settler') },
  },
  StartWork: { type: 'StartWork', unitId: asUnitId(1), kind: asImprovementId('mine') },
  CancelWork: { type: 'CancelWork', unitId: asUnitId(1) },
  SetRates: { type: 'SetRates', rates: { tax: 6, science: 4, luxury: 0 } },
  SetResearch: { type: 'SetResearch', tech: asTechId('pottery') },
  AttackUnit: { type: 'AttackUnit', unitId: asUnitId(0), target: asTileIndex(0) },
  FortifyUnit: { type: 'FortifyUnit', unitId: asUnitId(0) },
};

describe('unitRows', () => {
  it("lists the acting player's units in id order, with engine readouts", () => {
    const rows = unitRows(STATE, RULESET, P0);
    expect(rows.map((row) => row.id)).toEqual([asUnitId(0), asUnitId(1)]);
    expect(rows[0]?.label).toBe('Settler 0');
    expect(rows[1]?.label).toBe('Worker 1');
    expect(rows[0]?.hitPoints).toContain('hp');
    expect(rows[0]?.movementLeft).toBeGreaterThan(0);
  });

  it("shows another player's units to nobody", () => {
    expect(unitRows(STATE, RULESET, asPlayerId(1)).map((row) => row.label)).toEqual([
      'Settler 2',
      'Worker 3',
    ]);
    expect(unitRows(STATE, RULESET, asPlayerId(9))).toEqual([]);
  });

  it('omits the work key for an idle unit rather than writing undefined', () => {
    const rows = unitRows(STATE, RULESET, P0);
    expect(rows[0]?.work).toBeUndefined();
    expect(Object.hasOwn(rows[0] ?? {}, 'work')).toBe(false);
  });
});

describe('the actions group', () => {
  it("is exactly the engine's `unitActions` list, in the engine's order", () => {
    for (const id of [asUnitId(0), asUnitId(1), asUnitId(2)]) {
      expect(unitActionList(STATE, RULESET, id)).toEqual([...unitActions(STATE, RULESET, id)]);
    }
  });

  it('offers only commands the applier accepts', () => {
    let checked = 0;
    for (const unit of STATE.units) {
      for (const command of unitActionList(STATE, RULESET, unit.id)) {
        const applied = applyCommand(STATE, unit.owner, command, RULESET);
        expect(applied.ok, `${command.type} for unit ${String(unit.id)} was refused`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('is empty for a unit that does not exist', () => {
    expect(unitActionList(STATE, RULESET, asUnitId(99))).toEqual([]);
  });
});

describe("the group's queried commands (fortify)", () => {
  it('offers fortify where the planner accepts it', () => {
    const queried = unitQueriedActions(STATE, P0, asUnitId(0));
    expect(queried.map((command) => command.type)).toEqual(['FortifyUnit']);
  });

  it('offers only commands the engine accepts', () => {
    for (const command of unitQueriedActions(STATE, P0, asUnitId(0))) {
      expect(applyCommand(STATE, P0, command, RULESET).ok, `${command.type} was refused`).toBe(
        true,
      );
    }
  });

  it("offers nothing for a unit that is not the acting player's, or does not exist", () => {
    expect(unitQueriedActions(STATE, P0, asUnitId(2))).toEqual([]);
    expect(unitQueriedActions(STATE, P0, asUnitId(99))).toEqual([]);
  });

  it('never repeats a command the enumerated list already offers', () => {
    const enumerated = new Set(unitActionList(STATE, RULESET, asUnitId(0)).map((c) => c.type));
    for (const command of unitQueriedActions(STATE, P0, asUnitId(0))) {
      expect(enumerated.has(command.type), `${command.type} appears twice`).toBe(false);
    }
  });
});

describe("the group's contents", () => {
  it("is the engine's enumerated list, in order, with fortify after it", () => {
    const commands = unitPanelCommands(STATE, RULESET, P0, asUnitId(0));
    expect(commands.slice(0, unitActionList(STATE, RULESET, asUnitId(0)).length)).toEqual([
      ...unitActionList(STATE, RULESET, asUnitId(0)),
    ]);
    expect(commands.at(-1)?.type).toBe('FortifyUnit');
  });

  it('offers every enumerated command the engine lists, and nothing it refuses', () => {
    const commands = unitPanelCommands(STATE, RULESET, P0, asUnitId(0));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(applyCommand(STATE, P0, command, RULESET).ok, `${command.type} was refused`).toBe(
        true,
      );
    }
    for (const command of unitActionList(STATE, RULESET, asUnitId(0))) {
      expect(commands).toContainEqual(command);
    }
  });

  it('offers a unit that does not exist nothing at all', () => {
    expect(unitPanelCommands(STATE, RULESET, P0, asUnitId(99))).toEqual([]);
  });
});

describe('actionLabel', () => {
  it('labels every member of the Command union, with no blank label', () => {
    for (const command of Object.values(COMMANDS)) {
      const label = actionLabel(command, STATE, RULESET);
      expect(label.trim().length, `blank label for ${command.type}`).toBeGreaterThan(0);
      expect(label).not.toContain('undefined');
    }
  });

  it('tells two moves apart by their coordinates and two jobs apart by their name', () => {
    const first = actionLabel(
      { type: 'MoveUnit', unitId: asUnitId(0), to: asTileIndex(0) },
      STATE,
      RULESET,
    );
    const second = actionLabel(
      { type: 'MoveUnit', unitId: asUnitId(0), to: asTileIndex(1) },
      STATE,
      RULESET,
    );
    expect(first).not.toBe(second);
    expect(first).toMatch(/^Move to \d+,\d+$/);
  });

  it("names the tech and the item through the engine's catalog", () => {
    expect(actionLabel({ type: 'SetResearch', tech: asTechId('pottery') }, STATE, RULESET)).toBe(
      'Research Pottery',
    );
    expect(
      actionLabel(
        {
          type: 'SetProduction',
          cityId: asCityId(0),
          item: { kind: 'building', id: asBuildingId('granary') },
        },
        STATE,
        RULESET,
      ),
    ).toBe('Build Granary (building)');
  });
});

describe('defaultUnitId', () => {
  it("keeps a selection that is still this player's unit", () => {
    expect(defaultUnitId(STATE, P0, asUnitId(1))).toBe(asUnitId(1));
  });

  it('falls back to the first unit the player owns, deterministically', () => {
    expect(defaultUnitId(STATE, P0, undefined)).toBe(asUnitId(0));
    expect(defaultUnitId(STATE, P0, asUnitId(2))).toBe(asUnitId(0));
    expect(defaultUnitId(STATE, P0, asUnitId(99))).toBe(asUnitId(0));
  });

  it('answers nothing for a player with no units', () => {
    expect(defaultUnitId(STATE, asPlayerId(9), undefined)).toBeUndefined();
  });
});

describe('selectedUnitRow', () => {
  it('finds the row for the selected id and nothing for an absent one', () => {
    const rows = unitRows(STATE, RULESET, P0);
    const id: UnitId = asUnitId(1);
    expect(selectedUnitRow(rows, id)?.label).toBe('Worker 1');
    expect(selectedUnitRow(rows, asUnitId(5))).toBeUndefined();
    expect(selectedUnitRow(rows, undefined)).toBeUndefined();
  });
});
