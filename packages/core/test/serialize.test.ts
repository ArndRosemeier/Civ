/**
 * The one serializer: what it writes, what it refuses, and why each refusal is a *value*.
 * See docs/INTERFACES.md, M11 ("One serialization module, one version").
 *
 * The properties this file exists to pin, each of them a sentence of that contract:
 *
 * - **Round-trip is exact, over many states** — not one. The states below are the golden
 *   shapes (three fresh games, a played game, a game with a city in disorder, a finished game),
 *   so "the save round-trips" is a claim about the states this project actually hashes.
 * - **`deserialize` is TOTAL.** Malformed JSON, an unknown version, a missing field, a wrong
 *   type, an out-of-range index, a state that violates an invariant, a state written on another
 *   schema and a payload whose hash disagrees with its state each come back as a typed error.
 *   Each one is asserted by `kind`, never by prose, and each is asserted **not to throw** —
 *   a loader that answers a bad file with an exception is the failure mode this test is about.
 * - **A hash mismatch is a rejection**, which is the whole point: "a save that loads to a
 *   different game is worse than a save that fails". The test tampers with one field and shows
 *   both that the hash moves and that the loader refuses.
 * - **Optional fields stay absent**, never serialised as `undefined` — the payload text is
 *   searched for the substring, and the round trip is compared key by key.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  applyCommand,
  asBuildingId,
  asCityId,
  asPlayerId,
  asUnitId,
  civPlayers,
  deserialize,
  formatSaveError,
  gameOutcomeOf,
  isDisordered,
  isGameState,
  newGame,
  serialize,
  type City,
  type GameState,
  type PlayerId,
  type PlayerState,
  type Result,
  type RulesetView,
  type SaveCodec,
  type SaveError,
  type StateInvariant,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

/** The engine's own hasher, exactly as every shipping call site passes it. */
const CODEC: SaveCodec = { hash: hashValue, invariants: [] };
const P0 = asPlayerId(0);

/* ------------------------------------------------------------------ *
 * The states the round trip is proved over.
 * ------------------------------------------------------------------ */

/**
 * A fresh game, at **exactly** the settings `packages/testing/goldens/state.json` builds its
 * `tiny-civs2-seedN` entries with — including `seed` *inside* the settings, not only as
 * `newGame`'s first argument. That is not a detail: `settings.seed` is part of the state, so
 * leaving it at the default produced a different board from the golden one, and the hashes below
 * would have been this file's own rather than the suite's.
 */
const freshGame = (seed: number): GameState => {
  const started = newGame(
    seed,
    { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny', seed },
    RULESET,
  );
  if (!started.ok) throw new Error(`newGame failed for seed ${String(seed)}`);
  return started.value;
};

/**
 * A game with something in it: a city, production, an ended turn. Built by the engine's own
 * applier, so every field is a value the engine produced rather than one this file invented.
 */
const playSomeTurns = (seed: number, turns: number): GameState => {
  let state = freshGame(seed);
  for (let turn = 0; turn < turns; turn += 1) {
    const settler = state.units.find((unit) => unit.owner === P0 && unit.type === 'settler');
    if (settler !== undefined && state.cities.length === 0) {
      const founded = applyCommand(state, P0, { type: 'FoundCity', unitId: settler.id }, RULESET);
      if (!founded.ok) throw new Error(`founding a city was refused: ${founded.error.kind}`);
      state = founded.value.state;
      const chosen = applyCommand(
        state,
        P0,
        {
          type: 'SetProduction',
          cityId: asCityId(0),
          item: { kind: 'building', id: asBuildingId('granary') },
        },
        RULESET,
      );
      if (!chosen.ok) throw new Error(`setting production was refused: ${chosen.error.kind}`);
      state = chosen.value.state;
    }
    const ended = applyCommand(state, P0, { type: 'EndTurn' }, RULESET);
    if (!ended.ok) throw new Error(`ending the turn was refused: ${ended.error.kind}`);
    state = ended.value.state;
  }
  return state;
};

/** The same board with its first city past the top of the unhappy ladder and no luxuries. */
const disordered = (state: GameState): GameState => {
  const city = state.cities[0];
  if (city === undefined) throw new Error('the disorder fixture needs a city');
  const starved: GameState = {
    ...state,
    cities: state.cities.map((each) => (each.id === city.id ? { ...each, population: 40 } : each)),
    players: state.players.map((player) =>
      player.id === city.owner ? { ...player, luxuries: 0 } : player,
    ),
  };
  if (!isDisordered(starved, RULESET, city.id)) {
    throw new Error('the disorder fixture did not produce a disordered city');
  }
  return starved;
};

/** The same board with every civilization but one erased — a conquest, as the engine reads it. */
const finished = (state: GameState): GameState => {
  const keeper = civPlayers(state)[0];
  if (keeper === undefined) throw new Error('the finished fixture needs a civilization');
  const decided: GameState = {
    ...state,
    cities: state.cities.filter((city) => city.owner === keeper.id),
    units: state.units.filter((unit) => unit.owner === keeper.id),
  };
  const outcome = gameOutcomeOf(decided, RULESET);
  if (outcome === null || outcome.condition !== 'conquest') {
    throw new Error('the finished fixture did not end the game');
  }
  return decided;
};

/** A state with the shape a mid-game board has: a city with a queue, a worker with a job. */
const midGame = (): GameState => playSomeTurns(42, 12);

const STATES: readonly (readonly [string, GameState])[] = [
  // The three fresh-game goldens' seeds, at the settings those goldens use.
  ['fresh seed 1', freshGame(1)],
  ['fresh seed 42', freshGame(42)],
  ['fresh seed 1337', freshGame(1337)],
  // …and a larger map, so the dense layers (`tileOwner`, `explored`) are not all one size.
  [
    'fresh standard map',
    (() => {
      const started = newGame(7, { ...DEFAULT_SETTINGS, civCount: 4, mapSize: 'small' }, RULESET);
      if (!started.ok) throw new Error('newGame failed for the small map');
      return started.value;
    })(),
  ],
  ['played', midGame()],
  ['disordered', disordered(midGame())],
  ['finished', finished(midGame())],
];

/* ------------------------------------------------------------------ *
 * Round trip.
 * ------------------------------------------------------------------ */

describe('serialize / deserialize — the round trip', () => {
  it.each(STATES)('round-trips %s exactly, to the same engine hash', (_name, state) => {
    const written = serialize(state, CODEC);
    const read = deserialize(written, CODEC);
    if (!read.ok) throw new Error(`a save this module wrote did not load: ${read.error.kind}`);

    expect(read.value).toEqual(state);
    expect(hashValue(read.value)).toBe(hashValue(state));
  });

  it('is exact over every state at once, not one at a time', () => {
    // The same claim as above, folded: one hash list for every state, so a regression that
    // moved one state's round trip cannot hide behind the per-state tests passing.
    const hashes = STATES.map(([name, state]) => {
      const read = deserialize(serialize(state, CODEC), CODEC);
      if (!read.ok) throw new Error(`${name} did not load: ${read.error.kind}`);
      return hashValue(read.value);
    });
    expect(hashes).toEqual(STATES.map(([, state]) => hashValue(state)));
    // …and the claim is not vacuous: the states really do hash differently.
    expect(new Set(hashes).size).toBe(STATES.length);
  });

  it('round-trips the golden states themselves, to the hashes the golden file records', () => {
    // The three fresh entries of `packages/testing/goldens/state.json`, by name and by the hash
    // that file stores. This is a *leak test* and it is here for one reason: the states above are
    // built from the goldens' recipe, and a recipe that quietly stopped matching (a setting left
    // at its default, a map size moved) would leave every assertion in this file green while
    // "over every golden" became "over some states of the same shape". The numbers are the
    // golden file's own, so regenerating it fails here — which is the point.
    const GOLDENS: readonly (readonly [number, string])[] = [
      [1, '781d15e49cf79357'],
      [42, '782fe5306476b5d5'],
      [1337, '717543ac9b22ed91'],
    ];
    for (const [seed, hash] of GOLDENS) {
      const state = freshGame(seed);
      expect(hashValue(state), `seed ${String(seed)} is not the golden state`).toBe(hash);
      const read = deserialize(serialize(state, CODEC), CODEC);
      if (!read.ok) throw new Error(`the golden state did not load: ${read.error.kind}`);
      expect(read.value).toEqual(state);
      expect(hashValue(read.value)).toBe(hash);
    }
  });

  it('writes the four payload keys, and the state verbatim inside them', () => {
    const state = midGame();
    const parsed: unknown = JSON.parse(serialize(state, CODEC));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the payload is not an object');
    }
    expect(Object.keys(parsed).sort()).toEqual(['engine', 'hash', 'state', 'version']);
  });

  it('keeps optional fields ABSENT rather than writing undefined', () => {
    const text = serialize(midGame(), CODEC);
    expect(text).not.toContain('undefined');

    // A city building nothing spells that as the absence of `production`, and a player
    // researching nothing as the absence of `researching`. Both survive the round trip as
    // absence — a key written with `undefined` would be dropped by JSON and be invisible here,
    // so the check is made on the parsed object rather than on the text alone.
    const city = midGame().cities[0];
    const read = deserialize(serialize(midGame(), CODEC), CODEC);
    if (!read.ok) throw new Error('the mid-game state did not load');
    const readCity = read.value.cities[0];
    expect(city).toBeDefined();
    expect(Object.hasOwn(readCity ?? {}, 'production')).toBe(
      Object.hasOwn(city ?? {}, 'production'),
    );
    for (const player of read.value.players) {
      expect(Object.hasOwn(player, 'researching')).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Every way a load must fail, by kind.
 * ------------------------------------------------------------------ */

const payloadOfState = (state: GameState): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(serialize(state, CODEC));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the payload is not an object');
  }
  return { ...parsed };
};

/**
 * `deserialize` returns a typed error, and it **does not throw**. Both halves are asserted:
 * the throw is measured rather than assumed, because "the loader answered a bad file with an
 * exception" is the failure this milestone is about and a test that only read `.error` would
 * pass on a loader that threw a `SaveError`-shaped object.
 */
const refusal = (raw: unknown, codec: SaveCodec = CODEC): SaveError => {
  let captured: Result<GameState, SaveError> | undefined;
  let threw = false;
  try {
    captured = deserialize(raw, codec);
  } catch {
    threw = true;
  }
  expect(threw, 'deserialize threw instead of returning a typed error').toBe(false);
  if (captured === undefined) throw new Error('deserialize returned nothing at all');
  if (captured.ok) throw new Error('the payload was accepted; it should have been refused');
  return captured.error;
};

describe('deserialize is total — one typed error per failure class', () => {
  it('refuses text that is not JSON', () => {
    expect(refusal('{ not json').kind).toBe('malformed-json');
    expect(refusal('').kind).toBe('malformed-json');
    expect(refusal('[1,2,').kind).toBe('malformed-json');
  });

  it('refuses a value that is not a payload at all', () => {
    expect(refusal('[1,2,3]').kind).toBe('not-a-payload');
    expect(refusal('null').kind).toBe('not-a-payload');
    expect(refusal('7').kind).toBe('not-a-payload');
    expect(refusal(undefined).kind).toBe('not-a-payload');
  });

  it('refuses an unknown envelope version, and an unknown state version', () => {
    const payload = payloadOfState(midGame());
    expect(refusal({ ...payload, version: 2 })).toEqual({
      kind: 'unknown-version',
      where: 'save',
      found: 2,
    });
    expect(refusal({ ...payload, version: '1' }).kind).toBe('wrong-type');

    const state = payload['state'];
    if (typeof state !== 'object' || state === null) throw new Error('the payload has no state');
    expect(refusal({ ...payload, state: { ...state, schemaVersion: SCHEMA_VERSION + 1 } })).toEqual(
      { kind: 'unknown-version', where: 'state', found: SCHEMA_VERSION + 1 },
    );
  });

  it('refuses a payload or a state missing a field the engine needs', () => {
    const payload = payloadOfState(midGame());
    expect(refusal({ ...payload, hash: undefined })).toEqual({
      kind: 'missing-field',
      path: 'hash',
    });
    expect(refusal({ ...payload, engine: undefined })).toEqual({
      kind: 'missing-field',
      path: 'engine',
    });
    expect(refusal({ ...payload, state: undefined })).toEqual({
      kind: 'missing-field',
      path: 'state',
    });

    const state = payload['state'];
    if (typeof state !== 'object' || state === null) throw new Error('the payload has no state');
    const noUnits = { ...state } as Record<string, unknown>;
    delete noUnits['units'];
    expect(refusal({ ...payload, state: noUnits })).toEqual({
      kind: 'missing-field',
      path: 'state.units',
    });
  });

  it('refuses a field of the wrong type, at the path it is wrong at', () => {
    const payload = payloadOfState(midGame());
    expect(refusal({ ...payload, hash: 7 }).kind).toBe('wrong-type');

    const state = payload['state'];
    if (typeof state !== 'object' || state === null) throw new Error('the payload has no state');
    expect(refusal({ ...payload, state: { ...state, units: 'two' } })).toEqual({
      kind: 'wrong-type',
      path: 'state.units',
      expected: 'a list',
    });
    expect(refusal({ ...payload, state: { ...state, turn: 1.5 } })).toEqual({
      kind: 'wrong-type',
      path: 'state.turn',
      expected: 'a whole number',
    });
  });

  it('refuses a state whose shape the engine could not run', () => {
    const payload = payloadOfState(midGame());
    const state = payload['state'];
    if (typeof state !== 'object' || state === null) throw new Error('the payload has no state');
    const map = (state as Record<string, unknown>)['map'];
    if (typeof map !== 'object' || map === null) throw new Error('the payload has no map');

    // A truncated terrain layer: every later tile lookup would read `undefined`.
    expect(refusal({ ...payload, state: { ...state, map: { ...map, terrain: [] } } }).kind).toBe(
      'out-of-range',
    );
  });

  it('refuses an out-of-range index — a unit standing off the map', () => {
    const payload = payloadOfState(midGame());
    const state = payload['state'];
    if (typeof state !== 'object' || state === null) throw new Error('the payload has no state');
    const record = state as Record<string, unknown>;
    const units: readonly unknown[] = Array.isArray(record['units'])
      ? Array.from<unknown>(record['units'])
      : [];
    const first = units[0];
    if (typeof first !== 'object' || first === null) throw new Error('the state has no unit');
    const map = record['map'];
    if (typeof map !== 'object' || map === null) throw new Error('the payload has no map');
    const width = (map as Record<string, unknown>)['width'];
    const height = (map as Record<string, unknown>)['height'];
    if (typeof width !== 'number' || typeof height !== 'number') {
      throw new Error('the map has no dimensions');
    }

    const offMap = { ...first, tile: width * height };
    const units2 = [offMap, ...units.slice(1)];
    expect(refusal({ ...payload, state: { ...state, units: units2 } })).toEqual({
      kind: 'out-of-range',
      path: 'state.units[0].tile',
      detail: `${String(width * height)} is outside 0..${String(width * height - 1)}`,
    });

    // …and an ownership layer of the wrong length, which is the same class of defect one
    // layer up: every border question indexes into it.
    expect(refusal({ ...payload, state: { ...state, tileOwner: [0] } })).toMatchObject({
      kind: 'out-of-range',
      path: 'state.tileOwner',
    });
  });

  it('refuses a state that violates an invariant, naming the invariant', () => {
    const state = midGame();
    const broken: StateInvariant = {
      name: 'the-city-is-on-the-map',
      check: () => ['city 0 stands on tile 999999'],
    };
    const codec: SaveCodec = { hash: hashValue, invariants: [broken] };
    expect(refusal(serialize(state, codec), codec)).toEqual({
      kind: 'invariant-violated',
      violations: [{ invariant: 'the-city-is-on-the-map', detail: 'city 0 stands on tile 999999' }],
    });
  });

  it('reports an invariant that throws, rather than propagating it', () => {
    const state = midGame();
    const explosive: StateInvariant = {
      name: 'boom',
      check: () => {
        throw new Error('the check itself is broken');
      },
    };
    const codec: SaveCodec = { hash: hashValue, invariants: [explosive] };
    expect(refusal(serialize(state, codec), codec)).toEqual({
      kind: 'invariant-threw',
      invariant: 'boom',
      detail: 'the check itself is broken',
    });
  });

  it('refuses a save written on another game schema or another Node major', () => {
    const payload = payloadOfState(midGame());
    const engine = payload['engine'];
    if (typeof engine !== 'object' || engine === null) throw new Error('the payload has no engine');

    expect(refusal({ ...payload, engine: { ...engine, schemaVersion: 8 } })).toEqual({
      kind: 'engine-mismatch',
      field: 'schemaVersion',
      recorded: 8,
      running: SCHEMA_VERSION,
    });

    // The goldens' own rule, on the field the goldens record: a hash written on Node 24 is not
    // guaranteed on Node 26, so it is refused rather than trusted.
    expect(refusal({ ...payload, engine: { ...engine, nodeMajor: 26 } })).toEqual({
      kind: 'engine-mismatch',
      field: 'nodeMajor',
      recorded: 26,
      running: Number.parseInt(process.versions.node, 10),
    });
    expect(refusal({ ...payload, engine: { ...engine, nodeMajor: 'x' } }).kind).toBe('wrong-type');
  });

  it('REJECTS a payload whose hash disagrees with the state it carries', () => {
    const state = midGame();
    const payload = payloadOfState(state);
    const stored = payload['hash'];
    if (typeof stored !== 'string') throw new Error('the payload carries no hash');

    // A state that has moved on, under the hash of the state that was saved: exactly what a
    // truncated or hand-edited file looks like. The engine's recomputation notices.
    const moved = disordered(state);
    expect(hashValue(moved)).not.toBe(stored);
    expect(refusal({ ...payload, state: moved })).toEqual({
      kind: 'hash-mismatch',
      recorded: stored,
      actual: hashValue(moved),
    });

    // …and the same shape with the hash itself tampered with, so neither half is trusted.
    expect(refusal({ ...payload, hash: '0'.repeat(16) })).toEqual({
      kind: 'hash-mismatch',
      recorded: '0'.repeat(16),
      actual: stored,
    });
  });

  it('renders every error as a non-empty line, so none can become a blank one', () => {
    const samples: readonly SaveError[] = [
      { kind: 'malformed-json', detail: 'x' },
      { kind: 'not-a-payload', detail: 'x' },
      { kind: 'missing-field', path: 'hash' },
      { kind: 'wrong-type', path: 'hash', expected: 'a string' },
      { kind: 'out-of-range', path: 'state.turn', detail: 'x' },
      { kind: 'unknown-version', where: 'save', found: 2 },
      { kind: 'unknown-version', where: 'state', found: 2 },
      { kind: 'engine-mismatch', field: 'nodeMajor', recorded: 26, running: 24 },
      { kind: 'unhashable', detail: 'x' },
      { kind: 'hash-mismatch', recorded: 'a', actual: 'b' },
      { kind: 'invariant-violated', violations: [{ invariant: 'i', detail: 'd' }] },
      { kind: 'invariant-threw', invariant: 'i', detail: 'd' },
    ];
    for (const error of samples) {
      const text = formatSaveError(error);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('unhandled union member');
    }
  });
});

/* ------------------------------------------------------------------ *
 * `isGameState` — the predicate the loader narrows with.
 * ------------------------------------------------------------------ */

describe('isGameState', () => {
  it('accepts every state this project has, and refuses the shapes a bad file has', () => {
    for (const [name, state] of STATES) {
      expect(isGameState(state), `${name} was refused`).toBe(true);
      // The predicate sees what the round trip produces, not only what the engine holds:
      // a loader that accepted a state and then rejected its own output would be worse than
      // one that rejected both.
      const read: unknown = JSON.parse(serialize(state, CODEC));
      expect(isGameState(read)).toBe(false); // the *payload* is not a state…
      if (typeof read === 'object' && read !== null && !Array.isArray(read)) {
        expect(isGameState((read as Record<string, unknown>)['state'])).toBe(true); // …its state is.
      }
    }
    expect(isGameState(undefined)).toBe(false);
    expect(isGameState({})).toBe(false);
    expect(isGameState([])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The types the test leans on, pinned where they are declared.
 * ------------------------------------------------------------------ */

describe('the state the fixtures build is the one the contract describes', () => {
  it('gives the disorder fixture a disordered city and the finished fixture an ended game', () => {
    const state = midGame();
    const upset = disordered(state);
    const city = upset.cities[0];
    if (city === undefined) throw new Error('the disorder fixture has no city');
    expect(isDisordered(upset, RULESET, city.id)).toBe(true);

    const over = finished(state);
    expect(gameOutcomeOf(over, RULESET)?.condition).toBe('conquest');
  });

  it('gives the played fixture a city and a unit of the same seat', () => {
    // A round trip over an empty board would prove much less than the ones above claim: the
    // played fixture has to hold entities, and they have to be a real player's.
    const state = midGame();
    const seat: PlayerId = asPlayerId(0);
    const city: City | undefined = state.cities.find((each) => each.owner === seat);
    expect(city).toBeDefined();
    expect(state.units.some((unit) => unit.owner === seat)).toBe(true);
    const players: readonly PlayerState[] = state.players;
    expect(players.length).toBeGreaterThan(1);
    expect(asCityId(Number(city?.id))).toBe(city?.id);
    expect(asUnitId(Number(state.units[0]?.id))).toBe(state.units[0]?.id);
  });
});
