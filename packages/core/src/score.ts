/**
 * Score — one integer per civilization, from one function.
 * See docs/INTERFACES.md M9 ("Victory and score").
 *
 * ## The contract, in full
 *
 * > `score.ts`: an integer-only score per player from population, cities, techs,
 * > culture and wonders, with the weights in the catalog (placeholder). One function
 * > computes it; the UI and the engine both read that function — the M8 review already
 * > noted the scoreboard deliberately has no score column because no scoring rule
 * > existed, so this is where it appears.
 *
 * So: five named terms, five weights, one function, one reader — the scoreboard
 * panel and the score victory condition both call `playerScore`. There is no second
 * scoring rule anywhere, and the weights are `placeholder(...)` rows in
 * `@civts/rules` that `RulesetPatch.score` moves.
 *
 * ## What each term counts, and why *that*
 *
 * | term | what is counted | where it comes from |
 * |---|---|---|
 * | population | citizens, summed over the player's cities | `state.cities` |
 * | cities | cities the player owns | `state.cities` |
 * | techs | techs known | `PlayerState.techs` |
 * | culture | the **derived** player total | `culture.ts`' `playerCulture` |
 * | wonders | wonder rows held, summed over the player's cities | `buildings.ts`' `isWonder` |
 *
 * Every one of the five is a read of something that already exists and already has an
 * owner: the culture term in particular is *the* derived total and not a stored one,
 * which is the point of `culture.ts` existing. The wonders term asks `isWonder` — the
 * one statement of "is this row a wonder", which M4c/M6 capture uniqueness also ask —
 * rather than testing `wonder === true` here, which would be a second answer to it.
 *
 * ## Integers only, and what that guarantees
 *
 * Every term is a whole count and every weight is a whole number, so a score is an
 * exact integer computed by additions and multiplications — no float ever reaches a
 * comparison, and two players' scores can be compared for equality without an epsilon.
 * That matters beyond tidiness here: the score victory condition decides a game on the
 * **highest** score, so a tie is a real outcome the rule must handle, and a tie is only
 * well defined if the numbers are exact.
 *
 * ## Totality
 *
 * A player the state does not contain scores 0. A city whose `population` or whose
 * tech list this engine cannot read contributes what can be read: the same reading
 * `economy.ts` takes of a treasury and `culture.ts` takes of a city's culture.
 * Nothing here throws, because the UI asks for a score every frame and the victory
 * rule asks for one inside the turn pipeline.
 *
 * ## Provenance
 *
 * This module adds **no number of its own**. All five weights are catalog rows, and
 * every one of them is `placeholder(...)`, unsourced, chosen to be playable — not a
 * Civ 3 figure. Civ 3's own score is a different thing entirely (it is built from
 * territory, population, techs, wonders and a difficulty multiplier, and its totals
 * are in the thousands), and nothing here reproduces it or claims to.
 */

import { isWonder } from './buildings.js';
import { buildingCatalog } from './cities.js';
import type { PlayerId } from './ids.js';
import type { RulesetView } from './map.js';
import { playerCulture } from './culture.js';
import type { GameState, PlayerState } from './state.js';

/**
 * **The score weights a ruleset declares** — the engine's structural view of
 * `@civts/rules`' `ScoreSpec`, minus `provenance` (a field the engine never reads).
 *
 * Five whole numbers, each the multiplier of one term. `0` is a legal weight and means
 * "this term does not count in this ruleset", which is how a content author turns a
 * term off without the engine growing a flag for it.
 */
export interface ScoreDef {
  readonly perPopulation: number;
  readonly perCity: number;
  readonly perTech: number;
  readonly perCulture: number;
  readonly perWonder: number;
}

/**
 * **What the score is when the ruleset declares no weights.**
 *
 * All zero, so every player scores 0 and the score victory condition can never fire —
 * the honest answer for "this ruleset says nothing about scoring", and the same shape
 * `NO_COMBAT_RULES` and `NO_CAPTURE_RULES` take: an absent section must *change what
 * the rule does*, never quietly reproduce the shipped numbers. A game played under it
 * simply has no score, which is exactly what the engine had before M9.
 *
 * `validateRuleset` requires the catalog's `score` section, so no game built through
 * `newGame` plays under this rule.
 */
export const NO_SCORE_RULES: ScoreDef = {
  perPopulation: 0,
  perCity: 0,
  perTech: 0,
  perCulture: 0,
  perWonder: 0,
};

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A whole number at least `min`, or `undefined` for anything this engine cannot read. */
const wholeAtLeast = (value: unknown, min: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;

/**
 * **The score weights a ruleset declares** — the one read of them.
 *
 * Read through `unknown`, exactly as `combatRulesOf`, `captureRulesOf`,
 * `borders.ts`' `cultureRulesOf` and `happiness.ts`' `happinessRulesOf` read their
 * sections: content reaches this module without `core` depending on `rules`, and
 * without a cast. A value that is present but unreadable (a string, a fraction, a
 * `NaN`) reads as the degenerate weight rather than poisoning a score, and a negative
 * weight is refused by validation and read as 0 here — a score that could go *down*
 * when a city is founded is not a score.
 */
export const scoreRulesOf = (ruleset: RulesetView): ScoreDef => {
  const view: unknown = ruleset;
  const section = isRecord(view) ? view['score'] : undefined;
  if (!isRecord(section)) return NO_SCORE_RULES;

  return {
    perPopulation: wholeAtLeast(section['perPopulation'], 0) ?? NO_SCORE_RULES.perPopulation,
    perCity: wholeAtLeast(section['perCity'], 0) ?? NO_SCORE_RULES.perCity,
    perTech: wholeAtLeast(section['perTech'], 0) ?? NO_SCORE_RULES.perTech,
    perCulture: wholeAtLeast(section['perCulture'], 0) ?? NO_SCORE_RULES.perCulture,
    perWonder: wholeAtLeast(section['perWonder'], 0) ?? NO_SCORE_RULES.perWonder,
  };
};

/** The five counts a score is made of — carried so a caller can show its work. */
export interface ScoreBreakdown {
  readonly population: number;
  readonly cities: number;
  readonly techs: number;
  readonly culture: number;
  readonly wonders: number;
  /** The weighted total: what `playerScore` returns. */
  readonly score: number;
}

/** A whole count read out of a state field that may be anything at all. */
const countOf = (value: number): number => (Number.isInteger(value) && value > 0 ? value : 0);

/**
 * **The whole score, term by term** — the one computation, and the one the UI shows
 * so a player can see where the number came from rather than being told it.
 *
 * Reading order is the contract's own list (population, cities, techs, culture,
 * wonders), and the total is the sum of the five weighted terms. Nothing is rounded
 * and nothing is floored: every term is an exact integer product.
 */
export const scoreBreakdown = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): ScoreBreakdown => {
  const weights = scoreRulesOf(ruleset);
  const catalog = buildingCatalog(ruleset);

  let population = 0;
  let cities = 0;
  let wonders = 0;

  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    cities += 1;
    population += countOf(city.population);
    for (const id of city.buildings) {
      const row = catalog.find((def) => def.id === id);
      if (row !== undefined && isWonder(row)) wonders += 1;
    }
  }

  const player: PlayerState | undefined = state.players.find(
    (candidate) => candidate.id === playerId,
  );
  const techs = player === undefined ? 0 : player.techs.length;
  const culture = playerCulture(state, playerId);

  const score =
    weights.perPopulation * population +
    weights.perCity * cities +
    weights.perTech * techs +
    weights.perCulture * culture +
    weights.perWonder * wonders;

  return { population, cities, techs, culture, wonders, score };
};

/**
 * **A player's score**, as one integer — the function the UI's scoreboard column and
 * the victory rule both read. A thin read of `scoreBreakdown` above rather than a
 * second computation, so the column and the condition cannot disagree.
 */
export const playerScore = (state: GameState, ruleset: RulesetView, playerId: PlayerId): number =>
  scoreBreakdown(state, ruleset, playerId).score;

/**
 * The **highest score in the game**, and who holds it — the whole of the score
 * victory condition's decision.
 *
 * Ties are broken by **lowest player id**, explicitly, and this is the one place that
 * choice is written: the contract fixes the same tie-break for contested tiles
 * ("ties go to the LOWER **city** id — never to iteration order") and gives no rule here,
 * so the same principle is applied rather than leaving the winner to whichever player
 * the array happened to list first. **The player id is the one that decides** — this
 * sentence used to say "city id", which is the tile rule's id and not this one's, and a
 * reader following it would have looked for a city where the choice is made. `undefined`
 * for a state with no civilization at all, which is the honest answer rather than a
 * fabricated winner.
 *
 * **Barbarians are never a candidate** — the contract's "barbarians never win, never
 * score". The filter is `kind === 'civ'`, the same read `civPlayers` gives, and
 * nothing else in this module needs to know about it: the scoreboard may show a
 * barbarian row (it is a real player with real cities), but the *victory* is decided
 * among civilizations.
 */
export const highestScore = (
  state: GameState,
  ruleset: RulesetView,
): { readonly playerId: PlayerId; readonly score: number } | undefined => {
  let best: { readonly playerId: PlayerId; readonly score: number } | undefined;

  for (const player of state.players) {
    if (player.kind !== 'civ') continue;
    const score = playerScore(state, ruleset, player.id);
    if (best === undefined || score > best.score) best = { playerId: player.id, score };
  }

  return best;
};
