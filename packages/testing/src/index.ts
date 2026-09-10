/**
 * Invariant machinery shared by self-play, scenarios and property tests.
 * See PLAN.md 7 and 10.
 *
 * Invariants are plain predicate functions over game state. The self-play
 * harness runs them every turn; a violation is a bug, and any seed that
 * triggers one is captured as a regression fixture.
 */

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

export const assertInvariants = <S>(
  state: S,
  invariants: readonly Invariant<S>[],
): void => {
  const violations = runInvariants(state, invariants);
  if (violations.length > 0) {
    throw new Error(
      `invariant violations:\n${violations.map((v) => `  [${v.code}] ${v.detail}`).join('\n')}`,
    );
  }
};
