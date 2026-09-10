/**
 * M2 adversarial review (W6) — an attempt to FALSIFY the M2 contracts in
 * docs/INTERFACES.md, not to confirm them.
 *
 * Everything here was written *after* trying to break the implementation by hand
 * (throwaway probes under /tmp: 44 seeds × 12 play steps for two civilizations,
 * plus 2/3/4-civilization sweeps over 720 deep-frozen states and 7,776,000
 * enumerated `MoveUnit` commands). The tests below pin what survived.
 *
 * This review found two defects, and both were fixed by the **post-review binding
 * amendment** to the M2 contract (docs/INTERFACES.md, "Amendment (post-review,
 * binding)"), not by weakening a test. The two tests that recorded them are kept,
 * inverted, as evidence *for* the amended keystone property:
 *
 * 1. **The three-argument `applyCommand(state, playerId, cmd)` refused every
 *    command, including every action the generator yields**, because the interim
 *    implementation made the `RulesetView` parameter optional and refused at
 *    runtime. That is the worst shape: it compiles, the typechecker cannot catch
 *    a missing argument, and every command silently fails. The amendment makes
 *    the ruleset a **required** fourth parameter, so the old spelling is now a
 *    compile error — pinned below as a `@ts-expect-error` assertion that
 *    `pnpm typecheck` enforces — and the same commands apply under the
 *    four-argument call.
 * 2. **One reachable counterexample to invariant 1 existed**: `legalActions`
 *    always yields `EndTurn` for a real player, but `applyCommand` refused it
 *    when a unit's type was absent from the ruleset. The amendment makes
 *    `EndTurn` **total** — it refills the units it can resolve and carries the
 *    rest over untouched — so the counterexample is gone, and the test below now
 *    asserts the totality instead of the refusal. `newGame` and the scenario DSL
 *    cannot produce such a state; a hand-built state, a foreign ruleset view, or
 *    a future save-file load can, which is why the property is worth pinning.
 *
 * Everything else held under attack and is pinned here as evidence, deliberately
 * including the cases where the honest answer is "no finding":
 *
 * - keystone: 16 seeds × 8 steps, every player, every unit, every action, plus
 *   an exhaustive reverse sweep (every tile index for every unit: anything the
 *   engine accepts must be yielded by `unitActions`/`legalActions`, so the
 *   generator is neither unsound nor incomplete);
 * - purity: nothing mutates a deep-frozen state or a deep-frozen ruleset,
 *   including `EndTurn` and refused commands;
 * - conservation: a legal move changes exactly one **pre-existing** unit, keeps
 *   every pre-existing unit alive at the same id and
 *   `movementLeft` inside `[0, movement]` and equal to
 *   `old - destinationCost`, and never lands on a tile the unit could not
 *   afford. Since M3 a move can also consume a hut and add units, so the old
 *   "the unit count and the id sequence are unchanged" equality was replaced by
 *   a hut-aware property — the same equality wherever no hut is entered, plus
 *   "every unit that appears is claimed by a `HutEntered`/`BarbariansSpawned`
 *   event, with the claimed owner and tile" (see `conserveMove` below);
 * - fog: `newGame` marks exactly what its unit sees; `explored` only grows;
 *   every visible tile is explored after every applied command; `visibleTiles`
 *   is in-bounds for hostile radii; `describe(..., { viewer })` leaks no
 *   unexplored terrain;
 * - determinism: the same seed and command sequence hash identically
 *   in-process **and in a fresh `tsx` process** (the child prints its hashes);
 * - the goldens are rebuilt here from the current engine and compared with the
 *   committed file (an independent reconstruction of `golden.test.ts`'s check),
 *   and they are shown to be sensitive to a one-field perturbation.
 *
 * Two further precision notes are pinned as tests rather than claimed as
 * defects, because neither breaks a stated contract: `newGame`'s seed argument
 * and `settings.seed` are independent inputs (a byte-identical world hashes
 * differently when they disagree), and a scenario-built world starts with empty
 * fog memory even though its units can already see — an asymmetry with
 * `newGame`, which marks what the starting unit sees as explored.
 *
 * **Migrated to the M3 state shape** (docs/INTERFACES.md M3). `newGame` now
 * appends a barbarian player, so `players.length === civCount + 1` and every
 * "how many civilizations" question goes through `civPlayers`. The sweeps keep
 * iterating `players` on purpose — a barbarian unit is an ordinary `Unit` whose
 * `owner` is an ordinary `PlayerId`, so the keystone property must hold for it —
 * and the player model those sweeps walk is now asserted instead of assumed.
 * No existing claim was weakened by the migration: the goldens compared here are
 * the regenerated M3 file, and `EndTurn` for a player that owns no unit is swept
 * as well.
 *
 * **The M3 hut escalation is closed here too** (F5). The conservation sweep above
 * still asserted "a legal move moves one unit and nothing else" *after* the hut
 * contract deliberately broke it, so it failed on the one move the hut workstream
 * reproduced — `seed 3, unit 1 -> 2951` (a hut: `UnitMoved`, `HutEntered`,
 * `BarbariansSpawned`, unit count 2 -> 4). The fix is not to skip hut moves and
 * not to relax the count: it is the hut-aware property in `conserveMove`, which
 * re-derives the pre-M3 equality exactly where no hut is involved and otherwise
 * requires every added unit to be named — with its owner and tile — by the events
 * the command emitted. The three reward branches are swept separately, including
 * the free-unit branch that `SWEEP_SEEDS` never draws. `index.ts` now also exports
 * `./hut.js`, and a test pins that `hutAt`, `resolveHutEntry`, `HUT_REWARD_KINDS`,
 * `BARBARIAN_BAND_SIZE` and `HUT_REWARD_PROVENANCE` are reachable from
 * `@civts/core` rather than only from the module path.
 *
 * Findings that could NOT be turned into a test are reported in prose with the
 * review (cast/`any`/non-null audit, the `rehash:` commit note, the golden
 * harness's refusal to auto-write, CLI transcript hashes).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BARBARIAN_BAND_SIZE,
  DEFAULT_SETTINGS,
  HUT_REWARD_KINDS,
  HUT_REWARD_PROVENANCE,
  applyCommand,
  asPlayerId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  civPlayers,
  describe as renderState,
  distance8,
  hutAt,
  indexToX,
  indexToY,
  isExplored,
  isPlaceholder,
  legalActions,
  neighbors8,
  newGame,
  resolveHutEntry,
  terrainAtIndex,
  unitActions,
  unitDef,
  unitMoveOptions,
  visibleTiles,
  withExplored,
  type Command,
  type GameEvent,
  type GameError,
  type GameState,
  type PlayerId,
  type RulesetView,
  type Settings,
  type TileIndex,
  type Unit,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { loadGoldens } from '../src/goldens.js';
import { hashValue } from '../src/hash.js';
import { createScenarioBuilder } from '../src/scenario.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The real, validated content the CLI runs on — not a hand-made view. */
const RULESET: RulesetView = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((e) => e.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

/** Smallest generated world with two civilizations — the golden configuration. */
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 };

/**
 * The settings a generated game is built from, exactly as the CLI and the golden
 * harness build them: `settings.seed` is set to the seed that is *also* passed as
 * `newGame`'s first argument. `GameState.settings` is stored verbatim and is part
 * of every hash, so leaving `settings.seed` at its default while generating from
 * another seed changes the hash of a byte-identical world — see the precision
 * note at the bottom of this file, which pins that behaviour.
 */
const settingsFor = (seed: number, civCount: number = SETTINGS.civCount): Settings => ({
  ...SETTINGS,
  seed,
  civCount,
});

/** Seeds swept by the keystone and conservation checks (spread, not cherry-picked). */
const SWEEP_SEEDS: readonly number[] = [
  1, 2, 3, 5, 7, 11, 13, 17, 42, 99, 256, 777, 1337, 2024, 31337, 1000000,
];

/** Play steps per seed in the keystone sweep. */
const SWEEP_STEPS = 8;

/** The three golden scenarios, in the order `golden.test.ts` stores them. */
const GOLDEN_SEEDS: readonly number[] = [1, 42, 1337];

const generatedFor = (seed: number, civCount: number): GameState => {
  const result = newGame(seed, settingsFor(seed, civCount), RULESET);
  if (!result.ok)
    throw new Error(`newGame(${String(seed)}) failed: ${JSON.stringify(result.error)}`);
  return result.value;
};

const generated = (seed: number): GameState => generatedFor(seed, SETTINGS.civCount);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Freeze a state graph so any write throws (modules are strict mode). */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/** A frozen deep copy, so a write to the copy the engine was handed throws. */
const deepFrozenCopy = <T>(value: T): T => {
  deepFreeze(value);
  return value;
};

/**
 * A stable key for a command, so two generators can be compared as sets.
 *
 * Migrated twice: M2's pair (`MoveUnit`/`EndTurn`), and M3, which added the two
 * city commands and `FoundCity` to the frozen `Command` union. The switch is
 * exhaustive on purpose — a `Command` variant that is not keyed here is a
 * *typecheck* failure, not a silently equal pair of different commands, which is
 * what a comparator used as evidence for the keystone property has to guarantee.
 */
const cmdKey = (cmd: Command): string => {
  switch (cmd.type) {
    case 'EndTurn':
      return 'EndTurn';
    case 'MoveUnit':
      return `MoveUnit ${String(cmd.unitId)} -> ${String(cmd.to)}`;
    case 'FoundCity':
      return `FoundCity ${String(cmd.unitId)}`;
    case 'SetWorkedTiles':
      return `SetWorkedTiles ${String(cmd.cityId)} [${cmd.tiles.map(String).join(',')}]`;
    case 'SetProduction':
      return `SetProduction ${String(cmd.cityId)} ${cmd.item.kind}:${String(cmd.item.id)}`;
  }
};

const errorText = (error: GameError): string => JSON.stringify(error);

/** Deterministic 32-bit PRNG: the sweep must not depend on anything ambient. */
const makePrng = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
};

/**
 * Accumulates failures inside the conservation sweeps, where `expect` per
 * iteration would cost more than the work being checked. Each test resets it
 * first and asserts it is empty at the end.
 */
const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

const terrainCostAt = (state: GameState, tile: TileIndex): number | undefined => {
  const id = terrainAtIndex(state.map, tile);
  if (id === undefined) return undefined;
  return RULESET.terrains.find((terrain) => terrain.id === id)?.moveCost;
};

/* ------------------------------------------------------------------ *
 * 1. The keystone
 * ------------------------------------------------------------------ */

interface SweepTotals {
  readonly seeds: number;
  readonly steps: number;
  readonly legalActions: number;
  readonly applied: number;
  readonly unitActions: number;
  readonly enumerated: number;
  readonly accepted: number;
  readonly endTurns: number;
}

/**
 * Walk a real generated game forward, and at every state check both directions
 * of the keystone property:
 *
 * - soundness: every action `legalActions`/`unitActions` yields applies;
 * - completeness: every command `applyCommand` accepts is yielded by both
 *   generators. Exhaustive over every tile index (`to` in `[0, size)`), not just
 *   the 8 neighbours — a generator that forgot a tile would show up here.
 *
 * The state is deep-frozen before the walk, so a mutation is a thrown TypeError
 * rather than a silently different result.
 */
const sweepGames = (
  seeds: readonly number[],
  steps: number,
  civCount = SETTINGS.civCount,
): { totals: SweepTotals; failures: readonly string[] } => {
  const failures: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };

  let legalCount = 0;
  let appliedCount = 0;
  let unitActionCount = 0;
  let enumerated = 0;
  let accepted = 0;
  let endTurns = 0;

  for (const seed of seeds) {
    let state = generatedFor(seed, civCount);
    const prng = makePrng(seed);

    for (let step = 0; step < steps; step += 1) {
      const size = state.map.width * state.map.height;
      const frozenHash = hashValue(state);
      deepFreeze(state);

      for (const player of state.players) {
        const legal = new Set<string>();

        for (const cmd of legalActions(state, RULESET, player.id)) {
          legal.add(cmdKey(cmd));
          legalCount += 1;

          const outcome = applyCommand(state, player.id, cmd, RULESET);
          if (!outcome.ok) {
            failures.push(
              `seed ${String(seed)} step ${String(step)}: legalActions yielded ${cmdKey(cmd)} but ` +
                `applyCommand refused it: ${errorText(outcome.error)}`,
            );
            continue;
          }
          appliedCount += 1;
          check(
            outcome.value.state.revision === state.revision + 1,
            `seed ${String(seed)}: revision did not advance by exactly one`,
          );
          check(
            outcome.value.events.length > 0,
            `seed ${String(seed)}: an applied command emitted no event`,
          );
        }

        const endTurn = applyCommand(state, player.id, { type: 'EndTurn' }, RULESET);
        check(
          endTurn.ok === legal.has('EndTurn'),
          `seed ${String(seed)}: EndTurn accepted=${String(endTurn.ok)} but yielded=${String(legal.has('EndTurn'))}`,
        );

        for (const unit of state.units.filter((candidate) => candidate.owner === player.id)) {
          const mine = new Set<string>();

          for (const cmd of unitActions(state, RULESET, unit.id)) {
            mine.add(cmdKey(cmd));
            unitActionCount += 1;

            const outcome = applyCommand(state, player.id, cmd, RULESET);
            if (!outcome.ok) {
              failures.push(
                `seed ${String(seed)} step ${String(step)}: unitActions yielded ${cmdKey(cmd)} but ` +
                  `applyCommand refused it: ${errorText(outcome.error)}`,
              );
            }
          }

          for (let to = 0; to < size; to += 1) {
            const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to: asTileIndex(to) };
            enumerated += 1;

            const outcome = applyCommand(state, player.id, cmd, RULESET);
            if (!outcome.ok) continue;
            accepted += 1;

            check(
              mine.has(cmdKey(cmd)),
              `seed ${String(seed)}: engine ACCEPTED ${cmdKey(cmd)} but unitActions never yields it ` +
                '(generator incomplete)',
            );
            check(
              legal.has(cmdKey(cmd)),
              `seed ${String(seed)}: engine ACCEPTED ${cmdKey(cmd)} but legalActions never yields it ` +
                '(generator incomplete)',
            );
          }

          // M3: `unitActions` yields a second command family — `FoundCity`, for a
          // settler that can found. The `MoveUnit` sweep above enumerates every
          // tile but no `FoundCity`, so `accepted` would fall short of
          // `unitActions` by exactly the founders and the completeness count would
          // read as a generator bug. `FoundCity` carries no tile (the unit's own
          // tile is the site), so there is exactly one candidate per unit: it is
          // enumerated unconditionally, exactly as the applier is asked about it.
          const foundCity: Command = { type: 'FoundCity', unitId: unit.id };
          enumerated += 1;

          const founded = applyCommand(state, player.id, foundCity, RULESET);
          if (founded.ok) {
            accepted += 1;
            check(
              mine.has(cmdKey(foundCity)),
              `seed ${String(seed)}: engine ACCEPTED ${cmdKey(foundCity)} but unitActions never ` +
                'yields it (generator incomplete)',
            );
            check(
              legal.has(cmdKey(foundCity)),
              `seed ${String(seed)}: engine ACCEPTED ${cmdKey(foundCity)} but legalActions never ` +
                'yields it (generator incomplete)',
            );
          }
          // The equality, rather than only the "accepted implies yielded" half:
          // a generator that offered a founding this engine refuses is just as
          // broken as one that hid a founding it accepts, and it is the exact
          // shape of the M2 counterexample the `EndTurn` check above pins.
          check(
            founded.ok === mine.has(cmdKey(foundCity)),
            `seed ${String(seed)} step ${String(step)}: FoundCity accepted=${String(founded.ok)} ` +
              `but unitActions yielded=${String(mine.has(cmdKey(foundCity)))}`,
          );
        }
      }

      check(
        hashValue(state) === frozenHash,
        `seed ${String(seed)} step ${String(step)}: the read-only walk mutated the state`,
      );

      const actor = state.players[prng() % state.players.length];
      if (actor === undefined) break;

      const options = [...legalActions(state, RULESET, actor.id)];
      const next = options[prng() % options.length];
      if (next === undefined) break;

      const advanced = applyCommand(state, actor.id, next, RULESET);
      if (!advanced.ok) {
        failures.push(
          `seed ${String(seed)} step ${String(step)}: chosen action ${cmdKey(next)} was refused: ` +
            errorText(advanced.error),
        );
        break;
      }
      state = advanced.value.state;
      if (next.type === 'EndTurn') endTurns += 1;
    }
  }

  return {
    totals: {
      seeds: seeds.length,
      steps,
      legalActions: legalCount,
      applied: appliedCount,
      unitActions: unitActionCount,
      enumerated,
      accepted,
      endTurns,
    },
    failures,
  };
};

describe('keystone — the engine and the generator agree, in both directions', () => {
  it('every yielded action applies, and every accepted action is yielded', () => {
    const { totals, failures } = sweepGames(SWEEP_SEEDS, SWEEP_STEPS);
    console.log('keystone sweep totals:', JSON.stringify(totals));

    expect(failures).toEqual([]);

    // Non-vacuity: the sweep must actually have walked a real action space.
    expect(totals.legalActions).toBeGreaterThan(500);
    expect(totals.unitActions).toBeGreaterThan(400);
    expect(totals.enumerated).toBeGreaterThan(500_000);
    // At least one EndTurn per seed, so both halves of the generator were walked.
    expect(totals.endTurns).toBeGreaterThan(SWEEP_SEEDS.length);

    // Soundness and completeness, as counts: every accepted command was yielded
    // by both generators, and every yielded action applied.
    expect(totals.applied).toBe(totals.legalActions);
    expect(totals.accepted).toBe(totals.unitActions);
  });

  it('walks every player the M3 player model defines, barbarians included', () => {
    // MIGRATED (docs/INTERFACES.md M3, "State shape"). The sweeps above iterate
    // `state.players` on purpose: a barbarian unit is an ordinary `Unit` with an
    // ordinary `owner`, so the keystone property has to hold for its owner too.
    // That is only meaningful while `players` really is the full list, so the
    // model the sweep walks is asserted here rather than assumed: civCount
    // civilizations, then exactly one barbarian player, with `PlayerId` still the
    // index into `players` (which `explored` and every `owner` field rely on).
    for (const civCount of [2, 3, 4]) {
      const state = generatedFor(42, civCount);
      const civs = civPlayers(state);
      const barbarians = state.players.filter((player) => player.kind === 'barbarian');

      expect(civs).toHaveLength(civCount);
      expect(barbarians).toHaveLength(1);
      expect(state.players).toHaveLength(civCount + 1);
      expect(state.players.map((player) => Number(player.id))).toEqual(
        Array.from({ length: civCount + 1 }, (_, index) => index),
      );
      expect(state.explored).toHaveLength(state.players.length);

      // The barbarian player is a player identity, not a civilization: `newGame`
      // gives it no settler, so it owns no unit and yields only `EndTurn` — the
      // one action a player with nothing to move can still take.
      const barbarian = barbarians[0];
      if (barbarian === undefined) throw new Error('no barbarian player');
      expect(state.units.some((unit) => unit.owner === barbarian.id)).toBe(false);
      const actions = [...legalActions(state, RULESET, barbarian.id)];
      expect(actions).toEqual([{ type: 'EndTurn' }]);
      expect(applyCommand(state, barbarian.id, { type: 'EndTurn' }, RULESET).ok).toBe(true);
    }
  });

  it('holds with three and four civilizations crowded onto the same map', () => {
    for (const civCount of [3, 4]) {
      const { totals, failures } = sweepGames([1, 5, 42, 777, 1337, 31337], 4, civCount);
      console.log(`keystone sweep (${String(civCount)} civs):`, JSON.stringify(totals));

      expect(failures, `${String(civCount)} civilizations`).toEqual([]);
      expect(totals.applied).toBe(totals.legalActions);
      expect(totals.accepted).toBe(totals.unitActions);
      expect(totals.accepted).toBeGreaterThan(0);
      // More civilizations means more units, and therefore more occupied tiles
      // the generator has to exclude.
      expect(totals.unitActions).toBeGreaterThan(civCount);
    }
  });

  /**
   * The amended contract pins the arity in the *type*, not at runtime. This
   * directive suppresses a real error — a four-parameter function is not callable
   * as a three-argument one — and if the parameter ever became optional again the
   * directive would suppress nothing and `pnpm typecheck` would fail with
   * "Unused '@ts-expect-error' directive".
   *
   * The core suite (packages/core/test/commands.test.ts) asserts the same thing;
   * it is repeated here because this file is where the pre-amendment
   * three-argument call was first found to refuse every command, and the finding
   * should leave a regression test at the site it was discovered.
   */
  // @ts-expect-error applyCommand requires the ruleset as its fourth argument
  const applyWithThreeArguments: (state: GameState, playerId: PlayerId, cmd: Command) => unknown =
    applyCommand;

  it('applies every action the generators yield, under the amended four-argument call', () => {
    const state = generated(42);

    let yielded = 0;
    let moves = 0;
    const refusals: string[] = [];

    for (const player of state.players) {
      const actions = [...legalActions(state, RULESET, player.id)];
      expect(actions.length).toBeGreaterThan(0);
      // Both halves of the generator are walked: that player's moves, plus one
      // `EndTurn` — the command the old three-argument call refused outright.
      expect(actions.filter((cmd) => cmd.type === 'EndTurn')).toHaveLength(1);

      for (const cmd of actions) {
        yielded += 1;
        if (cmd.type === 'MoveUnit') moves += 1;
        const outcome = applyCommand(state, player.id, cmd, RULESET);
        if (!outcome.ok) {
          refusals.push(`player ${String(player.id)} ${cmdKey(cmd)}: ${errorText(outcome.error)}`);
        }
      }

      // The same commands through the per-unit generator, so `unitActions` is
      // covered by this assertion too and not only `legalActions`.
      for (const unit of state.units.filter((candidate) => candidate.owner === player.id)) {
        for (const cmd of unitActions(state, RULESET, unit.id)) {
          yielded += 1;
          const outcome = applyCommand(state, player.id, cmd, RULESET);
          if (!outcome.ok) {
            refusals.push(`unit ${String(unit.id)} ${cmdKey(cmd)}: ${errorText(outcome.error)}`);
          }
        }
      }
    }

    // Not a token example: every command either generator produced was applied,
    // and the set spans moves as well as the turn advance.
    expect(refusals).toEqual([]);
    expect(yielded).toBeGreaterThan(0);
    expect(moves).toBeGreaterThan(0);

    // The three-argument spelling is gone from the type — the same function is
    // still four parameters wide, and the old call site above does not compile.
    expect(typeof applyWithThreeArguments).toBe('function');
    expect(applyCommand.length).toBe(4);
  });

  it('EndTurn is total: a ruleset-foreign unit type is carried over, never refused', () => {
    const state = generated(42);
    const player = state.players[0];
    if (player === undefined) throw new Error('no players');

    const foreignUnit = state.units[0];
    const nativeUnit = state.units[1];
    if (foreignUnit === undefined || nativeUnit === undefined) {
      throw new Error('seed 42 needs two starting units');
    }
    const nativeDef = unitDef(RULESET, nativeUnit.type);
    if (nativeDef === undefined) throw new Error('the starting unit type is not in the ruleset');

    // A state `GameState` permits and `newGame`/the scenario DSL cannot build: a
    // unit whose type the ruleset does not define. INTERFACES.md M2 names exactly
    // this state as the one that used to make `EndTurn` non-total.
    const foreignType = asUnitTypeId('not-in-any-catalog');
    expect(unitDef(RULESET, foreignType)).toBeUndefined();

    // The foreign unit's budget sits above *every* catalogued movement, so
    // "carried over untouched" cannot be confused with "refilled to some value";
    // the native unit starts at zero, so its refill is observable, not vacuous.
    const foreignMovement =
      RULESET.units.reduce((max, definition) => Math.max(max, definition.movement), 0) + 3;
    const foreignUnitBefore = { ...foreignUnit, type: foreignType, movementLeft: foreignMovement };
    const nativeUnitBefore = { ...nativeUnit, movementLeft: 0 };
    expect(foreignUnitBefore.movementLeft).toBeGreaterThan(nativeDef.movement);
    expect(nativeUnitBefore.movementLeft).not.toBe(nativeDef.movement);

    const foreign: GameState = {
      ...state,
      units: state.units.map((unit) => {
        if (unit.id === foreignUnit.id) return foreignUnitBefore;
        if (unit.id === nativeUnit.id) return nativeUnitBefore;
        return unit;
      }),
    };

    // The generator still offers the turn — that is the half of the keystone
    // property the counterexample broke.
    const yielded = [...legalActions(foreign, RULESET, player.id)];
    expect(yielded.some((cmd) => cmd.type === 'EndTurn')).toBe(true);

    // Totality: the turn applies, and applies exactly once.
    const ended = applyCommand(foreign, player.id, { type: 'EndTurn' }, RULESET);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;

    const after = ended.value.state;
    expect(after.revision).toBe(foreign.revision + 1);
    expect(after.turn).toBe(foreign.turn + 1);
    expect(ended.value.events).toEqual([
      { type: 'TurnEnded', playerId: player.id, turn: foreign.turn + 1 },
    ]);
    expect(after.units.length).toBe(foreign.units.length);

    // The unit whose type no catalog can resolve is left exactly as it was: no
    // guessed budget, no dropped unit, no refusal of the whole turn.
    const carried = after.units.find((unit) => unit.id === foreignUnit.id);
    expect(carried).toEqual(foreignUnitBefore);
    expect(carried?.movementLeft).toBe(foreignMovement);

    // Every unit whose type *is* resolvable is refilled to its own movement.
    const refilled = after.units.find((unit) => unit.id === nativeUnit.id);
    expect(refilled?.movementLeft).toBe(nativeDef.movement);
    for (const unit of after.units) {
      const definition = unitDef(RULESET, unit.type);
      if (definition === undefined) continue;
      expect(unit.movementLeft, `unit ${String(unit.id)}`).toBe(definition.movement);
    }

    // The move half of the generator stays sound in the same state.
    for (const cmd of yielded.filter((candidate) => candidate.type === 'MoveUnit')) {
      expect(applyCommand(foreign, player.id, cmd, RULESET).ok, cmdKey(cmd)).toBe(true);
    }
  });

  it('says nothing about a unit whose owner is not a player (documented claim holds)', () => {
    const state = generated(42);
    const first = state.units[0];
    if (first === undefined) throw new Error('no units');

    const orphan: GameState = { ...state, units: [{ ...first, owner: asPlayerId(7) }] };

    expect(unitMoveOptions(orphan, RULESET, first.id)).toEqual([]);
    expect(unitActions(orphan, RULESET, first.id)).toEqual([]);
    expect([...legalActions(orphan, RULESET, asPlayerId(7))]).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Purity
 * ------------------------------------------------------------------ */

describe('purity — a command never writes to what it was given', () => {
  it('leaves a deep-frozen state and a deep-frozen ruleset untouched', () => {
    const state = generated(4242);
    const ruleset = deepFrozenCopy(structuredClone(RULESET));
    const player = state.players[0];
    if (player === undefined) throw new Error('no players');

    const snapshot = structuredClone(state);
    const before = hashValue(state);
    const unitsRef = state.units;
    const exploredRef = state.explored;
    const mapRef = state.map;
    deepFreeze(state);

    const commands: readonly Command[] = [
      ...legalActions(state, ruleset, player.id),
      { type: 'EndTurn' },
      // A refusal must be just as harmless as an application.
      { type: 'MoveUnit', unitId: asUnitId(0), to: asTileIndex(0) },
      { type: 'MoveUnit', unitId: asUnitId(99), to: asTileIndex(1) },
    ];
    expect(commands.length).toBeGreaterThan(2);

    let applied = 0;
    for (const cmd of commands) {
      const outcome = applyCommand(state, player.id, cmd, ruleset);
      // Whether it applied or not, the input is byte-identical afterwards.
      expect(state, cmdKey(cmd)).toEqual(snapshot);
      expect(hashValue(state), cmdKey(cmd)).toBe(before);

      if (!outcome.ok) continue;
      applied += 1;
      expect(outcome.value.state, cmdKey(cmd)).not.toBe(state);
      expect(outcome.value.state.units, cmdKey(cmd)).not.toBe(unitsRef);
      expect(outcome.value.state.map).toEqual(mapRef);
      expect(outcome.value.state.revision).toBe(state.revision + 1);
      expect(outcome.value.state.turn).toBe(cmd.type === 'EndTurn' ? state.turn + 1 : state.turn);

      // Structural sharing, pinned rather than assumed: a move folds fog and so
      // builds a fresh `explored`; `EndTurn` shares the readonly array by
      // identity (safe because `withExplored` always copies a row before writing
      // to it, and the type is `readonly`). The map is shared either way.
      if (cmd.type === 'MoveUnit') {
        expect(outcome.value.state.explored, cmdKey(cmd)).not.toBe(exploredRef);
      } else {
        expect(outcome.value.state.explored, cmdKey(cmd)).toBe(exploredRef);
      }
    }
    expect(applied).toBeGreaterThan(2);
  });

  it('a refused command leaves revision, turn and the hash alone', () => {
    const state = generated(42);
    const player = state.players[0];
    if (player === undefined) throw new Error('no players');

    const before = hashValue(state);
    const refusals: readonly Command[] = [
      { type: 'MoveUnit', unitId: asUnitId(0), to: asTileIndex(0) },
      { type: 'MoveUnit', unitId: asUnitId(99), to: asTileIndex(1) },
      { type: 'MoveUnit', unitId: asUnitId(1), to: asTileIndex(Number(state.units[0]?.tile ?? 0)) },
    ];

    for (const cmd of refusals) {
      const outcome = applyCommand(state, player.id, cmd, RULESET);
      expect(outcome.ok, cmdKey(cmd)).toBe(false);
    }

    expect(state.revision).toBe(0);
    expect(state.turn).toBe(1);
    expect(hashValue(state)).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Conservation
 * ------------------------------------------------------------------ */

/** One hut event's claim on a unit that did not exist before the move. */
interface UnitClaim {
  readonly id: number;
  readonly owner: number;
  readonly tile: number;
  /** The event that declared it, for the failure message. */
  readonly source: string;
}

/** What one applied move did to the unit set and to the map's huts. */
interface MoveDelta {
  readonly grantedUnits: number;
  readonly barbarianUnits: number;
  readonly hutsConsumed: number;
}

/**
 * Conservation for ONE applied `MoveUnit`: the move changes exactly one
 * *pre-existing* unit's position, keeps every pre-existing unit (and its id)
 * alive and unchanged, and **accounts for every unit that appears** out of the
 * events the command emitted.
 *
 * MIGRATED for M3 (docs/INTERFACES.md M3, "Goody huts"). The pre-M3 assertion was
 * "a legal move moves one unit and nothing else", with the unit count and the whole
 * id sequence pinned to equality. Entering a hut deliberately breaks both: the hut
 * is consumed and may hand the mover a free unit or drop a barbarian band onto the
 * map — reproduced here at `seed 3, unit 1 -> tile 2951`, which emits `UnitMoved`,
 * `HutEntered` and `BarbariansSpawned` and takes the unit count from 2 to 4. So the
 * old equality had to change; the two dishonest ways out were to skip hut-entering
 * moves (leaving conservation unverified for exactly the moves that can violate it)
 * or to keep the equality and let the sweep fail. This states the property that is
 * actually load-bearing instead, and it is **at least as strong** as what it
 * replaces wherever no hut is involved:
 *
 * - every pre-existing unit is still in the state, exactly once, at the same id,
 *   and every pre-existing unit other than the mover is **byte-identical**
 *   (`JSON.stringify` equality, as before);
 * - the pre-existing id sequence is a **prefix** of the new one and the whole
 *   sequence stays strictly ascending, so nothing was renumbered or reordered —
 *   with no event emitted this degenerates to the old "the id sequence is
 *   unchanged" assertion, since no new unit is allowed to appear;
 * - the mover is on `to` (that the step was one tile is checked by the caller,
 *   which also owns the "offered move was refused" case);
 * - **every unit that appears is claimed by an event**: `HutEntered` with
 *   `reward: 'unit'` names its `unitGiven`, and `BarbariansSpawned` names a declared
 *   list of ids with parallel tiles. The claim must match the unit's owner and tile
 *   exactly. A unit nobody declared is a failure, a claim naming a unit that did not
 *   appear is a failure, two events claiming one id is a failure, and a claim on an
 *   id that already existed is a failure — that last one is how a "grant" that
 *   silently *relabelled* an existing unit would be caught;
 * - a hut is consumed exactly when a `HutEntered` says so, and then the state RNG
 *   must have advanced (the reward is drawn from it, and an unadvanced RNG would
 *   make the same reward repeat); a move that emits no `HutEntered` may not remove
 *   a hut, add a unit or move the RNG at all;
 * - a `MoveUnit` emits no city event.
 *
 * Failures accumulate in the shared `failures` array rather than throwing, so one
 * sweep reports every violation it found; the caller asserts the array is empty.
 */
const conserveMove = (
  before: GameState,
  after: GameState,
  events: readonly GameEvent[],
  mover: Unit,
  to: TileIndex,
  label: string,
): MoveDelta => {
  const idsBefore = before.units.map((unit) => Number(unit.id));
  const known = new Set(idsBefore);
  const hutsBefore = before.map.huts.map(Number);

  const first = events[0];
  check(
    first !== undefined && first.type === 'UnitMoved' && first.unitId === mover.id,
    `${label}: the first event is not the moving unit's UnitMoved`,
  );
  check(
    first === undefined ||
      first.type !== 'UnitMoved' ||
      (first.from === mover.tile && first.to === to),
    `${label}: UnitMoved does not describe this step`,
  );

  const claims: UnitClaim[] = [];
  let hutsConsumed = 0;

  for (const event of events) {
    switch (event.type) {
      case 'UnitMoved':
        break;
      case 'HutEntered': {
        hutsConsumed += 1;
        check(event.unitId === mover.id, `${label}: HutEntered names another unit`);
        check(event.owner === mover.owner, `${label}: HutEntered names another owner`);
        check(event.tile === to, `${label}: HutEntered is for a tile the mover is not on`);
        if (event.reward === 'unit') {
          check(event.unitGiven !== undefined, `${label}: reward 'unit' without a unitGiven`);
          if (event.unitGiven !== undefined) {
            claims.push({
              id: Number(event.unitGiven),
              owner: Number(event.owner),
              tile: Number(event.tile),
              source: 'HutEntered',
            });
          }
        } else {
          check(
            event.unitGiven === undefined,
            `${label}: reward ${event.reward} carries a unitGiven`,
          );
        }
        break;
      }
      case 'BarbariansSpawned': {
        check(
          event.unitIds.length === event.tiles.length,
          `${label}: BarbariansSpawned has parallel lists of different length`,
        );
        check(event.unitIds.length > 0, `${label}: BarbariansSpawned names no unit`);
        check(
          event.unitIds.length <= BARBARIAN_BAND_SIZE,
          `${label}: a band of ${String(event.unitIds.length)} exceeds the declared BARBARIAN_BAND_SIZE of ${String(BARBARIAN_BAND_SIZE)}`,
        );
        check(
          before.players.find((player) => player.id === event.owner)?.kind === 'barbarian',
          `${label}: BarbariansSpawned names an owner that is not the barbarian player`,
        );
        for (let index = 0; index < event.unitIds.length; index += 1) {
          const claimedId = event.unitIds[index];
          const claimedTile = event.tiles[index];
          if (claimedId === undefined || claimedTile === undefined) {
            failures.push(`${label}: BarbariansSpawned lists disagree at index ${String(index)}`);
            continue;
          }
          claims.push({
            id: Number(claimedId),
            owner: Number(event.owner),
            tile: Number(claimedTile),
            source: 'BarbariansSpawned',
          });
        }
        break;
      }
      default:
        failures.push(`${label}: a MoveUnit emitted a ${event.type} event`);
        break;
    }
  }

  // --- the units that were already there ---------------------------------
  const idsAfter = after.units.map((unit) => Number(unit.id));
  const duplicated = idsAfter.filter((id, index) => idsAfter.indexOf(id) !== index);
  check(
    duplicated.length === 0,
    `${label}: unit id ${String(duplicated[0])} appears twice after the move`,
  );
  check(
    idsAfter.every((id, index) => index === 0 || (idsAfter[index - 1] ?? -1) < id),
    `${label}: the unit array is no longer sorted by id`,
  );

  const newIds = idsAfter.filter((id) => !known.has(id));
  check(
    JSON.stringify(idsAfter) ===
      JSON.stringify([...idsBefore, ...newIds.slice().sort((a, b) => a - b)]),
    `${label}: the pre-existing unit id sequence is not a prefix of the new one`,
  );

  const othersAfter = after.units.filter(
    (candidate) => candidate.id !== mover.id && known.has(Number(candidate.id)),
  );
  const othersBefore = before.units.filter((candidate) => candidate.id !== mover.id);
  check(
    JSON.stringify(othersAfter) === JSON.stringify(othersBefore),
    `${label}: a pre-existing unit that did not move changed`,
  );

  const moved = after.units.find((candidate) => candidate.id === mover.id);
  check(moved !== undefined, `${label}: the mover disappeared`);
  check(
    moved === undefined || moved.tile === to,
    `${label}: the mover is not on the destination tile`,
  );

  // --- and the units the events are allowed to have added ----------------
  const claimById = new Map<number, UnitClaim>();
  for (const claim of claims) {
    check(!claimById.has(claim.id), `${label}: two events claim unit ${String(claim.id)}`);
    check(
      !known.has(claim.id),
      `${label}: ${claim.source} claims unit ${String(claim.id)}, which existed before the move`,
    );
    claimById.set(claim.id, claim);
  }

  const newIdSet = new Set(newIds);
  for (const id of newIds) {
    const claim = claimById.get(id);
    if (claim === undefined) {
      failures.push(`${label}: unit ${String(id)} appeared without any event accounting for it`);
      continue;
    }
    const appeared = after.units.find((candidate) => Number(candidate.id) === id);
    check(
      appeared !== undefined,
      `${label}: ${claim.source} claims unit ${String(id)} but no such unit is in the state`,
    );
    check(
      appeared === undefined || Number(appeared.owner) === claim.owner,
      `${label}: unit ${String(id)} has owner ${String(appeared?.owner)} but ${claim.source} declared ${String(claim.owner)}`,
    );
    check(
      appeared === undefined || Number(appeared.tile) === claim.tile,
      `${label}: unit ${String(id)} stands on ${String(appeared?.tile)} but ${claim.source} declared ${String(claim.tile)}`,
    );
  }

  for (const [id, claim] of claimById) {
    check(
      newIdSet.has(id),
      `${label}: ${claim.source} claims unit ${String(id)} but no such unit appeared`,
    );
  }

  // --- the hut, and the draw it cost -------------------------------------
  const hutsAfter = after.map.huts.map(Number);
  if (hutsConsumed > 0) {
    check(hutsConsumed === 1, `${label}: one move consumed ${String(hutsConsumed)} huts`);
    check(hutsBefore.includes(Number(to)), `${label}: a hut was entered on a tile that had none`);
    check(
      JSON.stringify(hutsAfter) === JSON.stringify(hutsBefore.filter((hut) => hut !== Number(to))),
      `${label}: the hut on the destination tile was not consumed exactly once`,
    );
    check(
      JSON.stringify(after.rng) !== JSON.stringify(before.rng),
      `${label}: a hut was entered but the state RNG did not advance`,
    );
  } else {
    check(
      JSON.stringify(hutsAfter) === JSON.stringify(hutsBefore),
      `${label}: a hut vanished without a HutEntered event`,
    );
    check(
      JSON.stringify(after.rng) === JSON.stringify(before.rng),
      `${label}: the RNG advanced with no hut to draw from`,
    );
  }

  return {
    grantedUnits: claims.filter((claim) => claim.source === 'HutEntered').length,
    barbarianUnits: claims.filter((claim) => claim.source === 'BarbariansSpawned').length,
    hutsConsumed,
  };
};

describe('conservation — a legal move moves one unit, and every unit that appears is accounted for', () => {
  it('never duplicates, loses or teleports a pre-existing unit, and accounts for every hut unit', () => {
    failures.length = 0;
    let moves = 0;
    let hutsConsumed = 0;
    let grantedUnits = 0;
    let barbarianUnits = 0;

    for (const seed of SWEEP_SEEDS) {
      const state = generated(seed);

      for (const unit of state.units) {
        for (const to of unitMoveOptions(state, RULESET, unit.id)) {
          const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to };
          const outcome = applyCommand(state, unit.owner, cmd, RULESET);
          if (!outcome.ok) {
            failures.push(
              `seed ${String(seed)}: offered move ${cmdKey(cmd)} was refused: ${errorText(outcome.error)}`,
            );
            continue;
          }

          const after = outcome.value.state;
          const label = `seed ${String(seed)} unit ${String(unit.id)} -> ${String(to)}`;
          moves += 1;

          check(
            distance8(after.map, unit.tile, to) === 1,
            `${label}: the unit moved more than one tile`,
          );

          const delta = conserveMove(state, after, outcome.value.events, unit, to, label);
          hutsConsumed += delta.hutsConsumed;
          grantedUnits += delta.grantedUnits;
          barbarianUnits += delta.barbarianUnits;
        }
      }

      // The sweep reads one state for every unit and every offered tile; a state
      // that drifted under it would make every later label a lie.
      check(
        JSON.stringify(state.units) === JSON.stringify(generated(seed).units),
        `seed ${String(seed)}: the conservation sweep mutated the state it was reading`,
      );
    }

    const totals = { seeds: SWEEP_SEEDS.length, moves, hutsConsumed, grantedUnits, barbarianUnits };
    console.log('conservation sweep totals:', JSON.stringify(totals));

    expect(failures).toEqual([]);

    // Non-vacuity, so "every added unit is accounted for" is not a claim about a
    // command that never added one: the sweep must have walked real moves, and the
    // seeds it uses must really have entered huts and really have spawned a band.
    // (`grantedUnits` is 0 on this seed set by design — the free-unit branch is
    // covered by its own test below, which does not lean on these seeds.)
    expect(moves).toBeGreaterThan(150);
    expect(hutsConsumed).toBeGreaterThan(0);
    expect(barbarianUnits).toBeGreaterThan(0);
  });

  it('keeps movementLeft within [0, movement] and equal to old minus destination cost', () => {
    failures.length = 0;
    const checked: string[] = [];

    for (const seed of SWEEP_SEEDS) {
      const state = generated(seed);

      for (const unit of state.units) {
        const definition = unitDef(RULESET, unit.type);
        check(definition !== undefined, `seed ${String(seed)}: unit type is not in the ruleset`);

        for (const to of unitMoveOptions(state, RULESET, unit.id)) {
          const outcome = applyCommand(
            state,
            unit.owner,
            { type: 'MoveUnit', unitId: unit.id, to },
            RULESET,
          );
          if (!outcome.ok) continue;

          const moved = outcome.value.state.units.find((candidate) => candidate.id === unit.id);
          if (moved === undefined) {
            failures.push(`seed ${String(seed)}: the mover disappeared`);
            continue;
          }

          const cost = terrainCostAt(state, to);
          const label = `seed ${String(seed)} unit ${String(unit.id)} -> ${String(to)}`;
          check(cost !== undefined, `${label}: no terrain cost for the destination`);
          check(moved.movementLeft >= 0, `${label}: negative movementLeft`);
          check(
            definition === undefined || moved.movementLeft <= definition.movement,
            `${label}: movementLeft exceeds the unit's movement`,
          );
          check(moved.movementLeft <= unit.movementLeft, `${label}: movementLeft grew`);
          check(
            cost === undefined || moved.movementLeft === unit.movementLeft - cost,
            `${label}: movementLeft is not old - destination cost`,
          );
          checked.push(label);
        }
      }
    }

    expect(failures).toEqual([]);
    expect(checked.length).toBeGreaterThan(100);
  });

  it('offers exactly the adjacent tiles the engine accepts, for every neighbour', () => {
    failures.length = 0;
    for (const seed of SWEEP_SEEDS) {
      const state = generated(seed);

      for (const unit of state.units) {
        const offered = new Set(unitMoveOptions(state, RULESET, unit.id).map(Number));

        for (const to of neighbors8(state.map, unit.tile)) {
          const accepted = applyCommand(
            state,
            unit.owner,
            { type: 'MoveUnit', unitId: unit.id, to },
            RULESET,
          ).ok;
          check(
            accepted === offered.has(Number(to)),
            `seed ${String(seed)} unit ${String(unit.id)}: tile ${String(to)} offered=${String(offered.has(Number(to)))} accepted=${String(accepted)}`,
          );
        }

        // A unit can never end on a tile it could not afford: every neighbour
        // whose cost exceeds the remaining movement is refused, by reason.
        for (const to of neighbors8(state.map, unit.tile)) {
          const cost = terrainCostAt(state, to);
          if (cost === undefined || cost <= unit.movementLeft) continue;
          const outcome = applyCommand(
            state,
            unit.owner,
            { type: 'MoveUnit', unitId: unit.id, to },
            RULESET,
          );
          if (outcome.ok) {
            failures.push(
              `seed ${String(seed)} unit ${String(unit.id)}: paid ${String(cost)} with ${String(unit.movementLeft)} left`,
            );
          } else if (
            outcome.error.kind !== 'impassable' &&
            outcome.error.kind !== 'occupied-by-enemy'
          ) {
            check(
              outcome.error.kind === 'not-enough-movement',
              `seed ${String(seed)}: unaffordable tile refused as ${outcome.error.kind}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('EndTurn refills every unit to its type movement and advances the round once', () => {
    let turns = 0;

    for (const seed of SWEEP_SEEDS) {
      const state = generated(seed);
      const player = state.players[0];
      if (player === undefined) continue;

      const outcome = applyCommand(state, player.id, { type: 'EndTurn' }, RULESET);
      expect(outcome.ok, `seed ${String(seed)}`).toBe(true);
      if (!outcome.ok) continue;

      const after = outcome.value.state;
      expect(after.turn).toBe(state.turn + 1);
      expect(after.revision).toBe(state.revision + 1);
      expect(after.units.length).toBe(state.units.length);

      for (const unit of after.units) {
        const definition = unitDef(RULESET, unit.type);
        if (definition === undefined) continue;
        expect(unit.movementLeft, `seed ${String(seed)} unit ${String(unit.id)}`).toBe(
          definition.movement,
        );
      }
      turns += 1;
    }
    expect(turns).toBe(SWEEP_SEEDS.length);
  });
});

/* ------------------------------------------------------------------ *
 * 3b. Huts — every reward branch, and the surface itself
 * ------------------------------------------------------------------ */

/**
 * Seeds whose first steps enter a hut, chosen for **branch coverage** rather than
 * for looks: on this seed set the three reward kinds all occur (probed, and
 * asserted below, so a branch that drifts away fails loudly instead of silently
 * leaving a branch untested).
 *
 * A separate list on purpose. `SWEEP_SEEDS` drives the keystone sweep as well, and
 * the counts that test pins (`legalActions`, `enumerated`, `accepted` …) are part
 * of its evidence — quietly appending a seed there to reach the free-unit branch
 * would move another test's totals as a side effect.
 */
const HUT_BRANCH_SEEDS: readonly number[] = [3, 5, 57];

describe('hut rewards — conservation holds on every branch, not only where no hut is entered', () => {
  it('accounts for the units the free-unit branch adds, and for the band, and for nothing', () => {
    failures.length = 0;
    const rewards: string[] = [];
    let hutMoves = 0;

    for (const seed of HUT_BRANCH_SEEDS) {
      const state = generated(seed);

      for (const unit of state.units) {
        for (const to of unitMoveOptions(state, RULESET, unit.id)) {
          // `hutAt` is the public read of the map's hut list (`@civts/core`); the
          // sweep asks it rather than re-deriving "is this a hut tile?" from
          // `map.huts`, so the predicate the engine uses is the one under test.
          if (!hutAt(state, Number(to))) continue;

          const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to };
          const outcome = applyCommand(state, unit.owner, cmd, RULESET);
          if (!outcome.ok) {
            failures.push(
              `seed ${String(seed)}: offered hut move ${cmdKey(cmd)} was refused: ${errorText(outcome.error)}`,
            );
            continue;
          }

          hutMoves += 1;
          const label = `seed ${String(seed)} unit ${String(unit.id)} -> hut ${String(to)}`;
          const delta = conserveMove(
            state,
            outcome.value.state,
            outcome.value.events,
            unit,
            to,
            label,
          );
          check(delta.hutsConsumed === 1, `${label}: the hut was not consumed`);

          for (const event of outcome.value.events) {
            if (event.type === 'HutEntered') rewards.push(event.reward);
          }
        }
      }
    }

    const observed = [...new Set(rewards)].sort();
    console.log(
      'hut branch sweep:',
      JSON.stringify({ seeds: HUT_BRANCH_SEEDS.length, hutMoves, rewards: observed }),
    );

    expect(failures).toEqual([]);
    expect(hutMoves).toBeGreaterThanOrEqual(HUT_BRANCH_SEEDS.length);
    // All three branches — including the free-unit one, which `SWEEP_SEEDS` never
    // draws — so the "every added unit is claimed by an event" half of
    // `conserveMove` is exercised on a branch that really does add a unit.
    expect(observed).toEqual([...HUT_REWARD_KINDS].sort());
  });

  it('is a non-event away from a hut: no consumption, no event, no draw', () => {
    const state = generated(57);
    const unit = state.units.find((candidate) => !hutAt(state, Number(candidate.tile)));
    if (unit === undefined) throw new Error('every unit starts on a hut — the fixture is broken');

    // No hut under the unit ⇒ `undefined`: no consumption, no event, no draw.
    expect(resolveHutEntry(state, RULESET, unit.id)).toBeUndefined();

    // An id that resolves to nothing is the same non-event, not a throw.
    const absent = Math.max(...state.units.map((candidate) => Number(candidate.id))) + 1;
    expect(resolveHutEntry(state, RULESET, asUnitId(absent))).toBeUndefined();
  });

  it('surfaces the hut surface from @civts/core, with the provenance it claims', () => {
    // The five names the M3 hut workstream owes its consumers, reached through the
    // package entry point rather than the module path — a missing `export * from
    // './hut.js'` in `index.ts` is exactly the integration gap this pins.
    expect(typeof hutAt).toBe('function');
    expect(typeof resolveHutEntry).toBe('function');
    expect([...HUT_REWARD_KINDS]).toEqual(['unit', 'barbarians', 'nothing']);
    expect(Number.isInteger(BARBARIAN_BAND_SIZE)).toBe(true);
    expect(BARBARIAN_BAND_SIZE).toBeGreaterThan(0);

    // PROVENANCE (docs/INTERFACES.md M3, "Provenance warning"): the hut numbers are
    // ours, chosen to be playable, and the row says so. `cited-only` fidelity must
    // keep refusing while this is a placeholder, so a `cited` spelling here would
    // be a false claim about Civ 3 rather than a typo.
    const provenance = HUT_REWARD_PROVENANCE;
    expect(isPlaceholder(provenance)).toBe(true);
    expect(provenance.kind).toBe('placeholder');
    if (isPlaceholder(provenance)) {
      // "Plainly unsourced and chosen to be playable", in the row's own words.
      expect(provenance.note).toMatch(/unsourced/i);
      expect(provenance.note).toMatch(/playable/i);
      // …and explicitly *not* an accuracy claim, with the deliberate absence of
      // `gold` named rather than silently omitted (INTERFACES.md M3, "Goody huts").
      expect(provenance.note).toMatch(/not traced to civ 3/i);
      expect(provenance.note).toMatch(/gold/i);
    }

    // And the read itself, against a real generated map: every declared hut is a
    // hut, and a tile that is not one is not one.
    const state = generated(42);
    expect(state.map.huts.length).toBeGreaterThan(0);
    const huts = new Set(state.map.huts.map(Number));
    for (const hut of state.map.huts) {
      expect(hutAt(state, Number(hut)), `declared hut ${String(hut)}`).toBe(true);
    }
    const notAHut = Array.from(
      { length: state.map.width * state.map.height },
      (_, index) => index,
    ).find((tile) => !huts.has(tile));
    expect(notAHut).toBeDefined();
    if (notAHut !== undefined) expect(hutAt(state, notAHut)).toBe(false);

    // Out of bounds is "no hut", not an error: the predicate is total.
    expect(hutAt(state, -1)).toBe(false);
    expect(hutAt(state, state.map.width * state.map.height)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Fog honesty
 * ------------------------------------------------------------------ */

const gridCells = (render: string): string =>
  render
    .split('\n')
    .filter((line) => /^\s*\d+ \|/.test(line))
    .map((line) => line.slice(line.indexOf('|') + 1))
    .join('');

const countGlyph = (text: string, glyph: string): number => text.split(glyph).length - 1;

const unexploredCount = (state: GameState, playerId: PlayerId): number =>
  (state.explored[Number(playerId)] ?? []).filter((seen) => !seen).length;

describe('fog honesty — memory only grows and never lies', () => {
  it('newGame marks exactly what its starting unit can see', () => {
    for (const seed of SWEEP_SEEDS) {
      const state = generated(seed);
      const size = state.map.width * state.map.height;

      for (const player of state.players) {
        const visible = visibleTiles(state, player.id);
        const explored = (state.explored[Number(player.id)] ?? []).flatMap((seen, tile) =>
          seen ? [tile] : [],
        );

        expect(visible.map(Number), `seed ${String(seed)} player ${String(player.id)}`).toEqual(
          explored,
        );
        expect((state.explored[Number(player.id)] ?? []).length).toBe(size);
        for (const tile of visible) {
          expect(Number(tile)).toBeGreaterThanOrEqual(0);
          expect(Number(tile)).toBeLessThan(size);
        }
      }
    }
  });

  it('only grows explored, keeps every visible tile explored, and stays in bounds', () => {
    failures.length = 0;
    for (const seed of SWEEP_SEEDS) {
      let state = generated(seed);
      const size = state.map.width * state.map.height;
      let previous = state.explored.map((row) => [...row]);
      const prng = makePrng(seed);

      for (let step = 0; step < SWEEP_STEPS; step += 1) {
        const actor = state.players[prng() % state.players.length];
        if (actor === undefined) break;
        const options = [...legalActions(state, RULESET, actor.id)];
        const next = options[prng() % options.length];
        if (next === undefined) break;

        const outcome = applyCommand(state, actor.id, next, RULESET);
        expect(outcome.ok, `seed ${String(seed)} step ${String(step)}: ${cmdKey(next)}`).toBe(true);
        if (!outcome.ok) break;

        const after = outcome.value.state;

        after.explored.forEach((row, index) => {
          expect(row.length, `seed ${String(seed)}: explored row ${String(index)} length`).toBe(
            size,
          );
          row.forEach((seen, tile) => {
            const was = previous[index]?.[tile] === true;
            if (was && !seen) {
              failures.push(
                `seed ${String(seed)}: explored shrank for player ${String(index)} at tile ${String(tile)}`,
              );
            }
          });
        });

        for (const player of after.players) {
          for (const tile of visibleTiles(after, player.id)) {
            check(
              Number(tile) >= 0 && Number(tile) < size,
              `seed ${String(seed)}: visibleTiles returned out-of-bounds tile ${String(tile)}`,
            );
            check(
              isExplored(after, player.id, tile),
              `seed ${String(seed)}: tile ${String(tile)} is visible to player ${String(player.id)} but not explored`,
            );
          }
        }

        state = after;
        previous = after.explored.map((row) => [...row]);
      }
    }
    expect(failures).toEqual([]);
  });

  it('never returns an out-of-bounds tile, whatever radius it is handed', () => {
    const state = generated(42);
    const player = state.players[0];
    if (player === undefined) throw new Error('no players');
    const size = state.map.width * state.map.height;

    const radii: readonly (number | undefined)[] = [
      undefined,
      -5,
      -1,
      0,
      0.5,
      1,
      2,
      1_000_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const radius of radii) {
      const tiles = visibleTiles(state, player.id, radius);
      for (const tile of tiles) {
        expect(Number.isInteger(Number(tile))).toBe(true);
        expect(Number(tile)).toBeGreaterThanOrEqual(0);
        expect(Number(tile)).toBeLessThan(size);
      }
      expect(new Set(tiles.map(Number)).size).toBe(tiles.length);
    }

    expect(isExplored(state, player.id, asTileIndex(-1))).toBe(false);
    expect(isExplored(state, player.id, asTileIndex(size))).toBe(false);
    expect(visibleTiles(state, asPlayerId(9)).length).toBe(0);
  });

  it('withExplored is pure, ignores off-map tiles, and invents no players', () => {
    const state = generated(42);
    const player = state.players[0];
    if (player === undefined) throw new Error('no players');
    const size = state.map.width * state.map.height;

    const before = hashValue(state);
    const snapshot = structuredClone(state);
    deepFreeze(state);

    const grown = withExplored(state, player.id, [
      asTileIndex(-1),
      asTileIndex(0),
      asTileIndex(size),
      asTileIndex(0),
    ]);

    expect(state).toEqual(snapshot);
    expect(hashValue(state)).toBe(before);
    expect(grown.explored[Number(player.id)]?.[0]).toBe(true);
    expect(grown.explored[Number(player.id)]?.length).toBe(size);

    // Unknown player: no row to write, so the state comes back unchanged.
    expect(withExplored(state, asPlayerId(9), [asTileIndex(0)])).toBe(state);
  });

  it('renders only explored terrain for a viewer (god mode is the distinct case)', () => {
    const state = generated(42);
    const player = state.players[0];
    if (player === undefined) throw new Error('no players');

    const godCells = gridCells(renderState(state, RULESET));
    expect(godCells.length).toBe(state.map.width * state.map.height);
    // Every terrain id in a generated map is in the validated catalog, so god
    // mode has nothing unknown to draw.
    expect(countGlyph(godCells, '?')).toBe(0);

    const viewerCells = gridCells(renderState(state, RULESET, { viewer: player.id }));
    expect(viewerCells.length).toBe(state.map.width * state.map.height);
    expect(countGlyph(viewerCells, '?')).toBe(unexploredCount(state, player.id));

    // A legal move grows memory by exactly the newly explored tiles, and the
    // viewer render reveals exactly that many more cells.
    const move = unitMoveOptions(state, RULESET, state.units[0]?.id ?? asUnitId(0))[0];
    const unit = state.units[0];
    if (move === undefined || unit === undefined) throw new Error('seed 42 has no legal move');

    const outcome = applyCommand(
      state,
      unit.owner,
      { type: 'MoveUnit', unitId: unit.id, to: move },
      RULESET,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const afterCells = gridCells(renderState(outcome.value.state, RULESET, { viewer: player.id }));
    const before = unexploredCount(state, player.id);
    const after = unexploredCount(outcome.value.state, player.id);
    expect(after).toBeLessThan(before);
    expect(countGlyph(afterCells, '?')).toBe(after);
    expect(before - after).toBe(countGlyph(viewerCells, '?') - countGlyph(afterCells, '?'));
  });

  it('documents the asymmetry: a scenario-built world starts with no fog memory', () => {
    const builder = createScenarioBuilder(RULESET);
    const built = builder
      .addPlayer('Rome')
      .addPlayer('Egypt')
      .fillTerrain('grassland')
      .addUnit(0, asUnitTypeId('settler'), [1, 1])
      .addUnit(1, asUnitTypeId('settler'), [5, 5])
      .build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const state = built.value;
    const rome = state.players[0];
    if (rome === undefined) throw new Error('no players');

    // Documented design choice in scenario.ts, and an observable asymmetry with
    // newGame: the builder's players remember nothing, while their units can
    // already see. A scenario-driven render therefore starts fully fogged.
    expect((state.explored[Number(rome.id)] ?? []).filter((seen) => seen).length).toBe(0);
    const visible = visibleTiles(state, rome.id);
    expect(visible.length).toBeGreaterThan(0);
    for (const tile of visible) expect(isExplored(state, rome.id, tile)).toBe(false);

    // One step folds the unit's sight into memory: from then on the invariant
    // `visible ⊆ explored` holds, as it does in a generated game.
    const move = unitMoveOptions(state, RULESET, asUnitId(0))[0];
    if (move === undefined) throw new Error('no legal move in the scenario world');
    const outcome = applyCommand(
      state,
      rome.id,
      { type: 'MoveUnit', unitId: asUnitId(0), to: move },
      RULESET,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const after = outcome.value.state;
    const afterVisible = visibleTiles(after, rome.id);
    expect(afterVisible.length).toBeGreaterThan(0);
    for (const tile of afterVisible) expect(isExplored(after, rome.id, tile)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Determinism
 * ------------------------------------------------------------------ */

/**
 * The reference play sequence, shared by the in-process and fresh-process
 * checks. It must stay identical to the script embedded in the child process
 * below: two independent paths to the same hash is the point of the exercise.
 */
const playSequence = (seed: number, steps: number): GameState => {
  let state = generated(seed);

  for (let step = 0; step < steps; step += 1) {
    const actor = state.players[step % state.players.length];
    if (actor === undefined) break;
    const options = [...legalActions(state, RULESET, actor.id)];
    const next = options[step % options.length];
    if (next === undefined) break;

    const outcome = applyCommand(state, actor.id, next, RULESET);
    if (!outcome.ok) throw new Error(`step ${String(step)}: ${cmdKey(next)} refused`);
    state = outcome.value.state;
  }
  return state;
};

const DETERMINISM_STEPS = 24;

/**
 * `tsx` is a devDependency (`pnpm play` and `pnpm map` already need it), and its
 * `./cli` export is the entry point the `tsx` bin runs. A missing install is a
 * broken checkout, so the failure says so instead of surfacing a bare
 * module-not-found from deep inside a spawn.
 */
const tsxCliPath = (): string => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch (cause) {
    throw new Error(
      'the fresh-process checks need the `tsx` devDependency (resolved as "tsx/cli"): ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
};
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Run a throwaway TypeScript program in a fresh Node process and capture stdout. */
const runInFreshProcess = (
  script: string,
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [tsxCliPath(), '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const launchFailure = result.error === undefined ? '' : `launch failed: ${result.error.message}`;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: `${result.stderr}${launchFailure}`,
  };
};

/** The same play loop as `playSequence`, written out for the child process. */
const CHILD_SCRIPT = `
import { DEFAULT_SETTINGS, applyCommand, legalActions, newGame } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const play = (seed, steps) => {
  const settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed };
  const started = newGame(seed, settings, ruleset);
  if (!started.ok) throw new Error('newGame failed');
  let state = started.value;
  for (let step = 0; step < steps; step += 1) {
    const actor = state.players[step % state.players.length];
    if (actor === undefined) break;
    const options = [...legalActions(state, ruleset, actor.id)];
    const next = options[step % options.length];
    if (next === undefined) break;
    const outcome = applyCommand(state, actor.id, next, ruleset);
    if (!outcome.ok) throw new Error('a legal action was refused');
    state = outcome.value.state;
  }
  return hashValue(state);
};

for (const seed of [1, 42, 1337]) {
  console.log('HASH ' + String(seed) + ' ' + play(seed, ${String(DETERMINISM_STEPS)}));
}
`;

describe('determinism — the same seed and commands hash the same, everywhere', () => {
  it('reproduces identical hashes in-process', () => {
    const hashes = GOLDEN_SEEDS.map((seed) => {
      const first = playSequence(seed, DETERMINISM_STEPS);
      const second = playSequence(seed, DETERMINISM_STEPS);
      expect(hashValue(second), `seed ${String(seed)}`).toBe(hashValue(first));
      expect(second).toEqual(first);
      return hashValue(first);
    });

    console.log('in-process hashes:', hashes.join(' '));
    expect(new Set(hashes).size).toBe(GOLDEN_SEEDS.length);
  });

  it('reproduces the same hashes in a fresh process (tsx -e)', () => {
    const expected = GOLDEN_SEEDS.map((seed) => hashValue(playSequence(seed, DETERMINISM_STEPS)));

    const child = runInFreshProcess(CHILD_SCRIPT);
    expect(child.status, `fresh process failed:\n${child.stderr}`).toBe(0);

    const observed = child.stdout
      .split('\n')
      .filter((line) => line.startsWith('HASH '))
      .map((line) => line.slice('HASH '.length).trim());

    console.log('fresh-process hashes:', observed.join(' | '));
    expect(observed.length).toBe(GOLDEN_SEEDS.length);

    const childHashes = observed.map((line) => line.split(' ')[1] ?? '');
    expect(childHashes).toEqual(expected);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Goldens
 * ------------------------------------------------------------------ */

describe('goldens — still a real, non-vacuous gate', () => {
  it('stores exactly the hashes this build produces for the golden scenarios', () => {
    const stored = loadGoldens();
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    const computed = GOLDEN_SEEDS.map((seed) => ({
      name: `tiny-civs2-seed${String(seed)}`,
      hash: hashValue(generated(seed)),
    }));

    console.log('recomputed goldens:', computed.map((entry) => entry.hash).join(' '));

    // An independent reconstruction: if generation, state assembly or the hasher
    // drifts, this fails with the expected/actual pair even if golden.test.ts
    // were somehow weakened.
    expect(stored.entries).toEqual(computed);
    expect(new Set(stored.entries.map((entry) => entry.hash)).size).toBe(GOLDEN_SEEDS.length);
    expect(
      stored.entries.every((entry) => /^[0-9a-f]{16}$/.test(entry.hash)),
      'every hash is a 16-character FNV-1a 64 digest',
    ).toBe(true);

    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(stored.nodeMajor).toBe(nodeMajor);
  });

  it('would catch a change: a one-field perturbation moves the hash', () => {
    const state = generated(42);
    const baseline = hashValue(state);
    const unit = state.units[0];
    if (unit === undefined) throw new Error('no units');

    const perturbations: readonly GameState[] = [
      { ...state, turn: state.turn + 1 },
      { ...state, revision: state.revision + 1 },
      { ...state, nextUnitId: state.nextUnitId + 1 },
      { ...state, rng: { ...state.rng, a: state.rng.a + 1 } },
      {
        ...state,
        units: [{ ...unit, movementLeft: unit.movementLeft + 1 }, ...state.units.slice(1)],
      },
      {
        ...state,
        units: [{ ...unit, tile: asTileIndex(Number(unit.tile) + 1) }, ...state.units.slice(1)],
      },
      {
        ...state,
        explored: state.explored.map((row, index) => (index === 0 ? [true, ...row.slice(1)] : row)),
      },
    ];

    for (const perturbed of perturbations) {
      expect(hashValue(perturbed), JSON.stringify(perturbed.turn)).not.toBe(baseline);
    }
  });

  /**
   * A precision note found while building the golden reconstruction above.
   *
   * `newGame(seed, settings, ruleset)` uses its first argument to generate the
   * world and stores `settings` **verbatim** in the state. Nothing forces the two
   * to agree: a caller that leaves `settings.seed` at `DEFAULT_SETTINGS.seed`
   * (1) while generating from seed 42 gets a byte-identical *world* that hashes
   * differently — the hash covers `(world, settings)`, not the world alone. The
   * CLI and the golden harness both set `settings.seed` from `--seed`, so they
   * agree; a future save-file loader or UI that passes settings through must do
   * the same or its "same seed" states will not match the goldens.
   */
  it('shows that settings.seed and the generation seed are independent inputs', () => {
    const stale = newGame(42, { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 }, RULESET);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;

    const aligned = generated(42);

    // Same world, same generation seed…
    expect(stale.value.seed).toBe(aligned.seed);
    expect(stale.value.map.terrain).toEqual(aligned.map.terrain);
    expect(stale.value.units).toEqual(aligned.units);
    expect(stale.value.settings.seed).toBe(DEFAULT_SETTINGS.seed);
    // …and a different hash, because `settings` is part of the state.
    expect(hashValue(stale.value)).not.toBe(hashValue(aligned));
  });
});

/* ------------------------------------------------------------------ *
 * 7. The REPL, through its frozen surface: the real CLI
 * ------------------------------------------------------------------ */

const cliPath = join(repoRoot, 'packages/headless/src/cli.ts');

const runCli = (args: readonly string[], input = '') =>
  spawnSync(process.execPath, [tsxCliPath(), cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    input,
  });

describe('the REPL — a scripted session is a stable regression fixture', () => {
  it('prints byte-identical transcripts in two fresh processes and exits 0', () => {
    const state = generated(42);
    const unit = state.units[0];
    if (unit === undefined) throw new Error('no units');
    const target = unitMoveOptions(state, RULESET, unit.id)[0];

    const lines = ['units', 'state'];
    if (target !== undefined) {
      lines.push(
        `move ${String(unit.id)} ${String(indexToX(state.map, target))} ${String(indexToY(state.map, target))}`,
      );
    }
    lines.push('end', 'bogus', 'quit');

    const directory = mkdtempSync(join(tmpdir(), 'civts-m2-adversarial-'));
    try {
      const scriptPath = join(directory, 'session.txt');
      writeFileSync(scriptPath, `${lines.join('\n')}\n`, 'utf8');

      const args = [
        'play',
        '--seed',
        '42',
        '--map-size',
        'tiny',
        '--civs',
        '2',
        '--script',
        scriptPath,
      ];
      const first = runCli(args);
      const second = runCli(args);

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout.length).toBeGreaterThan(200);
      expect(second.stdout).toBe(first.stdout);

      expect(first.stdout).toContain('ok: turn 2 begins');
      expect(first.stdout).toContain('error: unknown command "bogus"');
      if (target !== undefined)
        expect(first.stdout).toContain(`ok: unit ${String(unit.id)} moved to`);
      expect(first.stdout).not.toMatch(/undefined|NaN/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exits 0 at end of input instead of hanging', () => {
    const result = runCli(['play', '--seed', '42', '--map-size', 'tiny'], '');
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(/undefined|NaN/);
  });
});

/* ------------------------------------------------------------------ *
 * A note on what is deliberately NOT tested here
 * ------------------------------------------------------------------ *
 * The cast / `any` / non-null / eslint-disable audit of packages/core/src and
 * packages/testing/src is reported in prose rather than asserted, because the
 * guarantees it covers are already enforced by the gate: the eslint config runs
 * `strictTypeChecked` over both trees (which makes non-null assertions and `any`
 * errors in `src/`), and the only narrowing cast in `core` outside the branded
 * id constructors in ids.ts is settings.ts:119 `(item as { key?: unknown }).key`.
 * A source-scanning test here would duplicate the lint rule and could only add
 * false positives. The M2 files add no cast, no `any`, no `!` and no disable.
 */
