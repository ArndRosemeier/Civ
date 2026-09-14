/**
 * `runSimulation` — the simulation loop.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (point 1,
 * "Runnable without a UI, at scale, deterministically") and its "`@civts/sim`
 * contract" (`SimulationOptions` / `SimulationResult`).
 *
 * ## What a run is
 *
 * A game is a pure function of `(seed, settings, ruleset, policies)`. This module
 * is that function written out: `newGame` builds the world, then for up to
 * `maxTurns` turns each **civilization** is polled in **player-id order**, every
 * command it returns is applied through `applyCommand` (never by mutating state),
 * the world advances with `advanceTurn`, and **every invariant runs on every
 * turn** — checked in flight rather than only at the end, which is what makes a
 * violation be caught where it happened. "Every turn" includes the turn that ends the
 * game: the registry runs **before** the game-over break, so a decided run is checked the
 * same number of times as a turn-limited one, and `invariantChecks` counts what ran
 * (F2 — the rule site states the choice and why a violation outranks an ending).
 *
 * ## The five decisions this file had to make, and why
 *
 * 1. **A violation is recorded, never swallowed, and stops the run.** Every
 *    violation the registry returns on the violating turn is appended to the
 *    result and the loop breaks, so `finalState` *is* the state that broke and can
 *    be inspected (hashed, diffed, replayed). Nothing is filtered, deduplicated or
 *    summarised: an invariant's own message is the evidence.
 * 2. **Only a violation truncates a run.** The run otherwise plays exactly
 *    `maxTurns` turns. `stoppedBecause: 'no-commands'` is therefore a *report*, not
 *    an early exit: it says no command was ever applied — every policy was silent,
 *    or everything it proposed was refused — so the turns that were played contain
 *    no decisions at all. Stopping early on a quiet turn was rejected: a turn in
 *    which nobody has anything to do is a normal turn (a city between builds, an
 *    army out of movement), and truncating there would make the length of a batch's
 *    runs depend on a policy's tempo rather than on `maxTurns`.
 * 3. **The turn boundary belongs to the runner, not to a policy.** A command of
 *    type `EndTurn` returned by a policy is dropped, with this reason: the runner
 *    advances the world itself immediately after the poll, so applying a policy's
 *    `EndTurn` as well would play two turns for one iteration — and every metric
 *    row and violation is numbered by the turn, so "one iteration, one turn" is
 *    structural rather than cosmetic. The shipped policies never return one.
 * 4. **A refused command is not applied and is not recorded.** `applyCommand` is
 *    pure and total-or-typed: a refusal returns the input state, so nothing moves,
 *    no revision is bumped and no event appears. The frozen `SimulationResult` has
 *    no field for refusals and `Violation` is defined as *an invariant's* message,
 *    so inventing either would be a contract change rather than an improvement —
 *    what the runner guarantees instead is that a refusal cannot change the
 *    *state*, and `policies.test.ts` asserts the shipped policies propose nothing
 *    the applier refuses. It also counts: a run in which every proposal was refused
 *    reports `'no-commands'`.
 * 5. **Simultaneous turns, sequential within a turn.** Every civilization plays the
 *    *same* world turn, and each is polled against the state as it stands when its
 *    turn to act comes — so player 1 sees player 0's commands of that turn. The
 *    alternative (polling everyone against one snapshot) would need a merge rule
 *    the engine does not have: there is no "apply a list of commands atomically"
 *    in the contract, and inventing one here would be a second applier.
 * 6. **A planner failure is carried in the result, and does not truncate the run.**
 *    M7d (docs/INTERFACES.md, "a failure the result itself can carry"): a policy is
 *    required to be **total**, so a turn in which the planner threw is a turn the AI did
 *    not play — and the commands it returned before the throw look exactly like a turn in
 *    which it had nothing to say (same legal command list, same metrics, same invariants,
 *    same plausible hash). The record therefore travels **in the result**, as
 *    `SimulationResult.plannerFailures`, and the runner is the only thing in a position
 *    to read it out of the policy that owns it — the policy's throw that happened **during
 *    this run**, named by this run's own turn, pass, player and detail rather than by a
 *    record an earlier run left on a reused instance. See "Carrying a planner failure"
 *    below for how it is read and why it is not a second `violations` list.
 *
 * ## Carrying a planner failure
 *
 * It is **not** a second `violations` list, and the two differ in the one way that matters
 * here: a violation **stops** the run (the state that broke has to be inspected where it
 * happened, and every later number would be a number about a broken world), while a partial
 * turn leaves a perfectly valid game — the commands that *were* decided applied, the world
 * advanced, the metrics are the metrics of the turn that was played. Truncating on a planner
 * failure would also put the batch's horizon rule back on the floor: runs of one batch would
 * end on different turns and every aggregate folded over them would be a mean over games of
 * different lengths, which is the M4b/M5 rule this package already paid for once. What a
 * planner failure changes is the **verdict**, not the length: see `tournamentVerdict` in
 * `tournament.ts`, where a tournament containing one fails.
 *
 * The record lives on the policy (`PolicyReport`, `ai/smart.ts`), because a policy that
 * catches its own throw is the only thing that can report one, and `plannerReportOf(policy)`
 * is the seam. Three details of that seam are load bearing and are stated here rather than
 * discovered later:
 *
 * - it answers `undefined` for a policy that cannot report (the control policies), so calling it
 *   costs no knowledge of the AI;
 * - `failures` keeps the **first** failure of each pass — the instance's whole memory, so "which
 *   passes have ever failed" is bounded by the five passes rather than by a cap somebody chose;
 * - `latestFailures` keeps the **most recent** failure of each pass, as a fresh object per throw —
 *   and that list, never `failures`, is where a run's own throw is named (see below);
 * - a report is *cumulative for the policy instance*, and `SMART_POLICY` is a module-level
 *   singleton;
 * - and `failureCount` counts **every** throw, including the hundreds that the first-per-pass
 *   list collapsed into one record. It is the only monotone thing a policy hands out.
 *
 * So the runner reads the count for every policy it is handed, before the first turn, and
 * collects the failures that appeared *after* that reading. **The count is the baseline, and the
 * first-per-pass list is not**, because that list alone cannot see a re-throw: a policy whose first
 * failure in a pass was recorded by an earlier run keeps that pass's record — one record, not one
 * per throw — so a second run that throws on every single turn reports an unchanged list, and
 * baselining on the list's contents therefore reported it as a clean run. That is a path where a
 * thrown planner LOOKS CLEAN, which is the exact silent-pass shape M7d exists to close, so the count
 * leads: `failureCount` grows on every throw, so a re-throw in a later run stays visible, while a
 * wholly pre-existing failure moves the count not at all and is still not re-attributed to a run
 * that did not produce it.
 *
 * ## What the count decides, and what the record still says
 *
 * The count answers *whether* something happened during this run; the record answers *what* — and
 * the record is `latestFailures`, **never** `failures`. Both are needed, neither is redundant, and
 * since H1/G2-1 they come from two different lists, which is the whole of that finding.
 *
 * M7e closed the *silence* by baselining on the count and then appending "the policy's own current
 * record for the pass that failed" — read as `failures[length - 1]`, the **last entry of a list
 * whose shape never changes for the life of the instance**. On a **reused** instance — and
 * `SMART_POLICY` is a singleton, while `batch`, `tournament` and the CLI each hand *one* instance to
 * every seat of every run, which is the supported and shipped usage — that entry is a record an
 * **earlier run** produced. So the count was honest about *whether* (a throw did happen here, and
 * the run exited 1) while the record told a story about a game that had already finished: a board
 * unreadable from turn 4 of run A, then run B whose planner threw only on turns 6, 7 and 8, reported
 * `turn 4 … cities pass (city 0)` — a turn B never failed on, printed seed-qualified as
 * `seed 2, turn 4 — smart, player 0, cities pass (city 0)`. A run's failure has to name a throw that
 * happened **in that run**, and the frozen M7d contract says a failure "says which game, turn and
 * phase failed".
 *
 * The fix is the seam's other list. `PolicyReport.latestFailures` is refilled by **every** throw with
 * the newest record of the pass it threw in, so the count can say *whether* a throw happened here
 * while that list says *what it was* — the policy's own turn, pass, player and detail, written while
 * it planned **this** run's turn. Three properties follow, and they are the three the seam promises:
 *
 * - a failure is attributed to the policy whose count moved, and to the run in which it moved: the
 *   entry appended is read from the latest-per-pass list *after* the count moved, so its `turn`,
 *   `phase`, `playerId` and `detail` were written while this run was planning — for the reused
 *   instance above, run B reports turn 6 — the first throw it actually made — and never run A's
 *   turn 4. It is the first record this run saw for that (seat, pass), not the last one: the first
 *   is the throw the run started failing at, and it is the one that explains the entry;
 * - a re-throw is visible in every run that re-threw, so no run is silent about its own throw — the
 *   count still leads for exactly that, and the record list agrees, because a throw replaces its
 *   pass's entry even when the first-per-pass list `failures` cannot move;
 * - a failure recorded before the run started moves no count and adds no entry, so no game is
 *   accused of a failure it did not cause.
 *
 * A run takes at most **one entry per (seat, pass)** it saw throw: a pass that throws on every turn
 * of a hundred-turn game reports **once for each seat that threw in it**, not once per turn — and not
 * once for the run either, because two seats that both stopped playing are two throws and collapsing
 * them would report one and silently drop the other. The key is the pass *and* the position rather
 * than the record object, because an honest policy mints a fresh record per throw (see
 * `PolicyReport.latestFailures` on why it must) and because a position is a seat.
 * `collectPlannerFailures` below states that argument in full.
 *
 * ## A poll takes only the records it minted (H2-1)
 *
 * The key above is not sufficient on its own, and the missing half is the one H2-1 is about:
 * `latestFailures` is the **instance's** list, and one instance serves every seat — `SMART_POLICY` is a
 * module-level singleton and `batch`, `tournament` and the CLI each hand one instance to every seat of
 * every run, which is the supported and shipped usage. So after a poll the list holds the polled seat's
 * own record *beside* every record the earlier seats' throws left in it, and reading the whole list
 * therefore hands a later poll records it did not produce: with seat 0 throwing in the cities pass and
 * seat 1 in the units pass, seat 1's poll re-appended seat 0's record under `1:cities` — **three
 * entries for two real throws**, the same record object twice, and a `(seat, pass)` named that never
 * threw. That is what a CLI banner printed as "3 PLANNER FAILURES" with a duplicated line, and what
 * `--json` carried; over a longer run it grows, because each seat keeps re-appending every other
 * seat's record under a key of its own that is still new. The count is an instance's count too, so the
 * same sharing also named a seat that never threw at all, off another seat's throw.
 *
 * The fix is that the runner **snapshots `latestFailures` before each poll and takes only the entries
 * that were not in it** — the records that poll minted, which is exactly the set that can belong to the
 * seat it polled. `plannerRecordsBeforePoll` takes the snapshot and `collectPlannerFailures` reads it.
 * The record's own `playerId` plus phase is *not* the fix, and the reason is worth the sentence: a
 * record's `playerId` cannot distinguish a record minted by another seat's throw during this poll from
 * one a **previous run** left in the shared list, so a run in which only seat 1 threw would claim the
 * earlier run's seat-0 record under key `0:<phase>` — the H1/G2-1 defect for the other seat, one layer
 * along. A snapshot answers both questions at once, because a record an earlier run minted is in it.
 * `runner.test.ts` drives both shapes: the different-pass count, and a later run that must not inherit
 * the other seat's record.
 *
 * The one shape this seam cannot name is a report that moves its count and offers no record at all
 * (a `PolicyReport` written with no `latestFailures`, before the field existed). Reaching back into
 * `failures` there would put another run's turn and pass into this run's result — the defect this
 * section is about — so the runner adds **nothing** rather than inventing a location: the count has
 * already said a throw happened during this run, nothing is claimed about where, and the honest
 * report is the shorter one. `runner.test.ts` drives that shape directly.
 *
 * `batch.test.ts`, `tournament.test.ts` and `headless/test/sim-cli.test.ts` pin those three
 * properties, and `tournament.test.ts` pins the reused-instance case directly.
 *
 * Nothing about the world changes: no RNG is drawn, no state is touched, and a run whose
 * policies never throw collects nothing and produces exactly the result it produced before
 * this field existed.
 *
 * ## The policy RNG stream, and the one thing it must never touch
 *
 * A policy draws from **its own** stream, never `state.rng`. If a policy consumed
 * the world's stream, changing the AI would change the world, and two policies
 * could not be compared on the same seed — which is the whole point of having
 * policies. `policyRngFor` derives that stream from the seed alone:
 *
 * - one stream **per (seed, player)** — the contract's own example, `seed + player
 *   index`, expanded through the engine's `seedRng` (sfc32);
 * - advanced **one draw per turn**, so a civilization's stream is a real sequence
 *   across a game rather than the same four words replayed;
 * - and it is a **pure function of `(seed, playerId, turn)`**, with no cursor
 *   carried by the loop. That is the strongest spelling of "derived from the seed":
 *   there is no shared mutable stream whose advance could depend on how many
 *   commands a policy happened to return, no way for one civilization's draws to
 *   shift another's, and no way for a policy's own randomness to perturb the world.
 *   The price is `O(turn)` sfc32 steps per poll, which at any simulation length this
 *   engine plays is nothing (a 32-bit mix each).
 *
 * ## What the runner does not do
 *
 * No I/O, no clock, no `Math.random`, no console: a run is a value. Reporting is a
 * renderer over the result (`@civts/sim`'s reporting half), never a `console.log`
 * inside the loop — the standing requirement's "one source of truth" rule, which
 * the M2 provenance summary broke by computing a figure the structured value did
 * not carry.
 */

import {
  advanceTurn,
  gameOutcomeOf,
  applyCommand,
  civPlayers,
  newGame,
  nextUint32,
  seedRng,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RngState,
  type RulesetView,
  type SetupError,
} from '@civts/core';
import { hashValue } from '@civts/testing';

import { plannerReportOf } from './policies.js';
import { CORE_INVARIANTS, checkInvariants } from './invariants.js';
import { sampleTurn } from './metrics.js';
import type { PlannerFailure } from './ai/smart.js';
import type {
  Invariant,
  InvariantContext,
  Policy,
  PolicyContext,
  SimulationOptions,
  SimulationResult,
  StopReason,
  TurnMetrics,
  Violation,
} from './types.js';

/* ------------------------------------------------------------------ *
 * The policy RNG stream
 * ------------------------------------------------------------------ */

/**
 * The stream policy `playerId` draws from on turn `turn` of a game seeded `seed`.
 *
 * `seed + player index`, expanded through the engine's `seedRng` (sfc32) — the
 * contract's own example — then stepped forward one draw per turn, so a
 * civilization's stream is a sequence across the game rather than a fixed four
 * words.
 *
 * **Pure in all three arguments**, deliberately: the runner keeps no cursor, so the
 * stream a policy is handed cannot depend on how many draws another policy made, on
 * the order civilizations were polled, or on how many commands were returned. Two
 * runs of the same seed therefore hand every policy the same series of streams, and
 * a policy can be swapped without moving any stream but its own — which is the
 * property `runner.test.ts` proves directly.
 */
export const policyRngFor = (seed: number, playerId: PlayerId, turn: number): RngState => {
  let cursor = seedRng(seed + Number(playerId));
  // Turn 1 is the stream's first state, turn 2 its second, and so on. A non-positive
  // or fractional `turn` (a caller sampling outside a run) collapses to the first
  // state rather than throwing: this is a derivation, and its totality is what keeps
  // it usable from a test that only wants "the stream for player 0".
  const steps = Number.isInteger(turn) && turn > 1 ? turn - 1 : 0;
  for (let step = 0; step < steps; step += 1) {
    cursor = nextUint32(cursor)[1];
  }
  return cursor;
};

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

/** How a setup failure reads in the thrown message. */
const describeSetupError = (error: SetupError): string => {
  switch (error.kind) {
    case 'missing-terrain-role':
      return `the ruleset describes no terrain for role "${error.role}", so no world can be generated`;
    case 'missing-unit-role':
      return `the ruleset describes no unit for role "${error.role}", so no game can be started`;
    case 'no-valid-starts':
      return `the world has no valid start position for ${String(error.civCount)} civilizations`;
    case 'too-few-start-candidates':
      return 'the world has too few candidate start positions for the civilizations asked for';
  }
};

/**
 * The metrics sampling stride, validated rather than trusted.
 *
 * A stride of `0` or a fraction would silently sample nothing (or sample on a
 * comparison that never holds), and a balance report that quietly contains no rows
 * is worse than a thrown argument error — the same reading `nextBelow` takes of its
 * bound, and the reason numeric flags are validated in the CLI.
 */
const samplingStride = (sampleEvery: number | undefined): number => {
  if (sampleEvery === undefined) return 1;
  if (!Number.isInteger(sampleEvery) || sampleEvery < 1) {
    throw new Error(
      `sampleEvery must be a positive integer (a sampling stride), got ${String(sampleEvery)}`,
    );
  }
  return sampleEvery;
};

/**
 * The seed, validated rather than trusted: a seed is a whole number.
 *
 * `seedRng` narrows with `| 0` and `generateWorld` mixes 32-bit words, so a
 * fractional seed is *silently truncated* for the randomness while the state stores
 * the fraction it was given as `state.seed` — the state's own record of its seed
 * would then disagree with the stream it was generated from, and two "different"
 * seeds 0.5 apart would produce the same world. A seed that is not a whole number is
 * a typo, and a typo that produces a plausible game is the one failure a simulation
 * harness must not have — so it is refused, and `runner.test.ts` pins the refusal.
 */
const checkedSeed = (seed: number): number => {
  if (!Number.isInteger(seed)) {
    throw new Error(
      `seed must be a whole number (a fractional seed is truncated by the RNG while the ` +
        `state stores it verbatim), got ${String(seed)}`,
    );
  }
  return seed;
};

/**
 * `maxTurns`, validated: a non-negative whole number.
 *
 * A fractional cap would play a different number of turns than it named (the loop
 * counts whole turns), and a negative one would play none — both are "the caller
 * asked for something and got something else", which is worse than a thrown
 * argument error. `Infinity` is rejected with them: this is a turn *cap*, and a
 * caller that wants a long run passes a long run's number.
 */
const checkedMaxTurns = (maxTurns: number): number => {
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    throw new Error(
      `maxTurns must be a non-negative whole number of turns, got ${String(maxTurns)}`,
    );
  }
  return maxTurns;
};

/** The policy for `playerId`, or a thrown message naming the caller's mistake. */
const policyFor = (policies: readonly Policy[], playerId: PlayerId): Policy => {
  const policy = policies[Number(playerId)];
  if (policy === undefined) {
    throw new Error(
      `policies must supply one policy per civilization, indexed by player id: player ` +
        `${String(playerId)} has none (policies.length = ${String(policies.length)})`,
    );
  }
  return policy;
};

/**
 * What a run has collected so far, where each policy's `failureCount` stood when the run began,
 * and which records it has already taken.
 *
 * A small object rather than closure variables so that the "read the count, then collect" rule is
 * one place: the count is read for every policy **before the first turn**, and `collect` adds only
 * what has happened since. The **count** is the key for *whether*, and the difference between it and
 * the first-per-pass record list is a silent pass rather than a saving: `PolicyReport.failures`
 * keeps one record per pass for the whole life of the instance, so a second run on the same instance
 * that throws in a pass the first run already recorded produces *the same record*, and comparing
 * those identities would call that run clean — the F2-1 finding, which `tournament.test.ts` pins.
 * `failureCount` is monotone, so it moves on every throw, whatever the list is holding.
 *
 * The **record** is the key for *what*, and it is `PolicyReport.latestFailures` — the policy's
 * newest throw in each pass, read *after* the count moved. See the module note's "What the count
 * decides, and what the record still says": answering *what* from the first-per-pass list is what
 * let a reused instance report an earlier run's turn and pass for its own throw (H1/G2-1).
 */
interface PlannerFailureLog {
  readonly collected: PlannerFailure[];
  /**
   * One ledger per **policy list position** — which in a run is the player id, the same index
   * `policyFor` resolves with. An array rather than a map keyed by the policy object, and
   * deliberately: a caller may hand the *same* instance to several seats (a tournament does), and
   * two seats are two polls whose counts have to be read separately. Both spellings are total —
   * the runner refuses a run whose policy list has no entry for a civilization — and this one
   * needs no lookup to resolve.
   */
  readonly ledgers: PolicyFailureLedger[];
  /**
   * What this run has already named, so a run does not report the same thing twice.
   *
   * A `Set<string | PlannerFailure>` because the handle differs by record: a record that
   * says which pass it came from is keyed by `"<position>:<phase>"` — one entry per seat per pass,
   * however many turns that pass threw on — while a record without a phase has only its identity to
   * go on. Both spellings live in one set because they can never collide (a string is never a
   * `PlannerFailure`), and one set keeps the two rules in one place.
   *
   * Per run, and rebuilt by each `startPlannerFailureLog`: a run's log is about that run, and the
   * opposite rule (`PolicyReport.failures`' first-record-per-pass, which never forgets for the life
   * of the instance) is precisely what made a reused instance's re-throw invisible.
   *
   * This set is what bounds a run's entries *across* its polls — a second turn that re-throws in a
   * pass already named is not named again. What bounds a *single* poll is the snapshot
   * `plannerRecordsBeforePoll` takes: only the records that poll minted are ever offered to the key
   * below, so no seat can be handed a record another seat's throw minted (H2-1). Both are needed, and
   * they answer different questions: "has this run named this already?" and "did this poll produce
   * it?".
   */
  readonly named: Set<string | PlannerFailure>;
}

/** One position's line in the log: the baseline reading, and nothing that remembers a record. */
interface PolicyFailureLedger {
  /**
   * `PolicyReport.failureCount` as it stood at the **baseline** and after every poll since —
   * "has anything happened?" is the only question ever asked of it, so one number does the work
   * of both readings. It is the whole of the baseline, and the record baseline this function used
   * to keep was removed by H1/G2-1 as unsound in both directions: see `collectPlannerFailures`.
   */
  countAtLastPoll: number;
}

/** The ledger for the policy polled at `position`, which the baseline always built one of. */
const ledgerAt = (log: PlannerFailureLog, position: number): PolicyFailureLedger => {
  const ledger = log.ledgers[position];
  if (ledger === undefined) {
    // Unreachable: `startPlannerFailureLog` fills this for every entry of the policy list, and the
    // runner resolves each civilization's policy (refusing a missing one) before it ever polls.
    // Written out rather than asserted away with `!`, so a change that broke that invariant says
    // so here instead of reading `undefined.countAtLastPoll`.
    throw new Error(
      `runSimulation: internal — no planner-failure ledger for policy ${String(position)}, and ` +
        'the baseline builds one for every entry of the policy list',
    );
  }
  return ledger;
};

/**
 * Start the log: collect nothing yet, and record every policy's failure count as it stands
 * **before the first turn**.
 *
 * This is the baseline, and it is what keeps a run's `plannerFailures` about *this* run. Nothing in
 * this package resets a policy's report (it is the policy's own record, and `SMART_POLICY` is a
 * module-level singleton), so a caller that reuses an instance across runs would otherwise see a
 * previous run's failure attributed to this one — a false accusation, which is a different bug from
 * the silence this field exists to end but a bug all the same.
 *
 * A policy that cannot report (`plannerReportOf` answers `undefined`) baselines at zero and is
 * never read again, so it contributes nothing: that is the ordinary case for the control
 * policies, and it costs no knowledge of the AI.
 */
const startPlannerFailureLog = (policies: readonly Policy[]): PlannerFailureLog => {
  return {
    collected: [],
    named: new Set(),
    ledgers: policies.map((policy) => ({
      countAtLastPoll: plannerReportOf(policy)?.failureCount ?? 0,
    })),
  };
};

/**
 * The policy's own latest-per-pass records **as they stand before it is polled** — the snapshot the
 * collector measures a poll against.
 *
 * One read before the poll, and it is the whole input of the H2-1 half of the rule: only a record
 * that was *not* in this list can have been minted by the poll being collected, and only those
 * records can belong to the seat that poll was made for. `latestFailures` is the instance's list and
 * one instance serves every seat, so after a poll it holds the polled seat's record *beside* the
 * records earlier seats' throws left there — reading the list without this snapshot is what let a
 * later seat's poll re-append an earlier seat's record under its own key, and let a seat that never
 * threw be named off another seat's throw. See "Carrying a planner failure" in the module note.
 *
 * A policy that cannot report has no records, and `[]` is the honest reading of that: it is also what
 * `plannerReportOf(policy)?.latestFailures` gives for a report written before that field existed, so
 * the collector's "minted during this poll" test degenerates to "everything the list offers" exactly
 * where the list offers nothing.
 *
 * The arrays the report hands back are fresh per call and the records in them are never mutated (the
 * `PolicyReport` contract), so holding this one across the poll is safe and the identity comparison
 * in the collector is meaningful rather than incidental.
 */
const plannerRecordsBeforePoll = (policy: Policy): readonly PlannerFailure[] =>
  plannerReportOf(policy)?.latestFailures ?? [];

/**
 * Read the policy that was polled for `position` and append whatever it recorded since the last
 * poll. Called straight after the poll, because the record can only change *during* it, and handed
 * the records the policy held *before* that poll (`plannerRecordsBeforePoll`), because only the ones
 * after it are this poll's.
 *
 * ## The count decides *whether*, the latest-per-pass record decides *what*
 *
 * Two questions, asked in this order:
 *
 * 1. **Whether.** A policy that cannot report, or one whose `failureCount` has not moved since
 *    the last poll, contributes nothing — a healthy policy costs two reads of its report (one for
 *    the snapshot, one for the count) and no allocation of the runner's own. A
 *    moved count means at least one throw happened **during this run**, which is the fact the old
 *    identity baseline could not see: `PolicyReport.failures` keeps one record per pass for the
 *    whole life of the instance, so a second run that throws in a pass the first run already
 *    recorded hands back *the same record*, and a run compared against that list alone looks clean.
 *    That was F2-1, and it is why the count leads. The count is the whole of the baseline: no
 *    record is compared with a reading taken before the run, because a reused instance holds the
 *    *same object* it held when the next run started, and an object-versus-baseline test would call
 *    that run's re-throw clean — the F2-1 silent pass, back again.
 * 2. **What.** The records are the policy's own `latestFailures`, read **after** the count moved,
 *    minus the ones that were already there before the poll: the newest throw in each pass *that this
 *    poll minted*, whose `turn`, `phase`, `playerId` and `detail` are the ones the planner wrote while
 *    planning this run's turn. That is the whole of the H1/G2-1 fix, because the throw that made the
 *    count move is the throw that wrote these records — a run cannot report an earlier run's turn and
 *    pass. Answering this question from the first-per-pass list is what did: a frozen entry, printed
 *    seed-qualified as `seed 2, turn 4 — smart, player 0, cities pass (city 0)` for a run whose planner
 *    only threw on turns 6, 7 and 8. And the subtraction is the whole of H2-1, because the count is an
 *    *instance's* count while the poll is a *seat's* poll: without it, one seat's throw moved the count
 *    that every later seat's poll — and every later poll that threw nothing at all — was measured
 *    against, and each of them then read the whole shared list.
 *
 * ## The bound, and why it is a pair rather than a record
 *
 * A run names **each (seat, pass) that threw during it, once**. The pass is the key because
 * `latestFailures` already holds one entry per pass, so reading the list after every poll costs one
 * entry per throwing pass however many turns it threw on. What the key is *not* is the record
 * object, and that distinction is the H1 finding: a policy that reports honestly mints a fresh
 * record per throw, so keying on the object gives one entry per turn and per seat — hundreds of
 * lines for one pass. (Remembering "phases I have named" *instead* of reading the newest record,
 * and skipping the rest, fails the other way: it keeps the first turn's record and drops every
 * later one, reporting a turn the run did throw on but not the throw that ended it.)
 *
 * The position is in the key because a position is a seat: two seats sharing one instance both throw
 * in the same pass of the same turn, for real, and each gets its line. Collapsing them would report
 * one seat's throw and silently drop the other's, which is the silence this channel exists to end.
 * The key is read only over records this poll minted, so it can never be filled with another seat's
 * record — which is the shape H2-1 removed, and the reason the key is the polled *position* rather
 * than the record's own `playerId`: a record's `playerId` says which seat wrote it, not which poll
 * produced it, and those two differ for exactly the records that must be skipped.
 *
 * A report that moved its count and holds no record this poll minted adds no entry, so nothing can
 * become an accusation: nothing to name means nothing to append, and the count has already said
 * *that* something happened. That is the same honest answer a report with no list at all gets, and it
 * is also what a report that hands one record object to two seats gets — a `PolicyReport` mints a
 * fresh object per throw, and one object can only be named once. The ledger's count is updated first
 * and unconditionally, so the next poll is measured from this one rather than re-counting the same
 * throw.
 */
const collectPlannerFailures = (
  log: PlannerFailureLog,
  position: number,
  policy: Policy,
  recordsBeforePoll: readonly PlannerFailure[],
): void => {
  const report = plannerReportOf(policy);
  if (report === undefined) return;

  const ledger = ledgerAt(log, position);
  const count = report.failureCount;
  if (count <= ledger.countAtLastPoll) return;
  ledger.countAtLastPoll = count;

  // The policy's own latest-per-pass records: the newest throw in each pass, so what is read here
  // is a throw that happened *during this run* rather than the first one the instance ever saw —
  // and never the frozen first-per-pass record an earlier run left behind.
  const latest = report.latestFailures ?? [];
  for (const record of latest) {
    // **Only what this poll minted** (H2-1). `latestFailures` is shared by every seat the instance
    // serves, so a record that was already in the list when this poll began was minted by some other
    // throw — this seat's on an earlier turn, or another seat's on this turn or in an earlier run —
    // and it is not this poll's to claim. Skipping it is what keeps the count honest: seat 0 throwing
    // in the cities pass and seat 1 in the units pass is **two** entries, not three, and a seat that
    // threw nothing is named nothing even though the shared count moved.
    //
    // The honest reporter this relies on is the one `PolicyReport.latestFailures` describes: a fresh
    // object per throw, never mutated. A reporter that hands one object back for two throws can only
    // be named once, and the count still says a throw happened — the alternative, naming it under both
    // seats, is the duplicate-record defect itself.
    if (recordsBeforePoll.includes(record)) continue;
    // **One entry per (seat, pass) per run.** The `(position, phase)` pair is the key, and it is
    // the one the data actually has: `latestFailures` holds one entry per pass, so a pass that
    // throws on every turn of a hundred-turn game is read here a hundred times and named once —
    // the record that explains the throw, kept by the first poll that saw it and never reduced.
    //
    // Two properties fall out and both are wanted. Two seats that share one instance both throw in
    // the same pass of the same turn, and both threw for real, so each gets its line: the key is
    // per position, not per run, because a position is a seat. And the entry is the *first* record
    // this run saw for that pair rather than the last, so a run reports the throw it started
    // failing at — `runner.test.ts` pins the two. The count has already said *that* something
    // happened; this says where, once, for each seat that stopped playing.
    //
    // A record with no phase has no pass to key on, so the run falls back to its object identity —
    // the only handle such a record has. The shipped AI always sets a phase (it is planning when it
    // throws); this is the branch for a report written elsewhere.
    const key = record.phase === undefined ? undefined : `${String(position)}:${record.phase}`;
    if (key === undefined) {
      if (log.named.has(record)) continue;
      log.named.add(record);
    } else {
      if (log.named.has(key)) continue;
      log.named.add(key);
    }
    log.collected.push(record);
  }
};

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * Play a game headlessly and report what happened.
 *
 * The returned `finalState` is the state the loop stopped on: the end of the last
 * turn played, or — when an invariant fired — the state that broke, which is the
 * point of stopping there rather than carrying on.
 *
 * Throws when `newGame` reports a setup failure, when a civilization has no policy, or when
 * `sampleEvery` is not a positive integer. All three are caller bugs, and a caller bug has no
 * field in this result to live in: `plannerFailures` (M7d) is a *policy's* own record of a
 * throw it caught, which is a different kind of fact, and a run that invented an entry for a
 * caller's mistake would make the two indistinguishable. All three would otherwise produce a
 * *plausible* result — an empty game, a run where one player never acts, a report with no
 * rows — and a plausible wrong number is the worst outcome a balance loop can have.
 *
 * A **planner failure is not one of them**, and the distinction is the whole of M7d: a
 * policy that throws while planning is caught by the policy itself (a policy is required
 * to be total), and what it returns is a partial turn. That is a fact about the run's
 * *evidence*, not about its arguments, so it is reported in the result —
 * `SimulationResult.plannerFailures` — rather than thrown. See "Carrying a planner
 * failure" above.
 */
export const runSimulation = (options: SimulationOptions): SimulationResult => {
  const rulesetView: RulesetView = options.ruleset;
  const seed = checkedSeed(options.seed);
  const maxTurns = checkedMaxTurns(options.maxTurns);

  const created = newGame(seed, options.settings, rulesetView);
  if (!created.ok) {
    throw new Error(
      `runSimulation: newGame(seed ${String(seed)}, ${options.settings.mapSize}, ` +
        `${String(options.settings.civCount)} civs) failed — ${describeSetupError(created.error)}`,
    );
  }

  const invariants = options.invariants ?? CORE_INVARIANTS;
  const stride = samplingStride(options.sampleEvery);
  const metrics: TurnMetrics[] = [];
  const violations: Violation[] = [];

  // **The count of checks that really ran**, incremented by the check itself rather than
  // computed from the turns played (F2). The registry used by the loop is the caller's own
  // entries with each `check` wrapped in a counter, so the number in the result moves exactly
  // when a predicate is invoked and cannot drift from what happened: a turn that is skipped,
  // a check that is added, or a loop that breaks before the registry runs all show up here as
  // a *different number* rather than as the same arithmetic reported twice. Every other
  // reading of "how many checks" — `turnsPlayed * registry.length` above all — is a claim
  // about the loop, and a claim about a loop is exactly the thing that goes stale.
  //
  // The wrappers preserve `name` and `description` (a violation built by `checkInvariants`
  // names the invariant from the entry it ran), so wrapping changes nothing observable except
  // the counter.
  let invariantChecks = 0;
  const countedInvariants: readonly Invariant[] = invariants.map((invariant) => ({
    name: invariant.name,
    description: invariant.description,
    check: (ctx: InvariantContext): readonly string[] => {
      invariantChecks += 1;
      return invariant.check(ctx);
    },
  }));
  // Taken before the first turn — see the module note on the baseline.
  const plannerFailures = startPlannerFailureLog(options.policies);

  let state: GameState = created.value;
  let turnsPlayed = 0;
  let appliedCommands = 0;
  let stopped: StopReason = 'max-turns';

  // Resolve every policy up front, before a single turn is played: a run that would
  // die on turn 30 because the caller forgot player 2's policy has already burned
  // 29 turns, and the message is the same either way.
  for (const player of civPlayers(state)) policyFor(options.policies, player.id);

  for (let step = 0; step < maxTurns; step += 1) {
    // The turn boundary: what every transition invariant is measured against. It is
    // taken before any command of this turn, because the commands are exactly what
    // the checks cannot see (see `invariants.ts` on why `previous` is a boundary
    // rather than the state the pipeline started from).
    //
    // Note that this is **also** the first turn's `previous` — the `newGame` state.
    // The contract's `InvariantContext` comment ("absent on the first turn") describes
    // a harness checking a state with no transition behind it; this loop never does
    // that, because a check only happens after a turn has been played. Handing the
    // boundary over on turn 1 rather than `undefined` is deliberate: the first turn is
    // the one that founds cities, and a transition check that skipped it would leave
    // the busiest transition of a run unchecked.
    const previous = state;
    const events: GameEvent[] = [];

    // Civilizations only, in player-id order: barbarians are a player but not a
    // civilization, and they are never polled (`civPlayers` is the one definition of
    // "who is a civilization" — re-deriving it here is how the count drifts).
    for (const player of civPlayers(state)) {
      const policy = policyFor(options.policies, player.id);
      const ctx: PolicyContext = {
        state,
        playerId: player.id,
        ruleset: options.ruleset,
        rng: policyRngFor(seed, player.id, state.turn),
      };

      // The poll, and then the read of the policy's own failure record — in that order,
      // because the record can only change *during* the poll. A policy that threw while
      // planning this turn has already recorded it by the time `chooseCommands` returns,
      // and the commands it returned are the partial turn that has to be visible in the
      // result rather than only in a warning beside it (see "Carrying a planner failure").
      //
      // The snapshot is taken **before** the poll and the record is read after it, because the
      // difference between the two is what makes the record this seat's: `latestFailures` is shared
      // by every seat the instance serves, so a list read after the poll holds other seats' records
      // too — reading it whole is H2-1, and `plannerRecordsBeforePoll` is the fix.
      const recordsBeforePoll = plannerRecordsBeforePoll(policy);
      const proposed = policy.chooseCommands(ctx);
      collectPlannerFailures(plannerFailures, Number(player.id), policy, recordsBeforePoll);

      for (const command of proposed) {
        // The runner owns the turn boundary — see the module note.
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, rulesetView);
        if (!outcome.ok) continue;
        state = outcome.value.state;
        events.push(...outcome.value.events);
        appliedCommands += 1;
      }
    }

    const advanced = advanceTurn(state, rulesetView);
    state = advanced.state;
    events.push(...advanced.events);
    turnsPlayed += 1;

    // **M10: a decided game ends the run.** `advanceTurn` returns a finished state
    // unchanged (see `turn.ts`), and `applyCommand` refuses every command on one with
    // `game-over`, so a loop that kept going would spend its remaining turns polling
    // policies whose every proposal is refused and then report `no-commands` — the
    // symptom, not the fact. Stopping here is what makes `outcome` below the run's own
    // ending rather than a fact the harness noticed afterwards.
    //
    // Checked *after* the turn rather than before it, because the condition is evaluated
    // inside the pipeline: the turn that wins the game is a turn that was really played.
    //
    // The reading is taken here and **acted on below**, after the registry has run — see
    // the note on the order of the two. It is one read of `gameOutcomeOf` for both uses,
    // so the ending that stops the run and the ending reported in `outcome` cannot be two
    // different answers to the same question.
    const decided = gameOutcomeOf(state, rulesetView) !== null;

    // Sampled after the pipeline, so a row describes a fully settled turn: this
    // turn's income and upkeep ledger is in `events`, and the state is the one the
    // next turn begins from. The row's `turn` is the state's own turn, so the first
    // row of a run is turn 2 — turn 1 is `newGame`'s state and nobody played it.
    //
    // A deciding turn is **not** sampled, which is the sampling rule this loop has always
    // had (`game-over` used to break before this line); the guard keeps the metric rows of
    // every existing report byte-identical while the registry below gains the turn.
    const sampleThisTurn = !decided && (turnsPlayed - 1) % stride === 0;
    if (sampleThisTurn) metrics.push(...sampleTurn(state, rulesetView, events));

    // **Every turn is checked, the deciding one included** (F2). The invariants are
    // properties of *state*, and the state a deciding turn reaches is a state like any
    // other — in fact it is the one that most needs checking: the capture or the
    // completion that ends a game is exactly what `captured-city-consistent` and the
    // conservation checks exist to fire on, and running them *after* the break meant the
    // one turn a game is decided on was handed to no predicate at all. The registry
    // therefore runs **before** the game-over break, on this turn's settled state, once:
    // no turn is double-checked and none is skipped, which is what makes
    // `SimulationResult.invariantChecks` equal to `turnsPlayed * registry.length` for a
    // decided run as well as for a turn-limited one.
    //
    // A violation still outweighs an ending when both happen on the same turn: a broken
    // state is a defect in the engine and has to be reported as one, and `stoppedBecause:
    // 'violation'` is the more specific fact about the turn. The two are not in conflict —
    // a state can end a game *and* break a property, and the property is the bug.
    const found = checkInvariants(
      {
        state,
        previous,
        ruleset: options.ruleset,
        rulesetView,
        events,
        turn: state.turn,
      },
      countedInvariants,
    );
    if (found.length > 0) {
      violations.push(...found);
      stopped = 'violation';
      break;
    }

    if (decided) {
      stopped = 'game-over';
      break;
    }
  }

  if (stopped !== 'violation' && stopped !== 'game-over' && appliedCommands === 0) {
    stopped = 'no-commands';
  }

  // The outcome is read from the final state, not accumulated during the run: it is a
  // pure function of the board, and a second copy is a second thing that can disagree.
  // `undefined` means the run stopped with the game still in play, and the key is then
  // **omitted** rather than written as `undefined` (the project's hashability rule).
  //
  // The `kind` is built here rather than taken from `outcomeFor`, because that function
  // answers "what does this mean for *this seat*" and a run has no seat: `victory` and
  // `defeat` are a viewer's words. A decided run with a winner is a `victory` and one
  // without is a `draw` — the two readings a batch can honestly report.
  const ending = gameOutcomeOf(state, rulesetView);
  const result: SimulationResult = {
    seed,
    turnsPlayed,
    finalHash: hashValue(state),
    finalState: state,
    metrics,
    violations,
    invariantChecks,
    // A fresh array, and an empty one when nothing failed — required and always present,
    // the same discipline `violations` follows. The log's own array is handed over rather
    // than copied because the run is over and the log is local to it; nothing else holds a
    // reference to it.
    plannerFailures: plannerFailures.collected,
    stoppedBecause: stopped,
  };
  if (ending === null) return result;

  return {
    ...result,
    outcome: {
      kind: ending.winner === null ? 'draw' : 'victory',
      condition: ending.condition,
      winner: ending.winner,
      turn: state.turn,
    },
  };
};
