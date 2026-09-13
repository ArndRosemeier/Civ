/**
 * The status strip and the scoreboard: every displayed figure is a read of the state.
 *
 * There is no score in the engine (M10 owns scoring, and nothing in `@civts/core` ranks
 * players), so the assertions here are deliberately about *reads*: the treasury a player holds,
 * the population summed over its cities, the turn and the year the panel derives from it. If a
 * points formula ever appears in this panel, these tests do not need to change — but the
 * golden-hash and headless-equality tests would, which is the point: a scoring rule belongs in
 * the engine where it can be hashed, tested and agreed with.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asCityId,
  asPlayerId,
  asUnitId,
  newGame,
  type GameState,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { formatYear, statusFacts } from '../../src/panels/index.js';
import { civilizationRows, scoreboardRows } from '../../src/panels/scoreboard.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(5, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const STATE: GameState = started.value;
const P0 = asPlayerId(0);

describe('statusFacts', () => {
  it('names the five contractual status elements, in order', () => {
    expect(statusFacts(STATE, P0).map((fact) => fact.name)).toEqual([
      'Turn',
      'Year',
      'Treasury',
      'Science',
      'Luxury',
    ]);
  });

  it('spells the turn indicator so its text contains `Turn <n>`', () => {
    const turn = statusFacts(STATE, P0).find((fact) => fact.name === 'Turn');
    expect(turn?.text).toBe('Turn 1');
    expect(turn?.text).toMatch(/Turn \d+/);
  });

  it('reads the treasury, beakers and luxuries off the player', () => {
    const facts = statusFacts(STATE, P0);
    const value = (name: string): string =>
      facts.find((fact) => fact.name === name)?.text ?? 'missing';
    expect(value('Treasury')).toBe('Treasury 10 gold');
    expect(value('Science')).toBe('Science 0 beakers');
    expect(value('Luxury')).toBe('Luxury 0 luxuries');
  });

  it('says out loud that luxuries do nothing yet, rather than implying a mechanic', () => {
    const luxury = statusFacts(STATE, P0).find((fact) => fact.name === 'Luxury');
    expect(luxury?.title).toContain('M9');
    const year = statusFacts(STATE, P0).find((fact) => fact.name === 'Year');
    expect(year?.title).toContain('no calendar');
  });

  it('follows the turn counter after a turn is ended', () => {
    const ended = applyCommand(STATE, P0, { type: 'EndTurn' }, RULESET);
    if (!ended.ok) throw new Error('ending the first turn was refused');
    expect(statusFacts(ended.value.state, P0).find((fact) => fact.name === 'Turn')?.text).toBe(
      'Turn 2',
    );
  });

  it('answers zeros for a player the state does not define rather than throwing', () => {
    const facts = statusFacts(STATE, asPlayerId(99));
    expect(facts.find((fact) => fact.name === 'Treasury')?.text).toBe('Treasury 0 gold');
  });
});

describe('formatYear', () => {
  it('starts at 4000 BC and steps 20 years a turn, in integers', () => {
    expect(formatYear(1)).toBe('4000 BC');
    expect(formatYear(2)).toBe('3980 BC');
    expect(formatYear(200)).toBe('20 BC');
    expect(formatYear(201)).toBe('1 AD');
    expect(formatYear(202)).toBe('20 AD');
  });

  it('is total for nonsense input rather than printing NaN', () => {
    expect(formatYear(0)).toBe('4000 BC');
    expect(formatYear(-5)).toBe('4000 BC');
    expect(formatYear(2.7)).toBe('3980 BC');
    expect(formatYear(Number.NaN)).toBe('4000 BC');
    expect(formatYear(Number.POSITIVE_INFINITY)).toBe('4000 BC');
  });
});

describe('scoreboardRows', () => {
  it('lists every player in player-id order, barbarians included', () => {
    const rows = scoreboardRows(STATE);
    expect(rows.map((row) => row.player)).toEqual(['Player 1', 'Player 2', 'Barbarians']);
    expect(rows.map((row) => row.kind)).toEqual(['civ', 'civ', 'barbarian']);
  });

  it("counts the state's units and cities per player", () => {
    const rows = scoreboardRows(STATE);
    expect(rows[0]?.units).toBe(2);
    expect(rows[1]?.units).toBe(2);
    expect(rows[2]?.units).toBe(0);
    expect(rows.map((row) => row.cities)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.population)).toEqual([0, 0, 0]);
  });

  it('shows the treasury the state holds, including the barbarian zero', () => {
    expect(scoreboardRows(STATE).map((row) => row.treasury)).toEqual([10, 10, 0]);
  });

  it("sums population over a player's cities once one exists", () => {
    const founded = applyCommand(STATE, P0, { type: 'FoundCity', unitId: asUnitId(0) }, RULESET);
    if (!founded.ok) throw new Error('founding the first city was refused');
    const rows = scoreboardRows(founded.value.state);
    expect(rows[0]?.cities).toBe(1);
    expect(rows[0]?.population).toBe(1);
    expect(rows[1]?.cities).toBe(0);
    expect(asCityId(0)).toBe(founded.value.state.cities[0]?.id);
  });

  it('marks the civilizations only when asked for the civilization rows', () => {
    expect(civilizationRows(STATE).map((row) => row.player)).toEqual(['Player 1', 'Player 2']);
  });
});
