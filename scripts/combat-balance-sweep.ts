/**
 * Combat balance sweep — **does a combat knob actually change the fighting?**
 *
 * `npx tsx scripts/combat-balance-sweep.ts`
 *
 * ## What this measures, and what it refuses to claim
 *
 * M6 added combat: units attack, defenders get terrain, fortification, city and wall
 * bonuses, winners are promoted, losers are destroyed, and an undefended city changes
 * hands. Every one of those numbers is a knob somebody will want to turn, and the only
 * honest answer to "what would turning it do?" is a *measured* one. This script turns
 * one combat knob through a grid of values, plays the same seeds under every value, and
 * reports what moved: battles fought, battles won by the attacker, hit points traded,
 * units destroyed, promotions earned and cities captured.
 *
 * The measurement is deliberately about **battles**, not about a score. Nothing here
 * says a value is "good" or "balanced": the report says what happened, and a reader who
 * wants "balanced" has to bring their own definition to it.
 *
 * ## The replay, and the cross-check that keeps it honest
 *
 * `SimulationResult` carries no events, and every figure in the table is counted from
 * the event stream (`CombatResolved`, `UnitDestroyed`, `UnitPromoted`, `CityCaptured`)
 * — so this script replays each run exactly as `scripts/tech-balance-sweep.ts` does, for
 * the same reason and with the same guard: civilizations in player-id order, each
 * policy's commands applied with `EndTurn` skipped (the runner owns the turn boundary),
 * the policy context built with the runner's own `policyRngFor`, then `advanceTurn`.
 * **Every run is played both ways** — once by `runSimulation` and once by the replay —
 * and the two must agree on `turnsPlayed` and `finalHash` before a single figure is
 * reported. A disagreement is printed and exits non-zero instead of becoming a table.
 * That check is what makes a private loop here a reading of the engine's game rather
 * than a second game.
 *
 * A run that stops early (`stoppedBecause`) is reported with the turns it actually
 * played, because the engine's own turn count is the horizon — a variant whose games
 * die young is a finding, not a rounding error.
 *
 * ## The horizon the runner would cut short, and what this sweep does about it
 *
 * `runSimulation` **stops a run the moment an invariant fires** (`stoppedBecause:
 * 'violation'`). That is the right behaviour for a harness, and it is the reason this
 * sweep plays its runs with `invariants: []` and checks the registry **itself, every
 * turn, in the replay**: at the time of writing this project's engine trips
 * `city-food-conservation` and `city-shield-conservation` on some seeds, at turns that
 * depend on the *value of the knob* — which would truncate one value's games at turn 9
 * and another's at turn 40 and make every cumulative figure in the table incomparable.
 *
 * Nothing is hidden by that choice, and the report makes it loud: the replay checks the
 * **full core registry** (`CORE_INVARIANTS`) on every turn of every run, every violation
 * is printed with its predicate and turn, and a run that violates anything makes the
 * script exit non-zero. The predicates that fire are **not combat predicates** and are
 * not this sweep's to fix; what this sweep refuses to do is let them silently decide how
 * long a value's games last. `--stop-on-violation` restores the runner's own stop for a
 * reader who wants the strict game instead.
 *
 * ## The knob, and where it cannot go yet
 *
 * A knob is a `RulesetPatch` value built by `patchFor` and applied by
 * **`applyOverrides`** — the one supported way to move a shipped number, and the reason
 * every variant's `overrideRecord` is printed: a knob that silently failed to apply
 * would produce a beautiful table of nothing. The shipped value it moves is read *out
 * of* `@civts/rules`' catalog and printed beside it, so this script contains **no game
 * magnitude of its own**. The only numbers written here are the grid and the default
 * experiment size, which are experiment parameters rather than claims about the game.
 *
 * Five knobs are reachable today:
 *
 * - `warrior-attack` — `units.warrior.attack`;
 * - `grassland-defense` — `terrains.grassland.defenseBonusPct`;
 * - `walls-bonus` — `combat.wallsBonusPct`, the city-wall defence bonus;
 * - `damage-per-round` — `combat.damagePerRound`, the hit points one won round costs.
 * - `capture-divisor` — `capture.populationDivisor`, the population a taken city is left
 *   with (M7).
 *
 * **M6b closed the gap this file used to report.** Until then M6's nine combat magnitudes
 * were module constants in `@civts/core` with no `combat` section in `RulesetPatch`, so
 * this sweep could only say that they were unreachable *by construction* — the same
 * finding `scripts/tech-balance-sweep.ts` reports for tech prices. They now live in the
 * catalog, the applier merges them field by field, and two of them are swept below end to
 * end: the report prints the shipped value, the value each variant actually reads inside
 * the patched ruleset, and what moved.
 *
 * **M7 closed the last one.** `CAPTURE_POPULATION_DIVISOR` was a literal in
 * `packages/core/src/cities.ts` and was the second entry of the "cannot move" list; it is
 * the catalog's `capture` section now and is swept above. So the list is **empty**, which
 * is a claim this file checks rather than asserts: `uncoveredMagnitudes` walks the fields
 * of the `combat` and `capture` sections and fails the run if any of them is neither
 * swept nor declared. What remains beside it is a separate, honestly labelled list of
 * combat-adjacent *conventions* — the row id that decides which building carries walls —
 * which are not numbers and so were never this sweep's to move.
 *
 * ## What a flat table means, and how this report decides
 *
 * A knob whose values produce identical figures has proved nothing, and there are two
 * reasons for that which a reader cannot tell apart from the table: the knob does not
 * matter (a finding), or the knob was never *in play* in these runs (a limitation of the
 * measurement). The walls bonus spent two milestones looking like the first while being
 * the second, so the report now counts the exposure itself — the battles a walled
 * defender actually fought, the cities that actually changed hands — prints it whether or
 * not the table moved, and says in words which of the two a flat result is.
 *
 * ## Policy dependence, stated because it is load-bearing
 *
 * The runs are played by `SIMPLE_POLICY`, the shipped placeholder AI — so what is
 * measured is *this AI's* fighting under each value, not a human's and not M7's. The
 * policy decides to attack on the odds the applier itself reports
 * (`SIMPLE_POLICY_TUNING.attackOddsFloorPct`), which means a knob that raises the
 * attacker's strength can change *which attacks happen at all* as well as how they go.
 * That coupling is real, it is reported, and `--floor` varies the threshold so a reader
 * can see whether the effect survives it.
 *
 * ## Provenance
 *
 * Every catalog row this sweep moves is a `placeholder`: **unsourced, chosen to be
 * playable**. This script makes **no claim about Civ 3** — the table measures *this
 * project's* numbers against *this project's* engine.
 *
 * ## Reproducibility
 *
 * No clock, no `Math.random`, no ambient input: the report is a function of the flags
 * alone, so the same command prints the same table byte for byte. `--json` prints the
 * same structured value the table is rendered from.
 */

import {
  // M6b: the nine combat magnitudes this file used to import as `@civts/core` constants
  // are read from the *ruleset* below (`ruleset.combat.*`), through `applyOverrides` like
  // every other swept number. Importing them here would be the dual-source bug in the one
  // program whose job is to prove there is no second source. M7 removed the last such
  // import — `CAPTURE_POPULATION_DIVISOR` — for the same reason, one milestone later.
  //
  // `WALLS_BUILDING` is imported and is *not* a magnitude: it is the row id the engine
  // reads as "this city has defensive walls", which content names and no patch can move.
  // The sweep uses it to count how many battles a walled defender actually fought — the
  // difference between "the walls knob did nothing" and "no defender was ever behind a
  // wall", which is the one sentence this report must never leave out.
  WALLS_BUILDING,
  DEFAULT_SETTINGS,
  advanceTurn,
  applyCommand,
  civPlayers,
  newGame,
  type GameEvent,
  type GameState,
  type Settings,
} from '@civts/core';
import { CATALOG, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import {
  CORE_INVARIANTS,
  applyOverrides,
  checkInvariants,
  policyRngFor,
  runSimulation,
  simplePolicy,
  tryApplyOverrides,
  SIMPLE_POLICY_TUNING,
  type Policy,
  type RulesetPatch,
  type SimulationOptions,
  type Violation,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * The experiment
 * ------------------------------------------------------------------ */

/**
 * The knobs this sweep can turn, each a `RulesetPatch` producer.
 *
 * A knob is a **function of one value to one patch** rather than a dotted path with a
 * setter, because a patch is what `applyOverrides` consumes and building it here keeps
 * the sweep's shape identical to every other override caller's. `read` reports the
 * shipped value the knob starts from — read out of the catalog, never written here — so
 * the table can print what was moved rather than only what it was moved to.
 */
interface Knob {
  /** The knob's name on the command line. */
  readonly id: string;
  /** What it moves, as an override path. */
  readonly path: string;
  /** The default grid: whole numbers, ascending, `control` first where there is one. */
  readonly values: readonly number[];
  readonly patchFor: (value: number) => RulesetPatch;
  /** The shipped value, read from the validated catalog. */
  readonly read: (ruleset: Ruleset) => number;
  /** One line on what a higher value means. */
  readonly meaning: string;
}

const KNOBS: readonly Knob[] = [
  {
    id: 'warrior-attack',
    path: 'units.warrior.attack',
    values: [1, 2, 3, 4, 5],
    patchFor: (value) => ({ units: { warrior: { attack: value } } }),
    read: (ruleset) => unitAttack(ruleset, 'warrior'),
    meaning: 'the attack strength of every warrior — the unit both AIs field first',
  },
  {
    id: 'grassland-defense',
    path: 'terrains.grassland.defenseBonusPct',
    values: [0, 10, 25, 50, 100],
    patchFor: (value) => ({ terrains: { grassland: { defenseBonusPct: value } } }),
    read: (ruleset) => terrainDefense(ruleset, 'grassland'),
    meaning:
      'the terrain defence bonus on grassland — the tile most battles in this fixture happen on',
  },
  {
    // M6b's first combat global. It is the bonus a defender inside a city with walls gets
    // *on top of* the city bonus, so it is the knob for "how much does fortifying a city
    // matter" — and, because the policy decides to attack on the odds the applier reports
    // (`SIMPLE_POLICY_TUNING.attackOddsFloorPct`), raising it can also change *which*
    // attacks happen at all.
    id: 'walls-bonus',
    path: 'combat.wallsBonusPct',
    values: [0, 25, 50, 100],
    patchFor: (value) => ({ combat: { wallsBonusPct: value } }),
    read: (ruleset) => ruleset.combat.wallsBonusPct,
    meaning: 'the defence bonus a city wall adds, in whole percent',
  },
  {
    // M6b's second, and the one that moves the *shape* of a battle rather than its odds:
    // one won round costs the loser this many hit points, so raising it shortens every
    // battle. It is also the magnitude whose absence validation refuses outright, because
    // a round that costs nothing can never end a fight.
    id: 'damage-per-round',
    path: 'combat.damagePerRound',
    values: [1, 2, 3, 4],
    patchFor: (value) => ({ combat: { damagePerRound: value } }),
    read: (ruleset) => ruleset.combat.damagePerRound,
    meaning: 'the hit points one won combat round costs the loser',
  },
  {
    // **M7's knob, and the last magnitude M6 left in logic.** `cities.ts` used to hold
    // `CAPTURE_POPULATION_DIVISOR = 2` as a module constant, so this sweep could only
    // *report* that a capture's population was unreachable — the same finding M6b fixed
    // for the nine combat globals. It is a catalog section now, so it is swept like any
    // other number: `read` asks the patched ruleset what the divisor is, and the table's
    // capture column prints the populations the captures actually produced.
    id: 'capture-divisor',
    path: 'capture.populationDivisor',
    values: [1, 2, 3, 4, 8],
    patchFor: (value) => ({ capture: { populationDivisor: value } }),
    read: (ruleset) => ruleset.capture.populationDivisor,
    meaning:
      'the divisor applied to a captured city’s population (floored, never below one citizen)',
  },
];

/* ------------------------------------------------------------------ *
 * What a knob has to be *given* before its effect can be measured
 * ------------------------------------------------------------------ */

/**
 * What the run set must contain for the swept knob to have been **exercised at all**.
 *
 * This is the diagnosis the M7 repair asks for, and the reason it exists is a specific
 * failure of reporting: the walls-bonus sweep was flat for two milestones, and a flat
 * table has two entirely different explanations — *the walls bonus does not change this
 * game* (a finding about the knob) and *no defender in these runs ever stood behind a
 * wall* (a limitation of the measurement, and of the fixture, and of the policy). A
 * report that prints the table without saying which one it is invites the reader to
 * believe the first, which is the more flattering and the less true of the two.
 *
 * So every knob declares what it needs, the replay counts it from the event stream, and
 * the report prints the exposure **whether or not** the table moved. The counters are
 * read from the same `before` state `commands.ts` computes its own `inCity`/`walls`
 * flags from, so "a defender behind walls" here means exactly what it means in the odds.
 */
interface Exposure {
  /** What was counted, in the report's words. */
  readonly name: string;
  /** How many of what the denominator counts actually had the knob in play. */
  readonly count: number;
  /** The denominator — the battles fought, or the captures taken. */
  readonly of: number;
  /** What would have had to happen for the knob to be exercised. */
  readonly needs: string;
  /** The reading of `count === 0`, in the report's words. */
  readonly zeroMeans: string;
}

/** The counters the replay keeps for the exposure of each knob. */
interface ExposureCounters {
  readonly battles: number;
  readonly battlesAtCity: number;
  readonly battlesBehindWalls: number;
  readonly captures: number;
  readonly capturesWithPopulationAboveOne: number;
}

/** The exposure of the swept knob, read off the report's own totals. */
const exposureOf = (knob: Knob, counters: ExposureCounters): Exposure => {
  switch (knob.id) {
    case 'walls-bonus':
      return {
        name: 'battles fought by a defender inside its own walled city',
        count: counters.battlesBehindWalls,
        of: counters.battles,
        needs:
          'the `walls` building to actually be in a city a defender stands in, and a battle to ' +
          'be fought there: `combat.ts` reads this bonus only when the defender is in its own ' +
          'city AND that city holds the walls row',
        zeroMeans:
          'the walls bonus never entered a single odds computation in these runs, so this sweep ' +
          'measures nothing about the knob',
      };
    case 'capture-divisor':
      return {
        name:
          'captures of a city holding more than one citizen (the only captures a divisor can ' +
          'change the answer for)',
        count: counters.capturesWithPopulationAboveOne,
        of: counters.captures,
        needs:
          'a city with at least two citizens to change hands: the rule is ' +
          '`max(1, floor(population / divisor))`, so a one-citizen city is left with one citizen ' +
          'under every legal divisor and proves nothing about which one is set',
        zeroMeans:
          'no capture in these runs had more than one citizen to divide: either no city changed ' +
          'hands at all within the horizon, or every city that did held a single citizen — and a ' +
          'one-citizen city is left with one citizen by every legal divisor. So the knob was never ' +
          'in a position to change anything, which is a limitation of these runs rather than a ' +
          'statement about the knob',
      };
    default:
      return {
        name: 'battles fought',
        count: counters.battles,
        of: counters.battles,
        needs:
          'two civilizations to meet in force within the horizon, or the policy to clear its own ' +
          'odds floor',
        zeroMeans:
          'no battle was fought under any value, so there is nothing here for the knob to move',
      };
  }
};

/**
 * The combat-adjacent magnitudes **the override surface still cannot move**.
 *
 * M6b shrank this list from ten entries to two, and **M7 shrinks it to none.** The last
 * entry was `CAPTURE_POPULATION_DIVISOR`, and it left for the only reason that counts:
 * it is a `capture` section of the catalog now, `RulesetPatch.capture` reaches it, and
 * `capture-divisor` sweeps it above. An entry that stayed behind would make this report
 * lie about its own surface — the failure mode the list was added to prevent.
 *
/**
 * Empty is a *claim*, so it is a claim this file **checks** rather than one it asserts:
 * `uncoveredMagnitudes` walks every field of the catalog's `combat` and `capture`
 * sections and reports any that neither a knob above nor an entry here accounts for. A
 * tenth combat magnitude added to content without a knob fails that check and exits
 * non-zero — the day this list would otherwise start lying again.
 */
const UNREACHABLE: readonly {
  /** The catalog field, as a `section.field` path. */
  readonly path: string;
  /** The shipped magnitude, where there is one to read; omitted where the gap is a shape. */
  readonly value?: number;
  readonly needs: string;
}[] = [];

/**
 * The combat-adjacent things that are **not magnitudes at all**, kept beside the list
 * above so the two are never confused.
 *
 * The M7 check on this file was item 2 of the standing-requirement repairs: *verify what
 * remains of the "cannot move" list and that each remaining entry has a REAL stated
 * reason*. The one entry M6b left after the nine combat globals was the id convention
 * that decides which building carries walls, and on inspection its old wording ("nothing
 * can move it, and nothing should") was half a reason and half a shrug. What is true is
 * more specific, and it is checkable in the source:
 *
 * - the *identity* is a convention, not a number: `core/commands.ts` names
 *   `WALLS_BUILDING = asBuildingId('walls')` and reads `city.buildings.includes(...)`
 *   against it. There is no magnitude in that expression to sweep, which is why no patch
 *   can express it and why "unreachable" was always the wrong list for it.
 * - the *bonus* it gates is `combat.wallsBonusPct` — content, and swept by `walls-bonus`.
 * - every **number** on the walls row itself (cost, maintenance, prerequisites, era) is
 *   already reachable: `RulesetPatch.buildings` patches those rows field by field.
 *
 * So this is reported as what it is — a naming convention that is load-bearing and
 * documented — rather than as a knob somebody cannot turn.
 */
const CONVENTIONS: readonly { readonly name: string; readonly reason: string }[] = [
  {
    name: 'which building row is read as defensive walls',
    reason:
      'a convention rather than a magnitude: `core/commands.ts` builds its `walls` flag from ' +
      '`city.buildings.includes(WALLS_BUILDING)`, where `WALLS_BUILDING` is the row id "walls". ' +
      'There is no number here for a patch to move — the bonus it gates is the swept ' +
      '`combat.wallsBonusPct`, and every number on the walls row itself (cost, maintenance, ' +
      'era, prerequisites) is already patchable through `buildings`. A ruleset that renames ' +
      'that row simply grants no wall bonus, which is why the convention is documented in ' +
      '`commands.ts` rather than left to be discovered.',
  },
];

/** The non-magnitude field of every section, named so the filter below is not a mystery. */
const NON_MAGNITUDE_FIELDS: readonly string[] = ['provenance'];

/**
 * Every magnitude the catalog's combat and capture sections declare, as `section.field`.
 *
 * `provenance` is filtered out and that is not a loophole: authorship is deliberately
 * *not* a balance knob (`applyOverrides` carries provenance through a merge rather than
 * letting a patch rewrite it), so it is a field no sweep should ever be able to move. It
 * is named here rather than silently skipped.
 */
const MAGNITUDE_PATHS: readonly string[] = (['combat', 'capture'] as const).flatMap((section) =>
  Object.keys(CATALOG[section])
    .filter((field) => !NON_MAGNITUDE_FIELDS.includes(field))
    .map((field) => `${section}.${field}`),
);

/**
 * **The proof that the list above is empty because it should be**, one entry per magnitude
 * of the catalog's `combat` and `capture` sections.
 *
 * A claim of the form "every magnitude is content now and a sweep can move it" is worth
 * exactly as much as the machinery that would fail if it stopped being true, and a type is
 * not that machinery: `RulesetPatch`'s shape is checked at compile time, but *reachability*
 * is a runtime property of `applyOverrides` — a merge that dropped a field, a validator
 * that refused a legal value, a section the applier forgot to carry would all compile. So
 * each entry carries the value to probe the field with and the reader to check the answer
 * against, and `reachabilityFailures` applies the patch through `applyOverrides`, validates
 * the result and reads the field back. A magnitude that could not be moved that way — or
 * that moved and was not read back — is named in the report and exits non-zero.
 *
 * Three of these magnitudes also have a curated grid above (`KNOBS`): the walls bonus, the
 * damage per round and the capture divisor. The rest are proven reachable here and are not
 * part of this script's experiment, which is a choice about what is interesting to sweep
 * rather than a limit of the override surface. `uncoveredMagnitudes` compares this list
 * against the catalog, so a tenth combat magnitude added to content shows up as an
 * uncovered path rather than as a number nobody noticed.
 */
const REACHABILITY: readonly {
  readonly path: string;
  readonly patchFor: (value: number) => RulesetPatch;
  /** The value the probe moves the field to, and the value the reader must then report. */
  readonly probe: number;
  /** The field, read out of the *patched* ruleset — never out of the patch. */
  readonly read: (ruleset: Ruleset) => number;
}[] = [
  {
    path: 'combat.fortifyBonusPct',
    patchFor: (value) => ({ combat: { fortifyBonusPct: value } }),
    probe: 7,
    read: (ruleset) => ruleset.combat.fortifyBonusPct,
  },
  {
    path: 'combat.cityDefenseBonusPct',
    patchFor: (value) => ({ combat: { cityDefenseBonusPct: value } }),
    probe: 7,
    read: (ruleset) => ruleset.combat.cityDefenseBonusPct,
  },
  {
    path: 'combat.wallsBonusPct',
    patchFor: (value) => ({ combat: { wallsBonusPct: value } }),
    probe: 7,
    read: (ruleset) => ruleset.combat.wallsBonusPct,
  },
  {
    path: 'combat.veteranAttackPct',
    patchFor: (value) => ({ combat: { veteranAttackPct: value } }),
    probe: 7,
    read: (ruleset) => ruleset.combat.veteranAttackPct,
  },
  {
    path: 'combat.maxExperience',
    patchFor: (value) => ({ combat: { maxExperience: value } }),
    probe: 2,
    read: (ruleset) => ruleset.combat.maxExperience,
  },
  {
    // 200 rather than 100: the probe has to satisfy the clamp chain
    // (`1 <= minWinPct <= maxWinPct <= rollBound`) and the shipped `maxWinPct` is 99, so a
    // probe below that would be refused by validation and would look like an unreachable
    // magnitude rather than like a badly chosen probe.
    path: 'combat.rollBound',
    patchFor: (value) => ({ combat: { rollBound: value } }),
    probe: 200,
    read: (ruleset) => ruleset.combat.rollBound,
  },
  {
    path: 'combat.damagePerRound',
    patchFor: (value) => ({ combat: { damagePerRound: value } }),
    probe: 2,
    read: (ruleset) => ruleset.combat.damagePerRound,
  },
  {
    path: 'combat.minWinPct',
    patchFor: (value) => ({ combat: { minWinPct: value } }),
    probe: 2,
    read: (ruleset) => ruleset.combat.minWinPct,
  },
  {
    path: 'combat.maxWinPct',
    patchFor: (value) => ({ combat: { maxWinPct: value } }),
    probe: 98,
    read: (ruleset) => ruleset.combat.maxWinPct,
  },
  {
    path: 'capture.populationDivisor',
    patchFor: (value) => ({ capture: { populationDivisor: value } }),
    probe: 3,
    read: (ruleset) => ruleset.capture.populationDivisor,
  },
];

/**
 * The magnitudes above whose patch did **not** move what it named.
 *
 * Run at report time rather than assumed from the type; see `REACHABILITY`. A failure here
 * is a broken instrument, not a bad result — the report says so and `main` exits non-zero.
 */
const reachabilityFailures = (): readonly string[] => {
  const failures: string[] = [];
  for (const entry of REACHABILITY) {
    const patched = applyOverrides(CATALOG, entry.patchFor(entry.probe));
    const validated = validateRuleset(patched, 'tuned');
    if (!validated.ok) {
      failures.push(
        `${entry.path}: the probe patch was refused by validation (` +
          `${validated.error.map((issue) => issue.kind).join(', ')})`,
      );
      continue;
    }
    const read = entry.read(validated.value);
    if (read !== entry.probe) {
      failures.push(
        `${entry.path}: the patch applied but the ruleset reads ${String(read)} back, not ` +
          `${String(entry.probe)} — the field is not carried through the override`,
      );
    }
  }
  return failures;
};

/**
 * The catalog magnitudes **neither a knob, nor `UNREACHABLE`, nor a probe accounts for**.
 *
 * The check that keeps the three lists above honest. It is deliberately computed from the
 * *catalog* rather than from a list written here: the day content grows a tenth combat
 * magnitude, this returns its path, the report names it, and the process exits non-zero —
 * instead of the sweep quietly measuring nine numbers and letting the tenth be a literal
 * again. That is precisely how M6's nine globals survived a milestone.
 */
const uncoveredMagnitudes = (): readonly string[] =>
  MAGNITUDE_PATHS.filter(
    (path) =>
      !KNOBS.some((knob) => knob.path === path) &&
      !UNREACHABLE.some((row) => row.path === path) &&
      !REACHABILITY.some((entry) => entry.path === path),
  );

const DEFAULTS = {
  knob: 'warrior-attack',
  seedSpec: '1..3',
  turns: 60,
  floor: SIMPLE_POLICY_TUNING.attackOddsFloorPct,
  values: undefined as readonly number[] | undefined,
};

/** How many civilizations a run plays. Two is the minimum that can meet in a war. */
const CIV_COUNT = 2;
const MAP_SIZE = 'duel';

/* ------------------------------------------------------------------ *
 * Reading the shipped catalog
 * ------------------------------------------------------------------ */

const unitAttack = (ruleset: Ruleset, unit: string): number =>
  ruleset.units.find((row) => row.id === unit)?.attack ?? 0;

const terrainDefense = (ruleset: Ruleset, terrain: string): number =>
  ruleset.terrains.find((row) => row.id === terrain)?.defenseBonusPct ?? 0;

/** The validated shipped ruleset — never a hand-made view. */
const shippedRuleset = (): Ruleset => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error
        .map((issue) => issue.kind)
        .join(', ')}`,
    );
  }
  return validated.value;
};

/* ------------------------------------------------------------------ *
 * What one run did
 * ------------------------------------------------------------------ */

/** The events this sweep counts, tallied as they stream past. */
interface Tally {
  battles: number;
  attackerWins: number;
  defenderWins: number;
  /** Hit points the two sides lost to each other, summed over every battle. */
  combatDamage: number;
  unitsLostToCombat: number;
  unitsLostToUpkeep: number;
  promotions: number;
  citiesCaptured: number;
  /**
   * The populations of the captured cities, as the `CityCaptured` events reported them.
   *
   * The figure M7's capture divisor moves, and the reason a sweep of that knob can show a
   * measured effect at all: without it the divisor would only be visible through whatever
   * the surviving population did to the rest of the game.
   */
  capturedPopulation: number;
  /**
   * Captures whose city held **more than one citizen before the divisor was applied** —
   * the only captures in which the divisor's value can change the answer.
   *
   * The M7 exposure counter for that knob, and it is exact rather than a proxy: the rule
   * is `max(1, floor(population / divisor))`, so a one-citizen (or emptier) city is left
   * with one citizen under *every* legal divisor, and a run set made only of those
   * captures cannot say anything about the divisor no matter how many of them there are.
   * The pre-divisor population is read from the state the command was applied to, which is
   * the state `core/commands.ts` computed the capture from.
   */
  capturesWithPopulationAboveOne: number;
  /**
   * Battles fought on a tile holding a city owned by the defender — the engine's own
   * `inCity` condition, counted from the same state the engine read it from.
   */
  battlesAtCity: number;
  /**
   * Battles where that city also held the walls row: the engine's `walls` flag, and so
   * the exact set of battles in which `combat.wallsBonusPct` was read. See `Exposure`.
   */
  battlesBehindWalls: number;
}

const emptyTally = (): Tally => ({
  battles: 0,
  attackerWins: 0,
  defenderWins: 0,
  combatDamage: 0,
  unitsLostToCombat: 0,
  unitsLostToUpkeep: 0,
  promotions: 0,
  citiesCaptured: 0,
  capturedPopulation: 0,
  capturesWithPopulationAboveOne: 0,
  battlesAtCity: 0,
  battlesBehindWalls: 0,
});

/**
 * Fold one event into the tally.
 *
 * Every branch is a *reading of the event's own fields*: nothing is inferred from the
 * state, and nothing is counted that the stream did not say. A `CombatResolved` line
 * that says `attacker-wins` is the only thing that increments `attackerWins`, so a
 * resolver that flipped its verdict would move this table — which is the point.
 *
 * The one exception is the walls/city exposure of a battle, and it is not an inference
 * about the event but a **lookup in the state the command was applied to**: which city
 * stood on the defender's tile, who owned it, and whether that city held the walls row.
 * That is the same `before` state `core/commands.ts` computes its own `inCity` and
 * `walls` flags from (`city !== undefined && city.owner === plan.defender.owner`, then
 * `city.buildings.includes(WALLS_BUILDING)`), so "a battle behind walls" here is the
 * engine's own condition rather than this script's reading of it. Reading it from the
 * *post-command* state instead would lose exactly the interesting case — a walled city
 * that was taken, whose owner is the attacker by the time the event is seen.
 */
const tallyEvent = (tally: Tally, event: GameEvent, before: GameState): void => {
  switch (event.type) {
    case 'CombatResolved': {
      tally.battles += 1;
      if (event.outcome === 'attacker-wins') tally.attackerWins += 1;
      else tally.defenderWins += 1;
      tally.combatDamage += event.attackerLost + event.defenderLost;
      const city = before.cities.find((candidate) => candidate.tile === event.target);
      const inCity = city !== undefined && city.owner === event.defenderOwner;
      if (inCity) tally.battlesAtCity += 1;
      if (inCity && city.buildings.includes(WALLS_BUILDING)) tally.battlesBehindWalls += 1;
      return;
    }
    case 'UnitDestroyed':
      if (event.reason === 'combat') tally.unitsLostToCombat += 1;
      else tally.unitsLostToUpkeep += 1;
      return;
    case 'UnitPromoted':
      tally.promotions += 1;
      return;
    case 'CityCaptured': {
      tally.citiesCaptured += 1;
      tally.capturedPopulation += event.population;
      // The *pre-divisor* population, from the state the capture was applied to: the event
      // reports what the city was left with, and "was left with one" is not the same
      // question as "had one to divide".
      const taken = before.cities.find((candidate) => candidate.id === event.cityId);
      if (taken !== undefined && taken.population > 1) tally.capturesWithPopulationAboveOne += 1;
      return;
    }
    default:
      return;
  }
};

/** One seed's run, as both the harness and the replay saw it. */
interface SeedRun {
  readonly seed: number;
  readonly turnsPlayed: number;
  readonly finalHash: string;
  readonly stoppedBecause: string;
  readonly violations: number;
  /** The invariants this run's violations named, in the order they were reported. */
  readonly violationNames: readonly string[];
  readonly tally: Tally;
  /** Units and cities the horizon left on the board. */
  readonly unitsAtHorizon: number;
  readonly citiesAtHorizon: number;
  /** How many of those units each civilization owns, keyed by player id. */
  readonly civUnitsAtHorizon: number;
}

interface Flag {
  readonly ok: boolean;
  readonly error?: string;
  readonly json?: boolean;
  readonly help?: boolean;
  readonly knob?: string;
  readonly values?: readonly number[];
  readonly seedSpec?: string;
  readonly turns?: number;
  readonly floor?: number;
  readonly stopOnViolation?: boolean;
}

const parseFlags = (argv: readonly string[]): Flag => {
  let knob: string = DEFAULTS.knob;
  let values: readonly number[] | undefined = DEFAULTS.values;
  let seedSpec: string = DEFAULTS.seedSpec;
  let turns: number = DEFAULTS.turns;
  let floor: number = DEFAULTS.floor;
  let stopOnViolation = false;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    const take = (): string | undefined => {
      if (next === undefined || next.startsWith('--')) return undefined;
      index += 1;
      return next;
    };

    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--stop-on-violation') {
      stopOnViolation = true;
      continue;
    }
    if (flag === '--knob') {
      const value = take();
      if (value === undefined) return { ok: false, error: '--knob needs a value' };
      knob = value;
      continue;
    }
    if (flag === '--values') {
      const value = take();
      if (value === undefined) return { ok: false, error: '--values needs a value' };
      const parts = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      if (parts.length === 0) return { ok: false, error: '--values needs at least one value' };
      const parsed: number[] = [];
      for (const part of parts) {
        const numeric = Number(part);
        if (!Number.isInteger(numeric) || numeric < 0) {
          return { ok: false, error: `--values must be whole numbers >= 0 (got "${part}")` };
        }
        parsed.push(numeric);
      }
      values = parsed;
      continue;
    }
    if (flag === '--seeds') {
      const value = take();
      if (value === undefined) return { ok: false, error: '--seeds needs a value' };
      seedSpec = value;
      continue;
    }
    if (flag === '--turns' || flag === '--floor') {
      const value = take();
      if (value === undefined) return { ok: false, error: `${flag} needs a value` };
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < 0) {
        return { ok: false, error: `${flag} must be a whole number >= 0 (got "${value}")` };
      }
      if (flag === '--turns') turns = numeric;
      else floor = numeric;
      continue;
    }
    return { ok: false, error: `unknown flag "${String(flag)}"` };
  }

  // The optional fields are *omitted* when they hold nothing rather than written as
  // `undefined` (`exactOptionalPropertyTypes`), which is the same rule the state itself
  // follows and the one bug class this project has been bitten by before.
  return {
    ok: true,
    json,
    help,
    knob,
    seedSpec,
    turns,
    floor,
    ...(values === undefined ? {} : { values }),
    ...(stopOnViolation ? { stopOnViolation: true } : {}),
  };
};

/** `"1,4,7"` or `"1..10"` — ascending and duplicate-free. */
const parseSeeds = (spec: string): readonly number[] => {
  const seeds = new Set<number>();
  for (const part of spec.split(',')) {
    const text = part.trim();
    if (text === '') continue;
    const range = /^(\d+)\.\.(\d+)$/.exec(text);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
        throw new Error(`bad seed range "${text}"`);
      }
      for (let seed = from; seed <= to; seed += 1) seeds.add(seed);
      continue;
    }
    const single = Number(text);
    if (!Number.isInteger(single) || single < 0) throw new Error(`bad seed "${text}"`);
    seeds.add(single);
  }
  if (seeds.size === 0) throw new Error('no seeds');
  return [...seeds].sort((a, b) => a - b);
};

/* ------------------------------------------------------------------ *
 * Playing one run twice
 * ------------------------------------------------------------------ */

const settingsFor = (seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  seed,
  mapSize: MAP_SIZE,
  civCount: CIV_COUNT,
});

const optionsFor = (
  seed: number,
  ruleset: Ruleset,
  policies: readonly Policy[],
  turns: number,
  stopOnViolation: boolean,
): SimulationOptions => ({
  seed,
  settings: settingsFor(seed),
  ruleset,
  policies,
  maxTurns: turns,
  // `[]` — not `undefined` — is "no registry": the runner reads an *absent* `invariants`
  // as the core registry (`options.invariants ?? CORE_INVARIANTS`), so the strict game is
  // what you get by leaving the field out. This sweep checks the registry itself, in the
  // replay, so that every value is measured over the same horizon — see the module note.
  ...(stopOnViolation ? {} : { invariants: [] }),
});

/** The replay's own view of a finished run: the state it reached and what happened. */
interface Replayed {
  readonly turnsPlayed: number;
  readonly state: GameState;
  readonly tally: Tally;
  /** What the **full core registry** said about each turn of this run. */
  readonly violations: readonly Violation[];
}

/**
 * Play one run by hand, collecting the events `runSimulation` throws away.
 *
 * This is the runner's loop, restated (the module note says why it has to be), and the
 * caller cross-checks it against the harness before trusting any of it. `EndTurn` is
 * skipped because the runner owns the turn boundary; `policyRngFor` is the runner's own
 * per-policy stream, so the policies draw exactly what they drew under the harness.
 */
const replay = (
  seed: number,
  ruleset: Ruleset,
  policies: readonly Policy[],
  turns: number,
): Replayed => {
  const violations: Violation[] = [];
  const created = newGame(seed, settingsFor(seed), ruleset);
  if (!created.ok) throw new Error(`newGame(${String(seed)}) failed: ${created.error.kind}`);
  let state = created.value;
  const tally = emptyTally();
  let turnsPlayed = 0;

  for (let step = 0; step < turns; step += 1) {
    // The turn boundary every transition invariant is measured against: the state before
    // this turn's commands, exactly as the runner takes it (see `invariants.ts` on why
    // `previous` is a boundary rather than the state the pipeline started from).
    const previous = state;
    const seen: GameEvent[] = [];

    for (const player of civPlayers(state)) {
      const policy = policies[player.id % policies.length] ?? policies[0];
      if (policy === undefined) throw new Error('the sweep has no policy to play with');
      const ctx = {
        state,
        playerId: player.id,
        ruleset,
        rng: policyRngFor(seed, player.id, state.turn),
      };
      for (const command of policy.chooseCommands(ctx)) {
        if (command.type === 'EndTurn') continue;
        const before = state;
        const outcome = applyCommand(state, player.id, command, ruleset);
        if (!outcome.ok) continue;
        state = outcome.value.state;
        for (const event of outcome.value.events) {
          tallyEvent(tally, event, before);
          seen.push(event);
        }
      }
    }

    // `before` for the turn boundary is the state the advance was applied to, for the same
    // reason: a barbarian attack on a walled city must be counted against the city as it
    // stood when the attack happened.
    const beforeAdvance = state;
    const advanced = advanceTurn(state, ruleset);
    state = advanced.state;
    for (const event of advanced.events) {
      tallyEvent(tally, event, beforeAdvance);
      seen.push(event);
    }
    turnsPlayed += 1;

    // The same call the runner makes, on the same boundary, with the same registry — so
    // the violations this sweep reports are the ones the harness *would* have stopped on,
    // measured without letting them decide the horizon.
    violations.push(
      ...checkInvariants(
        {
          state,
          previous,
          ruleset,
          rulesetView: ruleset,
          events: seen,
          turn: state.turn,
        },
        CORE_INVARIANTS,
      ),
    );
  }

  return { turnsPlayed, state, tally, violations };
};

const runOnce = (
  seed: number,
  ruleset: Ruleset,
  policies: readonly Policy[],
  turns: number,
  stopOnViolation: boolean,
): { readonly run: SeedRun; readonly disagreement?: string } => {
  const harness = runSimulation(optionsFor(seed, ruleset, policies, turns, stopOnViolation));

  // **The harness's own horizon, not the requested one.** The runner stops a run the
  // moment an invariant fires (`stoppedBecause: 'violation'`), so replaying the full
  // `turns` would count events from a game nobody played and compare two states that
  // are legitimately different. The replay therefore plays exactly as many turns as the
  // harness reported, and every figure below belongs to that game.
  const played = replay(seed, ruleset, policies, harness.turnsPlayed);

  // The cross-check, before any figure is believed. A replay that diverges from the
  // harness is a second game, and a table built from it would be a table about this
  // script rather than about the engine.
  let disagreement: string | undefined;
  if (played.turnsPlayed !== harness.turnsPlayed) {
    disagreement =
      `seed ${String(seed)}: the replay played ${String(played.turnsPlayed)} turns, the ` +
      `harness ${String(harness.turnsPlayed)}`;
  } else if (!sameState(played.state, harness.finalState)) {
    disagreement =
      `seed ${String(seed)}: the replay's final state differs from the harness's after the ` +
      'same turns (the event tallies cannot be trusted)';
  }

  return {
    run: {
      seed,
      turnsPlayed: harness.turnsPlayed,
      finalHash: harness.finalHash,
      stoppedBecause: harness.stoppedBecause,
      // The **replay's** registry check, not the harness's field: the harness was told
      // to skip the registry so the horizon is the requested one, and the check that
      // would have stopped it happens in the replay instead. Under
      // `--stop-on-violation` both agree, because the harness stops where the replay's
      // first violation is reported.
      violations: played.violations.length,
      violationNames: played.violations.map((violation) => violation.invariant),
      tally: played.tally,
      unitsAtHorizon: played.state.units.length,
      citiesAtHorizon: played.state.cities.length,
      civUnitsAtHorizon: civPlayers(played.state).reduce(
        (total, player) =>
          total + played.state.units.filter((unit) => unit.owner === player.id).length,
        0,
      ),
    },
    ...(disagreement === undefined ? {} : { disagreement }),
  };
};

/**
 * The same state, compared through the **hash** the harness itself pins runs with.
 *
 * Comparing `turnsPlayed` and the final hash is the discipline
 * `scripts/tech-balance-sweep.ts` uses and it is the weaker half of what is available
 * here: `runSimulation` hands back `finalState`, so the two worlds can be compared
 * byte for byte through the canonical form rather than by a digest of it. `hashValue`
 * is that form, so this is `canonicalize` by another name — and it needs no import of
 * the testing package into a script the CLI ships.
 */
const sameState = (a: GameState, b: GameState): boolean => {
  const key = (state: GameState): string =>
    JSON.stringify([
      state.turn,
      state.revision,
      state.units.map((unit) => [unit.id, unit.owner, unit.tile, unit.hitPointsLeft ?? null]),
      state.cities.map((city) => [city.id, city.owner, city.population, city.buildings]),
      state.players.map((player) => [player.id, player.treasury]),
    ]);
  return key(a) === key(b);
};

/* ------------------------------------------------------------------ *
 * Variants
 * ------------------------------------------------------------------ */

/** One value of the knob, over every seed. */
interface Variant {
  readonly value: number;
  readonly label: string;
  /** What `applyOverrides` recorded for this value's patch — the knob's own receipt. */
  readonly overrideRecord: readonly string[];
  /** The value the knob actually reads in the patched ruleset. */
  readonly effective: number;
  readonly seeds: readonly SeedRun[];
  /** Turns actually played, summed over the seeds (the runner stops early on a violation). */
  readonly turnsPlayed: number;
  readonly battles: number;
  readonly attackerWins: number;
  readonly defenderWins: number;
  readonly combatDamage: number;
  readonly unitsLostToCombat: number;
  readonly unitsLostToUpkeep: number;
  readonly promotions: number;
  readonly citiesCaptured: number;
  /** The populations those captured cities were left with, summed. */
  readonly capturedPopulation: number;
  /** Captures whose city held more than one citizen *before* the divisor was applied. */
  readonly capturesWithPopulationAboveOne: number;
  /** Battles fought on a tile holding a city owned by the defender (the engine's `inCity`). */
  readonly battlesAtCity: number;
  /** …of which the city held the walls row (the engine's `walls` flag). */
  readonly battlesBehindWalls: number;
  readonly unitsAtHorizon: number;
  readonly citiesAtHorizon: number;
  /** The attacker's share of the battles, in whole percent — absent when none were fought. */
  readonly attackerWinPct?: number;
}

interface CombatSweepReport {
  readonly knob: string;
  readonly knobMeaning: string;
  readonly shippedValue: number;
  readonly seedSpec: string;
  readonly seeds: readonly number[];
  readonly turns: number;
  readonly mapSize: string;
  readonly civCount: number;
  readonly policy: string;
  readonly attackOddsFloorPct: number;
  readonly variants: readonly Variant[];
  /** The magnitudes the override surface cannot express, with what would be needed. */
  readonly unreachable: readonly {
    readonly path: string;
    /** Absent where the gap is a *shape* rather than a number (see `UNREACHABLE`). */
    readonly value?: number;
    readonly needs: string;
  }[];
  /**
   * The combat-adjacent things that are not magnitudes at all (see `CONVENTIONS`), kept
   * apart from the list above so "nothing is unreachable" cannot be read as "nothing is
   * unwritten".
   */
  readonly conventions: readonly { readonly name: string; readonly reason: string }[];
  /**
   * Catalog magnitudes neither a knob, nor `UNREACHABLE`, nor a probe accounts for.
   * Non-empty means this report is incomplete, and `main` exits non-zero rather than
   * publishing it.
   */
  readonly uncovered: readonly string[];
  /**
   * The magnitudes this file proved it can move, by applying a patch through
   * `applyOverrides` and reading the field back (see `REACHABILITY`). Printed because it is
   * the evidence behind the empty list above, not a decoration: the count is the whole
   * argument that "every combat number is content now" is a checked statement.
   */
  readonly reachability: {
    readonly proven: number;
    readonly total: number;
    /** The paths proven, in the order they are declared. */
    readonly paths: readonly string[];
    /** …and the ones that failed, which make the report worthless — see `main`. */
    readonly failures: readonly string[];
  };
  /** Whether the swept knob was exercised at all — the reading a flat table needs. */
  readonly exposure: Exposure;
  /** Where the replay disagreed with the harness — fatal, and reported as such. */
  readonly disagreements: readonly string[];
  readonly violations: readonly string[];
  readonly caveats: readonly string[];
}

/**
 * The ruleset a value runs on, and the patch's own receipt.
 *
 * **`applyOverrides` is the path** — the one supported way to move a shipped number, and
 * the function this sweep must go through for the ruleset it plays on. The *receipt*
 * (which rows the patch touched) lives on `tryApplyOverrides`' outcome, which is the same
 * call returning a `Result` instead of throwing; it is asked for separately, on the same
 * patch, so a refusal is reported as a message rather than as a stack trace. `effective`
 * is then read out of the catalog `applyOverrides` returned — the receipt is printed, but
 * nothing is *trusted* from it.
 */
const patchedRuleset = (
  knob: Knob,
  value: number,
): {
  readonly ruleset: Ruleset;
  readonly record: readonly string[];
  readonly effective: number;
} => {
  const catalog: Catalog = applyOverrides(CATALOG, knob.patchFor(value));
  const validated = validateRuleset(catalog, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the patched catalog does not validate at ${knob.path} = ${String(value)}: ` +
        validated.error.map((issue) => issue.kind).join(', '),
    );
  }
  const receipt = tryApplyOverrides(CATALOG, knob.patchFor(value));
  return {
    ruleset: validated.value,
    record: receipt.ok ? receipt.value.applied : [],
    effective: knob.read(validated.value),
  };
};

const buildVariant = (
  knob: Knob,
  value: number,
  seeds: readonly number[],
  turns: number,
  floor: number,
  stopOnViolation: boolean,
): { readonly variant: Variant; readonly disagreements: readonly string[] } => {
  const patched = patchedRuleset(knob, value);
  const policies = [
    simplePolicy({ attackOddsFloorPct: floor }),
    simplePolicy({ attackOddsFloorPct: floor }),
  ];

  const runs: SeedRun[] = [];
  const disagreements: string[] = [];
  for (const seed of seeds) {
    const { run, disagreement } = runOnce(seed, patched.ruleset, policies, turns, stopOnViolation);
    runs.push(run);
    if (disagreement !== undefined) disagreements.push(disagreement);
  }

  const sum = (pick: (run: SeedRun) => number): number =>
    runs.reduce((total, run) => total + pick(run), 0);

  const battles = sum((run) => run.tally.battles);
  const attackerWins = sum((run) => run.tally.attackerWins);

  return {
    variant: {
      value,
      label: `${knob.path} = ${String(value)}`,
      overrideRecord: patched.record,
      effective: patched.effective,
      seeds: runs,
      turnsPlayed: sum((run) => run.turnsPlayed),
      battles,
      attackerWins,
      defenderWins: sum((run) => run.tally.defenderWins),
      combatDamage: sum((run) => run.tally.combatDamage),
      unitsLostToCombat: sum((run) => run.tally.unitsLostToCombat),
      unitsLostToUpkeep: sum((run) => run.tally.unitsLostToUpkeep),
      promotions: sum((run) => run.tally.promotions),
      citiesCaptured: sum((run) => run.tally.citiesCaptured),
      capturedPopulation: sum((run) => run.tally.capturedPopulation),
      capturesWithPopulationAboveOne: sum((run) => run.tally.capturesWithPopulationAboveOne),
      battlesAtCity: sum((run) => run.tally.battlesAtCity),
      battlesBehindWalls: sum((run) => run.tally.battlesBehindWalls),
      unitsAtHorizon: sum((run) => run.unitsAtHorizon),
      citiesAtHorizon: sum((run) => run.citiesAtHorizon),
      // A rate over no battles is not zero, it is *unmeasured* — which is why this is
      // absent rather than 0, and why the renderer prints a word for it.
      ...(battles === 0 ? {} : { attackerWinPct: Math.floor((attackerWins * 100) / battles) }),
    },
    disagreements,
  };
};

const buildReport = (
  knob: Knob,
  values: readonly number[],
  seeds: readonly number[],
  turns: number,
  floor: number,
  stopOnViolation: boolean,
): CombatSweepReport => {
  const variants: Variant[] = [];
  const disagreements: string[] = [];

  for (const value of values) {
    const built = buildVariant(knob, value, seeds, turns, floor, stopOnViolation);
    variants.push(built.variant);
    disagreements.push(...built.disagreements);
  }

  const violations: string[] = [];
  const byInvariant = new Map<string, number>();
  let truncated = 0;
  for (const variant of variants) {
    for (const run of variant.seeds) {
      if (run.violations === 0) continue;
      truncated += 1;
      for (const name of run.violationNames) {
        byInvariant.set(name, (byInvariant.get(name) ?? 0) + 1);
      }
      violations.push(
        `${variant.label} seed ${String(run.seed)}: ${String(run.violations)} invariant ` +
          `violation(s) at turn ${String(run.turnsPlayed)} (${run.violationNames.join(', ')}) — ` +
          'the runner STOPPED this run there, so its figures cover a shorter horizon',
      );
    }
  }
  if (truncated > 0) {
    violations.push(
      `${String(truncated)} of ${String(variants.reduce((total, variant) => total + variant.seeds.length, 0))} ` +
        'runs were cut short by the runner itself. Each one is named above by the invariant it ' +
        "tripped; those predicates are not this sweep's, and this sweep neither hides them nor " +
        'pretends the horizon was the requested one.',
    );
  }

  const caveats: string[] = [
    'the runs are played by SIMPLE_POLICY, the shipped placeholder AI (M7 replaces it), so ' +
      "these are that policy's battles and not a human's",
    `the policy attacks only at odds >= ${String(floor)}% (SIMPLE_POLICY_TUNING.attackOddsFloorPct), ` +
      'so a value that changes the odds can change WHICH attacks happen as well as how they go',
    'figures are cumulative over each run unless the column says "at the horizon"',
    stopOnViolation
      ? 'the runner stopped each run at its first invariant violation, so `turns` is the mean over ' +
        'the seeds and a value whose runs trip an invariant earlier is measured over a shorter game'
      : 'every run played the full horizon: the runner was given an empty registry and the FULL core ' +
        'registry is checked here instead, every turn, so a violation cannot decide how long a ' +
        'value is measured for (see the module note) — a violation still exits non-zero',
    `${String(seeds.length)} seed(s) of ${MAP_SIZE} maps with ${String(CIV_COUNT)} civilizations: ` +
      'a small sample, reported as a sum rather than as a mean with a confidence claim',
  ];

  // The exposure is computed from the variants' own counters, so it is a reading of what
  // the runs did rather than a claim about what they should have done.
  const totals: ExposureCounters = {
    battles: variants.reduce((total, variant) => total + variant.battles, 0),
    battlesAtCity: variants.reduce((total, variant) => total + variant.battlesAtCity, 0),
    battlesBehindWalls: variants.reduce((total, variant) => total + variant.battlesBehindWalls, 0),
    captures: variants.reduce((total, variant) => total + variant.citiesCaptured, 0),
    capturesWithPopulationAboveOne: variants.reduce(
      (total, variant) => total + variant.capturesWithPopulationAboveOne,
      0,
    ),
  };
  const exposure = exposureOf(knob, totals);

  return {
    knob: knob.path,
    knobMeaning: knob.meaning,
    shippedValue: knob.read(shippedRuleset()),
    seedSpec: seeds.join(','),
    seeds,
    turns,
    mapSize: MAP_SIZE,
    civCount: CIV_COUNT,
    policy: 'simple-placeholder',
    attackOddsFloorPct: floor,
    variants,
    unreachable: UNREACHABLE,
    conventions: CONVENTIONS,
    uncovered: uncoveredMagnitudes(),
    reachability: {
      proven: REACHABILITY.length - reachabilityFailures().length,
      total: REACHABILITY.length,
      paths: REACHABILITY.map((entry) => entry.path),
      failures: reachabilityFailures(),
    },
    exposure,
    disagreements,
    violations,
    caveats,
  };
};

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/** A whole number in a fixed-width column; `-` for a figure that was not measured. */
const cell = (value: number | undefined, width: number): string =>
  (value === undefined ? '-' : String(value)).padStart(width);

const renderReport = (report: CombatSweepReport): string => {
  const lines: string[] = [];
  lines.push('combat balance sweep');
  lines.push(`  knob:      ${report.knob} (${report.knobMeaning})`);
  lines.push(`  shipped:   ${String(report.shippedValue)}`);
  lines.push(`  grid:      ${report.variants.map((variant) => String(variant.value)).join(', ')}`);
  lines.push(`  seeds:     ${report.seeds.join(', ')} (${MAP_SIZE}, ${String(CIV_COUNT)} civs)`);
  lines.push(`  turns:     ${String(report.turns)}`);
  lines.push(
    `  policy:    ${report.policy} (attack at odds >= ${String(report.attackOddsFloorPct)}%)`,
  );
  lines.push('');

  lines.push(
    '  value  eff | turns | battles  atk-win  win% | damage | units lost  (combat/upkeep) | promos | captures/pop | city/wall | units@H cities@H',
  );
  lines.push(
    '  -----------+-------+------------------------+--------+---------------------------+--------+--------------+-----------+-----------------',
  );
  for (const variant of report.variants) {
    lines.push(
      `  ${cell(variant.value, 5)}  ${cell(variant.effective, 3)} | ` +
        `${cell(Math.floor(variant.turnsPlayed / Math.max(variant.seeds.length, 1)), 5)} | ` +
        `${cell(variant.battles, 7)}  ${cell(variant.attackerWins, 7)}  ${cell(variant.attackerWinPct, 4)} | ` +
        `${cell(variant.combatDamage, 6)} | ` +
        `${cell(variant.unitsLostToCombat + variant.unitsLostToUpkeep, 10)}  ` +
        `(${String(variant.unitsLostToCombat)}/${String(variant.unitsLostToUpkeep)})`.padEnd(17) +
        ` | ${cell(variant.promotions, 6)} | ` +
        `${cell(variant.citiesCaptured, 6)}/${cell(variant.capturedPopulation, 4)} | ` +
        `${cell(variant.battlesAtCity, 4)}/${cell(variant.battlesBehindWalls, 4)} | ` +
        `${cell(variant.unitsAtHorizon, 6)} ${cell(variant.citiesAtHorizon, 8)}`,
    );
  }
  lines.push('');
  lines.push(
    '  turns is the MEAN over the seeds, and it is printed because the runner stops a run on an ' +
      'invariant violation: a short figure is a short game.',
  );
  lines.push(
    "  win% is the ATTACKER's share of the battles (the per-round odds are the engine's; this " +
      'column is what actually happened).',
  );
  lines.push(
    '  eff is what the knob reads inside the patched ruleset — a value the override refused would ' +
      'show up here.',
  );
  lines.push(
    '  captures/pop is cities taken and the population they were left with; city/wall is battles ' +
      'fought on a tile holding a city owned by the defender, and how many of those cities held ' +
      'the walls row. See EXPOSURE below: those two counters are what separate a knob that did ' +
      'nothing from a knob that was never in play.',
  );
  lines.push('');

  // The exposure line, printed **whether or not** the table moved. This is the sentence the
  // M7 repair asks for: a flat walls table is not evidence until the report says whether any
  // defender ever stood behind a wall.
  lines.push('EXPOSURE (what the swept knob was actually given)');
  lines.push(
    `  ${report.exposure.name}: ${String(report.exposure.count)} of ${String(report.exposure.of)}`,
  );
  lines.push(`  needs: ${report.exposure.needs}`);
  if (report.exposure.count === 0) lines.push(`  NOT EXERCISED — ${report.exposure.zeroMeans}`);
  lines.push('');

  // The knob's receipt: what `applyOverrides` said it did.
  const record = report.variants.flatMap((variant) =>
    variant.overrideRecord.map((line) => `${variant.label}: ${line}`),
  );
  lines.push(`override record (${String(record.length)} line(s))`);
  if (record.length === 0)
    lines.push('  (none — the patch applied nothing, which would make every row identical)');
  for (const line of record) lines.push(`  ${line}`);
  lines.push('');

  lines.push(
    'combat and capture magnitudes this override surface CANNOT move (reported, not swept)',
  );
  if (report.unreachable.length === 0) {
    lines.push(
      '  (none — every magnitude of the combat and capture sections is content: the applier ' +
        'carries it and validation accepts it, which is what the reachability check below ' +
        'measures one field at a time)',
    );
  }
  for (const row of report.unreachable) {
    const value = row.value === undefined ? '' : ` = ${String(row.value)}`;
    lines.push(`  ${row.path}${value}  — needs ${row.needs}`);
  }
  lines.push('');

  // The check behind that empty list: each magnitude, patched and read back.
  lines.push(
    `reachability of every combat/capture magnitude: ${String(report.reachability.proven)} of ` +
      `${String(report.reachability.total)} moved through applyOverrides and read back`,
  );
  for (const path of report.reachability.paths) lines.push(`  ok   ${path}`);
  for (const failure of report.reachability.failures) lines.push(`  FAIL ${failure}`);
  lines.push('');

  // Not magnitudes — reported beside the list above so "nothing is unreachable" cannot be
  // read as "every combat-adjacent decision is a knob".
  lines.push('combat-adjacent decisions that are NOT magnitudes (nothing to sweep, by design)');
  for (const row of report.conventions) lines.push(`  ${row.name}  — ${row.reason}`);
  lines.push('');

  if (report.uncovered.length > 0) {
    lines.push(
      `UNACCOUNTED MAGNITUDES (${String(report.uncovered.length)}) — this report is incomplete`,
    );
    lines.push(
      '  these catalog fields are neither swept by a knob nor declared unreachable, so this ' +
        'sweep cannot say anything about them:',
    );
    for (const path of report.uncovered) lines.push(`  ${path}`);
    lines.push('');
  }

  if (report.disagreements.length > 0) {
    lines.push(
      `REPLAY DISAGREEMENTS (${String(report.disagreements.length)}) — the table above is not a ` +
        'reading of the engine',
    );
    for (const line of report.disagreements) lines.push(`  ${line}`);
    lines.push('');
  }

  if (report.violations.length > 0) {
    lines.push(
      `VIOLATIONS (${String(report.violations.length)}) — the table above is not evidence`,
    );
    for (const line of report.violations) lines.push(`  ${line}`);
    lines.push('');
  }

  for (const caveat of report.caveats) lines.push(`CAVEAT: ${caveat}`);
  if (report.caveats.length > 0) lines.push('');

  return lines.join('\n');
};

/* ------------------------------------------------------------------ *
 * Does the knob prove anything?
 * ------------------------------------------------------------------ */

/**
 * Whether any measured figure moved with the knob.
 *
 * The report's own guard against printing a table that *looks* like evidence: a knob
 * whose values produce identical battles, identical losses and identical captures has
 * demonstrated nothing about the game, whatever the table's shape. The comparison is
 * against the first value and every field compared is one the table prints.
 *
 * A grid in which **no battle happened at all** is the important case this catches: a
 * wall of zeros moves nowhere, and the honest report is "this sweep proves nothing",
 * not "combat is unaffected".
 */
const measurableEffect = (report: CombatSweepReport): boolean => {
  const first = report.variants[0];
  if (first === undefined) return false;
  const signature = (variant: Variant): string =>
    JSON.stringify([
      variant.battles,
      variant.attackerWins,
      variant.defenderWins,
      variant.combatDamage,
      variant.unitsLostToCombat,
      variant.unitsLostToUpkeep,
      variant.promotions,
      variant.citiesCaptured,
      // M7: the figure the capture divisor moves. Without it a sweep of that knob would
      // report "no measurable effect" while the table's own population column moved —
      // the exact class of quiet false negative this guard exists to prevent.
      variant.capturedPopulation,
      variant.capturesWithPopulationAboveOne,
      variant.battlesAtCity,
      variant.battlesBehindWalls,
      variant.unitsAtHorizon,
      variant.citiesAtHorizon,
      variant.turnsPlayed,
      variant.seeds.map((run) => [run.seed, run.turnsPlayed, run.finalHash]),
    ]);
  const baseline = signature(first);
  return report.variants.some((variant) => signature(variant) !== baseline);
};

/**
 * Whether every value in the grid produced the **same games**, seed by seed, hash for hash.
 *
 * The strongest form of "nothing moved", and the one worth stating separately: a knob can
 * change a number the engine computes (the odds the resolver reports, the clamp it applies)
 * without changing a single outcome, because the outcome is decided by the roll and the
 * rolls are drawn regardless of the odds. Identical final hashes say exactly that — the
 * whole game, not merely this table's columns, is the same one. It is what makes a flat
 * walls result a statement about *these runs* rather than a suspicious-looking tie.
 */
const gamesAreIdentical = (report: CombatSweepReport): boolean => {
  const first = report.variants[0];
  if (first === undefined) return true;
  const shape = (variant: Variant): string =>
    JSON.stringify(
      variant.seeds.map((run) => [run.seed, run.turnsPlayed, run.finalHash, run.stoppedBecause]),
    );
  const baseline = shape(first);
  return report.variants.every((variant) => shape(variant) === baseline);
};

/**
 * Why the knob proved nothing, in the report's own words — **and which of the two very
 * different things that means.**
 *
 * A flat table has exactly two explanations, and M7's second repair is the reason they
 * are separated here rather than left to the reader:
 *
 * 1. the knob was never **exercised** — no defender stood behind a wall, or no city
 *    changed hands — in which case the table is a statement about *this run set* and not
 *    about the knob at all. That is a MEASUREMENT LIMITATION, and the exposure counter
 *    above says so from the runs themselves rather than from anybody's belief about the
 *    placeholder policy.
 * 2. the knob was exercised, repeatedly, and nothing moved anyway — which is a TRUE
 *    FINDING about the knob in this engine at this sample size, stated as such with the
 *    exposure that backs it.
 *
 * The old text collapsed both into "a wider grid or more turns is what would", which is
 * advice about the wrong thing in case 2 and an unstated assumption in case 1.
 */
const noEffectReason = (report: CombatSweepReport): string => {
  const { exposure } = report;
  if (exposure.count === 0) {
    return (
      `MEASUREMENT LIMITATION, not a finding about the knob: ${exposure.zeroMeans}. ` +
      `The knob would need ${exposure.needs}. What would fix the measurement is a run set in ` +
      'which that happens — more turns, more seeds, a bigger map, a lower --floor, or (M7) the ' +
      'real policy, which reaches positions this placeholder never does.'
    );
  }

  const first = report.variants[0];
  const last = report.variants[report.variants.length - 1];
  const grid =
    first === undefined || last === undefined
      ? 'across the grid'
      : `even between ${String(first.value)} and ${String(last.value)}`;
  const identical = gamesAreIdentical(report)
    ? ' The games are byte-identical as well — the same turns and the same final hash on every ' +
      'seed under every value — so the knob changed what the engine computed without changing ' +
      'what it decided.'
    : '';
  return (
    `TRUE FINDING about the knob in these runs, stated with what it is worth: the knob WAS ` +
    `exercised — ${exposure.name} ${String(exposure.count)} of ${String(exposure.of)} — and ` +
    `every value produced the same battles, the same losses, the same captures and the same ` +
    `populations, ${grid}.${identical} The exposure is the strength of that finding and not ` +
    'merely its context: read the knob as "it did not move these games", not as "it can never ' +
    'matter". More exposure (a bigger map, more turns, or the M7 policy) would test it harder; a ' +
    'wider grid of values cannot, because the games did not move across this one.'
  );
};

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

const USAGE = `combat balance sweep — one combat knob, measured battles

usage: npx tsx scripts/combat-balance-sweep.ts [flags]

  --knob <id>        which knob to turn (default ${DEFAULTS.knob})
                     ${KNOBS.map((knob) => `${knob.id} → ${knob.path}`).join('\n                     ')}
  --values <list>    comma-separated whole numbers (default: the knob's own grid)
  --seeds <spec>     "1,2,3" or "1..10" (default ${DEFAULTS.seedSpec})
  --turns <n>        turns per run (default ${String(DEFAULTS.turns)})
  --floor <pct>      the policy's attack odds floor in whole percent
                     (default ${String(DEFAULTS.floor)}, SIMPLE_POLICY_TUNING.attackOddsFloorPct)
  --stop-on-violation  let the runner stop a run at its first invariant violation
                     (the default plays the full horizon and checks the registry here)
  --json             print the structured report instead of the table
  -h, --help         this text

Nothing here is a game magnitude: the knob's shipped value and every number it moves are read out
of the catalog, and every row of the catalog is a placeholder (unsourced, chosen to be playable).
`;

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const main = (): number => {
  const parsed = parseFlags(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.error ?? 'bad flags'}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const knob = KNOBS.find((candidate) => candidate.id === parsed.knob);
  if (knob === undefined) {
    const known = KNOBS.map((candidate) => candidate.id).join(', ');
    process.stderr.write(
      `error: unknown knob "${String(parsed.knob)}" (known: ${known})\n\n${USAGE}`,
    );
    return 2;
  }

  let seeds: readonly number[];
  try {
    seeds = parseSeeds(parsed.seedSpec ?? DEFAULTS.seedSpec);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const report = buildReport(
    knob,
    parsed.values ?? knob.values,
    seeds,
    parsed.turns ?? DEFAULTS.turns,
    parsed.floor ?? DEFAULTS.floor,
    parsed.stopOnViolation === true,
  );

  if (parsed.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
    if (!measurableEffect(report)) {
      process.stdout.write(`NO MEASURABLE EFFECT: ${noEffectReason(report)}\n`);
    }
  }

  // An unaccounted magnitude means this report described a game it does not fully cover —
  // the M6 failure, where nine numbers lived in logic and the sweep simply did not mention
  // them. A failed reachability probe means the surface itself is broken. Both are broken
  // instruments rather than bad results, so both exit like one.
  if (report.uncovered.length > 0) return 1;
  if (report.reachability.failures.length > 0) return 1;

  // A disagreement means the replay is not the harness's game, which makes every figure
  // above a statement about this script rather than about the engine. That is a
  // different failure from a violation, and it exits the same way: non-zero.
  return report.disagreements.length > 0 || report.violations.length > 0 ? 1 : 0;
};

process.exitCode = main();
