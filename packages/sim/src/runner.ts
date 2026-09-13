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
 * violation be caught where it happened.
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
 *    to read it out of the policy that owns it. See "Carrying a planner failure" below
 *    for how it is read and why it is not a second `violations` list.
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
 * - `failures` keeps the **first** failure of each pass, so the list is bounded by the five
 *   passes rather than by a cap somebody chose — and a policy that failed a pass before this run
 *   started will not report a *different* pass record for it;
 * - a report is *cumulative for the policy instance*, and `SMART_POLICY` is a module-level
 *   singleton;
 * - and `failureCount` counts **every** throw, including the hundreds that the first-per-pass
 *   list collapsed into one record. It is the only monotone thing a policy hands out.
 *
 * So the runner reads the count for every policy it is handed, before the first turn, and
 * collects the failures that appeared *after* that reading. **The count is the baseline, and the
 * list is not**, because the list alone cannot see a re-throw: a policy whose first failure in a
 * pass was recorded by an earlier run keeps that pass's record — one record, not one per throw —
 * so a second run that throws on every single turn reports an unchanged list, and baselining on
 * the list's contents therefore reported it as a clean run. That is a path where a thrown planner
 * LOOKS CLEAN, which is the exact silent-pass shape M7d exists to close, so the count leads:
 * `failureCount` grows on every throw, so a re-throw in a later run stays visible, while a wholly
 * pre-existing failure moves the count not at all and is still not re-attributed to a run that
 * did not produce it.
 *
 * ## What the count decides, and what the record still says
 *
 * The count answers *whether* something happened during this run; the record answers *what*. Both
 * are needed and neither is redundant. A failure whose count moved is a real throw, so the run
 * reports it — that is what closes F2-1. The entry it reports is the policy's **own** current
 * record for the pass that failed, appended and never minted: a turn number nobody observed,
 * attached to a game the throw may not have happened in, would be a guess dressed as evidence, and
 * this field exists precisely because a plausible-looking claim about the AI is the worst outcome
 * here.
 *
 * Because the policy collapses every throw of one pass into a single record, a run takes at most
 * one entry per distinct record — the same "one per pass" bound `PolicyReport` states, seen from
 * the runner's side. A pass that throws on every turn of a hundred-turn game therefore reports
 * **once**, not a hundred times.
 *
 * What the seam guarantees, in three lines:
 *
 * - a failure is attributed to the policy whose count moved, and to the run in which it moved;
 * - a re-throw is visible in every run that re-threw, so no run is silent about its own throw;
 * - a failure recorded before the run started moves no count and adds no entry, so no game is
 *   accused of a failure it did not cause.
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

import { plannerReportOf } from './ai/smart.js';
import { CORE_INVARIANTS, checkInvariants } from './invariants.js';
import { sampleTurn } from './metrics.js';
import type { PlannerFailure } from './ai/smart.js';
import type {
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
 * A small object rather than three closure variables so that the "read the count, then collect"
 * rule is one place: the count is read for every policy **before the first turn**, and `collect`
 * adds only what has happened since. The **count** is the key, not the record identity, and the
 * difference is a silent pass rather than a saving: `PolicyReport.failures` keeps one record per
 * pass for the whole life of the instance, so a second run on the same instance that throws in a
 * pass the first run already recorded produces *the same record*, and comparing identities would
 * call that run clean — the F2-1 finding, which `tournament.test.ts` pins. `failureCount` is
 * monotone, so it moves on every throw, whatever the list is holding.
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
   * The records this run has already taken, **however many policies or seats handed them over**:
   * one entry in `collected` per distinct record, so a pass that throws on every turn of a
   * hundred-turn game contributes one entry rather than a hundred — and two seats sharing one
   * instance do not each report the same throw.
   *
   * Per run, and rebuilt by each `startPlannerFailureLog`: a run's log is about that run, and the
   * opposite rule (`PolicyReport.failures`' first-record-per-pass, which never forgets) is
   * precisely what made a reused instance's re-throw invisible.
   */
  readonly named: Set<PlannerFailure>;
}

/** One position's line in the log: the baseline reading, and nothing that remembers a record. */
interface PolicyFailureLedger {
  /**
   * `PolicyReport.failureCount` as it stood at the **baseline** and after every poll since —
   * "has anything happened?" is the only question ever asked of it, so one number does the work
   * of both readings.
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
 * This is the whole of the baseline, and it is what keeps a run's `plannerFailures` about *this*
 * run. Nothing in this package resets a policy's report (it is the policy's own record, and
 * `SMART_POLICY` is a module-level singleton), so a caller that reuses an instance across runs
 * would otherwise see a previous run's failure attributed to this one — a false accusation, which
 * is a different bug from the silence this field exists to end but a bug all the same.
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
 * Read the policy that was polled for `position` and append whatever it recorded since the last
 * poll. Called straight after the poll, because the record can only change *during* it.
 *
 * ## The count decides *whether*, the record decides *what*
 *
 * Two different questions, asked in this order:
 *
 * 1. **Whether.** A policy that cannot report, or one whose `failureCount` has not moved since
 *    the last poll, contributes nothing — a healthy policy costs one read and no allocation. A
 *    moved count means at least one throw happened **during this run**, which is the fact the old
 *    identity baseline could not see: `PolicyReport.failures` keeps one record per pass for the
 *    whole life of the instance, so a second run that throws in a pass the first run already
 *    recorded hands back *the same record*, and a run compared against the list alone looks clean.
 *    That was F2-1, and it is why the count leads.
 * 2. **What.** The entry appended is the policy's own current record for the pass that failed —
 *    appended, never minted. A record this run has already taken is not appended again: the
 *    policy collapses every throw of one pass into one record, so a policy that throws on every
 *    turn of a hundred-turn game would otherwise add a hundred identical entries, and "which pass
 *    failed" does not become truer by repetition. This is the one place identity still matters,
 *    and within one run only.
 *
 * A report that moved its count and still hands out no records at all adds no entry, so an empty
 * report cannot become an accusation: nothing to name means nothing to append. The ledger's count
 * is updated first and unconditionally, so the next poll is measured from this one rather than
 * re-counting the same throw — including when the record was one this run had already taken.
 */
const collectPlannerFailures = (log: PlannerFailureLog, position: number, policy: Policy): void => {
  const report = plannerReportOf(policy);
  if (report === undefined) return;

  const ledger = ledgerAt(log, position);
  const count = report.failureCount;
  if (count <= ledger.countAtLastPoll) return;
  ledger.countAtLastPoll = count;

  const named = report.failures[report.failures.length - 1];
  if (named === undefined || log.named.has(named)) return;

  log.named.add(named);
  log.collected.push(named);
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
      const proposed = policy.chooseCommands(ctx);
      collectPlannerFailures(plannerFailures, Number(player.id), policy);

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

    // Sampled after the pipeline, so a row describes a fully settled turn: this
    // turn's income and upkeep ledger is in `events`, and the state is the one the
    // next turn begins from. The row's `turn` is the state's own turn, so the first
    // row of a run is turn 2 — turn 1 is `newGame`'s state and nobody played it.
    if ((turnsPlayed - 1) % stride === 0) metrics.push(...sampleTurn(state, rulesetView, events));

    const found = checkInvariants(
      {
        state,
        previous,
        ruleset: options.ruleset,
        rulesetView,
        events,
        turn: state.turn,
      },
      invariants,
    );
    if (found.length > 0) {
      violations.push(...found);
      stopped = 'violation';
      break;
    }
  }

  if (stopped !== 'violation' && appliedCommands === 0) stopped = 'no-commands';

  return {
    seed,
    turnsPlayed,
    finalHash: hashValue(state),
    finalState: state,
    metrics,
    violations,
    // A fresh array, and an empty one when nothing failed — required and always present,
    // the same discipline `violations` follows. The log's own array is handed over rather
    // than copied because the run is over and the log is local to it; nothing else holds a
    // reference to it.
    plannerFailures: plannerFailures.collected,
    stoppedBecause: stopped,
  };
};
