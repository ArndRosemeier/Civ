/**
 * M4a adversarial review (W5: integration owner, then adversarial review) — an
 * attempt to FALSIFY the frozen M4a contracts in docs/INTERFACES.md, not to
 * confirm them.
 *
 * This file was written after driving `pnpm verify` green from a red gate, so it
 * starts from the code that actually exists rather than from the prose. What it
 * attacks, and what each attack turned into:
 *
 * 1. **The keystone, now five generators.** `unitMoveOptions`, `unitActions`,
 *    `legalActions`, `planStartWork` and `planCancelWork` must agree with
 *    `applyCommand` in *both* directions — nothing yielded may be refused and
 *    nothing accepted may be missing. The sweep below walks real generated games
 *    with workers in them, and its completeness half enumerates the part of the
 *    command space the M2 and M3 sweeps never did: one `StartWork` per catalog kind
 *    and one `CancelWork` per unit, so an incomplete work generator cannot hide
 *    behind a candidate universe that contained no work command at all.
 * 2. **Improvement honesty.** `withImprovement` idempotent and pure, the pair list
 *    sorted and unique under long random play, every pair counted exactly once in a
 *    worked tile's yields, nothing at all for an unworked tile, nothing for the
 *    city centre.
 * 3. **Work honesty.** `turnsLeft` down by exactly one a turn; completion once,
 *    adding exactly one pair; moving cancels and never completes; a working unit
 *    that leaves the state leaves no phantom job behind.
 * 4. **Ordering, asserted rather than assumed.** An improvement finishing on turn N
 *    pays into turn N — the contract's deliberate "work runs first" ordering — and
 *    the assertion is a *twin* comparison, so a later "cleanup" that reorders the
 *    pipeline fails here even if every individual number still looks plausible.
 * 5. **Determinism**, in-process and in a genuinely fresh process, over a scripted
 *    worker game: the same seed and the same commands must give the same hash, the
 *    same event counts and the same pair list.
 * 6. **Whether the goldens are still a real gate**, and which invariants above are
 *    checked by something *permanent* rather than only by this file. Where a gap
 *    exists it is named rather than papered over — see the section comments at the
 *    bottom and the review report.
 *
 * Evidence quality, stated so this file is not oversold:
 *
 * - The keystone checks for `MoveUnit`, `FoundCity`, `StartWork` and `CancelWork`
 *   are two-sided against `applyCommand` on states reached by *playing*.
 *   `SetWorkedTiles` and `SetProduction` are deliberately not enumerated by the
 *   generators (a documented M3 decision: an assignment is a search space, not an
 *   action list); this file asserts the generators never yield them and otherwise
 *   leaves them to `packages/core/test/actions.test.ts`.
 * - The long-play checks are randomised but *seeded*: the PRNG is a local integer
 *   hash, never `Math.random`, so a failing run reproduces exactly.
 * - Provenance: nothing here blesses a number as Civ 3's. Every turn count and
 *   yield delta is read from the shipped catalog rows through `improvementDef`; the
 *   only literals are structural (which step of the sweep does what).
 *
 * Migrated for M4b (docs/INTERFACES.md M4b) by the F6 rule — this file's author had
 * finished before the milestone's contract landed. Three things needed it:
 *
 * 1. `cmdKey` gained `SetRates`, keyed by the triple. Without that case the switch
 *    is not exhaustive and the file does not compile, which is the property that
 *    switch exists for.
 * 2. The golden-coverage test used to close the gap "the goldens pin M4a's shape and
 *    nothing about workers, because every golden scenario is a `newGame` state". M4b
 *    gives every civilization a **starting worker**, so those states do now contain
 *    workers, and the gap is narrower than it was: the goldens cover `newGame`'s
 *    worker placement (one per civilization, pinned by count) and still cover no
 *    *behaviour* — no unit carries a `work` job and no tile carries an improvement in
 *    any golden state. The boundary is written out at its new width rather than
 *    deleted.
 * 3. `withWorkers`' doc comment claimed `newGame` places "no worker", which was true
 *    until M4b. The helper is kept — the sweeps want *several* workers per
 *    civilization, not one — and its comment now says what it is for instead of
 *    describing a board that no longer exists.
 *
 * Nothing else in the file moved, and in particular no sweep was weakened: this is
 * still the only place where `StartWork`/`CancelWork` completeness over played games
 * is checked, and the M2 keystone's new enumeration of those two families (M4b) does
 * not replace it — that one walks hand-built candidate lists, this one walks games.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  IMPROVEMENT_KINDS,
  SCHEMA_VERSION,
  advanceTurn,
  applyCommand,
  asImprovementId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  cityRadius,
  cityYields,
  hasImprovement,
  improvementDef,
  improvementsAt,
  legalActions,
  newGame,
  planStartWork,
  spawnUnit,
  unitActions,
  unitById,
  withImprovement,
  withoutImprovement,
  type City,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type ImprovementDef,
  type ImprovementId,
  type MapSize,
  type PlayerId,
  type RulesetView,
  type Settings,
  type TileIndex,
  type Unit,
  type UnitDef,
  type UnitId,
  type UnitTypeId,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

import { loadGoldens } from '../src/goldens.js';
import {
  canonicalize,
  createScenarioBuilder,
  hashValue,
  type ScenarioBuilder,
} from '../src/index.js';

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

/** The catalog's worker row: the unit every work test needs. */
const WORKER: UnitDef = (() => {
  const def = RULESET.units.find((unit) => unit.role === 'worker');
  if (def === undefined) throw new Error('the shipped catalog defines no worker-role unit');
  return def;
})();

const ROAD = asImprovementId('road');
const MINE = asImprovementId('mine');
const IRRIGATION = asImprovementId('irrigation');

/** Every improvement id this ruleset can build, in catalog order, deduplicated. */
const IMPROVEMENT_IDS: readonly ImprovementId[] = [
  ...new Set(RULESET.improvements.map((def) => def.id)),
];

/**
 * A catalog row, or a thrown error naming the gap. Used instead of a cast or a
 * non-null assertion so a catalog that lost a row fails as a *fixture* problem
 * rather than as a confusing expectation somewhere else.
 */
const mustImprovement = (id: ImprovementId): ImprovementDef => {
  const def = improvementDef(RULESET, id);
  if (def === undefined) throw new Error(`the shipped catalog defines no improvement "${id}"`);
  return def;
};

/**
 * Where an improvement kind sorts, mirroring `improvements.ts`: its index in
 * `IMPROVEMENT_KINDS`, or `-1` for a kind this engine does not know. The tuple is
 * widened to `readonly string[]` because `ImprovementId` is a branded string and
 * is not assignable to its literal element type — the same widening the source
 * module documents: a membership test, not a cast around the type system.
 */
const KIND_NAMES: readonly string[] = IMPROVEMENT_KINDS;
const kindRank = (kind: ImprovementId): number => KIND_NAMES.indexOf(kind);

const DUEL: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

const settingsFor = (seed: number, civCount: number = DUEL.civCount): Settings => ({
  ...DUEL,
  seed,
  civCount,
});

/** A generated game — the shipped `newGame` path, never a hand-built state. */
const startedState = (seed: number, civCount: number = DUEL.civCount): GameState => {
  const result = newGame(seed, settingsFor(seed, civCount), RULESET);
  if (!result.ok) {
    throw new Error(`newGame(${String(seed)}) failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

/** The golden harness's own scenario shape: tiny map, two civilizations. */
const goldenState = (seed: number): GameState => {
  const settings: Settings = { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed };
  const result = newGame(seed, settings, RULESET);
  if (!result.ok) throw new Error(`golden newGame(${String(seed)}) failed`);
  return result.value;
};

/**
 * Extra workers on top of the ones the board already has.
 *
 * MIGRATED (M4b): `newGame` used to place one settler per civilization and no
 * worker, so this helper *was* how every work sweep got a worker at all. It no
 * longer is — M4b's starting units hand each civilization a worker on turn one
 * (`STARTING_UNIT_ROLES`) — and the helper is kept, rather than deleted, because
 * the sweeps want several workers *per* civilization (two workers finishing the
 * same pair in one turn, one worker per terrain kind, a job that outlives its
 * unit): a fixed count on top of the starting pair is the honest way to say that,
 * and the starting worker is checked where it belongs, in the golden-state test
 * below. `spawnUnit` is the engine's own "a unit comes into being" (production and
 * hut rewards go through it), so a state with an injected worker is a state the
 * engine can genuinely reach — not a shaped object.
 */
const withWorkers = (state: GameState, perPlayer: number): GameState => {
  let current = state;
  for (const player of state.players) {
    if (player.kind !== 'civ') continue;
    for (let n = 0; n < perPlayer; n += 1) {
      current = spawnUnit(current, WORKER, player.id, player.startingTile).state;
    }
  }
  return current;
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

/** A tile index in a 40x40 duel map (`MAP_DIMENSIONS.duel`). */
const at = (x: number, y: number): TileIndex => asTileIndex(y * 40 + x);

/** An accumulating recorder, so a sweep reports everything it found in one run. */
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

/**
 * A stable key for a command, so two generators can be compared as sets. The
 * switch is exhaustive on purpose: a new `Command` variant that is not keyed here
 * is a *typecheck* failure rather than a silently equal pair of different
 * commands — and M4a's work commands are keyed by *kind*, because "start a road"
 * and "start a mine" are different commands.
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
    case 'StartWork':
      return `StartWork ${String(cmd.unitId)} ${String(cmd.kind)}`;
    case 'CancelWork':
      return `CancelWork ${String(cmd.unitId)}`;
    // M4b. Keyed by the *triple*, for the M4a reason: two `SetRates` naming
    // different splits are different commands, and a key that dropped the numbers
    // would call them equal — the exact false equivalence this comparator exists to
    // prevent.
    case 'SetRates':
      return `SetRates ${String(cmd.rates.tax)}/${String(cmd.rates.science)}/${String(cmd.rates.luxury)}`;
  }
};

/** A readable rendering of a refusal, for a sweep's failure message. */
const errorText = (error: GameError): string => JSON.stringify(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Freeze a state (and everything under it), so a mutation is a thrown TypeError. */
const deepFreeze = (value: unknown): void => {
  if (!isRecord(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
};

/** Can this state be hashed at all? The "explicit `undefined`" bug class, caught. */
const isHashable = (state: GameState): boolean => {
  try {
    hashValue(state);
    return true;
  } catch {
    return false;
  }
};

/** One unit's job, as read off the state — never a copy of the state's own object. */
interface WorkSnapshot {
  readonly kind: ImprovementId;
  readonly tile: TileIndex;
  readonly turnsLeft: number;
}

const workMap = (state: GameState): Map<number, WorkSnapshot> => {
  const map = new Map<number, WorkSnapshot>();
  for (const unit of state.units) {
    const work = unit.work;
    if (work === undefined) continue;
    map.set(Number(unit.id), { kind: work.kind, tile: work.tile, turnsLeft: work.turnsLeft });
  }
  return map;
};

const workOf = (state: GameState, unitId: UnitId): WorkSnapshot | undefined =>
  workMap(state).get(Number(unitId));

const workEventsOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'WorkCompleted' }>[] =>
  events.flatMap((event) => (event.type === 'WorkCompleted' ? [event] : []));

const cancelEventsOf = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'WorkCancelled' }>[] =>
  events.flatMap((event) => (event.type === 'WorkCancelled' ? [event] : []));

/**
 * The pair-list invariant the M4a contract fixes, checked wherever a state is
 * observed: sorted by `(tile, then kind)`, no duplicate pair, every entry a whole
 * tile index, every kind one the engine knows.
 *
 * A list that is not sorted-and-unique is a *hash* problem, not a cosmetic one:
 * the same set of pairs reached in a different order would hash differently, so
 * every save and every golden would depend on the order a worker happened to be
 * told to build things in.
 */
const checkPairList = (rec: Recorder, state: GameState, where: string): void => {
  const pairs = state.improvements;
  const seen = new Set<string>();
  for (let i = 0; i < pairs.length; i += 1) {
    const entry = pairs[i];
    if (entry === undefined) {
      rec.check(false, `${where}: hole at index ${String(i)} in improvements`);
      continue;
    }
    const key = `${String(entry.tile)}/${String(entry.kind)}`;
    rec.check(!seen.has(key), `${where}: duplicate pair ${key}`);
    seen.add(key);
    rec.check(
      Number.isInteger(Number(entry.tile)),
      `${where}: pair ${key} names a tile that is not a whole index`,
    );
    rec.check(
      KIND_NAMES.includes(entry.kind),
      `${where}: pair ${key} names a kind this engine does not know`,
    );

    const previous = pairs[i - 1];
    if (previous === undefined) continue;
    const ordered =
      previous.tile < entry.tile ||
      (previous.tile === entry.tile && kindRank(previous.kind) < kindRank(entry.kind));
    rec.check(
      ordered,
      `${where}: pair ${String(previous.tile)}/${String(previous.kind)} sorts after ` +
        `${String(entry.tile)}/${String(entry.kind)}`,
    );
  }
};

/* ------------------------------------------------------------------ *
 * The offer/choice policy the sweeps share
 * ------------------------------------------------------------------ */

interface Offer {
  readonly player: PlayerId;
  readonly cmd: Command;
}

/** Every command each real player may issue right now, tagged with its actor. */
const offersFor = (state: GameState): readonly Offer[] => {
  const offers: Offer[] = [];
  for (const player of state.players) {
    for (const cmd of legalActions(state, RULESET, player.id)) {
      offers.push({ player: player.id, cmd });
    }
  }
  return offers;
};

const isMoveOffer = (
  offer: Offer,
): offer is Offer & { readonly cmd: Extract<Command, { type: 'MoveUnit' }> } =>
  offer.cmd.type === 'MoveUnit';

/**
 * The sweeps' fixed, deterministic policy. Its whole job is to make the *states*
 * interesting: start jobs, pay turns so jobs complete, and cancel both ways (a
 * player-issued cancel and a move that cancels by construction). The step index
 * chooses the rule, so the walk is reproducible from the seed alone.
 */
const chooseCommand = (
  state: GameState,
  offers: readonly Offer[],
  step: number,
  prng: () => number,
): Offer | undefined => {
  const starts = offers.filter((offer) => offer.cmd.type === 'StartWork');
  const cancels = offers.filter((offer) => offer.cmd.type === 'CancelWork');
  const moves = offers.filter(isMoveOffer);
  const founds = offers.filter((offer) => offer.cmd.type === 'FoundCity');
  const ends = offers.filter((offer) => offer.cmd.type === 'EndTurn');
  const movingWorkers = moves.filter(
    (offer) => unitById(state, offer.cmd.unitId)?.work !== undefined,
  );

  const pick = <T>(list: readonly T[]): T | undefined => list[prng() % list.length];

  // A twelve-step cycle, chosen so that every branch of the work contract is
  // reached without relying on luck: a job is started (0), paid (1), cancelled
  // while in flight (2), started again (3) and paid to completion (4, 5, 6), then
  // started once more (7), paid (8) and walked away from (9). The catalog's
  // shortest job is two turns, so a job started at 0 still owes a turn at 2 — the
  // cancel is offered because there is genuinely something to cancel, which is why
  // the counters below are not vacuous.
  const cycle = step % 12;
  if ((cycle === 0 || cycle === 3 || cycle === 7) && starts.length > 0) return pick(starts);
  if (cycle === 2 && cancels.length > 0) return pick(cancels);
  if (cycle === 9 && movingWorkers.length > 0) return pick(movingWorkers);
  if (cycle === 11 && founds.length > 0) return pick(founds);
  if (cycle === 10 && moves.length > 0 && prng() % 3 === 0) return pick(moves);
  if (ends.length > 0) return pick(ends);
  return pick(offers);
};

/* ------------------------------------------------------------------ *
 * 1. The keystone, five generators, over played games
 * ------------------------------------------------------------------ */

interface KeystoneTotals {
  states: number;
  legalYielded: number;
  generatorApplied: number;
  unitCandidates: number;
  applierAccepted: number;
  movesYielded: number;
  movesAccepted: number;
  workCandidates: number;
  workYielded: number;
  workAccepted: number;
  workRefused: number;
  endTurns: number;
  cityCommandsYielded: number;
  started: number;
  completed: number;
  cancelledByPlayer: number;
  cancelledByMoving: number;
  pairsBuilt: number;
}

interface KeystoneRun {
  readonly failures: readonly string[];
  readonly totals: KeystoneTotals;
}

/**
 * Walk real games forward with workers on the board and check, at every state,
 * both directions of the keystone property:
 *
 * - **soundness**: every action `legalActions`/`unitActions` yields applies, bumps
 *   `revision` by exactly one, and emits at least one event;
 * - **completeness**: every command `applyCommand` accepts is yielded by *both*
 *   generators. The candidate universe is exhaustive where the space is finite:
 *   every tile index for `MoveUnit` (not just the 8 neighbours), `FoundCity`, one
 *   `StartWork` per catalog kind, `CancelWork`, and `EndTurn` per player.
 *
 * The state is deep-frozen before each read-only pass, so a mutation is a thrown
 * `TypeError` rather than a silently different answer, and the hash is compared
 * afterwards to catch a mutation of something freezing did not reach.
 */
const keystoneSweep = (seeds: readonly number[], steps: number): KeystoneRun => {
  const rec = recorder();

  const totals: KeystoneTotals = {
    states: 0,
    legalYielded: 0,
    generatorApplied: 0,
    unitCandidates: 0,
    applierAccepted: 0,
    movesYielded: 0,
    movesAccepted: 0,
    workCandidates: 0,
    workYielded: 0,
    workAccepted: 0,
    workRefused: 0,
    endTurns: 0,
    cityCommandsYielded: 0,
    started: 0,
    completed: 0,
    cancelledByPlayer: 0,
    cancelledByMoving: 0,
    pairsBuilt: 0,
  };

  for (const seed of seeds) {
    let state = withWorkers(startedState(seed), 1);
    const prng = makePrng(seed);
    const where = (step: number, extra: string): string =>
      `seed ${String(seed)} step ${String(step)}: ${extra}`;

    for (let step = 0; step < steps; step += 1) {
      totals.states += 1;
      const frozenHash = hashValue(state);
      deepFreeze(state);

      const offers: Offer[] = [];

      for (const player of state.players) {
        const legal = new Set<string>();

        for (const cmd of legalActions(state, RULESET, player.id)) {
          const key = cmdKey(cmd);
          legal.add(key);
          totals.legalYielded += 1;
          if (cmd.type === 'SetWorkedTiles' || cmd.type === 'SetProduction') {
            totals.cityCommandsYielded += 1;
          }

          const outcome = applyCommand(state, player.id, cmd, RULESET);
          if (!outcome.ok) {
            rec.check(
              false,
              where(
                step,
                `legalActions yielded ${key} but applyCommand refused it: ${errorText(outcome.error)}`,
              ),
            );
            continue;
          }
          totals.generatorApplied += 1;
          rec.check(
            outcome.value.state.revision === state.revision + 1,
            where(step, `${key} did not bump revision by exactly one`),
          );
          rec.check(
            outcome.value.events.length > 0,
            where(step, `${key} applied without emitting an event`),
          );
          offers.push({ player: player.id, cmd });
        }

        for (const unit of state.units) {
          if (unit.owner !== player.id) continue;

          const mine = new Set<string>();
          for (const cmd of unitActions(state, RULESET, unit.id)) {
            const key = cmdKey(cmd);
            mine.add(key);
            if (cmd.type === 'MoveUnit') totals.movesYielded += 1;

            const outcome = applyCommand(state, player.id, cmd, RULESET);
            if (!outcome.ok) {
              rec.check(
                false,
                where(
                  step,
                  `unitActions yielded ${key} but applyCommand refused it: ${errorText(outcome.error)}`,
                ),
              );
            }
          }

          /**
           * Ask the applier about one candidate and hold the generators to the
           * answer, in both directions. The equality — not just "accepted implies
           * yielded" — is the property: a generator that offers what the applier
           * refuses is exactly as broken as one that hides what it accepts.
           */
          const compare = (cmd: Command): boolean => {
            const key = cmdKey(cmd);
            const outcome = applyCommand(state, player.id, cmd, RULESET);
            const yielded = mine.has(key);
            const listed = legal.has(key);
            if (outcome.ok) {
              rec.check(
                yielded,
                where(step, `applier ACCEPTED ${key} but unitActions never yields it (incomplete)`),
              );
              rec.check(
                listed,
                where(
                  step,
                  `applier ACCEPTED ${key} but legalActions never yields it (incomplete)`,
                ),
              );
            } else {
              rec.check(
                !yielded,
                where(
                  step,
                  `applier REFUSED ${key} but unitActions yields it: ${errorText(outcome.error)}`,
                ),
              );
              rec.check(
                !listed,
                where(
                  step,
                  `applier REFUSED ${key} but legalActions yields it: ${errorText(outcome.error)}`,
                ),
              );
            }
            return outcome.ok;
          };

          // The fifth generator's whole space: one `StartWork` per catalog kind,
          // and the single `CancelWork` question. This is the universe the M2 and
          // M3 keystone sweeps never enumerated.
          for (const kind of IMPROVEMENT_IDS) {
            const cmd: Command = { type: 'StartWork', unitId: unit.id, kind };
            totals.workCandidates += 1;
            const accepted = compare(cmd);
            if (accepted) totals.workAccepted += 1;
            else totals.workRefused += 1;
            if (mine.has(cmdKey(cmd))) totals.workYielded += 1;
          }

          const cancel: Command = { type: 'CancelWork', unitId: unit.id };
          totals.workCandidates += 1;
          if (compare(cancel)) totals.workAccepted += 1;
          else totals.workRefused += 1;
          if (mine.has(cmdKey(cancel))) totals.workYielded += 1;

          const foundCity: Command = { type: 'FoundCity', unitId: unit.id };
          totals.unitCandidates += 1;
          if (compare(foundCity)) totals.applierAccepted += 1;

          // Every tile, not just the neighbours: a generator that forgot one shows
          // up here rather than in a review.
          const size = state.map.width * state.map.height;
          for (let to = 0; to < size; to += 1) {
            const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to: asTileIndex(to) };
            totals.unitCandidates += 1;
            if (compare(cmd)) {
              totals.applierAccepted += 1;
              totals.movesAccepted += 1;
            }
          }
        }

        const endTurn: Command = { type: 'EndTurn' };
        totals.endTurns += 1;
        const outcome = applyCommand(state, player.id, endTurn, RULESET);
        rec.check(
          outcome.ok === legal.has('EndTurn'),
          where(
            step,
            `EndTurn accepted=${String(outcome.ok)} but legalActions yielded=${String(
              legal.has('EndTurn'),
            )}`,
          ),
        );
      }

      rec.check(
        hashValue(state) === frozenHash,
        where(step, 'the read-only sweep mutated the state'),
      );

      // The walk itself: one command, applied for real, on the state everything
      // above only read.
      const chosen = chooseCommand(state, offers, step, prng);
      if (chosen === undefined) break;

      const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
      if (!outcome.ok) {
        rec.check(
          false,
          where(
            step,
            `chosen action ${cmdKey(chosen.cmd)} was refused: ${errorText(outcome.error)}`,
          ),
        );
        break;
      }

      state = outcome.value.state;
      for (const event of outcome.value.events) {
        switch (event.type) {
          case 'WorkStarted':
            totals.started += 1;
            break;
          case 'WorkCompleted':
            totals.completed += 1;
            break;
          case 'WorkCancelled':
            if (event.reason === 'moved') totals.cancelledByMoving += 1;
            else totals.cancelledByPlayer += 1;
            break;
          default:
            break;
        }
      }

      totals.pairsBuilt = state.improvements.length;
      checkPairList(rec, state, where(step, 'after an applied command'));
      rec.check(isHashable(state), where(step, 'the resulting state cannot be hashed'));
    }
  }

  return { failures: rec.problems, totals };
};

describe('1. keystone — five generators agree with the applier, in both directions', () => {
  it('holds over played games with workers, including every work command the applier accepts', () => {
    const { failures, totals } = keystoneSweep([1, 2, 3, 5, 8, 13, 21, 34], 12);

    console.log('m4a keystone totals:', JSON.stringify(totals));
    expect(failures).toEqual([]);

    // Non-vacuity, stated as counts: a sweep that never saw a work command, never
    // built anything or never refilled a turn would pass while proving nothing.
    expect(totals.states).toBeGreaterThan(0);
    expect(totals.workCandidates).toBeGreaterThan(0);
    expect(totals.workAccepted).toBeGreaterThan(0);
    expect(totals.workRefused).toBeGreaterThan(0);
    expect(totals.workYielded).toBe(totals.workAccepted);
    expect(totals.started).toBeGreaterThan(0);
    expect(totals.completed).toBeGreaterThan(0);
    expect(totals.cancelledByPlayer).toBeGreaterThan(0);
    expect(totals.cancelledByMoving).toBeGreaterThan(0);
    expect(totals.pairsBuilt).toBeGreaterThan(0);
    // `MoveUnit` completeness: every tile the applier accepted was yielded.
    expect(totals.movesAccepted).toBe(totals.movesYielded);
    // The two city setters are queries, not enumerated actions (M3's decision).
    expect(totals.cityCommandsYielded).toBe(0);
    expect(totals.endTurns).toBeGreaterThan(0);
  });

  it('agrees about where work may start on the boundary boards a played game cannot reach', () => {
    // A generated game never puts a worker on the ocean, on terrain the ruleset
    // does not describe, off the map, or on a tile that already carries the job —
    // so the sweep above can only ever test the happy path. These are hand-built
    // boards, and the property asserted is the same one: `StartWork` is offered
    // exactly where the applier accepts it, and the refusal is typed.
    const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .setTile(8, 5, 'ocean')
      .addUnit(0, WORKER.id, [6, 5])
      .addUnit(1, WORKER.id, [30, 30])
      .build();
    if (!built.ok)
      throw new Error(`the boundary fixture must build: ${JSON.stringify(built.error)}`);

    const base = built.value;
    const digger = asUnitId(0);
    const home = at(6, 5);
    const standingOn = (tile: TileIndex): GameState => ({
      ...base,
      units: base.units.map((unit) => (unit.id === digger ? { ...unit, tile } : unit)),
    });
    const withTerrain = (tile: TileIndex, id: string): GameState => ({
      ...base,
      map: {
        ...base.map,
        terrain: base.map.terrain.map((existing, index) =>
          index === Number(tile) ? asTerrainId(id) : existing,
        ),
      },
    });

    const ocean = at(8, 5);
    const boards: readonly { readonly label: string; readonly state: GameState }[] = [
      { label: 'hills (the control)', state: base },
      { label: 'ocean', state: standingOn(ocean) },
      {
        label: 'terrain the ruleset does not describe',
        state: withTerrain(home, 'unobtainium'),
      },
      { label: 'off the map', state: standingOn(asTileIndex(99999)) },
      { label: 'already carrying the kind', state: withImprovement(base, home, MINE) },
    ];

    const startOffer = (state: GameState, kind: ImprovementId): boolean =>
      [...unitActions(state, RULESET, digger)].some(
        (cmd) => cmd.type === 'StartWork' && cmd.kind === kind,
      );
    const listedOffer = (state: GameState, kind: ImprovementId): boolean =>
      [...legalActions(state, RULESET, asPlayerId(0))].some(
        (cmd) => cmd.type === 'StartWork' && cmd.unitId === digger && cmd.kind === kind,
      );
    const accepts = (state: GameState, kind: ImprovementId): boolean =>
      applyCommand(state, asPlayerId(0), { type: 'StartWork', unitId: digger, kind }, RULESET).ok;

    let accepted = 0;
    let refused = 0;
    for (const board of boards) {
      for (const kind of IMPROVEMENT_IDS) {
        const ok = accepts(board.state, kind);
        expect(
          startOffer(board.state, kind),
          `${board.label}: unitActions disagrees with the applier about ${String(kind)}`,
        ).toBe(ok);
        expect(
          listedOffer(board.state, kind),
          `${board.label}: legalActions disagrees with the applier about ${String(kind)}`,
        ).toBe(ok);
        if (ok) accepted += 1;
        else refused += 1;
      }
    }

    // Discriminating: the control offers work, the boundary boards refuse it.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);

    // And the refusals are the typed ones, each naming what is actually wrong —
    // a generator that refused silently would still pass the equality above.
    const refusal = (state: GameState, kind: ImprovementId): GameError | undefined => {
      const plan = planStartWork(state, RULESET, asPlayerId(0), digger, kind);
      return plan.ok ? undefined : plan.error;
    };
    expect(refusal(standingOn(ocean), MINE)).toEqual({
      kind: 'improvement-not-allowed',
      unitId: digger,
      tile: ocean,
      improvement: MINE,
      role: 'ocean',
    });
    expect(refusal(withTerrain(home, 'unobtainium'), MINE)?.kind).toBe('invalid-argument');
    expect(refusal(standingOn(asTileIndex(99999)), MINE)).toEqual({
      kind: 'out-of-bounds',
      to: asTileIndex(99999),
    });
    expect(refusal(withImprovement(base, home, MINE), MINE)).toEqual({
      kind: 'already-improved',
      tile: home,
      improvement: MINE,
    });
    // The control really does accept, so the four refusals above are not a
    // fixture that refuses everything.
    expect(refusal(base, MINE)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 2. Improvement honesty
 * ------------------------------------------------------------------ */

const HILL = at(6, 5);
const FLAT = at(7, 5);
const CENTRE = at(5, 5);

/**
 * A world with one city working a hill, a worker to its east, and everything else
 * flat. Hand-built through the scenario builder so the yields below are pinned to
 * known terrain rather than to whatever generation produced.
 */
const m4aWorld = (): ScenarioBuilder =>
  createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .setTile(6, 5, 'hills')
    // The builder needs a unit per player (a player's `startingTile` comes from
    // where its first unit stands), so both civilizations get one — out of the way,
    // because the city below is the subject.
    .addUnit(0, WORKER.id, [30, 31])
    .addUnit(1, WORKER.id, [31, 31])
    .addCity(0, [5, 5], { population: 1, workedTiles: [HILL] });

const m4aState = (): GameState => {
  const built = m4aWorld().build();
  if (!built.ok) throw new Error(`the M4a fixture must build: ${JSON.stringify(built.error)}`);
  return built.value;
};

const cityOf = (state: GameState): City => {
  const city = state.cities[0];
  if (city === undefined) throw new Error('the M4a fixture must hold one city');
  return city;
};

/**
 * The worked tiles `cityYields` actually counts, restated here from the M4a/M3
 * contract (radius, not the centre, one citizen one tile, at most `population`) so
 * that the yield comparison below is not just the implementation agreeing with
 * itself.
 */
const countedWorkedTiles = (state: GameState, city: City): readonly TileIndex[] => {
  const inside = new Set<number>(cityRadius(state, city.tile).map(Number));
  const counted = new Set<number>([Number(city.tile)]);
  const out: TileIndex[] = [];
  for (const tile of city.workedTiles) {
    if (counted.size > city.population) break;
    const index = Number(tile);
    if (!inside.has(index) || counted.has(index)) continue;
    counted.add(index);
    out.push(tile);
  }
  return out;
};

/** The improvement deltas the counted tiles should be contributing, summed by hand. */
const expectedImprovementDelta = (
  state: GameState,
  city: City,
): { readonly food: number; readonly shields: number; readonly commerce: number } => {
  let food = 0;
  let shields = 0;
  let commerce = 0;
  for (const tile of countedWorkedTiles(state, city)) {
    for (const kind of improvementsAt(state, tile)) {
      const def = improvementDef(RULESET, kind);
      if (def === undefined) continue;
      food += def.yields.food;
      shields += def.yields.shields;
      commerce += def.yields.commerce;
    }
  }
  return { food, shields, commerce };
};

describe('2. improvement honesty', () => {
  it('ships the three kinds the contract names, with readable catalog rows', () => {
    // A fixture check rather than a rule: if the catalog loses a row, the tests
    // below would be asserting about improvements nothing can build. Non-negative
    // terrain yields and non-negative deltas are also what makes the "observed
    // delta equals raw delta" comparison below exact: with both non-negative, the
    // per-component clamp at zero can never bite.
    for (const id of [ROAD, MINE, IRRIGATION]) {
      const def = mustImprovement(id);
      expect(KIND_NAMES).toContain(id);
      expect(Number.isInteger(def.turns)).toBe(true);
      expect(def.turns).toBeGreaterThanOrEqual(1);
      expect(def.allowedRoles.length).toBeGreaterThan(0);
      expect(def.yields.food).toBeGreaterThanOrEqual(0);
      expect(def.yields.shields).toBeGreaterThanOrEqual(0);
      expect(def.yields.commerce).toBeGreaterThanOrEqual(0);
    }
    for (const terrain of RULESET.terrains) {
      expect(terrain.yields.food).toBeGreaterThanOrEqual(0);
      expect(terrain.yields.shields).toBeGreaterThanOrEqual(0);
      expect(terrain.yields.commerce).toBeGreaterThanOrEqual(0);
    }
  });

  it('withImprovement is idempotent and pure: one entry, no mutation, no hash movement on a repeat', () => {
    const state = m4aState();
    const before = hashValue(state);

    const once = withImprovement(state, HILL, MINE);
    expect(hashValue(state)).toBe(before); // the input is untouched
    expect(state.improvements).toEqual([]);
    expect(once.improvements).toEqual([{ tile: HILL, kind: MINE }]);

    const twice = withImprovement(once, HILL, MINE);
    expect(twice.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(hashValue(twice)).toBe(hashValue(once));

    // Purity holds against a frozen input too, and the result is still hashable —
    // the "explicit undefined" bug class would throw here rather than later.
    deepFreeze(state);
    const frozenAdd = withImprovement(state, HILL, MINE);
    expect(hashValue(frozenAdd)).toBe(hashValue(once));
    expect(isHashable(frozenAdd)).toBe(true);

    // Removing then re-adding is the same state: the pair list is a function of
    // the pair *set*, not of how it was reached.
    const cycled = withImprovement(withoutImprovement(once, HILL, MINE), HILL, MINE);
    expect(hashValue(cycled)).toBe(hashValue(once));

    // Removing a pair that is not there leaves the pairs it keeps alone.
    expect(withoutImprovement(once, HILL, ROAD).improvements).toEqual([{ tile: HILL, kind: MINE }]);
  });

  it('orders the pair list by (tile, kind) however the pairs arrive', () => {
    const pairs: readonly { readonly tile: TileIndex; readonly kind: ImprovementId }[] = [
      { tile: at(6, 5), kind: MINE },
      { tile: at(6, 5), kind: ROAD },
      { tile: at(4, 4), kind: ROAD },
      { tile: at(4, 4), kind: IRRIGATION },
      { tile: at(20, 20), kind: ROAD },
      { tile: at(21, 21), kind: IRRIGATION },
    ];

    const base = m4aState();
    const canonical = pairs.reduce(
      (state, pair) => withImprovement(state, pair.tile, pair.kind),
      base,
    );
    const canonicalHash = hashValue(canonical);

    const keys = canonical.improvements.map((pair) => `${String(pair.tile)}/${String(pair.kind)}`);
    // The kind order is `IMPROVEMENT_KINDS` order — road, mine, irrigation — which
    // is catalog/editorial order and therefore *not* code-unit order (code units
    // would give irrigation, mine, road). It is hashed, so it is pinned here as
    // well as in `packages/core/test/improvements.test.ts`: an edit that
    // "corrected" the comparison to code units would move every golden, and this
    // assertion fails before it can.
    expect(KIND_NAMES).toEqual(['road', 'mine', 'irrigation']);
    expect(keys).toEqual([
      `${String(at(4, 4))}/${String(ROAD)}`,
      `${String(at(4, 4))}/${String(IRRIGATION)}`,
      `${String(at(6, 5))}/${String(ROAD)}`,
      `${String(at(6, 5))}/${String(MINE)}`,
      `${String(at(20, 20))}/${String(ROAD)}`,
      `${String(at(21, 21))}/${String(IRRIGATION)}`,
    ]);

    // Every insertion order of the same pairs, under a seeded shuffle: one
    // canonical list, so one hash.
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const prng = makePrng(seed);
      const shuffled = [...pairs];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = prng() % (i + 1);
        const a = shuffled[i];
        const b = shuffled[j];
        if (a === undefined || b === undefined) continue;
        shuffled[i] = b;
        shuffled[j] = a;
      }

      const built = shuffled.reduce(
        (state, pair) => withImprovement(state, pair.tile, pair.kind),
        base,
      );
      expect(hashValue(built), `insertion order from seed ${String(seed)}`).toBe(canonicalHash);
      checkPairList(recorder(), built, `insertion order from seed ${String(seed)}`);
    }
  });

  it('counts each improvement exactly once in the worked tile, nothing for an unworked tile, nothing for the centre', () => {
    const state = m4aState();
    const city = cityOf(state);
    const base = cityYields(state, RULESET, city.id);
    const mine = mustImprovement(MINE);
    const road = mustImprovement(ROAD);

    // The hill is worked: the mine's delta lands, once.
    const mined = withImprovement(state, HILL, MINE);
    expect(cityYields(mined, RULESET, city.id)).toEqual({
      food: base.food + mine.yields.food,
      shields: base.shields + mine.yields.shields,
      commerce: base.commerce + mine.yields.commerce,
      foodSurplus: base.foodSurplus + mine.yields.food,
    });

    // Adding it again (idempotent) cannot double it.
    const minedTwice = withImprovement(mined, HILL, MINE);
    expect(cityYields(minedTwice, RULESET, city.id)).toEqual(cityYields(mined, RULESET, city.id));

    // Two *different* improvements on one tile both count, once each — the "a road
    // and a mine" case the contract calls normal.
    const minedAndRoaded = withImprovement(mined, HILL, ROAD);
    expect(cityYields(minedAndRoaded, RULESET, city.id)).toEqual({
      food: base.food + mine.yields.food + road.yields.food,
      shields: base.shields + mine.yields.shields + road.yields.shields,
      commerce: base.commerce + mine.yields.commerce + road.yields.commerce,
      foodSurplus: base.foodSurplus + mine.yields.food + road.yields.food,
    });

    // An improvement on a tile the city does not work changes nothing — the pair
    // is really there (the hash moved), it simply pays nobody.
    const elsewhere = withImprovement(state, FLAT, MINE);
    expect(hasImprovement(elsewhere, FLAT, MINE)).toBe(true);
    expect(hashValue(elsewhere)).not.toBe(hashValue(state));
    expect(cityYields(elsewhere, RULESET, city.id)).toEqual(base);

    // The centre is not a worked tile: an improvement on it buys the city nothing,
    // even though the same kind on the same terrain pays when it is worked.
    const onCentre = withImprovement(state, CENTRE, MINE);
    expect(hasImprovement(onCentre, CENTRE, MINE)).toBe(true);
    expect(hashValue(onCentre)).not.toBe(hashValue(state));
    expect(cityYields(onCentre, RULESET, city.id)).toEqual(base);
    expect(cityYields(withImprovement(state, HILL, MINE), RULESET, city.id)).not.toEqual(base);
  });

  it('keeps the pair list canonical, and every city’s delta exact, across long random play', () => {
    const { recorder: rec, totals, finals } = longPlay([21, 34], 120);

    console.log('m4a improvement-honesty totals:', JSON.stringify(totals));
    expect(rec.problems).toEqual([]);
    expect(totals.pairsBuilt).toBeGreaterThan(0);
    expect(totals.completions).toBeGreaterThan(0);

    let citiesChecked = 0;
    let pepsChecked = 0;
    for (const state of finals) {
      for (const city of state.cities) {
        const built = cityYields(state, RULESET, city.id);
        const stripped: GameState = { ...state, improvements: [] };
        const bare = cityYields(stripped, RULESET, city.id);
        const expected = expectedImprovementDelta(state, city);

        // A tile's observed delta is its raw delta because neither terrain yields
        // nor improvement deltas are ever negative in this catalog (asserted in the
        // fixture test above), so the clamp at zero cannot be doing any work here.
        expect({
          food: built.food - bare.food,
          shields: built.shields - bare.shields,
          commerce: built.commerce - bare.commerce,
        }).toEqual(expected);

        citiesChecked += 1;
        pepsChecked += state.improvements.length;
      }
    }

    expect(citiesChecked).toBeGreaterThan(0);
    expect(pepsChecked).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Work honesty
 * ------------------------------------------------------------------ */

interface LongPlayTotals {
  states: number;
  endTurns: number;
  starts: number;
  completions: number;
  cancellations: number;
  movesByWorkingUnits: number;
  pairsBuilt: number;
  citiesFounded: number;
}

interface LongPlayRun {
  readonly recorder: Recorder;
  readonly totals: LongPlayTotals;
  readonly finals: readonly GameState[];
}

/**
 * Play real games for `steps` commands under the shared policy, checking the work
 * contract at every turn:
 *
 * - a job's `turnsLeft` falls by exactly one per turn, never more (a skip) and
 *   never less (a stall), and a non-positive count never reaches the state;
 * - a job that reaches zero completes that turn: its unit is idle, the pair is in
 *   the state, and exactly one `WorkCompleted` event names it — both directions, so
 *   neither a silent completion nor an event with no pair can pass;
 * - a move by a working unit cancels the job, emits `WorkCancelled` with reason
 *   `moved`, builds nothing, and reports what was still owed;
 * - no unit acquires a job except through `WorkStarted`;
 * - the pair list stays sorted, unique and hashable throughout.
 */
const longPlay = (seeds: readonly number[], steps: number): LongPlayRun => {
  const rec = recorder();
  const finals: GameState[] = [];
  const totals: LongPlayTotals = {
    states: 0,
    endTurns: 0,
    starts: 0,
    completions: 0,
    cancellations: 0,
    movesByWorkingUnits: 0,
    pairsBuilt: 0,
    citiesFounded: 0,
  };

  for (const seed of seeds) {
    let state = withWorkers(startedState(seed), 2);
    const prng = makePrng(seed);
    const where = (step: number, extra: string): string =>
      `seed ${String(seed)} step ${String(step)}: ${extra}`;

    for (let step = 0; step < steps; step += 1) {
      totals.states += 1;
      const chosen = chooseCommand(state, offersFor(state), step, prng);
      if (chosen === undefined) break;

      const before = workMap(state);
      const beforePairs = state.improvements.length;
      const mover = chosen.cmd.type === 'MoveUnit' ? unitById(state, chosen.cmd.unitId) : undefined;

      const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
      if (!outcome.ok) {
        rec.check(
          false,
          where(step, `${cmdKey(chosen.cmd)} was refused: ${errorText(outcome.error)}`),
        );
        break;
      }

      const next = outcome.value.state;
      const after = workMap(next);
      const completions = workEventsOf(outcome.value.events);
      const cancellations = cancelEventsOf(outcome.value.events);

      rec.check(isHashable(next), where(step, 'the resulting state cannot be hashed'));
      checkPairList(rec, next, where(step, 'after an applied command'));
      rec.check(
        next.improvements.length >= beforePairs,
        where(step, 'the pair list shrank; M4a has no command that removes an improvement'),
      );

      if (chosen.cmd.type === 'EndTurn') {
        totals.endTurns += 1;

        for (const [id, job] of before) {
          const still = after.get(id);
          if (still === undefined) {
            rec.check(
              job.turnsLeft === 1,
              where(
                step,
                `unit ${String(id)} lost its job with ${String(job.turnsLeft)} turns still owed`,
              ),
            );
            rec.check(
              hasImprovement(next, job.tile, job.kind),
              where(step, `unit ${String(id)} finished ${String(job.kind)} but the pair is absent`),
            );
            const named = completions.filter((event) => Number(event.unitId) === id);
            rec.check(
              named.length === 1,
              where(
                step,
                `unit ${String(id)} completed but ${String(named.length)} WorkCompleted events name it`,
              ),
            );
            const event = named[0];
            if (event !== undefined) {
              rec.check(
                event.tile === job.tile && event.kind === job.kind,
                where(step, `the WorkCompleted event for unit ${String(id)} names another job`),
              );
            }
          } else {
            rec.check(
              still.turnsLeft === job.turnsLeft - 1 && still.turnsLeft > 0,
              where(
                step,
                `unit ${String(id)} went from ${String(job.turnsLeft)} to ${String(
                  still.turnsLeft,
                )} turns owed; a turn pays exactly one, and a finished job leaves no count behind`,
              ),
            );
            rec.check(
              still.kind === job.kind && still.tile === job.tile,
              where(step, `unit ${String(id)} changed job mid-flight`),
            );
          }
        }

        for (const [id] of after) {
          rec.check(
            before.has(id),
            where(step, `unit ${String(id)} acquired a job during a turn, with no WorkStarted`),
          );
        }

        const finished = [...before.keys()].filter((id) => !after.has(id)).length;
        rec.check(
          completions.length === finished,
          where(
            step,
            `${String(completions.length)} WorkCompleted events for ${String(finished)} finished jobs`,
          ),
        );

        // A completion adds its pair once and a *repeat* adds nothing: two workers
        // may legally dig the same mine on the same tile (the command layer says so
        // deliberately), and idempotence is what keeps that from double-counting.
        const newlyBuilt = new Set<string>();
        for (const event of completions) {
          rec.check(
            hasImprovement(next, event.tile, event.kind),
            where(step, 'a WorkCompleted event names a pair the state does not carry'),
          );
          if (!hasImprovement(state, event.tile, event.kind)) {
            newlyBuilt.add(`${String(event.tile)}/${String(event.kind)}`);
          }
        }
        rec.check(
          next.improvements.length === beforePairs + newlyBuilt.size,
          where(
            step,
            `the pair list grew by ${String(
              next.improvements.length - beforePairs,
            )} for ${String(newlyBuilt.size)} pairs that were not already built`,
          ),
        );
        totals.completions += completions.length;
      }

      if (chosen.cmd.type === 'MoveUnit') {
        const wasWorking = mover?.work;
        if (mover !== undefined && wasWorking !== undefined) {
          totals.movesByWorkingUnits += 1;
          rec.check(
            unitById(next, mover.id)?.work === undefined,
            where(step, 'a relocated unit kept its job'),
          );
          rec.check(
            cancellations.length === 1,
            where(
              step,
              `a move by a working unit emitted ${String(
                cancellations.length,
              )} WorkCancelled events, expected exactly one`,
            ),
          );
          const event = cancellations[0];
          if (event !== undefined) {
            rec.check(
              event.reason === 'moved',
              where(step, `the cancellation reason is ${event.reason}`),
            );
            rec.check(
              event.turnsLeft === wasWorking.turnsLeft &&
                event.kind === wasWorking.kind &&
                event.tile === wasWorking.tile,
              where(step, 'the cancellation event does not describe the job that was lost'),
            );
          }
          rec.check(
            !hasImprovement(next, wasWorking.tile, wasWorking.kind),
            where(step, 'a cancelled job still built its improvement'),
          );
          rec.check(
            next.improvements.length === beforePairs,
            where(step, 'a move built an improvement'),
          );
        } else {
          rec.check(
            cancellations.length === 0,
            where(step, 'an idle unit moving reported a cancellation'),
          );
        }
      }

      if (chosen.cmd.type === 'CancelWork') {
        // The player-issued cancel: the job is gone, nothing was refunded into a
        // pair, and the event says what was owed rather than hiding it.
        const previous = unitById(state, chosen.cmd.unitId)?.work;
        const cancelEvent = cancellations[0];
        totals.cancellations += cancellations.length;
        rec.check(previous !== undefined, where(step, 'CancelWork applied to an idle unit'));
        rec.check(
          unitById(next, chosen.cmd.unitId)?.work === undefined,
          where(step, 'a cancelled unit kept its job'),
        );
        rec.check(
          cancellations.length === 1 && cancelEvent?.reason === 'cancelled',
          where(step, `CancelWork emitted ${String(cancellations.length)} cancellations`),
        );
        if (previous !== undefined && cancelEvent !== undefined) {
          rec.check(
            cancelEvent.turnsLeft === previous.turnsLeft &&
              cancelEvent.kind === previous.kind &&
              cancelEvent.tile === previous.tile,
            where(step, 'the cancellation event does not describe the job that was given up'),
          );
          rec.check(
            !hasImprovement(next, previous.tile, previous.kind),
            where(step, 'a cancelled job still built its improvement'),
          );
        }
        rec.check(
          next.improvements.length === beforePairs,
          where(step, 'cancelling built or destroyed an improvement'),
        );
      }

      if (chosen.cmd.type === 'StartWork') {
        totals.starts += 1;
        rec.check(
          next.improvements.length === beforePairs,
          where(step, 'StartWork built the improvement on the turn it started'),
        );
      }

      if (chosen.cmd.type === 'FoundCity') totals.citiesFounded += 1;

      totals.pairsBuilt = next.improvements.length;
      state = next;
    }

    finals.push(state);
  }

  return { recorder: rec, totals, finals };
};

describe('3. work honesty', () => {
  it('pays exactly one turn of a job per turn, completes it once, and never lets a move complete it', () => {
    const { recorder: rec, totals } = longPlay([3, 5, 8, 13], 120);

    console.log('m4a long play totals:', JSON.stringify(totals));
    expect(rec.problems).toEqual([]);

    // Non-vacuity: the walk must actually have started, completed and cancelled
    // work — by a command and by walking away — or it is evidence of nothing.
    expect(totals.starts).toBeGreaterThan(0);
    expect(totals.completions).toBeGreaterThan(0);
    expect(totals.cancellations).toBeGreaterThan(0);
    expect(totals.movesByWorkingUnits).toBeGreaterThan(0);
    expect(totals.pairsBuilt).toBeGreaterThan(0);
  });

  it('cancels on movement and never completes the abandoned job', () => {
    // A hill, a worker standing on it, and a mine — the shipped catalog's longest
    // job, so there is time to walk away with turns still owed.
    const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER.id, [6, 5])
      .addUnit(1, WORKER.id, [30, 30])
      .addCity(0, [5, 5], { population: 1, workedTiles: [HILL] })
      .build();
    if (!built.ok) {
      throw new Error(`the cancellation fixture must build: ${JSON.stringify(built.error)}`);
    }

    const mineDef = mustImprovement(MINE);
    const started = applyCommand(
      built.value,
      asPlayerId(0),
      { type: 'StartWork', unitId: asUnitId(0), kind: MINE },
      RULESET,
    );
    if (!started.ok) throw new Error(`StartWork must apply: ${errorText(started.error)}`);
    expect(workOf(started.value.state, asUnitId(0))?.turnsLeft).toBe(mineDef.turns);

    // One turn paid, so the job has something left to lose.
    const paid = applyCommand(started.value.state, asPlayerId(0), { type: 'EndTurn' }, RULESET);
    if (!paid.ok) throw new Error('EndTurn must apply');
    expect(workOf(paid.value.state, asUnitId(0))?.turnsLeft).toBe(mineDef.turns - 1);

    // Walk somewhere, which cancels by construction.
    const move = unitActions(paid.value.state, RULESET, asUnitId(0)).find(
      (cmd) => cmd.type === 'MoveUnit',
    );
    if (move === undefined) throw new Error('the worker must have somewhere to step');
    const moved = applyCommand(paid.value.state, asPlayerId(0), move, RULESET);
    if (!moved.ok) throw new Error(`the step must apply: ${errorText(moved.error)}`);

    expect(workOf(moved.value.state, asUnitId(0))).toBeUndefined();
    expect(moved.value.state.improvements).toEqual([]);
    expect(cancelEventsOf(moved.value.events)).toEqual([
      {
        type: 'WorkCancelled',
        unitId: asUnitId(0),
        kind: MINE,
        tile: HILL,
        turnsLeft: mineDef.turns - 1,
        reason: 'moved',
      },
    ]);

    // Pay far more turns than the job ever owed: a cancelled job never completes,
    // and the pair never appears.
    let state = moved.value.state;
    for (let turn = 0; turn < mineDef.turns + 3; turn += 1) {
      const step = applyCommand(state, asPlayerId(0), { type: 'EndTurn' }, RULESET);
      if (!step.ok) throw new Error('EndTurn must apply');
      expect(workEventsOf(step.value.events)).toEqual([]);
      state = step.value.state;
    }

    expect(state.improvements).toEqual([]);
    expect(hasImprovement(state, HILL, MINE)).toBe(false);
    expect(isHashable(state)).toBe(true);
  });

  it('leaves no phantom job behind when a working unit is removed from the state', () => {
    const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER.id, [6, 5])
      .addUnit(1, WORKER.id, [30, 30])
      .addCity(0, [5, 5], { population: 1, workedTiles: [HILL] })
      .build();
    if (!built.ok) throw new Error('the phantom-work fixture must build');

    const started = applyCommand(
      built.value,
      asPlayerId(0),
      { type: 'StartWork', unitId: asUnitId(0), kind: MINE },
      RULESET,
    );
    if (!started.ok) throw new Error('StartWork must apply');

    // The job's last turn, hand-set: the control proves the job *would* complete on
    // this turn, so the removal below is the only difference between the two runs.
    const due: GameState = {
      ...started.value.state,
      units: started.value.state.units.map((unit) =>
        unit.id === asUnitId(0)
          ? { ...unit, work: { kind: MINE, tile: HILL, turnsLeft: 1 } }
          : unit,
      ),
    };
    const control = advanceTurn(due, RULESET);
    expect(control.state.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(workEventsOf(control.events)).toHaveLength(1);

    // Now the unit is gone — a hand-built removal, because M4a has no combat and no
    // other engine path deletes a unit (FoundCity consumes a *settler*, and a
    // settler can never hold a job: `StartWork` refuses anything that is not a
    // worker). The work lived on the unit, so the job is gone with it.
    const removed: GameState = {
      ...due,
      units: due.units.filter((unit) => unit.id !== asUnitId(0)),
    };
    expect(workMap(removed).size).toBe(0);

    const outcome = advanceTurn(removed, RULESET);
    expect(workEventsOf(outcome.events)).toEqual([]);
    expect(outcome.state.improvements).toEqual([]);
    expect(isHashable(outcome.state)).toBe(true);

    // And it stays absent however many turns pass: a phantom job cannot surface
    // later, because nothing in the pipeline carries a job off a unit.
    let state = outcome.state;
    for (let turn = 0; turn < 4; turn += 1) {
      const next = advanceTurn(state, RULESET);
      expect(workEventsOf(next.events)).toEqual([]);
      expect(next.state.improvements).toEqual([]);
      state = next.state;
    }
  });

  it('counts one pair once when two workers finish the same job on one tile in one turn', () => {
    const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER.id, [6, 5])
      .addUnit(0, WORKER.id, [6, 5])
      .addUnit(1, WORKER.id, [30, 30])
      .addCity(0, [5, 5], { population: 1, workedTiles: [HILL] })
      .build();
    if (!built.ok)
      throw new Error(`the double-work fixture must build: ${JSON.stringify(built.error)}`);

    const mineDef = mustImprovement(MINE);
    const first = applyCommand(
      built.value,
      asPlayerId(0),
      { type: 'StartWork', unitId: asUnitId(0), kind: MINE },
      RULESET,
    );
    if (!first.ok) throw new Error(`StartWork must apply: ${errorText(first.error)}`);

    // The command layer *allows* a second worker to dig the same mine: the rules
    // are a list, and "another worker is already doing it" is deliberately not on
    // it (the doc note in `planStartWork` says so). Pinned here so the decision is
    // visible rather than discovered, and so the idempotence below has a reason.
    const second = planStartWork(first.value.state, RULESET, asPlayerId(0), asUnitId(1), MINE);
    expect(second.ok).toBe(true);

    // Both jobs on their last turn: both complete in the same turn.
    const due: GameState = {
      ...first.value.state,
      units: first.value.state.units.map((unit) =>
        Number(unit.owner) === 0
          ? { ...unit, work: { kind: MINE, tile: HILL, turnsLeft: 1 } }
          : unit,
      ),
    };
    const outcome = advanceTurn(due, RULESET);

    expect(workEventsOf(outcome.events)).toEqual([
      { type: 'WorkCompleted', unitId: asUnitId(0), kind: MINE, tile: HILL },
      { type: 'WorkCompleted', unitId: asUnitId(1), kind: MINE, tile: HILL },
    ]);
    // Two completions, one pair — never two entries, and therefore never a second
    // delta in the yields below.
    expect(outcome.state.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(improvementsAt(outcome.state, HILL)).toHaveLength(1);

    const worked = cityYields(outcome.state, RULESET, cityOf(outcome.state).id);
    const bare = cityYields(
      { ...outcome.state, improvements: [] },
      RULESET,
      cityOf(outcome.state).id,
    );
    expect(worked.shields - bare.shields).toBe(mineDef.yields.shields);
    expect(isHashable(outcome.state)).toBe(true);
  });

  it('treats a job as a property of the unit: an unresolvable type still works, cancels and completes', () => {
    // M2's hazard, extended by M4a: a unit whose *type* the ruleset cannot resolve
    // must not make the generators and the applier disagree, and must not freeze
    // the job it is holding. The job is state — a tile and a count — so the
    // pipeline completes it without consulting the catalog at all.
    const state = m4aState();
    const ghost: Unit = {
      id: asUnitId(99),
      type: asUnitTypeId('ghost-worker'),
      owner: asPlayerId(0),
      tile: HILL,
      movementLeft: 0,
      work: { kind: MINE, tile: HILL, turnsLeft: 1 },
    };
    const board: GameState = { ...state, units: [...state.units, ghost], nextUnitId: 100 };

    // The generator's whole offer set for that unit: exactly the cancel — no
    // StartWork while a job is held, and no step with no movement left.
    expect([...unitActions(board, RULESET, ghost.id)].map((cmd) => cmd.type)).toEqual([
      'CancelWork',
    ]);
    expect(
      [...legalActions(board, RULESET, asPlayerId(0))].some(
        (cmd) => cmd.type === 'CancelWork' && Number(cmd.unitId) === 99,
      ),
    ).toBe(true);

    const cancel = applyCommand(
      board,
      asPlayerId(0),
      { type: 'CancelWork', unitId: ghost.id },
      RULESET,
    );
    expect(cancel.ok).toBe(true);
    if (cancel.ok) {
      expect(unitById(cancel.value.state, ghost.id)?.work).toBeUndefined();
      expect(cancelEventsOf(cancel.value.events)).toEqual([
        {
          type: 'WorkCancelled',
          unitId: ghost.id,
          kind: MINE,
          tile: HILL,
          turnsLeft: 1,
          reason: 'cancelled',
        },
      ]);
    }

    const outcome = advanceTurn(board, RULESET);
    expect(workEventsOf(outcome.events)).toEqual([
      { type: 'WorkCompleted', unitId: ghost.id, kind: MINE, tile: HILL },
    ]);
    expect(outcome.state.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(isHashable(outcome.state)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Ordering: turn N's yields already include an improvement built on turn N
 * ------------------------------------------------------------------ */

describe('4. ordering is observable and pinned', () => {
  /**
   * Twin boards differing in one number: how many turns the mine still owes. Twin
   * A finishes this turn, twin B does not.
   *
   * The two tests below pin the *two* edges of the contract's order separately,
   * because a single one would not be enough. Mutation probes run while writing this
   * file: moving the work step after growth (growth → work → production, which
   * keeps work ahead of production) leaves the shields assertion green and is
   * caught only by the food assertion — so the food test is not decoration, it is
   * the half that pins "work before growth".
   */
  const twin = (turnsLeft: number): GameState => {
    const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
      .addPlayer('Rome')
      .addPlayer('Carthage')
      .fillTerrain('grassland')
      .setTile(6, 5, 'hills')
      .addUnit(0, WORKER.id, [6, 5])
      .addUnit(1, WORKER.id, [30, 30])
      .addCity(0, [5, 5], { population: 1, workedTiles: [HILL] })
      .build();
    if (!built.ok)
      throw new Error(`the ordering fixture must build: ${JSON.stringify(built.error)}`);

    return {
      ...built.value,
      units: built.value.units.map((unit) =>
        unit.id === asUnitId(0) ? { ...unit, work: { kind: MINE, tile: HILL, turnsLeft } } : unit,
      ),
    };
  };

  const shieldsOf = (state: GameState): number => {
    const city = state.cities[0];
    if (city === undefined) throw new Error('the ordering fixture must keep its city');
    return city.shields;
  };

  it('pays a mine finished this turn into this turn’s shields, not next turn’s', () => {
    // This is the "work before *production*" edge: twin A finishes its mine this
    // turn and twin B does not, so a pipeline that ran production first would bank
    // the same shields for both and the mine would pay a turn late.
    const mineDef = mustImprovement(MINE);
    expect(mineDef.yields.shields).toBeGreaterThan(0); // the observable below exists

    const completing = twin(1);
    const pending = twin(2);
    expect(completing.improvements).toEqual([]);
    expect(pending.improvements).toEqual([]);
    expect(shieldsOf(completing)).toBe(shieldsOf(pending));

    const endTurn: Command = { type: 'EndTurn' };
    const a = applyCommand(completing, asPlayerId(0), endTurn, RULESET);
    const b = applyCommand(pending, asPlayerId(0), endTurn, RULESET);
    if (!a.ok || !b.ok) throw new Error('EndTurn must apply to both twins');

    // The completion and the extra shield are in the *same* command outcome: the
    // turn the mine is built is the turn its shield is counted.
    expect(workEventsOf(a.value.events)).toHaveLength(1);
    expect(workEventsOf(b.value.events)).toEqual([]);
    expect(a.value.state.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(b.value.state.improvements).toEqual([]);
    expect(shieldsOf(a.value.state) - shieldsOf(b.value.state)).toBe(mineDef.yields.shields);

    // Second turn: the mine now pays on both boards, so the gap is unchanged. A
    // pipeline that had paid the mine a turn late would instead have closed it here.
    const a2 = applyCommand(a.value.state, asPlayerId(0), endTurn, RULESET);
    const b2 = applyCommand(b.value.state, asPlayerId(0), endTurn, RULESET);
    if (!a2.ok || !b2.ok) throw new Error('EndTurn must apply to both twins again');
    expect(workEventsOf(b2.value.events)).toHaveLength(1);
    expect(a2.value.state.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(b2.value.state.improvements).toEqual([{ tile: HILL, kind: MINE }]);
    expect(shieldsOf(a2.value.state) - shieldsOf(b2.value.state)).toBe(mineDef.yields.shields);

    // And the mine is worth exactly its catalog row, not some derived number.
    expect(shieldsOf(b2.value.state) - shieldsOf(a.value.state)).toBeGreaterThan(0);
  });

  it('pays an irrigation finished this turn into this turn’s food, before growth reads it', () => {
    // The "work before *growth*" edge, and the one a mutation probe proved is not
    // redundant with the shields test above: reordering the pipeline to growth →
    // work → production leaves the shields twins equal and only this one fails. Food
    // an irrigation adds this turn is in the foodBox growth reads *this* turn.
    const twinFood = (turnsLeft: number): GameState => {
      const built = createScenarioBuilder(RULESET, { mapSize: 'duel', civCount: 2 })
        .addPlayer('Rome')
        .addPlayer('Carthage')
        .fillTerrain('grassland')
        .addUnit(0, WORKER.id, [7, 5])
        .addUnit(1, WORKER.id, [30, 30])
        .addCity(0, [5, 5], { population: 1, foodBox: 0, workedTiles: [FLAT] })
        .build();
      if (!built.ok) throw new Error(`the food fixture must build: ${JSON.stringify(built.error)}`);

      return {
        ...built.value,
        units: built.value.units.map((unit) =>
          unit.id === asUnitId(0)
            ? { ...unit, work: { kind: IRRIGATION, tile: FLAT, turnsLeft } }
            : unit,
        ),
      };
    };

    const irrigation = mustImprovement(IRRIGATION);
    expect(irrigation.yields.food).toBeGreaterThan(0); // the observable below exists

    const foodOf = (state: GameState): { foodBox: number; surplus: number } => {
      const city = cityOf(state);
      return { foodBox: city.foodBox, surplus: cityYields(state, RULESET, city.id).foodSurplus };
    };

    const endTurn: Command = { type: 'EndTurn' };
    const a = applyCommand(twinFood(1), asPlayerId(0), endTurn, RULESET);
    const b = applyCommand(twinFood(2), asPlayerId(0), endTurn, RULESET);
    if (!a.ok || !b.ok) throw new Error('EndTurn must apply to both twins');

    expect(workEventsOf(a.value.events)).toHaveLength(1);
    expect(workEventsOf(b.value.events)).toEqual([]);
    const afterA = foodOf(a.value.state);
    const afterB = foodOf(b.value.state);
    expect(afterA.foodBox - afterB.foodBox).toBe(irrigation.yields.food);
    expect(afterA.surplus - afterB.surplus).toBe(irrigation.yields.food);

    // One turn later both boards carry the irrigation, so the gap is the same —
    // the irrigation paid on the turn it finished and on every turn after.
    const a2 = applyCommand(a.value.state, asPlayerId(0), endTurn, RULESET);
    const b2 = applyCommand(b.value.state, asPlayerId(0), endTurn, RULESET);
    if (!a2.ok || !b2.ok) throw new Error('EndTurn must apply to both twins again');
    expect(a2.value.state.improvements).toEqual([{ tile: FLAT, kind: IRRIGATION }]);
    expect(b2.value.state.improvements).toEqual([{ tile: FLAT, kind: IRRIGATION }]);
    expect(foodOf(a2.value.state).foodBox - foodOf(b2.value.state).foodBox).toBe(
      irrigation.yields.food,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 5. Determinism: in-process and in a fresh process
 * ------------------------------------------------------------------ */

interface RecordedSpawn {
  readonly owner: PlayerId;
  readonly type: UnitTypeId;
  readonly tile: TileIndex;
}

interface RecordedCommand {
  readonly player: PlayerId;
  readonly cmd: Command;
}

/**
 * A worker game as *data*: the seed, the units to place, and every command in
 * order. Passing this to a child process rather than duplicating the play loop
 * inside a string is what makes "the same commands" literal — the two processes
 * cannot drift apart, because there is only one script.
 */
interface Recording {
  readonly seed: number;
  readonly mapSize: MapSize;
  readonly civCount: number;
  readonly spawns: readonly RecordedSpawn[];
  readonly commands: readonly RecordedCommand[];
}

const recordWorkGame = (seed: number, steps: number): Recording => {
  const base = startedState(seed);
  const spawns: RecordedSpawn[] = [];
  let state = base;
  for (const player of base.players) {
    if (player.kind !== 'civ') continue;
    for (let n = 0; n < 2; n += 1) {
      spawns.push({ owner: player.id, type: WORKER.id, tile: player.startingTile });
      state = spawnUnit(state, WORKER, player.id, player.startingTile).state;
    }
  }

  const prng = makePrng(seed);
  const commands: RecordedCommand[] = [];
  for (let step = 0; step < steps; step += 1) {
    const chosen = chooseCommand(state, offersFor(state), step, prng);
    if (chosen === undefined) break;
    const outcome = applyCommand(state, chosen.player, chosen.cmd, RULESET);
    if (!outcome.ok) {
      throw new Error(`recording seed ${String(seed)}: ${cmdKey(chosen.cmd)} was refused`);
    }
    commands.push({ player: chosen.player, cmd: chosen.cmd });
    state = outcome.value.state;
  }

  return { seed, mapSize: 'duel', civCount: DUEL.civCount, spawns, commands };
};

interface ReplayResult {
  readonly hash: string;
  readonly completions: number;
  readonly starts: number;
  readonly pairs: number;
  readonly events: readonly GameEvent[];
}

const replay = (recording: Recording): ReplayResult => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    mapSize: recording.mapSize,
    civCount: recording.civCount,
    seed: recording.seed,
  };
  const started = newGame(recording.seed, settings, RULESET);
  if (!started.ok) throw new Error(`replay: newGame failed: ${JSON.stringify(started.error)}`);

  let state = started.value;
  for (const spawn of recording.spawns) {
    state = spawnUnit(state, WORKER, spawn.owner, spawn.tile).state;
  }

  const events: GameEvent[] = [];
  for (const entry of recording.commands) {
    const outcome = applyCommand(state, entry.player, entry.cmd, RULESET);
    if (!outcome.ok) {
      throw new Error(`replay: ${cmdKey(entry.cmd)} was refused: ${errorText(outcome.error)}`);
    }
    events.push(...outcome.value.events);
    state = outcome.value.state;
  }

  return {
    hash: hashValue(state),
    completions: workEventsOf(events).length,
    starts: events.filter((event) => event.type === 'WorkStarted').length,
    pairs: state.improvements.length,
    events,
  };
};

/** The one line the contract under test is: `hash completions starts pairs`. */
const replayLine = (result: ReplayResult): string =>
  `${result.hash} ${String(result.completions)} ${String(result.starts)} ${String(result.pairs)}`;

/** `tsx` is a devDependency; a missing install is a broken checkout, so say so. */
const tsxCliPath = (): string => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch (cause) {
    throw new Error(
      'the fresh-process check needs the `tsx` devDependency (resolved as "tsx/cli"): ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
};

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The child program: a *generic* replayer for whatever recording it is handed. It
 * contains no policy and no expectations, so a difference between it and the
 * in-process replay can only come from the engine.
 */
const childScript = (recording: Recording): string => `
import { DEFAULT_SETTINGS, applyCommand, newGame, spawnUnit } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { hashValue } from '@civts/testing';

const recording = JSON.parse(${JSON.stringify(JSON.stringify(recording))});
const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const ruleset = validated.value;

const settings = { ...DEFAULT_SETTINGS, mapSize: recording.mapSize, civCount: recording.civCount, seed: recording.seed };
const started = newGame(recording.seed, settings, ruleset);
if (!started.ok) throw new Error('newGame failed: ' + JSON.stringify(started.error));
let state = started.value;

for (const spawn of recording.spawns) {
  const def = ruleset.units.find((unit) => unit.id === spawn.type);
  if (def === undefined) throw new Error('the ruleset defines no unit type ' + spawn.type);
  state = spawnUnit(state, def, spawn.owner, spawn.tile).state;
}

let completions = 0;
let starts = 0;
for (const entry of recording.commands) {
  const outcome = applyCommand(state, entry.player, entry.cmd, ruleset);
  if (!outcome.ok) {
    throw new Error('recorded command refused: ' + JSON.stringify(entry.cmd) + ' -> ' + JSON.stringify(outcome.error));
  }
  for (const event of outcome.value.events) {
    if (event.type === 'WorkCompleted') completions += 1;
    if (event.type === 'WorkStarted') starts += 1;
  }
  state = outcome.value.state;
}

console.log('RESULT ' + hashValue(state) + ' ' + String(completions) + ' ' + String(starts) + ' ' + String(state.improvements.length));
`;

describe('5. determinism, in-process and in a fresh process', () => {
  it('replays a worker game to the same hash and the same event log in-process', () => {
    const recording = recordWorkGame(7, 40);
    const first = replay(recording);
    const second = replay(recording);

    expect(second.hash).toBe(first.hash);
    expect(second.events).toEqual(first.events);

    // Non-vacuity: the game really did start and finish work, and build something.
    expect(first.completions).toBeGreaterThan(0);
    expect(first.starts).toBeGreaterThan(0);
    expect(first.pairs).toBeGreaterThan(0);
    console.log(
      `m4a recording: ${String(recording.commands.length)} commands, ${String(
        first.completions,
      )} completions, ${String(first.pairs)} pairs, hash ${first.hash}`,
    );
  });

  it('reproduces the same hash, completions and pair list in a fresh process', () => {
    const recording = recordWorkGame(21, 40);
    const expected = replay(recording);

    const result = spawnSync(process.execPath, [tsxCliPath(), '-e', childScript(recording)], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const stderr = `${result.stderr}${
      result.error === undefined ? '' : `launch failed: ${result.error.message}`
    }`;
    expect(result.status, `the fresh process failed:\n${stderr}`).toBe(0);

    const lines = result.stdout
      .split('\n')
      .filter((candidate) => candidate.startsWith('RESULT '))
      .map((candidate) => candidate.slice('RESULT '.length).trim());

    expect(lines).toHaveLength(1);
    const observed = lines[0] ?? '';
    console.log(`fresh process: ${observed} | in-process: ${replayLine(expected)}`);

    // The whole line, not just the hash: a hash collision could hide a different
    // event log, and the pair list is the part M4a added.
    expect(observed).toBe(replayLine(expected));
    expect(expected.completions).toBeGreaterThan(0);
    expect(expected.pairs).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Are the goldens still a real gate?
 * ------------------------------------------------------------------ */

describe('6. goldens: what they cover, and what they do not', () => {
  it('stores the post-M4a hashes, and the new field is inside the hashed input', () => {
    const stored = loadGoldens();
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    const computed = [1, 42, 1337].map((seed) => hashValue(goldenState(seed)));
    console.log('m4a golden hashes:', computed.join(' '));

    expect(stored.entries.map((entry) => entry.hash)).toEqual(computed);
    expect(stored.entries.map((entry) => entry.name)).toEqual([
      'tiny-civs2-seed1',
      'tiny-civs2-seed42',
      'tiny-civs2-seed1337',
    ]);

    const state = goldenState(42);
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.improvements).toEqual([]);

    // The new key is inside the hashed input — `canonicalize` is what `hashValue`
    // feeds — so a shape change still trips the gate.
    const canonical = canonicalize(state);
    expect(canonical).toContain('"improvements":[]');
    expect(canonicalize(withImprovement(state, HILL, MINE))).toContain(
      canonicalize({ tile: HILL, kind: MINE }),
    );

    // And the unhashable spelling the project has been bitten by three times is
    // still refused: a key holding `undefined` cannot survive a JSON round trip, so
    // it must throw rather than hash to something ephemeral.
    expect(() => hashValue({ ...state, improvements: undefined })).toThrow();
    const firstUnit = state.units[0];
    if (firstUnit === undefined) throw new Error('the golden state must hold a unit');
    expect(() => hashValue({ ...state, units: [{ ...firstUnit, work: undefined }] })).toThrow();
  });

  it('covers the shape but not the behaviour of work — the gap, stated rather than assumed', () => {
    // The golden scenarios hash `newGame` states: they pin the *shape* (`the
    // `improvements` key, `SCHEMA_VERSION`) and nothing about jobs. This documents
    // that boundary where a reader will see it, so "the goldens are green" is never
    // mistaken for "work works". If a golden scenario ever gains a *built*
    // improvement or a unit holding a job, this fails and a human learns the
    // coverage changed — which is exactly when a rehash note is owed anyway.
    //
    // MIGRATED (M4b): the boundary is narrower than it was, and it is written out at
    // its new width instead of being deleted. M4b's starting units give every
    // civilization a worker, so a golden state *does* now contain workers — that
    // half of the old gap is closed, and closed by a `newGame` behaviour the goldens
    // therefore cover — while the half that remains open is the behaviour: no unit
    // carries a `work` job and no tile carries an improvement in any golden state.
    for (const seed of [1, 42, 1337]) {
      const state = goldenState(seed);
      expect(state.improvements).toEqual([]);
      expect(state.units.length).toBeGreaterThan(0);

      const workers = state.units.filter(
        (unit) => RULESET.units.find((def) => def.id === unit.type)?.role === 'worker',
      );
      // One starting worker per civilization, and no more: the count is pinned so
      // that "the goldens contain workers" cannot quietly become "the goldens
      // contain whatever the fixture happened to build".
      expect(workers).toHaveLength(state.players.filter((player) => player.kind === 'civ').length);
      expect(workers.every((unit) => unit.work === undefined)).toBe(true);
      // …and no unit at all — worker, settler or otherwise — holds a job.
      expect(state.units.filter((unit) => unit.work !== undefined)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * What is permanent, and what is only here
 * ------------------------------------------------------------------ *
 *
 * The question a review owes an answer to is whether the sweep above left anything
 * behind. Written out so that nobody has to guess, and so a gap is visible rather
 * than implied by a green run:
 *
 * **Checked permanently (so this file is not the only thing standing between a
 * regression and a green gate):**
 *
 * - The five-generator keystone on hand-built boards, with exact counts, and the
 *   planner-versus-applier equality for both work commands on every board and kind:
 *   `packages/core/test/actions.test.ts` and `packages/core/test/commands.test.ts`.
 * - Pair-list honesty — idempotence, purity, canonical `(tile, kind)` order, a
 *   delta counted once, an unworked tile paying nothing, the centre untouched, an
 *   absent `improvements` key read as empty: `packages/core/test/improvements.test.ts`.
 * - The turn pipeline's order, its leftovers and its event order; completion
 *   totals; a job whose count is not a positive whole number:
 *   `packages/core/test/commands.test.ts`. (Its order test catches a growth-first
 *   pipeline through the *event* order; what it does not do is show growth reading
 *   an improvement's food, which is why the food twin below exists.)
 * - The M4a acceptance scenarios — mine yield turn by turn, cancellation by
 *   movement, illegal work refused, work timing, the builder's improvement
 *   placement, and the "these assertions discriminate" controls:
 *   `packages/testing/test/scenarios.test.ts`.
 * - The keystone over *played* games for `MoveUnit` and `FoundCity`, determinism
 *   across processes, and the golden gate's refusal to auto-write:
 *   `packages/testing/test/{m2,m3}-adversarial.test.ts`.
 * - The state hashes themselves: `packages/testing/test/golden.test.ts` with
 *   `packages/testing/goldens/state.json` — which pin the *shape*
 *   (`improvements`, `SCHEMA_VERSION`) and, by construction, nothing about *jobs*,
 *   because every golden scenario is a `newGame` state. M4b narrows the gap this
 *   note used to describe: those states now contain a starting worker per
 *   civilization (`STARTING_UNIT_ROLES`), so `newGame`'s worker placement is
 *   covered by the goldens, while no unit holds a `work` job and no tile carries an
 *   improvement in any of them.
 *
 * **Checked only here (a one-off check that leaves no test behind would not be
 * verification, so each of these is a test in this file):**
 *
 * 1. completeness of `StartWork`/`CancelWork` over played games — the M2 and M3
 *    keystone sweeps enumerate `MoveUnit` and `FoundCity` only, and use the work
 *    commands for soundness alone;
 * 2. the boundary boards where work may *not* start (ocean, undescribed terrain,
 *    off the map, a pair already built), two-directionally;
 * 3. insertion-order invariance of the pair list's hash, over seeded shuffles;
 * 4. the exact per-city yield delta against an independent count of the worked
 *    tiles, over long random play;
 * 5. two workers finishing the same pair in one turn: two events, one pair, one
 *    delta;
 * 6. `turnsLeft` falling by exactly one a turn across a long walk (never skipping,
 *    never stalling), no phantom job after a working unit leaves the state, and a
 *    worker whose type the ruleset cannot resolve still agreeing with the
 *    generators and still completing;
 * 7. the food side of the ordering — growth reading an improvement finished the
 *    same turn;
 * 8. the fresh-process determinism line for a worker game (hash, completions,
 *    starts and pair count together, not the hash alone);
 * 9. the statement of what the goldens do *not* cover, asserted rather than
 *    assumed, so "the goldens are green" is not read as "M4a works".
 */
