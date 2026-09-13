/**
 * The victory thresholds a ruleset declares — the one read of them.
 * See docs/INTERFACES.md M9 ("Victory and score").
 *
 * ## Why this is a module of its own, next to `victory.ts`
 *
 * `victory.ts` is the *rule* — which conditions exist, what each one means, how a tie
 * breaks and in what order they are tried. This file is the *content*: the four
 * numbers, read out of a ruleset that may be a validated `@civts/rules` catalog, a
 * hand-built fixture or a foreign object.
 *
 * Everything that *evaluates* a condition is in `victory.ts`; everything that *knows a
 * number* is here. The standing requirement's third clause — every magnitude in the
 * catalog, reachable through `RulesetPatch` — is honoured by the four fields below and
 * by nothing else, and this module owns no number of its own: it reads what the rows
 * declare and nothing more.
 *
 * ## `scoreVictoryTurn` is the one that is easy to get wrong
 *
 * It is the **horizon the catalog declares**: the turn at which the score condition is
 * evaluated. A simulation's `maxTurns` is an *experiment budget* — "play at most this
 * many turns and stop" — and the two are deliberately different numbers with different
 * owners. Letting `maxTurns` be the score horizon would make the game's own rules
 * depend on how long a caller chose to run it, so the same seed could end in a score
 * victory under one batch size and not under another. The horizon is content, and
 * content belongs in the catalog.
 *
 * What that means in practice, stated because it is observable: a run whose `maxTurns`
 * is below the catalog's horizon stops at `max-turns` with **no** winner
 * (`GameState.outcome` stays absent), which is the honest report of "the experiment
 * ended before the game did". A run that reaches the horizon records the score
 * outcome. `m9-m10-adversarial.test.ts` drives both.
 *
 * ## Provenance
 *
 * Every number is a `placeholder(...)` row in `@civts/rules`, unsourced, chosen to be
 * playable, and **not** a Civ 3 figure — the catalog's own provenance notes say so per
 * row. Civ 3's domination needs a share of land *and* of population together, its
 * cultural victory counts culture in individual cities, and its turn limit depends on
 * the map size and the difficulty; none of that is reproduced here.
 */

import type { RulesetView } from './map.js';

/**
 * Which condition ended the game — the contract's own four ids, as a closed union so a
 * consumer's `switch` is checked by the compiler.
 *
 * Declared here rather than in `victory.ts` because the *catalog* names them: the
 * `victory` section is a list of rows keyed by these ids, `validateRuleset` checks that
 * every one of them is present exactly once and in order, and a content package that
 * cannot name a condition could not declare a threshold for it. `victory.ts` imports
 * the type from here, so there is one vocabulary and not two.
 */
export type VictoryConditionId = 'conquest' | 'domination' | 'cultural' | 'score';

/**
 * The condition order, which is **load-bearing twice**: it is the order
 * `victory.ts` evaluates conditions in (the first that holds decides the game) and the
 * order the catalog must declare its rows in.
 *
 * Both halves matter and both are checked. The evaluation half is checked by
 * `victory.ts`' own `satisfies` clause on its `VICTORY_CONDITIONS` tuple — a second
 * list there would be a second order, and the compiler refuses one that is not this.
 * The catalog half is checked by `validateRuleset`, which cannot import this module
 * (`@civts/rules` does not depend on `core`'s internals) and therefore restates the
 * three strings in its own section check; the two are held together by
 * `rules.test.ts`, which asserts the shipped section's row order by id.
 */
export const VICTORY_CONDITION_ORDER: readonly VictoryConditionId[] = [
  'conquest',
  'domination',
  'cultural',
  'score',
];

/**
 * **The victory magnitudes a ruleset declares** — the engine's structural view of
 * `@civts/rules`' `VictorySpec`, minus `provenance` (a field the engine never reads),
 * exactly as `CaptureDef` mirrors `CaptureSpec`.
 *
 * Four numbers, each with one reader in `victory.ts`:
 *
 * - `dominationLandPct` — the share of the land *any city claims* that wins;
 * - `dominationPopPct` — the share of the *world's* citizens that wins;
 * - `culturalVictoryCulture` — the player's total culture that wins;
 * - `scoreVictoryTurn` — the turn at which the highest score wins.
 */
export interface VictoryRules {
  /** Percent (`0..100`) of the land any city claims. */
  readonly dominationLandPct: number;
  /** Percent (`0..100`) of the world's citizens. */
  readonly dominationPopPct: number;
  /** The player's total culture that wins; `>= 1`. */
  readonly culturalVictoryCulture: number;
  /** The turn the score condition is evaluated at; `>= 1`. */
  readonly scoreVictoryTurn: number;
}

/**
 * **What victory does when the ruleset declares no victory section.**
 *
 * Every threshold is set so that **no condition can ever fire**: a domination share of
 * `101` percent is unreachable, the culture threshold is the largest safe integer, and
 * the score horizon is likewise beyond any run. That is the honest reading of "this
 * ruleset says nothing about victory" — a game that cannot end — and it is what keeps
 * every M2–M8 fixture, and every structural `RulesetView` in the tree, playing exactly
 * as it did before M9. It is the counterpart of `NO_BORDER_RULES` and
 * `NO_HAPPINESS_RULES`, which take the same "an absent section must change what the
 * rule does" position from the other direction: there the change is "nothing happens",
 * here it is "nothing ends", which is the same statement.
 *
 * **Why not the shipped numbers?** Because a fallback that reproduced them would be the
 * dual-source bug M6b and M7 remove, one milestone later: moving
 * `culturalVictoryCulture` in the catalog would then leave every game played through a
 * section-less view ending on a threshold nobody can see or sweep. A real game never
 * meets this: `validateRuleset` requires the catalog's `victory` section.
 */
export const NO_VICTORY_RULES: VictoryRules = {
  dominationLandPct: 101,
  dominationPopPct: 101,
  culturalVictoryCulture: Number.MAX_SAFE_INTEGER,
  scoreVictoryTurn: Number.MAX_SAFE_INTEGER,
};

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A whole percentage in `0..100`, or `undefined` for anything this engine cannot read.
 *
 * The bound matters more than usual here: `victory.ts` compares by multiplying out
 * (`owned * 100 >= pct * total`), and a percentage of `1000` read out of a malformed
 * catalog would make every player a domination winner on turn one.
 */
const percentOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined;

/** A whole number at least `min`, or `undefined` for anything this engine cannot read. */
const wholeAtLeast = (value: unknown, min: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;

/**
 * **The victory magnitudes a ruleset declares** — the one read of them.
 *
 * Read through `unknown`, exactly as `combatRulesOf`, `captureRulesOf`,
 * `borders.ts`' `cultureRulesOf`, `happiness.ts`' `happinessRulesOf` and `score.ts`'
 * `scoreRulesOf` read their sections, so content reaches this module without `core`
 * depending on `rules` and without a cast. A field that is present but unreadable reads
 * as the degenerate value rather than as a `NaN`, a negative or a percentage above 100
 * that would silently end games.
 *
 * **The one cross-field rule this reader does not enforce**: that the section's rows are
 * all present and in the canonical condition order is `validateRuleset`'s business, not
 * a reader's. A reader stays total; validation is what refuses.
 */
export const victoryRulesOf = (ruleset: RulesetView): VictoryRules => {
  const view: unknown = ruleset;
  const section = isRecord(view) ? view['victory'] : undefined;
  if (!isRecord(section)) return NO_VICTORY_RULES;

  return {
    dominationLandPct:
      percentOf(section['dominationLandPct']) ?? NO_VICTORY_RULES.dominationLandPct,
    dominationPopPct: percentOf(section['dominationPopPct']) ?? NO_VICTORY_RULES.dominationPopPct,
    culturalVictoryCulture:
      wholeAtLeast(section['culturalVictoryCulture'], 1) ?? NO_VICTORY_RULES.culturalVictoryCulture,
    scoreVictoryTurn:
      wholeAtLeast(section['scoreVictoryTurn'], 1) ?? NO_VICTORY_RULES.scoreVictoryTurn,
  };
};
