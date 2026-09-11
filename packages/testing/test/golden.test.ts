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
  newGame,
  planSetResearch,
  type Command,
  type GameEvent,
  type GameState,
  type RulesetView,
  type Settings,
  type SetupError,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset, type RulesetError } from '@civts/rules';
import { hashValue } from '../src/index.js';
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
 * The seed the **played** golden is built on. Deliberately one of the three seeds
 * above, so the played state is directly comparable with that seed's fresh state:
 * the two hashes differ *because commands were applied*, which is the assertion
 * that makes the played entry mean something.
 */
const PLAYED_SEED = 42;
const PLAYED_ENTRY_NAME = `played-civs${String(GOLDEN_CIV_COUNT)}-seed${String(PLAYED_SEED)}`;

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
  'building, grows, researches a tech and runs the money loop). ' +
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

/** The hashes this build of the engine produces, in scenario order. */
const actualEntries = (): readonly GoldenEntry[] => [
  ...GOLDEN_SEEDS.map((seed) => ({ name: entryName(seed), hash: hashValue(mustState(seed)) })),
  // The played scenario, stored beside the fresh worlds: same map, same seed, but a
  // state that thirty turns of play have moved — which is exactly what makes it a
  // different entry rather than a duplicate of `tiny-civs2-seed42`.
  { name: PLAYED_ENTRY_NAME, hash: hashValue(playedGame().state) },
];

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
    `expected: the committed golden file with ${String(GOLDEN_SEEDS.length + 1)} entries ` +
      `(${[...GOLDEN_SEEDS.map((seed) => entryName(seed)), PLAYED_ENTRY_NAME].join(', ')})`,
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
    // Every entry — the three fresh worlds *and* the played one — must hash
    // differently from every other. A collision between two entries would mean one of
    // them detects nothing the other does not, and between a fresh world and the
    // played state on the same seed it would mean the play changed nothing.
    const hashes = actualEntries().map((entry) => entry.hash);
    expect(new Set(hashes).size).toBe(actualEntries().length);
    expect(hashes.length).toBe(GOLDEN_SEEDS.length + 1);
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

  it('stores the played entry beside the fresh ones, under its own name', () => {
    // The list itself: four entries, all distinct, the played one last and named for
    // what it is. `actualEntries` is the single source both the comparison and the
    // regeneration read, so a drift between "what is checked" and "what is written"
    // is impossible by construction.
    const entries = actualEntries();
    expect(entries).toHaveLength(GOLDEN_SEEDS.length + 1);
    expect(entries.map((entry) => entry.name)).toEqual([
      ...GOLDEN_SEEDS.map(entryName),
      PLAYED_ENTRY_NAME,
    ]);
    expect(new Set(entries.map((entry) => entry.hash)).size).toBe(entries.length);
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
