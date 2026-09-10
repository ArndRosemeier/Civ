/**
 * M2 acceptance evidence: the three scenarios docs/INTERFACES.md names, written
 * against the DSL and run through `runScenario` — plus tests of the DSL's own
 * failure channels, because a harness that cannot fail is not evidence either.
 *
 * The scenarios are the point. Each builds a world by hand (`addPlayer`,
 * `fillTerrain`, `setTile`, `addUnit`) so the assertions are about the *rule* and
 * not about whatever terrain a generator happened to roll:
 *
 * 1. `movement-cost-crossing-terrain` — a step costs the **destination** tile's
 *    `moveCost`, exactly (Civ 3 style), and a unit can never end on a tile it
 *    could not afford.
 * 2. `blocked-impassable-and-enemy` — impassability is not a price and an enemy
 *    tile is not enterable, each with its own typed error, while the same unit
 *    still moves onto ordinary empty ground.
 * 3. `fog-expands-as-a-unit-moves` — `explored` grows to exactly the union of the
 *    sight boxes the unit passed through, no more and no less, and only for the
 *    player whose unit moved.
 *
 * Everything runs on `@civts/rules`' `CATALOG` through the same `validateRuleset`
 * the CLI runs, so a scenario measures the engine the game actually plays.
 */

import { describe, expect, it } from 'vitest';
import {
  MAP_DIMENSIONS,
  SCHEMA_VERSION,
  TERRAIN_BY_ROLE,
  VISIBILITY_RADIUS,
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  isExplored,
  tileIndex,
  unitById,
  unitDef,
  unitsOnTile,
  visibleTiles,
  type Command,
  type CommandOutcome,
  type GameError,
  type GameState,
  type PlayerId,
  type Result,
  type RulesetView,
  type TileIndex,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  createScenarioBuilder,
  defineScenario,
  hashValue,
  runScenario,
  runScenarioAgainst,
  type Scenario,
  type ScenarioAssertion,
  type ScenarioBuilder,
} from '../src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** `duel` is the smallest world a scenario can ask for (see `scenario.ts`). */
const DUEL = MAP_DIMENSIONS.duel;
const DUEL_SETTINGS = { mapSize: 'duel' } as const;

/** Row-major tile index on the `duel` map: `at(6, 5)` is six across, five down. */
const at = (x: number, y: number): TileIndex => tileIndex(DUEL.width, x, y);

/** `(6, 5) [tile 206]` — coordinates and index together, so a failure is unambiguous. */
const label = (x: number, y: number): string =>
  `(${String(x)}, ${String(y)}) [tile ${String(Number(at(x, y)))}]`;

const ROME = asPlayerId(0);
const CARTHAGE = asPlayerId(1);
const SCOUT = asUnitTypeId('scout'); // movement 3 in the shipped catalog
const WARRIOR = asUnitTypeId('warrior'); // movement 1
const NOT_A_UNIT = asUnitTypeId('nuke');

/**
 * The real content the CLI plays on, validated the way the CLI validates it. A
 * validated `Ruleset` is structurally a `RulesetView`, so no adapter is needed.
 */
const RULESET: RulesetView = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog must validate at fidelity "tuned": ${JSON.stringify(validated.error)}`,
    );
  }
  return validated.value;
})();

/**
 * The same catalog with one terrain role removed — for the missing-role path.
 *
 * Typed as the contract's `RulesetView`: M2 made `units` a required field of that
 * view, so a ruleset that carries a unit catalog is exactly what the engine reads
 * and no narrower alias is needed. (There is no `RulesetWithUnits` in
 * `@civts/core`; `RulesetView` *is* the view with units.)
 */
const RULESET_WITHOUT_MOUNTAINS: RulesetView = {
  terrains: CATALOG.terrains.filter((terrain) => terrain.role !== 'mountains'),
  units: CATALOG.units,
  fidelity: 'tuned',
};

const move = (unitId: number, to: TileIndex): Command => ({
  type: 'MoveUnit',
  unitId: asUnitId(unitId),
  to,
});

const check = (ok: boolean, message: string): ScenarioAssertion => ({ ok, message });

/**
 * A scenario's own `assert` callback, so the falsification tests at the bottom of
 * this file can run the *same* expectations against a deliberately wrong world.
 * An assertion that cannot fail is not evidence, and the only way to show it can
 * fail is to hand it a world that should fail it.
 */
const assertOf = (scenario: Scenario): NonNullable<Scenario['assert']> => {
  if (scenario.assert === undefined) {
    throw new Error(`scenario "${scenario.name}" has no assert callback`);
  }
  return scenario.assert;
};

/** The reasons a run failed; an empty list means every assertion held. */
const failures = (assertions: readonly ScenarioAssertion[]): readonly string[] =>
  assertions.filter((assertion) => !assertion.ok).map((assertion) => assertion.message);

const refusal = (result: Result<CommandOutcome, GameError>): GameError => {
  if (result.ok) throw new Error('expected the command to be refused, but it was applied');
  return result.error;
};

const applyMove = (state: GameState, unitId: number, to: TileIndex): GameState => {
  const result = applyCommand(state, ROME, move(unitId, to), RULESET);
  if (!result.ok) throw new Error(`move to tile ${String(to)} was refused: ${result.error.kind}`);
  return result.value.state;
};

/** How many tiles `player` has ever seen. */
const exploredCount = (state: GameState, player: PlayerId): number =>
  state.explored[Number(player)]?.filter((seen) => seen).length ?? 0;

/** Every tile within the visibility radius of `(x, y)`, clipped to the map. */
const seenFrom = (x: number, y: number): readonly TileIndex[] => {
  const tiles: TileIndex[] = [];
  for (let dy = -VISIBILITY_RADIUS; dy <= VISIBILITY_RADIUS; dy += 1) {
    for (let dx = -VISIBILITY_RADIUS; dx <= VISIBILITY_RADIUS; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= DUEL.width || ny >= DUEL.height) continue;
      tiles.push(at(nx, ny));
    }
  }
  return tiles;
};

/* ------------------------------------------------------------------ *
 * 1. Terrain movement cost
 * ------------------------------------------------------------------ */

/**
 * A scout (movement 3) on grassland, with plains (cost 1) to its east and hills
 * (cost 2) beyond that. One step is scripted through the runner; the second and
 * third are probes inside `assert`, so each crossing's price is checked on its
 * own rather than only as a total.
 */
const movementCostScenario = defineScenario({
  name: 'movement-cost-crossing-terrain',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland') // cost 1
      .setTile(6, 5, 'plains') // cost 1 — the scripted step
      .setTile(7, 5, 'hills') // cost 2 — the probed step
      .addUnit(0, SCOUT, [5, 5])
      .addUnit(1, WARRIOR, [20, 20]),
  run: [move(0, at(6, 5))],
  assert: (after, ruleset) => {
    const plains = TERRAIN_BY_ROLE(ruleset, 'plains');
    const hills = TERRAIN_BY_ROLE(ruleset, 'hills');
    const scoutDef = unitDef(ruleset, SCOUT);
    const scout = unitById(after, asUnitId(0));
    if (
      plains === undefined ||
      hills === undefined ||
      scoutDef === undefined ||
      scout === undefined
    ) {
      return [check(false, 'the ruleset or the world is missing a row this scenario needs')];
    }

    // Cost 1 (grassland -> plains) already paid by the scripted step.
    const firstSpend = scoutDef.movement - scout.movementLeft;

    // Probe: hills (cost 2). Pricing the *source* tile instead of the
    // destination would make this step cost 1, so this is the assertion that
    // pins Civ 3's rule and not merely "movement goes down".
    const secondStep = applyCommand(after, ROME, move(0, at(7, 5)), ruleset);
    const afterSecond = secondStep.ok ? unitById(secondStep.value.state, asUnitId(0)) : undefined;
    const secondSpend =
      afterSecond === undefined ? -1 : scout.movementLeft - afterSecond.movementLeft;

    // Probe: with the scout's movement fully spent, even a 1-cost tile is out of
    // reach — a unit can never end on a tile it could not afford.
    const broke = secondStep.ok
      ? applyCommand(secondStep.value.state, ROME, move(0, at(8, 5)), ruleset)
      : undefined;

    return [
      check(
        plains.moveCost === 1 && hills.moveCost === 2,
        `the catalog prices plains at 1 and hills at 2 (got ${String(plains.moveCost)} and ${String(hills.moveCost)})`,
      ),
      check(
        scout.tile === at(6, 5),
        `run stepped the scout onto the plains at ${label(6, 5)} (it is on tile ${String(scout.tile)})`,
      ),
      check(
        firstSpend === plains.moveCost,
        `crossing plains cost exactly plains.moveCost = ${String(plains.moveCost)} (movement left ${String(scoutDef.movement)} -> ${String(scout.movementLeft)})`,
      ),
      check(
        secondStep.ok && afterSecond !== undefined && afterSecond.tile === at(7, 5),
        `the same scout then stepped onto the hills at ${label(7, 5)}`,
      ),
      check(
        secondSpend === hills.moveCost,
        `crossing hills cost exactly hills.moveCost = ${String(hills.moveCost)}, not the plains' ${String(plains.moveCost)}: the destination tile sets the price (spent ${String(secondSpend)})`,
      ),
      check(
        afterSecond !== undefined &&
          afterSecond.movementLeft === 0 &&
          firstSpend + secondSpend === scoutDef.movement,
        `the two crossings spent the scout's whole movement of ${String(scoutDef.movement)} (${String(firstSpend)} + ${String(secondSpend)}), leaving 0`,
      ),
      check(
        broke !== undefined &&
          !broke.ok &&
          broke.error.kind === 'not-enough-movement' &&
          broke.error.needed === 1 &&
          broke.error.available === 0,
        'with 0 movement left, a 1-cost grassland step is refused with not-enough-movement(needed 1, available 0)',
      ),
      check(
        after.revision === 1 && after.turn === 1,
        `only the scripted step was applied: revision is 1 and the turn is still 1 (got ${String(after.revision)}/${String(after.turn)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 2. Blocked moves
 * ------------------------------------------------------------------ */

/**
 * A scout (movement 3, so it can afford the mountains' cost of 3) on grassland,
 * with impassable mountains to its east and a Carthaginian warrior to its south.
 * No `run` commands: a refusal in `run` is a failing run, and this scenario is
 * *about* refusals, so it probes them and asserts each typed error.
 */
const blockedScenario = defineScenario({
  name: 'blocked-impassable-and-enemy',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'mountains') // impassable, moveCost 3
      .addUnit(0, SCOUT, [5, 5])
      .addUnit(1, WARRIOR, [5, 6]),
  assert: (after, ruleset) => {
    const mountains = TERRAIN_BY_ROLE(ruleset, 'mountains');
    const grassland = TERRAIN_BY_ROLE(ruleset, 'grassland');
    const scout = unitById(after, asUnitId(0));
    const enemy = unitById(after, asUnitId(1));
    if (
      mountains === undefined ||
      grassland === undefined ||
      scout === undefined ||
      enemy === undefined
    ) {
      return [check(false, 'the ruleset or the world is missing a row this scenario needs')];
    }

    const intoMountain = applyCommand(after, ROME, move(0, at(6, 5)), ruleset);
    const intoEnemy = applyCommand(after, ROME, move(0, at(5, 6)), ruleset);
    const intoEmpty = applyCommand(after, ROME, move(0, at(5, 4)), ruleset);
    const enemyTileTerrain = after.map.terrain[Number(at(5, 6))];

    return [
      check(
        !intoMountain.ok &&
          intoMountain.error.kind === 'impassable' &&
          intoMountain.error.unitId === asUnitId(0) &&
          intoMountain.error.to === at(6, 5),
        `stepping onto the mountains at ${label(6, 5)} is refused with impassable(unit 0, tile ${String(Number(at(6, 5)))})`,
      ),
      check(
        mountains.impassable && mountains.moveCost <= scout.movementLeft,
        `the scout can afford the mountains' ${String(mountains.moveCost)} movement points (it has ${String(scout.movementLeft)}), so the refusal is impassability and not a price`,
      ),
      check(
        !intoEnemy.ok &&
          intoEnemy.error.kind === 'occupied-by-enemy' &&
          intoEnemy.error.unitId === asUnitId(0) &&
          intoEnemy.error.to === at(5, 6),
        `stepping onto Carthage's warrior at ${label(5, 6)} is refused with occupied-by-enemy(unit 0, tile ${String(Number(at(5, 6)))})`,
      ),
      check(
        enemyTileTerrain === grassland.id &&
          !grassland.impassable &&
          grassland.moveCost <= scout.movementLeft,
        'the tile the enemy stands on is ordinary passable grassland the scout can afford, so the refusal is the enemy: in M2 an enemy-held tile is simply not enterable',
      ),
      check(
        intoEmpty.ok,
        `the same scout steps onto the empty grassland at ${label(5, 4)}, so the two refusals are specific and not a blanket "nothing moves"`,
      ),
      check(
        after.revision === 0 &&
          unitById(after, asUnitId(0))?.tile === at(5, 5) &&
          after.units.length === 2,
        'no refused command changed anything: revision is still 0, the scout is still on its own tile, and the unit count is unchanged',
      ),
      check(
        unitsOnTile(after, at(6, 5)).length === 0,
        'the mountain tile holds no unit, so it was refused for being impassable rather than for being occupied',
      ),
      check(
        unitsOnTile(after, at(5, 6)).length === 1 &&
          unitsOnTile(after, at(5, 6))[0]?.owner === CARTHAGE,
        "the contested tile holds exactly one unit and it is Carthage's",
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 3. Fog expansion
 * ------------------------------------------------------------------ */

/**
 * A scout (movement 3) on grassland steps east three times in one turn. Its
 * three post-move sight boxes (radius 2, clipped to the map) overlap into the
 * rectangle x 4..10, y 3..7 — 35 tiles — which is exactly what `explored` must
 * hold afterwards: the world starts with no memory at all, and the only thing
 * that writes to it is a move.
 */
const fogScenario = defineScenario({
  name: 'fog-expands-as-a-unit-moves',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SCOUT, [5, 5])
      .addUnit(1, SCOUT, [30, 30]),
  run: [move(0, at(6, 5)), move(0, at(7, 5)), move(0, at(8, 5))],
  assert: (after, _ruleset) => {
    const scout = unitById(after, asUnitId(0));
    const stepped: readonly (readonly [number, number])[] = [
      [6, 5],
      [7, 5],
      [8, 5],
    ];
    const expected = new Set<number>();
    for (const [x, y] of stepped) {
      for (const tile of seenFrom(x, y)) expected.add(Number(tile));
    }

    const explored = exploredCount(after, ROME);
    const seenNow = visibleTiles(after, ROME);

    return [
      check(
        scout !== undefined && scout.tile === at(8, 5),
        `the scout stepped (6, 5) then (7, 5) then ${label(8, 5)} and is there now`,
      ),
      check(
        expected.size === 35,
        `the three sight boxes overlap into the rectangle x 4..10, y 3..7 — 35 tiles (this scenario computes ${String(expected.size)})`,
      ),
      check(explored === 35, `explored holds exactly those 35 tiles (got ${String(explored)})`),
      check(
        explored === expected.size &&
          [...expected].every((tile) => isExplored(after, ROME, asTileIndex(tile))),
        `every tile of the union is explored and nothing else is (explored ${String(explored)} of ${String(expected.size)})`,
      ),
      check(
        isExplored(after, ROME, at(4, 3)) && isExplored(after, ROME, at(10, 7)),
        `both far corners of the swept ground, ${label(4, 3)} and ${label(10, 7)}, are explored`,
      ),
      check(
        !isExplored(after, ROME, at(3, 5)),
        `${label(3, 5)} is within sight of where the scout started but was never inside a sight box the scout occupied, so it stays fogged: memory records where the unit looked from, not where it was placed`,
      ),
      check(
        !isExplored(after, ROME, at(11, 5)) &&
          !isExplored(after, ROME, at(5, 2)) &&
          !isExplored(after, ROME, at(10, 8)),
        'nothing beyond the last sight box is explored, so fog grew with the movement and then stopped',
      ),
      check(
        seenNow.length > 0 && seenNow.every((tile) => isExplored(after, ROME, tile)),
        'everything the scout can see right now is already remembered (visibility is folded into explored as the unit moves)',
      ),
      check(
        exploredCount(after, CARTHAGE) === 0,
        "Carthage's scout has not moved, so Carthage has explored nothing: fog is per-player",
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * The three scenarios, as tests
 * ------------------------------------------------------------------ */

describe('M2 scenario: movement cost across terrain', () => {
  it("pays exactly the destination tile's moveCost and cannot overspend", () => {
    const result = runScenario(movementCostScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.finalState?.revision).toBe(1);
    // The engine's own account of the scripted step, cost included.
    expect(result.events).toEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: at(5, 5),
        to: at(6, 5),
        cost: 1,
        movementLeft: 2,
      },
    ]);
  });
});

describe('M2 scenario: blocked moves', () => {
  it('refuses impassable and enemy-occupied tiles with their own typed errors', () => {
    const result = runScenario(blockedScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the blocked-move scenario must build a state');

    // The exact errors, not merely "it failed": each carries the unit and tile.
    expect(refusal(applyCommand(after, ROME, move(0, at(6, 5)), RULESET))).toEqual({
      kind: 'impassable',
      unitId: asUnitId(0),
      to: at(6, 5),
    });
    expect(refusal(applyCommand(after, ROME, move(0, at(5, 6)), RULESET))).toEqual({
      kind: 'occupied-by-enemy',
      unitId: asUnitId(0),
      to: at(5, 6),
    });

    // The control: the same unit, the same turn, an ordinary empty tile.
    expect(applyCommand(after, ROME, move(0, at(5, 4)), RULESET).ok).toBe(true);

    expect(result.events).toEqual([]);
    expect(after.revision).toBe(0);
  });
});

describe('M2 scenario: fog expands as a unit moves', () => {
  it('grows explored to exactly the union of the sight boxes the unit passed through', () => {
    const result = runScenario(fogScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the fog scenario must build a state');
    expect(unitById(after, asUnitId(0))?.tile).toBe(at(8, 5));
    expect(after.revision).toBe(3);
    expect(exploredCount(after, ROME)).toBe(35);
    expect(isExplored(after, ROME, at(4, 3))).toBe(true);
    expect(isExplored(after, ROME, at(11, 5))).toBe(false);
    expect(exploredCount(after, CARTHAGE)).toBe(0);
  });

  it('grows one step at a time, outside the runner, through the builder', () => {
    const built = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SCOUT, [5, 5])
      .addUnit(1, SCOUT, [30, 30])
      .build();
    if (!built.ok) throw new Error(`the fog fixture must build: ${JSON.stringify(built.error)}`);
    const start = built.value;

    // A hand-built world starts with no memory for anyone.
    expect(exploredCount(start, ROME)).toBe(0);
    expect(exploredCount(start, CARTHAGE)).toBe(0);

    const afterOne = applyMove(start, 0, at(6, 5));
    expect(exploredCount(afterOne, ROME)).toBe(25); // one 5x5 box: x 4..8, y 3..7

    const afterTwo = applyMove(afterOne, 0, at(7, 5));
    expect(exploredCount(afterTwo, ROME)).toBe(30); // + the column x = 9

    const afterThree = applyMove(afterTwo, 0, at(8, 5));
    expect(exploredCount(afterThree, ROME)).toBe(35); // + the column x = 10

    expect(afterOne.revision).toBe(1);
    expect(afterThree.revision).toBe(3);
    expect(exploredCount(afterThree, CARTHAGE)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Reproducibility
 * ------------------------------------------------------------------ */

describe('scenario runs are reproducible', () => {
  it('gives the same final state and the same hash on every run', () => {
    const first = runScenario(movementCostScenario);
    const second = runScenario(movementCostScenario);

    const state = first.finalState;
    if (state === undefined) throw new Error('the movement scenario must produce a final state');

    expect(first.passed).toBe(true);
    expect(first.hash).toBe(hashValue(state));
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(second.hash).toBe(first.hash);
    expect(second.finalState).toEqual(state);
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('hashes different worlds differently, so the digest is not a constant', () => {
    expect(runScenario(blockedScenario).hash).not.toBe(runScenario(movementCostScenario).hash);
  });
});

/* ------------------------------------------------------------------ *
 * The builder, and the DSL's failure channels
 * ------------------------------------------------------------------ */

describe('the scenario builder', () => {
  it('builds exactly the world the scenario asked for', () => {
    const built = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('ocean')
      .setTile(5, 5, 'grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, SCOUT, [5, 5])
      .addUnit(1, WARRIOR, [6, 6])
      .build();
    if (!built.ok) throw new Error(`the fixture must build: ${JSON.stringify(built.error)}`);
    const state = built.value;

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.revision).toBe(0);
    expect(state.turn).toBe(1);
    expect(state.map.width).toBe(DUEL.width);
    expect(state.map.height).toBe(DUEL.height);
    expect(state.map.terrain).toHaveLength(DUEL.width * DUEL.height);

    // Terrain by role: `fillTerrain('ocean')` with two overrides, no generation.
    expect(state.map.terrain[Number(at(0, 0))]).toBe(TERRAIN_BY_ROLE(RULESET, 'ocean')?.id);
    expect(state.map.terrain[Number(at(5, 5))]).toBe(TERRAIN_BY_ROLE(RULESET, 'grassland')?.id);
    expect(state.map.terrain[Number(at(6, 5))]).toBe(TERRAIN_BY_ROLE(RULESET, 'hills')?.id);

    expect(state.players.map((player) => player.name)).toEqual(['Rome', 'Carthage']);
    expect(state.players.map((player) => player.startingTile)).toEqual([at(5, 5), at(6, 6)]);
    expect(state.players.map((player) => player.color)).toEqual(['#d12f2f', '#2f6fd1']);

    // Dense ids in creation order, full movement, and `nextUnitId` past them.
    expect(state.units.map((unit) => unit.id)).toEqual([asUnitId(0), asUnitId(1)]);
    expect(state.units.map((unit) => unit.owner)).toEqual([ROME, CARTHAGE]);
    expect(state.units.map((unit) => unit.tile)).toEqual([at(5, 5), at(6, 6)]);
    expect(state.units[0]?.movementLeft).toBe(unitDef(RULESET, SCOUT)?.movement);
    expect(state.units[1]?.movementLeft).toBe(unitDef(RULESET, WARRIOR)?.movement);
    expect(state.nextUnitId).toBe(2);

    // The player list decides the civ count, not the settings patch.
    expect(state.settings.civCount).toBe(2);
    expect(state.settings.mapSize).toBe('duel');
  });
});

describe('the DSL reports failures instead of hiding them', () => {
  it('returns a typed missing-terrain-role when the ruleset cannot supply a role', () => {
    const built = createScenarioBuilder(RULESET_WITHOUT_MOUNTAINS, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'mountains')
      .addUnit(0, WARRIOR, [5, 5])
      .addUnit(1, WARRIOR, [5, 6])
      .build();

    expect(built.ok).toBe(false);
    expect(built.ok ? undefined : built.error).toEqual({
      kind: 'missing-terrain-role',
      role: 'mountains',
    });

    // Control: the same world without the missing role builds.
    const control = createScenarioBuilder(RULESET_WITHOUT_MOUNTAINS, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, WARRIOR, [5, 5])
      .addUnit(1, WARRIOR, [5, 6])
      .build();
    expect(control.ok).toBe(true);
  });

  it('reports a world that cannot be built as a failed run, not a thrown error', () => {
    const needsMountains: Scenario = {
      name: 'needs-mountains',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'mountains')
          .addUnit(0, WARRIOR, [5, 5])
          .addUnit(1, WARRIOR, [5, 6]),
      assert: () => [check(true, 'unreachable: the world never builds')],
    };

    const result = runScenarioAgainst(needsMountains, RULESET_WITHOUT_MOUNTAINS);

    expect(result.name).toBe('needs-mountains');
    expect(result.passed).toBe(false);
    expect(result.finalState).toBeUndefined();
    expect(result.hash).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(failures(result.assertions)).toEqual([
      'setup failed: missing-terrain-role ("mountains"): the ruleset defines no terrain for that role',
    ]);
  });

  it('turns a refused run command into a failed assertion naming the typed error', () => {
    const illegal: Scenario = {
      name: 'run-into-a-mountain',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'mountains')
          .addUnit(0, WARRIOR, [5, 5])
          .addUnit(1, WARRIOR, [5, 6]),
      run: [move(0, at(6, 5))],
      assert: () => [check(true, 'the assert callback still runs after a refused command')],
    };

    const result = runScenario(illegal);

    expect(result.passed).toBe(false);
    expect(result.assertions).toHaveLength(2);
    expect(result.assertions[0]?.message).toBe(
      `run[0] MoveUnit unit 0 to ${label(6, 5)} was refused: impassable (unit 0 cannot enter tile ${String(Number(at(6, 5)))})`,
    );
    // The refusal changed nothing: the run's final state is still the built world.
    const after = result.finalState;
    if (after === undefined) throw new Error('a refused command still leaves the built world');
    expect(after.revision).toBe(0);
    expect(unitById(after, asUnitId(0))?.tile).toBe(at(5, 5));
    expect(result.events).toEqual([]);
  });

  it('fails a scenario that asserts nothing, so a green run cannot be vacuous', () => {
    const vacuous: Scenario = {
      name: 'asserts-nothing',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .addUnit(0, WARRIOR, [5, 5])
          .addUnit(1, WARRIOR, [6, 6]),
    };

    const result = runScenario(vacuous);

    expect(result.passed).toBe(false);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]?.ok).toBe(false);
    expect(result.assertions[0]?.message).toMatch(/asserts nothing/);
    expect(result.finalState).toBeDefined();
  });

  it('refuses scenario-authoring mistakes at the offending call', () => {
    const fresh = (): ScenarioBuilder => createScenarioBuilder(RULESET, DUEL_SETTINGS);

    expect(() => fresh().setTile(DUEL.width, 0, 'hills')).toThrow(/outside this world's 40x40 map/);
    expect(() => fresh().setTile(0, -1, 'hills')).toThrow(/outside this world's 40x40 map/);
    expect(() => fresh().addPlayer('   ')).toThrow(/non-empty name/);
    expect(() => fresh().addUnit(0, WARRIOR, [0, 0])).toThrow(/needs a player index/);
    expect(() => fresh().addPlayer('Rome').addUnit(1, WARRIOR, [0, 0])).toThrow(
      /needs a player index/,
    );
    expect(() => fresh().addPlayer('Rome').addUnit(0, NOT_A_UNIT, [0, 0])).toThrow(
      /defines no unit type "nuke"/,
    );
    expect(() => fresh().addPlayer('Rome').fillTerrain('grassland').build()).toThrow(
      /at least 2 players/,
    );
    expect(() =>
      fresh().addPlayer('Rome').addPlayer('Byzantium').addUnit(0, WARRIOR, [5, 5]).build(),
    ).toThrow(/player 1 \("Byzantium"\) has no unit/);
    expect(() => createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 4 })).toThrow(
      /invalid settings/,
    );
    expect(() =>
      createScenarioBuilder(RULESET, { mapSize: 'tiny', civCount: 3 })
        .addPlayer('Rome')
        .addPlayer('Byzantium')
        .addUnit(0, WARRIOR, [5, 5])
        .addUnit(1, WARRIOR, [6, 6])
        .build(),
    ).toThrow(/settings.civCount is 3 but 2 players/);
    expect(() =>
      defineScenario({
        name: 'bad-settings',
        settings: { mapSize: 'tiny', civCount: 99 },
        setup: (b) => b,
      }),
    ).toThrow(/invalid settings/);
    expect(() => defineScenario({ name: '   ', setup: (b) => b })).toThrow(/non-empty name/);
  });

  it('returns the scenario it was handed, so a defined scenario is the scenario', () => {
    expect(defineScenario(movementCostScenario)).toBe(movementCostScenario);
  });
});

/* ------------------------------------------------------------------ *
 * Falsification: the three scenarios' assertions must be able to fail
 * ------------------------------------------------------------------ */

/**
 * Each test below runs one of the three scenarios' own `assert` callbacks
 * against a deliberately wrong world. If an expectation were vacuous — checking
 * nothing in particular, or something that holds no matter what the engine does —
 * these would pass, and the suite would be reporting evidence it does not have.
 * They fail, which is the point.
 */
describe('the scenario assertions discriminate (they are not decoration)', () => {
  it('the movement-cost assertions fail when the unit cannot afford the next crossing', () => {
    // Same script and same assertions, but a warrior (movement 1) where the
    // scenario expects a scout (movement 3): plain crossing still lands, and
    // everything priced beyond the first step has to be noticed.
    const variant: Scenario = {
      name: 'movement-cost-with-a-warrior',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'plains')
          .setTile(7, 5, 'hills')
          .addUnit(0, WARRIOR, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [move(0, at(6, 5))],
      assert: assertOf(movementCostScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(
      /crossing hills cost exactly hills.moveCost = 2/,
    );
  });

  it('the blocked-move assertions fail when the blocking unit is not there', () => {
    // Carthage exists, but its warrior is far away: the tile the scenario calls
    // "enemy-occupied" is empty, and that expectation must break.
    const variant: Scenario = {
      name: 'blocked-by-nobody',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'mountains')
          .addUnit(0, SCOUT, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      assert: assertOf(blockedScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/refused with occupied-by-enemy/);
  });

  it('the fog assertions fail when the unit does not move as far as expected', () => {
    // Two steps instead of three: the sight boxes cover 30 tiles, not the 35 the
    // scenario asserts, so the count and the far corner must both disagree.
    const variant: Scenario = {
      name: 'fog-with-two-steps',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .addUnit(0, SCOUT, [5, 5])
          .addUnit(1, SCOUT, [30, 30]),
      run: [move(0, at(6, 5)), move(0, at(7, 5))],
      assert: assertOf(fogScenario),
    };

    const result = runScenario(variant);

    const after = result.finalState;
    if (after === undefined) throw new Error('the two-step fog variant must still build a world');
    expect(result.passed).toBe(false);
    expect(exploredCount(after, ROME)).toBe(30);
    expect(failures(result.assertions).join('\n')).toMatch(/explored holds exactly those 35 tiles/);
  });
});
