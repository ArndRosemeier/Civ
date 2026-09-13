/**
 * M9's government selector: the menu is the engine's catalog, and the verdict is the engine's own
 * planner.
 *
 * The keystone shape at this panel is the same one the rates row and the city screen have: the UI
 * offers the catalog's rows and lets `planSetGovernment` — the evaluator `applyCommand` itself
 * refuses with — decide whether this player may adopt the selected one. So the tests below are about
 * two things and nothing else: that the menu is the catalog (no row invented, no row dropped), and
 * that the sentence a player reads is the engine's own, including the two typed refusals the M9
 * contract names (`unknown-government` for an id no row defines, `government-tech-required` for a
 * prerequisite this player has not researched).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asGovernmentId,
  asPlayerId,
  newGame,
  planSetGovernment,
  governmentCatalog,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { governmentOptions, governmentVerdict } from '../../src/panels/government.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(7, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const STATE: GameState = started.value;
const P0: PlayerId = asPlayerId(0);

describe('governmentOptions', () => {
  it("is the engine's own catalog, in catalog order, with the engine's own names", () => {
    const rows = governmentCatalog(RULESET);
    expect(rows.length, 'the shipped catalog ships no government at all').toBeGreaterThan(0);
    expect(governmentOptions(RULESET).map((option) => option.id)).toEqual(
      rows.map((row) => row.id),
    );
    expect(governmentOptions(RULESET).map((option) => option.name)).toEqual(
      rows.map((row) => row.name),
    );
    // The three the M9 contract asks for, by name, so a catalog that quietly dropped one is a
    // failure here rather than an empty menu nobody notices.
    expect(governmentOptions(RULESET).map((option) => option.id)).toEqual(
      expect.arrayContaining([
        asGovernmentId('despotism'),
        asGovernmentId('monarchy'),
        asGovernmentId('republic'),
      ]),
    );
  });
});

describe('governmentVerdict', () => {
  it('accepts the government the player already holds, which is what the default menu shows', () => {
    const held = STATE.players.find((player) => player.id === P0)?.government;
    expect(held, 'the acting seat has no government in the state').toBeDefined();
    if (held === undefined) return;
    const verdict = governmentVerdict(STATE, RULESET, P0, held);
    expect(verdict.acceptable).toBe(true);
    expect(verdict.note).toContain('the engine accepts');
  });

  it('agrees with the planner on every row of the catalog, in both directions', () => {
    // The panel's verdict IS `planSetGovernment`'s answer, so this can only fail if the panel starts
    // deciding something itself — which is the whole property under test.
    for (const option of governmentOptions(RULESET)) {
      const plan = planSetGovernment(STATE, RULESET, P0, option.id);
      const verdict = governmentVerdict(STATE, RULESET, P0, option.id);
      expect(verdict.acceptable, option.id).toBe(plan.ok);
    }
  });

  it("shows the engine's own refusal for an unknown id, and names the ids it does know", () => {
    const verdict = governmentVerdict(STATE, RULESET, P0, asGovernmentId('senate'));
    expect(verdict.acceptable).toBe(false);
    // The engine's own `kind`, so a reader — and a test — can tell WHICH refusal this is rather
    // than reading a UI paraphrase.
    expect(verdict.note).toContain('unknown-government');
    expect(verdict.note).toContain('senate');
    // …and the ids the engine said it knows, from the error's own `known` list.
    for (const row of governmentCatalog(RULESET)) expect(verdict.note).toContain(row.id);
  });

  it("shows the engine's own refusal for an unmet prerequisite, and names the tech", () => {
    // Monarchy sits behind a tech in the shipped catalog (M9's `requiresTech`), so this is the
    // reachable case in a real opening: a player may not become a monarchy on turn 1.
    const plan = planSetGovernment(STATE, RULESET, P0, asGovernmentId('monarchy'));
    expect(plan.ok, 'the shipped catalog lets a player adopt monarchy on turn 1').toBe(false);
    const verdict = governmentVerdict(STATE, RULESET, P0, asGovernmentId('monarchy'));
    expect(verdict.acceptable).toBe(false);
    expect(verdict.note).toContain('government-tech-required');
    expect(verdict.note).toContain('Monarchy');
  });

  it('accepts a gated government once the engine says the tech is known', () => {
    // The gated row becomes adoptable through the ENGINE, not through a UI flag: the state is
    // rewritten with the tech known and the same planner then accepts it.
    const tech = validated.value.governments.find(
      (row) => row.id === asGovernmentId('monarchy'),
    )?.requiresTech;
    expect(
      tech,
      'the monarchy row declares no prerequisite, so this case proves nothing',
    ).toBeDefined();
    if (tech === undefined) return;
    const learned: GameState = {
      ...STATE,
      players: STATE.players.map((player) =>
        player.id === P0 ? { ...player, techs: [...player.techs, tech] } : player,
      ),
    };
    const verdict = governmentVerdict(learned, RULESET, P0, asGovernmentId('monarchy'));
    expect(verdict.acceptable).toBe(true);
    expect(verdict.note).toContain('the engine accepts Monarchy as your government');
  });

  it('is answered by the engine the control dispatches through', () => {
    // The command the control would dispatch is accepted exactly when the verdict says so — the
    // property that makes a disabled control honest rather than decorative.
    const accepted = governmentVerdict(STATE, RULESET, P0, asGovernmentId('despotism'));
    expect(accepted.acceptable).toBe(true);
    const applied = applyCommand(
      STATE,
      P0,
      { type: 'SetGovernment', government: asGovernmentId('despotism') },
      RULESET,
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.state.players.find((player) => player.id === P0)?.government).toBe(
        asGovernmentId('despotism'),
      );
    }

    const refused = governmentVerdict(STATE, RULESET, P0, asGovernmentId('senate'));
    expect(refused.acceptable).toBe(false);
    const appliedBad = applyCommand(
      STATE,
      P0,
      { type: 'SetGovernment', government: asGovernmentId('senate') },
      RULESET,
    );
    expect(appliedBad.ok).toBe(false);
    if (!appliedBad.ok) expect(appliedBad.error.kind).toBe('unknown-government');
  });
});
