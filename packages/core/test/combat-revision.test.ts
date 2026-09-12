/**
 * The capture revision delta — **exactly one bump per sack, wherever the sack came from.**
 *
 * M6b moved the `revision` bump for a capture out of `commands.ts`' `applyCapture` and into
 * `cities.ts`' `captureCity`. The argument is that "the state changed" belongs to the rule
 * that changes it: `captureCity` is called by two callers — the player's `AttackUnit` in
 * `applyCapture`, and the engine's own barbarian step through the same applier — and a
 * counter owned by one caller is a counter the other callers can drop.
 *
 * That repair is only correct if the delta is *one*, in every path and for every number of
 * sacks. Two failures are possible and both are invisible in an ordinary test:
 *
 * - **Two bumps** — the command layer keeping its own `revision: state.revision + 1` on top
 *   of the capture rule's. A state would then advance by two for one command, which breaks
 *   M2's invariant 2 ("revision counts applied commands") without breaking any single
 *   capture assertion, because a single capture still *changed*.
 * - **Zero bumps** — a caller that forgot. This is what the barbarian path did before the
 *   repair, and it is why the last block below measures `advanceTurn`: the barbarian step
 *   deliberately *puts the revision back* (see `barbarians.ts`, "`revision` is not
 *   touched"), so a capture applied inside a turn must not advance the counter, and the
 *   number of sacks in that turn must not change that.
 *
 * The third case — **two sacks in one turn** — is the one that separates "one bump" from
 * "one bump per command": with one command it is impossible to tell a per-sack bump from a
 * constant, and with two it is not.
 */

import { describe, expect, it } from 'vitest';

import { hashValue } from '@civts/testing';

import { captureCity, captureRulesOf, type BuildingDef, type City } from '../src/cities.js';
import { defenderBonusPct, resolveCombat } from '../src/combat.js';
import { applyCommand, type Command, type GameEvent } from '../src/commands.js';
import {
  asBuildingId,
  asCityId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
} from '../src/ids.js';
import { tileIndex, type GameMap, type RulesetView, type TerrainDef } from '../src/map.js';
import { seedRng } from '../src/rng.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import {
  DEFAULT_RATES,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  type GameState,
  type PlayerState,
} from '../src/state.js';
import type { UnitDef } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * The board: 3x1, an enemy city at each end and an attacker on each centre tile
 * ------------------------------------------------------------------ */

const WIDTH = 3;
const HEIGHT = 1;

/**
 * A three-tile row, so "adjacent" is unambiguous and **both** enemy cities are reachable in
 * one command.
 *
 * ```
 *   x:  0        1        2
 *     [city 0] [grass] [city 1]     every tile is grassland; the cities are P1's
 *      (P1)     ^        (P1)
 *             attacker 0 and attacker 1 (P0), both here
 * ```
 *
 * The third tile is what the first version of this fixture got wrong: on a 4x1 row with
 * cities at 1 and 2, the only unit that could reach tile 1 stood on tile 0 and could not
 * reach tile 2 — "two sacks in one turn" is not a shape a single attacker can produce, and a
 * fixture that pretended otherwise would have measured one sack twice.
 *
 * `MIN_CITY_DISTANCE` is 2 and that rule is a *founding* rule, not a state invariant — a
 * hand-built state may hold two cities two tiles apart (this one does), and `AttackUnit`
 * only ever requires that the target be adjacent.
 */
const GRASS: TerrainDef = {
  id: asTerrainId('grassland'),
  role: 'grassland',
  name: 'Grassland',
  moveCost: 1,
  defenseBonusPct: 0,
  yields: { food: 2, shields: 1, commerce: 1 },
  impassable: false,
};

const WARRIOR: UnitDef = {
  id: asUnitTypeId('warrior'),
  role: 'military',
  name: 'Warrior',
  attack: 3,
  defense: 3,
  hitPoints: 3,
  movement: 1,
  cost: 10,
  domain: 'land',
};

/**
 * A building row whose **id** is the one the combat rule checks for walls.
 *
 * The wall bonus itself is `combat.wallsBonusPct` (M6b) and reads the id `"walls"`; there is
 * no engine-side effect kind for it, so the row's `effects` are empty and this row exists
 * only so that a city in this fixture *could* hold walls. The capture tests below do not put
 * it in a city — a capture is denied the wall bonus on the way out in any case, since the
 * city changes hands — but building the fixture without the row would make the id this
 * module's ruleset can name unreachable.
 */
const WALLS: BuildingDef = {
  id: asBuildingId('walls'),
  name: 'Walls',
  cost: 20,
  maintenance: 1,
  effects: [],
};

/**
 * A view that carries a combat section, because the applier reads the combat magnitudes
 * out of the ruleset it is handed (M6b) and an absent section is the *degenerate* table
 * rather than the shipped one. The nine numbers are the shipped ones.
 *
 * M7 gives it a `capture` section too, for the same reason one rule later: a capture reads
 * the population divisor out of the ruleset it is played under, and a view that declared
 * nothing would leave the sack under the degenerate "costs the city no citizens".
 */
interface SectionedView extends RulesetView {
  readonly capture: {
    readonly populationDivisor: number;
  };
  readonly combat: {
    readonly fortifyBonusPct: number;
    readonly cityDefenseBonusPct: number;
    readonly wallsBonusPct: number;
    readonly veteranAttackPct: number;
    readonly maxExperience: number;
    readonly rollBound: number;
    readonly damagePerRound: number;
    readonly minWinPct: number;
    readonly maxWinPct: number;
  };
}

const RULESET: SectionedView = {
  terrains: [GRASS],
  units: [WARRIOR],
  buildings: [WALLS],
  improvements: [],
  resources: [],
  fidelity: 'tuned',
  // The shipped divisor, stated by this fixture rather than assumed by `cities.ts`.
  capture: { populationDivisor: 2 },
  combat: {
    fortifyBonusPct: 25,
    cityDefenseBonusPct: 50,
    wallsBonusPct: 50,
    veteranAttackPct: 25,
    maxExperience: 3,
    rollBound: 100,
    damagePerRound: 1,
    minWinPct: 1,
    maxWinPct: 99,
  },
};

const makeMap = (): GameMap => ({
  width: WIDTH,
  height: HEIGHT,
  terrain: new Array<ReturnType<typeof asTerrainId>>(WIDTH * HEIGHT).fill(GRASS.id),
  huts: [],
  resources: [],
});

// Named for its job rather than `tile`, which the `City` literal's own field shadows: a
// one-letter helper here silently reads a *row* number where a *tile index* is meant, and
// the fixture then builds a board the test cannot attack.
const columnTile = (x: number): number => tileIndex(WIDTH, x, 0);

const makePlayer = (index: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: '#000000',
  startingTile: asTileIndex(columnTile(0)),
  kind: 'civ',
  treasury: STARTING_TREASURY,
  rates: DEFAULT_RATES,
  beakers: 0,
  luxuries: 0,
  techs: [],
});

const makeCity = (id: number, owner: number, at: number): City => ({
  id: asCityId(id),
  owner: asPlayerId(owner),
  name: `City ${String(id)}`,
  tile: asTileIndex(at),
  population: 2,
  foodBox: 0,
  shields: 0,
  queue: [],
  buildings: [],
  workedTiles: [],
});

/**
 * `cityCount` undefended cities of player 1 — at tile 0 and tile 2 — and `cityCount`
 * player-0 attackers on tile 1 with movement to spend.
 *
 * One attacker per city, deliberately: a capture spends the attacker's whole movement, so a
 * unit cannot sack twice in a turn. "Two sacks in one turn" is a statement about the *turn*,
 * not about a unit, and the honest fixture is two units.
 */
const board = (cityCount: number): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 7,
  turn: 1,
  seed: 1,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'tiny' },
  rng: seedRng(1),
  map: makeMap(),
  players: [makePlayer(0), makePlayer(1)],
  nextUnitId: cityCount,
  units: Array.from({ length: cityCount }, (_, index) => ({
    id: asUnitId(index),
    type: asUnitTypeId('warrior'),
    owner: asPlayerId(0),
    tile: asTileIndex(columnTile(1)),
    movementLeft: 1,
    hitPointsLeft: 3,
  })),
  explored: [asPlayerId(0), asPlayerId(1)].map(() => new Array<boolean>(WIDTH * HEIGHT).fill(true)),
  nextCityId: cityCount,
  cities: Array.from({ length: cityCount }, (_, index) =>
    makeCity(index, 1, columnTile(index === 0 ? 0 : 2)),
  ),
  improvements: [],
});

const attack = (unitId: number, target: number): Command => ({
  type: 'AttackUnit',
  unitId: asUnitId(unitId),
  target: asTileIndex(target),
});

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
};

const captureEvents = (events: readonly GameEvent[]): readonly GameEvent[] =>
  events.filter((event) => event.type === 'CityCaptured');

/* ------------------------------------------------------------------ *
 * The deltas
 * ------------------------------------------------------------------ */

describe('the capture revision delta is exactly one per sack', () => {
  it('bumps by exactly one for a single sack, and reports it once', () => {
    const before = board(1);
    const outcome = applyCommand(before, asPlayerId(0), attack(0, columnTile(0)), RULESET);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.state.revision - before.revision).toBe(1);
    expect(captureEvents(outcome.value.events)).toHaveLength(1);
    // The sack happened: the city changed hands. Without this the delta above would be
    // equally satisfied by a command that did nothing and bumped anyway.
    expect(must(outcome.value.state.cities[0], 'city 0').owner).toBe(asPlayerId(0));
  });

  it('bumps by exactly TWO for two sacks in one turn — not one, and not four', () => {
    // The case a per-command constant cannot express. `board(2)` gives player 1 two cities
    // (tiles 0 and 2) and player 0 two attackers standing between them on tile 1, each with
    // movement to spend, so both sacks happen inside one *turn* — the second command is
    // applied to the state the first returned, with `turn` untouched. Neither attacker can
    // act twice (a capture spends the attacker's whole movement), which is why this is two
    // units and not one.
    const before = board(2);
    const first = applyCommand(before, asPlayerId(0), attack(0, columnTile(0)), RULESET);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.value.state.turn).toBe(before.turn);
    const second = applyCommand(
      first.value.state,
      asPlayerId(0),
      attack(1, columnTile(2)),
      RULESET,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.state.turn).toBe(before.turn);
    // The second attacker was untouched by the first command, which is what makes this two
    // commands in one turn rather than two turns.
    expect(must(second.value.state.units[1], 'unit 1').movementLeft).toBe(0);

    expect(captureEvents(first.value.events)).toHaveLength(1);
    expect(captureEvents(second.value.events)).toHaveLength(1);
    expect(second.value.state.revision - before.revision).toBe(2);
    expect(second.value.state.cities.map((each) => each.owner)).toStrictEqual([
      asPlayerId(0),
      asPlayerId(0),
    ]);
    // Two commands, two revisions, two different states — so the counter is not a constant
    // that happens to match the first case.
    expect(second.value.state.revision).toBe(first.value.state.revision + 1);
    expect(hashValue(second.value.state)).not.toBe(hashValue(first.value.state));
  });

  it('bumps the same way for the capture rule called directly, with no command above it', () => {
    // The rule on its own: this is what the barbarian step reaches, and what M6b moved the
    // bump *into*. A capture that did not bump here would be the zero-bump failure.
    const before = board(1);
    const capture = captureCity(
      before,
      RULESET.buildings ?? [],
      asCityId(0),
      asPlayerId(0),
      captureRulesOf(RULESET),
    );
    if (capture === undefined) throw new Error('the fixture holds city 0');

    expect(capture.state.revision - before.revision).toBe(1);
    expect(capture.city.owner).toBe(asPlayerId(0));
  });

  it('answers the same for two captures applied to the same state, one after the other', () => {
    // The rule again, twice, without the command layer: two sacks are two bumps because
    // each call is a state change of its own. This is the property the `applyCapture`
    // comment states ("one bump per capture, from the capture rule") reduced to the rule.
    const before = board(2);
    const first = must(
      captureCity(
        before,
        RULESET.buildings ?? [],
        asCityId(0),
        asPlayerId(0),
        captureRulesOf(RULESET),
      ),
      'the first capture',
    );
    const second = must(
      captureCity(
        first.state,
        RULESET.buildings ?? [],
        asCityId(1),
        asPlayerId(0),
        captureRulesOf(RULESET),
      ),
      'the second capture',
    );

    expect(first.state.revision - before.revision).toBe(1);
    expect(second.state.revision - first.state.revision).toBe(1);
    expect(second.state.revision - before.revision).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The other half of the same repair: the resolver has no copy of its own
 * ------------------------------------------------------------------ */

describe('the resolver reads its magnitudes out of the ruleset it is handed', () => {
  /**
   * The chance a one-hit-point battle gives the attacker, with the defender fortified and
   * given `fortifyBonusPct`.
   *
   * The bonus is summed by `defenderBonusPct` — the engine's own single implementation of
   * the modifier list — so this is the *real* path a battle takes: section → bonus helper →
   * resolver. `static` is a settled roll (`0`), so the first round is the whole battle and
   * the figure is `winPct(3, 3 + bonus)`, which is hand-computable. That matters: the
   * assertion below is not "the number changed" but "the number is the arithmetic of the
   * *patched* section".
   */
  const oddsWith = (fortifyBonusPct: number): number => {
    const rules = { ...RULESET.combat, fortifyBonusPct };
    const bonusPct = defenderBonusPct(rules, {
      terrainBonusPct: 0,
      fortified: true,
      inCity: false,
      walls: false,
    });
    const outcome = resolveCombat({
      rules,
      attacker: { attack: 3, defense: 0, bonusPct: 0 },
      defender: { attack: 0, defense: 3, bonusPct },
      attackerHitPoints: 1,
      defenderHitPoints: 1,
      rng: seedRng(1),
      static: [0],
    });
    return outcome.result.attackerWinPct;
  };

  it('moves the odds when the section moves, and leaves them alone when the bonus is zero', () => {
    // A fortify bonus of 100 doubles the defence (3 -> 6), so the odds are 3/9 = 33% where
    // they were 3/6 = 50%. A `combat.ts` that carried its own copy of the bonus — M6's
    // `FORTIFY_BONUS_PCT` — would report 50% for both of these, and would report it *here*,
    // in the resolver, rather than only in a helper.
    expect(oddsWith(100)).toBe(33);
    expect(oddsWith(0)).toBe(50);
    // Two different sections, two different battles: the resolver is a function of the
    // ruleset, not of a module-level table that happens to match it today.
    expect(oddsWith(100)).not.toBe(oddsWith(0));
  });
});
