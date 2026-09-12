/**
 * Combat resolution — **the ONE statement of the odds** (docs/INTERFACES.md M6,
 * "Combat resolution"; PLAN.md §5.3 determinism).
 *
 * Everything a battle is made of lives here and nowhere else: the modifier table, the
 * per-round win chance, the tie rule, the damage-per-round rule and the loop that
 * applies them. A caller supplies the *inputs* — the two sides' statistics, the
 * defender's bonuses, the two units' current hit points — and the **RNG state**, and
 * gets back a `CombatResult` plus the next RNG state. No other module may re-derive
 * any of it: a second copy of "how likely is the attacker to win this round" is a
 * second game, and the whole point of putting combat in its own module is that the
 * UI, the AI, the balanced sweep and the test suite all read the same numbers.
 *
 * ## Purity
 *
 * `resolveCombat` **takes the RNG state and returns the next one**. It does not reach
 * into the world, does not read `GameState`, and does not draw from any ambient
 * source:
 *
 * - No `Math.random` (banned outright in this package), no clock, no I/O.
 * - Every constant is named and exported, so a balance sweep can read the magnitude it
 *   is sweeping instead of guessing at a literal.
 * - The result carries the **per-round win chance** (`attackerWinPct`) *and* the exact
 *   integer draw that produces it (`attackerWinsBelow`, of `ROLL_BOUND` values), so a
 *   scenario can assert the odds directly rather than re-deriving them from the
 *   constants — and a re-derivation cannot silently drift from the resolver.
 * - Given the same context and the same RNG state, the result is *identical*, which is
 *   what makes a battle reproducible from the game seed. That is also why the RNG is a
 *   parameter rather than a field: a pure function cannot forget to thread it.
 *
 * ## The modifier rule — summed, then floored ONCE
 *
 * M4c established this for a city's output multipliers and M6 inherits it verbatim,
 * for the same reason: **flooring twice gives a different number.** So the defender's
 * bonuses are *added as percentages* and applied to its defence with a single floor at
 * the end:
 *
 * ```
 * defence' = floor(defence * (100 + terrainBonus + fortifyBonus + cityBonus + wallsBonus) / 100)
 * ```
 *
 * `combat.test.ts` pins a case where the summed-then-floored answer differs from
 * flooring each modifier separately, so "simplify this into a loop that multiplies one
 * bonus at a time" fails a test rather than quietly changing the game.
 *
 * ## The tie rule
 *
 * **The defender wins ties, and that is stated rather than implied.** The attacker wins
 * a round only when its draw is *strictly below* the win threshold; a draw exactly at
 * the threshold is a defender win. Written as an explicit comparison (see `drawsWin`)
 * because a tie rule expressed by the *shape* of a comparison is a tie rule that
 * changes the first time somebody reorders it.
 *
 * ## Integer-only, and why the odds are a percentage
 *
 * Both sides are integers (`attack`, `defence`, `bonusPct`, hit points) and every
 * intermediate is an integer: percentages add, and the only division is a floored
 * division. Combat randomness comes from `rng.ts`'s `nextBelow(rng, 100)` — an integer
 * in `[0, 100)` — so a battle is reproducible from the seed and needs no transcendental
 * (which this package bans, because each engine ships its own `libm`).
 *
 * ## Every number here is a PLACEHOLDER
 *
 * The five bonus percentages, the roll bound, the damage-per-round rule (one hit point
 * per round won) and the 1..99 clamp on the odds are **unsourced values of ours, chosen
 * to be playable**. None of them is traced to Civ 3, and none is presented as Civ 3's:
 * the real game's firepower/hit-point model, its terrain bonuses and its combat
 * resolution are different and are unverified here. They live in named, exported
 * constants so a balance sweep can move one of them without editing this file
 * (INTERFACES.md, "STANDING REQUIREMENT — simulation-first": *Tunable*).
 */

import { nextBelow, type RngState } from './rng.js';

/* ------------------------------------------------------------------ *
 * The modifier table — every magnitude, named, in one place
 * ------------------------------------------------------------------ */

/**
 * Percent added to the defender's defence when it has fortified in place.
 *
 * **Placeholder** (as is every constant below): unsourced, chosen to be playable, and
 * not a Civ 3 figure. It is large enough that digging in is a real decision against a
 * comparable attacker, and small enough that a fortified defender still loses to a
 * clearly stronger one — which is the property that keeps combat from becoming a
 * stalemate.
 */
export const FORTIFY_BONUS_PCT = 25;

/**
 * Percent added to the defender's defence when it is defending a city it occupies.
 *
 * **Placeholder**, unsourced, ours. Separate from `WALLS_BONUS_PCT` on purpose: a city
 * is an advantage on its own, and walls are a *building* a city may or may not hold —
 * one number meaning both would make "the walls did nothing" unmeasurable.
 */
export const CITY_DEFENSE_BONUS_PCT = 50;

/**
 * Percent added to the defender's defence when that city holds defensive walls.
 *
 * **Placeholder**, unsourced, ours. Added *on top of* `CITY_DEFENSE_BONUS_PCT` (both
 * are applied only when the defender is in a city with walls), and both are summed
 * before the single floor — see the module note.
 */
export const WALLS_BONUS_PCT = 50;

/**
 * Percent added to the attacker's attack for **each** experience level it has earned.
 *
 * **Placeholder**, unsourced, ours. It is a *sweepable* replacement for Civ 3's
 * discrete veteran/elite unit types: this engine makes promotion a continuous ladder
 * (`experience`, capped at `MAX_EXPERIENCE`) so the M6 balance sweep can vary one
 * number and measure the effect on outcomes, rather than adding unit types to model it.
 */
export const VETERAN_ATTACK_PCT = 25;

/**
 * The highest `experience` a unit may reach (M6, "Experience and promotion").
 *
 * **Placeholder**, unsourced, ours. Three levels is a small ladder on purpose: at
 * `VETERAN_ATTACK_PCT` per level it is a real advantage without letting a single unit
 * become unanswerable, and it keeps the number of distinct attack strengths in a
 * simulation small enough to report on.
 */
export const MAX_EXPERIENCE = 3;

/**
 * The number of equally likely outcomes a per-round draw has: `nextBelow(rng, 100)`
 * yields an integer in `[0, 99]`, and the win threshold is read on that same scale.
 *
 * 100 is not a tuning choice, it is the definition of "percentage" — which is why a
 * per-round chance can be compared to a single integer draw with no float anywhere.
 */
export const ROLL_BOUND = 100;

/**
 * The lowest a per-round win chance may be: 1%.
 *
 * **Placeholder** as a *value* (the floor itself is ours), and present so that a
 * positive attack can never become a certainty: without it, an attacker with a large
 * enough advantage would win every round for ever and combat would stop being a
 * random process at all. It also guarantees termination is not the only thing standing
 * between an overwhelming attacker and a *certain* result, which a scenario could not
 * then distinguish from a bug.
 */
export const MIN_WIN_PCT = 1;

/**
 * The highest a per-round win chance may be: 99%.
 *
 * **Placeholder** as a value, and the counterpart of `MIN_WIN_PCT`: the defender keeps
 * at least a 1% chance in every round, so no battle is decided before it is fought.
 * Note that this clamp, not the arithmetic, is what makes the "defender wins ties" rule
 * observable at the extreme — at 99 the threshold is below the top of the roll range,
 * so a roll of 99 is always a defender win.
 */
export const MAX_WIN_PCT = 99;

/** Hit points a round winner takes off the loser. **Placeholder**, unsourced, ours. */
export const DAMAGE_PER_ROUND = 1;

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/**
 * One side of a battle, as the resolver reads it.
 *
 * `bonusPct` is the side's **pre-summed** total modifier, which is why the contract
 * declares it as one field: the resolver does the summing *and* the single floor, and
 * a structure that carried a list of bonuses would invite a caller to floor some of
 * them on the way in.
 */
export interface CombatSide {
  readonly attack: number;
  readonly defense: number;
  readonly bonusPct: number;
}

/**
 * Everything one battle needs, and nothing the resolver could look up for itself.
 *
 * The two `hitPoints` fields are the units' hit points **now**, not their maxima: a
 * wounded unit fights wounded, and a resolver that took only the maxima would heal
 * every unit that entered a battle. The maxima are the *caller's* business (they come
 * from the unit definitions), which is what keeps this module free of any ruleset.
 *
 * `experience` and `static` are optional and their absence means the benign default
 * (no promotions, no fixed draw): with `exactOptionalPropertyTypes` an absent key is
 * the only spelling of "not provided", and neither is ever read as `undefined`.
 */
export interface CombatContext {
  /**
   * The attacker's statistics with every *attacker* bonus already summed into
   * `bonusPct`. `combat.test.ts` and the combat scenario build this with
   * `veteranBonusPct`, which is this module's own statement of how experience turns
   * into a percentage — callers must not re-derive it.
   */
  readonly attacker: CombatSide;
  /**
   * The defender's statistics with every *defender* bonus already summed into
   * `bonusPct`: `defenderBonusPct` below is the helper for exactly that, and it is the
   * single implementation of the M6 modifier list (terrain + fortify + city + walls).
   */
  readonly defender: CombatSide;
  /** The attacker's hit points left, `>= 1` for a unit that is alive. */
  readonly attackerHitPoints: number;
  /** The defender's hit points left, `>= 1` for a unit that is alive. */
  readonly defenderHitPoints: number;
  /** The RNG state to draw from. **Required**: a battle is not reproducible without it. */
  readonly rng: RngState;
  /** The attacker's experience level; absent means 0, which is also its default. */
  readonly experience?: number;
  /**
   * A fixed sequence of per-round draws in `[0, ROLL_BOUND)`, used **instead of** the
   * RNG, and only for tests and scenarios.
   *
   * It exists so that a specific battle can be pinned exactly — the tie case above all,
   * which needs a draw *equal* to the threshold and cannot be produced by asking for a
   * seed. It is an explicit input rather than a mocking hook, so a caller that supplies
   * it is stating what the dice were; `rng` is still returned unchanged, because a
   * battle that drew nothing from the stream must not advance it.
   */
  readonly static?: readonly number[];
}

/**
 * The result of one battle — the contract's fields, plus the odds that produced it.
 *
 * `attackerWinPct` and `attackerWinsBelow` are the per-round chance, stated two ways
 * that cannot disagree: the percentage is the human-facing figure, and the threshold
 * is the exact integer the resolver compared against (the attacker wins when its draw
 * is strictly below it). A scenario asserts `attackerWinPct` directly rather than
 * recomputing it, which is what keeps the assertion about *this* resolver rather than
 * about a copy of its arithmetic.
 */
export interface CombatResult {
  /** Rounds fought, both sides counted; at least 1, since a battle ends on a hit. */
  readonly rounds: number;
  /** Hit points the attacker lost. */
  readonly attackerLost: number;
  /** Hit points the defender lost. */
  readonly defenderLost: number;
  readonly outcome: 'attacker-wins' | 'defender-wins';
  readonly attackerSurvives: boolean;
  readonly defenderSurvives: boolean;
  /** The per-round win chance for the attacker, as a floored percentage. */
  readonly attackerWinPct: number;
  /** The same chance exactly: the attacker wins when its draw is `< this`. */
  readonly attackerWinsBelow: number;
  /** The denominator the threshold is read against — `ROLL_BOUND`, exported here. */
  readonly rollBound: number;
  /** The RNG state **after** this battle's draws; the caller stores it. */
  readonly rng: RngState;
}

/** What one battle did to the world's RNG stream: the result and the state to keep. */
export interface CombatOutcome {
  readonly result: CombatResult;
  readonly rng: RngState;
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/**
 * A percentage, clamped to the range a draw can express — `MIN_WIN_PCT` to
 * `MAX_WIN_PCT`, floored.
 *
 * The clamp is what makes a *certain* result unreachable, which matters for a reason
 * beyond flavour: a threshold of 100 would make the draw irrelevant, so a balance sweep
 * over that region would measure "nothing happens" and a scenario could not tell a
 * decided battle from a broken resolver.
 *
 * It is also the last line of defence against a value no comparison can order. `NaN`
 * loses every comparison, so a bare clamp would pass it straight through and the threshold
 * would poison each round's comparison in turn — a battle that never ends, from a context
 * a caller built by hand. Anything not a finite number is therefore *refused to a bound*
 * rather than forwarded: the attacker keeps the smallest chance (`MIN_WIN_PCT`), which is
 * the same "the defender is the safe default" choice `winPct` makes for a side with no
 * strength at all.
 */
const clampPct = (pct: number): number => {
  if (!Number.isFinite(pct)) return MIN_WIN_PCT;
  const floored = Math.floor(pct);
  return floored < MIN_WIN_PCT ? MIN_WIN_PCT : floored > MAX_WIN_PCT ? MAX_WIN_PCT : floored;
};

/** `value` scaled by `pct` percent, floored once. Negative percentages do not aid. */
const scaleByPct = (value: number, pct: number): number =>
  Math.floor((value * (100 + Math.max(pct, 0))) / 100);

/**
 * The attacker's attack after its experience bonus: **one** floor, applied to the
 * summed percentage. See the module note on the compounding rule.
 *
 * An `experience` that is not a positive integer contributes nothing, so a hostile or
 * hand-built value cannot change the odds by accident — the same totality rule
 * `units.ts`' `experienceOf` applies to the field it reads.
 */
export const veteranAttack = (attack: number, experience: number): number => {
  const levels = Number.isInteger(experience) && experience > 0 ? experience : 0;
  return scaleByPct(attack, levels * VETERAN_ATTACK_PCT);
};

/** The defender's defence after its summed modifiers: **one** floor (see the module note). */
export const modifiedDefense = (defense: number, bonusPct: number): number =>
  scaleByPct(defense, bonusPct);

/** `value` as a whole number at or above zero; anything unreadable, including `NaN`, is 0. */
const nonNegativeInteger = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * The M6 defender modifier list, summed into the single `bonusPct` a `CombatSide`
 * carries: terrain defence, `+FORTIFY_BONUS_PCT` if fortified, `+CITY_DEFENSE_BONUS_PCT`
 * if defending a city, `+WALLS_BONUS_PCT` if that city holds defensive walls.
 *
 * **This is the one implementation of that list.** It returns the *sum* and nothing
 * else — no flooring, no multiplication — because the floor happens exactly once, in
 * `modifiedDefense`, and a helper that returned a modified defence would be the second
 * place the rule could be spelled differently.
 *
 * `walls` is read only when the defender is in a city: walls are a property of a city,
 * and a caller that passed `walls: true` for a unit standing in the open would be
 * describing a fortification that does not exist. The guard makes that unrepresentable
 * rather than trusting every caller to remember.
 */
export const defenderBonusPct = (modifiers: {
  readonly terrainBonusPct: number;
  readonly fortified: boolean;
  readonly inCity: boolean;
  readonly walls: boolean;
}): number =>
  modifiers.terrainBonusPct +
  (modifiers.fortified ? FORTIFY_BONUS_PCT : 0) +
  (modifiers.inCity ? CITY_DEFENSE_BONUS_PCT : 0) +
  (modifiers.inCity && modifiers.walls ? WALLS_BONUS_PCT : 0);

/**
 * The attacker's bonus percentage for an experience level — the reader a caller uses to
 * fill `CombatSide.bonusPct`, so the caller does not re-derive the veteran rule.
 */
export const veteranBonusPct = (experience: number): number =>
  (Number.isInteger(experience) && experience > 0 ? experience : 0) * VETERAN_ATTACK_PCT;

/**
 * A terrain row's defence bonus, under the M6 name **with the older name as a fallback**.
 *
 * Two names for one magnitude is a migration, not a design, and the shape of the problem
 * decides where the reading happens. `TerrainSpec` (content) declares the M6 name
 * `defenseBonus`; `TerrainDef` (the engine's structural view, in `map.ts`) declares
 * `defenseBonusPct`, which M6 did **not** rename — doing so would have made every
 * hand-built terrain literal in the tree a type error for a field nothing read. So the
 * type system guarantees neither name on the value that reaches a battle, and this
 * function is the single place the pair is reconciled:
 *
 * 1. `defenseBonus` when it is a usable number — the name shipped content writes, and the
 *    one `validateRuleset` cross-checks against the other;
 * 2. otherwise `defenseBonusPct`, so a view assembled before M6 (or by hand) still fights
 *    on the terrain it stands on;
 * 3. otherwise `0` — the totality rule, in the direction that never invents a bonus. A
 *    defensive modifier the game did not declare must not appear out of a `NaN`.
 *
 * The parameter is structural and every field is optional on purpose: this reader is
 * called with content rows and with hand-built views, and it must not force either to
 * declare both names. Values are read as non-negative integers, since a percentage that
 * is negative, fractional or unreadable is not a bonus.
 */
export const terrainDefenseBonus = (terrain: {
  readonly defenseBonus?: number;
  readonly defenseBonusPct?: number;
}): number => {
  const m6 = terrain.defenseBonus;
  if (typeof m6 === 'number' && Number.isFinite(m6)) return nonNegativeInteger(m6);
  const legacy = terrain.defenseBonusPct;
  return typeof legacy === 'number' && Number.isFinite(legacy) ? nonNegativeInteger(legacy) : 0;
};

/**
 * The per-round win chance for the attacker, as a whole percentage in
 * `[MIN_WIN_PCT, MAX_WIN_PCT]`: `attack / (attack + defense)`, floored **once**.
 *
 * A side whose effective strength is zero makes the ratio undefined, and the answer
 * chosen here is the attacker's **worst** case rather than an exception: with no attack
 * strength and no defence strength there is nothing to favour an assault, so the
 * defender wins every round. (In a real game that situation is unreachable — a unit with
 * `attack === 0` may not attack at all, which is a legality rule the command layer
 * enforces — but a total function is a better neighbour than a throw in a resolver that
 * a simulation calls in a loop.)
 */
export const winPct = (attackValue: number, defenseValue: number): number => {
  const attack = nonNegativeInteger(attackValue);
  const defense = nonNegativeInteger(defenseValue);
  const total = attack + defense;
  if (total <= 0) return MIN_WIN_PCT;
  return clampPct(Math.floor((attack * ROLL_BOUND) / total));
};

/**
 * Draw one per-round roll in `[0, ROLL_BOUND)`, threading the RNG state.
 *
 * `nextBelow(rng, 100)` is unbiased and integer-only; it returns the value *and* the
 * next state, which is what makes the whole resolver pure. A draw that is not a whole
 * number inside the range is treated as the top of the range — i.e. a defender win —
 * so a hostile or hand-built `static` sequence cannot produce a roll the comparison
 * below was never written for.
 */
const drawRoll = (
  scripted: readonly number[] | undefined,
  index: number,
  rng: RngState,
): { readonly roll: number; readonly rng: RngState } => {
  const fixed = scripted?.[index];
  if (fixed !== undefined) {
    const roll =
      Number.isInteger(fixed) && fixed >= 0 && fixed < ROLL_BOUND ? fixed : ROLL_BOUND - 1;
    // The state comes back **unchanged**: a battle that drew nothing from the stream must
    // not advance it, and that is what makes a fully scripted battle a pure observation
    // of the resolver rather than something that also consumes the game's randomness.
    return { roll, rng };
  }
  const [roll, next] = nextBelow(rng, ROLL_BOUND);
  return { roll, rng: next };
};

/**
 * **Does this roll win the round for the attacker?** — the comparison, written once.
 *
 * The rule is `roll < threshold`, i.e. **the defender wins ties**: a draw exactly equal
 * to the attacker's threshold is a defender win. Stated as a named function, with the
 * boundary in the `<` rather than the `<=`, so that the tie rule is a line someone can
 * read and a test can pin — a tie rule implicit in the shape of a comparison is one an
 * innocent reorder changes.
 */
export const drawsWin = (roll: number, threshold: number): boolean => roll < threshold;

/* ------------------------------------------------------------------ *
 * The resolver
 * ------------------------------------------------------------------ */

/** What one side's hit points are called inside the loop, so the two cannot be swapped. */
interface HitPoints {
  readonly attacker: number;
  readonly defender: number;
}

/**
 * Resolve one battle to its end: alternate rounds until a side has no hit points left,
 * drawing each round's outcome from the passed RNG state.
 *
 * The procedure, in full, because it is the contract:
 *
 * 1. The attacker's effective attack is its `attack` with its summed bonus applied —
 *    one floor. The defender's effective defence is its `defense` with *its* summed
 *    bonus applied — one floor. See `modifiedDefense` and the module note.
 * 2. The per-round win chance is `winPct(effectiveAttack, effectiveDefense)`, clamped
 *    to `[MIN_WIN_PCT, MAX_WIN_PCT]`.
 * 3. Each round draws `nextBelow(rng, 100)`; **the attacker wins a round only if the
 *    draw is strictly below the threshold** (`drawsWin`), so the defender wins ties.
 * 4. The round's loser takes `DAMAGE_PER_ROUND` hit points. The loop ends when a side
 *    reaches zero, and **a side at zero does not survive** — this resolver reports the
 *    outcome but never writes a unit, so it cannot leave a live unit at 0 hit points;
 *    `units.ts`' `woundUnit` is what turns the loss into state, by removing the unit.
 *
 * Termination is structural rather than assumed: every round costs the loser a hit
 * point, and both hit point counts are finite, so the loop cannot run forever. A hit
 * point count that is not a positive whole number is normalised to 1 first — a battle
 * between two units that are already dead is not a question worth throwing over, and
 * `canonicalize` would reject a fraction if one ever reached the state.
 *
 * The returned `rng` is the state **after** this battle's draws, and the result carries
 * it too, so a caller can either store the field or keep the purpose-built outcome —
 * they are the same value, and `combat.test.ts` asserts it.
 */
export const resolveCombat = (ctx: CombatContext): CombatOutcome => {
  const attackerAttack = veteranAttack(ctx.attacker.attack, ctx.experience ?? 0);
  const defenderDefense = modifiedDefense(ctx.defender.defense, ctx.defender.bonusPct);

  const threshold = winPct(attackerAttack, defenderDefense);

  let points: HitPoints = {
    attacker: normaliseHitPoints(ctx.attackerHitPoints),
    defender: normaliseHitPoints(ctx.defenderHitPoints),
  };
  const starting: HitPoints = points;

  let rounds = 0;
  let rng = ctx.rng;

  // `points.defender > 0 && points.attacker > 0` is the loop condition rather than a
  // `for(;;)` with a break, so the "a side at zero is finished" rule is the loop's own
  // statement instead of something a reader has to find inside the body.
  while (points.defender > 0 && points.attacker > 0) {
    const draw = drawRoll(ctx.static, rounds, rng);
    rng = draw.rng;
    rounds += 1;

    points = drawsWin(draw.roll, threshold)
      ? { attacker: points.attacker, defender: Math.max(points.defender - DAMAGE_PER_ROUND, 0) }
      : { attacker: Math.max(points.attacker - DAMAGE_PER_ROUND, 0), defender: points.defender };
  }

  const attackerWins = points.defender <= 0;

  return {
    result: {
      rounds,
      attackerLost: starting.attacker - points.attacker,
      defenderLost: starting.defender - points.defender,
      outcome: attackerWins ? 'attacker-wins' : 'defender-wins',
      attackerSurvives: points.attacker > 0,
      defenderSurvives: points.defender > 0,
      attackerWinPct: threshold,
      attackerWinsBelow: threshold,
      rollBound: ROLL_BOUND,
      rng,
    },
    rng,
  };
};

/**
 * A hit point count the loop can use: a positive whole number, or 1.
 *
 * Total on purpose. A resolver reached from a simulation, a scenario and a test will
 * eventually be handed a hand-built context; "the unit is already dead" is not a
 * question this function can answer, and throwing would turn a data problem into a
 * crash in the middle of a turn. One is the smallest value that lets a battle happen
 * and be visible, which is the same choice `units.ts`' `hitPointsLeftOf` makes.
 */
const normaliseHitPoints = (value: number): number =>
  Number.isInteger(value) && value >= 1 ? value : 1;
