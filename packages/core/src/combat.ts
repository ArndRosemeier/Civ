/**
 * Combat resolution — **the ONE statement of the odds** (docs/INTERFACES.md M6,
 * "Combat resolution"; PLAN.md §5.3 determinism).
 *
 * Everything a battle is made of lives here and nowhere else: the modifier table, the
 * per-round win chance, the tie rule, the damage-per-round rule and the loop that
 * applies them. A caller supplies the *inputs* — the two sides' statistics, the
 * defender's bonuses, the two units' current hit points — plus the **rules** and the
 * **RNG state**, and gets back a `CombatResult`. No other module may re-derive any of
 * it: a second copy of "how likely is the attacker to win this round" is a second game,
 * and the whole point of putting combat in its own module is that the UI, the AI, the
 * balance sweep and the test suite all read the same numbers.
 *
 * ## The magnitudes live in the catalog (M6b)
 *
 * Every number this module applies — the three defender bonuses, the veteran bonus, the
 * promotion cap, the roll bound, the damage per round and the odds clamp — is read from
 * the ruleset the caller hands over, through `combatRulesOf` below, and **`CombatDef` is
 * the whole of them**. There is no module-level copy of any of them, and that is a
 * checked property rather than a promise: `combat.test.ts` fights the same battle under
 * two different `CombatDef`s and requires the odds to move, so a literal left behind
 * here would fail a test instead of quietly becoming a second source of truth.
 *
 * M6 shipped these nine numbers as `export const` values in *this file*. That violated
 * the standing requirement's third clause — *every magnitude a system introduces lives in
 * the rules catalog or an explicit override, never as a literal buried in logic* — and it
 * had a visible cost: the M6 combat balance sweep had to print the whole block under
 * "combat magnitudes this override surface CANNOT move". **A system whose knobs cannot be
 * swept cannot be balanced.** So the numbers live in `@civts/rules`' `combat` section now
 * (where they are `placeholder` rows with provenance), `RulesetPatch.combat` moves them
 * one at a time, and this module reads them. `scripts/combat-balance-sweep.ts` sweeps
 * them; nothing here is claimed as Civ 3's.
 *
 * ## Purity
 *
 * `resolveCombat` **takes the RNG state and returns the next one**. It does not reach
 * into the world, does not read `GameState`, and does not draw from any ambient source:
 *
 * - No `Math.random` (banned outright in this package), no clock, no I/O.
 * - The rules are a **parameter**, not an import: a battle cannot silently fight under
 *   numbers the caller did not choose, and a sweep cannot be fooled by a default.
 * - The result carries the **per-round win chance** (`attackerWinPct`) *and* the exact
 *   integer draw that produces it (`attackerWinsBelow`, of `rules.rollBound` values), so
 *   a scenario can assert the odds directly rather than re-deriving them — and a
 *   re-derivation cannot silently drift from the resolver.
 * - Given the same context and the same RNG state, the result is *identical*, which is
 *   what makes a battle reproducible from the game seed. That is also why the RNG is a
 *   parameter rather than a field: a pure function cannot forget to thread it.
 *
 * ## The modifier rule — summed, then floored ONCE
 *
 * M4c established this for a city's output multipliers and M6 inherits it verbatim, for
 * the same reason: **flooring twice gives a different number.** So the defender's bonuses
 * are *added as percentages* and applied to its defence with a single floor at the end:
 *
 * ```
 * defence' = floor(defence * (100 + terrainBonus + fortifyBonus + cityBonus + wallsBonus) / 100)
 * ```
 *
 * `combat.test.ts` pins a case where the summed-then-floored answer differs from flooring
 * each modifier separately, so "simplify this into a loop that multiplies one bonus at a
 * time" fails a test rather than quietly changing the game.
 *
 * ## The veteran asymmetry — deliberate, and NOT how Civ 3 does it
 *
 * `rules.veteranAttackPct` is applied to the **attacker only**. A veteran *defender* gets
 * nothing for its experience: no attack bonus (it is not attacking) and no bonus to its
 * defence either. That is exactly what M6's contract specifies ("attacker:
 * `+VETERAN_ATTACK_PCT` per experience level"), so the behaviour is correct to the
 * contract and is **kept**, but the asymmetry is stated here, where the odds are
 * computed, because a reader who finds it will otherwise assume it is a bug:
 *
 * - **What Civ 3 does instead**: its veteran and elite units are *different unit types*
 *   with **extra hit points** (and, for some, altered firepower), so experience makes a
 *   unit *last longer* on both sides of a battle rather than making an attacker hit
 *   harder. Nothing here reproduces that, and `veteranAttackPct` is not a Civ 3 figure.
 * - **Why this engine does it this way**: M6 wanted one continuously sweepable number
 *   (`veteranAttackPct`, over `maxExperience` levels) rather than a set of discrete
 *   veteran unit types, so that a balance sweep could vary a single magnitude and measure
 *   the effect on outcomes. A defender-side counterpart is a *second* knob nobody has
 *   swept yet, and inventing one here would be a rebalance rather than the relocation
 *   M6b is.
 * - **So**: it is a placeholder, it is recorded in the catalog's own provenance note
 *   (`@civts/rules`' `combat` section), and a later reader can judge it on the evidence
 *   rather than on the assumption that someone forgot a line.
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
 * division. Combat randomness comes from `rng.ts`'s `nextBelow(rng, rules.rollBound)` —
 * an integer in `[0, rollBound)` — so a battle is reproducible from the seed and needs no
 * transcendental (which this package bans, because each engine ships its own `libm`).
 */

import { nextBelow, type RngState } from './rng.js';
import type { RulesetView } from './map.js';

/* ------------------------------------------------------------------ *
 * The modifier table — read from the ruleset, never copied here
 * ------------------------------------------------------------------ */

/**
 * The nine combat magnitudes, as this module reads them.
 *
 * **This interface is the engine's structural view of the catalog's `combat` section**
 * (`@civts/rules`' `CombatSpec`). It is declared here rather than imported because
 * `core` cannot depend on `rules` — `rules` depends on `core` — which is the same
 * direction-of-dependency judgement `TerrainDef`, `UnitDef` and `BuildingDef` make. The
 * two shapes are kept in step by construction and by test: a validated `Ruleset` is
 * structurally a `RulesetView` *and* carries these fields, and `rules.test.ts` pins the
 * shipped values field by field.
 *
 * Every field is an integer by validation (`validateRuleset`'s `checkCombat`), and each
 * one is a *placeholder* of ours: unsourced, chosen to be playable, and not a Civ 3
 * figure. The provenance claim for all nine lives with the row in `@civts/rules`.
 */
export interface CombatDef {
  /** Percent added to a fortified defender's defence. */
  readonly fortifyBonusPct: number;
  /** Percent added to a defender's defence when it stands in its own city. */
  readonly cityDefenseBonusPct: number;
  /** Percent added on top of that when the city holds defensive walls. */
  readonly wallsBonusPct: number;
  /** Percent added to an attacker's attack for **each** experience level it has earned. */
  readonly veteranAttackPct: number;
  /** The highest `experience` a unit may reach. */
  readonly maxExperience: number;
  /** How many equally likely outcomes a per-round draw has: `nextBelow(rng, rollBound)`. */
  readonly rollBound: number;
  /** Hit points a round winner takes off the loser. */
  readonly damagePerRound: number;
  /** The lowest a per-round win chance may be. */
  readonly minWinPct: number;
  /** The highest a per-round win chance may be. */
  readonly maxWinPct: number;
}

/**
 * **What a battle is fought under when the ruleset declares no combat section.**
 *
 * A *degenerate* set, deliberately unlike the shipped table, and deliberately not a
 * second copy of it: no bonus is granted for terrain, fortification, a city or walls, no
 * unit may be promoted (`maxExperience: 0`), the draw has one outcome and the odds clamp
 * is `[0, 0]` — so the attacker never wins a round and the defender takes every one. That
 * is the same "the defender is the safe default" answer `winPct` gives for a side with no
 * strength at all, and it is the honest reading of "this ruleset states no combat rules":
 * nothing favours an assault.
 *
 * **Why not the shipped catalog's numbers?** Because a fallback that reproduced today's
 * values would be the dual-source bug M6b exists to remove, wearing a new costume:
 * moving the catalog's `fortifyBonusPct` would then leave every combatant that arrived
 * through a section-less view fighting under a number nobody can see or sweep. An absent
 * section must *change the odds*, and `combat.test.ts` asserts that it does.
 *
 * `damagePerRound: 1` is **not** a copy of the shipped value: it is the termination
 * floor. A round that costs no hit point can never end a battle, so the resolver's loop
 * — inside a pure function the turn pipeline calls — would not terminate. One is the
 * smallest value that lets a battle happen and end.
 *
 * A real game never meets this: `validateRuleset` requires the catalog's `combat`
 * section, so every state built through `newGame` fights under declared rules. This is
 * the answer for a *structural* view — a hand-built fixture, a foreign object, an old
 * save's ruleset — the same totality rule `terrainDefenseBonus` applies to a terrain
 * that declares no defence bonus.
 */
export const NO_COMBAT_RULES: CombatDef = {
  fortifyBonusPct: 0,
  cityDefenseBonusPct: 0,
  wallsBonusPct: 0,
  veteranAttackPct: 0,
  maxExperience: 0,
  rollBound: 1,
  damagePerRound: 1,
  minWinPct: 0,
  maxWinPct: 0,
};

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One magnitude, read as a whole number at or above `minimum`, or `fallback`.
 *
 * Total on purpose, and in the direction that never invents a bonus: a value that is
 * missing, fractional, negative, or not a number at all reads as the fallback rather
 * than as a NaN that would poison every comparison downstream. Validation rejects such a
 * value in *content*; this is what a structural view gets, and the two answers are the
 * same kind of answer `nonNegativeInteger` and `normaliseHitPoints` below give.
 */
const magnitude = (value: unknown, fallback: number, minimum: number): number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= minimum
    ? value
    : fallback;

/**
 * **The combat magnitudes a ruleset declares** — the one read of them.
 *
 * The field is read *structurally*, through `unknown`, exactly as `techCatalog` reads a
 * view's `techs` and `terrainDefenseBonus` reads a terrain's defence bonus: `RulesetView`
 * (in `map.ts`) is the engine's structural view and does not declare `combat`, while
 * `@civts/rules`' validated `Ruleset` carries it, and a hand-built fixture may carry
 * anything at all. Reading it this way means the numbers reach combat from content
 * without this package depending on `rules`, and without a cast.
 *
 * **Absent is not "use the defaults"**: see `NO_COMBAT_RULES` for why an unstated section
 * must change the odds rather than reproduce the shipped table. A field that *is* present
 * but unreadable (a string, a fraction, a negative) reads as that field's degenerate
 * value — 0 for a percentage or a cap, the termination floor for the damage, 1 for the
 * roll bound — so a hostile hand-built view cannot make the resolver throw or loop.
 *
 * The clamp chain (`1 <= minWinPct <= maxWinPct <= rollBound`) is **checked in
 * validation, not repaired here**: this reader states what the view says, the resolver
 * stays total on a broken chain, and `validateRuleset` is where content that says
 * something impossible is refused by name.
 */
export const combatRulesOf = (ruleset: RulesetView): CombatDef => {
  const view: unknown = ruleset;
  const section = isRecord(view) ? view['combat'] : undefined;
  if (!isRecord(section)) return NO_COMBAT_RULES;

  return {
    fortifyBonusPct: magnitude(section['fortifyBonusPct'], NO_COMBAT_RULES.fortifyBonusPct, 0),
    cityDefenseBonusPct: magnitude(
      section['cityDefenseBonusPct'],
      NO_COMBAT_RULES.cityDefenseBonusPct,
      0,
    ),
    wallsBonusPct: magnitude(section['wallsBonusPct'], NO_COMBAT_RULES.wallsBonusPct, 0),
    veteranAttackPct: magnitude(section['veteranAttackPct'], NO_COMBAT_RULES.veteranAttackPct, 0),
    maxExperience: magnitude(section['maxExperience'], NO_COMBAT_RULES.maxExperience, 0),
    rollBound: magnitude(section['rollBound'], NO_COMBAT_RULES.rollBound, 1),
    damagePerRound: magnitude(section['damagePerRound'], NO_COMBAT_RULES.damagePerRound, 1),
    minWinPct: magnitude(section['minWinPct'], NO_COMBAT_RULES.minWinPct, 0),
    maxWinPct: magnitude(section['maxWinPct'], NO_COMBAT_RULES.maxWinPct, 0),
  };
};

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
 * `rules` is **required**, and that is the M6b contract's teeth: a caller cannot fight a
 * battle without stating the magnitudes it is fought under, so there is no path that
 * silently falls back to a value buried in this file. It is the same judgement the M2
 * amendment made about `ruleset` in `applyCommand` — "required means the compiler
 * enforces what the runtime needs" — and it is why a balance sweep cannot accidentally
 * measure the un-overridden game.
 *
 * The two `hitPoints` fields are the units' hit points **now**, not their maxima: a
 * wounded unit fights wounded, and a resolver that took only the maxima would heal
 * every unit that entered a battle. The maxima are the *caller's* business (they come
 * from the unit definitions).
 *
 * `experience` and `static` are optional and their absence means the benign default
 * (no promotions, no fixed draw): with `exactOptionalPropertyTypes` an absent key is
 * the only spelling of "not provided", and neither is ever read as `undefined`.
 */
export interface CombatContext {
  /** The combat magnitudes this battle is fought under. See `combatRulesOf`. */
  readonly rules: CombatDef;
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
   * A fixed sequence of per-round draws in `[0, rules.rollBound)`, used **instead of**
   * the RNG, and only for tests and scenarios.
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
  /** The denominator the threshold is read against — the ruleset's `rollBound`. */
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
 * A percentage, clamped to the range a draw can express — `rules.minWinPct` to
 * `rules.maxWinPct`, floored.
 *
 * The clamp is what makes a *certain* result unreachable, which matters for a reason
 * beyond flavour: a threshold of the full roll bound would make the draw irrelevant, so a
 * balance sweep over that region would measure "nothing happens" and a scenario could not
 * tell a decided battle from a broken resolver.
 *
 * It is also the last line of defence against a value no comparison can order. `NaN`
 * loses every comparison, so a bare clamp would pass it straight through and the threshold
 * would poison each round's comparison in turn — a battle that never ends, from a context
 * a caller built by hand. Anything not a finite number is therefore *refused to a bound*
 * rather than forwarded: the attacker keeps the smallest chance (`rules.minWinPct`), which
 * is the same "the defender is the safe default" choice `winPct` makes for a side with no
 * strength at all.
 */
const clampPct = (pct: number, rules: CombatDef): number => {
  if (!Number.isFinite(pct)) return rules.minWinPct;
  const floored = Math.floor(pct);
  return floored < rules.minWinPct
    ? rules.minWinPct
    : floored > rules.maxWinPct
      ? rules.maxWinPct
      : floored;
};

/** `value` scaled by `pct` percent, floored once. Negative percentages do not aid. */
const scaleByPct = (value: number, pct: number): number =>
  Math.floor((value * (100 + Math.max(pct, 0))) / 100);

/**
 * The attacker's attack after its experience bonus: **one** floor, applied to the
 * summed percentage. See the module note on the compounding rule and on why the bonus is
 * the attacker's alone.
 *
 * An `experience` that is not a positive integer contributes nothing, so a hostile or
 * hand-built value cannot change the odds by accident — the same totality rule
 * `units.ts`' `experienceOf` applies to the field it reads.
 */
export const veteranAttack = (rules: CombatDef, attack: number, experience: number): number => {
  const levels = Number.isInteger(experience) && experience > 0 ? experience : 0;
  return scaleByPct(attack, levels * rules.veteranAttackPct);
};

/** The defender's defence after its summed modifiers: **one** floor (see the module note). */
export const modifiedDefense = (defense: number, bonusPct: number): number =>
  scaleByPct(defense, bonusPct);

/** `value` as a whole number at or above zero; anything unreadable, including `NaN`, is 0. */
const nonNegativeInteger = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * The M6 defender modifier list, summed into the single `bonusPct` a `CombatSide`
 * carries: terrain defence, `+rules.fortifyBonusPct` if fortified,
 * `+rules.cityDefenseBonusPct` if defending a city, `+rules.wallsBonusPct` if that city
 * holds defensive walls.
 *
 * **This is the one implementation of that list.** It returns the *sum* and nothing
 * else — no flooring, no multiplication — because the floor happens exactly once, in
 * `modifiedDefense`, and a helper that returned a modified defence would be the second
 * place the rule could be spelled differently.
 *
 * The three bonuses come from the caller's `rules`, so a sweep that moves one of them
 * moves *this* sum and nothing else: the three are separate fields precisely so that
 * "the walls did nothing" is measurable instead of being an opinion.
 *
 * `walls` is read only when the defender is in a city: walls are a property of a city,
 * and a caller that passed `walls: true` for a unit standing in the open would be
 * describing a fortification that does not exist. The guard makes that unrepresentable
 * rather than trusting every caller to remember.
 */
export const defenderBonusPct = (
  rules: CombatDef,
  modifiers: {
    readonly terrainBonusPct: number;
    readonly fortified: boolean;
    readonly inCity: boolean;
    readonly walls: boolean;
  },
): number =>
  modifiers.terrainBonusPct +
  (modifiers.fortified ? rules.fortifyBonusPct : 0) +
  (modifiers.inCity ? rules.cityDefenseBonusPct : 0) +
  (modifiers.inCity && modifiers.walls ? rules.wallsBonusPct : 0);

/**
 * The attacker's bonus percentage for an experience level — the reader a caller uses to
 * fill `CombatSide.bonusPct`, so the caller does not re-derive the veteran rule.
 *
 * It is the attacker's bonus **only**: see the module note on the deliberate veteran
 * asymmetry for what a *defender* gets (nothing) and what Civ 3 does instead (extra hit
 * points per veteran level).
 */
export const veteranBonusPct = (rules: CombatDef, experience: number): number =>
  (Number.isInteger(experience) && experience > 0 ? experience : 0) * rules.veteranAttackPct;

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
 * `[rules.minWinPct, rules.maxWinPct]`: `attack / (attack + defense)`, floored **once**.
 *
 * A side whose effective strength is zero makes the ratio undefined, and the answer
 * chosen here is the attacker's **worst** case rather than an exception: with no attack
 * strength and no defence strength there is nothing to favour an assault, so the
 * defender wins every round. (In a real game that situation is unreachable — a unit with
 * `attack === 0` may not attack at all, which is a legality rule the command layer
 * enforces — but a total function is a better neighbour than a throw in a resolver that
 * a simulation calls in a loop.)
 */
export const winPct = (rules: CombatDef, attackValue: number, defenseValue: number): number => {
  const attack = nonNegativeInteger(attackValue);
  const defense = nonNegativeInteger(defenseValue);
  const total = attack + defense;
  if (total <= 0) return rules.minWinPct;
  return clampPct(Math.floor((attack * rules.rollBound) / total), rules);
};

/**
 * Draw one per-round roll in `[0, rules.rollBound)`, threading the RNG state.
 *
 * `nextBelow(rng, rules.rollBound)` is unbiased and integer-only; it returns the value
 * *and* the next state, which is what makes the whole resolver pure. A draw that is not a
 * whole number inside the range is treated as the top of the range — i.e. a defender win
 * — so a hostile or hand-built `static` sequence cannot produce a roll the comparison
 * below was never written for.
 */
const drawRoll = (
  rules: CombatDef,
  scripted: readonly number[] | undefined,
  index: number,
  rng: RngState,
): { readonly roll: number; readonly rng: RngState } => {
  const fixed = scripted?.[index];
  if (fixed !== undefined) {
    const roll =
      Number.isInteger(fixed) && fixed >= 0 && fixed < rules.rollBound
        ? fixed
        : rules.rollBound - 1;
    // The state comes back **unchanged**: a battle that drew nothing from the stream must
    // not advance it, and that is what makes a fully scripted battle a pure observation
    // of the resolver rather than something that also consumes the game's randomness.
    return { roll, rng };
  }
  const [roll, next] = nextBelow(rng, rules.rollBound);
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
 * 1. The attacker's effective attack is its `attack` with its summed bonus
 *    (`rules.veteranAttackPct` per level) applied — one floor. The defender's effective
 *    defence is its `defense` with *its* summed bonus applied — one floor. See
 *    `modifiedDefense` and the module note.
 * 2. The per-round win chance is `winPct(rules, effectiveAttack, effectiveDefense)`,
 *    clamped to `[rules.minWinPct, rules.maxWinPct]`.
 * 3. Each round draws `nextBelow(rng, rules.rollBound)`; **the attacker wins a round only
 *    if the draw is strictly below the threshold** (`drawsWin`), so the defender wins
 *    ties.
 * 4. The round's loser takes `rules.damagePerRound` hit points. The loop ends when a side
 *    reaches zero, and **a side at zero does not survive** — this resolver reports the
 *    outcome but never writes a unit, so it cannot leave a live unit at 0 hit points;
 *    `units.ts`' `woundUnit` is what turns the loss into state, by removing the unit.
 *
 * Termination is structural rather than assumed: every round costs the loser at least one
 * hit point (`validateRuleset` refuses a `damagePerRound` of 0 for exactly this reason,
 * and `combatRulesOf` floors an unreadable value at 1), and both hit point counts are
 * finite, so the loop cannot run forever. A hit point count that is not a positive whole
 * number is normalised to 1 first — a battle between two units that are already dead is
 * not a question worth throwing over, and `canonicalize` would reject a fraction if one
 * ever reached the state.
 *
 * The returned `rng` is the state **after** this battle's draws, and the result carries
 * it too, so a caller can either store the field or keep the purpose-built outcome —
 * they are the same value, and `combat.test.ts` asserts it.
 */
export const resolveCombat = (ctx: CombatContext): CombatOutcome => {
  const rules = ctx.rules;
  const attackerAttack = veteranAttack(rules, ctx.attacker.attack, ctx.experience ?? 0);
  const defenderDefense = modifiedDefense(ctx.defender.defense, ctx.defender.bonusPct);

  const threshold = winPct(rules, attackerAttack, defenderDefense);

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
    const draw = drawRoll(rules, ctx.static, rounds, rng);
    rng = draw.rng;
    rounds += 1;

    points = drawsWin(draw.roll, threshold)
      ? {
          attacker: points.attacker,
          defender: Math.max(points.defender - rules.damagePerRound, 0),
        }
      : {
          attacker: Math.max(points.attacker - rules.damagePerRound, 0),
          defender: points.defender,
        };
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
      rollBound: rules.rollBound,
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
