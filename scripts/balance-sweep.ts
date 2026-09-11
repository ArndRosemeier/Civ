#!/usr/bin/env node
/**
 * `scripts/balance-sweep.ts` — the balance loop, end to end.
 *
 * Run it with:
 *
 * ```
 *   npx tsx scripts/balance-sweep.ts                      # the default knob and grid
 *   npx tsx scripts/balance-sweep.ts --values 1,2,3,5,9
 *   npx tsx scripts/balance-sweep.ts --knob buildings.factory.maintenance --values 0,1,3,6,10
 *   npx tsx scripts/balance-sweep.ts --seeds 1..8 --turns 40 --json
 * ```
 *
 * ## What it demonstrates
 *
 * The standing requirement's acceptance line — *"a balance sweep demonstrates the loop
 * end to end: vary one catalog number, run a batch, and show the measured effect"* —
 * and nothing else:
 *
 * 1. **One catalog number** is chosen: `units.settler.cost`, the shield cost of the
 *    unit that founds cities, because a city count is a structural effect rather than
 *    a rounding difference;
 * 2. the **same** seed set, settings, turn count and policy are run under several
 *    values of it, through `@civts/sim`'s `applyOverrides` — the CLI's own override
 *    path, `runSweepCommand` in `packages/headless/src/sim-cli.ts` — so every
 *    difference in the table is the knob's and nothing else's;
 * 3. the **measured effect** is printed as a table: cities, population, treasury and
 *    units held at the horizon, each with its delta against the shipped catalog, which
 *    is run too, with no override at all, as the control.
 *
 * The sweep is reproducible by construction — no clock, no ambient randomness, no
 * input that is not a flag — so the same command prints the same table, byte for byte.
 *
 * ## Provenance
 *
 * This script contains **no game balance number of its own**. The knob's shipped value
 * (`3`, today) is *read out of* `@civts/rules`' catalog and printed with that row's own
 * provenance; the only numbers written here are the **sweep grid** and the default
 * experiment size, which are experiment parameters, not claims about the game.
 *
 * Every catalog row is a `placeholder`: **unsourced, chosen to be playable**. The table
 * below measures *this project's* numbers against *this project's* engine and says
 * nothing about Civ 3.
 *
 * ## Two things the table is not
 *
 * - **`units` is the unit count at the horizon, not a count of units ever built.**
 *   `TurnMetrics` measures the state each turn (what the standing requirement asks of
 *   it) and carries no cumulative production, so "units built by turn N" is not a
 *   figure the report contains — and a figure the report does not contain is a figure
 *   the table must not show.
 * - **`cities` is a count of cities standing, which is the number founded** only
 *   because nothing in this engine removes a city (M4c's bankruptcy disbands units, not
 *   cities). When a milestone adds city loss, that reading has to be revisited.
 *
 * ## The default experiment
 *
 * The grid is `1, 2, 3, 5, 9` — the shipped value (`3`, marked in the table) and values
 * either side of it, far enough to be visible. The seed set is `1, 4, 5, 7, 8`, a small
 * fixed experiment: five runs per value, the same five under every value, so every
 * difference in the table is the knob's.
 *
 * That seed set was originally chosen the other way round — to *steer around* a defect.
 * `city-food-box-within-threshold` used to fire on ordinary shipped content (a city whose
 * food box reached one short of its threshold in the same turn that production completed
 * a granary or the Pyramids, which lowers the requirement under the box the growth pass
 * had already filled: `growth.ts` runs before `production.ts`, the frozen turn order),
 * and the runner stops a violating run on the turn that broke — so a seed that hit it had
 * a shorter horizon than its neighbours and its sums were not comparable with theirs. The
 * seed set was picked to be clean, and widening it to `--seeds 1..10` was how to see it.
 *
 * **That defect is fixed.** `@civts/sim`'s check now states two bounds: the box is bounded
 * unconditionally by the bare `foodBoxSize(population)`, and by the reduced
 * (building-aware) threshold whenever the turn's events did not move a `growth-food`
 * building in or out of the city — so a completion that made the end-of-turn comparison
 * one turn early no longer reports a legal state. Measured on the shipped content
 * afterwards: `sim --seeds 1..50 --map-size tiny --turns 20` reports 0 violations at one
 * horizon, and this sweep runs at a single horizon on the default seed set, on
 * `--seeds 1..10`, and under the knob value (`4`) that used to trip it on every one of
 * these seeds. The seed set is therefore no longer load-bearing; it is kept because a
 * fixed five-seed experiment is what the table's byte-for-byte reproducibility rests on.
 *
 * What has NOT changed is the reporting: a violation is printed loudly with its knob
 * value, seed, turn and invariant name, the status becomes `violations` and the exit code
 * 1, and a run that stopped early still adds the horizon caveat saying its sums mix
 * horizons. The sweep is built to surface a disagreement between the engine and the
 * invariant registry, not to avoid one — it surfaced this one, which is the strongest
 * evidence that the loop does what it was built for.
 */

import { runSweepCommand, type SweepCommandDefaults } from '../packages/headless/src/sim-cli.js';

/** The default experiment: one knob, a grid, and the batch every value is run on. */
const SWEEP_DEFAULTS: SweepCommandDefaults = {
  knob: 'units.settler.cost',
  values: [1, 2, 3, 5, 9],
  seedSpec: '1,4,5,7,8',
  turns: 25,
};

const result = runSweepCommand(process.argv.slice(2), SWEEP_DEFAULTS);

if (!result.ok) {
  for (const line of result.error.lines) process.stderr.write(`${line}\n`);
  if (result.error.usage !== undefined) process.stderr.write(`\n${result.error.usage}`);
  process.exitCode = result.error.exitCode;
} else {
  process.stdout.write(result.value.stdout);
  if (result.value.stderr !== '') process.stderr.write(result.value.stderr);
  process.exitCode = result.value.exitCode;
}
