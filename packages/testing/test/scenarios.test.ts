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
  DEFAULT_RATES,
  FREE_UNITS_BASE,
  FREE_UNITS_PER_CITY,
  HUT_REWARD_KINDS,
  HUT_REWARD_PROVENANCE,
  MAP_DIMENSIONS,
  RATE_TOTAL,
  SCHEMA_VERSION,
  STARTING_TREASURY,
  TERRAIN_BY_ROLE,
  UNIT_SUPPORT_COST,
  VISIBILITY_RADIUS,
  applyCommand,
  asBuildingId,
  asCityId,
  asImprovementId,
  asPlayerId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  cityAt,
  cityById,
  cityYields,
  civPlayers,
  foodBoxSize,
  hasImprovement,
  hutAt,
  improvementDef,
  improvementsAt,
  isExplored,
  isPlaceholder,
  loadSettings,
  neighbors8,
  newGame,
  nextBelow,
  playerIncome,
  ratesProblem,
  seedRng,
  splitCommerce,
  tileIndex,
  tileYields,
  unitById,
  unitDef,
  unitSupport,
  unitsOnTile,
  visibleTiles,
  type City,
  type Command,
  type CommandOutcome,
  type GameError,
  type GameEvent,
  type GameState,
  type HutRewardKind,
  type ImprovementId,
  type PlayerId,
  type ProductionItem,
  type Rates,
  type Result,
  type RulesetView,
  type TileIndex,
  type UnitWork,
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
  // M4a made `improvements` a required field of the engine's view, so a hand-built
  // view must carry one: the same catalog's rows, untouched, because this fixture
  // is about a missing *terrain* role and not about improvements.
  improvements: CATALOG.improvements,
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

    // The world's players are the civilizations the scenario asked for — asked
    // through `civPlayers`, because M3 made `players` the *full* player list
    // (`newGame` appends a barbarian player to it) and "the names this scenario
    // added" is a civilization question.
    expect(civPlayers(state).map((player) => player.name)).toEqual(['Rome', 'Carthage']);
    expect(civPlayers(state).map((player) => player.startingTile)).toEqual([at(5, 5), at(6, 6)]);
    expect(civPlayers(state).map((player) => player.color)).toEqual(['#d12f2f', '#2f6fd1']);
    expect(civPlayers(state).every((player) => player.kind === 'civ')).toBe(true);

    // Dense ids in creation order, full movement, and `nextUnitId` past them.
    expect(state.units.map((unit) => unit.id)).toEqual([asUnitId(0), asUnitId(1)]);
    expect(state.units.map((unit) => unit.owner)).toEqual([ROME, CARTHAGE]);
    expect(state.units.map((unit) => unit.tile)).toEqual([at(5, 5), at(6, 6)]);
    expect(state.units[0]?.movementLeft).toBe(unitDef(RULESET, SCOUT)?.movement);
    expect(state.units[1]?.movementLeft).toBe(unitDef(RULESET, WARRIOR)?.movement);
    expect(state.nextUnitId).toBe(2);

    // The player list decides the civ count, not the settings patch — and the
    // count it decides is the number of *civilizations*: if the builder ever
    // appended the barbarian player `newGame` appends, `settings.civCount` must
    // not follow it upward.
    expect(state.settings.civCount).toBe(2);
    expect(state.settings.civCount).toBe(civPlayers(state).length);
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

/* ------------------------------------------------------------------ *
 * M3 acceptance evidence — growth timing, starvation, production, huts
 * ------------------------------------------------------------------ */

/**
 * M3's commands, spelled the way the REPL spells them, so a scenario's `run`
 * reads like a transcript rather than like a construction site.
 */
const endTurn = (): Command => ({ type: 'EndTurn' });
const endTurns = (count: number): readonly Command[] =>
  Array.from({ length: count }, () => endTurn());
const foundCity = (unitId: number): Command => ({ type: 'FoundCity', unitId: asUnitId(unitId) });
const setWorkedTiles = (cityId: number, tiles: readonly TileIndex[]): Command => ({
  type: 'SetWorkedTiles',
  cityId: asCityId(cityId),
  tiles,
});
const setProduction = (cityId: number, item: ProductionItem): Command => ({
  type: 'SetProduction',
  cityId: asCityId(cityId),
  item,
});

const SETTLER = asUnitTypeId('settler');
const GRANARY = asBuildingId('granary');
const NOT_A_BUILDING = asBuildingId('nope');

/** Player 2 in every M3 scenario that has a hut: the barbarian identity. */
const BARBARIANS = asPlayerId(2);

/**
 * Apply one command as Rome (player 0) and hand back the outcome, or `undefined`
 * when it was refused. These scenarios probe *inside* their `assert` callbacks —
 * "and then exactly one more turn does this" — the way the M2 movement scenario
 * probes its second and third steps, and a refusal there is a failure the
 * assertion messages report rather than a thrown error.
 */
const romeApply = (
  state: GameState,
  ruleset: RulesetView,
  command: Command,
): CommandOutcome | undefined => {
  const result = applyCommand(state, ROME, command, ruleset);
  return result.ok ? result.value : undefined;
};

/** `count` EndTurns as Rome, or `undefined` as soon as one is refused. */
const endTurnsFrom = (
  state: GameState,
  ruleset: RulesetView,
  count: number,
): GameState | undefined => {
  let current: GameState | undefined = state;
  for (let index = 0; index < count && current !== undefined; index += 1) {
    current = romeApply(current, ruleset, endTurn())?.state;
  }
  return current;
};

/** The position of the hut in the hut scenarios: one step east of the mover. */
const HUT_TILE = at(6, 5);

/**
 * M4b: the two ledger lines the money loop emits for **every** civilization on
 * **every** turn, and the `TurnEnded` the command layer appends after them.
 *
 * They are here, next to the M3 command spellings, because they changed what an
 * `EndTurn` puts in the event list: the M3 and M4a expectations below now name the
 * ledger lines explicitly rather than filtering them out. A helper that *hid* them
 * (by filtering the event list down to the types a test cares about) would let a
 * wrong amount, a missing player or a wrong order pass unnoticed, which is exactly
 * what those assertions exist to catch — so every list below still spells out the
 * amounts, one line per channel, per player, in player-id order.
 */
const incomeEvent = (
  playerId: PlayerId,
  gold: number,
  beakers: number,
  luxuries: number,
): GameEvent => ({ type: 'IncomeCollected', playerId, gold, beakers, luxuries });

const upkeepEvent = (
  playerId: PlayerId,
  gold: number,
  maintenance: number,
  unitSupport: number,
  units: number,
  freeUnits: number,
): GameEvent => ({
  type: 'UpkeepPaid',
  playerId,
  gold,
  maintenance,
  unitSupport,
  units,
  freeUnits,
});

/** `EndTurn` by Rome, as every M3/M4a scenario runs it. */
const turnEnded = (turn: number): GameEvent => ({ type: 'TurnEnded', playerId: ROME, turn });

/** `SetRates`, spelled as the REPL spells it (M4b's one new command). */
const setRates = (rates: Rates): Command => ({ type: 'SetRates', rates });

/* ------------------------------------------------------------------ *
 * 4. Growth timing and carry-over
 * ------------------------------------------------------------------ */

/**
 * GROWTH TIMING. A settler founds a city on open grassland and four turns later
 * the scenario stops: the box holds 8 of the 10 food a second citizen costs, so
 * every number below is *exactly one turn away* from a growth that has not
 * happened yet, and the growth turn itself is then probed.
 *
 * The arithmetic, all of it the engine's, from the shipped catalog's placeholder
 * yields (grassland 2 food / 1 shield, `FOOD_BOX_BASE` 10, `FOOD_BOX_PER_CITIZEN`
 * 5, `FOOD_PER_CITIZEN` 2):
 *
 * - the centre is always worked and free, and the auto-assigned citizen takes the
 *   lowest-index grassland in the 21-tile radius, so a one-citizen city makes
 *   2 + 2 = 4 food, eats 2, and carries a surplus of **2**;
 * - `foodBoxSize(1)` is 10, so the box reaches 10 on the **fifth** turn — the
 *   growth turn — and carries 10 - 10 = **0** over;
 * - at two citizens the city makes 6 food, eats 4, keeps a surplus of 2, and
 *   `foodBoxSize(2)` is 15, so the third citizen arrives on the **eighth** turn of
 *   that population (2 × 8 = 16) and the box carries **1** over. That 1 is the
 *   carry-over this scenario exists to pin: an implementation that reset the box
 *   on growth would leave 0 there, and one that reset it *after* the surplus
 *   would leave 2.
 *
 * Growth runs before production (`turn.ts`), so the growth turn's shields are
 * counted at the *new* population: 8 banked over four turns, then 1 + 1 + 1 = 3
 * on the fifth = **11**. An implementation that produced first would leave 10.
 */
const growthScenario = defineScenario({
  name: 'city-growth-timing-and-carry-over',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland') // 2 food, 1 shield a tile
      .addUnit(0, SETTLER, [5, 5])
      .addUnit(1, WARRIOR, [20, 20]),
  run: [foundCity(0), ...endTurns(4)],
  assert: (after, ruleset) => {
    const cityId = asCityId(0);
    const city = cityById(after, cityId);
    if (city === undefined) return [check(false, 'FoundCity left no city on the map')];

    const yields = cityYields(after, ruleset, cityId);
    const cityTile = at(5, 5);

    // The fifth turn: the growth turn.
    const fifth = romeApply(after, ruleset, endTurn());
    const grown = fifth?.state;
    const grownCity = grown === undefined ? undefined : cityById(grown, cityId);
    const grownEvent = fifth?.events.find((event) => event.type === 'CityGrew');

    // Seven more turns stop one food short (box 14 of 15) …
    const almost = grown === undefined ? undefined : endTurnsFrom(grown, ruleset, 7);
    const almostCity = almost === undefined ? undefined : cityById(almost, cityId);

    // … and the eighth grows again, this time with a remainder.
    const eighth = almost === undefined ? undefined : romeApply(almost, ruleset, endTurn());
    const third = eighth?.state;
    const thirdCity = third === undefined ? undefined : cityById(third, cityId);
    const thirdEvent = eighth?.events.find((event) => event.type === 'CityGrew');

    return [
      check(
        city.population === 1 && city.workedTiles.length === 1,
        `the young city has 1 citizen working 1 tile (got ${String(city.population)} citizen(s) and ${String(city.workedTiles.length)} worked tile(s))`,
      ),
      check(
        after.turn === 5 && city.foodBox === 8,
        `after four turns the box holds 8 of the 10 food a second citizen costs, so the next turn is the growth turn (turn ${String(after.turn)}, box ${String(city.foodBox)})`,
      ),
      check(
        foodBoxSize(1) === 10 && yields.food === 4 && yields.foodSurplus === 2,
        `the growth arithmetic: a grassland centre plus one grassland tile is 4 food, 2 citizens' worth is eaten, so the surplus is 2 and the box is 10 long (got food ${String(yields.food)}, surplus ${String(yields.foodSurplus)}, box size ${String(foodBoxSize(1))})`,
      ),
      check(
        cityAt(after, cityTile)?.id === cityId && after.cities.length === 1,
        `the city stands on ${label(5, 5)} and it is the only one (cities: ${String(after.cities.length)})`,
      ),
      check(
        grownCity !== undefined && grown !== undefined && grown.turn === 6,
        `the city grew on the fifth turn: the state is at turn 6 (got ${String(grown?.turn)})`,
      ),
      check(
        grownCity !== undefined && grownCity.population === 2 && grownCity.workedTiles.length === 2,
        `population 1 -> 2, and the second citizen was assigned a tile (got ${String(grownCity?.population)} citizen(s) and ${String(grownCity?.workedTiles.length)} worked tile(s))`,
      ),
      check(
        grownCity !== undefined && grownCity.foodBox === 0,
        `the box carries 10 - 10 = 0 over, so nothing is lost and nothing is invented (got ${String(grownCity?.foodBox)})`,
      ),
      check(
        grownEvent !== undefined &&
          grownEvent.cityId === cityId &&
          grownEvent.owner === ROME &&
          grownEvent.population === 2 &&
          grownEvent.foodBox === 0,
        `the engine's own account of the growth: CityGrew(city 0, Rome, population 2, foodBox 0) (got ${JSON.stringify(grownEvent)})`,
      ),
      check(
        grownCity !== undefined && grownCity.shields === 11,
        `growth ran before production: 8 shields banked at one citizen, then 3 at two = 11 (got ${String(grownCity?.shields)}; producing first would leave 10)`,
      ),
      check(
        almostCity !== undefined && almost !== undefined && almost.turn === 13,
        `seven turns later the state is at turn 13 (got ${String(almost?.turn)})`,
      ),
      check(
        almostCity !== undefined && almostCity.population === 2 && almostCity.foodBox === 14,
        `the box holds 14 of the 15 food a third citizen costs, so it has NOT grown yet (population ${String(almostCity?.population)}, box ${String(almostCity?.foodBox)})`,
      ),
      check(
        thirdCity !== undefined && third !== undefined && third.turn === 14,
        `the third citizen arrived on the eighth turn of that population: the state is at turn 14 (got ${String(third?.turn)})`,
      ),
      check(
        thirdCity !== undefined && thirdCity.population === 3 && thirdCity.workedTiles.length === 3,
        `population 2 -> 3, with a third tile assigned (got ${String(thirdCity?.population)} citizen(s) and ${String(thirdCity?.workedTiles.length)} worked tile(s))`,
      ),
      check(
        thirdCity !== undefined && thirdCity.foodBox === 1,
        `the box carries the leftover over: 16 - 15 = 1, and 1 is not 0 (got ${String(thirdCity?.foodBox)})`,
      ),
      check(
        thirdEvent !== undefined && thirdEvent.population === 3 && thirdEvent.foodBox === 1,
        `CityGrew(city 0, population 3, foodBox 1) is the engine's account of it (got ${JSON.stringify(thirdEvent)})`,
      ),
      check(
        thirdCity !== undefined && thirdCity.shields === 36,
        `shields at turn 14: 32 banked by then plus 4 at three citizens = 36 (got ${String(thirdCity?.shields)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 5. Starvation
 * ------------------------------------------------------------------ */

/**
 * STARVATION. A city is founded on **plains** (1 food, 2 shields at the centre)
 * so that once its citizens are unassigned it cannot feed them: the centre's
 * 1 food against 2 food per citizen is a deficit of 3 at two citizens and 1 at
 * one, and the box can never climb out of it.
 *
 * The timeline, exactly:
 *
 * 1. at one citizen, with the auto-assigned grassland tile, the city makes
 *    1 + 2 = 3 food and eats 2, so it grows by 1 a turn and reaches
 *    `foodBoxSize(1) = 10` on the **tenth** turn — turn 11, box 0, population 2;
 * 2. `SetWorkedTiles(city, [])` then unassigns both citizens: the city makes the
 *    centre's 1 food, needs 4, and runs a deficit of 3 with an empty box;
 * 3. the **eleventh** turn therefore takes a citizen (population 2 -> 1, box
 *    restarts at 0) — the turn this scenario pins;
 * 4. at one citizen the deficit is still 1 a turn, so every later turn takes
 *    another citizen *if it could*: the population stays at 1 for ever and the
 *    box restarts at 0 each time. That is the floor, and it is asserted on five
 *    consecutive turns rather than once.
 */
const starvationScenario = defineScenario({
  name: 'city-starvation-takes-a-citizen-and-never-falls-below-one',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(5, 5, 'plains') // the city site: 1 food, 2 shields
      .addUnit(0, SETTLER, [5, 5])
      .addUnit(1, WARRIOR, [20, 20]),
  run: [foundCity(0), ...endTurns(10), setWorkedTiles(0, [])],
  assert: (after, ruleset) => {
    const cityId = asCityId(0);
    const city = cityById(after, cityId);
    if (city === undefined) return [check(false, 'FoundCity left no city on the map')];

    const yields = cityYields(after, ruleset, cityId);

    // The starvation turn: the eleventh.
    const starved = romeApply(after, ruleset, endTurn());
    const afterStarve = starved?.state;
    const starvedCity = afterStarve === undefined ? undefined : cityById(afterStarve, cityId);
    const starveEvent = starved?.events.find((event) => event.type === 'CityStarved');

    // Five more deficit turns: the population must not fall any further.
    const later: (City | undefined)[] = [];
    let cursor = afterStarve;
    let starveEvents = 0;
    let floorHeld = true;
    for (let index = 0; index < 5 && cursor !== undefined; index += 1) {
      const turn = romeApply(cursor, ruleset, endTurn());
      const city2 = turn === undefined ? undefined : cityById(turn.state, cityId);
      later.push(city2);
      starveEvents += turn?.events.filter((event) => event.type === 'CityStarved').length ?? 0;
      if (city2 !== undefined && (city2.population < 1 || city2.foodBox !== 0)) floorHeld = false;
      cursor = turn?.state;
    }

    return [
      check(
        after.turn === 11 && city.population === 2 && city.foodBox === 0,
        `the city reached 2 citizens on the tenth turn (turn ${String(after.turn)}, population ${String(city.population)}, box ${String(city.foodBox)})`,
      ),
      check(
        city.workedTiles.length === 0,
        `SetWorkedTiles left it working no tiles at all, so its 2 citizens produce nothing (worked ${String(city.workedTiles.length)} tile(s))`,
      ),
      check(
        yields.food === 1 && yields.foodSurplus === -3,
        `a plains centre alone is 1 food against 2 per citizen, so the surplus is -3 and the empty box goes below zero (got food ${String(yields.food)}, surplus ${String(yields.foodSurplus)})`,
      ),
      check(
        starvedCity !== undefined && afterStarve !== undefined && afterStarve.turn === 12,
        `the citizen is lost on the eleventh turn: the state is at turn 12 (got ${String(afterStarve?.turn)})`,
      ),
      check(
        starvedCity !== undefined && starvedCity.population === 1,
        `population 2 -> 1: exactly one citizen went, because one deficit turn costs one citizen (got ${String(starvedCity?.population)})`,
      ),
      check(
        starvedCity !== undefined && starvedCity.foodBox === 0,
        `the food box restarts at 0 rather than going on at -3 (got ${String(starvedCity?.foodBox)})`,
      ),
      check(
        starveEvent !== undefined &&
          starveEvent.cityId === cityId &&
          starveEvent.owner === ROME &&
          starveEvent.population === 1 &&
          starveEvent.foodBox === 0,
        `the engine's own account: CityStarved(city 0, Rome, population 1, foodBox 0) (got ${JSON.stringify(starveEvent)})`,
      ),
      check(
        starvedCity !== undefined && starvedCity.workedTiles.length === 0,
        `the assignment was trimmed with the citizen: 0 worked tiles for 1 citizen (got ${String(starvedCity?.workedTiles.length)})`,
      ),
      check(
        later.length === 5 && later.every((entry) => entry !== undefined && entry.population === 1),
        `five further deficit turns leave the population at 1 — it never falls below 1 (populations: ${later.map((entry) => String(entry?.population)).join(', ')})`,
      ),
      check(
        floorHeld,
        `every one of those turns restarts the box at 0 and none of them reaches population 0 (boxes: ${later.map((entry) => String(entry?.foodBox)).join(', ')})`,
      ),
      check(
        starveEvents === 5,
        `each of those five turns starved again, so the floor is being tested by a continuing deficit and not by a city that recovered (CityStarved events: ${String(starveEvents)})`,
      ),
      check(
        afterStarve !== undefined &&
          cityYields(afterStarve, ruleset, cityId).foodSurplus === -1 &&
          afterStarve.cities.length === 1,
        `at one citizen the deficit is still 1 (1 food against 2), and the city is still Rome's only one (surplus ${String(afterStarve === undefined ? 'no state' : cityYields(afterStarve, ruleset, cityId).foodSurplus)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 6. Production
 * ------------------------------------------------------------------ */

/**
 * PRODUCTION. A hand-built city (the queue is what the DSL had to learn: M3
 * ships no command that appends to one) is building a **settler** (3 shields)
 * with a **warrior** (1 shield) queued behind it, and works one grassland tile,
 * so it banks exactly 2 shields a turn.
 *
 * The timeline, exactly:
 *
 * 1. turn 2: 2 shields, one short of the settler's 3, so nothing is finished;
 * 2. turn 3: 2 + 2 = 4 >= 3 — the settler completes, 1 shield is carried over,
 *    the unit appears on the city centre at full movement (2), and the **queue**
 *    promotes the warrior to the head;
 * 3. turn 4: 1 + 2 = 3 >= 1 — the warrior completes, 2 shields are carried over,
 *    and with the queue empty the city is building nothing at all: `production`
 *    is *absent* from the city, never present-and-`undefined` (a present
 *    `undefined` cannot survive canonical JSON, so the state would be
 *    unhashable — the trap `City.production` documents);
 * 4. turn 5: 2 + 2 = 4 shields are simply stored, because an empty queue with
 *    shields banked is legal and completing nothing is not an error.
 */
const PRODUCTION_CITY = at(5, 5);

const productionScenario = defineScenario({
  name: 'city-production-completes-a-unit-and-promotes-the-queue',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, WARRIOR, [30, 30]) // Rome's starting tile, far from the city
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], {
        population: 1,
        // A grassland centre plus one grassland tile: 4 food (a surplus of 2, so
        // growth is 10 turns away) and 2 shields.
        workedTiles: [at(4, 3)],
        production: { kind: 'unit', id: SETTLER }, // 3 shields
        queue: [{ kind: 'unit', id: WARRIOR }], // 1 shield
      }),
  run: [endTurn(), endTurn()],
  assert: (after, ruleset) => {
    const cityId = asCityId(0);
    const city = cityById(after, cityId);
    if (city === undefined) return [check(false, 'addCity left no city on the map')];

    const settlerDef = unitDef(ruleset, SETTLER);
    const warriorDef = unitDef(ruleset, WARRIOR);
    const spawned = after.units[2];
    const yields = cityYields(after, ruleset, cityId);

    // The third turn: the queued warrior is now the head, and it finishes too.
    const third = romeApply(after, ruleset, endTurn());
    const afterThird = third?.state;
    const thirdCity = afterThird === undefined ? undefined : cityById(afterThird, cityId);
    const thirdEvent = third?.events.find((event) => event.type === 'CityProduced');

    // The fourth turn: an empty queue simply banks its shields.
    const fourth = afterThird === undefined ? undefined : romeApply(afterThird, ruleset, endTurn());
    const afterFourth = fourth?.state;
    const fourthCity = afterFourth === undefined ? undefined : cityById(afterFourth, cityId);

    return [
      check(
        settlerDef !== undefined &&
          warriorDef !== undefined &&
          settlerDef.cost === 3 &&
          warriorDef.cost === 1,
        `the catalog prices the settler at 3 shields and the queued warrior at 1 (got ${String(settlerDef?.cost)} and ${String(warriorDef?.cost)})`,
      ),
      check(
        yields.shields === 2 && yields.foodSurplus === 2,
        `the city banks 2 shields a turn on one worked grassland tile, and eats its food surplus (got ${String(yields.shields)} shields, surplus ${String(yields.foodSurplus)})`,
      ),
      check(
        after.turn === 3 && city.shields === 1,
        `the settler completed on the second turn — the state is at turn 3 — and 4 - 3 = 1 shield was carried over (turn ${String(after.turn)}, shields ${String(city.shields)})`,
      ),
      check(
        after.units.length === 3 && spawned !== undefined && spawned.type === SETTLER,
        `the completed unit exists (units: ${after.units.map((unit) => `${String(unit.id)}:${unit.type}`).join(', ')})`,
      ),
      check(
        spawned !== undefined &&
          spawned.owner === ROME &&
          spawned.tile === PRODUCTION_CITY &&
          spawned.movementLeft === (settlerDef?.movement ?? -1),
        `it is Rome's, it stands on the city centre ${label(5, 5)}, and it has full movement (${String(settlerDef?.movement)}) (owner ${String(spawned?.owner)}, tile ${String(spawned?.tile)}, movement ${String(spawned?.movementLeft)})`,
      ),
      check(
        spawned !== undefined && spawned.id === asUnitId(2) && after.nextUnitId === 3,
        `ids are dense creation order: the new unit is 2 and nextUnitId is 3 (id ${String(spawned?.id)}, next ${String(after.nextUnitId)})`,
      ),
      check(
        city.production !== undefined &&
          city.production.kind === 'unit' &&
          city.production.id === WARRIOR,
        `the next queue entry became the city's current item: it is building the warrior now (got ${JSON.stringify(city.production)})`,
      ),
      check(
        city.queue.length === 0,
        `the built item left the queue and the promoted one was not also left in it (queue: ${JSON.stringify(city.queue)})`,
      ),
      check(
        after.revision === 2 && after.cities.length === 1,
        `two applied commands, one city (revision ${String(after.revision)}, cities ${String(after.cities.length)})`,
      ),
      check(
        thirdCity !== undefined && afterThird !== undefined && afterThird.turn === 4,
        `the third turn is the state at turn 4 (got ${String(afterThird?.turn)})`,
      ),
      check(
        thirdCity !== undefined && thirdCity.shields === 2,
        `1 banked + 2 earned - 1 for the warrior = 2 shields carried over (got ${String(thirdCity?.shields)})`,
      ),
      check(
        thirdCity !== undefined &&
          !Object.hasOwn(thirdCity, 'production') &&
          thirdCity.queue.length === 0,
        `with the queue empty the city is building nothing, and the key is ABSENT rather than holding undefined (keys: ${thirdCity === undefined ? 'no city' : Object.keys(thirdCity).join(', ')})`,
      ),
      check(
        afterThird !== undefined &&
          afterThird.units.length === 4 &&
          afterThird.units[3]?.type === WARRIOR,
        `the warrior also appeared on the centre, with dense id 3 (units: ${afterThird === undefined ? 'no state' : afterThird.units.map((unit) => `${String(unit.id)}:${unit.type}`).join(', ')})`,
      ),
      check(
        thirdEvent !== undefined &&
          thirdEvent.item.kind === 'unit' &&
          thirdEvent.item.id === WARRIOR &&
          thirdEvent.shields === 2,
        `CityProduced(warrior, shields 2) is the engine's account of the second completion (got ${JSON.stringify(thirdEvent)})`,
      ),
      check(
        fourthCity !== undefined &&
          afterFourth !== undefined &&
          afterFourth.turn === 5 &&
          fourthCity.shields === 4,
        `an empty queue with shields banked is legal: the fourth turn just stores 2 + 2 = 4 (turn ${String(afterFourth?.turn)}, shields ${String(fourthCity?.shields)})`,
      ),
      check(
        fourth !== undefined && fourth.events.every((event) => event.type !== 'CityProduced'),
        `and it completed nothing, because there is nothing to complete (events: ${JSON.stringify(fourth?.events)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 7. Goody huts — one branch per fixed seed
 * ------------------------------------------------------------------ */

/**
 * The reward a hut on a fixed seed must give. One seed exercises one branch, so
 * the branch is not something a scenario can choose: it is
 * `nextBelow(state.rng, HUT_REWARD_KINDS.length)` on the state's own RNG, which
 * `build()` seeds from `settings.seed` and nothing else touches before the step.
 * The three named seeds below were read off that draw (0 -> nothing,
 * 1 -> unit, 11 -> barbarians) and the sweep test pins the whole table for seeds
 * 0..11, so a change to the reward table or to the RNG cannot pass unnoticed.
 */
interface HutCase {
  readonly seed: number;
  readonly reward: HutRewardKind;
}

const HUT_UNIT_CASE: HutCase = { seed: 1, reward: 'unit' };
const HUT_BARBARIAN_CASE: HutCase = { seed: 11, reward: 'barbarians' };
const HUT_NOTHING_CASE: HutCase = { seed: 0, reward: 'nothing' };
const HUT_CASES: readonly HutCase[] = [HUT_UNIT_CASE, HUT_BARBARIAN_CASE, HUT_NOTHING_CASE];

/**
 * Where a hut's band lands: the two lowest-index tiles adjacent to the hut that
 * a land unit may stand on and that hold no unit of another player. The mover
 * itself rules out `(5, 5)`, which is what makes the band's positions (5, 4) and
 * (6, 4) rather than the first two neighbours by index.
 */
const BAND_TILES: readonly TileIndex[] = [at(5, 4), at(6, 4)];

/** The branch the state's own RNG selects on `seed` — computed, never guessed. */
const drawnReward = (seed: number): HutRewardKind =>
  HUT_REWARD_KINDS[nextBelow(seedRng(seed), HUT_REWARD_KINDS.length)[0]] ?? 'nothing';

/**
 * HUTS. Rome's warrior stands one step west of a goody hut and steps onto it;
 * the branch is the seed's, and each branch's effect is asserted exactly:
 * a free unit with its owner and tile, a band with its count and positions, or
 * nothing granted *while the hut is consumed anyway*.
 *
 * The world is otherwise inert: grassland everywhere (cost 1, so the step is
 * affordable and nothing about terrain enters the assertion), Carthage's warrior
 * far away, and a barbarian player with no units of its own.
 */
const hutScenario = (testCase: HutCase): Scenario =>
  defineScenario({
    name: `hut-reward-${testCase.reward}-on-seed-${String(testCase.seed)}`,
    settings: { mapSize: 'duel', seed: testCase.seed },
    setup: (b) =>
      b
        .addPlayer('Rome')
        .addPlayer('Carthage')
        .addBarbarianPlayer()
        .fillTerrain('grassland')
        .addHut(6, 5)
        .addUnit(0, WARRIOR, [5, 5])
        .addUnit(1, WARRIOR, [20, 20]),
    run: [move(0, HUT_TILE)],
    assert: (after, ruleset) => {
      const warriorDef = unitDef(ruleset, WARRIOR);
      const mover = unitById(after, asUnitId(0));
      const carthage = unitById(after, asUnitId(1));
      const barbarians = after.units.filter((unit) => unit.owner === BARBARIANS);
      const ids = after.units.map((unit) => unit.id);
      const owners = after.units.map((unit) => unit.owner);
      const tiles = after.units.map((unit) => unit.tile);
      const expectedRng = nextBelow(seedRng(testCase.seed), HUT_REWARD_KINDS.length)[1];

      const common: readonly ScenarioAssertion[] = [
        check(
          mover !== undefined && mover.tile === HUT_TILE && mover.movementLeft === 0,
          `the warrior stepped onto the hut at ${label(6, 5)} and spent its movement (tile ${String(mover?.tile)}, movement ${String(mover?.movementLeft)})`,
        ),
        check(
          !hutAt(after, HUT_TILE) && after.map.huts.length === 0,
          `the hut is gone from the map whatever the reward was — a hut is consumed by being entered (huts left: ${String(after.map.huts.length)})`,
        ),
        check(
          after.rng.a === expectedRng.a &&
            after.rng.b === expectedRng.b &&
            after.rng.c === expectedRng.c &&
            after.rng.d === expectedRng.d,
          `exactly one draw came off the state RNG: ${JSON.stringify(after.rng)} is seed ${String(testCase.seed)}'s stream after one draw (${JSON.stringify(expectedRng)})`,
        ),
        check(
          after.revision === 1 && after.turn === 1,
          `one command was applied and no turn passed (revision ${String(after.revision)}, turn ${String(after.turn)})`,
        ),
        check(
          carthage !== undefined && carthage.tile === at(20, 20) && carthage.owner === CARTHAGE,
          `Carthage's warrior did not stir (tile ${String(carthage?.tile)})`,
        ),
        check(
          after.players.filter((player) => player.kind === 'barbarian').length === 1,
          `the world still has exactly one barbarian player, and it is a player rather than a special case (${JSON.stringify(after.players.map((player) => player.kind))})`,
        ),
      ];

      if (testCase.reward === 'unit') {
        const free = after.units[2];
        return [
          ...common,
          check(
            after.units.length === 3 && free !== undefined,
            `a free unit was granted: 2 units became 3 (units: ${after.units.map((unit) => `${String(unit.id)}:${unit.type}`).join(', ')})`,
          ),
          check(
            free !== undefined &&
              free.id === asUnitId(2) &&
              free.type === WARRIOR &&
              free.owner === ROME &&
              free.tile === HUT_TILE &&
              free.movementLeft === (warriorDef?.movement ?? -1),
            `it is Rome's (the *finder's* owner, not the barbarians'), it stands on the hut tile beside the mover, and it has full movement (${JSON.stringify(free)})`,
          ),
          check(
            after.nextUnitId === 3 && barbarians.length === 0,
            `the id counter moved past it and no barbarian appeared (nextUnitId ${String(after.nextUnitId)}, barbarian units ${String(barbarians.length)})`,
          ),
        ];
      }

      if (testCase.reward === 'barbarians') {
        const walk = warriorDef?.movement ?? -1;
        return [
          ...common,
          check(
            after.units.length === 4 && barbarians.length === 2,
            `a band of 2 barbarians was spawned (units ${String(after.units.length)}, barbarian units ${String(barbarians.length)})`,
          ),
          check(
            ids.length === 4 &&
              ids[0] === asUnitId(0) &&
              ids[1] === asUnitId(1) &&
              ids[2] === asUnitId(2) &&
              ids[3] === asUnitId(3),
            `the band's units took the next free ids, 2 and 3, in creation order (ids: ${ids.map(String).join(', ')})`,
          ),
          check(
            owners.length === 4 &&
              owners[0] === ROME &&
              owners[1] === CARTHAGE &&
              owners[2] === BARBARIANS &&
              owners[3] === BARBARIANS,
            `both are the barbarian player's, and nobody else's (owners: ${owners.map(String).join(', ')})`,
          ),
          check(
            barbarians.length === 2 &&
              tiles[2] === BAND_TILES[0] &&
              tiles[3] === BAND_TILES[1] &&
              barbarians[0]?.tile === BAND_TILES[0] &&
              barbarians[1]?.tile === BAND_TILES[1],
            `the band stands on the two lowest-index standable neighbours of the hut, ${label(5, 4)} and ${label(6, 4)} (tiles: ${tiles.map(String).join(', ')})`,
          ),
          check(
            barbarians.every((unit) => unit.type === WARRIOR && unit.movementLeft === walk),
            `they are ordinary units of the catalog's first military land type at full movement (${String(walk)}), so movement and M6's combat need no special case (${JSON.stringify(barbarians)})`,
          ),
          check(
            barbarians.every((unit) => unit.tile !== HUT_TILE) && after.nextUnitId === 4,
            `none of them was placed on the hut tile the finder is standing on, and the id counter is 4 (nextUnitId ${String(after.nextUnitId)})`,
          ),
        ];
      }

      return [
        ...common,
        check(
          after.units.length === 2 && barbarians.length === 0,
          `nothing was granted: the world still holds the two starting units (units ${String(after.units.length)}, barbarian units ${String(barbarians.length)})`,
        ),
        check(
          tiles[0] === HUT_TILE &&
            tiles[1] === at(20, 20) &&
            owners[0] === ROME &&
            owners[1] === CARTHAGE,
          `the two units are exactly where they were, apart from the step onto the hut (tiles ${tiles.map(String).join(', ')})`,
        ),
        check(
          after.nextUnitId === 2,
          `no unit was created, so the id counter did not move (nextUnitId ${String(after.nextUnitId)})`,
        ),
        check(
          after.map.huts.length === 0,
          'and the hut is spent all the same: "nothing" is a reward, not a non-event',
        ),
      ];
    },
  });

/* ------------------------------------------------------------------ *
 * M3 scenarios, as tests
 * ------------------------------------------------------------------ */

describe('M3 scenario: growth timing and carry-over', () => {
  it('grows on the exact turn the box fills, and carries the remainder into the next one', () => {
    const result = runScenario(growthScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the growth scenario must build a state');

    // Four turns of the scripted run, and nothing in them grew the city.
    expect(after.turn).toBe(5);
    expect(cityById(after, asCityId(0))?.population).toBe(1);
    expect(cityById(after, asCityId(0))?.foodBox).toBe(8);
    // `FoundCity` is the run's first command, so its own event leads the list. Each
    // of the four turns then adds the M4b ledger lines of both civilizations —
    // Carthage's are zeroes (it owns no city), but a complete stream is what makes
    // "income minus upkeep equals the delta" checkable from events alone.
    expect(result.events.map((event) => event.type)).toEqual([
      'CityFounded',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
      'IncomeCollected',
      'UpkeepPaid',
      'IncomeCollected',
      'UpkeepPaid',
      'TurnEnded',
    ]);
    // Rome's one city makes 2 commerce (grassland centre 1 + the one worked
    // grassland 1) at the default 6/4/0: floor(2*6/10) = 1 gold, floor(2*4/10) = 0
    // beakers, 0 luxuries, and the leftover 1 is gold — 2 gold a turn, and nothing
    // to support (the settler became the city, so Rome owns no unit).
    const romeLine: readonly GameEvent[] = [
      incomeEvent(ROME, 2, 0, 0),
      upkeepEvent(ROME, 0, 0, 0, 0, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
    ];
    expect(result.events).toEqual([
      {
        type: 'CityFounded',
        cityId: asCityId(0),
        owner: ROME,
        name: 'City 1',
        tile: at(5, 5),
      },
      ...romeLine,
      turnEnded(2),
      ...romeLine,
      turnEnded(3),
      ...romeLine,
      turnEnded(4),
      ...romeLine,
      turnEnded(5),
    ]);
  });

  it('walks every turn outside the runner and shows the whole box sequence', () => {
    // The same world, stepped by hand: the point is the box *at each turn*, so a
    // growth that happened one turn early (or a box that reset when it should
    // have carried over) has nowhere to hide.
    const built = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SETTLER, [5, 5])
      .addUnit(1, WARRIOR, [20, 20])
      .build();
    if (!built.ok) throw new Error(`the growth fixture must build: ${JSON.stringify(built.error)}`);

    const founded = romeApply(built.value, RULESET, foundCity(0));
    if (founded === undefined) throw new Error('FoundCity must apply to the growth fixture');
    expect(founded.state.turn).toBe(1);

    const boxes: number[] = [];
    const populations: number[] = [];
    let state = founded.state;
    for (let turn = 0; turn < 14; turn += 1) {
      state = endTurnsFrom(state, RULESET, 1) ?? state;
      const city = cityById(state, asCityId(0));
      boxes.push(city?.foodBox ?? -1);
      populations.push(city?.population ?? -1);
    }

    // Turn by turn: five turns to the second citizen, eight more to the third,
    // and every value in between exactly as the surplus arithmetic says.
    expect(populations).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3]);
    expect(boxes).toEqual([2, 4, 6, 8, 0, 2, 4, 6, 8, 10, 12, 14, 1, 3]);
    expect(state.turn).toBe(15);
  });
});

describe('M3 scenario: starvation', () => {
  it('takes exactly one citizen on the exact turn the box would go negative, and stops at 1', () => {
    const result = runScenario(starvationScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the starvation scenario must build a state');

    // Ten turns of feeding, then the unassignment: the city is at its peak here.
    expect(after.turn).toBe(11);
    expect(result.events.filter((event) => event.type === 'CityGrew')).toEqual([
      { type: 'CityGrew', cityId: asCityId(0), owner: ROME, population: 2, foodBox: 0 },
    ]);
    expect(after.cities).toHaveLength(1);
    expect(cityById(after, asCityId(0))?.population).toBe(2);

    // Outside the runner: one turn takes a citizen, and the floor holds after it.
    const starved = romeApply(after, RULESET, endTurn());
    if (starved === undefined) throw new Error('EndTurn must apply');
    expect(starved.state.turn).toBe(12);
    expect(starved.events).toEqual([
      { type: 'CityStarved', cityId: asCityId(0), owner: ROME, population: 1, foodBox: 0 },
      // M4b: a starving city that works nothing still has its centre's commerce —
      // the plains centre is 1/2/1, so 1 commerce at 6/4/0 floors to 0 gold and 0
      // beakers and the leftover 1 becomes gold. Rome owns no unit (its settler
      // became the city) and Carthage's single warrior is inside its free
      // allowance of `FREE_UNITS_PER_CITY * 0 + FREE_UNITS_BASE = 4`.
      incomeEvent(ROME, 1, 0, 0),
      upkeepEvent(ROME, 0, 0, 0, 0, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(12),
    ]);
    expect(cityById(starved.state, asCityId(0))).toMatchObject({
      population: 1,
      foodBox: 0,
      workedTiles: [],
    });

    let state = starved.state;
    for (let turn = 0; turn < 10; turn += 1) {
      const next = romeApply(state, RULESET, endTurn());
      if (next === undefined) throw new Error('EndTurn must apply to a starving city too');
      const city = cityById(next.state, asCityId(0));
      expect(city?.population).toBe(1);
      expect(city?.foodBox).toBe(0);
      state = next.state;
    }
    expect(state.turn).toBe(22);
  });
});

describe('M3 scenario: production', () => {
  it('completes a unit on the exact turn it is paid for, carries shields over, and promotes the queue', () => {
    const result = runScenario(productionScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the production scenario must build a state');

    expect(after.turn).toBe(3);
    // Only the second turn produced anything, and the pipeline's own order shows:
    // the world's events first (production, then M4b's money step), then the
    // command layer's `TurnEnded`. The settler is added to `units` *before* the
    // money step, so the turn it appears is the turn its owner starts counting it
    // — Rome's `units` count is 2 on that turn, not 1.
    expect(result.events).toEqual([
      incomeEvent(ROME, 2, 0, 0),
      upkeepEvent(ROME, 0, 0, 0, 1, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(2),
      {
        type: 'CityProduced',
        cityId: asCityId(0),
        owner: ROME,
        item: { kind: 'unit', id: SETTLER },
        shields: 1,
        unitId: asUnitId(2),
        tile: PRODUCTION_CITY,
      },
      incomeEvent(ROME, 2, 0, 0),
      upkeepEvent(ROME, 0, 0, 0, 2, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(3),
    ]);

    // The queue promotion and the carried-over shield, on the state itself.
    expect(cityById(after, asCityId(0))?.production).toEqual({ kind: 'unit', id: WARRIOR });
    expect(cityById(after, asCityId(0))?.shields).toBe(1);
    expect(after.units.map((unit) => unit.type)).toEqual([WARRIOR, WARRIOR, SETTLER]);
  });

  it('leaves no `production` key behind when the queue runs dry, so the state stays hashable', () => {
    const result = runScenario(productionScenario);
    const after = result.finalState;
    if (after === undefined) throw new Error('the production scenario must build a state');

    const third = romeApply(after, RULESET, endTurn());
    if (third === undefined) throw new Error('EndTurn must apply');
    const city = cityById(third.state, asCityId(0));
    if (city === undefined) throw new Error('the city must still exist');

    // The trap this pins: `{ production: undefined }` is unhashable, so the key
    // must be absent — and the absent spelling must survive a JSON round trip.
    expect('production' in city).toBe(false);
    expect(Object.keys(city)).not.toContain('production');
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashValue(third.state)).toMatch(/^[0-9a-f]{16}$/);

    const roundTripped: unknown = JSON.parse(JSON.stringify(third.state));
    expect(hashValue(roundTripped)).toBe(hashValue(third.state));
  });

  it('is driven by SetProduction too, and a redirect keeps the shields already banked', () => {
    // The command path rather than the builder: a city that has banked 3 shields
    // is switched to a building it does not have. The pool is the city's, not the
    // item's, so the redirect must leave those 3 shields exactly where they were,
    // and asking for something already built is a typed refusal, not a no-op.
    const built = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, WARRIOR, [30, 30])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], { population: 1, shields: 3, workedTiles: [at(4, 3)] })
      .build();
    if (!built.ok)
      throw new Error(`the production fixture must build: ${JSON.stringify(built.error)}`);

    const armed = romeApply(
      built.value,
      RULESET,
      setProduction(0, { kind: 'building', id: GRANARY }),
    );
    if (armed === undefined) throw new Error('SetProduction must apply');
    expect(armed.state.revision).toBe(1);
    expect(armed.events).toEqual([]); // M3's setters emit no event: the command is the record
    expect(cityById(armed.state, asCityId(0))?.production).toEqual({
      kind: 'building',
      id: GRANARY,
    });
    // The redirect cost the city nothing: its 3 banked shields are untouched.
    expect(cityById(armed.state, asCityId(0))?.shields).toBe(3);

    // Two shields a turn against a granary's 10: 3 + 2 + 2 + 2 = 9 after three
    // turns, one short of the price …
    const thirdTurn = endTurnsFrom(armed.state, RULESET, 3);
    expect(thirdTurn?.turn).toBe(4);
    expect(cityById(thirdTurn ?? armed.state, asCityId(0))?.shields).toBe(9);
    expect(cityById(thirdTurn ?? armed.state, asCityId(0))?.buildings).toEqual([]);
    expect(cityById(thirdTurn ?? armed.state, asCityId(0))?.production).toEqual({
      kind: 'building',
      id: GRANARY,
    });

    // … and the fourth turn pays for it: 9 + 2 = 11 >= 10, with 1 shield carried
    // over and an empty queue, so the city is building nothing again.
    const fourthTurn = thirdTurn === undefined ? undefined : endTurnsFrom(thirdTurn, RULESET, 1);
    expect(fourthTurn?.turn).toBe(5);
    expect(cityById(fourthTurn ?? armed.state, asCityId(0))?.buildings).toEqual([GRANARY]);
    expect(cityById(fourthTurn ?? armed.state, asCityId(0))?.shields).toBe(1);
    expect(cityById(fourthTurn ?? armed.state, asCityId(0))?.production).toBeUndefined();

    if (fourthTurn === undefined) throw new Error('the fourth turn must apply');
    const again = applyCommand(
      fourthTurn,
      ROME,
      setProduction(0, { kind: 'building', id: GRANARY }),
      RULESET,
    );
    expect(again.ok).toBe(false);
    expect(again.ok ? undefined : again.error).toEqual({
      kind: 'already-built',
      cityId: asCityId(0),
      building: GRANARY,
    });

    // A city that banked shields with nothing to build is not an error: one more
    // turn stores them. That turn is also the growth turn (the box reaches 10), so
    // the city earns at two citizens — 1 + 3 = 4 — because growth runs first.
    const idle = endTurnsFrom(fourthTurn, RULESET, 1);
    expect(idle?.turn).toBe(6);
    expect(cityById(idle ?? fourthTurn, asCityId(0))?.shields).toBe(4);
  });
});
describe('M3 scenario: goody huts', () => {
  it('declares its reward table and says plainly that it is unsourced', () => {
    // `gold` is deliberately absent in M3 (there is no treasury until M4), and the
    // split itself is ours — not a Civ 3 number anyone verified.
    expect(HUT_REWARD_KINDS).toEqual(['unit', 'barbarians', 'nothing']);
    expect(isPlaceholder(HUT_REWARD_PROVENANCE)).toBe(true);
  });

  it(`seed ${String(HUT_UNIT_CASE.seed)} grants a free unit`, () => {
    const result = runScenario(hutScenario(HUT_UNIT_CASE));

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the hut scenario must build a state');
    expect(
      after.units.map((unit) => `${String(unit.id)}:${unit.type}:${String(unit.owner)}`),
    ).toEqual(['0:warrior:0', '1:warrior:1', '2:warrior:0']);
    expect(result.events).toEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: at(5, 5),
        to: HUT_TILE,
        cost: 1,
        movementLeft: 0,
      },
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: ROME,
        tile: HUT_TILE,
        reward: 'unit',
        unitGiven: asUnitId(2),
      },
    ]);
  });

  it(`seed ${String(HUT_BARBARIAN_CASE.seed)} spawns a barbarian band`, () => {
    const result = runScenario(hutScenario(HUT_BARBARIAN_CASE));

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the hut scenario must build a state');
    const band = after.units.filter((unit) => unit.owner === BARBARIANS);
    expect(band.map((unit) => [Number(unit.id), Number(unit.tile)])).toEqual([
      [2, Number(BAND_TILES[0])],
      [3, Number(BAND_TILES[1])],
    ]);
    expect(band.every((unit) => unit.type === WARRIOR && unit.movementLeft === 1)).toBe(true);
    expect(result.events).toEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: at(5, 5),
        to: HUT_TILE,
        cost: 1,
        movementLeft: 0,
      },
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: ROME,
        tile: HUT_TILE,
        reward: 'barbarians',
      },
      {
        type: 'BarbariansSpawned',
        owner: BARBARIANS,
        tile: HUT_TILE,
        unitIds: [asUnitId(2), asUnitId(3)],
        tiles: [BAND_TILES[0], BAND_TILES[1]],
      },
    ]);
  });

  it(`seed ${String(HUT_NOTHING_CASE.seed)} grants nothing and still spends the hut`, () => {
    const result = runScenario(hutScenario(HUT_NOTHING_CASE));

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the hut scenario must build a state');
    expect(after.units.map((unit) => unit.id)).toEqual([asUnitId(0), asUnitId(1)]);
    expect(after.nextUnitId).toBe(2);
    expect(after.map.huts).toEqual([]);
    expect(result.events).toEqual([
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: at(5, 5),
        to: HUT_TILE,
        cost: 1,
        movementLeft: 0,
      },
      {
        type: 'HutEntered',
        unitId: asUnitId(0),
        owner: ROME,
        tile: HUT_TILE,
        reward: 'nothing',
      },
    ]);
    // No `unitGiven` key at all: the reward gave no unit, and a present-but-
    // undefined key would not survive canonical JSON.
    const entered = result.events[1];
    expect(entered === undefined ? undefined : Object.hasOwn(entered, 'unitGiven')).toBe(false);
  });

  it('sweeps twelve seeds and covers every reward branch at least once', () => {
    // One seed exercises one branch, so no single scenario can be the evidence
    // for all three: the sweep is. Each run's *expectation* is the branch the
    // state RNG's first draw selects, so a run whose branch differs from the
    // draw fails its assertions rather than being quietly recorded.
    const observed: { readonly seed: number; readonly reward: HutRewardKind }[] = [];

    for (let seed = 0; seed <= 11; seed += 1) {
      const expected = drawnReward(seed);
      const result = runScenario(hutScenario({ seed, reward: expected }));
      expect(failures(result.assertions)).toEqual([]);

      const entered = result.events.find((event) => event.type === 'HutEntered');
      observed.push({
        seed,
        reward: entered?.type === 'HutEntered' ? entered.reward : 'nothing',
      });
    }

    // The whole table, pinned: a change to `HUT_REWARD_KINDS`, to its order, or to
    // the RNG must show up here.
    expect(observed).toEqual([
      { seed: 0, reward: 'nothing' },
      { seed: 1, reward: 'unit' },
      { seed: 2, reward: 'nothing' },
      { seed: 3, reward: 'nothing' },
      { seed: 4, reward: 'nothing' },
      { seed: 5, reward: 'unit' },
      { seed: 6, reward: 'unit' },
      { seed: 7, reward: 'nothing' },
      { seed: 8, reward: 'nothing' },
      { seed: 9, reward: 'nothing' },
      { seed: 10, reward: 'unit' },
      { seed: 11, reward: 'barbarians' },
    ]);

    const covered = new Set(observed.map((entry) => entry.reward));
    expect([...covered].sort()).toEqual(['barbarians', 'nothing', 'unit']);
    for (const reward of HUT_REWARD_KINDS) expect(covered.has(reward)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The builder's M3 additions, and what they refuse
 * ------------------------------------------------------------------ */

describe('the scenario builder states M3 worlds', () => {
  /** A world that is ready to build: two civilizations, grassland, two warriors. */
  const m3World = (): ScenarioBuilder =>
    createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, WARRIOR, [30, 30])
      .addUnit(1, WARRIOR, [20, 20]);

  it('places huts on the map, ascending, whatever order they were written in', () => {
    const built = m3World().addHut(7, 5).addHut(9, 4).addHut(6, 5).build();
    if (!built.ok) throw new Error(`the hut fixture must build: ${JSON.stringify(built.error)}`);

    // `GameMap.huts` is ascending by contract, and the builder sorts rather than
    // trusting the author's order.
    expect(built.value.map.huts).toEqual([at(9, 4), at(6, 5), at(7, 5)]);
    expect(hutAt(built.value, Number(at(7, 5)))).toBe(true);
    expect(hutAt(built.value, Number(at(8, 8)))).toBe(false);
  });

  it('refuses a hut it cannot place honestly', () => {
    expect(() => m3World().addHut(DUEL.width, 0)).toThrow(/outside this world's 40x40 map/);
    expect(() => m3World().addHut(6, 5).addHut(6, 5)).toThrow(/called twice for one tile/);
    // The terrain under a hut is only final once every setTile has run, so the
    // "land only" rule is enforced at build().
    expect(() => m3World().addHut(6, 5).setTile(6, 5, 'ocean').build()).toThrow(
      /huts sit on land only/,
    );
    expect(() => m3World().addHut(6, 5).setTile(6, 5, 'coast').build()).toThrow(
      /huts sit on land only/,
    );
    expect(() => m3World().addHut(6, 5).setTile(6, 5, 'mountains').build()).toThrow(
      /no unit could ever enter it/,
    );
    // Control: exactly the same calls on ordinary land build.
    expect(m3World().addHut(6, 5).setTile(6, 5, 'hills').build().ok).toBe(true);
  });

  it('adds the barbarian player as an identity, not as a civilization', () => {
    const built = m3World().addBarbarianPlayer().addHut(6, 5).build();
    if (!built.ok)
      throw new Error(`the barbarian fixture must build: ${JSON.stringify(built.error)}`);
    const state = built.value;

    expect(state.players.map((player) => player.kind)).toEqual(['civ', 'civ', 'barbarian']);
    expect(state.players[2]?.name).toBe('Barbarians');
    expect(state.players[2]?.color).toBe('#3f3f46');
    // A barbarian player owns no unit and needs none; its starting tile is the
    // map's first hut, exactly as `newGame` leaves it.
    expect(state.players[2]?.startingTile).toBe(at(6, 5));
    expect(state.units.map((unit) => unit.owner)).toEqual([ROME, CARTHAGE]);
    expect(state.explored).toHaveLength(3);

    // The civilizations still decide `civCount`, and `players.length` is
    // `civCount + 1` as it is after `newGame`.
    expect(state.settings.civCount).toBe(2);
    expect(civPlayers(state)).toHaveLength(2);
    expect(state.players).toHaveLength(state.settings.civCount + 1);

    // A world with no hut falls back to tile 0, again as `newGame` does.
    const noHut = m3World().addBarbarianPlayer().build();
    expect(noHut.ok ? noHut.value.players[2]?.startingTile : undefined).toBe(asTileIndex(0));

    // It does not count toward the two civilizations a game needs …
    expect(() =>
      createScenarioBuilder(RULESET, DUEL_SETTINGS)
        .addPlayer('Rome')
        .addBarbarianPlayer()
        .fillTerrain('grassland')
        .addUnit(0, WARRIOR, [5, 5])
        .build(),
    ).toThrow(/at least 2 players/);

    // … and there is exactly one of it.
    expect(() => m3World().addBarbarianPlayer().addBarbarianPlayer()).toThrow(
      /already has a barbarian player/,
    );
    expect(() => m3World().addBarbarianPlayer('   ')).toThrow(/non-empty name/);
  });

  it('states a city outright, including the queue no M3 command can build', () => {
    const built = m3World()
      .addCity(0, [5, 5], {
        population: 2,
        foodBox: 4,
        shields: 7,
        production: { kind: 'unit', id: WARRIOR },
        queue: [{ kind: 'building', id: GRANARY }],
        workedTiles: [at(4, 3)],
      })
      .build();
    if (!built.ok) throw new Error(`the city fixture must build: ${JSON.stringify(built.error)}`);
    const state = built.value;
    const city = cityById(state, asCityId(0));

    expect(city?.id).toBe(asCityId(0));
    expect(city?.owner).toBe(ROME);
    expect(city?.name).toBe('City 1');
    expect(city?.tile).toBe(at(5, 5));
    expect(city?.population).toBe(2);
    expect(city?.foodBox).toBe(4);
    expect(city?.shields).toBe(7);
    expect(city?.production).toEqual({ kind: 'unit', id: WARRIOR });
    expect(city?.queue).toEqual([{ kind: 'building', id: GRANARY }]);
    expect(city?.workedTiles).toEqual([at(4, 3)]);
    expect(city?.buildings).toEqual([]);
    expect(cityAt(state, at(5, 5))?.id).toBe(asCityId(0));
    expect(state.nextCityId).toBe(1);

    // The hand-built city's yields are the engine's own: a grassland centre plus
    // one grassland tile is 4 food against 2 citizens' 4, and 2 shields.
    expect(cityYields(state, RULESET, asCityId(0))).toEqual({
      food: 4,
      shields: 2,
      commerce: 2,
      foodSurplus: 0,
    });

    // An omitted `workedTiles` is `autoAssignWorkedTiles`, which is what
    // `FoundCity` writes: best tile first, lowest index to break a tie.
    const auto = m3World().addCity(0, [5, 5], { population: 2 }).build();
    expect(auto.ok ? cityById(auto.value, asCityId(0))?.workedTiles : undefined).toEqual([
      at(4, 3),
      at(5, 3),
    ]);
  });

  it('refuses cities and queues the command layer could not produce', () => {
    expect(() => createScenarioBuilder(RULESET, DUEL_SETTINGS).addCity(0, [5, 5])).toThrow(
      /needs a player index/,
    );
    expect(() => m3World().addCity(2, [5, 5])).toThrow(/needs a player index/);
    expect(() => m3World().addCity(0, [DUEL.width, 0])).toThrow(/outside this world's 40x40 map/);
    expect(() => m3World().addCity(0, [5, 5], { population: 0 })).toThrow(
      /integer population >= 1/,
    );
    expect(() => m3World().addCity(0, [5, 5], { foodBox: -1 })).toThrow(/integer foodBox >= 0/);
    expect(() => m3World().addCity(0, [5, 5], { shields: 1.5 })).toThrow(/integer shields >= 0/);

    // Things this ruleset cannot build: an unknown unit, an unknown building, and
    // a building the city already has (the engine refuses that too).
    expect(() =>
      m3World().addCity(0, [5, 5], { production: { kind: 'unit', id: NOT_A_UNIT } }),
    ).toThrow(/cannot price it/);
    expect(() =>
      m3World().addCity(0, [5, 5], { queue: [{ kind: 'unit', id: NOT_A_UNIT }] }),
    ).toThrow(/cannot price it/);
    expect(() => m3World().addCity(0, [5, 5], { buildings: [NOT_A_BUILDING] })).toThrow(
      /defines no building "nope"/,
    );
    expect(() =>
      m3World().addCity(0, [5, 5], {
        buildings: [GRANARY],
        queue: [{ kind: 'building', id: GRANARY }],
      }),
    ).toThrow(/which the city already has/);

    // Worked tiles: one citizen works one tile, no tile twice, none outside the
    // radius, and never the centre (always worked, costs no citizen).
    expect(() =>
      m3World().addCity(0, [5, 5], { population: 1, workedTiles: [at(4, 3), at(5, 3)] }),
    ).toThrow(/one citizen works one tile/);
    expect(() =>
      m3World().addCity(0, [5, 5], { population: 2, workedTiles: [at(4, 3), at(4, 3)] }),
    ).toThrow(/twice in workedTiles/);
    expect(() =>
      m3World()
        .addCity(0, [5, 5], { workedTiles: [at(20, 20)] })
        .build(),
    ).toThrow(/outside the 21-tile radius/);
    expect(() =>
      m3World()
        .addCity(0, [5, 5], { workedTiles: [at(5, 5)] })
        .build(),
    ).toThrow(/lists the city centre/);
    expect(() => m3World().addCity(0, [5, 5], { population: 1.5 }).build()).toThrow(
      /integer population >= 1/,
    );

    // Two cities: `FoundCity` refuses a site closer than `MIN_CITY_DISTANCE`, so a
    // hand-built world may not contain one either …
    expect(() => m3World().addCity(0, [5, 5]).addCity(1, [6, 6])).toThrow(
      /closer than MIN_CITY_DISTANCE = 2/,
    );
    // … and a tile one city works may not be claimed by another.
    expect(() =>
      m3World()
        .addCity(0, [5, 5], { workedTiles: [at(6, 5)] })
        .addCity(1, [7, 5], { workedTiles: [at(6, 5)] })
        .build(),
    ).toThrow(/already works/);
  });

  it('reports M3 refusals by name, so a refused run command is readable', () => {
    const illegal: Scenario = {
      name: 'found-a-city-with-a-warrior',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .addUnit(0, WARRIOR, [5, 5])
          .addUnit(1, WARRIOR, [6, 6]),
      run: [foundCity(0)],
      assert: () => [check(true, 'the assert callback still runs after a refused command')],
    };

    const result = runScenario(illegal);

    expect(result.passed).toBe(false);
    expect(result.assertions[0]?.message).toBe(
      'run[0] FoundCity by unit 0 was refused: not-a-settler (unit 0 is not an unused settler)',
    );
    expect(result.finalState?.revision).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Falsification: the M3 scenarios' assertions must be able to fail
 * ------------------------------------------------------------------ */

describe('the M3 scenario assertions discriminate (they are not decoration)', () => {
  it('the growth-timing assertions fail when the city earns one food less a turn', () => {
    // A plains city site: 1 food at the centre instead of 2, so the box holds 4
    // after four turns rather than 8, and every timing assertion after that is
    // wrong. The same `run` and the same `assert` as the real scenario.
    const variant: Scenario = {
      name: 'growth-timing-on-plains',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(5, 5, 'plains')
          .addUnit(0, SETTLER, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [foundCity(0), ...endTurns(4)],
      assert: assertOf(growthScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/8 of the 10 food/);
  });

  it('the starvation assertions fail when the citizens keep their tiles', () => {
    // The same city, but nothing unassigns its citizens: a grassland tile is 2
    // food, so the two citizens eat exactly what they grow — a surplus of 1, not
    // -3 — and no citizen is ever lost.
    const variant: Scenario = {
      name: 'starvation-without-the-unassignment',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(5, 5, 'plains')
          .addUnit(0, SETTLER, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [foundCity(0), ...endTurns(10)],
      assert: assertOf(starvationScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/surplus is -3/);
  });

  it('the production assertions fail when the queue does not promote the next item', () => {
    // No queue at all: the settler still completes with 1 shield carried over,
    // but nothing becomes the head, so the promotion and the second completion
    // must both break.
    const variant: Scenario = {
      name: 'production-with-an-empty-queue',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .addUnit(0, WARRIOR, [30, 30])
          .addUnit(1, WARRIOR, [20, 20])
          .addCity(0, [5, 5], {
            population: 1,
            workedTiles: [at(4, 3)],
            production: { kind: 'unit', id: SETTLER },
          }),
      run: [endTurn(), endTurn()],
      assert: assertOf(productionScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/next queue entry became/);
  });

  it('the hut assertions fail when the hut is not where the scenario says it is', () => {
    // The hut is placed one tile further east, so the warrior's step lands on
    // empty grassland: the map must still show the hut and no branch may fire.
    const variant: Scenario = {
      name: 'hut-reward-unit-with-no-hut-on-the-tile',
      settings: { mapSize: 'duel', seed: HUT_UNIT_CASE.seed },
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .addBarbarianPlayer()
          .fillTerrain('grassland')
          .addHut(8, 5)
          .addUnit(0, WARRIOR, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [move(0, HUT_TILE)],
      assert: assertOf(hutScenario(HUT_UNIT_CASE)),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/hut is gone from the map/);
  });

  it('the hut assertions fail when the seed draws a different branch than expected', () => {
    // Seed 11 draws the barbarian band, and the scenario is written to expect the
    // free unit: the RNG check, the unit count and the band's absence must all
    // disagree. This is what makes "one seed exercises one branch" a real claim.
    const result = runScenario(hutScenario({ seed: 11, reward: 'unit' }));

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/a free unit was granted/);
  });

  it('its own sweep would catch a reward table that stopped covering every branch', () => {
    // The sweep's coverage claim, checked in the small: a seed list that never
    // draws a band cannot cover every branch, which is exactly the failure the
    // sweep test exists to prevent.
    const branchless = [0, 1, 2, 5].map((seed) => drawnReward(seed));
    expect(new Set(branchless)).toEqual(new Set(['nothing', 'unit']));
    expect(branchless).not.toContain('barbarians');
    expect(new Set(HUT_CASES.map((testCase) => testCase.reward))).toEqual(
      new Set(['unit', 'barbarians', 'nothing']),
    );
  });
});

/* ================================================================== *
 * M4a acceptance evidence — workers, tile improvements and the yields
 * ================================================================== */

/**
 * Every number in this section is the shipped catalog's **placeholder** content
 * (PLAN.md §6.2, INTERFACES.md M4a's provenance paragraph): the improvement turn
 * counts and yield deltas are ours, chosen to be playable, and none of them is a
 * Civ 3 figure. What the scenarios below assert is the *engine's rules* over
 * those rows — that an improvement pays out on the turn it completes, that each
 * turn costs exactly one, that a term of work is cancelled by moving the worker,
 * that an illegal job is refused with a typed reason and changes nothing — not
 * that the numbers are right. The catalog assertions (`turns === 3`, a `+1`
 * shield delta) are there so a change to the content shows up as a changed test
 * rather than as a silently different game.
 */

/** M4a's two commands, spelled the way the DSL spells the M3 ones. */
const startWork = (unitId: number, kind: ImprovementId): Command => ({
  type: 'StartWork',
  unitId: asUnitId(unitId),
  kind,
});

const WORKER = asUnitTypeId('worker'); // movement 2 in the shipped catalog

/** The three improvement rows the shipped catalog defines (all placeholders). */
const MINE = asImprovementId('mine'); // 3 worker turns, +1 shield
const IRRIGATION = asImprovementId('irrigation'); // 2 worker turns, +1 food
const ROAD = asImprovementId('road'); // 2 worker turns, +1 commerce
const NOT_AN_IMPROVEMENT = asImprovementId('nope');

/** The job a unit is doing, or `undefined` when it is idle (the key is absent then). */
const workOf = (state: GameState, unitId: number): UnitWork | undefined =>
  unitById(state, asUnitId(unitId))?.work;

/**
 * Does the unit carry a `work` key at all?
 *
 * The distinction between "absent" and "present but `undefined`" is the bug class
 * that has cost this project three hunts: a key holding `undefined` cannot survive
 * a JSON round trip, so `canonicalize` rejects it and the state becomes
 * unhashable. `workOf` cannot see the difference (`?.work` answers `undefined`
 * either way), which is why an idle unit is asserted through this and not through
 * the value.
 */
const hasWorkKey = (state: GameState, unitId: number): boolean => {
  const unit = unitById(state, asUnitId(unitId));
  return unit !== undefined && Object.hasOwn(unit, 'work');
};

/**
 * The typed error a command was refused with, or `undefined` when it was applied.
 *
 * The refusal scenarios use this rather than the throwing `refusal` helper: a
 * *failing expectation* is what a scenario reports, and an unexpectedly applied
 * command must show up as a failed assertion (`"the refusal I expected did not
 * happen"`) instead of as an exception escaping the `assert` callback.
 */
const errorOf = (result: Result<CommandOutcome, GameError>): GameError | undefined =>
  result.ok ? undefined : result.error;

/* ------------------------------------------------------------------ *
 * 8. Mine yield
 * ------------------------------------------------------------------ */

/** The city centre: grassland, so the centre is 2 food / 1 shield / 1 commerce. */
const MINE_CITY = at(5, 5);
/** The hill the city's single citizen works, and the tile the worker mines. */
const MINE_TILE = at(6, 5);

/**
 * MINE YIELD. A hand-built city with **one** citizen works a hill, and a worker
 * stands on that same hill digging a mine. The arithmetic, all of it the
 * engine's, from the shipped catalog's placeholder values:
 *
 * - the centre is always worked and free, and grassland's 2/1/1 is above the
 *   1/1/1 floor, so it contributes **1 shield**;
 * - hills are 0 food / 2 shields / 0 commerce, so the city makes **3 shields a
 *   turn**, and 2 food against the 2 its citizen eats — a surplus of exactly 0, so
 *   it neither grows nor starves and the shield total is not entangled with
 *   either;
 * - a mine is a **+1 shield** delta on the tile it sits on, so once it is finished
 *   the same city makes **4 shields a turn**;
 * - a mine takes **3 worker turns**, and step 1 of `advanceTurn` pays one per turn
 *   *before* growth and production, so it is built during the third `EndTurn` —
 *   the state that call returns is at turn 4 — and its +1 shield is counted on
 *   **that same turn**: 3 + 3 + 4 = **10** shields, not 9.
 *
 * That last number is the point of M4a's order rule. An implementation that ran
 * production before work would still finish the mine on the third turn but would
 * pay 9. `run` therefore stops one turn *before* the completion and the `assert`
 * callback pins both sides of the boundary: the last turn without a mine, and the
 * turn it appears on.
 */
const mineYieldScenario = defineScenario({
  name: 'mine-yield-pays-out-on-the-turn-it-completes',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills') // the worked tile, and the tile the worker stands on
      .addUnit(0, WORKER, [6, 5]) // unit 0 — the digger
      .addUnit(1, WARRIOR, [20, 20]) // unit 1 — Carthage's, far away
      .addCity(0, [5, 5], { population: 1, workedTiles: [MINE_TILE] }),
  run: [startWork(0, MINE), endTurn(), endTurn()],
  assert: (after, ruleset) => {
    const cityId = asCityId(0);
    const city = cityById(after, cityId);
    const mineDef = improvementDef(ruleset, MINE);
    const hills = TERRAIN_BY_ROLE(ruleset, 'hills');
    if (city === undefined || mineDef === undefined || hills === undefined) {
      return [check(false, 'the ruleset or the world is missing a row this scenario needs')];
    }

    // Where the run stopped: two of the mine's three turns are paid.
    const before = cityYields(after, ruleset, cityId);
    const hillBefore = tileYields(after, ruleset, MINE_TILE);
    const inProgress = workOf(after, 0);

    // The third turn: the mine's last turn is paid, and that same turn's
    // production counts it.
    const third = romeApply(after, ruleset, endTurn());
    const completed = third?.state;
    const completedCity = completed === undefined ? undefined : cityById(completed, cityId);
    const afterYields =
      completed === undefined ? undefined : cityYields(completed, ruleset, cityId);
    const hillAfter =
      completed === undefined ? undefined : tileYields(completed, ruleset, MINE_TILE);
    const completedEvent = third?.events.find((event) => event.type === 'WorkCompleted');
    const idle = completed === undefined ? undefined : unitById(completed, asUnitId(0));

    // "Exactly once": asking for the same mine on the same tile again is refused,
    // and the pair list is still one entry long afterwards.
    const again =
      completed === undefined
        ? undefined
        : errorOf(applyCommand(completed, ROME, startWork(0, MINE), ruleset));

    return [
      check(
        mineDef.turns === 3 &&
          mineDef.yields.shields === 1 &&
          mineDef.yields.food === 0 &&
          mineDef.yields.commerce === 0,
        `the catalog's mine is a PLACEHOLDER row: 3 worker turns for a +1 shield delta, no food and no commerce (turns ${String(mineDef.turns)}, yields ${JSON.stringify(mineDef.yields)})`,
      ),
      check(
        hills.yields.shields === 2 && hills.yields.food === 0,
        `hills are a PLACEHOLDER 0 food / 2 shields, which is what makes the mine's +1 shield visible in a city's output (${JSON.stringify(hills.yields)})`,
      ),
      check(
        city.tile === MINE_CITY &&
          after.cities.length === 1 &&
          city.workedTiles.length === 1 &&
          city.workedTiles[0] === MINE_TILE,
        `the world is the one the scenario described: one city on ${label(5, 5)} whose single citizen works the hill at ${label(6, 5)} (tile ${String(city.tile)}, worked ${JSON.stringify(city.workedTiles)})`,
      ),
      check(
        after.turn === 3 && city.shields === 6,
        `the run stopped after two of the mine's three turns: state turn 3, the city has banked 3 + 3 = 6 shields (turn ${String(after.turn)}, shields ${String(city.shields)})`,
      ),
      check(
        inProgress !== undefined &&
          inProgress.kind === MINE &&
          inProgress.tile === MINE_TILE &&
          inProgress.turnsLeft === 1,
        `the job is in progress on the worker's own tile with exactly one turn left (got ${JSON.stringify(inProgress)})`,
      ),
      check(
        after.improvements.length === 0 && !hasImprovement(after, MINE_TILE, MINE),
        `no improvement exists yet: a job adds nothing to the tile when it starts (pairs: ${JSON.stringify(after.improvements)})`,
      ),
      check(
        before.shields === 3 && before.food === 2 && before.foodSurplus === 0,
        `BEFORE the mine the city makes 3 shields a turn (grassland centre 1 + hill 2) and 2 food against 2 eaten, so the surplus is 0 and growth cannot move the shield total (got ${JSON.stringify(before)})`,
      ),
      check(
        hillBefore !== undefined &&
          hillBefore.shields === 2 &&
          hillAfter !== undefined &&
          hillAfter.shields === 3,
        `the worked tile itself goes from 2 to 3 shields when the mine is finished (before ${JSON.stringify(hillBefore)}, after ${JSON.stringify(hillAfter)})`,
      ),
      check(
        completed !== undefined && completed.turn === 4,
        `the mine completes on the third turn: the state that call returns is at turn 4 (got ${String(completed?.turn)})`,
      ),
      check(
        afterYields !== undefined &&
          afterYields.shields === 4 &&
          afterYields.shields - before.shields === mineDef.yields.shields,
        `AFTER the mine the same city makes 4 shields a turn — exactly the mine's +1 delta more (before ${String(before.shields)}, after ${String(afterYields?.shields)})`,
      ),
      check(
        completedCity !== undefined && completedCity.shields === 10,
        `the completing turn pays at the improved rate: 6 banked + 4 = 10 shields (got ${String(completedCity?.shields)}; production running before work would leave 9)`,
      ),
      check(
        completed !== undefined &&
          completed.improvements.length === 1 &&
          completed.improvements[0]?.tile === MINE_TILE &&
          completed.improvements[0].kind === MINE &&
          improvementsAt(completed, MINE_TILE).length === 1 &&
          hasImprovement(completed, MINE_TILE, MINE),
        `the improvement appears in the state exactly once, as (tile ${String(Number(MINE_TILE))}, mine) and nowhere else (pairs: ${JSON.stringify(completed?.improvements)})`,
      ),
      check(
        idle !== undefined && !Object.hasOwn(idle, 'work') && idle.movementLeft === 2,
        `the worker is idle again — the \`work\` key is ABSENT rather than holding undefined — and step 4 of the turn refilled its movement to 2 (unit ${JSON.stringify(idle)})`,
      ),
      check(
        completedEvent !== undefined &&
          completedEvent.unitId === asUnitId(0) &&
          completedEvent.kind === MINE &&
          completedEvent.tile === MINE_TILE,
        `the engine's own account of it: WorkCompleted(unit 0, mine, tile ${String(Number(MINE_TILE))}) (got ${JSON.stringify(completedEvent)})`,
      ),
      check(
        again !== undefined &&
          again.kind === 'already-improved' &&
          again.tile === MINE_TILE &&
          again.improvement === MINE,
        `re-issuing the same job is refused with already-improved(tile ${String(Number(MINE_TILE))}, mine) (got ${again === undefined ? 'the command applied' : JSON.stringify(again)})`,
      ),
      check(
        completed !== undefined &&
          completed.improvements.length === 1 &&
          improvementsAt(completed, MINE_TILE).length === 1,
        `and the refused re-issue left the pair list at exactly one entry (pairs: ${JSON.stringify(completed?.improvements)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 9. Work cancelled by movement
 * ------------------------------------------------------------------ */

/** The hill worker 0 mines before walking away from it. */
const CANCEL_HILL = at(6, 5);
/** The grassland worker 1 works, and stays on: the control for the cancellation. */
const CANCEL_FLAT = at(4, 5);
/** Where the digger walks to: one step east of the hill, ordinary grassland. */
const CANCEL_DESTINATION = at(7, 5);

/**
 * WORK CANCELLED BY MOVEMENT. Two workers start jobs on one turn, a turn passes,
 * and then **one of them walks away**. The contract (M4a, "Moving a working unit,
 * or any other action that would relocate it, cancels its work. Say so in the
 * event stream rather than silently dropping it") is three claims at once, and the
 * scenario pins all three:
 *
 * 1. the mover's job is gone from the state, and the `work` key is **absent**
 *    rather than holding `undefined`;
 * 2. nothing was built — a job never adds a pair before its last turn, so a
 *    cancelled job leaves no half-finished mine behind;
 * 3. the cancellation is caused by the *relocation* and not by the turn passing:
 *    the worker that did not move is still working, with its count down by exactly
 *    the one turn that passed.
 *
 * The typed `WorkCancelled` event is asserted in two places, deliberately: the
 * runner's own event list for the scripted move (`{ reason: 'moved', turnsLeft: 2 }`
 * — the job was two thirds done and nothing is refunded), and, inside `assert`, the
 * event a *second* relocation produces, so the claim is about relocation rather
 * than about one particular command sequence.
 */
const workCancelledScenario = defineScenario({
  name: 'work-is-cancelled-by-movement-and-nothing-is-built',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER, [6, 5]) // unit 0 — digs a mine, then walks away
      .addUnit(0, WORKER, [4, 5]) // unit 1 — irrigates, and stays put
      .addUnit(1, WARRIOR, [20, 20]), // unit 2
  run: [startWork(0, MINE), startWork(1, IRRIGATION), endTurn(), move(0, CANCEL_DESTINATION)],
  assert: (after, ruleset) => {
    const mover = unitById(after, asUnitId(0));
    const control = unitById(after, asUnitId(1));
    const controlJob = workOf(after, 1);
    if (mover === undefined || control === undefined) {
      return [check(false, 'the world is missing a worker this scenario needs')];
    }

    // The control worker is moved *inside* the assertion, so the same fact is
    // checked again on a relocation the scenario's `run` did not perform.
    const probed = romeApply(after, ruleset, move(1, at(3, 5)));
    const probedCancelled = probed?.events.find((event) => event.type === 'WorkCancelled');

    return [
      check(
        mover.tile === CANCEL_DESTINATION && mover.movementLeft === 1,
        `the digger really did move: it is on ${label(7, 5)} with 2 - 1 = 1 movement left (tile ${String(mover.tile)}, movement ${String(mover.movementLeft)})`,
      ),
      check(
        !Object.hasOwn(mover, 'work') && workOf(after, 0) === undefined,
        `its job is GONE — the \`work\` key is absent, not present-and-undefined — so a worker cannot carry a half-finished mine somewhere else (unit ${JSON.stringify(mover)})`,
      ),
      check(
        after.improvements.length === 0 && !hasImprovement(after, CANCEL_HILL, MINE),
        `and no improvement was added: a cancelled job leaves the tile exactly as it found it (pairs: ${JSON.stringify(after.improvements)})`,
      ),
      check(
        control.tile === CANCEL_FLAT &&
          controlJob !== undefined &&
          controlJob.kind === IRRIGATION &&
          controlJob.tile === CANCEL_FLAT &&
          controlJob.turnsLeft === 1,
        `the worker that did NOT move still has its job, one turn further along (irrigation was 2 turns: one turn passed) — so the disappearance above is the relocation and not the turn (control ${JSON.stringify(controlJob)})`,
      ),
      check(
        hasWorkKey(after, 1),
        'the control worker still carries a `work` key, which is the absent-vs-undefined distinction stated the other way round',
      ),
      check(
        probed !== undefined && unitById(probed.state, asUnitId(1))?.tile === at(3, 5),
        `moving the control worker applied (it is on ${label(3, 5)}), so the probe above is a real relocation and not a refusal (tile ${String(probed === undefined ? 'not applied' : unitById(probed.state, asUnitId(1))?.tile)})`,
      ),
      check(
        probedCancelled !== undefined &&
          probedCancelled.unitId === asUnitId(1) &&
          probedCancelled.kind === IRRIGATION &&
          probedCancelled.tile === CANCEL_FLAT &&
          probedCancelled.turnsLeft === 1 &&
          probedCancelled.reason === 'moved',
        `the engine's own typed account: WorkCancelled(unit 1, irrigation, tile ${String(Number(CANCEL_FLAT))}, turnsLeft 1, reason "moved") (got ${JSON.stringify(probedCancelled)})`,
      ),
      check(
        probed !== undefined && !hasWorkKey(probed.state, 1),
        'and the probe\u2019s own state carries no `work` key on that unit either',
      ),
      check(
        probed !== undefined &&
          probed.state.improvements.length === 0 &&
          !hasImprovement(probed.state, CANCEL_FLAT, IRRIGATION),
        `the second cancellation built nothing either — the irrigation tile is still bare (pairs: ${JSON.stringify(probed?.state.improvements)})`,
      ),
      check(
        after.revision === 4 && after.turn === 2,
        `four applied commands and exactly one turn: revision ${String(after.revision)}, turn ${String(after.turn)} (two StartWork, one EndTurn, one MoveUnit)`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 10. Illegal work refused
 * ------------------------------------------------------------------ */

/** Grassland: a mine may not be built here (its `allowedRoles` are hills, mountains). */
const WRONG_ROLE_TILE = at(5, 5);
/** Hills that already carry a mine — the DSL states a worker's earlier job outright. */
const IMPROVED_HILL = at(7, 5);
/** Grassland, where irrigation *is* allowed: the control that keeps the refusals specific. */
const CONTROL_TILE = at(9, 5);

/**
 * ILLEGAL WORK REFUSED. No `run` commands at all: a refused command in `run` is a
 * failing run, and this scenario is *about* refusals, so each one is probed and
 * asserted with its exact typed error — the same shape the M2 blocked-move
 * scenario uses.
 *
 * The five refusals, in `planStartWork`'s check order:
 *
 * 1. a mine on grassland — `improvement-not-allowed`, naming the role that decided
 *    it (`grassland`), because that is the rule that makes a mine a rock job;
 * 2. irrigation on hills — the same error, naming `hills`, so the rule is not
 *    "mines need hills" but "every improvement names the terrain it may be built
 *    on";
 * 3. a mine on a hill that already carries one — `already-improved`, which is
 *    reachable only because a scenario can now *state* a pre-built improvement
 *    (`addImprovement`); the tile is asserted to be hills, so the refusal is about
 *    the pair and not about the terrain;
 * 4. an id no catalog row defines — `unknown-improvement`;
 * 5. a warrior told to dig — `not-a-worker`, because a scout (or a warrior) on a
 *    hill is not a mine that has not been dug yet.
 *
 * Then the two claims that make the refusals *evidence* rather than decoration:
 * the canonical state hash is byte-identical before and after all five (a refusal
 * changes nothing, and `hashValue` is the same digest the goldens use), and the
 * very same command shape is **accepted** where it is legal — so the refusals are
 * specific and not a blanket "work never starts".
 */
const illegalWorkScenario = defineScenario({
  name: 'illegal-work-is-refused-with-a-typed-error-and-leaves-the-state-alone',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(7, 5, 'hills')
      .addImprovement(7, 5, MINE) // a job finished earlier, stated by the DSL
      .addUnit(0, WORKER, [5, 5]) // unit 0 — mine on grassland: wrong terrain role
      .addUnit(0, WORKER, [7, 5]) // unit 1 — mine on a mined hill; irrigation on a hill
      .addUnit(0, WORKER, [9, 5]) // unit 2 — irrigation is legal here (the control)
      .addUnit(1, WARRIOR, [20, 20]), // unit 3 — not a worker
  assert: (after, ruleset) => {
    const hills = TERRAIN_BY_ROLE(ruleset, 'hills');
    if (hills === undefined) {
      return [check(false, 'the ruleset is missing the hills row this scenario needs')];
    }

    // The hash before anything is attempted, so "a refusal changes nothing" is
    // checked against the state itself rather than against a field count.
    const hashBefore = hashValue(after);

    const wrongRole = errorOf(applyCommand(after, ROME, startWork(0, MINE), ruleset));
    const irrigationOnHills = errorOf(applyCommand(after, ROME, startWork(1, IRRIGATION), ruleset));
    const alreadyImproved = errorOf(applyCommand(after, ROME, startWork(1, MINE), ruleset));
    const unknown = errorOf(applyCommand(after, ROME, startWork(0, NOT_AN_IMPROVEMENT), ruleset));
    const notAWorker = errorOf(applyCommand(after, CARTHAGE, startWork(3, MINE), ruleset));

    // The control: the same command shape, on a tile where the catalog allows it.
    const control = romeApply(after, ruleset, startWork(2, IRRIGATION));
    const controlJob = control === undefined ? undefined : workOf(control.state, 2);

    // And a *second* job for a worker already digging: `already-working`, naming
    // the job in progress. `road` is allowed on grassland, so the only reason to
    // refuse is the job the unit already has — one job at a time, and a caller that
    // must cancel first is told what to cancel.
    const second = errorOf(
      applyCommand(control?.state ?? after, ROME, startWork(2, ROAD), ruleset),
    );

    return [
      check(
        wrongRole !== undefined &&
          wrongRole.kind === 'improvement-not-allowed' &&
          wrongRole.unitId === asUnitId(0) &&
          wrongRole.tile === WRONG_ROLE_TILE &&
          wrongRole.improvement === MINE &&
          wrongRole.role === 'grassland',
        `a mine on grassland is refused with improvement-not-allowed(unit 0, tile ${String(Number(WRONG_ROLE_TILE))}, mine, role "grassland") (got ${JSON.stringify(wrongRole)})`,
      ),
      check(
        irrigationOnHills !== undefined &&
          irrigationOnHills.kind === 'improvement-not-allowed' &&
          irrigationOnHills.unitId === asUnitId(1) &&
          irrigationOnHills.tile === IMPROVED_HILL &&
          irrigationOnHills.improvement === IRRIGATION &&
          irrigationOnHills.role === 'hills',
        `irrigation on hills is refused the same way, reporting "hills": every improvement names the terrain it may be built on (got ${JSON.stringify(irrigationOnHills)})`,
      ),
      check(
        alreadyImproved !== undefined &&
          alreadyImproved.kind === 'already-improved' &&
          alreadyImproved.tile === IMPROVED_HILL &&
          alreadyImproved.improvement === MINE,
        `a mine on a hill that already carries one is refused with already-improved(tile ${String(Number(IMPROVED_HILL))}, mine) (got ${JSON.stringify(alreadyImproved)})`,
      ),
      check(
        after.map.terrain[Number(IMPROVED_HILL)] === hills.id &&
          hills.yields.shields === 2 &&
          !hills.impassable,
        `and that refusal is about the pair and not the terrain: the tile really is hills, where a mine is allowed and the worker could stand (role ${hills.role})`,
      ),
      check(
        unknown !== undefined &&
          unknown.kind === 'unknown-improvement' &&
          unknown.improvement === NOT_AN_IMPROVEMENT,
        `an id no catalog row defines is refused with unknown-improvement("nope") (got ${JSON.stringify(unknown)})`,
      ),
      check(
        notAWorker !== undefined &&
          notAWorker.kind === 'not-a-worker' &&
          notAWorker.unitId === asUnitId(3),
        `Carthage's warrior cannot dig: not-a-worker(unit 3) (got ${JSON.stringify(notAWorker)})`,
      ),
      check(
        hashValue(after) === hashBefore,
        `all five refusals left the state byte-for-byte identical: the canonical hash is still ${hashBefore}`,
      ),
      check(
        after.revision === 0 &&
          after.improvements.length === 1 &&
          after.improvements[0]?.tile === IMPROVED_HILL &&
          after.improvements[0].kind === MINE,
        `revision is still 0 and the pair list is exactly the one pre-placed mine (revision ${String(after.revision)}, pairs ${JSON.stringify(after.improvements)})`,
      ),
      check(
        !hasWorkKey(after, 0) && !hasWorkKey(after, 1) && !hasWorkKey(after, 2),
        'no refused command gave a unit a job, and no unit grew a `work` key holding undefined',
      ),
      check(
        control !== undefined && control.state.revision === 1 && control.state.turn === 1,
        `the CONTROL applies: irrigation on grassland is a legal job, so the refusals above are specific rather than a blanket "work is refused" (revision ${String(control?.state.revision)})`,
      ),
      check(
        controlJob !== undefined &&
          controlJob.kind === IRRIGATION &&
          controlJob.tile === CONTROL_TILE &&
          controlJob.turnsLeft === 2,
        `and it starts with the catalog's own 2 turns on the unit's own tile ${label(9, 5)} (got ${JSON.stringify(controlJob)})`,
      ),
      check(
        control !== undefined &&
          control.state.improvements.length === 1 &&
          !hasImprovement(control.state, CONTROL_TILE, IRRIGATION),
        `starting a legal job still builds nothing: the pair lands when its last turn is paid, not when it starts (pairs: ${JSON.stringify(control?.state.improvements)})`,
      ),
      check(
        second !== undefined &&
          second.kind === 'already-working' &&
          second.unitId === asUnitId(2) &&
          second.improvement === IRRIGATION,
        `a worker already digging cannot be handed a second job: already-working(unit 2, irrigation) — the job in progress, so a client knows what to cancel (got ${JSON.stringify(second)})`,
      ),
      check(
        second !== undefined &&
          controlJob !== undefined &&
          workOf(control?.state ?? after, 2)?.kind === IRRIGATION &&
          (control?.state.improvements.length ?? -1) === 1,
        `and the refusal did not quietly replace the job or build anything: unit 2 is still irrigating and the pair list is unchanged (job ${JSON.stringify(controlJob)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 11. Work timing
 * ------------------------------------------------------------------ */

/** The hill a 3-turn mine is dug on. */
const TIMING_HILL = at(6, 5);
/** The grassland a 2-turn irrigation is dug on. */
const TIMING_FLAT = at(4, 5);

/**
 * WORK TIMING. Two workers start jobs of **different lengths** on the same turn —
 * a mine (3 turns) and an irrigation (2 turns) — and every turn is walked
 * individually, asserting the pair `(mine.turnsLeft, irrigation.turnsLeft)` after
 * each one, what is built, and which job finished.
 *
 * Different lengths are the point: if the same length were used, "each turn costs
 * exactly one" and "the job finishes on turn 3" would be indistinguishable from
 * "the job finishes after three turns however they are counted". With 3 and 2, the
 * expected sequences are `[(2,1), (1,none), (none,none)]` and the completions land
 * on two different turns — an implementation that decremented twice a turn would
 * produce `[(1,none), (none,none), ...]`, and one that completed a turn early
 * would build the first improvement after turn 1.
 *
 * `-1` in the recorded sequence means "no `work` key at all": a finished job is
 * absent from the unit, never present with a zero count (`turn.ts` completes on
 * reaching zero, so a count of 0 never reaches the state).
 */
const workTimingScenario = defineScenario({
  name: 'work-timing-pays-one-turn-a-turn-and-finishes-on-the-catalog-turn',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER, [6, 5]) // unit 0 — the mine: the longer job
      .addUnit(0, WORKER, [4, 5]) // unit 1 — the irrigation: the shorter one
      .addUnit(1, WARRIOR, [20, 20]), // unit 2
  run: [startWork(0, MINE), startWork(1, IRRIGATION)],
  assert: (after, ruleset) => {
    const mineDef = improvementDef(ruleset, MINE);
    const irrigationDef = improvementDef(ruleset, IRRIGATION);
    if (mineDef === undefined || irrigationDef === undefined) {
      return [check(false, 'the ruleset is missing an improvement row this scenario needs')];
    }

    const started = [workOf(after, 0), workOf(after, 1)];

    const turnsLeft: (readonly [number, number])[] = [];
    const built: string[][] = [];
    const movement: (readonly [number, number])[] = [];
    const completionTurns: number[] = [];
    const completionKinds: ImprovementId[] = [];
    const hashes: string[] = [];

    let state = after;
    for (let turn = 0; turn < 3; turn += 1) {
      const step = romeApply(state, ruleset, endTurn());
      if (step === undefined) {
        return [check(false, 'EndTurn must apply to a world with two working units')];
      }
      state = step.state;

      turnsLeft.push([workOf(state, 0)?.turnsLeft ?? -1, workOf(state, 1)?.turnsLeft ?? -1]);
      built.push(state.improvements.map((pair) => `${String(Number(pair.tile))}:${pair.kind}`));
      movement.push([
        unitById(state, asUnitId(0))?.movementLeft ?? -1,
        unitById(state, asUnitId(1))?.movementLeft ?? -1,
      ]);
      // Every intermediate state is hashed, not only the last one: `canonicalize`
      // refuses `undefined` anywhere, so a `work` key written as
      // `work: undefined` when a job finishes — the bug class that has cost this
      // project three hunts — would throw here on the very turn it happened.
      hashes.push(hashValue(state));
      for (const event of step.events) {
        if (event.type === 'WorkCompleted') {
          completionTurns.push(state.turn);
          completionKinds.push(event.kind);
        }
      }
    }
    hashes.push(hashValue(after));

    // What each turn must build, in `(tile, kind)` order — the order the state's
    // pair list is hashed in.
    const flat = String(Number(TIMING_FLAT));
    const hill = String(Number(TIMING_HILL));
    const expectedBuilt: string[][] = [
      [],
      [`${flat}:${IRRIGATION}`],
      [`${flat}:${IRRIGATION}`, `${hill}:${MINE}`],
    ];

    return [
      check(
        mineDef.turns === 3 && irrigationDef.turns === 2,
        `the catalog's PLACEHOLDER turn counts differ — mine 3, irrigation 2 — which is what makes "exactly one turn a turn" observable (got ${String(mineDef.turns)} and ${String(irrigationDef.turns)})`,
      ),
      check(
        after.turn === 1 &&
          after.revision === 2 &&
          started[0] !== undefined &&
          started[0].turnsLeft === mineDef.turns &&
          started[0].tile === TIMING_HILL &&
          started[1] !== undefined &&
          started[1].turnsLeft === irrigationDef.turns &&
          started[1].tile === TIMING_FLAT,
        `the run only STARTED the two jobs, on turn 1: each carries the catalog's full count on the unit's own tile (${JSON.stringify(started)})`,
      ),
      check(
        after.improvements.length === 0,
        `and neither job has built anything yet (pairs: ${JSON.stringify(after.improvements)})`,
      ),
      check(
        JSON.stringify(turnsLeft) ===
          JSON.stringify([
            [2, 1],
            [1, -1],
            [-1, -1],
          ]),
        `each turn pays exactly one turn of each job and no more: [(2,1), (1,none), (none,none)] (got ${JSON.stringify(turnsLeft)}; -1 means the \`work\` key is gone)`,
      ),
      check(
        JSON.stringify(built) === JSON.stringify(expectedBuilt),
        `the improvements appear on the exact turn their last turn is paid, in (tile, kind) order: nothing, then the irrigation on tile ${flat}, then that plus the mine on tile ${hill} (got ${JSON.stringify(built)})`,
      ),
      check(
        JSON.stringify(completionTurns) === JSON.stringify([3, 4]) &&
          JSON.stringify(completionKinds) === JSON.stringify([IRRIGATION, MINE]),
        `work finishes on the catalog's own turn: the 2-turn irrigation on the second turn (state turn 3) and the 3-turn mine on the third (state turn 4), one WorkCompleted each (turns ${JSON.stringify(completionTurns)}, kinds ${JSON.stringify(completionKinds)})`,
      ),
      check(
        JSON.stringify(movement) ===
          JSON.stringify([
            [2, 2],
            [2, 2],
            [2, 2],
          ]),
        `a job costs no movement per turn: step 4 refills both workers to the catalog's 2 every turn (got ${JSON.stringify(movement)})`,
      ),
      check(
        state.turn === 4 &&
          !hasWorkKey(state, 0) &&
          !hasWorkKey(state, 1) &&
          state.improvements.length === 2,
        `after the third turn both workers are idle with no \`work\` key at all, and the state holds exactly the two pairs (turn ${String(state.turn)}, pairs ${JSON.stringify(state.improvements)})`,
      ),
      check(
        state.improvements.map((pair) => pair.kind).join(',') === `${IRRIGATION},${MINE}`,
        `and they are ordered by tile, then kind — the order the pair list is hashed in (kinds: ${state.improvements.map((pair) => pair.kind).join(',')})`,
      ),
      check(
        hashes.length === 4 && hashes.every((hash) => /^[0-9a-f]{16}$/.test(hash)),
        `every state along the way — each turn, a job at two different counts, an idle worker whose \`work\` key is gone — canonicalises and hashes, so no state in this sequence carries a key holding undefined (hashes: ${JSON.stringify(hashes)})`,
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * The four M4a scenarios, as tests
 * ------------------------------------------------------------------ */

describe('M4a scenario: mine yield', () => {
  it('pays exactly one shield more a turn from the turn the mine is finished', () => {
    const result = runScenario(mineYieldScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the mine scenario must build a state');

    // Two of the mine's three turns are paid, and nothing is built yet.
    expect(after.turn).toBe(3);
    expect(after.revision).toBe(3);
    expect(after.improvements).toEqual([]);
    expect(cityYields(after, RULESET, asCityId(0))).toEqual({
      food: 2,
      shields: 3,
      commerce: 1,
      foodSurplus: 0,
    });
    expect(cityById(after, asCityId(0))?.shields).toBe(6);
    expect(workOf(after, 0)).toEqual({ kind: MINE, tile: MINE_TILE, turnsLeft: 1 });

    // Progress is state, not an event: the run emitted the `WorkStarted` and the
    // two turns' worth of events and nothing else — no per-turn progress event, and
    // no completion before the last turn is paid. The hill the single citizen works
    // has no commerce, so Rome's one city earns its centre's 1 commerce at 6/4/0:
    // floor(0.6) = 0 gold + floor(0.4) = 0 beakers, and the leftover 1 is gold.
    const mineLedger: readonly GameEvent[] = [
      incomeEvent(ROME, 1, 0, 0),
      upkeepEvent(ROME, 0, 0, 0, 1, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
    ];
    expect(result.events).toEqual([
      { type: 'WorkStarted', unitId: asUnitId(0), kind: MINE, tile: MINE_TILE, turnsLeft: 3 },
      ...mineLedger,
      turnEnded(2),
      ...mineLedger,
      turnEnded(3),
    ]);
  });

  it('walks the job by hand: one turn a turn, 4 shields on the last one, and the pair exactly once', () => {
    const built = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER, [6, 5])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], { population: 1, workedTiles: [MINE_TILE] })
      .build();
    if (!built.ok) throw new Error(`the mine fixture must build: ${JSON.stringify(built.error)}`);

    const started = romeApply(built.value, RULESET, startWork(0, MINE));
    if (started === undefined) throw new Error('StartWork must apply to an idle worker on hills');
    expect(started.state.turn).toBe(1);
    expect(started.state.improvements).toEqual([]);
    expect(workOf(started.state, 0)).toEqual({ kind: MINE, tile: MINE_TILE, turnsLeft: 3 });
    // Starting the job spends the unit's whole turn (M4a: "it costs the unit's
    // remaining movement for the turn") and builds nothing.
    expect(unitById(started.state, asUnitId(0))?.movementLeft).toBe(0);

    const shields: number[] = [];
    const turnsLeft: number[] = [];
    const pairs: number[] = [];
    const completedOn: number[] = [];
    let state = started.state;
    for (let turn = 0; turn < 3; turn += 1) {
      const step = romeApply(state, RULESET, endTurn());
      if (step === undefined) throw new Error('EndTurn must apply');
      state = step.state;

      shields.push(cityById(state, asCityId(0))?.shields ?? -1);
      // `-1` is "no `work` key at all"; the engine completes a job on reaching 0,
      // so a count of 0 never reaches the state.
      turnsLeft.push(workOf(state, 0)?.turnsLeft ?? -1);
      pairs.push(state.improvements.length);
      if (step.events.some((event) => event.type === 'WorkCompleted')) {
        completedOn.push(state.turn);
      }
    }

    expect(shields).toEqual([3, 6, 10]);
    expect(turnsLeft).toEqual([2, 1, -1]);
    expect(pairs).toEqual([0, 0, 1]);
    expect(completedOn).toEqual([4]); // the third turn, and only that turn
    expect(state.turn).toBe(4);
    expect(state.improvements).toEqual([{ tile: MINE_TILE, kind: MINE }]);
    expect(hasWorkKey(state, 0)).toBe(false);

    // The mine keeps paying: the next turn banks the same 4 shields.
    const fourth = romeApply(state, RULESET, endTurn());
    expect(fourth?.state.turn).toBe(5);
    expect(cityById(fourth?.state ?? state, asCityId(0))?.shields).toBe(14);
  });
});

describe('M4a scenario: work cancelled by movement', () => {
  it('cancels the job with a typed WorkCancelled and builds nothing', () => {
    const result = runScenario(workCancelledScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the cancellation scenario must build a state');

    // The engine's own account, in the order it happened: the move, then the
    // cancellation it caused (reason `moved`, and the two turns still owed are
    // reported rather than refunded). M4b's ledger lines sit between them because
    // the one `EndTurn` in the run came first in the command list: this world has
    // no city at all, so both civilizations earn nothing and owe nothing — Rome's
    // two workers are still inside the 4 free units a cityless player gets.
    expect(result.events).toEqual([
      { type: 'WorkStarted', unitId: asUnitId(0), kind: MINE, tile: CANCEL_HILL, turnsLeft: 3 },
      {
        type: 'WorkStarted',
        unitId: asUnitId(1),
        kind: IRRIGATION,
        tile: CANCEL_FLAT,
        turnsLeft: 2,
      },
      incomeEvent(ROME, 0, 0, 0),
      upkeepEvent(ROME, 0, 0, 0, 2, 4),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(2),
      {
        type: 'UnitMoved',
        unitId: asUnitId(0),
        from: CANCEL_HILL,
        to: CANCEL_DESTINATION,
        cost: 1,
        movementLeft: 1,
      },
      {
        type: 'WorkCancelled',
        unitId: asUnitId(0),
        kind: MINE,
        tile: CANCEL_HILL,
        turnsLeft: 2,
        reason: 'moved',
      },
    ]);

    // The state says the same thing: no job key, no pair, and the worker that
    // stayed is still working.
    expect(hasWorkKey(after, 0)).toBe(false);
    expect(unitById(after, asUnitId(0))?.tile).toBe(CANCEL_DESTINATION);
    expect(workOf(after, 1)).toEqual({
      kind: IRRIGATION,
      tile: CANCEL_FLAT,
      turnsLeft: 1,
    });
    expect(after.improvements).toEqual([]);
    expect(hasImprovement(after, CANCEL_HILL, MINE)).toBe(false);
    expect(hasImprovement(after, CANCEL_FLAT, IRRIGATION)).toBe(false);
  });
});

describe('M4a scenario: illegal work refused', () => {
  it('refuses each illegal job with its exact typed error and leaves the hash unchanged', () => {
    const result = runScenario(illegalWorkScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the illegal-work scenario must build a state');

    // No `run` command at all: the scenario refuses everything by probing, so the
    // runner's event list is empty and the built world is untouched.
    expect(result.events).toEqual([]);
    expect(after.revision).toBe(0);
    expect(after.improvements).toEqual([{ tile: IMPROVED_HILL, kind: MINE }]);

    // The exact errors, deep-equal, so a changed field is a changed test.
    expect(refusal(applyCommand(after, ROME, startWork(0, MINE), RULESET))).toEqual({
      kind: 'improvement-not-allowed',
      unitId: asUnitId(0),
      tile: WRONG_ROLE_TILE,
      improvement: MINE,
      role: 'grassland',
    });
    expect(refusal(applyCommand(after, ROME, startWork(1, IRRIGATION), RULESET))).toEqual({
      kind: 'improvement-not-allowed',
      unitId: asUnitId(1),
      tile: IMPROVED_HILL,
      improvement: IRRIGATION,
      role: 'hills',
    });
    expect(refusal(applyCommand(after, ROME, startWork(1, MINE), RULESET))).toEqual({
      kind: 'already-improved',
      tile: IMPROVED_HILL,
      improvement: MINE,
    });
    expect(refusal(applyCommand(after, ROME, startWork(0, NOT_AN_IMPROVEMENT), RULESET))).toEqual({
      kind: 'unknown-improvement',
      improvement: NOT_AN_IMPROVEMENT,
    });
    expect(refusal(applyCommand(after, CARTHAGE, startWork(3, MINE), RULESET))).toEqual({
      kind: 'not-a-worker',
      unitId: asUnitId(3),
    });

    // The keystone pair, outside the scenario: the same command shape is accepted
    // where it is legal, so the refusals above are specific.
    const hashBefore = hashValue(after);
    const legal = applyCommand(after, ROME, startWork(2, IRRIGATION), RULESET);
    expect(legal.ok).toBe(true);
    if (legal.ok) {
      expect(legal.value.state.revision).toBe(1);
      expect(workOf(legal.value.state, 2)).toEqual({
        kind: IRRIGATION,
        tile: CONTROL_TILE,
        turnsLeft: 2,
      });
      // Starting a job builds nothing: the pair lands when its last turn is paid.
      expect(legal.value.state.improvements).toEqual([{ tile: IMPROVED_HILL, kind: MINE }]);
    }
    // A refused command leaves the state alone — and the refusals happened before
    // this control, so the hash is the same one it started with.
    expect(hashValue(after)).toBe(hashBefore);

    // `already-working` is reachable only once a job exists, so it is probed from
    // the applied control rather than from the built world: a worker may hold one
    // job at a time, and the refusal names the job it already has.
    const working = applyCommand(after, ROME, startWork(2, IRRIGATION), RULESET);
    expect(working.ok).toBe(true);
    if (working.ok) {
      expect(refusal(applyCommand(working.value.state, ROME, startWork(2, ROAD), RULESET))).toEqual(
        {
          kind: 'already-working',
          unitId: asUnitId(2),
          improvement: IRRIGATION,
        },
      );
      expect(workOf(working.value.state, 2)).toEqual({
        kind: IRRIGATION,
        tile: CONTROL_TILE,
        turnsLeft: 2,
      });
    }
  });
});

describe('M4a scenario: work timing', () => {
  it('pays one turn of each job a turn and finishes each on its catalog turn', () => {
    const result = runScenario(workTimingScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the timing scenario must build a state');

    expect(after.turn).toBe(1);
    expect(after.revision).toBe(2);
    expect(after.improvements).toEqual([]);
    expect(workOf(after, 0)).toEqual({ kind: MINE, tile: TIMING_HILL, turnsLeft: 3 });
    expect(workOf(after, 1)).toEqual({ kind: IRRIGATION, tile: TIMING_FLAT, turnsLeft: 2 });

    // `WorkStarted` reports the catalog's own count, so a consumer can render
    // "3 turns" without reading the ruleset — and the run emitted no completion,
    // because no turn has been paid yet.
    expect(result.events).toEqual([
      { type: 'WorkStarted', unitId: asUnitId(0), kind: MINE, tile: TIMING_HILL, turnsLeft: 3 },
      {
        type: 'WorkStarted',
        unitId: asUnitId(1),
        kind: IRRIGATION,
        tile: TIMING_FLAT,
        turnsLeft: 2,
      },
    ]);

    // Outside the scenario: two turns take the shorter job and three the longer
    // one, with the pair list growing one entry at a time.
    const second = endTurnsFrom(after, RULESET, 2);
    expect(second?.turn).toBe(3);
    expect(second?.improvements).toEqual([{ tile: TIMING_FLAT, kind: IRRIGATION }]);
    expect(workOf(second ?? after, 0)).toEqual({ kind: MINE, tile: TIMING_HILL, turnsLeft: 1 });
    expect(hasWorkKey(second ?? after, 1)).toBe(false);

    const third = second === undefined ? undefined : endTurnsFrom(second, RULESET, 1);
    expect(third?.turn).toBe(4);
    expect(third?.improvements).toEqual([
      { tile: TIMING_FLAT, kind: IRRIGATION },
      { tile: TIMING_HILL, kind: MINE },
    ]);
    expect(hasWorkKey(third ?? after, 0)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The builder's M4a addition, and what it refuses
 * ------------------------------------------------------------------ */

describe('the scenario builder states M4a worlds', () => {
  /** A world ready to improve: two civilizations, one hill, a worker on it. */
  const m4aWorld = (): ScenarioBuilder =>
    createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .setTile(8, 5, 'hills')
      .addUnit(0, WORKER, [6, 5])
      .addUnit(1, WARRIOR, [20, 20]);

  it('starts with nothing built, and says so with an empty list rather than a missing key', () => {
    const built = m4aWorld().build();
    if (!built.ok) throw new Error(`the M4a fixture must build: ${JSON.stringify(built.error)}`);

    expect(built.value.improvements).toEqual([]);
    expect(Object.hasOwn(built.value, 'improvements')).toBe(true);
    // An empty array of pairs is hashable, which is why "nothing is built" is an
    // empty list and not an `undefined` (canonicalize refuses `undefined`).
    expect(hashValue(built.value)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('places improvements as sorted, unique pairs, whatever order they were written in', () => {
    const built = m4aWorld()
      .addImprovement(8, 5, MINE)
      .addImprovement(6, 5, ROAD)
      .addImprovement(6, 5, MINE)
      .build();
    if (!built.ok)
      throw new Error(`the improvement fixture must build: ${JSON.stringify(built.error)}`);
    const state = built.value;

    // Sorted by (tile, kind), unique pairs: `withImprovement` establishes the order
    // the pair list is hashed in, and the builder goes through it rather than
    // appending an array of its own.
    expect(state.improvements).toEqual([
      { tile: at(6, 5), kind: ROAD },
      { tile: at(6, 5), kind: MINE },
      { tile: at(8, 5), kind: MINE },
    ]);
    // Two different kinds share one tile — that is why this is a list of pairs.
    expect(improvementsAt(state, at(6, 5))).toEqual([ROAD, MINE]);
    expect(improvementsAt(state, at(8, 5))).toEqual([MINE]);
    expect(improvementsAt(state, at(5, 5))).toEqual([]);
    expect(hasImprovement(state, at(6, 5), MINE)).toBe(true);
    expect(hasImprovement(state, at(6, 5), IRRIGATION)).toBe(false);

    // Plain data: the pairs survive a JSON round trip, so the state stays hashable
    // (an `undefined` anywhere in the field would make `canonicalize` throw).
    const roundTripped: unknown = JSON.parse(JSON.stringify(state));
    expect(hashValue(roundTripped)).toBe(hashValue(state));

    // The builder places improvements *before* it assigns citizens, so a
    // hand-built world matches a played one: `autoAssignWorkedTiles` ranks a tile
    // by what it is worth, improvements included.
    const irrigated = m4aWorld()
      .addImprovement(4, 5, IRRIGATION)
      .addCity(0, [5, 5], { population: 1 })
      .build();
    if (!irrigated.ok) throw new Error('the irrigated fixture must build');
    expect(tileYields(irrigated.value, RULESET, at(4, 5))).toEqual({
      food: 3,
      shields: 1,
      commerce: 1,
    });
    expect(cityById(irrigated.value, asCityId(0))?.workedTiles).toEqual([at(4, 5)]);

    // Control: the same city with nothing built takes the lowest-index grassland
    // (2 food), because the irrigated tile's 3 food no longer outranks anything.
    const plain = m4aWorld().addCity(0, [5, 5], { population: 1 }).build();
    expect(plain.ok ? cityById(plain.value, asCityId(0))?.workedTiles : undefined).toEqual([
      at(4, 3),
    ]);
  });

  it('leaves the city centre alone, because the centre is not a worked tile', () => {
    // M4a: "The city centre is unaffected by improvements — it is not a worked
    // tile." A mine on a hills centre is a world the command layer *can* produce
    // (a worker standing in the city could dig there), so the yields must show it
    // buys the city nothing.
    const withCentreMine = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(5, 5, 'hills')
      .addImprovement(5, 5, MINE)
      .addUnit(0, WORKER, [30, 30])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], { population: 1, workedTiles: [at(4, 5)] })
      .build();
    if (!withCentreMine.ok) throw new Error('the hills-centre fixture must build');

    // Centre: hills floored to 1 food / 2 shields / 1 commerce; worked tile:
    // grassland 2 food / 1 shield / 1 commerce.
    expect(cityYields(withCentreMine.value, RULESET, asCityId(0))).toEqual({
      food: 3,
      shields: 3,
      commerce: 2,
      foodSurplus: 1,
    });
    // The pair is really there — 3 shields is what the *city* makes, and 4 would
    // be the number if the centre counted improvements.
    expect(hasImprovement(withCentreMine.value, at(5, 5), MINE)).toBe(true);
    expect(tileYields(withCentreMine.value, RULESET, at(5, 5))).toEqual({
      food: 0,
      shields: 3,
      commerce: 0,
    });

    const withoutMine = createScenarioBuilder(RULESET, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(5, 5, 'hills')
      .addUnit(0, WORKER, [30, 30])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], { population: 1, workedTiles: [at(4, 5)] })
      .build();
    if (!withoutMine.ok) throw new Error('the control fixture must build');
    expect(cityYields(withoutMine.value, RULESET, asCityId(0))).toEqual(
      cityYields(withCentreMine.value, RULESET, asCityId(0)),
    );
  });

  it('refuses an improvement it cannot place honestly', () => {
    expect(() => m4aWorld().addImprovement(DUEL.width, 0, MINE)).toThrow(
      /outside this world's 40x40 map/,
    );
    expect(() => m4aWorld().addImprovement(0, -1, ROAD)).toThrow(/outside this world's 40x40 map/);
    expect(() => m4aWorld().addImprovement(6, 5, NOT_AN_IMPROVEMENT)).toThrow(
      /defines no improvement "nope"/,
    );
    expect(() => m4aWorld().addImprovement(6, 5, MINE).addImprovement(6, 5, MINE)).toThrow(
      /called twice for one tile/,
    );

    // The terrain under the tile is only final once every setTile has run, so the
    // allowedRoles rule — the same rule `StartWork` enforces — is checked at build().
    expect(() => m4aWorld().addImprovement(4, 4, MINE).build()).toThrow(
      /not in its allowedRoles \(hills, mountains\)/,
    );
    expect(() => m4aWorld().addImprovement(6, 5, IRRIGATION).build()).toThrow(
      /not in its allowedRoles \(grassland, plains\)/,
    );
    expect(() => m4aWorld().setTile(4, 4, 'ocean').addImprovement(4, 4, ROAD).build()).toThrow(
      /not in its allowedRoles/,
    );
    // A later setTile can rescue an earlier addImprovement: the check is at build().
    expect(m4aWorld().addImprovement(4, 4, MINE).setTile(4, 4, 'hills').build().ok).toBe(true);

    // Controls: the same calls where the terrain does allow it build, and several
    // different kinds may share one tile.
    expect(m4aWorld().addImprovement(6, 5, MINE).build().ok).toBe(true);
    expect(m4aWorld().addImprovement(4, 4, IRRIGATION).build().ok).toBe(true);
    expect(m4aWorld().setTile(4, 4, 'plains').addImprovement(4, 4, IRRIGATION).build().ok).toBe(
      true,
    );
    expect(m4aWorld().addImprovement(4, 4, ROAD).build().ok).toBe(true);
    expect(m4aWorld().addImprovement(6, 5, MINE).addImprovement(6, 5, ROAD).build().ok).toBe(true);
  });

  it('reports M4a refusals by name, so a refused run command is readable', () => {
    const illegal: Scenario = {
      name: 'run-a-mine-on-grassland',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .addUnit(0, WORKER, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [startWork(0, MINE)],
      assert: () => [check(true, 'the assert callback still runs after a refused command')],
    };

    const result = runScenario(illegal);

    expect(result.passed).toBe(false);
    expect(result.assertions[0]?.message).toBe(
      'run[0] StartWork by unit 0 on improvement "mine" was refused: ' +
        `improvement-not-allowed ("mine" cannot be built on "grassland" at tile ${String(Number(at(5, 5)))}, where unit 0 stands)`,
    );
    expect(result.finalState?.revision).toBe(0);

    const cancelAnIdleUnit: Scenario = {
      name: 'run-cancel-on-an-idle-worker',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .addUnit(0, WORKER, [5, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [{ type: 'CancelWork', unitId: asUnitId(0) }],
      assert: () => [check(true, 'the assert callback still runs after a refused command')],
    };

    const cancelled = runScenario(cancelAnIdleUnit);
    expect(cancelled.passed).toBe(false);
    expect(cancelled.assertions[0]?.message).toBe(
      'run[0] CancelWork by unit 0 was refused: not-working (unit 0 has no job to cancel)',
    );
    expect(cancelled.finalState?.revision).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Falsification: the M4a scenarios' assertions must be able to fail
 * ------------------------------------------------------------------ */

describe('the M4a scenario assertions discriminate (they are not decoration)', () => {
  it('the mine-yield assertions fail when the city does not work the mined tile', () => {
    // The mine is still dug on the hill at (6,5), but the citizen works the
    // grassland at (4,3): the improved tile is not the tile the city counts, so
    // the shield rate and the completing turn's total must both disagree. This is
    // the difference between "a mine appeared somewhere" and "the worked tile got
    // better".
    const variant: Scenario = {
      name: 'mine-yield-on-an-unworked-tile',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'hills')
          .addUnit(0, WORKER, [6, 5])
          .addUnit(1, WARRIOR, [20, 20])
          .addCity(0, [5, 5], { population: 1, workedTiles: [at(4, 3)] }),
      run: [startWork(0, MINE), endTurn(), endTurn()],
      assert: assertOf(mineYieldScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/BEFORE the mine the city makes 3 shields a turn/);
    expect(text).toMatch(/the completing turn pays at the improved rate/);

    // The world itself is the one the scenario described, and the job is one turn
    // from done — so those failures are about the *yields* and not about a mine
    // that was never dug. (`run` stops before the completing turn, so the pair is
    // still absent from the final state; the `assert` callback's own probe is what
    // completes it.)
    const finalState = result.finalState;
    if (finalState === undefined) {
      throw new Error('the unworked-tile variant must still build a world');
    }
    expect(finalState.turn).toBe(3);
    expect(workOf(finalState, 0)?.turnsLeft).toBe(1);
    expect(finalState.improvements).toEqual([]);
  });

  it('the cancellation assertions fail when the worker is never moved', () => {
    // The same two jobs and one turn, but the digger does not walk away: its job
    // survives, its tile stays bare only because nothing finished, and every
    // "cancelled by movement" expectation has to break.
    const variant: Scenario = {
      name: 'work-survives-because-nothing-moved',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'hills')
          .addUnit(0, WORKER, [6, 5])
          .addUnit(0, WORKER, [4, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [startWork(0, MINE), startWork(1, IRRIGATION), endTurn(), endTurn()],
      assert: assertOf(workCancelledScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/its job is GONE/);
    expect(text).toMatch(/no improvement was added/);

    // The digger's job is still in the state, which is what makes the assertion
    // above a real claim about the move rather than about the turn passing.
    const finalState = result.finalState;
    if (finalState === undefined) {
      throw new Error('the never-moved variant must still build a world');
    }
    expect(unitById(finalState, asUnitId(0))?.work?.turnsLeft).toBe(1);
  });

  it('the illegal-work assertions fail when the terrain does allow the job', () => {
    // The same world with a hill under the worker the scenario says is on the
    // wrong terrain: the mine is now legal, applies, and the typed refusal that
    // was expected must not be silently tolerated.
    const variant: Scenario = {
      name: 'illegal-work-that-is-actually-legal',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(5, 5, 'hills') // the one difference: worker 0 now stands on rock
          .setTile(7, 5, 'hills')
          .addImprovement(7, 5, MINE)
          .addUnit(0, WORKER, [5, 5])
          .addUnit(0, WORKER, [7, 5])
          .addUnit(0, WORKER, [9, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      assert: assertOf(illegalWorkScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(
      /a mine on grassland is refused with improvement-not-allowed/,
    );
  });

  it('the work-timing assertions fail when a turn has already been paid', () => {
    // The same two jobs, but one `EndTurn` is inside the run: every count and
    // every completion turn is then one off, which is exactly what the scenario's
    // per-turn sequence exists to catch.
    const variant: Scenario = {
      name: 'work-timing-with-a-turn-already-paid',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTile(6, 5, 'hills')
          .addUnit(0, WORKER, [6, 5])
          .addUnit(0, WORKER, [4, 5])
          .addUnit(1, WARRIOR, [20, 20]),
      run: [startWork(0, MINE), startWork(1, IRRIGATION), endTurn()],
      assert: assertOf(workTimingScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/the run only STARTED the two jobs, on turn 1/);
    expect(text).toMatch(/each turn pays exactly one turn of each job and no more/);
  });
});

/* ------------------------------------------------------------------ *
 * M4b acceptance evidence — the money loop
 * ------------------------------------------------------------------ */

/**
 * EVERY number in this section is a **placeholder** and is asserted as one. The
 * tuning constants it leans on — `FREE_UNITS_PER_CITY` (2), `FREE_UNITS_BASE` (4),
 * `UNIT_SUPPORT_COST` (1), `RATE_TOTAL` (10), `DEFAULT_RATES` (6/4/0) and
 * `STARTING_TREASURY` (10) — are M4b's own tuned values (docs/INTERFACES.md M4b,
 * "Rates and the commerce split" / "The money loop"), chosen to be playable and
 * explicitly **not** sourced from Civ 3: no row below claims that any of them is
 * Civ 3's figure, and the scenarios assert them as the engine's placeholders
 * (as the M4a mine scenario asserts `mineDef.turns === 3`) so that changing one is
 * a decision someone has to make on purpose.
 *
 * The two event shapes the money loop adds are read through these aliases, so a
 * test that wants "the gold this player collected" says so in its own words rather
 * than narrowing a union by hand at every call site.
 */
type IncomeCollectedEvent = Extract<GameEvent, { readonly type: 'IncomeCollected' }>;
type UpkeepPaidEvent = Extract<GameEvent, { readonly type: 'UpkeepPaid' }>;
type UnitDisbandedEvent = Extract<GameEvent, { readonly type: 'UnitDisbanded' }>;
type TreasuryShortfallEvent = Extract<GameEvent, { readonly type: 'TreasuryShortfall' }>;

/** The money fields of a player, in one value a test can compare outright. */
interface Money {
  readonly treasury: number;
  readonly beakers: number;
  readonly luxuries: number;
}

const moneyOf = (state: GameState, playerId: PlayerId): Money => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error(`player ${String(playerId)} is not in the state`);
  return {
    treasury: player.treasury,
    beakers: player.beakers,
    luxuries: player.luxuries,
  };
};

const incomeLines = (
  events: readonly GameEvent[],
  playerId: PlayerId,
): readonly IncomeCollectedEvent[] =>
  events.filter(
    (event): event is IncomeCollectedEvent =>
      event.type === 'IncomeCollected' && event.playerId === playerId,
  );

const upkeepLines = (
  events: readonly GameEvent[],
  playerId: PlayerId,
): readonly UpkeepPaidEvent[] =>
  events.filter(
    (event): event is UpkeepPaidEvent => event.type === 'UpkeepPaid' && event.playerId === playerId,
  );

const disbandLines = (
  events: readonly GameEvent[],
  playerId: PlayerId,
): readonly UnitDisbandedEvent[] =>
  events.filter(
    (event): event is UnitDisbandedEvent =>
      event.type === 'UnitDisbanded' && event.playerId === playerId,
  );

const shortfallLines = (
  events: readonly GameEvent[],
  playerId: PlayerId,
): readonly TreasuryShortfallEvent[] =>
  events.filter(
    (event): event is TreasuryShortfallEvent =>
      event.type === 'TreasuryShortfall' && event.playerId === playerId,
  );

/** One player's ledger line for one turn, read off the event stream alone. */
interface Ledger {
  readonly income: number;
  readonly beakers: number;
  readonly luxuries: number;
  readonly upkeep: number;
  /** What the disbands of this turn paid for: the sum of `UnitDisbanded.saved`. */
  readonly covered: number;
  /** What nobody paid: the sum of `TreasuryShortfall.unpaid`. */
  readonly unpaid: number;
  readonly disbanded: readonly number[];
}

/**
 * One turn's ledger for `playerId`, reconstructed from the events and from nothing
 * else — which is the point: the acceptance criterion is that gold is *accounted
 * for*, and an account kept from the state would assume what it is checking.
 */
const ledgerOf = (events: readonly GameEvent[], playerId: PlayerId): Ledger => {
  const income = incomeLines(events, playerId);
  const upkeep = upkeepLines(events, playerId);
  const disbands = disbandLines(events, playerId);
  const shortfalls = shortfallLines(events, playerId);
  return {
    income: income.reduce((total, line) => total + line.gold, 0),
    beakers: income.reduce((total, line) => total + line.beakers, 0),
    luxuries: income.reduce((total, line) => total + line.luxuries, 0),
    upkeep: upkeep.reduce((total, line) => total + line.gold, 0),
    covered: disbands.reduce((total, line) => total + line.saved, 0),
    unpaid: shortfalls.reduce((total, line) => total + line.unpaid, 0),
    disbanded: disbands.map((line) => Number(line.unitId)),
  };
};

/** The commerce `playerId`'s cities produce in `state` — the sum the split divides. */
const commerceOf = (state: GameState, ruleset: RulesetView, playerId: PlayerId): number =>
  state.cities
    .filter((city) => city.owner === playerId)
    .reduce((total, city) => total + cityYields(state, ruleset, city.id).commerce, 0);

/** One command as an arbitrary player, thrown away on refusal — for hand-walked turns. */
const applyFor = (
  state: GameState,
  playerId: PlayerId,
  command: Command,
  ruleset: RulesetView,
): CommandOutcome => {
  const result = applyCommand(state, playerId, command, ruleset);
  if (!result.ok) {
    throw new Error(
      `${command.type} as player ${String(playerId)} was refused: ${result.error.kind}`,
    );
  }
  return result.value;
};

/* ------------------------------------------------------------------ *
 * 11. Bankruptcy
 * ------------------------------------------------------------------ */

/** Where Rome's twelve workers stand: unit `n` on `(10 + n, 10)`, ids 0..11. */
const BANKRUPTCY_ARMY: readonly (readonly [number, number])[] = [
  [10, 10],
  [11, 10],
  [12, 10],
  [13, 10],
  [14, 10],
  [15, 10],
  [16, 10],
  [17, 10],
  [18, 10],
  [19, 10],
  [20, 10],
  [21, 10],
];

const BANKRUPTCY_FARM = at(4, 3);
const BANKRUPTCY_START = 5;

/**
 * The bankruptcy world, shared by the scenario and by the falsification tests
 * below, so that a variant differs from the real thing in exactly one stated way.
 *
 * Rome: one city on grassland whose single citizen works another grassland tile
 * (commerce 2 -> 2 gold a turn at 6/4/0), a treasury of 5, and **twelve** workers.
 * Carthage: one warrior, far away, with no city and nothing to pay.
 */
const bankruptcySetup = (b: ScenarioBuilder): ScenarioBuilder => {
  let builder = b
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .setTreasury(0, BANKRUPTCY_START);
  for (const [x, y] of BANKRUPTCY_ARMY) {
    builder = builder.addUnit(0, WORKER, [x, y]);
  }
  return builder
    .addUnit(1, WARRIOR, [20, 20])
    .addCity(0, [5, 5], { population: 1, workedTiles: [BANKRUPTCY_FARM] });
};

/**
 * BANKRUPTCY. Rome owns more units than it can support, from a treasury that
 * cannot cover the bill, and the money loop's answer is exact.
 *
 * The arithmetic, on the frozen placeholder constants:
 *
 * - Rome's allowance is `FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE` = 2 + 4 = **6**,
 *   so of its twelve workers **6** cost `UNIT_SUPPORT_COST` = 1 gold each: an
 *   upkeep of **6** a turn. Carthage has no city, so its allowance is 4 and its
 *   single warrior is free.
 * - Rome's income is its one city's commerce 2 (grassland centre 1 + the worked
 *   grassland 1) at 6/4/0: `floor(2*6/10)` = 1 gold, `floor(2*4/10)` = 0 beakers,
 *   0 luxuries, and the leftover 1 goes to gold — **2 gold** a turn.
 * - So a turn with the whole army is `+2 income - 6 upkeep` = **-4**, from a
 *   treasury of 5.
 *
 * The timeline, exactly:
 *
 * 1. **turn 2** — 5 + 2 - 6 = **1** gold. Solvent, and no unit is touched.
 * 2. **turn 3** — 1 + 2 - 6 = -3. The treasury floors at **0** and the shortfall
 *    of 3 is paid by disbanding the player's **highest-id** units one at a time:
 *    worker **11** (tile 421), then **10** (420), then **9** (419), each `saved: 1`,
 *    which covers the 3 owed exactly. Nine workers remain, so the bill falls to 3.
 * 3. **turn 4** — 0 + 2 - 3 = -1. Worker **8** (418) goes, and the bill falls to
 *    2 = income: the treasury is **0** and stays there, because the disband stops
 *    the moment the bill fits. The fixed point of the money loop is "broke but
 *    breaking even".
 * 4. **turn 5** — 0 + 2 - 2 = 0: nobody is taken, no `TreasuryShortfall`, and the
 *    treasury is still exactly **0**.
 * 5. **turn 6** — the city's food box fills and it grows to two citizens, so its
 *    commerce is 3 and the collection is 2 gold plus its first beaker; the bill is
 *    still 2, so the treasury is still exactly **0**.
 *
 * `run` is steps 1-3 (the state it returns is at turn 4, treasury 0, army ids 0..7,
 * with three of the four disbands in its event list) and the assertions probe
 * steps 4 and 5.
 *
 * Nothing here is a rounding-away of a negative number: the treasury is never
 * negative at any point in the sequence, and the disbands are what make that true
 * while still paying the bill.
 */
const bankruptcyScenario = defineScenario({
  name: 'bankruptcy-disbands-the-highest-id-unit-until-the-shortfall-is-covered',
  settings: DUEL_SETTINGS,
  setup: bankruptcySetup,
  run: [endTurn(), endTurn(), endTurn()],
  assert: (after, ruleset) => {
    const army = after.units.filter((unit) => unit.owner === ROME);
    const support = unitSupport(after, ROME);
    const income = playerIncome(after, ruleset, ROME);

    // The two turns after the run stops: the first takes nobody, the second grows
    // the city.
    const next = romeApply(after, ruleset, endTurn());
    const later = next === undefined ? undefined : romeApply(next.state, ruleset, endTurn());
    const afterNext = next?.state;
    const afterLater = later?.state;
    const nextLedger = next === undefined ? undefined : ledgerOf(next.events, ROME);
    const grew = later?.events.some((event) => event.type === 'CityGrew') === true;
    const laterIncome = later === undefined ? undefined : incomeLines(later.events, ROME)[0];

    // Every treasury the scenario can see, in the order the turns produced them.
    const observed = [
      { where: 'the state the run stopped at', gold: moneyOf(after, ROME).treasury },
      {
        where: 'after the next turn',
        gold: afterNext === undefined ? -1 : moneyOf(afterNext, ROME).treasury,
      },
      {
        where: 'after the turn after that',
        gold: afterLater === undefined ? -1 : moneyOf(afterLater, ROME).treasury,
      },
    ];

    return [
      check(
        support.free === FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE &&
          support.gold === UNIT_SUPPORT_COST * support.supported,
        `the allowance is the engine's own formula — FREE_UNITS_PER_CITY per city plus FREE_UNITS_BASE, and UNIT_SUPPORT_COST for each unit beyond it: ${String(FREE_UNITS_PER_CITY)}*1 + ${String(FREE_UNITS_BASE)} = ${String(support.free)} free, ${String(UNIT_SUPPORT_COST)} * ${String(support.supported)} = ${String(support.gold)} owed (the PLACEHOLDER 2/4/1)`,
      ),
      check(
        support.free === 6 &&
          BANKRUPTCY_ARMY.length === 12 &&
          support.units === 8 &&
          support.supported === 2 &&
          support.gold === 2,
        `Rome's allowance is 2*1 + 4 = 6, and the twelve workers it started with are down to eight, so the bill is 2 (the world's army ${String(BANKRUPTCY_ARMY.length)}, in the final state units ${String(support.units)}, free ${String(support.free)}, supported ${String(support.supported)}, gold ${String(support.gold)})`,
      ),
      check(
        income.gold === 2 && income.beakers === 0 && income.luxuries === 0,
        `Rome's one city makes 2 commerce, which is 2 gold (floor(1.2) = 1 plus the leftover 1) and no beakers at 6/4/0 (got ${JSON.stringify(income)})`,
      ),
      check(
        after.turn === 4 && after.revision === 3,
        `the run applied exactly three EndTurns: the state is at turn 4 with revision 3 (got turn ${String(after.turn)}, revision ${String(after.revision)})`,
      ),
      check(
        moneyOf(after, ROME).treasury === 0 &&
          army.map((unit) => Number(unit.id)).join(',') === '0,1,2,3,4,5,6,7',
        `the two bankruptcy turns left the treasury at exactly 0 and took workers 11, 10, 9 and 8, so the army is ids 0..7 (gold ${String(moneyOf(after, ROME).treasury)}, units ${army.map((unit) => String(unit.id)).join(',')})`,
      ),
      check(
        next !== undefined &&
          nextLedger !== undefined &&
          disbandLines(next.events, ROME).length === 0 &&
          shortfallLines(next.events, ROME).length === 0 &&
          afterNext !== undefined &&
          moneyOf(afterNext, ROME).treasury === 0,
        `the next turn takes nobody: with the bill down to 2 = income the treasury sits at exactly 0, and no TreasuryShortfall is emitted because nothing was left unpaid (gold ${String(afterNext === undefined ? 'no state' : moneyOf(afterNext, ROME).treasury)})`,
      ),
      check(
        nextLedger !== undefined &&
          afterNext !== undefined &&
          nextLedger.income - nextLedger.upkeep + nextLedger.covered + nextLedger.unpaid ===
            moneyOf(afterNext, ROME).treasury - moneyOf(after, ROME).treasury,
        `and that turn's ledger balances to the gold: ${String(nextLedger?.income)} income - ${String(nextLedger?.upkeep)} upkeep + ${String(nextLedger?.covered)} covered = the treasury's own delta (${nextLedger === undefined || afterNext === undefined ? 'no turn' : String(moneyOf(afterNext, ROME).treasury - moneyOf(after, ROME).treasury)})`,
      ),
      check(
        grew &&
          laterIncome !== undefined &&
          laterIncome.gold === 2 &&
          laterIncome.beakers === 1 &&
          afterLater !== undefined &&
          moneyOf(afterLater, ROME).treasury === 0,
        `the turn after that grows the city (commerce 2 -> 3, so the collection is 2 gold and its first beaker) and the treasury is still exactly 0 (event ${JSON.stringify(laterIncome)})`,
      ),
      check(
        observed.every((step) => step.gold >= 0),
        `treasury >= 0 at every point this scenario can observe it (${observed.map((step) => `${step.where}: ${String(step.gold)}`).join(', ')})`,
      ),
      check(
        afterLater !== undefined &&
          unitSupport(afterLater, ROME).gold === playerIncome(afterLater, ruleset, ROME).gold,
        "and the state it settles in is the money loop's fixed point: the bill equals the income",
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 12. The commerce split at the player's rates
 * ------------------------------------------------------------------ */

const RATES_TILE_A = at(4, 3);
const RATES_TILE_B = at(5, 3);

/** The triple this scenario switches to: 3/3/4 tenths, which does not divide evenly. */
const SPLIT_RATES: Rates = { tax: 3, science: 3, luxury: 4 };

/**
 * RATES SPLIT. One city whose commerce is **exactly 5** — a grassland centre (1
 * commerce) plus two grassland tiles carrying a road (1 + the road's +1 each) —
 * with two citizens working them, at the default 6/4/0 and then at 3/3/4.
 *
 * The split, channel by channel, on the frozen `RATE_TOTAL = 10`:
 *
 * - at **6/4/0**: gold `floor(5*6/10)` = 3, beakers `floor(5*4/10)` = 2, luxuries
 *   `floor(5*0/10)` = 0 — the three floors already sum to the whole commerce, so
 *   nothing is left over. Treasury 3, beakers 2, luxuries 0.
 * - at **3/3/4**: gold `floor(15/10)` = 1, beakers `floor(15/10)` = 1, luxuries
 *   `floor(20/10)` = 2 — the floors sum to **4 of the 5**, and the **remainder goes
 *   to gold**, so gold is 2, not 1. That is the rule this scenario exists to pin:
 *   round-half-up would give 2/2/2 = 6 (more than the city made), dropping the
 *   remainder would give 1/1/2 = 4 (a gold piece vanished), and "whatever floating
 *   point did" is not a rule at all. The three channels always sum to the commerce
 *   that was split.
 *
 * The **timing** rule is pinned by the same run: `SetRates` is applied *after* the
 * first collection, and it changes nothing about it — the treasury, beakers and
 * luxuries are exactly what they were the moment before the command applied, and
 * only the *next* collection divides differently. The contract's reading
 * (docs/INTERFACES.md M4b, "Commands") is that a collection that has not run yet
 * reads the new rates, because the money step is the last one in a turn and there
 * is no moment for a player to act after this turn's collection.
 */
const ratesSplitScenario = defineScenario({
  name: 'commerce-splits-at-the-players-rates-with-the-remainder-to-gold',
  settings: DUEL_SETTINGS,
  setup: (b) =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTreasury(0, 0)
      .addImprovement(4, 3, ROAD)
      .addImprovement(5, 3, ROAD)
      .addUnit(0, WARRIOR, [30, 30])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], { population: 2, workedTiles: [RATES_TILE_A, RATES_TILE_B] }),
  run: [endTurn()],
  assert: (after, ruleset) => {
    const yields = cityYields(after, ruleset, asCityId(0));
    const splitAtDefault = splitCommerce(yields.commerce, DEFAULT_RATES);
    const splitAtNew = splitCommerce(yields.commerce, SPLIT_RATES);

    // The run collected once at 6/4/0. The state says the same thing the split does.
    const collected = moneyOf(after, ROME);

    // The rate change: applied, and provably incapable of touching this turn.
    const changed = romeApply(after, ruleset, setRates(SPLIT_RATES));
    const afterChange = changed?.state;
    const ratesAfter = afterChange?.players.find((player) => player.id === ROME)?.rates;

    // The turn after it.
    const next = afterChange === undefined ? undefined : romeApply(afterChange, ruleset, endTurn());
    const afterNext = next?.state;
    const nextIncome = next === undefined ? undefined : incomeLines(next.events, ROME)[0];

    // The refusals, through the applier and through the rule the applier uses.
    const badSum = errorOf(
      applyCommand(after, ROME, setRates({ tax: 6, science: 4, luxury: 1 }), ruleset),
    );
    const badNegative = errorOf(
      applyCommand(after, ROME, setRates({ tax: 6, science: -1, luxury: 5 }), ruleset),
    );
    const badFraction = errorOf(
      applyCommand(after, ROME, setRates({ tax: 6.5, science: 3.5, luxury: 0 }), ruleset),
    );

    /**
     * The whole state a `SetRates` is allowed to produce, rebuilt from `after`: the
     * actor's `rates` and the `revision` bump, and **nothing else**.
     *
     * Comparing the applier's state against this, field for field, is what makes
     * "a rate change affects future turns only" a claim about the *whole* state
     * rather than about the three fields this test happens to name — a change that
     * quietly recollected, refunded, re-sorted a player or touched a city would
     * fail here.
     */
    const expectedAfterChange: GameState = {
      ...after,
      revision: after.revision + 1,
      players: after.players.map((player) =>
        player.id === ROME ? { ...player, rates: SPLIT_RATES } : player,
      ),
    };

    return [
      check(
        ratesProblem(DEFAULT_RATES) === undefined &&
          ratesProblem({ tax: RATE_TOTAL - 1, science: 1, luxury: 0 }) === undefined &&
          ratesProblem({ tax: RATE_TOTAL - 1, science: 1, luxury: 1 }) !== undefined,
        `the default triple is a legal split and RATE_TOTAL = ${String(RATE_TOTAL)} is the total it is legal against: taking a tenth off is still legal and adding one is not (the PLACEHOLDER ${String(RATE_TOTAL)} and ${JSON.stringify(DEFAULT_RATES)})`,
      ),
      check(
        yields.commerce === 5,
        `the city's commerce is exactly 5: grassland centre 1 + two roaded grassland tiles at 1 + 1 (got ${String(yields.commerce)})`,
      ),
      check(
        splitAtDefault.gold === 3 && splitAtDefault.beakers === 2 && splitAtDefault.luxuries === 0,
        `at 6/4/0 the 5 commerce is 3 gold / 2 beakers / 0 luxuries — the floors floor(3.0), floor(2.0), floor(0.0) leave nothing over (got ${JSON.stringify(splitAtDefault)})`,
      ),
      check(
        collected.treasury === 3 && collected.beakers === 2 && collected.luxuries === 0,
        `the run's one turn collected exactly that: treasury 3, beakers 2, luxuries 0 (got ${JSON.stringify(collected)})`,
      ),
      check(
        after.turn === 2 && after.revision === 1 && after.units.length === 2,
        `the run advanced exactly one turn and applied exactly one command: turn 2, revision 1, two units (turn ${String(after.turn)}, revision ${String(after.revision)}, units ${String(after.units.length)})`,
      ),
      check(
        changed !== undefined &&
          ratesAfter !== undefined &&
          ratesAfter.tax === 3 &&
          ratesAfter.science === 3 &&
          ratesAfter.luxury === 4,
        `SetRates wrote the new triple (rates ${JSON.stringify(ratesAfter)})`,
      ),
      check(
        afterChange !== undefined &&
          afterChange.revision === after.revision + 1 &&
          afterChange.turn === after.turn &&
          moneyOf(afterChange, ROME).treasury === collected.treasury &&
          moneyOf(afterChange, ROME).beakers === collected.beakers &&
          moneyOf(afterChange, ROME).luxuries === collected.luxuries,
        `and the rate change affected NOTHING that already happened: revision +1, the turn unchanged, and the treasury/beakers/luxuries are still ${JSON.stringify(collected)} (got ${afterChange === undefined ? 'no state' : JSON.stringify(moneyOf(afterChange, ROME))})`,
      ),
      check(
        splitAtNew.gold === 2 && splitAtNew.beakers === 1 && splitAtNew.luxuries === 2,
        `at 3/3/4 the same 5 commerce is 2 gold / 1 beaker / 2 luxuries: floor(5*3/10) = 1 and floor(5*4/10) = 2 leave 4 of the 5 paid out, so the REMAINDER 1 goes to gold — 2, not 1 (got ${JSON.stringify(splitAtNew)})`,
      ),
      check(
        nextIncome !== undefined &&
          nextIncome.gold === 2 &&
          nextIncome.beakers === 1 &&
          nextIncome.luxuries === 2 &&
          nextIncome.gold + nextIncome.beakers + nextIncome.luxuries === yields.commerce,
        `the NEXT turn's collection is that split, and the three channels still add up to the 5 commerce that was divided (event ${JSON.stringify(nextIncome)})`,
      ),
      check(
        afterNext !== undefined &&
          moneyOf(afterNext, ROME).treasury === 5 &&
          moneyOf(afterNext, ROME).beakers === 3 &&
          moneyOf(afterNext, ROME).luxuries === 2,
        `so the pools move by exactly that: 3 + 2 = 5 gold, 2 + 1 = 3 beakers, 0 + 2 = 2 luxuries (got ${afterNext === undefined ? 'no state' : JSON.stringify(moneyOf(afterNext, ROME))})`,
      ),
      check(
        afterChange !== undefined &&
          JSON.stringify(afterChange) === JSON.stringify(expectedAfterChange),
        `and the state after the rate change differs from the state before it in exactly two places — the actor's \`rates\` and the \`revision\` bump — so nothing was recollected, refunded or re-ordered (after ${afterChange === undefined ? 'no state' : JSON.stringify(moneyOf(afterChange, ROME))})`,
      ),
      check(
        badSum !== undefined &&
          badSum.kind === 'invalid-argument' &&
          badSum.detail.includes('= 11') &&
          ratesProblem({ tax: 6, science: 4, luxury: 1 })?.includes('= 11') === true,
        `a triple summing to 11 is refused with invalid-argument naming the actual sum, and the shared rule says the same thing (error ${JSON.stringify(badSum)})`,
      ),
      check(
        badNegative !== undefined &&
          badNegative.kind === 'invalid-argument' &&
          badNegative.detail.includes('science'),
        `a negative rate is refused as an invalid argument and names the offending channel (error ${JSON.stringify(badNegative)})`,
      ),
      check(
        badFraction !== undefined &&
          badFraction.kind === 'invalid-argument' &&
          badFraction.detail.includes('integer'),
        `a fractional rate is refused as an invalid argument — the state carries whole tenths or nothing (error ${JSON.stringify(badFraction)})`,
      ),
    ];
  },
});

/** `UnitDisbanded` for Rome's workers, which is every disband in these scenarios. */
const unitDisbanded = (unitId: number, tile: TileIndex, saved: number): GameEvent => ({
  type: 'UnitDisbanded',
  playerId: ROME,
  unitId: asUnitId(unitId),
  unitType: WORKER,
  tile,
  saved,
});

/**
 * Split a `ScenarioRunResult`'s merged event list into one list per turn, at each
 * `TurnEnded`. The command layer appends exactly one `TurnEnded` per `EndTurn` and
 * the pipeline puts everything a turn did before it, so a run's events can be read
 * turn by turn — which is what makes a per-turn ledger checkable without stepping
 * the world by hand.
 */
const turnLedgers = (events: readonly GameEvent[]): readonly (readonly GameEvent[])[] => {
  const turns: GameEvent[][] = [];
  let current: GameEvent[] = [];
  for (const event of events) {
    current.push(event);
    if (event.type === 'TurnEnded') {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
};

/* ------------------------------------------------------------------ *
 * 13. Treasury conservation over 120 turns
 * ------------------------------------------------------------------ */

/** Rome's ten workers: unit `n` on `(10 + n, 10)`, ids 0..9. */
const CONSERVATION_ARMY: readonly (readonly [number, number])[] = [
  [10, 10],
  [11, 10],
  [12, 10],
  [13, 10],
  [14, 10],
  [15, 10],
  [16, 10],
  [17, 10],
  [18, 10],
  [19, 10],
];

/** The length of the conservation run: "100+" turns, and a round number of them. */
const CONSERVATION_TURNS = 120;

/**
 * The conservation world, shared by the scenario and by the hand-walked test below.
 *
 * **Rome is the failing economy.** Its one city stands on plains, has two citizens
 * and works **no** tile: 1 food from the centre against the 4 two citizens eat is a
 * deficit of 3, so the city starves down to one citizen on the first turn and keeps
 * starving (a deficit of 1, the box reset to 0, `CityStarved` every single turn).
 * Its commerce is the centre's 1, which at 6/4/0 is floor(0.6) = 0 gold and
 * floor(0.4) = 0 beakers with the leftover 1 to gold — **1 gold a turn**. Against
 * that it keeps ten workers, of which `10 - (2*1 + 4)` = 4 are billable: **4 gold**
 * a turn, from a treasury of **2**.
 *
 * **Carthage is the solvent one.** Its city works a roaded grassland tile (commerce
 * 1 + 1 + 1 = 3) at rates 0/5/5, so floor(3*5/10) = 1 beaker and 1 luxury, and the
 * leftover 1 is gold: a gold piece a turn, and two pools that grow in step. It owns
 * one unit, which its allowance of 4 covers, so it pays nothing.
 */
const conservationSetup = (b: ScenarioBuilder): ScenarioBuilder => {
  let builder = b
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .setTile(5, 5, 'plains') // Rome's starving centre: 1 food, 2 shields, 1 commerce
    .setTreasury(0, 2);
  for (const [x, y] of CONSERVATION_ARMY) {
    builder = builder.addUnit(0, WORKER, [x, y]);
  }
  return builder
    .addUnit(1, WORKER, [34, 31])
    .setRates(1, { tax: 0, science: 5, luxury: 5 })
    .setTreasury(1, 0)
    .addImprovement(34, 30, ROAD)
    .addCity(0, [5, 5], { population: 2, workedTiles: [] })
    .addCity(1, [35, 30], { population: 1, workedTiles: [at(34, 30)] });
};

/**
 * TREASURY CONSERVATION over 120 turns: **income minus upkeep minus what the
 * disbands paid equals the observed gold delta, every turn, for every
 * civilization, and no treasury ever goes below zero** — including a starving city
 * and two bankruptcies.
 *
 * Rome's first two turns, exactly:
 *
 * 1. **turn 1** — 2 + 1 - 4 = -1. The treasury floors at 0 and the shortfall of 1
 *    is paid with worker **9**; the bill falls to 3.
 * 2. **turn 2** — 0 + 1 - 3 = -2. Workers **8** and then **7** go, each saving 1,
 *    which covers the 2; the bill falls to 1 = income.
 * 3. **turn 3 and the 117 after it** — 0 + 1 - 1 = 0: the treasury sits at exactly
 *    0 for the rest of the run, and the ledger identity is `0 = 1 - 1 + 0 + 0`
 *    every one of those turns.
 *
 * Over the whole run: income 120, upkeep 125, disbands 3, unpaid 0, and
 * 2 + 120 - 125 + 3 = **0**, which is the treasury the scenario asserts. Carthage
 * ends at 60 gold, 438 beakers and 438 luxuries — and the two pools are equal
 * because its rates are 0/5/5, so the same floor is applied to the same commerce
 * on both sides. Those three numbers are the accumulation of the per-turn ledger
 * the test checks line by line; they are pinned here because a change to the split,
 * to growth or to upkeep has to move them, and a reader who disagrees with them
 * should be able to see exactly which turn they came from.
 *
 * The assertions here are the ones the *final state* can carry. The per-turn
 * identity — the substance of "gold is accounted for" — is checked in the
 * hand-walked test below and again, over the runner's merged event stream, in the
 * test that runs this scenario.
 */
const conservationScenario = defineScenario({
  name: 'treasury-conservation-over-120-turns-of-starvation-and-bankruptcy',
  settings: DUEL_SETTINGS,
  setup: conservationSetup,
  run: endTurns(CONSERVATION_TURNS),
  assert: (after, ruleset) => {
    const rome = moneyOf(after, ROME);
    const carthage = moneyOf(after, CARTHAGE);
    const army = after.units.filter((unit) => unit.owner === ROME);
    const city = cityById(after, asCityId(0));

    return [
      check(
        after.turn === CONSERVATION_TURNS + 1 && after.revision === CONSERVATION_TURNS,
        `the run is ${String(CONSERVATION_TURNS)} turns long: the state is at turn ${String(CONSERVATION_TURNS + 1)} with ${String(CONSERVATION_TURNS)} revisions (got turn ${String(after.turn)}, revision ${String(after.revision)})`,
      ),
      check(
        rome.treasury === 0 && rome.beakers === 0 && rome.luxuries === 0,
        `Rome ends with exactly 0 gold: 2 + 120 income - 125 upkeep + 3 covered by disbands = 0, and at 6/4/0 its 1 commerce a turn never fills the beaker or luxury pool (got ${JSON.stringify(rome)})`,
      ),
      check(
        carthage.treasury === 60 && carthage.beakers === 438 && carthage.luxuries === 438,
        `Carthage ends with exactly 60 gold, 438 beakers and 438 luxuries — the accumulation of its 0/5/5 split over 120 turns, with the two pools equal because their rates are (got ${JSON.stringify(carthage)})`,
      ),
      check(
        army.map((unit) => Number(unit.id)).join(',') === '0,1,2,3,4,5,6',
        `Rome's army lost exactly the three highest-id workers, 9, 8 and 7, so seven remain (units ${army.map((unit) => String(unit.id)).join(',')})`,
      ),
      check(
        city !== undefined &&
          city.population === 1 &&
          city.foodBox === 0 &&
          city.workedTiles.length === 0,
        `and Rome's city starved to one citizen and stayed there, working nothing (city ${JSON.stringify(city?.population)} citizens, box ${String(city?.foodBox)}, worked ${JSON.stringify(city?.workedTiles)})`,
      ),
      check(
        rome.treasury >= 0 && carthage.treasury >= 0,
        `neither treasury is negative after 120 turns (Rome ${String(rome.treasury)}, Carthage ${String(carthage.treasury)})`,
      ),
      check(
        unitSupport(after, ROME).supported === 1 &&
          playerIncome(after, ruleset, ROME).gold === 1 &&
          unitSupport(after, ROME).gold === playerIncome(after, ruleset, ROME).gold,
        'and the world it ends in is the fixed point: one billable worker, 1 gold of income, and nothing left over',
      ),
    ];
  },
});

/* ------------------------------------------------------------------ *
 * 14. Starting units
 * ------------------------------------------------------------------ */

/**
 * Every way the starting position of `state` breaks M4b's rule, as a list of
 * reasons — empty when it holds.
 *
 * The rule (docs/INTERFACES.md M4b, "Starting units"): **every civilization starts
 * with exactly one settler and one worker**, the settler on (or beside) its
 * starting tile and the worker on a tile beside it, and **barbarians get
 * nothing**. It is written as a report rather than as a chain of `expect`s so the
 * falsification tests at the bottom of this file can run the *same* rules against
 * worlds that should break them — an assertion that cannot fail is not evidence.
 *
 * This checks the *roles*, not the type ids: "a settler and a worker" is a claim
 * about what the units can do (`UnitDef.role` is what `FoundCity` and `StartWork`
 * read), so a catalog that ships its settler under another name still passes, and
 * a catalog that ships two units of role `worker` and no settler still fails.
 */
const startingUnitsReport = (state: GameState, ruleset: RulesetView): readonly string[] => {
  const problems: string[] = [];
  const civs = civPlayers(state);

  if (civs.length !== state.settings.civCount) {
    problems.push(
      `the state has ${String(civs.length)} civilizations but its settings say ${String(state.settings.civCount)}`,
    );
  }

  for (const player of civs) {
    const owned = state.units.filter((unit) => unit.owner === player.id);
    const settlers = owned.filter((unit) => unitDef(ruleset, unit.type)?.role === 'settler');
    const workers = owned.filter((unit) => unitDef(ruleset, unit.type)?.role === 'worker');

    if (settlers.length !== 1) {
      problems.push(`${player.name} owns ${String(settlers.length)} settler(s), not exactly 1`);
    }
    if (workers.length !== 1) {
      problems.push(`${player.name} owns ${String(workers.length)} worker(s), not exactly 1`);
    }

    const settler = settlers[0];
    const worker = workers[0];
    if (settler !== undefined && settler.tile !== player.startingTile) {
      problems.push(
        `${player.name}'s settler stands on tile ${String(settler.tile)}, not on its starting tile ${String(player.startingTile)}`,
      );
    }
    if (worker !== undefined && settler !== undefined) {
      if (worker.tile === settler.tile) {
        problems.push(`${player.name}'s worker shares the settler's tile ${String(worker.tile)}`);
      } else if (!neighbors8(state.map, settler.tile).includes(worker.tile)) {
        problems.push(
          `${player.name}'s worker on tile ${String(worker.tile)} is not beside the settler on ${String(settler.tile)}`,
        );
      }
    }
  }

  const barbarians = state.players.filter((player) => player.kind === 'barbarian');
  if (barbarians.length !== 1) {
    problems.push(`the state has ${String(barbarians.length)} barbarian player(s), not exactly 1`);
  }
  for (const barbarian of barbarians) {
    const owned = state.units.filter((unit) => unit.owner === barbarian.id);
    if (owned.length !== 0) {
      problems.push(`the barbarians own ${String(owned.length)} unit(s), not 0`);
    }
    if (barbarian.treasury !== 0) {
      problems.push(
        `the barbarians hold ${String(barbarian.treasury)} gold, and they have no economy`,
      );
    }
  }

  // The id sequence every state the engine assembles satisfies: dense from 0, and
  // `nextUnitId` exactly how many units exist.
  const ids = state.units.map((unit) => Number(unit.id));
  const dense = ids.every((id, index) => id === index);
  if (!dense) problems.push(`unit ids are not dense from 0 (${ids.join(',')})`);
  if (state.nextUnitId !== state.units.length) {
    problems.push(
      `nextUnitId is ${String(state.nextUnitId)} with ${String(state.units.length)} unit(s) in the state`,
    );
  }

  return problems;
};

/** The `Settings` a starting-units case asks for, or a thrown authoring error. */
const settingsFor = (patch: { readonly mapSize: 'duel' | 'tiny'; readonly civCount: number }) => {
  const loaded = loadSettings(patch);
  if (!loaded.ok) throw new Error(`invalid settings in a starting-units case: ${patch.mapSize}`);
  return loaded.value;
};

/* ------------------------------------------------------------------ *
 * The M4b scenarios, as tests
 * ------------------------------------------------------------------ */

describe('M4b scenario: bankruptcy', () => {
  it('disbands the highest-id units in order until the shortfall is covered, and never goes negative', () => {
    const result = runScenario(bankruptcyScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The PLACEHOLDER constants this scenario's arithmetic is built on, pinned by
    // value: the engine's support rule (2 free units a city, 4 free with no city,
    // 1 gold a unit beyond that) and the starting treasury the DSL defaults a
    // civilization to. None of them is a Civ 3 figure; all of them are asserted in
    // the scenario's own words above as `2*1 + 4 = 6` and `1 * 6 = 6`.
    expect([FREE_UNITS_PER_CITY, FREE_UNITS_BASE, UNIT_SUPPORT_COST]).toEqual([2, 4, 1]);
    expect(STARTING_TREASURY).toBe(10);

    const after = result.finalState;
    if (after === undefined) throw new Error('the bankruptcy scenario must build a state');

    // The whole ledger of the three scripted turns, in pipeline order: production
    // was empty, so the money step's lines come first for Rome, then Carthage's,
    // and the command layer's `TurnEnded` closes each turn. The disbands sit after
    // the owner's own `UpkeepPaid` — the bill is what they pay — and before the
    // next player's lines.
    expect(result.events).toEqual([
      incomeEvent(ROME, 2, 0, 0),
      upkeepEvent(ROME, 6, 0, 6, 12, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(2),
      incomeEvent(ROME, 2, 0, 0),
      upkeepEvent(ROME, 6, 0, 6, 12, 6),
      unitDisbanded(11, at(21, 10), 1),
      unitDisbanded(10, at(20, 10), 1),
      unitDisbanded(9, at(19, 10), 1),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(3),
      incomeEvent(ROME, 2, 0, 0),
      upkeepEvent(ROME, 3, 0, 3, 9, 6),
      unitDisbanded(8, at(18, 10), 1),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(4),
    ]);

    // The treasury's whole trajectory, reconstructed from the events alone: 5 is
    // where the scenario started it, and every step of it stays at or above zero.
    const turns = turnLedgers(result.events);
    expect(turns).toHaveLength(3);
    let gold = BANKRUPTCY_START;
    const trajectory: number[] = [];
    for (const events of turns) {
      const ledger = ledgerOf(events, ROME);
      gold = gold + ledger.income - ledger.upkeep + ledger.covered + ledger.unpaid;
      expect(gold).toBeGreaterThanOrEqual(0);
      trajectory.push(gold);
    }
    expect(trajectory).toEqual([1, 0, 0]);
    expect(moneyOf(after, ROME).treasury).toBe(0);

    // Nothing was left unpaid anywhere in the run, so no `TreasuryShortfall` — the
    // disbands covered every shortfall to the gold.
    expect(result.events.filter((event) => event.type === 'TreasuryShortfall')).toEqual([]);

    // The final world: eight workers, ids 0..7 — the four highest ids are gone, in
    // descending order — and Carthage untouched.
    expect(
      after.units.filter((unit) => unit.owner === ROME).map((unit) => Number(unit.id)),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(
      after.units.filter((unit) => unit.owner === CARTHAGE).map((unit) => Number(unit.id)),
    ).toEqual([12]);
    // Carthage never spent or collected anything: its treasury is exactly the
    // PLACEHOLDER starting balance the DSL wrote when the player was added, which
    // is what makes the zeroes in its ledger lines above a *statement* — it really
    // did collect and pay nothing.
    expect(moneyOf(after, CARTHAGE).treasury).toBe(STARTING_TREASURY);
  });
});

describe('M4b scenario: treasury conservation over 120 turns', () => {
  it('agrees with the scenario assertions and pins the two economies end to end', () => {
    const result = runScenario(conservationScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const after = result.finalState;
    if (after === undefined) throw new Error('the conservation scenario must build a state');

    expect(after.turn).toBe(CONSERVATION_TURNS + 1);
    expect(moneyOf(after, ROME)).toEqual({ treasury: 0, beakers: 0, luxuries: 0 });
    expect(moneyOf(after, CARTHAGE)).toEqual({ treasury: 60, beakers: 438, luxuries: 438 });
  });

  it('accounts for every gold piece of every turn, from the run’s own event stream', () => {
    const result = runScenario(conservationScenario);
    const turns = turnLedgers(result.events);
    expect(turns).toHaveLength(CONSERVATION_TURNS);

    // The two treasuries the world started with: Rome 2, Carthage 0. The identity
    // below is the *only* thing that moves them.
    const gold = new Map<number, number>([
      [Number(ROME), 2],
      [Number(CARTHAGE), 0],
    ]);
    const pools = new Map<number, readonly [number, number]>([
      [Number(ROME), [0, 0]],
      [Number(CARTHAGE), [0, 0]],
    ]);
    const disbandedOn: { readonly turn: number; readonly ids: readonly number[] }[] = [];
    const romeUpkeep: number[] = [];
    const carthageGold: number[] = [];

    for (const [index, events] of turns.entries()) {
      const turn = index + 1;

      // The stream is complete: one line of each kind per civilization, every turn,
      // even when the amount is zero. Without that, a suppressed line would be
      // indistinguishable from a payment that never happened.
      for (const playerId of [ROME, CARTHAGE]) {
        expect(incomeLines(events, playerId)).toHaveLength(1);
        expect(upkeepLines(events, playerId)).toHaveLength(1);
      }

      for (const playerId of [ROME, CARTHAGE]) {
        const key = Number(playerId);
        const ledger = ledgerOf(events, playerId);
        const [beforeBeakers, beforeLuxuries] = pools.get(key) ?? [0, 0];
        const before = gold.get(key) ?? -1;

        // The identity the contract states, in the engine's own terms: income
        // minus upkeep, **plus what the disbands paid** and what nobody paid, is
        // exactly the change in the treasury. `covered` is a term and not an
        // omission because a disband pays with a unit instead of with gold.
        gold.set(key, before + ledger.income - ledger.upkeep + ledger.covered + ledger.unpaid);
        expect(gold.get(key)).toBeGreaterThanOrEqual(0);

        // The two inert pools take exactly their own channel of the split.
        pools.set(key, [beforeBeakers + ledger.beakers, beforeLuxuries + ledger.luxuries]);
        expect(ledger.beakers).toBeGreaterThanOrEqual(0);
        expect(ledger.luxuries).toBeGreaterThanOrEqual(0);
      }

      const romeLedger = ledgerOf(events, ROME);
      romeUpkeep.push(romeLedger.upkeep);
      if (romeLedger.disbanded.length > 0) {
        disbandedOn.push({ turn, ids: romeLedger.disbanded });
      }
      carthageGold.push(ledgerOf(events, CARTHAGE).income);
      // Carthage's rates are 0/5/5, so the same floor is applied to the same
      // commerce on both sides: its two pools must grow by the same amount every
      // turn, and a rate mix-up cannot hide behind a total.
      expect(ledgerOf(events, CARTHAGE).beakers).toBe(ledgerOf(events, CARTHAGE).luxuries);
    }

    // Rome is broke from its second turn on and stays exactly there; Carthage's
    // 60 gold are the gold channel of 120 turns of its 0/5/5 split, and its two
    // pools are equal at the end for the same reason they were equal every turn.
    expect(gold.get(Number(ROME))).toBe(0);
    expect(gold.get(Number(CARTHAGE))).toBe(60);
    expect(pools.get(Number(ROME))).toEqual([0, 0]);
    expect(pools.get(Number(CARTHAGE))).toEqual([438, 438]);

    // The exact shape of Rome's decline: the bill starts at 4, the disbands bring
    // it down to 1 over the first three turns, and it never moves again.
    expect(romeUpkeep.slice(0, 4)).toEqual([4, 3, 1, 1]);
    expect(romeUpkeep.slice(4).every((bill) => bill === 1)).toBe(true);
    expect(disbandedOn).toEqual([
      { turn: 1, ids: [9] },
      { turn: 2, ids: [8, 7] },
    ]);

    // Carthage's gold is 1 a turn while its commerce divides with a remainder left
    // over; the first four turns are before its first growth changes the number.
    expect(carthageGold.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(carthageGold.reduce((total, piece) => total + piece, 0)).toBe(60);
  });

  it('walks all 120 turns by hand and checks the split against the commerce that was there', () => {
    // The same world, stepped one `EndTurn` at a time, so that each turn's *state*
    // is available as well as its events: that is what lets the split be compared
    // with the commerce the cities actually produced — "the three channels add up
    // to what was divided" — instead of only with itself.
    const built = conservationSetup(createScenarioBuilder(RULESET, DUEL_SETTINGS)).build();
    if (!built.ok)
      throw new Error(`the conservation fixture must build: ${JSON.stringify(built.error)}`);

    let state = built.value;
    const trajectory: number[] = [];
    const carthage: {
      readonly gold: number;
      readonly beakers: number;
      readonly luxuries: number;
    }[] = [];

    for (let turn = 1; turn <= CONSERVATION_TURNS; turn += 1) {
      const before = {
        rome: moneyOf(state, ROME),
        carthage: moneyOf(state, CARTHAGE),
      };
      const outcome = applyFor(state, ROME, endTurn(), RULESET);
      state = outcome.state;

      for (const playerId of [ROME, CARTHAGE]) {
        const key = playerId === ROME ? 'rome' : 'carthage';
        const ledger = ledgerOf(outcome.events, playerId);
        const starting = before[key];
        const ending = moneyOf(state, playerId);

        // (1) gold: income minus upkeep plus the disbands' savings equals the delta.
        expect(ending.treasury - starting.treasury).toBe(
          ledger.income - ledger.upkeep + ledger.covered + ledger.unpaid,
        );
        // (2) the pools take their own channel, and nothing else.
        expect(ending.beakers - starting.beakers).toBe(ledger.beakers);
        expect(ending.luxuries - starting.luxuries).toBe(ledger.luxuries);
        // (3) never negative, in any state of any turn.
        expect(ending.treasury).toBeGreaterThanOrEqual(0);
        // (4) the split divides the commerce that was really there: the three
        // channels sum to the player's cities' commerce, which the money step read
        // after growth and production and nothing after it changed.
        expect(ledger.income + ledger.beakers + ledger.luxuries).toBe(
          commerceOf(state, RULESET, playerId),
        );
      }

      trajectory.push(moneyOf(state, ROME).treasury);
      const carthageLedger = ledgerOf(outcome.events, CARTHAGE);
      carthage.push({
        gold: carthageLedger.income,
        beakers: carthageLedger.beakers,
        luxuries: carthageLedger.luxuries,
      });
    }

    // Rome: broke on the first turn and exactly zero for the remaining 119; the
    // disband turns are the only turns where the delta is not `income - upkeep`.
    expect(state.turn).toBe(CONSERVATION_TURNS + 1);
    expect(trajectory[0]).toBe(0);
    expect(trajectory.slice(1).every((piece) => piece === 0)).toBe(true);
    expect(trajectory).toHaveLength(CONSERVATION_TURNS);

    // Carthage: gold accumulates by exactly the split's gold channel, and its two
    // pools move in lockstep because its rates are.
    expect(carthage.reduce((total, row) => total + row.gold, 0)).toBe(60);
    expect(carthage.reduce((total, row) => total + row.beakers, 0)).toBe(438);
    expect(carthage.reduce((total, row) => total + row.luxuries, 0)).toBe(438);
    expect(carthage.every((row) => row.beakers === row.luxuries)).toBe(true);
    expect(carthage[0]).toEqual({ gold: 1, beakers: 1, luxuries: 1 });
  });
});

describe('M4b scenario: the commerce split at the player’s rates', () => {
  it('splits a known commerce exactly, sends the remainder to gold, and applies a rate change to the next turn only', () => {
    const result = runScenario(ratesSplitScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The PLACEHOLDER rate constants, pinned by value: the split is in tenths of
    // `RATE_TOTAL`, and a new player starts at 6/4/0.
    expect([RATE_TOTAL, DEFAULT_RATES.tax, DEFAULT_RATES.science, DEFAULT_RATES.luxury]).toEqual([
      10, 6, 4, 0,
    ]);

    const after = result.finalState;
    if (after === undefined) throw new Error('the rates-split scenario must build a state');

    // One collection, at the default rates: 5 commerce -> floor(3.0) gold,
    // floor(2.0) beakers, floor(0.0) luxuries, and nothing left over.
    expect(result.events).toEqual([
      incomeEvent(ROME, 3, 2, 0),
      upkeepEvent(ROME, 0, 0, 0, 1, 6),
      incomeEvent(CARTHAGE, 0, 0, 0),
      upkeepEvent(CARTHAGE, 0, 0, 0, 1, 4),
      turnEnded(2),
    ]);
    expect(moneyOf(after, ROME)).toEqual({ treasury: 3, beakers: 2, luxuries: 0 });

    // The city's commerce is the sum of its parts, stated as parts: the centre's 1
    // and two roaded grassland tiles at 1 + the road's 1.
    expect(cityYields(after, RULESET, asCityId(0)).commerce).toBe(5);
    expect(tileYields(after, RULESET, RATES_TILE_A)).toEqual({ food: 2, shields: 1, commerce: 2 });
    expect(tileYields(after, RULESET, RATES_TILE_B)).toEqual({ food: 2, shields: 1, commerce: 2 });

    // The rate change, and the next turn under it: 1 + 1 + 2 from the floors, and
    // the 1 that was left over goes to gold, so gold is 2 rather than 1.
    const changed = applyFor(after, ROME, setRates(SPLIT_RATES), RULESET);
    expect(moneyOf(changed.state, ROME)).toEqual({ treasury: 3, beakers: 2, luxuries: 0 });

    const next = applyFor(changed.state, ROME, endTurn(), RULESET);
    expect(incomeLines(next.events, ROME)).toEqual([
      { type: 'IncomeCollected', playerId: ROME, gold: 2, beakers: 1, luxuries: 2 },
    ]);
    expect(moneyOf(next.state, ROME)).toEqual({ treasury: 5, beakers: 3, luxuries: 2 });

    // The floors, spelled out: 5 commerce is not divisible by 10 tenths into three
    // whole channels, and the contract says which one gets what is left.
    expect(Math.floor((5 * SPLIT_RATES.tax) / RATE_TOTAL)).toBe(1);
    expect(Math.floor((5 * SPLIT_RATES.science) / RATE_TOTAL)).toBe(1);
    expect(Math.floor((5 * SPLIT_RATES.luxury) / RATE_TOTAL)).toBe(2);
    expect(5 - 1 - 1 - 2).toBe(1); // the remainder, which is gold: 1 + 1 = 2 above
  });
});

describe('M4b scenario: starting units', () => {
  const cases: readonly {
    readonly mapSize: 'duel' | 'tiny';
    readonly civCount: number;
    readonly seeds: readonly number[];
  }[] = [
    { mapSize: 'duel', civCount: 2, seeds: [1, 2, 3, 7, 11] },
    { mapSize: 'tiny', civCount: 4, seeds: [1, 4] },
  ];

  for (const testCase of cases) {
    for (const seed of testCase.seeds) {
      it(`gives every civilization exactly one settler and one worker (seed ${String(seed)}, ${testCase.mapSize}/${String(testCase.civCount)} civs)`, () => {
        // `newGame` is what "starting units" means: the DSL's builder places
        // exactly the units a scenario names, so a scenario about the *starting
        // position* has to read the position the engine assembles (see
        // `startingUnitsReport`).
        const game = newGame(
          seed,
          // Only the two settings keys: a patch layer with an unknown key is
          // rejected by the settings schema, which is why the case's `seeds` is not
          // handed over with it.
          settingsFor({ mapSize: testCase.mapSize, civCount: testCase.civCount }),
          RULESET,
        );
        if (!game.ok) {
          throw new Error(`newGame must host seed ${String(seed)}: ${JSON.stringify(game.error)}`);
        }

        expect(startingUnitsReport(game.value, RULESET)).toEqual([]);

        // The rule, counted directly as well: two units for each of the
        // civilizations and none for the barbarian, ids 0..2n-1.
        const civs = civPlayers(game.value);
        expect(game.value.units).toHaveLength(civs.length * 2);
        expect(game.value.units.map((unit) => Number(unit.id))).toEqual(
          Array.from({ length: civs.length * 2 }, (_, index) => index),
        );
        expect(game.value.units.map((unit) => unitDef(RULESET, unit.type)?.role)).toEqual(
          civs.flatMap(() => ['settler', 'worker']),
        );
        expect(
          game.value.units.every((unit) => civs.some((player) => player.id === unit.owner)),
        ).toBe(true);

        // M4b's money fields come with them: every civilization starts at
        // `STARTING_TREASURY` with the default rates and two empty pools, and the
        // barbarian's are inert zeroes.
        for (const player of civs) {
          expect(player.treasury).toBe(STARTING_TREASURY);
          expect(player.rates).toEqual(DEFAULT_RATES);
          expect(player.beakers).toBe(0);
          expect(player.luxuries).toBe(0);
        }
        const barbarians = game.value.players.filter((player) => player.kind === 'barbarian');
        expect(barbarians).toHaveLength(1);
        expect(barbarians[0]?.treasury).toBe(0);
      });
    }
  }

  it('refuses to start a game with no settler role in the ruleset, and says which role', () => {
    // The settler is mandatory (a civilization that cannot found a city cannot
    // play), and the contract makes that a typed setup failure rather than a state
    // with no units at all.
    const noSettlers: RulesetView = {
      ...RULESET,
      units: RULESET.units.filter((unit) => unit.role !== 'settler'),
    };

    const game = newGame(1, settingsFor({ mapSize: 'duel', civCount: 2 }), noSettlers);
    expect(game.ok).toBe(false);
    if (game.ok) throw new Error('a ruleset with no settler must not start a game');
    expect(game.error).toEqual({ kind: 'missing-unit-role', role: 'settler' });
  });

  it('places settlers and no workers when the ruleset ships no worker role, which the report must notice', () => {
    // The worker is optional in the catalog, so this is a legal game — a
    // civilization with a settler and nothing to improve land with. It is here
    // because it is the falsification of the *report*: the same world the passing
    // cases accept must be rejected when the worker is missing, which shows the
    // assertions are about what the engine placed and not about a list this file
    // wrote down.
    const noWorkers: RulesetView = {
      ...RULESET,
      units: RULESET.units.filter((unit) => unit.role !== 'worker'),
    };

    const game = newGame(1, settingsFor({ mapSize: 'duel', civCount: 2 }), noWorkers);
    if (!game.ok)
      throw new Error(
        `newGame must still host a world without workers: ${JSON.stringify(game.error)}`,
      );

    const roles = game.value.units.map((unit) => unitDef(noWorkers, unit.type)?.role);
    expect(roles).toEqual(['settler', 'settler']);
    expect(startingUnitsReport(game.value, noWorkers).join('\n')).toMatch(
      /owns 0 worker\(s\), not exactly 1/,
    );
  });
});

describe('M4b: the money loop’s unpaid branch', () => {
  it('reports a shortfall it cannot disband away, rather than inventing a debt or a negative treasury', () => {
    // The shipped catalog declares **no** `maintenance` on any building — M4b sums
    // whatever a row declares and M4c owns effects — so the only way a shortfall
    // survives every disband is a catalog that does declare one. That is exactly
    // what this test states: a ruleset view whose granary bills 3 gold a turn, in a
    // city with 1 commerce of income (1 gold at 6/4/0) and a treasury of 0.
    //
    // Rome's one unit is *free* (1 unit against an allowance of 6), so there is
    // nothing to disband and the loop ends with the bill unpaid: the treasury is
    // left at exactly 0 and the unpaid 2 is reported in a `TreasuryShortfall`
    // event, which is the contract's answer to "no debt field, no invented number".
    const granaryRow = CATALOG.buildings.find((row) => row.id === GRANARY);
    if (granaryRow === undefined) throw new Error('the shipped catalog must describe a granary');
    const taxedGranary = { ...granaryRow, maintenance: 3 };
    const withMaintenance: RulesetView = {
      ...RULESET,
      buildings: [taxedGranary, ...(RULESET.buildings ?? []).filter((row) => row.id !== GRANARY)],
    };

    const built = createScenarioBuilder(withMaintenance, DUEL_SETTINGS)
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTreasury(0, 0)
      .addUnit(0, WARRIOR, [30, 30])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], { population: 1, workedTiles: [], buildings: [GRANARY] })
      .build();
    if (!built.ok)
      throw new Error(`the maintenance fixture must build: ${JSON.stringify(built.error)}`);

    const outcome = applyFor(built.value, ROME, endTurn(), withMaintenance);

    expect(upkeepLines(outcome.events, ROME)).toEqual([
      {
        type: 'UpkeepPaid',
        playerId: ROME,
        gold: 3,
        maintenance: 3,
        unitSupport: 0,
        units: 1,
        freeUnits: 6,
      },
    ]);
    expect(disbandLines(outcome.events, ROME)).toEqual([]);
    expect(shortfallLines(outcome.events, ROME)).toEqual([
      { type: 'TreasuryShortfall', playerId: ROME, unpaid: 2 },
    ]);
    expect(moneyOf(outcome.state, ROME).treasury).toBe(0);
    expect(outcome.state.units.filter((unit) => unit.owner === ROME)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Falsification: the M4b scenarios' assertions must be able to fail
 * ------------------------------------------------------------------ */

describe('the M4b scenario assertions discriminate (they are not decoration)', () => {
  it('the bankruptcy assertions fail when the treasury outlasts the deficit', () => {
    // The same twelve workers and the same bill, but 10 gold instead of 5: the
    // treasury covers three turns of the deficit, so the first disband happens a
    // turn later than the scenario says and only two units are ever taken — the
    // army that survives is ids 0..9 rather than 0..7, and the bill that is left
    // is 4 a turn rather than 2.
    const variant: Scenario = {
      name: 'bankruptcy-with-a-deeper-treasury',
      settings: DUEL_SETTINGS,
      setup: (b) => bankruptcySetup(b).setTreasury(0, 10),
      run: [endTurn(), endTurn(), endTurn()],
      assert: assertOf(bankruptcyScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/took workers 11, 10, 9 and 8, so the army is ids 0\.\.7/);
    expect(text).toMatch(/twelve workers it started with are down to eight/);

    // The world itself is the one the variant described — twelve workers, one city,
    // three turns — so those failures are about the money and not about a fixture
    // that never ran.
    const finalState = result.finalState;
    if (finalState === undefined) throw new Error('the variant must still build a world');
    expect(finalState.turn).toBe(4);
    expect(finalState.units.filter((unit) => unit.owner === ROME)).toHaveLength(10);
    expect(moneyOf(finalState, ROME).treasury).toBe(0);
  });

  it('the bankruptcy assertions fail when the army is affordable after all', () => {
    // Eight workers instead of twelve: the allowance of 6 leaves only 2 billable,
    // which the 2 gold of income covers, so nothing ever goes bankrupt and the
    // treasury is still the 5 it started with.
    const variant: Scenario = {
      name: 'bankruptcy-that-never-comes',
      settings: DUEL_SETTINGS,
      setup: (b) => {
        let builder = b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTreasury(0, BANKRUPTCY_START);
        for (const [x, y] of BANKRUPTCY_ARMY.slice(0, 8)) {
          builder = builder.addUnit(0, WORKER, [x, y]);
        }
        return builder
          .addUnit(1, WARRIOR, [20, 20])
          .addCity(0, [5, 5], { population: 1, workedTiles: [BANKRUPTCY_FARM] });
      },
      run: [endTurn(), endTurn(), endTurn()],
      assert: assertOf(bankruptcyScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/took workers 11, 10, 9 and 8, so the army is ids 0\.\.7/);
    expect(text).toMatch(/with the bill down to 2 = income the treasury sits at exactly 0/);

    const finalState = result.finalState;
    if (finalState === undefined) throw new Error('the variant must still build a world');
    expect(moneyOf(finalState, ROME).treasury).toBe(BANKRUPTCY_START);
    expect(finalState.units.filter((unit) => unit.owner === ROME)).toHaveLength(8);
  });

  it('the rates-split assertions fail when the city’s commerce is not the one the scenario names', () => {
    // One road missing: commerce 4 rather than 5, which changes both collections —
    // 4 at 6/4/0 is floor(2.4) + remainder 1 = 3 gold and floor(1.6) = 1 beaker, so
    // the "5 commerce / 3 gold / 2 beakers" expectations must both break.
    const variant: Scenario = {
      name: 'rates-split-with-one-road-missing',
      settings: DUEL_SETTINGS,
      setup: (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Carthage')
          .fillTerrain('grassland')
          .setTreasury(0, 0)
          .addImprovement(4, 3, ROAD) // the second road is gone
          .addUnit(0, WARRIOR, [30, 30])
          .addUnit(1, WARRIOR, [20, 20])
          .addCity(0, [5, 5], { population: 2, workedTiles: [RATES_TILE_A, RATES_TILE_B] }),
      run: [endTurn()],
      assert: assertOf(ratesSplitScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/the city's commerce is exactly 5/);
    expect(text).toMatch(/at 6\/4\/0 the 5 commerce is 3 gold \/ 2 beakers \/ 0 luxuries/);
  });

  it('the conservation assertions fail when the solvent civilization pays the default rates', () => {
    // Carthage at 6/4/0 rather than 0/5/5: it still earns, but the gold channel is
    // different and nothing reaches the two pools in step, so the exact end state
    // the scenario pins has to disagree.
    const variant: Scenario = {
      name: 'conservation-with-default-rates',
      settings: DUEL_SETTINGS,
      setup: (b) => conservationSetup(b).setRates(1, DEFAULT_RATES),
      run: endTurns(CONSERVATION_TURNS),
      assert: assertOf(conservationScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/Carthage ends with exactly 60 gold, 438 beakers and 438 luxuries/);

    // Rome's half of the scenario still holds, which is what makes the failure
    // above about Carthage's rates and not about a world that did not run.
    const finalState = result.finalState;
    if (finalState === undefined) throw new Error('the variant must still build a world');
    expect(moneyOf(finalState, ROME)).toEqual({ treasury: 0, beakers: 0, luxuries: 0 });
    expect(finalState.turn).toBe(CONSERVATION_TURNS + 1);
  });

  it('the starting-units rules reject a world that lost a worker or gained a barbarian', () => {
    // The rules are the engine's answer, so they have to react to a world that is
    // wrong in each of the two ways the rule names — otherwise "every civilization
    // has one worker" is a sentence with nothing behind it.
    const game = newGame(1, settingsFor({ mapSize: 'duel', civCount: 2 }), RULESET);
    if (!game.ok) throw new Error('newGame must host seed 1');

    expect(startingUnitsReport(game.value, RULESET)).toEqual([]);

    const withoutWorker: GameState = {
      ...game.value,
      units: game.value.units.filter(
        (unit) => !(unit.owner === ROME && unitDef(RULESET, unit.type)?.role === 'worker'),
      ),
    };
    expect(startingUnitsReport(withoutWorker, RULESET).join('\n')).toMatch(
      /Player 1 owns 0 worker\(s\), not exactly 1/,
    );

    const barbarian = game.value.players.find((player) => player.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('a new game must have a barbarian player');
    const withBand: GameState = {
      ...game.value,
      units: [
        ...game.value.units,
        {
          id: asUnitId(game.value.units.length),
          type: WARRIOR,
          owner: barbarian.id,
          tile: asTileIndex(0),
          movementLeft: 1,
        },
      ],
    };
    expect(startingUnitsReport(withBand, RULESET).join('\n')).toMatch(
      /the barbarians own 1 unit\(s\), not 0/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The DSL's M4b additions — additive, and loud when they are wrong
 * ------------------------------------------------------------------ */

describe('the scenario builder states M4b money', () => {
  /** A one-civilization world with a single unit, which is all these cases need. */
  const withRome = (b: ScenarioBuilder): ScenarioBuilder =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SETTLER, [5, 5])
      .addUnit(1, WARRIOR, [20, 20]);

  const build = (setup: (builder: ScenarioBuilder) => ScenarioBuilder) =>
    setup(createScenarioBuilder(RULESET, DUEL_SETTINGS)).build();

  it('gives every civilization the starting treasury, the default rates and two empty pools', () => {
    // The defaults `newGame` writes, so a scenario that says nothing about money
    // still describes a state the engine could have produced — and so every
    // existing M2/M3/M4a scenario kept building the same world it always did (the
    // hashes move, because the fields are part of the state, which is M4b's own
    // SCHEMA_VERSION bump).
    const built = build(withRome);
    if (!built.ok) throw new Error(`the fixture must build: ${JSON.stringify(built.error)}`);

    expect(built.value.players.map((player) => player.treasury)).toEqual([
      STARTING_TREASURY,
      STARTING_TREASURY,
    ]);
    expect(built.value.players.map((player) => player.rates)).toEqual([
      DEFAULT_RATES,
      DEFAULT_RATES,
    ]);
    expect(built.value.players.map((player) => player.beakers)).toEqual([0, 0]);
    expect(built.value.players.map((player) => player.luxuries)).toEqual([0, 0]);

    // The four fields are plain JSON: they survive a round trip and the state still
    // hashes, which is the whole reason they are written rather than left off (a
    // key holding `undefined` cannot survive either, and `canonicalize` rejects
    // it).
    expect(JSON.parse(JSON.stringify(built.value))).toEqual(built.value);
    expect(hashValue(built.value)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('states a treasury, rates and pools — and keeps an omitted pool field', () => {
    const built = build((b) =>
      withRome(b)
        .setTreasury(0, 7)
        .setRates(0, { tax: 2, science: 3, luxury: 5 })
        .setPools(0, { beakers: 3 })
        .setPools(0, { luxuries: 9 }),
    );
    if (!built.ok) throw new Error(`the fixture must build: ${JSON.stringify(built.error)}`);

    const rome = built.value.players[0];
    const carthage = built.value.players[1];
    expect(rome?.treasury).toBe(7);
    expect(rome?.rates).toEqual({ tax: 2, science: 3, luxury: 5 });
    expect(rome?.beakers).toBe(3);
    expect(rome?.luxuries).toBe(9);
    // The second player was not mentioned, so it keeps the defaults.
    expect(carthage?.treasury).toBe(STARTING_TREASURY);
    expect(carthage?.rates).toEqual(DEFAULT_RATES);
  });

  it('refuses a treasury the engine can never hold, a rate triple that breaks the rule, and a barbarian with money', () => {
    expect(() => build((b) => withRome(b).setTreasury(0, -1))).toThrow(
      /never lets a treasury go below zero/,
    );
    expect(() => build((b) => withRome(b).setTreasury(0, 1.5))).toThrow(/integer gold >= 0/);
    expect(() => build((b) => withRome(b).setRates(0, { tax: 6, science: 4, luxury: 1 }))).toThrow(
      /= 11/,
    );
    expect(() =>
      build((b) => withRome(b).setRates(0, { tax: 6.5, science: 3.5, luxury: 0 })),
    ).toThrow(/tax must be an integer >= 0/);
    expect(() => build((b) => withRome(b).setPools(0, { beakers: -1 }))).toThrow(
      /integer beakers >= 0/,
    );
    // The index has to name a player that was added...
    expect(() => build((b) => withRome(b).setTreasury(2, 5))).toThrow(/needs a player index/);
    // ...and it has to be a civilization: `applyEconomy` skips barbarians outright,
    // so a barbarian treasury is a number nothing reads.
    expect(() => build((b) => withRome(b).addBarbarianPlayer().setTreasury(2, 5))).toThrow(
      /the barbarian player .* has no economy/,
    );
    expect(() =>
      build((b) => withRome(b).addBarbarianPlayer().setRates(2, { tax: 1, science: 1, luxury: 8 })),
    ).toThrow(/the barbarian player .* has no economy/);
  });
});
