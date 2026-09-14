/**
 * `ui/hover.ts` — the hover readout, on real boards and without a browser.
 *
 * The brief for this phase names the trap twice: **the readout must not become a second statement of
 * the rules.** So the assertions here are written to fail if it ever does, and they are of three
 * kinds:
 *
 * 1. **Equality with the engine's own answer**, asked a *different* way where one exists. The
 *    movement figure is compared against a move the test actually makes (the engine's own state
 *    transition), not against `planMove` called twice; the yield figures are compared against the
 *    terrain row for a tile with no improvements on it.
 * 2. **The property that matters for combat**: the number the hover shows is the number the engine
 *    reports when the attack is really made (`CombatResolved.attackerWinPct`). A preview that
 *    disagrees with `applyCommand` is the defect class this whole project is arranged against.
 * 3. **Behaviour the readout must NOT have**: no odds for an attack the engine does not offer, no
 *    name for a unit the player cannot see, nothing at all about unexplored ground, and **no change
 *    to the state or the RNG** — the combat figure is obtained by folding `applyCommand` on a copy,
 *    and a fold that leaked would be a preview that plays the game.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitId,
  DEFAULT_SETTINGS,
  improvementsAt,
  indexToX,
  indexToY,
  isExplored,
  neighbors8,
  newGame,
  planMove,
  planRoute,
  spawnUnit,
  tileYields,
  unitActions,
  unitCatalog,
  visibleTiles,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RulesetView,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

import { hoverReadout, readoutText } from '../../src/ui/hover.js';
import { problemText } from '../../src/ui/problem.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const SEED = 7;

const startOf = (seed = SEED): GameState => {
  const started = newGame(
    seed,
    { ...DEFAULT_SETTINGS, seed, mapSize: 'tiny', civCount: 2 },
    RULESET,
  );
  if (!started.ok) throw new Error('newGame refused the fixture seed');
  return started.value;
};

const STATE = startOf();
const SEAT: PlayerId = STATE.players[0]?.id ?? asPlayerId(0);
const RIVAL: PlayerId = STATE.players[1]?.id ?? asPlayerId(1);

const unitOf = (state: GameState, id: UnitId): GameState['units'][number] => {
  const unit = state.units.find((each) => each.id === id);
  if (unit === undefined) throw new Error(`no unit ${String(id)}`);
  return unit;
};

const defOf = (type: string): ReturnType<typeof unitCatalog>[number] => {
  const def = unitCatalog(RULESET).find((candidate) => candidate.id === type);
  if (def === undefined) throw new Error(`the ruleset has no unit type ${type}`);
  return def;
};

const apply = (state: GameState, seat: PlayerId, command: Command): GameState => {
  const outcome = applyCommand(state, seat, command, RULESET);
  if (!outcome.ok) {
    throw new Error(`the engine refused ${command.type}: ${JSON.stringify(outcome.error)}`);
  }
  return outcome.value.state;
};

const eventOf = <T extends GameEvent['type']>(
  state: GameState,
  seat: PlayerId,
  command: Command,
  type: T,
): Extract<GameEvent, { type: T }> | undefined => {
  const outcome = applyCommand(state, seat, command, RULESET);
  if (!outcome.ok) throw new Error(`the engine refused ${command.type}`);
  return outcome.value.events.find(
    (event): event is Extract<GameEvent, { type: T }> => event.type === type,
  );
};

const settlerOf = (state: GameState): GameState['units'][number] =>
  unitOf(
    state,
    state.units.find((unit) => unit.owner === SEAT && unit.type === 'settler')?.id ?? asUnitId(-1),
  );

/**
 * The board the combat cases are played on: an archer and a warrior of the human's, beside a rival
 * warrior, on ground the human can see.
 *
 * Every unit is created by the engine's own `spawnUnit` and every legality question below is asked
 * of the engine, so nothing here invents a statistic or a rule — the fixture only decides *where*
 * things stand, which `spawnUnit` says outright is the caller's business. The two human units have
 * deliberately different attack strengths (1 and 3), which is what makes the odds a *function* of
 * the attacker rather than a constant the test could be fooled by.
 */
const combatBoard = (): {
  readonly state: GameState;
  readonly archer: UnitId;
  readonly warrior: UnitId;
  readonly defender: UnitId;
  readonly tile: TileIndex;
} => {
  const settler = settlerOf(STATE);
  const archer = spawnUnit(STATE, defOf('archer'), SEAT, settler.tile);
  const warrior = spawnUnit(archer.state, defOf('warrior'), SEAT, settler.tile);
  // A neighbour of the settler that carries no unit, so the target tile is unambiguously the
  // rival's: a stack would make "which defender?" a question the readout must not have to answer.
  const free = neighbors8(warrior.state.map, settler.tile).find(
    (tile) => !warrior.state.units.some((unit) => unit.tile === tile),
  );
  if (free === undefined) throw new Error('the fixture settler has no empty neighbour');
  const defender = spawnUnit(warrior.state, defOf('warrior'), RIVAL, free);
  return {
    state: defender.state,
    archer: archer.unit.id,
    warrior: warrior.unit.id,
    defender: defender.unit.id,
    tile: free,
  };
};

const BOARD = combatBoard();

/** The engine's own offered attack for a unit, or a loud failure so a case cannot be vacuous. */
const offeredAttack = (state: GameState, unitId: UnitId, tile: TileIndex): Command => {
  const command = unitActions(state, RULESET, unitId).find(
    (candidate) => candidate.type === 'AttackUnit' && candidate.target === tile,
  );
  if (command === undefined) {
    throw new Error(`the engine offers unit ${String(unitId)} no attack on tile ${String(tile)}`);
  }
  return command;
};

describe('the readout prints the engine’s yields, and nothing about ground the player has not seen', () => {
  it('names the terrain and the engine’s own three yield figures', () => {
    const settler = settlerOf(STATE);
    const readout = hoverReadout(STATE, RULESET, SEAT, settler.id, settler.tile);
    const engine = tileYields(STATE, RULESET, settler.tile);
    const terrain = RULESET.terrains.find((def) => def.id === STATE.map.terrain[settler.tile]);
    expect(engine, 'the fixture tile has no yields to compare against').toBeDefined();
    expect(readout.yields, 'the readout reported no yields for a known tile').toEqual(engine);
    // The independent half: with no improvement on the tile, the engine's answer IS the terrain
    // row, read from the ruleset rather than from `tileYields` a second time.
    expect(
      improvementsAt(STATE, settler.tile),
      'the fixture tile carries an improvement, so the comparison above is about improvements too',
    ).toEqual([]);
    expect(readout.yields).toEqual(terrain?.yields);
    expect(readout.terrain).toBe(terrain?.name);
    expect(readout.x).toBe(indexToX(STATE.map, settler.tile));
    expect(readout.y).toBe(indexToY(STATE.map, settler.tile));
    expect(readoutText(readout), 'the sentence does not name what the tile yields').toContain(
      'food',
    );
  });

  it('says nothing at all about an unexplored tile — the §7.8 leak, in a tooltip', () => {
    const hidden = STATE.units.find((unit) => unit.owner === RIVAL);
    expect(hidden, 'the fixture board has no rival unit').toBeDefined();
    if (hidden === undefined) return;
    // The vacuity guard: the state really does know where this unit is. The readout is entitled to
    // that knowledge only when the player can see the ground, and at the opening it cannot.
    expect(
      isExplored(STATE, SEAT, hidden.tile),
      'the fixture rival stands on explored ground, so this case is not about the fog',
    ).toBe(false);

    const readout = hoverReadout(STATE, RULESET, SEAT, settlerOf(STATE).id, hidden.tile);
    expect(readout.known).toBe(false);
    expect(readout.yields, 'an unexplored tile yielded something').toBeUndefined();
    expect(readout.terrain, 'an unexplored tile named its terrain').toBeUndefined();
    expect(readout.occupant, 'the readout named a rival the player cannot see').toBeUndefined();
    expect(readoutText(readout)).toContain('unexplored');
  });

  it('names a rival it can see, and calls it a rival', () => {
    const readout = hoverReadout(BOARD.state, RULESET, SEAT, BOARD.archer, BOARD.tile);
    expect(visibleTiles(BOARD.state, SEAT).some((tile) => tile === BOARD.tile)).toBe(true);
    expect(readout.occupant, 'the readout did not name a rival standing in plain sight').toContain(
      'rival',
    );
    expect(readout.occupant).toContain(defOf('warrior').name);
  });
});

describe('the movement figure is what a move actually costs', () => {
  it('matches the movement the engine really spends', () => {
    const settler = settlerOf(STATE);
    const destination = unitActions(STATE, RULESET, settler.id)
      .map((command) => (command.type === 'MoveUnit' ? command.to : undefined))
      .find((tile) => tile !== undefined);
    expect(destination, 'the fixture settler was offered nowhere to go').toBeDefined();
    if (destination === undefined) return;

    const readout = hoverReadout(STATE, RULESET, SEAT, settler.id, destination);
    expect(readout.movement?.kind, 'the readout did not price a legal step').toBe('cost');
    const before = settler.movementLeft;
    const moved = apply(STATE, SEAT, { type: 'MoveUnit', unitId: settler.id, to: destination });
    const after = unitOf(moved, settler.id).movementLeft;
    const spent = before - after;
    expect(
      readout.movement?.kind === 'cost' ? readout.movement.cost : undefined,
      'the readout priced the step differently from what the engine charged for it',
    ).toBe(spent);
    expect(
      readout.movement?.kind === 'cost' ? readout.movement.movementLeft : undefined,
      'the readout predicted the wrong movement left over',
    ).toBe(after);
  });

  it('prices a far tile as a journey, with the engine’s own step count', () => {
    const settler = settlerOf(STATE);
    expect(settler.movementLeft, 'the fixture settler has no movement').toBeGreaterThan(0);
    // A known far tile: the readout says nothing at all about ground the player has not seen, so a
    // journey across unexplored ground is not a case this sentence can show (the test above pins
    // that silence).
    const far = STATE.map.terrain.findIndex(
      (_terrain, tile) =>
        isExplored(STATE, SEAT, asTileIndex(tile)) &&
        tile !== Number(settler.tile) &&
        planRoute(STATE, RULESET, settler.id, asTileIndex(tile)).ok,
    );
    expect(far, 'no explored far tile on the fixture board has a route').toBeGreaterThanOrEqual(0);
    const route = planRoute(STATE, RULESET, settler.id, asTileIndex(far));
    expect(route.ok, 'the fixture route is not a route').toBe(true);
    if (!route.ok) return;
    expect(
      route.value.steps.length,
      'the fixture route is a single step, not a journey',
    ).toBeGreaterThan(1);
    const readout = hoverReadout(STATE, RULESET, SEAT, settler.id, asTileIndex(far));
    expect(readout.movement, 'a far tile got no movement answer').toEqual({
      kind: 'route',
      steps: route.value.steps.length,
    });
    expect(readoutText(readout)).toContain('steps away');
  });

  it('reports a refusal in the engine’s own words, not in words of its own', () => {
    // The rival on the board's target tile is unenterable ground: `planMove` refuses it with
    // `occupied-by-enemy`, and that refusal — the engine's sentence, naming the tile — is what a
    // player must read. A readout that invented "you cannot go there" would be this package writing
    // a rule's answer.
    const refused = planMove(BOARD.state, RULESET, settlerOf(BOARD.state).id, BOARD.tile);
    expect(refused.ok, 'the fixture tile is enterable, so it cannot show a refusal').toBe(false);
    if (refused.ok) return;
    const readout = hoverReadout(BOARD.state, RULESET, SEAT, settlerOf(BOARD.state).id, BOARD.tile);
    expect(readout.movement).toEqual({
      kind: 'refused',
      reason: problemText(refused.error),
    });
    expect(readoutText(readout)).toContain(String(BOARD.tile));
  });
});

describe('the combat line is the engine’s own odds', () => {
  it('shows the number the engine reports when the attack is really made', () => {
    const attack = offeredAttack(BOARD.state, BOARD.archer, BOARD.tile);
    const resolved = eventOf(BOARD.state, SEAT, attack, 'CombatResolved');
    expect(resolved, 'the engine resolved no battle for the offered attack').toBeDefined();
    if (resolved === undefined) return;

    const readout = hoverReadout(BOARD.state, RULESET, SEAT, BOARD.archer, BOARD.tile);
    expect(
      readout.combat,
      'the readout priced no battle for a tile the engine offers an attack on',
    ).toEqual({ kind: 'odds', perRoundPct: resolved.attackerWinPct });
    expect(readoutText(readout)).toContain(String(resolved.attackerWinPct));
  });

  it('prices the stronger attacker higher, so the figure is about the attacker', () => {
    const strong = hoverReadout(BOARD.state, RULESET, SEAT, BOARD.archer, BOARD.tile).combat;
    const weak = hoverReadout(BOARD.state, RULESET, SEAT, BOARD.warrior, BOARD.tile).combat;
    expect(strong?.kind, 'the archer got no odds').toBe('odds');
    expect(weak?.kind, 'the warrior got no odds').toBe('odds');
    if (strong?.kind !== 'odds' || weak?.kind !== 'odds') return;
    expect(
      strong.perRoundPct,
      'an archer (attack 3) is priced no better than a warrior (attack 1) against the same defender',
    ).toBeGreaterThan(weak.perRoundPct);
  });

  it('shows the engine’s reason instead of odds for an attack the engine does not offer', () => {
    // The settler cannot attack at all (`unit-cannot-attack`), and that sentence is the answer —
    // not a blank, and never a figure for a battle the player cannot start.
    const settler = settlerOf(BOARD.state);
    const readout = hoverReadout(BOARD.state, RULESET, SEAT, settler.id, BOARD.tile);
    expect(readout.combat?.kind, 'the readout priced an attack for a unit that cannot attack').toBe(
      'refused',
    );

    // And a spent soldier: the engine offers nothing, so no odds are shown.
    const spent = apply(BOARD.state, SEAT, { type: 'FortifyUnit', unitId: BOARD.archer });
    const spentReadout = hoverReadout(spent, RULESET, SEAT, BOARD.archer, BOARD.tile);
    expect(
      spentReadout.combat?.kind,
      'a unit with no movement left was offered odds on an attack the engine does not offer',
    ).toBe('refused');
    expect(readoutText(spentReadout)).not.toContain('percent');
  });

  it('says nothing about combat on a tile with nothing foreign on it', () => {
    const settler = settlerOf(STATE);
    const empty = neighbors8(STATE.map, settler.tile).find(
      (tile) =>
        !STATE.units.some((unit) => unit.tile === tile) &&
        !STATE.cities.some((city) => city.tile === tile),
    );
    expect(empty, 'the fixture has no empty neighbour').toBeDefined();
    if (empty === undefined) return;
    const readout = hoverReadout(STATE, RULESET, SEAT, settler.id, empty);
    expect(readout.combat, 'an empty tile talked about combat').toBeUndefined();
  });
});

describe('reading a tile does not touch the game', () => {
  it('leaves the state and the RNG exactly as they were, on every tile of the board', () => {
    const before = hashValue(BOARD.state);
    const rngBefore = JSON.stringify(BOARD.state.rng);
    for (let tile = 0; tile < BOARD.state.map.terrain.length; tile += 1) {
      hoverReadout(BOARD.state, RULESET, SEAT, BOARD.archer, asTileIndex(tile));
      readoutText(hoverReadout(BOARD.state, RULESET, SEAT, BOARD.archer, asTileIndex(tile)));
    }
    expect(hashValue(BOARD.state), 'reading the map changed the state hash').toBe(before);
    expect(JSON.stringify(BOARD.state.rng), 'reading the map advanced the RNG').toBe(rngBefore);
  });
});
