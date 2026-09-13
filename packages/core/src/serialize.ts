/**
 * **The one serializer.** `serialize(state, codec)` and `deserialize(unknown, codec)`, and
 * nothing else in the tree writes a save.
 * See docs/INTERFACES.md, M11 ("One serialization module, one version").
 *
 * "Not `JSON.stringify` at a call site — one place, because a second serializer is a second
 * format and this project has found 'two things that must agree' defects seven times now."
 * Before this module the web panel had its own `{ schema, hash, state }` envelope and the REPL
 * had a third spelling (`{ schemaVersion, engine: 'civts', nodeMajor, state }`, written through
 * `canonicalize`). Two envelopes means a save written by one is unreadable by the other, and
 * nothing in either package can notice.
 *
 * ## The payload
 *
 * ```json
 * { "version": 1, "engine": { "schemaVersion": 9, "nodeMajor": 24 }, "hash": "…", "state": { … } }
 * ```
 *
 * - `version` is the **envelope** version (`SAVE_VERSION`), a number this module owns. It is
 *   deliberately *not* `SCHEMA_VERSION`: the envelope may gain a key without the game changing,
 *   and the game may change without the envelope changing, so one number for both would have to
 *   be bumped for reasons that do not apply to the other half.
 * - `engine` names the **schema version and the Node major**, which is how the goldens already
 *   pin a hash: `@civts/testing`'s golden file records `nodeMajor` and the gate fails when it
 *   differs from the running Node. A save records the same fact for the same reason — a hash is
 *   only guaranteed across an identical `(schemaVersion, Node major)` pair.
 *   `nodeMajor` is **absent**, never `undefined`, where there is no Node: the browser is a host
 *   too (M8 ships the engine into a tab), and "no Node major" is the absence of the key.
 * - `hash` is `codec.hash(state)` — the engine's own digest, the same value the goldens and
 *   `stateHash()` report. It is what makes a load *checked* rather than trusted:
 *   **a payload whose hash disagrees with the state it carries is REJECTED**, because a save
 *   that loads to a different game is worse than a save that fails.
 * - `state` is the `GameState`, verbatim (PLAN.md §4.3: the state *is* plain serialisable data,
 *   so a save file is the game and not a description of it).
 *
 * ## Why the hash is injected rather than imported
 *
 * `core` may not depend on `@civts/testing`: `testing` depends on `core` (it hashes states,
 * scenarios and goldens), so the import would be a cycle, and PLAN.md §4 fixes `core` as the
 * pure engine with no dependency on the packages built on top of it. So the digest arrives as
 * `SaveCodec.hash` — `hashValue` at every real call site. It is the *same* function the goldens
 * use, passed in rather than re-implemented: a second canonical-JSON-plus-FNV-1a in this module
 * would be exactly the "two things that must agree" defect this milestone exists to close.
 *
 * `SaveCodec.invariants` is the same arrangement for the same reason: the engine's invariant
 * registry is `@civts/sim`'s `CORE_INVARIANTS`, which reads a validated `Ruleset` this package
 * never sees. The contract's rule — "a state that VIOLATES AN INVARIANT must return a typed
 * error" — is therefore implemented here over a list the caller supplies, and the shipping
 * callers pass the real registry.
 *
 * ## Two deliberate departures from M11's letter, and why
 *
 * M11 states the signatures as `serialize(state)` and `deserialize(unknown)`, and the payload as
 * the state plus its envelope. Both are implemented with one addition each, and neither is a
 * convenience:
 *
 * 1. **The codec argument.** `core` cannot import `@civts/testing` (a cycle — `testing` is built
 *    on `core`) or `@civts/sim` (built on both), so the digest and the invariant registry cannot
 *    be reached from here. The alternative to injecting them is the one this project has paid for
 *    repeatedly: a second canonical-JSON-plus-FNV-1a and a second invariant list in this module,
 *    each free to disagree with the engine's. A defaulted or optional codec was rejected for the
 *    same reason a defaulted invariant list would be rejected — a check that a caller can forget
 *    to pass is a check that silently stops running.
 * 2. **The `hash` key.** "A payload whose stateHash disagrees with the state it carries is
 *    REJECTED" cannot be implemented without the recorded hash in the payload; there would be
 *    nothing to disagree with. The key is the contract's own requirement, spelled where a reader
 *    of the file can see it.
 *
 * Every caller of `serialize`/`deserialize` in this tree passes the engine's own hasher, and the
 * payload is checked against the state on every load — see `SaveCodec` below.
 *
 * ## `deserialize` is TOTAL
 *
 * Malformed JSON, an unknown envelope version, a missing field, a wrong type, an out-of-range
 * index, a state that violates an invariant and a payload whose hash disagrees with its state
 * each come back as a `SaveError` value. It never throws, and it never returns a half-built
 * state: the state is validated *as a whole* and handed back only when every check passed, so
 * there is no code path that installs a state the checks have not finished judging.
 *
 * ## Load validates; it does not construct
 *
 * `state.ts`' `newGame` is the one place a `GameState` comes into existence, and this module
 * does not become a second one: `deserialize` **validates the parsed value and returns it**, so
 * a loaded state is byte-for-byte the state the save carried (which is the whole point — the
 * hash is computed over exactly what was stored). Rebuilding the state field by field here
 * would be a second constructor free to disagree with the first.
 *
 * The validation is a **type predicate** (`isGameState`) over the parsed value rather than an
 * `as` cast, for the reason this project states everywhere: a cast would silence the question
 * "is this actually a state", which is the question a save loader exists to answer. The
 * predicate and the error-reporting walk are one function, so the boolean and the reason can
 * never disagree about which payloads are acceptable.
 */

import { err, ok, type Result } from './result.js';
import { parseSettings } from './settings.js';
import { SCHEMA_VERSION, type GameState } from './state.js';

/**
 * The **envelope** version — the saved *format*, not the game's schema.
 *
 * - 1 — M11: `{ version, engine: { schemaVersion, nodeMajor? }, hash, state }`, the first and
 *   only format. The two spellings it replaced (the web panel's `{ schema, hash, state }` and
 *   the REPL's `{ schemaVersion, engine: 'civts', nodeMajor, state }`) wrote the same `GameState`
 *   in the same JSON, so the *bytes of the state* have not moved and no golden hash changes:
 *   only the envelope did, which is why this is a save-format version and not a `SCHEMA_VERSION`
 *   bump with a rehash behind it.
 */
export const SAVE_VERSION = 1;

/** The engine identity a save carries: which game schema, and on which Node major. */
export interface EngineIdentity {
  /** `SCHEMA_VERSION` at the time of writing. */
  readonly schemaVersion: number;
  /**
   * The Node **major** the save was written on — the same fact the golden file records.
   *
   * **Absent** where there is no Node (the browser is a save-writing host too). Absent is the
   * only encoding of "not applicable": an explicit `undefined` is not JSON and is exactly what
   * this project forbids in a payload, and a sentinel number (`0`) would be a literal standing
   * in for a fact.
   */
  readonly nodeMajor?: number;
}

/** Everything a save file holds, in the order the keys are written. */
export interface SavePayload {
  readonly version: number;
  readonly engine: EngineIdentity;
  /** The engine's digest of `state` — `codec.hash(state)` when the save was written. */
  readonly hash: string;
  readonly state: GameState;
}

/** One named property a loaded state must hold, as the caller's registry states it. */
export interface StateInvariant {
  /** Stable, kebab-case; appears in the error. */
  readonly name: string;
  /** Violation messages; empty means the property holds. */
  readonly check: (state: GameState) => readonly string[];
}

/**
 * What the engine's own hasher and invariant registry are, as this module needs them.
 *
 * `hash` takes `unknown` rather than `GameState` because the very same digest is the *ruleset's*
 * identity (`hashValue(validateRuleset(catalog))` is what `@civts/sim`'s ruleset-identity test
 * pins, and what a replay log records), and one function covering both is one function to keep
 * straight.
 *
 * `invariants` is **required**, and an empty list is spelled `[]` at the call site: a defaulted
 * or optional registry is a check that can be dropped by forgetting to pass it, and a load that
 * silently skipped the invariants would look exactly like one that ran them.
 */
export interface SaveCodec {
  /** The engine's own digest — `hashValue` from `@civts/testing`. */
  readonly hash: (value: unknown) => string;
  /** Every extra property a loaded state must hold; `[]` means "no registry here". */
  readonly invariants: readonly StateInvariant[];
}

/** One invariant's complaint, named by the invariant that made it. */
export interface StateViolation {
  readonly invariant: string;
  readonly detail: string;
}

/**
 * Every way a load can fail, as a **value**. Discriminated on `kind` so a renderer that
 * switches on it is exhaustive without a `default` (see `formatSaveError`).
 */
export type SaveError =
  /** The text handed to `deserialize` is not JSON. */
  | { readonly kind: 'malformed-json'; readonly detail: string }
  /** The parsed value is not an object — `7`, `null`, `[1,2,3]`, `"a save"`. */
  | { readonly kind: 'not-a-payload'; readonly detail: string }
  /** A key the payload must carry is not there. */
  | { readonly kind: 'missing-field'; readonly path: string }
  /** A key is there and is the wrong kind of thing. */
  | { readonly kind: 'wrong-type'; readonly path: string; readonly expected: string }
  /** A number, index or length is outside the range the engine can use. */
  | { readonly kind: 'out-of-range'; readonly path: string; readonly detail: string }
  /** `version` (or the state's own `schemaVersion`) is a number this build does not know. */
  | { readonly kind: 'unknown-version'; readonly where: 'save' | 'state'; readonly found: number }
  /** The save was written on a different game schema, or a different Node major. */
  | {
      readonly kind: 'engine-mismatch';
      readonly field: 'schemaVersion' | 'nodeMajor';
      readonly recorded: number;
      readonly running: number;
    }
  /** The digest could not be computed over the state at all (a value canonical JSON refuses). */
  | { readonly kind: 'unhashable'; readonly detail: string }
  /** The state does not hash to the hash the payload carries. */
  | { readonly kind: 'hash-mismatch'; readonly recorded: string; readonly actual: string }
  /** The state hashes to what it says, and breaks a property the caller's registry names. */
  | { readonly kind: 'invariant-violated'; readonly violations: readonly StateViolation[] }
  /** An invariant's own check threw. Reported, never propagated: `deserialize` is total. */
  | { readonly kind: 'invariant-threw'; readonly invariant: string; readonly detail: string };

/* ------------------------------------------------------------------ *
 * Numbers, and the small structural helpers the walk is built from.
 *
 * Every one of them answers `SaveError | undefined` and takes the path it is checking, so a
 * rejection names *where* in the payload the trouble is rather than only that there is trouble.
 * ------------------------------------------------------------------ */

/** `2**31 - 1` / `-2**31`: the range the engine's RNG words are stored in (`| 0`). */
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;
/** A bound for counters that the engine only ever increments. */
const COUNTER_MAX = Number.MAX_SAFE_INTEGER;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `Array.isArray` narrows to `any[]`, which would leak `any` into the walk and defeat the point
 * of validating unknown data. `Array.from<unknown>` re-types it without a cast — the same
 * device `@civts/testing`'s golden reader uses.
 */
const asArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? Array.from<unknown>(value) : undefined;

const missing = (path: string): SaveError => ({ kind: 'missing-field', path });

const wrongType = (path: string, expected: string): SaveError => ({
  kind: 'wrong-type',
  path,
  expected,
});

const outOfRange = (path: string, detail: string): SaveError => ({
  kind: 'out-of-range',
  path,
  detail,
});

const integerProblem = (
  value: unknown,
  path: string,
  min: number,
  max: number,
): SaveError | undefined => {
  if (value === undefined) return missing(path);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return wrongType(path, 'a whole number');
  }
  if (value < min || value > max) {
    return outOfRange(path, `${String(value)} is outside ${String(min)}..${String(max)}`);
  }
  return undefined;
};

const stringProblem = (value: unknown, path: string): SaveError | undefined => {
  if (value === undefined) return missing(path);
  if (typeof value !== 'string') return wrongType(path, 'a string');
  return undefined;
};

const booleanProblem = (value: unknown, path: string): SaveError | undefined => {
  if (value === undefined) return missing(path);
  if (typeof value !== 'boolean') return wrongType(path, 'a boolean');
  return undefined;
};

const recordProblem = (
  value: unknown,
  path: string,
): SaveError | { readonly record: Record<string, unknown> } => {
  if (value === undefined) return missing(path);
  if (!isRecord(value)) return wrongType(path, 'an object');
  return { record: value };
};

/** Discriminates the error half of a walk step's result from the value half. */
/**
 * A field that must be a list, or a path-qualified reason why not. An **absent** key is
 * `missing-field` and a present-but-wrong one is `wrong-type`, because those are two different
 * defects in a save file and a loader that reported both as one would send a reader looking for
 * the wrong thing.
 */
const listAt = (
  source: Record<string, unknown>,
  key: string,
  path: string,
): SaveError | { readonly list: readonly unknown[] } => {
  if (source[key] === undefined) return missing(path);
  const list = asArray(source[key]);
  if (list === undefined) return wrongType(path, 'a list');
  return { list };
};

const isSaveError = (value: SaveError | object): value is SaveError => 'kind' in value;

/** A field that must be a whole number in `[0, bound)`, or a path-qualified reason why not. */
const indexProblem = (value: unknown, path: string, bound: number): SaveError | undefined => {
  if (bound <= 0) return outOfRange(path, 'the map is empty, so no index can be in bounds');
  return integerProblem(value, path, 0, bound - 1);
};

/* ------------------------------------------------------------------ *
 * The state's shape, one entity at a time.
 * ------------------------------------------------------------------ */

/** One entry of a sparse `(tile, id)` list — an improvement, or a resource on the map. */
const tileEntryProblem = (
  value: unknown,
  path: string,
  tileBound: number,
  idKey: string,
): SaveError | undefined => {
  const item = recordProblem(value, path);
  if (isSaveError(item)) return item;
  const tile = indexProblem(item.record['tile'], `${path}.tile`, tileBound);
  if (tile !== undefined) return tile;
  return stringProblem(item.record[idKey], `${path}.${idKey}`);
};

const unitProblem = (
  value: unknown,
  path: string,
  tileBound: number,
  playerCount: number,
): SaveError | undefined => {
  const item = recordProblem(value, path);
  if (isSaveError(item)) return item;
  const unit = item.record;

  const problems: readonly (SaveError | undefined)[] = [
    integerProblem(unit['id'], `${path}.id`, 0, COUNTER_MAX),
    stringProblem(unit['type'], `${path}.type`),
    indexProblem(unit['owner'], `${path}.owner`, playerCount),
    indexProblem(unit['tile'], `${path}.tile`, tileBound),
    integerProblem(unit['movementLeft'], `${path}.movementLeft`, 0, COUNTER_MAX),
  ];
  for (const problem of problems) if (problem !== undefined) return problem;

  // The three optional M6 keys. Absent is legal and means "at full health / no promotions /
  // not fortified"; present-and-wrong is not.
  const hitPoints = unit['hitPointsLeft'];
  if (hitPoints !== undefined) {
    // A live unit at 0 hit points is the state M6 says must not exist, and `@civts/sim`
    // names it as an invariant — so the bound here is `>= 1`, not `>= 0`.
    const problem = integerProblem(hitPoints, `${path}.hitPointsLeft`, 1, COUNTER_MAX);
    if (problem !== undefined) return problem;
  }
  const experience = unit['experience'];
  if (experience !== undefined) {
    const problem = integerProblem(experience, `${path}.experience`, 0, COUNTER_MAX);
    if (problem !== undefined) return problem;
  }
  const fortified = unit['fortified'];
  if (fortified !== undefined) {
    const problem = booleanProblem(fortified, `${path}.fortified`);
    if (problem !== undefined) return problem;
  }

  const work = unit['work'];
  if (work !== undefined) {
    const job = recordProblem(work, `${path}.work`);
    if (isSaveError(job)) return job;
    const kind = stringProblem(job.record['kind'], `${path}.work.kind`);
    if (kind !== undefined) return kind;
    const tile = indexProblem(job.record['tile'], `${path}.work.tile`, tileBound);
    if (tile !== undefined) return tile;
    return integerProblem(job.record['turnsLeft'], `${path}.work.turnsLeft`, 0, COUNTER_MAX);
  }
  return undefined;
};

const productionItemProblem = (value: unknown, path: string): SaveError | undefined => {
  const item = recordProblem(value, path);
  if (isSaveError(item)) return item;
  const kind = item.record['kind'];
  if (kind !== 'unit' && kind !== 'building') {
    return wrongType(`${path}.kind`, '"unit" or "building"');
  }
  return stringProblem(item.record['id'], `${path}.id`);
};

const cityProblem = (
  value: unknown,
  path: string,
  tileBound: number,
  playerCount: number,
): SaveError | undefined => {
  const item = recordProblem(value, path);
  if (isSaveError(item)) return item;
  const city = item.record;

  const problems: readonly (SaveError | undefined)[] = [
    integerProblem(city['id'], `${path}.id`, 0, COUNTER_MAX),
    indexProblem(city['owner'], `${path}.owner`, playerCount),
    stringProblem(city['name'], `${path}.name`),
    indexProblem(city['tile'], `${path}.tile`, tileBound),
    // A city always has at least one citizen (`city-population-at-least-one`), and M9's culture
    // never decreases, so both bounds are the engine's own, stated where the load can enforce
    // them rather than only where the game does.
    integerProblem(city['population'], `${path}.population`, 1, COUNTER_MAX),
    integerProblem(city['foodBox'], `${path}.foodBox`, 0, COUNTER_MAX),
    integerProblem(city['shields'], `${path}.shields`, 0, COUNTER_MAX),
    integerProblem(city['culture'], `${path}.culture`, 0, COUNTER_MAX),
  ];
  for (const problem of problems) if (problem !== undefined) return problem;

  const production = city['production'];
  if (production !== undefined) {
    const problem = productionItemProblem(production, `${path}.production`);
    if (problem !== undefined) return problem;
  }

  const queueField = listAt(city, 'queue', `${path}.queue`);
  if (isSaveError(queueField)) return queueField;
  const buildingsField = listAt(city, 'buildings', `${path}.buildings`);
  if (isSaveError(buildingsField)) return buildingsField;
  const workedField = listAt(city, 'workedTiles', `${path}.workedTiles`);
  if (isSaveError(workedField)) return workedField;

  const queue = queueField.list;
  for (const [position, entry] of queue.entries()) {
    const problem = productionItemProblem(entry, `${path}.queue[${String(position)}]`);
    if (problem !== undefined) return problem;
  }

  const buildings = buildingsField.list;
  for (const [position, entry] of buildings.entries()) {
    const problem = stringProblem(entry, `${path}.buildings[${String(position)}]`);
    if (problem !== undefined) return problem;
  }

  const worked = workedField.list;
  for (const [position, entry] of worked.entries()) {
    const problem = indexProblem(entry, `${path}.workedTiles[${String(position)}]`, tileBound);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

const playerProblem = (value: unknown, path: string, tileBound: number): SaveError | undefined => {
  const item = recordProblem(value, path);
  if (isSaveError(item)) return item;
  const player = item.record;

  const problems: readonly (SaveError | undefined)[] = [
    integerProblem(player['id'], `${path}.id`, 0, COUNTER_MAX),
    stringProblem(player['name'], `${path}.name`),
    stringProblem(player['color'], `${path}.color`),
    indexProblem(player['startingTile'], `${path}.startingTile`, tileBound),
  ];
  for (const problem of problems) if (problem !== undefined) return problem;

  const kind = player['kind'];
  if (kind !== 'civ' && kind !== 'barbarian') {
    return wrongType(`${path}.kind`, '"civ" or "barbarian"');
  }

  const numbers: readonly (SaveError | undefined)[] = [
    // A treasury is never negative (a shortfall floors it at 0 and disbands units), and the two
    // pools only accumulate. `@civts/sim` states all three as invariants; the load can state
    // them for the three fields the engine's own arithmetic guarantees.
    integerProblem(player['treasury'], `${path}.treasury`, 0, COUNTER_MAX),
    integerProblem(player['beakers'], `${path}.beakers`, 0, COUNTER_MAX),
    integerProblem(player['luxuries'], `${path}.luxuries`, 0, COUNTER_MAX),
  ];
  for (const problem of numbers) if (problem !== undefined) return problem;

  const rates = recordProblem(player['rates'], `${path}.rates`);
  if (isSaveError(rates)) return rates;
  for (const key of ['tax', 'science', 'luxury'] as const) {
    const problem = integerProblem(rates.record[key], `${path}.rates.${key}`, 0, COUNTER_MAX);
    if (problem !== undefined) return problem;
  }

  const researching = player['researching'];
  if (researching !== undefined) {
    const problem = stringProblem(researching, `${path}.researching`);
    if (problem !== undefined) return problem;
  }

  const techsField = listAt(player, 'techs', `${path}.techs`);
  if (isSaveError(techsField)) return techsField;
  const techs = techsField.list;
  for (const [position, entry] of techs.entries()) {
    const problem = stringProblem(entry, `${path}.techs[${String(position)}]`);
    if (problem !== undefined) return problem;
  }

  return stringProblem(player['government'], `${path}.government`);
};

const mapProblem = (
  value: unknown,
): SaveError | { readonly width: number; readonly height: number } => {
  const item = recordProblem(value, 'state.map');
  if (isSaveError(item)) return item;
  const map = item.record;

  const width = integerProblem(map['width'], 'state.map.width', 1, COUNTER_MAX);
  if (width !== undefined) return width;
  const height = integerProblem(map['height'], 'state.map.height', 1, COUNTER_MAX);
  if (height !== undefined) return height;

  const w = map['width'];
  const h = map['height'];
  if (typeof w !== 'number' || typeof h !== 'number') {
    return wrongType('state.map.width', 'a whole number');
  }
  const tileBound = w * h;

  const terrainField = listAt(map, 'terrain', 'state.map.terrain');
  if (isSaveError(terrainField)) return terrainField;
  const terrain = terrainField.list;
  if (terrain.length !== tileBound) {
    return outOfRange(
      'state.map.terrain',
      `${String(terrain.length)} entries for a ${String(w)}x${String(h)} map (${String(tileBound)} expected)`,
    );
  }
  for (const [position, entry] of terrain.entries()) {
    const problem = stringProblem(entry, `state.map.terrain[${String(position)}]`);
    if (problem !== undefined) return problem;
  }

  const hutsField = listAt(map, 'huts', 'state.map.huts');
  if (isSaveError(hutsField)) return hutsField;
  const huts = hutsField.list;
  for (const [position, entry] of huts.entries()) {
    const problem = indexProblem(entry, `state.map.huts[${String(position)}]`, tileBound);
    if (problem !== undefined) return problem;
  }

  const resourcesField = listAt(map, 'resources', 'state.map.resources');
  if (isSaveError(resourcesField)) return resourcesField;
  const resources = resourcesField.list;
  for (const [position, entry] of resources.entries()) {
    const problem = tileEntryProblem(
      entry,
      `state.map.resources[${String(position)}]`,
      tileBound,
      'resource',
    );
    if (problem !== undefined) return problem;
  }

  return { width: w, height: h };
};

/**
 * One walk, two consumers: `stateProblem` returns the first reason a value is not a
 * `GameState`, and `isGameState` is that function's boolean face. They cannot disagree, because
 * there is one walk.
 */
const stateProblem = (value: unknown): SaveError | undefined => {
  if (!isRecord(value)) return wrongType('state', 'an object');
  const state = value;

  const scalars: readonly (SaveError | undefined)[] = [
    integerProblem(state['schemaVersion'], 'state.schemaVersion', 0, COUNTER_MAX),
    integerProblem(state['revision'], 'state.revision', 0, COUNTER_MAX),
    integerProblem(state['turn'], 'state.turn', 1, COUNTER_MAX),
    // A seed is any integer a caller may choose (`loadSettings` bounds it only to integers),
    // so the bound here is the one JSON numbers can carry exactly, not the RNG's own word range.
    integerProblem(state['seed'], 'state.seed', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    integerProblem(state['nextUnitId'], 'state.nextUnitId', 0, COUNTER_MAX),
    integerProblem(state['nextCityId'], 'state.nextCityId', 0, COUNTER_MAX),
  ];
  for (const problem of scalars) if (problem !== undefined) return problem;

  const settings = recordProblem(state['settings'], 'state.settings');
  if (isSaveError(settings)) return settings;
  const parsed = parseSettings(settings.record);
  if (!parsed.ok) {
    const issue = parsed.error[0];
    // The settings ARE validated by `settings.ts`' one schema — this module asks it rather than
    // restating a single bound, so a new setting is a change in one place. Only the *envelope's*
    // rejection is this module's to word.
    return issue === undefined
      ? wrongType('state.settings', 'valid settings')
      : wrongType(`state.settings.${issue.path}`, issue.message);
  }

  const rng = recordProblem(state['rng'], 'state.rng');
  if (isSaveError(rng)) return rng;
  for (const key of ['a', 'b', 'c', 'd'] as const) {
    // The four sfc32 words are stored as signed 32-bit values (`| 0`), so both ends are real.
    const problem = integerProblem(rng.record[key], `state.rng.${key}`, INT32_MIN, INT32_MAX);
    if (problem !== undefined) return problem;
  }

  const map = mapProblem(state['map']);
  if (isSaveError(map)) return map;
  const tileBound = map.width * map.height;

  const playersField = listAt(state, 'players', 'state.players');
  if (isSaveError(playersField)) return playersField;
  const players = playersField.list;
  if (players.length === 0) {
    return outOfRange('state.players', 'a game with no players has no player to act as');
  }
  for (const [position, entry] of players.entries()) {
    const problem = playerProblem(entry, `state.players[${String(position)}]`, tileBound);
    if (problem !== undefined) return problem;
  }

  const unitsField = listAt(state, 'units', 'state.units');
  if (isSaveError(unitsField)) return unitsField;
  const units = unitsField.list;
  for (const [position, entry] of units.entries()) {
    const problem = unitProblem(
      entry,
      `state.units[${String(position)}]`,
      tileBound,
      players.length,
    );
    if (problem !== undefined) return problem;
  }

  const citiesField = listAt(state, 'cities', 'state.cities');
  if (isSaveError(citiesField)) return citiesField;
  const cities = citiesField.list;
  for (const [position, entry] of cities.entries()) {
    const problem = cityProblem(
      entry,
      `state.cities[${String(position)}]`,
      tileBound,
      players.length,
    );
    if (problem !== undefined) return problem;
  }

  const exploredField = listAt(state, 'explored', 'state.explored');
  if (isSaveError(exploredField)) return exploredField;
  const explored = exploredField.list;
  if (explored.length !== players.length) {
    return outOfRange(
      'state.explored',
      `${String(explored.length)} rows for ${String(players.length)} players`,
    );
  }
  for (const [row, entries] of explored.entries()) {
    const path = `state.explored[${String(row)}]`;
    if (entries === undefined) return missing(path);
    const seen = asArray(entries);
    if (seen === undefined) return wrongType(path, 'a list of booleans');
    if (seen.length !== tileBound) {
      return outOfRange(
        path,
        `${String(seen.length)} entries for a ${String(map.width)}x${String(map.height)} map`,
      );
    }
    for (const [position, entry] of seen.entries()) {
      const problem = booleanProblem(entry, `${path}[${String(position)}]`);
      if (problem !== undefined) return problem;
    }
  }

  const tileOwnerField = listAt(state, 'tileOwner', 'state.tileOwner');
  if (isSaveError(tileOwnerField)) return tileOwnerField;
  const tileOwner = tileOwnerField.list;
  // The **one case that is not a violation**, quoted from the engine's own statement of this rule
  // (`@civts/sim`'s `tile-owner-matches-culture`, which is the check that owns it): "A state with
  // no cities and an unmaterialised layer (`tileOwner.length === 0`) claims nothing and stores
  // nothing, and the two agree trivially … Hand-built fixtures in other packages are exactly this
  // state (a board made by placing units, before any city exists), and calling them broken would
  // be this check inventing a rule the engine does not have."
  //
  // This is the one place the serializer restates an engine invariant — it has to, because a save
  // must be readable in the browser, where the registry cannot run — so it restates the engine's
  // rule rather than a stricter one of its own. That is not hypothetical: the first version of
  // this check refused the REPL's own fixtures, and the fix was to agree with the engine, not to
  // move the fixture. A layer of any *other* wrong length is still refused: the contract fixes it
  // at one entry per tile.
  const unmaterialised = tileOwner.length === 0 && cities.length === 0;
  if (!unmaterialised && tileOwner.length !== tileBound) {
    return outOfRange(
      'state.tileOwner',
      `${String(tileOwner.length)} entries for a ${String(map.width)}x${String(map.height)} map`,
    );
  }
  for (const [position, entry] of tileOwner.entries()) {
    // `-1` (`borders.ts`' `UNOWNED`) is the one value outside the player indices that means
    // something, and it is the layer's own spelling of "nobody" — an owner of `-2` is not.
    const problem = integerProblem(
      entry,
      `state.tileOwner[${String(position)}]`,
      -1,
      players.length - 1,
    );
    if (problem !== undefined) return problem;
  }

  const improvementsField = listAt(state, 'improvements', 'state.improvements');
  if (isSaveError(improvementsField)) return improvementsField;
  const improvements = improvementsField.list;
  for (const [position, entry] of improvements.entries()) {
    const problem = tileEntryProblem(
      entry,
      `state.improvements[${String(position)}]`,
      tileBound,
      'kind',
    );
    if (problem !== undefined) return problem;
  }

  return undefined;
};

/**
 * Does this value describe a game this build can run?
 *
 * A type predicate rather than a cast, and derived from the one walk above rather than written
 * as a second, weaker check — the failure mode a hand-written predicate invites is that the
 * boolean and the reported reason disagree, which is how a state gets installed with a reason
 * saying it should not have been.
 */
export const isGameState = (value: unknown): value is GameState =>
  stateProblem(value) === undefined;

/* ------------------------------------------------------------------ *
 * The engine identity, read from the runtime.
 * ------------------------------------------------------------------ */

/**
 * The running Node major, or `undefined` where there is no Node.
 *
 * The browser is a host for this engine (M8), and `process` is not defined in a tab — a bare
 * `process.versions` would be a `ReferenceError` inside a Save click, so the read goes through
 * `globalThis`, where an absent global is simply `undefined`. A payload written in a browser
 * therefore carries no `nodeMajor`, and a loader running in a browser skips the comparison;
 * a payload written on Node and loaded on Node compares exactly as the goldens do.
 *
 * The value is read structurally (`typeof` checks down to a string) rather than through
 * `process`'s type, because the whole point is that the object may not be there at all.
 */
const runtimeNodeMajor = (): number | undefined => {
  const global: { readonly process?: unknown } = globalThis;
  const proc = global.process;
  if (!isRecord(proc)) return undefined;
  const versions = proc['versions'];
  if (!isRecord(versions)) return undefined;
  const node = versions['node'];
  if (typeof node !== 'string') return undefined;
  const major = Number.parseInt(node, 10);
  return Number.isInteger(major) && major > 0 ? major : undefined;
};

/** The `engine` block for a payload written now — `nodeMajor` only where there is a Node. */
const engineIdentityNow = (): EngineIdentity => {
  const nodeMajor = runtimeNodeMajor();
  // The key is written only when there is a Node to name: absence is how "no Node major"
  // is spelled, and an explicit `undefined` is neither JSON nor this project's spelling.
  return nodeMajor === undefined
    ? { schemaVersion: SCHEMA_VERSION }
    : { schemaVersion: SCHEMA_VERSION, nodeMajor };
};

/* ------------------------------------------------------------------ *
 * The two functions.
 * ------------------------------------------------------------------ */

/**
 * The save **payload** for a state: the engine's one format, in one place, as a value.
 *
 * Every `SavePayload` key is written with a real value: the state carries optional keys as
 * *absence* (M3's rule, four times paid for) and `engineIdentityNow` writes `nodeMajor` only
 * when there is a Node to name — so a key holding an explicit `undefined` never reaches a
 * payload, which is the one thing `canonicalize` refuses and JSON would silently drop.
 */
export const payloadOf = (state: GameState, codec: SaveCodec): SavePayload => ({
  version: SAVE_VERSION,
  engine: engineIdentityNow(),
  hash: codec.hash(state),
  state,
});

/**
 * The save **text**: `payloadOf` written out.
 *
 * Compact JSON on a single line, with no trailing newline written here — the callers that write
 * a *file* add their own, and the browser's `localStorage` has no use for one. `serialize` holds
 * no field of its own, so the value a caller reads and the text a file carries cannot disagree.
 */
export const serialize = (state: GameState, codec: SaveCodec): string =>
  JSON.stringify(payloadOf(state, codec));

const describeFound = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
};

const payloadShapeProblem = (
  raw: Record<string, unknown>,
): SaveError | { readonly hash: string; readonly state: unknown } => {
  const version = raw['version'];
  if (version === undefined) return missing('version');
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return wrongType('version', 'a whole number');
  }
  if (version !== SAVE_VERSION) return { kind: 'unknown-version', where: 'save', found: version };

  const engine = recordProblem(raw['engine'], 'engine');
  if (isSaveError(engine)) return engine;
  const schemaVersion = engine.record['schemaVersion'];
  if (schemaVersion === undefined) return missing('engine.schemaVersion');
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return wrongType('engine.schemaVersion', 'a whole number');
  }
  if (schemaVersion !== SCHEMA_VERSION) {
    return {
      kind: 'engine-mismatch',
      field: 'schemaVersion',
      recorded: schemaVersion,
      running: SCHEMA_VERSION,
    };
  }

  const nodeMajor = engine.record['nodeMajor'];
  if (nodeMajor !== undefined) {
    if (typeof nodeMajor !== 'number' || !Number.isInteger(nodeMajor)) {
      return wrongType('engine.nodeMajor', 'a whole number');
    }
    const running = runtimeNodeMajor();
    // The goldens' rule, applied here: a hash is only guaranteed across the same Node major,
    // so a save written by another one is refused rather than trusted. Where the *running*
    // side has no major (a browser), there is nothing to compare and the check is skipped —
    // stated rather than implied, because "skipped" and "passed" render identically otherwise.
    if (running !== undefined && running !== nodeMajor) {
      return { kind: 'engine-mismatch', field: 'nodeMajor', recorded: nodeMajor, running };
    }
  }

  const hash = raw['hash'];
  if (hash === undefined) return missing('hash');
  if (typeof hash !== 'string') return wrongType('hash', 'a string');

  const state = raw['state'];
  if (state === undefined) return missing('state');

  return { hash, state };
};

/**
 * Read a save back, checking everything that can be checked.
 *
 * `raw` is either the save **text** (a string, which is parsed here — malformed JSON is one of
 * the failure classes the contract names, and parsing at the boundary is what makes it a
 * *value* rather than an exception) or an already-parsed value (a caller that read the file
 * itself, or a test holding a payload object).
 *
 * The order is deliberate: the envelope, then the state's shape, then the version, then the
 * hash, then the invariants. The hash comes before the invariants because a state that does not
 * hash to what the payload carries is *not the saved state at all*, and judging it against the
 * game's rules would be judging something else; the invariants then catch the one case the hash
 * cannot — a state the engine itself produced that breaks a property, which is a real bug and
 * not a tampered file.
 */
export const deserialize = (raw: unknown, codec: SaveCodec): Result<GameState, SaveError> => {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      return err({
        kind: 'malformed-json',
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (!isRecord(parsed)) {
    return err({
      kind: 'not-a-payload',
      detail: `expected an object, got ${describeFound(parsed)}`,
    });
  }

  const shape = payloadShapeProblem(parsed);
  if (isSaveError(shape)) return err(shape);

  const problem = stateProblem(shape.state);
  if (problem !== undefined) return err(problem);

  // `stateProblem` above is the only thing that decides this, and `isGameState` is its boolean
  // face — so the narrowing here is the walk's verdict, not a second opinion about it.
  if (!isGameState(shape.state)) {
    return err(wrongType('state', 'a game state'));
  }
  const state: GameState = shape.state;

  if (state.schemaVersion !== SCHEMA_VERSION) {
    return err({ kind: 'unknown-version', where: 'state', found: state.schemaVersion });
  }

  let actual: string;
  try {
    actual = codec.hash(state);
  } catch (cause) {
    return err({
      kind: 'unhashable',
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (actual !== shape.hash) {
    return err({ kind: 'hash-mismatch', recorded: shape.hash, actual });
  }

  const violations: StateViolation[] = [];
  for (const invariant of codec.invariants) {
    let details: readonly string[];
    try {
      details = invariant.check(state);
    } catch (cause) {
      // The contract's word is "total": a check that throws is a finding about the caller's
      // registry, and it must not become a thrown exception inside a load.
      return err({
        kind: 'invariant-threw',
        invariant: invariant.name,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    for (const detail of details) violations.push({ invariant: invariant.name, detail });
  }
  if (violations.length > 0) return err({ kind: 'invariant-violated', violations });

  return ok(state);
};

/* ------------------------------------------------------------------ *
 * Rendering.
 * ------------------------------------------------------------------ */

/**
 * Compile-time exhaustiveness, made visible — and it lives here because `core` had no such
 * device before M11 and both of this milestone's modules need one. It is the *same* device
 * `repl.ts` uses for events (see its note): a switch over a union that lacks a case does not
 * fail loudly, it returns `undefined` and prints nothing, which is exactly how six M3 events
 * were silently dropped.
 */
export const assertNever = (value: never): never => {
  throw new Error(`unhandled union member: ${JSON.stringify(value)}`);
};

/**
 * One save error, as one line — the **only** wording of these failures, so the CLI, the REPL
 * and the web panel cannot describe the same refusal three ways.
 *
 * The switch has no `default` clause: a new `SaveError` member is a compile error here, not a
 * blank line in a transcript. That failure shape is not hypothetical in this project — it has
 * shipped once, in `repl.ts`' event rendering.
 */
export const formatSaveError = (error: SaveError): string => {
  switch (error.kind) {
    case 'malformed-json':
      return `the save is not JSON: ${error.detail}`;
    case 'not-a-payload':
      return `the save is not a save payload: ${error.detail}`;
    case 'missing-field':
      return `the save has no ${error.path}`;
    case 'wrong-type':
      return `${error.path} is not ${error.expected}`;
    case 'out-of-range':
      return `${error.path} is out of range: ${error.detail}`;
    case 'unknown-version':
      return error.where === 'save'
        ? `save format version ${String(error.found)} is not the one this build writes (${String(SAVE_VERSION)})`
        : `the state is schema version ${String(error.found)}, not ${String(SCHEMA_VERSION)}`;
    case 'engine-mismatch':
      return `the save was written with ${error.field} ${String(error.recorded)} and this build is ${String(error.running)}`;
    case 'unhashable':
      return `the state cannot be hashed, so it cannot be checked: ${error.detail}`;
    case 'hash-mismatch':
      return `the stored hash is ${error.recorded} but the state hashes to ${error.actual}`;
    case 'invariant-violated':
      return `the state breaks ${String(error.violations.length)} invariant(s): ${error.violations
        .map((violation) => `[${violation.invariant}] ${violation.detail}`)
        .join('; ')}`;
    case 'invariant-threw':
      return `the invariant "${error.invariant}" threw while checking: ${error.detail}`;
  }
  // Reached only when every member above was handled, which is what makes this a compile error
  // rather than a blank line for a new one: `error` is `never` here, so a `SaveError` member
  // without a case above cannot be passed to `assertNever`.
  return assertNever(error);
};
