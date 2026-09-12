/**
 * **The AI's weights — every magnitude the real policy introduces, in one place.**
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (point 3,
 * *Tunable*: "Every magnitude it introduces lives in the rules catalog (or an
 * explicit override), never as a literal buried in logic") and the M7 contract's
 * "be **decomposable for balance work**: its decisions read from named weights or
 * thresholds that live in one place … An AI whose preferences are scattered literals
 * cannot be tuned, which is the same violation M6b fixed for combat."
 *
 * ## What this file is, and what it is not
 *
 * It is the AI's **taste**, written down once and named. It is not content: no value
 * here can live in `@civts/rules`, because a catalog row says what the *world* permits
 * while every number here says what *this opponent* happens to prefer. The engine
 * never reads this module — `ai/smart.ts` is the only reader, and `policies.ts` the
 * only thing that re-exports it — so a balance sweep can vary a weight here without
 * touching a rule of the game.
 *
 * ## PROVENANCE — read this before quoting any number below
 *
 * **Every value in this file is a `placeholder`: unsourced, chosen to be playable, and
 * not a Civ 3 figure.** Civ 3's own AI has weights and this file has weights, and that
 * is the *entire* relationship between them: none of these numbers is traced to a
 * source, none is presented as a Civ 3 behaviour, and a reader who recognises a number
 * as "about right" for Civ 3 should read that as coincidence rather than provenance.
 * The project has already made the mistake of passing off a guess as a source once
 * (INTERFACES.md M3 records it); this paragraph exists so the AI half does not repeat
 * it. Where a value *is* structurally forced — a rate triple must sum to `RATE_TOTAL`,
 * a step budget cannot be negative — the field's own note says so instead, which is a
 * different statement from "this is a good number".
 *
 * ## How a sweep varies it
 *
 * `smartPolicy(patch)` takes a `Partial<SmartWeights>` and layers it over
 * `SMART_WEIGHTS`; `mergeSmartWeights` is the one place that layering happens, so a
 * sweep and a caller cannot disagree about what a patch means. Every field is a scalar
 * or a nested group of scalars, so a patch names the knob it means
 * (`smartPolicy({ military: { attackOddsFloorPct: 70 } })`) rather than restating a
 * group — the same "a patch that had to restate everything would make 'move one number
 * and change nothing else' impossible to write down" argument `RulesetPatch.combat`
 * records for the catalog's own globals.
 *
 * `SMART_WEIGHT_PATHS` lists every knob as a dotted path, and `ai.test.ts` asserts it
 * is **complete**: a new weight added to the interface without being listed there fails
 * a test rather than being invisible to a sweep. That is the enforcement the standing
 * requirement asks for, because "a number a sweep might vary should never be a literal
 * buried in a branch" is only checkable if the set of knobs is enumerable.
 */

/* ------------------------------------------------------------------ *
 * The shape
 * ------------------------------------------------------------------ */

/**
 * The real AI's preferences.
 *
 * Grouped by the *decision* a field belongs to — `settlement`, `city`, `production`,
 * `research`, `economy`, `military`, `exploration` — rather than by the function that
 * happens to read it, because the question a balance sweep asks is "what happens if
 * this AI settles more aggressively?" and not "what happens if I change a local in
 * `planProduction`?". Every field says in its own note what it does and what it is a
 * placeholder for.
 */
export interface SmartWeights {
  /** When and where the AI founds cities, and how many it wants. */
  readonly settlement: {
    /**
     * How many cities this AI wants. **PLACEHOLDER: unsourced, chosen to be playable,
     * not a Civ 3 figure and not a measured optimum.**
     *
     * It is a *target*, not a cap: a settler that already exists keeps walking and
     * founds wherever it is if no better site is in reach, because a settler is a
     * finished good and stranding one is strictly worse than a mediocre city. What
     * the target really controls is when cities stop *building* settlers.
     */
    readonly targetCities: number;
    /**
     * The fewest cities this AI is willing to settle for, whatever the map. It exists so
     * that `targetCities` derived from a small map cannot become "one city and stop", which
     * is a legal way to play and a terrible opponent to measure anything against.
     * **PLACEHOLDER.**
     */
    readonly minTargetCities: number;
    /**
     * Roughly how much map this AI wants per city, used as the ceiling on `targetCities` on
     * large maps. **PLACEHOLDER**: a city's own tile plus its neighbourhood is 21 tiles, so
     * this is a claim about how much *unshared* ground an AI wants around each city, not a
     * measurement of anything.
     */
    readonly tilesPerCity: number;
    /**
     * The food surplus at which a city that is **below the empire's city target** starts
     * building settlers regardless of its size. **PLACEHOLDER.**
     *
     * This is the "expand or die" rule, and it exists because the alternative is a deadlock
     * that is easy to write and hard to see: a one-city empire whose only city is too small
     * for `city.minPopulationForSettler` and cannot grow because nothing it can build adds
     * food is a game that never produces a second settler, never founds a second city, and
     * therefore never gets a bigger food surplus. A surplus of `1` is the smallest value
     * that breaks that loop.
     */
    readonly emergencySettlerFoodSurplus: number;
    /**
     * How good a site has to be, in the site score's own integer units (see
     * `ai/smart.ts`' `siteRank`: the food, then the surplus, then the shields of the tiles
     * the engine's own `autoAssignWorkedTiles` would give the city's first citizens),
     * before a settler walking past it will stop and found.
     *
     * **PLACEHOLDER: unsourced, chosen to be playable.** It exists because *any* legal
     * site is a legal city and an AI with no floor founds its capital's neighbour on a
     * one-food coastal snowfield. The floor is on **food** specifically — the failure
     * this guards against is a city that cannot feed itself, which stalls the whole
     * civilization — and it is deliberately low, because the alternative failure (a
     * settler that never founds) is worse.
     */
    readonly minSiteFood: number;
    /**
     * The food surplus a site must show before the AI is willing to call it a good
     * place to *walk toward* (as opposed to a place to stop at immediately, which is
     * `minSiteFood`'s and much more permissive). **PLACEHOLDER.**
     */
    readonly preferredSiteFoodSurplus: number;
    /**
     * How many tiles around a candidate site the AI counts as "good city ground" when
     * comparing one candidate against another. **PLACEHOLDER**: 5 is chosen so that a
     * comparison sees a city's early working set (a centre plus its first four
     * citizens) rather than its whole eventual radius.
     */
    readonly siteSampleTiles: number;
    /**
     * How many steps a settler may be handed in one turn before the AI gives up on
     * moving it. **PLACEHOLDER**, and it is a *loop guard* rather than a preference:
     * a validated ruleset has no zero-cost terrain, so a unit's own movement points end
     * the loop by themselves, and this bound only matters for a foreign or hand-built
     * ruleset that could otherwise let a policy walk one unit for ever.
     */
    readonly maxStepsPerSettler: number;
  };

  /** What a city works, when it founds, and when it is in trouble. */
  readonly city: {
    /**
     * How close an enemy unit has to be, in Chebyshev tiles from the city centre,
     * before the AI treats the city as **threatened**. **PLACEHOLDER.**
     *
     * This one number drives several decisions (build a defender, build walls, keep a
     * garrison home, do not walk the last defender out), which is deliberate: an AI
     * with one threat radius is an AI whose reactions to a threat are consistent, and a
     * sweep that moves it moves the whole posture.
     */
    readonly threatRadius: number;
    /**
     * Population at or below which a city is treated as **young** and gets the
     * growth-first production preferences. **PLACEHOLDER.**
     */
    readonly youngCityPopulation: number;
    /**
     * How many citizens a city wants before the AI is willing to spend it on a
     * settler. **PLACEHOLDER**: a city that gives up citizens before it can replace
     * them shrinks the empire it is trying to grow.
     */
    readonly minPopulationForSettler: number;
    /**
     * How many **non-military** units this AI wants per city (a settler counts while
     * the city target is unmet, a worker always). **PLACEHOLDER.**
     */
    readonly workersPerCity: number;
    /**
     * How many defenders this AI wants standing in each of its cities. **PLACEHOLDER**:
     * one is the smallest number that makes an undefended city (and therefore a
     * capture) not the normal state of the world, which is what M6's capture rules need
     * to be exercised rather than theoretical.
     */
    readonly defendersPerCity: number;
    /**
     * How many defenders this AI wants in a city it considers **threatened**
     * (`threatRadius`). **PLACEHOLDER**, and larger than `defendersPerCity` on purpose:
     * a city under pressure should pull its field army home rather than keep
     * exploring.
     */
    readonly defendersPerThreatenedCity: number;
    /**
     * How much of its military this AI is willing to **commit to garrison duty**, as a
     * percentage of the army, floored by one soldier per city — and therefore, read the other
     * way round, how much of it is free to be a *field army*. **PLACEHOLDER.**
     *
     * It is a **budget on home defence, not a description of it**, and it exists because the
     * per-city rule on its own has no ceiling and no floor to the *army*: every soldier's own
     * neighbourhood looks under-defended for ever, so every soldier is permanently walking to
     * a city and none ever leaves. Measured with the per-city rule alone, on a duel map over
     * **150 turns the two civilizations founded 14 and 18 cities, made 31 military units
     * between them, and never once brought a soldier within 13 tiles of an enemy city** — the
     * land was decided by whoever walked there first and the armies never met. Nothing about
     * walls or a walls bonus can be measured in a game like that.
     *
     * `cities` stays the floor, so the budget can never be small enough to leave a city with
     * nobody in it; above that floor the share applies to the army, so a big army keeps a
     * garrison proportional to its size and sends the rest out.
     */
    readonly fieldArmySharePct: number;
    /**
     * How many workers this AI will put on the map regardless of how few cities it
     * has. **PLACEHOLDER**: without it a one-city opening builds no workers at all
     * (the per-city allowance rounds to nothing), so no tile is ever improved and the
     * whole improvement system is inert.
     */
    readonly minWorkers: number;
  };

  /**
   * What a city builds.
   *
   * The `*Priority` fields are **ranks, not weights**: larger wins, and every
   * comparison is a tuple compared left to right (`ai/smart.ts`' `compareRanks`), so
   * no two preferences are ever silently added together into a score whose units
   * nobody can state. They are placeholders — unsourced, chosen to be playable — and
   * their *order* is the AI's opening theory rather than a claim about Civ 3's.
   */
  readonly production: {
    /** Priority of the second defensive unit in a city that has none. **PLACEHOLDER.** */
    readonly secondDefenderPriority: number;
    /** Priority of the first defensive unit in a city that has none. **PLACEHOLDER.** */
    readonly firstDefenderPriority: number;
    /** Priority of a granary in a city with surplus food. **PLACEHOLDER.** */
    readonly granaryPriority: number;
    /** Priority of city walls in a threatened city. **PLACEHOLDER** — see the module note on the walls sweep. */
    readonly wallsPriority: number;
    /** Priority of a settler when the city target is unmet. **PLACEHOLDER.** */
    readonly settlerPriority: number;
    /** Priority of a worker when the per-city allowance is unmet. **PLACEHOLDER.** */
    readonly workerPriority: number;
    /** Priority of a military unit when the garrison and field-army targets are unmet. **PLACEHOLDER.** */
    readonly militaryPriority: number;
    /** Priority of a commerce or science building in a mature city. **PLACEHOLDER.** */
    readonly economyBuildingPriority: number;
    /** Priority of a granary in a city with no surplus food (it cannot grow anyway). **PLACEHOLDER.** */
    readonly stagnantGranaryPriority: number;
    /** Priority of anything the AI has no opinion about. **PLACEHOLDER.** */
    readonly fillerPriority: number;
    /**
     * When a city is **threatened**, every priority above is raised by this amount
     * before comparison. **PLACEHOLDER**: it is one number rather than a second table,
     * so "react to a threat" is a single knob a sweep can move.
     */
    readonly threatenedBoost: number;
    /**
     * When a city is **young** (`youngCityPopulation`), its growth preferences
     * (granary, settler, worker) are raised by this amount. **PLACEHOLDER.**
     */
    readonly youngCityBoost: number;
    /**
     * How many turns of its own output a city will let a *building* cost before the AI
     * prefers a cheaper item of the same priority. **PLACEHOLDER**, and it is a
     * *tie-break* rather than a rule: two items of the same priority are compared by
     * "does this finish within this many turns?", then by remaining shields, then by
     * `(kind, id)` — a total order over the candidates that reads only their own
     * content and the city's output, never the catalog's row order.
     */
    readonly affordableWithinTurns: number;
  };

  /**
   * What the AI researches, and why.
   *
   * The AI researches **with a goal**: what it wants to build next, not the first tech
   * the tree offers. `unlockValue*` are the values it puts on the four kinds of thing a
   * tech can unlock (the engine's own `TECH_UNLOCK_KINDS` vocabulary, read through
   * `techUnlocks`); `prerequisiteValue` is what it pays for a tech that unlocks nothing
   * *itself* but sits in front of something that does.
   *
   * Every one of these is a **PLACEHOLDER: unsourced, chosen to be playable, and not a
   * Civ 3 figure** — in particular, "a military tech is worth more than a growth
   * building" is this AI's opinion, not a claim about how Civ 3's AI values its tree.
   */
  readonly research: {
    /** Value of a tech that unlocks a `military` unit. **PLACEHOLDER.** */
    readonly unlockValueMilitary: number;
    /** Value of a tech that unlocks a `settler` unit. **PLACEHOLDER.** */
    readonly unlockValueSettler: number;
    /** Value of a tech that unlocks a `worker` unit. **PLACEHOLDER.** */
    readonly unlockValueWorker: number;
    /** Value of a tech that unlocks a `scout` unit. **PLACEHOLDER.** */
    readonly unlockValueScout: number;
    /** Value of a tech that unlocks a building holding defensive walls. **PLACEHOLDER.** */
    readonly unlockValueWalls: number;
    /** Value of a tech that unlocks a growth building (the granary's own effect). **PLACEHOLDER.** */
    readonly unlockValueGrowthBuilding: number;
    /** Value of a tech that unlocks a commerce or science building. **PLACEHOLDER.** */
    readonly unlockValueEconomyBuilding: number;
    /** Value of a tech that unlocks any other building. **PLACEHOLDER.** */
    readonly unlockValueOtherBuilding: number;
    /** Value of a tech that unlocks an improvement. **PLACEHOLDER.** */
    readonly unlockValueImprovement: number;
    /** Value of a tech that unlocks a resource. **PLACEHOLDER.** */
    readonly unlockValueResource: number;
    /**
     * What the AI adds for each *other* tech that names this one as a prerequisite —
     * the "this is a step toward something I want" term. **PLACEHOLDER.**
     */
    readonly prerequisiteValue: number;
    /**
     * The multiplier, as a percentage, applied to a tech's unlock value when the AI's
     * cities are currently short of the thing it unlocks. **PLACEHOLDER**: at `100` a
     * wanted-but-missing item is worth its base value, and a sweep can push this to
     * `200` to make the AI chase what it lacks.
     */
    readonly wantedUnlockBonusPct: number;
  };

  /**
   * The money loop's settings: what the AI does with the three rate sliders.
   *
   * `RATE_TOTAL` is the engine's (the three rates must sum to it), so these fields are
   * the AI's *allocation* policy rather than magnitudes of the game. Every one is a
   * **PLACEHOLDER**.
   */
  readonly economy: {
    /**
     * Turns of deficit this AI keeps in the treasury before it will run a science-heavy
     * slider. It is the whole of the AI's economic policy in one number: `gold >= upkeep *
     * this` means "I can fund this rate for this many turns even when income does not cover
     * it", and below it the AI raises taxes. **PLACEHOLDER**, chosen to be playable.
     *
     * Note what it is *not*: a hoard. Measured with a hoarding rule — a target of a fixed
     * reserve plus three turns of upkeep on the projected balance, ranked **above** beakers —
     * this AI ended a 45-turn game with 272–509 gold in the bank and **zero technologies
     * researched**. An economy that taxes itself to a full treasury and buys nothing with it
     * is not a cautious economy; it is one that has stopped playing.
     */
    readonly runwayTurns: number;
    /**
     * How many turns of its current deficit the AI will let its treasury cover before
     * it moves gold to the tax slider. **PLACEHOLDER**: a higher number is a more
     * patient (and more science-heavy) AI that will let the treasury drain closer to
     * zero first.
     */
    readonly deficitTurnsTolerated: number;
    /**
     * How much of the budget this AI is willing to put into **luxuries** at most, out of
     * `RATE_TOTAL`. **PLACEHOLDER**, and `0` at the defaults.
     *
     * Luxuries are banked and read by nothing until M9 (happiness), so spending rate
     * points on them is spending them on nothing — but "spend nothing on contentment" is
     * a *decision of this AI* rather than a rule of the engine, and the balance pass that
     * lands M9 will want to move exactly this number. It is therefore a knob whose
     * default is zero rather than a hard-coded branch.
     */
    readonly luxuryShareWhenRich: number;
    /**
     * How many units this AI will allow itself **over** the engine's free support
     * allowance before it stops building units it has to pay for. **PLACEHOLDER**: it is
     * this AI's self-imposed army cap, and the reason it has one at all is that the
     * engine's bankruptcy rule *disbands* units — an AI that ignored support would be an
     * AI that periodically disbanded its own army and called it a strategy. It gates
     * settlers, workers and scouts as well as soldiers, because the engine bills all four.
     */
    readonly unitsOverAllowanceCap: number;
    /**
     * The treasury below which this AI stops commissioning units that carry support.
     * **PLACEHOLDER**: it is the "do not go bankrupt by choice" rule applied at the far end
     * of the pipeline. `runwayTurns` governs the *sliders*; this governs **production**,
     * and the failure it prevents is the expensive one — an AI that keeps building soldiers
     * while broke has them disbanded by the engine's bankruptcy rule, so it pays full price
     * for an army it then loses, forever.
     */
    readonly supportAffordableAtTreasury: number;
    /**
     * How many settlers this AI is willing to have **unfounded** on top of the cities it
     * still wants. **PLACEHOLDER**, and normally `0`: the AI builds settlers to reach
     * `settlement.targetCities` and no further, because the expensive failure it is
     * guarding against is a settler that cannot found anywhere — it then walks for the
     * rest of the game, and every turn of it is a unit the treasury pays for. It is a knob
     * rather than a hard `0` so a balance pass can ask what an AI with a settler in hand
     * does differently.
     */
    readonly surplusSettlerAllowance: number;
  };

  /**
   * When the AI fights, and how it moves.
   *
   * The odds thresholds are thresholds on the **probability the AI wins the whole
   * battle**, computed with integer arithmetic from the *per-round* chance the engine
   * itself reports (`CombatResolved.attackerWinPct`), never from a second statement of
   * `combat.ts`' odds formula — see `ai/smart.ts`' `battleWinPctOf`.
   */
  readonly military: {
    /**
     * The overall battle win chance, in whole percent, below which the AI will not
     * start a fight it does not have to. **PLACEHOLDER: unsourced, chosen to be
     * playable, not a Civ 3 figure and not a measured optimum.**
     */
    readonly attackWinFloorPct: number;
    /**
     * The overall battle win chance the AI demands when the target is **inside a
     * city**, as opposed to a unit in the open. **PLACEHOLDER**, and higher than the
     * open-field floor because a lost assault leaves the attacker dead in front of a
     * city that will now produce a defender.
     */
    readonly attackWinFloorVsCityPct: number;
    /**
     * The overall battle win chance the AI demands when the target city holds
     * **defensive walls**. **PLACEHOLDER**, and the highest of the three: this is the
     * number that decides whether the AI ever *attacks into* a walled city, and
     * therefore half of what makes M7's walls-bonus sweep measurable at all (the other
     * half being `production.wallsPriority`, which decides whether the AI *builds*
     * them).
     */
    readonly attackWinFloorVsWalledCityPct: number;
    /**
     * The overall battle win chance the AI demands against a **barbarian**. Lower than
     * the others on purpose. **PLACEHOLDER**: barbarians are the threat this AI is
     * meant to react to, and an AI that refuses to engage them is an AI that lets them
     * walk into its cities.
     */
    readonly attackWinFloorVsBarbarianPct: number;
    /**
     * How many tiles a unit may be handed in one turn before the AI gives up. A
     * **loop guard** rather than a preference, exactly as
     * `settlement.maxStepsPerSettler` is, and a **PLACEHOLDER**.
     */
    readonly maxStepsPerUnit: number;
    /**
     * How close a visible enemy has to be before a soldier with a city still short of a
     * defender **chases it instead of reinforcing that city** — the radius inside which the
     * nearest enemy outranks the nearest garrison post. **PLACEHOLDER.**
     *
     * Deliberately **not** a leash, and the difference was measured. As a leash (a rule that a
     * soldier with no garrison to fill would only pursue an enemy inside this radius, and
     * explore otherwise) the two civilizations stood **15 tiles apart for fifty turns and never
     * fought once**: the fallback for a soldier with nothing to do is exploration, an army
     * standing in ground it has already mapped has no step that reveals anything, so every
     * soldier simply stood still. Past the radius an enemy is therefore still pursued — the
     * radius only decides whether the chase comes *before* a walk home.
     */
    readonly huntRadius: number;
    /**
     * The strength ratio, as a percentage, at which a military unit that has *not* been
     * ordered to fight will stand and fortify rather than keep moving: its own defense
     * against the best attack it can see next to it, times 100. **PLACEHOLDER**: it is
     * the AI's one crude threat read, and it exists so that "fortify when contact is
     * bad" is a named number rather than a branch.
     */
    readonly standAndFortifyRatioPct: number;
    /**
     * How far from an enemy city a soldier's hit points still count toward that city's
     * **assault force** — the force the AI asks whether it has before it commits to a siege.
     * **PLACEHOLDER.**
     *
     * A radius rather than "the soldiers standing next to the city" because a siege is
     * decided *before* the army is in position: the troops that count are the ones close
     * enough to arrive, and `siegeForceRatioPct` is what decides whether they are enough.
     */
    readonly siegeRadius: number;
    /**
     * The assault force's hit points as a percentage of the garrison's hit points, below
     * which an enemy city is **not** this AI's siege objective. **PLACEHOLDER**, and the
     * whole content of "besiege a city **when it has the force for it**".
     *
     * Hit points and not a second odds model, on purpose: hit points are the engine's own
     * measure of how much punishment a force can take (`hitPointsLeftOf`), and the garrison
     * is what the engine will make an assault resolve against — the odds themselves come
     * from the engine, through the fold `ai/smart.ts`' `bestAttack` already performs. A
     * ratio of `100` means "as many hit points as the garrison"; the shipped default asks
     * for half again as much.
     */
    readonly siegeForceRatioPct: number;
    /**
     * The chance, in whole percent, that the **whole assault group** takes an enemy city,
     * below which the AI will not storm it — the number that turns "a walled city is
     * unassailable" into "a walled city is unassailable *alone*". **PLACEHOLDER.**
     *
     * The group's chance is composed from the engine's own per-attack numbers
     * (`1 - Π(1 - pᵢ)`, which is exactly the chance that at least one of the committed
     * attackers wins, and a *lower* bound on the truth because each attack is priced against
     * the defender as it stands before the assault, not as the attacks wound it). It is
     * therefore not a second odds model: every `pᵢ` is read off the engine's own
     * `CombatResolved.attackerWinPct` for that attacker, and `battleWinPctOf` turns it into
     * the battle's chance. What the group number buys is that **a stack may attack where a
     * lone unit must not**: the individual floors above stay the rule for a soldier that
     * attacks by itself, and this is the rule for a soldier that attacks with the army.
     *
     * The shipped default is **even money on the first assault**. Lower and a stack that is
     * merely numerous walks into a fortified walled city — which, with a lone archer's true
     * chance against one at 16 %, means five archers at 58 % and one at 16 %; higher and an
     * army that has arrived in force still stands outside, because the individual floors it
     * is otherwise held to (`attackWinFloorVsWalledCityPct`, 65) are unreachable against a
     * walled city for every unit in the shipped catalog. It is a **lower bound** on the
     * siege, not the siege: the attacks that fail also land `damagePerRound` on the defender
     * (the engine says so in `CombatResolved.defenderLost`), so a wave of three kills a
     * three-hit-point garrison outright whatever the dice do. Erring low is still the safe
     * direction, which is why the group's chance is floored rather than rounded.
     */
    readonly siegeAssaultFloorPct: number;
  };

  /** What the AI does with units that have nothing to fight or build. */
  readonly exploration: {
    /**
     * How many tiles of unexplored ground a step has to open up before the AI counts
     * it as exploration rather than wandering. **PLACEHOLDER**: `0` makes every step
     * that reveals anything worth taking, which is what keeps an early scout useful.
     */
    readonly minRevealPerStep: number;
    /**
     * How many scouts this AI wants per city. **PLACEHOLDER**, and deliberately small:
     * a scout is cheap and its job (finding ground, huts and neighbours) is done early,
     * so this is a target rather than a standing army.
     */
    readonly scoutsPerCity: number;
  };
}

/* ------------------------------------------------------------------ *
 * The defaults
 * ------------------------------------------------------------------ */

/**
 * The real AI at its default tuning.
 *
 * **Every value is a `placeholder`.** Read the interface above for what each one
 * means; this object exists so a sweep has something to vary and so the defaults are
 * stated in one place instead of at each use site.
 */
export const SMART_WEIGHTS: SmartWeights = {
  settlement: {
    targetCities: 5,
    minTargetCities: 2,
    tilesPerCity: 120,
    emergencySettlerFoodSurplus: 1,
    minSiteFood: 4,
    preferredSiteFoodSurplus: 1,
    siteSampleTiles: 5,
    maxStepsPerSettler: 8,
  },
  city: {
    threatRadius: 4,
    youngCityPopulation: 2,
    minPopulationForSettler: 2,
    workersPerCity: 1,
    defendersPerCity: 1,
    defendersPerThreatenedCity: 2,
    fieldArmySharePct: 50,
    minWorkers: 1,
  },
  production: {
    secondDefenderPriority: 80,
    firstDefenderPriority: 100,
    granaryPriority: 70,
    wallsPriority: 85,
    settlerPriority: 75,
    workerPriority: 60,
    militaryPriority: 50,
    economyBuildingPriority: 40,
    stagnantGranaryPriority: 20,
    fillerPriority: 1,
    threatenedBoost: 30,
    youngCityBoost: 10,
    affordableWithinTurns: 12,
  },
  research: {
    unlockValueMilitary: 60,
    unlockValueSettler: 55,
    unlockValueWorker: 30,
    unlockValueScout: 20,
    unlockValueWalls: 45,
    unlockValueGrowthBuilding: 50,
    unlockValueEconomyBuilding: 40,
    unlockValueOtherBuilding: 25,
    unlockValueImprovement: 25,
    unlockValueResource: 25,
    prerequisiteValue: 15,
    wantedUnlockBonusPct: 150,
  },
  economy: {
    runwayTurns: 4,
    deficitTurnsTolerated: 3,
    luxuryShareWhenRich: 0,
    unitsOverAllowanceCap: 2,
    supportAffordableAtTreasury: 5,
    surplusSettlerAllowance: 0,
  },
  military: {
    attackWinFloorPct: 55,
    attackWinFloorVsCityPct: 50,
    attackWinFloorVsWalledCityPct: 65,
    attackWinFloorVsBarbarianPct: 45,
    maxStepsPerUnit: 8,
    huntRadius: 6,
    standAndFortifyRatioPct: 150,
    siegeRadius: 3,
    siegeForceRatioPct: 150,
    siegeAssaultFloorPct: 50,
  },
  exploration: {
    minRevealPerStep: 0,
    scoutsPerCity: 0,
  },
};

/* ------------------------------------------------------------------ *
 * Patching and enumeration
 * ------------------------------------------------------------------ */

/** One group of `SmartWeights`, by the group's own field name. */
export type SmartWeightGroup = keyof SmartWeights;

/**
 * A patch over `SmartWeights`: **one field, or as many as the caller means.**
 *
 * Every group is itself partial, which `Partial<SmartWeights>` is not — that would let a
 * caller omit a whole group but force it to restate every field of any group it touches, and
 * a restatement is a second place a group's values can drift from this file. Written group
 * by group rather than with a mapped type over `keyof` because the mapping would need an
 * index signature to be expressible, and an index signature here would stop the compiler
 * refusing a patch that names a field this interface does not have — which is the whole point
 * of typing it.
 */
export interface SmartWeightsPatch {
  readonly settlement?: Partial<SmartWeights['settlement']>;
  readonly city?: Partial<SmartWeights['city']>;
  readonly production?: Partial<SmartWeights['production']>;
  readonly research?: Partial<SmartWeights['research']>;
  readonly economy?: Partial<SmartWeights['economy']>;
  readonly military?: Partial<SmartWeights['military']>;
  readonly exploration?: Partial<SmartWeights['exploration']>;
}

/**
 * The groups of `SmartWeights`, in the interface's own reading order.
 *
 * An array rather than `Object.keys`: the order a report or a sweep walks the knobs in
 * must be a property of this module's source, not of how an object literal happened to
 * be written. `ai.test.ts` asserts this list covers the interface.
 */
export const SMART_WEIGHT_GROUPS: readonly SmartWeightGroup[] = [
  'settlement',
  'city',
  'production',
  'research',
  'economy',
  'military',
  'exploration',
];

/**
 * Layer `patch` over `base`, group by group, with the base's value kept for every
 * field the patch does not name.
 *
 * The `??` per field is not defensive noise and it is not the same thing as a spread:
 * a caller reaching this from JSON can put a **key holding `undefined`** into the
 * patch, and a spread would then write `undefined` over a real default — the M4b
 * `simplePolicy` note records the same trap. It works group by group rather than with
 * one flat spread because a partial of the *nested* shape would otherwise have to be
 * restated field by field here, and a restatement is a second statement of the
 * interface that a new field could silently miss.
 */
export const mergeSmartWeights = (patch: SmartWeightsPatch = {}): SmartWeights => {
  const base = SMART_WEIGHTS;
  return {
    settlement: {
      targetCities: patch.settlement?.targetCities ?? base.settlement.targetCities,
      minTargetCities: patch.settlement?.minTargetCities ?? base.settlement.minTargetCities,
      tilesPerCity: patch.settlement?.tilesPerCity ?? base.settlement.tilesPerCity,
      emergencySettlerFoodSurplus:
        patch.settlement?.emergencySettlerFoodSurplus ??
        base.settlement.emergencySettlerFoodSurplus,
      minSiteFood: patch.settlement?.minSiteFood ?? base.settlement.minSiteFood,
      preferredSiteFoodSurplus:
        patch.settlement?.preferredSiteFoodSurplus ?? base.settlement.preferredSiteFoodSurplus,
      siteSampleTiles: patch.settlement?.siteSampleTiles ?? base.settlement.siteSampleTiles,
      maxStepsPerSettler:
        patch.settlement?.maxStepsPerSettler ?? base.settlement.maxStepsPerSettler,
    },
    city: {
      threatRadius: patch.city?.threatRadius ?? base.city.threatRadius,
      youngCityPopulation: patch.city?.youngCityPopulation ?? base.city.youngCityPopulation,
      minPopulationForSettler:
        patch.city?.minPopulationForSettler ?? base.city.minPopulationForSettler,
      workersPerCity: patch.city?.workersPerCity ?? base.city.workersPerCity,
      defendersPerCity: patch.city?.defendersPerCity ?? base.city.defendersPerCity,
      defendersPerThreatenedCity:
        patch.city?.defendersPerThreatenedCity ?? base.city.defendersPerThreatenedCity,
      fieldArmySharePct: patch.city?.fieldArmySharePct ?? base.city.fieldArmySharePct,
      minWorkers: patch.city?.minWorkers ?? base.city.minWorkers,
    },
    production: {
      secondDefenderPriority:
        patch.production?.secondDefenderPriority ?? base.production.secondDefenderPriority,
      firstDefenderPriority:
        patch.production?.firstDefenderPriority ?? base.production.firstDefenderPriority,
      granaryPriority: patch.production?.granaryPriority ?? base.production.granaryPriority,
      wallsPriority: patch.production?.wallsPriority ?? base.production.wallsPriority,
      settlerPriority: patch.production?.settlerPriority ?? base.production.settlerPriority,
      workerPriority: patch.production?.workerPriority ?? base.production.workerPriority,
      militaryPriority: patch.production?.militaryPriority ?? base.production.militaryPriority,
      economyBuildingPriority:
        patch.production?.economyBuildingPriority ?? base.production.economyBuildingPriority,
      stagnantGranaryPriority:
        patch.production?.stagnantGranaryPriority ?? base.production.stagnantGranaryPriority,
      fillerPriority: patch.production?.fillerPriority ?? base.production.fillerPriority,
      threatenedBoost: patch.production?.threatenedBoost ?? base.production.threatenedBoost,
      youngCityBoost: patch.production?.youngCityBoost ?? base.production.youngCityBoost,
      affordableWithinTurns:
        patch.production?.affordableWithinTurns ?? base.production.affordableWithinTurns,
    },
    research: {
      unlockValueMilitary: patch.research?.unlockValueMilitary ?? base.research.unlockValueMilitary,
      unlockValueSettler: patch.research?.unlockValueSettler ?? base.research.unlockValueSettler,
      unlockValueWorker: patch.research?.unlockValueWorker ?? base.research.unlockValueWorker,
      unlockValueScout: patch.research?.unlockValueScout ?? base.research.unlockValueScout,
      unlockValueWalls: patch.research?.unlockValueWalls ?? base.research.unlockValueWalls,
      unlockValueGrowthBuilding:
        patch.research?.unlockValueGrowthBuilding ?? base.research.unlockValueGrowthBuilding,
      unlockValueEconomyBuilding:
        patch.research?.unlockValueEconomyBuilding ?? base.research.unlockValueEconomyBuilding,
      unlockValueOtherBuilding:
        patch.research?.unlockValueOtherBuilding ?? base.research.unlockValueOtherBuilding,
      unlockValueImprovement:
        patch.research?.unlockValueImprovement ?? base.research.unlockValueImprovement,
      unlockValueResource: patch.research?.unlockValueResource ?? base.research.unlockValueResource,
      prerequisiteValue: patch.research?.prerequisiteValue ?? base.research.prerequisiteValue,
      wantedUnlockBonusPct:
        patch.research?.wantedUnlockBonusPct ?? base.research.wantedUnlockBonusPct,
    },
    economy: {
      runwayTurns: patch.economy?.runwayTurns ?? base.economy.runwayTurns,
      deficitTurnsTolerated:
        patch.economy?.deficitTurnsTolerated ?? base.economy.deficitTurnsTolerated,
      luxuryShareWhenRich: patch.economy?.luxuryShareWhenRich ?? base.economy.luxuryShareWhenRich,
      unitsOverAllowanceCap:
        patch.economy?.unitsOverAllowanceCap ?? base.economy.unitsOverAllowanceCap,
      supportAffordableAtTreasury:
        patch.economy?.supportAffordableAtTreasury ?? base.economy.supportAffordableAtTreasury,
      surplusSettlerAllowance:
        patch.economy?.surplusSettlerAllowance ?? base.economy.surplusSettlerAllowance,
    },
    military: {
      attackWinFloorPct: patch.military?.attackWinFloorPct ?? base.military.attackWinFloorPct,
      attackWinFloorVsCityPct:
        patch.military?.attackWinFloorVsCityPct ?? base.military.attackWinFloorVsCityPct,
      attackWinFloorVsWalledCityPct:
        patch.military?.attackWinFloorVsWalledCityPct ??
        base.military.attackWinFloorVsWalledCityPct,
      attackWinFloorVsBarbarianPct:
        patch.military?.attackWinFloorVsBarbarianPct ?? base.military.attackWinFloorVsBarbarianPct,
      maxStepsPerUnit: patch.military?.maxStepsPerUnit ?? base.military.maxStepsPerUnit,
      huntRadius: patch.military?.huntRadius ?? base.military.huntRadius,
      standAndFortifyRatioPct:
        patch.military?.standAndFortifyRatioPct ?? base.military.standAndFortifyRatioPct,
      siegeRadius: patch.military?.siegeRadius ?? base.military.siegeRadius,
      siegeForceRatioPct: patch.military?.siegeForceRatioPct ?? base.military.siegeForceRatioPct,
      siegeAssaultFloorPct:
        patch.military?.siegeAssaultFloorPct ?? base.military.siegeAssaultFloorPct,
    },
    exploration: {
      minRevealPerStep: patch.exploration?.minRevealPerStep ?? base.exploration.minRevealPerStep,
      scoutsPerCity: patch.exploration?.scoutsPerCity ?? base.exploration.scoutsPerCity,
    },
  };
};

/**
 * A **complete** patch: `mergeSmartWeights({})` — every field named with its default.
 *
 * Exported because it is the honest starting point for a programmatic sweep: a sweep
 * mutates one field of this value and hands it back, and because it is `SmartWeights`
 * (not a `Partial`) the compiler refuses a sweep that drops a group rather than letting
 * it silently fall back to a default nobody wrote down.
 */
export const DEFAULT_SMART_WEIGHTS: SmartWeights = mergeSmartWeights();
