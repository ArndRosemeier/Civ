/**
 * `@civts/sim/ai` — **the real AI, in one namespace.**
 * See docs/INTERFACES.md, "M7 contracts — FROZEN (a real opponent, and self-play)".
 *
 * ## What is here, and what is not
 *
 * Three modules, in reading order:
 *
 * 1. `weights.ts` — **every magnitude the AI introduces**, in one named, documented place,
 *    each marked a `placeholder` (unsourced, chosen to be playable, not a Civ 3 figure),
 *    with `SMART_WEIGHT_GROUPS` and `mergeSmartWeights` as the sweep seam. This is the
 *    standing requirement's *Tunable* applied to the AI, and the answer to M6b's lesson
 *    about combat: a preference a balance pass might want to vary must never be a literal
 *    buried in a branch.
 * 2. `smart.ts` — the policy itself: one real opponent that plays a whole game unaided.
 * 3. this file — the import surface, so a caller that wants the AI has one name to reach
 *    for and does not have to know how the three modules are split.
 *
 * `DO_NOTHING_POLICY` and `SIMPLE_POLICY` are deliberately **not** here. They are not
 * part of the AI; they are the *control* a balance comparison is measured against and the
 * placeholder M7 replaces, and both stay exported from `./policies.js` where they always
 * were, so nothing that already imports them has to move. What `policies.ts` adds is one
 * line: `SMART_POLICY`, re-exported from here.
 *
 * ## Provenance, stated at the surface as well as in the module
 *
 * Nothing the AI prefers is a rule of the game and nothing is traced to a source. Its
 * weights are **placeholders**; the engine reads none of them; and the one thing that must
 * never be confused — "this AI attacks at 55% because that was playable" versus "Civ 3's
 * AI attacks at 55%" — is a distinction `weights.ts` states at length and this file
 * repeats, because it is the claim most likely to be quoted out of context.
 */

export {
  DEFAULT_SMART_WEIGHTS,
  SMART_WEIGHT_GROUPS,
  SMART_WEIGHTS,
  mergeSmartWeights,
} from './weights.js';
export type { SmartWeightGroup, SmartWeights, SmartWeightsPatch } from './weights.js';

// A policy that cannot throw and cannot say it went wrong reports a game it did not play.
// `plannerFailuresOf` and `describePlannerFailures` are how a runner or a CLI asks: they
// work on any `Policy` (`[]` and `[]` for one that cannot report), so wiring them costs a
// call and no knowledge of this module. `plannerReportOf` is the same question asked for the
// whole report — the two lists and the monotone count — and it is on this surface because a
// consumer that wants the **count** (the only monotone thing a policy hands out, and the thing
// the runner baselines on) otherwise has no public path to it: `describing`/`listing` drop it,
// so `@civts/sim`'s own runner reached for the module path instead. Exported beside its two
// narrower readers so the seam has one name on the surface, not three.

export {
  describePlannerFailures,
  plannerFailuresOf,
  plannerReportOf,
  SMART_POLICY,
  SMART_POLICY_NAME,
  smartPolicy,
} from './smart.js';
export type {
  DiagnosedPolicy,
  PlannerFailure,
  PlannerFailureDraft,
  PlannerPhase,
  PolicyReport,
} from './smart.js';
