/**
 * M10's victory / defeat screen: the outcome is DERIVED, and the screen only renders it.
 *
 * Every assertion below is against the engine's own `outcomeFor` / `gameOutcomeOf` / `isGameOver`,
 * never against a value this file computed. Two properties matter, and both are the contract's:
 * the screen names the condition and the winner the ENGINE decided, and the game it describes is a
 * game that genuinely refuses further commands — a victory screen over a board that keeps playing
 * would be a picture rather than an end.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asGovernmentId,
  asPlayerId,
  asTechId,
  asUnitId,
  isGameOver,
  newGame,
  outcomeFor,
  scoreHorizon,
  victoryRulesOf,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { outcomeFacts } from '../../src/panels/victory.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(3, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const OPENING: GameState = started.value;
const P0: PlayerId = asPlayerId(0);
const P1: PlayerId = asPlayerId(1);

const foundCity = (state: GameState, tileOwnerPlayer: PlayerId): GameState => {
  const settler = state.units.find(
    (unit) => unit.owner === tileOwnerPlayer && unit.type === 'settler',
  );
  if (settler === undefined) throw new Error('the seat has no settler to found with');
  const founded = applyCommand(
    state,
    tileOwnerPlayer,
    { type: 'FoundCity', unitId: settler.id },
    RULESET,
  );
  if (!founded.ok) throw new Error(`founding a city was refused: ${founded.error.kind}`);
  return founded.value.state;
};

describe('outcomeFacts', () => {
  it('answers nothing while the game is still being played', () => {
    expect(outcomeFacts(OPENING, RULESET, P0)).toBeUndefined();
    expect(isGameOver(OPENING, RULESET), 'a fresh game is already over').toBe(false);
    // …and it is not vacuous in the other direction: the position below really is a finished game.
    expect(isGameOver(atTheScoreHorizon(), RULESET)).toBe(true);
  });

  it('names the condition, the turn and the winner the ENGINE decided', () => {
    const finished = atTheScoreHorizon();
    const outcome = outcomeFor(finished, RULESET, P0);
    expect(outcome, 'the engine reports no outcome at its own score horizon').toBeDefined();
    if (outcome === undefined) return;

    const facts = outcomeFacts(finished, RULESET, P0);
    expect(facts).toBeDefined();
    if (facts === undefined) return;
    expect(facts.condition).toBe(outcome.condition);
    expect(facts.turn).toBe(outcome.turn);
    expect(facts.winner).toBe(outcome.winner);
    expect(facts.kind).toBe(outcome.kind);
    // The condition is the engine's own id, spelled verbatim rather than renamed by a table here.
    expect(facts.detail).toContain(`"${outcome.condition}"`);
    expect(facts.detail).toContain(`turn ${String(outcome.turn)}`);
  });

  it('is relative to the seat watching: the winner sees a victory and the loser a defeat', () => {
    const finished = atTheScoreHorizon();
    const outcome = outcomeFor(finished, RULESET, P0);
    expect(outcome?.winner).toBe(P0);
    const mine = outcomeFacts(finished, RULESET, P0);
    const theirs = outcomeFacts(finished, RULESET, P1);
    expect(mine?.kind).toBe('victory');
    expect(mine?.headline).toBe('Victory');
    expect(theirs?.kind).toBe('defeat');
    expect(theirs?.headline).toBe('Defeat');
    // The same winner is named on both screens — the outcome is one engine value, read relatively.
    expect(theirs?.winner).toBe(P0);
    expect(mine?.detail).toContain('Player 1 won');
    expect(theirs?.detail).toContain('Player 1 won');
  });

  it('says so plainly when nobody won, rather than inventing a name', () => {
    // The engine's `winner: null` is reachable: the score condition finds no winner in a world with
    // no civilization at all. The screen must render that as "nobody won" — a draw is a real
    // outcome, and printing `null` or "player undefined" would be the blank-line bug wearing a hat.
    const barbariansOnly: GameState = {
      ...atTheScoreHorizon(),
      players: atTheScoreHorizon().players.filter((player) => player.kind === 'barbarian'),
    };
    const outcome = outcomeFor(barbariansOnly, RULESET, P0);
    expect(outcome?.winner).toBeNull();
    const facts = outcomeFacts(barbariansOnly, RULESET, P0);
    expect(facts?.kind).toBe('draw');
    expect(facts?.headline).toBe('Draw');
    expect(facts?.detail).toContain('nobody won');
    expect(facts?.detail).not.toContain('undefined');
    expect(facts?.detail).not.toContain('null');
  });

  it('reports a cultural victory at the catalog’s own threshold', () => {
    // The condition is decided by `playerCulture` against the catalog's number, so this builds the
    // board the rule is stated over and lets the engine answer.
    const founded = foundCity(OPENING, P0);
    const city = founded.cities[0];
    expect(city, 'the seat founded no city').toBeDefined();
    if (city === undefined) return;
    // The threshold is read through the ENGINE's own reader (`victoryRulesOf`), not off the view,
    // so this case is stated over the catalog's number rather than over a field's shape.
    const threshold = victoryRulesOf(RULESET).culturalVictoryCulture;
    expect(threshold, 'the shipped catalog declares no cultural threshold').toBeGreaterThan(0);

    const grown: GameState = {
      ...founded,
      cities: founded.cities.map((candidate) =>
        candidate.id === city.id ? { ...candidate, culture: threshold } : candidate,
      ),
    };
    const facts = outcomeFacts(grown, RULESET, P0);
    expect(facts?.condition).toBe('cultural');
    expect(facts?.winner).toBe(P0);
    expect(facts?.kind).toBe('victory');
  });

  it('describes a game the engine genuinely refuses to keep playing', () => {
    // The reason the rest of the UI closes its controls: on a finished game `applyCommand` answers
    // `game-over` before it even looks at the command. If this ever stopped holding, a victory
    // screen would be painted over a game that was still being played.
    const finished = atTheScoreHorizon();
    const unit = finished.units.find((candidate) => candidate.owner === P0);
    expect(unit, 'the seat has no unit to name in a command').toBeDefined();
    const commands = [
      { type: 'SetGovernment', government: asGovernmentId('despotism') },
      { type: 'SetRates', rates: { tax: 1, science: 1, luxury: 1 } },
      { type: 'SetResearch', tech: asTechId('bronze-working') },
      { type: 'FortifyUnit', unitId: unit?.id ?? asUnitId(0) },
    ] as const;
    for (const command of commands) {
      const refused = applyCommand(finished, P0, command, RULESET);
      expect(refused.ok, `${command.type} was accepted on a finished game`).toBe(false);
      if (!refused.ok) expect(refused.error.kind, command.type).toBe('game-over');
    }

    // `EndTurn` is the engine's own deliberate exception — `commands.ts`' gate exempts it so a
    // runner cannot hang on the turn the game finished — and the engine therefore still accepts it.
    // The victory screen closes that control anyway (see `main.ts`): the M10 contract's sentence is
    // that a finished game must not keep playing behind the screen, and advancing the turn counter
    // of a decided game is exactly that. The control is disabled, not the command hidden — the seam
    // still dispatches it, and a test can still prove the engine's answer is `'ok'`.
    const ended = applyCommand(finished, P0, { type: 'EndTurn' }, RULESET);
    expect(ended.ok, 'the engine stopped exempting EndTurn').toBe(true);
  });

  it('answers nothing for a seat the state does not define only when the game is still running', () => {
    // A seat the state does not hold is not a special case: while the game runs there is no outcome
    // for anybody, and once it has ended the outcome is reported relative to whoever asked.
    expect(outcomeFacts(OPENING, RULESET, asPlayerId(99))).toBeUndefined();
    const finished = atTheScoreHorizon();
    const facts = outcomeFacts(finished, RULESET, asPlayerId(99));
    expect(facts?.kind).toBe('defeat');
    expect(facts?.winner).toBe(P0);
  });
});

/** The engine's own opening at the turn its score condition fires on — a real, finished game. */
function atTheScoreHorizon(): GameState {
  const horizon = scoreHorizon(RULESET);
  expect(horizon).toBeGreaterThan(1);
  return { ...OPENING, turn: horizon };
}

describe('the seat a fresh game is played as', () => {
  it('exists, so the cases above are about a real board', () => {
    expect(OPENING.units.some((unit) => unit.owner === P0)).toBe(true);
    expect(asUnitId(0)).toBe(0);
  });
});
