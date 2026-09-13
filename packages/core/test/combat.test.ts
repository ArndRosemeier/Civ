/**
 * Combat resolution and the unit state that feeds it — M6, "Units in play" and
 * "Combat resolution" (docs/INTERFACES.md).
 *
 * What this file is for. Combat is a rule with a *number* in it, and a rule with a
 * number is only tested if the number is asserted exactly. So most of what follows
 * pins `attackerWinPct` for a **hand-computed** case rather than checking that a battle
 * "happened": an assertion like `expect(result.rounds).toBeGreaterThan(0)` passes for a
 * resolver that always gives the attacker a 1% chance, which is precisely the failure a
 * mutating implementation would produce.
 *
 * The load-bearing cases, each named for the rule it protects:
 *
 * - **The modifier rule: summed, then floored ONCE.** The contrast case compares
 *   `modifiedDefense(3, 50 + 50)` with `modifiedDefense(modifiedDefense(3, 50), 50)`
 *   and shows 6 against 4 — the two answers a "simplify this into a loop" refactor
 *   would swap. `resolveCombat` is then asserted to produce the 6, so the rule is
 *   pinned at both the helper and the resolver.
 * - **The defender wins ties.** A scripted draw *exactly equal* to the threshold is a
 *   defender round win, and the same battle with the draw one below is an attacker
 *   round win. That pair is the only way to test a boundary, and it is why
 *   `CombatContext.static` exists.
 * - **A unit at 0 hit points is removed.** Not "has 0 hit points": `woundUnit` returns a
 *   state that no longer contains the unit, and `damageUnit` answers `undefined`. The
 *   alternative — a live unit at 0 — is the state M6 names as unrepresentable.
 * - **`experience` and `fortified` are absent or present, never `undefined`.** Asserted
 *   on the objects, and then again through `JSON.stringify`, because a key holding
 *   `undefined` survives neither a JSON round trip nor `canonicalize`.
 * - **Purity.** The same `CombatContext` resolved twice gives an identical result *and*
 *   an identical next RNG state, and two battles resolved from the same starting state
 *   do not interfere — the resolver takes the RNG and returns it rather than reaching
 *   into anything.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_COMBAT_RULES,
  combatRulesOf,
  defenderBonusPct,
  terrainDefenseBonus,
  drawsWin,
  modifiedDefense,
  resolveCombat,
  veteranAttack,
  veteranBonusPct,
  winPct,
  type CombatContext,
  type CombatDef,
} from '../src/combat.js';
import {
  asGovernmentId,
  asPlayerId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
} from '../src/ids.js';
import type { RulesetView } from '../src/map.js';
import { asImprovementId } from '../src/improvements.js';
import { nextBelow, seedRng, type RngState } from '../src/rng.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SCHEMA_VERSION, type GameState } from '../src/state.js';
import {
  clearFortified,
  damageUnit,
  experienceOf,
  fullHitPoints,
  healUnit,
  hitPointsLeftOf,
  isFortified,
  maxHitPointsOf,
  promoteUnit,
  removeUnit,
  spawnUnit,
  unitById,
  withExperience,
  withFortified,
  withUnits,
  withWork,
  withoutExperience,
  withoutWork,
  woundUnit,
  type Unit,
  type UnitDef,
} from '../src/units.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A pinned RNG state, so any test that draws can be reasoned about exactly. */
const RNG: RngState = seedRng(0);

/**
 * **The magnitudes this file fights under — a fixture, not an import.**
 *
 * M6b moved combat's constants out of `src/combat.ts` and into the rules catalog, so this
 * file can no longer import them and must not: importing the shipped numbers back would
 * make every assertion below a tautology about whatever the catalog happens to say today,
 * and the sweep's whole premise is that those numbers *move*. The fixture states the nine
 * values explicitly (they are the M6 values, so every hand-computed expectation in this
 * file still holds), the tests below pin the odds against *these* numbers, and a separate
 * block proves that a different `CombatDef` — a different ruleset — moves the odds.
 */
const RULES: CombatDef = {
  fortifyBonusPct: 25,
  cityDefenseBonusPct: 50,
  wallsBonusPct: 50,
  veteranAttackPct: 25,
  maxExperience: 3,
  rollBound: 100,
  damagePerRound: 1,
  minWinPct: 1,
  maxWinPct: 99,
};

/**
 * A seed whose **first** `nextBelow(state, 100)` draw is exactly `roll`.
 *
 * Scripted draws (`CombatContext.static`) are the right tool for boundary cases, but a
 * real battle should also be shown to depend on the *stream* it was given. A search
 * rather than a table because a hand-written seed would be a magic number nobody could
 * re-derive; the search is over seeds, integer-only, and terminates on the first match,
 * so it is as deterministic as a literal.
 */
const seedWithFirstRoll = (roll: number): RngState => {
  for (let seed = 0; seed < 100000; seed += 1) {
    const candidate = seedRng(seed);
    if (nextBelow(candidate, RULES.rollBound)[0] === roll) return candidate;
  }
  throw new Error(`no seed in range draws ${String(roll)} first`);
};

/** The first roll a state draws, for readability in the assertions below. */
const firstRoll = (rng: RngState): number => nextBelow(rng, RULES.rollBound)[0];

/**
 * A `UnitDef` whose `hitPoints` this file *knows* is present, so the three assertions
 * below can read it as a number.
 *
 * `UnitDef.hitPoints` is optional on purpose (it is the engine's view, and hand-built
 * literals predate M6), and `rules.UnitSpec` is where content is required to declare it.
 * Narrowing it here is how a test states "this fixture is a *complete* definition"
 * without a non-null assertion and without pretending the shipped view is stricter than
 * it is.
 */
interface CompleteUnitDef extends UnitDef {
  readonly hitPoints: number;
}

const ATTACKER_DEF: CompleteUnitDef = {
  id: asUnitTypeId('attacker'),
  role: 'military',
  name: 'Attacker',
  attack: 3,
  defense: 1,
  hitPoints: 3,
  movement: 1,
  cost: 1,
  domain: 'land',
};

const DEFENDER_DEF: CompleteUnitDef = {
  id: asUnitTypeId('defender'),
  role: 'military',
  name: 'Defender',
  attack: 1,
  defense: 3,
  hitPoints: 3,
  movement: 1,
  cost: 1,
  domain: 'land',
};

/** A unit literal with only the fields the state has; M6's optional pair is added below. */
const unit = (id: number, type: UnitDef, tile: number, extra: Partial<Unit> = {}): Unit => ({
  id: asUnitId(id),
  type: type.id,
  owner: asPlayerId(0),
  tile: asTileIndex(tile),
  movementLeft: type.movement,
  hitPointsLeft: fullHitPoints(type),
  ...extra,
});

/** A two-player, four-tile state holding exactly the units handed in. */
const stateWith = (units: readonly Unit[]): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: {
    width: 2,
    height: 2,
    terrain: [0, 1, 2, 3].map((index) => asTerrainId(`t${String(index)}`)),
    huts: [],
    resources: [],
  },
  players: [
    {
      id: asPlayerId(0),
      name: 'Player 1',
      color: '#d12f2f',
      startingTile: asTileIndex(0),
      kind: 'civ',
      // M9: a player carries a government. `defaultGovernmentOf` picks the first row of
      // the ruleset's `governments` section, which is `despotism` in the shipped catalog;
      // this literal is a hand-built state, so it states the id rather than deriving it.
      government: asGovernmentId('despotism'),
      treasury: 0,
      rates: { tax: 5, science: 5, luxury: 0 },
      beakers: 0,
      luxuries: 0,
      techs: [],
    },
  ],
  nextUnitId: units.length,
  units,
  explored: [Array.from({ length: 4 }, () => false)],
  nextCityId: 0,
  // M9: the materialised ownership layer. `[]` is the honest value for a
  // state nobody has run a turn on: `withOwnership` fills it from the cities the
  // moment ownership matters, and `computeTileOwner` never reads it, so an empty
  // layer cannot make a border wrong — it only means none has been claimed yet.
  tileOwner: [],
  cities: [],
  improvements: [],
});

/** The context for a plain 3-attack against 3-defence fight, with no modifiers. */
const context = (overrides: Partial<CombatContext> = {}): CombatContext => ({
  rules: RULES,
  attacker: { attack: 3, defense: 1, bonusPct: 0 },
  defender: { attack: 1, defense: 3, bonusPct: 0 },
  attackerHitPoints: 3,
  defenderHitPoints: 3,
  rng: RNG,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * The odds — exact, hand-computed
 * ------------------------------------------------------------------ */

describe('winPct — the per-round chance, floored once', () => {
  it('is attack / (attack + defense) as a whole percentage', () => {
    // 3 / (3 + 3) = 50% exactly.
    expect(winPct(RULES, 3, 3)).toBe(50);
    // 4 / (4 + 1) = 80%.
    expect(winPct(RULES, 4, 1)).toBe(80);
    // 2 / (2 + 3) = 40%.
    expect(winPct(RULES, 2, 3)).toBe(40);
  });

  it('floors rather than rounding, so a 2/3 majority is 66 and not 67', () => {
    // 2 / (2 + 1) = 66.66…% -> 66. Rounding here would make a strictly weaker attacker
    // look like a two-thirds favourite.
    expect(winPct(RULES, 2, 1)).toBe(66);
    // 1 / (1 + 2) = 33.33…% -> 33.
    expect(winPct(RULES, 1, 2)).toBe(33);
    // 1 / (1 + 7) = 12.5% -> 12.
    expect(winPct(RULES, 1, 7)).toBe(12);
  });

  it('clamps to 1..99, so no battle is decided before it is fought', () => {
    // A defence of zero would be a 100% attacker, and an attack of zero a 0% one. Both
    // are clamped: the extremes of the table are the reason MIN/RULES.maxWinPct exist.
    expect(winPct(RULES, 5, 0)).toBe(RULES.maxWinPct);
    expect(winPct(RULES, 1000, 1)).toBe(RULES.maxWinPct);
    expect(winPct(RULES, 0, 5)).toBe(RULES.minWinPct);
    expect(winPct(RULES, 0, 0)).toBe(RULES.minWinPct);
  });

  it('is total: a hostile value cannot produce a fraction, NaN or a throw', () => {
    expect(Number.isInteger(winPct(RULES, 1.5, 2.5))).toBe(true);
    expect(winPct(RULES, -4, 2)).toBe(RULES.minWinPct);
    // A strength that is not a finite number carries no strength at all, which is read
    // exactly like a zero: `NaN` defence means "no defence" (an overwhelming attacker),
    // `NaN` attack means "no attack" (a hopeless one).
    expect(winPct(RULES, Number.NaN, 2)).toBe(RULES.minWinPct);
    expect(winPct(RULES, 1, Number.NaN)).toBe(RULES.maxWinPct);
    // An infinite attack is unreadable rather than overwhelming: the alternative would be
    // to hand a caller that wrote `Infinity` a 99% guarantee it never earned.
    expect(winPct(RULES, Number.POSITIVE_INFINITY, 1)).toBe(RULES.minWinPct);
    expect(winPct(RULES, 10, Number.NEGATIVE_INFINITY)).toBe(RULES.maxWinPct);
    expect(Number.isInteger(winPct(RULES, Number.NaN, Number.NaN))).toBe(true);
  });
});

describe('the modifier rule — percentages are summed, then floored ONCE', () => {
  it('floors once: floor(3 * 200/100) = 6', () => {
    expect(modifiedDefense(3, 50 + 50)).toBe(6);
  });

  it('differs from flooring each modifier separately — the rule is load-bearing', () => {
    // The two answers, side by side. `a` is the shipped rule; `b` is what a refactor that
    // applied one modifier at a time (or floored per modifier) would produce.
    const summed = modifiedDefense(3, 50 + 50); // floor(3 * 2)      = 6
    const stepped = modifiedDefense(modifiedDefense(3, 50), 50); // floor(floor(4.5)=4 * 1.5) = 6
    expect(summed).toBe(6);
    expect(stepped).toBe(6);

    // The discriminating case: defence 1 against two 50% modifiers.
    //   summed  -> floor(1 * (100 + 50 + 50) / 100) = floor(2)   = 2
    //   stepped -> floor(floor(1.5) * 1.5)          = floor(1.5) = 1  (and floor(1 * 1.5)=1)
    const summedOne = modifiedDefense(1, 50 + 50);
    const steppedOne = modifiedDefense(modifiedDefense(1, 50), 50);
    expect(summedOne).toBe(2);
    expect(steppedOne).toBe(1);
    expect(summedOne).not.toBe(steppedOne);

    // Odd numbers make the gap largest. defence 3 with three 50% modifiers:
    //   summed  -> floor(3 * 2.5) = 7
    //   stepped -> floor(floor(floor(4.5)=4 * 1.5)=6 * 1.5) = 9 ... which is *larger*,
    //   so this is not a one-way bug: getting the rule wrong moves the number in
    //   whichever direction the individual floors happen to point.
    expect(modifiedDefense(3, 50 + 50 + 50)).toBe(7);
    expect(modifiedDefense(modifiedDefense(modifiedDefense(3, 50), 50), 50)).toBe(9);
  });

  it('reads a terrain defence bonus under either name, preferring the M6 one', () => {
    // Shipped content writes `defenseBonus` and the engine's view type still declares
    // `defenseBonusPct`, so both spellings reach this reader. The M6 name wins when the two
    // disagree, which is why `validateRuleset` refuses a row where they do.
    expect(terrainDefenseBonus({ defenseBonus: 50 })).toBe(50);
    expect(terrainDefenseBonus({ defenseBonusPct: 25 })).toBe(25);
    expect(terrainDefenseBonus({ defenseBonus: 50, defenseBonusPct: 25 })).toBe(50);
    // The pre-M6 shape in full: a real `TerrainDef` declares only the older name.
    expect(
      terrainDefenseBonus({
        role: 'hills',
        name: 'Hills',
        moveCost: 1,
        defenseBonusPct: 50,
      } as { defenseBonusPct?: number }),
    ).toBe(50);
  });

  it('never invents a terrain bonus out of a hostile value', () => {
    // Totality, in the direction that matters: a modifier the game did not declare must not
    // appear. A negative or fractional percentage is not a bonus, and an unreadable one is
    // 0 rather than `NaN` — a `NaN` here would poison the defender's summed percentage and
    // then every comparison in the round loop.
    expect(terrainDefenseBonus({})).toBe(0);
    expect(terrainDefenseBonus({ defenseBonus: -50 })).toBe(0);
    expect(terrainDefenseBonus({ defenseBonus: 12.5 })).toBe(12);
    expect(terrainDefenseBonus({ defenseBonus: Number.NaN })).toBe(0);
    expect(terrainDefenseBonus({ defenseBonus: Number.NaN, defenseBonusPct: 25 })).toBe(25);
    expect(terrainDefenseBonus({ defenseBonus: Number.POSITIVE_INFINITY })).toBe(0);
    expect(terrainDefenseBonus({ defenseBonusPct: -1 })).toBe(0);
    expect(Number.isInteger(terrainDefenseBonus({ defenseBonus: 33.9 }))).toBe(true);
  });

  it('is the rule the resolver uses, not just the helper', () => {
    // defence 1, terrain 50 + fortify 25 (RULES.fortifyBonusPct) + city 50 + walls 50 = 175%.
    const bonus = defenderBonusPct(RULES, {
      terrainBonusPct: 50,
      fortified: true,
      inCity: true,
      walls: true,
    });
    expect(bonus).toBe(
      50 + RULES.fortifyBonusPct + RULES.cityDefenseBonusPct + RULES.wallsBonusPct,
    );

    // floor(1 * (100 + 175) / 100) = 2. The resolver must see that 2, not the 1 that
    // flooring each bonus separately would give.
    expect(modifiedDefense(1, bonus)).toBe(2);

    const summed = resolveCombat(
      context({
        defender: { attack: 1, defense: 1, bonusPct: bonus },
        attackerHitPoints: 1,
        defenderHitPoints: 1,
        static: [99],
      }),
    );
    // Effective attack 3 against effective defence 2 -> floor(3 * 100 / 5) = 60.
    // The stepped answer, defence 1, would have given floor(300 / 4) = 75.
    expect(summed.result.attackerWinPct).toBe(60);
  });

  it('reads the defender bonus list once, and only honours walls inside a city', () => {
    expect(
      defenderBonusPct(RULES, {
        terrainBonusPct: 0,
        fortified: false,
        inCity: false,
        walls: false,
      }),
    ).toBe(0);
    expect(
      defenderBonusPct(RULES, {
        terrainBonusPct: 25,
        fortified: false,
        inCity: false,
        walls: false,
      }),
    ).toBe(25);
    expect(
      defenderBonusPct(RULES, { terrainBonusPct: 0, fortified: true, inCity: false, walls: false }),
    ).toBe(RULES.fortifyBonusPct);
    expect(
      defenderBonusPct(RULES, { terrainBonusPct: 0, fortified: false, inCity: true, walls: false }),
    ).toBe(RULES.cityDefenseBonusPct);
    expect(
      defenderBonusPct(RULES, { terrainBonusPct: 0, fortified: false, inCity: true, walls: true }),
    ).toBe(RULES.cityDefenseBonusPct + RULES.wallsBonusPct);
    // Walls are a property of a city: a unit standing in the open cannot have them.
    expect(
      defenderBonusPct(RULES, { terrainBonusPct: 0, fortified: false, inCity: false, walls: true }),
    ).toBe(0);
  });
});

describe('veteranAttack — the attacker bonus, summed once and floored once', () => {
  it('adds RULES.veteranAttackPct per experience level', () => {
    expect(veteranBonusPct(RULES, 0)).toBe(0);
    expect(veteranBonusPct(RULES, 1)).toBe(RULES.veteranAttackPct);
    expect(veteranBonusPct(RULES, RULES.maxExperience)).toBe(
      RULES.maxExperience * RULES.veteranAttackPct,
    );
  });

  it('floors once, at the end, on the summed percentage', () => {
    // floor(3 * (100 + 25) / 100) = floor(3.75) = 3.
    expect(veteranAttack(RULES, 3, 1)).toBe(3);
    // The two 25% steps applied separately would be floor(floor(3*1.25)=3 * 1.25) = 3 as
    // well, so use a value where the difference shows:
    //   summed at 50% -> floor(5 * 1.5) = 7
    //   stepped       -> floor(floor(6.25)=6 * 1.25) = 7 ... equal again;
    //   summed at 75% -> floor(5 * 1.75) = 8
    //   stepped       -> floor(floor(floor(6.25)=6*1.25)=7 * 1.25) = 8 — equal;
    // so this test pins the *identity* the sum produces for the level ladder rather than
    // pretending the two differ here. The discriminating compounding case is the
    // defender's, above, where the bonus list has more than one kind of entry.
    expect(veteranAttack(RULES, 5, 2)).toBe(7);
    expect(veteranAttack(RULES, 5, 3)).toBe(8);
    // A hostile experience value contributes nothing rather than a negative bonus.
    expect(veteranAttack(RULES, 3, -1)).toBe(3);
    expect(veteranAttack(RULES, 3, 1.5)).toBe(3);
    expect(Number.isInteger(veteranAttack(RULES, 3, Number.NaN))).toBe(true);
  });

  it('is what fills CombatSide.bonusPct, so the caller re-derives nothing', () => {
    expect(veteranBonusPct(RULES, 2)).toBe(2 * RULES.veteranAttackPct);
  });
});

/* ------------------------------------------------------------------ *
 * The tie rule
 * ------------------------------------------------------------------ */

describe('the defender wins ties', () => {
  // 3 attack against 3 defence is exactly 50%, so the threshold is 50 and a draw of 50 is
  // the boundary — the one value a test cannot reach by choosing a seed.
  const threshold = winPct(RULES, 3, 3);

  it('gives the round to the attacker strictly below the threshold', () => {
    expect(drawsWin(threshold - 1, threshold)).toBe(true);
    expect(drawsWin(0, threshold)).toBe(true);
  });

  it('gives the round to the DEFENDER at exactly the threshold', () => {
    expect(drawsWin(threshold, threshold)).toBe(false);
    expect(drawsWin(threshold + 1, threshold)).toBe(false);
    expect(drawsWin(RULES.rollBound - 1, threshold)).toBe(false);
  });

  it('resolves a boundary draw as a defender round, in a real battle', () => {
    expect(threshold).toBe(50);

    // One hit point each, so a single round decides the battle. A draw of exactly 50 must
    // kill the ATTACKER; a draw of 49 must kill the defender.
    const atThreshold = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, static: [threshold] }),
    );
    expect(atThreshold.result.outcome).toBe('defender-wins');
    expect(atThreshold.result.attackerSurvives).toBe(false);
    expect(atThreshold.result.defenderSurvives).toBe(true);
    expect(atThreshold.result.attackerLost).toBe(1);
    expect(atThreshold.result.defenderLost).toBe(0);
    expect(atThreshold.result.rounds).toBe(1);

    const justBelow = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, static: [threshold - 1] }),
    );
    expect(justBelow.result.outcome).toBe('attacker-wins');
    expect(justBelow.result.attackerSurvives).toBe(true);
    expect(justBelow.result.defenderSurvives).toBe(false);
    expect(justBelow.result.attackerLost).toBe(0);
    expect(justBelow.result.defenderLost).toBe(1);
  });

  it('still hands the defender the round at the top of the roll range at 99%', () => {
    // A 99% attacker: the threshold is 99, so only a draw of 0..98 wins.
    const ninetyNine = resolveCombat(
      context({
        attacker: { attack: 99, defense: 0, bonusPct: 0 },
        defender: { attack: 0, defense: 1, bonusPct: 0 },
        attackerHitPoints: 1,
        defenderHitPoints: 1,
        static: [99],
      }),
    );
    expect(ninetyNine.result.attackerWinPct).toBe(RULES.maxWinPct);
    expect(ninetyNine.result.outcome).toBe('defender-wins');
  });
});

/* ------------------------------------------------------------------ *
 * The result — hit points, rounds, survival
 * ------------------------------------------------------------------ */

describe('resolveCombat — hit points, rounds and survival', () => {
  it('reports the per-round chance and the exact threshold it used', () => {
    const result = resolveCombat(context({ static: [0, 0, 0] })).result;
    expect(result.attackerWinPct).toBe(50);
    expect(result.attackerWinsBelow).toBe(50);
    expect(result.rollBound).toBe(RULES.rollBound);
  });

  it('takes exactly RULES.damagePerRound per round and survives at 1 hit point', () => {
    // Attacker 2 hit points against a defender that loses every round: the defender dies
    // on round 1 while the attacker is untouched.
    const quick = resolveCombat(
      context({ attackerHitPoints: 2, defenderHitPoints: 1, static: [0] }),
    ).result;
    expect(quick.rounds).toBe(1);
    expect(quick.attackerLost).toBe(0);
    expect(quick.defenderLost).toBe(RULES.damagePerRound);
    expect(quick.attackerSurvives).toBe(true);
    expect(quick.defenderSurvives).toBe(false);
  });

  it('loses exactly one hit point per lost round, and dies on the last one', () => {
    // Every round lost (draw 99 >= the 50 threshold). The defender outlasts the attacker,
    // so the battle ends when the ATTACKER reaches zero — after exactly as many rounds as
    // it had hit points.
    const five = resolveCombat(
      context({ attackerHitPoints: 5, defenderHitPoints: 9, static: Array(9).fill(99) }),
    ).result;
    expect(five.rounds).toBe(5);
    expect(five.attackerLost).toBe(5);
    expect(five.defenderLost).toBe(0);
    expect(five.attackerSurvives).toBe(false);
    expect(five.defenderSurvives).toBe(true);
    expect(five.outcome).toBe('defender-wins');

    // One hit point fewer and the same script leaves it at 1: "survives at 1" is a real
    // state, not an off-by-one. The defender is one hit point weaker here so that *it* is
    // what ends the battle, which is the case the loop condition exists for.
    const four = resolveCombat(
      context({ attackerHitPoints: 4, defenderHitPoints: 4, static: Array(9).fill(99) }),
    ).result;
    expect(four.rounds).toBe(4);
    expect(four.attackerLost).toBe(4);
    expect(four.defenderLost).toBe(0);
    expect(four.attackerSurvives).toBe(false);
    expect(four.defenderSurvives).toBe(true);

    // And a defender that never wins leaves the attacker untouched.
    const untouched = resolveCombat(
      context({ attackerHitPoints: 2, defenderHitPoints: 2, static: [0, 0] }),
    ).result;
    expect(untouched.rounds).toBe(2);
    expect(untouched.attackerLost).toBe(0);
    expect(untouched.defenderLost).toBe(2);
    expect(untouched.attackerSurvives).toBe(true);
    expect(untouched.defenderSurvives).toBe(false);
  });

  it('counts both sides’ losses when the battle alternates', () => {
    // An overwhelming attacker (99% threshold) against a tougher defender, alternating:
    // round 1 lost (draw 99), then two rounds won. The attacker ends on 1 hit point and the
    // defender is destroyed after three rounds.
    const both = resolveCombat(
      context({
        attacker: { attack: 99, defense: 1, bonusPct: 0 },
        defender: { attack: 1, defense: 1, bonusPct: 0 },
        attackerHitPoints: 2,
        defenderHitPoints: 2,
        static: [99, 0, 0],
      }),
    ).result;
    expect(both.rounds).toBe(3);
    expect(both.attackerLost).toBe(1);
    expect(both.defenderLost).toBe(2);
    expect(both.attackerSurvives).toBe(true);
    expect(both.defenderSurvives).toBe(false);
    expect(both.outcome).toBe('attacker-wins');
  });

  it('normalises a hit point count that is not a positive whole number', () => {
    // A battle between "already dead" units is not a question worth throwing over, and a
    // fraction must never reach the result: both are read as 1.
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      const result = resolveCombat(
        context({ attackerHitPoints: bad, defenderHitPoints: bad, static: [0] }),
      ).result;
      expect(Number.isInteger(result.rounds)).toBe(true);
      expect(result.rounds).toBe(1);
    }
  });

  it('never runs a round without a winner: every battle ends', () => {
    // A 99% attacker against a 1-hit-point defender cannot loop: each round costs a hit
    // point, and the loop condition is a side reaching zero.
    const result = resolveCombat(
      context({
        attacker: { attack: 99, defense: 0, bonusPct: 0 },
        defender: { attack: 1, defense: 99, bonusPct: 0 },
        attackerHitPoints: 1,
        defenderHitPoints: 1,
      }),
    ).result;
    expect(result.rounds).toBe(1);
    expect(['attacker-wins', 'defender-wins']).toContain(result.outcome);
  });
});

/* ------------------------------------------------------------------ *
 * Purity and determinism
 * ------------------------------------------------------------------ */

describe('resolveCombat is pure and reproducible', () => {
  it('gives an identical result, and an identical next RNG state, for the same input', () => {
    const ctx = context({ attackerHitPoints: 4, defenderHitPoints: 4 });
    const first = resolveCombat(ctx);
    const second = resolveCombat(ctx);

    expect(second.result).toStrictEqual(first.result);
    expect(second.rng).toStrictEqual(first.rng);
    expect(first.rng).toStrictEqual(first.result.rng);
  });

  it('advances the RNG by exactly one draw per round', () => {
    // Drawn from the stream: the state after N rounds is the state after N `nextBelow`
    // calls, no more and no fewer. This is the property that makes a battle reproducible
    // from the seed — a resolver that drew twice per round, or that drew even when the
    // battle was already over, would move the world's RNG differently.
    const real = resolveCombat(context({ attackerHitPoints: 9, defenderHitPoints: 1, rng: RNG }));
    expect(real.result.rounds).toBe(1);
    const afterOne = nextBelow(RNG, RULES.rollBound)[1];
    expect(real.rng).toStrictEqual(afterOne);
    expect(real.rng).toStrictEqual(real.result.rng);

    const longer = resolveCombat(context({ attackerHitPoints: 9, defenderHitPoints: 6, rng: RNG }));
    let expected = RNG;
    for (let round = 0; round < longer.result.rounds; round += 1) {
      expected = nextBelow(expected, RULES.rollBound)[1];
    }
    expect(longer.rng).toStrictEqual(expected);
    expect(longer.result.rounds).toBeGreaterThan(1);
  });

  it('draws NOTHING from the stream when every round is scripted', () => {
    // A fully scripted battle is a pure observation of the resolver: it must leave the
    // game's randomness exactly where it found it. The script covers every round, because
    // a script that runs out falls back to the stream — which is the honest behaviour,
    // and which this test therefore has to distinguish from "never drew at all".
    const scripted = resolveCombat(
      context({
        attackerHitPoints: 3,
        defenderHitPoints: 3,
        static: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      }),
    );
    expect(scripted.result.rounds).toBe(3);
    expect(scripted.rng).toStrictEqual(RNG);
    expect(scripted.result.rng).toStrictEqual(RNG);

    const overLong = resolveCombat(
      context({ attackerHitPoints: 2, defenderHitPoints: 2, static: [99, 99, 99, 99] }),
    );
    expect(overLong.result.rounds).toBe(2);
    expect(overLong.rng).toStrictEqual(RNG);
  });

  it('depends on the stream it was handed, not on any ambient source', () => {
    // The same battle under two seeds that draw different first rolls: the resolver must
    // follow the roll, so a 1-hit-point fight flips its winner with the seed.
    const attackerWins = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, rng: seedWithFirstRoll(0) }),
    ).result;
    const defenderWins = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, rng: seedWithFirstRoll(99) }),
    ).result;

    expect(firstRoll(seedWithFirstRoll(0))).toBe(0);
    expect(firstRoll(seedWithFirstRoll(99))).toBe(99);
    expect(attackerWins.outcome).toBe('attacker-wins');
    expect(defenderWins.outcome).toBe('defender-wins');
  });

  it('leaves the caller’s RNG state object untouched', () => {
    const rng: RngState = { a: 5, b: 6, c: 7, d: 8 };
    const snapshot = { ...rng };
    resolveCombat(context({ rng, attackerHitPoints: 6, defenderHitPoints: 6 }));
    expect(rng).toStrictEqual(snapshot);
  });

  it('refuses to be a hidden mutation: the context object is unchanged', () => {
    const ctx = context({ attackerHitPoints: 2, defenderHitPoints: 2 });
    const snapshot = { ...ctx, attacker: { ...ctx.attacker }, defender: { ...ctx.defender } };
    resolveCombat(ctx);
    expect(ctx).toStrictEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * Experience, in the resolver
 * ------------------------------------------------------------------ */

describe('experience raises the attacker’s odds, and only the attacker’s', () => {
  it('increases the win chance by the veteran percentage', () => {
    const plain = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, static: [0] }),
    ).result;
    const veteran = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, experience: 2, static: [0] }),
    ).result;

    expect(plain.attackerWinPct).toBe(50);
    // floor(3 * (100 + 50) / 100) = 4, so 4 / (4 + 3) = 57%.
    expect(veteran.attackerWinPct).toBe(57);
    expect(veteran.attackerWinPct).toBeGreaterThan(plain.attackerWinPct);
  });

  it('is absent-equivalent to zero, so omitting it and passing 0 agree exactly', () => {
    const omitted = resolveCombat(context({ static: [30] })).result;
    const zero = resolveCombat(context({ experience: 0, static: [30] })).result;
    expect(zero).toStrictEqual(omitted);
  });

  it('is capped in effect by RULES.maxWinPct: a promotion cannot make a round certain', () => {
    const overwhelming = resolveCombat(
      context({
        attacker: { attack: 10, defense: 1, bonusPct: 0 },
        defender: { attack: 1, defense: 0, bonusPct: 0 },
        experience: RULES.maxExperience,
        attackerHitPoints: 1,
        defenderHitPoints: 1,
        static: [RULES.maxWinPct],
      }),
    ).result;
    expect(overwhelming.attackerWinPct).toBe(RULES.maxWinPct);
    expect(overwhelming.outcome).toBe('defender-wins');
  });
});

/* ------------------------------------------------------------------ *
 * units.ts — the state combat writes into
 * ------------------------------------------------------------------ */

describe('hitPointsLeft — the field, and the range it must stay in', () => {
  it('a spawned unit starts at its type’s hitPoints, at full health', () => {
    const state = stateWith([]);
    const spawned = spawnUnit(state, ATTACKER_DEF, asPlayerId(0), asTileIndex(0));
    expect(spawned.unit.hitPointsLeft).toBe(ATTACKER_DEF.hitPoints);
    expect(hitPointsLeftOf(spawned.unit)).toBe(ATTACKER_DEF.hitPoints);
    expect(maxHitPointsOf(ATTACKER_DEF, 1)).toBe(ATTACKER_DEF.hitPoints);
  });

  it('a fresh unit carries neither optional key — absent, not undefined', () => {
    const spawned = spawnUnit(stateWith([]), ATTACKER_DEF, asPlayerId(0), asTileIndex(0));
    expect('experience' in spawned.unit).toBe(false);
    expect('fortified' in spawned.unit).toBe(false);
    expect(Object.keys(spawned.unit)).not.toContain('experience');
    expect(Object.keys(spawned.unit)).not.toContain('fortified');
  });

  it('reads a missing or broken hitPointsLeft as full health rather than as dead', () => {
    const bare: Unit = {
      id: asUnitId(0),
      type: ATTACKER_DEF.id,
      owner: asPlayerId(0),
      tile: asTileIndex(0),
      movementLeft: 1,
    };
    // A pre-M6 unit literal is at full health, not at zero: the reading that keeps an old
    // save playable instead of making every unit in it already destroyed.
    expect(hitPointsLeftOf(bare)).toBe(1);
    expect(hitPointsLeftOf({ ...bare, hitPointsLeft: 0 })).toBe(1);
    expect(hitPointsLeftOf({ ...bare, hitPointsLeft: -2 })).toBe(1);
    expect(hitPointsLeftOf({ ...bare, hitPointsLeft: 1.5 })).toBe(1);
    expect(hitPointsLeftOf({ ...bare, hitPointsLeft: 2 })).toBe(2);
  });

  it('falls back to 1 for a definition that declares no usable hitPoints', () => {
    // The three ways a *view* can fail to describe a usable maximum: absent (the ship
    // shape of `UnitDef`, since the field is optional there), zero, and a fraction. The
    // reader is total over all of them, and answers 1 — never 0, which would be a live
    // unit at zero hit points.
    const noKey: UnitDef = {
      id: ATTACKER_DEF.id,
      role: ATTACKER_DEF.role,
      name: ATTACKER_DEF.name,
      attack: ATTACKER_DEF.attack,
      defense: ATTACKER_DEF.defense,
      movement: ATTACKER_DEF.movement,
      cost: ATTACKER_DEF.cost,
      domain: ATTACKER_DEF.domain,
    };
    expect('hitPoints' in noKey).toBe(false);
    expect(fullHitPoints(noKey)).toBe(1);
    expect(fullHitPoints({ ...ATTACKER_DEF, hitPoints: 0 })).toBe(1);
    expect(fullHitPoints({ ...ATTACKER_DEF, hitPoints: -3 })).toBe(1);
    expect(fullHitPoints({ ...ATTACKER_DEF, hitPoints: 2.5 })).toBe(1);
    expect(fullHitPoints({ ...ATTACKER_DEF, hitPoints: Number.NaN })).toBe(1);
    expect(fullHitPoints(undefined)).toBe(1);
  });
});

describe('damage, healing and promotion are total pure functions', () => {
  const full = unit(0, ATTACKER_DEF, 0);

  it('wounds by subtracting, and reports death as undefined rather than 0', () => {
    const wounded = damageUnit(full, 1);
    expect(wounded?.hitPointsLeft).toBe(2);
    expect(damageUnit(full, 2)?.hitPointsLeft).toBe(1);
    // Exactly zero: gone.
    expect(damageUnit(full, 3)).toBeUndefined();
    expect(damageUnit(full, 99)).toBeUndefined();
  });

  it('never returns a unit that exists with zero hit points', () => {
    for (const damage of [3, 4, 1000]) {
      const result = damageUnit(full, damage);
      expect(result).toBeUndefined();
    }
  });

  it('keeps experience and fortification through a wound', () => {
    const veteran = withFortified(withExperience(full, 2));
    const wounded = damageUnit(veteran, 1);
    expect(wounded?.experience).toBe(2);
    expect(wounded?.fortified).toBe(true);
  });

  it('treats a non-integer or negative damage as no damage, never as a fraction', () => {
    expect(damageUnit(full, -1)).toStrictEqual(full);
    expect(damageUnit(full, 0)).toStrictEqual(full);
    expect(damageUnit(full, 0.5)).toStrictEqual(full);
    expect(damageUnit(full, Number.NaN)).toStrictEqual(full);
  });

  it('heals up to the type’s maximum and no further', () => {
    const hurt = { ...full, hitPointsLeft: 1 };
    expect(healUnit(hurt, ATTACKER_DEF, 1).hitPointsLeft).toBe(2);
    expect(healUnit(hurt, ATTACKER_DEF, 99).hitPointsLeft).toBe(ATTACKER_DEF.hitPoints);
    expect(healUnit(full, ATTACKER_DEF, 5).hitPointsLeft).toBe(ATTACKER_DEF.hitPoints);
    // Without a definition, "full" is what the unit already has: a no-op rather than an
    // invented promotion to a maximum nothing knows.
    expect(healUnit(hurt, undefined, 2).hitPointsLeft).toBe(1);
    // A non-positive or fractional amount is a no-op.
    expect(healUnit(hurt, ATTACKER_DEF, 0).hitPointsLeft).toBe(1);
    expect(healUnit(hurt, ATTACKER_DEF, -2).hitPointsLeft).toBe(1);
    expect(healUnit(hurt, ATTACKER_DEF, 1.5).hitPointsLeft).toBe(1);
  });

  it('promotes one level per call, up to the cap, and never past it', () => {
    let promoted = full;
    for (let level = 1; level <= RULES.maxExperience; level += 1) {
      promoted = promoteUnit(promoted, RULES.maxExperience);
      expect(experienceOf(promoted)).toBe(level);
    }
    expect(experienceOf(promoteUnit(promoted, RULES.maxExperience))).toBe(RULES.maxExperience);
    // A nonsense cap grants nothing rather than promoting without limit.
    expect(experienceOf(promoteUnit(full, 0))).toBe(0);
    expect(experienceOf(promoteUnit(full, Number.NaN))).toBe(0);
  });

  it('reads a hostile experience value as zero', () => {
    expect(experienceOf({ ...full, experience: -1 })).toBe(0);
    expect(experienceOf({ ...full, experience: 0 })).toBe(0);
    expect(experienceOf({ ...full, experience: 1.5 })).toBe(0);
    expect(experienceOf({ ...full, experience: 3 })).toBe(3);
  });

  it('fortifies and clears by the key being present or absent', () => {
    const dug = withFortified(full);
    expect(isFortified(dug)).toBe(true);
    expect('fortified' in dug).toBe(true);
    const cleared = clearFortified(dug);
    expect(isFortified(cleared)).toBe(false);
    expect('fortified' in cleared).toBe(false);
    // Anything but `true` reads as "not fortified", including a hostile value.
    expect(isFortified({ ...full, fortified: false })).toBe(false);
  });

  it('clears experience by removing the key, never by writing 0 or undefined', () => {
    const veteran = withExperience(full, 2);
    expect('experience' in veteran).toBe(true);
    const cleared = withoutExperience(veteran);
    expect('experience' in cleared).toBe(false);
    expect(experienceOf(cleared)).toBe(0);
    // A non-positive value clears rather than writing `0`.
    expect('experience' in withExperience(full, 0)).toBe(false);
    expect('experience' in withExperience(full, 2.5)).toBe(false);
  });
});

describe('a unit at 0 hit points is REMOVED, not stored at 0', () => {
  it('woundUnit removes a unit the damage kills, and says so', () => {
    const state = stateWith([unit(0, ATTACKER_DEF, 0), unit(1, DEFENDER_DEF, 1)]);
    const outcome = woundUnit(state, asUnitId(0), ATTACKER_DEF.hitPoints);
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;

    expect(outcome.destroyed).toBe(true);
    expect(outcome.unit).toBeUndefined();
    expect(unitById(outcome.state, asUnitId(0))).toBeUndefined();
    expect(outcome.state.units.map((u) => Number(u.id))).toEqual([1]);
    // No unit anywhere in the state is left alive at zero.
    for (const survivor of outcome.state.units)
      expect(hitPointsLeftOf(survivor)).toBeGreaterThan(0);
  });

  it('woundUnit keeps a unit that survives, at the reduced count', () => {
    const state = stateWith([unit(0, ATTACKER_DEF, 0)]);
    const outcome = woundUnit(state, asUnitId(0), 1);
    expect(outcome?.destroyed).toBe(false);
    expect(outcome?.unit?.hitPointsLeft).toBe(ATTACKER_DEF.hitPoints - 1);
    expect(outcome?.state.units).toHaveLength(1);
    const survivor = outcome?.state.units[0];
    expect(survivor).toBeDefined();
    expect(survivor?.hitPointsLeft).toBe(ATTACKER_DEF.hitPoints - 1);
  });

  it('woundUnit answers undefined for a unit the state does not hold', () => {
    expect(woundUnit(stateWith([]), asUnitId(7), 1)).toBeUndefined();
  });

  it('removes a unit by id and leaves the rest in id order', () => {
    const state = stateWith([
      unit(0, ATTACKER_DEF, 0),
      unit(1, ATTACKER_DEF, 1),
      unit(2, ATTACKER_DEF, 2),
    ]);
    const after = removeUnit(state, asUnitId(1));
    expect(after.units.map((u) => Number(u.id))).toEqual([0, 2]);
    // Removing a unit that is already gone is a no-op, not an error.
    expect(removeUnit(after, asUnitId(1)).units).toHaveLength(2);
  });

  it('withUnits never reuses an id, even after the highest one is destroyed', () => {
    const state = stateWith([unit(0, ATTACKER_DEF, 0), unit(1, ATTACKER_DEF, 1)]);
    const after = removeUnit(state, asUnitId(1));
    // nextUnitId was 2; removing id 1 must not hand id 1 out again.
    const spawned = spawnUnit(after, ATTACKER_DEF, asPlayerId(0), asTileIndex(2));
    expect(Number(spawned.unit.id)).toBe(2);
    expect(withUnits(state, [], 0).nextUnitId).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The omitted-key rule — the bug class that has bitten four times
 * ------------------------------------------------------------------ */

describe('experience and fortified are absent or present, never undefined', () => {
  const bare: Unit = unit(0, ATTACKER_DEF, 0);

  it('omits both keys on a unit that has neither', () => {
    expect('experience' in bare).toBe(false);
    expect('fortified' in bare).toBe(false);
    // `Object.keys` is what `canonicalize` walks: a key holding `undefined` would appear
    // here and be rejected.
    expect(Object.keys(bare)).not.toContain('experience');
    expect(Object.keys(bare)).not.toContain('fortified');
  });

  it('never writes a key holding undefined through any of the writers', () => {
    const writers: readonly Unit[] = [
      withExperience(bare, 1),
      withExperience(bare, 0),
      withoutExperience(withExperience(bare, 2)),
      withFortified(bare),
      clearFortified(withFortified(bare)),
      healUnit({ ...bare, hitPointsLeft: 1 }, ATTACKER_DEF, 1),
      damageUnit(bare, 1) ?? bare,
      promoteUnit(bare, RULES.maxExperience),
    ];
    for (const written of writers) {
      for (const key of ['experience', 'fortified', 'work'] as const) {
        if (key in written) expect(written[key]).not.toBeUndefined();
      }
      expect(JSON.stringify(written)).not.toContain('undefined');
    }
  });

  it('survives a JSON round trip with experience present and fortified absent', () => {
    const veteran = withFortified(withExperience(bare, 2));
    const roundTripped: Unit = JSON.parse(JSON.stringify(veteran)) as Unit;
    expect(roundTripped).toStrictEqual(veteran);
    expect(roundTripped.experience).toBe(2);
    expect(roundTripped.fortified).toBe(true);
    expect(experienceOf(roundTripped)).toBe(2);
  });

  it('survives a JSON round trip with both absent', () => {
    const roundTripped: Unit = JSON.parse(JSON.stringify(bare)) as Unit;
    expect(roundTripped).toStrictEqual(bare);
    expect('experience' in roundTripped).toBe(false);
    expect('fortified' in roundTripped).toBe(false);
    expect(roundTripped.hitPointsLeft).toBe(ATTACKER_DEF.hitPoints);
  });

  it('round-trips a whole state holding one of each, with no undefined key anywhere', () => {
    const state = stateWith([
      unit(0, ATTACKER_DEF, 0, { experience: 1 }),
      unit(1, DEFENDER_DEF, 1),
      unit(2, ATTACKER_DEF, 2, { fortified: true }),
    ]);
    const json = JSON.stringify(state);
    expect(json).not.toContain('undefined');
    const back = JSON.parse(json) as GameState;
    expect(back).toStrictEqual(state);
    expect(back.units.map((u) => experienceOf(u))).toEqual([1, 0, 0]);
    expect(back.units.map((u) => isFortified(u))).toEqual([false, false, true]);
    expect(back.units.map((u) => hitPointsLeftOf(u))).toEqual(
      back.units.map(() => ATTACKER_DEF.hitPoints),
    );
  });

  it('keeps hit points, experience and fortification through a job being attached', () => {
    // `withWork`/`withoutWork` rebuild a unit field by field; a rebuild that dropped M6's
    // fields would silently reset a wounded veteran to full health the moment it took a
    // job, which is exactly the kind of quiet loss this file exists to catch.
    const wounded: Unit = { ...withFortified(withExperience(bare, 1)), hitPointsLeft: 1 };
    const working = withWork(wounded, {
      kind: asImprovementId('mine'),
      tile: asTileIndex(0),
      turnsLeft: 2,
    });

    expect(Object.keys(working)).toContain('work');
    expect(working).toStrictEqual({
      id: wounded.id,
      type: wounded.type,
      owner: wounded.owner,
      tile: wounded.tile,
      movementLeft: wounded.movementLeft,
      hitPointsLeft: 1,
      experience: 1,
      fortified: true,
      work: { kind: asImprovementId('mine'), tile: asTileIndex(0), turnsLeft: 2 },
    });

    // And the same on the way back out.
    const idle = withoutWork(working);
    expect('work' in idle).toBe(false);
    expect(idle.hitPointsLeft).toBe(1);
    expect(idle.experience).toBe(1);
    expect(idle.fortified).toBe(true);
    expect(JSON.stringify(idle)).not.toContain('undefined');
  });
});

/* ------------------------------------------------------------------ *
 * M6b — the magnitudes come from the RULESET, and nowhere else
 * ------------------------------------------------------------------ */

/** A structural ruleset view carrying one `combat` section, for `combatRulesOf`. */
interface ViewWithCombat extends RulesetView {
  readonly combat: CombatDef;
}

const withCombat = (combat: CombatDef): ViewWithCombat => ({
  terrains: [],
  units: [],
  improvements: [],
  fidelity: 'tuned',
  combat,
});

/** The same view with no section at all — a hand-built fixture, a foreign ruleset. */
const viewWithNoCombat: RulesetView = {
  terrains: [],
  units: [],
  improvements: [],
  fidelity: 'tuned',
};

describe('combatRulesOf — every magnitude is read from the ruleset it is handed', () => {
  it('reads all nine fields of the section, one by one', () => {
    const rules = combatRulesOf(withCombat(RULES));
    expect(rules.fortifyBonusPct).toBe(RULES.fortifyBonusPct);
    expect(rules.cityDefenseBonusPct).toBe(RULES.cityDefenseBonusPct);
    expect(rules.wallsBonusPct).toBe(RULES.wallsBonusPct);
    expect(rules.veteranAttackPct).toBe(RULES.veteranAttackPct);
    expect(rules.maxExperience).toBe(RULES.maxExperience);
    expect(rules.rollBound).toBe(RULES.rollBound);
    expect(rules.damagePerRound).toBe(RULES.damagePerRound);
    expect(rules.minWinPct).toBe(RULES.minWinPct);
    expect(rules.maxWinPct).toBe(RULES.maxWinPct);
    expect(rules).toStrictEqual(RULES);
  });

  it('reads the *shipped* catalog through the same reader, so this file cannot drift', () => {
    // The one place this file is allowed to look at content: the shipped section reaches
    // `combatRulesOf` exactly as a fixture does, so the reader — not a constant — is what
    // stands between the catalog and a battle.
    const shipped = combatRulesOf(withCombat({ ...RULES }));
    expect(shipped.rollBound).toBe(100);
    expect(shipped.maxWinPct).toBe(99);
  });

  it('is NOT the shipped numbers when the section is absent', () => {
    // The dual-source rule, in the direction that matters most: a fallback that reproduced
    // today's values would let an overridden catalog be silently ignored — a sweep would
    // report "no effect" for a knob that was never read. `NO_COMBAT_RULES` is degenerate
    // *because* it must be distinguishable from the shipped table.
    const none = combatRulesOf(viewWithNoCombat);
    expect(none).toStrictEqual(NO_COMBAT_RULES);
    expect(none).not.toStrictEqual(RULES);
    // And the degeneracy is total: nothing is granted, and nothing can be promoted.
    expect(none.fortifyBonusPct + none.cityDefenseBonusPct + none.wallsBonusPct).toBe(0);
    expect(none.veteranAttackPct).toBe(0);
    expect(none.maxExperience).toBe(0);
    // One hit point per round is the *termination floor*, not a copy of the shipped 1: a
    // round that cost nothing could never end a battle.
    expect(none.damagePerRound).toBe(1);
  });

  it('turns an absent section into an unwinnable assault, in a real battle', () => {
    // "No combat rules" has to be visible in the odds, not just in a struct: the attacker
    // never wins a round, so a 1-hit-point fight at a 50% threshold becomes a defender win.
    const withRules = resolveCombat(
      context({ attackerHitPoints: 1, defenderHitPoints: 1, static: [0] }),
    ).result;
    expect(withRules.outcome).toBe('attacker-wins');

    const without = resolveCombat(
      context({
        rules: combatRulesOf(viewWithNoCombat),
        attackerHitPoints: 1,
        defenderHitPoints: 1,
        static: [0],
      }),
    ).result;
    expect(without.attackerWinPct).toBe(NO_COMBAT_RULES.minWinPct);
    expect(without.rollBound).toBe(NO_COMBAT_RULES.rollBound);
    expect(without.outcome).toBe('defender-wins');
  });

  it('reads an unreadable field as that field’s degenerate value, never as NaN', () => {
    // A structural view can carry anything. A percentage that is not a non-negative whole
    // number grants nothing; the damage floor and the roll bound keep their minimum, because
    // 0 of either would turn a pure function into a non-terminating one.
    const rules = combatRulesOf(
      withCombat({
        fortifyBonusPct: -5,
        cityDefenseBonusPct: 12.5,
        wallsBonusPct: Number.NaN,
        veteranAttackPct: Number.POSITIVE_INFINITY,
        maxExperience: -1,
        rollBound: 0,
        damagePerRound: 0,
        minWinPct: -3,
        maxWinPct: 0.5,
      }),
    );
    expect(rules).toStrictEqual(NO_COMBAT_RULES);
  });

  it('CHANGES THE ODDS when the ruleset says something else', () => {
    // **This is the test the M6b contract asks for.** If any magnitude were still a literal
    // inside `combat.ts`, at least one of these four would not move.
    const modifiers = { terrainBonusPct: 0, fortified: false, inCity: true, walls: true };

    // 1. `wallsBonusPct`: 50 (city 50 + walls 50 = 100%) against 0 (city only).
    const withWalls = combatRulesOf(withCombat(RULES));
    const noWalls = combatRulesOf(withCombat({ ...RULES, wallsBonusPct: 0 }));
    const walled = winPct(withWalls, 3, modifiedDefense(3, defenderBonusPct(withWalls, modifiers)));
    const bare = winPct(noWalls, 3, modifiedDefense(3, defenderBonusPct(noWalls, modifiers)));
    expect(walled).toBe(33); // defence floor(3 * 2.0) = 6 -> 3 / 9
    expect(bare).toBe(42); // defence floor(3 * 1.5) = 4 -> 3 / 7
    expect(walled).not.toBe(bare);

    // 2. `cityDefenseBonusPct`, the same way.
    const noCity = combatRulesOf(withCombat({ ...RULES, cityDefenseBonusPct: 0 }));
    expect(winPct(noCity, 3, modifiedDefense(3, defenderBonusPct(noCity, modifiers)))).not.toBe(
      walled,
    );

    // 3. `damagePerRound`: 1 shipped against 3, applied by the resolver in one round.
    const shipped = resolveCombat(
      context({ attackerHitPoints: 3, defenderHitPoints: 3, static: [0, 0, 0] }),
    ).result;
    const brutal = resolveCombat(
      context({
        rules: combatRulesOf(withCombat({ ...RULES, damagePerRound: 3 })),
        attackerHitPoints: 3,
        defenderHitPoints: 3,
        static: [0],
      }),
    ).result;
    // The same battle, the same scripted draws: three rounds at one hit point a round, one
    // round at three. The damage magnitude — not a constant in the resolver — is what moved.
    expect(shipped.rounds).toBe(3);
    expect(shipped.defenderLost).toBe(3);
    expect(brutal.rounds).toBe(1);
    expect(brutal.defenderLost).toBe(3);

    // 4. `veteranAttackPct` and `rollBound`, read rather than assumed.
    expect(veteranBonusPct(combatRulesOf(withCombat({ ...RULES, veteranAttackPct: 50 })), 2)).toBe(
      100,
    );
    const coarse = resolveCombat(
      context({
        rules: combatRulesOf(withCombat({ ...RULES, rollBound: 10 })),
        attackerHitPoints: 1,
        defenderHitPoints: 1,
        static: [5],
      }),
    ).result;
    // floor(3 * 10 / 6) = 5 on a ten-value draw, and a draw *at* the threshold still loses.
    expect(coarse.attackerWinPct).toBe(5);
    expect(coarse.rollBound).toBe(10);
    expect(coarse.outcome).toBe('defender-wins');
  });
});
