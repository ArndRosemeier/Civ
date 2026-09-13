/**
 * `@civts/sim` — the simulation package.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first".
 *
 * Everything `sim` offers is re-exported here, so downstream code imports from one
 * place and the typechecker is the integration mechanism between workstreams — the
 * same arrangement `@civts/core` and `@civts/rules` use for their own modules.
 *
 * The standing requirement is four properties of *every* future system, and this
 * package is where three of them are delivered as infrastructure rather than as a
 * convention:
 *
 * - **Runnable without a UI, deterministically.** A game is a pure function of
 *   `(seed, settings, ruleset, policies)`. `Policy` is the replaceable seam: the AI is
 *   never hard-wired into the engine, and each policy draws from its **own** RNG stream
 *   derived from the seed, so swapping strategies changes the game and never the
 *   world's stream. A system that cannot be exercised headlessly is not finished.
 * - **Observable.** `TurnMetrics` is the machine-readable state a run did not have
 *   before, so an effect can be *measured* rather than eyeballed.
 * - **Tunable.** No magnitude lives in logic: content lives in `@civts/rules` and a
 *   sweep varies it through `RulesetPatch` (`applyOverrides`), applied before
 *   `validateRuleset` so a bad override fails exactly like a hand-edited catalog.
 * - **Checkable in flight.** `CORE_INVARIANTS` is one named predicate per broken
 *   property, run on *every* turn of a run instead of only at the end — one definition
 *   that runs in the tests and in the simulation.
 *
 * ## What is in this file, and what is added beside it
 *
 * This index covers the modules that exist today: `types.ts` (the shapes), the
 * invariant registry (`invariants.ts`) and the balance knobs (`overrides.ts`). The
 * simulation loop, the metrics sampler, the batch aggregator and the policies arrive as
 * sibling modules in `src/` and are appended to the export lists below by their owners,
 * one line each — the same reading order `@civts/core`'s index uses. Nothing here
 * re-exports a module that does not exist, so the package typechecks at every step
 * rather than only once every workstream has landed.
 *
 * ## Provenance
 *
 * Nothing in this package introduces a game magnitude, and nothing in it is claimed to
 * be Civ 3-accurate. Every number a simulation reads comes from the catalog, where each
 * row carries its own provenance — and every row of the shipped catalog is a
 * `placeholder`: unsourced, chosen to be playable. Infrastructure code that introduced
 * a balance number of its own would be that number's only home, with no provenance and
 * no way to sweep it.
 */

export { CORE_INVARIANTS, checkInvariants } from './invariants.js';

export {
  OVERRIDE_SECTIONS,
  applyOverrides,
  formatOverrideError,
  tryApplyOverrides,
} from './overrides.js';
export type { OverrideError, OverrideOutcome } from './overrides.js';

// The simulation loop and the AI seam beside it. Added by their owners, beside the
// registry and the balance knobs the paragraph above describes, in reading order:
// what a turn's numbers are (`metrics`), who decides (`policies`), how a run is
// played (`runner`), and how many runs are summarised (`batch`).
export { playerMetrics, sampleTurn } from './metrics.js';
export { IDENTITY_METRIC_FIELDS, MEASURED_METRIC_FIELDS, METRIC_KEY_ORDER } from './metrics.js';
export type { MeasuredMetricField } from './metrics.js';

export {
  DO_NOTHING_POLICY,
  SIMPLE_POLICY,
  SIMPLE_POLICY_TUNING,
  simplePolicy,
} from './policies.js';
export type { SimplePolicyTuning } from './policies.js';

// M7's real opponent, and the weights it reads. Re-exported from the `policies` line above
// as well, so a caller that already imports `DO_NOTHING_POLICY` from here finds the real AI
// beside it without learning a second module path — while the AI's own module notes stay
// under `ai/`, where its weights and its decision code live together.
export {
  DEFAULT_SMART_WEIGHTS,
  SMART_POLICY,
  SMART_POLICY_NAME,
  SMART_WEIGHT_GROUPS,
  SMART_WEIGHTS,
  mergeSmartWeights,
  smartPolicy,
} from './ai/index.js';
export type { SmartWeightGroup, SmartWeights, SmartWeightsPatch } from './ai/index.js';

export { policyRngFor, runSimulation } from './runner.js';

// **The AI's failure channel, on the package's surface rather than one module deep, and since
// M7d a field of the results as well as a question a caller can ask.** A policy that catches a
// throw and keeps playing is the right contract — a policy that threw would take a twenty-seed
// tournament down with it — but the turn it leaves behind looks *exactly* like a turn in which
// the AI had nothing to say: same legal command list, same metrics, same invariants, same
// plausible hash. M7c gave that record a type and a reader (`plannerFailuresOf`); M7d wired it
// into `SimulationResult.plannerFailures` and `TournamentResult.plannerFailures`, so a reader
// holding only the structured result can tell a partial turn from a quiet one and
// `tournamentVerdict(...).passed` fails a run that contains one. All three functions work on any
// `Policy` and answer `undefined`/`[]` for one that cannot report (the controls), so calling them
// costs no knowledge of the AI; `sim-cli.ts` is the consumer that renders them and fails the run.
//
// `plannerReportOf` is the **whole** report — `failures` (which passes have ever failed),
// `latestFailures` (this policy's most recent throw in each pass, which is what a run attributes
// itself with: see `PolicyReport`) and `failureCount` (the only monotone thing a policy hands
// out, and the number the runner baselines *whether* against). It is exported here rather than
// left one module deep because the count is a figure a consumer can want and neither narrower
// reader carries it — the runner itself once reached past this surface for it (H1/G2-5).
export { describePlannerFailures, plannerFailuresOf, plannerReportOf } from './ai/index.js';
export type {
  DiagnosedPolicy,
  PlannerFailure,
  PlannerFailureDraft,
  PlannerPhase,
  PolicyReport,
} from './ai/index.js';

export { aggregateRuns, runBatch } from './batch.js';

// M7's self-play harness: many games, one policy per seat, and the seats rotated so that no
// strategy is ever tested from one position only. Exported beside the batch it is built on,
// because the two answer the two halves of the same question — "how do these numbers move
// when the world changes" (`runBatch`) and "how do these strategies compare" (this).
export {
  A3_TOURNAMENT_EVIDENCE,
  DEFAULT_TOURNAMENT_BUDGET_MS,
  HOST_CLOCK,
  runTournament,
  seatPlan,
  tournamentEvidence,
  tournamentVerdict,
} from './tournament.js';
export type {
  TournamentClock,
  TournamentEvidence,
  TournamentEvidenceGame,
  TournamentEvidenceInput,
  TournamentHarness,
  TournamentOptions,
  TournamentPolicyTotals,
  TournamentResult,
  TournamentSeatTotals,
  TournamentTotals,
  TournamentVerdict,
} from './tournament.js';

export type {
  BatchOptions,
  BatchResult,
  BuildingPatch,
  ImprovementPatch,
  Invariant,
  InvariantContext,
  MetricAggregate,
  OverrideSection,
  Policy,
  PolicyContext,
  ResourcePatch,
  RulesetPatch,
  SimulationOptions,
  SimulationResult,
  StopReason,
  TerrainPatch,
  TurnMetrics,
  UnitPatch,
  Violation,
  WinCount,
  YieldsPatch,
} from './types.js';
