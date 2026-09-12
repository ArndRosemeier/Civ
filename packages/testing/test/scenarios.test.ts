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
 *
 * **M3, M4a, M4b, M4c, M5 and M6 appended their own acceptance evidence to this
 * file**, each in its own numbered section at the end, so one run of one file is
 * the milestone suite. M6's section (17) is the last: combat odds for the known
 * modifier list (including the arithmetic that separates compounding from flooring
 * twice), a capture with its exact population and its exact list of destroyed
 * buildings, a promotion ladder with the exact attack bonus at each level, and a
 * barbarian band's exact route to a city it then takes. M5's section (16) was the
 * last before it: research *timing* (the exact turn a
 * tech completes, the beaker remainder carried into the next tech, and beakers banked
 * when nothing is selected), prerequisites (an unmet one refused; a completed tech
 * unlocking exactly what it should and nothing else), and gating (a tech-gated item
 * refused before and accepted after, including an item whose resource is itself
 * behind a tech, so the two gates compose). Each scenario has a falsification test
 * below it that runs its own assertions against a world where the rule is broken —
 * an assertion that cannot fail is not evidence.
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
  applyEconomy,
  applyGrowth,
  applyProduction,
  applyResearch,
  asBuildingId,
  asCityId,
  asImprovementId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  buildingCatalog,
  buildingHolder,
  cityAt,
  cityById,
  cityMaintenance,
  cityProductionOptions,
  captureRulesOf,
  capturedPopulation,
  cityYields,
  civPlayers,
  connected,
  combatRulesOf,
  defenderBonusPct,
  drawsWin,
  experienceOf,
  foodBoxSize,
  hasImprovement,
  hitPointsLeftOf,
  hutAt,
  improvementDef,
  improvementsAt,
  indexToX,
  indexToY,
  isConnected,
  isExplored,
  isFortified,
  isPlaceholder,
  isWonder,
  knownTechs,
  loadSettings,
  maintenanceOf,
  mayStartBuilding,
  modifiedDefense,
  neighbors8,
  newGame,
  nextBelow,
  planSetResearch,
  prerequisitesOf,
  placeholder,
  playerIncome,
  productionGate,
  ratesProblem,
  researchingOf,
  researchStep,
  seedRng,
  splitCommerce,
  techDef,
  techUnlocks,
  tileIndex,
  tileYields,
  unitById,
  unitDef,
  unitSupport,
  unitsOnTile,
  unmetTechFor,
  veteranAttack,
  winPct,
  planStartWork,
  visibleTiles,
  type City,
  type CityId,
  type Command,
  type CommandOutcome,
  type BuildingId,
  type GameError,
  type GameEvent,
  type GameMap,
  type GameState,
  type HutRewardKind,
  type ImprovementId,
  type PlayerId,
  type ProductionItem,
  type Rates,
  type ResearchStep,
  type Result,
  type RulesetView,
  type TechId,
  type TileIndex,
  type Unit,
  type UnitTypeId,
  type UnitWork,
} from '@civts/core';
import {
  CATALOG,
  validateRuleset,
  type BuildingSpec,
  type Catalog,
  type ImprovementSpec,
  type ResourceSpec,
  type UnitSpec,
} from '@civts/rules';
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
 * **The nine combat magnitudes, as the resolver reads them** (M6b).
 *
 * M6 shipped these as `export const` values in `packages/core/src/combat.ts` —
 * `FORTIFY_BONUS_PCT`, `CITY_DEFENSE_BONUS_PCT`, `WALLS_BONUS_PCT`,
 * `VETERAN_ATTACK_PCT`, `MAX_EXPERIENCE`, `ROLL_BOUND`, `DAMAGE_PER_ROUND` and the two
 * clamps — and this file imported `MAX_EXPERIENCE` from `@civts/core` by name. M6b moved
 * all nine into the catalog's `combat` section, so the fixture asks `combatRulesOf` for
 * them, which is the *same* reader `core/commands.ts` uses before it resolves a battle.
 *
 * The values these scenarios assert are still written out by hand: the odds table, the
 * promotion ladder and the "flooring twice gives a different number" discriminator all
 * state the number they expect, which is what makes them evidence about the engine rather
 * than a restatement of it. What this constant supplies is the handful of figures a check
 * needs at runtime — the promotion cap, and the three bonuses and the roll bound the
 * readers require a caller to pass — so the relocation moves none of the numbers under
 * test.
 */
const COMBAT_RULES = combatRulesOf(RULESET);

/**
 * **The capture rule, read the same way** (M7).
 *
 * M6 shipped the divisor as `CAPTURE_POPULATION_DIVISOR`, a module constant in
 * `packages/core/src/cities.ts`, and this file imported it by name. M7 moves it into the
 * catalog's `capture` section, so the fixture asks `captureRulesOf` for it — the *same*
 * reader `core/commands.ts` uses before it applies a sack — and the scenarios below keep
 * stating the numbers they expect (4 -> 2, and never below one), which is what makes them
 * evidence about the engine rather than a restatement of it.
 */
const CAPTURE_RULES = captureRulesOf(RULESET);

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

/* ------------------------------------------------------------------ *
 * M4c acceptance evidence — building effects, wonders, resources, maintenance
 * ------------------------------------------------------------------ */

/**
 * M4c's content, named the way `@civts/rules` names it, with the magnitudes these
 * scenarios assert spelled out beside each id.
 *
 * **Every magnitude below is a placeholder.** The rows are `placeholder(...)` in
 * the shipped catalog; the percentages, maintenance costs, wonder flag and the
 * swordsman's iron requirement are ours, chosen to be playable, and none of them is
 * presented as Civ 3's (PLAN.md §6.2 — the provenance rule the M3 warning states
 * verbatim). What the scenarios pin is that the *engine* reads the row the catalog
 * declares: the rule under test is M4c's (sum-then-floor, global uniqueness, the
 * connection walk, maintenance reachability), not the tuning. Where a number of
 * ours is asserted as a number, it is asserted *as* a placeholder — the maintenance
 * scenario checks the provenance outright.
 */
const MARKETPLACE = asBuildingId('marketplace'); // commerce-multiplier 50%, maintenance 1, cost 12
const LIBRARY = asBuildingId('library'); // beaker-multiplier 50%, maintenance 1, cost 20
const BARRACKS = asBuildingId('barracks'); // shield-multiplier 25%, maintenance 1, cost 12
const WALLS = asBuildingId('walls'); // shield-multiplier 25%, maintenance 1, cost 15
const FACTORY = asBuildingId('factory'); // shield-multiplier 50%, maintenance 3, cost 25
const PYRAMIDS = asBuildingId('pyramids'); // wonder: growth-food 1, maintenance 2, cost 30
const IRON = asResourceId('iron'); // strategic: what the swordsman requires
const GEMS = asResourceId('gems'); // luxury: placed, connected, read by nothing until M9
const WHEAT = asResourceId('wheat'); // bonus: +1 food on its tile
const WINES = asResourceId('wines'); // luxury: inert until M9
const SWORDSMAN = asUnitTypeId('swordsman'); // cost 3 shields, `requiresResource: iron`

const buildingItem = (id: BuildingId): ProductionItem => ({ kind: 'building', id });
const unitItem = (id: UnitTypeId): ProductionItem => ({ kind: 'unit', id });

/** The city `cityId`, or a loud failure: every scenario world below has it. */
const cityOf = (state: GameState, cityId: CityId): City => {
  const city = cityById(state, cityId);
  if (city === undefined) throw new Error(`city ${String(cityId)} is not in the state`);
  return city;
};

/** The building row `id`, or a loud failure — a content bug rather than a test bug. */
const buildingRowOf = (ruleset: RulesetView, id: BuildingId) => {
  const def = buildingCatalog(ruleset).find((row) => row.id === id);
  if (def === undefined) throw new Error(`the ruleset defines no building "${id}"`);
  return def;
};

/**
 * `state` with city `cityId`'s `buildings` list replaced **wholesale** — the world
 * an assertion uses to ask "what would this same city have produced with *these*
 * buildings?".
 *
 * This is not a shortcut around the engine: a building's effect is a pure read of
 * `city.buildings` (`buildings.ts`' `cityBuildingEffects`), so the same city with a
 * shorter list *is* the same city earlier in its own completion order — same
 * terrain, same worked tiles, same citizens, same rates. Assertions that read the
 * earlier stage off the final state through this helper are therefore asserting
 * about the engine's own earlier world rather than about a hand-recomputed number.
 * The stages are taken from the city's **actual** final list (`slice`), not from a
 * list the test believes in, so a scenario whose timeline silently completed a
 * different set of buildings fails the assertions that follow instead of grading
 * itself against its own intention.
 */
const withBuildings = (
  state: GameState,
  cityId: CityId,
  buildings: readonly BuildingId[],
): GameState => ({
  ...state,
  cities: state.cities.map((city) => (city.id === cityId ? { ...city, buildings } : city)),
});

/** The production options a city shows, as `kind:id` strings a test can compare. */
const optionIds = (state: GameState, ruleset: RulesetView, cityId: CityId): readonly string[] =>
  cityProductionOptions(state, ruleset, cityId).map((item) => `${item.kind}:${item.id}`);

/** Every resource `playerId` has connected, sorted — a comparable list. */
const connectedIds = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly string[] => [...connected(state, ruleset, playerId)].sort();

/** Build a fixture world directly (outside `runScenario`) for the hand-walked tests. */
const buildWorld = (setup: (b: ScenarioBuilder) => ScenarioBuilder): GameState => {
  const built = setup(createScenarioBuilder(RULESET, DUEL_SETTINGS)).build();
  if (!built.ok) throw new Error(`the fixture must build: ${JSON.stringify(built.error)}`);
  return built.value;
};

/**
 * Walking a scripted turn sequence by hand, asserting each step — the same
 * technique the conservation scenario's second test uses, and the reason it is here
 * rather than only in the scenario's `assert`: the *before* and *after* of a
 * building's completion are states the runner's final state no longer has.
 */
const walk = (
  state: GameState,
  commands: readonly Command[],
): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
  let current = state;
  const events: GameEvent[] = [];
  for (const command of commands) {
    const outcome = applyFor(current, ROME, command, RULESET);
    current = outcome.state;
    events.push(...outcome.events);
  }
  return { state: current, events };
};

/* ---- 12. Building effects ----------------------------------------- */

/**
 * The building-effect world. One Roman city, three citizens, a worked radius whose
 * yields are whole and stated, no food surplus (so nothing grows and every stage
 * below is about the *buildings*), and a scripted completion order.
 *
 * The arithmetic, all of it from the shipped rows:
 *
 * - centre grassland 2 food / 1 shield / 1 commerce (floored at 1 per component);
 *   worked grassland 2/1/1; two worked plains 1/2/1 each.
 * - So **6 food** (2+2+1+1) with three citizens eating 6 — a surplus of exactly 0,
 *   which is what keeps the world from growing out from under the assertions — and
 *   **6 shields** (1+1+2+2) and **4 commerce** (1+1+1+1).
 * - Rome's rates are **5/5/0** rather than the default 6/4/0, chosen so the two
 *   channels are equal and the library's 50% lands on a number that moves: at 6/4/0
 *   four commerce is 2 gold and 1 beaker, and a 50% beaker multiplier on 1 beaker
 *   would be invisible (floor(1.5) = 1). PLACEHOLDER rates either way — `RATE_TOTAL`
 *   is 10 in both.
 * - 34 stored shields and 100 gold are stated outright, so the scripted completions
 *   land on the turns the comments below name and the treasury never hits zero (a
 *   shortfall here would take the buildings the scenario is measuring).
 */
const EFFECT_CITY = asCityId(0);
const EFFECT_GRASSLAND = at(4, 5);
const EFFECT_PLAINS_A = at(6, 5);
const EFFECT_PLAINS_B = at(5, 6);
const EFFECT_RATES: Rates = { tax: 5, science: 5, luxury: 0 };
const EFFECT_STORED_SHIELDS = 34;
const EFFECT_TREASURY = 100;

const effectSetup = (b: ScenarioBuilder): ScenarioBuilder =>
  b
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .setTile(6, 5, 'plains')
    .setTile(5, 6, 'plains')
    .setRates(0, EFFECT_RATES)
    .setTreasury(0, EFFECT_TREASURY)
    .addUnit(0, WARRIOR, [35, 35])
    .addUnit(1, WARRIOR, [20, 20])
    .addCity(0, [5, 5], {
      name: 'Roma',
      population: 3,
      foodBox: 0,
      shields: EFFECT_STORED_SHIELDS,
      workedTiles: [EFFECT_GRASSLAND, EFFECT_PLAINS_A, EFFECT_PLAINS_B],
    });

/** The completion order the scenario scripts: one building at a time, in this order. */
const EFFECT_COMPLETIONS: readonly BuildingId[] = [MARKETPLACE, LIBRARY, BARRACKS, WALLS, FACTORY];

/**
 * The script: `SetProduction` then enough `EndTurn`s for that item to finish.
 *
 * The factory needs **three** turns at the 9 shields a turn the two 25% multipliers
 * give (9, 18, 27 >= its cost 25), which is why it is the one entry with extra
 * `EndTurn`s. The earlier items all complete on the first turn because 34 stored
 * shields pay for them (40 - 12 = 28, 34 - 20 = 14, 20 - 12 = 8, 8 + 7 = 15 >= 15).
 */
const effectRun = (completed: readonly BuildingId[]): readonly Command[] => {
  const commands: Command[] = [];
  for (const id of completed) {
    commands.push(setProduction(0, buildingItem(id)));
    commands.push(endTurn());
    if (id === FACTORY) commands.push(endTurn(), endTurn());
  }
  return commands;
};

const EFFECT_RUN: readonly Command[] = effectRun(EFFECT_COMPLETIONS);

/** What the final state of the scripted world has to look like, stage by stage. */
const EFFECT_STAGES: readonly {
  readonly completed: number;
  readonly shows: string;
  readonly shields: number;
  readonly commerce: number;
  readonly food: number;
  readonly gold: number;
  readonly beakers: number;
}[] = [
  { completed: 0, shows: 'nothing', shields: 6, commerce: 4, food: 6, gold: 2, beakers: 2 },
  { completed: 1, shows: 'marketplace', shields: 6, commerce: 6, food: 6, gold: 3, beakers: 3 },
  { completed: 2, shows: 'library', shields: 6, commerce: 6, food: 6, gold: 3, beakers: 4 },
  { completed: 3, shows: 'barracks', shields: 7, commerce: 6, food: 6, gold: 3, beakers: 4 },
  { completed: 4, shows: 'walls', shields: 9, commerce: 6, food: 6, gold: 3, beakers: 4 },
  { completed: 5, shows: 'factory', shields: 12, commerce: 6, food: 6, gold: 3, beakers: 4 },
];

/**
 * BUILDING EFFECTS. What one city's buildings do to *its own* output, with the
 * exact gold, beakers and shields before and after each of the three multipliers
 * M4c ships — and the compound-flooring rule, which is the whole reason the effect
 * union is summed before it is applied.
 *
 * Reading the table above (all of it hand-computed from the shipped rows, and all of
 * it asserted below):
 *
 * - **before any building** — 6 shields, 4 commerce, so 2 gold and 2 beakers at
 *   5/5/0;
 * - **marketplace** (commerce +50%) — `floor(4 * 150 / 100) = 6` commerce, hence
 *   3 gold and 3 beakers. It changes *commerce*, which the rates then divide, so
 *   both channels move;
 * - **library** (beakers +50%) — the city's 3 beakers become
 *   `floor(3 * 150 / 100) = 4`; gold is untouched at 3. It scales one *channel*, and
 *   only this city's (M4c: effects apply only to their own city);
 * - **barracks** (shields +25%) — `floor(6 * 125 / 100) = 7`;
 * - **walls** (shields +25%) — the two percentages **sum before one floor**:
 *   `floor(6 * 150 / 100) = 9`. Flooring each separately would give
 *   `floor(floor(6 * 1.25) * 1.25) = 8`, which is the reading this engine does NOT
 *   implement, and the assertion below checks both numbers so that the case is
 *   discriminating rather than merely satisfied;
 * - **factory** (shields +50%) — the three percentages now sum to 100%:
 *   `floor(6 * 200 / 100) = 12`, not the 13 a per-building floor gives.
 *
 * Food is 6 at every stage: M4c's union has no food multiplier, and the granary's
 * `growth-food` shrinks the *requirement* instead, which is not part of this triple.
 */
const buildingEffectsScenario = defineScenario({
  name: 'building-effects-multiply-one-city-and-floor-once',
  settings: DUEL_SETTINGS,
  setup: effectSetup,
  run: EFFECT_RUN,
  assert: (after, ruleset) => {
    const city = cityOf(after, EFFECT_CITY);
    const stage = (completed: number): GameState =>
      withBuildings(after, EFFECT_CITY, city.buildings.slice(0, completed));
    const yieldsAt = (completed: number) => cityYields(stage(completed), ruleset, EFFECT_CITY);
    const incomeAt = (completed: number) => playerIncome(stage(completed), ruleset, ROME);

    const observed = EFFECT_STAGES.map((entry) => ({
      entry,
      yields: yieldsAt(entry.completed),
      income: incomeAt(entry.completed),
    }));
    const [none, market, library, barracks, walls, all] = observed;

    // The alternative reading of the compound rule, computed here so the assertion
    // can name it: apply each building's percentage in turn, flooring every time.
    const floorEach = (value: number, pcts: readonly number[]): number =>
      pcts.reduce((running, pct) => Math.floor((running * (100 + pct)) / 100), value);
    const wallsFloorEach = floorEach(6, [25, 25]);
    const factoryFloorEach = floorEach(6, [50, 25, 25]);

    const exact = (entry: (typeof observed)[number]): string =>
      `${entry.entry.shows}: ${String(entry.yields.shields)} shields, ` +
      `${String(entry.yields.commerce)} commerce, ${String(entry.yields.food)} food, ` +
      `${String(entry.income.gold)} gold, ${String(entry.income.beakers)} beakers`;

    return [
      check(
        city.buildings.length === EFFECT_COMPLETIONS.length &&
          EFFECT_COMPLETIONS.every((id, index) => city.buildings[index] === id),
        'the city completed its five buildings in the scripted order (marketplace, library, ' +
          `barracks, walls, factory); it actually holds [${city.buildings.join(', ')}]`,
      ),
      check(
        none !== undefined &&
          none.yields.shields === 6 &&
          none.yields.commerce === 4 &&
          none.yields.food === 6 &&
          none.income.gold === 2 &&
          none.income.beakers === 2,
        'before any building the city produces 6 shields and 4 commerce (grassland centre 2/1/1, ' +
          'worked grassland 2/1/1, two worked plains 1/2/1 each) and 6 food with no surplus, so at ' +
          `5/5/0 that commerce is 2 gold and 2 beakers; got ${none === undefined ? 'nothing' : exact(none)}`,
      ),
      check(
        market !== undefined &&
          market.yields.commerce === 6 &&
          market.yields.shields === 6 &&
          market.income.gold === 3 &&
          market.income.beakers === 3,
        'after the marketplace the commerce multiplier applies to commerce alone: ' +
          `floor(4 * 150 / 100) = 6, so 3 gold and 3 beakers and shields unchanged at 6; got ` +
          (market === undefined ? 'nothing' : exact(market)),
      ),
      check(
        library !== undefined &&
          library.income.beakers === 4 &&
          library.income.gold === 3 &&
          library.yields.commerce === 6,
        "after the library the beaker multiplier applies to this city's own beaker channel: " +
          `floor(3 * 150 / 100) = 4, with gold untouched at 3 and commerce still 6; got ` +
          (library === undefined ? 'nothing' : exact(library)),
      ),
      check(
        barracks !== undefined && barracks.yields.shields === 7,
        'after the barracks the single 25% shield multiplier gives floor(6 * 125 / 100) = 7; got ' +
          `${String(barracks?.yields.shields)} shields`,
      ),
      check(
        walls !== undefined && walls.yields.shields === 9 && wallsFloorEach === 8,
        'two 25% shield multipliers SUM before one floor: floor(6 * 150 / 100) = 9, and flooring ' +
          `each separately would give ${String(wallsFloorEach)} (the reading this engine does NOT ` +
          `implement, so this case discriminates); got ${String(walls?.yields.shields)} shields`,
      ),
      check(
        all !== undefined && all.yields.shields === 12 && all.yields.commerce === 6,
        'after the factory the three shield percentages sum to 100% before the floor: ' +
          `floor(6 * 200 / 100) = 12, not the ${String(factoryFloorEach)} a per-building floor ` +
          `gives; got ${String(all?.yields.shields)} shields`,
      ),
      check(
        observed.every((entry) => entry.yields.food === 6),
        "food is not multiplied by any building (M4c's effect union has no food multiplier; the " +
          `granary reduces the growth requirement instead): 6 food at every stage; got ` +
          observed.map((entry) => String(entry.yields.food)).join(', '),
      ),
      check(
        moneyOf(after, ROME).treasury === 96,
        'gold is accounted for to the piece: 100 + (3-1) + (3-2) + (3-3) + (3-4) + (3-4) + (3-4) ' +
          `+ (3-7) = 96 — seven turns of 3 gold of income against the maintenance of the buildings ` +
          `standing at the time; got ${String(moneyOf(after, ROME).treasury)}`,
      ),
    ];
  },
});

describe('M4c scenario: building effects (gold, beakers, shields, compound flooring)', () => {
  it('agrees with the scenario assertions and pins every stage from the engine’s own turns', () => {
    const result = runScenario(buildingEffectsScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The same timeline again, walked one command at a time, so each stage is read
    // off the *state the engine produced* rather than off a reconstruction of it.
    let state = buildWorld(effectSetup);
    expect(cityYields(state, RULESET, EFFECT_CITY)).toEqual({
      food: 6,
      shields: 6,
      commerce: 4,
      foodSurplus: 0,
    });

    for (const entry of EFFECT_STAGES.slice(1)) {
      const id = EFFECT_COMPLETIONS[entry.completed - 1];
      if (id === undefined) throw new Error('every stage after the first completes one building');
      const steps: Command[] = [setProduction(0, buildingItem(id)), endTurn()];
      if (id === FACTORY) steps.push(endTurn(), endTurn());
      const walked = walk(state, steps);
      state = walked.state;

      const yields = cityYields(state, RULESET, EFFECT_CITY);
      const income = playerIncome(state, RULESET, ROME);
      expect({
        shields: yields.shields,
        commerce: yields.commerce,
        food: yields.food,
        gold: income.gold,
        beakers: income.beakers,
      }).toEqual({
        shields: entry.shields,
        commerce: entry.commerce,
        food: entry.food,
        gold: entry.gold,
        beakers: entry.beakers,
      });
      // The building really is standing, and it is the one this stage is named for.
      expect(cityOf(state, EFFECT_CITY).buildings.at(-1)).toBe(id);
    }

    expect(cityOf(state, EFFECT_CITY).buildings).toEqual([...EFFECT_COMPLETIONS]);
    expect(moneyOf(state, ROME)).toEqual({ treasury: 96, beakers: 27, luxuries: 0 });
    expect(hashValue(state)).toBe(hashValue(result.finalState));
  });

  it('collects the last turn’s gold and beakers in the engine’s own event stream', () => {
    // The runner's final state is one thing; the *ledger* is another, and M4c's
    // effects have to be visible in both. The final turn is the factory's: its
    // 3 gold and 4 beakers are what the commerce multiplier, the rates and the
    // beaker multiplier produced together.
    const state = buildWorld(effectSetup);
    const walked = walk(state, EFFECT_RUN);
    const lastTurn = incomeLines(walked.events, ROME).at(-1);

    expect(lastTurn).toEqual({
      type: 'IncomeCollected',
      playerId: ROME,
      gold: 3,
      beakers: 4,
      luxuries: 0,
    });
    // ...and the bill that turn, which is every building's maintenance summed.
    expect(upkeepLines(walked.events, ROME).at(-1)).toEqual({
      type: 'UpkeepPaid',
      playerId: ROME,
      gold: 7,
      maintenance: 7,
      unitSupport: 0,
      units: 1,
      freeUnits: FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE,
    });
  });
});

/* ---- 12b. Growth food: the granary --------------------------------- */

/**
 * M4c's `growth-food` effect: the granary reduces the food a city needs to grow,
 * and in this world the reduction is worth **exactly one turn**.
 *
 * The arithmetic, all of it the shipped rows' (every one of them a placeholder)
 * plus one bonus resource the map places:
 *
 * - Rome's capital stands on grassland (2 food / 1 shield / 1 commerce) and works
 *   one grassland tile carrying **wheat** — a bonus resource worth +1 food, so 3
 *   food on that tile. Five food in total, one citizen eating 2, so the surplus is
 *   exactly **3**.
 * - `foodBoxSize(1)` is `FOOD_BOX_BASE` = 10, and the granary declares
 *   `growth-food: 1`, so the reduced requirement is **9**.
 * - The box therefore reaches 9 on the **third** turn of the run and 10 on the
 *   fourth: the granary city grows on turn 3 carrying `9 - 9 = 0` over, and the
 *   identical city without one grows a turn later carrying `12 - 10 = 2`. A surplus
 *   of 2 would be no evidence at all — 9 and 10 both land on the fifth turn — which
 *   is why the fixture is tuned to 3.
 *
 * Carthage's capital is the **control in the same world**: same terrain, the same
 * wheat on the tile it works, the same citizen count and the same box, so the
 * granary is the only difference between the two cities and the one-turn gap cannot
 * be explained by two different maps.
 */
const GRANARY_CITY = asCityId(0); // Rome's capital: the holder
const GRANARY_CONTROL = asCityId(1); // Carthage's capital: identical but for the granary
const GRANARY_TILE_A = at(6, 5); // grassland + wheat: 2 + 1 = 3 food
const GRANARY_TILE_B = at(11, 10); // the same tile, in Carthage's radius

const granaryGrowthSetup =
  (holdsGranary: boolean) =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    const world = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addResource(6, 5, WHEAT)
      .addResource(11, 10, WHEAT)
      .addUnit(0, WARRIOR, [35, 35])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], {
        name: 'Roma',
        population: 1,
        foodBox: 0,
        workedTiles: [GRANARY_TILE_A],
      })
      .addCity(1, [10, 10], {
        name: 'Carthago',
        population: 1,
        foodBox: 0,
        workedTiles: [GRANARY_TILE_B],
      });
    // The single difference between the scenario and its falsification variant.
    return holdsGranary ? world.addBuilding(0, GRANARY) : world;
  };

const granaryGrowthScenario = defineScenario({
  name: 'granary-grows-its-city-one-turn-earlier',
  settings: DUEL_SETTINGS,
  setup: granaryGrowthSetup(true),
  // Three turns: the third is the granary city's growth turn, and the state the
  // scenario stops at is the moment the control city is one food short.
  run: endTurns(3),
  assert: (after, ruleset) => {
    const holder = cityOf(after, GRANARY_CITY);
    const control = cityOf(after, GRANARY_CONTROL);
    const controlYields = cityYields(after, ruleset, GRANARY_CONTROL);

    // The control's fourth turn, probed forward from the state the run stopped at.
    const fourth = romeApply(after, ruleset, endTurn())?.state;
    const controlGrown = fourth === undefined ? undefined : cityOf(fourth, GRANARY_CONTROL);

    return [
      check(
        holder.buildings.includes(GRANARY) && !control.buildings.includes(GRANARY),
        "the granary stands in Rome's capital and in no other city, so the two cities " +
          'differ in nothing but the building: Rome holds ' +
          `[${holder.buildings.join(', ')}], Carthage holds [${control.buildings.join(', ')}]`,
      ),
      check(
        controlYields.food === 5 && controlYields.foodSurplus === 3 && foodBoxSize(1) === 10,
        'the arithmetic both turns come from: a grassland centre plus a wheat grassland tile is ' +
          '5 food, one citizen eats 2, so the surplus is 3 against the 10 food a second citizen ' +
          `costs — got food ${String(controlYields.food)}, surplus ` +
          `${String(controlYields.foodSurplus)}, box size ${String(foodBoxSize(1))}`,
      ),
      check(
        after.turn === 4 && holder.population === 2 && holder.foodBox === 0,
        'the granary city grew on the THIRD turn of the run (the state is at turn 4), carrying ' +
          `9 - 9 = 0 over — got turn ${String(after.turn)}, population ` +
          `${String(holder.population)}, box ${String(holder.foodBox)}`,
      ),
      check(
        control.population === 1 && control.foodBox === 9,
        'at that same moment the city without a granary has NOT grown: its box holds 9 of the 10 ' +
          "a second citizen costs, because the reduction is the holder's alone — got population " +
          `${String(control.population)}, box ${String(control.foodBox)}`,
      ),
      check(
        controlGrown !== undefined && controlGrown.population === 2 && controlGrown.foodBox === 2,
        'the very next turn the control city grows too — 12 - 10 = 2 carried over — so the ' +
          'granary bought exactly one turn and not two, and the remainder differs (0 against 2) ' +
          `because the threshold did — got population ${String(controlGrown?.population)}, box ` +
          `${String(controlGrown?.foodBox)} (the fourth turn was ` +
          `${fourth === undefined ? 'refused' : 'applied'})`,
      ),
    ];
  },
});

describe('M4c scenario: the granary grows its city one turn earlier', () => {
  it('agrees with the scenario assertions, and shows the gap in the engine’s own turn stream', () => {
    const result = runScenario(granaryGrowthScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The same world again, walked one turn at a time: the two growths are then read
    // off the *engine's* events rather than off the states they left behind, which is
    // what makes "on the third turn, with this box" a statement about the pipeline.
    const third = walk(buildWorld(granaryGrowthSetup(true)), endTurns(3));
    expect(third.state.turn).toBe(4);
    expect(third.events.filter((event) => event.type === 'CityGrew')).toEqual([
      { type: 'CityGrew', cityId: GRANARY_CITY, owner: ROME, population: 2, foodBox: 0 },
    ]);
    expect(cityOf(third.state, GRANARY_CONTROL)).toMatchObject({ population: 1, foodBox: 9 });

    const fourth = walk(third.state, [endTurn()]);
    expect(fourth.state.turn).toBe(5);
    expect(fourth.events.filter((event) => event.type === 'CityGrew')).toEqual([
      { type: 'CityGrew', cityId: GRANARY_CONTROL, owner: CARTHAGE, population: 2, foodBox: 2 },
    ]);

    // And the scripted run's final state is exactly the state the walk reached: the
    // scenario is measuring the same world the events above come from.
    expect(result.finalState).toBeDefined();
    if (result.finalState !== undefined) {
      expect(hashValue(third.state)).toBe(hashValue(result.finalState));
    }
  });
});

/* ---- 13. Wonders -------------------------------------------------- */

const WONDER_CITY_A = asCityId(0); // Rome's city
const WONDER_CITY_B = asCityId(1); // Carthage's city, five tiles away
const WONDER_HILLS = at(5, 6); // worked by A: 0 food, 2 shields, 0 commerce
const WONDER_FARM = at(10, 11); // worked by B: 2 food, 1 shield, 1 commerce

/**
 * The wonder world, parameterised by the two things the two scenarios below differ
 * in: Rome's starting treasury (which decides whether it can pay the wonder's
 * maintenance) and whether the wonder is there at all (which is what the
 * discrimination tests take away).
 *
 * Rome's city A works one hill, so its output is deliberately tiny: the centre
 * (grassland, floored at 1/1/1) plus the hill is **2 food, 3 shields, 1 commerce**,
 * a food surplus of exactly 0 (no growth to move the numbers), and at the default
 * 6/4/0 that one commerce is `floor(0.6) = 0` gold, `floor(0.4) = 0` beakers and the
 * leftover 1 to gold — **1 gold a turn**. The Pyramids cost **2 gold a turn**
 * (PLACEHOLDER: the row's own `maintenance`), so from a treasury of 0 the very first
 * `EndTurn` cannot pay for them.
 *
 * Carthage's city B is there for the opposite reason: it is the *other* player's
 * production options, and M4c's wonder rule is about every city anywhere.
 */
const wonderSetup =
  (treasury: number, holdsWonder: boolean) =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    const world = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(5, 6, 'hills')
      .setTreasury(0, treasury)
      .addUnit(0, WARRIOR, [35, 35])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], {
        name: 'Roma',
        population: 1,
        foodBox: 0,
        workedTiles: [WONDER_HILLS],
      })
      .addCity(1, [10, 10], {
        name: 'Carthago',
        population: 1,
        foodBox: 0,
        workedTiles: [WONDER_FARM],
      });
    return holdsWonder ? world.addBuilding(0, PYRAMIDS) : world;
  };

/** Rome can pay: the wonder stands, and stays standing through the scenario. */
const wonderHeldScenario = defineScenario({
  name: 'wonder-held-by-one-civilization-leaves-every-other-option',
  settings: DUEL_SETTINGS,
  setup: wonderSetup(EFFECT_TREASURY, true),
  assert: (after, ruleset) => {
    const catalog = buildingCatalog(ruleset);
    const cityA = cityOf(after, WONDER_CITY_A);
    const cityB = cityOf(after, WONDER_CITY_B);
    const holder = buildingHolder(after, PYRAMIDS);

    // The other player's city, and *starting* the wonder there.
    const bRefusal = errorOf(
      applyCommand(after, CARTHAGE, setProduction(1, buildingItem(PYRAMIDS)), ruleset),
    );
    const bHeld = bRefusal?.kind === 'wonder-already-built' ? bRefusal : undefined;
    // The holder's own city: a different refusal, with a different fix.
    const ownRefusal = errorOf(
      applyCommand(after, ROME, setProduction(0, buildingItem(PYRAMIDS)), ruleset),
    );
    // The control: B may still start an *ordinary* building, so the refusal above
    // is about the wonder's uniqueness and not about B's city being unusable.
    const granaryRefusal = errorOf(
      applyCommand(after, CARTHAGE, setProduction(1, buildingItem(GRANARY)), ruleset),
    );

    const row = buildingRowOf(ruleset, PYRAMIDS);

    return [
      check(
        holder?.id === WONDER_CITY_A,
        `city ${String(Number(WONDER_CITY_A))} ("Roma") holds the Pyramids — the world is the one ` +
          'the scenario describes, and every assertion below is about a wonder that is really standing',
      ),
      check(
        !optionIds(after, ruleset, WONDER_CITY_B).includes(`building:${PYRAMIDS}`) &&
          !mayStartBuilding(after, catalog, cityB, PYRAMIDS),
        "a wonder one city holds is offered by NO other city: Carthage's production options are " +
          `[${optionIds(after, ruleset, WONDER_CITY_B).join(', ')}]`,
      ),
      check(
        bHeld !== undefined && bHeld.building === PYRAMIDS && bHeld.holder === WONDER_CITY_A,
        'and asking to start it anyway is refused with the typed `wonder-already-built`, naming the ' +
          `city that holds it — got ${bRefusal === undefined ? 'no refusal at all' : JSON.stringify(bRefusal)}`,
      ),
      check(
        ownRefusal?.kind === 'already-built' && ownRefusal.building === PYRAMIDS,
        "the holder's own attempt is refused with `already-built` instead (a different refusal, " +
          `because the fix is different) — got ${JSON.stringify(ownRefusal)}`,
      ),
      check(
        granaryRefusal === undefined &&
          optionIds(after, ruleset, WONDER_CITY_B).includes(`building:${GRANARY}`),
        'the uniqueness refusal is about the wonder and not about Carthage: the same city may still ' +
          'start an ordinary building, and the granary is refused with nothing',
      ),
      check(
        isWonder(row) &&
          maintenanceOf(row) === 2 &&
          cityMaintenance(catalog, cityA) === 2 &&
          cityMaintenance(catalog, cityB) === 0,
        'a wonder is a building like any other in every other respect: it declares `wonder: true`, ' +
          'it costs its owner 2 gold a turn, and that bill falls only on the city holding it ' +
          `(B owes ${String(cityMaintenance(catalog, cityB))})`,
      ),
    ];
  },
});

/** Rome cannot pay: the wonder's maintenance bankrupts it, and the wonder is lost. */
const wonderBankruptcyScenario = defineScenario({
  name: 'a-bankrupted-wonder-is-buildable-again',
  settings: DUEL_SETTINGS,
  setup: wonderSetup(0, true),
  run: [endTurn()],
  assert: (after, ruleset) => {
    const catalog = buildingCatalog(ruleset);
    const cityA = cityOf(after, WONDER_CITY_A);
    const restored = withBuildings(after, WONDER_CITY_A, [PYRAMIDS]);
    const income = playerIncome(after, ruleset, ROME);
    const next = applyFor(after, ROME, endTurn(), ruleset);
    const restartedRefusal = errorOf(
      applyCommand(after, ROME, setProduction(0, buildingItem(PYRAMIDS)), ruleset),
    );
    const otherRefusal = errorOf(
      applyCommand(after, CARTHAGE, setProduction(1, buildingItem(PYRAMIDS)), ruleset),
    );

    return [
      check(
        cityA.buildings.length === 0 && buildingHolder(after, PYRAMIDS) === undefined,
        'the bankruptcy took the wonder: city 0 holds nothing and no city anywhere holds the ' +
          `Pyramids (its buildings are [${cityA.buildings.join(', ')}])`,
      ),
      check(
        moneyOf(after, ROME).treasury === 0 && income.gold === 1,
        'the bill was 2 gold of maintenance against 1 gold of income (one commerce at 6/4/0), so ' +
          'the treasury floored at exactly 0 and reported a shortfall rather than going negative — ' +
          `got ${String(moneyOf(after, ROME).treasury)} gold and ${String(income.gold)} of income`,
      ),
      check(
        cityMaintenance(catalog, cityOf(restored, WONDER_CITY_A)) === 2 &&
          !mayStartBuilding(restored, catalog, cityOf(restored, WONDER_CITY_A), PYRAMIDS) &&
          !optionIds(restored, ruleset, WONDER_CITY_B).includes(`building:${PYRAMIDS}`),
        'the same world with the wonder put back is exactly the world where nobody may start it: ' +
          "its maintenance is 2, city 0 may not restart it and it is in no other city's options — " +
          'so what the loss changed is the holder, and nothing else',
      ),
      check(
        mayStartBuilding(after, catalog, cityA, PYRAMIDS) &&
          optionIds(after, ruleset, WONDER_CITY_A).includes(`building:${PYRAMIDS}`) &&
          restartedRefusal === undefined,
        'a wonder lost to bankruptcy is buildable again: the city that lost it may start it once ' +
          `more — got ${restartedRefusal === undefined ? 'accepted' : JSON.stringify(restartedRefusal)}`,
      ),
      check(
        optionIds(after, ruleset, WONDER_CITY_B).includes(`building:${PYRAMIDS}`) &&
          otherRefusal === undefined,
        'and it is back in the OTHER player\'s options too, which is the whole of "unique but never ' +
          'rebuilt" coming apart: with no holder anywhere, the wonder is startable by anyone',
      ),
      check(
        moneyOf(next.state, ROME).treasury === 1 &&
          !next.events.some((event) => event.type === 'TreasuryShortfall'),
        'what the loss buys is the next turn: with no maintenance left, 1 gold of income is 1 gold ' +
          'of treasury and no shortfall',
      ),
    ];
  },
});

describe('M4c scenario: wonders are globally unique', () => {
  it('keeps a held wonder out of every other city’s options, and names the holder in the refusal', () => {
    const result = runScenario(wonderHeldScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The world the setup really built: if the wonder were not standing, the
    // scenario's assertions would be about nothing, so the fixture is pinned here.
    const state = buildWorld(wonderSetup(EFFECT_TREASURY, true));
    expect(buildingHolder(state, PYRAMIDS)?.id).toBe(WONDER_CITY_A);
    expect(cityOf(state, WONDER_CITY_A).buildings).toEqual([PYRAMIDS]);
    expect(cityYields(state, RULESET, WONDER_CITY_A)).toEqual({
      food: 2,
      shields: 3,
      commerce: 1,
      foodSurplus: 0,
    });
    expect(playerIncome(state, RULESET, ROME)).toEqual({ gold: 1, beakers: 0, luxuries: 0 });

    // The option list is the *engine's* own (`planSetProduction`), which is why the
    // assertion above is not just a menu the test painted.
    expect(optionIds(state, RULESET, WONDER_CITY_B)).not.toContain(`building:${PYRAMIDS}`);
    expect(optionIds(state, RULESET, WONDER_CITY_B)).toContain(`building:${GRANARY}`);
  });

  it('records the bankruptcy that takes it: a real shortfall out of the wonder’s own maintenance', () => {
    const result = runScenario(wonderBankruptcyScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const state = buildWorld(wonderSetup(0, true));
    expect(buildingHolder(state, PYRAMIDS)?.id).toBe(WONDER_CITY_A);

    // One `EndTurn`: income 1, upkeep 2 (the wonder alone), treasury 0 — so the
    // shortfall is 1, and no unit can pay it (Rome's single warrior is inside the
    // six-unit free allowance, so `applyEconomy` disbands nothing).
    const walked = walk(state, [endTurn()]);
    expect(moneyOf(walked.state, ROME).treasury).toBe(0);
    expect(shortfallLines(walked.events, ROME)).toEqual([
      { type: 'TreasuryShortfall', playerId: ROME, unpaid: 1 },
    ]);
    expect(disbandLines(walked.events, ROME)).toEqual([]);
    expect(upkeepLines(walked.events, ROME).at(0)?.maintenance).toBe(2);
    // The wonder is gone, which is what makes `mayStartBuilding` say yes again.
    expect(buildingHolder(walked.state, PYRAMIDS)).toBeUndefined();
  });
});

/* ---- 14. Resources ------------------------------------------------ */

const RESOURCE_CITY = asCityId(0); // Rome's city, road-connected to the iron
const RESOURCE_REMOTE = asCityId(1); // Rome's second city, no road anywhere near it
const RESOURCE_OTHER = asCityId(2); // Carthage's city, with iron on its own tile
const RESOURCE_WORKED = at(4, 5);
const RESOURCE_SHARED = at(6, 5); // wheat (bonus) and wines (luxury), same tile
const RESOURCE_IRON = at(5, 9); // hills, carrying iron and gems
const RESOURCE_ROAD_NEAR = at(5, 8); // the last roaded tile before the resource
const RESOURCE_ROAD_GAP = at(5, 7); // the middle tile the broken road omits
const RESOURCE_REMOTE_FARM = at(15, 16);
const RESOURCE_OTHER_TILE = at(20, 20);
const RESOURCE_OTHER_FARM = at(21, 20);

/**
 * The resource world, with one switch: whether the road from Rome's capital to the
 * iron is whole or broken **at its middle tile** (`(5, 7)`).
 *
 * What the world states, and why each piece is there:
 *
 * - a **hills tile at (5, 9) carrying iron AND gems**, four tiles south of Rome's
 *   capital. Iron is strategic (it gates the swordsman); gems is a luxury, inert
 *   until M9. Two resources on one tile is a world `gen.ts` would not place — and
 *   M4c's acceptance evidence asks for it, because `resources.ts` sums a tile's
 *   bonus deltas and must not assume the generator's at-most-one-per-tile rule;
 * - a **wheat (bonus, +1 food) and a wines (luxury) on the same worked tile**
 *   `(6, 5)`: the bonus delta is the only one of the four that touches the tile, so
 *   the city's food is 7 rather than 6 and the wines contribute nothing;
 * - the **road**: `connectRoad` writes the whole chain (5,5)..(5,8) when it is
 *   whole, and (5,5),(5,6) plus (5,8) alone when it is broken. The broken variant
 *   therefore has the resource tile's *neighbour* roaded and still connects
 *   nothing, which is what makes "a path from a city" the rule rather than "a road
 *   near the resource";
 * - the **resource tile itself carries no road** in either variant: endpoints are
 *   inclusive, so a chain that stops *next to* the iron connects it;
 * - a **second Roman city at (15, 15) with no roads and no nearby resources**, and
 *   **Carthage's city at (20, 20) standing on its own iron with no roads at all**.
 *   The first is the engine's per-*player* reading of connection ("a resource is
 *   connected for a player if SOME city of that player reaches it", `resources.ts`);
 *   the second is the city-centre-is-a-node half of "endpoints inclusive". Both are
 *   asserted, in both directions.
 */
const resourceSetup =
  (roadBroken: boolean) =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    const world = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(5, 9, 'hills')
      .setTile(20, 20, 'hills')
      .addResource(6, 5, WHEAT)
      .addResource(6, 5, WINES)
      .addResource(5, 9, GEMS)
      .addResource(5, 9, IRON)
      .addResource(20, 20, IRON)
      .addUnit(0, WARRIOR, [35, 35])
      .addUnit(1, WARRIOR, [36, 35])
      .addCity(0, [5, 5], {
        name: 'Roma',
        population: 2,
        foodBox: 0,
        shields: 4,
        workedTiles: [RESOURCE_WORKED, RESOURCE_SHARED],
      })
      .addCity(0, [15, 15], {
        name: 'Ostia',
        population: 1,
        foodBox: 0,
        workedTiles: [RESOURCE_REMOTE_FARM],
      })
      .addCity(1, [20, 20], {
        name: 'Carthago',
        population: 1,
        foodBox: 0,
        workedTiles: [RESOURCE_OTHER_FARM],
      });
    return roadBroken
      ? world.connectRoad([5, 5], [5, 6]).connectRoad([5, 8], [5, 8])
      : world.connectRoad([5, 5], [5, 8]);
  };

/**
 * RESOURCES, the positive half: a city road-connected to a strategic resource can
 * build the unit that requires it, and the two extra worlds the evidence names —
 * a resource on a city tile with no road at all, and two resources sharing a tile —
 * behave as the contract says.
 *
 * The script is the proof of legality: `SetProduction` on the swordsman is applied,
 * so the applier accepted it. Everything the assertion adds is the *reason* (the
 * connection walk's exact answer), the mirror (`planSetProduction` is also what the
 * option list is made of, so the swordsman is *offered*) and the three other worlds.
 */
const resourceConnectedScenario = defineScenario({
  name: 'road-connected-resource-allows-the-gated-unit',
  settings: DUEL_SETTINGS,
  setup: resourceSetup(false),
  run: [setProduction(0, unitItem(SWORDSMAN))],
  assert: (after, ruleset) => {
    const cityA = cityOf(after, RESOURCE_CITY);
    const otherRefusal = errorOf(
      applyCommand(after, CARTHAGE, setProduction(2, unitItem(SWORDSMAN)), ruleset),
    );
    const shared = after.map.resources.filter((entry) => entry.tile === RESOURCE_SHARED);
    const onIron = after.map.resources.filter((entry) => entry.tile === RESOURCE_IRON);
    const production = cityA.production;
    const gated =
      production?.kind === 'unit' && production.id === SWORDSMAN ? production : undefined;
    const yieldsA = cityYields(after, ruleset, RESOURCE_CITY);
    // A rendering of the probe for the message, computed once: reading `otherRefusal`
    // inside the message would be reading a variable the condition above has already
    // narrowed, which is a lint error and a worse message.
    const otherText =
      otherRefusal === undefined ? 'an accepted order' : JSON.stringify(otherRefusal);

    return [
      check(
        connectedIds(after, ruleset, ROME).join(',') === 'gems,iron,wheat,wines' &&
          isConnected(after, ruleset, ROME, IRON),
        'Rome is connected to exactly the four resources its network reaches — the road chain down ' +
          'to (5, 8) buys the iron and the gems, and the two on the worked tile next to the capital ' +
          'need no road at all — got ' +
          `[${connectedIds(after, ruleset, ROME).join(', ')}]`,
      ),
      check(
        gated !== undefined &&
          optionIds(after, ruleset, RESOURCE_CITY).includes(`unit:${SWORDSMAN}`),
        'the connected city may build the gated unit: the scripted `SetProduction(swordsman)` was ' +
          'applied (the applier accepted it, and the city is set to it), and the swordsman is in the ' +
          `city's production options — production is ${JSON.stringify(production)}`,
      ),
      check(
        optionIds(after, ruleset, RESOURCE_REMOTE).includes(`unit:${SWORDSMAN}`),
        'connection is the PLAYER\'s, as `resources.ts` states it ("some city of that player"): ' +
          "Rome's second city at (15, 15) has no road and no resource anywhere near it, and may " +
          'still build the swordsman because Rome has iron connected',
      ),
      check(
        connectedIds(after, ruleset, CARTHAGE).join(',') === 'iron' &&
          optionIds(after, ruleset, RESOURCE_OTHER).includes(`unit:${SWORDSMAN}`) &&
          otherRefusal === undefined,
        'a resource on the CITY TILE is connected with no road at all (endpoints inclusive, and a ' +
          "city centre is a node of the network): Carthage's city stands on its own iron, and may " +
          `build the swordsman — got [${connectedIds(after, ruleset, CARTHAGE).join(', ')}] and ` +
          otherText,
      ),
      check(
        shared.length === 2 &&
          shared[0]?.resource === WHEAT &&
          shared[1]?.resource === WINES &&
          onIron.length === 2 &&
          onIron[0]?.resource === GEMS &&
          onIron[1]?.resource === IRON,
        'two resources may share one tile, and the sparse list stays sorted by (tile, resource): ' +
          `(6, 5) carries [${shared.map((entry) => entry.resource).join(', ')}] and (5, 9) carries ` +
          `[${onIron.map((entry) => entry.resource).join(', ')}]`,
      ),
      check(
        hasImprovement(after, RESOURCE_ROAD_NEAR, ROAD) &&
          !hasImprovement(after, RESOURCE_IRON, ROAD),
        'the chain stops NEXT TO the iron: (5, 8) is roaded and the resource tile is not, which is ' +
          'what "endpoints inclusive" means on the resource end',
      ),
      check(
        yieldsA.food === 7 &&
          yieldsA.shields === 3 &&
          yieldsA.commerce === 3 &&
          yieldsA.foodSurplus === 3,
        "the tile's worth is terrain plus improvements plus BONUS resources: the wheat adds its " +
          '+1 food to (6, 5) (grassland 2/1/1 -> 3/1/1) and the wines on the same tile add nothing, ' +
          'since only a bonus row has a delta — got ' +
          `${String(yieldsA.food)} food, ${String(yieldsA.shields)} shields, ` +
          `${String(yieldsA.commerce)} commerce`,
      ),
    ];
  },
});

/**
 * RESOURCES, the negative half: with the road broken **at its middle tile** the same
 * order is refused with the typed error, and the mirror holds — the unit is no longer
 * *offered*, because the option list is made of the same `planSetProduction` verdicts.
 *
 * The run is empty on purpose: this scenario is about a refusal, and a refusal is
 * not a state transition, so the assertion probes the applier instead of scripting a
 * command the runner would refuse (a refused command in `run` fails the scenario for
 * a different reason — the script, not the rule).
 */
const resourceBrokenScenario = defineScenario({
  name: 'broken-road-refuses-the-gated-unit-with-resource-not-connected',
  settings: DUEL_SETTINGS,
  setup: resourceSetup(true),
  assert: (after, ruleset) => {
    const refusal = errorOf(
      applyCommand(after, ROME, setProduction(0, unitItem(SWORDSMAN)), ruleset),
    );
    const typed = refusal?.kind === 'resource-not-connected' ? refusal : undefined;
    const otherRefusal = errorOf(
      applyCommand(after, CARTHAGE, setProduction(2, unitItem(SWORDSMAN)), ruleset),
    );

    return [
      check(
        !isConnected(after, ruleset, ROME, IRON) &&
          connectedIds(after, ruleset, ROME).join(',') === 'wheat,wines',
        'the broken chain connects the iron to nothing: (5, 6) is roaded, the middle tile (5, 7) is ' +
          'not, and (5, 8) is roaded but unreachable — so the walk reaches only the two resources ' +
          `beside the capital, got [${connectedIds(after, ruleset, ROME).join(', ')}]`,
      ),
      check(
        hasImprovement(after, at(5, 6), ROAD) &&
          !hasImprovement(after, RESOURCE_ROAD_GAP, ROAD) &&
          hasImprovement(after, RESOURCE_ROAD_NEAR, ROAD),
        'the gap is the middle tile of the chain, and the far segment is roaded: (5, 6) roaded, ' +
          '(5, 7) not, (5, 8) roaded — a road near the iron is not a connection to it',
      ),
      check(
        typed !== undefined &&
          typed.cityId === RESOURCE_CITY &&
          typed.owner === ROME &&
          typed.resource === IRON &&
          typed.item.kind === 'unit' &&
          typed.item.id === SWORDSMAN,
        'the build is refused with the typed `resource-not-connected`, naming the city, the owner, ' +
          `the item and the resource — got ${JSON.stringify(refusal)}`,
      ),
      check(
        !optionIds(after, ruleset, RESOURCE_CITY).includes(`unit:${SWORDSMAN}`) &&
          optionIds(after, ruleset, RESOURCE_CITY).includes(`unit:${WARRIOR}`),
        'and the unit is not OFFERED either, because the option list is filtered through the same ' +
          "evaluator: the swordsman is gone from the city's options while the warrior (which " +
          'demands nothing) is still there',
      ),
      check(
        otherRefusal === undefined &&
          optionIds(after, ruleset, RESOURCE_OTHER).includes(`unit:${SWORDSMAN}`),
        "the refusal is about Rome's chain and not about the unit row: Carthage, whose own city " +
          'tile carries iron, still may build the swordsman',
      ),
    ];
  },
});

describe('M4c scenario: road-connected resources gate production', () => {
  it('lets the connected city build the swordsman and pins the shared-tile and city-tile worlds', () => {
    const result = runScenario(resourceConnectedScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const state = buildWorld(resourceSetup(false));
    // The map the setup really built: sparse, sorted pairs, two of them on one tile.
    expect(state.map.resources).toEqual([
      { tile: RESOURCE_SHARED, resource: WHEAT },
      { tile: RESOURCE_SHARED, resource: WINES },
      { tile: RESOURCE_IRON, resource: GEMS },
      { tile: RESOURCE_IRON, resource: IRON },
      { tile: RESOURCE_OTHER_TILE, resource: IRON },
    ]);
    // A map fact has to survive serialisation like every other map fact.
    const roundTripped: unknown = JSON.parse(JSON.stringify(state));
    expect(hashValue(roundTripped)).toBe(hashValue(state));
  });

  it('refuses it with resource-not-connected, changes nothing, and still offers everything else', () => {
    const result = runScenario(resourceBrokenScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    const state = buildWorld(resourceSetup(true));
    const attempt = applyCommand(state, ROME, setProduction(0, unitItem(SWORDSMAN)), RULESET);

    // A refusal is not a transition: the typed error, and no new state at all.
    expect(attempt.ok).toBe(false);
    expect(errorOf(attempt)).toEqual({
      kind: 'resource-not-connected',
      cityId: RESOURCE_CITY,
      owner: ROME,
      item: { kind: 'unit', id: SWORDSMAN },
      resource: IRON,
    });
    // Nothing about the world moved: the same hash before and after the attempt,
    // and the same hash as the scenario's final state.
    const finalState = result.finalState;
    if (finalState === undefined) throw new Error('the broken-road scenario must build a state');
    expect(hashValue(state)).toBe(hashValue(finalState));
    const roundTripped: unknown = JSON.parse(JSON.stringify(state));
    expect(hashValue(roundTripped)).toBe(hashValue(state));
  });
});

/* ---- 15. Maintenance ---------------------------------------------- */

const MAINTENANCE_CITY = asCityId(0);
const MAINTENANCE_HILLS = at(5, 6);

/**
 * The five buildings, in the order the scenario gives them to the city.
 *
 * The order is load-bearing: `addBuilding` appends, `production.ts` appends on
 * completion, and `disbandBuildings` reads the list **backwards** (most recently
 * completed first) — so "the last four of these five" is exactly "the four a
 * bankruptcy takes when 6 gold go unpaid". Their maintenance is 1, 1, 1, 1 and 3
 * (PLACEHOLDER, from the shipped rows).
 */
const MAINTENANCE_BUILDINGS: readonly BuildingId[] = [
  MARKETPLACE,
  LIBRARY,
  BARRACKS,
  WALLS,
  FACTORY,
];

/** What the city could not pay: 7 gold of maintenance against 1 gold of income. */
const MAINTENANCE_UNPAID = 6;

/**
 * The maintenance world, at a treasury the caller chooses.
 *
 * Rome's city works one hill from a grassland centre, so its output is 2 food (a
 * surplus of 0: the city never grows), 3 shields and **1 commerce**, which at the
 * default 6/4/0 is `floor(0.6) = 0` gold plus the leftover 1 — **1 gold a turn**.
 * Five buildings cost **7 gold a turn**. Rome's single worker is well inside the
 * `FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE = 6` free allowance, so there is no
 * unit to disband: the shortfall reaches `TreasuryShortfall`, and what pays is the
 * buildings themselves.
 */
const maintenanceSetup =
  (treasury: number) =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    let world = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(5, 6, 'hills')
      .setTreasury(0, treasury)
      .addUnit(0, WORKER, [35, 35])
      .addUnit(1, WARRIOR, [20, 20])
      .addCity(0, [5, 5], {
        name: 'Roma',
        population: 1,
        foodBox: 0,
        workedTiles: [MAINTENANCE_HILLS],
      });
    for (const id of MAINTENANCE_BUILDINGS) world = world.addBuilding(0, id);
    return world;
  };

/**
 * MAINTENANCE, and the debt M4b left open: its `TreasuryShortfall` branch was
 * unreachable from shipped content, because every shipped `maintenance` was zero
 * and only a hand-built ruleset could state one. This scenario runs through
 * `runScenario`, which validates `CATALOG` and nothing else — no test view, no
 * hand-written ruleset — and asserts that the shortfall is *reached*, that the gold
 * it reports is the arithmetic of the shipped rows, that the buildings which ran it
 * up are the ones taken, and that the treasury never goes negative.
 *
 * The test below adds the other half of the claim by pinning the provenance of the
 * five rows: every one of them is `placeholder(...)`, so the numbers are ours and
 * unsourced rather than borrowed from Civ 3.
 */
const maintenanceScenario = defineScenario({
  name: 'building-maintenance-outruns-income-and-drives-a-shortfall',
  settings: DUEL_SETTINGS,
  setup: maintenanceSetup(0),
  run: [endTurn()],
  assert: (after, ruleset) => {
    const catalog = buildingCatalog(ruleset);
    const city = cityOf(after, MAINTENANCE_CITY);
    const before = withBuildings(after, MAINTENANCE_CITY, MAINTENANCE_BUILDINGS);
    const owed = cityMaintenance(catalog, cityOf(before, MAINTENANCE_CITY));
    const income = playerIncome(after, ruleset, ROME);
    const support = unitSupport(after, ROME);
    const next = applyFor(after, ROME, endTurn(), ruleset);
    const rows = MAINTENANCE_BUILDINGS.map((id) => buildingRowOf(ruleset, id));
    const specs = CATALOG.buildings.filter((spec) => MAINTENANCE_BUILDINGS.includes(spec.id));

    return [
      check(
        owed === 7 && income.gold === 1 && owed - income.gold === MAINTENANCE_UNPAID,
        `the city's buildings cost ${String(owed)} gold a turn (1+1+1+1+3) against ` +
          `${String(income.gold)} gold of income (one commerce at 6/4/0), so ` +
          `${String(MAINTENANCE_UNPAID)} gold of the bill cannot be paid — and no unit can pay it ` +
          `either, because the whole army is inside the free allowance (${String(support.units)} ` +
          `unit(s), ${String(support.free)} free, ${String(support.gold)} owed)`,
      ),
      check(
        specs.length === 5 &&
          specs.every((spec) => spec.maintenance > 0) &&
          specs.every((spec) => isPlaceholder(spec.provenance)),
        'this shortfall comes from SHIPPED content and from nothing a test wrote: all five rows are ' +
          "`@civts/rules`' own, each declares a maintenance > 0, and each says outright that its " +
          'numbers are placeholders of ours (unsourced, chosen to be playable) — that is the M4b ' +
          'debt closed',
      ),
      check(
        city.buildings.length === 1 && city.buildings[0] === MARKETPLACE,
        'the buildings that ran it up paid: `disbandBuildings` took the four most recently completed ' +
          '— factory (3), walls (1), barracks (1), library (1) — until their 6 gold covered the 6 ' +
          'unpaid, leaving the marketplace it can afford; the city holds ' +
          `[${city.buildings.join(', ')}]`,
      ),
      check(
        moneyOf(after, ROME).treasury === 0,
        'the treasury floored at exactly 0: a shortfall is reported, never a negative balance and ' +
          `never an invented debt field — got ${String(moneyOf(after, ROME).treasury)}`,
      ),
      check(
        !next.events.some((event) => event.type === 'TreasuryShortfall') &&
          moneyOf(next.state, ROME).treasury === 0,
        'what the loss buys is the next turn: with only the marketplace left, 1 gold of income and ' +
          '1 gold of maintenance meet exactly, and no shortfall is reported again',
      ),
      check(
        rows.every((row) => maintenanceOf(row) > 0) && rows.every((row) => row.effects.length > 0),
        "and the rows the assertion above reads are the engine's own view of the catalog: every one " +
          'declares a maintenance and at least one effect, so no building here is a free shield sink',
      ),
    ];
  },
});

describe('M4c scenario: maintenance drives a real TreasuryShortfall from shipped content', () => {
  it('closes M4b’s debt: the shortfall is reachable with no hand-built ruleset at all', () => {
    const result = runScenario(maintenanceScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The fixture, and the three numbers that make it a shipped-content shortfall.
    const state = buildWorld(maintenanceSetup(0));
    const city = cityOf(state, MAINTENANCE_CITY);
    expect(city.buildings).toEqual([...MAINTENANCE_BUILDINGS]);
    expect(cityMaintenance(buildingCatalog(RULESET), city)).toBe(7);
    expect(playerIncome(state, RULESET, ROME).gold).toBe(1);

    // Every row involved is the shipped catalog's own, declares its own maintenance,
    // and says outright that the number is a placeholder of ours.
    expect(MAINTENANCE_BUILDINGS.map((id) => maintenanceOf(buildingRowOf(RULESET, id)))).toEqual([
      1, 1, 1, 1, 3,
    ]);
    const specs = CATALOG.buildings.filter((spec) => MAINTENANCE_BUILDINGS.includes(spec.id));
    expect(specs).toHaveLength(5);
    expect(specs.reduce((total, spec) => total + spec.maintenance, 0)).toBe(7);
    expect(specs.every((spec) => isPlaceholder(spec.provenance))).toBe(true);

    // And the same scenario against the same (shipped) catalog, explicitly — the
    // point being that `runScenario` never had a hand-built view to begin with.
    expect(runScenarioAgainst(maintenanceScenario, RULESET).passed).toBe(true);

    // The ledger, from the events alone: the shortfall is real, nothing was
    // disbanded, and the upkeep line names the 7 gold the rows declare.
    const walked = walk(state, [endTurn()]);
    expect(shortfallLines(walked.events, ROME)).toEqual([
      { type: 'TreasuryShortfall', playerId: ROME, unpaid: MAINTENANCE_UNPAID },
    ]);
    expect(disbandLines(walked.events, ROME)).toEqual([]);
    expect(upkeepLines(walked.events, ROME).at(0)).toEqual({
      type: 'UpkeepPaid',
      playerId: ROME,
      gold: 7,
      maintenance: 7,
      unitSupport: 0,
      units: 1,
      freeUnits: FREE_UNITS_PER_CITY * 1 + FREE_UNITS_BASE,
    });
    expect(cityOf(walked.state, MAINTENANCE_CITY).buildings).toEqual([MARKETPLACE]);
    expect(moneyOf(walked.state, ROME).treasury).toBe(0);
  });

  it('buys the next turn with the loss, and takes no unit instead of a building', () => {
    const state = buildWorld(maintenanceSetup(0));
    const first = walk(state, [endTurn()]);
    const second = walk(first.state, [endTurn()]);

    expect(shortfallLines(first.events, ROME)).toHaveLength(1);
    expect(shortfallLines(second.events, ROME)).toEqual([]);
    expect(disbandLines(second.events, ROME)).toEqual([]);
    expect(moneyOf(second.state, ROME).treasury).toBe(0);
    expect(cityOf(second.state, MAINTENANCE_CITY).buildings).toEqual([MARKETPLACE]);
    // The army is untouched: a building was taken, not a unit, because there was no
    // supported unit to take.
    expect(second.state.units.filter((unit) => unit.owner === ROME)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * The DSL's own M4c surface: `addResource`, `addBuilding`, `connectRoad`
 * ------------------------------------------------------------------ */

describe('the scenario builder states M4c worlds', () => {
  const withRome = (b: ScenarioBuilder): ScenarioBuilder =>
    b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, WORKER, [5, 5]) // Rome's start tile: where its first unit stands
      .addUnit(1, WARRIOR, [20, 20]);

  const build = (
    setup: (builder: ScenarioBuilder) => ScenarioBuilder,
    ruleset: RulesetView = RULESET,
  ) => setup(createScenarioBuilder(ruleset, DUEL_SETTINGS)).build();

  const builtState = (
    setup: (builder: ScenarioBuilder) => ScenarioBuilder,
    ruleset: RulesetView = RULESET,
  ): GameState => {
    const built = build(setup, ruleset);
    if (!built.ok) throw new Error(`the fixture must build: ${JSON.stringify(built.error)}`);
    return built.value;
  };

  it('places resources as sorted (tile, resource) pairs, and lets two share a tile', () => {
    const state = builtState((b) =>
      withRome(b)
        .setTile(4, 4, 'hills')
        // Asked out of order on purpose: the builder folds them, it does not keep
        // the order the calls came in, because `GameMap.resources` is a sorted list
        // and every state hash reads it as one.
        .addResource(6, 5, WINES)
        .addResource(6, 5, WHEAT)
        .addResource(4, 4, IRON)
        .addResource(4, 4, GEMS),
    );

    expect(state.map.resources).toEqual([
      { tile: at(4, 4), resource: GEMS },
      { tile: at(4, 4), resource: IRON },
      { tile: at(6, 5), resource: WHEAT },
      { tile: at(6, 5), resource: WINES },
    ]);
    // Two on one tile is a world `gen.ts` would not place and a hand-built map may
    // state (the module note says so): `resources.ts` sums a tile's deltas rather
    // than reading a single row, and M4c's acceptance evidence names this world.
    expect(state.map.resources.filter((entry) => entry.tile === at(4, 4))).toHaveLength(2);
    // And it survives the round trip every other map fact does.
    const roundTripped: unknown = JSON.parse(JSON.stringify(state));
    expect(hashValue(roundTripped)).toBe(hashValue(state));
  });

  it('refuses a resource it cannot place, and states the two generator rules it deliberately does not impose', () => {
    expect(() => build((b) => withRome(b).addResource(DUEL.width, 0, IRON))).toThrow(
      /outside this world's 40x40 map/,
    );
    expect(() => build((b) => withRome(b).addResource(6, 5, asResourceId('unobtainium')))).toThrow(
      /defines no resource "unobtainium"/,
    );
    expect(() =>
      build((b) => withRome(b).addResource(6, 5, WHEAT).addResource(6, 5, WHEAT)),
    ).toThrow(/called twice for one tile/);

    // The terrain under the tile, and the huts on it, are only final at build() —
    // the same split `addImprovement` uses.
    expect(() => build((b) => withRome(b).addResource(6, 5, IRON))).toThrow(
      /not in its allowedRoles \(hills, mountains\)/,
    );
    expect(() => build((b) => withRome(b).addHut(6, 5).addResource(6, 5, WHEAT))).toThrow(
      /goody hut/,
    );
    // A later setTile rescues an earlier addResource, exactly as it does for an
    // improvement: the check is at build().
    expect(build((b) => withRome(b).addResource(6, 5, IRON).setTile(6, 5, 'hills')).ok).toBe(true);

    // The two placement guarantees `gen.ts` gives that a *hand-built* world is
    // deliberately not bound by (the module note argues both):
    // 1. a resource on a player's own start tile — which is where `FoundCity`
    //    founds, and where M4c's evidence wants a resource;
    expect(build((b) => withRome(b).addResource(5, 5, WHEAT)).ok).toBe(true);
    // 2. two resources sharing a tile.
    expect(build((b) => withRome(b).addResource(9, 9, WHEAT).addResource(9, 9, WINES)).ok).toBe(
      true,
    );
  });

  it('gives a city a building in the order it is stated, and refuses what the engine refuses', () => {
    const state = builtState((b) =>
      withRome(b)
        .addCity(0, [10, 10], { name: 'Roma', population: 1 })
        .addBuilding(0, MARKETPLACE)
        .addBuilding(0, BARRACKS),
    );
    expect(cityOf(state, asCityId(0)).buildings).toEqual([MARKETPLACE, BARRACKS]);

    // The engine's own two refusals, raised where the author wrote the call.
    expect(() =>
      build((b) =>
        withRome(b)
          .addCity(0, [10, 10], { population: 1 })
          .addBuilding(0, MARKETPLACE)
          .addBuilding(0, MARKETPLACE),
      ),
    ).toThrow(/already holds it/);
    expect(() =>
      build((b) =>
        withRome(b)
          .addCity(0, [10, 10], { population: 1 })
          .addCity(1, [20, 20], { population: 1 })
          .addBuilding(0, PYRAMIDS)
          .addBuilding(1, PYRAMIDS),
      ),
    ).toThrow(/second copy of a wonder/);
    expect(() =>
      build((b) =>
        withRome(b).addCity(0, [10, 10], { population: 1 }).addBuilding(0, asBuildingId('nope')),
      ),
    ).toThrow(/defines no building "nope"/);
    expect(() => build((b) => withRome(b).addBuilding(0, MARKETPLACE))).toThrow(
      /needs the index of a city/,
    );

    // The control: two cities may hold the same *ordinary* building, and one may
    // hold a wonder — which is what makes the two refusals about the rules they
    // name and not about the call being impossible.
    const shared = builtState((b) =>
      withRome(b)
        .addCity(0, [10, 10], { population: 1 })
        .addCity(1, [20, 20], { population: 1 })
        .addBuilding(0, MARKETPLACE)
        .addBuilding(1, MARKETPLACE)
        .addBuilding(0, PYRAMIDS),
    );
    expect(cityOf(shared, asCityId(0)).buildings).toEqual([MARKETPLACE, PYRAMIDS]);
    expect(cityOf(shared, asCityId(1)).buildings).toEqual([MARKETPLACE]);
  });

  it('connects two tiles by road, reading the road KIND off the catalog rather than an id', () => {
    const straight = builtState((b) => withRome(b).connectRoad([5, 5], [8, 5]));
    expect(straight.improvements).toEqual([
      { tile: at(5, 5), kind: ROAD },
      { tile: at(6, 5), kind: ROAD },
      { tile: at(7, 5), kind: ROAD },
      { tile: at(8, 5), kind: ROAD },
    ]);

    // 8-way: a diagonal target is walked diagonally, which is what makes the chain
    // a path `resources.ts`' 8-way connection walk can cross.
    const diagonal = builtState((b) => withRome(b).connectRoad([5, 5], [7, 7]));
    expect(diagonal.improvements.map((entry) => Number(entry.tile))).toEqual(
      [at(5, 5), at(6, 6), at(7, 7)].map(Number),
    );

    // Overlapping segments: a road is a road, so a tile already carrying one is not
    // a second road (that refusal belongs to `addImprovement`, where writing one call
    // twice is the mistake being reported).
    const overlapping = builtState((b) =>
      withRome(b).connectRoad([5, 5], [8, 5]).connectRoad([7, 5], [9, 5]),
    );
    expect(overlapping.improvements.map((entry) => Number(entry.tile))).toEqual(
      [at(5, 5), at(6, 5), at(7, 5), at(8, 5), at(9, 5)].map(Number),
    );

    // The same world with the road row renamed: the connection layer reads the row's
    // *kind*, so nothing in the DSL depended on the shipped id.
    const renamedRoads: RulesetView = {
      ...RULESET,
      improvements: RULESET.improvements.map((def) =>
        def.kind === 'road' ? { ...def, id: asImprovementId('highway') } : def,
      ),
    };
    const renamed = builtState((b) => withRome(b).connectRoad([5, 5], [7, 5]), renamedRoads);
    expect(renamed.improvements).toEqual([
      { tile: at(5, 5), kind: asImprovementId('highway') },
      { tile: at(6, 5), kind: asImprovementId('highway') },
      { tile: at(7, 5), kind: asImprovementId('highway') },
    ]);

    // The refusals: off the map, no road row at all, and terrain the road may not
    // take (checked at build(), where the terrain under the path is final).
    expect(() => build((b) => withRome(b).connectRoad([5, 5], [DUEL.width, 5]))).toThrow(
      /outside this world's 40x40 map/,
    );
    const noRoads: RulesetView = {
      ...RULESET,
      improvements: RULESET.improvements.filter((def) => def.kind !== 'road'),
    };
    expect(() => build((b) => withRome(b).connectRoad([5, 5], [7, 5]), noRoads)).toThrow(
      /needs a road improvement/,
    );
    expect(() =>
      build((b) => withRome(b).setTile(6, 5, 'ocean').connectRoad([5, 5], [7, 5])),
    ).toThrow(/not in its allowedRoles/);
  });
});

/* ------------------------------------------------------------------ *
 * The M4c assertions discriminate
 * ------------------------------------------------------------------ */

describe('the M4c scenario assertions discriminate (they are not decoration)', () => {
  it('the compound-flooring assertion fails when the city holds only one 25% shield multiplier', () => {
    // The same world and the same assertions, minus the walls: the shield count at
    // the "two 25% multipliers" stage is then a single 25% (7 rather than 9), so the
    // sum-before-floor assertion has to notice.
    const variant: Scenario = {
      name: 'building-effects-without-the-walls',
      settings: DUEL_SETTINGS,
      setup: effectSetup,
      run: effectRun(EFFECT_COMPLETIONS.filter((id) => id !== WALLS)),
      assert: assertOf(buildingEffectsScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(
      /two 25% shield multipliers SUM before one floor/,
    );
  });

  it('the building-effect assertions fail when Rome splits its commerce at the default rates', () => {
    // 6/4/0 rather than 5/5/0: the same commerce splits into different channels, so
    // the library's 50% lands on 2 beakers rather than 3 and the exact numbers the
    // scenario pins must break. (The world, the buildings and the timeline are
    // otherwise identical, which is what makes the failure about the gold/beaker
    // assertions specifically.)
    const variant: Scenario = {
      name: 'building-effects-at-the-default-rates',
      settings: DUEL_SETTINGS,
      setup: (b) => effectSetup(b).setRates(0, DEFAULT_RATES),
      run: EFFECT_RUN,
      assert: assertOf(buildingEffectsScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(
      /after the library the beaker multiplier applies to this city.s own beaker/,
    );
    expect(text).toMatch(/after the marketplace the commerce multiplier applies to commerce alone/);
  });

  it('the granary assertions fail when the granary is taken away', () => {
    // The same world and the same assertions with the granary removed from Rome's
    // capital: the holder's reduced requirement of 9 is gone, so its box reaches 9 on
    // the third turn and does NOT grow — and it grows on the fourth turn instead,
    // carrying 2 over where the scenario pins 0. That one turn IS the effect, so the
    // assertions have to notice its absence.
    const variant: Scenario = {
      name: 'granary-growth-with-no-granary',
      settings: DUEL_SETTINGS,
      setup: granaryGrowthSetup(false),
      run: endTurns(3),
      assert: assertOf(granaryGrowthScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/stands in Rome's capital and in no other city/);
    expect(text).toMatch(/the granary city grew on the THIRD turn of the run/);
    // ...and the failure is about the holder, not about a world that never ran: the
    // control city's own assertions still hold, exactly as they do in the real one.
    expect(text).not.toMatch(/the city without a granary has NOT grown/);
  });

  it('the wonder-held assertions fail when nobody holds the wonder', () => {
    const variant: Scenario = {
      name: 'wonder-held-by-nobody',
      settings: DUEL_SETTINGS,
      setup: wonderSetup(EFFECT_TREASURY, false),
      assert: assertOf(wonderHeldScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    // Both halves have to break: the world is not the one the scenario describes,
    // and the other player *may* start the wonder.
    expect(text).toMatch(/holds the Pyramids/);
    expect(text).toMatch(/is offered by NO other city/);
  });

  it('the bankruptcy assertions fail when there was no wonder to take', () => {
    // No wonder, and a treasury of 0: Rome's 1 gold of income is unspent, so the
    // treasury ends at 1 rather than floored at 0 — which is exactly the statement
    // that the wonder's 2 gold of maintenance was what drove the shortfall.
    const variant: Scenario = {
      name: 'bankruptcy-with-no-wonder',
      settings: DUEL_SETTINGS,
      setup: wonderSetup(0, false),
      run: [endTurn()],
      assert: assertOf(wonderBankruptcyScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/the bill was 2 gold of maintenance against 1 gold of income/);
  });

  it('the connection assertions fail against the broken road, and the refusal assertions against the whole one', () => {
    const connected = runScenario({
      name: 'connection-assertions-against-a-broken-road',
      settings: DUEL_SETTINGS,
      setup: resourceSetup(true),
      run: [setProduction(0, unitItem(SWORDSMAN))],
      assert: assertOf(resourceConnectedScenario),
    });

    expect(connected.passed).toBe(false);
    const connectedText = failures(connected.assertions).join('\n');
    // The scripted order itself is refused — which is the negative half of the same
    // rule, reported by the runner rather than by the assertion.
    expect(connectedText).toMatch(/run\[0\].*was refused: resource-not-connected/);
    expect(connectedText).toMatch(/Rome is connected to exactly the four resources/);

    const broken = runScenario({
      name: 'refusal-assertions-against-a-whole-road',
      settings: DUEL_SETTINGS,
      setup: resourceSetup(false),
      assert: assertOf(resourceBrokenScenario),
    });

    expect(broken.passed).toBe(false);
    const brokenText = failures(broken.assertions).join('\n');
    expect(brokenText).toMatch(/the build is refused with the typed `resource-not-connected`/);
    expect(brokenText).toMatch(/the broken chain connects the iron to nothing/);
    // ...but the scenario's other half still holds, which is what makes the failure
    // about the connection rather than about a world that never ran: Carthage's own
    // city-tile iron is still buildable in both worlds.
    expect(brokenText).not.toMatch(/Carthage, whose own city tile carries iron/);
  });

  it('the maintenance assertions fail when the city can pay for its buildings', () => {
    // A treasury of 100: the same buildings, the same income, and no shortfall — so
    // nothing is disbanded and the exact list of survivors the scenario pins must
    // break. This is the assertion that would otherwise pass on a world where
    // maintenance was simply ignored.
    const variant: Scenario = {
      name: 'maintenance-with-a-solvent-treasury',
      settings: DUEL_SETTINGS,
      setup: maintenanceSetup(100),
      run: [endTurn()],
      assert: assertOf(maintenanceScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/the buildings that ran it up paid/);
    expect(text).toMatch(/the treasury floored at exactly 0/);
  });

  /* ------------------------------------------------------------------ *
   * 16. M5 — research timing, prerequisites, gating
   * ------------------------------------------------------------------ */

  /**
   * M5's acceptance evidence, in one place.
   *
   * The milestone's acceptance lines (docs/INTERFACES.md, "Acceptance evidence for M5")
   * are:
   *
   * 1. a research scenario with the exact turn a tech completes, the exact beaker
   *    remainder carried, and banked beakers when nothing is being researched;
   * 2. a prerequisite scenario: an unmet prerequisite refused, and a completed tech
   *    unlocking exactly what it should and nothing else;
   * 3. a gating scenario: a tech-gated unit/building/improvement refused with the typed
   *    error before the tech is known and accepted after;
   * 4. the balance sweep in `scripts/tech-balance-sweep.ts` (not this file).
   *
   * Every scenario below is paired with a falsification test that runs **its own
   * assertions** against a world where the rule is broken, because an assertion that
   * cannot fail is not evidence.
   *
   * ## The world, and why its numbers are what they are
   *
   * One Roman city at `(6, 5)` on a hand-built `duel` map, working exactly two tiles — a
   * grassland with a road and a hills with a road and a mine — and Carthage parked in a
   * corner with a single unit so the settings have the two civilizations they claim.
   *
   * ```
   *   centre  (6, 5) grassland          2 food  1 shield  1 commerce
   *   worked  (5, 6) grassland + road   2 food  1 shield  2 commerce
   *   worked  (6, 6) hills + road+mine  0 food  3 shield  1 commerce
   *   ---------------------------------------------------------------
   *   CITY                              4 food  5 shield  4 commerce
   * ```
   *
   * Two of those numbers carry the research arithmetic, so they are stated rather than
   * left to the reader:
   *
   * - **`foodSurplus` is exactly 0.** Two citizens eat 4 food and the city makes 4, so the
   *   city never grows and never starves. A city that grew would work another tile and its
   *   beaker rate would change mid-scenario, which would make "the remainder" a function
   *   of when the growth happened. `population === 2` is asserted, so that is a checked
   *   property rather than a hope.
   * - **The rates are 5/5/0**, so the 4 commerce splits into **2 gold and 2 beakers**
   *   (`splitCommerce`: neither floor bites at 4 commerce). Every beaker total below is
   *   therefore 2 per turn, banked at the end of each turn by the money loop and spent at
   *   the *start* of the next one by the research step — the pipeline-delay reading
   *   `tech.ts` argues out, and the reason `pottery` completes on turn 5 rather than 4.
   *
   * All of it is placeholder content from the shipped catalog; nothing here is a claim
   * about Civ 3.
   */
  const RESEARCH_CITY = asCityId(0);
  const RESEARCH_GRASS = at(5, 6);
  const RESEARCH_HILLS = at(6, 6);
  /** `(x, y)` pairs: the builder's unit and resource methods take coordinates, not indices. */
  const RESEARCH_FAR: readonly [number, number] = [30, 30];
  const RESEARCH_WORKER_TILE: readonly [number, number] = [7, 5];

  /**
   * A tech row's placeholder cost, or a loud failure. `noUncheckedIndexedAccess` is why this
   * exists rather than a `?.`: a scenario that named a tech the catalog does not define must
   * fail at the point it looked, not compare `undefined` to a number and pass.
   */
  const techCost = (ruleset: RulesetView, tech: TechId): number => {
    const row = techDef(ruleset, tech);
    if (row === undefined) throw new Error(`the catalog defines no tech "${String(tech)}"`);
    return row.cost;
  };

  /** The shipped techs these scenarios name, with their placeholder costs. */
  const POTTERY = asTechId('pottery'); // 5 beakers, a root
  const ALPHABET = asTechId('alphabet'); // 7 beakers, requires pottery
  const BRONZE_WORKING = asTechId('bronze-working'); // 6 beakers, a root
  const MASONRY = asTechId('masonry'); // 9 beakers, requires bronze-working
  const IRON_WORKING = asTechId('iron-working'); // 14 beakers, requires bronze + masonry
  const NOT_A_TECH = asTechId('mithril');

  /** 2 beakers a turn: 4 commerce split 5/5/0 by `splitCommerce`. */
  const BEAKERS_PER_TURN = 2;

  /**
   * The research world. `granted` comes first so a scenario can hand a player a tech it
   * never researched (that is what `grantTech` is for); `selected` is what it is working
   * on, and the builder checks it against the engine's own rule.
   */
  const researchSetup =
    (granted: readonly TechId[], selected?: TechId) =>
    (b: ScenarioBuilder): ScenarioBuilder => {
      const world = b
        .addPlayer('Rome')
        .addPlayer('Carthage')
        .fillTerrain('grassland')
        .setTile(6, 6, 'hills')
        .addImprovement(5, 6, asImprovementId('road'))
        .addImprovement(6, 6, asImprovementId('road'))
        .addImprovement(6, 6, asImprovementId('mine'))
        // Carthage's own unit, far away: a second civilization so the settings are
        // honest, and no interaction with Rome's research.
        .addUnit(0, WARRIOR, [6, 5])
        .addUnit(1, WARRIOR, [RESEARCH_FAR[0], RESEARCH_FAR[1]])
        .addUnit(0, asUnitTypeId('worker'), [RESEARCH_WORKER_TILE[0], RESEARCH_WORKER_TILE[1]])
        .setRates(0, { tax: 5, science: 5, luxury: 0 })
        .addCity(0, [6, 5], {
          name: 'Roma',
          population: 2,
          foodBox: 0,
          shields: 0,
          workedTiles: [RESEARCH_GRASS, RESEARCH_HILLS],
        });

      for (const tech of granted) world.grantTech(0, tech);
      return selected === undefined ? world : world.setResearching(0, selected);
    };

  /** The techs `playerId` knows in `state`, as comparable strings. */
  const techsIn = (state: GameState, playerId: PlayerId): readonly string[] => {
    const player = state.players.find((candidate) => candidate.id === playerId);
    return player === undefined ? [] : [...knownTechs(player)].map(String);
  };

  /** What `playerId` is researching, or `undefined` — read through `tech.ts`' reader. */
  const researchOf = (state: GameState, playerId: PlayerId): TechId | undefined => {
    const player = state.players.find((candidate) => candidate.id === playerId);
    return player === undefined ? undefined : researchingOf(player);
  };

  /** The beakers `playerId` has banked. */
  const beakersIn = (state: GameState, playerId: PlayerId): number => {
    const player = state.players.find((candidate) => candidate.id === playerId);
    return player === undefined ? 0 : player.beakers;
  };

  /** One `TechResearched` line, as the event carries it. */
  interface TechLine {
    readonly playerId: PlayerId;
    readonly tech: TechId;
    readonly cost: number;
    readonly beakers: number;
  }

  /** The `TechResearched` lines in `events`, in the order the pipeline emitted them. */
  const techLines = (events: readonly GameEvent[]): readonly TechLine[] =>
    events.flatMap((event) =>
      event.type === 'TechResearched'
        ? [
            {
              playerId: event.playerId,
              tech: event.tech,
              cost: event.cost,
              beakers: event.beakers,
            },
          ]
        : [],
    );

  /** How many citizens `playerId` has, summed over its cities. */
  const populationOf = (state: GameState, playerId: PlayerId): number =>
    state.cities
      .filter((city) => city.owner === playerId)
      .reduce((total, city) => total + city.population, 0);

  /** The states a scripted run passed through, rebuilt through the engine's own applier. */
  const replayFrom = (
    setup: (b: ScenarioBuilder) => ScenarioBuilder,
    ruleset: RulesetView,
    commands: readonly Command[],
    steps: number,
  ): GameState => replayEventsFrom(setup, ruleset, commands, steps).state;

  /**
   * The events a prefix of a scripted run produced, with the state that prefix ended in.
   *
   * Every command goes through `applyFor` — the engine's own applier, the same one a player
   * drives — so this is a replay of the run and not a second implementation of the pipeline.
   */
  const replayEventsFrom = (
    setup: (b: ScenarioBuilder) => ScenarioBuilder,
    ruleset: RulesetView,
    commands: readonly Command[],
    steps: number,
  ): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
    const built = setup(createScenarioBuilder(ruleset, DUEL_SETTINGS)).build();
    if (!built.ok) throw new Error(`the replay fixture must build: ${JSON.stringify(built.error)}`);

    let current = built.value;
    const events: GameEvent[] = [];
    for (const command of commands.slice(0, steps)) {
      const outcome = applyFor(current, ROME, command, ruleset);
      current = outcome.state;
      events.push(...outcome.events);
    }
    return { state: current, events };
  };

  /**
   * The timing run played with **research after the money loop** instead of before it — the
   * reading `turn.ts` and `tech.ts` explicitly reject.
   *
   * Every step is still the engine's own exported function (`applyGrowth`, `applyProduction`,
   * `applyEconomy`, `applyResearch`); only the order of the last two differs, so a difference
   * between the two runs is that order and nothing else. This exists for the falsification
   * test below and is used nowhere else: the real pipeline is `advanceTurn`, and no scenario
   * plays this one.
   */
  const replayWithResearchAfterTheMoneyLoop = (
    setup: (b: ScenarioBuilder) => ScenarioBuilder,
    ruleset: RulesetView,
    commands: readonly Command[],
  ): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
    const built = setup(createScenarioBuilder(ruleset, DUEL_SETTINGS)).build();
    if (!built.ok) {
      throw new Error(`the counterfactual fixture must build: ${JSON.stringify(built.error)}`);
    }

    let current = built.value;
    const events: GameEvent[] = [];
    for (const command of commands) {
      if (command.type !== 'EndTurn') {
        const outcome = applyFor(current, ROME, command, ruleset);
        current = outcome.state;
        events.push(...outcome.events);
        continue;
      }
      // The same six steps with steps 4 and 5 exchanged: production, then the money loop,
      // then research. (The movement refill is step 6 and is not exported; nothing in this
      // scenario moves a unit, so leaving it out changes no number under test.)
      const grown = applyGrowth(current, ruleset);
      const produced = applyProduction(grown.state, ruleset);
      const paid = applyEconomy(produced.state, ruleset);
      const researched = applyResearch(paid.state, ruleset);
      events.push(...grown.events, ...produced.events, ...paid.events, ...researched.events);
      current = { ...researched.state, turn: researched.state.turn + 1 };
    }
    return { state: current, events };
  };

  /* ---- 16a. Research timing and the beaker carry -------------------- */

  /** `SetResearch`, named the way `endTurn` and `setProduction` name their commands. */
  const setResearch = (tech: TechId): Command => ({ type: 'SetResearch', tech });

  /** The scripted run: 3 turns, a 4th, a selection, then 3 more. */
  const TIMING_RUN: readonly Command[] = [
    ...endTurns(3),
    endTurn(),
    setResearch(ALPHABET),
    ...endTurns(3),
  ];

  /**
   * Where a falsification test puts the world it wants a scenario's assertions to be run
   * against, and the only reason this exists.
   *
   * A scenario's `assert` callback receives the state and ruleset of its own run, which is
   * exactly right for acceptance evidence and exactly wrong for falsifying it: the
   * falsification needs the *same assertions* aimed at a broken world. Rather than write a
   * second copy of them (which would prove nothing about the first copy), the timing
   * scenario reads this when it is set. `undefined` in every real run, and nothing in the
   * engine knows it exists.
   */
  let timingCounterfactual:
    { readonly state: GameState; readonly events: readonly GameEvent[] } | undefined;

  /**
   * **The exact turn a tech completes, the exact remainder carried, and the pool after.**
   *
   * Rome starts researching `pottery` (5 beakers) with an empty pool and makes 2 beakers a
   * turn:
   *
   * | turn | pool at the start of the research step | what the step does |
   * |---|---|---|
   * | 1 | 0 | nothing banked yet — research runs *before* the money loop |
   * | 2 | 0 | accumulating, `needed: 5` |
   * | 3 | 2 | accumulating, `needed: 3` |
   * | 4 | 4 | accumulating, `needed: 1` |
   * | 5 | 6 | **completes**: pottery known, 5 charged, **1 carried** |
   *
   * The pool at the start of turn 5 is 6 rather than 5 because the money loop of turn 4
   * banked its 2 beakers *after* that turn's research step ran. The completion turn is
   * therefore a direct consequence of the frozen step order, which is what makes it
   * evidence: with the two steps exchanged, pottery completes on **turn 4** and the pool
   * runs one collection ahead forever after. The falsification test below measures that by
   * aiming these same assertions at that world.
   *
   * `alphabet` (7 beakers, requires pottery) is selected at turn 5, and the carried beaker
   * is part of the next tech's progress rather than being discarded: the pool goes 1 → 3 →
   * 5 → 7 → 9 and alphabet completes on **turn 8**, having charged 7. Nothing is lost and
   * nothing is created: 1 + 4 × 2 = 9, minus 7 = **2**, which is the pool at the end.
   *
   * Every number is read back out of the engine: the completion turns from `state.turn` and
   * each player's sorted `techs`, the charge and the remainder from the engine's own
   * `TechResearched` events (`cost`, `beakers`), and the beaker rate from the pools
   * themselves.
   */
  const researchTimingScenario = defineScenario({
    name: 'm5-research-timing-carries-the-remainder',
    settings: DUEL_SETTINGS,
    setup: researchSetup([], POTTERY),
    run: TIMING_RUN,
    assert: (after, ruleset) => {
      const counterfactual = timingCounterfactual;
      const world = (steps: number): GameState =>
        counterfactual?.state ?? replayFrom(researchSetup([], POTTERY), ruleset, TIMING_RUN, steps);
      const eventsAt = (steps: number): readonly GameEvent[] =>
        counterfactual?.events ??
        replayEventsFrom(researchSetup([], POTTERY), ruleset, TIMING_RUN, steps).events;

      const afterThree = world(3); // state turn 4: pool 6, pottery one beaker short
      const afterFour = world(4); // state turn 5: completion charged, 1 carried, 3 banked
      const afterEight = world(8); // state turn 8: alphabet charged, 2 banked after it
      const pottery = techLines(eventsAt(4)).find((line) => line.tech === POTTERY);
      const alphabet = techLines(eventsAt(8)).find((line) => line.tech === ALPHABET);

      return [
        check(
          counterfactual === undefined || after.turn === 8,
          `the run is 7 turns long, so it ends at turn 8 (got ${String(after.turn)})`,
        ),
        check(
          populationOf(after, ROME) === 2,
          'the city never grew and never starved, so every beaker total below is a multiple of ' +
            `the same 2-a-turn rate (population ${String(populationOf(after, ROME))})`,
        ),
        check(
          techsIn(afterThree, ROME).join(',') === '' && beakersIn(afterThree, ROME) === 6,
          'after 3 turns (state turn 4) pottery is NOT known: the pool is 6 against a cost of 5, ' +
            'and the research step has not run on it yet — the collection arrives after the ' +
            `step, which is why the 4th turn completes it and not the 3rd (got ` +
            `[${techsIn(afterThree, ROME).join(', ')}] with ` +
            `${String(beakersIn(afterThree, ROME))} beakers)`,
        ),
        check(
          techsIn(afterFour, ROME).join(',') === 'pottery',
          'and it IS known after the 4th turn (state turn 5) — the turn its pool first covers the ' +
            "price. This is the pipeline-delay reading: the 4th turn's collection arrives after " +
            `that turn's research step and cannot be spent until turn 5 (got ` +
            `[${techsIn(afterFour, ROME).join(', ')}])`,
        ),
        check(
          beakersIn(afterFour, ROME) === 3,
          "and exactly 1 beaker is carried past the completion — 6 banked minus pottery's 5 — and " +
            'the turn the completion happens on then banks its own 2, so the pool at the end of ' +
            `turn 5 is 3 (got ${String(beakersIn(afterFour, ROME))})`,
        ),
        check(
          pottery !== undefined &&
            pottery.playerId === ROME &&
            pottery.cost === 5 &&
            pottery.beakers === 1,
          "the engine's own account of that completion is TechResearched(Rome, pottery, cost 5, " +
            `beakers 1) — the remainder carried rather than discarded (got ${JSON.stringify(pottery)})`,
        ),
        check(
          researchOf(afterFour, ROME) === undefined,
          'and the completion clears the selection itself: the key is ABSENT, never present and ' +
            `undefined (got ${String(researchOf(afterFour, ROME))})`,
        ),
        check(
          researchOf(afterEight, ROME) === undefined,
          'the next tech selected after that is alphabet, and alphabet in turn completes on ' +
            "turn 8 — the run's last turn — so nothing is being researched at the end (got " +
            `${String(researchOf(afterEight, ROME))})`,
        ),
        check(
          techsIn(afterEight, ROME).join(',') === 'alphabet,pottery',
          "by turn 8 Rome knows alphabet and pottery, in the contract's sorted order (got " +
            `[${techsIn(afterEight, ROME).join(', ')}])`,
        ),
        check(
          beakersIn(afterEight, ROME) === 2,
          "and the pool is 2: 1 carried + 4 turns x 2 = 9, minus alphabet's 7 (got " +
            `${String(beakersIn(afterEight, ROME))})`,
        ),
        check(
          alphabet !== undefined && alphabet.cost === 7 && alphabet.beakers === 0,
          'alphabet charged its own 7 out of the 7 the pool held when its step ran, leaving 0 ' +
            "carried — and the 2 beakers in the pool at the end of the turn are that turn's own " +
            `collection, which the step could not spend (got ${JSON.stringify(alphabet)})`,
        ),
        check(
          techsIn(after, CARTHAGE).join(',') === '',
          'Carthage, which selected nothing, still knows nothing — the events are per player, and ' +
            `this run granted nobody anything (got [${techsIn(after, CARTHAGE).join(', ')}])`,
        ),
      ];
    },
  });

  /**
   * **Beakers are BANKED when nothing is being researched.**
   *
   * The same world with 3 beakers already banked and **no** selection: four turns of 2
   * beakers each must leave 11 — the whole 8 collected, on top of the 3 already there.
   * Nothing is spent, nothing is lost and no tech is granted. A pool that was drained or
   * reset while the player is not researching would be the quietest way for a beaker to
   * disappear, and that is the failure this scenario exists to catch.
   *
   * The pool must also still be *growing* rather than merely present: the `researchStep` the
   * pipeline itself computes is asked, and it must answer `nothing-being-researched` — so
   * "banked" is a property of the engine's step, not of a number a scenario happened to find.
   */
  const bankedBeakersScenario = defineScenario({
    name: 'm5-beakers-are-banked-when-nothing-is-researched',
    settings: DUEL_SETTINGS,
    setup: (b) => researchSetup([], undefined)(b).setPools(0, { beakers: 3 }),
    run: endTurns(4),
    assert: (after, ruleset) => {
      const { events } = replayEventsFrom(researchSetup([], undefined), ruleset, endTurns(4), 4);
      const step: ResearchStep = researchStep(after, ruleset, ROME);
      return [
        check(
          beakersIn(after, ROME) === BEAKERS_PER_TURN * 4 + 3,
          `3 banked + 4 turns x ${String(BEAKERS_PER_TURN)} = 11 beakers, all still banked (got ` +
            `${String(beakersIn(after, ROME))})`,
        ),
        check(
          techLines(events).length === 0,
          'and no tech was researched at all: the pool grew every turn and completed nothing (got ' +
            `${JSON.stringify(techLines(events))})`,
        ),
        check(
          step.kind === 'nothing-being-researched',
          "and the pipeline's own step answers nothing-being-researched for that player, which is " +
            `why the pool can only grow (got ${step.kind})`,
        ),
        check(
          techsIn(after, ROME).join(',') === '',
          `Rome knows nothing after banking 11 beakers (got [${techsIn(after, ROME).join(', ')}])`,
        ),
        check(
          researchOf(after, ROME) === undefined,
          'the selection is still absent, because a scenario that names none leaves the key off ' +
            `(got ${String(researchOf(after, ROME))})`,
        ),
        check(after.turn === 5, `the run really played 4 turns (got turn ${String(after.turn)})`),
      ];
    },
  });

  /* ---- 16b. Prerequisites ------------------------------------------- */

  /**
   * **An unmet prerequisite is refused, by name.**
   *
   * `alphabet` requires `pottery`, and this Rome knows nothing. `literature` is the
   * two-prerequisite case (`alphabet` **and** `ceremonial-burial`), so the refusal has to
   * report a list rather than one id — the shape a UI renders "requires …" from. Selecting a
   * tech the player already has, and one no catalog row defines, are the two other refusals
   * the same planner produces, and both are asserted so the three are visibly distinct
   * answers rather than one "refused".
   *
   * The planner and the applier are asked for the same command and must return the same
   * `kind`: "the generator and the applier must not disagree" is the standing requirement,
   * and the same planner is what the two of them are built from.
   */
  const prerequisiteRefusalScenario = defineScenario({
    name: 'm5-unmet-prerequisite-is-refused',
    settings: DUEL_SETTINGS,
    setup: researchSetup([], undefined),
    // Nothing scripted: every probe below applies a command the engine must refuse, and the
    // empty `run` is what keeps the world untouched while they do.
    run: [],
    assert: (after, ruleset) => {
      const alphabet = planSetResearch(after, ruleset, ROME, ALPHABET);
      const literature = planSetResearch(after, ruleset, ROME, asTechId('literature'));
      const applied = applyCommand(after, ROME, setResearch(ALPHABET), ruleset);
      const unknown = applyCommand(after, ROME, setResearch(NOT_A_TECH), ruleset);

      return [
        check(after.turn === 1, `the world never advanced (got turn ${String(after.turn)})`),
        check(
          !alphabet.ok && alphabet.error.kind === 'tech-prerequisites-unmet',
          'planSetResearch(alphabet) is refused, not accepted (got ' +
            `${alphabet.ok ? 'accepted' : alphabet.error.kind})`,
        ),
        check(
          !alphabet.ok &&
            alphabet.error.kind === 'tech-prerequisites-unmet' &&
            alphabet.error.missing.join(',') === 'pottery',
          'and the refusal names the ONE missing prerequisite: pottery (got ' +
            `${alphabet.ok ? 'accepted' : JSON.stringify(alphabet.error)})`,
        ),
        check(
          !literature.ok &&
            literature.error.kind === 'tech-prerequisites-unmet' &&
            literature.error.missing.join(',') === 'alphabet,ceremonial-burial',
          'literature — which requires alphabet AND ceremonial burial — lists both, in the ' +
            `contract's canonical order (got ` +
            `${literature.ok ? 'accepted' : JSON.stringify(literature.error)})`,
        ),
        check(
          !applied.ok &&
            !alphabet.ok &&
            applied.error.kind === 'tech-prerequisites-unmet' &&
            applied.error.kind === alphabet.error.kind,
          'and the APPLIER returns the same typed refusal for the same command, so the two cannot ' +
            `disagree about it (got ${applied.ok ? 'applied' : applied.error.kind})`,
        ),
        check(
          !unknown.ok && unknown.error.kind === 'unknown-tech',
          'a tech no catalog row defines is refused as unknown-tech — a different answer from a ' +
            `real tech whose prerequisites are unmet (got ` +
            `${unknown.ok ? 'applied' : unknown.error.kind})`,
        ),
        check(
          planSetResearch(after, ruleset, ROME, POTTERY).ok,
          'while a root tech with no prerequisites at all is NOT refused: the rule is about ' +
            'prerequisites rather than a refusal of everything',
        ),
      ];
    },
  });

  /**
   * **A completed tech unlocks exactly what it should, and nothing else.**
   *
   * `techUnlocks` is the engine's answer to "what does knowing this tech unlock", read off
   * the four catalogs a `requiresTech` may appear in. On the variant catalog
   * `bronze-working` unlocks precisely the `legion` and the `prospecting` row: the
   * `man-of-war` is gated on `iron-working` (and on a resource that is itself gated on
   * `iron-working`), the `observatory` on `pottery`, and the `saltpetre` resource on
   * `iron-working`. So the assertion is an **exact set**, in the kind vocabulary's order —
   * and "nothing else" is the half that catches a reader that matched the wrong field, or
   * one that reported every row of the catalog as unlocked.
   *
   * The second half asks the same question the other way round: a player granted
   * `bronze-working` must **not** be able to select `iron-working` (whose other
   * prerequisite, `masonry`, is missing) and must have no selection made for it, because
   * granting knowledge is not playing the game.
   */
  const unlockScenario = defineScenario({
    name: 'm5-a-completed-tech-unlocks-exactly-its-own-rows',
    settings: DUEL_SETTINGS,
    setup: researchSetup([BRONZE_WORKING], undefined),
    run: [],
    assert: (after, ruleset) => {
      const unlocked = techUnlocks(ruleset, BRONZE_WORKING);
      const keys = unlocked.map((row) => `${row.kind}:${row.id}`).join(',');
      const ironWorking = planSetResearch(after, ruleset, ROME, IRON_WORKING);

      return [
        check(
          keys === 'unit:legion,improvement:prospecting',
          'bronze-working unlocks exactly the legion and the prospecting row, in the kind ' +
            `vocabulary's order (got [${keys}])`,
        ),
        check(
          unlocked.length === 2,
          `and the set holds exactly two rows, counted rather than inferred (got ` +
            `${String(unlocked.length)})`,
        ),
        check(
          !unlocked.some((row) => row.id === LOCKED_RESOURCE),
          'and it does not unlock the saltpetre resource, whose own row is gated on iron working',
        ),
        check(
          !unlocked.some((row) => row.id === GATED_BUILDING),
          'nor the observatory, which is gated on pottery',
        ),
        check(
          !unlocked.some((row) => row.id === GATED_UNIT_WITH_RESOURCE),
          'nor the man-of-war, which is gated on iron working',
        ),
        check(
          techCost(ruleset, BRONZE_WORKING) === 6 &&
            prerequisitesOf(ruleset, IRON_WORKING).join(',') === 'bronze-working,masonry',
          'and the catalog the reader walked is the one under test: bronze-working costs 6 and ' +
            'iron-working requires bronze-working and masonry, in canonical order (got ' +
            `${String(techCost(ruleset, BRONZE_WORKING))} and ` +
            `[${prerequisitesOf(ruleset, IRON_WORKING).join(', ')}])`,
        ),
        check(
          !ironWorking.ok && ironWorking.error.kind === 'tech-prerequisites-unmet',
          'knowing bronze-working does not let Rome select iron-working, whose other prerequisite ' +
            '(masonry) is missing — a grant is knowledge, not a licence (got ' +
            `${ironWorking.ok ? 'accepted' : JSON.stringify(ironWorking.error)})`,
        ),
        check(
          researchOf(after, ROME) === undefined && after.turn === 1,
          'and granting knowledge selects nothing: the player is still researching nothing at ' +
            `turn 1 (got ${String(researchOf(after, ROME))} at turn ${String(after.turn)})`,
        ),
      ];
    },
  });

  /* ---- 16c. Gating -------------------------------------------------- */

  /** A gated improvement, unit, building and resource — the variant catalog's content. */
  const GATED_IMPROVEMENT = asImprovementId('prospecting');
  const GATED_UNIT = asUnitTypeId('legion');
  const GATED_BUILDING = asBuildingId('observatory');
  const GATED_UNIT_WITH_RESOURCE = asUnitTypeId('man-of-war');
  const GATED_UNIT_RESOURCE_ONLY = asUnitTypeId('sea-scout');
  const LOCKED_RESOURCE = asResourceId('saltpetre');

  /**
   * The `requiresTech`-bearing rows, written as they are and cast **once**, at the fixture
   * boundary.
   *
   * `requiresTech` is deliberately not declared on `UnitDef`/`BuildingDef`/
   * `ImprovementDef`/`ResourceDef`: `units.ts` states the decision in as many words — the
   * field's *shape* belongs to content, and the engine reads it **totally** from any row
   * (`tech.ts`' `requiresTechOf(row: unknown)`), so declaring it on the structural views
   * would state one field in four places. That leaves a test that wants a ruleset whose rows
   * declare one with no way to *type* it, because `UnitSpec extends UnitDef` and so cannot
   * carry a field its base does not have.
   *
   * The assertions below are the honest way out and they are confined to these five rows.
   * The rows are exactly the shape `techUnlocks` and `productionGate` read (`requiresTechOf`
   * checks `typeof field === 'string'`), and `validateRuleset` — which *does* know the field
   * and rejects an id no catalog row defines — runs over the result before any scenario sees
   * it, so a mistake here fails loudly at load rather than passing quietly.
   */
  const gatedRows = {
    unit: {
      id: GATED_UNIT,
      role: 'military',
      name: 'Legion',
      attack: 3,
      defense: 3,
      movement: 1,
      cost: 3,
      domain: 'land',
      requiresTech: BRONZE_WORKING,
      provenance: placeholder(
        'unsourced and chosen to be playable: a scenario fixture row, added so the engine has a unit that declares requiresTech',
      ),
    } as UnitSpec & { readonly requiresTech: TechId },
    unitResourceOnly: {
      id: GATED_UNIT_RESOURCE_ONLY,
      role: 'military',
      name: 'Sea Scout',
      attack: 1,
      defense: 2,
      movement: 2,
      cost: 3,
      domain: 'sea',
      requiresResource: LOCKED_RESOURCE,
      provenance: placeholder(
        "unsourced and chosen to be playable: a fixture row that declares requiresResource and NO requiresTech, so the resource row's own tech gate is the one the engine reaches",
      ),
    } as UnitSpec,
    unitWithResource: {
      id: GATED_UNIT_WITH_RESOURCE,
      role: 'military',
      name: 'Man-of-War',
      attack: 2,
      defense: 2,
      movement: 1,
      cost: 4,
      domain: 'sea',
      requiresResource: LOCKED_RESOURCE,
      requiresTech: IRON_WORKING,
      provenance: placeholder(
        'unsourced and chosen to be playable: a fixture row declaring both requiresTech and requiresResource, so the two gates can be shown to compose',
      ),
    } as UnitSpec & { readonly requiresTech: TechId },
    building: {
      id: GATED_BUILDING,
      name: 'Observatory',
      cost: 6,
      maintenance: 1,
      effects: [{ kind: 'beaker-multiplier', pct: 25 }],
      requiresTech: POTTERY,
      provenance: placeholder(
        'unsourced and chosen to be playable: a fixture row, added so the engine has a building that declares requiresTech',
      ),
    } as BuildingSpec & { readonly requiresTech: TechId },
    improvement: {
      id: GATED_IMPROVEMENT,
      kind: 'mine',
      name: 'Prospecting',
      turns: 2,
      yields: { food: 0, shields: 1, commerce: 0 },
      allowedRoles: ['grassland', 'plains', 'hills'],
      requiresTech: BRONZE_WORKING,
      provenance: placeholder(
        'unsourced and chosen to be playable: a fixture row, added so the engine has an improvement that declares requiresTech',
      ),
    } as ImprovementSpec & { readonly requiresTech: TechId },
    resource: {
      id: LOCKED_RESOURCE,
      name: 'Saltpetre',
      kind: 'strategic',
      yields: { food: 0, shields: 0, commerce: 0 },
      allowedRoles: ['grassland', 'plains', 'hills'],
      requiresTech: IRON_WORKING,
      provenance: placeholder(
        'unsourced and chosen to be playable: a fixture row whose own requiresTech locks it until iron working, so a unit needing it is gated twice over',
      ),
    } as ResourceSpec & { readonly requiresTech: TechId },
  } as const;

  /**
   * A variant of the shipped catalog with **one gated row of each kind**, which is what M5's
   * gating evidence needs and what the shipped catalog deliberately does not ship: no shipped
   * row declares `requiresTech` (`@civts/rules` says so in as many words), so the *rule* has
   * no content exercising it end to end.
   *
   * The variant is the shipped rows verbatim plus five additions, so a world built from it is
   * the shipped world in every other respect:
   *
   * | row | kind | what it demands |
   * |---|---|---|
   * | `observatory` | building | `pottery` |
   * | `legion` | unit | `bronze-working` |
   * | `prospecting` | improvement | `bronze-working` |
   * | `man-of-war` | unit | `iron-working` **and** the `saltpetre` resource |
   * | `saltpetre` | strategic resource | `iron-working`, so a unit needing it is gated twice |
   *
   * Every added magnitude is a **placeholder**: unsourced, chosen to be playable, and not
   * claimed to match Civ 3. `validateRuleset` runs over the result at the fidelity these
   * scenarios ask for, exactly as it does for the shipped catalog.
   */
  const GATED_CATALOG: Catalog = {
    ...CATALOG,
    units: [
      ...CATALOG.units,
      gatedRows.unit,
      gatedRows.unitWithResource,
      gatedRows.unitResourceOnly,
    ],
    buildings: [...CATALOG.buildings, gatedRows.building],
    improvements: [...CATALOG.improvements, gatedRows.improvement],
    resources: [...CATALOG.resources, gatedRows.resource],
  };

  /** Validate a variant catalog, or fail where it is written — the shipped catalog's gate. */
  const rulesetOf = (catalog: Catalog, what: string): RulesetView => {
    const validated = validateRuleset(catalog, 'tuned');
    if (!validated.ok) {
      throw new Error(
        `${what} must validate at fidelity "tuned": ${JSON.stringify(validated.error)}`,
      );
    }
    return validated.value;
  };

  /**
   * The variant above, validated once — the same gate the CLI and `runScenario` apply. This
   * view is what the gating scenarios run under, and `rulesetOf` is used again for each
   * stripped variant the falsification tests build.
   */
  const GATED_RULESET: RulesetView = rulesetOf(GATED_CATALOG, 'the gated fixture catalog');

  /**
   * One row with its `requiresTech` removed, for the falsification tests below.
   *
   * A copy with the key **deleted** rather than set to `undefined`: a present-and-undefined
   * key is not a state this engine represents (the same rule `PlayerState.researching`
   * follows), and `exactOptionalPropertyTypes` is what makes that a compile error rather
   * than a convention.
   */
  const withoutTechRequirement = <Row extends { readonly id: unknown }>(
    row: Row,
  ): Omit<Row, 'requiresTech'> => {
    const copy: Record<string, unknown> = { ...row };
    delete copy['requiresTech'];
    return copy as Omit<Row, 'requiresTech'>;
  };

  /**
   * The world the gating scenarios build: a city, a worker, and a locked resource the city is
   * **already road-connected to**.
   *
   * ```
   *   (6, 5)  tile 206  ROMA (city centre — always worked, always a path tile)
   *   (5, 6)  tile 245  grassland, worked
   *   (7, 6)  tile 246  hills, road + mine, worked, the worker stands here
   *   (8, 6)  tile 207  grassland, road, carries saltpetre
   * ```
   *
   * The road from the centre to `246` and on to `207` is the point: the resource is *reached*
   * by the connection walk (`reachableTiles` starts at the centre and walks 8-way over road
   * tiles), so the **only** thing that can keep it unconnected is its own row's `requiresTech`.
   * That is what makes the composed-gate scenario discriminating — a deposit nobody can reach
   * would be `blocked` for a reason that has nothing to do with the tech gate, and a
   * falsification test that removed the requirement would change nothing.
   */
  const GATING_CITY: readonly [number, number] = [6, 5];
  const GATING_RESOURCE: readonly [number, number] = [8, 6];
  const GATING_WORKER: readonly [number, number] = [7, 6];

  const gatingSetup =
    (granted: readonly TechId[]) =>
    (b: ScenarioBuilder): ScenarioBuilder => {
      const world = b
        .addPlayer('Rome')
        .addPlayer('Carthage')
        .fillTerrain('grassland')
        .setTile(GATING_WORKER[0], GATING_WORKER[1], 'hills')
        .addImprovement(GATING_WORKER[0], GATING_WORKER[1], asImprovementId('road'))
        .addImprovement(GATING_WORKER[0], GATING_WORKER[1], asImprovementId('mine'))
        .addImprovement(GATING_RESOURCE[0], GATING_RESOURCE[1], asImprovementId('road'))
        .addResource(GATING_RESOURCE[0], GATING_RESOURCE[1], LOCKED_RESOURCE)
        .addUnit(0, WARRIOR, [GATING_CITY[0], GATING_CITY[1]])
        .addUnit(1, WARRIOR, [RESEARCH_FAR[0], RESEARCH_FAR[1]])
        .addUnit(0, asUnitTypeId('worker'), [GATING_WORKER[0], GATING_WORKER[1]])
        .setRates(0, { tax: 5, science: 5, luxury: 0 })
        .addCity(0, [GATING_CITY[0], GATING_CITY[1]], {
          name: 'Roma',
          population: 2,
          foodBox: 0,
          shields: 0,
          workedTiles: [at(5, 6), at(GATING_WORKER[0], GATING_WORKER[1])],
        });

      for (const tech of granted) world.grantTech(0, tech);
      return world;
    };

  /**
   * Build the gating world with `granted` known — the "after" half of a before/after.
   *
   * It builds on `GATED_RULESET` when the caller passes the same view the scenarios run
   * under, and on the caller's view otherwise (a falsification test runs a scenario against
   * a stripped catalog, and the "after" worlds must be built from *that* catalog or the two
   * halves would not be comparable).
   */
  const buildGatedWorld = (granted: readonly TechId[], ruleset: RulesetView): GameState => {
    const built = gatingSetup(granted)(createScenarioBuilder(ruleset, DUEL_SETTINGS)).build();
    if (!built.ok) throw new Error(`the gated fixture must build: ${JSON.stringify(built.error)}`);
    return built.value;
  };

  /**
   * **The tech gate, in the generator and the applier, before and after.**
   *
   * The variant catalog's `observatory` (building) and `legion` (unit) declare
   * `requiresTech`. Before the tech is known:
   *
   * - `cityProductionOptions` — the **generator**, and the engine's answer to "what may this
   *   city be set to build" — must not offer either item;
   * - `productionGate` — the one verdict both askers read — must answer `tech-required` and
   *   **name the tech**;
   * - and `applyCommand`'s `SetProduction`, the **applier**, must refuse the same item with
   *   the matching typed error.
   *
   * After the tech is granted all three must flip: offered, `open`, and applied. "Before" and
   * "after" are one grant apart and nothing else, which is what makes a difference between
   * them the tech's.
   *
   * The applier half used to be written to the **correct** behaviour and to fail, because
   * `planSetProduction` (`commands.ts`) asked `resourceGate` alone and `GameError` had no
   * `tech-required` member: a tech-gated item was accepted and merely stalled at completion.
   * **M5's integration wave closed that gap** — the planner asks `productionGate` and refuses
   * with the typed `tech-required` naming the tech — so the assertion below now passes and is
   * asserted as a *pass*, in the same scenario, with no assertion changed in strength (the
   * applier must refuse the same item the menu omits, with the tech named).
   */
  const gatedItemScenario = defineScenario({
    name: 'm5-tech-gated-item-refused-then-accepted',
    settings: DUEL_SETTINGS,
    setup: gatingSetup([]),
    run: [],
    assert: (before, ruleset) => {
      const building = { kind: 'building', id: GATED_BUILDING } as const;
      const unit = { kind: 'unit', id: GATED_UNIT } as const;
      const optionsBefore = optionIds(before, ruleset, RESEARCH_CITY);
      const gateBefore = productionGate(before, ruleset, ROME, building);
      const gateUnitBefore = productionGate(before, ruleset, ROME, unit);

      const granted = buildGatedWorld([POTTERY, BRONZE_WORKING], ruleset);
      const appliedBefore = applyCommand(before, ROME, setProduction(0, building), ruleset);
      const appliedAfter = applyCommand(granted, ROME, setProduction(0, building), ruleset);

      return [
        check(
          !optionsBefore.includes('building:observatory') && !optionsBefore.includes('unit:legion'),
          "before the tech: the city's production menu offers neither the observatory nor the " +
            `legion (got [${optionsBefore.join(', ')}])`,
        ),
        check(
          gateBefore.kind === 'tech-required' && gateBefore.tech === POTTERY,
          "and the gate's verdict for the observatory is tech-required, NAMING pottery (got " +
            `${JSON.stringify(gateBefore)})`,
        ),
        check(
          gateUnitBefore.kind === 'tech-required' && gateUnitBefore.tech === BRONZE_WORKING,
          'and for the legion it names bronze-working rather than pottery — the verdict is read ' +
            `off the row the item names (got ${JSON.stringify(gateUnitBefore)})`,
        ),
        check(
          optionIds(granted, ruleset, RESEARCH_CITY).includes('building:observatory') &&
            optionIds(granted, ruleset, RESEARCH_CITY).includes('unit:legion'),
          'after granting pottery and bronze-working both are offered (got ' +
            `[${optionIds(granted, ruleset, RESEARCH_CITY).join(', ')}])`,
        ),
        check(
          productionGate(granted, ruleset, ROME, building).kind === 'open',
          'and the gate is open for the observatory (got ' +
            `${JSON.stringify(productionGate(granted, ruleset, ROME, building))})`,
        ),
        check(
          // No `as never` any more: the refusal is a real member of `GameError` now, so the
          // comparison is the compiler's business rather than an escape hatch. It names the
          // tech too, which is what makes the applier's answer the *same answer* the gate
          // gave three lines up rather than merely a refusal.
          !appliedBefore.ok &&
            appliedBefore.error.kind === 'tech-required' &&
            appliedBefore.error.tech === POTTERY,
          'before the tech the APPLIER refuses SetProduction(observatory) with the typed ' +
            'tech-required error, NAMING pottery — the same verdict `productionGate` gave, ' +
            'because `planSetProduction` asks that one verdict (got ' +
            `${appliedBefore.ok ? 'ACCEPTED' : JSON.stringify(appliedBefore.error)})`,
        ),
        check(
          appliedAfter.ok,
          'after the tech the same command is accepted (got ' +
            `${appliedAfter.ok ? 'applied' : appliedAfter.error.kind})`,
        ),
      ];
    },
  });

  /**
   * **The two gates COMPOSE.** An item that demands a tech *and* a resource must be refused
   * for the tech first, then for the resource — never "refused" for one reason while the
   * other is unchecked, and never accepted because one of the two happened to hold.
   *
   * `man-of-war` requires the `saltpetre` resource, and the **resource's own row** is gated
   * on `iron-working`; its own row is gated on `iron-working` too. That is what makes this
   * the composing case rather than a repetition of the scenario above:
   *
   * | state | `productionGate` | applier |
   * |---|---|---|
   * | knows nothing | `tech-required` (iron-working) | refused — the *same* typed verdict, tech named |
   * | knows the ancients, not iron-working | `tech-required` (iron-working), through the resource's own row | refused — the same verdict again |
   * | knows iron-working, deposit unconnected | `blocked` (saltpetre) | refused — `resource-not-connected`, a *different* reason |
   * | knows it, deposit in the radius | `open` | accepted |
   *
   * The third row proves composition: the tech gate is satisfied and the resource gate is
   * not, so the answer must name the **resource**. A gate that reported the tech
   * unconditionally would answer `tech-required` there too and be wrong; a gate that ignored
   * the resource row's own tech would answer `blocked` in the first row and be wrong the
   * other way. Both directions are asserted, and the resource's connection is read through
   * the engine's own rule rather than assumed from the map.
   *
   * The applier column used to read "refused — the resource is not connected" for the first
   * row, which was a *statement about the old wiring*: `planSetProduction` asked
   * `resourceGate` alone, so it named the resource while the gate named the tech, and the two
   * answers disagreed on the one case this scenario exists to compose. M5's integration wave
   * closed that, so the column now asserts the stronger fact: the applier's typed refusal is
   * the gate's own verdict, tech and all, in every row.
   */
  const composedGateScenario = defineScenario({
    name: 'm5-tech-and-resource-gates-compose',
    settings: DUEL_SETTINGS,
    setup: gatingSetup([]),
    run: [],
    assert: (before, ruleset) => {
      // The unit that declares **only** the resource: its own row has no `requiresTech`, so
      // everything the gate knows about a tech comes from the deposit's own row. That is the
      // branch `unmetItemTech`'s documentation calls out as "the case a reader is most likely to
      // miss", and it is the branch a composite unit — which declares its own tech — would hide,
      // because the item's own requirement is answered first and the resource is never consulted.
      const item = { kind: 'unit', id: GATED_UNIT_RESOURCE_ONLY } as const;

      // `iron-working` requires bronze-working AND masonry; knowing it is what makes the deposit
      // connectable, and knowing the deposit is connected is what makes the unit buildable.
      const ancients = buildGatedWorld([BRONZE_WORKING], ruleset);
      const unlocked = buildGatedWorld([BRONZE_WORKING, MASONRY, IRON_WORKING], ruleset);

      const gateNothing = productionGate(before, ruleset, ROME, item);
      const gateAncients = productionGate(ancients, ruleset, ROME, item);
      const gateUnlocked = productionGate(unlocked, ruleset, ROME, item);

      const appliedBefore = applyCommand(before, ROME, setProduction(0, item), ruleset);
      const appliedAfter = applyCommand(unlocked, ROME, setProduction(0, item), ruleset);
      const composite = { kind: 'unit', id: GATED_UNIT_WITH_RESOURCE } as const;
      const gateAncientsComposite = productionGate(ancients, ruleset, ROME, composite);

      return [
        check(
          gateNothing.kind === 'tech-required' && gateNothing.tech === IRON_WORKING,
          'with nothing known the gate names a TECH, and the tech it names is the one the ' +
            "*deposit's own row* demands — the unit itself declares none, so nothing but the " +
            `resource could have put it there (got ${JSON.stringify(gateNothing)})`,
        ),
        check(
          // The planner asks the *composite* gate, so its refusal is the gate's own verdict —
          // the tech, asked first, because it is the closer cause a player can act on. This is
          // the row-for-row agreement the composition property needs: not merely "the applier
          // refused", but "the applier refused with exactly what the gate said".
          !appliedBefore.ok &&
            appliedBefore.error.kind === 'tech-required' &&
            appliedBefore.error.tech === IRON_WORKING,
          'and the applier refuses it with the SAME verdict the gate gave — tech-required naming ' +
            "iron-working, the tech the deposit's own row demands, rather than the resource " +
            'the refusal would name once the tech is known (got ' +
            `${appliedBefore.ok ? 'ACCEPTED' : JSON.stringify(appliedBefore.error)})`,
        ),
        check(
          !optionIds(before, ruleset, RESEARCH_CITY).includes('unit:sea-scout'),
          'and the menu does not offer it, so the generator agrees with the gate',
        ),
        check(
          gateAncients.kind === 'tech-required' && gateAncients.tech === IRON_WORKING,
          'knowing bronze-working changes nothing: the deposit is still not connectable, so the ' +
            'resource is still not connected and the gate still names the tech that would ' +
            `connect it (got ${JSON.stringify(gateAncients)})`,
        ),
        check(
          !connectedIds(ancients, ruleset, ROME).includes(String(LOCKED_RESOURCE)),
          "and the deposit really is unconnected in that state, read through the engine's own " +
            `rule (connected was [${connectedIds(ancients, ruleset, ROME).join(', ')}])`,
        ),
        check(
          gateUnlocked.kind === 'open',
          'once iron-working is known the deposit becomes connectable, the road this world ' +
            'already had reaches it, and the verdict is open (got ' +
            `${JSON.stringify(gateUnlocked)})`,
        ),
        check(
          connectedIds(unlocked, ruleset, ROME).includes(String(LOCKED_RESOURCE)),
          'and the connection is real in that state rather than assumed (connected was ' +
            `[${connectedIds(unlocked, ruleset, ROME).join(', ')}])`,
        ),
        check(
          appliedAfter.ok,
          'so the applier accepts the same SetProduction it refused two states ago (got ' +
            `${appliedAfter.ok ? 'applied' : appliedAfter.error.kind})`,
        ),
        check(
          gateAncientsComposite.kind === 'tech-required' &&
            gateAncientsComposite.tech === IRON_WORKING,
          'and the COMPOSITE unit — which declares the resource *and* its own iron-working — is ' +
            'answering tech-required in that same state, while the resource-only unit would be ' +
            'answering it only because of the deposit. Both rows are read, and each is the ' +
            'closer cause of its own item, which is the composition this scenario is for (got ' +
            `${JSON.stringify(gateAncientsComposite)})`,
        ),
      ];
    },
  });

  /**
   * **A tech-gated improvement.** `StartWork` is the applier for improvements and
   * `planStartWork` is its one planner — the same evaluator `actions.ts` reads the menu from.
   *
   * The worker stands on an ordinary grassland tile and `prospecting` allows that role, so the
   * only thing that can refuse the job is the tech. `planStartWork` **now asks that gate** — M5's
   * integration wave closed the gap this comment used to name — so the scenario asserts the
   * whole property in one place: the gate's verdict names bronze-working, the planner refuses
   * with the matching typed error *naming the same tech*, and the applier accepts the job once
   * the tech is known. Behaviour that was three separate facts is now one property with a
   * before/after.
   */
  const gatedImprovementScenario = defineScenario({
    name: 'm5-tech-gated-improvement-refused-then-accepted',
    settings: DUEL_SETTINGS,
    setup: gatingSetup([]),
    run: [],
    assert: (before, ruleset) => {
      const worker = before.units.find((unit) => unit.type === asUnitTypeId('worker'));
      const row = improvementDef(ruleset, GATED_IMPROVEMENT);
      const missing = unmetTechFor(before, ROME, row);

      const granted = buildGatedWorld([BRONZE_WORKING], ruleset);
      const workOutcome = (() => {
        const unit = granted.units.find((candidate) => candidate.type === asUnitTypeId('worker'));
        if (unit === undefined) return undefined;
        const applied = applyCommand(
          granted,
          ROME,
          { type: 'StartWork', unitId: unit.id, kind: GATED_IMPROVEMENT },
          ruleset,
        );
        return applied.ok ? applied.value.state : undefined;
      })();

      // The planner's own answer, kept as the `Result` so the check below can assert *what* the
      // refusal names rather than only which member it is: "refused" and "refused for the right
      // reason, naming the tech" are different claims, and only the second one is the gate.
      const plannedBefore =
        worker === undefined
          ? undefined
          : planStartWork(before, ruleset, ROME, worker.id, GATED_IMPROVEMENT);
      const plannerBefore =
        plannedBefore === undefined
          ? 'no-worker'
          : plannedBefore.ok
            ? 'ACCEPTED'
            : plannedBefore.error.kind;
      const plannerNamesTech =
        plannedBefore !== undefined &&
        !plannedBefore.ok &&
        plannedBefore.error.kind === 'improvement-tech-required' &&
        plannedBefore.error.tech === BRONZE_WORKING;

      return [
        check(
          worker !== undefined,
          'the fixture really has a worker to give the job to — a world that forgot one would ' +
            'otherwise satisfy every assertion below for the wrong reason',
        ),
        check(
          missing === BRONZE_WORKING,
          "the gate's verdict for the improvement names bronze-working as the missing tech (got " +
            `${String(missing)})`,
        ),
        check(
          workOutcome !== undefined,
          'and once bronze-working is known the applier accepts StartWork and the job starts (got ' +
            `${workOutcome === undefined ? 'refused' : 'accepted'})`,
        ),
        check(
          workOutcome !== undefined &&
            workOutcome.units.some(
              (unit) => unit.work !== undefined && unit.work.kind === GATED_IMPROVEMENT,
            ),
          'and the accepted command really started work: the state records the job on the worker ' +
            `(got ${JSON.stringify(workOutcome?.units.map((unit) => unit.work))})`,
        ),
        check(
          // No `as never`: `improvement-tech-required` is a real member of `GameError`, so the
          // comparison is checked rather than cast.
          plannerBefore === 'improvement-tech-required' && plannerNamesTech,
          '`planStartWork` refuses the job with the typed improvement-tech-required error, NAMING ' +
            'bronze-working, before the tech is known — so a worker cannot start a job its owner ' +
            'could never finish, and the generator (`unitActions` filters through this same ' +
            `evaluator) does not offer it either (got ${plannerBefore})`,
        ),
      ];
    },
  });

  /* ---- 16d. The scenarios themselves -------------------------------- */

  /**
   * The five M5 scenarios, run. **All five pass**, and they are all asserted as passes: the
   * two that used to fail were failing *deliberately*, as the evidence for the wiring gap
   * `resources.ts` named — the applier accepted a tech-gated item the menu would not offer.
   * M5's integration wave closed the gap (the planner asks `productionGate`; `planStartWork`
   * asks `unmetTechFor`), so those assertions now hold and are asserted as properties of the
   * shipped engine rather than as evidence of a debt. Not one of them lost strength: each
   * still requires the typed refusal *and* the tech it names, which the old expectations did
   * not (they asserted only that the refusal was missing).
   */
  describe('the M5 scenarios', () => {
    it('research timing, the beaker carry and banked beakers all hold', () => {
      const timing = runScenario(researchTimingScenario);
      expect(failures(timing.assertions)).toEqual([]);
      expect(timing.passed).toBe(true);

      const banked = runScenario(bankedBeakersScenario);
      expect(failures(banked.assertions)).toEqual([]);
      expect(banked.passed).toBe(true);
    });

    it('an unmet prerequisite is refused, by name', () => {
      const result = runScenario(prerequisiteRefusalScenario);

      expect(failures(result.assertions)).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it('a completed tech unlocks exactly its own rows, run against the gated variant', () => {
      const result = runScenarioAgainst(unlockScenario, GATED_RULESET);

      expect(failures(result.assertions)).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it('the tech gate refuses in the generator AND the applier, and accepts both after', () => {
      const result = runScenarioAgainst(gatedItemScenario, GATED_RULESET);
      const text = failures(result.assertions).join('\n');

      // Every assertion holds, and the strongest of them is the applier one: the refusal is
      // the gate's own typed `tech-required`, naming the tech whose row gates the item. A
      // scenario that only checked "refused" would pass if the applier refused for the wrong
      // reason, which is exactly the disagreement this pair of gates exists to prevent.
      expect(text).not.toMatch(/the city's production menu offers neither/);
      expect(text).not.toMatch(/the gate's verdict for the observatory is tech-required/);
      expect(text).not.toMatch(/and for the legion it names bronze-working/);
      expect(text).not.toMatch(/and the gate is open for the observatory/);
      expect(text).not.toMatch(/before the tech the APPLIER refuses/);
      expect(text).not.toMatch(/after the tech the same command is accepted/);
      expect(failures(result.assertions)).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it('the two gates compose, and the resource row carries its own tech gate', () => {
      const result = runScenarioAgainst(composedGateScenario, GATED_RULESET);
      const text = failures(result.assertions).join('\n');

      // Three verdicts, one unit, three states of knowledge: the tech the deposit's row demands,
      // the same tech once the nearer cause has not changed, and finally open. Every one of them
      // is read off `productionGate`, which is the one implementation of the verdict.
      expect(text).not.toMatch(/with nothing known the gate names a TECH/);
      expect(text).not.toMatch(/knowing bronze-working changes nothing/);
      expect(text).not.toMatch(/once iron-working is known the deposit becomes connectable/);
      expect(text).not.toMatch(/and the COMPOSITE unit/);
      // Nothing here fails — including the applier, whose refusal is now asserted to *be* the
      // gate's verdict rather than merely a refusal. Every verdict this scenario pins holds
      // under the gated ruleset.
      expect(failures(result.assertions)).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it('the improvement gate refuses in the gate AND the planner, and accepts after', () => {
      const result = runScenarioAgainst(gatedImprovementScenario, GATED_RULESET);
      const text = failures(result.assertions).join('\n');

      expect(text).not.toMatch(/the fixture really has a worker/);
      expect(text).not.toMatch(/the gate's verdict for the improvement names bronze-working/);
      expect(text).not.toMatch(/`planStartWork` refuses the job/);
      expect(text).not.toMatch(/the applier accepts StartWork/);
      expect(failures(result.assertions)).toEqual([]);
      expect(result.passed).toBe(true);
    });
  });

  /* ---- 16e. The M5 assertions discriminate -------------------------- */

  describe('the M5 scenario assertions discriminate (they are not decoration)', () => {
    it('the timing assertions fail when research runs AFTER the money loop', () => {
      // The counterfactual `turn.ts` and `tech.ts` explicitly reject: steps 4 and 5 exchanged.
      // Every step is still the engine's own exported function, so the difference between the
      // two runs is the order and nothing else.
      const swapped = replayWithResearchAfterTheMoneyLoop(
        researchSetup([], POTTERY),
        RULESET,
        TIMING_RUN,
      );

      // First, that the counterfactual is the world we think it is: the same two techs, at the
      // same two completions. The *remainder* is what moves — pottery is charged before its
      // turn's collection lands in the swapped order, so 1 is carried rather than 3.
      expect(
        techLines(swapped.events).map((line) => `${String(line.tech)}:${String(line.beakers)}`),
      ).toEqual(['pottery:1', 'alphabet:0']);
      expect(swapped.state.turn).toBe(8);

      timingCounterfactual = swapped;
      let result;
      try {
        result = runScenario({
          name: 'm5-research-timing-with-research-run-after-the-split',
          settings: DUEL_SETTINGS,
          setup: researchSetup([], POTTERY),
          run: TIMING_RUN,
          assert: assertOf(researchTimingScenario),
        });
      } finally {
        timingCounterfactual = undefined;
      }

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      // The two assertions that agree with the real run still hold, because the completion
      // *turns* do not move between the two orders: the last turn's collection cannot change a
      // completion that already happened. That is exactly why the assertion that pins the
      // *remainder* is the one that has to catch this.
      expect(text).toMatch(/after 3 turns \(state turn 4\) pottery is NOT known/);
      expect(text).toMatch(/it IS known after the 4th turn/);
      // ...and what does catch it is the *remainder*: the swapped order let pottery spend the
      // collection it should not have seen, so the remainder it reports is the pool minus the
      // price rather than the pool minus the price plus that turn's collection. The end-of-run
      // pool is the same in both orders, which is worth knowing: an assertion about the final
      // pool alone would not have caught this, and the remainder is the number that shows the
      // order.
      expect(text).toMatch(/and exactly 1 beaker is carried past the completion/);
    });

    it('the banking assertions fail when an unresearched pool is spent or reset', () => {
      // A world whose beakers were drained while nothing was selected: the pool the scenario
      // pins (11) is gone, while the `nothing-being-researched` step still answers for the
      // player — so the failure is specifically about the pool surviving rather than about a
      // world that no longer exists.
      const variant: Scenario = {
        name: 'm5-bankers-whose-pool-was-drained',
        settings: DUEL_SETTINGS,
        setup: (b) => researchSetup([], undefined)(b).setPools(0, { beakers: 3 }),
        run: endTurns(4),
        assert: (after, ruleset) => {
          const drained: GameState = {
            ...after,
            players: after.players.map((player) =>
              player.id === ROME ? { ...player, beakers: 0 } : player,
            ),
          };
          return assertOf(bankedBeakersScenario)(drained, ruleset);
        },
      };

      const result = runScenario(variant);

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      expect(text).toMatch(/3 banked \+ 4 turns x 2 = 11 beakers, all still banked/);
      // The half that is *not* about the pool still holds, so the failure is about the number
      // rather than about an assertion that can never pass.
      expect(text).not.toMatch(/and no tech was researched at all/);
      expect(text).not.toMatch(/the pipeline's own step answers nothing-being-researched/);
    });

    it('the prerequisite assertions fail when the prerequisite is granted first', () => {
      // The same world with pottery already known: `alphabet` becomes selectable, so every
      // refusal the scenario pins must break — and the assertions are the *same* ones.
      const variant: Scenario = {
        name: 'm5-alphabet-with-its-prerequisite-known',
        settings: DUEL_SETTINGS,
        setup: researchSetup([POTTERY], undefined),
        run: [],
        assert: assertOf(prerequisiteRefusalScenario),
      };

      const result = runScenario(variant);

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      expect(text).toMatch(/planSetResearch\(alphabet\) is refused, not accepted/);
      expect(text).toMatch(/the refusal names the ONE missing prerequisite: pottery/);
      expect(text).toMatch(/and the APPLIER returns the same typed refusal/);
      // The two-prerequisite case is untouched by this variant: literature still needs both
      // rows, so its assertion must still hold. A variant that broke *everything* would be
      // evidence of nothing in particular.
      expect(text).not.toMatch(/literature — which requires alphabet AND ceremonial burial/);
    });

    it('the unlock assertions fail when a tech unlocks a row it should not', () => {
      // A catalog where the observatory is gated on bronze-working instead of pottery: the exact
      // set for bronze-working now holds three rows, so the "exactly two" assertions break while
      // every other assertion in the scenario still holds.
      const widened = rulesetOf(
        {
          ...GATED_CATALOG,
          buildings: GATED_CATALOG.buildings.map((row) =>
            row.id === GATED_BUILDING ? { ...row, requiresTech: BRONZE_WORKING } : row,
          ),
        },
        'the widened fixture catalog',
      );

      const result = runScenarioAgainst(unlockScenario, widened);

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      expect(text).toMatch(/bronze-working unlocks exactly the legion and the prospecting row/);
      expect(text).toMatch(/and the set holds exactly two rows, counted rather than inferred/);
      // The observatory really is unlocked now, so its own assertion fails too — while the grant
      // still selects nothing.
      expect(text).not.toMatch(/and granting knowledge selects nothing/);
    });

    it('the item-gate assertions fail when the item loses its tech requirement', () => {
      // An observatory with its `requiresTech` removed is offered from turn 1 and its gate is
      // never `tech-required`, so both "before" assertions must fail — which is what proves the
      // menu and the gate were consulting the requirement rather than merely agreeing with a
      // world where nothing is gated.
      const ungated = rulesetOf(
        {
          ...GATED_CATALOG,
          buildings: GATED_CATALOG.buildings.map((row) =>
            row.id === GATED_BUILDING ? withoutTechRequirement(row) : row,
          ),
        },
        'the ungated fixture catalog',
      );

      const result = runScenarioAgainst(gatedItemScenario, ungated);

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      expect(text).toMatch(
        /the city's production menu offers neither the observatory nor the legion/,
      );
      expect(text).toMatch(
        /the gate's verdict for the observatory is tech-required, NAMING pottery/,
      );
      // The "after" half still holds — an ungated item is *easier* to build — so the failure is
      // about the missing gate rather than about a world that could not be assembled.
      expect(text).not.toMatch(/after the tech the same command is accepted/);
    });

    it('the composition assertions fail when the resource row loses its own tech', () => {
      // `saltpetre` with its `requiresTech` removed: the item is then gated only by its own row,
      // so the "knowing the ancients is still not enough" assertion — the one that shows the
      // *resource's* row carrying a tech gate — must break while the rest still holds.
      const unlockedResource = rulesetOf(
        {
          ...GATED_CATALOG,
          resources: GATED_CATALOG.resources.map((row) =>
            row.id === LOCKED_RESOURCE ? withoutTechRequirement(row) : row,
          ),
        },
        'the ungated-resource fixture catalog',
      );

      // The world this variant makes, read directly first, so what follows is about a measured
      // difference rather than about which assertion happened to break. The unit declares only
      // the resource, so the tech gate it meets is the resource row's own: with the requirement
      // in place a player who knows bronze-working is refused for `iron-working`, and without it
      // the road already reaching the deposit is enough.
      const item = { kind: 'unit', id: GATED_UNIT_RESOURCE_ONLY } as const;
      const ungatedWorld = buildGatedWorld([BRONZE_WORKING], unlockedResource);
      const gatedWorld = buildGatedWorld([BRONZE_WORKING], GATED_RULESET);

      expect(connectedIds(gatedWorld, GATED_RULESET, ROME)).not.toContain(String(LOCKED_RESOURCE));
      expect(connectedIds(ungatedWorld, unlockedResource, ROME)).toContain(String(LOCKED_RESOURCE));
      expect(productionGate(gatedWorld, GATED_RULESET, ROME, item)).toEqual({
        kind: 'tech-required',
        tech: IRON_WORKING,
      });
      expect(productionGate(ungatedWorld, unlockedResource, ROME, item)).toEqual({ kind: 'open' });

      const result = runScenarioAgainst(composedGateScenario, unlockedResource);

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      // Every verdict the resource row's own tech was responsible for inverts: the gate sees
      // `open` where it named a tech, and both connection assertions see a deposit that is
      // reachable one tech too early. The applier's refusal is the one that follows, because the
      // command is now accepted.
      expect(text).toMatch(/with nothing known the gate names a TECH/);
      expect(text).toMatch(/knowing bronze-working changes nothing/);
      expect(text).toMatch(/and the deposit really is unconnected in that state/);
      // What still holds is the item's *own* branch, which this variant did not touch: the
      // composite unit is still refused for the tech it declares.
      expect(text).not.toMatch(
        /the COMPOSITE unit — which declares the resource \*and\* its own iron-working/,
      );
    });

    it('the improvement assertions fail when the improvement loses its tech requirement', () => {
      const ungated = rulesetOf(
        {
          ...GATED_CATALOG,
          improvements: GATED_CATALOG.improvements.map((row) =>
            row.id === GATED_IMPROVEMENT ? withoutTechRequirement(row) : row,
          ),
        },
        'the ungated-improvement fixture catalog',
      );

      const result = runScenarioAgainst(gatedImprovementScenario, ungated);

      expect(result.passed).toBe(false);
      const text = failures(result.assertions).join('\n');
      expect(text).toMatch(/the gate's verdict for the improvement names bronze-working/);
      // The accepted half is untouched: an ungated improvement is easier to start, so the
      // failure must be about the missing refusal and nothing else.
      expect(text).not.toMatch(/once bronze-working is known the applier accepts StartWork/);
      expect(text).not.toMatch(/the fixture really has a worker/);
    });
  });
});

/* ---- 17. M6: combat odds, capture, promotion and barbarians ------- */

/**
 * M6's acceptance evidence, under M2's discipline (restated because M6 is the
 * milestone where it matters most): a scenario builds a world by hand and *probes* it,
 * so an assertion is about the rule and not about what a generator happened to roll.
 *
 * The four scenarios, and what each one is the only evidence for:
 *
 * 1. `combat-odds-known-modifiers` — a battle's per-round chance is
 *    `floor(attack * 100 / (attack + defence))` over the defender's modifiers
 *    **summed and floored once**. One case per modifier in `defenderBonusPct`'s list
 *    (terrain, fortification, the city itself, walls), plus the case that exists only
 *    to separate compounding from flooring twice: a fortified spearman on grassland is
 *    `floor(3 * 1.35) = 4` defence, so a warrior attacks at 20% — and the
 *    floor-after-each-modifier reading reports `floor(floor(3 * 1.1) * 1.25) = 3` for
 *    25%. Same world, same units, eight points of odds apart, so no rounding accident
 *    can hide a regression.
 * 2. `capture-takes-half-and-spares-wonders` — a capture is not a battle: the city
 *    keeps its id, name and tile, its population is `max(1, floor(population / 2))`,
 *    its non-wonder buildings are destroyed in maintenance-descending order, its
 *    wonders survive, its queue and assignment are cleared and its stores are untouched.
 * 3. `a-win-promotes-one-level` — a won battle raises the winner by **exactly one**
 *    level up to `COMBAT_RULES.maxExperience`, announces it only when the level actually rose, and
 *    buys `floor(attack * (100 + 25 * level) / 100)` attack: a ladder whose rungs are
 *    visible as odds, and which stops mattering at the cap.
 * 4. `a-band-approaches-and-sacks` — the barbarian step is engine behaviour: a band
 *    walks a **route** (a ridge across its path makes it detour), one tile per turn at
 *    movement 1, taking the lowest tile index among the steps that close the distance,
 *    drawing **nothing** from the state's RNG on the way, and taking the undefended
 *    city it arrives beside — halved, as any capture is.
 *
 * Every assertion below is written as a **probe** — a command applied inside `assert`
 * to the state the scenario actually built — rather than as a scripted `run`. The
 * reason is the falsification test under each scenario: `assertOf` re-runs a scenario's
 * own assertions against a *variant world*, and a probe re-measures that world, so a
 * variant that breaks the rule really does break the assertions. A scripted `run` would
 * fix the commands at definition time and the variants would measure nothing.
 */

// `SETTLER`, `GRANARY`, `BARBARIANS`, `LIBRARY`, `WALLS` and `PYRAMIDS` are already
// defined above (they are M2's/M4c's fixtures), so M6 adds only what it needs.
const ARCHER = asUnitTypeId('archer');
const SPEARMAN = asUnitTypeId('spearman');
const TEMPLE = asBuildingId('temple');

/** Attack `(x, y)` with `unitId` (M6). */
const attack = (unitId: number, x: number, y: number): Command => ({
  type: 'AttackUnit',
  unitId: asUnitId(unitId),
  target: at(x, y),
});

/** Dig in (M6): an event of its own there is none, and the movement point is spent. */
const fortify = (unitId: number): Command => ({ type: 'FortifyUnit', unitId: asUnitId(unitId) });

/** The battles in an event list, in the order they were fought. */
const battles = (events: readonly GameEvent[]) =>
  events.filter((event) => event.type === 'CombatResolved');

/** The captures in an event list, in order. */
const captures = (events: readonly GameEvent[]) =>
  events.filter((event) => event.type === 'CityCaptured');

/** The promotions in an event list, in order. */
const promotions = (events: readonly GameEvent[]) =>
  events.filter((event) => event.type === 'UnitPromoted');

/** The steps one unit took, in order — the route it walked, as the events saw it. */
const stepsOf = (events: readonly GameEvent[], unitId: number) =>
  events
    .filter((event) => event.type === 'UnitMoved')
    .filter((event) => Number(event.unitId) === unitId);

/** `id` in `state`, or a loud failure (a scenario bug, not a rule to assert). */
const unitOf = (state: GameState, id: number): Unit => {
  const unit = unitById(state, asUnitId(id));
  if (unit === undefined) throw new Error(`unit ${String(id)} is not in the state`);
  return unit;
};

/** `building:temple, unit:warrior` — a production list a failure message can be read from. */
const describeItems = (items: readonly ProductionItem[]): string =>
  items.map((item) => `${item.kind}:${item.id}`).join(', ');

/** A tile as a coordinate pair, for reading and for `label`. */
const xyOf = (map: GameMap, tile: TileIndex): readonly [number, number] => [
  indexToX(map, tile),
  indexToY(map, tile),
];

/**
 * A probe: apply `command` as Rome to a state, and hand back the outcome, or
 * `undefined` when the applier refused it. It never throws, because a *refused*
 * command is one of the things an assertion here has to be able to report.
 */
const probe = (
  state: GameState,
  ruleset: RulesetView,
  command: Command,
): CommandOutcome | undefined => romeApply(state, ruleset, command);

/**
 * The wrong reading, computed here on purpose: floor after **each** modifier instead of
 * once after their sum. `combat.ts`' `defenderBonusPct` + `modifiedDefense` are the
 * right reading; this function exists so the assertion that pins the right one can name
 * the number the wrong one produces.
 */
const flooredAfterEach = (defense: number, bonuses: readonly number[]): number =>
  bonuses.reduce((value, pct) => Math.floor((value * (100 + pct)) / 100), defense);

/* ---- 17a. The odds, one case per modifier -------------------------- */

/**
 * One battle's inputs and the numbers the engine must produce from them, all stated by
 * hand: `bonusPct` is the **sum** the defender's list comes to, `defense` is that sum
 * floored once onto the defender's row, and `expectedPct` is the attacker's per-round
 * chance.
 */
interface OddsCase {
  readonly name: string;
  readonly attackerAt: readonly [number, number];
  readonly defenderAt: readonly [number, number];
  readonly defenderType: UnitTypeId;
  readonly fortified: boolean;
  readonly inCity: boolean;
  readonly tile: 'grassland' | 'hills' | 'mountains';
  readonly terrainBonusPct: number;
  readonly walls: boolean;
  readonly bonusPct: number;
  readonly defense: number;
  readonly expectedPct: number;
  /** What the floor-after-each-modifier reading gives — the wrong answer, stated. */
  readonly wrongDefense: number;
  readonly wrongPct: number;
}

/**
 * Every attacker is a warrior (attack 1), so the only column that varies is the
 * *defender's* — which is what makes the table evidence about the modifier list rather
 * than about the attack statistics.
 */
const ODDS_CASES: readonly OddsCase[] = [
  {
    name: 'a bare warrior on grassland',
    attackerAt: [5, 5],
    defenderAt: [6, 5],
    defenderType: WARRIOR,
    fortified: false,
    inCity: false,
    tile: 'grassland',
    terrainBonusPct: 10,
    walls: false,
    bonusPct: 10,
    defense: 2,
    expectedPct: 33,
    wrongDefense: 2,
    wrongPct: 33,
  },
  {
    name: 'a fortified spearman on grassland (compounding, not flooring twice)',
    attackerAt: [5, 10],
    defenderAt: [6, 10],
    defenderType: SPEARMAN,
    fortified: true,
    inCity: false,
    tile: 'grassland',
    terrainBonusPct: 10,
    walls: false,
    bonusPct: 35,
    defense: 4,
    expectedPct: 20,
    wrongDefense: 3,
    wrongPct: 25,
  },
  {
    name: 'a warrior behind walls in its own city on hills',
    attackerAt: [21, 20],
    defenderAt: [20, 20],
    defenderType: WARRIOR,
    fortified: false,
    inCity: true,
    tile: 'hills',
    terrainBonusPct: 50,
    walls: true,
    bonusPct: 150,
    defense: 5,
    expectedPct: 16,
    wrongDefense: 6,
    wrongPct: 14,
  },
  {
    name: 'a spearman standing on mountains',
    attackerAt: [5, 15],
    defenderAt: [6, 15],
    defenderType: SPEARMAN,
    fortified: false,
    inCity: false,
    tile: 'mountains',
    terrainBonusPct: 100,
    walls: false,
    bonusPct: 100,
    defense: 6,
    expectedPct: 14,
    wrongDefense: 6,
    wrongPct: 14,
  },
];

/** `at(...)` for a table row's coordinate pair. */
const tileAt = (pair: readonly [number, number]): TileIndex => at(pair[0], pair[1]);

/**
 * The odds world: two civilizations, four battle grounds far enough apart that no
 * attacker has two neighbours, and Carthage's city on the hills of case 3.
 *
 * Unit ids are dense in creation order, so row `i`'s attacker is `2 + 2 * i` and its
 * defender `3 + 2 * i` — and the assertions check that rather than assume it, because a
 * reordered setup would otherwise silently measure the wrong pair.
 */
const oddsSetup =
  (weakens: 'nothing' | 'no-fortify' | 'no-walls' | 'flat-mountains') =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    let builder = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SETTLER, [2, 2])
      .addUnit(1, SETTLER, [35, 35]);

    for (const row of ODDS_CASES) {
      const terrain = weakens === 'flat-mountains' ? 'grassland' : row.tile;
      builder = builder.setTile(row.defenderAt[0], row.defenderAt[1], terrain);
    }

    builder = builder.addCity(1, [20, 20], {
      name: 'Ostia',
      buildings: weakens === 'no-walls' ? [] : [WALLS],
    });

    for (const row of ODDS_CASES) {
      const fortified = row.fortified && weakens !== 'no-fortify';
      builder = builder
        .addUnit(0, WARRIOR, row.attackerAt)
        .addUnit(1, row.defenderType, row.defenderAt, fortified ? { fortified: true } : {});
    }
    return builder;
  };

const combatOddsScenario = defineScenario({
  name: 'combat-odds-known-modifiers',
  settings: DUEL_SETTINGS,
  setup: oddsSetup('nothing'),
  assert: (after, ruleset) => {
    const checks: ScenarioAssertion[] = [];

    // The table is evidence only if its rows disagree: four identical expectations
    // would be satisfied by any engine that reported one number four times.
    const distinct = new Set(ODDS_CASES.map((row) => row.expectedPct));
    checks.push(
      check(
        distinct.size >= 3,
        'the four cases expect at least three different chances, so the table cannot be ' +
          `satisfied by one number repeated: [${ODDS_CASES.map((row) => String(row.expectedPct)).join(', ')}]`,
      ),
    );

    // The tie rule, as a boundary: a round is the attacker's only while the draw is
    // BELOW the threshold, so the threshold itself belongs to the defender.
    checks.push(
      check(
        drawsWin(19, 20) && !drawsWin(20, 20),
        'the defender holds a round the attacker did not win: drawsWin(19, 20) is true ' +
          'and drawsWin(20, 20) is false',
      ),
    );

    for (const [index, row] of ODDS_CASES.entries()) {
      const attackerId = 2 + 2 * index;
      const defenderId = 3 + 2 * index;
      const attackValue = unitDef(ruleset, WARRIOR)?.attack ?? -1;
      const defenseValue = unitDef(ruleset, row.defenderType)?.defense ?? -1;

      const outcome = probe(after, ruleset, attack(attackerId, ...row.defenderAt));
      const event = outcome === undefined ? undefined : battles(outcome.events)[0];
      const attacker = unitById(after, asUnitId(attackerId));
      const defender = unitById(after, asUnitId(defenderId));

      // Read outside the condition chain: `isFortified` takes a unit, and the narrowing a
      // `defender?.owner === ...` test performs does not reach a later argument.
      const defenderFortified = defender === undefined ? false : isFortified(defender);
      checks.push(
        check(
          attacker?.owner === ROME &&
            attacker.type === WARRIOR &&
            Number(attacker.tile) === Number(tileAt(row.attackerAt)) &&
            defender?.owner === CARTHAGE &&
            defender.type === row.defenderType &&
            Number(defender.tile) === Number(tileAt(row.defenderAt)) &&
            defenderFortified === row.fortified,
          `${row.name}: warrior ${String(attackerId)} stands on ${label(...row.attackerAt)} ` +
            `and ${row.defenderType} ${String(defenderId)} on ${label(...row.defenderAt)}, ` +
            `fortified ${String(defenderFortified)}`,
        ),
      );

      checks.push(
        check(
          event !== undefined &&
            Number(event.attackerId) === attackerId &&
            Number(event.defenderId) === defenderId &&
            Number(event.target) === Number(tileAt(row.defenderAt)) &&
            event.defenderOwner === CARTHAGE,
          `${row.name}: the battle is fought over ${label(...row.defenderAt)} and names both ` +
            `units (got ${
              event === undefined
                ? 'no battle at all'
                : `attacker ${String(event.attackerId)} vs defender ${String(event.defenderId)} on tile ${String(event.target)}`
            })`,
        ),
      );

      // The modifier list, as the engine sums it...
      const summed = defenderBonusPct(COMBAT_RULES, {
        terrainBonusPct: row.terrainBonusPct,
        fortified: row.fortified,
        inCity: row.inCity,
        walls: row.walls,
      });
      checks.push(
        check(
          summed === row.bonusPct,
          `${row.name}: the defender's modifiers SUM to ${String(row.bonusPct)}% (terrain ` +
            `${String(row.terrainBonusPct)} + fortify ${String(row.fortified ? 25 : 0)} + city ` +
            `${String(row.inCity ? 50 : 0)} + walls ${String(row.walls ? 50 : 0)}), got ` +
            `${String(summed)}%`,
        ),
      );

      // ...floored ONCE onto the defender's own defence...
      const modified = modifiedDefense(defenseValue, summed);
      checks.push(
        check(
          modified === row.defense,
          `${row.name}: ${String(defenseValue)} defence at ${String(summed)}% is floor(` +
            `${String(defenseValue)} * ${String(100 + summed)} / 100) = ${String(row.defense)}, ` +
            `got ${String(modified)}`,
        ),
      );

      // ...and the chance that follows from it.
      checks.push(
        check(
          winPct(COMBAT_RULES, attackValue, modified) === row.expectedPct,
          `${row.name}: attack ${String(attackValue)} against defence ${String(modified)} is ` +
            `floor(${String(attackValue)} * 100 / ${String(attackValue + modified)}) = ` +
            `${String(row.expectedPct)}%`,
        ),
      );

      // The number the engine actually reported, which is what the table is for.
      checks.push(
        check(
          event?.attackerWinPct === row.expectedPct,
          `${row.name}: the battle reports a ${String(row.expectedPct)}% chance per round, got ` +
            (event === undefined ? 'no battle' : `${String(event.attackerWinPct)}%`),
        ),
      );

      // The discriminator, named: the floor-after-each-modifier reading of the SAME
      // inputs, and the odds it would produce. Every row but the fortified
      // spearman agrees under both readings — which is exactly why that row exists.
      const bonuses = [
        row.terrainBonusPct,
        ...(row.fortified ? [25] : []),
        ...(row.inCity ? [50] : []),
        ...(row.inCity && row.walls ? [50] : []),
      ];
      const wrongDefense = flooredAfterEach(defenseValue, bonuses);
      const wrongPct = winPct(COMBAT_RULES, attackValue, wrongDefense);
      const separates = wrongPct !== row.expectedPct;
      checks.push(
        check(
          wrongDefense === row.wrongDefense && wrongPct === row.wrongPct,
          `${row.name}: flooring after EACH modifier would give defence ` +
            `${String(row.wrongDefense)} and ${String(row.wrongPct)}%, got ` +
            `${String(wrongDefense)} and ${String(wrongPct)}%`,
        ),
      );
      checks.push(
        check(
          separates === (row.wrongPct !== row.expectedPct),
          separates
            ? `${row.name}: this row SEPARATES compounding from flooring twice: the wrong ` +
                `reading gives ${String(wrongPct)}% where the engine gives ` +
                `${String(row.expectedPct)}%`
            : `${row.name}: with one modifier the two readings agree (both ` +
                `${String(wrongPct)}%), so this row cannot separate them`,
        ),
      );
    }

    return checks;
  },
});

describe('M6 scenario: combat odds for the known modifiers', () => {
  it('fights the four battles and reports the table it claims', () => {
    const result = runScenario(combatOddsScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The same four battles again, read off the engine's own events, so the numbers the
    // reply quotes are visible here and not only inside the scenario's assertions.
    const world = buildWorld(oddsSetup('nothing'));
    const fought = ODDS_CASES.map((row, index) =>
      probe(world, RULESET, attack(2 + 2 * index, ...row.defenderAt)),
    ).map((outcome) => battles(outcome?.events ?? [])[0]);

    expect(fought.map((event) => event?.attackerWinPct)).toEqual([33, 20, 16, 14]);
    expect(fought.map((event) => Number(event?.defenderId))).toEqual([3, 5, 7, 9]);
    // ...and the odds decide the battles: the attacker takes the two it was favoured in
    // (33% and 20%) and loses the two it was not. 3 hit points a side and one point a
    // round, so the winner of a round costs its opponent a point: the attacker's two
    // wins run 5 rounds (it lost 2 points on the way) and its two losses run 3 (it lost
    // three, which is all it had).
    expect(fought.map((event) => event?.outcome)).toEqual([
      'attacker-wins',
      'attacker-wins',
      'defender-wins',
      'defender-wins',
    ]);
    expect(fought.map((event) => event?.rounds)).toEqual([5, 5, 3, 3]);
    expect(fought.map((event) => event?.attackerLost)).toEqual([2, 2, 3, 3]);
    expect(fought.map((event) => event?.defenderLost)).toEqual([3, 3, 0, 0]);
  });

  it('fortifying spends the movement, and buys what the arithmetic says', () => {
    const world = buildWorld(oddsSetup('nothing'));

    expect(isFortified(unitOf(world, 2))).toBe(false);
    const dug = probe(world, RULESET, fortify(2));

    // Digging in is a state change with no announcement, and it costs the turn.
    expect(dug?.events).toEqual([]);
    expect(dug === undefined ? undefined : isFortified(unitOf(dug.state, 2))).toBe(true);
    expect(dug === undefined ? undefined : unitOf(dug.state, 2).movementLeft).toBe(0);
    // ...so a second fortify has nothing left to spend, and is refused for that reason.
    expect(
      dug === undefined ? undefined : refusal(applyCommand(dug.state, ROME, fortify(2), RULESET)),
    ).toMatchObject({ kind: 'not-enough-movement', unitId: asUnitId(2) });

    // A unit that dug in cannot attack either: an attack costs the rest of the turn,
    // and the turn is what fortifying spent.
    expect(
      dug === undefined
        ? undefined
        : refusal(applyCommand(dug.state, ROME, attack(2, 6, 5), RULESET)),
    ).toMatchObject({ kind: 'not-enough-movement', unitId: asUnitId(2) });

    // The bonus belongs to the DEFENDING side, so it is measured by digging Carthage's
    // warrior in and attacking it with Rome's. A warrior's 2 defence at 35% is
    // floor(2 * 1.35) = 2, so the odds do not move — the +25% is real and it floors away
    // — while a spearman's floor(3 * 1.35) = 4 against floor(3 * 1.1) = 3 is where the
    // same fortification is worth five points of chance (the discriminator row above).
    const entrenched = applyCommand(world, CARTHAGE, fortify(3), RULESET);
    expect(entrenched.ok).toBe(true);
    const battle = battles(
      probe(entrenched.ok ? entrenched.value.state : world, RULESET, attack(2, 6, 5))?.events ?? [],
    )[0];
    expect(battle?.attackerWinPct).toBe(33);
    expect(modifiedDefense(3, 10)).toBe(3);
    expect(modifiedDefense(3, 35)).toBe(4);
    expect(winPct(COMBAT_RULES, 1, modifiedDefense(3, 10))).toBe(25);
    expect(winPct(COMBAT_RULES, 1, modifiedDefense(3, 35))).toBe(20);
  });

  it('the odds assertions fail when the defender is not fortified', () => {
    const variant: Scenario = {
      name: 'combat-odds-with-no-fortification',
      settings: DUEL_SETTINGS,
      setup: oddsSetup('no-fortify'),
      assert: assertOf(combatOddsScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/a fortified spearman on grassland/);
    // ...and the failure is about that row: the bare warrior's case still holds, which
    // is what makes it a failure of the compound case and not of the whole table.
    expect(text).not.toMatch(/a bare warrior on grassland/);
  });

  it('the odds assertions fail when the city has no walls', () => {
    const variant: Scenario = {
      name: 'combat-odds-with-no-walls',
      settings: DUEL_SETTINGS,
      setup: oddsSetup('no-walls'),
      assert: assertOf(combatOddsScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/behind walls in its own city/);
  });

  it('the odds assertions fail when the mountains are plain grassland', () => {
    const variant: Scenario = {
      name: 'combat-odds-with-no-mountains',
      settings: DUEL_SETTINGS,
      setup: oddsSetup('flat-mountains'),
      assert: assertOf(combatOddsScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/standing on mountains/);
  });
});

/* ---- 17b. A capture halves the city and spares its wonders --------- */

const CAPTURE_CITY = asCityId(0);
const CAPTURE_TILE: readonly [number, number] = [20, 20];
const CAPTURE_ATTACKER: readonly [number, number] = [21, 20];
const CAPTURE_POPULATION = 4;
const CAPTURE_FOOD_BOX = 5;
const CAPTURE_SHIELDS = 3;

/**
 * The capture world: Carthage's city `Ostia` on grassland with four citizens, a
 * granary, walls and the Pyramids, a queued and an in-progress item, food and shields
 * in store — and one Roman warrior beside it, with nothing inside to defend it.
 *
 * The two weakenings exist for the falsification tests: `no-wonder` takes the Pyramids
 * out (so "the wonder survived" has nothing to be true about), and `defended` puts a
 * Carthage warrior inside, which turns the attack into a *battle* and the capture into
 * an event that never happens.
 */
const captureSetup =
  (weakens: 'nothing' | 'no-wonder' | 'defended') =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    let builder = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SETTLER, [2, 2])
      .addUnit(1, SETTLER, [35, 35])
      .addCity(1, CAPTURE_TILE, {
        name: 'Ostia',
        population: CAPTURE_POPULATION,
        foodBox: CAPTURE_FOOD_BOX,
        shields: CAPTURE_SHIELDS,
        production: { kind: 'building', id: TEMPLE },
        queue: [{ kind: 'building', id: LIBRARY }],
        buildings: [GRANARY, WALLS, ...(weakens === 'no-wonder' ? [] : [PYRAMIDS])],
      })
      .addUnit(0, WARRIOR, CAPTURE_ATTACKER);

    if (weakens === 'defended') builder = builder.addUnit(1, WARRIOR, CAPTURE_TILE);
    return builder;
  };

const captureScenario = defineScenario({
  name: 'capture-takes-half-and-spares-wonders',
  settings: DUEL_SETTINGS,
  setup: captureSetup('nothing'),
  assert: (after, ruleset) => {
    const before = cityOf(after, CAPTURE_CITY);
    const outcome = probe(after, ruleset, attack(2, ...CAPTURE_TILE));
    const event = outcome === undefined ? undefined : captures(outcome.events)[0];
    const next = outcome?.state;
    const city = next === undefined ? undefined : cityById(next, CAPTURE_CITY);

    return [
      // The rule, and both ends of it: half, floored, and never below one.
      check(
        capturedPopulation(CAPTURE_RULES, 4) === 2 &&
          capturedPopulation(CAPTURE_RULES, 1) === 1 &&
          capturedPopulation(CAPTURE_RULES, 0) === 1,
        'a capture halves the population and floors it, but never empties the city: ' +
          `capturedPopulation(4) = ${String(capturedPopulation(CAPTURE_RULES, 4))}, ` +
          `capturedPopulation(1) = ${String(capturedPopulation(CAPTURE_RULES, 1))}, ` +
          `capturedPopulation(0) = ${String(capturedPopulation(CAPTURE_RULES, 0))}`,
      ),
      check(
        before.population === CAPTURE_POPULATION &&
          before.buildings.includes(PYRAMIDS) &&
          before.buildings.includes(WALLS) &&
          before.buildings.includes(GRANARY) &&
          before.foodBox === CAPTURE_FOOD_BOX &&
          before.shields === CAPTURE_SHIELDS,
        `the world really holds a ${String(CAPTURE_POPULATION)}-citizen city with a granary, ` +
          `walls, the Pyramids, ${String(CAPTURE_FOOD_BOX)} food and ${String(CAPTURE_SHIELDS)} ` +
          `shields — got population ${String(before.population)}, buildings ` +
          `[${before.buildings.join(', ')}], box ${String(before.foodBox)}, shields ` +
          String(before.shields),
      ),
      // An undefended city is taken, not fought over.
      check(
        outcome !== undefined && battles(outcome.events).length === 0,
        'a capture is not a battle and reports none: taking an undefended city emits ' +
          'CityCaptured and no CombatResolved at all',
      ),
      check(
        event !== undefined &&
          Number(event.cityId) === Number(CAPTURE_CITY) &&
          event.from === CARTHAGE &&
          event.to === ROME &&
          event.name === 'Ostia' &&
          Number(event.tile) === Number(tileAt(CAPTURE_TILE)) &&
          event.population === 2,
        'the capture names Ostia, its tile and both owners, and reports the halved ' +
          `population 4 -> 2 (got ${
            event === undefined
              ? 'no CityCaptured at all'
              : `${event.name} ${String(event.population)} ${String(event.from)} -> ${String(event.to)}`
          })`,
      ),
      // The exact destruction list, in order, and the wonder absent from it.
      check(
        event !== undefined &&
          event.destroyed.length === 2 &&
          event.destroyed[0] === WALLS &&
          event.destroyed[1] === GRANARY,
        'the sack destroys the non-wonder buildings in maintenance-descending order — walls ' +
          `(1) then granary (0) — and reports exactly those two, got ` +
          `[${event === undefined ? '' : event.destroyed.join(', ')}]`,
      ),
      check(
        city !== undefined &&
          city.buildings.length === 1 &&
          city.buildings[0] === PYRAMIDS &&
          !city.buildings.includes(GRANARY) &&
          !city.buildings.includes(WALLS),
        'the Pyramids survive a sack (a wonder is never destroyed, because destroying one ' +
          `would silently make it buildable again): the city holds ` +
          `[${city === undefined ? '' : city.buildings.join(', ')}]`,
      ),
      // The city keeps its identity and changes hands.
      check(
        city !== undefined &&
          city.owner === ROME &&
          city.name === 'Ostia' &&
          Number(city.tile) === Number(tileAt(CAPTURE_TILE)) &&
          Number(city.id) === Number(CAPTURE_CITY) &&
          city.population === 2,
        `the captured city is the same city: id ${String(city?.id)}, name "${String(city?.name)}", ` +
          `tile ${String(city?.tile)}, owner ${String(city?.owner)}, population ` +
          String(city?.population),
      ),
      // What the sack clears, and what it does not touch.
      check(
        city !== undefined &&
          city.queue.length === 0 &&
          city.workedTiles.length === 0 &&
          city.production === undefined,
        'a captured city has no queue, no assignment and nothing in production (found: ' +
          `queue [${city === undefined ? '' : describeItems(city.queue)}], ` +
          `${String(city?.workedTiles.length)} worked tiles, production ` +
          `${city?.production?.kind ?? 'none'})`,
      ),
      check(
        city !== undefined && city.foodBox === CAPTURE_FOOD_BOX && city.shields === CAPTURE_SHIELDS,
        'the sack does not touch the stores it found: the box is still ' +
          `${String(CAPTURE_FOOD_BOX)} and the shield pool still ${String(CAPTURE_SHIELDS)} ` +
          `(got ${String(city?.foodBox)} and ${String(city?.shields)})`,
      ),
      // The attacker paid for the attack with its movement, and did not move.
      check(
        next !== undefined &&
          Number(unitOf(next, 2).tile) === Number(tileAt(CAPTURE_ATTACKER)) &&
          unitOf(next, 2).movementLeft === 0,
        'taking a city is an action, not a move: the attacker is still on ' +
          `${label(...CAPTURE_ATTACKER)} with no movement left (tile ` +
          `${next === undefined ? 'n/a' : String(unitOf(next, 2).tile)}, movement ` +
          `${next === undefined ? 'n/a' : String(unitOf(next, 2).movementLeft)})`,
      ),
    ];
  },
});

describe('M6 scenario: a capture halves the city and spares its wonders', () => {
  it('takes Ostia, and the surviving city is the one the assertions describe', () => {
    const result = runScenario(captureScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The capture again, from the events, so the exact population and the exact
    // destruction order are visible here as well as inside the assertions.
    const world = buildWorld(captureSetup('nothing'));
    const outcome = probe(world, RULESET, attack(2, ...CAPTURE_TILE));
    const event = captures(outcome?.events ?? [])[0];

    expect(event?.population).toBe(2);
    expect(event?.destroyed).toEqual([WALLS, GRANARY]);
    expect(event?.destroyed).not.toContain(PYRAMIDS);
    expect(cityById(outcome?.state ?? world, CAPTURE_CITY)?.buildings).toEqual([PYRAMIDS]);
  });

  it('the capture assertions fail when the city holds no wonder', () => {
    const variant: Scenario = {
      name: 'capture-with-no-wonder-to-spare',
      settings: DUEL_SETTINGS,
      setup: captureSetup('no-wonder'),
      assert: assertOf(captureScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/the Pyramids survive a sack/);
  });

  it('the capture assertions fail when the city is defended', () => {
    const variant: Scenario = {
      name: 'capture-of-a-defended-city',
      settings: DUEL_SETTINGS,
      setup: captureSetup('defended'),
      assert: assertOf(captureScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    expect(text).toMatch(/no CityCaptured at all/);
    expect(text).toMatch(/a capture is not a battle and reports none/);
  });
});

/* ---- 17c. A won battle promotes its winner by one level ------------ */

interface PromoCase {
  readonly level: number;
  readonly attackerAt: readonly [number, number];
  readonly defenderAt: readonly [number, number];
  readonly expectedAttack: number;
  readonly expectedPct: number;
}

/**
 * The ladder, hand-computed from `veteranAttack` and `winPct`: an archer (attack 3)
 * against a warrior on grassland, whose defence is `floor(2 * 1.1) = 2` at every level
 * (the *defender* brings no experience bonus, so the rungs are the attacker's alone).
 *
 * - level 0: `floor(3 * 1.00) = 3` -> `floor(300 / 5) = 60%`
 * - level 1: `floor(3 * 1.25) = 3` -> `60%` — the first promotion buys **nothing** at
 *   attack 3, which is a fact about the shipped numbers and worth pinning
 * - level 2: `floor(3 * 1.50) = 4` -> `floor(400 / 6) = 66%`
 * - level 3: `floor(3 * 1.75) = 5` -> `floor(500 / 7) = 71%`, and there is no fourth:
 *   `COMBAT_RULES.maxExperience` is the cap
 */
const PROMO_CASES: readonly PromoCase[] = [
  { level: 0, attackerAt: [5, 5], defenderAt: [6, 5], expectedAttack: 3, expectedPct: 60 },
  { level: 1, attackerAt: [5, 10], defenderAt: [6, 10], expectedAttack: 3, expectedPct: 60 },
  { level: 2, attackerAt: [5, 15], defenderAt: [6, 15], expectedAttack: 4, expectedPct: 66 },
  { level: 3, attackerAt: [5, 20], defenderAt: [6, 20], expectedAttack: 5, expectedPct: 71 },
];

/**
 * The promotion world: four Roman archers, one per experience level, each beside its own
 * Carthage warrior, so the four battles are independent and the ladder is read off four
 * separate draws. `clamp-all` is the weakening: every archer starts at the cap, so no
 * battle can promote anybody and the ladder's expectations have to notice.
 */
const promotionSetup =
  (weakens: 'nothing' | 'clamp-all') =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    let builder = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SETTLER, [2, 2])
      .addUnit(1, SETTLER, [35, 35]);

    for (const row of PROMO_CASES) {
      builder = builder
        .addUnit(0, ARCHER, row.attackerAt, {
          experience: weakens === 'clamp-all' ? COMBAT_RULES.maxExperience : row.level,
        })
        .addUnit(1, WARRIOR, row.defenderAt);
    }
    return builder;
  };

const promotionScenario = defineScenario({
  name: 'a-win-promotes-one-level',
  settings: DUEL_SETTINGS,
  setup: promotionSetup('nothing'),
  assert: (after, ruleset) => {
    const checks: ScenarioAssertion[] = [];
    const defenderDefense = modifiedDefense(
      unitDef(ruleset, WARRIOR)?.defense ?? -1,
      defenderBonusPct(COMBAT_RULES, {
        terrainBonusPct: 10,
        fortified: false,
        inCity: false,
        walls: false,
      }),
    );

    checks.push(
      check(
        COMBAT_RULES.maxExperience === PROMO_CASES.length - 1 && defenderDefense === 2,
        `the ladder is measured against ${String(COMBAT_RULES.maxExperience)} levels of promotion and a ` +
          `grassland warrior's ${String(defenderDefense)} defence, which the attacker's levels ` +
          'do not move (the bonus is the ATTACKER’s)',
      ),
    );

    let promotionsSeen = 0;
    for (const row of PROMO_CASES) {
      // The units interleave: row `level` adds archer `2 + 2 * level` and then its own
      // defender `3 + 2 * level`, so the archer is NOT `2 + level`.
      const unitId = 2 + 2 * row.level;
      const outcome = probe(after, ruleset, attack(unitId, ...row.defenderAt));
      const event = outcome === undefined ? undefined : battles(outcome.events)[0];
      const next = outcome?.state;
      const promoted = outcome === undefined ? [] : promotions(outcome.events);
      const survivor = next === undefined ? undefined : unitById(next, asUnitId(unitId));
      const capped = row.level === COMBAT_RULES.maxExperience;
      promotionsSeen += promoted.length;

      // The bonus, as arithmetic.
      checks.push(
        check(
          veteranAttack(COMBAT_RULES, 3, row.level) === row.expectedAttack &&
            winPct(COMBAT_RULES, row.expectedAttack, defenderDefense) === row.expectedPct,
          `at level ${String(row.level)} an attack-3 unit's bonus is floor(3 * ` +
            `${String(100 + 25 * row.level)} / 100) = ${String(row.expectedAttack)}, so its ` +
            `chance is floor(${String(row.expectedAttack)} * 100 / ` +
            `${String(row.expectedAttack + defenderDefense)}) = ${String(row.expectedPct)}%`,
        ),
      );

      // The same bonus, as the engine reported it.
      checks.push(
        check(
          event?.attackerWinPct === row.expectedPct,
          `the level-${String(row.level)} battle reports the ${String(row.expectedPct)}% the ` +
            `ladder predicts, got ${
              event === undefined ? 'no battle' : `${String(event.attackerWinPct)}%`
            }`,
        ),
      );

      if (event?.attackerSurvives === true) {
        checks.push(
          check(
            survivor !== undefined &&
              experienceOf(survivor) === Math.min(row.level + 1, COMBAT_RULES.maxExperience),
            `winning raises the winner by exactly one level, to the cap: level ` +
              `${String(row.level)} becomes ${String(Math.min(row.level + 1, COMBAT_RULES.maxExperience))} ` +
              `(got ${survivor === undefined ? 'the unit is gone' : String(experienceOf(survivor))})`,
          ),
        );
        checks.push(
          check(
            promoted.length === (capped ? 0 : 1) &&
              (capped || promoted[0]?.experience === row.level + 1),
            capped
              ? 'a unit already at the cap wins without a promotion event: there is no level ' +
                  'left to announce'
              : `a promotion is announced with the level it reached, ${String(row.level)} -> ` +
                  `${String(row.level + 1)} (got ${
                    promoted.length === 0 ? 'no event' : String(promoted[0]?.experience)
                  })`,
          ),
        );
        checks.push(
          check(
            survivor !== undefined && hitPointsLeftOf(survivor) === 3 - event.attackerLost,
            'a promotion is neither a heal nor a wound: the winner keeps exactly the hit points ' +
              `the battle left it (3 hp - ${String(event.attackerLost)} lost = ` +
              `${String(3 - event.attackerLost)}, got ` +
              `${survivor === undefined ? 'n/a' : String(hitPointsLeftOf(survivor))})`,
          ),
        );
      } else {
        checks.push(
          check(
            survivor === undefined && event?.defenderSurvives === true,
            `the level-${String(row.level)} archer lost its battle, so it is gone and the ` +
              'defender is not',
          ),
        );
      }
    }

    // Non-vacuity: the ladder's upper half is evidence only if a promotion happened.
    checks.push(
      check(
        promotionsSeen > 0,
        `at least one of the four battles promoted its winner (${String(promotionsSeen)} ` +
          'promotions in all)',
      ),
    );

    return checks;
  },
});

describe('M6 scenario: a won battle promotes its winner by one level', () => {
  it('reads the ladder off four independent battles', () => {
    const result = runScenario(promotionScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The four battles and their promotions, as the engine's own events.
    const world = buildWorld(promotionSetup('nothing'));
    const fought = PROMO_CASES.map((row) =>
      probe(world, RULESET, attack(2 + 2 * row.level, ...row.defenderAt)),
    );

    expect(fought.map((outcome) => battles(outcome?.events ?? [])[0]?.attackerWinPct)).toEqual([
      60, 60, 66, 71,
    ]);
    // One promotion for each of the first three levels, none for the capped archer.
    expect(fought.map((outcome) => promotions(outcome?.events ?? []).length)).toEqual([1, 1, 1, 0]);
    // ...and the level each archer ended the probe on: `min(level + 1, COMBAT_RULES.maxExperience)`.
    expect(
      fought.map((outcome, index) => {
        const unit =
          outcome === undefined ? undefined : unitById(outcome.state, asUnitId(2 + 2 * index));
        return unit === undefined ? 'gone' : experienceOf(unit);
      }),
    ).toEqual([1, 2, 3, 3]);
    // A promotion is not a heal: every winner is at 3 hp minus the rounds it lost.
    expect(
      fought.map((outcome) => {
        const unit =
          outcome === undefined ? undefined : unitById(outcome.state, asUnitId(2 + 2 * 0));
        return unit === undefined ? -1 : hitPointsLeftOf(unit);
      })[0],
    ).toBe(3 - (battles(fought[0]?.events ?? [])[0]?.attackerLost ?? -1));
  });

  it('the ladder assertions fail when every archer is already at the cap', () => {
    const variant: Scenario = {
      name: 'promotion-ladder-already-at-the-cap',
      settings: DUEL_SETTINGS,
      setup: promotionSetup('clamp-all'),
      assert: assertOf(promotionScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    const text = failures(result.assertions).join('\n');
    // Every archer is at the cap, so the ladder's own numbers are wrong first: the
    // level-0 row fights at the level-3 chance, and no battle can raise anybody.
    expect(text).toMatch(/the level-0 battle reports the 60%/);
    expect(text).toMatch(/winning raises the winner by exactly one level/);
    expect(text).toMatch(/level 0 becomes 1 \(got 3\)/);
  });
});

/* ---- 17d. A band approaches, then sacks ---------------------------- */

const BAND_START: readonly [number, number] = [5, 5];
const ROMAN_CITY_TILE: readonly [number, number] = [10, 5];
const ROMAN_CITY = asCityId(0);
const BAND_SETTINGS = { mapSize: 'duel', seed: 1 } as const;

/**
 * A ridge across the band's direct line, so the route is a *route* and not a straight
 * line: the north-east diagonal out of `(5, 5)` is mountains, so the band is sent east
 * first and only then cuts the corner.
 */
const RIDGE: readonly (readonly [number, number])[] = [
  [6, 3],
  [6, 4],
  [7, 3],
  [7, 4],
];

/**
 * The measured route, turn by turn, on seed 1: three steps east, one north-east, and
 * then it attacks from `(9, 4)`, which is beside the city.
 *
 * `no-ridge` removes the mountains (the band then cuts the corner at `(6, 4)`) and
 * `closer` starts it two tiles in — both are worlds where this list must be wrong. A
 * third test runs the same world on a different seed, where the route must be
 * *unchanged*, because nothing in the approach reads the RNG at all.
 */
const BAND_ROUTE: readonly (readonly [number, number])[] = [
  [6, 5],
  [7, 5],
  [8, 4],
  [9, 4],
];

const bandSetup =
  (weakens: 'nothing' | 'no-ridge' | 'closer') =>
  (b: ScenarioBuilder): ScenarioBuilder => {
    const start: readonly [number, number] = weakens === 'closer' ? [7, 5] : BAND_START;
    let builder = b
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .addUnit(0, SETTLER, [2, 2])
      .addUnit(1, SETTLER, [35, 35])
      .addCity(0, ROMAN_CITY_TILE, { name: 'Roma', population: 4 })
      .addBarbarianPlayer();

    if (weakens !== 'no-ridge') {
      for (const [x, y] of RIDGE) builder = builder.setTile(x, y, 'mountains');
    }
    return builder.addUnit(2, WARRIOR, start);
  };

const bandScenario = defineScenario({
  name: 'a-band-approaches-and-sacks',
  settings: BAND_SETTINGS,
  setup: bandSetup('nothing'),
  assert: (after, ruleset) => {
    const checks: ScenarioAssertion[] = [];
    const startRng = JSON.stringify(after.rng);

    checks.push(
      check(
        after.units.filter((unit) => unit.owner === BARBARIANS).length === 1 &&
          after.units.filter((unit) => unit.owner === BARBARIANS)[0]?.movementLeft === 1 &&
          after.cities.length === 1 &&
          after.cities[0]?.owner === ROME &&
          after.cities[0].population === 4,
        'the world really holds one movement-1 barbarian warrior and one four-citizen Roman ' +
          'city for it to walk to',
      ),
    );

    // Five turns, walked one at a time so the band's tile is read after each of them.
    let current = after;
    const events: GameEvent[] = [];
    const route: string[] = [];
    let refused = false;
    for (let turn = 0; turn < BAND_ROUTE.length + 1; turn += 1) {
      const outcome = probe(current, ruleset, endTurn());
      if (outcome === undefined) {
        refused = true;
        break;
      }
      current = outcome.state;
      events.push(...outcome.events);
      const band = current.units.find((unit) => unit.owner === BARBARIANS);
      route.push(band === undefined ? 'gone' : label(...xyOf(current.map, band.tile)));
    }

    checks.push(
      check(!refused, 'every turn of the approach was applied — a refusal would stop it dead'),
    );

    // The exact tiles, turn by turn, as the band stood on them at the end of each turn.
    const expectedRoute = BAND_ROUTE.map(([x, y]) => label(x, y));
    const expectedStanding = expectedRoute[BAND_ROUTE.length - 1] ?? 'nowhere';
    checks.push(
      check(
        route.length === BAND_ROUTE.length + 1 &&
          expectedRoute.every((seen, index) => route[index] === seen) &&
          route[BAND_ROUTE.length] === expectedStanding,
        `the band walks exactly ${String(BAND_ROUTE.length)} tiles and then stands still to ` +
          `fight: ${expectedRoute.join(' -> ')} (got ${route.join(' -> ')})`,
      ),
    );

    // The same route as the engine's own step events, so the claim is about the pipeline
    // and not only about the two endpoints.
    const steps = stepsOf(events, 2).map(
      (event) =>
        `${label(...xyOf(current.map, event.from))} -> ${label(...xyOf(current.map, event.to))}`,
    );
    checks.push(
      check(
        steps.length === BAND_ROUTE.length &&
          steps.every((step, index) => step.endsWith(expectedRoute[index] ?? 'nowhere')),
        `the band's ${String(BAND_ROUTE.length)} UnitMoved events end on exactly the tiles of ` +
          `the route, starting from ${label(...BAND_START)}: [${steps.join(', ')}]`,
      ),
    );

    // ...and the sack happens on the last of those turns, from the tile beside the city.
    const event = captures(events)[0];
    const city = cityById(current, ROMAN_CITY);
    checks.push(
      check(
        event !== undefined &&
          Number(event.cityId) === Number(ROMAN_CITY) &&
          event.from === ROME &&
          event.to === BARBARIANS &&
          Number(event.tile) === Number(tileAt(ROMAN_CITY_TILE)) &&
          event.population === capturedPopulation(CAPTURE_RULES, 4),
        'arriving beside an undefended city, the band takes it: population 4 -> ' +
          `${String(capturedPopulation(CAPTURE_RULES, 4))}, from Rome to the barbarians (got ${
            event === undefined
              ? 'no CityCaptured at all'
              : `${event.name} ${String(event.population)} ${String(event.from)} -> ${String(event.to)}`
          })`,
      ),
    );
    checks.push(
      check(
        city !== undefined && city.owner === BARBARIANS && city.population === 2,
        `the city is the barbarians' afterwards, at the halved population (owner ` +
          `${String(city?.owner)}, population ${String(city?.population)})`,
      ),
    );
    checks.push(
      check(
        battles(events).length === 0,
        'nothing was fought on the way: a band attacks only what the applier accepts, and an ' +
          'undefended city is a capture rather than a battle',
      ),
    );

    // The approach is not a random walk: reaching the city consumes no RNG at all, which
    // is what makes a pinned route legitimate in the first place.
    checks.push(
      check(
        JSON.stringify(current.rng) === startRng,
        'the approach and the sack draw NOTHING from the state RNG, so the band is ' +
          `reproducible from the state alone (rng ${startRng} -> ${JSON.stringify(current.rng)})`,
      ),
    );

    return checks;
  },
});

describe('M6 scenario: a barbarian band approaches a city and sacks it', () => {
  it('walks the exact route, drawing nothing, and takes an undefended city', () => {
    const result = runScenario(bandScenario);

    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);

    // The route again, from the engine's events, so the tiles the reply quotes are here.
    const world = buildWorld(bandSetup('nothing'));
    const walked = [0, 1, 2, 3, 4].reduce<{ state: GameState; events: readonly GameEvent[] }>(
      (carry) => {
        const outcome = probe(carry.state, RULESET, endTurn());
        return outcome === undefined
          ? carry
          : { state: outcome.state, events: [...carry.events, ...outcome.events] };
      },
      { state: world, events: [] },
    );

    expect(stepsOf(walked.events, 2).map((event) => Number(event.to))).toEqual(
      BAND_ROUTE.map(([x, y]) => Number(at(x, y))),
    );
    expect(captures(walked.events).map((event) => event.population)).toEqual([2]);
    expect(battles(walked.events)).toEqual([]);
  });

  it('walks the same route on a different seed, because the walk draws nothing', () => {
    const variant: Scenario = {
      name: 'a-band-approaches-and-sacks-on-another-seed',
      settings: { mapSize: 'duel', seed: 987_654 },
      setup: bandSetup('nothing'),
      assert: assertOf(bandScenario),
    };

    const result = runScenario(variant);

    // The same assertions, including the exact route and the "the RNG did not move"
    // claim: if any step of the approach read a draw, a different seed would move it.
    expect(failures(result.assertions)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('the route assertion fails when the ridge is not there', () => {
    const variant: Scenario = {
      name: 'a-band-with-no-ridge-in-its-way',
      settings: BAND_SETTINGS,
      setup: bandSetup('no-ridge'),
      assert: assertOf(bandScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/the band walks exactly 4 tiles/);
  });

  it('the route assertion fails when the band starts two tiles closer', () => {
    const variant: Scenario = {
      name: 'a-band-starting-closer-to-the-city',
      settings: BAND_SETTINGS,
      setup: bandSetup('closer'),
      assert: assertOf(bandScenario),
    };

    const result = runScenario(variant);

    expect(result.passed).toBe(false);
    expect(failures(result.assertions).join('\n')).toMatch(/the band walks exactly 4 tiles/);
  });
});
