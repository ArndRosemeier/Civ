/**
 * `CORE_INVARIANTS` — the invariant registry, and the one definition of "a
 * simulation did not break a rule" that runs in tests *and* on every turn of every
 * run. See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" (point 4,
 * "Checkable in flight, not only at the end") and its "`@civts/sim` contract".
 *
 * ## What this module is for
 *
 * The standing requirement asks for a system's invariants to be "expressed as named
 * predicates that a simulation can run *every turn*, so a violation is caught where
 * it happens rather than at the final state". This file is that registry for the
 * engine: **one named `Invariant` per broken property**, so a failure names the
 * property that broke instead of reporting "something is wrong somewhere".
 *
 * It also closes **M3's accepted debt**: the long-run economy checks used to live as
 * one-off assertions inside `packages/testing/test/m3-adversarial.test.ts`. The food
 * and shield bookkeeping and the gold ledger below are lifted from that file's
 * `checkTurn` — same reasoning, same equations — so the same definitions now run in
 * a test *and* in flight. `turn.ts` is the one definition of a turn's *order*;
 * this module is the one definition of what a turn must not *do*.
 *
 * ## Reading the context honestly
 *
 * A check sees `(previous, state, events)` and, critically, **`previous` is a
 * boundary between turns, not the state the engine's pipeline started from**:
 * commands (which emit no event for `SetWorkedTiles`/`SetProduction`) may have run
 * between the two snapshots. So a check may not simply replay `applyGrowth` on
 * `previous` and compare — that is the M3 test's `checkTurn`, which is *given* the
 * state immediately before `EndTurn` and cannot be transcribed literally here.
 * Instead:
 *
 * - The values a pass **wrote** are recoverable from the after-state: growth appends
 *   newly worked tiles (so the pre-growth assignment is the after-state's list less
 *   the tiles it gained), production runs *after* growth (so the assignment and
 *   population production saw are exactly the after-state's), a completed building
 *   is named by its `CityProduced` event, and a bankrupt player's demolished
 *   buildings are the one genuinely unrecoverable case.
 * - Where more than one *legitimate* reading of "the state the pass saw" is
 *   consistent with the after-state, the arithmetic is accepted if **any** reading
 *   explains the transition, and the message prints every reading it tried. In the
 *   common case the readings coincide and the check is an exact equality; where they
 *   do not, the check is conservative rather than wrong, because a false alarm stops
 *   a run and a silent false negative does not.
 * - Where a pass's inputs are genuinely unrecoverable slice of a turn — a growth
 *   threshold whose `growth-food` building was completed or demolished later in the
 *   same turn — the transition arithmetic is **skipped**, and the checks that do not
 *   depend on it (event/state agreement, population accounting, box bounds) still
 *   run. Each such case is named in the check's own doc comment. That slice is also why
 *   the growth threshold has **two** predicates rather than one
 *   (`foodBoxThresholdRecoverable` for `city-food-box-within-threshold`,
 *   `thresholdRecoverable` for `city-food-conservation`): the completion half is the
 *   only case that can excuse a full box, while a demolition can only *raise* the
 *   threshold, so the box check does not inherit it — see that check's doc comment for
 *   the arithmetic and for what the shared predicate used to suppress.
 *
 * Per-command as well as per-turn granularity therefore works: the arithmetic
 * invariants only engage when the transition's events show that the turn pipeline
 * ran (an `IncomeCollected` line is emitted for every civilization on every turn,
 * zero amounts included), and when it did not they fall back to the claim that is
 * true of any single command — a city's food box and shield pool do not move.
 *
 * ## Totality
 *
 * "An invariant returns violations, it does not throw — so a run reports every
 * broken property at once instead of dying on the first." Every check here reads
 * defensively: whole-number reads are verified before they enter arithmetic, every
 * list is walked rather than indexed, and a value that cannot be reconciled produces
 * a *message naming the entity* rather than a guess. `checkInvariants` then wraps
 * each check so that even a state this engine could not have built — a `null` city, a
 * missing array, a string where a number belongs — comes back as a violation string
 * instead of an exception. That wrapper is belt-and-braces behind the checks, not a
 * substitute for them: a check that throws has failed, and the message says which
 * check it was and what it threw.
 *
 * ## Provenance
 *
 * Nothing here introduces a game magnitude, and nothing here is claimed as Civ 3's.
 * The thresholds a check compares against are **read from the ruleset** — the food
 * box curve from `core`'s placeholders, the `growth-food` reduction from the rows the
 * city actually holds — and the one literal in the file (`MAX_GROWTHS_PER_TURN`) is a
 * termination bound on this *check's* own loop, not a rule of the game.
 */

import {
  IMPROVEMENT_KINDS,
  MIN_GROWTH_FOOD,
  UNIT_SUPPORT_COST,
  cityRadius,
  cityYields,
  compareTileResources,
  foodBoxSize,
  itemCost,
  neighbors8,
  unitById,
  unitDef,
  unitsOnTile,
  type BuildingDef,
  type BuildingId,
  type City,
  type CityId,
  type GameEvent,
  type GameState,
  type ImprovementId,
  type PlayerId,
  type ProductionItem,
  type RulesetView,
  type TileIndex,
  type Unit,
} from '@civts/core';

import type { Invariant, InvariantContext, Violation } from './types.js';

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * A whole number, or `undefined` for anything else.
 *
 * The parameter is `unknown` on purpose: this is the boundary where a field the
 * engine's types promise is a number meets a state that may not be the one those
 * types describe (a hand-built literal, a JSON file written by an older build, a
 * saved game from before a milestone). Widening to `unknown` and narrowing with a
 * real check is what makes this a check rather than a comparison the typechecker
 * (rightly) calls unnecessary — the same reading `economy.ts` takes of a treasury.
 */
const wholeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

/** Does the state contain this player? A `PlayerId` *is* an index into `players`. */
const playerExists = (state: GameState, id: PlayerId): boolean =>
  state.players.some((player) => player.id === id);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A value as it reads in a message, for a field whose type the state may contradict. */
const describeValue = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value);
  const text: unknown = JSON.stringify(value);
  return typeof text === 'string' ? text : 'undefined';
};

/**
 * Is this list entry a `(tile, kind)` pair at all?
 *
 * The two pair lists are the collections whose *order* is part of the saved state, so
 * the checks below are about consecutive entries — and a single malformed entry (a
 * `null` from a truncated file, a kind that is not a string) would otherwise sit in a
 * one-element list, where there is no consecutive pair to compare and nothing is said.
 * A list of one says nothing about order; that is not the same claim as "the entry is
 * a pair". Widened to `unknown` first, because the state's own type already claims the
 * entry is one and a check the typechecker calls unnecessary is not a check.
 */
const isPairEntry = (value: unknown): boolean =>
  isRecord(value) &&
  wholeNumber(value['tile']) !== undefined &&
  typeof value['kind'] === 'string' &&
  value['kind'].length > 0;

/** The same question for a resource pair, whose second field is the resource id. */
const isResourceEntry = (value: unknown): boolean =>
  isRecord(value) &&
  wholeNumber(value['tile']) !== undefined &&
  typeof value['resource'] === 'string' &&
  value['resource'].length > 0;

/** `item` as it reads in a message. */
const describeItem = (item: ProductionItem): string =>
  item.kind === 'unit' ? `unit ${String(item.id)}` : `building ${String(item.id)}`;

/** The city's `CityProduced` events, at most one per turn. */
const producedEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityProduced' }>[] =>
  events.flatMap((event) => (event.type === 'CityProduced' ? [event] : []));

/** The city's `CityGrew` events, at most one per turn. */
const grewEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityGrew' }>[] =>
  events.flatMap((event) => (event.type === 'CityGrew' ? [event] : []));

/** The city's `CityStarved` events, at most one per turn. */
const starvedEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'CityStarved' }>[] =>
  events.flatMap((event) => (event.type === 'CityStarved' ? [event] : []));

/** Every `IncomeCollected` line of the transition. */
const incomeEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'IncomeCollected' }>[] =>
  events.flatMap((event) => (event.type === 'IncomeCollected' ? [event] : []));

/** Every `UpkeepPaid` line of the transition. */
const upkeepEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'UpkeepPaid' }>[] =>
  events.flatMap((event) => (event.type === 'UpkeepPaid' ? [event] : []));

/** Every `UnitDisbanded` line of the transition. */
const disbandEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'UnitDisbanded' }>[] =>
  events.flatMap((event) => (event.type === 'UnitDisbanded' ? [event] : []));

/** Every `TreasuryShortfall` line of the transition. */
const shortfallEvents = (
  events: readonly GameEvent[],
): readonly Extract<GameEvent, { type: 'TreasuryShortfall' }>[] =>
  events.flatMap((event) => (event.type === 'TreasuryShortfall' ? [event] : []));

/**
 * Did the turn pipeline run inside this transition?
 *
 * `IncomeCollected` is emitted for **every** civilization on **every** turn — the
 * money loop's own evidence bar ("gold is accounted for … checkable from the event
 * stream alone only if the stream is complete") — so its presence is the marker that
 * growth, production and the money step all ran between `previous` and `state`. A
 * transition with no such line is a *command*, and a command may not move a food box
 * or a shield pool; that is the claim the transition checks fall back to.
 */
const turnRan = (ctx: InvariantContext): boolean =>
  ctx.events.some((event) => event.type === 'IncomeCollected');

/* ------------------------------------------------------------------ *
 * The growth threshold, re-derived from the catalog
 * ------------------------------------------------------------------ */

/** The building rows a view describes (`[]` when it describes none). */
const buildingRows = (view: RulesetView): readonly BuildingDef[] => view.buildings ?? [];

/** How much food `city`'s own `growth-food` buildings shave off its requirement. */
const growthFoodOf = (view: RulesetView, city: City): number => {
  let total = 0;
  for (const id of city.buildings) {
    const row = buildingRows(view).find((def) => def.id === id);
    if (row === undefined) continue;
    for (const effect of row.effects) {
      if (effect.kind === 'growth-food') total += effect.amount;
    }
  }
  return total;
};

/**
 * The food `city`'s `population` citizens need to gain one more: the bare curve
 * reduced by this city's own `growth-food` buildings and floored at `MIN_GROWTH_FOOD`.
 *
 * **Deliberately not `cityGrowthTarget`.** This is the *oracle* the growth pass is
 * measured against, so asking the engine's own reduction function what the reduction
 * is would make the check circular: a `growth-food` summed twice, summed per kind
 * instead of per building, or dropped entirely would still agree with itself. The
 * rule is restated here from the catalog rows the city actually holds, exactly as
 * `m3-adversarial.test.ts` restates it — that is the whole point of lifting the check
 * rather than calling the code under test.
 */
const growthRequirement = (view: RulesetView, city: City, population: number): number =>
  Math.max(MIN_GROWTH_FOOD, foodBoxSize(population) - growthFoodOf(view, city));

/** How much food one building row shaves off, for the threshold-precision test below. */
const growthFoodOfRow = (view: RulesetView, id: BuildingId): number => {
  const row = buildingRows(view).find((def) => def.id === id);
  if (row === undefined) return 0;
  let total = 0;
  for (const effect of row.effects) {
    if (effect.kind === 'growth-food') total += effect.amount;
  }
  return total;
};

/** Is this building id a wonder in this view? `wonder: true` is the only spelling. */
const isWonderRow = (view: RulesetView, id: BuildingId): boolean =>
  buildingRows(view).some((def) => def.id === id && def.wonder === true);

/* ------------------------------------------------------------------ *
 * Food bookkeeping — the transcription of the growth rule
 * ------------------------------------------------------------------ */

/**
 * A guard on this module's own growth loop, **not a rule of the game**.
 *
 * The transcription below spends a threshold per citizen gained, and the real curve
 * guarantees at least `MIN_GROWTH_FOOD` per citizen, so a real transition terminates
 * in a handful of iterations. A hand-built state with an enormous food box and a
 * positive surplus would otherwise make a *check* hang, which is worse than a
 * violation: the check stops at this many citizens and reports that the transition is
 * not something a turn could have produced.
 */
const MAX_GROWTHS_PER_TURN = 1000;

/** What the food rule leaves after one turn, transcribed from the M3 contract. */
interface FoodStep {
  readonly population: number;
  readonly foodBox: number;
  readonly grew: boolean;
  readonly starved: boolean;
  /** Citizens gained — the loop's iteration count. */
  readonly gained: number;
}

/**
 * One application of the growth rule: add the surplus, spend a threshold per citizen
 * gained and carry the remainder, or draw a deficit down and starve only below zero.
 * Pure, and a function of `(box, population, surplus, threshold curve)` alone.
 */
const foodStep = (
  box: number,
  population: number,
  surplus: number,
  requirement: (population: number) => number,
): FoodStep => {
  if (surplus > 0) {
    let remaining = box + surplus;
    let citizens = population;
    let gained = 0;
    for (;;) {
      if (gained >= MAX_GROWTHS_PER_TURN) break;
      const needed = requirement(citizens);
      if (remaining < needed) break;
      remaining -= needed;
      citizens += 1;
      gained += 1;
    }
    return {
      population: citizens,
      foodBox: remaining,
      grew: gained > 0,
      starved: false,
      gained,
    };
  }

  if (surplus < 0) {
    const remaining = box + surplus;
    if (remaining < 0) {
      return {
        population: Math.max(1, population - 1),
        foodBox: 0,
        grew: false,
        starved: true,
        gained: 0,
      };
    }
    return { population, foodBox: remaining, grew: false, starved: false, gained: 0 };
  }

  return { population, foodBox: box, grew: false, starved: false, gained: 0 };
};

/** A city whose assignment and population have been rolled back to a pass's inputs. */
const withTiles = (city: City, population: number, workedTiles: readonly TileIndex[]): City => ({
  ...city,
  population,
  workedTiles,
});

/** `state` with the city of the same id replaced. Never mutates its input. */
const withCity = (state: GameState, city: City): GameState => ({
  ...state,
  cities: state.cities.map((existing) => (existing.id === city.id ? city : existing)),
});

/** One reading of "the surplus growth saw", and what produced it. */
interface SurplusReading {
  readonly label: string;
  readonly surplus: number;
  readonly step: FoodStep;
}

/**
 * Every legitimate reading of the food surplus growth used this turn, each already
 * evaluated against the contract's rule.
 *
 * Three readings, because `previous` is a turn boundary and the check cannot see the
 * commands in between:
 *
 * 1. **The after-state's assignment, less the tiles growth appended.** Growth appends
 *    one tile per citizen gained, so rolling those back reconstructs what it read —
 *    valid whenever the appended count matches the citizens gained.
 * 2. **The assignment the turn started with**, read against the after-state's
 *    improvements and buildings. Valid whenever no command reassigned tiles during
 *    the turn (the common case) and whenever growth appended fewer tiles than
 *    citizens (no free tile left in the radius).
 * 3. **The previous state's own numbers** — the M3 test's reading, and the one that is
 *    exactly right when the invariant is called with the state immediately before
 *    `EndTurn`.
 *
 * Readings that agree collapse to one, which is the usual case: nothing is
 * reassigned, nothing is appended, and the check is an exact equality.
 */
const surplusReadings = (
  ctx: InvariantContext,
  cityBefore: City,
  cityAfter: City,
  requirement: (population: number) => number,
): readonly SurplusReading[] => {
  const readings: SurplusReading[] = [];
  const boxBefore = cityBefore.foodBox;
  const populationBefore = cityBefore.population;
  const gained = Math.max(0, cityAfter.population - cityBefore.population);

  const consider = (label: string, state: GameState, city: City): void => {
    let surplus: number;
    try {
      surplus = cityYields(withCity(state, city), ctx.rulesetView, city.id).foodSurplus;
    } catch {
      // A corpus too corrupt for `cityYields` is reported by the shape invariants;
      // this reading contributes nothing rather than throwing.
      return;
    }
    if (readings.some((reading) => reading.surplus === surplus)) return;
    readings.push({
      label,
      surplus,
      step: foodStep(boxBefore, populationBefore, surplus, requirement),
    });
  };

  const tiles = cityAfter.workedTiles;
  if (tiles.length >= gained) {
    consider(
      'the tiles it works now, less the ones growth added',
      ctx.state,
      withTiles(cityAfter, populationBefore, tiles.slice(0, tiles.length - gained)),
    );
  }
  consider(
    'the assignment it had at the start of the turn',
    ctx.state,
    withTiles(cityAfter, populationBefore, cityBefore.workedTiles),
  );
  if (ctx.previous !== undefined) {
    consider(
      'the city as the previous turn left it',
      ctx.previous,
      withTiles(cityBefore, populationBefore, cityBefore.workedTiles),
    );
  }

  return readings;
};

/**
 * Did this city's owner report a `TreasuryShortfall` this turn — that is, did the money
 * step run `disbandBuildings` for it?
 *
 * The ledger reports *that a player was short*, never which buildings left, so this is
 * the finest statement the events support about a demolition. One check needs it (see
 * `thresholdRecoverable`); the food-box bound deliberately does not, and its doc comment
 * says why.
 */
const ownerWentShort = (ctx: InvariantContext, cityAfter: City): boolean =>
  shortfallEvents(ctx.events).some((event) => event.playerId === cityAfter.owner);

/**
 * Did a `growth-food` building **join this city** during this turn's production step?
 *
 * `advanceTurn` runs growth before production, so such a row was not in the list growth
 * measured the box against: it lowers the threshold *after* the box was filled, which is
 * the shipped false positive this exemption exists for (five runs of the first fifty
 * seeds of `sim --map-size tiny --turns 20` stopped on it before it was fixed).
 */
const growthFoodCompleted = (ctx: InvariantContext, cityAfter: City): boolean =>
  producedEvents(ctx.events).some(
    (event) =>
      event.cityId === cityAfter.id &&
      event.item.kind === 'building' &&
      growthFoodOfRow(ctx.rulesetView, event.item.id) > 0,
  );

/**
 * **The growth threshold, and the two checks that read it.** A growth threshold is
 * `max(MIN_GROWTH_FOOD, bare - the city's growth-food reduction)`, so it depends on
 * *which buildings the city held when growth measured the box* — and the after-state's
 * building list is not always that list, because production and the money step run
 * after growth (`turn.ts`' frozen order). Exactly two things can move it, and they move
 * it in opposite directions:
 *
 * 1. a `growth-food` building **completes** this turn and joins the city after growth
 *    ran. That *lowers* the threshold, so the box the turn ends with may legitimately be
 *    at or above the threshold the state's own rows now imply. This is the case
 *    `growthFoodCompleted` names, and it is the only one that can excuse a full box.
 * 2. a bankrupt owner's buildings are **demolished** before the turn ends, which can
 *    only *raise* the threshold: removing rows removes reductions and never adds one. On
 *    shipped content the row taken is never the granary — it pays no maintenance, and
 *    `disbandBuildings` skips every row whose maintenance is `<= 0` — and even a
 *    `growth-food` row a demolition did take could only raise the threshold, which
 *    cannot make a box at or above the after-state's threshold legal.
 *
 * So the two checks claim exactly what those facts allow, and they no longer share one
 * predicate:
 *
 * - **`city-food-box-within-threshold` claims `foodBoxThresholdRecoverable`** — case 1
 *   alone. Because case 2 only *raises* the threshold, a box at or above the reduced
 *   threshold the state carries now was at or above the threshold growth saw, so growth
 *   should have spent it. Inheriting case 2 gave the check an exemption it could not
 *   need: a box in `[reduced, bare)` — a box the growth pass should have spent — escaped
 *   the reduced bound on any turn whose owner reported a shortfall, which is a real loss
 *   of detection, not a relaxation of precision.
 * - **`city-food-conservation` claims `thresholdRecoverable`** — both cases. It cannot
 *   skip them: it *recomputes* the growth arithmetic against the after-state's rows
 *   (`growthRequirement`), so a demolition in the same turn leaves it unable to know what
 *   growth did. (A late completion it also cannot recompute. The events name the player
 *   who went short and never the rows that left, which is why this check skips the
 *   arithmetic rather than subtracting a guessed threshold.)
 *
 * Splitting the predicate is what lets each doc comment be true rather than
 * approximately true: one claim is shared where it is genuinely shared, and dropped
 * where it was only ever suppressing a real violation.
 */
const foodBoxThresholdRecoverable = (ctx: InvariantContext, cityAfter: City): boolean =>
  !growthFoodCompleted(ctx, cityAfter);

/** The wider exemption `city-food-conservation` needs: a completion *or* a demolition. */
const thresholdRecoverable = (ctx: InvariantContext, cityAfter: City): boolean =>
  !ownerWentShort(ctx, cityAfter) && foodBoxThresholdRecoverable(ctx, cityAfter);

/* ------------------------------------------------------------------ *
 * Shape invariants
 * ------------------------------------------------------------------ */

/**
 * `treasury-non-negative` — a treasury is never negative.
 *
 * The money loop's hard floor: a treasury that would go below zero floors at **0**
 * and the shortfall is reported, never carried. A negative treasury silently breaks
 * every later subtraction, which is exactly why it is an invariant rather than a
 * convention.
 */
const treasuryNonNegative = (ctx: InvariantContext): readonly string[] =>
  ctx.state.players.flatMap((player) =>
    player.treasury >= 0
      ? []
      : [
          `player ${String(player.id)} (${player.name}) has treasury ` +
            `${String(player.treasury)}; a treasury is never negative (bankruptcy floors at 0)`,
        ],
  );

/**
 * `pools-non-negative` — beakers and luxuries never go negative.
 *
 * The other two channels of the commerce split. Both are **inert** until M5 and M9,
 * which is exactly why a negative value would go unnoticed for milestones: nothing
 * spends them, so nothing would fail. They accumulate, and accumulation cannot
 * subtract.
 */
const poolsNonNegative = (ctx: InvariantContext): readonly string[] =>
  ctx.state.players.flatMap((player) => {
    const problems: string[] = [];
    const label = `player ${String(player.id)} (${player.name})`;
    if (player.beakers < 0) problems.push(`${label} has ${String(player.beakers)} beakers`);
    if (player.luxuries < 0) problems.push(`${label} has ${String(player.luxuries)} luxuries`);
    return problems;
  });

/**
 * `player-pools-integral` — every money pool is a whole number.
 *
 * Integer-only simulation arithmetic (PLAN.md §5.3): a fraction in a pool is a
 * fraction in the state hash, which `canonicalize` would reject and a save/load round
 * trip would not preserve. The pools are the three numbers the money loop writes.
 */
const playerPoolsIntegral = (ctx: InvariantContext): readonly string[] =>
  ctx.state.players.flatMap((player) => {
    const problems: string[] = [];
    const label = `player ${String(player.id)} (${player.name})`;
    if (!Number.isInteger(player.treasury)) {
      problems.push(`${label} carries a fractional treasury ${String(player.treasury)}`);
    }
    if (!Number.isInteger(player.beakers)) {
      problems.push(`${label} carries fractional beakers ${String(player.beakers)}`);
    }
    if (!Number.isInteger(player.luxuries)) {
      problems.push(`${label} carries fractional luxuries ${String(player.luxuries)}`);
    }
    return problems;
  });

/** `city-population-at-least-one` — a city is never empty. */
const cityPopulationAtLeastOne = (ctx: InvariantContext): readonly string[] =>
  ctx.state.cities.flatMap((city) =>
    Number.isInteger(city.population) && city.population >= 1
      ? []
      : [
          `city ${String(city.id)} (${city.name}) has population ${String(city.population)}; ` +
            `a city has at least one citizen, and the count is a whole number`,
        ],
  );

/**
 * `city-food-box-within-threshold` — the food box is in `[0, its own threshold)`, where
 * "its own threshold" is **the threshold in force when growth measured it**, not
 * necessarily the one the state's buildings imply at the end of the turn.
 *
 * ## Why this is two bounds and not one
 *
 * The frozen turn order runs **growth before production** (`turn.ts`), so a
 * `growth-food` building that completes in the production step joins the city *after*
 * the box was filled. The reduced threshold it brings — smaller by its `growth-food`
 * amount — is what the **next** growth check will use; the box the turn ends with was
 * legally allowed to reach the pre-completion threshold. Comparing an end-of-turn box
 * against an end-of-turn threshold is therefore one turn too strict, and it is a false
 * alarm on shipped content rather than a hypothetical: without the exemption below,
 * `sim --seeds 1..50 --map-size tiny --turns 20` reports **five violations** (seeds 6,
 * 17, 29, 38, 39, all at turn 12), each one a city that completed a granary that turn
 * and ended with its box exactly at the new, lower threshold. A false alarm is worse
 * than a missed check here: it stops the run, truncates its horizon, and makes every
 * aggregate folded over the batch a mean over games of different lengths.
 *
 * So the check states two claims, and the pair is the whole point of it:
 *
 * 1. **The box is ALWAYS below the BARE `foodBoxSize(population)`** — unconditionally,
 *    for every city, every turn, whatever its buildings. No event has to be read to
 *    justify this bound: growth spends a threshold per citizen gained, that threshold is
 *    `max(MIN_GROWTH_FOOD, bare - reduction)` with a non-negative reduction (the
 *    `growth-food` amount `validateRuleset` requires to be a non-negative integer), so it
 *    never exceeds the bare curve, and the growth loop leaves the box below the
 *    threshold it stopped on. A box at or above the bare size is a box growth should
 *    have spent, and nothing about a building completed later in the turn can excuse it.
 *    **This is the bound that catches a genuinely illegal box**, and it is the one the
 *    `BROKEN_STATES` case for this invariant fires.
 * 2. **The box is ALSO below the REDUCED (building-aware) threshold** — the bare curve
 *    less this city's own `growth-food` rows, floored at `MIN_GROWTH_FOOD` — because
 *    that is the stricter of the two statements and a granary city sitting one food
 *    short of a citizen it should have gained is a growth bug the bare bound would
 *    accept. This is claimed **except when the state's building list is not the list
 *    growth measured against in the direction that can excuse a full box** — that is,
 *    except when a `growth-food` building completed this turn, lowering the threshold
 *    after growth ran (`foodBoxThresholdRecoverable`). A **demolition** is deliberately
 *    *not* an exemption here, and the reason is arithmetic rather than optimism:
 *    demolishing rows can only *raise* the threshold, so a box at or above the
 *    after-state's reduced threshold was at or above the threshold growth saw, and growth
 *    spends the box whenever it reaches its requirement. The earlier version of this
 *    check inherited the demolition exemption from the shared predicate, which meant a
 *    box in `[reduced, bare)` — a box the growth pass should have spent — escaped the
 *    reduced bound on any turn whose owner reported a shortfall: an exemption that could
 *    only ever *suppress* a violation, never prevent a false one (on shipped content the
 *    demolished row is never the granary, which pays no maintenance and so is skipped by
 *    `disbandBuildings`). The bare bound above still applies in every one of those
 *    configurations, so nothing illegal was ever invisible; what was lost was the
 *    stricter of the two bounds, and it is no longer lost.
 *
 * Someone will eventually read bound 2 alone, see that it "obviously" subsumes bound 1,
 * and simplify — which reintroduces five false positives in the first fifty seeds. The
 * two claims are not one claim with a fallback; they are the claim that holds always
 * (bound 1) and the claim that holds whenever no growth-food building arrived after
 * growth ran (bound 2).
 *
 * ## The one limit bound 2 has, stated rather than discovered later
 *
 * Bound 2 says "growth spent a box this full". That is a statement about a growth pass
 * that *ran*, and the pass changes nothing at all for a city whose food surplus is
 * exactly zero (`growth.ts` skips such a city). So a box in `[reduced, bare)` that was
 * **carried into** a turn survives it, and this check reports it. The configuration is
 * narrow and was never reached in a sweep of 200 seeds × 40 turns (`sim --seeds 1..200
 * --map-size tiny --turns 40`: 168000 checks, 0 violations), but it is reachable in
 * principle: a city sitting one food below the bare curve on a zero-surplus turn, whose
 * granary completes in that turn's production step (which the exemption above correctly
 * allows — the box is now at the reduced threshold), followed by a second zero-surplus
 * turn. Closing it would mean asking the after-state for the surplus growth saw and
 * exempting a zero-surplus city, which trades a false alarm on a legal save for a false
 * negative on a corrupt one — so the bound is left as the stricter, spec'd statement, and
 * the limit is named here instead of silently widened.
 */
const cityFoodBoxWithinThreshold = (ctx: InvariantContext): readonly string[] =>
  ctx.state.cities.flatMap((city) => {
    const label = `city ${String(city.id)} (${city.name})`;
    const box = wholeNumber(city.foodBox);
    if (box === undefined || box < 0) {
      return [
        `${label} has food box ${String(city.foodBox)}; a food box is a whole number that never ` +
          `goes below zero`,
      ];
    }

    const bare = foodBoxSize(city.population);
    if (box >= bare) {
      return [
        `${label} has food box ${String(box)}, at or above the ${String(bare)} food a city of ` +
          `population ${String(city.population)} must accumulate for another citizen; growth spends ` +
          `the box whenever it reaches its requirement, and no reduction a building applies can make ` +
          `that requirement exceed the bare curve — so no turn can leave a box this full, whatever ` +
          `was completed during it`,
      ];
    }

    const reduced = growthRequirement(ctx.rulesetView, city, city.population);
    if (box < reduced) return [];
    if (!foodBoxThresholdRecoverable(ctx, city)) return [];
    return [
      `${label} has food box ${String(box)}, outside [0, ${String(reduced)}) — the threshold this ` +
        `city's own growth-food buildings leave for population ${String(city.population)} — and no ` +
        `growth-food building was completed in this turn's events, so the pass that filled this box ` +
        `measured it against the same threshold the state carries now (a demolition can only raise ` +
        `that threshold, so it cannot make a box this full legal)`,
    ];
  });

/** `city-shields-non-negative` — stored production is a whole, non-negative count. */
const cityShieldsNonNegative = (ctx: InvariantContext): readonly string[] =>
  ctx.state.cities.flatMap((city) =>
    Number.isInteger(city.shields) && city.shields >= 0
      ? []
      : [
          `city ${String(city.id)} (${city.name}) has ${String(city.shields)} stored shields; ` +
            `stored production is a whole number that never goes below zero`,
        ],
  );

/**
 * `city-works-at-most-its-citizens` — a city never works more tiles than it has
 * citizens.
 *
 * One citizen, one tile (the centre is free and excluded). Starvation trims the
 * assignment to the new population, so this holds after a city shrinks as well as
 * after it grows.
 */
const cityWorksAtMostItsCitizens = (ctx: InvariantContext): readonly string[] =>
  ctx.state.cities.flatMap((city) =>
    city.workedTiles.length <= city.population
      ? []
      : [
          `city ${String(city.id)} (${city.name}) works ${String(city.workedTiles.length)} tiles ` +
            `for ${String(city.population)} citizens`,
        ],
  );

/**
 * `tile-worked-by-one-city` — no two cities work the same tile, and no city lists one
 * twice.
 *
 * The rule is stated once here and enforced by assignment; a second city claiming a
 * worked tile would silently double the world's output, and which city "really" holds
 * it would depend on iteration order.
 */
const tileWorkedByOneCity = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const claimed = new Map<number, string>();

  for (const city of ctx.state.cities) {
    const seen = new Set<number>();
    const label = `city ${String(city.id)} (${city.name})`;
    for (const tile of city.workedTiles) {
      const index = Number(tile);
      if (seen.has(index)) {
        problems.push(`${label} lists tile ${String(index)} twice`);
        continue;
      }
      seen.add(index);
      const rival = claimed.get(index);
      if (rival !== undefined) {
        problems.push(`tile ${String(index)} is worked by ${rival} and by ${label}`);
        continue;
      }
      claimed.set(index, label);
    }
  }

  return problems;
};

/**
 * `worked-tile-in-city-radius` — every worked tile is inside its city's radius and is
 * not the centre.
 *
 * The radius is the 21-tile shape (`cityRadius`), which already excludes tiles off
 * the map; the centre is excluded separately because it is worked for free and must
 * never appear in `workedTiles`.
 */
const workedTileInCityRadius = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];

  for (const city of ctx.state.cities) {
    const label = `city ${String(city.id)} (${city.name})`;
    const radius = new Set(cityRadius(ctx.state, city.tile).map(Number));
    for (const tile of city.workedTiles) {
      const index = Number(tile);
      if (index === Number(city.tile)) {
        problems.push(`${label} lists its own centre (tile ${String(index)}) as a worked tile`);
        continue;
      }
      if (!radius.has(index)) {
        problems.push(
          `${label} works tile ${String(index)}, which is not in its radius (centre tile ` +
            `${String(city.tile)})`,
        );
      }
    }
  }

  return problems;
};

/** `city-ids-unique-and-sorted` — city ids are strictly ascending, so also unique. */
const cityIdsUniqueAndSorted = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const cities = ctx.state.cities;
  for (let index = 1; index < cities.length; index += 1) {
    const previous = cities[index - 1];
    const city = cities[index];
    if (previous === undefined || city === undefined) continue;
    if (Number(city.id) <= Number(previous.id)) {
      problems.push(
        `cities[${String(index)}] has id ${String(city.id)}, which does not exceed ` +
          `cities[${String(index - 1)}]'s id ${String(previous.id)}; city ids are unique and ` +
          `sorted ascending (the order is hashed)`,
      );
    }
  }
  return problems;
};

/**
 * `city-tile-unique` — no two cities stand on the same tile.
 *
 * The companion of `city-ids-unique-and-sorted`, and a *different* property: ids
 * identify cities, tiles locate them, and a registry that checked only the first could
 * not see two cities sharing one square. Today no command can produce that state —
 * `FoundCity` enforces `MIN_CITY_DISTANCE` — so this is not a live play bug, and saying
 * which it is matters: it is a **shape** check, and the registry is what a hand-built
 * fixture and (from the save/load milestone) a *loaded file* are checked against. A
 * second city on an occupied tile doubles that tile's output and makes every later
 * lookup by tile — `cityAt`, the worked-tile assignment, the AI's target choice —
 * depend on which of the two the city list happens to reach first, which is exactly the
 * kind of silent ambiguity a named invariant exists to turn into a failure.
 *
 * Reported once per extra city on the tile, naming the tile, the city that holds it and
 * the city that claims it, so a three-way collision names both intruders rather than
 * only the first.
 */
const cityTileUnique = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const holder = new Map<number, string>();

  for (const city of ctx.state.cities) {
    const tile = Number(city.tile);
    const label = `city ${String(city.id)} (${city.name})`;
    const rival = holder.get(tile);
    if (rival !== undefined) {
      problems.push(
        `tile ${String(tile)} holds ${rival} and ${label}; two cities never stand on one tile`,
      );
      continue;
    }
    holder.set(tile, label);
  }

  return problems;
};

/** `unit-ids-unique-and-sorted` — unit ids are strictly ascending, so also unique. */
const unitIdsUniqueAndSorted = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const units = ctx.state.units;
  for (let index = 1; index < units.length; index += 1) {
    const previous = units[index - 1];
    const unit = units[index];
    if (previous === undefined || unit === undefined) continue;
    if (Number(unit.id) <= Number(previous.id)) {
      problems.push(
        `units[${String(index)}] has id ${String(unit.id)}, which does not exceed ` +
          `units[${String(index - 1)}]'s id ${String(previous.id)}; unit ids are unique and ` +
          `sorted ascending (the order is hashed)`,
      );
    }
  }
  return problems;
};

/** `unit-tile-in-bounds` — every unit stands on a real tile. */
const unitTileInBounds = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const size = ctx.state.map.width * ctx.state.map.height;
  for (const unit of ctx.state.units) {
    const tile = Number(unit.tile);
    if (!Number.isInteger(tile) || tile < 0 || tile >= size) {
      problems.push(
        `unit ${String(unit.id)} stands on tile ${String(unit.tile)}, outside the ` +
          `${String(ctx.state.map.width)}x${String(ctx.state.map.height)} map (0..${String(size - 1)})`,
      );
    }
  }
  return problems;
};

/** `unit-owner-exists` — every unit is owned by a player that exists. */
const unitOwnerExists = (ctx: InvariantContext): readonly string[] =>
  ctx.state.units.flatMap((unit) =>
    playerExists(ctx.state, unit.owner)
      ? []
      : [
          `unit ${String(unit.id)} is owned by player ${String(unit.owner)}, which the state's ` +
            `player list does not contain`,
        ],
  );

/**
 * `unit-movement-in-range` — movement left is a whole number in `[0, its maximum]`.
 *
 * The maximum comes from the unit's own row. A unit whose type the ruleset does not
 * describe **is reported**: the engine's `EndTurn` deliberately refills such a unit's
 * budget not at all (there is no honest number for it), but a simulation cannot
 * bound what the rules cannot describe, and "movement within `[0, maximum]`" is a
 * claim no such unit satisfies. Naming it here is what keeps the failure at the unit
 * that has no rules rather than at whatever later reads its budget.
 */
const unitMovementInRange = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];

  for (const unit of ctx.state.units) {
    const label = `unit ${String(unit.id)} (${String(unit.type)})`;
    const movement = wholeNumber(unit.movementLeft);
    if (movement === undefined || movement < 0) {
      problems.push(
        `${label} has ${String(unit.movementLeft)} movement left; it is a whole number >= 0`,
      );
      continue;
    }
    const def = unitDef(ctx.rulesetView, unit.type);
    if (def === undefined) {
      problems.push(
        `${label} is not in the ruleset, so its movement budget (${String(movement)}) cannot be ` +
          `bounded by a maximum`,
      );
      continue;
    }
    if (movement > def.movement) {
      problems.push(
        `${label} has ${String(movement)} movement left, more than its ${String(def.movement)} ` +
          `per turn`,
      );
    }
  }

  return problems;
};

/**
 * Where a stored improvement id sorts, restated here rather than imported from the
 * writer's private comparison: the position of the **kind it names** in
 * `IMPROVEMENT_KINDS` (`road`, `mine`, `irrigation` — the vocabulary's editorial order,
 * which is deliberately not code-unit order), or `-1` for an id that names no kind.
 *
 * The vocabulary is imported because it is the *engine's* list, not the ruleset under
 * test; the order the modules must agree on is what is restated.
 *
 * The spelling tie-break is part of the rule rather than an implementation detail: two
 * ids that name no kind both rank `-1`, and without a tie-break the *insertion* order
 * would decide theirs — the one thing a hashed order may never depend on. `String`
 * comparison, never `localeCompare`: a collator would order by the environment's locale.
 */
const IMPROVEMENT_KIND_NAMES: readonly string[] = IMPROVEMENT_KINDS;
const improvementIdRank = (id: ImprovementId): number => IMPROVEMENT_KIND_NAMES.indexOf(id);
const compareImprovementIds = (a: ImprovementId, b: ImprovementId): number => {
  const byKind = improvementIdRank(a) - improvementIdRank(b);
  if (byKind !== 0) return byKind;
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

/**
 * `improvements-sorted-and-unique` — the improvement pair list is in its contract
 * order and free of duplicates.
 *
 * The order is part of the contract because the list is hashed: *tile ascending, then
 * the rank of the kind the stored id names, then the id itself*. It is restated here
 * (rather than imported from the writer's private comparison) on purpose — an invariant
 * that asked the module under test what order it meant would agree with any order that
 * module produced.
 *
 * Each entry is also required to *be* a `(tile, kind)` pair: a one-element list makes no
 * claim about order, and a `null` or a kind that is not a string is a corruption a
 * consecutive-entry comparison would never look at. A kind the catalog does not describe
 * is deliberately not reported here — that is a foreign ruleset's business, not the
 * pair list's — but its *rank* is still checked, because the state-level order is an
 * order on ids and every id therefore has one.
 */
const improvementsSortedAndUnique = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const pairs = ctx.state.improvements;

  for (let index = 0; index < pairs.length; index += 1) {
    const entry: unknown = pairs[index];
    if (!isPairEntry(entry)) {
      problems.push(
        `improvements[${String(index)}] is ${describeValue(entry)}, which is not a (tile, kind) pair`,
      );
    }
  }

  for (let index = 1; index < pairs.length; index += 1) {
    const previous = pairs[index - 1];
    const pair = pairs[index];
    if (previous === undefined || pair === undefined) continue;
    const tileDelta = Number(pair.tile) - Number(previous.tile);
    const kindDelta = compareImprovementIds(pair.kind, previous.kind);
    if (tileDelta < 0 || (tileDelta === 0 && kindDelta <= 0)) {
      problems.push(
        `improvements[${String(index)}] is (tile ${String(pair.tile)}, ${String(pair.kind)}), which ` +
          `does not follow (tile ${String(previous.tile)}, ${String(previous.kind)}) in the ` +
          `contract order (tile ascending, then the kind the id names, then the id) — and a ` +
          `duplicate pair is not stored twice`,
      );
    }
  }

  return problems;
};

/**
 * `resources-sorted-and-unique` — the resource pair list is in its contract order, has
 * no duplicates, and never puts two resources on one tile.
 *
 * Entries are validated the same way the improvement list validates its own, for the
 * same reason: a one-element list says nothing about order, and a `null` entry is not a
 * pair in a list that is supposed to be made of them.
 *
 * Order and uniqueness come from `compareTileResources` — the engine's own statement
 * of the order, which is what the list was written with. "At most one resource per
 * tile" is the map's own guarantee and is checked separately, because two different
 * resources on one tile *do* sort correctly and would otherwise pass.
 */
const resourcesSortedAndUnique = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];
  const pairs = ctx.state.map.resources;

  for (let index = 0; index < pairs.length; index += 1) {
    const entry: unknown = pairs[index];
    if (!isResourceEntry(entry)) {
      problems.push(
        `resources[${String(index)}] is ${describeValue(entry)}, which is not a (tile, resource) pair`,
      );
    }
  }

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === undefined) continue;
    if (index === 0) continue;
    const previous = pairs[index - 1];
    if (previous === undefined) continue;
    if (compareTileResources(previous, pair) >= 0) {
      problems.push(
        `resources[${String(index)}] is (tile ${String(pair.tile)}, ${String(pair.resource)}), which ` +
          `does not follow (tile ${String(previous.tile)}, ${String(previous.resource)}) in the ` +
          `contract order (tile ascending, then resource id) — and a pair is stored once`,
      );
      continue;
    }
    if (Number(previous.tile) === Number(pair.tile)) {
      problems.push(
        `tile ${String(pair.tile)} carries both ${String(previous.resource)} and ` +
          `${String(pair.resource)}; a tile carries at most one resource`,
      );
    }
  }

  return problems;
};

/**
 * `wonder-held-by-one-city` — a wonder is held by at most one city in the world.
 *
 * M4c's global uniqueness, as a property of the **world** rather than of one city's
 * completion branch: a second copy is precisely what the rule exists to prevent, and
 * it can only be seen by looking at every city at once. A wonder row the catalog does
 * not describe is not a wonder and is ignored; `wonder: true` is the only spelling.
 */
const wonderHeldByOneCity = (ctx: InvariantContext): readonly string[] => {
  const problems: string[] = [];

  for (const def of buildingRows(ctx.rulesetView)) {
    if (def.wonder !== true) continue;
    const holders = ctx.state.cities.filter((city) => city.buildings.includes(def.id));
    if (holders.length > 1) {
      const names = holders.map((city) => `city ${String(city.id)} (${city.name})`).join(', ');
      problems.push(
        `wonder ${String(def.id)} is held by ${String(holders.length)} cities: ${names}; a wonder ` +
          `is globally unique`,
      );
    }
  }

  return problems;
};

/* ------------------------------------------------------------------ *
 * Transition invariants — the conservation checks
 * ------------------------------------------------------------------ */

/**
 * `gold-conservation` — every civilization's gold moved by exactly what the money
 * loop's own ledger says, and a shortfall floored it at zero.
 *
 * The money loop documents one identity: `treasuryAfter - treasuryBefore ===
 * income - upkeep + covered + unpaid`, where `covered` is the sum of every
 * `UnitDisbanded.saved` and `unpaid` the `TreasuryShortfall.unpaid` remainder, plus
 * the settlement rule `treasuryAfter === max(0, treasuryBefore + income - upkeep)`.
 * Both are checked here, from the ledger lines the turn itself emitted — which is what
 * makes the check independent of the arithmetic that wrote them:
 *
 * - the **settlement** line compares the state against the two amounts the turn
 *   reported, so a mis-settled treasury, a pool written twice or a rate applied to the
 *   wrong player fails here;
 * - the **identity** compares the reported income and upkeep against the reported
 *   covered and unpaid amounts, so an over-credited disband (`saved` larger than the
 *   shortfall), an invented shortfall or a disband that bought nothing fails here;
 * - the **disband lines** are checked against the units themselves: a `UnitDisbanded`
 *   naming a unit that is still in the state is a lie about what happened, and a
 *   `saved` above `UNIT_SUPPORT_COST` claims one unit paid for more than it can.
 *
 * What it deliberately does **not** do is recompute income and upkeep from
 * `previous`: the money step runs *after* growth and production, so the cities it
 * summed are not the cities `previous` describes (a city that grew this turn split
 * more commerce). Recomputing from the turn boundary would be wrong on exactly the
 * turns that matter. The check is the ledger's identity, not a second opinion about
 * the arithmetic inside it.
 *
 * On the first turn (`previous === undefined`) there is nothing to conserve and the
 * check returns no violations.
 */
const goldConservation = (ctx: InvariantContext): readonly string[] => {
  const previous = ctx.previous;
  if (previous === undefined) return [];

  const problems: string[] = [];
  const income = incomeEvents(ctx.events);
  const upkeep = upkeepEvents(ctx.events);
  const disbands = disbandEvents(ctx.events);
  const shortfalls = shortfallEvents(ctx.events);

  // Lines about players, and about units that really left.
  for (const event of income) {
    const player = previous.players.find((candidate) => candidate.id === event.playerId);
    if (player === undefined) {
      problems.push(
        `IncomeCollected names player ${String(event.playerId)}, which the previous state does ` +
          `not contain; barbarians never collect`,
      );
    } else if (player.kind !== 'civ') {
      problems.push(
        `IncomeCollected names player ${String(event.playerId)} (${player.name}), who is a ` +
          `barbarian; barbarians have no economy`,
      );
    }
  }
  for (const event of upkeep) {
    const player = previous.players.find((candidate) => candidate.id === event.playerId);
    if (player === undefined || player.kind !== 'civ') {
      problems.push(
        `UpkeepPaid names player ${String(event.playerId)}, which is not a civilization of the ` +
          `previous state; barbarians pay nothing`,
      );
    }
  }
  for (const event of disbands) {
    if (!(event.saved >= 0) || event.saved > UNIT_SUPPORT_COST) {
      problems.push(
        `disbanding unit ${String(event.unitId)} reports saving ${String(event.saved)} gold, ` +
          `outside [0, ${String(UNIT_SUPPORT_COST)}] — one unit's removal saves one unit's support`,
      );
    }
    if (ctx.state.units.some((unit) => unit.id === event.unitId)) {
      problems.push(
        `unit ${String(event.unitId)} was disbanded for player ${String(event.playerId)} and is ` +
          `still in the state`,
      );
    }
  }
  for (const event of shortfalls) {
    if (!(event.unpaid > 0)) {
      problems.push(
        `a TreasuryShortfall for player ${String(event.playerId)} reports ${String(event.unpaid)} ` +
          `unpaid gold; a shortfall is what could not be paid, so it is positive`,
      );
    }
  }

  for (const player of previous.players) {
    if (player.kind !== 'civ') continue;
    const after = ctx.state.players.find((candidate) => candidate.id === player.id);
    if (after === undefined) {
      problems.push(
        `player ${String(player.id)} (${player.name}) was in the world at the start of the turn ` +
          `and is gone now`,
      );
      continue;
    }

    const label = `player ${String(player.id)} (${player.name})`;
    const mine = (event: { readonly playerId: PlayerId }): boolean => event.playerId === player.id;
    const ledgerRan = income.some(mine) || upkeep.some(mine);
    if (!ledgerRan) {
      if (after.treasury !== player.treasury) {
        problems.push(
          `${label}'s treasury moved ${String(player.treasury)} -> ${String(after.treasury)} with ` +
            `no IncomeCollected/UpkeepPaid line in this transition; only the money loop changes gold`,
        );
      }
      continue;
    }

    const collected = income.filter(mine).reduce((total, event) => total + event.gold, 0);
    const paid = upkeep.filter(mine).reduce((total, event) => total + event.gold, 0);
    const covered = disbands.filter(mine).reduce((total, event) => total + event.saved, 0);
    const unpaid = shortfalls.filter(mine).reduce((total, event) => total + event.unpaid, 0);

    const settled = player.treasury + collected - paid;
    if (settled >= 0) {
      if (after.treasury !== settled) {
        problems.push(
          `${label}'s treasury is ${String(after.treasury)}; the ledger says ` +
            `${String(player.treasury)} + ${String(collected)} income - ${String(paid)} upkeep = ` +
            String(settled),
        );
      }
      if (covered !== 0 || unpaid !== 0) {
        problems.push(
          `${label} ended the turn solvent (${String(settled)}) but its ledger reports ` +
            `${String(covered)} gold saved by disbanding and ${String(unpaid)} gold unpaid`,
        );
      }
      continue;
    }

    if (after.treasury !== 0) {
      problems.push(
        `${label} went ${String(-settled)} gold short but its treasury is ` +
          `${String(after.treasury)}; a shortfall floors the treasury at 0`,
      );
    }
    if (covered + unpaid !== -settled) {
      problems.push(
        `${label} went ${String(-settled)} gold short, but its ledger reports ` +
          `${String(covered)} covered by disbanding + ${String(unpaid)} unpaid`,
      );
    }
  }

  return problems;
};

/**
 * `city-food-conservation` — a city's population and food box moved exactly as the
 * growth rule says, or the turn did not run the growth pass at all.
 *
 * Lifted from `m3-adversarial.test.ts`'s `checkTurn`, whose food half is a
 * transcription of the M3 contract: add the surplus, spend the city's own threshold
 * per citizen gained and carry the remainder over, draw a deficit down and starve only
 * below zero. The transcription stays a transcription — the threshold is re-derived
 * from the catalog rows the city holds (`growthRequirement`), never read back out of
 * `applyGrowth` — so a growth bug has to fool this before it can pass.
 *
 * What is checked, and the limits of each:
 *
 * 1. **Event/state agreement.** A `CityGrew`/`CityStarved` event for this city must
 *    name the population and box the state has; a growth the state does not show, or a
 *    state change no event names, is a violation.
 * 2. **Population accounting.** The population changes only through a growth event,
 *    grows only upward, and a starving city lands on `max(1, population - 1)` with a
 *    box of 0.
 * 3. **The arithmetic.** `foodStep` reproduces the transition for at least one
 *    legitimate reading of the assignment growth saw. When the readings coincide — the
 *    ordinary case — this is the M3 equality to the food.
 * 4. **No turn, no movement.** A transition whose events carry no `IncomeCollected`
 *    line did not run the pipeline, so neither the population nor the box may move.
 *
 * Two cases deliberately skip the arithmetic, and both are stated in the messages the
 * check produces rather than hidden: a **starvation** (the trim rewrites the
 * assignment at the end of the deficit rule, so the assignment the deficit was
 * computed against is not recoverable from the state) and a turn whose **growth
 * threshold is not recoverable** (`thresholdRecoverable`). The structural claims above
 * still run in both cases, and the "one tile per citizen" shape invariant covers the
 * trim.
 */
const cityFoodConservation = (ctx: InvariantContext): readonly string[] => {
  const previous = ctx.previous;
  if (previous === undefined) return [];

  const problems: string[] = [];
  const ran = turnRan(ctx);

  for (const cityBefore of previous.cities) {
    const id: CityId = cityBefore.id;
    const cityAfter = ctx.state.cities.find((city) => city.id === id);
    if (cityAfter === undefined) {
      problems.push(
        `city ${String(id)} (${cityBefore.name}) was in the world at the start of the turn and is ` +
          `gone now; cities are founded, never removed`,
      );
      continue;
    }

    const label = `city ${String(id)} (${cityAfter.name})`;
    const popBefore = cityBefore.population;
    const boxBefore = cityBefore.foodBox;
    const popAfter = cityAfter.population;
    const boxAfter = cityAfter.foodBox;

    if (wholeNumber(popBefore) === undefined || wholeNumber(boxBefore) === undefined) {
      problems.push(
        `${label}: the previous state's population ${String(popBefore)} / food box ` +
          `${String(boxBefore)} is not a whole number, so this transition's food bookkeeping ` +
          `cannot be reconciled`,
      );
      continue;
    }

    const grew = grewEvents(ctx.events).filter((event) => event.cityId === id);
    const starved = starvedEvents(ctx.events).filter((event) => event.cityId === id);

    if (grew.length > 1) {
      problems.push(`${label} grew ${String(grew.length)} times in one turn`);
    }
    if (starved.length > 1) {
      problems.push(`${label} starved ${String(starved.length)} times in one turn`);
    }
    if (grew.length > 0 && starved.length > 0) {
      problems.push(`${label} both grew and starved in one turn`);
    }

    for (const event of grew) {
      if (event.population !== popAfter || event.foodBox !== boxAfter) {
        problems.push(
          `${label}: its CityGrew event says population ${String(event.population)} with food box ` +
            `${String(event.foodBox)}, but the state says ${String(popAfter)} / ${String(boxAfter)}`,
        );
      }
    }
    for (const event of starved) {
      if (event.population !== popAfter) {
        problems.push(
          `${label}: its CityStarved event says population ${String(event.population)}, but the ` +
            `state says ${String(popAfter)}`,
        );
      }
      if (event.foodBox !== 0) {
        problems.push(
          `${label}: its CityStarved event reports a food box of ${String(event.foodBox)}; the ` +
            `box restarts at 0`,
        );
      }
    }

    if (starved.length > 0) {
      const expected = Math.max(1, popBefore - 1);
      if (popAfter !== expected) {
        problems.push(
          `${label} starved from population ${String(popBefore)} to ${String(popAfter)}, but the ` +
            `rule takes a starving city to ${String(expected)}`,
        );
      }
      if (boxAfter !== 0) {
        problems.push(
          `${label} starved but its food box is ${String(boxAfter)}; a starved city's box restarts ` +
            `at 0`,
        );
      }
    } else if (grew.length > 0) {
      if (popAfter <= popBefore) {
        problems.push(
          `${label} has a CityGrew event but its population went ${String(popBefore)} -> ` +
            String(popAfter),
        );
      }
    } else if (popAfter !== popBefore) {
      problems.push(
        `${label}'s population moved ${String(popBefore)} -> ${String(popAfter)} with no ` +
          `CityGrew/CityStarved event; only the growth pass changes a population`,
      );
    }

    if (!ran) {
      if (boxAfter !== boxBefore) {
        problems.push(
          `${label}'s food box moved ${String(boxBefore)} -> ${String(boxAfter)}, but this ` +
            `transition carries no IncomeCollected line, so no turn pipeline ran: a command ` +
            `never moves a food box`,
        );
      }
      continue;
    }

    if (starved.length > 0 || !thresholdRecoverable(ctx, cityAfter)) continue;

    const requirement = (population: number): number =>
      growthRequirement(ctx.rulesetView, cityAfter, population);
    const readings = surplusReadings(ctx, cityBefore, cityAfter, requirement);
    const reconciled = readings.some(
      (reading) =>
        reading.step.population === popAfter &&
        reading.step.foodBox === boxAfter &&
        reading.step.grew === grew.length > 0,
    );
    if (!reconciled) {
      const tried = readings
        .map(
          (reading) =>
            `${reading.label} (surplus ${String(reading.surplus)} -> population ` +
            `${String(reading.step.population)}, box ${String(reading.step.foodBox)})`,
        )
        .join('; ');
      problems.push(
        `${label}: food bookkeeping — population ${String(popBefore)} -> ${String(popAfter)} with ` +
          `the box ${String(boxBefore)} -> ${String(boxAfter)}, which no reading of the city's ` +
          `surplus explains. ${tried || 'no reading could be computed'}`,
      );
    }
  }

  return problems;
};

/**
 * `city-shield-conservation` — a city's stored shields moved by exactly what it
 * produced, less exactly what it paid for a completion.
 *
 * Lifted from `m3-adversarial.test.ts`'s shield half, with the same substitutions the
 * food half makes: the shields a city produced are read from the after-state
 * (`production` runs after growth, so the city production saw is the city the state
 * has), and the item it paid for is named by its `CityProduced` event.
 *
 * Checked here, each against the entity it names:
 *
 * 1. **Event/state agreement** — a `CityProduced` event's remaining shields are the
 *    city's stored shields, and at most one completion happens per city per turn.
 * 2. **The charge** — the pool after the charge is the pool before plus production,
 *    less the item's price, brackets included (see below).
 * 3. **Affordability** — an item that completed could pay for itself.
 * 4. **The completion's own consequence** — a completed building joined the city
 *    (unless the owner was bankrupt, which is the one way a building leaves a city the
 *    same turn), or a completed unit appeared at full movement on the tile its event
 *    names (or was disbanded by the same turn's money step, which M4c makes reachable).
 * 5. **No silent stall** — a city whose pool covered a startable head, with nothing
 *    able to stop the completion, must show one.
 *
 * The **bracket** is the one place this check is not an equality, and it is stated
 * rather than hidden. Production runs after growth, so the assignment and population
 * are the state's — but the *buildings* can differ, because a `shield-multiplier`
 * building completed this very turn joined the city after its production was counted,
 * and a bankrupt player's buildings are demolished after production. So the shield
 * yield is read twice: with the after-state's buildings (an upper bound, since
 * multipliers are non-negative percentages) and with the building completed this turn
 * taken out (a lower bound). With no completion and no bankruptcy the two coincide and
 * the check is exact; with a bankruptcy only the lower side is claimed, because
 * demolition makes the true value unbounded above.
 */
const cityShieldConservation = (ctx: InvariantContext): readonly string[] => {
  const previous = ctx.previous;
  if (previous === undefined) return [];

  const problems: string[] = [];
  const ran = turnRan(ctx);

  for (const cityBefore of previous.cities) {
    const id: CityId = cityBefore.id;
    const cityAfter = ctx.state.cities.find((city) => city.id === id);
    if (cityAfter === undefined) continue; // `city-food-conservation` reports the loss.

    const label = `city ${String(id)} (${cityAfter.name})`;
    const shieldsBefore = wholeNumber(cityBefore.shields);
    if (shieldsBefore === undefined) {
      problems.push(
        `${label}: the previous state's shields ${String(cityBefore.shields)} are not a whole ` +
          `number, so this transition's production bookkeeping cannot be reconciled`,
      );
      continue;
    }
    if (wholeNumber(cityAfter.shields) === undefined) {
      // Reported by `city-shields-non-negative`; the arithmetic below would only
      // restate it with a worse message.
      continue;
    }

    if (!ran) {
      if (cityAfter.shields !== shieldsBefore) {
        problems.push(
          `${label}'s shields moved ${String(shieldsBefore)} -> ${String(cityAfter.shields)}, but ` +
            `this transition carries no IncomeCollected line, so no turn pipeline ran: a command ` +
            `never banks shields`,
        );
      }
      continue;
    }

    const completions = producedEvents(ctx.events).filter((event) => event.cityId === id);
    if (completions.length > 1) {
      problems.push(
        `${label} completed ${String(completions.length)} items in one turn; the production pass ` +
          `settles one per city per turn`,
      );
    }
    const completion = completions[0];
    const bankrupt = shortfallEvents(ctx.events).some(
      (event) => event.playerId === cityAfter.owner,
    );

    const asIs = cityYields(ctx.state, ctx.rulesetView, id).shields;
    const completedBuilding =
      completion !== undefined && completion.item.kind === 'building'
        ? completion.item.id
        : undefined;
    const trimmed =
      completedBuilding !== undefined && cityAfter.buildings.includes(completedBuilding)
        ? cityYields(
            withCity(ctx.state, {
              ...cityAfter,
              buildings: cityAfter.buildings.filter((held) => held !== completedBuilding),
            }),
            ctx.rulesetView,
            id,
          ).shields
        : asIs;

    const low = shieldsBefore + Math.min(asIs, trimmed);
    const high = bankrupt ? undefined : shieldsBefore + Math.max(asIs, trimmed);
    const pool =
      high === undefined
        ? `${String(low)} or more`
        : high === low
          ? String(low)
          : `${String(low)} to ${String(high)}`;

    if (completion !== undefined) {
      const cost = itemCost(ctx.rulesetView, completion.item);
      if (cost <= 0) {
        problems.push(
          `${label} completed ${describeItem(completion.item)}, which this ruleset prices at ` +
            `${String(cost)} shields; an item with no price is not something a city can be charged for`,
        );
      }
      if (completion.shields !== cityAfter.shields) {
        problems.push(
          `${label}: its CityProduced event reports ${String(completion.shields)} shields left, but ` +
            `the city has ${String(cityAfter.shields)}`,
        );
      }
      if (high !== undefined && cost > high) {
        problems.push(
          `${label} completed ${describeItem(completion.item)} for ${String(cost)} shields with at ` +
            `most ${String(high)} in its pool`,
        );
      }
      if (
        cityAfter.shields + cost < low ||
        (high !== undefined && cityAfter.shields + cost > high)
      ) {
        problems.push(
          `${label}: after paying ${String(cost)} for ${describeItem(completion.item)} the city ` +
            `holds ${String(cityAfter.shields)} shields; the pool it came from was ${pool}, so the ` +
            `charge does not reconcile`,
        );
      }
      problems.push(...completionConsequences(ctx, cityAfter, completion));
      continue;
    }

    if (cityAfter.shields < low || (high !== undefined && cityAfter.shields > high)) {
      problems.push(
        `${label}: banked ${String(cityAfter.shields)} shields where production adds ` +
          `${String(low - shieldsBefore)}${high === undefined ? ' or more' : ` to ${String(high - shieldsBefore)}`} ` +
          `to the ${String(shieldsBefore)} it had, and nothing was completed`,
      );
    }
    problems.push(...unfinishedProduction(ctx, cityAfter, low));
  }

  return problems;
};

/**
 * What a completion must have left behind, read off the item it names.
 *
 * The building half allows one exception and names it: a building completed and then
 * demolished by the same turn's money step is gone from the city even though it was
 * really built (`TreasuryShortfall` is the line that says the owner was bankrupt).
 * The unit half follows the M3 check, including M4c's reachable case where the money
 * step disbands the unit production had just spawned.
 */
const completionConsequences = (
  ctx: InvariantContext,
  cityAfter: City,
  completion: Extract<GameEvent, { type: 'CityProduced' }>,
): readonly string[] => {
  const label = `city ${String(cityAfter.id)} (${cityAfter.name})`;
  const problems: string[] = [];

  if (completion.item.kind === 'building') {
    const bankrupt = shortfallEvents(ctx.events).some(
      (event) => event.playerId === cityAfter.owner,
    );
    if (!cityAfter.buildings.includes(completion.item.id) && !bankrupt) {
      problems.push(
        `${label} completed ${describeItem(completion.item)} and the city does not hold it, while ` +
          `its owner was not bankrupt (the one way a building leaves a city in the same turn)`,
      );
    }
    return problems;
  }

  const unitId = completion.unitId;
  if (unitId === undefined) {
    problems.push(
      `${label} completed ${describeItem(completion.item)} without naming the unit it appeared on`,
    );
    return problems;
  }

  const spawned = unitById(ctx.state, unitId);
  if (spawned === undefined) {
    const disbanded = disbandEvents(ctx.events).find((event) => event.unitId === unitId);
    if (disbanded === undefined) {
      problems.push(
        `${label} completed ${describeItem(completion.item)} as unit ${String(unitId)}, which is ` +
          `in neither the state nor a UnitDisbanded event of the same turn`,
      );
      return problems;
    }
    if (disbanded.playerId !== cityAfter.owner) {
      problems.push(
        `unit ${String(unitId)} was disbanded for player ${String(disbanded.playerId)} but was ` +
          `produced by ${label}`,
      );
    }
    if (disbanded.unitType !== completion.item.id) {
      problems.push(
        `unit ${String(unitId)} was disbanded as ${String(disbanded.unitType)}, not the ` +
          `${String(completion.item.id)} ${label} built`,
      );
    }
    return problems;
  }

  problems.push(...spawnedUnitProblems(ctx, cityAfter, completion, spawned));
  return problems;
};

/** Where a just-produced unit must be, and how much movement it must have. */
const spawnedUnitProblems = (
  ctx: InvariantContext,
  cityAfter: City,
  completion: Extract<GameEvent, { type: 'CityProduced' }>,
  spawned: Unit,
): readonly string[] => {
  const label = `city ${String(cityAfter.id)} (${cityAfter.name})`;
  const problems: string[] = [];

  if (spawned.owner !== cityAfter.owner) {
    problems.push(
      `unit ${String(spawned.id)}, produced by ${label}, belongs to player ` +
        String(spawned.owner),
    );
  }
  if (completion.tile !== undefined && spawned.tile !== completion.tile) {
    problems.push(
      `unit ${String(spawned.id)} stands on tile ${String(spawned.tile)}, not the tile ` +
        String(completion.tile) +
        ' its CityProduced event names',
    );
  }
  const def = unitDef(ctx.rulesetView, spawned.type);
  if (def !== undefined && spawned.movementLeft !== def.movement) {
    problems.push(
      `unit ${String(spawned.id)} was produced with ${String(spawned.movementLeft)} movement ` +
        `instead of its full ${String(def.movement)}`,
    );
  }
  return problems;
};

/**
 * Is a completion that did not happen *explainable*?
 *
 * A city whose pool covers its head has three ways to end the turn without a
 * `CityProduced` event, and each is checked here so that "it should have completed" is
 * only claimed when nothing could have stopped it:
 *
 * - the entry was **dropped** because the rules no longer allow it — the city already
 *   holds it, or it is a wonder another city holds (`production.ts` banks the shields,
 *   charges nothing and consumes the entry, with no event of its own). Reachable only
 *   when some city anywhere holds a building, which is the conservative test used here;
 * - the item is a **unit with nowhere to stand** — the centre and all eight neighbours
 *   hold an enemy unit (`production.ts`'s `placementTile`), which this mirrors;
 * - the head is simply **not startable** (the city holds it, or a wonder is held
 *   elsewhere), in which case production drops it rather than completing it.
 */
const unfinishedProduction = (
  ctx: InvariantContext,
  cityAfter: City,
  poolLow: number,
): readonly string[] => {
  const label = `city ${String(cityAfter.id)} (${cityAfter.name})`;
  const head = cityAfter.production;
  if (head === undefined) return [];

  const cost = itemCost(ctx.rulesetView, head);
  if (cost <= 0 || poolLow < cost) return [];

  if (head.kind === 'building') {
    if (cityAfter.buildings.includes(head.id)) return [];
    if (isWonderRow(ctx.rulesetView, head.id)) {
      const heldElsewhere = ctx.state.cities.some(
        (city) => city.id !== cityAfter.id && city.buildings.includes(head.id),
      );
      if (heldElsewhere) return [];
    }
  }

  const droppable =
    cityAfter.buildings.length > 0 ||
    ctx.state.cities.some((city) => city.buildings.some((id) => isWonderRow(ctx.rulesetView, id)));
  if (droppable) return [];

  if (head.kind === 'unit' && placementBlocked(ctx.state, cityAfter)) return [];

  return [
    `${label} had at least ${String(poolLow)} shields against a cost of ${String(cost)} for ` +
      `${describeItem(head)}, nothing could have stopped the completion, and no CityProduced ` +
      `event names it`,
  ];
};

/**
 * Is there nowhere for a produced unit to stand? `production.ts` places one on the
 * city centre, or on the first adjacent tile holding no unit of another player, and
 * leaves the item unfinished when every one of those tiles is blocked. This mirrors
 * that rule so the check does not claim a completion the rules never owed.
 */
const placementBlocked = (state: GameState, city: City): boolean => {
  const blocked = (tile: TileIndex): boolean =>
    unitsOnTile(state, tile).some((unit) => unit.owner !== city.owner);
  if (!blocked(city.tile)) return false;
  return neighbors8(state.map, city.tile).every(blocked);
};

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * Every core invariant, shape first and transitions last.
 *
 * The order is documentary, not a dependency: each check is independent, so a
 * violation report reads in the order a reviewer would ask the questions — is the
 * state well formed, then did this turn keep its books. A caller may run any subset
 * (a UI might run the shape half on every command), and a caller may add its own
 * invariants beside these for a milestone-specific rule (tech costs, happiness).
 */
export const CORE_INVARIANTS: readonly Invariant[] = [
  {
    name: 'treasury-non-negative',
    description: 'A treasury is never negative; a shortfall floors it at 0.',
    check: treasuryNonNegative,
  },
  {
    name: 'pools-non-negative',
    description: 'Beakers and luxuries only accumulate, so they are never negative.',
    check: poolsNonNegative,
  },
  {
    name: 'player-pools-integral',
    description: 'Every money pool is a whole number (integer-only simulation arithmetic).',
    check: playerPoolsIntegral,
  },
  {
    name: 'city-population-at-least-one',
    description: 'A city always has at least one citizen, counted in whole numbers.',
    check: cityPopulationAtLeastOne,
  },
  {
    name: 'city-food-box-within-threshold',
    description:
      'A food box is below the bare growth curve, and below its own reduced threshold ' +
      'unless a growth-food building completed this turn.',
    check: cityFoodBoxWithinThreshold,
  },
  {
    name: 'city-shields-non-negative',
    description: 'Stored production is a whole, non-negative count of shields.',
    check: cityShieldsNonNegative,
  },
  {
    name: 'city-works-at-most-its-citizens',
    description: 'A city never works more tiles than it has citizens.',
    check: cityWorksAtMostItsCitizens,
  },
  {
    name: 'tile-worked-by-one-city',
    description: 'No tile is worked by two cities, and no city lists one twice.',
    check: tileWorkedByOneCity,
  },
  {
    name: 'worked-tile-in-city-radius',
    description: "Every worked tile is inside its city's radius and is not the centre.",
    check: workedTileInCityRadius,
  },
  {
    name: 'city-ids-unique-and-sorted',
    description: 'City ids are unique and sorted ascending, as the hashed shape requires.',
    check: cityIdsUniqueAndSorted,
  },
  {
    name: 'city-tile-unique',
    description: 'No two cities stand on the same tile.',
    check: cityTileUnique,
  },
  {
    name: 'unit-ids-unique-and-sorted',
    description: 'Unit ids are unique and sorted ascending, as the hashed shape requires.',
    check: unitIdsUniqueAndSorted,
  },
  {
    name: 'unit-tile-in-bounds',
    description: 'Every unit stands on a tile of the map.',
    check: unitTileInBounds,
  },
  {
    name: 'unit-owner-exists',
    description: 'Every unit is owned by a player the state contains.',
    check: unitOwnerExists,
  },
  {
    name: 'unit-movement-in-range',
    description: "A unit's remaining movement is a whole number within its own maximum.",
    check: unitMovementInRange,
  },
  {
    name: 'improvements-sorted-and-unique',
    description: 'The improvement pair list is sorted by (tile, kind) and free of duplicates.',
    check: improvementsSortedAndUnique,
  },
  {
    name: 'resources-sorted-and-unique',
    description: 'The resource pair list is sorted by (tile, resource), unique, one per tile.',
    check: resourcesSortedAndUnique,
  },
  {
    name: 'wonder-held-by-one-city',
    description: 'A wonder is held by at most one city in the world.',
    check: wonderHeldByOneCity,
  },
  {
    name: 'gold-conservation',
    description: "Gold moved by exactly the money loop's income, upkeep and shortfall ledger.",
    check: goldConservation,
  },
  {
    name: 'city-food-conservation',
    description: "A city's population and food box moved exactly as the growth rule says.",
    check: cityFoodConservation,
  },
  {
    name: 'city-shield-conservation',
    description: "A city's shields moved by what it produced, less what it completed.",
    check: cityShieldConservation,
  },
];

/* ------------------------------------------------------------------ *
 * Running a registry
 * ------------------------------------------------------------------ */

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'a non-Error value was thrown';

/**
 * One check, run so that it cannot throw.
 *
 * The contract says an invariant returns violations and does not throw, so that a run
 * reports every broken property rather than dying on the first. Each check above
 * already reads defensively, and this is the belt to that pair of braces: a state this
 * engine could not have built still produces a *violation string* naming the check and
 * what it tripped over, instead of an exception escaping into a simulation loop that
 * has nowhere to put it.
 */
const guarded = (invariant: Invariant, ctx: InvariantContext): readonly string[] => {
  try {
    return invariant.check(ctx);
  } catch (error) {
    return [
      `${invariant.name} threw instead of returning violations: ${describeError(error)} — a ` +
        `corrupt state must produce a violation, not an exception`,
    ];
  }
};

/**
 * Run a registry against one context, turning its strings into `Violation` records.
 *
 * The one place the name/turn pairing is written, so every consumer — the simulation
 * loop, a test, a report — produces violations the same way and none of them can
 * invent a shape the others cannot read.
 */
export const checkInvariants = (
  ctx: InvariantContext,
  invariants: readonly Invariant[] = CORE_INVARIANTS,
): readonly Violation[] =>
  invariants.flatMap((invariant) =>
    guarded(invariant, ctx).map((message) => ({
      invariant: invariant.name,
      turn: ctx.turn,
      message,
    })),
  );
