#!/usr/bin/env node
/**
 * `scripts/behaviour-probe.ts` — the **behaviour-preservation probe**.
 *
 * Run it with:
 *
 * ```
 *   npx tsx scripts/behaviour-probe.ts
 * ```
 *
 * ## What it is for, and why it is a script rather than a test
 *
 * A change to the engine is supposed to be behaviour-preserving on the shipped
 * catalog, and the only honest way to check that is to run the *same* runs against
 * the *old* code and the *new* code and compare what came out. A test that lives in
 * one tree cannot do that: it would have to carry a copy of the engine it is meant
 * to be checking. So this is a script with **no arguments and no ambient input**, in
 * the spirit of `scripts/balance-sweep.ts`: it prints one canonical line per run, and
 * the comparison is `diff` between two checkouts.
 *
 * The procedure it supports is:
 *
 * ```
 *   git worktree add --detach /tmp/pre <revision-before-the-change>
 *   # ...wire /tmp/pre's node_modules links...
 *   cp scripts/behaviour-probe.ts /tmp/pre/scripts/
 *   npx tsx scripts/behaviour-probe.ts > /tmp/new.txt   # in this tree
 *   (cd /tmp/pre && npx tsx scripts/behaviour-probe.ts) > /tmp/old.txt
 *   diff /tmp/old.txt /tmp/new.txt                      # empty is the expected result
 * ```
 *
 * **Identical output is the claim**: the same seed, the same settings and the same
 * policy produce the same turn count, the same stop reason, the same final state
 * hash, the same violation list and the same *every metric row of every turn* — not
 * only the hash of the last state, because a run can end in the same place by a
 * different route and only the sequence shows it.
 *
 * ## Two modes per run, because a checker is not the engine
 *
 * A run's output is a function of the engine **and** of the invariant registry it was
 * given, and those two things move for different reasons. A stricter check that fires
 * on a genuinely illegal state is a *correct* change that nevertheless truncates the
 * run it fired in; counting that as "the engine's behaviour moved" would be exactly
 * the confusion this probe exists to prevent. So every scenario/seed is run twice:
 *
 * - **`MODE engine`** — `runSimulation` with the coverage recorder as its *only*
 *   invariant, so nothing can stop the run early. Every line of this mode must be
 *   **byte-identical** across the two trees: this is the behaviour-preservation claim,
 *   and it is stated over the full metrics sequence, not only the final hash.
 * - **`MODE checked`** — the same run with `CORE_INVARIANTS` concatenated, so the real
 *   registry runs on every turn. This mode may differ between trees **only** where the
 *   registry itself changed, and a difference here is a finding about the *checker*
 *   (a newly-caught violation, reported by name) rather than about the game.
 *
 * Both modes are printed with their mode in the line prefix, so a `diff` separates the
 * two claims for the reader instead of leaving them tangled.
 *
 * ## The four scenarios, and what each one is there to reach
 *
 * A comparison only proves something about the code paths it actually executes, so
 * the grid is chosen for *coverage*, and every run reports the event counts it
 * reached (`COVERAGE` lines) rather than asking the reader to trust that something
 * happened:
 *
 * 1. **`simple`** — the shipped `SIMPLE_POLICY` on `tiny`, 40 turns. The ordinary
 *    game: cities founded, production queued, units walked, huts entered.
 * 2. **`do-nothing`** — the shipped `DO_NOTHING_POLICY` on `tiny`, 40 turns. The
 *    control: with no commands at all, whatever the world does on its own (growth,
 *    income, upkeep) is compared, so a difference in the engine's *pipeline* — as
 *    opposed to in a policy's decisions — cannot hide behind the AI.
 * 3. **`hut-seeker`** — a probe policy that walks every unit toward the nearest
 *    remaining hut, on `small` with 60 turns. **This is the scenario that reaches the
 *    hut reward paths** (`HutEntered`, and the free-unit and barbarian-band branches
 *    behind it), which is where a change to *which unit a hut pays* would show up.
 * 4. **`worker`** — a probe policy that puts every worker on the first job the engine
 *    offers it, on `small` with 60 turns. **This is the scenario that reaches the
 *    improvement paths** (`WorkCompleted`, and the improved-tile pair list that the
 *    state hash covers), which is where a change to the *stored improvement order*
 *    would show up.
 *
 * The two probe policies are deliberately dull — first legal job, nearest hut — and
 * they are part of this file rather than of `@civts/sim` because they are *probes*,
 * not strategies: nothing here is a balance claim, and a policy that existed to be
 * played would live in the package.
 *
 * ## Determinism
 *
 * No clock, no ambient randomness, no arguments, no file IO: two runs of this script
 * on one tree print the same bytes, and that is asserted by running it twice rather
 * than assumed. The probe policies draw nothing from their RNG streams at all — they
 * are pure functions of the state — so the only randomness in a run is the world's,
 * which is the point: the comparison is about the engine.
 *
 * ## Provenance
 *
 * No game magnitude is introduced here. Every number is either a seed, a turn cap or
 * a map size — experiment parameters — or a value read out of `@civts/rules`'
 * catalog.
 */

import {
  DEFAULT_SETTINGS,
  indexToX,
  indexToY,
  unitActions,
  unitMoveOptions,
  type Command,
  type GameState,
  type MapSize,
  type TileIndex,
} from '@civts/core';
import { CATALOG, validateRuleset, type Ruleset } from '@civts/rules';
import {
  CORE_INVARIANTS,
  DO_NOTHING_POLICY,
  METRIC_KEY_ORDER,
  SIMPLE_POLICY,
  runSimulation,
  type Invariant,
  type Policy,
  type SimulationResult,
  type TurnMetrics,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * The ruleset — the shipped catalog, validated the way the CLI validates it
 * ------------------------------------------------------------------ */

const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

/* ------------------------------------------------------------------ *
 * Two probe policies
 * ------------------------------------------------------------------ */

/** Manhattan distance from `tile` to the nearest tile in `huts`, or a large number with none. */
const distanceToNearestHut = (
  state: GameState,
  tile: TileIndex,
  huts: readonly number[],
): number => {
  const x = indexToX(state.map, Number(tile));
  const y = indexToY(state.map, Number(tile));
  let best = Number.MAX_SAFE_INTEGER;
  for (const hut of huts) {
    const distance =
      Math.abs(indexToX(state.map, hut) - x) + Math.abs(indexToY(state.map, hut) - y);
    if (distance < best) best = distance;
  }
  return best;
};

/**
 * Walk every unit one step toward the nearest remaining hut. Nothing else: no city is
 * founded (a city consumes its tile's hut), no job is started, and the RNG is never
 * touched — so the huts a run reaches are a property of the world and the walk.
 */
const HUT_SEEKER: Policy = {
  name: 'probe-hut-seeker',
  chooseCommands: (ctx) => {
    const huts = ctx.state.map.huts.map(Number);
    if (huts.length === 0) return [];

    const commands: Command[] = [];
    for (const unit of ctx.state.units) {
      if (unit.owner !== ctx.playerId) continue;
      const options = unitMoveOptions(ctx.state, ctx.ruleset, unit.id);
      let bestTile: TileIndex | undefined;
      let bestDistance = Number.MAX_SAFE_INTEGER;
      for (const to of options) {
        const distance = distanceToNearestHut(ctx.state, to, huts);
        const better =
          bestTile === undefined ||
          distance < bestDistance ||
          (distance === bestDistance && Number(to) < Number(bestTile));
        if (better) {
          bestTile = to;
          bestDistance = distance;
        }
      }
      if (bestTile !== undefined) {
        commands.push({ type: 'MoveUnit', unitId: unit.id, to: bestTile });
      }
    }
    return commands;
  },
};

/**
 * Put every worker on the first job the engine offers it, on the tile it stands on.
 *
 * The first job is the catalog's own order, which is *content* and identical in both
 * trees of a comparison; the point of the scenario is not which job is chosen but
 * that jobs really finish, so `WorkCompleted` fires and improved tiles accumulate
 * pairs in a hashed list.
 */
const WORKER: Policy = {
  name: 'probe-worker',
  chooseCommands: (ctx) => {
    const commands: Command[] = [];
    for (const unit of ctx.state.units) {
      if (unit.owner !== ctx.playerId) continue;
      for (const command of unitActions(ctx.state, ctx.ruleset, unit.id)) {
        if (command.type === 'StartWork') {
          commands.push(command);
          break;
        }
      }
    }
    return commands;
  },
};

/* ------------------------------------------------------------------ *
 * Coverage: what a run actually reached
 * ------------------------------------------------------------------ */

/**
 * An invariant that counts the events of every turn and reports nothing.
 *
 * This is how the probe reads what happened **through the real runner**: the frozen
 * `InvariantContext` carries the turn's events, so a check that returns no violations
 * is a free, exact event recorder — and it means the probe does not have to re-implement
 * the turn pipeline (a second pipeline would be a second thing to trust) to know
 * whether a scenario reached the hut or the improvement paths.
 *
 * What it counts is chosen for **non-vacuity of the comparison**: an event total per
 * type, then `HutEntered` split by its `reward` (so "a hut was entered" and "a hut paid
 * a **unit**" are separate facts — the free unit is one of the picks a change could move,
 * and a run that only ever drew `nothing` would prove nothing about it), and then the
 * improvement pair list the run ended with: how many pairs, over how many tiles, of
 * which kinds, and the most pairs any one tile holds (a tile holding two pairs is what
 * makes the stored order's second key observable at all).
 *
 * `CORE_INVARIANTS` is concatenated rather than replaced, so a run in the probe stops
 * on a real violation exactly as a CLI run would.
 */
const eventCounter = (): { readonly invariant: Invariant; readonly report: () => string } => {
  const counts = new Map<string, number>();
  const kinds = new Set<string>();
  const tiles = new Set<number>();
  const perTile = new Map<number, number>();
  let improvements = 0;

  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  return {
    invariant: {
      name: 'probe-event-coverage',
      description: 'counts events and improvement pairs; reports nothing (a probe, not a property)',
      check: (ctx) => {
        for (const event of ctx.events) {
          bump(event.type);
          if (event.type === 'HutEntered') bump(`HutEntered@${event.reward}`);
        }

        // The after-state's improvement list is what the hasher covers, so it is read
        // fresh each turn and reported from the last turn the run reached.
        improvements = ctx.state.improvements.length;
        kinds.clear();
        tiles.clear();
        perTile.clear();
        for (const pair of ctx.state.improvements) {
          const tile = Number(pair.tile);
          kinds.add(String(pair.kind));
          tiles.add(tile);
          perTile.set(tile, (perTile.get(tile) ?? 0) + 1);
        }
        return [];
      },
    },
    report: () => {
      const events = [...counts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([type, count]) => `${type}=${String(count)}`)
        .join(' ');
      let mostPairsOnOneTile = 0;
      for (const count of perTile.values()) {
        if (count > mostPairsOnOneTile) mostPairsOnOneTile = count;
      }
      const kindNames = [...kinds].sort();
      return (
        `${events} | final-improvements=${String(improvements)} improved-tiles=${String(tiles.size)} ` +
        `kinds=${kindNames.length === 0 ? 'none' : kindNames.join('+')} ` +
        `max-pairs-on-one-tile=${String(mostPairsOnOneTile)}`
      );
    },
  };
};

/* ------------------------------------------------------------------ *
 * The grid, and the canonical report
 * ------------------------------------------------------------------ */

interface Scenario {
  readonly label: string;
  readonly policy: Policy;
  readonly mapSize: MapSize;
  readonly turns: number;
  /** What this scenario exists to reach, printed so the evidence is legible. */
  readonly reaches: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: 'simple',
    policy: SIMPLE_POLICY,
    mapSize: 'tiny',
    turns: 40,
    reaches: 'the ordinary game: cities, production, movement',
  },
  {
    label: 'do-nothing',
    policy: DO_NOTHING_POLICY,
    mapSize: 'tiny',
    turns: 40,
    reaches: 'the pipeline with no commands at all (the control)',
  },
  {
    label: 'hut-seeker',
    policy: HUT_SEEKER,
    mapSize: 'small',
    turns: 60,
    reaches: 'HutEntered and the reward branches behind it',
  },
  {
    label: 'worker',
    policy: WORKER,
    mapSize: 'small',
    turns: 60,
    reaches: 'WorkCompleted and the hashed improved-tile pair list',
  },
];

const SEEDS: readonly number[] = [1, 42, 1337, 7, 99];

/**
 * Which invariant set a run is given: `engine` (the recorder only, so nothing can
 * truncate a run) or `checked` (the real registry as well). See the module note.
 */
type Mode = 'engine' | 'checked';

/** One metrics row, in the module's declared key order: `k=v k=v …`. */
const rowOf = (row: TurnMetrics): string =>
  METRIC_KEY_ORDER.map((key) => `${key}=${String(row[key])}`).join(' ');

const report = (
  scenario: Scenario,
  mode: Mode,
  seed: number,
  result: SimulationResult,
  coverage: string,
): void => {
  const prefix = `${mode} ${scenario.label} seed=${String(seed)}`;
  const violations = result.violations
    .map((violation) => `${violation.invariant}@${String(violation.turn)}`)
    .join(',');
  console.log(
    `RUN ${prefix} turns=${String(result.turnsPlayed)} stop=${result.stoppedBecause} ` +
      `hash=${result.finalHash} violations=${String(result.violations.length)}` +
      (violations === '' ? '' : ` [${violations}]`),
  );
  console.log(`COVERAGE ${prefix} ${coverage}`);
  for (const row of result.metrics) {
    console.log(`METRIC ${prefix} ${rowOf(row)}`);
  }
};

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

console.log(
  `PROBE terrains=${String(CATALOG.terrains.length)} units=${String(CATALOG.units.length)} ` +
    `buildings=${String(CATALOG.buildings.length)} improvements=${String(CATALOG.improvements.length)} ` +
    `resources=${String(CATALOG.resources.length)} seeds=${SEEDS.map(String).join(',')} ` +
    `scenarios=${String(SCENARIOS.length)}`,
);

for (const scenario of SCENARIOS) {
  console.log(
    `SCENARIO ${scenario.label} map=${scenario.mapSize} turns=${String(scenario.turns)} ` +
      `reaches=${scenario.reaches}`,
  );
  for (const seed of SEEDS) {
    // `engine`: the coverage recorder is the only check, so nothing can truncate the
    // run and every line below is attributable to the engine.
    const engineCounter = eventCounter();
    report(
      scenario,
      'engine',
      seed,
      runSimulation({
        seed,
        settings: { ...DEFAULT_SETTINGS, seed, mapSize: scenario.mapSize, civCount: 2 },
        ruleset: RULESET,
        policies: [scenario.policy, scenario.policy],
        maxTurns: scenario.turns,
        invariants: [engineCounter.invariant],
      }),
      engineCounter.report(),
    );

    // `checked`: the same run with the real registry, which is what a CLI run does.
    const checkedCounter = eventCounter();
    report(
      scenario,
      'checked',
      seed,
      runSimulation({
        seed,
        settings: { ...DEFAULT_SETTINGS, seed, mapSize: scenario.mapSize, civCount: 2 },
        ruleset: RULESET,
        policies: [scenario.policy, scenario.policy],
        maxTurns: scenario.turns,
        invariants: [...CORE_INVARIANTS, checkedCounter.invariant],
      }),
      checkedCounter.report(),
    );
  }
}

/**
 * The end marker. The comparison is a `diff` of the whole output, so this line exists
 * only to make a **truncated** run visible: a stream that was cut short, or a run that
 * threw halfway, does not end here, and a diff against a complete tree then shows a
 * missing tail rather than an empty diff.
 */
console.log('PROBE COMPLETE');
