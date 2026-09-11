/**
 * `play` — the text REPL, the agent's hands on the game.
 * See docs/INTERFACES.md, M2 ("Headless — the REPL"), PLAN.md §8.1 and §5.3.
 *
 * Design notes:
 *
 * - **The REPL owns no rules.** Every state change goes through
 *   `applyCommand`; every legality question is answered by `unitMoveOptions`
 *   (the same evaluator `applyCommand` refuses with). The REPL parses text, calls
 *   the engine, and renders what came back — it never edits a `GameState`
 *   field. That is what makes a scripted session a regression test of the
 *   *engine* rather than of a second implementation of the rules.
 * - **Legibility for a reader with no other channel.** The banner names the
 *   acting player; every view is `describe(state, ruleset, { viewer })`, so the
 *   picture is exactly that player's fog; `units` shows each unit's remaining
 *   movement; and a refused command prints the typed `GameError` plus the moves
 *   that *were* legal, so a failure teaches the next command.
 * - **Outcome is returned, not just printed.** `run` returns a `LineOutcome`
 *   carrying the `Command` it built and, on refusal, the engine's typed error —
 *   so tests assert on reasons instead of scraping text, while a human reads the
 *   same information as prose.
 * - **The city surface (M3) is the same arrangement as the movement one.**
 *   `found`, `city`, `cities`, `work` and `build` are thin: each parses text,
 *   builds exactly one `Command`, and hands it to `applyCommand`. Every refusal is
 *   the engine's own typed `GameError`, and every "legal:" line under it comes
 *   from an engine *evaluator* — `planFoundCity`, `planSetWorkedTiles`,
 *   `planSetProduction`, `itemCostOf`, `cityRadius`, `foodBoxSize` — the same
 *   functions the applier decides with. So the REPL cannot advertise a city site,
 *   an assignment or a build order the engine would refuse, and there is no second
 *   copy of the city rules here to drift out of step with it.
 * - **Event rendering is exhaustive, not defaulted.** `outcomeText` switches over
 *   *every* `GameEvent` member with no `default` clause and an `assertNever` tail,
 *   so the next event member is a compile error. A `switch` that simply falls
 *   through returns `undefined` for the unhandled member, and `undefined` inside a
 *   joined line is not a loud failure — it is a silently *blank* line in a
 *   transcript, which is exactly how the M3 city and goody-hut events would have
 *   arrived: `CityFounded`, `CityGrew`, `CityStarved`, `CityProduced`,
 *   `HutEntered` and `BarbariansSpawned` all hit no case and printed nothing.
 * - **The worker surface (M4a) is the same arrangement a third time.** `work
 *   <unitId> <improvementId>` and `cancel <unitId>` parse text, build exactly one
 *   `Command` (`StartWork` / `CancelWork`) and hand it to `applyCommand`; every
 *   "legal:" line under a refusal comes from `planStartWork` (and the improvement
 *   catalog), the same evaluator the applier decides with. What a unit is doing is
 *   then *shown* wherever a unit is shown — the `units` line, the `units` table and the `state`
 *   view — through `workSummary` (`@civts/core`), so the REPL does not own a
 *   second mapping from a job to prose.
 * - **`work` has two readings, and the arguments pick one.** M3's `work <cityId>
 *   <x> <y> ...` sets a city's worked tiles; M4a's `work <unitId>
 *   <improvementId>` puts a worker on a job. They are told apart by the second
 *   argument — a coordinate is an integer, an improvement id is a word — and
 *   nothing else in the session is ambiguous. Both readings are documented in
 *   `help`, and a `work` line whose arguments fit neither says so.
 * - **The transcript is a pure function of (state, lines, flags).** Numbers are
 *   the only variable content and they come from the state; nothing reads the
 *   clock, and the prompt/echo are written for every line whether the input
 *   arrives from a file, a pipe or a terminal. `--script` therefore produces a
 *   deterministic transcript, and a play session becomes a test fixture.
 * - **Non-interactive-safe.** End of input always ends the loop with exit code
 *   0: `play --script missing-commands` cannot hang, and `play < /dev/null`
 *   exits cleanly rather than waiting for a human.
 *
 * This module is deliberately free of top-level side effects (nothing runs on
 * import), so tests can drive a session directly and `cli.ts` stays the only
 * place that touches `process`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import {
  MAP_SIZES,
  MIN_CITY_DISTANCE,
  applyCommand,
  asBuildingId,
  asCityId,
  asImprovementId,
  asUnitId,
  asUnitTypeId,
  buildingCatalog,
  buildingDef,
  citiesOf,
  cityById,
  cityRadius,
  cityYields,
  civPlayers,
  describe,
  err,
  foodBoxSize,
  improvementCatalog,
  improvementDef,
  inBounds,
  indexToX,
  indexToY,
  isExplored,
  itemCostOf,
  ok,
  planFoundCity,
  planSetProduction,
  planSetWorkedTiles,
  planStartWork,
  terrainAtIndex,
  tileIndex,
  unitById,
  unitCatalog,
  unitDef,
  unitMoveOptions,
  unitsOnTile,
  visibleTiles,
  workSummary,
  type Command,
  type CommandOutcome,
  type BuildingId,
  type City,
  type CityId,
  type CityYields,
  type GameError,
  type GameMap,
  type GameState,
  type ImprovementDef,
  type ImprovementId,
  type MapSize,
  type PlayerId,
  type ProductionItem,
  type Result,
  type RulesetView,
  type SetupError,
  type TerrainDef,
  type TileIndex,
  type Unit,
  type UnitId,
  type UnitTypeId,
} from '@civts/core';
import { canonicalize, hashValue } from '@civts/testing';

/* ------------------------------------------------------------------ *
 * Flags — parsed strictly, never guessed (a typo must not play a
 * different game than the one that was asked for).
 * ------------------------------------------------------------------ */

const INTEGER = /^[+-]?\d+$/;

/**
 * Strict integer parsing, shared with the `map` command: `"abc"`, `"NaN"`,
 * `""`, `"1.5"`, `"0x10"` and `"1e3"` are all errors.
 */
export const parseIntFlag = (flag: string, raw: string): Result<number, string> => {
  const text = raw.trim();
  if (!INTEGER.test(text)) return err(`${flag} expects an integer, got "${raw}"`);

  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return err(`${flag} is out of range: "${raw}"`);
  return ok(value);
};

/** Command arguments are parsed with the same rule, but a failure is prose. */
const intOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !INTEGER.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : undefined;
};

export interface PlayFlags {
  readonly seed: number | undefined;
  readonly mapSize: MapSize | undefined;
  readonly civCount: number | undefined;
  readonly playerIndex: number | undefined;
  readonly scriptPath: string | undefined;
  /** Render the whole map instead of the acting player's fog (debugging). */
  readonly god: boolean;
}

export const PLAY_USAGE = `usage: civts play [--seed <int>] [--map-size <size>] [--civs <int>]
                   [--player <int>] [--script <file>] [--god]

  --seed <int>        world seed (any integer; default 1)
  --map-size <size>   one of ${MAP_SIZES.join('|')} (default tiny)
  --civs <int>        number of civilizations, 2..16 (default 2)
  --player <int>      which civilization you play, 0-based (default 0)
  --script <file>     run a command file, print the transcript, exit 0
  --god               render the whole map, ignoring fog (debugging only)

Commands inside a session (also documented by "help"):
  move <unitId> <x> <y>      found <unitId>      cities      city <cityId>
  work <cityId> <x> <y> ...  build <cityId> <unit|building>:<id>
  work <unitId> <improve>    cancel <unitId>
  end   units   state   save <path>   help   quit
`;

export const parsePlayArgs = (args: readonly string[]): Result<PlayFlags, string> => {
  let seed: number | undefined;
  let mapSize: MapSize | undefined;
  let civCount: number | undefined;
  let playerIndex: number | undefined;
  let scriptPath: string | undefined;
  let god = false;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined) break;

    // A boolean flag consumes no value, so it is handled before the
    // "every other flag needs one" rule below.
    if (flag === '--god') {
      god = true;
      continue;
    }

    if (
      flag !== '--seed' &&
      flag !== '--map-size' &&
      flag !== '--civs' &&
      flag !== '--player' &&
      flag !== '--script'
    ) {
      return err(`unknown option for play: "${flag}"`);
    }

    const raw = args[i + 1];
    if (raw === undefined) return err(`${flag} needs a value`);
    i += 1; // consume the value

    if (flag === '--script') {
      scriptPath = raw;
      continue;
    }

    if (flag === '--map-size') {
      const size = MAP_SIZES.find((candidate) => candidate === raw);
      if (size === undefined) {
        return err(`--map-size expects one of ${MAP_SIZES.join('|')}, got "${raw}"`);
      }
      mapSize = size;
      continue;
    }

    const value = parseIntFlag(flag, raw);
    if (!value.ok) return err(value.error);
    if (flag === '--seed') seed = value.value;
    else if (flag === '--civs') civCount = value.value;
    else playerIndex = value.value;
  }

  return ok({ seed, mapSize, civCount, playerIndex, scriptPath, god });
};

/* ------------------------------------------------------------------ *
 * Error prose — what went wrong, and what would have worked.
 * ------------------------------------------------------------------ */

/** Everything the formatters need to turn a typed error into a lesson. */
export interface ErrorContext {
  readonly state: GameState;
  readonly ruleset: RulesetView;
  readonly playerId: PlayerId;
  /** The unit the refused command named, when it named one (`undefined` otherwise). */
  readonly unitId: UnitId | undefined;
  /**
   * The city the refused command named, when it named one (`undefined`
   * otherwise). Not part of any game state, so a present-and-`undefined` field is
   * harmless here — `City.production`'s canonical-JSON trap applies to state,
   * not to this prose-only context.
   */
  readonly cityId: CityId | undefined;
}

const coordOf = (map: GameMap, tile: TileIndex): string =>
  `${String(indexToX(map, tile))},${String(indexToY(map, tile))}`;

const playerName = (state: GameState, id: PlayerId): string =>
  state.players.find((player) => player.id === id)?.name ?? `player ${String(id)}`;

const playerLabel = (state: GameState, id: PlayerId): string =>
  `${playerName(state, id)} (p${String(id)})`;

const terrainDefAt = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): TerrainDef | undefined => {
  const id = terrainAtIndex(state.map, tile);
  return id === undefined ? undefined : ruleset.terrains.find((terrain) => terrain.id === id);
};

/** The unit type's name, or the raw type id when the ruleset cannot name it. */
const typeName = (ruleset: RulesetView, type: UnitTypeId): string => {
  const def = unitDef(ruleset, type);
  return def === undefined ? type : def.name;
};

/**
 * What a unit is doing, as prose (`mining, 2 turns left`), or `undefined` when it
 * is idle — never an empty string, so a caller's `job === undefined` test is the
 * one place "no job" is decided.
 *
 * The wording is `@civts/core`'s `workSummary`, the same function `textview` prints
 * its `work:` line with: the REPL does not own a second mapping from an
 * improvement to a verb, so the two surfaces cannot describe one job differently.
 */
const workOf = (ruleset: RulesetView, unit: Unit): string | undefined => {
  const work = unit.work;
  return work === undefined ? undefined : workSummary(ruleset, work);
};

/** An improvement as prose, with what it costs: `improvement "Mine" (3 turns)`. */
const improvementLabel = (ruleset: RulesetView, id: ImprovementId): string => {
  const def = improvementDef(ruleset, id);
  return def === undefined
    ? `improvement "${id}"`
    : `improvement "${def.name}" (${String(def.turns)} turn${def.turns === 1 ? '' : 's'})`;
};

/** `id (N turns)` for every improvement in the catalog — the catalogue, as data. */
const improvementCatalogueHint = (ruleset: RulesetView): string => {
  const rows = improvementCatalog(ruleset).map(
    (def) =>
      `"${def.id}" (${String(def.turns)} turn${def.turns === 1 ? '' : 's'}, ` +
      `${def.allowedRoles.join('/') || 'nowhere'})`,
  );
  if (rows.length === 0) {
    return 'this ruleset can build no improvements at all: its improvement catalog is empty';
  }
  return `buildable improvements: ${rows.join('; ')}`;
};

const unitLabel = (state: GameState, ruleset: RulesetView, unitId: UnitId): string => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return `unit ${String(unitId)}`;
  const def = unitDef(ruleset, unit.type);
  const max = def === undefined ? '?' : `${String(def.movement)} per turn`;
  const job = workOf(ruleset, unit);
  return (
    `unit ${String(unit.id)} (${typeName(ruleset, unit.type)} at ` +
    `${coordOf(state.map, unit.tile)}, ${String(unit.movementLeft)}/${max} movement left` +
    // A working unit says so wherever it is named, because "why can this worker not
    // start a job?" is answered by the job it already has.
    `${job === undefined ? '' : `, ${job}`})`
  );
};

/** The legal alternatives for the unit a refused command named — the lesson. */
const legalMovesLines = (context: ErrorContext): readonly string[] => {
  const id = context.unitId;
  if (id === undefined) return [];
  if (unitById(context.state, id) === undefined) return [];

  const options = unitMoveOptions(context.state, context.ruleset, id);
  const label = unitLabel(context.state, context.ruleset, id);
  if (options.length === 0) {
    return [`  legal: ${label} has no legal move this turn ("end" refills movement).`];
  }
  const tiles = options.map((tile) => `(${coordOf(context.state.map, tile)})`).join(' ');
  return [`  legal: ${label} can move to ${tiles}.`];
};

/** The acting player's own units, so a bad id is a one-line fix. */
const yourUnitsLines = (context: ErrorContext): readonly string[] => {
  const mine = context.state.units.filter((unit) => unit.owner === context.playerId);
  if (mine.length === 0) return ['  your units: none.'];

  const labels = mine.map((unit) => {
    const def = unitDef(context.ruleset, unit.type);
    const name = def === undefined ? unit.type : def.name;
    const job = workOf(context.ruleset, unit);
    return (
      `${String(unit.id)} ${name} at ${coordOf(context.state.map, unit.tile)} ` +
      `(${String(unit.movementLeft)} movement left` +
      // What the unit is doing belongs with where it is: a bad id is a one-line fix,
      // and "that worker is already mining" is part of the line.
      `${job === undefined ? '' : `, ${job}`})`
    );
  });
  return [`  your units: ${labels.join('; ')}.`];
};

/** The acting player's own cities, so a bad city id is a one-line fix. */
const yourCitiesLines = (context: ErrorContext): readonly string[] => {
  const mine = citiesOf(context.state, context.playerId);
  if (mine.length === 0) return ['  your cities: none.'];

  const labels = mine.map(
    (city) => `${String(city.id)} ${city.name} at ${coordOf(context.state.map, city.tile)}`,
  );
  return [`  your cities: ${labels.join('; ')}.`];
};

/**
 * `city 0 "City 1" (Player 1 (p0) at 12,8)`, or `city 0` when the state has no
 * such city — an error about a city the state does not define must still print,
 * and it must not claim a name or an owner it never read.
 */
const cityLabel = (state: GameState, cityId: CityId): string => {
  const city = cityById(state, cityId);
  if (city === undefined) return `city ${String(cityId)}`;
  return (
    `city ${String(city.id)} "${city.name}" (${playerLabel(state, city.owner)} at ` +
    `${coordOf(state.map, city.tile)})`
  );
};

/** A production item as prose: `unit "settler"` or `building "granary"`. */
const itemLabel = (ruleset: RulesetView, item: ProductionItem): string =>
  item.kind === 'unit' ? `unit "${typeName(ruleset, item.id)}"` : buildingLabel(ruleset, item.id);

/** A building as prose, falling back to the raw id when the ruleset cannot name it. */
const buildingLabel = (ruleset: RulesetView, id: BuildingId): string =>
  `building "${buildingDef(ruleset, id)?.name ?? id}"`;

/* ------------------------------------------------------------------ *
 * M3 - the legal alternatives for a refused city command.
 *
 * Every list below is an answer the engine gives, not a restatement of
 * the city rules: `planFoundCity`, `planSetWorkedTiles` and
 * `planSetProduction` are the *same* evaluators `applyCommand` refuses
 * with, and `cityRadius`/`foodBoxSize`/`itemCostOf` are the engine's own
 * statements of the radius, the next-citizen threshold and an item's
 * cost. That is the point: the prose under a refusal cannot drift from
 * the engine, because there is only one implementation of each rule.
 * ------------------------------------------------------------------ */

/** The city a context names, when the state has one with that id. */
const contextCity = (context: ErrorContext): City | undefined =>
  context.cityId === undefined ? undefined : cityById(context.state, context.cityId);

/** `(x,y) (x,y) ...`, or `fallback` for an empty list. The one tile-list renderer. */
const tileList = (map: GameMap, tiles: readonly TileIndex[], fallback: string): string =>
  tiles.length === 0 ? fallback : tiles.map((tile) => `(${coordOf(map, tile)})`).join(' ');

/** `(x,y) (x,y) ...`, or `(none)` for an empty list. */
const coordList = (context: ErrorContext, tiles: readonly TileIndex[]): string =>
  tileList(context.state.map, tiles, '(none)');

/**
 * The tiles `cityId` may be assigned right now, asked one tile at a time of
 * `planSetWorkedTiles` — so a tile another city works, a tile outside the radius,
 * the centre itself and an off-map tile are all excluded by the engine's answer
 * rather than by a second opinion here.
 */
const workableTiles = (state: GameState, playerId: PlayerId, city: City): readonly TileIndex[] =>
  cityRadius(state, city.tile).filter(
    (tile) =>
      Number(tile) !== Number(city.tile) && planSetWorkedTiles(state, playerId, city.id, [tile]).ok,
  );

/**
 * The lesson behind a refused `work`: the city's citizen count (which bounds the
 * assignment), what it works now, and the tiles it may work instead.
 */
const legalWorkLines = (context: ErrorContext): readonly string[] => {
  const city = contextCity(context);
  if (city === undefined) return yourCitiesLines(context);

  const free = workableTiles(context.state, context.playerId, city);
  return [
    `  legal: ${cityLabel(context.state, city.id)} has ${String(city.population)} citizen(s), so at`,
    `    most ${String(city.population)} worked tile(s); it works ` +
      `${coordList(context, city.workedTiles)} now.`,
    `  legal: tiles free for it to work: ${coordList(context, free)}.`,
  ];
};

/**
 * Every item `cityId` may be set to build, as `planSetProduction` answers it —
 * so an id no catalog defines and a building the city already has are excluded by
 * the engine, not by the REPL.
 */
const buildableItems = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  cityId: CityId,
): readonly ProductionItem[] => {
  const items: readonly ProductionItem[] = [
    ...unitCatalog(ruleset).map((def): ProductionItem => ({ kind: 'unit', id: def.id })),
    ...buildingCatalog(ruleset).map((def): ProductionItem => ({ kind: 'building', id: def.id })),
  ];
  return items.filter((item) => planSetProduction(state, ruleset, playerId, cityId, item).ok);
};

/** An item as prose with its cost: `unit "Settler" (cost 3 shields)`. */
const pricedItemLabel = (ruleset: RulesetView, item: ProductionItem): string => {
  const cost = itemCostOf(ruleset, item);
  return (
    `${itemLabel(ruleset, item)} ` +
    (cost === undefined ? '(unpriceable)' : `(cost ${String(cost)} shield${cost === 1 ? '' : 's'})`)
  );
};

/** The lesson behind a refused `build`: what this city may build instead. */
const legalBuildLines = (context: ErrorContext): readonly string[] => {
  const city = contextCity(context);
  if (city === undefined) return yourCitiesLines(context);

  const items = buildableItems(context.state, context.ruleset, context.playerId, city.id);
  // Units and buildings on their own lines: ten items on one line is a wall, and
  // the split is the same distinction `build` asks the player to spell out.
  const labels = (kind: ProductionItem['kind']): string =>
    items
      .filter((item) => item.kind === kind)
      .map((item) => pricedItemLabel(context.ruleset, item))
      .join(', ');

  const units = labels('unit');
  const buildings = labels('building');
  const inventory =
    units === '' && buildings === ''
      ? 'nothing this ruleset can price.'
      : [
          units === '' ? undefined : `units: ${units}`,
          buildings === '' ? undefined : `buildings: ${buildings}`,
        ]
          .filter((line): line is string => line !== undefined)
          .join('; ') + '.';

  return [
    `  legal: ${cityLabel(context.state, city.id)} may be set to build ${inventory}`,
    `  legal: "build ${String(city.id)} unit:<id>" or "build ${String(city.id)} building:<id>".`,
  ];
};

/**
 * The lesson behind a refused `found`: the units of yours that *could* found a
 * city where they stand, asked of `planFoundCity` — the evaluator that refused
 * the command.
 */
const legalFoundLines = (context: ErrorContext): readonly string[] => {
  const ready = context.state.units.filter(
    (unit) =>
      unit.owner === context.playerId &&
      planFoundCity(context.state, context.ruleset, context.playerId, unit.id).ok,
  );

  if (ready.length === 0) {
    return [
      '  legal: none of your units can found a city where it stands: a settler must be on land',
      `  and at least ${String(MIN_CITY_DISTANCE)} tiles (counting diagonals) from every city.`,
    ];
  }
  const labels = ready.map((unit) => unitLabel(context.state, context.ruleset, unit.id));
  return [`  legal: these can found a city now: ${labels.join('; ')}.`];
};

/* ------------------------------------------------------------------ *
 * M4a - the legal alternatives for a refused worker command.
 *
 * Same arrangement as the city lessons above: `planStartWork` is the
 * evaluator `applyCommand` refuses with, so a "legal:" line under a
 * refusal names a job the engine would actually accept. There is no
 * second reading of "may this worker build this here?" in this file.
 * ------------------------------------------------------------------ */

/**
 * The improvements `unitId` may start where it stands, asked of `planStartWork` one
 * catalog row at a time. Empty when the unit does not exist, is not the actor's, is
 * not a worker, is already working, has no movement left, or stands on a terrain
 * role the row does not allow — every one of those is the engine's own answer, not
 * a rule restated here.
 */
const startableImprovements = (context: ErrorContext, unitId: UnitId): readonly ImprovementDef[] =>
  improvementCatalog(context.ruleset).filter(
    (def) => planStartWork(context.state, context.ruleset, context.playerId, unitId, def.id).ok,
  );

/** What one unit could start right now, as the lesson under a refusal about it. */
const startableLines = (context: ErrorContext, unitId: UnitId | undefined): readonly string[] => {
  if (unitId === undefined) return [];

  const ready = startableImprovements(context, unitId);
  if (ready.length === 0) {
    return [
      '  legal: that unit can start no job where it stands right now: a worker must be idle,',
      '  have movement left, and stand where this ruleset allows the improvement.',
    ];
  }
  return [
    `  legal: ${unitLabel(context.state, context.ruleset, unitId)} can start ` +
      `${ready.map((def) => improvementLabel(context.ruleset, def.id)).join(', ')}.`,
  ];
};

/**
 * The units of yours that could start *some* job where they stand — the worker
 * counterpart of `legalFoundLines`, and for the same reason: a refusal about "not a
 * worker" is only a lesson if it also says which unit could have done it.
 */
const legalWorkerLines = (context: ErrorContext): readonly string[] => {
  const ready = context.state.units.filter(
    (unit) => unit.owner === context.playerId && startableImprovements(context, unit.id).length > 0,
  );

  if (ready.length === 0) {
    return [
      '  legal: none of your units can start a job where it stands: a worker must be idle,',
      '  have movement left, and stand where this ruleset allows the improvement.',
    ];
  }
  return [
    `  legal: these can start a job now: ${ready
      .map((unit) => unitLabel(context.state, context.ruleset, unit.id))
      .join('; ')}.`,
  ];
};

/* ------------------------------------------------------------------ *
 * M3 - what the two setter verbs accept.
 * ------------------------------------------------------------------ */

/** The unit a command names, when it names one (`move`, `found`, the worker verbs). */
const unitIdOf = (command: Command): UnitId | undefined =>
  command.type === 'MoveUnit' ||
  command.type === 'FoundCity' ||
  command.type === 'StartWork' ||
  command.type === 'CancelWork'
    ? command.unitId
    : undefined;

/** The city a command names, when it names one (`work` and `build` do). */
const cityIdOf = (command: Command): CityId | undefined =>
  command.type === 'SetWorkedTiles' || command.type === 'SetProduction'
    ? command.cityId
    : undefined;

/**
 * The `ProductionItem` a `build` argument means.
 *
 * `unit:<id>` and `building:<id>` are the explicit spellings, and they are always
 * taken at their word: the two id spaces are different (a unit and a building may
 * share an id — `cities.ts` says so where `ProductionItem` is declared), and an
 * explicit kind is how the REPL is told *which* is meant. A bare id is accepted
 * when exactly one catalog holds it, refused when both do (spell the kind out) and
 * refused when neither does — with a hint that lists what this ruleset can
 * actually price, taken from `itemCostOf`, the engine's own answer.
 */
const productionItemOf = (ruleset: RulesetView, spec: string): Result<ProductionItem, string> => {
  const colon = spec.indexOf(':');
  if (colon >= 0) {
    const kind = spec.slice(0, colon).toLowerCase();
    const id = spec.slice(colon + 1);
    if (id === '') return err(`"${spec}" names no id after the ":"`);
    if (kind === 'unit') return ok({ kind: 'unit', id: asUnitTypeId(id) });
    if (kind === 'building') return ok({ kind: 'building', id: asBuildingId(id) });
    return err(
      `"${kind}" is not a kind of thing to build: use "unit:<id>" or "building:<id>" ` +
        `(got "${spec}")`,
    );
  }

  const inUnits = unitCatalog(ruleset).some((def) => def.id === spec);
  const inBuildings = buildingCatalog(ruleset).some((def) => def.id === spec);

  if (inUnits && inBuildings) {
    return err(
      `"${spec}" is both a unit and a building in this ruleset, so the kind has to be spelled ` +
        `out: "unit:${spec}" or "building:${spec}"`,
    );
  }
  if (inUnits) return ok({ kind: 'unit', id: asUnitTypeId(spec) });
  if (inBuildings) return ok({ kind: 'building', id: asBuildingId(spec) });

  return err(`this ruleset has no unit and no building with the id "${spec}"`);
};

/**
 * What a ruleset can build at all, as prose for a hint — every catalog row whose
 * cost `itemCostOf` accepts. That is the engine's own "can this be priced?"
 * evaluator, so the hint cannot advertise an item `build` would refuse.
 */
const buildCatalogueHint = (ruleset: RulesetView): string => {
  const units = unitCatalog(ruleset)
    .filter((def) => itemCostOf(ruleset, { kind: 'unit', id: def.id }) !== undefined)
    .map((def) => `unit "${def.id}" (${String(def.cost)} shields)`);
  const buildings = buildingCatalog(ruleset)
    .filter((def) => itemCostOf(ruleset, { kind: 'building', id: def.id }) !== undefined)
    .map((def) => `building "${def.id}" (${String(def.cost)} shields)`);

  if (units.length === 0 && buildings.length === 0) {
    return 'this ruleset can build nothing: no catalog row carries a usable shield cost';
  }
  return `buildable here: ${[...units, ...buildings].join('; ')}`;
};

/**
 * Render a `GameError` as an explanation plus, where it can be derived, the
 * moves that were legal.
 *
 * The message always names the *reason* first — the same string the AI branches
 * on and the test asserts on — so the prose and the type stay in step.
 */
export const formatGameError = (error: GameError, context: ErrorContext): string => {
  switch (error.kind) {
    case 'unknown-unit':
      return [
        `error: unknown-unit - there is no unit with id ${String(error.unitId)}.`,
        ...yourUnitsLines(context),
        '  type "units" to list the units you can see.',
      ].join('\n');

    case 'unknown-player':
      return [
        `error: unknown-player - this session acts as player ${String(error.playerId)}, which this`,
        `  state does not define (it has ${String(context.state.players.length)} players).`,
      ].join('\n');

    case 'not-your-unit':
      return [
        `error: not-your-unit - unit ${String(error.unitId)} belongs to ` +
          `${playerLabel(context.state, error.owner)}, and you are ` +
          `${playerLabel(context.state, context.playerId)}.`,
        ...yourUnitsLines(context),
      ].join('\n');

    case 'out-of-bounds':
      return [
        `error: out-of-bounds - tile ${String(error.to)} is outside the map ` +
          `(${String(context.state.map.width)}x${String(context.state.map.height)}): x must be ` +
          `0..${String(context.state.map.width - 1)} and y must be ` +
          `0..${String(context.state.map.height - 1)}.`,
      ].join('\n');

    case 'impassable': {
      const terrain = terrainDefAt(context.state, context.ruleset, error.to);
      const what = terrain === undefined ? 'that terrain' : `terrain "${terrain.name}"`;
      return [
        `error: impassable - ${unitLabel(context.state, context.ruleset, error.unitId)} cannot ` +
          `enter (${coordOf(context.state.map, error.to)}): ${what} is impassable.`,
        ...legalMovesLines(context),
      ].join('\n');
    }

    case 'not-enough-movement':
      return [
        `error: not-enough-movement - ${unitLabel(context.state, context.ruleset, error.unitId)} ` +
          `needs ${String(error.needed)} movement for the step onto that tile, but only ` +
          `${String(error.available)} is left. "end" refills movement.`,
        ...legalMovesLines(context),
      ].join('\n');

    case 'occupied-by-enemy': {
      const holders = unitsOnTile(context.state, error.to)
        .filter((unit) => unit.owner !== context.playerId)
        .map((unit) => `${playerLabel(context.state, unit.owner)} unit ${String(unit.id)}`)
        .join(', ');
      const held = holders === '' ? 'another player' : holders;
      return [
        `error: occupied-by-enemy - (${coordOf(context.state.map, error.to)}) is held by ${held}.`,
        '  Combat arrives in M6, so an enemy tile is not enterable.',
        ...legalMovesLines(context),
      ].join('\n');
    }

    /* ---------------- M3: founding, citizens and production ---------------- */

    case 'not-a-settler':
      return [
        `error: not-a-settler - ${unitLabel(context.state, context.ruleset, error.unitId)} is not a`,
        '  settler, and only a settler can found a city (founding consumes it).',
        ...legalFoundLines(context),
        ...legalMovesLines(context),
      ].join('\n');

    case 'not-on-land': {
      const terrain = terrainDefAt(context.state, context.ruleset, error.tile);
      const what = terrain === undefined ? 'not land' : `"${terrain.name}" (water)`;
      return [
        `error: not-on-land - a city can only be founded on land, and ` +
          `(${coordOf(context.state.map, error.tile)}) is ${what}.`,
        ...legalFoundLines(context),
        ...legalMovesLines(context),
      ].join('\n');
    }

    case 'city-too-close':
      return [
        `error: city-too-close - (${coordOf(context.state.map, error.tile)}) is ` +
          `${String(error.distance)} tile(s) from ${cityLabel(context.state, error.cityId)}, and ` +
          `cities must be at least ${String(error.minDistance)} apart (counting diagonals).`,
        ...legalFoundLines(context),
        ...legalMovesLines(context),
      ].join('\n');

    case 'unknown-city':
      return [
        `error: unknown-city - there is no city with id ${String(error.cityId)}.`,
        ...yourCitiesLines(context),
      ].join('\n');

    case 'not-your-city':
      return [
        `error: not-your-city - ${cityLabel(context.state, error.cityId)} belongs to ` +
          `${playerLabel(context.state, error.owner)}, and you are ` +
          `${playerLabel(context.state, context.playerId)}.`,
        ...yourCitiesLines(context),
      ].join('\n');

    case 'tile-not-workable': {
      const where = `(${coordOf(context.state.map, error.tile)})`;
      const city = cityById(context.state, error.cityId);
      if (city !== undefined && city.tile === error.tile) {
        return [
          `error: tile-not-workable - ${where} is the centre of ` +
            `${cityLabel(context.state, error.cityId)}, and the centre is always`,
          '  worked for free: it costs no citizen, so it is never listed as a worked tile.',
          ...legalWorkLines(context),
        ].join('\n');
      }
      return [
        `error: tile-not-workable - ${where} is not inside the working radius of ` +
          `${cityLabel(context.state, error.cityId)}.`,
        '  a city works the tiles within two of its centre (the four corners excepted), and only',
        '  tiles that are on the map: a tile at or past an edge has no yields to assign.',
        ...legalWorkLines(context),
      ].join('\n');
    }

    case 'tile-worked-by-another-city':
      return [
        `error: tile-worked-by-another-city - ` +
          `(${coordOf(context.state.map, error.tile)}) is already worked by ` +
          `${cityLabel(context.state, error.byCityId)}.`,
        '  a tile may be worked by only one city, of any owner, at a time.',
        ...legalWorkLines(context),
      ].join('\n');

    case 'duplicate-worked-tile':
      return [
        `error: duplicate-worked-tile - (${coordOf(context.state.map, error.tile)}) is listed ` +
          `twice for ${cityLabel(context.state, error.cityId)}.`,
        '  one citizen works one tile, so a repeated tile would spend two citizens on one job.',
        ...legalWorkLines(context),
      ].join('\n');

    case 'too-many-worked-tiles':
      return [
        `error: too-many-worked-tiles - ${cityLabel(context.state, error.cityId)} has ` +
          `${String(error.allowed)} citizen(s) and can work at most ${String(error.allowed)} ` +
          `tile(s), but ${String(error.requested)} were given.`,
        '  the whole request is refused rather than truncated: an assignment longer than the',
        '  citizen count is a mistake, and a shorter one is what you meant to send.',
        ...legalWorkLines(context),
      ].join('\n');

    case 'unknown-production-item':
      return [
        `error: unknown-production-item - this ruleset cannot build ` +
          `${itemLabel(context.ruleset, error.item)}.`,
        '  an item is buildable when its catalog row exists and its cost is a whole number of',
        '  shields greater than zero. "state" shows the hash; the ruleset is @civts/rules.',
        ...legalBuildLines(context),
      ].join('\n');

    case 'already-built':
      return [
        `error: already-built - ${cityLabel(context.state, error.cityId)} already has ` +
          `${buildingLabel(context.ruleset, error.building)}.`,
        '  each building is built once per city; building it again is refused rather than',
        '  quietly ignored, so a queue cannot silently waste shields on a duplicate.',
        ...legalBuildLines(context),
      ].join('\n');

    case 'invalid-argument':
      return [`error: invalid-argument - ${error.detail}`, ...legalMovesLines(context)].join('\n');

    /* ---------------- M4a: workers and tile improvements ---------------- */

    case 'not-a-worker':
      return [
        `error: not-a-worker - ${unitLabel(context.state, context.ruleset, error.unitId)} is not`,
        '  a worker, and only a worker improves a tile. A unit type this ruleset does not',
        '  describe is not a worker either: the engine cannot see one there.',
        ...legalWorkerLines(context),
        ...legalMovesLines(context),
      ].join('\n');

    case 'already-working': {
      const unit = unitById(context.state, error.unitId);
      const doing = unit === undefined ? undefined : workOf(context.ruleset, unit);
      return [
        `error: already-working - ${unitLabel(context.state, context.ruleset, error.unitId)} is`,
        `  already ${doing ?? `working on "${error.improvement}"`}. One job at a time:`,
        `  "cancel ${String(error.unitId)}" gives the job up first (the turns already spent`,
        '  are not refunded).',
        ...legalMovesLines(context),
      ].join('\n');
    }

    case 'not-working':
      return [
        `error: not-working - ${unitLabel(context.state, context.ruleset, error.unitId)} is not`,
        '  working, so there is nothing to cancel. The "units" table and the "units:" line',
        '  under every view say what each unit is doing.',
        ...startableLines(context, error.unitId),
        ...legalMovesLines(context),
      ].join('\n');

    case 'unknown-improvement':
      return [
        `error: unknown-improvement - this ruleset cannot build the improvement ` +
          `"${error.improvement}".`,
        '  an improvement is buildable when its catalog row exists and its turns are a',
        `  whole number of at least 1. ${improvementCatalogueHint(context.ruleset)}.`,
      ].join('\n');

    case 'improvement-not-allowed': {
      const terrain = terrainDefAt(context.state, context.ruleset, error.tile);
      const what =
        terrain === undefined
          ? `terrain role "${error.role}"`
          : `"${terrain.name}" (${terrain.role})`;
      const allows = improvementCatalog(context.ruleset)
        .filter((def) => def.allowedRoles.includes(error.role))
        .map((def) => def.id);
      return [
        `error: improvement-not-allowed - ${improvementLabel(context.ruleset, error.improvement)}`,
        `  cannot be built at (${coordOf(context.state.map, error.tile)}), which is ${what}.`,
        allows.length === 0
          ? '  this ruleset lets no improvement be built on that terrain role.'
          : `  this terrain role allows: ${allows.join(', ')}.`,
        ...startableLines(context, error.unitId),
      ].join('\n');
    }

    case 'already-improved':
      return [
        `error: already-improved - (${coordOf(context.state.map, error.tile)}) already carries ` +
          `${improvementLabel(context.ruleset, error.improvement)}.`,
        '  building it twice is refused rather than quietly ignored: the tile keeps what it',
        '  has, and the worker keeps the turns it would have spent.',
        ...startableLines(context, context.unitId),
      ].join('\n');
  }
};
/** A `SetupError` as prose. Shared with the `map` command, so both say the same thing. */
export const formatSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `ruleset is missing terrain role "${error.role}"`;
    case 'missing-unit-role':
      return `ruleset has no unit with role "${error.role}", so no starting unit can be placed`;
    case 'no-valid-starts':
      return `no valid starting tile for ${String(error.civCount)} civilizations`;
    case 'too-few-start-candidates':
      return 'too few starting-tile candidates for the requested civilizations';
  }
};

/* ------------------------------------------------------------------ *
 * M3 - one city in full, and the list of them.
 *
 * Numbers here are read, never derived: the growth threshold comes from
 * `foodBoxSize`, an item's price from `itemCostOf`, the yields from
 * `cityYields`. "How much more food does this city need?" is a
 * subtraction of two numbers the engine published, not a second
 * statement of the growth rule.
 * ------------------------------------------------------------------ */

/** `+2` / `-1` / `0`: a surplus with its sign, for a reader skimming the line. */
const signed = (value: number): string => (value > 0 ? `+${String(value)}` : String(value));

/** The terrain under a tile, or `?` when the ruleset cannot name it. */
const terrainNameAt = (state: GameState, ruleset: RulesetView, tile: TileIndex): string =>
  terrainDefAt(state, ruleset, tile)?.name ?? '?';

/**
 * One city in full: population, the food box **and the threshold it is filling
 * toward**, the stored shields, the item being built **and what it costs**, the
 * queue behind that item, the buildings, and the tiles its citizens work.
 *
 * The yields line states what `cityYields` computed — food, shields, commerce,
 * how much the citizens eat, and the surplus — because "why is this city not
 * growing?" is a question about integers the engine already has, and a reader
 * should not have to add them up.
 */
const cityDetailText = (state: GameState, ruleset: RulesetView, city: City): string => {
  const yields: CityYields = cityYields(state, ruleset, city.id);
  const box = foodBoxSize(city.population);
  const eaten = yields.food - yields.foodSurplus;
  const item = city.production;

  const lines = [
    cityLabel(state, city.id),
    `  population ${String(city.population)}; food box ${String(city.foodBox)}/${String(box)} ` +
      `(${String(Math.max(0, box - city.foodBox))} more to grow); food ${String(yields.food)} per ` +
      `turn, ${String(eaten)} eaten, surplus ${signed(yields.foodSurplus)}`,
  ];

  if (item === undefined) {
    lines.push(
      `  shields ${String(city.shields)}; building nothing (idle: ` +
        `"build ${String(city.id)} unit:<id>" or "build ${String(city.id)} building:<id>")`,
    );
  } else {
    const cost = itemCostOf(ruleset, item);
    lines.push(
      `  shields ${String(city.shields)}; building ${itemLabel(ruleset, item)} ` +
        `(cost ${cost === undefined ? '? (unpriceable)' : String(cost)}; ` +
        `${cost === undefined ? '?' : String(Math.max(0, cost - city.shields))} more to go)`,
    );
  }

  lines.push(
    city.queue.length === 0
      ? '  queue: (empty)'
      : `  queue: ${city.queue
          .map((entry, index) => `${String(index + 1)}. ${pricedItemLabel(ruleset, entry)}`)
          .join(', ')}`,
  );

  lines.push(
    city.buildings.length === 0
      ? '  buildings: (none)'
      : `  buildings: ${city.buildings
          .map((id) => buildingDef(ruleset, id)?.name ?? id)
          .join(', ')}`,
  );

  lines.push(
    city.workedTiles.length === 0
      ? `  works 0 of ${String(city.population)} citizen(s): (nothing assigned - an unassigned ` +
          'citizen works nothing)'
      : `  works ${String(city.workedTiles.length)} of ${String(city.population)} citizen(s): ` +
          city.workedTiles
            .map((tile) => `(${coordOf(state.map, tile)}) ${terrainNameAt(state, ruleset, tile)}`)
            .join(', '),
  );

  if (city.workedTiles.length > city.population) {
    lines.push(
      `  note: only the first ${String(city.population)} of those tile(s) count - one citizen ` +
        'works one tile (see "work <cityId> <x> <y>").',
    );
  }

  return `${lines.join('\n')}\n`;
};

/** Column widths for the `cities` table: id, name, at, pop, food, shields, production. */
const CITY_WIDTHS: readonly number[] = [2, 10, 6, 3, 8, 7];

/**
 * The player's own cities, one row each: id, name, where it is, its citizens, the
 * food box against its next-citizen threshold, the stored shields, and what it is
 * building. The `city <cityId>` view is the one that goes into detail.
 *
 * `visible` is the fog-filtered list the view line uses, so a city of another
 * player the session *can* see is named here too — under the table, never in it.
 * Without that line `cities` would answer "you have none" while the `cities:` line
 * above it listed somebody else's, which reads like a bug rather than like a rule.
 */
const citiesTableText = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  visible: readonly City[],
): string => {
  const mine = citiesOf(state, playerId);
  const others = visible.filter((city) => city.owner !== playerId);
  const lines = [`cities: ${String(mine.length)} for ${playerLabel(state, playerId)}`];

  if (mine.length === 0) {
    lines.push('  you have founded none yet: "found <unitId>" turns one of your settlers into a');
    lines.push('  city where it stands ("units" lists your unit ids).');
  } else {
    lines.push(tableRow(CITY_WIDTHS, ['id', 'name', 'at', 'pop', 'food', 'shields', 'production']));
    for (const city of mine) {
      const item = city.production;
      lines.push(
        tableRow(CITY_WIDTHS, [
          String(city.id),
          city.name,
          coordOf(state.map, city.tile),
          String(city.population),
          `${String(city.foodBox)}/${String(foodBoxSize(city.population))}`,
          String(city.shields),
          item === undefined ? '(idle)' : itemLabel(ruleset, item),
        ]),
      );
    }
    lines.push('  "city <cityId>" shows one in full: yields, queue, buildings and worked tiles.');
  }

  if (others.length > 0) {
    lines.push(
      `  not yours, but visible to you: ${others
        .map((city) => citySummary(state, ruleset, city, false))
        .join('  ')}`,
    );
  }

  return `${lines.join('\n')}\n`;
};

/**
 * One compact line per city you can see, printed under every view — the city
 * counterpart of the `units:` line, and for the same reason: `describe` draws
 * terrain and huts, so without this the agent would have to ask "cities" after
 * every command to notice the city it just founded. Compact on purpose: it is
 * printed after *every* command, and `city <cityId>` is where the detail lives.
 */
const citySummary = (state: GameState, ruleset: RulesetView, city: City, mine: boolean): string => {
  const item = city.production;
  return (
    `${mine ? '*' : ' '}${String(city.id)} ${city.name} p${String(city.owner)} ` +
    `@${coordOf(state.map, city.tile)} pop ${String(city.population)} ` +
    `food ${String(city.foodBox)}/${String(foodBoxSize(city.population))} ` +
    `shields ${String(city.shields)} ` +
    (item === undefined ? '(idle)' : `building ${itemLabel(ruleset, item)}`)
  );
};

/* ------------------------------------------------------------------ *
 * The session.
 * ------------------------------------------------------------------ */

/** What one input line did. Returned as well as printed, so tests need not scrape text. */
export type LineOutcome =
  | { readonly kind: 'applied'; readonly command: Command; readonly outcome: CommandOutcome }
  | { readonly kind: 'refused'; readonly command: Command; readonly error: GameError }
  | { readonly kind: 'inspected'; readonly command: string }
  /**
   * An inspector named a city this session cannot show — one the state does not
   * have, or one the player can neither own nor see. Not a `refused`: nothing was
   * sent to the engine, because inspecting is not a `Command`.
   */
  | { readonly kind: 'unknown-city'; readonly cityId: CityId }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'io-error'; readonly detail: string }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'quit' };

export interface SessionOptions {
  readonly state: GameState;
  readonly ruleset: RulesetView;
  readonly playerId: PlayerId;
  /**
   * Render the whole map (no `viewer`) instead of the acting player's fog.
   * Debugging only: it is the one way the REPL can show a tile the player has
   * never explored, which is exactly what `describe`'s god mode is for.
   */
  readonly god: boolean;
  /** Where everything the session prints goes (stdout in the CLI, a buffer in tests). */
  readonly write: (text: string) => void;
}

export interface ReplSession {
  /** The current state. Replaced wholesale by every applied command; never mutated. */
  readonly state: GameState;
  readonly playerId: PlayerId;
  /** Process one input line, printing everything it has to say. */
  readonly run: (line: string) => LineOutcome;
}

/**
 * Every verb, for the banner and for the "unknown command" reply — so a mistyped
 * word is answered with the list it should have come from. Exported because the
 * transcript fixture prints it: a new verb has to show up here as well as in
 * `HELP`.
 */
export const COMMAND_SUMMARY =
  'move <unitId> <x> <y> | found <unitId> | cities | city <cityId> | ' +
  'work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | ' +
  'work <unitId> <improvementId> | cancel <unitId> | ' +
  'end | units | state | save <path> | help | quit';

const HELP = `commands:
  move <unitId> <x> <y>   step one unit onto an adjacent tile (8-way). The cost is the
                          destination tile's move cost, paid from that unit's movement.
  found <unitId>          found a city with that unit, which must be a settler standing on
                          land at least 2 tiles (counting diagonals) from every city. The
                          settler is consumed. New cities start at population 1 and work
                          the best tiles they can reach.
  cities                  list your cities: where each is, its citizens, its food box
                          against the threshold for the next citizen, its stored shields
                          and what it is building.
  city <cityId>           show one city in full: population, the food box and its
                          threshold, stored shields, the current item and its cost, the
                          queue behind it, its buildings and the tiles it works.
  work <cityId> <x> <y> ...   set which tiles that city's citizens work, one x y pair per
                          citizen (at most "population" pairs; an unassigned citizen works
                          nothing). With no pairs the assignment is cleared.
  build <cityId> <item>   set what that city builds. <item> is "unit:<id>" or
                          "building:<id>"; a bare id is accepted when only one catalog has
                          it ("build 0 granary" means building "Granary", because no unit
                          is called that). Stored shields are kept.
  work <unitId> <improvementId>   put that worker to work on the tile it is standing on,
                          building <improvementId> there. The unit must be a worker with
                          movement left and no job already; the improvement must be one
                          this ruleset builds where the unit stands and must not already be
                          on that tile. Starting spends the unit's whole turn. "work
                          <unitId> mine" and "work <cityId> <x> <y>" are told apart by the
                          second argument: an improvement id is a word, a coordinate is a
                          number.
  cancel <unitId>         stop that worker's job. Nothing is refunded: the turns already
                          spent are gone, and the improvement is not built. Moving a
                          working unit cancels its job the same way.
  end                     end the turn: every unit's work advances, every city grows and
                          produces, every unit refills its movement, turn advances. An
                          improvement finished this turn counts towards this turn.
  units                   list the units you can see, with position, movement left and
                          what each one is doing.
  state                   print seed, turn, revision, map size, RNG, what your units are
                          doing and the state hash.
  save <path>             write the state to <path> as canonical JSON (parent
                          directories are created).
  help                    print this text.
  quit                    leave the game (alias: exit). End of input also quits, with
                          status 0, so scripted and piped runs are safe.

notes:
  - coordinates are x,y as ruled above the map: x is the column, y is the row.
  - a digit drawn on the map is that player's STARTING tile. Live unit positions are the
    "units:" line printed under every view ("*" marks a unit of yours), your cities are
    the "cities:" line under it, and a unit in the middle of a job is named on the
    "work:" line under that.
  - a refused command prints the typed reason and the choices that were legal, and never
    changes the state.
  - every command goes through the engine's command API; the REPL never edits state.
`;

const promptFor = (playerId: PlayerId): string => `p${String(playerId)}> `;

const bannerText = (state: GameState, playerId: PlayerId, god: boolean): string =>
  `CivTS play - seed ${String(state.seed)}, ${state.settings.mapSize} map ` +
  `${String(state.map.width)}x${String(state.map.height)}, ` +
  // `civPlayers`, never `players.length`: M3 appends the barbarian player, so the
  // array is one longer than the civilization count and `--civs 2` would print
  // "3 civs" (INTERFACES.md M3, "State shape").
  `${String(civPlayers(state).length)} civs\n` +
  `you are ${playerName(state, playerId)} (p${String(playerId)}); ` +
  (god
    ? 'GOD MODE - the whole map is rendered and fog is ignored\n'
    : 'every view below is drawn from your fog of war\n') +
  `commands: ${COMMAND_SUMMARY}\n\n`;

/**
 * Compile-time exhaustiveness, made visible.
 *
 * A `switch` over a union that lacks a case does not fail loudly: the mapping
 * function simply returns `undefined`, and a line built from `undefined` is a
 * **blank line** in a transcript that looks like a rendering choice rather than a
 * bug. That is exactly how M3's city and goody-hut events were being dropped —
 * `CityFounded`, `CityGrew`, `CityStarved`, `CityProduced`, `HutEntered` and
 * `BarbariansSpawned` hit no case in `outcomeText` and printed nothing at all.
 *
 * So every event switch below is exhaustive *without* a `default` clause and ends
 * here: `value` is narrowed to `never` only when every member was handled, and
 * adding a `GameEvent` member therefore stops the build instead of quietly
 * producing that blank line. The throw is unreachable by construction; it exists
 * so the function has a total return type the compiler can check.
 */
const assertNever = (value: never): never => {
  throw new Error(`unhandled union member: ${JSON.stringify(value)}`);
};

/** `(x,y)` of the tile an event names. */
const eventPlace = (outcome: CommandOutcome, tile: TileIndex): string =>
  `(${coordOf(outcome.state.map, tile)})`;

/** `3, 4` — a list of unit ids for a reader, or `none`. */
const idList = (ids: readonly UnitId[]): string =>
  ids.length === 0 ? 'none' : ids.map((id) => String(id)).join(', ');

/**
 * One `ok:` line per event, in the order the events happened, followed by the new
 * revision.
 *
 * Every `GameEvent` member is rendered, and each line says something a reader can
 * act on: a hut that paid nothing says so, a city that starved names the citizen
 * it lost, a produced unit names the id and tile it appeared on. `outcomeText`
 * is the only place events become prose, so a caller that wants them as data
 * reads `CommandOutcome.events` instead.
 */
const outcomeText = (outcome: CommandOutcome, command: Command, ruleset: RulesetView): string => {
  const lines = outcome.events.map((event): string => {
    switch (event.type) {
      case 'UnitMoved':
        return (
          `ok: unit ${String(event.unitId)} moved to ${eventPlace(outcome, event.to)}, ` +
          `cost ${String(event.cost)}, ${String(event.movementLeft)} movement left`
        );

      case 'TurnEnded':
        return `ok: turn ${String(event.turn)} begins; every unit refilled its movement`;

      case 'CityFounded':
        return (
          `ok: ${event.name} founded at ${eventPlace(outcome, event.tile)} for ` +
          `${playerLabel(outcome.state, event.owner)} (city ${String(event.cityId)}); the ` +
          'settler is consumed'
        );

      case 'CityGrew':
        return (
          `ok: ${cityLabel(outcome.state, event.cityId)} grew to ` +
          `${String(event.population)} citizen(s); food box ${String(event.foodBox)}/` +
          `${String(foodBoxSize(event.population))} carried over`
        );

      case 'CityStarved':
        return (
          `ok: ${cityLabel(outcome.state, event.cityId)} starved down to ` +
          `${String(event.population)} citizen(s); food box restarted at ` +
          String(event.foodBox)
        );

      case 'CityProduced': {
        const where =
          event.unitId === undefined || event.tile === undefined
            ? ''
            : ` (unit ${String(event.unitId)} at ${eventPlace(outcome, event.tile)})`;
        return (
          `ok: ${cityLabel(outcome.state, event.cityId)} finished ` +
          `${itemLabel(ruleset, event.item)}${where}; ${String(event.shields)} shields left`
        );
      }

      case 'HutEntered': {
        const found =
          event.reward === 'unit'
            ? `a free unit${event.unitGiven === undefined ? '' : ` (unit ${String(event.unitGiven)})`}`
            : event.reward === 'barbarians'
              ? 'barbarians'
              : 'nothing (the hut is spent)';
        return (
          `ok: unit ${String(event.unitId)} entered a goody hut at ` +
          `${eventPlace(outcome, event.tile)} and found ${found}`
        );
      }

      case 'BarbariansSpawned':
        return event.unitIds.length === 0
          ? // Never emitted this way (`hut.ts` reports a band with nowhere to stand
            // as `reward: 'nothing'`), but the line must be true for any event the
            // state can carry rather than claiming a band that is not there.
            `ok: the hut at ${eventPlace(outcome, event.tile)} roused no band: the map had ` +
              'nowhere for one to stand'
          : `ok: ${String(event.unitIds.length)} barbarian unit(s) (${idList(event.unitIds)}) ` +
              `appeared on ${tileList(outcome.state.map, event.tiles, 'nowhere')} near the hut ` +
              `at ${eventPlace(outcome, event.tile)}, owned by ` +
              playerLabel(outcome.state, event.owner);

      case 'WorkStarted':
        return (
          `ok: unit ${String(event.unitId)} started ${improvementLabel(ruleset, event.kind)} on ` +
          `${eventPlace(outcome, event.tile)}: ${String(event.turnsLeft)} turn` +
          `${event.turnsLeft === 1 ? '' : 's'} left`
        );

      case 'WorkCancelled':
        return (
          `ok: unit ${String(event.unitId)} stopped ${improvementLabel(ruleset, event.kind)} on ` +
          `${eventPlace(outcome, event.tile)} (${
            event.reason === 'moved' ? 'the unit moved' : 'cancelled'
          }), ${String(event.turnsLeft)} turn${event.turnsLeft === 1 ? '' : 's'} of work lost`
        );

      case 'WorkCompleted':
        return (
          `ok: unit ${String(event.unitId)} finished ${improvementLabel(ruleset, event.kind)} on ` +
          `${eventPlace(outcome, event.tile)}; the tile is improved`
        );
    }

    return assertNever(event);
  });

  // Two commands emit no event, by the frozen contract: `SetWorkedTiles` and
  // `SetProduction` change only what the command's own payload names, and M3's
  // event list has no member for "the assignment changed" or "the queue changed".
  // Rendering the command that was applied is therefore the only honest report of
  // what happened — otherwise the session would answer a `build` with nothing but
  // "revision 5", and the player would have to guess whether it took.
  const effect = appliedCommandText(command, outcome, ruleset);
  const all = effect === undefined ? lines : [...lines, effect];

  const revision = `revision ${String(outcome.state.revision)}`;
  return all.length === 0 ? `ok: ${revision}` : `${all.join('\n')}\n  ${revision}`;
};

/**
 * What a command did when it emitted no event, or `undefined` for the commands
 * whose events already say it. Exhaustive over `Command` for the same reason
 * `outcomeText` is exhaustive over `GameEvent`: a new command must be considered
 * here rather than inherit a silent "nothing to report".
 */
const appliedCommandText = (
  command: Command,
  outcome: CommandOutcome,
  ruleset: RulesetView,
): string | undefined => {
  switch (command.type) {
    case 'MoveUnit':
    case 'EndTurn':
    case 'FoundCity':
      return undefined;

    // M4a: both worker commands emit an event of their own (`WorkStarted`,
    // `WorkCancelled`), and `outcomeText` renders every event — so there is nothing
    // left for this function to add. They are listed rather than left to a
    // `default` so a *new* command is still a compile error here.
    case 'StartWork':
    case 'CancelWork':
      return undefined;

    case 'SetWorkedTiles': {
      const city = cityById(outcome.state, command.cityId);
      const citizens = city === undefined ? undefined : city.population;
      if (command.tiles.length === 0) {
        return (
          `ok: ${cityLabel(outcome.state, command.cityId)} now works no tiles` +
          (citizens === undefined
            ? ' (the assignment is cleared)'
            : ` (its ${String(citizens)} citizen(s) work nothing, which is a legal choice)`)
        );
      }
      return (
        `ok: ${cityLabel(outcome.state, command.cityId)} now works ` +
        tileList(outcome.state.map, command.tiles, '(none)') +
        (citizens === undefined
          ? ''
          : ` with ${String(command.tiles.length)} of ${String(citizens)} citizen(s)`)
      );
    }

    case 'SetProduction': {
      const city = cityById(outcome.state, command.cityId);
      const stored = city === undefined ? 0 : city.shields;
      return (
        `ok: ${cityLabel(outcome.state, command.cityId)} production set to ` +
        `${pricedItemLabel(ruleset, command.item)}; ${String(stored)} shields stored`
      );
    }
  }

  // Reached only when every member above was handled, which is what makes the tail
  // a compile error rather than a silent "nothing to report" for a new command.
  return assertNever(command);
};

/** Column widths for the `units` table: marker, id, type, owner, at, move, terrain, job. */
const UNIT_WIDTHS: readonly number[] = [1, 2, 10, 11, 8, 7, 11, 26];

/** A padded row: every cell but the last is padded to its column's width. */
const tableRow = (widths: readonly number[], cells: readonly string[]): string =>
  cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
    .join('  ');

export const createSession = (options: SessionOptions): ReplSession => {
  const { ruleset, playerId, god, write } = options;
  let state = options.state;

  const context = (unitId: UnitId | undefined, cityId: CityId | undefined): ErrorContext => ({
    state,
    ruleset,
    playerId,
    unitId,
    cityId,
  });

  /**
   * The units a command author can see: its own always, another player's only
   * where it has explored. Positions are the one piece of state fog is for, so
   * a query that ignored the fog row would quietly turn the REPL into a cheat.
   */
  const visibleUnits = (): readonly Unit[] => {
    if (god) return state.units;
    return state.units.filter(
      (unit) => unit.owner === playerId || isExplored(state, playerId, unit.tile),
    );
  };

  /**
   * The cities this session may show: its own always, another player's only where
   * it has explored that city's tile — the same fog rule as `visibleUnits`, so
   * `city <id>` and the `cities:` line cannot become a way to scout for free.
   */
  const visibleCities = (): readonly City[] => {
    if (god) return state.cities;
    return state.cities.filter(
      (city) => city.owner === playerId || isExplored(state, playerId, city.tile),
    );
  };

  /** May this session show this city at all? (`city <cityId>`'s visibility half.) */
  const cityVisible = (city: City): boolean =>
    god || city.owner === playerId || isExplored(state, playerId, city.tile);

  /**
   * One compact line naming every visible unit, printed after each view.
   *
   * `describe` marks player *starting* tiles, not units — so without this the
   * agent would have to cross-reference the `units` table to find itself on a
   * 60x60 grid. The view and the positions therefore travel together.
   */
  const unitsLine = (): string => {
    const rows = visibleUnits();
    if (rows.length === 0) return 'units: none visible\n';

    const parts = rows.map((unit) => {
      const def = unitDef(ruleset, unit.type);
      const name = def === undefined ? unit.type : def.name;
      const max = def === undefined ? '?' : String(def.movement);
      const job = workOf(ruleset, unit);
      // M4a: a worker's job is part of what a unit *is* right now, so it belongs on
      // the line that names its position and its movement — otherwise "what is my
      // worker doing?" would need a second command after every step.
      const suffix = job === undefined ? '' : ` ${job}`;
      return (
        `${unit.owner === playerId ? '*' : ' '}${String(unit.id)} p${String(unit.owner)} ` +
        `${name} @${coordOf(state.map, unit.tile)} ` +
        `(${String(unit.movementLeft)}/${max} movement)${suffix}`
      );
    });
    return `units: ${parts.join('  ')}\n`;
  };

  /**
   * One compact line naming every city you can see, printed after each view.
   *
   * `describe` draws terrain and goody huts, not cities, so this is the only place
   * a founded city shows up without asking for it — and a session that founded one
   * would otherwise show a map with no unit and no sign of the city it made.
   */
  const citiesLine = (): string => {
    const rows = visibleCities();
    if (rows.length === 0) return 'cities: none\n';
    const parts = rows.map((city) => citySummary(state, ruleset, city, city.owner === playerId));
    return `cities: ${parts.join('  ')}\n`;
  };

  const view = (): void => {
    write(god ? describe(state, ruleset) : describe(state, ruleset, { viewer: playerId }));
    write(unitsLine());
    write(citiesLine());
  };

  const malformed = (detail: string, hint: string): LineOutcome => {
    write(`error: malformed command - ${detail}.\n  ${hint}\n`);
    return { kind: 'malformed', detail };
  };

  const unitsText = (): string => {
    const rows = visibleUnits();
    const hidden = state.units.length - rows.length;
    const lines = [
      `units: ${String(rows.length)} of ${String(state.units.length)} visible for ${playerLabel(state, playerId)}`,
    ];

    if (rows.length === 0) {
      lines.push('  you have no units, and none of another player is inside what you explored');
    } else {
      lines.push(
        tableRow(UNIT_WIDTHS, [
          'm',
          'id',
          'type',
          'owner',
          'at',
          'move',
          'terrain',
          'job',
          'legal',
        ]),
      );
      for (const unit of rows) {
        const def = unitDef(ruleset, unit.type);
        lines.push(
          tableRow(UNIT_WIDTHS, [
            unit.owner === playerId ? '*' : ' ',
            String(unit.id),
            def === undefined ? unit.type : def.name,
            playerName(state, unit.owner),
            coordOf(state.map, unit.tile),
            `${String(unit.movementLeft)}/${def === undefined ? '?' : String(def.movement)}`,
            terrainDefAt(state, ruleset, unit.tile)?.name ?? '?',
            // M4a: the job column, so the table answers "what is each of my units
            // doing?" without a second command. `(idle)` is the same spelling the
            // city table uses for "building nothing".
            workOf(ruleset, unit) ?? '(idle)',
            String(unitMoveOptions(state, ruleset, unit.id).length),
          ]),
        );
      }
    }

    if (hidden > 0) {
      lines.push(
        `  (+${String(hidden)} unit(s) of other players are outside your fog: ` +
          'explore to find them)',
      );
    }
    return `${lines.join('\n')}\n`;
  };

  const stateText = (): string => {
    const size = state.map.width * state.map.height;
    const explored = (state.explored[Number(playerId)] ?? []).filter((seen) => seen).length;
    const seeing = visibleTiles(state, playerId).length;
    const mine = state.units.filter((unit) => unit.owner === playerId).length;
    // The `civs:` line names civilizations, so it is `civPlayers`: the barbarian
    // player is a player identity (`PlayerId` is the index into `players`) but not
    // a civilization, and listing it here would contradict the count above.
    const civs = civPlayers(state)
      .map((player) => `${playerLabel(state, player.id)}${player.id === playerId ? ' <- you' : ''}`)
      .join(', ');

    // M4a: the jobs line. "What are my workers doing?" is the question the `state`
    // view exists to answer without a second command, so it is answered for the
    // session's own units — the ones the player can command — and never for
    // another player's, whose work is not this player's business even where the
    // tile is explored (the `units:` line under every view names *visible* units,
    // jobs included, which is where a scout report belongs).
    const working = state.units.filter(
      (unit) => unit.owner === playerId && unit.work !== undefined,
    );
    const jobs =
      working.length === 0
        ? 'none of your units is working (start one with "work <unitId> <improvementId>")'
        : working
            .map(
              (unit) =>
                `${String(unit.id)} ${typeName(ruleset, unit.type)}@` +
                `${coordOf(state.map, unit.tile)} ${workOf(ruleset, unit) ?? ''}`,
            )
            .join('  ');

    return (
      [
        `state: seed=${String(state.seed)} turn=${String(state.turn)} ` +
          `revision=${String(state.revision)} schema=${String(state.schemaVersion)} ` +
          `map=${state.settings.mapSize}(${String(state.map.width)}x` +
          `${String(state.map.height)}) civs=${String(civPlayers(state).length)}`,
        `you: ${String(mine)} unit(s), explored ${String(explored)}/${String(size)} tiles, ` +
          `${String(seeing)} visible right now`,
        `jobs: ${jobs}`,
        `civs: ${civs}`,
        `rng: a=${String(state.rng.a)} b=${String(state.rng.b)} c=${String(state.rng.c)} ` +
          `d=${String(state.rng.d)}`,
        `hash: ${hashValue(state)}`,
      ].join('\n') + '\n'
    );
  };

  const saveState = (path: string): LineOutcome => {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    const body = `${canonicalize({
      schemaVersion: state.schemaVersion,
      engine: 'civts',
      nodeMajor,
      state,
    })}\n`;

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, 'utf8');
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'unknown error';
      write(`error: save failed - ${detail}\n`);
      return { kind: 'io-error', detail };
    }

    write(
      `saved: ${path} (${String(Buffer.byteLength(body, 'utf8'))} bytes, ` +
        `state hash ${hashValue(state)})\n`,
    );
    return { kind: 'inspected', command: 'save' };
  };

  const applied = (command: Command): LineOutcome => {
    const result = applyCommand(state, playerId, command, ruleset);
    if (!result.ok) {
      write(`${formatGameError(result.error, context(unitIdOf(command), cityIdOf(command)))}\n`);
      return { kind: 'refused', command, error: result.error };
    }

    state = result.value.state;
    write(`${outcomeText(result.value, command, ruleset)}\n`);
    return { kind: 'applied', command, outcome: result.value };
  };

  const dispatch = (raw: string): LineOutcome => {
    const line = raw.trim();
    if (line === '') return { kind: 'ignored' };

    const tokens = line.split(/\s+/);
    const word = (tokens[0] ?? '').toLowerCase();
    const args = tokens.slice(1);

    switch (word) {
      case 'quit':
      case 'exit':
        write('bye - the state lives in memory only unless you ran "save <path>".\n');
        return { kind: 'quit' };

      case 'help':
        write(HELP);
        return { kind: 'inspected', command: word };

      case 'units':
        if (args.length > 0) {
          return malformed(`"units" takes no arguments (got "${args.join(' ')}")`, 'usage: units');
        }
        write(unitsText());
        return { kind: 'inspected', command: word };

      case 'state':
        if (args.length > 0) {
          return malformed(`"state" takes no arguments (got "${args.join(' ')}")`, 'usage: state');
        }
        write(stateText());
        return { kind: 'inspected', command: word };

      case 'end':
        if (args.length > 0) {
          return malformed(`"end" takes no arguments (got "${args.join(' ')}")`, 'usage: end');
        }
        return applied({ type: 'EndTurn' });

      /* ---------------- M3: founding, one city, the list ---------------- */

      case 'found': {
        if (args.length !== 1) {
          return malformed(
            `"found" needs 1 argument: found <unitId> (got ${String(args.length)})`,
            'example: found 0  ("units" lists your unit ids; founding consumes the settler)',
          );
        }
        const unitId = intOf(args[0]);
        if (unitId === undefined) {
          return malformed(
            `unit id must be a whole number (got "${args[0] ?? ''}")`,
            'example: found 0  ("units" lists your unit ids)',
          );
        }
        return applied({ type: 'FoundCity', unitId: asUnitId(unitId) });
      }

      case 'cities':
        if (args.length > 0) {
          return malformed(
            `"cities" takes no arguments (got "${args.join(' ')}")`,
            'usage: cities  (then "city <cityId>" shows one in full)',
          );
        }
        write(citiesTableText(state, ruleset, playerId, visibleCities()));
        return { kind: 'inspected', command: word };

      case 'city': {
        if (args.length !== 1) {
          return malformed(
            `"city" needs 1 argument: city <cityId> (got ${String(args.length)})`,
            'usage: city <cityId>  ("cities" lists your city ids)',
          );
        }
        const raw = args[0];
        const id = intOf(raw);
        if (id === undefined) {
          return malformed(
            `city id must be a whole number (got "${raw ?? ''}")`,
            'usage: city <cityId>  ("cities" lists your city ids)',
          );
        }

        const cityId = asCityId(id);
        const city = cityById(state, cityId);

        // An inspector is not a `Command`, so a city this session cannot show is
        // not a refusal by the engine — but it is still reported in the engine's
        // own vocabulary (`unknown-city`), with the same "your cities:" lesson,
        // so the prose and the typed error a `work`/`build` would give agree.
        if (city === undefined) {
          write(
            `${formatGameError({ kind: 'unknown-city', cityId }, context(undefined, cityId))}\n`,
          );
          return { kind: 'unknown-city', cityId };
        }
        if (!cityVisible(city)) {
          write(
            `error: unknown-city - city ${String(cityId)} is not one you can see: it is not ` +
              'yours, and it does not stand in what you have explored.\n' +
              `${yourCitiesLines(context(undefined, cityId)).join('\n')}\n`,
          );
          return { kind: 'unknown-city', cityId };
        }

        write(cityDetailText(state, ruleset, city));
        return { kind: 'inspected', command: word };
      }

      /* ---------------- M3: the two setters ---------------- */

      case 'work': {
        const cityRaw = args[0];
        if (cityRaw === undefined) {
          return malformed(
            '"work" needs a unit id and an improvement id, or a city id and x y pairs',
            'usage: work <unitId> <improvementId>  |  work <cityId> [<x> <y>]...',
          );
        }
        const cityId = intOf(cityRaw);
        if (cityId === undefined) {
          return malformed(
            `the id must be a whole number (got "${cityRaw}")`,
            'usage: work <unitId> <improvementId>  |  work <cityId> [<x> <y>]...',
          );
        }

        const rest = args.slice(1);

        // One word, two readings (M3's city tiles and M4a's worker jobs), told apart
        // by the *second* argument: a coordinate is a whole number, an improvement id
        // is a word. `work 0` and `work 0 1 1` stay the city form exactly as they
        // were; `work 0 mine` is the worker form — the only argument shape both
        // readings could claim is a lone word, and a city assignment can never be
        // one.
        const only = rest.length === 1 ? rest[0] : undefined;
        if (only !== undefined && intOf(only) === undefined) {
          return applied({
            type: 'StartWork',
            unitId: asUnitId(cityId),
            kind: asImprovementId(only),
          });
        }

        if (rest.length % 2 !== 0) {
          return malformed(
            `"work" takes either <unitId> <improvementId>, or a city id followed by whole ` +
              `x y pairs (got "${rest.join(' ')}" after "${cityRaw}")`,
            `usage: work ${cityRaw} <improvementId>  |  work ${cityRaw} <x> <y> ...`,
          );
        }

        const tiles: TileIndex[] = [];
        for (let i = 0; i < rest.length; i += 2) {
          const x = intOf(rest[i]);
          const y = intOf(rest[i + 1]);
          if (x === undefined || y === undefined) {
            return malformed(
              `x and y must be whole numbers (got "${rest[i] ?? ''}" and "${rest[i + 1] ?? ''}")` +
                ' - a lone word after a *unit* id is an improvement id, as in "work 2 mine"',
              'the ruler above the map lists the valid columns and rows',
            );
          }
          // Same reason `move` checks bounds here: `tileIndex` does not validate,
          // so an off-map coordinate would silently wrap onto another tile.
          if (!inBounds(state.map, x, y)) {
            return malformed(
              `(${String(x)},${String(y)}) is outside the map (` +
                `${String(state.map.width)}x${String(state.map.height)}): x must be ` +
                `0..${String(state.map.width - 1)} and y must be ` +
                `0..${String(state.map.height - 1)}`,
              'the ruler above the map lists the valid columns and rows',
            );
          }
          tiles.push(tileIndex(state.map.width, x, y));
        }

        return applied({ type: 'SetWorkedTiles', cityId: asCityId(cityId), tiles });
      }

      /* ---------------- M4a: the worker verbs ---------------- */

      case 'cancel': {
        if (args.length !== 1) {
          return malformed(
            `"cancel" needs 1 argument: cancel <unitId> (got ${String(args.length)})`,
            'example: cancel 2  ("units" lists your unit ids and what each is doing)',
          );
        }
        const unitId = intOf(args[0]);
        if (unitId === undefined) {
          return malformed(
            `unit id must be a whole number (got "${args[0] ?? ''}")`,
            'example: cancel 2  ("units" lists your unit ids)',
          );
        }
        return applied({ type: 'CancelWork', unitId: asUnitId(unitId) });
      }

      case 'build': {
        if (args.length !== 2) {
          return malformed(
            `"build" needs 2 arguments: build <cityId> <item> (got ${String(args.length)})`,
            'example: build 0 unit:warrior   or   build 0 building:granary',
          );
        }

        const cityRaw = args[0];
        const spec = args[1];
        const cityId = cityRaw === undefined ? undefined : intOf(cityRaw);
        if (cityId === undefined) {
          return malformed(
            `city id must be a whole number (got "${cityRaw ?? ''}")`,
            'usage: build <cityId> <unit|building>:<id>  ("cities" lists your city ids)',
          );
        }
        if (spec === undefined) {
          return malformed(
            '"build" needs an item after the city id',
            'example: build 0 unit:warrior   or   build 0 building:granary',
          );
        }

        const item = productionItemOf(ruleset, spec);
        if (!item.ok) {
          return malformed(item.error, buildCatalogueHint(ruleset));
        }

        return applied({ type: 'SetProduction', cityId: asCityId(cityId), item: item.value });
      }

      case 'save': {
        const path = args[0];
        if (args.length !== 1 || path === undefined) {
          return malformed(
            `"save" needs exactly one path (got ${String(args.length)} argument(s))`,
            'usage: save <path>  (a path cannot contain spaces)',
          );
        }
        return saveState(path);
      }

      case 'move': {
        if (args.length !== 3) {
          return malformed(
            `"move" needs 3 arguments: move <unitId> <x> <y> (got ` + `${String(args.length)})`,
            'example: move 0 12 9  ("units" lists your unit ids)',
          );
        }

        const unitId = intOf(args[0]);
        if (unitId === undefined) {
          return malformed(
            `unit id must be a whole number (got "${args[0] ?? ''}")`,
            'example: move 0 12 9  ("units" lists your unit ids)',
          );
        }

        const x = intOf(args[1]);
        const y = intOf(args[2]);
        if (x === undefined || y === undefined) {
          return malformed(
            `x and y must be whole numbers (got "${args[1] ?? ''}" and "${args[2] ?? ''}")`,
            'the ruler above the map lists the valid columns and rows',
          );
        }

        // Bounds are checked here, before a `Command` is built: `tileIndex` does
        // not validate (x=500 on a 60-wide map would silently become column 20),
        // so a coordinate that is off the map is an argument error, not a move.
        if (!inBounds(state.map, x, y)) {
          return malformed(
            `(${String(x)},${String(y)}) is outside the map (` +
              `${String(state.map.width)}x${String(state.map.height)}): x must be ` +
              `0..${String(state.map.width - 1)} and y must be ` +
              `0..${String(state.map.height - 1)}`,
            'the ruler above the map lists the valid columns and rows',
          );
        }

        return applied({
          type: 'MoveUnit',
          unitId: asUnitId(unitId),
          to: tileIndex(state.map.width, x, y),
        });
      }

      default:
        write(
          `error: unknown command "${word}" - no such command.\n` +
            `  commands: ${COMMAND_SUMMARY}\n` +
            '  type "help" for what each one does.\n',
        );
        return { kind: 'malformed', detail: `unknown command "${word}"` };
    }
  };

  write(bannerText(state, playerId, god));
  view();

  return {
    get state(): GameState {
      return state;
    },
    playerId,
    run: (line: string): LineOutcome => {
      const outcome = dispatch(line);
      // Every command refreshes the picture, so the agent always sees the board
      // it just changed. `quit` and empty input have nothing to show.
      if (outcome.kind !== 'ignored' && outcome.kind !== 'quit') view();
      return outcome;
    },
  };
};

/* ------------------------------------------------------------------ *
 * Driving a session: scripts (deterministic transcript) and terminals.
 * ------------------------------------------------------------------ */

/**
 * Feed a command file through a session, echoing each line as
 * `p0> <line>` so the transcript reads like a session a human watched.
 *
 * Blank lines are skipped entirely (no echo, no output). Processing stops at
 * `quit`, and end of input is a normal exit — the return value is the process
 * exit code, always 0, which is what makes `--script` safe in a pipeline.
 */
export const runScript = (
  session: ReplSession,
  scriptText: string,
  write: (text: string) => void,
): number => {
  const prompt = promptFor(session.playerId);

  for (const raw of scriptText.split('\n')) {
    // `trimEnd` folds a CRLF file down to LF, and keeps the echo free of
    // trailing whitespace.
    const line = raw.trimEnd();
    if (line.trim() === '') continue;

    write(`${prompt}${line}\n`);
    if (session.run(line).kind === 'quit') break;
  }

  return 0;
};

/** Read a command file, or explain why it could not be read. */
export const readScript = (path: string): Result<string, string> => {
  try {
    return ok(readFileSync(path, 'utf8'));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown error';
    return err(`cannot read script "${path}": ${detail}`);
  }
};

/**
 * Run a session against the terminal until end of input, always returning 0.
 *
 * In a real terminal readline owns the prompt and the echo (so typing behaves);
 * when stdin is a pipe or a file the session writes the prompt and the line
 * itself, so a piped run produces exactly the transcript `--script` produces.
 * End of input — Ctrl-D, a closed pipe, `/dev/null` — leaves the loop normally,
 * which is what "non-interactive-safe" means here.
 */
export const runInteractive = async (
  session: ReplSession,
  write: (text: string) => void,
): Promise<number> => {
  // `isTTY` is a plain boolean in `@types/node`; a pipe or a file is `false`.
  const interactive = process.stdin.isTTY;
  const prompt = promptFor(session.playerId);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    crlfDelay: Infinity,
  });

  try {
    if (interactive) {
      rl.setPrompt(prompt);
      rl.prompt();
    }

    for await (const line of rl) {
      if (!interactive) write(`${prompt}${line}\n`);
      if (session.run(line).kind === 'quit') break;
      if (interactive) rl.prompt();
    }
  } finally {
    rl.close();
  }

  if (interactive) write('\n');
  return 0;
};
