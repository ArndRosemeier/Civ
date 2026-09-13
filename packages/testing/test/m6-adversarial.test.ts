/**
 * M6 adversarial review (C5: integration owner for M6, then adversarial verification)
 * — an attempt to **falsify** the frozen M6 contracts in docs/INTERFACES.md
 * ("M6 contracts — FROZEN (combat, promotion, capture, barbarians)"), not to confirm
 * them.
 *
 * This file was written after driving `pnpm verify` green, and it starts from the code
 * on disk rather than from the prose. What it attacks, section by section:
 *
 * 1. **The keystone, both directions, with the EIGHTH generator (combat) inside it.**
 *    `planAttackUnit`'s verdict and `applyCommand`'s verdict must be the same verdict on
 *    every board this file can build — including the boards where the answer is a
 *    *refusal*, which is where a generator and an applier usually disagree. The commands
 *    the applier accepts but no generator advertises are pinned as an exact, named set
 *    (`FortifyUnit` joins M4b's `SetRates` and M5's `SetResearch`), so "queried, not
 *    enumerated" cannot quietly become "forgotten".
 * 2. **Combat honesty.** The per-round odds are re-derived in this file from integer
 *    arithmetic and compared with what the resolver reports; the defender-wins-ties
 *    boundary is pinned at the exact threshold; the sum-then-floor-**once** rule is
 *    asserted with a case where flooring twice would give a *different* answer, through a
 *    real battle; the dice are shown to come from the state's RNG; and no battle is
 *    allowed to raise a hit-point count or add a unit.
 * 3. **No live unit at 0 hit points, and no trace of a destroyed one.**
 * 4. **Capture integrity**: population, the deterministic building list, the wonder that is
 *    never destroyed, the cleared queue, the untouched food/shields/improvements, the
 *    population-1 and twice-captured corners, and a *barbarian* capture.
 * 5. **Barbarian determinism**: the same board twice, tile-index tie-breaks (never map or
 *    unit iteration order), no gold, no research, no road bonus, and a step whose own
 *    decisions draw no dice — plus the regression pin for the one contract violation this
 *    review found (see below).
 * 6. **Gating exercised by shipped content, through play** — research completed by the
 *    turn pipeline, then the gate opening, then the item actually produced.
 * 7. **Determinism in-process and in a fresh process.**
 * 8. **The invariant registry's cost per turn**, and M6's new invariants shown to *fire*
 *    on the states they exist to catch (a fire case each, or the invariant proves nothing).
 * 9. **The rules the gate depends on, pinned so a mutation to them is RED**: the tie rule
 *    and the wonder rule, plus the operational mutation check recorded in the header note
 *    below.
 *
 * ## What this review found
 *
 * **One contract violation, now fixed: a hut could place a barbarian band inside a
 * civilization's city.** `hut.ts`' `bandTiles` filtered the adjacent tiles for another
 * player's *units* and had no city filter, while M6 both registers
 * `unit-not-inside-foreign-city` and makes the mover refuse a foreign city tile
 * (`occupied-by-enemy`). A band placed on such a tile is therefore a state no command can
 * produce, and it is reachable from real play: the 200-seed `duel`/3-civ sweeps in
 * `@civts/sim`'s full tier (`invariant-precision.test.ts`) stopped on it twice, on seeds 57
 * and 122, both on a turn whose band landed on the tile of a city whose defender had just
 * walked away (`BarbariansSpawned` tiles `[406, 407]` with 406 = city 1 of player 1, and
 * `[1270, 1271]` with 1271 = city 4 of player 1). `bandTiles` now also excludes a tile
 * holding another player's city, read through the engine's own `cityAt`; the fast tier was
 * green before and after, which is why only the full tier could see it. Section 5 pins it.
 *
 * Two integration defects found by the same full-tier run, both in *review* code rather
 * than in the engine, and both fixed by stating the rule the engine already states:
 * `m4c-adversarial`'s keystone compared `availableBuildings` with the menu for *equality*,
 * which M6's tech-gated temple makes false (the menu asks `productionGate`, which the
 * ruleset-free reader cannot); and `invariants.test.ts`'s fire case for
 * `city-food-box-within-threshold` built its probes without the `foodSurplus > 0` premise
 * the check documents. Neither is a weakening: the first is now an equivalence plus both
 * implications, with counters proving the M6 dimension was exercised, and the second counts
 * the city-turns it passes over.
 *
 * ## The mutation check (item 9), as run
 *
 * The two mutations this milestone's evidence most depends on were applied to the sources
 * by hand, the affected suites were run, the results were recorded, and the files were
 * restored and compared byte for byte:
 *
 * - `packages/core/src/combat.ts`: `drawsWin` flipped from `roll < threshold` to
 *   `roll <= threshold` (the tie rule). Result: RED — 7 failures: 5 in
 *   `packages/core/test/combat.test.ts` and 2 here (the tie-boundary test and section 9's
 *   pin). Reverted; `sha256sum` matches the recorded pre-mutation digest.
 * - `packages/core/src/cities.ts`: `buildingsLostToCapture`'s `kept: ... isWonder(def)`
 *   guard replaced by `kept: false`, so a sack destroys the wonder too. Result: RED — 7
 *   failures: 3 in `packages/core/test/cities.test.ts` and 4 here (all three capture tests
 *   and section 9's pin). Reverted; `sha256sum` matches again.
 * - `packages/core/src/hut.ts`: the city filter the finding above added to `bandTiles`
 *   removed, reproducing the pre-fix behaviour. Result: RED — section 5's regression pin
 *   fails with "a band was placed on tile 779 inside city 0, owned by player 1". Reverted;
 *   `sha256sum` matches the post-fix digest.
 *
 * Both mutants were caught by *assertions about behaviour* rather than by a hash of a
 * source file, which is why the checks live here as tests rather than as a pinned digest:
 * a digest test would fail on every legitimate edit and pass on a behavioural regression
 * that happened to keep the file length.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BARBARIAN_BAND_SIZE,
  advanceTurn,
  applyCommand,
  asBuildingId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTileIndex,
  asUnitTypeId,
  buildingCatalog,
  buildingsLostToCapture,
  captureRulesOf,
  capturedPopulation,
  cityAt,
  cityProductionOptions,
  connected,
  combatRulesOf,
  defenderBonusPct,
  distance8,
  drawsWin,
  fullHitPoints,
  hitPointsLeftOf,
  isWonder,
  knownTechs,
  knowsTech,
  legalActions,
  maintenanceOf,
  maxHitPointsOf,
  modifiedDefense,
  neighbors8,
  planAttackUnit,
  planSetResearch,
  prerequisitesOf,
  productionGate,
  requiresTechOf,
  researchingOf,
  resolveCombat,
  seedRng,
  spawnUnit,
  techCatalog,
  techDef,
  terrainAtIndex,
  terrainDefenseBonus,
  tileIndex,
  unitActions,
  unitById,
  unitDef,
  unitsOnTile,
  unmetItemTech,
  veteranAttack,
  veteranBonusPct,
  winPct,
  woundUnit,
  type BuildingDef,
  type City,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type PlayerId,
  type ProductionItem,
  type Rates,
  type RulesetView,
  type TerrainRole,
  type TileIndex,
  type Unit,
  type UnitDef,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import { CORE_INVARIANTS, checkInvariants, type Invariant } from '@civts/sim';

import { createScenarioBuilder, hashValue } from '../src/index.js';
import { FULL_TIER } from '../src/tier.js';

/* ------------------------------------------------------------------ *
 * 0. The world this file builds
 * ------------------------------------------------------------------ */

/**
 * The shipped catalog, validated exactly as the CLI validates it: everything in this file
 * is about **real content**, so a ruleset built for the test would defeat the point of
 * item 6 in particular.
 */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error
        .map((error) => `${error.kind}:${JSON.stringify(error)}`)
        .join('; ')}`,
    );
  }
  return validated.value;
})();

/**
 * **The nine combat magnitudes, as the resolver reads them** (M6b).
 *
 * They were `core/combat.ts` module constants when M6 pinned them — `ROLL_BOUND`,
 * `MAX_WIN_PCT`, `FORTIFY_BONUS_PCT` and the rest — and this file imported each one by
 * name. M6b moved them into the catalog's `combat` section, so the pin now reads them out
 * of the validated ruleset through `combatRulesOf`, which is the *same* reader
 * `core/commands.ts` asks before it resolves a battle. The numbers, and therefore every
 * assertion below, are unchanged: this is where they live now, and it is the place a
 * balance sweep can move them.
 *
 * Reading them through `combatRulesOf` rather than off `RULESET.combat` directly is
 * deliberate: it is the reader under test. A fixture that pulled the raw section out would
 * agree with itself even if the reader dropped a field on the way to the resolver.
 */
const COMBAT = combatRulesOf(RULESET);

/**
 * **The capture rule, read the same way** (M7).
 *
 * M6's `CAPTURE_POPULATION_DIVISOR` was a module constant in `core/cities.ts` and this file
 * imported it by name; M7 moves the divisor into the catalog's `capture` section, so the
 * pin reads it out of the validated ruleset through `captureRulesOf` — the *same* reader
 * `core/commands.ts` asks before it applies a sack. The number, and therefore every
 * assertion below, is unchanged.
 */
const CAPTURE = captureRulesOf(RULESET);

/** `Ruleset` is structurally the engine's view; named so the intent is visible at each call. */
const VIEW: RulesetView = RULESET;

const DUEL = { width: 40, height: 40 } as const;

/** A tile index on this file's 40x40 board, from coordinates — never a bare literal. */
const at = (x: number, y: number): TileIndex => tileIndex(DUEL.width, x, y);

/** The catalog's own row for a unit id, or a thrown error naming the id (never `undefined`). */
const unitRow = (type: string): UnitDef => {
  const def = unitDef(RULESET, asUnitTypeId(type));
  if (def === undefined) throw new Error(`the shipped catalog defines no unit "${type}"`);
  return def;
};

const buildingRow = (id: string): BuildingDef => {
  const def = buildingCatalog(RULESET).find((row) => String(row.id) === id);
  if (def === undefined) throw new Error(`the shipped catalog defines no building "${id}"`);
  return def;
};

/**
 * The board builder every section shares: a 40x40 duel map, grassland everywhere unless a
 * tile's role is stated, two civilizations (plus the barbarian player when asked for), and
 * units/cities placed where the caller says.
 *
 * Nothing in this file hand-writes a `GameState`: the scenario builder is the harness's own
 * board assembler, so a board that `gen.ts` or a command could never produce is refused here
 * rather than asserted against. Every value the sections below assert is read back from the
 * engine or from the catalog.
 */
interface Placement {
  readonly owner: number;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly hp?: number;
  readonly experience?: number;
  readonly fortified?: true;
}

interface CityPlacement {
  readonly owner: number;
  readonly x: number;
  readonly y: number;
  readonly population?: number;
  readonly buildings?: readonly string[];
  /** Shields already banked towards the current build — a state a scenario may state. */
  readonly shields?: number;
}

interface WorldConfig {
  /** The generation seed: what makes two boards on the same map differ in their dice. */
  readonly seed?: number;
  readonly units?: readonly Placement[];
  readonly cities?: readonly CityPlacement[];
  /** Terrain roles by tile key (`"x,y"`), over the grassland fill. */
  readonly terrain?: Readonly<Record<string, TerrainRole>>;
  readonly barbarians?: boolean;
  readonly huts?: readonly (readonly [number, number])[];
  readonly roads?: readonly (readonly [readonly [number, number], readonly [number, number]])[];
  readonly techs?: readonly string[];
  readonly beakers?: number;
  readonly treasury?: number;
  readonly researching?: string;
  readonly rates?: Rates;
  /** Resources on the map, as `(x, y, id)` triples. */
  readonly resources?: readonly { readonly x: number; readonly y: number; readonly id: string }[];
}

const buildWorld = (config: WorldConfig): GameState => {
  let builder = createScenarioBuilder(VIEW, {
    mapSize: 'duel',
    civCount: 2,
    seed: config.seed ?? 11,
  })
    .addPlayer('Rome')
    .addPlayer('Greece')
    .fillTerrain('grassland');

  if (config.barbarians === true) builder = builder.addBarbarianPlayer();

  for (const [key, role] of Object.entries(config.terrain ?? {})) {
    const [rawX, rawY] = key.split(',');
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`terrain key "${key}" is not "x,y"`);
    }
    builder = builder.setTile(x, y, role);
  }

  for (const hut of config.huts ?? []) builder = builder.addHut(hut[0], hut[1]);
  for (const resource of config.resources ?? []) {
    builder = builder.addResource(resource.x, resource.y, asResourceId(resource.id));
  }
  for (const road of config.roads ?? []) builder = builder.connectRoad(road[0], road[1]);
  for (const tech of config.techs ?? []) builder = builder.grantTech(0, asTechId(tech));
  if (config.treasury !== undefined) builder = builder.setTreasury(0, config.treasury);
  if (config.beakers !== undefined) builder = builder.setPools(0, { beakers: config.beakers });
  if (config.rates !== undefined) builder = builder.setRates(0, config.rates);
  if (config.researching !== undefined) {
    builder = builder.setResearching(0, asTechId(config.researching));
  }

  // Cities first, then their buildings by index: `addBuilding` takes the index `addCity`
  // returned, so a building cannot be placed before the city it belongs to exists.
  const cities = config.cities ?? [];
  for (const city of cities) {
    builder = builder.addCity(city.owner, [city.x, city.y], {
      ...(city.population === undefined ? {} : { population: city.population }),
      ...(city.shields === undefined ? {} : { shields: city.shields }),
    });
  }
  for (const [index, city] of cities.entries()) {
    for (const building of city.buildings ?? []) {
      builder = builder.addBuilding(index, asBuildingId(building));
    }
  }

  for (const placement of config.units ?? []) {
    builder = builder.addUnit(
      placement.owner,
      asUnitTypeId(placement.type),
      [placement.x, placement.y],
      {
        ...(placement.hp === undefined ? {} : { hitPointsLeft: placement.hp }),
        ...(placement.experience === undefined ? {} : { experience: placement.experience }),
        ...(placement.fortified === undefined ? {} : { fortified: placement.fortified }),
      },
    );
  }

  // A hand-built world has no pre-history, so the builder needs every *civilization* to have
  // a unit somewhere: that unit is where the player "started". The padding settlers are put
  // in a corner far from every board this file builds, so they never take part in a battle,
  // a capture or a barbarian approach — but they are real units of that player and the
  // engine treats them as such.
  for (const owner of [0, 1]) {
    const mine = (config.units ?? []).some((placement) => placement.owner === owner);
    if (!mine) {
      builder = builder.addUnit(owner, asUnitTypeId('settler'), [34 + owner, 34]);
    }
  }

  const built = builder.build();
  if (!built.ok) {
    throw new Error(`the board did not build: ${JSON.stringify(built.error)}`);
  }
  return built.value;
};

/* ------------------------------------------------------------------ *
 * Shared readers and comparisons
 * ------------------------------------------------------------------ */

const errorText = (error: GameError): string => `${error.kind} (${JSON.stringify(error)})`;

/** A command's identity as a string, so two generators can be compared by set. */
const cmdKey = (cmd: Command): string => {
  switch (cmd.type) {
    case 'MoveUnit':
      return `MoveUnit ${String(cmd.unitId)} -> ${String(cmd.to)}`;
    case 'EndTurn':
      return 'EndTurn';
    case 'FoundCity':
      return `FoundCity ${String(cmd.unitId)}`;
    case 'SetWorkedTiles':
      return `SetWorkedTiles ${String(cmd.cityId)}`;
    case 'SetProduction':
      return `SetProduction ${String(cmd.cityId)} ${cmd.item.kind}:${String(cmd.item.id)}`;
    case 'StartWork':
      return `StartWork ${String(cmd.unitId)} ${String(cmd.kind)}`;
    case 'CancelWork':
      return `CancelWork ${String(cmd.unitId)}`;
    case 'SetRates':
      return `SetRates ${String(cmd.rates.tax)}/${String(cmd.rates.science)}/${String(cmd.rates.luxury)}`;
    case 'SetResearch':
      return `SetResearch ${String(cmd.tech)}`;
    case 'AttackUnit':
      return `AttackUnit ${String(cmd.unitId)} -> ${String(cmd.target)}`;
    case 'FortifyUnit':
      return `FortifyUnit ${String(cmd.unitId)}`;

    // M9: the government setter, keyed by the government it names for the same M4a
    // reason as its neighbours — two `SetGovernment`s naming different rows are
    // different commands, and a key that dropped the id would call them equal.
    case 'SetGovernment':
      return `SetGovernment ${String(cmd.government)}`;
  }
};

/** The applier's refusal, or a thrown error saying the command was *accepted* when it was not meant to be. */
const refusalOf = (state: GameState, player: PlayerId, cmd: Command): GameError => {
  const outcome = applyCommand(state, player, cmd, VIEW);
  if (outcome.ok) {
    throw new Error(`${cmdKey(cmd)} was accepted; this assertion expected a refusal`);
  }
  return outcome.error;
};

/** The applier's accepted state and events, or a thrown error carrying the refusal. */
const accept = (
  state: GameState,
  player: PlayerId,
  cmd: Command,
): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
  const outcome = applyCommand(state, player, cmd, VIEW);
  if (!outcome.ok) {
    throw new Error(`${cmdKey(cmd)} was refused: ${errorText(outcome.error)}`);
  }
  return outcome.value;
};

const hitsOf = (state: GameState): number =>
  state.units.reduce((total, unit) => total + hitPointsLeftOf(unit), 0);

const unitOn = (state: GameState, tile: TileIndex, owner?: PlayerId): Unit | undefined =>
  unitsOnTile(state, tile).find((unit) => owner === undefined || unit.owner === owner);

const mustUnitOn = (state: GameState, tile: TileIndex, owner?: PlayerId): Unit => {
  const unit = unitOn(state, tile, owner);
  if (unit === undefined) {
    throw new Error(
      `no unit${owner === undefined ? '' : ` of player ${String(owner)}`} on tile ${String(tile)}`,
    );
  }
  return unit;
};

const mustUnit = (state: GameState, id: UnitId): Unit => {
  const unit = unitById(state, id);
  if (unit === undefined) throw new Error(`the world holds no unit ${String(id)}`);
  return unit;
};

const mustCity = (state: GameState, owner: PlayerId): City => {
  const city = state.cities.find((each) => each.owner === owner);
  if (city === undefined) throw new Error(`player ${String(owner)} holds no city`);
  return city;
};

/** The player row for an id, or `undefined` — the reader every assertion here needs. */
const playerRowOf = (state: GameState, id: PlayerId): GameState['players'][number] | undefined =>
  state.players.find((player) => player.id === id);

const mustPlayerRow = (state: GameState, id: PlayerId): GameState['players'][number] => {
  const row = playerRowOf(state, id);
  if (row === undefined) throw new Error(`the state has no player ${String(id)}`);
  return row;
};

const first = (values: readonly number[]): number => {
  const value = values[0];
  if (value === undefined) throw new Error('expected a non-empty list');
  return value;
};

/** Every invariant violation this state produces, run against the shared registry. */
const violationsOf = (
  state: GameState,
  previous?: GameState,
  events: readonly GameEvent[] = [],
): readonly string[] =>
  checkInvariants({
    state,
    previous,
    ruleset: RULESET,
    rulesetView: VIEW,
    events,
    turn: state.turn,
  }).map((violation) => `${violation.invariant}: ${violation.message}`);

const invariantNamed = (name: string): Invariant => {
  const found = CORE_INVARIANTS.find((invariant) => invariant.name === name);
  if (found === undefined) throw new Error(`the registry has no invariant "${name}"`);
  return found;
};

/* ------------------------------------------------------------------ *
 * 1. The keystone invariant, both directions, with the eighth generator
 * ------------------------------------------------------------------ */

interface Board {
  readonly name: string;
  readonly state: GameState;
  /** The ring plus a far tile: the tiles an `AttackUnit` candidate can name. */
  readonly targets: readonly TileIndex[];
}

const ATTACKER_AT = { x: 10, y: 10 } as const;
const DEFENDER_AT = { x: 11, y: 10 } as const;

/** Every board this section needs, each one a corner the legality rule names. */
const keystoneBoards = (): readonly Board[] => {
  const ring = (state: GameState): readonly TileIndex[] => [
    ...neighbors8(state.map, at(ATTACKER_AT.x, ATTACKER_AT.y)),
    at(30, 30),
  ];

  // (a) the plain battle: an attack that applies.
  const plain = buildWorld({
    units: [
      { owner: 0, type: 'warrior', x: ATTACKER_AT.x, y: ATTACKER_AT.y },
      { owner: 1, type: 'warrior', x: DEFENDER_AT.x, y: DEFENDER_AT.y },
    ],
  });

  // (b) two enemy units on one tile: `target-stacked`, and the half of "exactly one
  // enemy-occupied thing" that refuses rather than guesses.
  const stacked = buildWorld({
    units: [
      { owner: 0, type: 'warrior', x: ATTACKER_AT.x, y: ATTACKER_AT.y },
      { owner: 1, type: 'warrior', x: DEFENDER_AT.x, y: DEFENDER_AT.y },
      { owner: 1, type: 'warrior', x: DEFENDER_AT.x, y: DEFENDER_AT.y },
    ],
  });

  // (c) a friend on the target tile: not an enemy, so `nothing-to-attack` — the
  // readability corner, since M2 lets a player stack its own units.
  const friend = buildWorld({
    units: [
      { owner: 0, type: 'warrior', x: ATTACKER_AT.x, y: ATTACKER_AT.y },
      { owner: 0, type: 'warrior', x: DEFENDER_AT.x, y: DEFENDER_AT.y },
    ],
  });

  // (d) a unit that may not attack at all (`attack === 0`): M6's "legality rule, not a
  // footnote", read off the catalog rather than restated here.
  const scout = buildWorld({
    units: [
      { owner: 0, type: 'scout', x: ATTACKER_AT.x, y: ATTACKER_AT.y },
      { owner: 1, type: 'warrior', x: DEFENDER_AT.x, y: DEFENDER_AT.y },
    ],
  });

  // (e) an own city on the target tile: a city is not an enemy city, so nothing to attack.
  const ownCity = buildWorld({
    units: [{ owner: 0, type: 'warrior', x: ATTACKER_AT.x, y: ATTACKER_AT.y }],
    cities: [{ owner: 0, x: DEFENDER_AT.x, y: DEFENDER_AT.y }],
  });

  // (f) an undefended enemy city: a capture, not a battle.
  const enemyCity = buildWorld({
    units: [{ owner: 0, type: 'warrior', x: ATTACKER_AT.x, y: ATTACKER_AT.y }],
    cities: [{ owner: 1, x: DEFENDER_AT.x, y: DEFENDER_AT.y, population: 4 }],
  });

  // (g) a defended enemy city: the same tile, and the answer is a battle against the
  // unit rather than a capture of the city.
  const defendedCity = buildWorld({
    units: [
      { owner: 0, type: 'warrior', x: ATTACKER_AT.x, y: ATTACKER_AT.y },
      { owner: 1, type: 'spearman', x: DEFENDER_AT.x, y: DEFENDER_AT.y },
    ],
    cities: [{ owner: 1, x: DEFENDER_AT.x, y: DEFENDER_AT.y, population: 4 }],
  });

  return [
    { name: 'plain', state: plain, targets: ring(plain) },
    { name: 'stacked', state: stacked, targets: ring(stacked) },
    { name: 'friend', state: friend, targets: ring(friend) },
    { name: 'scout', state: scout, targets: ring(scout) },
    { name: 'own-city', state: ownCity, targets: ring(ownCity) },
    { name: 'enemy-city', state: enemyCity, targets: ring(enemyCity) },
    { name: 'defended-city', state: defendedCity, targets: ring(defendedCity) },
  ];
};

describe('1. the keystone invariant, both directions, with combat as the eighth generator', () => {
  it('planAttackUnit, unitActions and the applier give one verdict on every ring tile', () => {
    // The property the M6 contract states: "`legalActions`/`unitActions` must yield
    // `AttackUnit` exactly where the applier accepts it — the keystone invariant in BOTH
    // directions". Three readers are compared on every (unit, ring tile) pair this file can
    // build: the planner (`planAttackUnit`, the applier's own evaluator), the generator
    // (`unitActions`), and the applier (`applyCommand`). Any disagreement — a tile offered
    // and refused, or accepted and not offered — fails here.
    let accepted = 0;
    let refused = 0;

    for (const board of keystoneBoards()) {
      for (const unit of board.state.units) {
        const advertised = new Set(
          unitActions(board.state, VIEW, unit.id)
            .filter((cmd) => cmd.type === 'AttackUnit')
            .map((cmd) => Number(cmd.target)),
        );

        for (const target of board.targets) {
          const cmd: Command = { type: 'AttackUnit', unitId: unit.id, target };
          const planned = planAttackUnit(board.state, VIEW, unit.owner, unit.id, target);
          const outcome = applyCommand(board.state, unit.owner, cmd, VIEW);
          const where = `${board.name}: unit ${String(unit.id)} (${String(unit.type)}) -> tile ${String(target)}`;

          // The planner *is* the applier's evaluator, so this is the engine's own
          // generator/applier agreement; the next assertion is the extra claim that
          // `unitActions` advertises exactly that same set.
          expect(
            planned.ok,
            `${where} planner=${planned.ok ? 'accept' : planned.error.kind} applier=${outcome.ok ? 'accept' : outcome.error.kind}`,
          ).toBe(outcome.ok);
          expect(
            advertised.has(Number(target)),
            `${where}: unitActions ${advertised.has(Number(target)) ? 'offered' : 'omitted'} it, the applier ${outcome.ok ? 'accepted' : 'refused'} it`,
          ).toBe(outcome.ok);

          if (outcome.ok) accepted += 1;
          else refused += 1;
        }
      }
    }

    // Non-vacuity in both directions: a sweep that only ever refused (or only ever
    // accepted) would prove nothing about the agreement.
    expect(
      accepted,
      'no attack in the sweep was legal, so the agreement is untested',
    ).toBeGreaterThan(0);
    expect(
      refused,
      'every attack in the sweep was legal, so the refusals are untested',
    ).toBeGreaterThan(0);
  });

  it('refuses each named corner with the named reason', () => {
    // The refusals are the half a generator cannot show: it is silent about *why*. Each
    // case below pins the reason the contract gives, so a legality rule that changed into
    // a different refusal is caught even though "refused" alone stayed true.
    const boards = keystoneBoards();
    const byName = new Map(boards.map((board) => [board.name, board] as const));
    const board = (name: string): Board => {
      const found = byName.get(name);
      if (found === undefined) throw new Error(`no board named ${name}`);
      return found;
    };
    const attackerOf = (b: Board): Unit =>
      mustUnitOn(b.state, at(ATTACKER_AT.x, ATTACKER_AT.y), asPlayerId(0));

    const attacker = attackerOf(board('plain'));
    const attack = (b: Board, target: TileIndex): GameError =>
      refusalOf(b.state, attackerOf(b).owner, {
        type: 'AttackUnit',
        unitId: attackerOf(b).id,
        target,
      });

    // An *empty* adjacent tile: the plain board's enemy is on the target tile, so the
    // refusal case has to be a tile nobody is standing on.
    expect(attack(board('plain'), at(10, 11)).kind).toBe('nothing-to-attack');
    expect(attack(board('stacked'), at(DEFENDER_AT.x, DEFENDER_AT.y)).kind).toBe('target-stacked');
    expect(attack(board('friend'), at(DEFENDER_AT.x, DEFENDER_AT.y)).kind).toBe(
      'nothing-to-attack',
    );
    expect(attack(board('own-city'), at(DEFENDER_AT.x, DEFENDER_AT.y)).kind).toBe(
      'nothing-to-attack',
    );

    // A unit with `attack === 0`, on a board where everything else is legal. The *row* is
    // checked first, so this case cannot pass because the catalog happened to change.
    expect(unitRow('scout').attack).toBe(0);
    const scoutRefusal = attack(board('scout'), at(DEFENDER_AT.x, DEFENDER_AT.y));
    expect(scoutRefusal.kind).toBe('unit-cannot-attack');

    // A non-adjacent tile, and a tile off the map.
    expect(attack(board('plain'), at(30, 30)).kind).toBe('invalid-argument');
    expect(attack(board('plain'), asTileIndex(-1)).kind).toBe('out-of-bounds');

    // A unit the actor does not own: `not-your-unit`, before anything about the target.
    const foreign = refusalOf(board('plain').state, asPlayerId(1), {
      type: 'AttackUnit',
      unitId: attacker.id,
      target: at(DEFENDER_AT.x, DEFENDER_AT.y),
    });
    expect(foreign.kind).toBe('not-your-unit');
    void board('enemy-city');
  });

  it('spends the whole turn: after an attack the unit has no movement, win or lose', () => {
    // M6: "The attack consumes ALL remaining movement (attacking ends the unit's turn)
    // whether or not it succeeds." A surviving attacker must end at 0 — a mutation that spent
    // one point (like a move) or none is caught — and an attacker that died is simply gone,
    // which is the other half of the same rule. Swept over seeds so both outcomes occur.
    let survivors = 0;
    let deaths = 0;
    for (let seed = 1; seed <= 16; seed += 1) {
      const board = buildWorld({
        seed,
        units: [
          { owner: 0, type: 'warrior', x: 10, y: 10 },
          { owner: 1, type: 'warrior', x: 11, y: 10 },
        ],
      });
      const attacker = mustUnitOn(board, at(10, 10));
      expect(attacker.movementLeft).toBe(unitRow('warrior').movement);
      const applied = accept(board, attacker.owner, {
        type: 'AttackUnit',
        unitId: attacker.id,
        target: at(11, 10),
      });
      expect(applied.events[0]?.type).toBe('CombatResolved');

      const after = unitById(applied.state, attacker.id);
      if (after === undefined) {
        deaths += 1;
        const death = applied.events.find(
          (event) => event.type === 'UnitDestroyed' && event.unitId === attacker.id,
        );
        expect(death, 'the attacker vanished with no UnitDestroyed event').toBeDefined();
      } else {
        survivors += 1;
        expect(
          after.movementLeft,
          `seed ${String(seed)}: the attacker kept movement after attacking`,
        ).toBe(0);
      }
    }
    expect(
      survivors,
      'no attacker survived the sweep, so the movement rule is untested',
    ).toBeGreaterThan(0);
    expect(deaths, 'no attacker died in the sweep, so the death half is untested').toBeGreaterThan(
      0,
    );
  });

  it('keeps its promise about an attack with no movement left: refused, and not offered', () => {
    // Built by *playing*: `FortifyUnit` spends the unit's remaining movement (M6), so the
    // state this assertion uses is one the command layer really produces rather than one
    // this file wrote by hand.
    const board = keystoneBoards().find((candidate) => candidate.name === 'plain');
    if (board === undefined) throw new Error('the plain board is missing');
    const attacker = mustUnitOn(board.state, at(ATTACKER_AT.x, ATTACKER_AT.y));

    const fortified = accept(board.state, attacker.owner, {
      type: 'FortifyUnit',
      unitId: attacker.id,
    });
    expect(mustUnit(fortified.state, attacker.id).movementLeft).toBe(0);

    const target = at(DEFENDER_AT.x, DEFENDER_AT.y);
    const error = refusalOf(fortified.state, attacker.owner, {
      type: 'AttackUnit',
      unitId: attacker.id,
      target,
    });
    expect(error.kind).toBe('not-enough-movement');
    if (error.kind === 'not-enough-movement') {
      expect(error.needed).toBe(1);
      expect(error.available).toBe(0);
    }
    const offered = unitActions(fortified.state, VIEW, attacker.id).filter(
      (cmd) => cmd.type === 'AttackUnit',
    );
    expect(offered).toEqual([]);
  });

  it('names the queried commands the applier accepts and no generator advertises', () => {
    // The other half of "state the rule once": a command the applier accepts but which no
    // generator enumerates is legal *by query* — and the set of those commands is stated,
    // named and finite. A new one appearing (or one of these becoming advertised) fails
    // here rather than sliding through as "the generators are just quiet about it".
    // One board carries everything this test needs: a unit of player 0 on a tile, and a city
    // of player 0 with a production menu — so the production candidates below are the ones the
    // menu itself offers, on the same state the applier is asked about.
    const board = keystoneBoards().find((candidate) => candidate.name === 'own-city');
    if (board === undefined) throw new Error('the own-city board is missing');
    const state = board.state;
    const attacker = mustUnitOn(state, at(ATTACKER_AT.x, ATTACKER_AT.y));
    const ownCity = mustCity(state, asPlayerId(0));
    const offered = cityProductionOptions(state, VIEW, ownCity.id);
    expect(
      offered.length,
      'the city offers nothing to build, so nothing is advertised',
    ).toBeGreaterThan(0);

    const candidates: readonly Command[] = [
      { type: 'FortifyUnit', unitId: attacker.id },
      { type: 'SetRates', rates: { tax: 5, science: 5, luxury: 0 } },
      ...techCatalog(RULESET).map((tech): Command => ({ type: 'SetResearch', tech: tech.id })),
      // Both halves of the production surface: what the menu offers (accepted, advertised)
      // and items the catalog has but the menu withholds (refused, which is the gate at work).
      ...offered.map((item): Command => ({ type: 'SetProduction', cityId: ownCity.id, item })),
      ...unitCatalogItems()
        .filter((item) => !offered.some((each) => each.kind === item.kind && each.id === item.id))
        .map((item): Command => ({ type: 'SetProduction', cityId: ownCity.id, item })),
    ];

    // The two *enumerating* generators: what a client that walks the action list sees.
    const advertisedByEnumerator = (cmd: Command): boolean => {
      const key = cmdKey(cmd);
      for (const player of state.players) {
        for (const action of legalActions(state, VIEW, player.id)) {
          if (cmdKey(action) === key) return true;
        }
      }
      for (const unit of state.units) {
        for (const action of unitActions(state, VIEW, unit.id)) {
          if (cmdKey(action) === key) return true;
        }
      }
      return false;
    };

    // The *queried* generator for production: `SetProduction` is advertised by the city menu
    // (`cityProductionOptions`) rather than by the action list — M3's precedent for the
    // setters, restated by M4b and M4c — so it is checked through its own reader.
    const advertisedByMenu = (cmd: Command): boolean => {
      if (cmd.type !== 'SetProduction') return false;
      for (const city of state.cities) {
        if (city.id !== cmd.cityId) continue;
        return cityProductionOptions(state, VIEW, city.id).some(
          (item) =>
            item.kind === cmd.item.kind &&
            item.id === cmd.item.id &&
            cmdKey({ type: 'SetProduction', cityId: city.id, item }) === cmdKey(cmd),
        );
      }
      return false;
    };

    const acceptedWithNoReader = new Set<string>();
    let accepted = 0;
    let advertised = 0;
    for (const cmd of candidates) {
      const outcome = applyCommand(
        state,
        cmd.type === 'SetProduction' ? asPlayerId(0) : attacker.owner,
        cmd,
        VIEW,
      );
      if (!outcome.ok) continue;
      accepted += 1;
      if (advertisedByEnumerator(cmd) || advertisedByMenu(cmd)) advertised += 1;
      else acceptedWithNoReader.add(cmd.type);
    }

    expect(
      accepted,
      'not one queried command was accepted, so the set below is empty for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      advertised,
      'no queried command had a reader at all, so the menu is not being consulted',
    ).toBeGreaterThan(0);
    // **The named set**: commands the applier accepts and no reader offers. Three of them, by
    // name — a fourth appearing here, or one of these becoming advertised, fails.
    expect([...acceptedWithNoReader].sort()).toEqual(['FortifyUnit', 'SetRates', 'SetResearch']);

    // …and the enumerators are silent about `SetProduction` by design: the menu is its
    // reader, and this pins that the *other* two generators do not quietly start offering it.
    for (const cmd of candidates) {
      if (cmd.type !== 'SetProduction') continue;
      expect(advertisedByEnumerator(cmd)).toBe(false);
    }
  });

  it('runs the barbarian half of the same rule: the engine steps where the mover accepts', () => {
    // The barbarian step is engine behaviour with no generator behind it, so its own promise
    // is different: the move it makes is one `planMove` accepts and the attack it makes is one
    // the applier resolves — which `advanceTurn` below shows by doing both. (`barbarians.ts`
    // is not part of `@civts/core`'s public surface, so this file drives it through the
    // pipeline, which is also the position the contract makes contractual.)
    const board = buildWorld({
      barbarians: true,
      units: [
        { owner: 0, type: 'warrior', x: 11, y: 10 },
        { owner: 0, type: 'settler', x: 30, y: 30 },
      ],
      cities: [{ owner: 0, x: 20, y: 20, population: 4 }],
    });
    const barbarian = board.players.find((candidate) => candidate.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('the board has no barbarian player');
    const band = spawnUnit(board, unitRow('warrior'), barbarian.id, at(10, 10));
    const victimBefore = hitPointsLeftOf(mustUnitOn(band.state, at(11, 10)));

    const turned = advanceTurn(band.state, VIEW);
    const combat = turned.events.find((event) => event.type === 'CombatResolved');
    if (combat === undefined) {
      throw new Error('the band stood beside a civilization unit and fought nobody');
    }
    expect(combat.attackerOwner).toBe(barbarian.id);
    expect(combat.attackerId).toBe(band.unit.id);
    expect(combat.target).toBe(at(11, 10));

    // The applier really applied it: the victim is wounded by exactly what the event says,
    // or gone.
    const victimAfter = unitById(turned.state, combat.defenderId);
    if (victimAfter === undefined) {
      expect(victimBefore - combat.defenderLost).toBeLessThanOrEqual(0);
    } else {
      expect(hitPointsLeftOf(victimAfter)).toBe(victimBefore - combat.defenderLost);
    }
  });
});

/** One `ProductionItem` per distinct unit and building row in the shipped catalog. */
const unitCatalogItems = (): readonly ProductionItem[] => [
  ...RULESET.units.map((row): ProductionItem => ({ kind: 'unit', id: row.id })),
  ...buildingCatalog(RULESET).map((row): ProductionItem => ({ kind: 'building', id: row.id })),
];

/* ------------------------------------------------------------------ *
 * 2. Combat honesty
 * ------------------------------------------------------------------ */

/**
 * The per-round win chance, re-derived **in this file** from the contract's prose rather
 * than called: `attack / (attack + defense)`, floored once and clamped to
 * `[COMBAT.minWinPct, COMBAT.maxWinPct]`.
 *
 * The point of writing it out again is that the resolver's own answer can then be compared
 * with an independent one. The *inputs* (the effective attack and defence) are built with
 * the engine's own readers — `veteranAttack`, `modifiedDefense`, `defenderBonusPct`,
 * `terrainDefenseBonus` — because those are the milestone's readers of the modifier table,
 * and a test that re-implemented them too would be asserting an arithmetic coincidence
 * rather than the rule.
 */
const contractScale = (value: number, pct: number): number =>
  Math.floor((value * (100 + Math.max(pct, 0))) / 100);

const contractWinPct = (attackValue: number, defenseValue: number): number => {
  const attack = Number.isFinite(attackValue) && attackValue > 0 ? Math.floor(attackValue) : 0;
  const defense = Number.isFinite(defenseValue) && defenseValue > 0 ? Math.floor(defenseValue) : 0;
  const total = attack + defense;
  if (total <= 0) return COMBAT.minWinPct;
  const raw = Math.floor((attack * COMBAT.rollBound) / total);
  if (raw < COMBAT.minWinPct) return COMBAT.minWinPct;
  return raw > COMBAT.maxWinPct ? COMBAT.maxWinPct : raw;
};

const terrainRowFor = (
  role: string,
): { readonly defenseBonus?: number; readonly defenseBonusPct?: number } => {
  const row = RULESET.terrains.find((terrain) => terrain.role === role);
  if (row === undefined) throw new Error(`the shipped catalog has no terrain with role "${role}"`);
  return row;
};

describe('2. combat honesty', () => {
  it('re-derives the per-round odds and agrees with the resolver, including at the clamps', () => {
    const rng = (): ReturnType<typeof import('@civts/core').seedRng> => seedRng(9);
    const cases: readonly {
      readonly attack: number;
      readonly defense: number;
      readonly bonusPct: number;
      readonly experience: number;
    }[] = [
      { attack: 1, defense: 2, bonusPct: 0, experience: 0 },
      { attack: 2, defense: 2, bonusPct: 0, experience: 0 },
      { attack: 3, defense: 3, bonusPct: 0, experience: 0 },
      { attack: 4, defense: 1, bonusPct: 0, experience: 0 },
      { attack: 1, defense: 1, bonusPct: 25, experience: 0 },
      { attack: 1, defense: 1, bonusPct: 50, experience: 0 },
      { attack: 2, defense: 3, bonusPct: 135, experience: 0 },
      { attack: 2, defense: 3, bonusPct: 0, experience: 1 },
      { attack: 2, defense: 3, bonusPct: 0, experience: COMBAT.maxExperience },
      { attack: 1_000_000, defense: 1, bonusPct: 0, experience: 0 },
      { attack: 1, defense: 1_000_000, bonusPct: 0, experience: 0 },
      { attack: 0, defense: 0, bonusPct: 0, experience: 0 },
    ];

    const thresholds: number[] = [];
    for (const testCase of cases) {
      const effectiveAttack = contractScale(
        testCase.attack,
        testCase.experience * COMBAT.veteranAttackPct,
      );
      const effectiveDefense = contractScale(testCase.defense, testCase.bonusPct);
      const expected = contractWinPct(effectiveAttack, effectiveDefense);
      thresholds.push(expected);

      // The engine's own readers produce the same intermediate values the contract names.
      expect(veteranAttack(COMBAT, testCase.attack, testCase.experience)).toBe(effectiveAttack);
      expect(modifiedDefense(testCase.defense, testCase.bonusPct)).toBe(effectiveDefense);
      expect(winPct(COMBAT, effectiveAttack, effectiveDefense)).toBe(expected);

      const outcome = resolveCombat({
        rules: COMBAT,
        attacker: {
          attack: testCase.attack,
          defense: 0,
          bonusPct: veteranBonusPct(COMBAT, testCase.experience),
        },
        defender: { attack: 0, defense: testCase.defense, bonusPct: testCase.bonusPct },
        attackerHitPoints: 3,
        defenderHitPoints: 3,
        rng: rng(),
        ...(testCase.experience === 0 ? {} : { experience: testCase.experience }),
      });
      expect(
        outcome.result.attackerWinPct,
        `attack ${String(testCase.attack)} vs defence ${String(testCase.defense)} +${String(testCase.bonusPct)}%`,
      ).toBe(expected);
      expect(outcome.result.attackerWinsBelow).toBe(expected);
      expect(outcome.result.rollBound).toBe(COMBAT.rollBound);
    }

    // Non-vacuity: the table spans both clamps and an unclamped middle, so "the clamp
    // exists" and "it is not always on" are both measured rather than assumed.
    expect(thresholds).toContain(COMBAT.maxWinPct);
    expect(thresholds).toContain(COMBAT.minWinPct);
    expect(thresholds.some((value) => value > COMBAT.minWinPct && value < COMBAT.maxWinPct)).toBe(
      true,
    );
  });

  it('sums the defender modifiers and floors ONCE — with a case where flooring twice differs', () => {
    // The M4c compounding rule, restated by M6 for combat: "all integer percentages summed
    // then applied ONCE ... flooring twice differs". The case is chosen so the two answers
    // really do differ: defence 3 with terrain 10% and fortification 25%.
    //   once:  floor(3 * (100 + 35) / 100) = 4
    //   twice: floor(floor(3 * 110 / 100) * 125 / 100) = floor(3 * 1.25) = 3
    const terrain = terrainRowFor('grassland');
    const terrainPct = terrainDefenseBonus(terrain);
    expect(terrainPct).toBeGreaterThan(0);

    const summed = defenderBonusPct(COMBAT, {
      terrainBonusPct: terrainPct,
      fortified: true,
      inCity: false,
      walls: false,
    });
    expect(summed).toBe(terrainPct + COMBAT.fortifyBonusPct);

    const defence = 3;
    const once = modifiedDefense(defence, summed);
    const twice = modifiedDefense(modifiedDefense(defence, terrainPct), COMBAT.fortifyBonusPct);
    expect(once).not.toBe(twice);
    expect(once).toBe(4);
    expect(twice).toBe(3);
    expect(contractWinPct(2, once)).not.toBe(contractWinPct(2, twice));

    // …and a real battle shows which of the two the *applier* uses. The attacker is the
    // shipped swordsman (attack 2), the defender a fortified spearman (defence 3) standing
    // on grassland, so nothing here is hand-written arithmetic the engine could disagree
    // with: the odds in the event are compared with the contract's own two answers.
    const board = buildWorld({
      terrain: { '11,10': 'grassland' },
      units: [
        { owner: 0, type: 'swordsman', x: 10, y: 10 },
        { owner: 1, type: 'spearman', x: 11, y: 10, fortified: true },
      ],
    });
    const attacker = mustUnitOn(board, at(10, 10));
    const applied = accept(board, attacker.owner, {
      type: 'AttackUnit',
      unitId: attacker.id,
      target: at(11, 10),
    });
    const combat = applied.events.find((event) => event.type === 'CombatResolved');
    if (combat === undefined) {
      throw new Error('the battle reported no CombatResolved event');
    }
    expect(combat.attackerWinPct).toBe(contractWinPct(unitRow('swordsman').attack, once));
    expect(combat.attackerWinPct).not.toBe(contractWinPct(unitRow('swordsman').attack, twice));
  });

  it('adds the city and walls bonuses only where the contract says, and only in a city', () => {
    // The other half of the modifier table: fortification, the city bonus and walls. Each
    // term is checked by *changing that one thing* on a board and reading the odds the
    // applier reports, so an accidental extra term fails here even if the sum looks right.
    const terrain = terrainRowFor('grassland');
    const terrainPct = terrainDefenseBonus(terrain);
    const attack = unitRow('swordsman').attack;
    const defense = unitRow('spearman').defense;

    const oddsOn = (config: WorldConfig): number => {
      const state = buildWorld(config);
      const attacker = mustUnitOn(state, at(10, 10));
      const applied = accept(state, attacker.owner, {
        type: 'AttackUnit',
        unitId: attacker.id,
        target: at(11, 10),
      });
      const combat = applied.events.find((event) => event.type === 'CombatResolved');
      if (combat === undefined) {
        throw new Error('the battle reported no CombatResolved event');
      }
      return combat.attackerWinPct;
    };

    const units: readonly Placement[] = [
      { owner: 0, type: 'swordsman', x: 10, y: 10 },
      { owner: 1, type: 'spearman', x: 11, y: 10 },
    ];

    const open = oddsOn({ units });
    expect(open).toBe(contractWinPct(attack, modifiedDefense(defense, terrainPct)));

    const fortified = oddsOn({
      units: [
        { owner: 0, type: 'swordsman', x: 10, y: 10 },
        { owner: 1, type: 'spearman', x: 11, y: 10, fortified: true },
      ],
    });
    expect(fortified).toBe(
      contractWinPct(attack, modifiedDefense(defense, terrainPct + COMBAT.fortifyBonusPct)),
    );

    const inCity = oddsOn({
      units,
      cities: [{ owner: 1, x: 11, y: 10, population: 3 }],
    });
    expect(inCity).toBe(
      contractWinPct(attack, modifiedDefense(defense, terrainPct + COMBAT.cityDefenseBonusPct)),
    );

    const walled = oddsOn({
      units,
      cities: [{ owner: 1, x: 11, y: 10, population: 3, buildings: ['walls'] }],
    });
    expect(walled).toBe(
      contractWinPct(
        attack,
        modifiedDefense(defense, terrainPct + COMBAT.cityDefenseBonusPct + COMBAT.wallsBonusPct),
      ),
    );

    // A fortification inside a city adds both terms — the summed table, in one battle.
    const both = oddsOn({
      units: [
        { owner: 0, type: 'swordsman', x: 10, y: 10 },
        { owner: 1, type: 'spearman', x: 11, y: 10, fortified: true },
      ],
      cities: [{ owner: 1, x: 11, y: 10, population: 3, buildings: ['walls'] }],
    });
    expect(both).toBe(
      contractWinPct(
        attack,
        modifiedDefense(
          defense,
          terrainPct + COMBAT.fortifyBonusPct + COMBAT.cityDefenseBonusPct + COMBAT.wallsBonusPct,
        ),
      ),
    );

    // Every step of the ladder really moved the odds: a bonus that changed nothing would
    // make this section pass for the wrong reason.
    expect(new Set([open, fortified, inCity, walled, both]).size).toBeGreaterThan(2);
  });

  it('gives the defender the ties, at the exact threshold, and keeps certainty out of reach', () => {
    const threshold = contractWinPct(4, 4);
    expect(threshold).toBe(50);

    // The comparison itself: a draw *equal* to the threshold is a defender win.
    expect(drawsWin(threshold, threshold)).toBe(false);
    expect(drawsWin(threshold - 1, threshold)).toBe(true);

    const fight = (roll: number): ReturnType<typeof resolveCombat> =>
      resolveCombat({
        rules: COMBAT,
        attacker: { attack: 4, defense: 0, bonusPct: 0 },
        defender: { attack: 0, defense: 4, bonusPct: 0 },
        attackerHitPoints: 1,
        defenderHitPoints: 1,
        rng: seedRng(3),
        static: [roll],
      });

    // End to end, one hit point each, so the single round is the whole battle: the draw
    // exactly at the threshold is the defender's round, and the attacker dies of it.
    const onTheTie = fight(threshold);
    expect(onTheTie.result.outcome).toBe('defender-wins');
    expect(onTheTie.result.attackerSurvives).toBe(false);
    expect(onTheTie.result.defenderSurvives).toBe(true);
    expect(onTheTie.result.rounds).toBe(1);
    expect(onTheTie.result.attackerLost).toBe(1);
    expect(onTheTie.result.defenderLost).toBe(0);
    // A battle that drew nothing from the stream must not advance it.
    expect(onTheTie.rng).toEqual(seedRng(3));

    const justBelow = fight(threshold - 1);
    expect(justBelow.result.outcome).toBe('attacker-wins');
    expect(justBelow.result.attackerSurvives).toBe(true);
    expect(justBelow.result.defenderSurvives).toBe(false);

    // The clamp: a certain result is unreachable, which is what makes a balance sweep over
    // this region measure something.
    expect(winPct(COMBAT, 1_000_000, 1)).toBe(COMBAT.maxWinPct);
    expect(COMBAT.maxWinPct).toBeLessThan(COMBAT.rollBound);
    expect(winPct(COMBAT, 0, 0)).toBe(COMBAT.minWinPct);
    expect(winPct(COMBAT, Number.NaN, 5)).toBe(COMBAT.minWinPct);
  });

  it('takes its dice from the world RNG, and reproduces the same battle from the same state', () => {
    const boardWith = (seed: number): GameState =>
      buildWorld({
        seed,
        units: [
          { owner: 0, type: 'warrior', x: 10, y: 10 },
          { owner: 1, type: 'warrior', x: 11, y: 10 },
        ],
      });

    const battleOf = (
      state: GameState,
    ): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
      const attacker = mustUnitOn(state, at(10, 10));
      return accept(state, attacker.owner, {
        type: 'AttackUnit',
        unitId: attacker.id,
        target: at(11, 10),
      });
    };

    // Same board, same battle: the whole point of a state hash.
    const firstBoard = boardWith(1);
    const first = battleOf(firstBoard);
    const second = battleOf(boardWith(1));
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toEqual(second.events);

    // The dice really came from the world's stream, and the stream really moved: the
    // battle's numbers are the resolver's own answer for the inputs the *applier* used,
    // drawn from the board's RNG state.
    const attacker = mustUnitOn(firstBoard, at(10, 10));
    const defender = mustUnitOn(firstBoard, at(11, 10));
    const independent = resolveCombat({
      rules: COMBAT,
      attacker: {
        attack: unitRow('warrior').attack,
        defense: 0,
        bonusPct: veteranBonusPct(COMBAT, 0),
      },
      defender: {
        attack: unitRow('warrior').attack,
        defense: unitRow('warrior').defense,
        bonusPct: defenderBonusPct(COMBAT, {
          terrainBonusPct: terrainDefenseBonus(
            RULESET.terrains.find(
              (row) => row.id === terrainAtIndex(firstBoard.map, Number(defender.tile)),
            ) ?? {},
          ),
          fortified: false,
          inCity: false,
          walls: false,
        }),
      },
      attackerHitPoints: hitPointsLeftOf(attacker),
      defenderHitPoints: hitPointsLeftOf(defender),
      rng: firstBoard.rng,
    });
    expect(independent.result.attackerWinPct).toBe(
      contractWinPct(unitRow('warrior').attack, unitRow('warrior').defense),
    );
    expect(first.state.rng).toEqual(independent.rng);
    expect(first.state.rng).not.toEqual(firstBoard.rng);

    // Over a spread of seeds the *odds* are one number — two shipped warriors are equal, so
    // the threshold cannot move — while the battle itself is not always the same battle.
    // That pair is the sharpest reading of "the dice come from the seed": a resolver that
    // ignored the RNG would give one battle for every seed, and a resolver that invented
    // odds per seed would move the threshold.
    const odds = new Set<number>();
    const rounds = new Set<number>();
    const hashes = new Set<string>();
    const losses = new Set<string>();
    for (let seed = 1; seed <= 12; seed += 1) {
      const applied = battleOf(boardWith(seed));
      const combat = applied.events.find((event) => event.type === 'CombatResolved');
      if (combat === undefined) {
        throw new Error('a battle reported no CombatResolved event');
      }
      odds.add(combat.attackerWinPct);
      rounds.add(combat.rounds);
      hashes.add(hashValue(applied.state));
      for (const unit of applied.state.units) {
        losses.add(`${String(unit.id)}:${String(hitPointsLeftOf(unit))}`);
      }
    }
    expect(odds.size).toBe(1);
    expect(rounds.size).toBeGreaterThan(1);
    expect(hashes.size).toBeGreaterThan(1);
    expect(losses.size).toBeGreaterThan(1);
  });

  it('never raises a hit-point count and never creates a unit', () => {
    // M6's conservation rule, measured rather than trusted: over a sweep of boards and
    // seeds, no battle may leave a combatant with more hit points than it started with, the
    // total may only fall, and the roster may only shrink.
    let battles = 0;
    let deaths = 0;
    const pairings: readonly (readonly [string, string])[] = [
      ['warrior', 'warrior'],
      ['swordsman', 'spearman'],
      ['archer', 'warrior'],
      ['warrior', 'spearman'],
      ['horseman', 'archer'],
    ];

    for (let seed = 1; seed <= 16; seed += 1) {
      for (const [attackerType, defenderType] of pairings) {
        const board = buildWorld({
          seed,
          units: [
            { owner: 0, type: attackerType, x: 10, y: 10 },
            { owner: 1, type: defenderType, x: 11, y: 10 },
          ],
        });
        const attacker = mustUnitOn(board, at(10, 10));
        const beforeHits = hitsOf(board);
        const beforeCount = board.units.length;
        const beforeById = new Map(
          board.units.map((unit) => [Number(unit.id), hitPointsLeftOf(unit)] as const),
        );

        const applied = accept(board, attacker.owner, {
          type: 'AttackUnit',
          unitId: attacker.id,
          target: at(11, 10),
        });
        const where = `${attackerType} vs ${defenderType} on seed ${String(seed)}`;

        expect(
          hitsOf(applied.state),
          `${where}: the battle raised the world's total hit points`,
        ).toBeLessThanOrEqual(beforeHits);
        expect(
          applied.state.units.length,
          `${where}: the battle created a unit`,
        ).toBeLessThanOrEqual(beforeCount);

        for (const unit of applied.state.units) {
          const was = beforeById.get(Number(unit.id));
          if (was === undefined)
            throw new Error(
              `${where}: unit ${String(unit.id)} was not on the board before the battle`,
            );
          expect(
            hitPointsLeftOf(unit),
            `${where}: unit ${String(unit.id)} gained hit points`,
          ).toBeLessThanOrEqual(was);
          const maximum = maxHitPointsOf(unitDef(VIEW, unit.type), 1);
          expect(hitPointsLeftOf(unit)).toBeLessThanOrEqual(maximum);
          expect(hitPointsLeftOf(unit)).toBeGreaterThanOrEqual(1);
        }

        // The event's own losses account for the difference exactly: two sides, no third.
        const combat = applied.events.find((event) => event.type === 'CombatResolved');
        if (combat === undefined) {
          throw new Error(`${where}: the battle reported no CombatResolved event`);
        }
        const lost = beforeHits - hitsOf(applied.state);
        expect(lost).toBe(combat.attackerLost + combat.defenderLost);
        if (!combat.attackerSurvives || !combat.defenderSurvives) deaths += 1;

        // And the invariant the registry carries for exactly this rule agrees.
        expect(violationsOf(applied.state, board, applied.events)).toEqual([]);
        battles += 1;
      }
    }

    expect(battles).toBeGreaterThan(50);
    expect(
      deaths,
      'no battle in the sweep killed anyone, so the conservation case is untested',
    ).toBeGreaterThan(0);
  });

  /**
   * The chance the attacker wins the whole battle, from its *advertised per-round* chance and
   * the two hit-point totals. One side loses one hit point per round, so the attacker wins when
   * it lands `defenderHitPoints` round-wins before the defender lands `attackerHitPoints` — the
   * negative-binomial sum over how many rounds the attacker loses on the way:
   *
   *   P = Σ_{j < attackerHitPoints} C(defenderHitPoints - 1 + j, j) · p^defenderHitPoints · (1-p)^j
   *
   * This is written here, from the contract's rules, rather than read from the engine: it is
   * the independent model the measured outcomes are compared against. It is also the assertion
   * that a round costs exactly `COMBAT.damagePerRound` and that the fight runs to a death — a
   * resolver that stopped early, or dealt two points a round, would not fit.
   */
  const battleWinProbability = (
    perRoundPct: number,
    attackerHitPoints: number,
    defenderHitPoints: number,
  ): number => {
    const p = perRoundPct / 100;
    const q = 1 - p;
    const choose = (n: number, k: number): number => {
      let value = 1;
      for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i;
      return value;
    };
    let total = 0;
    for (let losses = 0; losses < attackerHitPoints; losses += 1) {
      total +=
        choose(defenderHitPoints - 1 + losses, losses) * p ** defenderHitPoints * q ** losses;
    }
    return total;
  };

  it('lands where its per-round odds and the hit points say it should, over a fixed seed set', () => {
    // M6's acceptance list asks for "the exact per-round win chance **and the distribution over
    // a fixed seed set**". Both halves are here: every battle advertises the *same* chance,
    // derived from the shipped rows and the contract's arithmetic, and the number of battles the
    // attacker actually wins over 60 fixed seeds sits within four binomial standard deviations
    // of the chance the *battle* model predicts. A resolver that ignored the dice lands on 0 or
    // 60, and one whose damage or stopping rule differed does not fit the model at all.
    const seeds = 60;
    const pairings: readonly {
      readonly name: string;
      readonly attacker: string;
      readonly defender: string;
    }[] = [
      { name: 'warrior vs warrior (the even fight)', attacker: 'warrior', defender: 'warrior' },
      { name: 'archer vs warrior (the favourite)', attacker: 'archer', defender: 'warrior' },
    ];
    const terrainPct = terrainDefenseBonus(terrainRowFor('grassland'));

    for (const pairing of pairings) {
      const attackerRow = unitRow(pairing.attacker);
      const defenderRow = unitRow(pairing.defender);
      // The odds, re-derived from the shipped rows and the contract's own arithmetic: the
      // attacker's veteran bonus (no experience) against the defender's terrain bonus on the
      // grassland this board is filled with.
      const predicted = contractWinPct(
        contractScale(attackerRow.attack, 0),
        contractScale(defenderRow.defense, terrainPct),
      );
      const battleChance = battleWinProbability(
        predicted,
        fullHitPoints(attackerRow),
        fullHitPoints(defenderRow),
      );

      let wins = 0;
      for (let seed = 1; seed <= seeds; seed += 1) {
        const board = buildWorld({
          seed,
          units: [
            { owner: 0, type: pairing.attacker, x: 10, y: 10 },
            { owner: 1, type: pairing.defender, x: 11, y: 10 },
          ],
        });
        const attacker = mustUnitOn(board, at(10, 10));
        const applied = accept(board, attacker.owner, {
          type: 'AttackUnit',
          unitId: attacker.id,
          target: at(11, 10),
        });
        const combat = combatEventOf(applied.events);
        // Every seed advertises the same chance — the odds come from the stats, not the dice.
        expect(combat.attackerWinPct, pairing.name).toBe(predicted);
        // The event reports the outcome in the same terms the odds are stated in: a win means
        // the defender was destroyed, so `outcome` and `defenderSurvives` cannot disagree.
        expect(combat.outcome === 'attacker-wins').toBe(!combat.defenderSurvives);
        expect(combat.attackerSurvives).toBe(combat.outcome === 'attacker-wins');
        if (combat.attackerSurvives) wins += 1;
      }

      const expected = battleChance * seeds;
      const sigma = Math.sqrt(seeds * battleChance * (1 - battleChance));
      const slack = Math.max(4, Math.ceil(4 * sigma));
      expect(
        wins,
        `${pairing.name}: won ${String(wins)}/${String(seeds)}; the per-round chance is ` +
          `${String(predicted)}% and the battle model predicts ${expected.toFixed(1)}`,
      ).toBeGreaterThan(expected - slack);
      expect(wins).toBeLessThan(expected + slack);

      // Non-vacuity: neither side sweeps the set, so the dice really decide these battles.
      expect(wins).toBeGreaterThan(0);
      expect(wins).toBeLessThan(seeds);
      // …and the two pairings are not the same fight: the favourite wins more often than the
      // even fight does, which is the direction of the whole modifier system.
      if (pairing.defender === 'warrior' && pairing.attacker === 'archer') {
        expect(wins).toBeGreaterThan(seeds / 2);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. No live unit at 0 hit points, and no trace of a destroyed one
 * ------------------------------------------------------------------ */

describe('3. a unit at 0 hit points is destroyed, and leaves no trace', () => {
  it('wounds by subtraction, removes at 0, and never stores 0', () => {
    const board = buildWorld({
      units: [
        { owner: 0, type: 'warrior', x: 10, y: 10, hp: 3 },
        { owner: 1, type: 'warrior', x: 11, y: 10 },
      ],
    });
    const victim = mustUnitOn(board, at(10, 10));
    expect(maxHitPointsOf(unitDef(VIEW, victim.type), 1)).toBe(3);

    const wounded = woundUnit(board, victim.id, 1);
    if (wounded === undefined) throw new Error('the wound found no unit to wound');
    expect(hitPointsLeftOf(mustUnit(wounded.state, victim.id))).toBe(2);
    expect(wounded.destroyed).toBe(false);

    const lethal = woundUnit(wounded.state, victim.id, 2);
    if (lethal === undefined) throw new Error('the lethal wound found no unit to wound');
    expect(lethal.destroyed).toBe(true);
    expect(unitById(lethal.state, victim.id)).toBeUndefined();
    expect(lethal.state.units.some((unit) => Number(unit.id) === Number(victim.id))).toBe(false);
    expect(unitsOnTile(lethal.state, at(10, 10))).toEqual([]);
    expect(hitsOf(lethal.state)).toBe(3);

    // A wound of nothing is not a rebuild: the unit comes back unchanged, and no key
    // appears (`experience`/`fortified` are absent, never present-and-undefined).
    const noop = woundUnit(lethal.state, mustUnitOn(lethal.state, at(11, 10)).id, 0);
    if (noop === undefined) throw new Error('the zero wound found no unit');
    for (const unit of noop.state.units) {
      expect('experience' in unit).toBe(false);
      expect('fortified' in unit).toBe(false);
    }
    expect(() => hashValue(noop.state)).not.toThrow();
  });

  it('leaves no trace of a destroyed unit anywhere in the state', () => {
    let destroyed = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      const board = buildWorld({
        seed,
        units: [
          { owner: 0, type: 'swordsman', x: 10, y: 10 },
          { owner: 1, type: 'warrior', x: 11, y: 10 },
        ],
      });
      const attacker = mustUnitOn(board, at(10, 10));
      const defender = mustUnitOn(board, at(11, 10));
      const applied = accept(board, attacker.owner, {
        type: 'AttackUnit',
        unitId: attacker.id,
        target: at(11, 10),
      });

      const gone = [attacker.id, defender.id].filter(
        (id) => unitById(applied.state, id) === undefined,
      );
      if (gone.length === 0) continue;
      destroyed += gone.length;

      for (const id of gone) {
        // The places a corpse could linger: the roster, the tile it fought on, and the tile
        // it fought from. `unitsOnTile` reads `state.units`, so the first two readings are
        // two spellings of one answer — which is exactly why both are asserted.
        expect(unitById(applied.state, id)).toBeUndefined();
        for (const unit of applied.state.units) expect(unit.id).not.toBe(id);
        expect(unitsOnTile(applied.state, at(11, 10)).some((unit) => unit.id === id)).toBe(false);
        expect(unitsOnTile(applied.state, at(10, 10)).some((unit) => unit.id === id)).toBe(false);
        expect(unitsOnTile(applied.state, at(11, 10))).toEqual(
          applied.state.units.filter((unit) => unit.tile === at(11, 10)),
        );
        // The death is reported, with a reason, and the world agrees with the report.
        const death = applied.events.find(
          (event) => event.type === 'UnitDestroyed' && event.unitId === id,
        );
        if (death === undefined || death.type !== 'UnitDestroyed') {
          throw new Error(`unit ${String(id)} vanished with no UnitDestroyed event`);
        }
        expect(death.reason).toBe('combat');
        expect(death.byUnitId).toBeDefined();
      }

      expect(violationsOf(applied.state, board, applied.events)).toEqual([]);
      expect(() => hashValue(applied.state)).not.toThrow();
    }
    expect(destroyed, 'no unit died in the sweep, so the trace checks are vacuous').toBeGreaterThan(
      0,
    );
  });

  it('promotes only a winner, only by one level, and never past the cap', () => {
    // Three rules in one sweep, over a spread of seeds so both winners occur: a win promotes
    // the winner by exactly one level; a loss promotes nobody; and at the cap a win promotes
    // nobody either (no event for a promotion that did not happen).
    const board = (seed: number, experience: number): GameState =>
      buildWorld({
        seed,
        units: [
          { owner: 0, type: 'warrior', x: 10, y: 10, ...(experience === 0 ? {} : { experience }) },
          { owner: 1, type: 'warrior', x: 11, y: 10 },
        ],
      });

    let attackerWins = 0;
    let defenderWins = 0;
    let promotionsBelowCap = 0;

    for (let seed = 1; seed <= 24; seed += 1) {
      const before = board(seed, COMBAT.maxExperience - 1);
      const attacker = mustUnitOn(before, at(10, 10));
      expect(attacker.experience).toBe(COMBAT.maxExperience - 1);
      const applied = accept(before, attacker.owner, {
        type: 'AttackUnit',
        unitId: attacker.id,
        target: at(11, 10),
      });
      const combat = applied.events.find((event) => event.type === 'CombatResolved');
      if (combat === undefined) {
        throw new Error('the battle reported no CombatResolved event');
      }
      const promoted = applied.events.filter((event) => event.type === 'UnitPromoted');

      if (combat.attackerSurvives) {
        attackerWins += 1;
        // The attacker won one level below the cap: it is promoted, by exactly one, with an
        // event that agrees with the state.
        const after = mustUnit(applied.state, attacker.id);
        expect(after.experience).toBe(COMBAT.maxExperience);
        const event = promoted.find((candidate) => candidate.unitId === attacker.id);
        if (event === undefined) {
          throw new Error('the winner of a battle was not promoted');
        }
        expect(event.experience).toBe(COMBAT.maxExperience);
        expect(event.maxExperience).toBe(COMBAT.maxExperience);
        promotionsBelowCap += 1;
      } else {
        defenderWins += 1;
        // The attacker lost. M6: "Losing a combat that the unit survives grants nothing" —
        // and here it did not survive, so there is nothing to grant in any case. No event may
        // name it, and the defender (which won) is the only candidate for one.
        expect(promoted.some((candidate) => candidate.unitId === attacker.id)).toBe(false);
      }
      expect(
        applied.state.units.every((unit) => (unit.experience ?? 0) <= COMBAT.maxExperience),
      ).toBe(true);
      expect(violationsOf(applied.state, before, applied.events)).toEqual([]);
    }
    expect(attackerWins, 'no seed in the sweep let the attacker win').toBeGreaterThan(0);
    expect(defenderWins, 'no seed in the sweep let the defender win').toBeGreaterThan(0);
    expect(promotionsBelowCap).toBe(attackerWins);

    // At the cap, the same win promotes nobody and emits nothing — a promotion event for a
    // level that did not rise would be a lie in the stream.
    let cappedWins = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      const before = board(seed, COMBAT.maxExperience);
      const attacker = mustUnitOn(before, at(10, 10));
      const applied = accept(before, attacker.owner, {
        type: 'AttackUnit',
        unitId: attacker.id,
        target: at(11, 10),
      });
      const combat = applied.events.find((event) => event.type === 'CombatResolved');
      if (combat === undefined) {
        throw new Error('the battle reported no CombatResolved event');
      }
      const after = unitById(applied.state, attacker.id);
      if (combat.attackerSurvives && after !== undefined) {
        cappedWins += 1;
        expect(after.experience).toBe(COMBAT.maxExperience);
        expect(
          applied.events.some(
            (event) => event.type === 'UnitPromoted' && event.unitId === attacker.id,
          ),
        ).toBe(false);
      }
    }
    expect(cappedWins, 'no capped attacker won, so the cap case is untested').toBeGreaterThan(0);
  });

  it('fires each M6 invariant on the state it exists to catch', () => {
    // An invariant with no fire case proves nothing: it is indistinguishable from a check
    // that always returns "fine". Each M6 invariant is therefore shown to *fire* on a state
    // that breaks it, and to stay quiet on a healthy one.
    const healthy = buildWorld({
      units: [
        { owner: 0, type: 'warrior', x: 10, y: 10 },
        { owner: 1, type: 'warrior', x: 11, y: 10 },
      ],
    });
    expect(violationsOf(healthy)).toEqual([]);

    const warp = (mutate: (unit: Unit) => Unit): GameState => ({
      ...healthy,
      units: healthy.units.map(mutate),
    });

    const dead = warp((unit) =>
      unit.owner === asPlayerId(0) ? { ...unit, hitPointsLeft: 0 } : unit,
    );
    expect(violationsOf(dead).some((line) => line.startsWith('unit-hit-points-above-zero:'))).toBe(
      true,
    );

    const overfull = warp((unit) =>
      unit.owner === asPlayerId(0) ? { ...unit, hitPointsLeft: 99 } : unit,
    );
    expect(
      violationsOf(overfull).some((line) => line.startsWith('unit-hit-points-in-range:')),
    ).toBe(true);

    const overpromoted = warp((unit) =>
      unit.owner === asPlayerId(0) ? { ...unit, experience: COMBAT.maxExperience + 1 } : unit,
    );
    expect(
      violationsOf(overpromoted).some((line) => line.startsWith('unit-experience-in-range:')),
    ).toBe(true);

    // A unit standing inside a city it does not own: the state capture exists to make
    // unreachable.
    const occupied = buildWorld({
      units: [{ owner: 0, type: 'warrior', x: 11, y: 10 }],
      cities: [{ owner: 1, x: 11, y: 10, population: 3 }],
    });
    expect(
      violationsOf(occupied).some((line) => line.startsWith('unit-not-inside-foreign-city:')),
    ).toBe(true);

    // Conservation is a *transition* property: with a previous snapshot where the unit had
    // fewer hit points and an event claiming a battle, a "gain" is reported.
    const attacker = mustUnitOn(healthy, at(10, 10));
    const defender = mustUnitOn(healthy, at(11, 10));
    const battleEvent: GameEvent = {
      type: 'CombatResolved',
      attackerId: attacker.id,
      attackerOwner: attacker.owner,
      defenderId: defender.id,
      defenderOwner: defender.owner,
      target: at(11, 10),
      outcome: 'attacker-wins',
      rounds: 1,
      attackerLost: 0,
      defenderLost: 3,
      attackerWinPct: 50,
      attackerSurvives: true,
      defenderSurvives: false,
    };
    const woundedBefore = warp((unit) =>
      unit.id === attacker.id ? { ...unit, hitPointsLeft: 1 } : unit,
    );
    const healed = violationsOf(healthy, woundedBefore, [battleEvent]);
    expect(healed.some((line) => line.startsWith('combat-hit-point-conservation:'))).toBe(true);

    // A `UnitDestroyed` event whose unit is still in the world: the same invariant's other
    // reading, and the one a resolver that forgot to remove a corpse would trip.
    const corpseEvent: GameEvent = {
      type: 'UnitDestroyed',
      unitId: defender.id,
      owner: defender.owner,
      unitType: defender.type,
      tile: defender.tile,
      reason: 'combat',
      byUnitId: attacker.id,
      byOwner: attacker.owner,
    };
    expect(
      violationsOf(healthy, healthy, [corpseEvent]).some((line) =>
        line.startsWith('unit-hit-points-above-zero:'),
      ),
    ).toBe(true);

    // And the registry really carries all six M6 invariants, by name.
    for (const name of [
      'unit-hit-points-in-range',
      'unit-hit-points-above-zero',
      'unit-experience-in-range',
      'unit-not-inside-foreign-city',
      'captured-city-consistent',
      'combat-hit-point-conservation',
    ]) {
      expect(invariantNamed(name).description.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. Capture integrity
 * ------------------------------------------------------------------ */

/** The wonder the shipped catalog carries, read from the content rather than named here. */
const WONDER: BuildingDef = (() => {
  const row = buildingCatalog(RULESET).find((building) => isWonder(building));
  if (row === undefined) throw new Error('the shipped catalog declares no wonder');
  return row;
})();

/** The independent destruction rule: maintenance descending, then list position descending. */
const expectedSack = (city: City, catalog: readonly BuildingDef[]): readonly string[] =>
  city.buildings
    .map((id, index) => ({
      id: String(id),
      index,
      maintenance:
        catalog.find((row) => row.id === id) === undefined
          ? 0
          : maintenanceOf(catalog.find((row) => row.id === id) ?? buildingRow('granary')),
      wonder:
        catalog.find((row) => row.id === id) !== undefined &&
        isWonder(catalog.find((row) => row.id === id) ?? buildingRow('granary')),
    }))
    .filter((entry) => !entry.wonder)
    .sort((a, b) => b.maintenance - a.maintenance || b.index - a.index)
    .map((entry) => entry.id);

type CombatEvent = Extract<GameEvent, { readonly type: 'CombatResolved' }>;

/** The one combat event of an event list, or a thrown error when the battle did not happen. */
const combatEventOf = (events: readonly GameEvent[]): CombatEvent => {
  const event = events.find((candidate) => candidate.type === 'CombatResolved');
  if (event === undefined) {
    throw new Error('the attack emitted no CombatResolved event');
  }
  return event;
};

const captureEventOf = (
  events: readonly GameEvent[],
): Extract<GameEvent, { readonly type: 'CityCaptured' }> => {
  const event = events.find((candidate) => candidate.type === 'CityCaptured');
  if (event === undefined) {
    throw new Error('the attack emitted no CityCaptured event');
  }
  return event;
};

describe('4. capture integrity', () => {
  const cityWithBuildings = (population: number, buildings: readonly string[]): GameState =>
    buildWorld({
      units: [
        { owner: 0, type: 'warrior', x: 10, y: 10 },
        { owner: 1, type: 'warrior', x: 30, y: 30 },
      ],
      cities: [{ owner: 1, x: 11, y: 10, population, buildings }],
      roads: [
        [
          [10, 11],
          [11, 11],
        ],
      ],
    });

  it('transfers the city, halves the population and sacks deterministically without the wonder', () => {
    const board = cityWithBuildings(5, ['granary', 'barracks', 'library', 'pyramids']);
    const before = mustCity(board, asPlayerId(1));
    expect(before.population).toBe(5);
    expect(before.buildings).toContain(WONDER.id);

    const attacker = mustUnitOn(board, at(10, 10));
    const applied = accept(board, attacker.owner, {
      type: 'AttackUnit',
      unitId: attacker.id,
      target: at(11, 10),
    });
    const event = captureEventOf(applied.events);

    // The event says what happened, in the engine's own words.
    expect(event.cityId).toBe(before.id);
    expect(event.from).toBe(asPlayerId(1));
    expect(event.to).toBe(asPlayerId(0));
    expect(event.tile).toBe(before.tile);
    expect(event.name).toBe(before.name);
    expect(event.population).toBe(capturedPopulation(CAPTURE, before.population));
    expect(event.population).toBe(2);

    // …and the state agrees with it, field by field.
    const after = mustCity(applied.state, asPlayerId(0));
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.tile).toBe(before.tile);
    expect(after.owner).toBe(asPlayerId(0));
    expect(after.population).toBe(event.population);

    // The sack list is the engine's, and it is re-derived here from the catalog's own
    // maintenance figures: descending bill, ties by descending list position, wonder kept.
    expect(event.destroyed).toEqual(expectedSack(before, buildingCatalog(RULESET)));
    expect(event.destroyed).toEqual(['library', 'barracks', 'granary']);
    expect(event.destroyed).not.toContain(WONDER.id);
    for (const destroyed of event.destroyed) expect([...after.buildings]).not.toContain(destroyed);
    expect([...after.buildings]).toEqual([WONDER.id]);
    expect(maintenanceOf(buildingRow('library'))).toBe(maintenanceOf(buildingRow('barracks')));

    // The queue is cleared and nothing is being built: the head is *absent*, not `undefined`.
    expect(after.queue).toEqual([]);
    expect('production' in after).toBe(false);
    expect(after.workedTiles).toEqual([]);

    // Untouched by design: food, shields, tile improvements and roads.
    expect(after.foodBox).toBe(before.foodBox);
    expect(after.shields).toBe(before.shields);
    expect(applied.state.improvements).toEqual(board.improvements);
    expect(applied.state.improvements.length).toBeGreaterThan(0);

    // A capture is not a battle: no `CombatResolved`, no promotion (M6 grants a level for
    // winning a *combat*), and the attacker's whole turn is spent all the same.
    expect(applied.events.some((candidate) => candidate.type === 'CombatResolved')).toBe(false);
    expect(applied.events.some((candidate) => candidate.type === 'UnitPromoted')).toBe(false);
    expect(mustUnit(applied.state, attacker.id).movementLeft).toBe(0);

    // The city is not razed and the world is coherent at the turn boundary.
    expect(applied.state.cities).toHaveLength(1);
    expect(violationsOf(applied.state, board, applied.events)).toEqual([]);
    expect(() => hashValue(applied.state)).not.toThrow();
  });

  it('never reduces a city below one citizen, and a second sack takes nothing more', () => {
    // The exploitability corner: a population of 1 halved is still 1, so capture is not a
    // way to delete a city; and a city whose only remaining building is a wonder has
    // nothing left to lose, so taking it back and forth cannot destroy the wonder either.
    const board = buildWorld({
      units: [
        { owner: 0, type: 'warrior', x: 10, y: 10 },
        { owner: 1, type: 'warrior', x: 12, y: 10 },
      ],
      cities: [{ owner: 1, x: 11, y: 10, population: 1, buildings: ['pyramids'] }],
    });

    const first = accept(board, asPlayerId(0), {
      type: 'AttackUnit',
      unitId: mustUnitOn(board, at(10, 10)).id,
      target: at(11, 10),
    });
    const taken = mustCity(first.state, asPlayerId(0));
    expect(taken.population).toBe(1);
    expect(captureEventOf(first.events).population).toBe(1);
    // The first sack had the wonder and nothing else in the city, so it destroyed nothing.
    expect(captureEventOf(first.events).destroyed).toEqual([]);
    expect([...taken.buildings]).toEqual([WONDER.id]);

    // …and the other civilization takes it straight back. The second sack destroys nothing
    // (there is nothing but the wonder), the city keeps its identity, and the world is
    // still coherent — which is the assertion that "no invariant is violable merely because
    // ownership changed".
    const second = accept(first.state, asPlayerId(1), {
      type: 'AttackUnit',
      unitId: mustUnitOn(first.state, at(12, 10)).id,
      target: at(11, 10),
    });
    const retaken = mustCity(second.state, asPlayerId(1));
    expect(retaken.id).toBe(taken.id);
    expect(retaken.population).toBe(1);
    expect(captureEventOf(second.events).destroyed).toEqual([]);
    expect([...retaken.buildings]).toEqual([WONDER.id]);
    expect(second.state.cities.filter((city) => city.buildings.includes(WONDER.id))).toHaveLength(
      1,
    );
    expect(violationsOf(second.state, first.state, second.events)).toEqual([]);
  });

  it('lets a barbarian band capture a city, and keeps the world coherent afterwards', () => {
    // "Barbarians may capture cities; that is the point of barbarians. A captured city's
    // fate must be reflected in the invariants — after capture, no invariant may be
    // violable merely because ownership changed." The band is placed by the engine's own
    // `spawnUnit` and the attack goes through the applier, so this is the same command path
    // a civilization uses.
    const board = buildWorld({
      barbarians: true,
      units: [{ owner: 0, type: 'warrior', x: 30, y: 30 }],
      cities: [{ owner: 0, x: 11, y: 10, population: 3, buildings: ['granary', 'pyramids'] }],
    });
    const barbarian = board.players.find((player) => player.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('the board has no barbarian player');

    const band = spawnUnit(board, unitRow('warrior'), barbarian.id, at(10, 10));
    const applied = accept(band.state, barbarian.id, {
      type: 'AttackUnit',
      unitId: band.unit.id,
      target: at(11, 10),
    });
    const event = captureEventOf(applied.events);
    expect(event.from).toBe(asPlayerId(0));
    expect(event.to).toBe(barbarian.id);

    const captured = mustCity(applied.state, barbarian.id);
    expect(captured.population).toBe(capturedPopulation(CAPTURE, 3));
    expect([...captured.buildings]).toEqual([WONDER.id]);
    expect(event.destroyed).toEqual(['granary']);

    // The invariants are the point of this test: a city that changed hands to the player
    // with no economy must not break a single registered property.
    expect(violationsOf(applied.state, band.state, applied.events)).toEqual([]);
    expect(() => hashValue(applied.state)).not.toThrow();

    // A *quiet* turn after the capture is the harder case — the city now belongs to the
    // barbarians and the pipeline runs for it — so it is measured too.
    const turned = advanceTurn(applied.state, VIEW);
    expect(turned.events.some((candidate) => candidate.type === 'CityCaptured')).toBe(false);
    expect(violationsOf(turned.state, applied.state, turned.events)).toEqual([]);
    expect(mustCity(turned.state, barbarian.id).population).toBe(captured.population);
  });

  it('refuses to capture a city that is defended, and to attack one it owns', () => {
    const defended = buildWorld({
      units: [
        { owner: 0, type: 'warrior', x: 10, y: 10 },
        { owner: 1, type: 'warrior', x: 11, y: 10 },
      ],
      cities: [{ owner: 1, x: 11, y: 10, population: 3 }],
    });
    const attacker = mustUnitOn(defended, at(10, 10));
    const applied = accept(defended, attacker.owner, {
      type: 'AttackUnit',
      unitId: attacker.id,
      target: at(11, 10),
    });
    // A battle, not a capture: the city did not change hands even though the attacker won
    // (the defender died) — the *next* attack is the one that would take it.
    expect(applied.events.some((event) => event.type === 'CombatResolved')).toBe(true);
    expect(applied.events.some((event) => event.type === 'CityCaptured')).toBe(false);
    expect(mustCity(applied.state, asPlayerId(1)).owner).toBe(asPlayerId(1));

    const own = buildWorld({
      units: [{ owner: 0, type: 'warrior', x: 10, y: 10 }],
      cities: [{ owner: 0, x: 11, y: 10, population: 3 }],
    });
    const ownAttacker = mustUnitOn(own, at(10, 10));
    expect(
      refusalOf(own, ownAttacker.owner, {
        type: 'AttackUnit',
        unitId: ownAttacker.id,
        target: at(11, 10),
      }).kind,
    ).toBe('nothing-to-attack');
  });
});

/* ------------------------------------------------------------------ *
 * 5. Barbarians: deterministic engine behaviour with no policy and no economy
 * ------------------------------------------------------------------ */

describe('5. barbarian determinism', () => {
  const bandBoard = (seed: number): GameState => {
    const board = buildWorld({
      seed,
      barbarians: true,
      units: [{ owner: 0, type: 'warrior', x: 11, y: 10 }],
      cities: [{ owner: 0, x: 20, y: 20, population: 3 }],
    });
    const barbarian = board.players.find((player) => player.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('the board has no barbarian player');
    // The band is spawned by the engine's own helper, which is also what a hut reward uses.
    const spawned = spawnUnit(board, unitRow('warrior'), barbarian.id, at(10, 10));
    return spawned.state;
  };

  const barbariansOf = (state: GameState): readonly Unit[] => {
    const barbarian = state.players.find((player) => player.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('this board has no barbarian player');
    return state.units.filter((unit) => unit.owner === barbarian.id);
  };

  it('does the same thing twice from the same board', () => {
    const first = advanceTurn(bandBoard(5), VIEW);
    const second = advanceTurn(bandBoard(5), VIEW);
    expect(hashValue(second.state)).toBe(hashValue(first.state));
    expect(second.events).toEqual(first.events);
    expect(violationsOf(first.state, bandBoard(5), first.events)).toEqual([]);
  });

  it('attacks what stands beside it, before the refill, and takes no dice of its own', () => {
    const board = bandBoard(5);
    const barbarian = board.players.find((player) => player.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('the board has no barbarian player');
    const before = mustUnitOn(board, at(10, 10), barbarian.id);
    const victim = mustUnitOn(board, at(11, 10));
    const victimHits = hitPointsLeftOf(victim);

    const turned = advanceTurn(board, VIEW);
    const combat = turned.events.find((event) => event.type === 'CombatResolved');
    if (combat === undefined) {
      throw new Error('the barbarian step fought nobody although a unit stood beside the band');
    }
    expect(combat.attackerId).toBe(before.id);
    expect(combat.attackerOwner).toBe(barbarian.id);
    expect(combat.defenderId).toBe(victim.id);

    // The victim really lost the hit points the event reports (or died of them).
    const afterVictim = unitById(turned.state, victim.id);
    if (afterVictim === undefined) {
      expect(combat.defenderSurvives).toBe(false);
      expect(combat.defenderLost).toBeGreaterThanOrEqual(victimHits);
    } else {
      expect(hitPointsLeftOf(afterVictim)).toBe(victimHits - combat.defenderLost);
    }

    // **The pipeline position, measured.** The step runs after the money loop and *before*
    // the movement refill, so a band that spent its whole turn attacking ends the turn with
    // its movement back. A step that ran after the refill would leave it at 0. A band that
    // *died* in its own attack is gone, which is the other legal outcome.
    const afterBand = unitById(turned.state, before.id);
    if (afterBand === undefined) {
      expect(combat.attackerSurvives).toBe(false);
    } else {
      expect(afterBand.movementLeft).toBe(unitRow('warrior').movement);
    }

    // A band whose whole turn was an attack drew no dice for its *decision*: the attack's
    // dice are the engine's combat path, but the step itself added no draws of its own.
    // Measured on a board where the band only walks (below), where the stream must not move
    // at all.
    const peaceful = buildWorld({
      barbarians: true,
      units: [{ owner: 0, type: 'warrior', x: 30, y: 30 }],
      cities: [{ owner: 0, x: 20, y: 20, population: 3 }],
    });
    const wanderer = spawnUnit(
      peaceful,
      unitRow('warrior'),
      (() => {
        const player = peaceful.players.find((candidate) => candidate.kind === 'barbarian');
        if (player === undefined) throw new Error('no barbarian player');
        return player.id;
      })(),
      at(10, 10),
    );
    const walked = advanceTurn(wanderer.state, VIEW);
    expect(walked.events.some((event) => event.type === 'CombatResolved')).toBe(false);
    expect(walked.state.rng).toEqual(wanderer.state.rng);
    expect(hitsOf(walked.state)).toBe(hitsOf(wanderer.state));
  });

  it('breaks ties by ascending tile index, and never by the order of the arrays', () => {
    // Two civilization cities at equal distance from the band, on open grassland where the
    // walkable distance between two tiles is their Chebyshev distance: the step must go to
    // the **lowest-indexed** neighbour that is strictly closer to a city, and swapping the
    // order of the units and the cities in the state must not change the answer.
    const symmetric = (): GameState => {
      const board = buildWorld({
        barbarians: true,
        units: [{ owner: 0, type: 'warrior', x: 35, y: 35 }],
        cities: [
          { owner: 0, x: 20, y: 16, population: 2 },
          { owner: 0, x: 20, y: 24, population: 2 },
        ],
      });
      const player = board.players.find((candidate) => candidate.kind === 'barbarian');
      if (player === undefined) throw new Error('no barbarian player');
      return spawnUnit(board, unitRow('warrior'), player.id, at(20, 20)).state;
    };

    const board = symmetric();
    const band = barbariansOf(board)[0];
    if (band === undefined) throw new Error('the board has no band');
    const turned = advanceTurn(board, VIEW);
    const moved = mustUnit(turned.state, band.id);

    // The independent expectation: among the band's neighbours, the ones that are strictly
    // closer (Chebyshev) to the nearest civilization city; the lowest index among *those*
    // wins. On this open board the walkable distance is the Chebyshev distance to the
    // nearest city tile, and the terrain is uniform grassland with no obstacles.
    const cityTiles = board.cities.map((city) => city.tile);
    const nearest = (tile: TileIndex): number =>
      Math.min(...cityTiles.map((cityTile) => distance8(board.map, tile, cityTile)));
    const here = nearest(band.tile);
    const candidates = neighbors8(board.map, band.tile)
      .filter((tile) => nearest(tile) < here)
      .sort((a, b) => Number(a) - Number(b));
    expect(candidates.length).toBeGreaterThan(1);
    expect(moved.tile).toBe(first(candidates.map(Number)));

    // Order-independence: the same world with its unit list and city list reversed reaches
    // exactly the same decision, which is what "never by map iteration order" means.
    const reversed: GameState = {
      ...board,
      units: [...board.units].reverse(),
      cities: [...board.cities].reverse(),
    };
    const reversedTurn = advanceTurn(reversed, VIEW);
    const reversedBand = reversedTurn.state.units.find((unit) => unit.id === band.id);
    if (reversedBand === undefined) throw new Error('the reversed board lost the band');
    expect(reversedBand.tile).toBe(moved.tile);
  });

  it('gets no gold, no research and no roads', () => {
    // Barbarians "never research, never build, never receive gold, and never benefit from
    // another player's roads". Each clause is measured over several turns rather than read.
    const board = buildWorld({
      barbarians: true,
      units: [{ owner: 0, type: 'warrior', x: 30, y: 30 }],
      cities: [{ owner: 0, x: 20, y: 20, population: 4, buildings: ['marketplace'] }],
      // A road right under the band, and a long one beside it: the movement economy's
      // favourite way to move fast.
      roads: [
        [
          [10, 10],
          [25, 10],
        ],
      ],
    });
    const player = board.players.find((candidate) => candidate.kind === 'barbarian');
    if (player === undefined) throw new Error('no barbarian player');
    const band = spawnUnit(board, unitRow('warrior'), player.id, at(10, 10));
    const withoutRoad = buildWorld({
      barbarians: true,
      units: [{ owner: 0, type: 'warrior', x: 30, y: 30 }],
      cities: [{ owner: 0, x: 20, y: 20, population: 4, buildings: ['marketplace'] }],
    });
    const plainBarbarian = withoutRoad.players.find((candidate) => candidate.kind === 'barbarian');
    if (plainBarbarian === undefined) throw new Error('the no-road board has no barbarian player');
    // The two bands are placed on the *same* tile of two otherwise identical boards: one
    // board has a road under it, the other does not.
    const roadBand = spawnUnit(board, unitRow('warrior'), player.id, at(10, 12));
    const plainBand = spawnUnit(withoutRoad, unitRow('warrior'), plainBarbarian.id, at(10, 12));

    let state = band.state;
    const goldSeen: number[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const turned = advanceTurn(state, VIEW);
      expect(
        turned.events.some(
          (event) =>
            (event.type === 'IncomeCollected' || event.type === 'UpkeepPaid') &&
            event.playerId === player.id,
        ),
        'a barbarian collected income or paid upkeep',
      ).toBe(false);
      const row = playerRowOf(turned.state, player.id);
      if (row === undefined) throw new Error('the barbarian player vanished');
      goldSeen.push(row.treasury);
      expect(knownTechs(row)).toEqual([]);
      expect(researchingOf(row)).toBeUndefined();
      state = turned.state;
    }
    expect(goldSeen).toEqual([0, 0, 0, 0]);

    // The road changes nothing about what a barbarian may spend: the two bands (one on a
    // road, one not) end the turn with the same movement, the type's own figure.
    const onRoad = advanceTurn(roadBand.state, VIEW);
    const offRoad = advanceTurn(plainBand.state, VIEW);
    expect(mustUnit(onRoad.state, roadBand.unit.id).movementLeft).toBe(unitRow('warrior').movement);
    expect(mustUnit(offRoad.state, plainBand.unit.id).movementLeft).toBe(
      unitRow('warrior').movement,
    );
    // Non-vacuity: the road really is on one board and not the other, or the comparison
    // above is between two identical worlds.
    expect(onRoad.state.improvements.length).toBeGreaterThan(offRoad.state.improvements.length);
  });

  it('does not spend the money a civilization would, and never reaches the treasury', () => {
    // The same claim from the other side: the barbarian row's economy fields are inert. The
    // money loop reads `kind`, and this asserts the consequence rather than the mechanism.
    const board = buildWorld({
      barbarians: true,
      units: [{ owner: 0, type: 'warrior', x: 30, y: 30 }],
      cities: [{ owner: 0, x: 20, y: 20, population: 4 }],
      treasury: 40,
    });
    const player = board.players.find((candidate) => candidate.kind === 'barbarian');
    if (player === undefined) throw new Error('no barbarian player');
    const band = spawnUnit(board, unitRow('warrior'), player.id, at(21, 21));
    const turned = advanceTurn(band.state, VIEW);
    const row = playerRowOf(turned.state, player.id);
    if (row === undefined) throw new Error('the barbarian player vanished');
    expect(row.treasury).toBe(0);
    expect(row.rates).toEqual(player.rates);
    expect(turned.state.players.filter((each) => each.kind === 'barbarian')).toHaveLength(1);
  });

  it('never lets a hut place a band inside a foreign city (the defect this review found)', () => {
    // **This is the one place the review falsified the contract, and the test is the
    // regression pin for it.** M6 registers `unit-not-inside-foreign-city` and makes the
    // mover refuse a foreign city tile (`occupied-by-enemy`), so "a unit never stands
    // inside a city it does not own" is a property of every state the command layer can
    // produce. `hut.ts`' `bandTiles` filtered the adjacent tiles for another player's
    // *units* and not for another player's *cities*, so a hut's `barbarians` reward could
    // place a band inside a civilization's city — which is how the 200-seed
    // `duel`/3-civ sweeps in `@civts/sim`'s full tier found it (seeds 57 and 122, both on a
    // turn whose band landed on the tile of a city whose defender had just walked away).
    // The filter now excludes foreign cities as well, using `cityAt`.
    //
    // The board is arranged so the city tile is the *first* ascending neighbour of the hut
    // (779 = (19,19), with the hut at (20,20)), because the band takes the lowest-numbered
    // legal tiles first: without the city filter the band lands on 779 and this fails.
    const hutAt: readonly [number, number] = [20, 20];
    const cityAtTile: readonly [number, number] = [19, 19];
    const board = (seed: number): GameState =>
      buildWorld({
        seed,
        barbarians: true,
        cities: [{ owner: 1, x: cityAtTile[0], y: cityAtTile[1], population: 1 }],
        units: [{ owner: 0, type: 'warrior', x: 20, y: 19 }],
        huts: [hutAt],
      });

    // The rule this spawn must respect, stated by the engine for a *unit*: the tile the
    // band may not be placed on is a tile no unit of another player may walk onto.
    const walker = board(1);
    const mover = mustUnitOn(walker, at(20, 19));
    expect(
      refusalOf(walker, mover.owner, { type: 'MoveUnit', unitId: mover.id, to: at(19, 19) }).kind,
    ).toBe('occupied-by-enemy');

    // A seed whose draw really is the `barbarians` reward, found by playing: the reward is a
    // function of the state's RNG, so the search is deterministic and its result is pinned
    // by the non-vacuity assertion below.
    let bands = 0;
    let searched = 0;
    for (let seed = 1; seed <= 64; seed += 1) {
      searched += 1;
      const started = board(seed);
      const unit = mustUnitOn(started, at(20, 19));
      const applied = accept(started, unit.owner, {
        type: 'MoveUnit',
        unitId: unit.id,
        to: at(hutAt[0], hutAt[1]),
      });
      const spawn = applied.events.find((event) => event.type === 'BarbariansSpawned');
      if (spawn === undefined) continue;
      bands += 1;

      // Every tile the band occupies is a legal home: no foreign unit, no foreign city, and
      // the band really is standing there.
      expect(spawn.tiles.length).toBe(BARBARIAN_BAND_SIZE);
      expect([...spawn.tiles].map(Number)).toEqual(
        [...spawn.tiles].map(Number).sort((a, b) => a - b),
      );
      expect(new Set(spawn.tiles.map(Number)).size).toBe(spawn.tiles.length);
      for (const tile of spawn.tiles) {
        expect(unitsOnTile(applied.state, tile).some((each) => each.owner !== spawn.owner)).toBe(
          false,
        );
        const city = cityAt(applied.state, tile);
        expect(
          city === undefined || city.owner === spawn.owner,
          `a band was placed on tile ${String(tile)} inside city ${String(city?.id)}, owned by ` +
            `player ${String(city?.owner)}`,
        ).toBe(true);
        expect(unitsOnTile(applied.state, tile).some((each) => each.owner === spawn.owner)).toBe(
          true,
        );
      }
      // The specific hole: the city tile is the first ascending neighbour, and the band must
      // have passed over it rather than into it.
      expect(spawn.tiles.map(Number)).not.toContain(
        tileIndex(DUEL.width, cityAtTile[0], cityAtTile[1]),
      );

      // The band members are exactly the event's ids, on the event's tiles, and the world is
      // coherent at the boundary (the invariant that found this is asked directly).
      expect(spawn.unitIds.length).toBe(spawn.tiles.length);
      for (const [index, id] of spawn.unitIds.entries()) {
        expect(mustUnit(applied.state, id).tile).toBe(spawn.tiles[index]);
      }
      // The invariant that found this is asked directly, by name, on the transition that
      // produced the band — and the whole registry is asked too, because a spawn that breaks
      // one property usually breaks a second one.
      expect(
        violationsOf(applied.state, started, applied.events).filter((violation) =>
          violation.startsWith('unit-not-inside-foreign-city:'),
        ),
      ).toEqual([]);
      expect(violationsOf(applied.state, started, applied.events)).toEqual([]);
    }
    expect(searched).toBe(64);
    expect(
      bands,
      'not one of the 64 seeds drew a barbarian band, so the loop above is empty',
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Gating exercised by SHIPPED content, through PLAY
 * ------------------------------------------------------------------ */

/** The prerequisite closure of a tech, read from the tree rather than written here. */
const prerequisitesClosure = (tech: string): readonly string[] => {
  const seen = new Set<string>();
  const stack: string[] = [tech];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (techDef(RULESET, asTechId(current)) === undefined) {
      throw new Error(`the shipped catalog defines no tech "${current}"`);
    }
    for (const prerequisite of prerequisitesOf(VIEW, asTechId(current))) {
      const id = String(prerequisite);
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(id);
    }
  }
  return [...seen].sort();
};

/** Research a tech **by playing**: set the research through the applier, then let turns pass. */
const researchThroughPlay = (
  state: GameState,
  tech: string,
): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
  const player = asPlayerId(0);
  const planned = planSetResearch(state, VIEW, player, asTechId(tech));
  if (!planned.ok) {
    throw new Error(`planSetResearch refused ${tech}: ${errorText(planned.error)}`);
  }
  const started = accept(state, player, { type: 'SetResearch', tech: asTechId(tech) });
  let current = started.state;
  const events: GameEvent[] = [...started.events];

  for (let turn = 0; turn < 8; turn += 1) {
    const turned = advanceTurn(current, VIEW);
    events.push(...turned.events);
    current = turned.state;
    if (
      turned.events.some(
        (event) => event.type === 'TechResearched' && event.tech === asTechId(tech),
      )
    ) {
      return { state: current, events };
    }
  }
  throw new Error(`${tech} was not researched within eight turns of play`);
};

describe('6. the gates are exercised by shipped content, through play', () => {
  it('names the shipped rows that carry each gate, so the evidence is about content', () => {
    // Every gate asserted below has to be *in the catalog*, not in a test override: that is
    // the whole point of the M6 acceptance item ("No shipped row declares `requiresTech`
    // today, which is exactly why two gating defects survived play testing").
    const archer = unitRow('archer');
    const spearman = unitRow('spearman');
    const horseman = unitRow('horseman');
    const transport = unitRow('transport');
    expect(requiresTechOf(archer)).toBe(asTechId('warrior-code'));
    expect(requiresTechOf(spearman)).toBe(asTechId('warrior-code'));
    expect(requiresTechOf(horseman)).toBe(asTechId('horseback-riding'));
    expect(requiresTechOf(transport)).toBe(asTechId('map-making'));
    expect(horseman.requiresResource).toBe(asResourceId('horses'));
    expect(requiresTechOf(buildingRow('temple'))).toBe(asTechId('ceremonial-burial'));
    // At least one shipped unit is gated on a *resource* with no tech gate, so the older
    // gate is exercised by content too.
    expect(
      RULESET.units.some(
        (row) => row.requiresResource !== undefined && requiresTechOf(row) === undefined,
      ),
    ).toBe(true);
  });

  it('refuses the gated unit before the tech and offers it after, through the pipeline', () => {
    const tech = 'warrior-code';
    const item: ProductionItem = { kind: 'unit', id: asUnitTypeId('archer') };
    const state = buildWorld({
      cities: [{ owner: 0, x: 10, y: 10, population: 6 }],
      beakers: 10_000,
      treasury: 200,
      techs: prerequisitesClosure(tech),
    });
    const city = mustCity(state, asPlayerId(0));

    // Before: the gate names the tech, the menu omits the item, the applier refuses with the
    // same name, and the engine's own reader agrees about *why*.
    expect(knowsTech(mustPlayerRow(state, asPlayerId(0)), asTechId(tech))).toBe(false);
    const gateBefore = productionGate(state, VIEW, asPlayerId(0), item);
    expect(gateBefore.kind).toBe('tech-required');
    if (gateBefore.kind === 'tech-required') expect(gateBefore.tech).toBe(asTechId(tech));
    expect(cityProductionOptions(state, VIEW, city.id)).not.toContainEqual(item);
    const refused = refusalOf(state, asPlayerId(0), {
      type: 'SetProduction',
      cityId: city.id,
      item,
    });
    expect(refused.kind).toBe('tech-required');
    if (refused.kind === 'tech-required') expect(refused.tech).toBe(asTechId(tech));
    expect(unmetItemTech(state, VIEW, asPlayerId(0), item)).toBe(asTechId(tech));

    // After: the same four readers flip, having only *played* the research step.
    const researched = researchThroughPlay(state, tech);
    expect(
      researched.events.some(
        (event) => event.type === 'TechResearched' && event.tech === asTechId(tech),
      ),
    ).toBe(true);
    expect(knowsTech(mustPlayerRow(researched.state, asPlayerId(0)), asTechId(tech))).toBe(true);
    expect(productionGate(researched.state, VIEW, asPlayerId(0), item).kind).toBe('open');
    expect(
      cityProductionOptions(researched.state, VIEW, mustCity(researched.state, asPlayerId(0)).id),
    ).toContainEqual(item);

    // And the unit is really built afterwards: production through the applier, then the
    // pipeline, then a `CityProduced` event naming the archer.
    const set = accept(researched.state, asPlayerId(0), {
      type: 'SetProduction',
      cityId: city.id,
      item,
    });
    let producedState = set.state;
    let produced = false;
    for (let turn = 0; turn < 12; turn += 1) {
      const turned = advanceTurn(producedState, VIEW);
      producedState = turned.state;
      if (
        turned.events.some(
          (event) =>
            event.type === 'CityProduced' &&
            event.item.kind === 'unit' &&
            event.item.id === asUnitTypeId('archer'),
        )
      ) {
        produced = true;
        break;
      }
    }
    expect(produced, 'the archer was never produced although its gate had opened').toBe(true);
    expect(producedState.units.some((unit) => unit.type === asUnitTypeId('archer'))).toBe(true);
  });

  it('gates the shipped building, and the temple is really built after the research', () => {
    const tech = 'ceremonial-burial';
    const temple = buildingRow('temple');
    const item: ProductionItem = { kind: 'building', id: temple.id };
    const state = buildWorld({
      cities: [{ owner: 0, x: 10, y: 10, population: 6 }],
      beakers: 10_000,
      treasury: 200,
      techs: prerequisitesClosure(tech),
    });
    const city = mustCity(state, asPlayerId(0));

    expect(productionGate(state, VIEW, asPlayerId(0), item).kind).toBe('tech-required');
    const refused = refusalOf(state, asPlayerId(0), {
      type: 'SetProduction',
      cityId: city.id,
      item,
    });
    expect(refused.kind).toBe('tech-required');

    const researched = researchThroughPlay(state, tech);
    expect(productionGate(researched.state, VIEW, asPlayerId(0), item).kind).toBe('open');
    const set = accept(researched.state, asPlayerId(0), {
      type: 'SetProduction',
      cityId: city.id,
      item,
    });
    let current = set.state;
    let built = false;
    for (let turn = 0; turn < 12; turn += 1) {
      const turned = advanceTurn(current, VIEW);
      current = turned.state;
      if (
        turned.events.some(
          (event) =>
            event.type === 'CityProduced' &&
            event.item.kind === 'building' &&
            event.item.id === temple.id,
        )
      ) {
        built = true;
        break;
      }
    }
    expect(built, 'the temple was never completed although its gate had opened').toBe(true);
    expect(mustCity(current, asPlayerId(0)).buildings).toContain(temple.id);
  });

  it('keeps the two gates apart: the horseman needs its tech AND a connected resource', () => {
    const tech = 'horseback-riding';
    const horses = asResourceId('horses');
    const horseman = unitRow('horseman');
    expect(horseman.requiresResource).toBe(horses);
    const item: ProductionItem = { kind: 'unit', id: horseman.id };

    // (a) tech known, no horses: the resource half refuses, naming the resource.
    const noHorses = buildWorld({
      cities: [{ owner: 0, x: 10, y: 10, population: 6 }],
      beakers: 10_000,
      treasury: 200,
      techs: [...prerequisitesClosure(tech), tech],
    });
    const cityA = mustCity(noHorses, asPlayerId(0));
    expect(connected(noHorses, VIEW, asPlayerId(0)).has(horses)).toBe(false);
    const gateA = productionGate(noHorses, VIEW, asPlayerId(0), item);
    expect(gateA.kind).toBe('blocked');
    if (gateA.kind === 'blocked') expect(gateA.resource).toBe(horses);
    const refusedA = refusalOf(noHorses, asPlayerId(0), {
      type: 'SetProduction',
      cityId: cityA.id,
      item,
    });
    expect(refusedA.kind).toBe('resource-not-connected');
    if (refusedA.kind === 'resource-not-connected') expect(refusedA.resource).toBe(horses);
    expect(cityProductionOptions(noHorses, VIEW, cityA.id)).not.toContainEqual(item);

    // (b) horses connected, tech unknown: the tech half refuses, naming the tech.
    const noTech = buildWorld({
      cities: [{ owner: 0, x: 10, y: 10, population: 6 }],
      beakers: 10_000,
      treasury: 200,
      techs: prerequisitesClosure(tech),
      resources: [{ x: 12, y: 10, id: 'horses' }],
      roads: [
        [
          [10, 10],
          [12, 10],
        ],
      ],
    });
    const cityB = mustCity(noTech, asPlayerId(0));
    expect(connected(noTech, VIEW, asPlayerId(0)).has(horses)).toBe(true);
    const gateB = productionGate(noTech, VIEW, asPlayerId(0), item);
    expect(gateB.kind).toBe('tech-required');
    if (gateB.kind === 'tech-required') expect(gateB.tech).toBe(asTechId(tech));
    const refusedB = refusalOf(noTech, asPlayerId(0), {
      type: 'SetProduction',
      cityId: cityB.id,
      item,
    });
    expect(refusedB.kind).toBe('tech-required');

    // (c) both satisfied, by playing the last tech: the item is offered, accepted and built.
    const researched = researchThroughPlay(noTech, tech);
    expect(productionGate(researched.state, VIEW, asPlayerId(0), item).kind).toBe('open');
    const set = accept(researched.state, asPlayerId(0), {
      type: 'SetProduction',
      cityId: cityB.id,
      item,
    });
    let current = set.state;
    let built = false;
    for (let turn = 0; turn < 12; turn += 1) {
      const turned = advanceTurn(current, VIEW);
      current = turned.state;
      if (
        turned.events.some(
          (event) =>
            event.type === 'CityProduced' &&
            event.item.kind === 'unit' &&
            event.item.id === horseman.id,
        )
      ) {
        built = true;
        break;
      }
    }
    expect(built, 'the horseman was never produced with both gates open').toBe(true);
    expect(current.units.some((unit) => unit.type === horseman.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Determinism: in this process, and in a fresh one
 * ------------------------------------------------------------------ */

/** A short played game with combat, barbarians and a city in it: the world the hashes pin. */
const determinismRun = (
  seed: number,
): { readonly state: GameState; readonly events: readonly GameEvent[] } => {
  const board = buildWorld({
    seed,
    barbarians: true,
    units: [
      { owner: 0, type: 'warrior', x: 11, y: 10 },
      { owner: 0, type: 'settler', x: 10, y: 12 },
      { owner: 1, type: 'warrior', x: 12, y: 11 },
    ],
    cities: [{ owner: 0, x: 20, y: 20, population: 3, buildings: ['granary'] }],
    treasury: 30,
    beakers: 5,
  });
  const player = board.players.find((candidate) => candidate.kind === 'barbarian');
  if (player === undefined) throw new Error('the board has no barbarian player');
  const withBand = spawnUnit(board, unitRow('warrior'), player.id, at(4, 4)).state;

  let current = withBand;
  const events: GameEvent[] = [];
  // The civilization's own attack first, through the applier, so the run contains the
  // command path as well as the engine's barbarian step.
  const attacker = mustUnitOn(current, at(11, 10));
  const struck = accept(current, attacker.owner, {
    type: 'AttackUnit',
    unitId: attacker.id,
    target: at(12, 11),
  });
  events.push(...struck.events);
  current = struck.state;

  for (let turn = 0; turn < 6; turn += 1) {
    const turned = advanceTurn(current, VIEW);
    events.push(...turned.events);
    current = turned.state;
  }
  return { state: current, events };
};

describe('7. determinism, in this process and in a fresh one', () => {
  it('gives one hash for one world, with combat and the barbarian step inside it', () => {
    const first = determinismRun(21);
    const second = determinismRun(21);
    expect(hashValue(second.state)).toBe(hashValue(first.state));
    expect(second.events).toEqual(first.events);

    // Non-vacuity: the run really contains a battle (from a command *and* from the engine's
    // barbarian step is not required, but one of the two must be there) and really moved.
    expect(first.events.some((event) => event.type === 'CombatResolved')).toBe(true);
    expect(first.state.turn).toBeGreaterThan(1);
    expect(violationsOf(first.state, undefined, [])).toEqual([]);
  });

  it('is not accidentally constant: a different seed gives a different world', () => {
    expect(hashValue(determinismRun(22).state)).not.toBe(hashValue(determinismRun(21).state));
  });

  // The full tier owns the subprocess: the standing requirement lists cross-process
  // determinism among that tier's reasons for existing.
  it.skipIf(!FULL_TIER)(
    'gives the same battle hash in a fresh process (full tier: it spawns one)',
    () => {
      // Two runs in this process could share module state and still agree, so the claim that
      // matters — the same *battle* is reproducible in another process from the same seed — is
      // measured there. The child program builds the same board with the same harness builder
      // and prints the hash of the state after one applied `AttackUnit`.
      const here = hashValue(combatHashRun());
      const program = [
        "import { applyCommand, asPlayerId, asUnitTypeId, tileIndex, unitById } from '@civts/core';",
        "import { CATALOG, validateRuleset } from '@civts/rules';",
        "import { createScenarioBuilder, hashValue } from '@civts/testing';",
        'const validated = validateRuleset(CATALOG, "tuned");',
        'if (!validated.ok) throw new Error("catalog");',
        'const ruleset = validated.value;',
        'const board = createScenarioBuilder(ruleset, { mapSize: "duel", civCount: 2, seed: 11 })',
        '  .addPlayer("Rome").addPlayer("Greece").fillTerrain("grassland")',
        '  .addUnit(0, asUnitTypeId("warrior"), [10, 10])',
        '  .addUnit(1, asUnitTypeId("warrior"), [11, 10])',
        '  .build();',
        'if (!board.ok) throw new Error("board");',
        'const state = board.value;',
        'const attacker = state.units.find((unit) => unit.owner === asPlayerId(0));',
        'if (attacker === undefined) throw new Error("attacker");',
        'const applied = applyCommand(state, asPlayerId(0), {',
        '  type: "AttackUnit", unitId: attacker.id, target: tileIndex(40, 11, 10),',
        '}, ruleset);',
        'if (!applied.ok) throw new Error(JSON.stringify(applied.error));',
        'void unitById;',
        'process.stdout.write(hashValue(applied.value.state));',
      ].join('\n');

      const tsx = (() => {
        try {
          return createRequire(import.meta.url).resolve('tsx/cli');
        } catch (cause) {
          throw new Error(
            'the fresh-process check needs the `tsx` devDependency (resolved as "tsx/cli"): ' +
              (cause instanceof Error ? cause.message : String(cause)),
          );
        }
      })();
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const child = spawnSync(process.execPath, [tsx, '-e', program], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe(here);
    },
  );
});

/** The one-battle board the fresh-process check mirrors: the same seed, the same tiles. */
const combatHashRun = (): GameState => {
  const board = buildWorld({
    units: [
      { owner: 0, type: 'warrior', x: 10, y: 10 },
      { owner: 1, type: 'warrior', x: 11, y: 10 },
    ],
  });
  const attacker = mustUnitOn(board, at(10, 10));
  return accept(board, attacker.owner, {
    type: 'AttackUnit',
    unitId: attacker.id,
    target: at(11, 10),
  }).state;
};

/* ------------------------------------------------------------------ *
 * 8. The invariant registry: what it costs, and that it bites
 * ------------------------------------------------------------------ */

describe('8. the invariant registry, measured', () => {
  it('registers every M6 invariant once, with a description', () => {
    const names = CORE_INVARIANTS.map((invariant) => invariant.name);
    expect(new Set(names).size).toBe(names.length);
    for (const invariant of CORE_INVARIANTS) {
      expect(invariant.description.length, `${invariant.name} has no description`).toBeGreaterThan(
        0,
      );
      expect(invariant.name).toMatch(/^[a-z0-9-]+$/);
    }
    for (const name of [
      'unit-hit-points-in-range',
      'unit-hit-points-above-zero',
      'unit-experience-in-range',
      'unit-not-inside-foreign-city',
      'captured-city-consistent',
      'combat-hit-point-conservation',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('costs a fraction of a millisecond per check and per turn', () => {
    // The fast tier's budget is 90 seconds and it runs the whole registry once per
    // simulated turn, so the registry's cost per turn is a *tier* budget question, not only
    // a micro-benchmark. Measured here rather than asserted from a document: the fast tier
    // (`pnpm test`, 1677 tests) was measured at ~12 s of wall clock on this machine while
    // this review ran, so the numbers below leave the tier a wide margin.
    const played = determinismRun(3).state;
    const iterations = 200;

    const startedChecks = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      expect(
        checkInvariants({
          state: played,
          previous: played,
          ruleset: RULESET,
          rulesetView: VIEW,
          events: [],
          turn: played.turn,
        }),
      ).toEqual([]);
    }
    const perCheck = (performance.now() - startedChecks) / iterations;
    expect(perCheck, `the registry cost ${perCheck.toFixed(3)} ms per check`).toBeLessThan(5);

    // A whole turn — the pipeline plus the registry — is the figure the tier actually pays.
    const turns = 30;
    const startedTurns = performance.now();
    let state = played;
    for (let index = 0; index < turns; index += 1) {
      const turned = advanceTurn(state, VIEW);
      checkInvariants({
        state: turned.state,
        previous: state,
        ruleset: RULESET,
        rulesetView: VIEW,
        events: turned.events,
        turn: turned.state.turn,
      });
      state = turned.state;
    }
    const perTurn = (performance.now() - startedTurns) / turns;
    expect(perTurn, `a turn plus its invariant check cost ${perTurn.toFixed(2)} ms`).toBeLessThan(
      50,
    );
    // The long sweeps in this repository run a few hundred turns: at the measured cost they
    // cannot be what pushes a 90-second tier over its budget.
    expect((perTurn * 400) / 1000).toBeLessThan(90);
  });

  it('catches a battle that raises hit points, on a state it did not build itself', () => {
    // The registry's fire case for the M6 conservation invariant, driven by a real battle
    // and a deliberately wrong "previous": the check must report it, and must stay quiet
    // when the same battle is told honestly.
    const board = buildWorld({
      units: [
        { owner: 0, type: 'swordsman', x: 10, y: 10 },
        { owner: 1, type: 'warrior', x: 11, y: 10 },
      ],
    });
    const attacker = mustUnitOn(board, at(10, 10));
    const applied = accept(board, attacker.owner, {
      type: 'AttackUnit',
      unitId: attacker.id,
      target: at(11, 10),
    });
    expect(violationsOf(applied.state, board, applied.events)).toEqual([]);
    expect(
      violationsOf(
        applied.state,
        { ...board, units: board.units.map((unit) => ({ ...unit, hitPointsLeft: 1 })) },
        applied.events,
      ).length,
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 9. The rules the milestone's evidence depends on, pinned against mutation
 * ------------------------------------------------------------------ */

describe('9. the rules a mutation would have to break', () => {
  it('pins the tie rule, the population rule, the movement spend and the wonder rule', () => {
    // This section is the in-test half of the operational mutation check recorded in the
    // file header: each assertion below is one a mutant of the named source fails.
    //
    // (a) `combat.ts`' `drawsWin`: the defender wins ties. Flipping `<` to `<=` flips both
    // of these.
    const threshold = contractWinPct(3, 3);
    expect(drawsWin(threshold, threshold)).toBe(false);
    expect(drawsWin(threshold - 1, threshold)).toBe(true);
    expect(drawsWin(0, COMBAT.minWinPct)).toBe(true);

    // (b) `cities.ts`' `capturedPopulation`: halved, floored, at least one. A different
    // divisor changes every number here.
    expect(capturedPopulation(CAPTURE, 5)).toBe(2);
    expect(capturedPopulation(CAPTURE, 4)).toBe(2);
    expect(capturedPopulation(CAPTURE, 1)).toBe(1);
    expect(capturedPopulation(CAPTURE, 0)).toBe(1);
    expect(capturedPopulation(CAPTURE, 2.5)).toBe(1);
    // …and the divisor is the *catalog's*, not a copy of it: the same population under a
    // different capture section is a different city, which is what makes this knob sweepable.
    expect(capturedPopulation({ populationDivisor: 4 }, 4)).toBe(1);

    // (c) `cities.ts`' `buildingsLostToCapture`: maintenance-descending, ties by the most
    // recently completed, and **the wonder is kept**. Dropping the `isWonder` guard puts
    // `pyramids` in the destroyed list and out of the city — the mutation this pins.
    const board = buildWorld({
      units: [
        { owner: 0, type: 'warrior', x: 10, y: 10 },
        { owner: 1, type: 'warrior', x: 30, y: 30 },
      ],
      cities: [
        {
          owner: 1,
          x: 11,
          y: 10,
          population: 5,
          buildings: ['granary', 'barracks', 'library', 'pyramids'],
        },
      ],
    });
    const city = mustCity(board, asPlayerId(1));
    const losses = buildingsLostToCapture(buildingCatalog(RULESET), city);
    expect(losses).toEqual(['library', 'barracks', 'granary']);
    expect(losses).not.toContain(WONDER.id);
    const captured = accept(board, asPlayerId(0), {
      type: 'AttackUnit',
      unitId: mustUnitOn(board, at(10, 10)).id,
      target: at(11, 10),
    });
    expect(captureEventOf(captured.events).destroyed).toEqual([...losses]);
    expect([...mustCity(captured.state, asPlayerId(0)).buildings]).toEqual([WONDER.id]);
    // The wonder is held exactly once, which is the property the guard exists for.
    expect(captured.state.cities.filter((each) => each.buildings.includes(WONDER.id))).toHaveLength(
      1,
    );

    // (d) `commands.ts`' attack applier: the attacker's whole turn is spent, and a capture
    // promotes nobody. Removing the `movementLeft: 0` write or promoting on a capture fails
    // these two.
    expect(mustUnit(captured.state, mustUnitOn(board, at(10, 10)).id).movementLeft).toBe(0);
    expect(captured.events.some((event) => event.type === 'UnitPromoted')).toBe(false);

    // (e) the clamp in `combat.ts`: certainty is unreachable, so a sweep over the extremes
    // measures something.
    expect(winPct(COMBAT, 1_000_000, 0)).toBe(COMBAT.maxWinPct);
    expect(winPct(COMBAT, 0, 1_000_000)).toBe(COMBAT.minWinPct);
    expect(COMBAT.damagePerRound).toBe(1);
  });

  it('pins the damage a round deals and the hit-points-at-zero rule', () => {
    // A battle between two one-hit-point units ends in exactly one round, which is what
    // makes `COMBAT.damagePerRound` observable rather than only declared; and the loser is
    // reported dead rather than stored at zero.
    const fight = resolveCombat({
      rules: COMBAT,
      attacker: { attack: 9, defense: 0, bonusPct: 0 },
      defender: { attack: 0, defense: 1, bonusPct: 0 },
      attackerHitPoints: 1,
      defenderHitPoints: 1,
      rng: seedRng(4),
      static: [0],
    });
    expect(fight.result.rounds).toBe(1);
    expect(fight.result.defenderLost).toBe(COMBAT.damagePerRound);
    expect(fight.result.defenderSurvives).toBe(false);
    expect(fight.result.outcome).toBe('attacker-wins');
  });
});
