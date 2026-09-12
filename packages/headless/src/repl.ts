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
 *   `planSetProduction`, `itemCostOf`, `cityRadius`, `cityGrowthTarget` — the same
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
 * - **The economy is shown whether or not the reader asked** (M4b). `rates <tax>
 *   <science> <luxury>` is the sixth verb: it parses three integers, builds one
 *   `SetRates`, and hands it to `applyCommand` — the rate rule itself lives in
 *   `economy.ts`' `ratesProblem`, and the "legal:" line under a refusal is built
 *   by *asking* `planSetRates`, the same evaluator the applier decides with. Money
 *   then travels with the reader everywhere it is needed: the banner states the
 *   starting position, an `economy:` line is printed under **every** view (the
 *   money loop changes something every single turn, so a figure the agent has to
 *   ask for is a figure it will notice only after it has already gone bankrupt),
 *   and `state` prints the full ledger with the engine's own projection of the
 *   next collection. Every number is read from the state or computed by an engine
 *   function — `playerIncome`, `playerUpkeep`, `unitSupport` — never re-derived
 *   here.
 * - **One channel is inert, and it is named where it is printed (M5).** M4b said
 *   out loud that *both* beakers and luxuries did nothing, because nothing read
 *   them: research was M5 and happiness is M9. **Half of that sentence is now
 *   false.** Beakers buy tech, so every place they are printed says what they do
 *   and what they are banked toward; luxuries still do nothing, so
 *   `LUXURY_CAVEAT` is quoted, unchanged and from one constant, wherever they
 *   appear. Leaving the old wording in one of those places would be exactly the
 *   doc drift that made M4c's growth-food hole invisible: prose asserting a limit
 *   the engine no longer has.
 * - **The research surface (M5) is the same arrangement once more, and the first one
 *   with a *tree* in it.** `research <techId>` parses one word,
 *   builds one `SetResearch` and hands it to `applyCommand`; `tech` prints the
 *   tree — what is known, what is available now, what each costs, and for every
 *   tech that is not available, the reason, as the engine's own typed answer
 *   (`planSetResearch`, the same evaluator `applyCommand` refuses with). Nothing
 *   here re-decides whether a tech may be researched, and the tree is never
 *   filtered into a "menu of legal research" that could disagree with the
 *   refusals: the blocked rows are printed *with* their reason, which is the
 *   whole point of the view. The current research (tech, pool, cost, progress)
 *   travels with the reader the way money does — a `research:` line under every
 *   view and in the banner — because the pool is spent on the turn it is filled
 *   and a figure the agent has to ask for is one it notices too late. That line
 *   is `researchStep`, the pipeline's own read of the player, so a view cannot
 *   predict a completion the pipeline would not make.
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
  RATE_TOTAL,
  applyCommand,
  asBuildingId,
  asCityId,
  asImprovementId,
  asTechId,
  asUnitId,
  asUnitTypeId,
  buildingCatalog,
  buildingDef,
  citiesOf,
  cityById,
  cityGrowthTarget,
  cityMaintenance,
  cityProductionOptions,
  cityRadius,
  cityYields,
  civPlayers,
  combatRulesOf,
  connected,
  defenderBonusPct,
  describe,
  err,
  foodBoxSize,
  hitPointsLabel,
  improvementCatalog,
  improvementDef,
  inBounds,
  indexToX,
  indexToY,
  isExplored,
  isFortified,
  isWonder,
  itemCostOf,
  knownTechs,
  maintenanceOf,
  neighbors8,
  ok,
  planAttackUnit,
  planFoundCity,
  planSetProduction,
  planSetRates,
  planSetResearch,
  planSetWorkedTiles,
  planStartWork,
  playerIncome,
  playerUpkeep,
  prerequisitesOf,
  productionGate,
  researchingOf,
  researchStep,
  resourceDef,
  techCatalog,
  techCostOf,
  techDef,
  terrainAtIndex,
  terrainDefenseBonus,
  tileIndex,
  unitById,
  unitCatalog,
  unitDef,
  unitMoveOptions,
  unitsOnTile,
  unitSupport,
  unmetTechFor,
  visibleTiles,
  WALLS_BUILDING,
  workSummary,
  type CombatDef,
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
  type PlayerState,
  type ProductionItem,
  type Rates,
  type ResearchProblem,
  type ResearchStep,
  type ResourceId,
  type Result,
  type RulesetView,
  type SetupError,
  type TechDef,
  type TechId,
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
  move <unitId> <x> <y>      attack <unitId> <x> <y>     fortify <unitId>
  found <unitId>      cities      city <cityId>
  work <cityId> <x> <y> ...  build <cityId> <unit|building>:<id>
  work <unitId> <improve>    cancel <unitId>
  rates <tax> <science> <luxury>
  research <techId>          tech
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
  /**
   * The rates a refused `SetRates` asked for, when the refused command was one
   * (`undefined` otherwise). The only error kind that needs it is
   * `invalid-argument`, whose detail is the engine's own sentence: with the asked
   * triple in hand the formatter can add the part a caller actually needs — what
   * a *legal* triple looks like, checked against `planSetRates` rather than
   * asserted here.
   */
  readonly rates: Rates | undefined;
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

/**
 * A unit's hit points as this file prints them: `2/3 hp` (M6).
 *
 * `@civts/core`'s `hitPointsLabel` is the *one* spelling of that figure — the same
 * function `textview` puts on its `work:` line — so the REPL does not own a second
 * mapping from a hit point count to prose, exactly as `workOf` above does not own a
 * second mapping from a job to a verb. The maximum is therefore asked of the unit's
 * own type in one place, `maxHitPointsOf`' fallback included: a type this ruleset
 * cannot describe renders the unit's own count rather than an invented `?`.
 *
 * This is the figure that makes a damaged unit *visible as damaged* in all four places
 * this file names units: the `units:` line under every view, the `units` table, the
 * `state` view's `your units:` line and the prose of a refusal about one.
 */
const unitHitPoints = (ruleset: RulesetView, unit: Unit): string =>
  hitPointsLabel(unit, unitDef(ruleset, unit.type));

/**
 * What a city's tile gives a **defender standing in it**, as one line (M6) — the
 * answer to "how hard is this city to take?", which is a question about the
 * *modifiers* the engine will sum.
 *
 * Every figure is read from `combat.ts` **through the ruleset**: `terrainDefenseBonus` for
 * the terrain part and `defenderBonusPct` for the sum (terrain + the ruleset's
 * `cityDefenseBonusPct` + its `wallsBonusPct` when the city holds `WALLS_BUILDING`), so
 * the number a player reads here is the number the applier will put into a battle — it
 * cannot drift from the resolver, because no arithmetic is repeated here.
 * `defenderBonusPct` is handed `fortified: false` on purpose: whether the defender is dug
 * in is a fact about *that unit*, not about this city, and the line says so rather than
 * assuming one.
 *
 * **The three bonuses and the fortify figure come from `combatRulesOf(ruleset)`**, which
 * is the same reader `commands.ts` asks before it resolves a battle (M6b): before that
 * wave they were constants exported by `combat.ts`, and a screen that restated them would
 * have gone on printing the old numbers after a balance sweep moved them. Reading them
 * here means this line reports the game being played, not the game that was compiled.
 *
 * **The line also has to say what the city does NOT have**, because the honest answer to
 * "what defends this city?" is "a unit, and nothing else": an undefended city is
 * captured outright by `AttackUnit` — there is no city-versus-unit combat in M6 — so a
 * view that printed a health bar or a defence strength for the city itself would be
 * describing a mechanic the engine does not have.
 */
const cityDefenceLine = (state: GameState, ruleset: RulesetView, city: City): string => {
  const rules = combatRulesOf(ruleset);
  const terrain = terrainDefenseBonus(terrainDefAt(state, ruleset, city.tile) ?? {});
  const walls = city.buildings.includes(WALLS_BUILDING);
  const total = defenderBonusPct(rules, {
    terrainBonusPct: terrain,
    fortified: false,
    inCity: true,
    walls,
  });

  const parts = [`terrain +${String(terrain)}%`, `city +${String(rules.cityDefenseBonusPct)}%`];
  parts.push(
    walls
      ? `walls +${String(rules.wallsBonusPct)}% (it holds defensive walls)`
      : `walls +0% (no "${String(WALLS_BUILDING)}" building here, so no wall bonus)`,
  );
  return (
    `  defence: +${String(total)}% to a unit defending this tile (${parts.join(', ')}), plus ` +
    `+${String(rules.fortifyBonusPct)}% if that unit is fortified. ` +
    'The city has no defence of its own: an undefended city is captured outright, so what ' +
    'defends it is a unit standing here.'
  );
};

/** An improvement as prose, with what it costs: `improvement "Mine" (3 turns)`. */
const improvementLabel = (ruleset: RulesetView, id: ImprovementId): string => {
  const def = improvementDef(ruleset, id);
  return def === undefined
    ? `improvement "${id}"`
    : `improvement "${def.name}" (${String(def.turns)} turn${def.turns === 1 ? '' : 's'})`;
};

/**
 * A resource as prose: its catalog **name**, or the raw id when this ruleset cannot
 * name it (M4c).
 *
 * The name is what a reader acts on — "it requires Iron" is the sentence that makes
 * a refused build legible — and the raw id is the fallback for a hand-built view
 * whose resource catalog does not describe what the state's map carries, the same
 * "read what is there" rule `improvementLabel` and `buildingLabel` follow. Unlike
 * those two there is no command argument to spell: nothing in the command language
 * takes a resource id, so printing "Iron (iron)" would be noise rather than a hint.
 */
const resourceLabel = (ruleset: RulesetView, id: ResourceId): string =>
  resourceDef(ruleset, id)?.name ?? id;

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

/**
 * A unit as prose, for a refusal about it: its id, type, position, remaining movement,
 * its hit points (M6) and what it is doing.
 *
 * Every field is a fact the engine holds, and the hit points are `units.ts`' own read of
 * them through `hitPointsLabel` — a damaged unit must be visible as damaged *wherever* it
 * is named, and a refusal that said "unit 3 (Warrior at 2,3 …)" about a unit one hit from
 * death would be hiding the one number that decides whether attacking is a good idea.
 */
const unitLabel = (state: GameState, ruleset: RulesetView, unitId: UnitId): string => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return `unit ${String(unitId)}`;
  const def = unitDef(ruleset, unit.type);
  const max = def === undefined ? '?' : `${String(def.movement)} per turn`;
  const job = workOf(ruleset, unit);
  return (
    `unit ${String(unit.id)} (${typeName(ruleset, unit.type)} at ` +
    `${coordOf(state.map, unit.tile)}, ${String(unit.movementLeft)}/${max} movement left, ` +
    unitHitPoints(ruleset, unit) +
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
      `(${String(unit.movementLeft)} movement left, ${unitHitPoints(context.ruleset, unit)}` +
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
 * with, and `cityRadius`/`cityGrowthTarget`/`itemCostOf` are the engine's
 * own statements of the radius, the next-citizen threshold and an item's
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
 * The adjacent tiles `unitId` may attack right now (M6) — **asked of the engine's own
 * `planAttackUnit`**, the same evaluator `applyCommand` refuses with and the same
 * generator `actions.ts` advertises from.
 *
 * That is the whole point of the function: the "legal:" lesson under a refused `attack`
 * must not be a second opinion about what may be attacked. An enemy unit on a tile, an
 * undefended enemy city, a stack of two enemies (refused as `target-stacked`) and a
 * friendly-occupied tile (nothing to attack) are each classified by the applier's own
 * planner, so every target this function prints is a command the engine would accept.
 *
 * `neighbors8` is the engine's own adjacency — a unit attacks what it stands beside —
 * never a second reading of "adjacent", and it never returns an off-map tile.
 */
const attackTargets = (context: ErrorContext, unitId: UnitId): readonly TileIndex[] => {
  const unit = unitById(context.state, unitId);
  if (unit === undefined) return [];
  return neighbors8(context.state.map, unit.tile).filter(
    (tile) => planAttackUnit(context.state, context.ruleset, context.playerId, unitId, tile).ok,
  );
};

/** The lesson behind a refused `attack`: what that unit *can* reach instead. */
const legalAttackLines = (context: ErrorContext, unitId: UnitId): readonly string[] => {
  const targets = attackTargets(context, unitId);
  const label = unitLabel(context.state, context.ruleset, unitId);
  if (targets.length === 0) {
    return [
      `  legal: ${label} has nothing it can attack this turn - an attack needs an adjacent`,
      '  tile holding exactly one enemy unit or an undefended enemy city, and movement left',
      '  to spend ("end" refills movement).',
    ];
  }
  return [
    `  legal: ${label} can attack ${tileList(context.state.map, targets, '(none)')} - each is ` +
      'adjacent and holds one enemy unit or an undefended enemy city.',
  ];
};

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
 * Every item `cityId` may be set to build — **the engine's own menu**, not a list
 * this file derived.
 *
 * `cityProductionOptions` is `planSetProduction` *and* `productionGate` asked once per
 * catalog row (`actions.ts` says why: the gate is what the production pass asks when
 * the item comes up, so a menu built without it would advertise a build the city can
 * never finish). Asking that one function rather than repeating its conjuncts here is
 * the point: M5 added the *tech* dimension to the gate, and a second copy of the rule
 * in this file would have gone on offering tech-gated units as if the milestone had
 * not happened. The same function is what the city view's own build list uses, so the
 * lesson under a refusal and the `city` view cannot disagree either.
 */
const buildableItems = (
  state: GameState,
  ruleset: RulesetView,
  cityId: CityId,
): readonly ProductionItem[] => cityProductionOptions(state, ruleset, cityId);

/**
 * The items this city's owner may *not* build for want of a technology (M5), with the
 * tech each one waits on.
 *
 * A reading of the **planner's own typed refusal** — `planSetProduction` returns
 * `tech-required` naming the tech, because it asks `productionGate` — rather than a
 * second application of the gate. That is the strongest form of the one-rule rule this
 * file follows everywhere else: the lesson and the refusal are the same verdict, so
 * the list cannot name a tech the engine would not name, and it cannot go on naming one
 * after the gate opens.
 *
 * **Migrated when the wiring landed.** This function used to ask `productionGate`
 * directly, because `planSetProduction` did not ask it yet: a `build` of a tech-gated
 * item was *accepted* by the engine and the city banked shields forever, so the note was
 * the only thing telling a player why nothing arrived. Now the applier refuses that
 * order outright (with `tech-required`), and the note is a lesson under somebody else's
 * refusal — "what am I *not* allowed to build here, and why".
 */
const techLockedItems = (
  state: GameState,
  ruleset: RulesetView,
  city: City,
): readonly { readonly item: ProductionItem; readonly tech: TechId }[] => {
  const candidates: readonly ProductionItem[] = [
    ...unitCatalog(ruleset).map((def): ProductionItem => ({ kind: 'unit', id: def.id })),
    ...buildingCatalog(ruleset).map((def): ProductionItem => ({ kind: 'building', id: def.id })),
  ];

  return candidates.flatMap((item) => {
    const planned = planSetProduction(state, ruleset, city.owner, city.id, item);
    if (planned.ok) return [];
    return planned.error.kind === 'tech-required' ? [{ item, tech: planned.error.tech }] : [];
  });
};

/** The note that has to travel with a `build` the tech gate refuses (see `techLockedItems`). */
const itemTechNote = (
  state: GameState,
  ruleset: RulesetView,
  city: City | undefined,
  item: ProductionItem,
): string => {
  if (city === undefined) return '';
  const gate = productionGate(state, ruleset, city.owner, item);
  if (gate.kind !== 'tech-required') return '';
  return (
    ` - NOTE: this item needs ${techLabel(ruleset, gate.tech)}, which ` +
    `${playerLabel(state, city.owner)} has not researched, so the city will bank shields ` +
    `and not finish it until you "research ${gate.tech}"`
  );
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

  const items = buildableItems(context.state, context.ruleset, city.id);
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

  // M5: what the tech gate is holding back, named one item at a time — the same
  // `productionGate` verdict the production pass will ask, so this line cannot
  // advertise an item as merely "later" when nothing will ever finish it.
  const locked = techLockedItems(context.state, context.ruleset, city);
  const lockedLines =
    locked.length === 0
      ? []
      : [
          `  legal: locked behind a tech you have not researched: ${locked
            .map(
              ({ item, tech }) =>
                `${itemLabel(context.ruleset, item)} needs ${techLabel(context.ruleset, tech)} ` +
                `("research ${tech}")`,
            )
            .join('; ')}.`,
        ];

  return [
    `  legal: ${cityLabel(context.state, city.id)} may be set to build ${inventory}`,
    ...lockedLines,
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
    (def) =>
      planStartWork(context.state, context.ruleset, context.playerId, unitId, def.id).ok &&
      // M5: `planStartWork` now asks the tech gate itself (`improvement-tech-required`),
      // so this conjunct is a **no-op by construction** — it is kept as the belt to that
      // brace, and it is deliberately the engine's own statement of the tech dimension
      // (`unmetTechFor`) rather than a second reading here. The locked rows are not
      // dropped silently either way: `startableLines` names every one of them, with the
      // tech and the command that unlocks it.
      unmetTechFor(context.state, context.playerId, def) === undefined,
  );

/** What one unit could start right now, as the lesson under a refusal about it. */
const startableLines = (context: ErrorContext, unitId: UnitId | undefined): readonly string[] => {
  if (unitId === undefined) return [];

  const ready = startableImprovements(context, unitId);
  // M5: the improvements this ruleset defines but the actor cannot start *anywhere*
  // for want of a tech, named with the command that unlocks them. `unmetTechFor` is
  // the engine's own gate (the one `resources.ts` states for all four catalog kinds),
  // so this line cannot invent a requirement.
  const locked = improvementCatalog(context.ruleset).flatMap((def) => {
    const tech = unmetTechFor(context.state, context.playerId, def);
    return tech === undefined ? [] : [{ def, tech }];
  });
  const lockedLine =
    locked.length === 0
      ? []
      : [
          `  legal: locked behind a tech for you: ${locked
            .map(
              ({ def, tech }) =>
                `${improvementLabel(context.ruleset, def.id)} needs ` +
                `${techLabel(context.ruleset, tech)} ("research ${tech}")`,
            )
            .join('; ')}.`,
        ];

  if (ready.length === 0) {
    return [
      '  legal: that unit can start no job where it stands right now: a worker must be idle,',
      '  have movement left, and stand where this ruleset allows the improvement.',
      ...lockedLine,
    ];
  }
  return [
    `  legal: ${unitLabel(context.state, context.ruleset, unitId)} can start ` +
      `${ready.map((def) => improvementLabel(context.ruleset, def.id)).join(', ')}.`,
    ...lockedLine,
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
 * M5 - the tech tree as the reader meets it.
 *
 * The tree is *content*, not a menu of legal actions, so the `tech` view
 * prints every row — known, available and blocked — and the blocked ones
 * carry the engine's own typed reason (`planSetResearch`, the evaluator
 * `applyCommand` refuses with). A view that showed only what may be
 * researched today would hide the prerequisites, which is the one thing a
 * player planning two moves ahead needs to see.
 *
 * The "legal:" lines under a refused `research` are built the same way as
 * every other lesson in this file: by *asking* the engine's planner, one
 * candidate at a time, never by restating `tech.ts`' rule here.
 * ------------------------------------------------------------------ */

/** `"Pottery" (pottery)` — the catalog's name, and the id a command spells. */
const techLabel = (ruleset: RulesetView, id: TechId): string => {
  const def = techDef(ruleset, id);
  return def === undefined ? `"${id}"` : `"${def.name}" (${id})`;
};

/**
 * `requires pottery, bronze-working`, or `no prerequisites` — a tech's own rows, in
 * the order the ruleset states them, **by id**.
 *
 * Ids rather than display names because every one of them is selectable with
 * `research <techId>` and every row of the tree already leads with its own name, so a
 * name here would be a third spelling of the same row (the row's `name`, its `id`, and
 * the prerequisite's `name`) with nothing added. The *reason* lines below the blocked
 * rows spell the names out, which is where a reader needs them.
 *
 * `prerequisitesOf` is the engine's read of the edge, so a view cannot print a
 * prerequisite the research rule does not enforce.
 */
const prerequisitesLabel = (ruleset: RulesetView, id: TechId): string => {
  const required = prerequisitesOf(ruleset, id);
  if (required.length === 0) return 'no prerequisites';
  return `requires ${required.join(', ')}`;
};

/** `7 beakers`, or the honest answer for a row the engine cannot price. */
const techPriceLabel = (ruleset: RulesetView, id: TechId): string => {
  const cost = techCostOf(ruleset, id);
  return cost === undefined ? 'no usable beaker cost in this ruleset' : `${String(cost)} beakers`;
};

/** `cost 7 beakers` — the same figure, in the form a candidate line wants it. */
const techCostLabel = (ruleset: RulesetView, id: TechId): string =>
  techCostOf(ruleset, id) === undefined
    ? 'no usable beaker cost in this ruleset'
    : `cost ${techPriceLabel(ruleset, id)}`;

/**
 * The techs `playerId` may start researching right now, asked of
 * `planSetResearch` one catalog row at a time — the same evaluator the applier
 * refuses with, so this list cannot advertise a tech the engine would reject, and
 * it excludes a tech already known without this file having an opinion about what
 * "known" means.
 */
const researchableTechs = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly TechDef[] =>
  techCatalog(ruleset).filter((def) => planSetResearch(state, ruleset, playerId, def.id).ok);

/** One tech as a candidate: `"Pottery" (pottery), cost 5 beakers`. */
const researchableLabel = (ruleset: RulesetView, id: TechId): string =>
  `${techLabel(ruleset, id)}, ${techCostLabel(ruleset, id)}`;

/**
 * The lesson behind a refused `research`: what the actor could research instead,
 * or — when nothing is researchable — the rule that is stopping it.
 */
const legalResearchLines = (context: ErrorContext): readonly string[] => {
  const ready = researchableTechs(context.state, context.ruleset, context.playerId);
  if (ready.length === 0) {
    return [
      '  legal: no tech in this ruleset can be started by you right now - every row is either',
      '  already known to you or still waiting on its own prerequisites.',
    ];
  }
  return [
    '  legal: researchable now: ' +
      ready.map((def) => researchableLabel(context.ruleset, def.id)).join('; ') +
      '.',
    '  legal: "research <techId>" chooses one; "tech" prints the whole tree, including what is',
    '  blocked and by which prerequisite.',
  ];
};

/**
 * The `tech` verb: the whole tree, grouped by what it means to the actor.
 *
 * Three groups, and every row in exactly one of them, because that is what makes
 * the view answer the question a player actually has — *what can I do now, and what
 * is in my way?* The grouping is the planner's verdict (`planSetResearch`) plus the
 * player's own `techs` list, so a row cannot appear as available here and be refused
 * by `research` there: one evaluator, asked once per row.
 *
 * The reasons printed under `blocked` are the engine's own error kinds, named in the
 * engine's own vocabulary, with the fix spelled out — "research <prerequisite>
 * first" — rather than a second opinion about the tree.
 */
const techReport = (state: GameState, ruleset: RulesetView, playerId: PlayerId): string => {
  const player = playerStateOf(state, playerId);
  const catalog = techCatalog(ruleset);
  const known = player === undefined ? [] : knownTechs(player);
  const knownSet = new Set<string>(known);
  const selected = player === undefined ? undefined : researchingOf(player);

  const knownRows: TechDef[] = [];
  const available: TechDef[] = [];
  const blocked: { readonly def: TechDef; readonly reason: string }[] = [];

  for (const def of catalog) {
    if (knownSet.has(def.id)) {
      knownRows.push(def);
      continue;
    }
    const plan = planSetResearch(state, ruleset, playerId, def.id);
    if (plan.ok) {
      available.push(def);
      continue;
    }
    blocked.push({ def, reason: researchRefusalReason(ruleset, plan.error) });
  }

  const lines: string[] = [
    `tech: ${String(catalog.length)} tech(s) in this ruleset; ${playerLabel(state, playerId)} knows ` +
      `${String(known.length)} of them`,
    researchStanding(state, ruleset, playerId),
  ];

  const row = (def: TechDef): string =>
    `  ${def.id} "${def.name}" (${def.era}, ${techPriceLabel(ruleset, def.id)}, ` +
    `${prerequisitesLabel(ruleset, def.id)})`;

  lines.push(
    knownRows.length === 0
      ? 'known (0): none yet - every tech in this ruleset is still ahead of you'
      : `known (${String(knownRows.length)}):`,
    ...knownRows.map(row),
  );
  lines.push(
    available.length === 0
      ? 'available now (0): nothing can be started right now'
      : `available now (${String(available.length)}):`,
    ...available.map((def) => `${row(def)}${selected === def.id ? ' <- researching' : ''}`),
  );
  lines.push(
    blocked.length === 0 ? 'blocked (0): nothing' : `blocked (${String(blocked.length)}):`,
    ...blocked.map(({ def, reason }) => `${row(def)} - ${reason}`),
  );

  return lines.join('\n');
};

/**
 * The three ways a tech is not researchable, each as **one clause naming what the
 * player has to act on** — shared by the tree's blocked rows and by the prose under a
 * refused `research` line, so the two surfaces cannot describe one refusal
 * differently. A blocked row that said only "not available" would be a refusal with
 * the reason filed off.
 */
const unknownTechReason = (id: TechId): string =>
  `this ruleset cannot research "${id}": no row defines it, or its cost is not a whole number of beakers`;

const alreadyKnownReason = (ruleset: RulesetView, id: TechId): string =>
  `you already know ${techLabel(ruleset, id)}`;

const unmetPrerequisitesReason = (ruleset: RulesetView, missing: readonly TechId[]): string => {
  const first = missing[0];
  const fix = first === undefined ? '"tech" prints the tree' : `"research ${first}" comes first`;
  return (
    `needs ${missing.map((id) => techLabel(ruleset, id)).join(', ')}, which you do not ` +
    `know yet (${fix})`
  );
};

/**
 * A `SetResearch` refusal, in one clause, from the engine's typed `GameError`.
 *
 * `planSetResearch` maps `tech.ts`' `researchProblem` onto exactly the three kinds
 * below plus `unknown-player`, and this function is only ever handed its answer, so
 * the final branch is unreachable: it names the error instead of inventing a lesson
 * for it, which keeps a future member printing something true rather than throwing.
 * Written as guards rather than a `switch` so it stays a *prose* mapper and not a
 * second exhaustive reading of the `GameError` union (that one is `formatGameError`).
 */
const researchRefusalReason = (ruleset: RulesetView, error: GameError): string => {
  if (error.kind === 'unknown-tech') return unknownTechReason(error.tech);
  if (error.kind === 'tech-already-known') return alreadyKnownReason(ruleset, error.tech);
  if (error.kind === 'tech-prerequisites-unmet') {
    return unmetPrerequisitesReason(ruleset, error.missing);
  }
  return `refused: ${error.kind}`;
};

/** The same three situations, as `researchStep` reports them on the pipeline's behalf. */
const researchProblemReason = (ruleset: RulesetView, problem: ResearchProblem): string => {
  if (problem.kind === 'unknown-tech') return unknownTechReason(problem.tech);
  if (problem.kind === 'already-known') return alreadyKnownReason(ruleset, problem.tech);
  if (problem.kind === 'unmet-prerequisite') {
    return unmetPrerequisitesReason(ruleset, problem.missing);
  }
  return 'nothing is being researched';
};

/**
 * What the acting player is researching, in one line — **the pipeline's own read of
 * the state** (`researchStep`), so the view and the turn agree about whether the pool
 * covers the cost, and a completion cannot be predicted here that step 4 would not
 * make.
 *
 * Every member of `ResearchStep` is a situation a reader has to be able to tell
 * apart: nothing selected (the pool is simply banked), accumulating (`n of cost, m to
 * go`), already affordable (the tech completes at the *start of the next turn*,
 * because research reads the pool the last money loop filled), and stuck — a
 * selection this ruleset cannot price, which is the one case that would otherwise
 * look like a game that had stopped.
 */
const researchStanding = (state: GameState, ruleset: RulesetView, playerId: PlayerId): string => {
  const step: ResearchStep = researchStep(state, ruleset, playerId);
  const pool = playerStateOf(state, playerId)?.beakers ?? 0;

  switch (step.kind) {
    case 'nothing-being-researched':
      return (
        `research: nothing being researched - ${String(wholeNumber(pool))} ` +
        `${plural(wholeNumber(pool), 'beaker')} banked ("research <techId>"; "tech" lists the tree)`
      );
    case 'accumulating':
      return (
        `research: researching ${techLabel(ruleset, step.tech)} - ${String(step.beakers)}/` +
        `${String(step.cost)} beakers, ${String(step.needed)} to go`
      );
    case 'completed':
      // `step.beakers` on this member is the remainder that *stays* in the pool, not
      // the pool itself (`tech.ts` says so where the union is declared), so the
      // fraction is printed from the pool and the carry-over is named separately. The
      // first draft printed `step.beakers/cost` and read "1/5 beakers: covered", which
      // is exactly the kind of line a reader would take for a bug.
      return (
        `research: researching ${techLabel(ruleset, step.tech)} - ` +
        `${String(wholeNumber(pool))}/${String(step.cost)} beakers: the pool covers it, so the ` +
        `next "end" completes it and carries ${String(step.beakers)} ` +
        `${plural(step.beakers, 'beaker')} past it`
      );
    case 'stuck':
      return (
        `research: stuck on "${step.tech}" - ${researchProblemReason(ruleset, step.problem)}; ` +
        '"research <techId>" replaces it, and "tech" prints the tree'
      );
  }
};

/* ------------------------------------------------------------------ *
 * M3 - what the two setter verbs accept.
 * ------------------------------------------------------------------ */

/**
 * The unit a command names, when it names one (`move`, `found`, the worker verbs, and
 * M6's `attack` and `fortify`).
 *
 * This function is the *only* writer of an `ErrorContext`'s `unitId`, and every lesson
 * that names the offending unit reads it back out — so a command missing from this list
 * does not fail loudly: its refusals simply lose the sentence that says which unit they
 * are about, and the loss is easy to miss because the typed error still names the id.
 * M6's two verbs were missing here at first, and `unit-cannot-attack` was the tell: the
 * "legal:" line under that refusal vanished (`legalMovesLines` needs this id) while the
 * prose above it looked complete. The list covers every `Command` member that carries a
 * `unitId`, for that reason, and `repl.test.ts` pins the lesson each one prints.
 */
const unitIdOf = (command: Command): UnitId | undefined =>
  command.type === 'MoveUnit' ||
  command.type === 'FoundCity' ||
  command.type === 'StartWork' ||
  command.type === 'CancelWork' ||
  command.type === 'AttackUnit' ||
  command.type === 'FortifyUnit'
    ? command.unitId
    : undefined;

/** The city a command names, when it names one (`work` and `build` do). */
const cityIdOf = (command: Command): CityId | undefined =>
  command.type === 'SetWorkedTiles' || command.type === 'SetProduction'
    ? command.cityId
    : undefined;

/**
 * The rates a command asked for, when it asked for any (`rates` does).
 *
 * The third and last payload an `ErrorContext` carries, and the only reason it
 * exists: the lesson under a refused `invalid-argument` depends on *which* command
 * was refused, and `SetRates` is the one that has a rule to teach (see
 * `formatGameError`).
 */
const ratesOf = (command: Command): Rates | undefined =>
  command.type === 'SetRates' ? command.rates : undefined;

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
 * What a ruleset can research at all, as prose for a hint — every catalog row whose
 * cost `techCostOf` accepts.
 *
 * The same evaluator `planSetResearch` gates on, so a hint under a refused `research`
 * line cannot advertise an id the engine would refuse for the same reason it refused
 * the one that was typed. The ids are the tokens a command spells, so they are
 * printed as ids rather than as prose names.
 */
const techCatalogueHint = (ruleset: RulesetView): string => {
  const rows = techCatalog(ruleset)
    .filter((def) => techCostOf(ruleset, def.id) !== undefined)
    // The price comes back out of `techCostOf` rather than off the row, so the hint
    // and the engine's price cannot drift (`tech.ts` is the one place a row's cost
    // becomes a *chargeable* number, and a row could carry one this rejects).
    .map((def) => `"${def.id}" (${techPriceLabel(ruleset, def.id)})`);

  if (rows.length === 0) {
    return 'this ruleset ships no researchable tech: its tech catalog is empty or unpriced';
  }
  return `researchable in this ruleset: ${rows.join('; ')}`;
};

/* ------------------------------------------------------------------ *
 * M4b - the economy, as the reader sees it.
 *
 * The money loop changes something on *every* turn (gold moves, upkeep is
 * paid, and a treasury that cannot pay disbands units), so its figures are
 * printed rather than offered: the banner states the starting position, an
 * `economy:` line rides under every view, and `state` prints the ledger.
 *
 * Every number below is either read straight out of the state or computed by
 * an engine function — `playerIncome`, `playerUpkeep`, `unitSupport`,
 * `planSetRates`, `RATE_TOTAL` — so the prose cannot develop a second opinion
 * about what a player earns or owes. Nothing here is a rule; it is all
 * rendering.
 *
 * `beakers` and `luxuries` are printed with an honest sentence every single
 * time, and as of M5 the two sentences are **different**, because the two channels
 * are no longer the same thing. Beakers buy tech (`tech.ts`), so they are printed
 * with what they are banked toward and how far the pool is from the cost; luxuries
 * still do nothing (happiness is M9), so `LUXURY_CAVEAT` is quoted in full wherever
 * they appear. Leaving the M4b sentence — "beakers and luxuries DO NOTHING yet" — on
 * a beaker line would be a lie the engine's own turn pipeline contradicts, and a
 * stale claim in the output is how a real hole stays invisible.
 * ------------------------------------------------------------------ */

/**
 * A whole number read out of the state, or `0`.
 *
 * The state is typed, so every field below is a `number` at compile time — the
 * guard is not a type test, it is a *rendering* rule: this module prints into the
 * agent's primary view, and `gold=NaN` or `rates 1.5/NaN/0` would be a worse
 * answer than a 0 that says "nothing the engine can count". `economy.ts` reads the
 * same fields the same way for the same reason (a hand-built state, a save from
 * before M4b, a JSON round trip).
 */
const wholeNumber = (value: number): number => (Number.isInteger(value) ? value : 0);

/** The acting player's own row, or `undefined` when the state has no such player. */
const playerStateOf = (state: GameState, id: PlayerId): PlayerState | undefined =>
  state.players.find((player) => player.id === id);

/**
 * The sentence that has to travel with the one inert channel, quoted in full
 * wherever luxuries are printed.
 *
 * M4b wrote one constant for *two* inert pools ("beakers and luxuries DO NOTHING
 * yet"). M5 made half of that sentence false — beakers now buy tech — so the
 * constant was split rather than edited: this half is still exactly true (happiness
 * is M9, and nothing reads `luxuries`), and the beaker half is now
 * `researchStanding`'s job, because what beakers do depends on what the player has
 * selected. One constant per claim, so the next milestone cannot leave a stale half
 * behind in one of the five places it is printed.
 */
const LUXURY_CAVEAT = 'luxuries DO NOTHING yet: nothing reads them until M9 (happiness)';

/**
 * What the science share of commerce does, for a line that has just printed a
 * beaker figure and cannot show the running total (`IncomeCollected` is per player
 * per turn; the standing line is elsewhere).
 */
const BEAKER_RULE =
  'beakers now buy tech: they are banked toward the tech you selected and spent on the ' +
  'turn the pool covers its cost ("research <techId>" chooses one, "tech" shows the tree)';

/** `tax 6 / science 4 / luxury 0 (sum 10 of 10)` — the split, spelled out. */
const ratesLabel = (rates: Rates): string => {
  const tax = wholeNumber(rates.tax);
  const science = wholeNumber(rates.science);
  const luxury = wholeNumber(rates.luxury);
  return (
    `tax ${String(tax)} / science ${String(science)} / luxury ${String(luxury)} ` +
    `(sum ${String(tax + science + luxury)} of ${String(RATE_TOTAL)})`
  );
};

/** `6/4/0` — the same three numbers, for a line that already says which is which. */
const ratesTriple = (rates: Rates): string =>
  `${String(wholeNumber(rates.tax))}/${String(wholeNumber(rates.science))}/` +
  String(wholeNumber(rates.luxury));

/** `1 city` / `3 cities`: a count with its noun, so no line reads "1 cit(y|ies)". */
const plural = (count: number, singular: string, pluralForm?: string): string =>
  count === 1 ? singular : (pluralForm ?? `${singular}s`);

/** `10 gold, 0 beakers, 0 luxuries` — the three pools, as the state holds them. */
const poolsOf = (player: PlayerState): string =>
  `${String(wholeNumber(player.treasury))} gold, ${String(wholeNumber(player.beakers))} ` +
  `${plural(wholeNumber(player.beakers), 'beaker')}, ` +
  `${String(wholeNumber(player.luxuries))} ${plural(wholeNumber(player.luxuries), 'luxury', 'luxuries')}`;

/**
 * The economy in one line, printed under **every** view — the counterpart of the
 * `units:` and `cities:` lines, and for the reason those exist: without it the
 * agent would have to ask (`state`) to see a number that changed on the turn it
 * just ended, and a bankrupt player would find out one command too late.
 *
 * A player this state does not have gets a line that says so rather than a
 * fabricated `0 gold` — the same reading `headerLine`'s gold field takes in
 * `textview`.
 */
const economyLine = (state: GameState, playerId: PlayerId): string => {
  const player = playerStateOf(state, playerId);
  if (player === undefined) {
    return `economy: unknown (this state has no player ${String(playerId)})\n`;
  }
  const support = unitSupport(state, playerId);
  return (
    `economy: ${String(wholeNumber(player.treasury))} gold, rates ${ratesTriple(player.rates)} ` +
    `(tax/science/luxury, sum ${String(
      wholeNumber(player.rates.tax) +
        wholeNumber(player.rates.science) +
        wholeNumber(player.rates.luxury),
    )} of ${String(RATE_TOTAL)}), ${String(wholeNumber(player.beakers))} beakers, ` +
    `${String(wholeNumber(player.luxuries))} luxuries - ${LUXURY_CAVEAT}\n` +
    `  ${String(support.units)} unit(s) against ${String(support.free)} supported free ` +
    `(${String(support.supported)} billable at ${String(support.gold)} gold); upkeep is what empties a treasury\n`
  );
};

/**
 * The full ledger, for the `state` verb: the three pools, the split that produced
 * them, and — from the engine's own evaluators — what ending the turn now would
 * collect and cost.
 *
 * The projection is labelled as one, and honestly: it is `playerIncome` and
 * `playerUpkeep` answering about the *current* state, while the money loop runs
 * after this turn's growth and production, which can add a city's commerce or a
 * unit's support before the bill is drawn. Saying "a projection from this state"
 * is the precise claim; saying "you will collect 4 gold" would not be.
 *
 * Beakers are shown as a pool *and* as a per-turn flow, and the standing research
 * line is printed under them, because those are the three claims a reader could
 * confuse: "I have 12 beakers", "I earn 2 a turn" and "the tech I selected costs 7"
 * are different facts about one system. Luxuries keep M4b's sentence verbatim,
 * because for them it is still exactly true.
 */
const economyDetailLines = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly string[] => {
  const player = playerStateOf(state, playerId);
  if (player === undefined) {
    return [`economy: unknown (this state has no player ${String(playerId)})`];
  }

  const income = playerIncome(state, ruleset, playerId);
  const upkeep = playerUpkeep(state, ruleset, playerId);
  const support = unitSupport(state, playerId);
  const cities = citiesOf(state, playerId).length;

  return [
    `economy: ${String(wholeNumber(player.treasury))} gold, rates ${ratesLabel(player.rates)}, ` +
      `${String(wholeNumber(player.beakers))} beakers, ${String(wholeNumber(player.luxuries))} luxuries`,
    `  ${BEAKER_RULE}.`,
    `  ${LUXURY_CAVEAT}: they only pile up, and this build neither spends nor reads them.`,
    `  gold pays upkeep, and a treasury that cannot pay is paid for by disbanding units`,
    `  (highest id first) rather than by going negative.`,
    `economy: at these rates this state collects ${String(income.gold)} gold, ` +
      `${String(income.beakers)} ${plural(income.beakers, 'beaker')} and ` +
      `${String(income.luxuries)} ${plural(income.luxuries, 'luxury', 'luxuries')} a turn`,
    `  from ${String(cities)} ${plural(cities, 'city', 'cities')}, and owes ${String(upkeep.gold)} ` +
      `gold of upkeep (${String(upkeep.maintenance)} maintenance + ${String(upkeep.unitSupport)} ` +
      `unit support for ${String(support.units)} unit(s), ${String(support.free)} free)`,
    `  - a projection from this state, because growth and production run before the bill is drawn.`,
    researchStanding(state, ruleset, playerId),
  ];
};

/**
 * The banner's economy block: the same facts, once, at the top of a session.
 *
 * A session that opens on a 10-gold treasury and never mentions it again is a
 * session whose player learns about upkeep by being bankrupted by it, so the
 * numbers are stated before the first command rather than only on demand.
 */
const bannerEconomyLines = (state: GameState, playerId: PlayerId): string => {
  const player = playerStateOf(state, playerId);
  if (player === undefined) return '';
  const cities = citiesOf(state, playerId).length;
  return (
    `economy: ${poolsOf(player)}, rates ${ratesLabel(player.rates)}, ` +
    `${String(cities)} ${plural(cities, 'city', 'cities')}\n` +
    `  ${BEAKER_RULE}.\n` +
    `  ${LUXURY_CAVEAT}.\n` +
    `  "rates <tax> <science> <luxury>" moves the sliders (they must sum to ` +
    `${String(RATE_TOTAL)}); gold pays upkeep, and a treasury that cannot pay disbands units.\n`
  );
};

/**
 * A few legal triples, each one **asked of `planSetRates`** before it is printed —
 * so the lesson under a refused `rates` cannot advertise a triple the engine would
 * refuse too. The corners of the space (all gold, all science, all luxury) plus the
 * shipped default: the four a reader reaching for a slider actually wants.
 *
 * Empty when the actor itself is unknown, in which case the lesson is the rule and
 * nothing else — an example the engine would refuse would be worse than no example.
 */
const legalRatesExamples = (context: ErrorContext): readonly string[] => {
  const candidates: readonly Rates[] = [
    { tax: RATE_TOTAL, science: 0, luxury: 0 },
    { tax: 0, science: RATE_TOTAL, luxury: 0 },
    { tax: 0, science: 0, luxury: RATE_TOTAL },
    { tax: 6, science: 4, luxury: 0 },
  ];
  return candidates
    .filter((rates) => planSetRates(context.state, context.playerId, rates).ok)
    .map(
      (rates) => `"rates ${String(rates.tax)} ${String(rates.science)} ${String(rates.luxury)}"`,
    );
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

    /* ---------------- M4c: the resource gate and the wonder rule ---------------- */

    case 'resource-not-connected':
      // The refusal **names the missing resource**, which is the whole reason M4c
      // gave this its own `GameError` member rather than reusing
      // `unknown-production-item`: the item is real and settable in a city that has
      // the resource, so the answer is "build a road to the Iron", not "pick
      // something else". The connection rule is stated once, in `resources.ts`, and
      // asked rather than restated: this line says what the *player* must do (the
      // connection is the owner's, not this city's — M4c quantifies over "some city
      // of that player").
      return [
        `error: resource-not-connected - ${cityLabel(context.state, error.cityId)} cannot build ` +
          `${itemLabel(context.ruleset, error.item)}: it requires ${resourceLabel(
            context.ruleset,
            error.resource,
          )}, and ${playerLabel(context.state, error.owner)} has no road connecting it.`,
        '  a resource is connected for a player when some city of that player reaches it through',
        '  a path of road-improved tiles (8-way, endpoints inclusive) - so a road from any of its',
        '  cities will do, not only from this one.',
        ...legalBuildLines(context),
      ].join('\n');

    case 'tech-required':
      // M5's third gating dimension, and the same shape of sentence as
      // `resource-not-connected`: the item is real and settable once the technology is
      // known, so the answer is "research Iron Working", not "pick something else".
      // The tech is named by name *and* id, with the command that gets it, because a
      // refusal a player cannot act on is a dead end.
      //
      // This is the applier's own typed refusal (`planSetProduction` asks
      // `productionGate`), so the line and the menu cannot disagree — and the
      // "locked behind a tech" note in the build lesson below is now a *reading of this
      // same refusal* rather than a report about a build the engine used to accept.
      return [
        `error: tech-required - ${cityLabel(context.state, error.cityId)} cannot build ` +
          `${itemLabel(context.ruleset, error.item)}: it requires ` +
          `${techLabel(context.ruleset, error.tech)}, which ${playerLabel(
            context.state,
            error.owner,
          )} has not researched.`,
        `  to get there: "research ${error.tech}" (${techPriceLabel(
          context.ruleset,
          error.tech,
        )}). Beakers are split from commerce by the rates, so a city with commerce and a`,
        '  science rate banks the beakers that buy it.',
        ...legalBuildLines(context),
      ].join('\n');

    case 'wonder-already-built': {
      // `holder` is **absent** (never a key holding `undefined`) for a state the
      // rule cannot produce, where the lookup found no holder at all. Saying "the
      // city that holds it" there would be a claim about a city this state does not
      // name, so the two cases are two sentences.
      const held =
        error.holder === undefined
          ? 'a city already holds it, so another city may not start it'
          : `${cityLabel(context.state, error.holder)} already holds it`;
      return [
        `error: wonder-already-built - ${cityLabel(context.state, error.cityId)} cannot start ` +
          `${buildingLabel(context.ruleset, error.building)}: ${held}.`,
        '  a wonder is globally unique - once any city anywhere holds it, no city may start it -',
        '  and M4c has no destruction, so it is never rebuilt either. Bankruptcy is the one way a',
        '  wonder is lost, and after that it is buildable again.',
        ...legalBuildLines(context),
      ].join('\n');
    }

    case 'invalid-argument': {
      // `invalid-argument` is one error kind with many causes, so the lesson is
      // the one that fits the refused command: a refused `SetRates` gets the rate
      // rule and legal triples (checked against `planSetRates`), everything else
      // gets the moves that were legal, exactly as before.
      const lesson =
        context.rates === undefined
          ? legalMovesLines(context)
          : [
              `  legal: the three rates are integers >= 0 that must sum to exactly ` +
                `${String(RATE_TOTAL)} (RATE_TOTAL); the split is tenths of a city's commerce,`,
              '  the remainder of each division going to gold.',
              ...(legalRatesExamples(context).length === 0
                ? []
                : [
                    `  legal: any such split works, for example ` +
                      `${legalRatesExamples(context).join(', ')}.`,
                  ]),
            ];
      return [`error: invalid-argument - ${error.detail}`, ...lesson].join('\n');
    }

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

    case 'improvement-tech-required':
      // M5's gate on the worker path, and the same sentence shape as the production
      // one above: the improvement is real and startable once the technology is known
      // (`planStartWork` asks `unmetTechFor`, so this is the applier's own typed
      // refusal), so the answer names the tech and the command that gets it.
      return [
        `error: improvement-tech-required - ${unitLabel(
          context.state,
          context.ruleset,
          error.unitId,
        )} cannot start ${improvementLabel(context.ruleset, error.improvement)}: it requires ` +
          `${techLabel(context.ruleset, error.tech)}, which ${playerLabel(
            context.state,
            context.playerId,
          )} has not researched.`,
        `  to get there: "research ${error.tech}" (${techPriceLabel(
          context.ruleset,
          error.tech,
        )}).`,
        ...startableLines(context, error.unitId),
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

    /* ---------------- M5: research and the tech tree ---------------- */

    case 'unknown-tech':
      return [
        `error: unknown-tech - this ruleset has no researchable tech "${error.tech}": no tech row`,
        '  carries that id, or the row that does carries no whole number of beakers to charge.',
        `  ${techCatalogueHint(context.ruleset)}.`,
        ...legalResearchLines(context),
      ].join('\n');

    case 'tech-already-known':
      return [
        `error: tech-already-known - ${playerLabel(context.state, context.playerId)} already knows`,
        `  ${techLabel(context.ruleset, error.tech)}, so there is nothing to research.`,
        ...legalResearchLines(context),
      ].join('\n');

    case 'tech-prerequisites-unmet':
      return [
        `error: tech-prerequisites-unmet - ${techLabel(context.ruleset, error.tech)} needs ` +
          `${error.missing.map((id) => techLabel(context.ruleset, id)).join(', ')}, which ` +
          `${playerLabel(context.state, context.playerId)} does not know yet.`,
        `  it costs ${techPriceLabel(context.ruleset, error.tech)}, and a prerequisite is known`,
        '  only once its own research completes, so the tree is climbed from the roots.',
        ...error.missing.map(
          (id) =>
            `  to get there: "research ${id}" (${techPriceLabel(context.ruleset, id)}${
              prerequisitesOf(context.ruleset, id).length === 0
                ? ''
                : `, but only once ${prerequisitesOf(context.ruleset, id).join(', ')} is known`
            }).`,
        ),
        ...legalResearchLines(context),
      ].join('\n');

    /* ---------------- M6: combat ---------------- */

    // The three refusals `AttackUnit` can produce beyond the ones every unit command
    // shares (`unknown-unit`, `not-your-unit`, `out-of-bounds`, `not-enough-movement`
    // and `invalid-argument` above). Each lesson is built by *asking* the engine —
    // `planAttackUnit` over the unit's eight neighbours (`legalAttackLines`) — so a
    // refusal cannot advertise an attack the applier would refuse in turn, which is the
    // keystone invariant applied to the wording.
    case 'unit-cannot-attack':
      return [
        `error: unit-cannot-attack - ${unitLabel(context.state, context.ruleset, error.unitId)}`,
        `  cannot attack: its type's attack is ${String(error.attack)}, and M6's rule is that a`,
        '  unit with attack 0 may not attack at all. A type this ruleset does not describe',
        '  reads as attack 0 too, because the engine can see no attack there.',
        ...legalMovesLines(context),
      ].join('\n');

    case 'nothing-to-attack':
      return [
        `error: nothing-to-attack - (${coordOf(context.state.map, error.target)}) holds no enemy ` +
          'unit',
        `  and no enemy city, so there is nothing there for ` +
          `${unitLabel(context.state, context.ruleset, error.unitId)} to attack.`,
        ...legalAttackLines(context, error.unitId),
        ...legalMovesLines(context),
      ].join('\n');

    case 'target-stacked':
      return [
        `error: target-stacked - (${coordOf(context.state.map, error.target)}) holds ` +
          `${String(error.defenders)} enemy units,`,
        '  and one attack resolves against exactly one of them. Which one would be picked is a',
        '  rule this engine does not have (M2 lets units stack), so the attack is refused',
        '  rather than aimed at a defender the command never named.',
        ...legalAttackLines(context, error.unitId),
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
 * `cityGrowthTarget` (the bare `foodBoxSize` reduced by the city's own
 * `growth-food` buildings — M4c, see `growthThresholdOf`), an item's
 * price from `itemCostOf`, the yields from `cityYields`. "How much more
 * food does this city need?" is a subtraction of two numbers the engine
 * published, not a second statement of the growth rule.
 * ------------------------------------------------------------------ */

/** `+2` / `-1` / `0`: a surplus with its sign, for a reader skimming the line. */
const signed = (value: number): string => (value > 0 ? `+${String(value)}` : String(value));

/**
 * The food `city` needs for its next citizen: `foodBoxSize(population)` reduced by the
 * city's own `growth-food` buildings and floored at `MIN_GROWTH_FOOD`. That is
 * `cityGrowthTarget`, the engine's own read of the requirement — the one rule, asked
 * rather than restated.
 *
 * **Migrated for the M4c growth-food wiring.** This module used to print the bare
 * `foodBoxSize`, so a city holding a granary was shown `food 5/10 (5 more to grow)`
 * while the engine grew it at 9: the view was a *second* answer to "what does this
 * city need", and once the effect was wired it became the wrong one. Asking the engine
 * is the discipline the rest of this file already follows for the price
 * (`itemCostOf`), the yields (`cityYields`) and the maintenance bill
 * (`maintenanceOf`), so the number a player reads is the number the growth pass will
 * compare against and cannot drift from it.
 */
const growthThresholdOf = (ruleset: RulesetView, city: City): number =>
  cityGrowthTarget(buildingCatalog(ruleset), city, foodBoxSize(city.population));

/** The terrain under a tile, or `?` when the ruleset cannot name it. */
const terrainNameAt = (state: GameState, ruleset: RulesetView, tile: TileIndex): string =>
  terrainDefAt(state, ruleset, tile)?.name ?? '?';

/**
 * One building as a reader needs it **since M4c**: what it is called, whether it
 * is a wonder, and what it costs its owner per turn — `Granary (0 gold/turn)`,
 * `Pyramids (wonder, 2 gold/turn)`.
 *
 * `maintenanceOf` is the engine's own read of the field (the one `economy.ts` sums
 * for the bill), so the number a player sees beside a building cannot drift from
 * the number they are charged for it. A row the catalog cannot describe — a
 * hand-built city holding an id no catalog defines — costs nothing and is named by
 * its id, the same "read what is there" `buildingLabel` follows.
 *
 * `wonder` is spelled out because it is the one property of a building that
 * changes *other* cities' options: a wonder another city holds is not startable
 * anywhere, so a reader who cannot see the mark cannot explain why the build menu
 * changed.
 */
const buildingCostLabel = (ruleset: RulesetView, id: BuildingId): string => {
  const def = buildingDef(ruleset, id);
  if (def === undefined) return `${id} (0 gold/turn)`;
  const kind = isWonder(def) ? 'wonder, ' : '';
  return `${def.name} (${kind}${String(maintenanceOf(def))} gold/turn)`;
};

/**
 * What a player has **connected**, for the city view (M4c): the resources its road
 * network reaches, named.
 *
 * The list is `connected`'s own answer — the one implementation of the connection
 * rule, the same one `planSetProduction` gates a unit on — so what this line says
 * and what the engine will let the player build cannot disagree. It is the
 * *player's* set and not this city's, which is why the line names the owner: M4c
 * quantifies over "some city of that player", and a line that read as "this city's
 * roads" would make a legal build look illegal.
 *
 * Read off `state.map.resources` (the map, in its `(tile, resource)` order) and
 * filtered by membership, rather than off the catalog: a connection the catalog
 * cannot name still exists in the state, and the id is then the honest label —
 * exactly what `resourceLabel` does for the refusal in `formatGameError`.
 *
 * Nothing here consults the fog, and that is deliberate rather than an oversight: a
 * connected resource is necessarily on a tile the player has explored (a road tile
 * is a tile one of its units stood on), and the alternative — filtering the
 * engine's answer through `isExplored` — would hide a connection the engine will
 * still honour, which is a display that lies about the rule.
 */
const resourcesLine = (state: GameState, ruleset: RulesetView, playerId: PlayerId): string => {
  const reached = connected(state, ruleset, playerId);
  const names: string[] = [];
  for (const pair of state.map.resources) {
    if (!reached.has(pair.resource)) continue;
    const name = resourceLabel(ruleset, pair.resource);
    if (!names.includes(name)) names.push(name);
  }

  if (names.length === 0) {
    return (
      '  resources: none connected - a resource connects when a city of its owner reaches it ' +
      'through road tiles'
    );
  }
  return `  resources: connected for ${playerLabel(state, playerId)}: ${names.join(', ')}`;
};

/**
 * One city in full: population, the food box **and the threshold it is filling
 * toward**, the stored shields, the item being built **and what it costs**, the
 * queue behind that item, the buildings with their maintenance, the resources the
 * owner has connected, and the tiles its citizens work.
 *
 * The yields line states what `cityYields` computed — food, shields, commerce,
 * how much the citizens eat, and the surplus — because "why is this city not
 * growing?" is a question about integers the engine already has, and a reader
 * should not have to add them up. M4c's two new lines answer the two questions a
 * city view gained with this wave: what is this city costing me to keep, and which
 * resources can its owner actually build on. M6's third (`cityDefenceLine`) answers
 * the one combat asks of a city: how much harder is a unit standing here to kill.
 */
const cityDetailText = (state: GameState, ruleset: RulesetView, city: City): string => {
  const yields: CityYields = cityYields(state, ruleset, city.id);
  const box = growthThresholdOf(ruleset, city);
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
        `${cost === undefined ? '?' : String(Math.max(0, cost - city.shields))} more to go)` +
        // M5: an item the tech gate refuses is shown as the item it is *and* as the
        // reason it will not finish. Without this the view would report a build in
        // progress that the production pass is going to skip forever.
        itemTechNote(state, ruleset, city, item),
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
      : `  buildings: ${city.buildings.map((id) => buildingCostLabel(ruleset, id)).join(', ')}; ` +
          `${String(cityMaintenance(buildingCatalog(ruleset), city))} gold/turn for this city`,
  );

  lines.push(resourcesLine(state, ruleset, city.owner));

  // M6: how hard the city's tile is to take, under the resources line and above the
  // assignment — the two lines above say what the city *is* and what it *costs*, and
  // this one says what standing in it is worth to a defender.
  lines.push(cityDefenceLine(state, ruleset, city));

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
          `${String(city.foodBox)}/${String(growthThresholdOf(ruleset, city))}`,
          String(city.shields),
          item === undefined ? '(idle)' : itemLabel(ruleset, item),
        ]),
      );
    }
    lines.push(
      '  "city <cityId>" shows one in full: yields, queue, buildings, defence and worked tiles.',
    );
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
    `food ${String(city.foodBox)}/${String(growthThresholdOf(ruleset, city))} ` +
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
 * `helpText`.
 */
export const COMMAND_SUMMARY =
  'move <unitId> <x> <y> | attack <unitId> <x> <y> | fortify <unitId> | found <unitId> | ' +
  'cities | city <cityId> | ' +
  'work <cityId> <x> <y> ... | build <cityId> <unit|building>:<id> | ' +
  'work <unitId> <improvementId> | cancel <unitId> | ' +
  'rates <tax> <science> <luxury> | research <techId> | tech | ' +
  'end | units | state | save <path> | help | quit';

/**
 * The help text, as a **function of the combat rules** (M6b).
 *
 * It used to be a module-level constant that interpolated `MAX_EXPERIENCE`,
 * `VETERAN_ATTACK_PCT` and `FORTIFY_BONUS_PCT` from `core/combat.ts`. Those are catalog
 * magnitudes now, so a constant computed at import time would freeze whatever the module
 * was compiled against and go on printing it after a balance sweep moved the real number —
 * a help screen that documents a game nobody is playing. Taking `rules` and being called
 * where the session knows its ruleset is the whole fix, and the printed text is
 * byte-identical to what the constants produced.
 */
const helpText = (rules: CombatDef): string => `commands:
  move <unitId> <x> <y>   step one unit onto an adjacent tile (8-way). The cost is the
                          destination tile's move cost, paid from that unit's movement.
  attack <unitId> <x> <y> attack one of the 8 adjacent tiles with that unit. The unit must
                          have attack > 0 and movement left, and the tile must hold exactly
                          one enemy unit (a battle, resolved against that defender with the
                          tile's and its city's defence bonuses) or an undefended enemy
                          city (which is CAPTURED: its population halves rounded down to a
                          minimum of 1, its non-wonder buildings are destroyed, its queue
                          and worked tiles are cleared, and it is not razed). Attacking
                          spends ALL of the unit's remaining movement whether it wins or
                          loses. The winner of a battle gains one experience level
                          (capped at ${String(rules.maxExperience)}), worth +${String(rules.veteranAttackPct)}% attack each;
                          a battle ends when one side is destroyed, so a unit is never left
                          standing at 0 hit points. A tie in a round goes to the DEFENDER.
                          "units" shows every unit's hit points; a city's "defence:" line
                          shows what its tile and walls are worth to a defender.
  fortify <unitId>        dig that unit in where it stands: +${String(rules.fortifyBonusPct)}% defence until it moves.
                          It requires movement left and costs the rest of the turn, and it
                          prints a line because (unlike an attack) it emits no event.
  found <unitId>          found a city with that unit, which must be a settler standing on
                          land at least 2 tiles (counting diagonals) from every city. The
                          settler is consumed. New cities start at population 1 and work
                          the best tiles they can reach.
  cities                  list your cities: where each is, its citizens, its food box
                          against the threshold for the next citizen, its stored shields
                          and what it is building.
  city <cityId>           show one city in full: population, the food box and its
                          threshold, stored shields, the current item and its cost, the
                          queue behind it, its buildings, what its tile is worth to a
                          defending unit (its "defence:" line) and the tiles it works.
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
  rates <tax> <science> <luxury>
                          move your tax/science/luxury sliders. The three are integers >= 0
                          that must sum to exactly ${String(RATE_TOTAL)} (RATE_TOTAL, a placeholder
                          of ours): that many tenths of every city's commerce go to gold,
                          beakers and luxuries, and the remainder of each division goes to
                          gold. It changes FUTURE collections only - nothing already banked
                          is recomputed. Beakers buy tech (see "research"); LUXURIES DO
                          NOTHING yet, because happiness is M9, so that one channel only
                          piles up. Gold pays upkeep.
  research <techId>       choose what to research. <techId> is a tech id ("tech" lists
                          them). A tech may be chosen when this ruleset defines it, you do
                          not already know it, and you know all of its prerequisites; a
                          refusal names which of those is missing and what you may research
                          instead. Beakers collected from your science rate are banked and
                          spent by the research step of "end", so a tech completes on the
                          turn the pool covers its cost and the remainder is carried.
  tech                    print the tech tree: every tech this ruleset defines, its era, its
                          cost in beakers and its prerequisites, grouped into what you know,
                          what you may research now, and what is blocked - each blocked row
                          naming the prerequisite that is missing.
  end                     end the turn: every unit's work advances, every city grows and
                          produces, research advances, every player collects income and pays
                          upkeep (a treasury that cannot pay disbands units), every unit
                          refills its movement, turn advances. An improvement finished this
                          turn counts towards this turn, and a unit produced this turn costs
                          support from this turn.
  units                   list the units you can see, with position, movement left, hit
                          points (a damaged unit must be visible as damaged) and what each
                          one is doing.
  state                   print seed, turn, revision, map size, RNG, your gold, rates,
                          beakers and luxuries, your research, what your units are doing and
                          the state hash.
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
  - the "economy:" line printed under every view is your own money: gold, the three rates
    and the beakers you have banked; the "research:" line under it says what those beakers
    are banked toward, its cost and how much is still to come. Luxuries still do nothing
    (happiness is M9). Your gold is also in the header of every view, as "gold=" beside
    "viewer=".
  - a refused command prints the typed reason and the choices that were legal, and never
    changes the state.
  - every command goes through the engine's command API; the REPL never edits state.
`;

const promptFor = (playerId: PlayerId): string => `p${String(playerId)}> `;

const bannerText = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  god: boolean,
): string =>
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
  // M4b: the economy, before the first command rather than only on demand. A
  // session that never mentions the treasury is a session whose player finds out
  // what upkeep costs by being bankrupted by it.
  bannerEconomyLines(state, playerId) +
  // M5: what you are researching (nothing, at the start of a game) and how to
  // change it, stated once before the first command for the same reason.
  `${researchStanding(state, ruleset, playerId)}\n` +
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
const outcomeText = (
  outcome: CommandOutcome,
  command: Command,
  ruleset: RulesetView,
  playerId: PlayerId,
): string => {
  // M6b: the two combat magnitudes this renderer prints — the per-level attack bonus and
  // the fortify bonus — are read from the ruleset the session is playing, the same way
  // `commands.ts` reads them before it resolves a battle. They were module constants in
  // `combat.ts` before this wave; reading them here is what keeps the event prose from
  // reporting a number the engine no longer uses.
  const rules = combatRulesOf(ruleset);
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

      case 'CityGrew': {
        // The denominator is the requirement for the *next* citizen, so it is asked of
        // the city as it stands after the growth (M4c: `growthThresholdOf`, which is
        // the reduced requirement — a granary city at two citizens needs 14, not the
        // bare 15). The fallback covers only a state the event contradicts (no city with
        // that id), where there is nothing to ask.
        const grown = cityById(outcome.state, event.cityId);
        const next =
          grown === undefined ? foodBoxSize(event.population) : growthThresholdOf(ruleset, grown);
        return (
          `ok: ${cityLabel(outcome.state, event.cityId)} grew to ` +
          `${String(event.population)} citizen(s); food box ${String(event.foodBox)}/` +
          `${String(next)} carried over`
        );
      }

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

      /* ---------------- M4b: the money loop ---------------- */

      // The four money events, each rendered as a real line. They are the one
      // place a *zero* is reported: `economy.ts` emits `IncomeCollected` and
      // `UpkeepPaid` for every civilization on every turn, including a turn whose
      // amount is zero, because the milestone's evidence bar is that gold is
      // accounted for — and a ledger with a suppressed line in it can only be
      // guessed at. So these lines say their zero out loud rather than vanishing.
      //
      // `beakers`/`luxuries` carry their own sentence here too: this is the line a
      // reader meets every single turn, and "collected 2 beakers" with no caveat is
      // exactly the implication M4b's honesty rule forbids. Since M5 the two
      // sentences differ, because the two channels do: beakers are read by the
      // research step and luxuries by nothing at all.
      case 'IncomeCollected':
        return (
          `ok: ${playerLabel(outcome.state, event.playerId)} collected ${String(event.gold)} gold, ` +
          `${String(event.beakers)} ${plural(event.beakers, 'beaker')} and ` +
          `${String(event.luxuries)} ${plural(event.luxuries, 'luxury', 'luxuries')} from its ` +
          `cities at its rates - ${BEAKER_RULE}; ${LUXURY_CAVEAT}`
        );

      // M5: the one event that spends the pool. It carries the price and the
      // remainder, so the line can state the carry-over rule from the event alone
      // (`tech.ts` puts both on the payload for exactly this reason) and name the
      // tech through the *ruleset*, never through the id.
      case 'TechResearched':
        return (
          `ok: ${playerLabel(outcome.state, event.playerId)} finished researching ` +
          `${techLabel(ruleset, event.tech)} for ${String(event.cost)} ` +
          `${plural(event.cost, 'beaker')}; ${String(event.beakers)} ` +
          `${plural(event.beakers, 'beaker')} left in the pool`
        );

      case 'UpkeepPaid':
        return (
          `ok: ${playerLabel(outcome.state, event.playerId)} paid ${String(event.gold)} gold of ` +
          `upkeep (${String(event.maintenance)} building maintenance + ` +
          `${String(event.unitSupport)} unit support for ${String(event.units)} unit(s), ` +
          `${String(event.freeUnits)} of them free)`
        );

      // Which units, and why. The event names one removal, and the answer to "why
      // was my unit disbanded?" is three facts: the treasury could not cover the
      // turn's upkeep, the unit was one the player was *paying* for, and the
      // highest id goes first (`economy.ts` states the order; this line reports it).
      case 'UnitDisbanded': {
        const where = eventPlace(outcome, event.tile);
        return (
          `ok: BANKRUPTCY - ${playerLabel(outcome.state, event.playerId)} disbanded unit ` +
          `${String(event.unitId)} (${typeName(ruleset, event.unitType)} at ${where}) to pay ` +
          `${String(event.saved)} gold of this turn's upkeep: the treasury could not cover it, ` +
          'and the highest-id unit goes first'
        );
      }

      // The honest failure: nothing left to disband and gold still owed. The
      // unpaid amount is *reported*, never carried: the frozen state has no debt
      // field, and inventing one here would put a field in the save file that
      // nothing else knows about.
      case 'TreasuryShortfall':
        return (
          `ok: BANKRUPTCY - ${playerLabel(outcome.state, event.playerId)} still owes ` +
          `${String(event.unpaid)} gold of this turn's upkeep after disbanding every unit it ` +
          'could pay with; the treasury is 0 (it never goes negative) and the unpaid gold is ' +
          'reported here rather than carried as a debt'
        );

      /* ---------------- M6: combat ---------------- */

      // The four combat events, each printed as a *real* line. This is the block the
      // no-blank-line regression exists for: a missing `case` here would leave a silent
      // empty line inside an `ok:` block, which is exactly how M3's city and hut events
      // would have arrived (see the module note), so `attack`/`fortify` are covered by
      // the same regression as every earlier event.
      //
      // `CombatResolved` prints the numbers the *resolver* produced rather than a
      // re-derived summary: the per-round odds the draw was taken against, the rounds
      // fought, each side's losses, and each side's fate. The odds come first because
      // "it won" is only legible beside "it had a 31% chance per round" — and the
      // `UnitDestroyed` line that follows says *which* unit died and why, so this line
      // does not have to guess at a cause from a flag.
      case 'CombatResolved': {
        const fate =
          event.attackerSurvives && !event.defenderSurvives
            ? `the attacker holds the field and unit ${String(event.defenderId)} is destroyed`
            : !event.attackerSurvives && event.defenderSurvives
              ? `the defender holds the field and unit ${String(event.attackerId)} is destroyed`
              : event.attackerSurvives
                ? 'both sides are still standing, which a battle of this engine cannot leave'
                : 'both sides were destroyed';
        return (
          `ok: COMBAT - unit ${String(event.attackerId)} ` +
          `(${playerLabel(outcome.state, event.attackerOwner)}) attacked unit ` +
          `${String(event.defenderId)} (${playerLabel(outcome.state, event.defenderOwner)}) at ` +
          `${eventPlace(outcome, event.target)}: ${String(event.attackerWinPct)}% per-round odds ` +
          `for the attacker (a draw below that wins, and a tie goes to the defender), ` +
          `${String(event.rounds)} round(s) fought, the attacker lost ` +
          `${String(event.attackerLost)} hit point(s) and the defender lost ` +
          `${String(event.defenderLost)} - ${event.outcome}: ${fate}`
        );
      }

      // **Why a unit is gone** is the whole reason this event carries a reason, so the
      // line leads with the cause and names the killer when there is one. A death with
      // no killer prints the absence rather than an empty parenthetical: "nothing is
      // recorded as having killed it" is a true sentence about a bankrupt unit, and an
      // invented `by unit undefined` would be a false one.
      case 'UnitDestroyed': {
        const killer =
          event.byUnitId === undefined || event.byOwner === undefined
            ? 'nothing is recorded as having killed it'
            : `killed by unit ${String(event.byUnitId)} ` +
              `(${playerLabel(outcome.state, event.byOwner)})`;
        const why =
          event.reason === 'combat'
            ? 'it lost the battle it was fighting'
            : "its owner's treasury could not pay its support";
        return (
          `ok: unit ${String(event.unitId)} (${typeName(ruleset, event.unitType)}, ` +
          `${playerLabel(outcome.state, event.owner)}) is GONE from ` +
          `${eventPlace(outcome, event.tile)}: ${why}, and ${killer}`
        );
      }

      // Promotion is the reward for winning, so the line names the level it reached, the
      // cap it was clamped against and what the level is *worth* — the bonus percentage
      // read from the ruleset through `combatRulesOf` rather than restated here, because
      // "veteran 2" with no magnitude is a number a player cannot act on.
      case 'UnitPromoted':
        return (
          `ok: unit ${String(event.unitId)} (${playerLabel(outcome.state, event.owner)}) won at ` +
          `${eventPlace(outcome, event.tile)} and was promoted to veteran level ` +
          `${String(event.experience)} of ${String(event.maxExperience)}; each level is ` +
          `+${String(rules.veteranAttackPct)}% attack, and experience is never lost`
        );

      // A capture is not a battle, so this line reports what the *sack* did: the old
      // owner, the new one, the population afterwards and every building destroyed, in
      // destruction order. The wonder rule is printed as a fact about the event rather
      // than as a promise: `destroyed` never names a wonder (`cities.ts` states the rule),
      // and the line says so where a reader would otherwise wonder.
      case 'CityCaptured':
        return (
          `ok: ${event.name} (city ${String(event.cityId)}) at ` +
          `${eventPlace(outcome, event.tile)} was CAPTURED by ` +
          `${playerLabel(outcome.state, event.to)} from ` +
          `${playerLabel(outcome.state, event.from)}; population is now ` +
          `${String(event.population)} and the sack destroyed ` +
          (event.destroyed.length === 0
            ? 'no buildings'
            : `${String(event.destroyed.length)} building(s) (` +
              `${event.destroyed.map((id) => buildingLabel(ruleset, id)).join(', ')})`) +
          ' - a wonder is never destroyed by capture, the city is not razed, and its tile ' +
          'improvements stay'
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
  const effect = appliedCommandText(command, outcome, ruleset, playerId);
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
  playerId: PlayerId,
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
        `${pricedItemLabel(ruleset, command.item)}; ${String(stored)} shields stored` +
        // M5's third gate, reported rather than silently obeyed. `planSetProduction`
        // does not ask the tech gate *yet* (the wiring is owed in `resources.ts` and
        // named there), so an acceptance here is possible for an item
        // `productionGate` refuses — and the city would then bank shields forever
        // without a word about why. The note is the gate's own verdict, not a second
        // legality rule: the REPL never refuses this command, it says what will
        // happen to it.
        itemTechNote(outcome.state, ruleset, city, command.item)
      );
    }

    // M4b: `SetRates` emits no event either (the command's payload is the record
    // of the change), so the report is this line — and it has to name the rule a
    // reader cares about, which is *when* the new split takes effect. It cannot
    // retroactively recollect: the money loop is the last step of a turn and reads
    // the rates once, so the next collection uses these numbers and nothing already
    // banked is recomputed (`planSetRates` states the argument in full).
    case 'SetRates':
      return (
        `ok: rates set to ${ratesLabel(command.rates)}; this changes future collections only - ` +
        'the treasury and the two pools are exactly what they were, and no turn already' +
        ' collected is recomputed'
      );

    // M5: `SetResearch` emits no event (the same reading as the three setters above —
    // the payload *is* the record), so the report has to say what was chosen, what it
    // costs and where the pool stands. The figures are read from the state the command
    // produced, so the line cannot disagree with the pool the next `end` will spend.
    case 'SetResearch': {
      const banked = wholeNumber(playerStateOf(outcome.state, playerId)?.beakers ?? 0);
      const cost = techCostOf(ruleset, command.tech);
      const toGo = cost === undefined ? undefined : Math.max(0, cost - banked);
      return (
        `ok: ${playerLabel(outcome.state, playerId)} is now researching ` +
        `${techLabel(ruleset, command.tech)} - ${techCostLabel(ruleset, command.tech)}, ` +
        `${String(banked)} banked` +
        (toGo === undefined ? '' : `, ${String(toGo)} to go`) +
        '; "end" spends the pool, so it completes on the turn the pool covers the cost'
      );
    }

    // M6: `AttackUnit` always emits an event — `CombatResolved` for a battle,
    // `CityCaptured` for an undefended city — and `outcomeText` renders every event, so
    // there is nothing left to add. It is listed rather than left to a `default` so that
    // a *new* command is still a compile error here.
    case 'AttackUnit':
      return undefined;

    // M6: `FortifyUnit` emits **no** event — the frozen M6 event list names no member
    // for "the unit is dug in", which is exactly why `legalActions` does not advertise
    // it (see `planFortifyUnit`) — so the state's own `fortified` flag is the record and
    // this line is the report. It is read back out of the state the command produced
    // rather than assumed, so a `fortify` the applier somehow did not write would say so
    // instead of claiming a position that is not there.
    case 'FortifyUnit': {
      const unit = unitById(outcome.state, command.unitId);
      const dug = unit !== undefined && isFortified(unit);
      // M6b: the figure quoted below is the catalog's `fortifyBonusPct`, read from the
      // same ruleset the applier summed it out of — it was a constant of `combat.ts`
      // before this wave, and a line that restated it would go on printing the old
      // number after a sweep moved the real one.
      const { fortifyBonusPct } = combatRulesOf(ruleset);
      return (
        `ok: unit ${String(command.unitId)} is ${
          dug ? 'dug in where it stands' : 'NOT recorded as fortified'
        }` +
        (unit === undefined
          ? ' (it is no longer in the state, so there is nothing left to fortify)'
          : `; fortifying spends its remaining movement (${String(unit.movementLeft)} left), ` +
            'and a unit that moves away is no longer fortified. It is worth ' +
            `+${String(fortifyBonusPct)}% defence, and it emits no event, so this line is ` +
            'the record of it')
      );
    }
  }

  // Reached only when every member above was handled, which is what makes the tail
  // a compile error rather than a silent "nothing to report" for a new command.
  return assertNever(command);
};

/**
 * Column widths for the `units` table: marker, id, type, owner, at, move, hp, terrain,
 * job. (`hp` is M6's column: the width holds `12/12`, the widest count the shipped
 * catalog's hit points can produce.)
 */
const UNIT_WIDTHS: readonly number[] = [1, 2, 10, 11, 8, 7, 6, 11, 26];

/** A padded row: every cell but the last is padded to its column's width. */
const tableRow = (widths: readonly number[], cells: readonly string[]): string =>
  cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
    .join('  ');

export const createSession = (options: SessionOptions): ReplSession => {
  const { ruleset, playerId, god, write } = options;
  let state = options.state;

  const context = (
    unitId: UnitId | undefined,
    cityId: CityId | undefined,
    rates?: Rates,
  ): ErrorContext => ({
    state,
    ruleset,
    playerId,
    unitId,
    cityId,
    rates,
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
   *
   * M6 puts each unit's **hit points** beside its movement (`3/3 hp`), for the same
   * reason the job is there: this line rides under every view, so it is the one place a
   * damaged unit becomes visible without a second command. A unit one hit from death
   * that this line printed as though it were whole would make every attack decision the
   * agent takes from this line a guess.
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
        `(${String(unit.movementLeft)}/${max} movement, ${unitHitPoints(ruleset, unit)})${suffix}`
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
    // M4b: the economy, under every view. The money loop changes something on every
    // turn — income arrives, upkeep is charged, and a treasury that cannot pay
    // disbands units — so a figure the agent has to *ask* for is a figure it will
    // notice only after it has already gone bankrupt. It sits last, after the
    // things a command was probably about, and it is one line: the detail is a
    // `state` away.
    write(economyLine(state, playerId));
    // M5: research, beside the economy, for the same reason and with the same
    // arrival time. The pool is spent on the `end` that fills it, and a tech can
    // complete on a turn the player did not ask about it — so the running total, the
    // cost and the remainder are printed rather than offered. The line is
    // `researchStep`'s, the pipeline's own read, so it cannot predict a completion
    // the turn would not make.
    write(`${researchStanding(state, ruleset, playerId)}\n`);
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
          'hp',
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
            // M6: the whole reason the table needed a new column is that a *damaged*
            // unit has to be visible as damaged — every other column in this row
            // describes the unit as though a wound had not happened.
            unitHitPoints(ruleset, unit),
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

    // M5: what this player knows and what the tree offers next, in the state view.
    // Three lines at most, and each one is an engine read: the known ids are
    // `knownTechs` (canonical order, the same list the save's hash covers) and the
    // counts are `planSetResearch`'s verdicts, so "3 available, 12 blocked" cannot
    // disagree with what a `research` line would accept. The whole tree, with costs
    // and prerequisites, is the `tech` verb's job — this is the summary a player
    // wants beside the ledger.
    const me = playerStateOf(state, playerId);
    const known = me === undefined ? [] : knownTechs(me);
    const catalog = techCatalog(ruleset);
    const available = catalog.filter(
      (def) => planSetResearch(state, ruleset, playerId, def.id).ok,
    ).length;
    const techLines = [
      `tech: ${String(known.length)}/${String(catalog.length)} known` +
        (known.length === 0 ? ' (none yet)' : `: ${known.join(', ')}`),
      `tech: ${String(available)} researchable now, ` +
        `${String(Math.max(0, catalog.length - known.length - available))} blocked; ` +
        '"tech" prints the tree with costs and prerequisites',
    ];

    return (
      [
        `state: seed=${String(state.seed)} turn=${String(state.turn)} ` +
          `revision=${String(state.revision)} schema=${String(state.schemaVersion)} ` +
          `map=${state.settings.mapSize}(${String(state.map.width)}x` +
          `${String(state.map.height)}) civs=${String(civPlayers(state).length)}`,
        // M4b: the money, in full, before the census lines below it: "can I afford
        // this?" is the question a player opens the state view with, and it is
        // answered by the engine's own evaluators rather than by a second reading
        // of the economy rules here.
        ...economyDetailLines(state, ruleset, playerId),
        // M5: research, directly under the ledger it is paid from, because the pool
        // on the economy line and the cost on these lines are the same story.
        ...techLines,
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
      write(
        `${formatGameError(
          result.error,
          context(unitIdOf(command), cityIdOf(command), ratesOf(command)),
        )}\n`,
      );
      return { kind: 'refused', command, error: result.error };
    }

    state = result.value.state;
    write(`${outcomeText(result.value, command, ruleset, playerId)}\n`);
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
        write(helpText(combatRulesOf(ruleset)));
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

      /* ---------------- M4b: the economy ---------------- */

      case 'rates': {
        if (args.length !== 3) {
          return malformed(
            `"rates" needs 3 arguments: rates <tax> <science> <luxury> (got ` +
              `${String(args.length)})`,
            `example: rates 6 4 0  (the three must be integers >= 0 summing to exactly ` +
              `${String(RATE_TOTAL)})`,
          );
        }

        const tax = intOf(args[0]);
        const science = intOf(args[1]);
        const luxury = intOf(args[2]);
        if (tax === undefined || science === undefined || luxury === undefined) {
          return malformed(
            `tax, science and luxury must be whole numbers (got "${args[0] ?? ''}", ` +
              `"${args[1] ?? ''}" and "${args[2] ?? ''}")`,
            `example: rates 6 4 0  (the three must be integers >= 0 summing to exactly ` +
              `${String(RATE_TOTAL)})`,
          );
        }

        // The triple is handed to the engine exactly as parsed — including a
        // negative one or one that does not sum to `RATE_TOTAL`. The rate rule is
        // `economy.ts`' `ratesProblem`, reached through `planSetRates`, and the
        // refusal below is the engine's own `invalid-argument` naming the actual
        // sum. A check here would be this file's second opinion about what a rate
        // is, which is the one thing the REPL is not allowed to have.
        return applied({ type: 'SetRates', rates: { tax, science, luxury } });
      }

      /* ---------------- M5: research ---------------- */

      case 'research': {
        if (args.length !== 1) {
          return malformed(
            `"research" needs 1 argument: research <techId> (got ${String(args.length)})`,
            'example: research pottery  ("tech" lists every tech id, its cost and whether you ' +
              'may start it)',
          );
        }
        const tech = args[0] ?? '';
        if (tech === '') {
          return malformed(
            '"research" needs a tech id',
            'example: research pottery  ("tech" lists every tech id)',
          );
        }

        // The id is handed to the engine exactly as typed, in whatever case, and
        // without being checked against the catalog first: "is this a tech I may
        // research?" is `tech.ts`' `researchProblem`, reached through
        // `planSetResearch`, and the refusal below is the engine's own typed answer
        // (`unknown-tech`, `tech-already-known`, `tech-prerequisites-unmet`). A
        // lookup here would be this file's second opinion about the tree — and the
        // very thing the `tech` view exists to render instead.
        return applied({ type: 'SetResearch', tech: asTechId(tech) });
      }

      case 'tech': {
        if (args.length > 0) {
          return malformed(
            `"tech" takes no arguments (got "${args.join(' ')}") - it prints the whole tree`,
            'usage: tech  (then "research <techId>" chooses one)',
          );
        }
        write(`${techReport(state, ruleset, playerId)}\n`);
        return { kind: 'inspected', command: word };
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

      /* ---------------- M6: the combat verbs ---------------- */

      // `attack` is the same three arguments `move` takes — a unit id and a tile — and it
      // parses them the same way, for the same reasons: a coordinate off the map is an
      // *argument* error rather than a command the engine should see (`tileIndex` does not
      // validate, so x=500 on a 60-wide map would silently become column 20), and a unit id
      // that is not a whole number names no unit. The parsing is repeated rather than
      // shared because it is not a *rule*: the rules this verb obeys are all in the engine
      // (`planAttackUnit` decides adjacency, the target's contents and the movement cost),
      // and the REPL adds no opinion of its own about any of them. The one thing the REPL
      // does decide — because a command's payload cannot say it — is that `attack` is how a
      // player says "take that tile", whether the tile holds a unit (a battle) or an
      // undefended city (a capture); `planAttackUnit` picks between the two.
      case 'attack': {
        if (args.length !== 3) {
          return malformed(
            `"attack" needs 3 arguments: attack <unitId> <x> <y> (got ${String(args.length)})`,
            'example: attack 3 12 9  ("units" lists your unit ids and their hit points)',
          );
        }

        const unitId = intOf(args[0]);
        if (unitId === undefined) {
          return malformed(
            `unit id must be a whole number (got "${args[0] ?? ''}")`,
            'example: attack 3 12 9  ("units" lists your unit ids)',
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
          type: 'AttackUnit',
          unitId: asUnitId(unitId),
          target: tileIndex(state.map.width, x, y),
        });
      }

      // `fortify` takes the one argument `cancel` takes, and for the same reason: the
      // position *is* the unit's own, so there is no tile to name. What it does is stated
      // by the engine (`planFortifyUnit` requires ownership and movement left, and the
      // applier spends the rest of the turn), and what a reader gets back is the
      // `appliedCommandText` line, because this command emits no event.
      case 'fortify': {
        if (args.length !== 1) {
          return malformed(
            `"fortify" needs 1 argument: fortify <unitId> (got ${String(args.length)})`,
            'example: fortify 3  ("units" lists your unit ids)',
          );
        }
        const unitId = intOf(args[0]);
        if (unitId === undefined) {
          return malformed(
            `unit id must be a whole number (got "${args[0] ?? ''}")`,
            'example: fortify 3  ("units" lists your unit ids)',
          );
        }
        return applied({ type: 'FortifyUnit', unitId: asUnitId(unitId) });
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

  write(bannerText(state, ruleset, playerId, god));
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
