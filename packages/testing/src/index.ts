/**
 * Invariant machinery shared by self-play, scenarios and property tests.
 * See PLAN.md 7 and 10.
 *
 * Invariants are plain predicate functions over game state. The self-play
 * harness runs them every turn; a violation is a bug, and any seed that
 * triggers one is captured as a regression fixture.
 *
 * Also re-exports canonical JSON + FNV-1a 64 hashing (PLAN.md 5.3) and the
 * scenario DSL (docs/INTERFACES.md M2, "Scenario DSL"): hand-built worlds, run
 * as tests, which is what M2's acceptance evidence is made of.
 */

export { canonicalize } from './canonical.js';
export { fnv1a64, hashValue } from './hash.js';

// The test tiers (M5's A5 criterion). Exported from the package rather than declared in
// each suite, so "which tier is this run?" has one answer that every test file and the
// `package.json` scripts read: a per-file `process.env` read would be as many statements
// of the rule as there are suites, and the two that disagreed would do so silently.
export { FULL_TIER, FULL_TIER_VALUE, TIER_ENV, FULL_TIER_COMMAND } from './tier.js';

export {
  createScenarioBuilder,
  defineScenario,
  runScenario,
  runScenarioAgainst,
} from './scenario.js';
export type {
  Scenario,
  ScenarioAssertion,
  ScenarioBuilder,
  ScenarioRunResult,
  ScenarioSettings,
} from './scenario.js';

export interface InvariantViolation {
  /** Stable machine-readable code, e.g. `negative-stockpile`. */
  readonly code: string;
  readonly detail: string;
}

export type Invariant<S> = (state: S) => readonly InvariantViolation[];

export const runInvariants = <S>(
  state: S,
  invariants: readonly Invariant<S>[],
): readonly InvariantViolation[] => invariants.flatMap((invariant) => invariant(state));

export const violation = (code: string, detail: string): InvariantViolation => ({ code, detail });

export const assertInvariants = <S>(state: S, invariants: readonly Invariant<S>[]): void => {
  const violations = runInvariants(state, invariants);
  if (violations.length > 0) {
    throw new Error(
      `invariant violations:\n${violations.map((v) => `  [${v.code}] ${v.detail}`).join('\n')}`,
    );
  }
};
