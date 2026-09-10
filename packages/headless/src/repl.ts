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
  applyCommand,
  asUnitId,
  buildingDef,
  citiesOf,
  cityById,
  civPlayers,
  describe,
  err,
  inBounds,
  indexToX,
  indexToY,
  isExplored,
  ok,
  terrainAtIndex,
  tileIndex,
  unitById,
  unitDef,
  unitMoveOptions,
  unitsOnTile,
  visibleTiles,
  type Command,
  type CommandOutcome,
  type BuildingId,
  type CityId,
  type GameError,
  type GameMap,
  type GameState,
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
  move <unitId> <x> <y>   end   units   state   save <path>   help   quit
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

const unitLabel = (state: GameState, ruleset: RulesetView, unitId: UnitId): string => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return `unit ${String(unitId)}`;
  const def = unitDef(ruleset, unit.type);
  const max = def === undefined ? '?' : `${String(def.movement)} per turn`;
  return (
    `unit ${String(unit.id)} (${typeName(ruleset, unit.type)} at ` +
    `${coordOf(state.map, unit.tile)}, ${String(unit.movementLeft)}/${max} movement left)`
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
    return (
      `${String(unit.id)} ${name} at ${coordOf(context.state.map, unit.tile)} ` +
      `(${String(unit.movementLeft)} movement left)`
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
        ...legalMovesLines(context),
      ].join('\n');

    case 'not-on-land': {
      const terrain = terrainDefAt(context.state, context.ruleset, error.tile);
      const what = terrain === undefined ? 'not land' : `"${terrain.name}" (water)`;
      return [
        `error: not-on-land - a city can only be founded on land, and ` +
          `(${coordOf(context.state.map, error.tile)}) is ${what}.`,
        ...legalMovesLines(context),
      ].join('\n');
    }

    case 'city-too-close':
      return [
        `error: city-too-close - (${coordOf(context.state.map, error.tile)}) is ` +
          `${String(error.distance)} tile(s) from ${cityLabel(context.state, error.cityId)}, and ` +
          `cities must be at least ${String(error.minDistance)} apart (counting diagonals).`,
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
        ].join('\n');
      }
      return [
        `error: tile-not-workable - ${where} is not inside the working radius of ` +
          `${cityLabel(context.state, error.cityId)}.`,
        '  a city works the tiles within two of its centre (the four corners excepted), and only',
        '  tiles that are on the map: a tile at or past an edge has no yields to assign.',
      ].join('\n');
    }

    case 'tile-worked-by-another-city':
      return [
        `error: tile-worked-by-another-city - ` +
          `(${coordOf(context.state.map, error.tile)}) is already worked by ` +
          `${cityLabel(context.state, error.byCityId)}.`,
        '  a tile may be worked by only one city, of any owner, at a time.',
      ].join('\n');

    case 'duplicate-worked-tile':
      return [
        `error: duplicate-worked-tile - (${coordOf(context.state.map, error.tile)}) is listed ` +
          `twice for ${cityLabel(context.state, error.cityId)}.`,
        '  one citizen works one tile, so a repeated tile would spend two citizens on one job.',
      ].join('\n');

    case 'too-many-worked-tiles':
      return [
        `error: too-many-worked-tiles - ${cityLabel(context.state, error.cityId)} has ` +
          `${String(error.allowed)} citizen(s) and can work at most ${String(error.allowed)} ` +
          `tile(s), but ${String(error.requested)} were given.`,
        '  the whole request is refused rather than truncated: an assignment longer than the',
        '  citizen count is a mistake, and a shorter one is what you meant to send.',
      ].join('\n');

    case 'unknown-production-item':
      return [
        `error: unknown-production-item - this ruleset cannot build ` +
          `${itemLabel(context.ruleset, error.item)}.`,
        '  an item is buildable when its catalog row exists and its cost is a whole number of',
        '  shields greater than zero. "state" shows the hash; the ruleset is @civts/rules.',
      ].join('\n');

    case 'already-built':
      return [
        `error: already-built - ${cityLabel(context.state, error.cityId)} already has ` +
          `${buildingLabel(context.ruleset, error.building)}.`,
        '  each building is built once per city; building it again is refused rather than',
        '  quietly ignored, so a queue cannot silently waste shields on a duplicate.',
      ].join('\n');

    case 'invalid-argument':
      return [`error: invalid-argument - ${error.detail}`, ...legalMovesLines(context)].join('\n');
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
 * The session.
 * ------------------------------------------------------------------ */

/** What one input line did. Returned as well as printed, so tests need not scrape text. */
export type LineOutcome =
  | { readonly kind: 'applied'; readonly command: Command; readonly outcome: CommandOutcome }
  | { readonly kind: 'refused'; readonly command: Command; readonly error: GameError }
  | { readonly kind: 'inspected'; readonly command: string }
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

const COMMAND_SUMMARY = 'move <unitId> <x> <y> | end | units | state | save <path> | help | quit';

const HELP = `commands:
  move <unitId> <x> <y>   step one unit onto an adjacent tile (8-way). The cost is the
                          destination tile's move cost, paid from that unit's movement.
  end                     end the turn: every unit refills its movement, turn advances.
  units                   list the units you can see, with position and movement left.
  state                   print seed, turn, revision, map size, RNG and the state hash.
  save <path>             write the state to <path> as canonical JSON (parent
                          directories are created).
  help                    print this text.
  quit                    leave the game (alias: exit). End of input also quits, with
                          status 0, so scripted and piped runs are safe.

notes:
  - coordinates are x,y as ruled above the map: x is the column, y is the row.
  - a digit drawn on the map is that player's STARTING tile. Live unit positions are the
    "units:" line printed under every view ("*" marks a unit of yours).
  - a refused command prints the typed reason and the moves that were legal, and never
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

/** One-line reaction to an applied command, derived from its events. */
const outcomeText = (outcome: CommandOutcome): string => {
  const lines = outcome.events.map((event) => {
    switch (event.type) {
      case 'UnitMoved':
        return (
          `ok: unit ${String(event.unitId)} moved to ` +
          `(${coordOf(outcome.state.map, event.to)}), cost ${String(event.cost)}, ` +
          `${String(event.movementLeft)} movement left`
        );
      case 'TurnEnded':
        return `ok: turn ${String(event.turn)} begins; every unit refilled its movement`;
    }
  });
  const revision = `revision ${String(outcome.state.revision)}`;
  return lines.length === 0 ? `ok: ${revision}` : `${lines.join('\n')}\n  ${revision}`;
};

/** Column widths for the `units` table: marker, id, type, owner, at, move, terrain. */
const UNIT_WIDTHS: readonly number[] = [1, 2, 10, 11, 8, 7, 11];

const tableRow = (cells: readonly string[]): string =>
  cells
    .map((cell, index) =>
      index === cells.length - 1 ? cell : cell.padEnd(UNIT_WIDTHS[index] ?? 0),
    )
    .join('  ');

export const createSession = (options: SessionOptions): ReplSession => {
  const { ruleset, playerId, god, write } = options;
  let state = options.state;

  const context = (unitId: UnitId | undefined): ErrorContext => ({
    state,
    ruleset,
    playerId,
    unitId,
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
      return (
        `${unit.owner === playerId ? '*' : ' '}${String(unit.id)} p${String(unit.owner)} ` +
        `${name} @${coordOf(state.map, unit.tile)} ` +
        `(${String(unit.movementLeft)}/${max} movement)`
      );
    });
    return `units: ${parts.join('  ')}\n`;
  };

  const view = (): void => {
    write(god ? describe(state, ruleset) : describe(state, ruleset, { viewer: playerId }));
    write(unitsLine());
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
      lines.push(tableRow(['m', 'id', 'type', 'owner', 'at', 'move', 'terrain', 'legal']));
      for (const unit of rows) {
        const def = unitDef(ruleset, unit.type);
        lines.push(
          tableRow([
            unit.owner === playerId ? '*' : ' ',
            String(unit.id),
            def === undefined ? unit.type : def.name,
            playerName(state, unit.owner),
            coordOf(state.map, unit.tile),
            `${String(unit.movementLeft)}/${def === undefined ? '?' : String(def.movement)}`,
            terrainDefAt(state, ruleset, unit.tile)?.name ?? '?',
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

    return (
      [
        `state: seed=${String(state.seed)} turn=${String(state.turn)} ` +
          `revision=${String(state.revision)} schema=${String(state.schemaVersion)} ` +
          `map=${state.settings.mapSize}(${String(state.map.width)}x` +
          `${String(state.map.height)}) civs=${String(civPlayers(state).length)}`,
        `you: ${String(mine)} unit(s), explored ${String(explored)}/${String(size)} tiles, ` +
          `${String(seeing)} visible right now`,
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
      const unitId = command.type === 'MoveUnit' ? command.unitId : undefined;
      write(`${formatGameError(result.error, context(unitId))}\n`);
      return { kind: 'refused', command, error: result.error };
    }

    state = result.value.state;
    write(`${outcomeText(result.value)}\n`);
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
