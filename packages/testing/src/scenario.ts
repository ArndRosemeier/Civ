/**
 * The scenario DSL: hand-built worlds, run as tests — M2's acceptance evidence.
 * See docs/INTERFACES.md M2 ("Scenario DSL", "M2 acceptance criteria"),
 * PLAN.md §8.3 (the DSL) and §10 ("the scenario suite doubles as milestone
 * acceptance").
 *
 * Why a builder exists at all: a scenario that is meant to prove *a rule* must
 * not be at the mercy of map generation. `newGame` picks starts by greedy
 * max-min distance across generated terrain, so a test written against it says
 * "some unit, somewhere, if this seed produced hills". The builder below lets a
 * scenario state the world outright — terrain by role, a unit on an exact tile —
 * so a failure means the rule moved, not the map.
 *
 * Design decisions (each is a decision, not an accident):
 *
 * - **The builder records roles; `build()` resolves them.** `fillTerrain` /
 *   `setTile` store a `TerrainRole`, and `build` resolves each role through
 *   `TERRAIN_BY_ROLE` exactly as `gen.ts` does. A role the ruleset does not
 *   define therefore fails *at build time* as the typed
 *   `{ kind: 'missing-terrain-role' }` that `newGame` also returns — which is the
 *   only failure `build()`'s frozen `Result<GameState, SetupError>` can express.
 * - **Map dimensions come from `settings.mapSize`** (`MAP_DIMENSIONS`). The
 *   frozen `Scenario` interface has no width/height field, so `duel` (40x40) is
 *   the smallest world a scenario can ask for; coordinates are validated against
 *   it, so a typo cannot silently land off the map.
 * - **Tiles default to `grassland`**; `fillTerrain` replaces the whole map and
 *   `setTile` overrides one tile. Last write to a tile wins.
 * - **The player list is authoritative for `civCount`.** `addPlayer` calls, not
 *   `settings.civCount`, decide how many civilizations exist, and `build()`
 *   writes `civCount = players.length` into the state, so the state can never
 *   claim a count it does not have. A patch that *names* a contradictory
 *   `civCount` is refused rather than silently ignored.
 * - **A player's `startingTile` is where its first unit stands.** `addPlayer`
 *   takes no tile, and `PlayerState.startingTile` is persisted (so it is part of
 *   every hash); inventing an arbitrary tile would put a lie in the state, so a
 *   player with no unit makes `build()` fail loudly instead.
 * - **Units get dense ids in creation order and full movement**, so
 *   `nextUnitId === units.length` and `units` is sorted by id — the invariants
 *   `newGame` establishes.
 * - **Fog memory starts empty.** The builder has no pre-history, so every player
 *   begins with an all-`false` explored row. The only thing that ever writes to
 *   it is a move, which folds in what the unit sees *after* the step (that is
 *   when `applyCommand` derives visibility). That is what makes "fog expands as a
 *   unit moves" an exactly computable assertion instead of a guess.
 *
 * Failure channels — the frozen signature is narrower than the builder's needs,
 * so the split is stated here rather than discovered by a caller:
 *
 * - `build()` returns `Result<GameState, SetupError>` (frozen). `SetupError`'s
 *   variants describe *generation* failures, and a hand-built map generates
 *   nothing; the one that applies here is `missing-terrain-role`.
 *   `missing-unit-role` — the variant M2 added for `newGame`'s starting settler —
 *   is not reachable from here either: the builder places exactly the units the
 *   scenario names, so a ruleset that defines no unit of the requested type is
 *   reported by the `addUnit` call that named it (below), not by `build()`.
 * - Everything else an author can get wrong — a `setTile` outside the map, an
 *   `addUnit` for a player that was never added or for a unit type the ruleset
 *   does not define, fewer than two players, a `settings.civCount` that
 *   contradicts the player list, a player with no unit — has **no** member in
 *   `SetupError`. Those throw a descriptive `Error` at the offending call rather
 *   than being mapped onto a variant that would misdescribe them. A scenario is
 *   code: a mistake in it should fail at the line that made it. (Escalated for
 *   M2: scenarios built from untrusted data would need a `bad-scenario-setup`
 *   variant, or a wider error union on `build()`.)
 * - A scenario whose *settings* do not parse is refused by `defineScenario`, and
 *   again by `runScenario` — a `Scenario` is structurally constructible without
 *   `defineScenario`, so the runner cannot assume the check already happened.
 *
 * The runner:
 *
 * - `runScenario` validates the built-in `CATALOG` through `validateRuleset` (the
 *   frozen signature takes no ruleset). `runScenarioAgainst` is the same runner
 *   against a ruleset the caller supplies — the seam a test needs to exercise a
 *   custom catalog and the setup-failure path.
 * - `scenario.run` commands are applied **as the first player**, in order: M2 has
 *   no active-player field, so "the scenario's player" is player 0 by
 *   definition. A scenario that needs another actor probes with `applyCommand`
 *   from its own `assert`, which is also how an expected *refusal* is asserted
 *   (a refused command in `run` is a failure, not an expectation).
 * - A refused `run` command is reported as a failing assertion naming the command
 *   and the typed error, and ends the run: a refusal leaves the state untouched,
 *   so carrying on would only pile up identical failures.
 * - A scenario with no assertions at all is reported as **failed**. A green run
 *   that asserts nothing is exactly the vacuous evidence the rest of this repo
 *   refuses to accept (cf. the golden harness's non-vacuity checks).
 * - A scenario *failure* never throws: the result carries `passed`, the
 *   per-assertion `{ ok, message }` list, the final state, its `hashValue` digest
 *   and the events the commands emitted. Only a bug in the scenario's own code
 *   (setup, `assert`, or the settings it names) throws.
 */

import {
  MAP_DIMENSIONS,
  SCHEMA_VERSION,
  TERRAIN_BY_ROLE,
  applyCommand,
  asPlayerId,
  asUnitId,
  err,
  inBounds,
  indexToX,
  indexToY,
  loadSettings,
  ok,
  seedRng,
  tileIndex,
  unitCatalog,
  unitDef,
  type Command,
  type Fidelity,
  type GameError,
  type GameEvent,
  type GameMap,
  type GameState,
  type PlayerState,
  type Result,
  type RulesetView,
  type Settings,
  type SettingsIssue,
  type SetupError,
  type TerrainId,
  type TerrainRole,
  type TileIndex,
  type Unit,
  type UnitDef,
  type UnitTypeId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { hashValue } from './hash.js';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** One assertion's outcome, with the sentence a human reads when it is `false`. */
export interface ScenarioAssertion {
  readonly ok: boolean;
  readonly message: string;
}

/** The world under construction. Every method returns the builder, so `setup` can chain. */
export interface ScenarioBuilder {
  addPlayer(name: string): ScenarioBuilder;
  fillTerrain(role: TerrainRole): ScenarioBuilder;
  setTile(x: number, y: number, role: TerrainRole): ScenarioBuilder;
  addUnit(playerIndex: number, type: UnitTypeId, at: readonly [number, number]): ScenarioBuilder;
  build(): Result<GameState, SetupError>;
}

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * A settings patch, layered over `DEFAULT_SETTINGS` by `loadSettings` (which is
 * also where it is validated, unknown keys included).
 *
 * The frozen interface writes `Partial<...>`; it is a *deep* partial here because
 * that is what the layering genuinely accepts — a patch may change one key of
 * `ai` without restating the rest — and a plain `Partial<Settings>` is assignable
 * to this type, so no scenario written against the frozen spelling stops
 * compiling.
 */
export type ScenarioSettings = DeepPartial<Settings>;

/** A world, its script and its expectations — data, not bespoke test code. */
export interface Scenario {
  readonly name: string;
  readonly settings?: ScenarioSettings;
  readonly setup: (b: ScenarioBuilder) => ScenarioBuilder;
  readonly run?: readonly Command[];
  readonly assert?: (after: GameState, ruleset: RulesetView) => readonly ScenarioAssertion[];
}

/**
 * What a run reports. `{ passed, assertions, finalState, hash }` is the set the
 * frozen signature names; `name` and `events` are additive, and `events` is what
 * lets a test assert the engine's own account of a step (a `UnitMoved` carries
 * the `cost` it actually paid) rather than re-deriving it.
 *
 * `finalState` and `hash` are `undefined` only when the world could not be built
 * at all — there is no state then, and reporting a fabricated one would be worse
 * than reporting none.
 */
export interface ScenarioRunResult {
  readonly name: string;
  readonly passed: boolean;
  readonly assertions: readonly ScenarioAssertion[];
  readonly finalState: GameState | undefined;
  readonly hash: string | undefined;
  readonly events: readonly GameEvent[];
}

/* ------------------------------------------------------------------ *
 * Constants and small helpers
 * ------------------------------------------------------------------ */

/** Tiles a scenario world starts as, before `fillTerrain` / `setTile`. */
const DEFAULT_FILL_ROLE: TerrainRole = 'grassland';

/**
 * A game needs at least two civilizations: `Settings.civCount` is `>= 2` in the
 * settings schema, so a one-player "game" could not be represented as valid
 * settings and would be a state the rest of the engine has never been asked to
 * handle.
 */
const MIN_PLAYERS = 2;

/**
 * Player colours, indexed by player index — the same deterministic palette
 * `newGame` paints with. `state.ts` keeps its copy private, so the sixteen values
 * are repeated here rather than reached for; exporting the palette from `core` is
 * the fix, and it is reported as an escalation for M2 (PLAN.md §6.2 keeps the
 * *content* honest, and this is content).
 *
 * A scenario's colours never reach a golden: scenarios build their own worlds and
 * are compared with each other, not with `newGame` output.
 */
const PLAYER_COLORS: readonly string[] = [
  '#d12f2f', // red
  '#2f6fd1', // blue
  '#2f9e44', // green
  '#e8b400', // gold
  '#8b2fc9', // purple
  '#00a0a0', // teal
  '#e06b00', // orange
  '#5a3b1e', // brown
  '#c2258f', // magenta
  '#4b5563', // slate
  '#7bbf2a', // lime
  '#1f3b73', // navy
  '#b03060', // maroon
  '#00897b', // sea green
  '#9a7b1f', // olive
  '#6b7280', // grey
];

const COLOR_FALLBACK = '#000000';

const playerColor = (index: number): string =>
  PLAYER_COLORS[index % PLAYER_COLORS.length] ?? COLOR_FALLBACK;

const formatSettingsIssues = (issues: readonly SettingsIssue[]): string =>
  issues
    .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
    .join('; ');

/** `(x, y) [tile n]` — the coordinates *and* the index, so a message cannot be misread. */
const formatTile = (tile: TileIndex, map: GameMap): string =>
  `(${String(indexToX(map, tile))}, ${String(indexToY(map, tile))}) [tile ${String(tile)}]`;

const describeCommand = (command: Command, map: GameMap): string => {
  switch (command.type) {
    case 'MoveUnit':
      return `MoveUnit unit ${String(command.unitId)} to ${formatTile(command.to, map)}`;
    case 'EndTurn':
      return 'EndTurn';
    // Unreachable for today's union; kept total so a command added elsewhere
    // degrades to a vague message instead of breaking this module's build.
    default:
      return 'unrecognised command';
  }
};

const describeGameError = (error: GameError): string => {
  switch (error.kind) {
    case 'unknown-unit':
      return `unknown-unit (no unit ${String(error.unitId)})`;
    case 'unknown-player':
      return `unknown-player (no player ${String(error.playerId)})`;
    case 'not-your-unit':
      return `not-your-unit (unit ${String(error.unitId)} belongs to player ${String(error.owner)})`;
    case 'out-of-bounds':
      return `out-of-bounds (tile ${String(error.to)} is not on this map)`;
    case 'impassable':
      return `impassable (unit ${String(error.unitId)} cannot enter tile ${String(error.to)})`;
    case 'not-enough-movement':
      return (
        `not-enough-movement (unit ${String(error.unitId)} needs ${String(error.needed)}, ` +
        `has ${String(error.available)})`
      );
    case 'occupied-by-enemy':
      return `occupied-by-enemy (tile ${String(error.to)} holds another player's unit)`;
    case 'invalid-argument':
      return `invalid-argument (${error.detail})`;
    default:
      return 'unrecognised error';
  }
};

const describeSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `missing-terrain-role ("${error.role}"): the ruleset defines no terrain for that role`;
    case 'missing-unit-role':
      return `missing-unit-role ("${error.role}"): the ruleset defines no unit for that role`;
    case 'no-valid-starts':
      return `no-valid-starts (${String(error.civCount)} civilizations)`;
    case 'too-few-start-candidates':
      return 'too-few-start-candidates';
    default:
      return 'unrecognised setup error';
  }
};

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

/** A unit the scenario asked for, before ids and tiles are handed out. */
interface UnitPlacement {
  readonly playerIndex: number;
  readonly def: UnitDef;
  readonly x: number;
  readonly y: number;
}

/** The mutable world the builder records into. */
interface BuilderWorld {
  readonly ruleset: RulesetView;
  /** The patch as written; kept to catch a `civCount` that contradicts the players. */
  readonly patch: ScenarioSettings;
  readonly width: number;
  readonly height: number;
  readonly roles: TerrainRole[];
  readonly playerNames: string[];
  readonly placements: UnitPlacement[];
}

/**
 * Turn the recorded world into a `GameState`, or into the one `SetupError` a
 * hand-built map can produce.
 *
 * Authoring errors throw (see the module note): they are mistakes in the
 * scenario, and the failure to report is "you wrote this wrong", which
 * `SetupError` has no way to say.
 */
const buildState = (world: BuilderWorld): Result<GameState, SetupError> => {
  if (world.playerNames.length < MIN_PLAYERS) {
    throw new Error(
      `scenario builder: a world needs at least ${String(MIN_PLAYERS)} players ` +
        `(Settings.civCount is >= ${String(MIN_PLAYERS)}), but ${String(world.playerNames.length)} ` +
        'addPlayer call(s) were made',
    );
  }

  const patchCivCount = world.patch.civCount;
  if (patchCivCount !== undefined && patchCivCount !== world.playerNames.length) {
    throw new Error(
      `scenario builder: settings.civCount is ${String(patchCivCount)} but ` +
        `${String(world.playerNames.length)} players were added with addPlayer — the player list ` +
        'decides the civ count, so drop the patch key or make the two agree',
    );
  }

  // Roles resolve to terrain ids here, once, in row-major order: the first role
  // the ruleset cannot supply is the one reported, and the message names it
  // rather than a tile (the tile is where the author looks, the role is what is
  // missing).
  const size = world.width * world.height;
  const terrain = new Array<TerrainId>(size);
  const idByRole = new Map<TerrainRole, TerrainId>();
  for (let index = 0; index < size; index += 1) {
    const role = world.roles[index] ?? DEFAULT_FILL_ROLE;
    const cached = idByRole.get(role);
    if (cached !== undefined) {
      terrain[index] = cached;
      continue;
    }
    const def = TERRAIN_BY_ROLE(world.ruleset, role);
    if (def === undefined) return err({ kind: 'missing-terrain-role', role });
    idByRole.set(role, def.id);
    terrain[index] = def.id;
  }

  // Creation order is id order (dense ids, sorted array — the `newGame`
  // invariant), and a player's first placement is the tile it "started" on.
  const units: Unit[] = [];
  const startByPlayer = new Map<number, TileIndex>();
  for (const placement of world.placements) {
    const tile = tileIndex(world.width, placement.x, placement.y);
    if (!startByPlayer.has(placement.playerIndex)) {
      startByPlayer.set(placement.playerIndex, tile);
    }
    units.push({
      id: asUnitId(units.length),
      type: placement.def.id,
      owner: asPlayerId(placement.playerIndex),
      tile,
      movementLeft: placement.def.movement,
    });
  }

  const players: PlayerState[] = world.playerNames.map((name, index) => {
    const startingTile = startByPlayer.get(index);
    if (startingTile === undefined) {
      throw new Error(
        `scenario builder: player ${String(index)} ("${name}") has no unit, so the world has no ` +
          `tile it started on; add one with addUnit(${String(index)}, ...) — a hand-built world has ` +
          'no pre-history to fall back on',
      );
    }
    return {
      id: asPlayerId(index),
      name,
      color: playerColor(index),
      startingTile,
      // Every player the builder makes is a civilization. The builder is a
      // hand-built world with no `newGame` pass behind it, so it adds no
      // barbarian player; `kind` is still part of the persisted shape and is
      // therefore spelled out rather than defaulted (`civPlayers` reads it).
      kind: 'civ',
    };
  });

  // The player list decides `civCount`; the rest of the patch layers over the
  // defaults exactly as it does for the CLI (defaults -> patch -> parse).
  const resolved = loadSettings({ ...world.patch, civCount: players.length });
  if (!resolved.ok) {
    throw new Error(
      `scenario builder: settings cannot be resolved for ${String(players.length)} players — ` +
        formatSettingsIssues(resolved.error),
    );
  }

  // Fog memory starts empty and only ever grows (see the module note): the
  // builder has no history, so claiming any tile was seen would invent one.
  const explored: readonly (readonly boolean[])[] = players.map(() =>
    new Array<boolean>(size).fill(false),
  );

  return ok({
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    turn: 1,
    seed: resolved.value.seed,
    settings: resolved.value,
    rng: seedRng(resolved.value.seed),
    map: { width: world.width, height: world.height, terrain, huts: [] },
    players,
    nextUnitId: units.length,
    units,
    explored,
    // No city has been founded: a scenario that wants one issues `FoundCity`
    // through `run`. `nextCityId` starts at 0 and `cities` is empty, matching
    // what `newGame` leaves behind, so a `FoundCity` here is id 0.
    nextCityId: 0,
    cities: [],
  });
};

/**
 * Start a builder for a world of the dimensions `settings.mapSize` names.
 *
 * Not part of the frozen surface, but the assignment's point: a test that wants
 * to inspect a hand-built world directly (rather than only through
 * `runScenario`'s final state) needs to make one, and a test that wants a custom
 * ruleset cannot get one through `runScenario`. Invalid settings throw here, at
 * construction, rather than surfacing as a broken world later.
 */
export const createScenarioBuilder = (
  ruleset: RulesetView,
  settingsPatch: ScenarioSettings = {},
): ScenarioBuilder => {
  const resolved = loadSettings(settingsPatch);
  if (!resolved.ok) {
    throw new Error(`scenario builder: invalid settings — ${formatSettingsIssues(resolved.error)}`);
  }

  const dimensions = MAP_DIMENSIONS[resolved.value.mapSize];
  const world: BuilderWorld = {
    ruleset,
    patch: settingsPatch,
    width: dimensions.width,
    height: dimensions.height,
    roles: new Array<TerrainRole>(dimensions.width * dimensions.height).fill(DEFAULT_FILL_ROLE),
    playerNames: [],
    placements: [],
  };

  const checkTile = (x: number, y: number): void => {
    if (!inBounds(world, x, y)) {
      throw new Error(
        `scenario builder: (${String(x)}, ${String(y)}) is outside this world's ` +
          `${String(world.width)}x${String(world.height)} map (mapSize "${resolved.value.mapSize}"); ` +
          'set mapSize in the scenario settings for a different size',
      );
    }
  };

  const builder: ScenarioBuilder = {
    addPlayer(name) {
      if (name.trim() === '') {
        throw new Error('scenario builder: addPlayer needs a non-empty name');
      }
      world.playerNames.push(name);
      return builder;
    },

    fillTerrain(role) {
      world.roles.fill(role);
      return builder;
    },

    setTile(x, y, role) {
      checkTile(x, y);
      world.roles[tileIndex(world.width, x, y)] = role;
      return builder;
    },

    addUnit(playerIndex, type, at) {
      const known = world.playerNames.length;
      if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= known) {
        throw new Error(
          `scenario builder: addUnit(${String(playerIndex)}, ...) needs a player index in ` +
            `[0, ${String(known - 1)}]; ${String(known)} player(s) have been added with addPlayer`,
        );
      }

      const def = unitDef(world.ruleset, type);
      if (def === undefined) {
        const knownTypes = unitCatalog(world.ruleset)
          .map((unit) => unit.id)
          .join(', ');
        throw new Error(
          `scenario builder: the ruleset defines no unit type "${type}"` +
            (knownTypes === '' ? ' (it defines no units at all)' : ` (it defines: ${knownTypes})`),
        );
      }

      const [x, y] = at;
      checkTile(x, y);
      world.placements.push({ playerIndex, def, x, y });
      return builder;
    },

    build() {
      return buildState(world);
    },
  };

  return builder;
};

/* ------------------------------------------------------------------ *
 * Definition and execution
 * ------------------------------------------------------------------ */

/**
 * Name a scenario and check the settings it declares, once, at definition time.
 *
 * `defineScenario` is the sanctioned constructor, so a settings typo fails where
 * it is written instead of inside a run. The returned value is the scenario
 * itself: this validates, it does not wrap.
 */
export const defineScenario = (scenario: Scenario): Scenario => {
  if (scenario.name.trim() === '') {
    throw new Error('defineScenario: a scenario needs a non-empty name (a failing run reports it)');
  }
  const resolved = loadSettings(scenario.settings ?? {});
  if (!resolved.ok) {
    throw new Error(
      `scenario "${scenario.name}": invalid settings — ${formatSettingsIssues(resolved.error)}`,
    );
  }
  return scenario;
};

/**
 * The built-in ruleset at `fidelity`, validated the way every other entry point
 * validates it. A failure here is not a scenario failure: it means the shipped
 * catalog is broken (or that `cited-only` was asked for while every row is still
 * a placeholder), so it throws rather than being folded into a run result.
 */
const rulesetForFidelity = (fidelity: Fidelity): RulesetView => {
  const validated = validateRuleset(CATALOG, fidelity);
  if (!validated.ok) {
    const hint =
      fidelity === 'cited-only'
        ? ' — every row of the shipped catalog is a placeholder, so no scenario can run at ' +
          '"cited-only" until rows are sourced (PLAN.md §6.2)'
        : '';
    const details = validated.error.map((error) => JSON.stringify(error)).join('; ');
    throw new Error(
      `scenario runner: the built-in ruleset catalog does not validate at fidelity ` +
        `"${fidelity}"${hint}: ${details}`,
    );
  }
  return validated.value;
};

/**
 * Run `scenario` against `ruleset` — the seam `runScenario` cannot express,
 * because the frozen signature names no ruleset and the built-in catalog is
 * therefore the only one it can reach.
 */
export const runScenarioAgainst = (scenario: Scenario, ruleset: RulesetView): ScenarioRunResult => {
  const builder = createScenarioBuilder(ruleset, scenario.settings ?? {});
  const built = scenario.setup(builder).build();

  if (!built.ok) {
    return {
      name: scenario.name,
      passed: false,
      assertions: [{ ok: false, message: `setup failed: ${describeSetupError(built.error)}` }],
      finalState: undefined,
      hash: undefined,
      events: [],
    };
  }

  const assertions: ScenarioAssertion[] = [];
  const events: GameEvent[] = [];
  let current = built.value;

  // M2 has no active-player field, so the scenario's actor is player 0 by
  // definition; `build()` guarantees the array is not empty, and the check is
  // here so the runner cannot be reached with a world it cannot command.
  const actor = current.players[0]?.id;
  if (actor === undefined) {
    assertions.push({
      ok: false,
      message: 'the scenario world has no players, so no command can be applied to it',
    });
  } else {
    const commands = scenario.run ?? [];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      if (command === undefined) continue;

      const applied = applyCommand(current, actor, command, ruleset);
      if (!applied.ok) {
        assertions.push({
          ok: false,
          message:
            `run[${String(index)}] ${describeCommand(command, current.map)} was refused: ` +
            describeGameError(applied.error),
        });
        break;
      }
      current = applied.value.state;
      events.push(...applied.value.events);
    }
  }

  if (scenario.assert !== undefined) {
    assertions.push(...scenario.assert(current, ruleset));
  }

  // Non-vacuity: a scenario that checks nothing passes forever and detects
  // nothing, which is the failure mode the golden harness refuses on the hashing
  // side. A milestone's acceptance evidence must not be able to pass that way.
  if (assertions.length === 0) {
    assertions.push({
      ok: false,
      message:
        'the scenario asserts nothing, so a passing run would prove nothing; add an `assert` ' +
        'callback (or `run` commands) that checks the rule under test',
    });
  }

  return {
    name: scenario.name,
    passed: assertions.every((assertion) => assertion.ok),
    assertions,
    finalState: current,
    hash: hashValue(current),
    events,
  };
};

/**
 * Run a scenario against the built-in ruleset (`@civts/rules`' `CATALOG`,
 * validated at the fidelity the scenario's settings ask for).
 *
 * Settings are re-checked here as well as in `defineScenario`, because a
 * `Scenario` is a plain object and can be written literally; the runner must not
 * assume the check happened. A failure throws — it is a bug in the scenario, not
 * a result of running it.
 */
export const runScenario = (scenario: Scenario): ScenarioRunResult => {
  const resolved = loadSettings(scenario.settings ?? {});
  if (!resolved.ok) {
    throw new Error(
      `scenario "${scenario.name}": invalid settings — ${formatSettingsIssues(resolved.error)}`,
    );
  }
  return runScenarioAgainst(scenario, rulesetForFidelity(resolved.value.fidelity));
};
