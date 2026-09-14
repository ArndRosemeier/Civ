/**
 * Victory — the conditions, the outcome, and the one place a game ends.
 * See docs/INTERFACES.md M9 ("Victory and score").
 *
 * ## The frozen shape, and the reading that makes it safe
 *
 * ```
 * GameOutcome = { kind: 'victory' | 'defeat' | 'draw'; condition: VictoryConditionId;
 *                 winner: PlayerId | null; turn: number }
 * ```
 *
 * > "…a DERIVED value on the result/state read, **never a stored flag that can disagree
 * > with the board**. A finished game REFUSES further commands with a typed error."
 *
 * **Every function here recomputes.** `gameOutcomeOf` is a pure function of
 * `(state, ruleset)` — the board, the culture totals, the ownership layer, the scores
 * and the catalog's horizon — and nothing caches it. There is no `GameState.outcome`
 * field, for the same reason there is no stored unhappy count and no stored player
 * culture: this wave's whole design is that a value two places must agree about is a
 * value that will disagree, and `m9-m10-adversarial.test.ts` sweeps seeds and turns for
 * exactly that disagreement.
 *
 * The cost of recomputing is real and stated: the ownership layer is counted and every
 * civilization's score is summed on each call. It is bounded by the map and the player
 * count, it happens once per command in `applyCommand`, and it buys the property the
 * contract asks for. `score.ts`' five terms are all O(cities) reads.
 *
 * ## The four conditions
 *
 * > - **conquest** — you are the last civilization holding a city (if you own cities and
 * >   every other civilization owns none, you win);
 * > - **domination** — you own at least `DOMINATION_LAND_PCT` of the land tiles that any
 * >   city claims, or at least `DOMINATION_POP_PCT` of the world population;
 * > - **cultural** — your total culture reaches `CULTURAL_VICTORY_CULTURE`;
 * > - **score** — at the turn limit, the highest score wins.
 *
 * **The domination line above is quoted from the contract, and BOTH of its clauses are
 * overruled.** The AMENDMENT at the end of `docs/INTERFACES.md` rules the implementation
 * correct and that wording wrong: domination requires **both** shares, and the land share
 * is over the **MAP's** land tiles, never the land "any city claims". `dominationWinner`
 * below states the rule and the measurement that forced it; `@civts/rules`' `VictorySpec`
 * and its `victory` section say the same thing in their own prose, so a reader of the
 * engine and a reader of the catalog are told one rule.
 *
 * Each is a predicate over one player (`conquestWinner`, `dominationWinner`,
 * `culturalWinner`, `scoreWinner`), and every threshold is a `placeholder(...)` row in
 * `@civts/rules` that `RulesetPatch.victory` moves. **None of them is a Civ 3 figure**:
 * Civ 3's cultural victory counts culture accumulated in individual cities where this
 * engine's is a player total, and Civ 3's turn limit depends on map size and difficulty,
 * where this engine's is one catalog number — readings stated here rather than presented
 * as fidelity. Domination is the one condition whose *shape* this engine deliberately
 * matches (both shares, held together); its two magnitudes are still our own, measured
 * over the map's whole land.
 *
 * **Space race is deferred**, and the contract asks for it to be named rather than
 * silently absent: there is no `VictoryConditionId` for it and no catalog row, because
 * a space race needs a whole parts-and-launch subsystem. The catalog's `victory` section
 * says so in its own provenance note, and so does this comment — the two places a reader
 * would look.
 *
 * ## Barbarians are not a civilization
 *
 * > `civPlayers()` decides "civilization" — barbarians never win, never score, and never
 * > count toward another player's conquest.
 *
 * One clause, in one place: `civPlayers(state)` is the candidate list below. A barbarian
 * holding every city in the world is therefore not a winner and does not deny a
 * civilization its conquest victory — the contract's own reading, which
 * `m9-m10-adversarial.test.ts` constructs the world for and checks.
 *
 * ## Determinism
 *
 * Every threshold is a whole number, every comparison is an integer comparison (the
 * percentage tests are multiplied out so no division and no float can enter), and
 * players are visited in **id order**, so "the first civilization to satisfy a
 * condition" is a function of the data rather than of array order. Nothing here reads
 * the RNG, a clock or the environment.
 */

import { ownedLandTiles } from './borders.js';
import { playerCulture } from './culture.js';
import type { PlayerId } from './ids.js';
import { landTileCount, type RulesetView } from './map.js';
import { highestScore, playerScore } from './score.js';
import { civPlayers, type GameState, type PlayerState } from './state.js';
import {
  NO_VICTORY_RULES,
  VICTORY_CONDITION_ORDER,
  victoryRulesOf,
  type VictoryConditionId,
  type VictoryRules,
} from './victory-rules.js';

export type { VictoryConditionId } from './victory-rules.js';

/**
 * Every condition, in the canonical order they are evaluated in.
 *
 * The `satisfies` clause is the contract between this list and
 * `victory-rules.ts`': the tuple must be exactly the catalog's ids, so a condition
 * added to one side and not the other is a **typecheck failure** rather than two
 * orders that quietly differ. That is the same technique `@civts/rules` uses for
 * `VictoryConditionId` in its own section check.
 */
export const VICTORY_CONDITIONS = VICTORY_CONDITION_ORDER satisfies readonly VictoryConditionId[];

/**
 * The end of a game — the frozen shape, plus the two facts a caller cannot re-derive
 * without re-running the rule.
 *
 * `kind` is **relative to the player who is asking**, which is the only reading under
 * which one value serves both "a victory/defeat screen" (A1) and a headless
 * simulation: `victory` when `winner` is the acting player, `defeat` when somebody else
 * won, `draw` when nobody did. A run with no acting player — the batch, the tournament —
 * reads `winner` directly, and `winner: null` is what a draw looks like from there.
 *
 * `turn` is the turn the game ended **on**: the state's own `turn` at the moment the
 * condition first held. It is carried because a caller is usually holding a state after
 * the turn advanced, and "which turn did this end?" is a question the outcome has to
 * answer by itself — A3's acceptance evidence asks for "the exact turn and winner".
 */
export interface GameOutcome {
  readonly kind: 'victory' | 'defeat' | 'draw';
  readonly condition: VictoryConditionId;
  readonly winner: PlayerId | null;
  readonly turn: number;
}

/**
 * What a condition decided, before it is turned into an outcome for one particular
 * player: who won and by what — or `null` when no condition holds.
 */
export interface VictoryResult {
  readonly condition: VictoryConditionId;
  /** The winner, or `null` for a draw. `null` only ever comes from the score condition. */
  readonly winner: PlayerId | null;
}

/**
 * **Is this civilization on the board at all?** — it owns a city or commands a unit.
 *
 * The one place "this player is in the game" is decided, read from the two arrays a player's
 * presence is recorded in. Its complement is what conquest needs, and it is deliberately *not*
 * called "eliminated": a civilization the state does not mention at all has not been
 * conquered — it has not been placed. The difference matters because a hand-built state (a
 * structural fixture, an M2-era board, a unit test) routinely lists two players and gives one
 * of them nothing, and reading that as "the other player wiped them out" ends the game before
 * the test runs. **A real game always places every civilization** (`newGame` gives each one a
 * settler and a worker), so for a played game the two readings coincide and this one costs
 * nothing.
 */
const isInPlay = (state: GameState, playerId: PlayerId): boolean =>
  state.cities.some((city) => city.owner === playerId) ||
  state.units.some((unit) => unit.owner === playerId);

/**
 * **Conquest** — `player` owns at least one city and every *other civilization* is off the
 * board.
 *
 * The contract's own simpler reading is "you are the last civilization holding a city (if you
 * own cities and every other civilization owns none, you win)", and this is that sentence with
 * the clarification that makes it a rule about elimination rather than about the opening
 * position. Two clarifications, in fact, and both were forced by measurement:
 *
 * 1. **"Owns none" is read through `isInPlay`**, so a civilization that has no city *yet* but
 *    still commands a settler is not conquered. The pipeline founds cities in player-id order
 *    *inside one turn*, so under the literal reading the first civilization to found its
 *    capital is instantly "the last civilization holding a city" — and `applyCommand` refuses
 *    commands on a finished game, so nobody else ever founds one. Measured: every seed of a
 *    3-civilization `SMART_POLICY` run ended in conquest on turn 1. That is not a victory, it
 *    is the reading being wrong.
 * 2. **A world with no other civilization at all is not a conquest.** One civilization is a
 *    state without a contest, not a won one; there is nobody to have eliminated. `newGame`
 *    never produces such a state (`civCount >= 2`), and a fixture that does would otherwise be
 *    terminal before its first assertion.
 *
 * Barbarians are not civilizations, so a barbarian horde holding the map neither denies a
 * conquest victory nor wins one. A player with no cities never wins by conquest — an empty
 * world is not a conquered one — which is the first clause.
 */
const conquestWinner = (state: GameState, player: PlayerState): boolean => {
  if (!state.cities.some((city) => city.owner === player.id)) return false;
  const others = civPlayers(state).filter((other) => other.id !== player.id);
  if (others.length === 0) return false;
  return !others.some((other) => isInPlay(state, other.id));
};

/** A whole, non-negative population read out of a city that may be anything. */
const citizensOf = (population: number): number =>
  Number.isInteger(population) && population > 0 ? population : 0;

/**
 * **Domination** — `player` holds at least the land share **and** at least the population
 * share the catalog names.
 *
 * ## Why AND, when the contract writes "or"
 *
 * The contract's line is "you own at least `DOMINATION_LAND_PCT` of the land tiles that any
 * city claims, or at least `DOMINATION_POP_PCT` of the world population". Read as **OR** with
 * those two denominators, domination is a turn-1 rule, and the measurements are not close:
 *
 * - *land*: a share of the claimed land is a share of a quantity that exists only because the
 *   player claimed it. On turn 1 the first civilization's capital owns **5 of the 5** claimed
 *   tiles — 100 % — and `60 %` is met before anybody else has been polled.
 * - *population*: the first civilization's one citizen is **all** of the world's citizens, so
 *   it holds 100 % of the world population and `40 %` is met by the same founding.
 *
 * Both were measured: a 2-civilization `tiny` run under a plain found-a-city driver ends in
 * domination on turn 1 with `winner: 0`, and every seed of a 3-civilization run does the same.
 * `applyCommand` refuses commands on a finished game, so the other civilizations never found
 * at all, and the game is over before anybody has played. A victory that fires on the opening
 * position is not a victory condition; it is a reading error with a green test attached.
 *
 * ## The three repairs, which the contract's own amendment now confirms
 *
 * The **AMENDMENT at the end of `docs/INTERFACES.md`** rules for this implementation and
 * against the frozen sentence: "Civ 3's domination victory requires both shares, so 'or'
 * would have been the less faithful reading … and a land share measured against *claimed*
 * land is a moving denominator that a player can lower by claiming less, which makes the
 * condition easier the worse you play." The three repairs below are therefore the rule, not
 * a deviation from it.
 *
 * 1. **The land denominator is the map's land**, not the land anybody claims — see
 *    `landTileCount`. A percentage of the world's ground is a number a player can plan toward
 *    and a number that does not move when they make progress.
 * 2. **Both shares must hold.** AND is this engine's reading of the sentence, and it is the
 *    reading the two named thresholds ask for: each is a *strict* share of the world (60 % of
 *    its land, 40 % of its people), and a domination victory that needs only one of two stated
 *    requirements would leave the other magnitude unreachable in practice — a swept knob whose
 *    value could be changed with no effect on any game, which is exactly what the standing
 *    requirement's third clause exists to prevent. Both are reachable together: the shipped
 *    land share is 60 % and the population share 40 %, and a player who holds most of the
 *    world's ground almost always holds most of its citizens.
 * 3. **The land numerator counts LAND** (`ownedLandTiles`, `borders.ts`) — the third repair,
 *    R1's. The first two left the two halves of the fraction counting different kinds of tile:
 *    `computeTileOwner` claims a **geometric disc** with no terrain filter, so a coastal city
 *    claims its bay as well as its fields, and the old numerator counted every claimed tile
 *    while the denominator counted only land. Measured (`scripts/probes/land-numerator-probe.ts`,
 *    re-runnable): on eight AI-played `tiny` games at 200 turns, **713 of 1,793 owned tiles —
 *    40 % — were water**, so the two readings of the share differ by up to 1.5× on real boards
 *    (tiny seed 42 player 0: 4.9 % of the map's land counting the bay, 3.4 % counting land).
 *    What did **not** move is any outcome: the twenty-seed tournaments at 100, 150 and 200 turns
 *    are identical game for game — census, winners, per-game final hashes, check totals — as are
 *    the six goldens and every scenario, because no policy this engine ships has ever reached
 *    even a fifth of the map's land. So the repair costs nothing observable and removes a rule
 *    that stated a share of the world's ground while measuring a share of its ground *and sea*.
 *    `packages/core/test/victory.test.ts` pins it on a board built so the two numerators
 *    disagree and the verdict turns on which one is used.
 *
 * Neither share can be won in a world with no denominator: a map with no land, or a world
 * with no citizens, is a world with no domination victory — stated rather than left to the
 * arithmetic to decide by accident. The comparison is multiplied out into integers
 * (`owned * 100 >= pct * total`), so no division and no float enters.
 *
 * The land denominator is a function of the map and the ruleset alone, so it is computed once
 * per call and read by every player; the numerator is a read of the ownership layer, one pass
 * over it per player. The population denominator counts **barbarian cities too**, because "the
 * world population" is a fact about the world.
 */
const dominationWinner = (
  state: GameState,
  ruleset: RulesetView,
  rules: VictoryRules,
  player: PlayerState,
): boolean => {
  const land = landTileCount(state.map, ruleset);
  if (land <= 0) return false;
  if (ownedLandTiles(state, ruleset, player.id) * 100 < rules.dominationLandPct * land)
    return false;

  let world = 0;
  let own = 0;
  for (const city of state.cities) {
    const citizens = citizensOf(city.population);
    world += citizens;
    if (city.owner === player.id) own += citizens;
  }

  return world > 0 && own * 100 >= rules.dominationPopPct * world;
};

/**
 * **Cultural** — `player`'s total culture reaches the catalog's threshold.
 *
 * The total is `culture.ts`' `playerCulture`, the *derived* sum of the player's cities
 * and never a stored counter — which is the contract's own insistence, and the reason a
 * checker for "the two agree" has nothing to check: there is one number.
 *
 * The comparison is `>=`, the contract's word ("reaches"), so the boundary is
 * inclusive: at exactly the threshold the victory fires. `m9-m10-adversarial.test.ts`
 * tests it **at** the value and one below.
 */
const culturalWinner = (state: GameState, rules: VictoryRules, player: PlayerState): boolean =>
  playerCulture(state, player.id) >= rules.culturalVictoryCulture;

/**
 * **Score** — evaluated only at the catalog's horizon, and decided by the highest
 * score, with ties going to the **lowest player id**.
 *
 * `highestScore` owns both the maximum and the tie-break, so this function adds nothing
 * to it but the horizon test — one computation, one reading.
 *
 * **A tie is not a draw, and this paragraph used to say it was.** The corrected sentence is
 * the one above and the one `highestScore` implements: equal scores go to the **lowest player
 * id**, and `winner: null` is reached only by a world with **no civilization at all** (every
 * candidate is a barbarian, or the state lists none). The stale wording — "a world whose
 * civilizations all score the same is a draw" — was not a harmless comment: it described a
 * value this function cannot return, so a verifier's draw-arm mutation on a tied board looked
 * vacuous when the literal reading of this comment said the board was a draw and the engine
 * correctly named player 0. The engine's own answer is what the tests pin: Q3's B3 read
 * `{"condition":"score","winner":0}` off two do-nothing civilizations level at zero, against
 * `winner: null` for the same board with every player relabelled barbarian.
 *
 * A draw is a real outcome and not a failure — it says the world contains nobody who can win,
 * which is a fact about the state rather than a failure to decide.
 */
const scoreWinner = (
  state: GameState,
  ruleset: RulesetView,
  rules: VictoryRules,
): VictoryResult | null => {
  if (state.turn < rules.scoreVictoryTurn) return null;
  const best = highestScore(state, ruleset);
  return { condition: 'score', winner: best === undefined ? null : best.playerId };
};

/**
 * **The end of the game, or `null` while it is still being played** — the one statement
 * of the victory rule, and the function `applyCommand` refuses on, the runner reports
 * from and the UI draws.
 *
 * ## The turn-limit question, answered once
 *
 * The score condition's horizon is `VictoryRules.scoreVictoryTurn` — the **catalog's**
 * number, not the caller's `maxTurns`. A simulation's `maxTurns` is an experiment
 * budget with a different owner: making it the game's horizon would make the same seed
 * end differently under two batch sizes. So `gameOutcomeOf` takes no turn-limit
 * parameter at all, and every caller — the runner, the CLI, the UI, an invariant —
 * asking "has this game ended?" gets the same answer for the same board. See
 * `victory-rules.ts` for what that means for a run that stops early.
 *
 * ## Evaluation order
 *
 * Conditions are tried in the catalog's canonical order — conquest, domination,
 * cultural, score — and the first that holds decides. That is a **rule**, not an
 * accident of the `switch` below: two conditions can hold on the same turn (a player can
 * cross the culture threshold on the turn it takes the last enemy city), and "which one
 * ended the game" has to be a function of the state rather than of the order somebody
 * wrote the branches in. `VICTORY_CONDITIONS` *is* that order, the catalog declares its
 * rows in it, and `validateRuleset` refuses a section that does not.
 *
 * ## Player order
 *
 * Civilizations are visited in **id order**, so the lowest id wins a tie — the same
 * principle the tile tie-break uses, applied here because a tie is real: two players can
 * both be over the culture threshold when the rule runs, and only one game can end.
 */
export const gameOutcomeOf = (state: GameState, ruleset: RulesetView): VictoryResult | null => {
  const rules = victoryRulesOf(ruleset);
  const candidates = [...civPlayers(state)].sort((a, b) => Number(a.id) - Number(b.id));

  for (const condition of VICTORY_CONDITIONS) {
    if (condition === 'score') {
      const scored = scoreWinner(state, ruleset, rules);
      if (scored !== null) return scored;
      continue;
    }

    const winner = candidates.find((player) => {
      switch (condition) {
        case 'conquest':
          return conquestWinner(state, player);
        case 'domination':
          return dominationWinner(state, ruleset, rules, player);
        case 'cultural':
          return culturalWinner(state, rules, player);
      }
    });

    if (winner !== undefined) return { condition, winner: winner.id };
  }

  return null;
};

/**
 * **Is this game over?** — the read `applyCommand` gates on and the runner stops on.
 *
 * A pure recomputation (see the module note), so a state that has never been through a
 * turn — every `newGame` state, every hand-built fixture — answers `false` unless it
 * genuinely satisfies a condition.
 */
export const isGameOver = (state: GameState, ruleset: RulesetView): boolean =>
  gameOutcomeOf(state, ruleset) !== null;

/**
 * The outcome as a **caller-relative** `GameOutcome`, for a player who is watching.
 *
 * `undefined` while the game is running. This is what the UI and the CLI use: the rule
 * gives the condition, the winner and the turn, and this decides whether that is the
 * watching player's victory or defeat. `winner: null` — the draw — answers `draw` for
 * everybody.
 *
 * `playerId` is optional because the headless half has no "you": a caller that passes
 * nothing gets `defeat` for any game somebody won, which is the honest reading of
 * "somebody won and it was not nobody".
 */
export const outcomeFor = (
  state: GameState,
  ruleset: RulesetView,
  playerId?: PlayerId,
): GameOutcome | undefined => {
  const outcome = gameOutcomeOf(state, ruleset);
  if (outcome === null) return undefined;

  const winner = outcome.winner;
  const kind: GameOutcome['kind'] =
    winner === null ? 'draw' : playerId !== undefined && winner === playerId ? 'victory' : 'defeat';

  return { kind, condition: outcome.condition, winner, turn: state.turn };
};

/**
 * Every condition that holds for `playerId`, in the canonical order — the predicate
 * list, exposed so a UI can render "you are 40 culture from winning" without
 * re-implementing a threshold.
 *
 * Unlike `gameOutcomeOf`, this does **not** stop at the first: it answers "what is
 * true", where the outcome answers "what ended the game". A player over the culture
 * threshold while also the last civilization standing is reported as both here and as
 * `conquest` there, which is what makes the ordering rule observable rather than
 * hidden.
 *
 * An empty list for a barbarian — it is not a candidate for any condition — and for an
 * unknown player.
 */
export const conditionsMetBy = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
): readonly VictoryConditionId[] => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined || player.kind !== 'civ') return [];

  const rules = victoryRulesOf(ruleset);
  const met: VictoryConditionId[] = [];

  for (const condition of VICTORY_CONDITIONS) {
    switch (condition) {
      case 'conquest':
        if (conquestWinner(state, player)) met.push(condition);
        break;
      case 'domination':
        if (dominationWinner(state, ruleset, rules, player)) met.push(condition);
        break;
      case 'cultural':
        if (culturalWinner(state, rules, player)) met.push(condition);
        break;
      case 'score':
        if (state.turn >= rules.scoreVictoryTurn) met.push(condition);
        break;
    }
  }

  return met;
};

/**
 * The score of every player, in **id order** — the scoreboard's row source, and the
 * reader that answers the M8 review's note ("the scoreboard deliberately has no score
 * column because no scoring rule existed").
 *
 * Barbarians are included, because they are a real player with real cities and the
 * scoreboard shows players; `highestScore` is where "barbarians never win" is decided,
 * once. A UI that wants civilizations only filters with `civPlayers` itself, which is the
 * one statement of that filter.
 *
 * **A barbarian's row here is always 0 in a real game, and that is a consequence rather
 * than a special case.** Every term of `score.ts`' sum is read from cities, techs, culture
 * and wonders, and a barbarian player has no cities *of its own*: `barbarians.ts` gives it
 * units, and the cities it owns are cities it has captured, which is exactly the case the
 * sum does not exclude. So the barbarians' row is included here — the number the engine
 * computes — and M10's "barbarians never score" is asserted where it is decided, which is
 * that only `civPlayers` may win. A caller that wants a civilization-only scoreboard
 * filters with `civPlayers`, and `victory.ts`' own `highestScore` already does.
 *
 * `playerScore` is `score.ts`' function, not a second computation, so a column and a
 * condition cannot disagree about a number.
 */
export const scoreTable = (
  state: GameState,
  ruleset: RulesetView,
  options?: { readonly civilizationsOnly?: boolean },
): readonly { readonly playerId: PlayerId; readonly score: number }[] => {
  // `civilizationsOnly` is the *caller's* choice rather than this function's, and it is a
  // parameter rather than a second function so the two lists cannot come from two
  // different reads of `civPlayers` — the filter is applied to one array, once.
  const players = options?.civilizationsOnly === true ? civPlayers(state) : state.players;
  return [...players]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((player) => ({ playerId: player.id, score: playerScore(state, ruleset, player.id) }));
};

/**
 * The horizon the score condition fires at, read from the catalog — exported so a UI can
 * say "the game ends on turn N" without hard-coding a number or asking the engine for a
 * different one.
 */
export const scoreHorizon = (ruleset: RulesetView): number =>
  victoryRulesOf(ruleset).scoreVictoryTurn;

/** Named re-export so a caller that only has a ruleset can reach the fallback for a test. */
export { NO_VICTORY_RULES };
