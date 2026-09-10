/**
 * M3 adversarial review (F4, integration + review owner) — an attempt to
 * FALSIFY the M3 contracts in docs/INTERFACES.md, not to confirm them.
 *
 * This file was written after trying to break the implementation by hand
 * (throwaway probes under /tmp, including the one that produced the hut-walk
 * seeds reused below). What survived is pinned here; the few things that did not
 * hold are named in the comments at the site, and everything this review could
 * NOT turn into an assertion is reported in prose to the chief of staff rather
 * than dressed up as a test.
 *
 * The five attacks the M3 review owed, and what each turned into:
 *
 * 1. **The keystone, over four generators.** `unitMoveOptions`, `unitActions`
 *    and `legalActions` must agree with `applyCommand` in *both* directions, and
 *    the two city planners (`planSetWorkedTiles`, `planSetProduction`) must be the
 *    applier's decision for the commands no generator enumerates. The sweep below
 *    runs deep — after cities exist, after production has completed items, with
 *    settlers that can found and settlers that cannot — rather than only on fresh
 *    `newGame` states, which is what `m2-adversarial.test.ts` already covers.
 * 2. **Hut honesty.** Consumption happens exactly once and never re-triggers; the
 *    reward is exactly the kind the state RNG's next draw selects; the RNG
 *    advances by exactly one draw; a sea unit and a city never trigger; a hut
 *    under fog is not drawn and adds no legend entry.
 * 3. **Economy conservation over long runs** (110 turns, several seeds, real
 *    cities, real production, deliberate starvation pressure): population never
 *    below 1, `foodBox` never negative and never at or above the threshold,
 *    shields never negative, food and shields carried over without invention or
 *    loss, a city never works more tiles than it has citizens, no two cities work
 *    the same tile, and barbarians never gain a city.
 * 4. **Determinism**, in-process and in a fresh `tsx` process, over a scripted
 *    sequence that founds cities, queues production, enters huts and ends turns —
 *    comparing not only the final hash but the whole event list, so a hut reward
 *    that differed between processes could not hide behind a hash collision.
 * 5. **Whether the goldens are still a real gate.** The golden harness is run
 *    against a *throwaway copy* of the repo with one stored hash corrupted: the
 *    run must fail with the expected/actual pair and must leave the file on disk
 *    byte-identical. That is the claim "still refusing to auto-write", tested
 *    where it lives instead of asserted in prose.
 *
 * Evidence quality, stated so that this file is not oversold:
 *
 * - The keystone checks for `MoveUnit` and `FoundCity` are genuinely two-sided
 *   against `applyCommand`. For the two city setters the planner *is* the
 *   applier's decision by construction (the applier calls `planSetWorkedTiles` /
 *   `planSetProduction`), so what those sweeps verify is the wiring, the refusal
 *   *reason* and the state effects of acceptance; the content of the rule is
 *   pinned by `packages/core/test/commands.test.ts`. The state-level checks that
 *   accompany them — one tile per citizen at most, no tile worked by two cities,
 *   every worked tile inside the radius and none of them the centre — are
 *   independent of the planner.
 * - Sixteen defects were injected one at a time into a stable
 *   `packages/core/src` file (dropped food carry-over; population allowed to
 *   reach 0; an unchallenged shield cost for a building and for a unit; a
 *   completion granted without affordability; a hut that is never consumed; a
 *   hut that fires for a sea unit, and one that fires inside a city; two draws
 *   per entry; growth and production swapped; `FoundCity` dropped from
 *   `unitActions` and offered when it may not be founded; cross-city tile claims
 *   allowed; the too-many-tiles rule dropped), and each one made this file fail.
 *   Every probe was reverted byte-for-byte, verified by digest.
 * - One probe did **not** fail it and is reported rather than hidden: turning
 *   growth's `while` into an `if` is unreachable through the command layer,
 *   because with this catalog the largest possible food surplus is a city
 *   centre's floor — terrain food never exceeds the 2 a citizen eats — so no city
 *   can cross two thresholds in one turn. `commands.test.ts` pins that branch
 *   with a foreign ruleset view instead, which is the only way to reach it.
 *
 * On provenance: nothing here blesses a number as Civ 3's. The growth thresholds
 * this file pins (`FOOD_BOX_BASE`/`FOOD_BOX_PER_CITIZEN`, and `foodBoxSize`'s
 * linear shape) are the project's own **placeholders**, and the tests read them
 * from `@civts/core` rather than restating them, so a future sourced rehash
 * changes one place. `20 + 2*pop` is Civ IV, not Civ III, and is not asserted
 * anywhere in this file.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  HUT_REWARD_KINDS,
  applyCommand,
  applyGrowth,
  applyProduction,
  asBuildingId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  cityById,
  cityRadius,
  cityYields,
  civPlayers,
  citiesOf,
  describe as renderState,
  distance8,
  foodBoxSize,
  hutAt,
  itemCost,
  legalActions,
  newGame,
  nextBelow,
  planFoundCity,
  planSetProduction,
  planSetWorkedTiles,
  resolveHutEntry,
  unitActions,
  unitById,
  unitDef,
  unitMoveOptions,
  visibleTiles,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type ProductionItem,
  type RulesetView,
  type CityId,
  type Settings,
  type TileIndex,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { loadGoldens } from '../src/goldens.js';
import { createScenarioBuilder, hashValue, type ScenarioBuilder } from '../src/index.js';

/* ------------------------------------------------------------------ *
 * Fixtures and small helpers
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

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2 };

const settingsFor = (seed: number, civCount: number = SETTINGS.civCount): Settings => ({
  ...SETTINGS,
  seed,
  civCount,
});

const generatedFor = (seed: number, civCount: number = SETTINGS.civCount): GameState => {
  const result = newGame(seed, settingsFor(seed, civCount), RULESET);
  if (!result.ok)
    throw new Error(`newGame(${String(seed)}) failed: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** A deterministic 32-bit PRNG: the sweeps must not depend on anything ambient. */
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
 * Collects violations instead of failing on the first one, so a sweep reports
 * everything it found in one run. Each test creates its own recorder (no shared
 * mutable state between tests, which is how a stale failure from one test leaks
 * into another's message).
 */
interface Recorder {
  readonly problems: string[];
  check(condition: boolean, message: string): void;
}

const recorder = (): Recorder => {
  const problems: string[] = [];
  return {
    problems,
    check(condition: boolean, message: string): void {
      if (!condition) problems.push(message);
    },
  };
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/**
 * A stable key for a command, so two generators can be compared as sets. The
 * switch is exhaustive on purpose: a new `Command` variant that is not keyed here
 * is a *typecheck* failure rather than a silently equal pair of different
 * commands, which is what a comparator used as evidence has to guarantee.
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

const keysOf = (commands: Iterable<Command>): Set<string> =>
  new Set([...commands].map((cmd) => cmdKey(cmd)));

/** The `CityProduced` events of a command, read off the event list it emitted. */
const completionsOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityProduced' }>[] =>
  events.flatMap((event) => (event.type === 'CityProduced' ? [event] : []));

const hutEntriesOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'HutEntered' }>[] =>
  events.flatMap((event) => (event.type === 'HutEntered' ? [event] : []));

const citiesGrewOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityGrew' }>[] =>
  events.flatMap((event) => (event.type === 'CityGrew' ? [event] : []));

const citiesStarvedOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityStarved' }>[] =>
  events.flatMap((event) => (event.type === 'CityStarved' ? [event] : []));

const citiesFoundedOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityFounded' }>[] =>
  events.flatMap((event) => (event.type === 'CityFounded' ? [event] : []));

/** The neighbour of `unitId` that steps toward the nearest hut, or `undefined`. */
const greedyTowardHut = (state: GameState, unitId: number): TileIndex | undefined => {
  const unit = unitById(state, asUnitId(unitId));
  if (unit === undefined) return undefined;

  const huts = state.map.huts.map(Number);
  if (huts.length === 0) return undefined;

  let target = huts[0];
  if (target === undefined) return undefined;
  for (const hut of huts) {
    if (
      distance8(state.map, hut, Number(unit.tile)) < distance8(state.map, target, Number(unit.tile))
    )
      target = hut;
  }

  const options = unitMoveOptions(state, RULESET, unit.id);
  let best = options[0];
  if (best === undefined) return undefined;
  for (const option of options) {
    if (distance8(state.map, option, target) < distance8(state.map, best, target)) best = option;
  }
  return best;
};

/**
 * The kind `planSetWorkedTiles` refuses a change with, or `'ok'`. A tiny reader
 * so the tests can compare the *plan* with the *applier* without restating the
 * error union at every call site.
 */
const refusalPlanKind = (
  state: GameState,
  player: PlayerId,
  cityId: CityId,
  tiles: readonly TileIndex[],
): string => {
  const plan = planSetWorkedTiles(state, player, cityId, tiles);
  return plan.ok ? 'ok' : plan.error.kind;
};

/** A tile index on the 40x40 duel map the scenario worlds below use. */
const duelTile = (x: number, y: number): TileIndex => asTileIndex(y * 40 + x);

/** Build a hand-made world, or throw with the reason (a broken fixture is loud). */
const buildWorld = (seed: number, setup: (b: ScenarioBuilder) => ScenarioBuilder): GameState => {
  const built = setup(createScenarioBuilder(RULESET, { mapSize: 'duel', seed })).build();
  if (!built.ok) throw new Error(`scenario build failed: ${JSON.stringify(built.error)}`);
  return built.value;
};

/* ------------------------------------------------------------------ *
 * 1. The keystone, spanning four generators
 * ------------------------------------------------------------------ */

/**
 * The command space the applier is asked about for one player, at one state:
 * every `MoveUnit` to a neighbouring tile, one `FoundCity` per unit, and the two
 * city-command candidate universes. Returns the sets the generators produced so
 * the caller can compare them with what the applier accepted.
 */
interface GeneratorSnapshot {
  readonly legal: Set<string>;
  readonly yielded: number;
  /** Yielded actions the applier accepted, and enumerated candidates it accepted. */
  readonly applied: number;
}

/**
 * Both directions of the keystone for the two commands a generator *does*
 * enumerate (`MoveUnit`, `FoundCity`), plus the planner-versus-applier
 * agreement for the two it deliberately does not (`SetWorkedTiles`,
 * `SetProduction` — see `actions.ts`' module note: an assignment is a search
 * space and a production item is a content choice, so a generator that yielded
 * "the" assignment would advertise an arbitrary subset as if it were the whole).
 *
 * The exhaustive half is capped, and the cap is stated rather than hidden: every
 * *neighbouring* tile is enumerated for every unit (which is complete for
 * acceptance, because `planMove` refuses any non-adjacent destination outright,
 * with one exception named in the module under test: a unit standing off the map
 * could in principle have a "neighbour" that is on the map), and the *whole* tile
 * range is enumerated for the first two units each player owns, which is the
 * "a generator forgot a tile" check `m2-adversarial.test.ts` runs exhaustively on
 * fresh states.
 */
const FULL_TILE_UNITS_PER_PLAYER = 2;

const keystoneAtState = (rec: Recorder, state: GameState, label: string): GeneratorSnapshot => {
  const size = state.map.width * state.map.height;
  const frozenHash = hashValue(state);
  deepFreeze(state);

  const legal = new Set<string>();
  let yielded = 0;
  let applied = 0;

  for (const player of state.players) {
    const actions = [...legalActions(state, RULESET, player.id)];
    for (const cmd of actions) {
      legal.add(cmdKey(cmd));
      yielded += 1;
      const outcome = applyCommand(state, player.id, cmd, RULESET);
      if (!outcome.ok) {
        rec.check(
          false,
          `${label}: legalActions yielded ${cmdKey(cmd)} for player ${String(player.id)} but ` +
            `applyCommand refused it: ${JSON.stringify(outcome.error)}`,
        );
        continue;
      }
      applied += 1;
      rec.check(
        outcome.value.state.revision === state.revision + 1,
        `${label}: ${cmdKey(cmd)} did not bump revision by exactly one`,
      );
    }

    rec.check(
      actions.filter((cmd) => cmd.type === 'EndTurn').length === 1,
      `${label}: player ${String(player.id)} did not get exactly one EndTurn`,
    );

    const mine = state.units.filter((unit) => unit.owner === player.id);

    mine.forEach((unit, index) => {
      const perUnit = keysOf(unitActions(state, RULESET, unit.id));

      for (const cmd of unitActions(state, RULESET, unit.id)) {
        yielded += 1;
        const outcome = applyCommand(state, player.id, cmd, RULESET);
        if (!outcome.ok) {
          rec.check(
            false,
            `${label}: unitActions yielded ${cmdKey(cmd)} but applyCommand refused it: ` +
              JSON.stringify(outcome.error),
          );
        }
        rec.check(
          legal.has(cmdKey(cmd)),
          `${label}: unitActions yielded ${cmdKey(cmd)} which legalActions does not`,
        );
      }
      applied += unitActions(state, RULESET, unit.id).length;

      // --- the applier's verdict, for the two generated families -----------
      const candidates: Command[] = [
        ...unitMoveOptions(state, RULESET, unit.id).map((to): Command => ({
          type: 'MoveUnit',
          unitId: unit.id,
          to,
        })),
        { type: 'FoundCity', unitId: unit.id },
      ];
      if (index < FULL_TILE_UNITS_PER_PLAYER) {
        for (let to = 0; to < size; to += 1) {
          const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to: asTileIndex(to) };
          if (!legal.has(cmdKey(cmd))) candidates.push(cmd);
        }
      }

      const foundAccepted = applyCommand(
        state,
        player.id,
        { type: 'FoundCity', unitId: unit.id },
        RULESET,
      ).ok;
      const foundYielded = perUnit.has(cmdKey({ type: 'FoundCity', unitId: unit.id }));
      rec.check(
        foundAccepted === foundYielded,
        `${label}: FoundCity for unit ${String(unit.id)} accepted=${String(foundAccepted)} but ` +
          `yielded=${String(foundYielded)} (a generator and an applier disagree)`,
      );

      for (const cmd of candidates) {
        const accepted = applyCommand(state, player.id, cmd, RULESET).ok;
        if (accepted) applied += 1;
        rec.check(
          accepted === perUnit.has(cmdKey(cmd)),
          `${label}: ${cmdKey(cmd)} accepted=${String(accepted)} but unitActions ` +
            `yielded=${String(perUnit.has(cmdKey(cmd)))}`,
        );
        rec.check(
          accepted === legal.has(cmdKey(cmd)),
          `${label}: ${cmdKey(cmd)} accepted=${String(accepted)} but legalActions ` +
            `yielded=${String(legal.has(cmdKey(cmd)))}`,
        );
      }
    });

    // --- the two city planners, against the applier -----------------------
    for (const city of state.cities) {
      const owner = city.owner;
      const other: PlayerId | undefined = state.players.find((player) => player.id !== owner)?.id;

      const radius = cityRadius(state, city.tile).map(Number);
      const claimedElsewhere = new Set<number>(
        state.cities
          .filter((candidate) => candidate.id !== city.id)
          .flatMap((candidate) => candidate.workedTiles.map(Number)),
      );
      const free = radius.filter(
        (tile) => tile !== Number(city.tile) && !claimedElsewhere.has(tile),
      );
      const claimedInside = radius.filter(
        (tile) => tile !== Number(city.tile) && claimedElsewhere.has(tile),
      );
      const claimedOutside = [...claimedElsewhere].filter((tile) => !radius.includes(tile));
      const outside = Array.from({ length: size }, (_, index) => index).find(
        (tile) => !radius.includes(tile),
      );

      // Each case names the refusal the contract *guarantees*, where one is
      // guaranteed, so the sweep checks the reason and not merely that two code
      // paths both said no.
      const duplicate = free.slice(0, 1).map(asTileIndex);
      const tileCases: readonly {
        readonly label: string;
        readonly tiles: readonly TileIndex[];
        readonly expect: string | undefined;
      }[] = [
        { label: 'nothing assigned', tiles: [], expect: undefined },
        { label: 'one free tile', tiles: free.slice(0, 1).map(asTileIndex), expect: undefined },
        {
          label: 'exactly the population',
          tiles: free.slice(0, city.population).map(asTileIndex),
          expect: undefined,
        },
        {
          label: 'more tiles than citizens',
          tiles: radius.map(asTileIndex),
          expect: radius.length > city.population ? 'too-many-worked-tiles' : undefined,
        },
        {
          label: 'the same tile twice',
          tiles: duplicate.concat(duplicate),
          expect:
            duplicate.length > 0 && city.population >= 2 && duplicate.length * 2 <= city.population
              ? 'duplicate-worked-tile'
              : undefined,
        },
        { label: 'the city centre', tiles: [city.tile], expect: 'tile-not-workable' },
        // The plan checks `tile-not-workable` (radius, centre) *before* the
        // cross-city claim, so the reason a player sees for a claimed tile
        // outside this city's own radius is the radius — which is true, and the
        // two cases are therefore separated rather than conflated.
        {
          label: 'a tile another city works, inside this radius',
          tiles: claimedInside.slice(0, 1).map(asTileIndex),
          expect: claimedInside.length > 0 ? 'tile-worked-by-another-city' : undefined,
        },
        {
          label: 'a tile another city works, outside this radius',
          tiles: claimedOutside.slice(0, 1).map(asTileIndex),
          expect: claimedOutside.length > 0 ? 'tile-not-workable' : undefined,
        },
        {
          label: 'a tile outside the radius',
          tiles: outside === undefined ? [] : [asTileIndex(outside)],
          expect: outside === undefined ? undefined : 'tile-not-workable',
        },
      ];

      for (const tileCase of tileCases) {
        const tiles = tileCase.tiles;
        const cmd: Command = { type: 'SetWorkedTiles', cityId: city.id, tiles };
        const plan = planSetWorkedTiles(state, owner, city.id, tiles);
        const outcome = applyCommand(state, owner, cmd, RULESET);
        if (outcome.ok) applied += 1;
        rec.check(
          plan.ok === outcome.ok,
          `${label}: ${cmdKey(cmd)} (${tileCase.label}) plan=${plan.ok ? 'ok' : JSON.stringify(plan.error)} ` +
            `applier=${outcome.ok ? 'ok' : JSON.stringify(outcome.error)}`,
        );
        if (tileCase.expect !== undefined) {
          rec.check(
            !outcome.ok && outcome.error.kind === tileCase.expect,
            `${label}: ${tileCase.label} should be refused as ${tileCase.expect}, got ` +
              (outcome.ok ? 'accepted' : JSON.stringify(outcome.error)),
          );
        }
        if (plan.ok && outcome.ok) {
          const after = cityById(outcome.value.state, city.id);
          rec.check(
            sameJson(after?.workedTiles, tiles),
            `${label}: ${cmdKey(cmd)} was accepted but the assignment was not stored in order`,
          );
          rec.check(
            after !== undefined && after.workedTiles.length <= after.population,
            `${label}: a city ended up working more tiles than it has citizens`,
          );
          rec.check(
            outcome.value.events.length === 0,
            `${label}: SetWorkedTiles emitted an event the frozen union does not have`,
          );
          rec.check(
            outcome.value.state.revision === state.revision + 1 &&
              sameJson(cityById(outcome.value.state, city.id)?.shields, city.shields),
            `${label}: SetWorkedTiles changed more than the assignment and the revision`,
          );

          // A state-level check, independent of the planner that accepted it: no
          // accepted assignment may leave two cities working one tile.
          const held = new Map<number, number>();
          for (const candidate of outcome.value.state.cities) {
            for (const tile of candidate.workedTiles) {
              const index = Number(tile);
              const rival = held.get(index);
              rec.check(
                rival === undefined || rival === Number(candidate.id),
                `${label}: ${cmdKey(cmd)} was accepted and left tile ${String(index)} worked by ` +
                  `cities ${String(rival ?? -1)} and ${String(candidate.id)}`,
              );
              held.set(index, Number(candidate.id));
            }
          }
        }
        if (other !== undefined) {
          const asOther = applyCommand(state, other, cmd, RULESET);
          rec.check(
            !asOther.ok && asOther.error.kind === 'not-your-city',
            `${label}: another player was allowed to reassign city ${String(city.id)}'s tiles`,
          );
        }
      }

      const items: readonly ProductionItem[] = [
        ...RULESET.units.map((def): ProductionItem => ({ kind: 'unit', id: def.id })),
        ...(RULESET.buildings ?? []).map((def): ProductionItem => ({
          kind: 'building',
          id: def.id,
        })),
        ...city.buildings.map((id): ProductionItem => ({ kind: 'building', id })),
        { kind: 'unit', id: asUnitTypeId('no-such-unit') },
        { kind: 'building', id: asBuildingId('no-such-building') },
      ];
      const bogusIds = new Set<string>([
        String(asUnitTypeId('no-such-unit')),
        String(asBuildingId('no-such-building')),
      ]);

      for (const item of items) {
        const cmd: Command = { type: 'SetProduction', cityId: city.id, item };
        const plan = planSetProduction(state, RULESET, owner, city.id, item);
        const outcome = applyCommand(state, owner, cmd, RULESET);
        rec.check(
          plan.ok === outcome.ok,
          `${label}: ${cmdKey(cmd)} plan=${plan.ok ? 'ok' : JSON.stringify(plan.error)} ` +
            `applier=${outcome.ok ? 'ok' : JSON.stringify(outcome.error)}`,
        );
        if (item.kind === 'building' && city.buildings.includes(item.id)) {
          rec.check(
            !outcome.ok && outcome.error.kind === 'already-built',
            `${label}: a building the city has was not refused as already-built`,
          );
        }
        if (bogusIds.has(String(item.id))) {
          rec.check(
            !outcome.ok && outcome.error.kind === 'unknown-production-item',
            `${label}: an item no catalog defines was not refused as unknown-production-item`,
          );
        }
        if (other !== undefined) {
          const asOther = applyCommand(state, other, cmd, RULESET);
          rec.check(
            !asOther.ok && asOther.error.kind === 'not-your-city',
            `${label}: another player was allowed to set city ${String(city.id)}'s production`,
          );
        }
        if (!plan.ok) {
          rec.check(
            !outcome.ok && outcome.error.kind === plan.error.kind,
            `${label}: the plan and the applier refused ${cmdKey(cmd)} for different reasons`,
          );
        }
        if (outcome.ok) applied += 1;
        if (outcome.ok) {
          const after = cityById(outcome.value.state, city.id);
          rec.check(
            sameJson(after?.production, item),
            `${label}: SetProduction was accepted but the item is not the city's head`,
          );
          rec.check(
            sameJson(after?.queue, city.queue),
            `${label}: SetProduction changed the rest of the queue`,
          );
          rec.check(
            after?.shields === city.shields,
            `${label}: SetProduction threw away the city's stored shields`,
          );
          rec.check(
            outcome.value.events.length === 0,
            `${label}: SetProduction emitted an event the frozen union does not have`,
          );
        }
      }
    }
  }

  rec.check(hashValue(state) === frozenHash, `${label}: the read-only walk mutated the state`);
  return { legal, yielded, applied };
};

/**
 * Play a real game forward with cities, production and huts, and sweep the
 * keystone property at every state on the way. The driver is deliberately
 * dumb-but-deterministic: found when a settler can, queue a warrior, walk the
 * first unit toward the nearest hut, end the turn.
 */
interface DeepTotals {
  readonly states: number;
  readonly legalActions: number;
  /** Commands the sweep applied while checking the keystone property. */
  readonly appliedBySweep: number;
  /** `FoundCity` commands the driver applied to build cities as the sweep ran. */
  readonly founders: number;
  readonly citiesAtEnd: number;
}

const deepSweep = (rec: Recorder, seeds: readonly number[], turns: number): DeepTotals => {
  let legalActionsCount = 0;
  let appliedBySweep = 0;
  let founders = 0;
  let states = 0;
  let citiesAtEnd = 0;

  for (const seed of seeds) {
    let state = generatedFor(seed);

    for (let turn = 0; turn < turns; turn += 1) {
      states += 1;
      const snapshot = keystoneAtState(rec, state, `seed ${String(seed)} turn ${String(turn)}`);
      legalActionsCount += snapshot.yielded;
      appliedBySweep += snapshot.applied;

      // Advance: founder, production, one step toward a hut, end the turn.
      for (const player of civPlayers(state)) {
        const found = [...legalActions(state, RULESET, player.id)].find(
          (cmd) => cmd.type === 'FoundCity',
        );
        if (found !== undefined) {
          const moved = applyCommand(state, player.id, found, RULESET);
          if (moved.ok) {
            state = moved.value.state;
            founders += 1;
          } else {
            rec.check(false, `seed ${String(seed)}: a yielded FoundCity was refused`);
          }
        }

        for (const city of citiesOf(state, player.id)) {
          if (city.production !== undefined) continue;
          const item: ProductionItem = { kind: 'unit', id: asUnitTypeId('warrior') };
          const queued = applyCommand(
            state,
            player.id,
            { type: 'SetProduction', cityId: city.id, item },
            RULESET,
          );
          if (queued.ok) state = queued.value.state;
          else rec.check(false, `seed ${String(seed)}: SetProduction was refused`);
        }

        const unit = state.units.find((candidate) => candidate.owner === player.id);
        if (unit !== undefined) {
          const to = greedyTowardHut(state, Number(unit.id));
          if (to !== undefined) {
            const moved = applyCommand(
              state,
              player.id,
              { type: 'MoveUnit', unitId: unit.id, to },
              RULESET,
            );
            if (moved.ok) state = moved.value.state;
            else rec.check(false, `seed ${String(seed)}: an offered move was refused`);
          }
        }

        const ended = applyCommand(state, player.id, { type: 'EndTurn' }, RULESET);
        if (ended.ok) state = ended.value.state;
        else rec.check(false, `seed ${String(seed)}: EndTurn was refused`);
      }
    }

    citiesAtEnd += state.cities.length;
  }

  return { states, legalActions: legalActionsCount, appliedBySweep, founders, citiesAtEnd };
};

describe('keystone — the generators and the applier agree, deep into a played game', () => {
  it(
    'holds after cities, production and huts exist, with settlers that can found',
    { timeout: 180_000 },
    () => {
      const rec = recorder();
      const totals = deepSweep(rec, [1, 3, 42, 1337], 6);
      console.log('m3 deep keystone totals:', JSON.stringify(totals));

      expect(rec.problems).toEqual([]);

      // Non-vacuity: the sweep must have walked states where founding was legal
      // (so `FoundCity` really was in the compared sets), and must have ended with
      // cities on the board — the whole point of sweeping deep rather than fresh.
      expect(totals.states).toBe(24);
      expect(totals.founders).toBeGreaterThan(0);
      expect(totals.citiesAtEnd).toBeGreaterThanOrEqual(totals.states / 6);
      expect(totals.legalActions).toBeGreaterThan(200);
      expect(totals.appliedBySweep).toBeGreaterThan(200);
    },
  );

  it('offers FoundCity exactly where the applier accepts it, refusal included', () => {
    const rec = recorder();

    // A hand-built board with both directions in one state: a settler one tile
    // from a city (`MIN_CITY_DISTANCE` is 2), and one far outside the radius.
    const nearTile = 10 * 40 + 11;
    const farTile = 20 * 40 + 20;
    const state = buildWorld(1, (b) =>
      b
        .addPlayer('Rome')
        .addPlayer('Egypt')
        .fillTerrain('grassland')
        .addCity(0, [10, 10])
        .addUnit(0, asUnitTypeId('settler'), [11, 10])
        .addUnit(0, asUnitTypeId('settler'), [20, 20])
        .addUnit(1, asUnitTypeId('warrior'), [30, 30]),
    );

    const near = state.units.find((unit) => Number(unit.tile) === nearTile);
    const far = state.units.find((unit) => Number(unit.tile) === farTile);
    if (near === undefined || far === undefined)
      throw new Error('the settlers are not where they were put');
    const owner = near.owner;

    // --- the refused direction -------------------------------------------
    const refusedPlan = planFoundCity(state, RULESET, owner, near.id);
    rec.check(
      !refusedPlan.ok && refusedPlan.error.kind === 'city-too-close',
      `a settler one tile from a city planned to found: ${JSON.stringify(refusedPlan)}`,
    );
    const refusedApply = applyCommand(
      state,
      owner,
      { type: 'FoundCity', unitId: near.id },
      RULESET,
    );
    rec.check(
      !refusedApply.ok && refusedApply.error.kind === 'city-too-close',
      `the applier and the plan disagree about a settler one tile from a city: ${JSON.stringify(refusedApply)}`,
    );
    rec.check(
      !unitActions(state, RULESET, near.id).some((cmd) => cmd.type === 'FoundCity'),
      'unitActions offers FoundCity to a settler that may not found',
    );
    rec.check(
      distance8(state.map, nearTile, 10 * 40 + 10) === 1,
      'the refused settler is not one tile from the city after all',
    );

    // --- the accepted direction ------------------------------------------
    rec.check(planFoundCity(state, RULESET, owner, far.id).ok, 'a far settler cannot found');
    rec.check(
      unitActions(state, RULESET, far.id).some((cmd) => cmd.type === 'FoundCity'),
      'unitActions does not offer FoundCity to a settler that can found',
    );
    const founded = applyCommand(state, owner, { type: 'FoundCity', unitId: far.id }, RULESET);
    expect(founded.ok).toBe(true);
    if (!founded.ok) return;

    const after = founded.value.state;
    const city = after.cities.find((candidate) => Number(candidate.tile) === farTile);
    rec.check(city !== undefined, 'the founded city is not on the settler tile');
    rec.check(
      after.units.every((unit) => Number(unit.id) !== Number(far.id)),
      'the founding settler was not consumed',
    );
    rec.check(
      citiesFoundedOf(founded.value.events).length === 1,
      'FoundCity did not emit exactly one CityFounded',
    );
    rec.check(
      after.nextCityId === state.nextCityId + 1,
      'FoundCity did not advance nextCityId by one',
    );

    // --- and the equality, for every unit on the new board ----------------
    for (const unit of after.units) {
      const yielded = unitActions(after, RULESET, unit.id).some((cmd) => cmd.type === 'FoundCity');
      const accepted = applyCommand(
        after,
        unit.owner,
        { type: 'FoundCity', unitId: unit.id },
        RULESET,
      ).ok;
      rec.check(
        yielded === accepted,
        `unit ${String(unit.id)}: FoundCity yielded=${String(yielded)} accepted=${String(accepted)}`,
      );
    }

    expect(rec.problems).toEqual([]);
  });

  it('holds on a board where two cities contest the same radius', () => {
    const rec = recorder();

    // `MIN_CITY_DISTANCE` is 2, so two cities two tiles apart is a board the
    // command layer really can reach — and three of the four tiles each city may
    // work are then contested. This is where "no two cities work the same tile"
    // and the SetWorkedTiles planner's cross-city refusal have to hold.
    const state = buildWorld(1, (b) =>
      b
        .addPlayer('Rome')
        .addPlayer('Egypt')
        .fillTerrain('grassland')
        // Rome works the three tiles between the cities; Egypt works away from
        // Rome, so every one of Rome's tiles is a tile Egypt may not take.
        .addCity(0, [10, 10], {
          population: 3,
          workedTiles: [duelTile(11, 10), duelTile(11, 11), duelTile(11, 9)],
        })
        .addCity(1, [12, 10], {
          population: 3,
          workedTiles: [duelTile(13, 10), duelTile(13, 11), duelTile(13, 9)],
        })
        .addUnit(0, asUnitTypeId('warrior'), [25, 25])
        .addUnit(1, asUnitTypeId('warrior'), [30, 30]),
    );

    expect(state.cities).toHaveLength(2);
    const first = state.cities[0];
    const second = state.cities[1];
    if (first === undefined || second === undefined) throw new Error('two cities were expected');

    // A tile the *first* city works and the second city could otherwise claim:
    // its own radius has to cover it, and the second city must not already hold it.
    const contested = first.workedTiles.filter(
      (tile) =>
        cityRadius(state, second.tile).some((candidate) => Number(candidate) === Number(tile)) &&
        !second.workedTiles.some((worked) => Number(worked) === Number(tile)),
    );
    rec.check(
      contested.length === 3,
      `the fixture does not contest the three tiles it means to: it contests ${String(contested.length)}`,
    );
    rec.check(
      distance8(state.map, Number(first.tile), Number(second.tile)) === 2,
      'the fixture cities are not two tiles apart',
    );

    // The applier and the plan must both refuse a cross-city claim, and both
    // accept a claim on a tile nobody else works.
    const taken = contested[0];
    if (taken !== undefined) {
      const body: Command = { type: 'SetWorkedTiles', cityId: second.id, tiles: [taken] };
      const refusal = applyCommand(state, second.owner, body, RULESET);
      rec.check(
        !refusal.ok &&
          refusalPlanKind(state, second.owner, second.id, [taken]) === refusal.error.kind,
        'a cross-city tile claim was accepted, or the plan and the applier disagree about it',
      );
      rec.check(
        refusalPlanKind(state, second.owner, second.id, [taken]) === 'tile-worked-by-another-city',
        'a tile another city works is not refused as tile-worked-by-another-city',
      );
    }

    const free = cityRadius(state, second.tile)
      .filter((tile) => Number(tile) !== Number(second.tile))
      .filter((tile) => !first.workedTiles.some((worked) => Number(worked) === Number(tile)))
      .filter((tile) => !second.workedTiles.some((worked) => Number(worked) === Number(tile)));
    const spare = free[0];
    if (spare !== undefined) {
      const accepted = applyCommand(
        state,
        second.owner,
        { type: 'SetWorkedTiles', cityId: second.id, tiles: [asTileIndex(Number(spare))] },
        RULESET,
      );
      rec.check(accepted.ok, 'an unclaimed tile inside the radius was refused');
    }

    const snapshot = keystoneAtState(rec, state, 'contested-radius board');
    console.log(
      'contest board:',
      JSON.stringify({ contested: contested.length, applied: snapshot.applied }),
    );
    expect(rec.problems).toEqual([]);
    expect(snapshot.applied).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Hut honesty
 * ------------------------------------------------------------------ */

/** The hut tile the scenario worlds below use: (11, 10) on a duel map. */
const HUT_TILE = 10 * 40 + 11;
const HUT_X = 11;
const HUT_Y = 10;

describe('hut honesty — consumed once, drawn exactly once, never on water or under a city', () => {
  it('consumes the hut once, draws exactly the kind the RNG selects, and never re-triggers', () => {
    const rec = recorder();
    const seen = new Set<string>();
    let entries = 0;

    // Several scenario seeds, because which of the three rewards comes out is a
    // function of the state RNG alone — so the kind is *predicted* from the RNG
    // below rather than accepted as whatever the engine happens to say.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const state = buildWorld(seed, (b) =>
        b
          .addPlayer('Rome')
          .addPlayer('Egypt')
          .addBarbarianPlayer()
          .fillTerrain('grassland')
          .addHut(HUT_X, HUT_Y)
          .addUnit(0, asUnitTypeId('warrior'), [HUT_X - 1, HUT_Y])
          .addUnit(1, asUnitTypeId('warrior'), [30, 30]),
      );

      const mover = state.units.find((unit) => Number(unit.owner) === 0);
      if (mover === undefined) throw new Error('the scenario has no unit for player 0');
      expect(hutAt(state, HUT_TILE)).toBe(true);

      // What the RNG *must* produce: one `nextBelow` draw over the reward table.
      const draw = nextBelow(state.rng, HUT_REWARD_KINDS.length);
      const expectedKind = HUT_REWARD_KINDS[draw[0]];
      if (expectedKind === undefined) throw new Error('the reward table has no entry for draw 0');

      const moved = applyCommand(
        state,
        mover.owner,
        { type: 'MoveUnit', unitId: mover.id, to: asTileIndex(HUT_TILE) },
        RULESET,
      );
      expect(moved.ok, `seed ${String(seed)}: stepping onto a hut tile was refused`).toBe(true);
      if (!moved.ok) continue;

      const after = moved.value.state;
      entries += 1;
      seen.add(expectedKind);

      // The reward is the draw's kind — not merely "one of three".
      const entered = hutEntriesOf(moved.value.events);
      rec.check(
        entered.length === 1,
        `seed ${String(seed)}: ${String(entered.length)} HutEntered events`,
      );
      rec.check(
        entered[0]?.reward === expectedKind,
        `seed ${String(seed)}: the RNG selects ${expectedKind} but the event says ${String(entered[0]?.reward)}`,
      );
      rec.check(
        sameJson(after.rng, draw[1]),
        `seed ${String(seed)}: the RNG did not advance by exactly one draw`,
      );

      // Consumed, once: gone from the map, and nothing about the tile can fire again.
      rec.check(!hutAt(after, HUT_TILE), `seed ${String(seed)}: the hut is still on the map`);
      rec.check(
        !after.map.huts.some((hut) => Number(hut) === HUT_TILE),
        `seed ${String(seed)}: the hut list still names the entered tile`,
      );
      rec.check(
        state.map.huts.length - after.map.huts.length === 1,
        `seed ${String(seed)}: consuming one hut changed the hut list by more than one`,
      );
      const again = resolveHutEntry(after, RULESET, mover.id);
      rec.check(again === undefined, `seed ${String(seed)}: the spent hut resolved a second time`);
      rec.check(
        sameJson(after.rng, draw[1]),
        `seed ${String(seed)}: re-resolving advanced the RNG`,
      );

      // The branch's promise about units, checked against the state.
      const beforeIds = new Set(state.units.map((unit) => Number(unit.id)));
      const appeared = after.units.filter((unit) => !beforeIds.has(Number(unit.id)));
      if (expectedKind === 'nothing') {
        rec.check(appeared.length === 0, `seed ${String(seed)}: 'nothing' still added a unit`);
      } else if (expectedKind === 'unit') {
        rec.check(appeared.length === 1, `seed ${String(seed)}: the free unit is missing`);
        rec.check(
          Number(appeared[0]?.tile) === HUT_TILE && Number(appeared[0]?.owner) === 0,
          `seed ${String(seed)}: the free unit did not appear on the hut tile for the mover`,
        );
        rec.check(
          Number(entered[0]?.unitGiven) === Number(appeared[0]?.id),
          `seed ${String(seed)}: HutEntered.unitGiven does not name the unit that appeared`,
        );
      } else {
        rec.check(appeared.length > 0 && appeared.length <= 2, `seed ${String(seed)}: band size`);
        rec.check(
          appeared.every((unit) => Number(unit.owner) === Number(after.players[2]?.id)),
          `seed ${String(seed)}: a band member is not owned by the barbarian player`,
        );
      }

      // --- and the tile never fires again: off, back, and nothing happens.
      let walking = after;
      const steps: readonly Command[] = [
        { type: 'EndTurn' },
        { type: 'MoveUnit', unitId: mover.id, to: asTileIndex(HUT_TILE - 1) },
        { type: 'EndTurn' },
        { type: 'MoveUnit', unitId: mover.id, to: asTileIndex(HUT_TILE) },
      ];
      for (const step of steps) {
        const outcome = applyCommand(walking, mover.owner, step, RULESET);
        rec.check(
          outcome.ok,
          `seed ${String(seed)}: the re-entry walk refused ${cmdKey(step)}: ${
            outcome.ok ? '' : JSON.stringify(outcome.error)
          }`,
        );
        if (!outcome.ok) break;
        rec.check(
          hutEntriesOf(outcome.value.events).length === 0,
          `seed ${String(seed)}: ${cmdKey(step)} emitted a HutEntered for a spent hut`,
        );
        if (step.type === 'MoveUnit') {
          rec.check(
            sameJson(outcome.value.state.rng, walking.rng),
            `seed ${String(seed)}: a move with no hut to enter advanced the RNG`,
          );
        }
        walking = outcome.value.state;
      }
      rec.check(!hutAt(walking, HUT_TILE), `seed ${String(seed)}: the hut came back`);
    }

    console.log('hut honesty: entries', entries, 'kinds', [...seen].sort().join(','));
    expect(rec.problems).toEqual([]);
    // Non-vacuity: the sweep must really have entered huts, and the RNG-selected
    // kinds must really have spanned the table (otherwise "the reward is the
    // draw's kind" would be a claim about one branch).
    expect(entries).toBe(12);
    expect([...seen].sort()).toEqual([...HUT_REWARD_KINDS].sort());
  });

  it('never triggers for a sea unit, however it got onto the hut tile', () => {
    const rec = recorder();
    const state = buildWorld(1, (b) =>
      b
        .addPlayer('Rome')
        .addPlayer('Egypt')
        .addBarbarianPlayer()
        .fillTerrain('grassland')
        .addHut(HUT_X, HUT_Y)
        .addUnit(0, asUnitTypeId('galley'), [HUT_X - 1, HUT_Y])
        .addUnit(1, asUnitTypeId('warrior'), [30, 30]),
    );

    const galley = state.units[0];
    if (galley === undefined) throw new Error('no galley');
    const rngBefore = state.rng;

    const moved = applyCommand(
      state,
      galley.owner,
      { type: 'MoveUnit', unitId: galley.id, to: asTileIndex(HUT_TILE) },
      RULESET,
    );
    if (!moved.ok)
      throw new Error(
        `the galley could not step onto the hut tile: ${JSON.stringify(moved.error)}`,
      );

    rec.check(hutEntriesOf(moved.value.events).length === 0, 'a sea unit triggered a hut');
    rec.check(hutAt(moved.value.state, HUT_TILE), 'a sea unit consumed the hut');
    rec.check(sameJson(moved.value.state.rng, rngBefore), 'a sea unit advanced the RNG');
    rec.check(
      moved.value.state.units.length === state.units.length,
      'a sea unit on a hut tile produced a unit',
    );

    // The resolver's own answer, on the state where the sea unit stands on the hut.
    rec.check(
      resolveHutEntry(moved.value.state, RULESET, galley.id) === undefined,
      'resolveHutEntry resolved a hut for a sea unit',
    );
    rec.check(sameJson(moved.value.state.rng, rngBefore), 'the resolver drew for a sea unit');

    expect(rec.problems).toEqual([]);
  });

  it('never triggers for a unit sharing a tile with a city, and the city keeps the hut inert', () => {
    const rec = recorder();
    const state = buildWorld(1, (b) =>
      b
        .addPlayer('Rome')
        .addPlayer('Egypt')
        .addBarbarianPlayer()
        .fillTerrain('grassland')
        .addHut(HUT_X, HUT_Y)
        .addCity(0, [HUT_X, HUT_Y])
        .addUnit(0, asUnitTypeId('warrior'), [HUT_X - 1, HUT_Y])
        .addUnit(1, asUnitTypeId('warrior'), [30, 30]),
    );

    // The city does not consume the hut on its own tile — the documented reading
    // in `hut.ts`: "the hut stays on the map because no unit ever enters it".
    rec.check(hutAt(state, HUT_TILE), 'the city consumed its own tile’s hut at once');

    const warrior = state.units.find((unit) => Number(unit.owner) === 0);
    if (warrior === undefined) throw new Error('no unit for player 0');
    const rngBefore = state.rng;

    const moved = applyCommand(
      state,
      warrior.owner,
      { type: 'MoveUnit', unitId: warrior.id, to: asTileIndex(HUT_TILE) },
      RULESET,
    );
    if (!moved.ok)
      throw new Error(`stepping into the city centre was refused: ${JSON.stringify(moved.error)}`);

    rec.check(
      hutEntriesOf(moved.value.events).length === 0,
      'a unit inside a city triggered a hut',
    );
    rec.check(sameJson(moved.value.state.rng, rngBefore), 'a unit inside a city advanced the RNG');
    rec.check(hutAt(moved.value.state, HUT_TILE), 'a unit inside a city consumed the hut');
    rec.check(
      resolveHutEntry(moved.value.state, RULESET, warrior.id) === undefined,
      'resolveHutEntry resolved a hut for a unit standing in a city',
    );

    expect(rec.problems).toEqual([]);
  });

  it('draws exactly one RNG value per entry, and nothing for a move that enters no hut', () => {
    const rec = recorder();
    let state = generatedFor(1);
    const walkerId = state.units[0]?.id;
    if (walkerId === undefined) throw new Error('seed 1 has no units');

    let entries = 0;
    let plainMoves = 0;

    // One unit, many huts: the point is that the draw is per *entry*, not per
    // unit, per turn or per hut-consuming command.
    for (let step = 0; step < 80; step += 1) {
      const walker = unitById(state, walkerId);
      if (walker === undefined) throw new Error('the walker vanished');
      const to = greedyTowardHut(state, Number(walker.id));
      const cmd: Command =
        to === undefined ? { type: 'EndTurn' } : { type: 'MoveUnit', unitId: walker.id, to };

      // The exact draw the command is allowed to take, from the state RNG.
      const expected = nextBelow(state.rng, HUT_REWARD_KINDS.length);
      const expectedKind = HUT_REWARD_KINDS[expected[0]];

      const outcome = applyCommand(state, walker.owner, cmd, RULESET);
      rec.check(
        outcome.ok,
        `step ${String(step)}: ${cmdKey(cmd)} was refused: ${
          outcome.ok ? '' : JSON.stringify(outcome.error)
        }`,
      );
      if (!outcome.ok) break;
      const after = outcome.value.state;

      const entered = hutEntriesOf(outcome.value.events);
      if (entered.length === 0) {
        if (cmd.type === 'MoveUnit') plainMoves += 1;
        rec.check(
          sameJson(after.rng, state.rng),
          `step ${String(step)}: a command that entered no hut advanced the RNG`,
        );
      }
      for (const event of entered) {
        entries += 1;
        rec.check(
          sameJson(after.rng, expected[1]),
          `entry ${String(entries)}: the RNG is not the state RNG advanced by exactly one draw`,
        );
        // A branch this ruleset cannot honour (nowhere for a band to stand) is
        // reported as `nothing` by contract, so that one downgrade is named
        // rather than silently allowed for every kind.
        const bandSpawned = outcome.value.events.some(
          (candidate) => candidate.type === 'BarbariansSpawned',
        );
        const allowed = expectedKind === 'barbarians' && !bandSpawned ? 'nothing' : expectedKind;
        rec.check(
          event.reward === allowed,
          `entry ${String(entries)}: the RNG selects ${String(expectedKind)} but the event says ${event.reward}`,
        );
        rec.check(
          !hutAt(after, Number(event.tile)),
          `entry ${String(entries)}: the hut named by the event is still on the map`,
        );
      }

      state = after;
    }

    console.log('hut draw sweep:', JSON.stringify({ entries, plainMoves }));
    expect(rec.problems).toEqual([]);
    expect(entries).toBeGreaterThan(2);
    expect(plainMoves).toBeGreaterThan(2);
  });
});

describe('hut honesty — fog hides the feature, not just the terrain', () => {
  /** `(x, y) => glyph` for a rendered state, with right-stripped rows padded out. */
  const gridOf = (render: string, size: number): ((x: number, y: number) => string) => {
    const rows = new Map<number, string>();
    for (const line of render.split('\n')) {
      const match = /^\s*(\d+) \|(.*)$/.exec(line);
      if (match === null) continue;
      const y = Number(match[1]);
      const row = match[2] ?? '';
      rows.set(y, row.padEnd(size, ' '));
    }
    return (x, y) => rows.get(y)?.[x] ?? ' ';
  };

  it('draws a hut exactly when the viewer has explored it, and never otherwise', () => {
    const rec = recorder();

    // A hand-built world with one hut beside the unit (seen after one step) and
    // one hut on the far side of the map (never seen): the hiding and the showing
    // are both non-vacuous in the same state.
    const near = asTileIndex(10 * 40 + 12);
    const far = asTileIndex(30 * 40 + 30);
    const state = buildWorld(1, (b) =>
      b
        .addPlayer('Rome')
        .addPlayer('Egypt')
        .fillTerrain('grassland')
        .addHut(12, 10)
        .addHut(30, 30)
        .addUnit(0, asUnitTypeId('warrior'), [10, 10])
        .addUnit(1, asUnitTypeId('warrior'), [20, 20]),
    );

    const rome = state.players[0];
    if (rome === undefined) throw new Error('no players');
    const explored = (current: GameState, tile: number): boolean =>
      current.explored[Number(rome.id)]?.[tile] === true;

    rec.check(!explored(state, Number(near)), 'the near hut starts explored');
    rec.check(!explored(state, Number(far)), 'the far hut starts explored');

    // God mode still shows both: the feature exists, it is only hidden from a viewer.
    const god = gridOf(renderState(state, RULESET), state.map.width);
    rec.check(god(12, 10) === '%', 'god mode does not draw the near hut');
    rec.check(god(30, 30) === '%', 'god mode does not draw the far hut');
    rec.check(
      renderState(state, RULESET).includes('% hut'),
      'god mode draws a hut without saying so in the legend',
    );

    const blind = gridOf(renderState(state, RULESET, { viewer: rome.id }), state.map.width);
    rec.check(blind(12, 10) === '?', 'a viewer sees the terrain of an unexplored hut tile');
    rec.check(blind(30, 30) === '?', 'a viewer sees an unexplored hut at the map edge');
    rec.check(
      !renderState(state, RULESET, { viewer: rome.id }).includes('%'),
      'a viewer render leaks the hut glyph for an unexplored tile',
    );
    rec.check(
      !renderState(state, RULESET, { viewer: rome.id }).includes('hut'),
      'a viewer render names `hut` in its legend while no hut was drawn',
    );

    // Explore the near hut: the glyph must appear there and nowhere else.
    const unit = state.units[0];
    if (unit === undefined) throw new Error('no unit');
    const moved = applyCommand(
      state,
      unit.owner,
      { type: 'MoveUnit', unitId: unit.id, to: asTileIndex(10 * 40 + 11) },
      RULESET,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const after = moved.value.state;
    rec.check(explored(after, Number(near)), 'one step did not explore the near hut');
    rec.check(!explored(after, Number(far)), 'one step explored the far hut');

    const seen = gridOf(renderState(after, RULESET, { viewer: rome.id }), state.map.width);
    rec.check(seen(12, 10) === '%', 'an explored hut is not drawn for the viewer');
    rec.check(seen(30, 30) === '?', 'the far hut leaked through the fog');
    rec.check(
      renderState(after, RULESET, { viewer: rome.id }).includes('% hut'),
      'a drawn hut is missing from the viewer legend',
    );

    // And the leak check, cell by cell, over the whole map: no unexplored tile is
    // drawn as anything but `?`, for either hut or terrain.
    for (let y = 0; y < state.map.height; y += 1) {
      for (let x = 0; x < state.map.width; x += 1) {
        const tile = y * state.map.width + x;
        const glyph = seen(x, y);
        if (explored(after, tile)) continue;
        rec.check(glyph === '?', `unexplored tile (${String(x)},${String(y)}) renders "${glyph}"`);
      }
    }

    expect(rec.problems).toEqual([]);
  });

  it('never explores a hut for a player who cannot see it (a barbarian viewer sees nothing)', () => {
    const state = generatedFor(42);
    const barbarian = state.players.find((player) => player.kind === 'barbarian');
    if (barbarian === undefined) throw new Error('no barbarian player');

    expect(visibleTiles(state, barbarian.id)).toEqual([]);
    const render = renderState(state, RULESET, { viewer: barbarian.id });
    expect(render.includes('%')).toBe(false);
    expect(render.includes('hut')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Economy conservation over long runs
 * ------------------------------------------------------------------ */

/** What one long run did, as evidence that the invariants were not vacuous. */
interface RunTotals {
  readonly turns: number;
  readonly founded: number;
  readonly grew: number;
  readonly starved: number;
  readonly produced: number;
  readonly huts: number;
  readonly barbarianUnits: number;
  readonly maxPopulation: number;
  readonly maxCities: number;
  readonly unitsAtEnd: number;
  readonly hash: string;
}

/**
 * Check one `EndTurn` against the contract, from the state before it and the
 * state after it.
 *
 * The food half is transcribed from INTERFACES.md M3 ("Growth (food box)") — add
 * the surplus, spend `foodBoxSize` per citizen born and carry the remainder,
 * draw down a deficit and starve only below zero — and compared with the state.
 * The shields half is transcribed from "Production": add `cityYields(...).shields`,
 * complete when the pool covers the item, subtract its cost, carry the
 * remainder, promote the next queue entry.
 *
 * `applyGrowth` is used for exactly one thing: the *incoming assignment* of the
 * city that production then reads. That is not circular — the food half above is
 * checked without it, and the assignment itself is checked by the shape
 * invariants (one tile per citizen, inside the radius, unclaimed, no duplicates)
 * — but it is a real limit of this check and it is stated rather than glossed:
 * a bug in growth's own arithmetic would have to fool the transcription above
 * *and* survive the shape invariants. The pipeline itself is checked by
 * composition: the events of `EndTurn` must be exactly
 * `applyGrowth(before).events ++ applyProduction(grown).events ++ TurnEnded`.
 */
const checkTurn = (
  rec: Recorder,
  before: GameState,
  after: GameState,
  events: readonly GameEvent[],
  label: string,
): void => {
  rec.check(after.turn === before.turn + 1, `${label}: turn did not advance by one`);
  rec.check(
    after.revision === before.revision + 1,
    `${label}: revision did not advance by exactly one`,
  );
  rec.check(
    after.cities.length === before.cities.length,
    `${label}: a turn added or removed a city`,
  );

  const grown = applyGrowth(before, RULESET);
  const produced = applyProduction(grown.state, RULESET);
  const last = events[events.length - 1];
  rec.check(
    sameJson(events, [
      ...grown.events,
      ...produced.events,
      {
        type: 'TurnEnded',
        playerId: last?.type === 'TurnEnded' ? last.playerId : -1,
        turn: after.turn,
      },
    ]),
    `${label}: EndTurn is not growth ++ production ++ TurnEnded, in that order`,
  );

  // --- refill, and no unit is moved by a turn ---------------------------
  const beforeById = new Map(before.units.map((unit) => [Number(unit.id), unit]));
  for (const unit of after.units) {
    const previous = beforeById.get(Number(unit.id));
    if (previous === undefined) continue;
    rec.check(
      Number(previous.tile) === Number(unit.tile),
      `${label}: unit ${String(unit.id)} moved during a turn (${String(previous.tile)} -> ${String(unit.tile)})`,
    );
    const def = unitDef(RULESET, unit.type);
    if (def !== undefined) {
      rec.check(
        unit.movementLeft === def.movement,
        `${label}: unit ${String(unit.id)} was not refilled to its movement`,
      );
    }
  }

  // --- every unit that appeared is named by a CityProduced event --------
  const completions = completionsOf(events);
  const claimedUnitIds = new Set(
    completions.flatMap((event) => (event.unitId === undefined ? [] : [Number(event.unitId)])),
  );
  const appeared = after.units.filter((unit) => !beforeById.has(Number(unit.id)));
  rec.check(
    appeared.length === claimedUnitIds.size,
    `${label}: ${String(appeared.length)} units appeared but ${String(claimedUnitIds.size)} production events name one`,
  );
  for (const unit of appeared) {
    rec.check(
      claimedUnitIds.has(Number(unit.id)),
      `${label}: unit ${String(unit.id)} appeared during a turn without a CityProduced event`,
    );
  }

  const citiesSeen = new Set<number>();
  const tilesClaimed = new Map<number, number>();

  for (const cityBefore of before.cities) {
    const id = cityBefore.id;
    const cityAfter = cityById(after, id);
    if (cityAfter === undefined) {
      rec.check(false, `${label}: city ${String(id)} disappeared`);
      continue;
    }
    citiesSeen.add(Number(id));

    // --- food, transcribed from the contract ---------------------------
    const yields = cityYields(before, RULESET, id);
    let population = cityBefore.population;
    let foodBox = cityBefore.foodBox;
    let starved = false;
    if (yields.foodSurplus > 0) {
      foodBox += yields.foodSurplus;
      while (foodBox >= foodBoxSize(population)) {
        foodBox -= foodBoxSize(population);
        population += 1;
      }
    } else if (yields.foodSurplus < 0) {
      foodBox += yields.foodSurplus;
      if (foodBox < 0) {
        population = Math.max(1, population - 1);
        foodBox = 0;
        starved = true;
      }
    }

    rec.check(
      cityAfter.population === population && cityAfter.foodBox === foodBox,
      `${label}: city ${String(id)} food bookkeeping: expected pop ${String(population)} box ` +
        `${String(foodBox)}, got pop ${String(cityAfter.population)} box ${String(cityAfter.foodBox)} ` +
        `(before pop ${String(cityBefore.population)} box ${String(cityBefore.foodBox)}, surplus ${String(yields.foodSurplus)})`,
    );

    const grew = citiesGrewOf(events).filter((event) => event.cityId === id);
    const starvedEvents = citiesStarvedOf(events).filter((event) => event.cityId === id);
    rec.check(grew.length <= 1, `${label}: city ${String(id)} grew more than once in a turn`);
    rec.check(
      starvedEvents.length <= 1,
      `${label}: city ${String(id)} starved more than once in a turn`,
    );
    if (population > cityBefore.population) {
      rec.check(grew.length === 1, `${label}: city ${String(id)} grew without a CityGrew event`);
      const grewEvent = grew[0];
      rec.check(
        grewEvent !== undefined &&
          grewEvent.population === population &&
          grewEvent.foodBox === foodBox,
        `${label}: the CityGrew event disagrees with the state for city ${String(id)}`,
      );
      rec.check(starvedEvents.length === 0, `${label}: city ${String(id)} grew and starved`);
    }
    if (starved) {
      rec.check(
        starvedEvents.length === 1,
        `${label}: city ${String(id)} starved without a CityStarved event`,
      );
      rec.check(starvedEvents[0]?.population === population, `${label}: CityStarved population`);
    }
    if (population === cityBefore.population) {
      rec.check(grew.length === 0, `${label}: city ${String(id)} emitted CityGrew without growing`);
    }

    // --- the shape invariants -----------------------------------------
    rec.check(
      Number.isInteger(cityAfter.population) && cityAfter.population >= 1,
      `${label}: city ${String(id)} has population ${String(cityAfter.population)}`,
    );
    rec.check(
      Number.isInteger(cityAfter.foodBox) &&
        cityAfter.foodBox >= 0 &&
        cityAfter.foodBox < foodBoxSize(cityAfter.population),
      `${label}: city ${String(id)} foodBox ${String(cityAfter.foodBox)} is outside ` +
        `[0, ${String(foodBoxSize(cityAfter.population))}) for population ${String(cityAfter.population)}`,
    );
    rec.check(
      Number.isInteger(cityAfter.shields) && cityAfter.shields >= 0,
      `${label}: city ${String(id)} has shields ${String(cityAfter.shields)}`,
    );
    rec.check(
      cityAfter.workedTiles.length <= cityAfter.population,
      `${label}: city ${String(id)} works ${String(cityAfter.workedTiles.length)} tiles for ` +
        `${String(cityAfter.population)} citizens`,
    );
    const radius = new Set(cityRadius(after, cityAfter.tile).map(Number));
    const listed = new Set<number>();
    for (const tile of cityAfter.workedTiles) {
      const index = Number(tile);
      rec.check(index !== Number(cityAfter.tile), `${label}: city ${String(id)} lists its centre`);
      rec.check(
        radius.has(index),
        `${label}: city ${String(id)} works tile ${String(index)} outside its radius`,
      );
      rec.check(
        !listed.has(index),
        `${label}: city ${String(id)} lists tile ${String(index)} twice`,
      );
      listed.add(index);

      const rival = tilesClaimed.get(index);
      rec.check(
        rival === undefined,
        `${label}: tile ${String(index)} is worked by city ${String(id)} and city ${String(rival ?? -1)}`,
      );
      tilesClaimed.set(index, Number(id));
    }
    if (starved) {
      rec.check(
        sameJson(cityAfter.workedTiles, cityBefore.workedTiles.slice(0, cityAfter.population)),
        `${label}: a starved city kept a tile it can no longer work`,
      );
    }

    // --- shields, transcribed from the contract ------------------------
    const grownCity = cityById(grown.state, id);
    if (grownCity === undefined) {
      rec.check(false, `${label}: the growth pass lost city ${String(id)}`);
      continue;
    }
    let pool = grownCity.shields + cityYields(grown.state, RULESET, id).shields;
    const item = grownCity.production;
    const completion = completions.find((event) => event.cityId === id);

    if (item === undefined) {
      rec.check(
        cityAfter.shields === pool,
        `${label}: city ${String(id)} banked ${String(cityAfter.shields)} shields, expected ${String(pool)}`,
      );
      rec.check(
        completion === undefined,
        `${label}: city ${String(id)} produced with an empty queue`,
      );
      continue;
    }

    const cost = itemCost(RULESET, item);
    const redundant = item.kind === 'building' && grownCity.buildings.includes(item.id);
    rec.check(cost > 0, `${label}: city ${String(id)} is building an item with no price`);

    if (pool >= cost) {
      // Completion: one per turn, cost subtracted, remainder carried over.
      if (!redundant) pool -= cost;
      rec.check(
        cityAfter.shields === pool,
        `${label}: city ${String(id)} carried ${String(cityAfter.shields)} shields through a ` +
          `completion, expected ${String(pool)}`,
      );
      rec.check(
        sameJson(cityAfter.production, grownCity.queue[0]),
        `${label}: city ${String(id)} did not promote the next queue entry`,
      );
      rec.check(
        sameJson(cityAfter.queue, grownCity.queue.slice(1)),
        `${label}: city ${String(id)} did not consume the completed entry from its queue`,
      );
      if (redundant) {
        rec.check(completion === undefined, `${label}: a redundant building was charged`);
      } else {
        rec.check(
          completion !== undefined,
          `${label}: city ${String(id)} completed without an event`,
        );
        rec.check(
          completion?.shields === pool,
          `${label}: the CityProduced remainder disagrees with the state`,
        );
        rec.check(
          sameJson(completion?.item, item),
          `${label}: the CityProduced event names another item`,
        );
        if (item.kind === 'building') {
          rec.check(
            cityAfter.buildings.includes(item.id),
            `${label}: a completed building did not join the city`,
          );
        } else {
          const unitId = completion?.unitId;
          rec.check(unitId !== undefined, `${label}: a produced unit has no unitId in its event`);
          const spawned = unitId === undefined ? undefined : unitById(after, unitId);
          rec.check(spawned !== undefined, `${label}: the produced unit is not in the state`);
          rec.check(
            spawned !== undefined && Number(spawned.owner) === Number(cityAfter.owner),
            `${label}: the produced unit belongs to somebody else`,
          );
          rec.check(
            spawned !== undefined && Number(spawned.tile) === Number(completion?.tile),
            `${label}: the produced unit is not on the tile its event names`,
          );
          const def = spawned === undefined ? undefined : unitDef(RULESET, spawned.type);
          rec.check(
            def === undefined || spawned?.movementLeft === def.movement,
            `${label}: the produced unit does not start at full movement`,
          );
        }
      }
    } else {
      rec.check(
        cityAfter.shields === pool,
        `${label}: city ${String(id)} banked ${String(cityAfter.shields)} shields, expected ${String(pool)}`,
      );
      rec.check(completion === undefined, `${label}: an unaffordable item completed anyway`);
      rec.check(
        sameJson(cityAfter.production, item),
        `${label}: an unfinished item left the head of the queue`,
      );
    }
  }

  for (const city of after.cities) {
    const owner = after.players.find((player) => player.id === city.owner);
    rec.check(
      owner !== undefined && owner.kind !== 'barbarian',
      `${label}: city ${String(city.id)} is owned by the barbarian player`,
    );
    rec.check(
      citiesSeen.has(Number(city.id)),
      `${label}: city ${String(city.id)} exists after the turn but not before`,
    );
  }
};

/**
 * Play one long game: found, queue, move, end turns — with deliberate
 * starvation pressure halfway through, so "population never below 1" and "the
 * deficit restarts the box at 0" are exercised rather than assumed.
 */
const longRun = (rec: Recorder, seed: number, turns: number): RunTotals => {
  let state = generatedFor(seed);
  const prng = makePrng(seed);
  const civs = civPlayers(state).map((player) => player.id);
  const totals = {
    turns: 0,
    founded: 0,
    grew: 0,
    starved: 0,
    produced: 0,
    huts: 0,
    barbarianUnits: 0,
    maxPopulation: 1,
    maxCities: 0,
    unitsAtEnd: 0,
    hash: '',
  };

  for (let turn = 0; turn < turns; turn += 1) {
    for (const playerId of civs) {
      // Found with every settler that can (the start settler on turn 1, and any
      // settler production delivers later).
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const found = [...legalActions(state, RULESET, playerId)].find(
          (cmd) => cmd.type === 'FoundCity',
        );
        if (found === undefined) break;
        const outcome = applyCommand(state, playerId, found, RULESET);
        rec.check(outcome.ok, `seed ${String(seed)}: a yielded FoundCity was refused`);
        if (!outcome.ok) break;
        totals.founded += 1;
        state = outcome.value.state;
      }

      const mine = citiesOf(state, playerId);
      if (mine.length > totals.maxCities) totals.maxCities = mine.length;

      for (const city of mine) {
        if (city.population > totals.maxPopulation) totals.maxPopulation = city.population;

        // Halfway through: strip the assignment of every city with citizens to
        // spare, which is a deficit on grassland and a real starvation.
        if (turn === Math.floor(turns / 2) && city.population >= 2) {
          const stripped = applyCommand(
            state,
            playerId,
            { type: 'SetWorkedTiles', cityId: city.id, tiles: [] },
            RULESET,
          );
          rec.check(stripped.ok, `seed ${String(seed)}: clearing an assignment was refused`);
          if (!stripped.ok) continue;
          state = stripped.value.state;
          continue;
        }

        // Every fifth turn, re-assign a legal but deliberately unambitious set:
        // the *last* unclaimed tiles in the radius, in index order.
        if (turn % 5 === 0 && city.population >= 1) {
          const claimed = new Set(
            state.cities
              .filter((candidate) => candidate.id !== city.id)
              .flatMap((candidate) => candidate.workedTiles.map(Number)),
          );
          const free = cityRadius(state, city.tile)
            .map(Number)
            .filter((tile) => tile !== Number(city.tile) && !claimed.has(tile))
            .slice(-city.population);
          const assigned = applyCommand(
            state,
            playerId,
            { type: 'SetWorkedTiles', cityId: city.id, tiles: free.map(asTileIndex) },
            RULESET,
          );
          rec.check(
            assigned.ok,
            `seed ${String(seed)}: an assignment built from the radius was refused: ${
              assigned.ok ? '' : JSON.stringify(assigned.error)
            }`,
          );
          if (assigned.ok) state = assigned.value.state;
        }

        const current = cityById(state, city.id);
        if (current === undefined || current.production !== undefined) continue;
        if (state.units.filter((unit) => unit.owner === playerId).length > 10) continue;

        const unbuilt = (RULESET.buildings ?? []).filter(
          (def) => !current.buildings.includes(def.id),
        );
        const building = unbuilt[prng() % Math.max(unbuilt.length, 1)];
        const item: ProductionItem =
          building !== undefined && prng() % 2 === 0
            ? { kind: 'building', id: building.id }
            : { kind: 'unit', id: asUnitTypeId(prng() % 2 === 0 ? 'settler' : 'warrior') };
        const queued = applyCommand(
          state,
          playerId,
          { type: 'SetProduction', cityId: current.id, item },
          RULESET,
        );
        rec.check(
          queued.ok,
          `seed ${String(seed)}: queuing ${JSON.stringify(item)} was refused: ${
            queued.ok ? '' : JSON.stringify(queued.error)
          }`,
        );
        if (queued.ok) state = queued.value.state;
      }

      // Walk units on some turns so huts get entered and the barbarian player
      // really exists (otherwise "barbarians never gain cities" is vacuous).
      if (turn % 4 === 0) {
        for (const unit of state.units.filter((candidate) => candidate.owner === playerId)) {
          for (let step = 0; step < 2; step += 1) {
            const options = unitMoveOptions(state, RULESET, unit.id);
            if (options.length === 0) break;
            const to = options[prng() % options.length];
            if (to === undefined) break;
            const outcome = applyCommand(
              state,
              playerId,
              { type: 'MoveUnit', unitId: unit.id, to },
              RULESET,
            );
            if (!outcome.ok) {
              rec.check(false, `seed ${String(seed)}: an offered move was refused`);
              break;
            }
            totals.huts += hutEntriesOf(outcome.value.events).length;
            state = outcome.value.state;
          }
        }
      }

      const before = state;
      const ended = applyCommand(state, playerId, { type: 'EndTurn' }, RULESET);
      rec.check(ended.ok, `seed ${String(seed)} turn ${String(turn)}: EndTurn was refused`);
      if (!ended.ok) return { ...totals, hash: hashValue(state) };

      totals.turns += 1;
      totals.founded += citiesFoundedOf(ended.value.events).length;
      totals.grew += citiesGrewOf(ended.value.events).length;
      totals.starved += citiesStarvedOf(ended.value.events).length;
      totals.produced += completionsOf(ended.value.events).length;

      checkTurn(
        rec,
        before,
        ended.value.state,
        ended.value.events,
        `seed ${String(seed)} turn ${String(turn)}`,
      );
      state = ended.value.state;
    }
  }

  const barbarian = state.players.find((player) => player.kind === 'barbarian');
  totals.barbarianUnits =
    barbarian === undefined ? 0 : state.units.filter((unit) => unit.owner === barbarian.id).length;
  totals.unitsAtEnd = state.units.length;
  return { ...totals, hash: hashValue(state) };
};

describe('economy conservation — 110 turns, real cities, real starvation', () => {
  it(
    'never invents or loses food or shields, and keeps every city invariant',
    { timeout: 180_000 },
    () => {
      const rec = recorder();
      const runs: RunTotals[] = [];

      for (const seed of [1, 42, 1337]) {
        runs.push(longRun(rec, seed, 110));
      }

      console.log('m3 economy long runs:', JSON.stringify(runs));
      expect(rec.problems).toEqual([]);

      const sum = (pick: (run: RunTotals) => number): number =>
        runs.reduce((total, run) => total + pick(run), 0);

      // Non-vacuity, branch by branch: the runs must really have founded cities,
      // grown them, starved them, completed production and entered huts, or the
      // invariants above are claims about nothing.
      expect(sum((run) => run.turns)).toBeGreaterThanOrEqual(3 * 110 * 2 * 0.9);
      expect(sum((run) => run.founded)).toBeGreaterThan(6);
      expect(sum((run) => run.grew)).toBeGreaterThan(10);
      expect(sum((run) => run.starved)).toBeGreaterThan(0);
      expect(sum((run) => run.produced)).toBeGreaterThan(10);
      expect(sum((run) => run.huts)).toBeGreaterThan(0);
      expect(sum((run) => run.barbarianUnits)).toBeGreaterThan(0);
      expect(Math.max(...runs.map((run) => run.maxPopulation))).toBeGreaterThan(1);
      expect(Math.max(...runs.map((run) => run.maxCities))).toBeGreaterThan(1);
      for (const run of runs) expect(run.hash).toMatch(/^[0-9a-f]{16}$/);
    },
  );

  it('holds with two more civilizations crowded onto the map', { timeout: 180_000 }, () => {
    const rec = recorder();
    const state0 = generatedFor(7, 4);
    expect(civPlayers(state0)).toHaveLength(4);

    let state = state0;
    for (const player of civPlayers(state)) {
      const unit = state.units.find((candidate) => candidate.owner === player.id);
      if (unit === undefined) continue;
      const founded = applyCommand(
        state,
        player.id,
        { type: 'FoundCity', unitId: unit.id },
        RULESET,
      );
      expect(founded.ok, `player ${String(player.id)} could not found`).toBe(true);
      if (founded.ok) state = founded.value.state;
    }
    expect(state.cities.length).toBe(4);

    // Four cities on one tiny map: their radii overlap heavily, which is exactly
    // where "no two cities work the same tile" has to hold.
    for (const player of civPlayers(state)) {
      const before = state;
      const ended = applyCommand(state, player.id, { type: 'EndTurn' }, RULESET);
      expect(ended.ok).toBe(true);
      if (!ended.ok) continue;
      checkTurn(
        rec,
        before,
        ended.value.state,
        ended.value.events,
        `seed 7 player ${String(player.id)}`,
      );
      state = ended.value.state;
    }

    const tiles = new Map<number, number>();
    for (const city of state.cities) {
      for (const tile of city.workedTiles) {
        const index = Number(tile);
        expect(tiles.has(index), `tile ${String(index)} is worked by two cities`).toBe(false);
        tiles.set(index, Number(city.id));
      }
    }
    expect(tiles.size).toBeGreaterThan(0);
    expect(rec.problems).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Determinism, in-process and in a fresh process
 * ------------------------------------------------------------------ */

/** One step of a recorded script: who acts, with what. */
interface ScriptStep {
  readonly player: number;
  readonly cmd: Command;
}

interface ScriptedRun {
  readonly seed: number;
  readonly steps: readonly ScriptStep[];
  readonly hash: string;
  readonly events: readonly GameEvent[];
  readonly hutRewards: readonly string[];
}

/**
 * A scripted M3 session: found cities, queue production, walk a unit toward the
 * nearest hut (which enters huts), end turns. Recorded as a *list of commands*
 * so a fresh process can replay the very same sequence rather than re-deriving
 * it — "same seed and same commands" is the property under test, and re-deriving
 * the commands would be testing the driver instead.
 */
const scriptedRun = (seed: number, turns: number): ScriptedRun => {
  let state = generatedFor(seed);
  const steps: ScriptStep[] = [];
  const events: GameEvent[] = [];

  const push = (player: PlayerId, cmd: Command): void => {
    const outcome = applyCommand(state, player, cmd, RULESET);
    if (!outcome.ok) {
      throw new Error(`script: ${cmdKey(cmd)} refused: ${JSON.stringify(outcome.error)}`);
    }
    steps.push({ player: Number(player), cmd });
    events.push(...outcome.value.events);
    state = outcome.value.state;
  };

  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of civPlayers(state)) {
      const found = [...legalActions(state, RULESET, player.id)].find(
        (cmd) => cmd.type === 'FoundCity',
      );
      if (found !== undefined) push(player.id, found);

      const city = citiesOf(state, player.id).find(
        (candidate) => candidate.production === undefined,
      );
      if (city !== undefined) {
        push(player.id, {
          type: 'SetProduction',
          cityId: city.id,
          item: { kind: 'unit', id: asUnitTypeId('settler') },
        });
      }

      const walker = state.units.find((unit) => unit.owner === player.id);
      if (walker !== undefined) {
        const to = greedyTowardHut(state, Number(walker.id));
        if (to !== undefined) push(player.id, { type: 'MoveUnit', unitId: walker.id, to });
      }

      push(player.id, { type: 'EndTurn' });
    }
  }

  return {
    seed,
    steps,
    hash: hashValue(state),
    events,
    hutRewards: hutEntriesOf(events).map((event) => event.reward),
  };
};

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

/** The child replays the recorded script and prints its hash and its full event log. */
const childScript = (run: ScriptedRun): string => `
import { DEFAULT_SETTINGS, applyCommand, newGame } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const seeded = newGame(${String(run.seed)}, { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed: ${String(run.seed)} }, ruleset);
if (!seeded.ok) throw new Error('newGame failed');

let state = seeded.value;
const events = [];
for (const step of ${JSON.stringify(run.steps)}) {
  const outcome = applyCommand(state, step.player, step.cmd, ruleset);
  if (!outcome.ok) {
    console.log('REFUSED ' + JSON.stringify(step.cmd) + ' ' + JSON.stringify(outcome.error));
    process.exit(3);
  }
  for (const event of outcome.value.events) events.push(event);
  state = outcome.value.state;
}

console.log('HASH ' + hashValue(state));
console.log('EVENTS ' + JSON.stringify(events));
`;

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

describe('determinism — M3, in-process and in a fresh process', () => {
  it(
    'reproduces the same hash and the same event log for the same seed and commands',
    { timeout: 180_000 },
    () => {
      const runs = [1, 42, 1337].map((seed) => scriptedRun(seed, 12));

      // In-process: twice, and compared field by field (not only by hash).
      for (const run of runs) {
        const again = scriptedRun(run.seed, 12);
        expect(again.steps, `seed ${String(run.seed)}`).toEqual(run.steps);
        expect(again.hash).toBe(run.hash);
        expect(again.events).toEqual(run.events);
        expect(again.hutRewards).toEqual(run.hutRewards);
      }

      expect(new Set(runs.map((run) => run.hash)).size).toBe(runs.length);
      // The scripts really do exercise M3: cities with production, and huts.
      expect(runs.some((run) => run.hutRewards.length > 0)).toBe(true);
      expect(runs.every((run) => run.steps.some((step) => step.cmd.type === 'FoundCity'))).toBe(
        true,
      );

      const childResults = runs.map((run) => {
        const child = runInFreshProcess(childScript(run));
        expect(
          child.status,
          `seed ${String(run.seed)} fresh process failed:\n${child.stderr}`,
        ).toBe(0);
        return child;
      });

      const observed = childResults.map((child) => {
        const hashLine = child.stdout.split('\n').find((line) => line.startsWith('HASH '));
        const eventsLine = child.stdout.split('\n').find((line) => line.startsWith('EVENTS '));
        expect(hashLine, 'the child printed no hash').toBeDefined();
        expect(eventsLine, 'the child printed no event log').toBeDefined();
        return {
          hash: (hashLine ?? '').slice('HASH '.length).trim(),
          events: (eventsLine ?? '').slice('EVENTS '.length).trim(),
        };
      });

      console.log(
        'm3 hashes (in-process = fresh process):',
        runs
          .map((run, index) => `${String(run.seed)}:${run.hash}=${observed[index]?.hash ?? '?'}`)
          .join(' '),
      );
      console.log(
        'm3 hut rewards:',
        runs.map((run) => `${String(run.seed)}:[${run.hutRewards.join(',')}]`).join(' '),
      );

      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index];
        const seen = observed[index];
        expect(seen?.hash, `seed ${String(run?.seed)}: the fresh process disagrees`).toBe(
          run?.hash,
        );
        // The whole event log, so a hut reward that differed between processes could
        // not hide behind an identical final state.
        expect(seen?.events, `seed ${String(run?.seed)}: the event logs differ`).toBe(
          JSON.stringify(run?.events),
        );
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 5. Is the golden harness still a gate?
 * ------------------------------------------------------------------ */

/**
 * Run the *committed* golden test against a throwaway copy of the repo, so the
 * real harness — not a paraphrase of it — can be asked what it does when a stored
 * hash is wrong.
 *
 * Nothing in the repository is written: the copy lives in the OS temp directory,
 * `node_modules` is symlinked, and the function returns whether the file in the
 * copy survived the run unchanged.
 */
interface GoldenHarnessRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly fileUnchanged: boolean;
}

const runGoldenHarness = (corrupt: boolean): GoldenHarnessRun => {
  const root = mkdtempSync(join(tmpdir(), 'civts-m3-golden-'));
  try {
    for (const packageName of ['core', 'rules', 'testing']) {
      cpSync(
        join(repoRoot, 'packages', packageName, 'src'),
        join(root, 'packages', packageName, 'src'),
        { recursive: true },
      );
      const packageModules = join(repoRoot, 'packages', packageName, 'node_modules');
      cpSync(packageModules, join(root, 'packages', packageName, 'node_modules'), {
        recursive: true,
      });
    }
    cpSync(
      join(repoRoot, 'packages', 'testing', 'goldens'),
      join(root, 'packages', 'testing', 'goldens'),
      {
        recursive: true,
      },
    );
    cpSync(
      join(repoRoot, 'packages', 'testing', 'test', 'golden.test.ts'),
      join(root, 'packages', 'testing', 'test', 'golden.test.ts'),
    );
    cpSync(join(repoRoot, 'vitest.config.ts'), join(root, 'vitest.config.ts'));
    cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');

    const goldenPath = join(root, 'packages', 'testing', 'goldens', 'state.json');
    if (corrupt) {
      const parsed: unknown = JSON.parse(readFileSync(goldenPath, 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed['entries'])) {
        throw new Error('the copied golden file is not shaped like a golden file');
      }
      const entries = Array.from<unknown>(parsed['entries']);
      const first = entries[0];
      if (!isRecord(first)) throw new Error('the copied golden file has no first entry');
      first['hash'] = 'deadbeefdeadbeef';
      writeFileSync(goldenPath, `${JSON.stringify({ ...parsed, entries }, null, 2)}\n`, 'utf8');
    }

    const before = readFileSync(goldenPath, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--root',
        root,
        join('packages', 'testing', 'test', 'golden.test.ts'),
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    const after = readFileSync(goldenPath, 'utf8');

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: `${result.stderr}${result.error === undefined ? '' : `launch failed: ${result.error.message}`}`,
      fileUnchanged: before === after,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('goldens — still a gate, still refusing to auto-write', () => {
  it('stores the three pinned hashes, and they are the ones this build produces', () => {
    const stored = loadGoldens();
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    const computed = [1, 42, 1337].map((seed) => hashValue(generatedFor(seed)));
    console.log('m3 golden hashes:', computed.join(' '));

    // The three hashes the milestone pinned: M3 changed the persisted shape (and
    // therefore every hash) exactly once, at the foundation commit. This
    // milestone adds no state, so a hash that moves here is a semantic bug, not a
    // rehash to be regenerated.
    expect(computed).toEqual(['ba34136f4060eb63', '180cf4a0776af053', '1a1255383b7b747c']);
    expect(stored.entries.map((entry) => entry.hash)).toEqual(computed);
  });

  it('fails on a wrong hash and leaves the file on disk untouched', { timeout: 180_000 }, () => {
    const healthy = runGoldenHarness(false);
    expect(
      healthy.status,
      `the copied harness should pass:\n${healthy.stdout}${healthy.stderr}`,
    ).toBe(0);
    expect(healthy.fileUnchanged).toBe(true);

    const broken = runGoldenHarness(true);
    expect(broken.status, 'a corrupted golden did not fail the run').not.toBe(0);
    // The failure has to be the *gate* failing, with the pair a human needs, not
    // a crash in the copy.
    expect(broken.stdout).toContain('golden state hashes differ');
    expect(broken.stdout).toContain('deadbeefdeadbeef');
    expect(broken.stdout).toContain('ba34136f4060eb63');
    expect(broken.stdout).toContain('rehash: <reason>');
    // And it did not "fix" the file for itself: a golden that rewrites itself
    // cannot fail, and therefore cannot detect anything.
    expect(broken.fileUnchanged, 'the golden harness rewrote the file it was checking').toBe(true);
  });
});
