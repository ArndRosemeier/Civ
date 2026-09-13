/**
 * Tech-tree classification and research selection.
 *
 * The property under test is that the panel's three states come from the engine and not from a
 * rule invented here: `known` is `knowsTech`, `available` is "`researchProblem` says nothing",
 * and a row the screen enables is exactly a row `planSetResearch` accepts. The last of those is
 * the keystone shape at this panel — **a control the UI offers must be an action the engine
 * accepts** — so the enabled rows are swept through `applyCommand` as well as through the
 * planner.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asPlayerId,
  asTechId,
  newGame,
  planSetResearch,
  researchProblem,
  type GameState,
  type PlayerId,
  type PlayerState,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { classifyTech, researchStatus, techRows } from '../../src/panels/techtree.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(7, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const STATE: GameState = started.value;

const P0 = asPlayerId(0);
const POTTERY = asTechId('pottery');
const ALPHABET = asTechId('alphabet');

/** The player with `techs` replaced — the state a game reaches by researching. */
const withTechs = (state: GameState, playerId: PlayerId, techs: readonly string[]): GameState => ({
  ...state,
  players: state.players.map((player): PlayerState =>
    player.id === playerId ? { ...player, techs: techs.map((id) => asTechId(id)) } : player,
  ),
});

const playerOf = (state: GameState, playerId: PlayerId): PlayerState => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error('the state has no such player');
  return player;
};

describe('classifyTech', () => {
  it('calls a root tech available to a player who knows nothing', () => {
    expect(classifyTech(RULESET, playerOf(STATE, P0), POTTERY)).toBe('available');
    expect(researchProblem(RULESET, playerOf(STATE, P0), POTTERY)).toBeUndefined();
  });

  it('calls a tech with unmet prerequisites locked, and the engine names them', () => {
    const player = playerOf(STATE, P0);
    expect(classifyTech(RULESET, player, ALPHABET)).toBe('locked');
    const problem = researchProblem(RULESET, player, ALPHABET);
    if (problem === undefined || problem.kind !== 'unmet-prerequisite') {
      throw new Error('expected an unmet-prerequisite refusal');
    }
    expect(problem.missing).toEqual([POTTERY]);
  });

  it('calls a researched tech known, which unlocks what it gated', () => {
    const learned = withTechs(STATE, P0, ['pottery']);
    const player = playerOf(learned, P0);
    expect(classifyTech(RULESET, player, POTTERY)).toBe('known');
    expect(classifyTech(RULESET, player, ALPHABET)).toBe('available');
  });

  it('treats the same tech differently for two players, because knowledge is per player', () => {
    const learned = withTechs(STATE, P0, ['pottery']);
    expect(classifyTech(RULESET, playerOf(learned, P0), POTTERY)).toBe('known');
    expect(classifyTech(RULESET, playerOf(learned, asPlayerId(1)), POTTERY)).toBe('available');
  });
});

describe('techRows', () => {
  const rows = techRows(STATE, RULESET, P0);

  it('lists the engine catalog, one row per tech, in catalog order', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.id)).toEqual(techRows(STATE, RULESET, P0).map((row) => row.id));
    expect(rows[0]?.id).toBe(POTTERY);
  });

  it('agrees with the planner about which rows the screen may enable', () => {
    for (const row of rows) {
      expect(row.selectable).toBe(planSetResearch(STATE, RULESET, P0, row.id).ok);
    }
  });

  it('never enables a row the applier would refuse, and every enabled row applies', () => {
    const enabled = rows.filter((row) => row.selectable);
    expect(enabled.length).toBeGreaterThan(0);
    for (const row of enabled) {
      const applied = applyCommand(STATE, P0, { type: 'SetResearch', tech: row.id }, RULESET);
      expect(applied.ok, `SetResearch ${row.id} was refused`).toBe(true);
      if (applied.ok) expect(applied.value.state.revision).toBe(STATE.revision + 1);
    }
  });

  it('carries the cost and the era straight off the catalog row', () => {
    const pottery = rows.find((row) => row.id === POTTERY);
    expect(pottery?.cost).toBe(5);
    expect(pottery?.era).toBe('ancient');
    expect(pottery?.state).toBe('available');
  });

  it('marks the tech being researched, and only that one', () => {
    const researching: GameState = {
      ...STATE,
      players: STATE.players.map((player) =>
        player.id === P0 ? { ...player, researching: ALPHABET } : player,
      ),
    };
    const marked = techRows(withTechs(researching, P0, ['pottery']), RULESET, P0).filter(
      (row) => row.researching,
    );
    expect(marked.map((row) => row.id)).toEqual([ALPHABET]);
  });

  it('returns nothing for a player the state does not define', () => {
    expect(techRows(STATE, RULESET, asPlayerId(99))).toEqual([]);
  });
});

describe('researchStatus', () => {
  it("says nothing is being researched, with the state's own beaker pool", () => {
    const status = researchStatus(STATE, RULESET, P0);
    expect(status.name).toBeUndefined();
    expect(status.note).toBe('nothing is being researched');
    expect(status.beakers).toBe(0);
  });

  it('names the tech in progress once one is selected', () => {
    const applied = applyCommand(STATE, P0, { type: 'SetResearch', tech: POTTERY }, RULESET);
    if (!applied.ok) throw new Error('selecting a root tech was refused');
    const status = researchStatus(applied.value.state, RULESET, P0);
    expect(status.name).toBe('Pottery');
    expect(status.beakers).toBe(0);
  });
});
