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
 * Four combat knobs are reachable today:
 *
 * - `warrior-attack` — `units.warrior.attack`;
 * - `grassland-defense` — `terrains.grassland.defenseBonusPct`;
 * - `walls-bonus` — `combat.wallsBonusPct`, the city-wall defence bonus;
 * - `damage-per-round` — `combat.damagePerRound`, the hit points one won round costs.
 *
 * **M6b closed the gap this file used to report.** Until then M6's nine combat magnitudes
 * were module constants in `@civts/core` with no `combat` section in `RulesetPatch`, so
 * this sweep could only say that they were unreachable *by construction* — the same
 * finding `scripts/tech-balance-sweep.ts` reports for tech prices. They now live in the
 * catalog, the applier merges them field by field, and two of them are swept below end to
 * end: the report prints the shipped value, the value each variant actually reads inside
 * the patched ruleset, and what moved.
 *
 * What remains unreachable is reported rather than swept (see `UNREACHABLE`), and it is
 * now a short list of things that are genuinely not numbers in this engine: the id
 * convention that decides which building carries walls, and the capture population
 * divisor, which is still a literal in `core/cities.ts`.
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
  // program whose job is to prove there is no second source.
  CAPTURE_POPULATION_DIVISOR,
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
];

/**
 * The combat-adjacent magnitudes **the override surface still cannot move**, read from
 * `@civts/core` so the report cannot drift from the code.
 *
 * M6b shrank this list from ten entries to two. The nine `combat` magnitudes and
 * `units.*.hitPoints` left it because `RulesetPatch` can now address them — and a list
 * that kept claiming they were unreachable would be this report lying about its own
 * surface, which is worse than not reporting at all. What is left is genuinely not a
 * number a patch could carry, and each row says what would have to change for it to be
 * one.
 */
const UNREACHABLE: readonly {
  readonly name: string;
  /** The shipped magnitude, where there is one to read; omitted where the gap is a shape. */
  readonly value?: number;
  readonly needs: string;
}[] = [
  {
    name: 'buildings.walls (the id that decides which building carries walls)',
    needs:
      'nothing can move it, and nothing should: which *building* grants the wall bonus is a ' +
      'rows-level convention (`defenderBonusPct` reads the id "walls"), while the bonus itself ' +
      'is the swept `combat.wallsBonusPct`',
  },
  {
    name: 'CAPTURE_POPULATION_DIVISOR',
    value: CAPTURE_POPULATION_DIVISOR,
    needs:
      'a catalog row: this one magnitude of the capture rule is still a literal in ' +
      '`packages/core/src/cities.ts`, so no patch can reach it',
  },
];

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
});

/**
 * Fold one event into the tally.
 *
 * Every branch is a *reading of the event's own fields*: nothing is inferred from the
 * state, and nothing is counted that the stream did not say. A `CombatResolved` line
 * that says `attacker-wins` is the only thing that increments `attackerWins`, so a
 * resolver that flipped its verdict would move this table — which is the point.
 */
const tallyEvent = (tally: Tally, event: GameEvent): void => {
  switch (event.type) {
    case 'CombatResolved':
      tally.battles += 1;
      if (event.outcome === 'attacker-wins') tally.attackerWins += 1;
      else tally.defenderWins += 1;
      tally.combatDamage += event.attackerLost + event.defenderLost;
      return;
    case 'UnitDestroyed':
      if (event.reason === 'combat') tally.unitsLostToCombat += 1;
      else tally.unitsLostToUpkeep += 1;
      return;
    case 'UnitPromoted':
      tally.promotions += 1;
      return;
    case 'CityCaptured':
      tally.citiesCaptured += 1;
      return;
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
        const outcome = applyCommand(state, player.id, command, ruleset);
        if (!outcome.ok) continue;
        state = outcome.value.state;
        for (const event of outcome.value.events) {
          tallyEvent(tally, event);
          seen.push(event);
        }
      }
    }

    const advanced = advanceTurn(state, ruleset);
    state = advanced.state;
    for (const event of advanced.events) {
      tallyEvent(tally, event);
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
    readonly name: string;
    /** Absent where the gap is a *shape* rather than a number (see `UNREACHABLE`). */
    readonly value?: number;
    readonly needs: string;
  }[];
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
    '  value  eff | turns | battles  atk-win  win% | damage | units lost  (combat/upkeep) | promos | captures | units@H cities@H',
  );
  lines.push(
    '  -----------+-------+------------------------+--------+---------------------------+--------+----------+-----------------',
  );
  for (const variant of report.variants) {
    lines.push(
      `  ${cell(variant.value, 5)}  ${cell(variant.effective, 3)} | ` +
        `${cell(Math.floor(variant.turnsPlayed / Math.max(variant.seeds.length, 1)), 5)} | ` +
        `${cell(variant.battles, 7)}  ${cell(variant.attackerWins, 7)}  ${cell(variant.attackerWinPct, 4)} | ` +
        `${cell(variant.combatDamage, 6)} | ` +
        `${cell(variant.unitsLostToCombat + variant.unitsLostToUpkeep, 10)}  ` +
        `(${String(variant.unitsLostToCombat)}/${String(variant.unitsLostToUpkeep)})`.padEnd(17) +
        ` | ${cell(variant.promotions, 6)} | ${cell(variant.citiesCaptured, 8)} | ` +
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

  lines.push('combat magnitudes this override surface CANNOT move (reported, not swept)');
  for (const row of report.unreachable) {
    const value = row.value === undefined ? '' : ` = ${String(row.value)}`;
    lines.push(`  ${row.name}${value}  — needs ${row.needs}`);
  }
  lines.push('');

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
      variant.unitsAtHorizon,
      variant.citiesAtHorizon,
      variant.turnsPlayed,
      variant.seeds.map((run) => [run.seed, run.turnsPlayed, run.finalHash]),
    ]);
  const baseline = signature(first);
  return report.variants.some((variant) => signature(variant) !== baseline);
};

/** Why the knob proved nothing, in the report's own words. */
const noEffectReason = (report: CombatSweepReport): string => {
  const battles = report.variants.reduce((total, variant) => total + variant.battles, 0);
  if (battles === 0) {
    return (
      'no battle was fought under ANY value of the knob, so there is nothing here to move: the ' +
      'two civilizations never met in force within the horizon, or the policy never cleared its ' +
      'own odds floor. More turns, more seeds, a bigger map or a lower --floor is what would.'
    );
  }
  return (
    'every value produced the same battles, the same losses and the same captures, so this sweep ' +
    'proves nothing about the knob. A wider grid or more turns is what would.'
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

  // A disagreement means the replay is not the harness's game, which makes every figure
  // above a statement about this script rather than about the engine. That is a
  // different failure from a violation, and it exits the same way: non-zero.
  return report.disagreements.length > 0 || report.violations.length > 0 ? 1 : 0;
};

process.exitCode = main();
