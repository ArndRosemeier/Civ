/**
 * Golden replay harness (docs/INTERFACES.md W4; PLAN.md §5.3 determinism,
 * §10 testing tiers).
 *
 * What this file is for: a small, fixed set of worlds whose state hashes are
 * stored in `packages/testing/goldens/state.json`. If map generation, state
 * assembly or the hasher changes behaviour, the hashes move and this test fails
 * with the expected/actual pair. That is the whole value of a golden, so the
 * harness is deliberately built to be **unable to pass by rewriting itself**:
 *
 * - The test never writes unless `CIVTS_WRITE_GOLDENS=1` is set explicitly. A
 *   missing file or a differing hash is a failure, with the regeneration command
 *   in the message plus the reminder that a rehash needs a
 *   `rehash: <reason>` note in the commit message.
 * - The stored `nodeMajor` is compared with the running one. PLAN.md §5.3 scopes
 *   the determinism guarantee to a pinned `(engine revision, Node major)`, so a
 *   Node upgrade is expected to change hashes — and must be an intentional,
 *   recorded rehash rather than a surprise in CI.
 * - The scenarios themselves are checked for non-vacuity: distinct seeds must
 *   produce distinct hashes, and perturbing a state must move its hash. A golden
 *   that cannot fail would pass forever and detect nothing.
 *
 * The ruleset is `@civts/rules`' `CATALOG` (the real content the CLI runs on),
 * put through the same `validateRuleset` the CLI runs — a validated `Ruleset`
 * carries a `role` per terrain and is therefore structurally the engine's
 * `RulesetView`, with no adapter in between.
 *
 * **Migrated to the M3 state shape** (docs/INTERFACES.md M3). The golden hashes
 * moved a second time — `SCHEMA_VERSION` 2 -> 3, `nextCityId`/`cities` on the
 * state, `kind` on a player and a barbarian player appended by `newGame`, `huts`
 * on the map — and the file was regenerated through this harness's own opt-in
 * path (`CIVTS_WRITE_GOLDENS=1`), never by hand. The civ-count check below now
 * asks `civPlayers`, because `players` ends with the barbarian player.
 *
 * M5 moved them a fourth time (`SCHEMA_VERSION` 6 -> 7: `PlayerState` gained
 * `techs` and the optional `researching`), and regenerated the file the same way.
 *
 * **M6 moves them a fifth time (`SCHEMA_VERSION` 7 -> 8), and the movement is bigger than
 * the version bump suggests.** Two independent things changed inside the hashed JSON:
 *
 * - `Unit` gained `hitPointsLeft`, which `newGame` writes on every starting unit — one new
 *   key per unit, so no state can hash the same; and the two omitted-when-default keys
 *   `experience` and `fortified`, which `newGame` deliberately does *not* write, because a
 *   fresh settler has taken no damage, earned no promotion and is not dug in. The old and
 *   new hashes are recorded in this commit's message, and the *shape* claim is the one
 *   that matters: a key holding `undefined` would not have round-tripped, and the file is
 *   written through the harness's own opt-in path either way.
 * - The shipped catalog changed too — M6 gives every unit row real combat statistics,
 *   adds gated rows, and gives every terrain the `defenseBonus` the M6 contract names. The
 *   three *fresh-seed* entries therefore move even though the ruleset is not hashed: a
 *   starting army's units carry the `hitPoints` their definitions declare, and the set of
 *   units `newGame` can place depends on which rows the catalog offers.
 *
 * Regenerated with `CIVTS_WRITE_GOLDENS=1`, never by hand, and this test passes **without**
 * that variable afterwards — which is the property that makes the file a gate rather than a
 * transcript. A `rehash: <reason>` line belongs in the commit message for the same reason
 * it did the previous four times.
 *
 * **M6 adds a *third* kind of entry beside those: a battle.** `played-civs2-seed42-combat`
 * is the played world with one `AttackUnit` applied through the command path — the applier,
 * not the resolver — chosen and placed entirely by engine code. It exists because M6's
 * acceptance list asks for "a played golden that INCLUDES combat, so battles are covered at
 * hash level", and it is stored in the file rather than hashed inside the test so the fight
 * is pinned across engine revisions. It is a separate scenario rather than more turns of the
 * played one because that script cannot reach an enemy on this map: the two civilizations
 * start 37 tiles apart, and the unit it produces is the *scout*, whose attack is 0. The
 * entry list moved from four to five, and the five are pinned by name here and in every
 * adversarial suite that reads this file.
 *
 * **M5 also adds a second kind of entry: a *played* state.** The three seed entries
 * are `newGame` output — a fresh world nobody has touched — which pins generation and
 * assembly but never exercises a command. `played-civs2-seed42` is the same tiny map
 * and civ count with a **fixed command script** applied to it: a city is founded, a
 * worker builds an improvement, a unit and then a building are produced, the city
 * grows, a tech is researched and the money loop runs for thirty turns. Its hash is
 * stored beside the others, and the assertions around it prove the script actually
 * did those things rather than merely running — because a "played" golden whose script
 * silently refused every command would be a hash of the same fresh state under a
 * misleading name. The script is fixed *and* self-describing: it resolves each choice
 * through `applyCommand` (the cheapest unit the catalog defines, the first
 * improvement legal on the worker's tile, the first researchable tech), so it does not
 * hold a hand-copied second opinion about what is legal.
 */

import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  civPlayers,
  gameOutcomeOf,
  outcomeFor,
  hitPointsLeftOf,
  newGame,
  planSetResearch,
  scoreHorizon,
  spawnUnit,
  unitById,
  unitDef,
  unitMoveOptions,
  type Command,
  type GameEvent,
  type GameState,
  type RulesetView,
  type Settings,
  type SetupError,
  type UnitId,
  type VictoryResult,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset, type RulesetError } from '@civts/rules';
import { canonicalize, hashValue } from '../src/index.js';
import {
  goldensPath,
  loadGoldens,
  saveGoldens,
  type GoldenEntry,
  type GoldenFile,
} from '../src/goldens.js';

/* ------------------------------------------------------------------ *
 * Scenarios (fixed list; changing it changes the golden file, so it is a
 * deliberate act that also needs a rehash note).
 * ------------------------------------------------------------------ */

const GOLDEN_SEEDS = [1, 42, 1337] as const;
const GOLDEN_MAP_SIZE = 'tiny';
const GOLDEN_CIV_COUNT = 2;

/**
 * The promotion cap the played golden's battles may reach (M6b).
 *
 * It used to be `MAX_EXPERIENCE`, a module constant of `core/combat.ts`. That number is
 * the catalog's `combat.maxExperience` now — the same value, in the one place a balance
 * sweep can move it — so this fixture reads it from `CATALOG` rather than from
 * `@civts/core`. The assertions below are unchanged: they still require every stored
 * promotion to sit in `1..this`, and still require `UnitPromoted.maxExperience` to be
 * exactly it.
 */
const GOLDEN_MAX_EXPERIENCE = CATALOG.combat.maxExperience;

/**
 * The seed the **played** golden is built on. Deliberately one of the three seeds
 * above, so the played state is directly comparable with that seed's fresh state:
 * the two hashes differ *because commands were applied*, which is the assertion
 * that makes the played entry mean something.
 */
const PLAYED_SEED = 42;
const PLAYED_ENTRY_NAME = `played-civs${String(GOLDEN_CIV_COUNT)}-seed${String(PLAYED_SEED)}`;
/**
 * M6's own scenario: the played world above, plus one battle applied through the command
 * path (`AttackUnit`). It is a separate entry rather than more turns inside the played one
 * because the played map cannot reach a fight — see the entry-list test below — and it is
 * named after the world it is built on so a reader can see where it comes from.
 */
const COMBAT_ENTRY_NAME = `${PLAYED_ENTRY_NAME}-combat`;

/**
 * M10's entry — the played game continued until a victory condition ends it.
 *
 * Named for what it is, like the other two: the map, the civilization count and the seed
 * it starts from, plus the fact that it is the *ended* game rather than the played one.
 */
const VICTORY_ENTRY_NAME = `${PLAYED_ENTRY_NAME}-victory`;

/**
 * How many turns the played script ends. Fixed rather than "until something
 * happens": a golden is a replay, and a loop that stopped early would make the
 * stored hash depend on the stopping rule as well as on the engine.
 *
 * 30 turns is enough for every step the milestone is about, with room to spare, and
 * the tests below assert each of them *did* happen — so a shorter run, a ruleset
 * change or a broken step fails loudly here instead of quietly hashing a state
 * where nothing occurred.
 */
const PLAYED_TURNS = 30;

/** The turns between founding and the second production order (see `playedGame`). */
const PLAYED_FIRST_PRODUCTION_TURNS = 6;

const GOLDEN_NOTE =
  'State hashes for packages/testing/test/golden.test.ts ' +
  '(seeds 1, 42, 1337; map size tiny; 2 civilizations; plus one played 30-turn game ' +
  'on seed 42, which founds a city, builds an improvement, produces a unit and a ' +
  'building, grows, researches a tech and runs the money loop; plus one battle applied ' +
  'to that played game with AttackUnit, stored as played-civs2-seed42-combat; plus that ' +
  'played game continued to the turn limit, where the score condition ends it and seat 0 ' +
  'wins, stored as played-civs2-seed42-victory). ' +
  'Hashes are only guaranteed for a pinned (engine revision, Node major): ' +
  'changing one requires an intentional regeneration and a "rehash: <reason>" note in the commit message.';

/** Set only by an explicit regeneration run; never by a normal test run. */
const WRITE_MODE = process.env['CIVTS_WRITE_GOLDENS'] === '1';

const REGENERATE_COMMAND =
  'CIVTS_WRITE_GOLDENS=1 npx vitest run packages/testing/test/golden.test.ts';
const REHASH_INSTRUCTION = 'and record a "rehash: <reason>" note in the commit message.';

/* ------------------------------------------------------------------ *
 * The ruleset under test
 * ------------------------------------------------------------------ */

const formatRulesetError = (e: RulesetError): string => {
  switch (e.kind) {
    case 'empty-catalog':
      return `empty catalog: ${e.catalog}`;
    case 'duplicate-id':
      return `duplicate id in ${e.catalog}: ${e.id}`;
    case 'placeholder-in-cited-only':
      return `placeholder row in cited-only mode: ${e.catalog}/${e.id} (${e.note})`;
    case 'invalid-value':
      return `invalid value: ${e.catalog}/${e.id}.${e.field} — ${e.detail}`;
    case 'missing-role':
      return `no terrain fills role "${e.role}"`;
    // M5: a tree with a prerequisite cycle is refused before a game can run on it,
    // and this renders it as the loop it is (`a -> b -> a`) rather than as a set of
    // rows, because that is what the operator has to break.
    case 'tech-cycle':
      return `tech prerequisite cycle in ${e.catalog}: ${e.detail}`;
  }
};

/**
 * The catalog is validated exactly as the CLI validates it, and the resulting
 * `Ruleset` is used directly: `TerrainSpec.role` makes it structurally the
 * engine's `RulesetView`, so the previous "read the role off the terrain id"
 * adapter is gone. Throwing here rather than defaulting keeps a broken catalog
 * from being reported as a wrong golden hash.
 */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the placeholder catalog does not validate: ${validated.error.map(formatRulesetError).join('; ')}`,
    );
  }
  return validated.value;
})();

/* ------------------------------------------------------------------ *
 * Building the states under test
 * ------------------------------------------------------------------ */

const settingsFor = (seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  mapSize: GOLDEN_MAP_SIZE,
  civCount: GOLDEN_CIV_COUNT,
  seed,
});

const entryName = (seed: number): string =>
  `${GOLDEN_MAP_SIZE}-civs${String(GOLDEN_CIV_COUNT)}-seed${String(seed)}`;

/**
 * Render a setup failure for a test-failure message.
 *
 * Kept local and self-contained rather than imported from
 * `packages/headless/src/repl.ts`: this package must not depend on the REPL (the
 * golden harness is the thing the REPL is measured against, not the other way
 * round), and the switch is exhaustively typed, so a new `SetupError` variant
 * fails this build instead of degrading to "unknown setup error".
 */
const formatSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `ruleset is missing terrain role "${error.role}"`;
    case 'missing-unit-role':
      return `ruleset is missing a unit for role "${error.role}"`;
    case 'no-valid-starts':
      return `no valid starting tile for ${String(error.civCount)} civilizations`;
    case 'too-few-start-candidates':
      return 'too few starting-tile candidates for the requested civilizations';
  }
};

const mustState = (seed: number): GameState => {
  const result = newGame(seed, settingsFor(seed), RULESET);
  if (!result.ok) {
    throw new Error(
      `golden scenario seed=${String(seed)}: newGame failed — ${formatSetupError(result.error)}`,
    );
  }
  return result.value;
};

/* ------------------------------------------------------------------ *
 * The played scenario (M5): a fixed script, applied through the applier
 * ------------------------------------------------------------------ */

/** What a played game produced: the state at the end, and everything that happened. */
interface PlayedGame {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** The played game continued to its ending: the board, the verdict, and how long it took. */
interface VictoryGame {
  readonly state: GameState;
  /** Who the engine says won and by what — `gameOutcomeOf`'s own `VictoryResult`. */
  readonly verdict: VictoryResult;
  /** Turns played past the played entry's own 30. */
  readonly turns: number;
  readonly events: readonly GameEvent[];
}

/**
 * Apply one command as player 0, or fail loudly.
 *
 * Throwing rather than matching on a refusal is the point: the script is fixed, so a
 * refusal is not a case to handle — it means the script and the engine have drifted,
 * and a golden that swallowed it would store a hash of a game nobody played.
 */
const step = (state: GameState, command: Command, events: GameEvent[]): GameState => {
  const outcome = applyCommand(state, PLAYER_ZERO(state), command, RULESET);
  if (!outcome.ok) {
    throw new Error(
      `the played golden's script was refused: ${JSON.stringify(command)} — ${JSON.stringify(outcome.error)}`,
    );
  }
  events.push(...outcome.value.events);
  return outcome.value.state;
};

/** Player 0's id, read off the state rather than assumed to be 0. */
const PLAYER_ZERO = (state: GameState) => {
  const first = civPlayers(state)[0];
  if (first === undefined) throw new Error('the golden board has no civilizations');
  return first.id;
};

/** The player 0 row of a state. */
const playerZero = (state: GameState) => civPlayers(state)[0];

/**
 * The played scenario: one fixed script, resolved against the state as it goes.
 *
 * Every *choice* in it is made by the engine rather than copied here — the cheapest
 * unit the catalog defines, the first improvement the applier accepts on the worker's
 * tile, the first tech `planSetResearch` accepts — so the script cannot hold a second
 * opinion about legality, and a catalog retune changes the golden deliberately (via a
 * regeneration) rather than breaking this file.
 *
 * The shape of the game it plays:
 *
 * 1. the starting settler founds a city (`CityFounded`);
 * 2. the starting worker begins the first improvement it is allowed to build
 *    (`WorkStarted`), and finishes it a few turns later (`WorkCompleted`);
 * 3. the city is set to produce the cheapest unit, which it finishes
 *    (`CityProduced`);
 * 4. the player selects the first tech it may research (`SetResearch`, which emits
 *    nothing) and completes it some turns later (`TechResearched`);
 * 5. the city is then set to produce the cheapest building, which it finishes too —
 *    so the stored state carries a *building* as well as a unit, and production's
 *    second kind is covered;
 * 6. and the money loop runs every turn in between (`IncomeCollected` /
 *    `UpkeepPaid`, for both civilizations, including the idle one).
 */
const playedGame = (): PlayedGame => {
  const events: GameEvent[] = [];
  let state = mustState(PLAYED_SEED);
  const playerId = PLAYER_ZERO(state);

  // 1. Found the city with the starting settler.
  const settler = state.units.find((unit) => unit.owner === playerId && unit.type === 'settler');
  if (settler === undefined) {
    throw new Error('the played golden expects player 0 to start with a settler');
  }
  state = step(state, { type: 'FoundCity', unitId: settler.id }, events);

  // 2. Put the starting worker to work on the first improvement the applier accepts
  //    on its own tile (catalog order, so it is the same one every run).
  const worker = state.units.find((unit) => unit.owner === playerId && unit.type === 'worker');
  if (worker === undefined) {
    throw new Error('the played golden expects player 0 to start with a worker');
  }
  const work = RULESET.improvements.find(
    (improvement) =>
      applyCommand(
        state,
        playerId,
        { type: 'StartWork', unitId: worker.id, kind: improvement.id },
        RULESET,
      ).ok,
  );
  if (work === undefined) {
    throw new Error('no improvement in the catalog can be built on the worker’s tile');
  }
  state = step(state, { type: 'StartWork', unitId: worker.id, kind: work.id }, events);

  // 3. Produce the cheapest unit, and 4. research the first tech that may be.
  const cheapestUnit = [...RULESET.units].sort((a, b) => a.cost - b.cost)[0];
  if (cheapestUnit === undefined) throw new Error('the catalog defines no units');
  const city = state.cities[0];
  if (city === undefined) throw new Error('the played golden expects the city it just founded');
  state = step(
    state,
    { type: 'SetProduction', cityId: city.id, item: { kind: 'unit', id: cheapestUnit.id } },
    events,
  );

  const tech = RULESET.techs.find(
    (candidate) => planSetResearch(state, RULESET, playerId, candidate.id).ok,
  );
  if (tech === undefined)
    throw new Error('no tech in the catalog may be researched from a fresh start');
  state = step(state, { type: 'SetResearch', tech: tech.id }, events);

  // The first stretch: the improvement completes, the unit is produced, the city
  // grows at least once, and the research accumulates.
  for (let turn = 0; turn < PLAYED_FIRST_PRODUCTION_TURNS; turn += 1) {
    state = step(state, { type: 'EndTurn' }, events);
  }

  // 5. Then the cheapest building, so the played state carries both production kinds.
  const cheapestBuilding = [...RULESET.buildings].sort((a, b) => a.cost - b.cost)[0];
  const cityAfter = state.cities[0];
  if (cheapestBuilding !== undefined && cityAfter !== undefined) {
    state = step(
      state,
      {
        type: 'SetProduction',
        cityId: cityAfter.id,
        item: { kind: 'building', id: cheapestBuilding.id },
      },
      events,
    );
  }

  // 6. The rest of the run.
  for (let turn = PLAYED_FIRST_PRODUCTION_TURNS; turn < PLAYED_TURNS; turn += 1) {
    state = step(state, { type: 'EndTurn' }, events);
  }

  return { state, events };
};

/**
 * M6's combat golden: **a battle fought through the applier**, on the played world.
 *
 * M6's acceptance list asks for "a played golden that INCLUDES combat, so battles are
 * covered at hash level". This is that entry — `COMBAT_ENTRY_NAME` — and it is deliberately
 * the strongest version of it available:
 *
 * - **The battle is a command.** The attack goes through `applyCommand` as
 *   `{ type: 'AttackUnit' }`, so the stored state is what the *command path* produces:
 *   legality (`planAttackUnit`), the resolver, the damage, the death of a unit that
 *   reaches 0, a possible promotion, the `CombatResolved`/`UnitDestroyed`/`UnitPromoted`
 *   events, and the advance of the world's RNG all happen in one applied command. An
 *   earlier draft of this fixture called `resolveCombat` and applied the losses with
 *   `woundUnit` by hand, and it said so plainly — that version hashed the resolver's
 *   arithmetic but proved nothing about the applier, which is where a generator and an
 *   applier can disagree. Neither the resolver call nor the hand-wound loss survives here.
 * - **The board is the played world**, not a fresh one: `playedGame()`'s 30-turn state, with
 *   its city, its produced unit, its improvement and its researched tech, is the base.
 * - **Every choice is made by the engine.** The attacker is the first shipped row that may
 *   attack (`attack > 0`, M6's own legality rule; the played world's produced unit is the
 *   *scout*, whose attack is 0, which is why this fixture places combatants at all). Its
 *   tile is its owner's starting tile and the defender's is the **first tile in
 *   `unitMoveOptions`** — the engine's own answer about where that land unit may go — so
 *   this file holds no opinion about terrain, domains or occupancy. The defender is the
 *   next attack-capable row, owned by the other civilization, and it is *placed on* the
 *   chosen tile rather than moved there, because a move onto an enemy-occupied tile is the
 *   one move the engine refuses.
 * - **Throwing rather than degrading.** A refused attack, or an accepted one with no
 *   `CombatResolved` event, throws. A battle that silently did not happen would hash as
 *   though the golden covered combat while containing none.
 *
 * The stored entry's own assertions (`resolves a real battle...`, below) check the state
 * against the applier's account of it, so the entry is never taken on trust.
 */
interface CombatGame {
  /** The played world with both combatants placed on it, before the attack. */
  readonly before: GameState;
  /** The same world after `AttackUnit`: wounded units, and any that died simply gone. */
  readonly state: GameState;
  readonly attacker: UnitId;
  readonly defender: UnitId;
  /** The battle the *applier* reported, read off its own event rather than re-resolved. */
  readonly combat: CombatEvent;
  /** Every event the attack emitted, in order. */
  readonly events: readonly GameEvent[];
}

/** The event `AttackUnit` emits for the unit-vs-unit half of its two shapes. */
type CombatEvent = Extract<GameEvent, { readonly type: 'CombatResolved' }>;

const combatGame = (): CombatGame => {
  const played = playedGame().state;
  const sides = civPlayers(played);

  // The two rows that may attack, in catalog order: the same pair every run, and a catalog
  // retune changes it deliberately. `attack > 0` is M6's legality rule read directly — a
  // row with no attack strength is not a candidate, which is why the scout is skipped.
  const combatants = RULESET.units.filter((row) => row.attack > 0).slice(0, 2);
  const attackerDef = combatants[0];
  const defenderDef = combatants[1] ?? combatants[0];
  if (attackerDef === undefined || defenderDef === undefined) {
    throw new Error(
      'the combat golden needs at least one catalog unit with attack > 0, and this ruleset has none',
    );
  }

  const attackerSide = sides[0];
  const defenderSide = sides[1] ?? sides[0];
  if (attackerSide === undefined || defenderSide === undefined) {
    throw new Error('the played world has no civilizations to fight with');
  }

  // 1. The attacker, placed by the engine's own helper on its owner's starting tile.
  const attackerSpawn = spawnUnit(played, attackerDef, attackerSide.id, attackerSide.startingTile);

  // 2. The defender's tile: the first destination the engine says this attacker may move to.
  //    Read from `unitMoveOptions` rather than computed here, so the fixture cannot disagree
  //    with the mover about what terrain a land unit may stand on.
  const destinations = unitMoveOptions(attackerSpawn.state, RULESET, attackerSpawn.unit.id);
  const target = destinations[0];
  if (target === undefined) {
    throw new Error(
      `the combat golden's attacker at ${String(attackerSide.startingTile)} has nowhere to go, ` +
        'so no enemy can be placed beside it',
    );
  }
  const defenderSpawn = spawnUnit(attackerSpawn.state, defenderDef, defenderSide.id, target);
  const board = defenderSpawn.state;
  const attacker = attackerSpawn.unit;
  const defender = defenderSpawn.unit;

  // 3. The attack, through the command path — the whole subject of this entry.
  const applied = applyCommand(
    board,
    attackerSide.id,
    { type: 'AttackUnit', unitId: attacker.id, target },
    RULESET,
  );
  if (!applied.ok) {
    throw new Error(
      `the combat golden's attack was refused: ${JSON.stringify(applied.error)}. ` +
        'A combat golden that contains no battle is worse than no entry at all.',
    );
  }
  const combat = applied.value.events.find(
    (event): event is CombatEvent => event.type === 'CombatResolved',
  );
  if (combat === undefined) {
    throw new Error(
      'the applier accepted the attack but reported no CombatResolved event, so the entry ' +
        'would hash a battle nobody can account for',
    );
  }

  return {
    before: board,
    state: applied.value.state,
    attacker: attacker.id,
    defender: defender.id,
    combat,
    events: applied.value.events,
  };
};

/**
 * M10's victory entry: **the played game, continued until a real victory condition ends
 * it.**
 *
 * M9+M10's acceptance list asks for "a played golden that INCLUDES a victory, so the end
 * of a game is covered at hash level". This is that entry. It is deliberately the
 * strongest version of the item available:
 *
 * - **It starts from the played game**, so the stored state is the end of a game a player
 *   really played — a founded city, a finished improvement, a produced unit, a researched
 *   tech, a completed building — and not a board arranged into a terminal shape.
 * - **Every turn goes through the applier** (`step`, i.e. `applyCommand ... EndTurn`), so
 *   the victory is reached by the turn loop rather than asserted about a state.
 * - **The condition is the score condition at the horizon**, which is the one the engine
 *   reaches unaided: `scoreVictoryTurn` is a catalog magnitude and `turn.ts` evaluates the
 *   conditions after the money loop, so the game ends on the turn `scoreHorizon` names and
 *   the highest-scoring civilization wins. Measured cost: 199 further turns, ~70 ms, which
 *   is cheap enough for the fast tier and is why this is a *played* entry rather than a
 *   second hand-built board.
 *
 * The `outcome` is returned alongside so the test can pin the condition, the turn and the
 * winner — an entry whose hash moved is a regression, but an entry that stopped *ending*
 * would be a hole this file could otherwise store silently.
 */
const victoryGame = (): VictoryGame => {
  const events: GameEvent[] = [];
  let state = playedGame().state;
  // The loop asks the engine's total predicate (`gameOutcomeOf`), which answers "is this
  // game over, and how" without a viewer; the *reading* a seat gets — with the `kind` and
  // the turnaround — is taken from `outcomeFor` by the test below, so neither function is
  // asked a question it does not answer.
  let verdict = endingOf(state);
  let turns = 0;

  // The bound is a guard on THIS loop, not a game rule: the horizon is a catalog
  // magnitude and a run that somehow never reached it must fail loudly rather than spin.
  const limit = scoreHorizon(RULESET) + 1;
  while (verdict === null && turns < limit) {
    state = step(state, { type: 'EndTurn' }, events);
    verdict = endingOf(state);
    turns += 1;
  }

  if (verdict === null) {
    throw new Error(
      `the victory golden played ${String(turns)} turns past the ${String(
        scoreHorizon(RULESET),
      )}-turn horizon and no condition ever held — a victory entry that contains no victory ` +
        'is worse than no entry at all',
    );
  }
  return { state, verdict, turns, events };
};

/** Is this game over, and by what — the engine's own total predicate. */
const endingOf = (state: GameState): VictoryResult | null => gameOutcomeOf(state, RULESET);

/** The hashes this build of the engine produces, in scenario order. */
const actualEntries = (): readonly GoldenEntry[] => [
  ...GOLDEN_SEEDS.map((seed) => ({ name: entryName(seed), hash: hashValue(mustState(seed)) })),
  // The played scenario, stored beside the fresh worlds: same map, same seed, but a
  // state that thirty turns of play have moved — which is exactly what makes it a
  // different entry rather than a duplicate of `tiny-civs2-seed42`.
  { name: PLAYED_ENTRY_NAME, hash: hashValue(playedGame().state) },
  // M6's battle, stored as an entry rather than hashed in a test: the acceptance item is
  // about the golden *file* covering combat, and an unstored hash gates nothing across
  // engine revisions. `combatGame` applies a real `AttackUnit` to the played world.
  { name: COMBAT_ENTRY_NAME, hash: hashValue(combatGame().state) },
  // M10's ending, for the same reason one milestone later: an engine revision that broke
  // the victory rule would change this hash, and the entry is what makes that a diff
  // rather than something only a live game could notice.
  { name: VICTORY_ENTRY_NAME, hash: hashValue(victoryGame().state) },
];

/** One entry's stored hash, or a failure that names the entry even when the file is absent. */
const readEntryHash = (name: string): string => {
  const stored = requireStored();
  const entry = stored.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw failure(`golden file ${goldensPath()} has no entry "${name}"`, [
      `expected: an entry named "${name}"`,
      `actual:   ${stored.entries.map((candidate) => candidate.name).join(', ')}`,
    ]);
  }
  return entry.hash;
};

const runningNodeMajor = (): number => {
  const major = process.versions.node.split('.')[0];
  return major === undefined ? Number.NaN : Number.parseInt(major, 10);
};

/* ------------------------------------------------------------------ *
 * Failure reporting: every path shows expected vs actual and says what an
 * intentional change looks like.
 * ------------------------------------------------------------------ */

const failure = (heading: string, lines: readonly string[]): Error =>
  new Error(
    [
      heading,
      '',
      ...lines,
      '',
      `Regenerate intentionally:\n  ${REGENERATE_COMMAND}`,
      REHASH_INSTRUCTION,
    ].join('\n'),
  );

const missingFileError = (): Error =>
  failure(`golden file missing: ${goldensPath()}`, [
    `expected: the committed golden file with ${String(GOLDEN_SEEDS.length + 2)} entries ` +
      `(${[...GOLDEN_SEEDS.map((seed) => entryName(seed)), PLAYED_ENTRY_NAME, COMBAT_ENTRY_NAME].join(', ')})`,
    'actual:   no file at that path',
  ]);

const requireStored = (): GoldenFile => {
  const stored = loadGoldens();
  if (stored === undefined) throw missingFileError();
  return stored;
};

/** Per-entry expected/actual lines, covering missing, extra and differing hashes. */
const diffLines = (
  stored: readonly GoldenEntry[],
  actual: readonly GoldenEntry[],
): readonly string[] => {
  const actualByName = new Map(actual.map((entry) => [entry.name, entry.hash] as const));
  const storedNames = new Set(stored.map((entry) => entry.name));
  const lines: string[] = [];

  for (const entry of stored) {
    const got = actualByName.get(entry.name);
    if (got === undefined) {
      lines.push(`  ${entry.name}: expected ${entry.hash}, actual <no such entry was rebuilt>`);
    } else if (got !== entry.hash) {
      lines.push(`  ${entry.name}: expected ${entry.hash}, actual ${got}`);
    }
  }

  for (const entry of actual) {
    if (!storedNames.has(entry.name)) {
      lines.push(`  ${entry.name}: expected <absent from the golden file>, actual ${entry.hash}`);
    }
  }

  return lines;
};

/* ------------------------------------------------------------------ *
 * The scenarios themselves — always checked, in both modes.
 * ------------------------------------------------------------------ */

describe('golden scenarios', () => {
  it('is deterministic: rebuilding the same seeds reproduces the same hashes', () => {
    expect(actualEntries()).toEqual(actualEntries());
  });

  it('is not vacuous: distinct scenarios produce distinct hashes', () => {
    // Every entry — the three fresh worlds *and* the three played ones — must hash
    // differently from every other. A collision between two entries would mean one of
    // them detects nothing the other does not, and between a fresh world and the
    // played state on the same seed it would mean the play changed nothing. The M10
    // victory entry is the sharpest case of that: it starts from the played entry and
    // adds ~199 turns, so if the two ever hashed alike the turn loop would be doing
    // nothing that reaches the hash at all.
    const entries = actualEntries();
    const hashes = entries.map((entry) => entry.hash);
    expect(new Set(hashes).size).toBe(entries.length);
    expect(hashes.length).toBe(GOLDEN_SEEDS.length + 3);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('would catch a change: perturbing a state moves its hash', () => {
    const state = mustState(42);
    const baseline = hashValue(state);

    // A one-turn difference, and a different world at the same turn: both must
    // move the digest, which is what makes a stored hash meaningful.
    expect(hashValue({ ...state, turn: state.turn + 1 })).not.toBe(baseline);
    expect(hashValue({ ...state, map: mustState(1).map })).not.toBe(baseline);
  });

  it('builds every seed on land with the requested civilization count', () => {
    for (const seed of GOLDEN_SEEDS) {
      const state = mustState(seed);
      expect(state.settings.mapSize).toBe(GOLDEN_MAP_SIZE);
      // One player per *civilization*: M3 appends a barbarian player to
      // `players`, so the count that answers "how many civilizations did the
      // harness ask for" is `civPlayers`, never `players.length`.
      expect(civPlayers(state)).toHaveLength(GOLDEN_CIV_COUNT);
      expect(state.players).toHaveLength(GOLDEN_CIV_COUNT + 1);
      expect(state.seed).toBe(seed);
    }
  });

  it('plays: the fixed script founds, grows, produces, improves, researches and banks', () => {
    // The played entry's evidence. A golden's hash proves only that *something*
    // reproducible happened; these assertions prove the something is the game the
    // entry's name claims — founding, growth, production, an improvement, research
    // and the money loop. Without them a script that silently refused every command
    // would store the fresh state under a played name and pass.
    const game = playedGame();
    const kinds = new Set(game.events.map((event) => event.type));

    // The whole milestone, in the event stream the script produced.
    for (const required of [
      'CityFounded',
      'CityGrew',
      'CityProduced',
      'WorkCompleted',
      'TechResearched',
      'IncomeCollected',
      'UpkeepPaid',
    ]) {
      expect(kinds, `the played golden never produced a ${required}`).toContain(required);
    }

    // Production happened twice — a unit and then a building — which is what makes it
    // "production" rather than "one item".
    const produced = game.events.filter((event) => event.type === 'CityProduced');
    expect(produced.length).toBeGreaterThanOrEqual(2);

    // The state says the same thing the events do.
    const player = playerZero(game.state);
    const city = game.state.cities[0];
    expect(city).toBeDefined();
    if (city !== undefined && player !== undefined) {
      expect(game.state.cities).toHaveLength(1);
      // Growth: citizens are worked, so more than the founding population of 1.
      expect(city.population).toBeGreaterThanOrEqual(2);
      expect(city.workedTiles.length).toBeGreaterThanOrEqual(2);
      // A building was finished, and the worker's improvement is on the map.
      expect(city.buildings.length).toBeGreaterThanOrEqual(1);
      expect(game.state.improvements.length).toBeGreaterThanOrEqual(1);
      // Research: a tech is known and the pool has banked beakers in it.
      expect([...player.techs].length).toBeGreaterThanOrEqual(1);
      expect(player.beakers).toBeGreaterThan(0);
      // The money loop ran: gold was collected and a unit produced costs upkeep.
      expect(player.treasury).not.toBe(civPlayers(mustState(PLAYED_SEED))[0]?.treasury);
    }

    // The run lasted the script's full length, and the map and civ count are the
    // ones the entry's name promises.
    expect(game.state.turn).toBe(PLAYED_TURNS + 1);
    expect(game.state.seed).toBe(PLAYED_SEED);
    expect(civPlayers(game.state)).toHaveLength(GOLDEN_CIV_COUNT);
    expect(game.state.settings.mapSize).toBe(GOLDEN_MAP_SIZE);
  });

  it('plays reproducibly, and the played state is not the fresh one', () => {
    // Two properties in one, because either alone is worthless: the script must
    // replay to the same hash, and it must have *moved* the state — a played golden
    // that equalled its seed's fresh hash would be a duplicate entry wearing a
    // misleading name, and the most likely way for that to happen is a script whose
    // commands were all refused.
    const first = playedGame();
    const second = playedGame();

    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toEqual(second.events);
    expect(hashValue(first.state)).not.toBe(hashValue(mustState(PLAYED_SEED)));
    // And it is a different *world* from the other seeds, so the entry is not a
    // duplicate of one of those either.
    expect(hashValue(first.state)).not.toBe(hashValue(mustState(1)));
    expect(hashValue(first.state)).not.toBe(hashValue(mustState(1337)));
  });

  /*
   * ------------------------------------------------------------------ *
   * M6: what every stored state has to say about units
   * ------------------------------------------------------------------ *
   */

  it('stores units that are all alive, at whole hit points, with no key holding undefined', () => {
    // M6 puts a unit's health inside the hashed JSON, so the *invariants* of that field are
    // what this milestone's golden has to prove — a stored state carrying a unit at 0 hit
    // points would be a state describing something the engine says cannot exist, and it
    // would hash perfectly well. Checked on every entry, fresh and played alike, because a
    // played world is where a wounded unit would first appear.
    // Every stored scenario, fresh and played alike, because a played world is where a
    // wounded unit would first appear. The states are built once here rather than through
    // `actualEntries`, which would recompute the played game per entry.
    const scenarios: readonly (readonly [string, GameState])[] = [
      ...GOLDEN_SEEDS.map((seed): readonly [string, GameState] => [
        entryName(seed),
        mustState(seed),
      ]),
      [PLAYED_ENTRY_NAME, playedGame().state],
      // M6's battle, where a unit is *actually wounded* — the reason the field exists. A
      // stored state is exactly where a unit at 0 hit points would survive unnoticed, so
      // this scenario is checked by the same rule as the others rather than trusted.
      [COMBAT_ENTRY_NAME, combatGame().state],
      // M10's ending, which is a state where the turn loop has stopped: it is checked by
      // the same unit-health rules as every other entry, and a finished game's board is
      // exactly where a unit left at 0 hit points would survive unnoticed.
      [VICTORY_ENTRY_NAME, victoryGame().state],
    ];
    for (const [name, state] of scenarios) {
      expect(state.units.length, `${name} has no units to check`).toBeGreaterThan(0);

      for (const unit of state.units) {
        expect(Number.isInteger(unit.hitPointsLeft), `${name} unit ${String(unit.id)}`).toBe(true);
        expect(unit.hitPointsLeft).toBeGreaterThanOrEqual(1);
        // …and above its catalog maximum is equally impossible: `hitPointsLeft` is a
        // resource that is spent, never banked.
        const def = unitDef(RULESET, unit.type);
        expect(def).toBeDefined();
        expect(unit.hitPointsLeft).toBeLessThanOrEqual(def?.hitPoints ?? 1);

        // A unit that is not promoted and not dug in must carry neither key, and no key at
        // all may hold `undefined` — that is the spelling that cannot survive a JSON round
        // trip. `canonicalize` throws on it, so this call is the assertion.
        //
        // `experience` is the one key that may legitimately be present in a stored state:
        // M6's promotion writes it on the winner of a battle, and the combat entry is where
        // that happened. Where it is present it must be a positive whole number inside the
        // engine's cap — never the default zero (which the schema omits) and never a
        // fraction — and it may appear in *no other* scenario, which is the rule that keeps
        // a stray promotion from hiding in the fresh worlds.
        expect('fortified' in unit).toBe(false);
        if (unit.experience === undefined) {
          expect('experience' in unit).toBe(false);
        } else {
          expect(name, `${name} carries a promotion outside the combat entry`).toBe(
            COMBAT_ENTRY_NAME,
          );
          expect(Number.isInteger(unit.experience)).toBe(true);
          expect(unit.experience).toBeGreaterThanOrEqual(1);
          expect(unit.experience).toBeLessThanOrEqual(GOLDEN_MAX_EXPERIENCE);
        }
        expect(() => canonicalize(unit)).not.toThrow();
      }

      // The whole state, not only its units: a stray `undefined` anywhere would make the
      // stored file unreadable in exactly the way the version bump exists to avoid.
      expect(() => canonicalize(state)).not.toThrow();
    }
  });

  it('hashes the hit points, so a golden cannot be blind to combat damage', () => {
    // The property the entry is *for*. M6's whole point is that a unit can be hurt, so a
    // state's hash has to move when it is — otherwise a battle could happen, change the
    // game, and leave every golden in this file reporting "unchanged". Asserted by
    // perturbing the field the milestone added rather than by trusting that it is hashed.
    const played = playedGame().state;
    // The victim is chosen as a unit that *can* be wounded — one whose row declares more than
    // one hit point — because the perturbation has to stay inside `1..hitPoints` to be a state
    // the engine could really produce. That such a unit exists is itself part of the
    // assertion: a played golden whose every unit had one hit point could not express damage
    // at all, and this test would have nothing to prove.
    const victim = played.units.find((unit) => (unitDef(RULESET, unit.type)?.hitPoints ?? 1) >= 2);
    expect(
      victim,
      'the played golden contains no unit with more than one hit point, so damage is unrepresentable',
    ).toBeDefined();
    if (victim === undefined) return;

    const maximum = unitDef(RULESET, victim.type)?.hitPoints ?? 1;
    expect(maximum).toBeGreaterThanOrEqual(2);

    const wounded: GameState = {
      ...played,
      units: played.units.map((unit) =>
        unit.id === victim.id ? { ...unit, hitPointsLeft: maximum - 1 } : unit,
      ),
    };
    const woundedVictim = wounded.units.find((unit) => unit.id === victim.id);
    if (woundedVictim === undefined) throw new Error('the wounded copy lost the unit it wounded');
    expect(hitPointsLeftOf(woundedVictim)).toBe(maximum - 1);
    expect(hashValue(wounded)).not.toBe(hashValue(played));
    expect(unitById(wounded, victim.id)?.hitPointsLeft).toBe(maximum - 1);

    // And it is the *field* that moved the hash, not the array identity: the same mutation
    // written as the same value changes nothing.
    const same: GameState = { ...played, units: played.units.map((unit) => ({ ...unit })) };
    expect(hashValue(same)).toBe(hashValue(played));
  });

  it('plays a world whose M6 statistics are the shipped ones, not a fixture', () => {
    // The played golden is built from `CATALOG` through `validateRuleset`, so its units'
    // hit points come from real content: this asserts the two are connected. A fixture
    // ruleset would satisfy every invariant above while proving nothing about what ships.
    const played = playedGame().state;
    const types = new Set(played.units.map((unit) => unit.type));

    for (const type of types) {
      const shipped = CATALOG.units.find((candidate) => candidate.id === type);
      expect(shipped, `${String(type)} is not a shipped unit row`).toBeDefined();
      for (const unit of played.units.filter((candidate) => candidate.type === type)) {
        expect(unit.hitPointsLeft).toBe(shipped?.hitPoints ?? 1);
      }
    }
  });

  it('plays a real battle through the applier, and stores it as a hash', () => {
    // M6's acceptance item: "a played golden that INCLUDES combat, so battles are covered at
    // hash level". The battle is an applied `AttackUnit` — the command path, not a resolver
    // call — on the played world, and its hash is a **stored entry** in
    // `goldens/state.json`, so the fight is pinned across engine revisions like every other
    // scenario rather than only inside one build.
    const played = playedGame().state;
    const first = combatGame();
    const second = combatGame();

    // The stored entry is this state: the file's hash for the name and the hash computed
    // here are the same number, so "the golden includes a battle" is a fact about the file
    // rather than a claim about this test. In regeneration mode the file is written *from*
    // `actualEntries` after this, so only the read path is compared against the disk.
    expect(actualEntries().find((entry) => entry.name === COMBAT_ENTRY_NAME)?.hash).toBe(
      hashValue(first.state),
    );
    if (!WRITE_MODE) {
      expect(readEntryHash(COMBAT_ENTRY_NAME)).toBe(hashValue(first.state));
    }

    // Determinism first: two runs of the same world produce the same state, which is the
    // property a golden hash is for.
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.state).toEqual(second.state);

    // …and the battle is *in* the state, not merely around it. A state that hashed the same
    // as the world it was played on would be a combat entry in name only.
    expect(hashValue(first.state)).not.toBe(hashValue(played));

    // The attack really was accepted as a command, and it emitted the applier's own account
    // of the fight — odds, rounds and both sides' losses — which the assertions below read
    // instead of re-resolving the battle. `attackerWinPct` is the resolver's figure, and the
    // clamp M6 states (1..99, so neither side is ever certain) holds on it.
    expect(first.events[0]?.type).toBe('CombatResolved');
    expect(first.combat.attackerId).toBe(first.attacker);
    expect(first.combat.defenderId).toBe(first.defender);
    expect(first.combat.attackerOwner).toBe(civPlayers(played)[0]?.id);
    expect(first.combat.target).toBe(unitById(first.before, first.defender)?.tile);
    expect(first.combat.attackerWinPct).toBeGreaterThanOrEqual(1);
    expect(first.combat.attackerWinPct).toBeLessThanOrEqual(99);
    expect(first.combat.rounds).toBeGreaterThanOrEqual(1);
    expect(first.combat.attackerLost + first.combat.defenderLost).toBeGreaterThan(0);

    // A unit that died, died *of this battle* and says so: the `UnitDestroyed` event names
    // the killer and the reason, and the reason is combat rather than a disband.
    const killed = first.events.filter((event) => event.type === 'UnitDestroyed');
    for (const event of killed) {
      expect(event.reason).toBe('combat');
      expect(event.byUnitId).toBe(
        event.unitId === first.attacker ? first.defender : first.attacker,
      );
    }

    const beforeIds = new Set(first.before.units.map((unit) => Number(unit.id)));
    const afterIds = new Set(first.state.units.map((unit) => Number(unit.id)));
    const dead = [...beforeIds].filter((id) => !afterIds.has(id));

    // Exactly the units `defenderSurvives`/`attackerSurvives` say are gone — no more, no
    // fewer, and always one of the two combatants.
    expect(dead.length).toBe(
      (first.combat.attackerSurvives ? 0 : 1) + (first.combat.defenderSurvives ? 0 : 1),
    );
    // …and the death events say exactly as much: the roster is short by one unit, and the
    // applier reported one `UnitDestroyed` for each side it says did not survive.
    expect(killed.length).toBe(dead.length);
    for (const id of dead) {
      expect([Number(first.attacker), Number(first.defender)]).toContain(id);
    }
    // A destroyed unit is *removed*, never retained at 0 hit points (M6's invariant), so the
    // roster shrinks by exactly the number that died.
    expect(first.state.units.length).toBe(beforeIds.size - dead.length);

    // The survivors are wounded by exactly the hit points the resolver charged them, which is
    // the other half of "the result is the state".
    const beforeOf = (id: UnitId): number => {
      const unit = first.before.units.find((candidate) => candidate.id === id);
      if (unit === undefined) throw new Error(`the board lost unit ${String(id)} before the fight`);
      return hitPointsLeftOf(unit);
    };
    const afterOf = (id: UnitId): number | undefined => {
      const unit = first.state.units.find((candidate) => candidate.id === id);
      return unit === undefined ? undefined : hitPointsLeftOf(unit);
    };
    // A survivor is down *exactly* the hit points the resolver charged it; a casualty took at
    // least everything it had left and is no longer on the board. Stated as one rule so the
    // two sides cannot be checked by two different standards.
    const expectWounds = (id: UnitId, lost: number, survives: boolean): void => {
      const before = beforeOf(id);
      if (survives) {
        expect(afterOf(id)).toBe(before - lost);
      } else {
        expect(afterOf(id)).toBeUndefined();
        expect(lost).toBeGreaterThanOrEqual(before);
      }
    };
    expectWounds(first.attacker, first.combat.attackerLost, first.combat.attackerSurvives);
    expectWounds(first.defender, first.combat.defenderLost, first.combat.defenderSurvives);

    // The stream moved too: a battle that drew dice and left the world's RNG untouched would
    // replay the same dice in the next battle.
    expect(first.state.rng).not.toEqual(played.rng);

    // And M6's invariants survive the fight: no live unit at 0 hit points, no unit above its
    // catalog maximum, and no key holding `undefined` (which would make a save unreadable).
    const promoted = first.state.units.filter((unit) => unit.experience !== undefined);
    for (const unit of first.state.units) {
      const def = unitDef(RULESET, unit.type);
      expect(hitPointsLeftOf(unit)).toBeGreaterThanOrEqual(1);
      expect(hitPointsLeftOf(unit)).toBeLessThanOrEqual(def?.hitPoints ?? 1);
      // `fortified` is absent here: neither `spawnUnit` nor the attack fortifies anyone.
      expect('fortified' in unit).toBe(false);
      // `experience` is present *only* on a unit that won a battle, which is the promotion
      // rule — and this state is the one place in the file where that can be true, so the
      // field is checked here rather than assumed absent. Where it is present it is a whole
      // number inside the engine's cap; the default zero is never written, because the schema
      // omits it, and a presence check plus a value check is what catches a zero slip through.
      if (unit.experience === undefined) {
        expect('experience' in unit).toBe(false);
      } else {
        expect(Number.isInteger(unit.experience)).toBe(true);
        expect(unit.experience).toBeGreaterThanOrEqual(1);
        expect(unit.experience).toBeLessThanOrEqual(GOLDEN_MAX_EXPERIENCE);
        expect([first.attacker, first.defender]).toContain(unit.id);
      }
    }
    expect(() => canonicalize(first.state)).not.toThrow();

    // Every promotion the state carries is one the applier *reported*, with the level it
    // reports: the event and the field cannot disagree about how seasoned a winner is, and a
    // promotion written without an event (or the other way round) fails here.
    const promotions = first.events.filter((event) => event.type === 'UnitPromoted');
    const byId = (a: { readonly unitId: UnitId }, b: { readonly unitId: UnitId }): number =>
      Number(a.unitId) - Number(b.unitId);
    expect([...promotions].sort(byId).map((event) => Number(event.unitId))).toEqual(
      [...promoted].sort((a, b) => Number(a.id) - Number(b.id)).map((unit) => Number(unit.id)),
    );
    for (const event of promotions) {
      const unit = first.state.units.find((candidate) => candidate.id === event.unitId);
      expect(unit?.experience).toBe(event.experience);
      expect(event.maxExperience).toBe(GOLDEN_MAX_EXPERIENCE);
    }
  });

  it('stores the played entry beside the fresh ones, under its own name', () => {
    // The list itself: six entries, all distinct, the three played ones last and named for
    // what they are. `actualEntries` is the single source both the comparison and the
    // regeneration read, so a drift between "what is checked" and "what is written"
    // is impossible by construction.
    //
    // **M6 makes it five.** The combat entry (`COMBAT_ENTRY_NAME`) is the milestone's
    // acceptance item — a played state that includes a battle — and it is stored under its
    // own name rather than folded into the played entry, because the played script cannot
    // reach an enemy: the two civilizations' starts are 37 tiles apart on this map, and the
    // unit the script produces is the *scout*, whose attack is 0. Rather than pushing the
    // played scenario's turn count past 40 and hoping a generated map has a land path, the
    // battle is its own scenario whose board is the played world plus an applied
    // `AttackUnit` — engine-placed combatants, engine legality, engine dice. The entry list
    // is pinned by name here *and* in the adversarial suites, which were updated with it.
    // **M10 makes it six.** The victory entry (`VICTORY_ENTRY_NAME`) is this wave's
    // acceptance item — "a played golden that INCLUDES a victory, so the end of a game is
    // covered at hash level" — and it is the played game continued to the horizon rather
    // than a board arranged into a terminal shape, so the hash covers the end of a *real*
    // game. The entry list is pinned by name here *and* in the adversarial suites, which
    // were updated with it.
    const entries = actualEntries();
    expect(entries).toHaveLength(GOLDEN_SEEDS.length + 3);
    expect(entries.map((entry) => entry.name)).toEqual([
      ...GOLDEN_SEEDS.map(entryName),
      PLAYED_ENTRY_NAME,
      COMBAT_ENTRY_NAME,
      VICTORY_ENTRY_NAME,
    ]);
    expect(new Set(entries.map((entry) => entry.hash)).size).toBe(entries.length);
  });

  it('stores a played game that a victory condition really ended', () => {
    // M9+M10's acceptance item — "a played golden that INCLUDES a victory, so the end of a
    // game is covered at hash level" — proved rather than implied. The hash alone cannot
    // tell a game that ended from a game that ran out of script, so the ending itself is
    // pinned: the condition, the turn and the winner, read from the stored state's own
    // board through `outcomeFor`.
    //
    // The turn is asserted against `scoreHorizon(RULESET)` rather than against a written
    // 200, so a catalog retune of the horizon moves this test with the rule instead of
    // making it fail; the winner is asserted to be a real seat rather than "somebody".
    const game = victoryGame();
    const seat = PLAYER_ZERO(game.state);
    // The seat's own reading of its ending — the function a screen and a CLI both use —
    // so "the golden contains a victory" is asserted in the vocabulary the product speaks.
    const reading = outcomeFor(game.state, RULESET, seat);
    expect(reading?.kind).toBe('victory');
    expect(reading?.condition).toBe('score');
    expect(reading?.turn).toBe(scoreHorizon(RULESET));
    expect(reading?.winner).toBe(seat);
    expect(game.state.turn).toBe(scoreHorizon(RULESET));
    expect(game.verdict.condition).toBe('score');
    // The turn count is a *report*, not a rule — the rule is the horizon pinned above.
    // What matters is that the loop really played turns, so the ending was reached by
    // play rather than read off a state that was already terminal.
    expect(game.turns).toBeGreaterThan(0);

    // Non-vacuity, in the two directions that matter: the game was *still in play* at the
    // played entry's own end (so the condition is reached by the turns this entry adds,
    // not inherited), and the turn loop stopped because the game was over rather than
    // because the guard ran out.
    expect(endingOf(playedGame().state)).toBeNull();
    expect(game.turns).toBeLessThan(scoreHorizon(RULESET) + 1);
  });

  it('names the reason when a ruleset cannot populate the world', () => {
    // The diagnosis path a failed golden actually uses: `mustState` renders the
    // typed `SetupError` instead of letting a raw error escape. M2 added
    // `missing-unit-role` (`newGame` now places a starting settler per player),
    // so this pins that the harness names it — and that it names it as a *unit*
    // problem, not a terrain one.
    const withoutUnits: RulesetView = {
      terrains: RULESET.terrains,
      units: [],
      improvements: RULESET.improvements,
      fidelity: 'tuned',
    };
    const withoutTerrain: RulesetView = {
      terrains: [],
      units: RULESET.units,
      improvements: RULESET.improvements,
      fidelity: 'tuned',
    };

    const noUnits = newGame(GOLDEN_SEEDS[0], settingsFor(GOLDEN_SEEDS[0]), withoutUnits);
    expect(noUnits.ok).toBe(false);
    if (!noUnits.ok) {
      expect(formatSetupError(noUnits.error)).toBe('ruleset is missing a unit for role "settler"');
    }

    const noTerrain = newGame(GOLDEN_SEEDS[0], settingsFor(GOLDEN_SEEDS[0]), withoutTerrain);
    expect(noTerrain.ok).toBe(false);
    if (!noTerrain.ok) {
      expect(formatSetupError(noTerrain.error)).toMatch(/missing terrain role/);
      expect(formatSetupError(noTerrain.error)).not.toBe(
        'ruleset is missing a unit for role "settler"',
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * Comparison with the stored file, or (opt-in) regeneration.
 * ------------------------------------------------------------------ */

if (WRITE_MODE) {
  describe('golden regeneration (CIVTS_WRITE_GOLDENS=1)', () => {
    it('writes the golden file and reads it back unchanged', () => {
      const entries = actualEntries();
      const file: GoldenFile = {
        note: GOLDEN_NOTE,
        nodeMajor: runningNodeMajor(),
        entries: [...entries],
      };

      saveGoldens(file);

      expect(loadGoldens()).toEqual(file);
      console.log(
        `goldens written: ${goldensPath()}\n` +
          'If any hash changed, make sure the commit message carries a "rehash: <reason>" note.',
      );
    });
  });
} else {
  describe('golden file', () => {
    it('exists and was produced by this harness', () => {
      const stored = requireStored();

      // The expected *names* come from `actualEntries`, so adding a scenario to the
      // harness cannot leave this check asserting a stale count — it fails until the
      // file is regenerated, which is the point of a golden.
      const expected = actualEntries();
      if (stored.entries.length !== expected.length) {
        throw failure(`golden file entry count in ${goldensPath()}`, [
          `expected: ${String(expected.length)} entries (${expected.map((entry) => entry.name).join(', ')})`,
          `actual:   ${String(stored.entries.length)} (${stored.entries.map((entry) => entry.name).join(', ')})`,
        ]);
      }

      if (stored.note !== GOLDEN_NOTE) {
        throw failure(`golden file note differs from the harness note in ${goldensPath()}`, [
          `expected: ${GOLDEN_NOTE}`,
          `actual:   ${stored.note}`,
        ]);
      }

      expect(stored.entries).toHaveLength(actualEntries().length);
    });

    it('was recorded on the running Node major', () => {
      const stored = requireStored();
      const running = runningNodeMajor();

      if (stored.nodeMajor !== running) {
        throw failure(`golden file recorded on Node major ${String(stored.nodeMajor)}`, [
          `expected: nodeMajor ${String(running)} (the running Node ${process.versions.node})`,
          `actual:   nodeMajor ${String(stored.nodeMajor)} in ${goldensPath()}`,
          '',
          'Hashes are only guaranteed for a pinned (engine revision, Node major), so a Node upgrade',
          'is expected to move them — intentionally, not silently.',
        ]);
      }

      expect(stored.nodeMajor).toBe(running);
    });

    it('reproduces every stored state hash', () => {
      const stored = requireStored();
      const actual = actualEntries();
      const lines = diffLines(stored.entries, actual);

      if (lines.length > 0) {
        throw failure(`golden state hashes differ from ${goldensPath()}`, [
          'expected vs actual:',
          ...lines,
        ]);
      }

      for (const entry of actual) {
        const match = stored.entries.find((storedEntry) => storedEntry.name === entry.name);
        expect(match?.hash).toBe(entry.hash);
      }
    });
  });
}

describe('goldensPath', () => {
  it('points at the committed, package-relative data file', () => {
    const path = goldensPath();
    expect(path.endsWith(join('packages', 'testing', 'goldens', 'state.json'))).toBe(true);
    expect(isAbsolute(path)).toBe(true);
  });
});
