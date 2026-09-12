/**
 * Barbarians — **engine behaviour, not a policy** (docs/INTERFACES.md, M6,
 * "Barbarians are ENGINE behaviour, not a policy"; PLAN.md §5.3 determinism).
 *
 * `sim` policies exist for civilizations. The barbarian player has none, is never
 * polled, and is driven from inside `advanceTurn` by the step this module owns: the
 * one place that decides what a barbarian band does with its turn. Everything here is
 * deterministic from the state alone; nothing reads a clock, an ambient random source
 * or a policy's RNG stream.
 *
 * ## The rules, each stated once
 *
 * 1. **It attacks when it can.** For each barbarian unit, in **unit-id order**, the 8
 *    adjacent tiles are asked of `planAttackUnit` — the *same* evaluator `applyCommand`
 *    refuses with and `actions.ts` advertises with — in **ascending tile index** order,
 *    and the first target that evaluator accepts is attacked. Attacking an enemy unit
 *    resolves a battle; attacking an undefended enemy city captures it. Both are
 *    applied through `applyCommand`, so a barbarian's battle is *literally* the same
 *    code path a civilization's battle is: there is no second combat implementation
 *    here, and none of the odds, modifiers, tie rule or damage rules are restated
 *    (`combat.ts` owns them; `commands.ts` owns what an attack does).
 *    "When it can" means exactly "when the applier's own evaluator accepts": a tile
 *    holding more than one enemy unit is `target-stacked` and is therefore *not* a
 *    target — the engine does not choose a victim out of a stack for anybody.
 * 2. **Otherwise it moves toward the nearest civilization city**, breaking ties by
 *    **ascending tile index** — the same tie-break, stated once in
 *    `nearestCivCityTile`. "Nearest" is the engine's own metric, Chebyshev distance
 *    (`distance8`). The comparison is *total* over the cities (distance first, then
 *    tile index), so the answer cannot depend on the order `state.cities` happens to
 *    be in, on map iteration order, or on catalog row order. The step itself is then
 *    the first legal one along a walkable route to that city
 *    (`barbarianApproachField` + `barbarianStepTile`), which is what makes a band
 *    approach a city that a hill range or a lake sits between it and. A step that is
 *    unaffordable *this turn* is skipped in favour of the next-best one, so a band
 *    never idles against a tile it cannot pay for while a legal step exists.
 *    **It spends its movement doing so**: it keeps stepping while a legal step toward
 *    the city remains, and it attacks the instant it can — an attack costs the rest of
 *    the unit's turn, exactly as it does for a civilization — so a two-movement band
 *    covers two tiles a turn and a one-movement warrior one, which is the same budget
 *    the refill hands every other unit.
 * 3. **What barbarians never do**, and where each of those facts lives:
 *    - *never research*: `tech.ts`' `applyResearch` skips every player whose
 *      `kind !== 'civ'`, and this module never touches `techs`, `researching`,
 *      `beakers` or `luxuries`.
 *    - *never build*: production runs for every city, and a barbarian-owned city can
 *      only ever be a **captured** one — `cities.ts`' `captureCity` clears its
 *      production head and its queue, and no policy is ever polled for the barbarian
 *      player, so nothing orders a new item. (`production.ts` states the same thing
 *      from its side.) `barbarians.test.ts` pins it over a long run.
 *    - *never receive gold*: `economy.ts`' `applyEconomy` skips the barbarian player
 *      entirely, so no income is collected, no upkeep is paid and no unit is
 *      disbanded for bankruptcy. This module never writes a treasury.
 *    - *never benefit from another player's roads*: in this engine roads do not affect
 *      movement at all — a step costs the **destination terrain's** `moveCost`
 *      (`planMove`), and an improvement's road kind is read only by `resources.ts`
 *      for connectivity. A barbarian therefore pays the terrain price on a tiled or
 *      roaded tile exactly as it would on bare ground, and so does everyone else;
 *      `barbarians.test.ts` measures the barbarian half of that.
 * 4. **The only randomness is combat's**, and it is drawn from `state.rng` by
 *    `applyCommand` → `combat.ts`. This module has no RNG of its own: the target
 *    choice, the step choice and the unit order are all functions of the state
 *    (ids, tiles, distances), never of a draw. Add a draw here and a barbarian's
 *    decision stops being reproducible from the seed — so there is nothing to add:
 *    if a rule needs one, it belongs in the state's stream, not in a policy's.
 * 5. **The step's position in the pipeline is contractual**: after the money loop,
 *    before the movement refill. `turn.ts` states it and argues both halves; this
 *    module only has to be the step.
 *
 * ## `revision` is not touched, and that is deliberate
 *
 * `revision` counts **applied commands** (M2 invariant 2), and advancing a turn is one
 * step of one command: `applyCommand` bumps it exactly once, in the `EndTurn` case.
 * The barbarian step is the *engine's* behaviour — nobody issued a command — so it
 * hands the state back with the revision it was given, even though each action it
 * takes is applied by `applyCommand` (which bumps a counter this step then puts back).
 * That keeps two properties true at once: `advanceTurn` still never touches
 * `revision`, and a barbarian's battle is still applied by the one applier.
 *
 * ## Why the edge to `commands.ts` is a runtime edge, and why that is safe
 *
 * Every other step of the pipeline imports `GameEvent` from `commands.ts` **type-only**,
 * precisely so that `commands.ts → turn.ts` has no way back. This module cannot do
 * that: "the same combat path" means calling `applyCommand`, so the pair becomes
 * `commands.ts → turn.ts → barbarians.ts → commands.ts`. It is safe because the cycle
 * is only ever entered *at call time*: `barbarians.ts` reads `applyCommand`,
 * `planAttackUnit` and `planMove` inside function bodies and never at module
 * evaluation, so ESM's live bindings are initialised long before the first call, from
 * either direction. The alternative — resolving the battle here out of `resolveCombat`
 * and `woundUnit` — is a second combat implementation, which is the one thing M6 says
 * combat must not have.
 *
 * ## Provenance — placeholder, all of it
 *
 * This module introduces no numbers: no radius, no probability, no count. What it
 * introduces are *rules*, and they are ours: reading the contract's "the nearest known
 * (to it) civilization city" as "a band knows where the civilizations' cities are",
 * taking exactly one step per turn, and treating a tile the unit could not re-enter as
 * a tile it may still leave. See `BARBARIAN_PROVENANCE`: unsourced, chosen to be
 * playable, and **not** presented as Civ 3's.
 */

import {
  applyCommand,
  planAttackUnit,
  planMove,
  type Command,
  type GameEvent,
} from './commands.js';
import { asTileIndex, type PlayerId, type TileIndex } from './ids.js';
import { distance8, neighbors8, terrainAtIndex, type RulesetView } from './map.js';
import { placeholder, type Provenance } from './provenance.js';
import type { GameState, PlayerState } from './state.js';
import { unitById, unitDef, type Unit } from './units.js';

/**
 * What this module's rules claim, in the project's provenance vocabulary. **Every one
 * of them is ours**, unsourced and chosen to be playable:
 *
 * - the reading of "the nearest **known (to it)** civilization city" as "a band knows
 *   where every civilization's cities are". This is a real judgement rather than a
 *   detail: a band spawned by a goody hut begins with an **empty explored row** (M3
 *   gives barbarians no fog memory, and nothing folds it for them before they move),
 *   and nothing renders a barbarian's map — so a strict fog reading would leave a hut
 *   band with no target at all and M6's barbarians would never approach anything,
 *   which is the one thing this step exists to do. The alternative — restricting
 *   targets to what the band can see — is a *different rule* and a later milestone's
 *   call, not a number to tune; `nearestCivCityTile` is the single place it would be
 *   changed.
 * - the "spend your movement, along a walkable route" tactics — a band steps while it
 *   has movement and a legal step toward its city, and attacks the moment it can — and
 *   the departure rule for a tile a unit could not re-enter (a band standing on a hill
 *   can walk down it).
 *
 * Civ 3's real barbarian behaviour — how far a band wanders, how likely it is to
 * appear, whether it beelines for a city at all — is unverified here and is **not**
 * what this module implements.
 */
export const BARBARIAN_PROVENANCE: Provenance = placeholder(
  "Unsourced placeholder rules, chosen to be playable, NOT traced to Civ 3: M6's barbarian " +
    'behaviour is our own. (1) "the nearest known (to it) city" is read as "a band knows where ' +
    'every civilization\'s cities are" — a hut band starts with an empty explored row and has no ' +
    'way to learn, so a strict fog reading would make it inert. (2) A band spends its movement on ' +
    'that route: it steps while it has movement and a legal step toward that city, and it attacks ' +
    'the moment it can. (3) A tile a unit could not re-enter (a hill ' +
    "for a one-movement unit) may still be left. Civ 3's actual barbarian distances, spawn rates " +
    'and targeting are unverified here and are not what this implements.',
);

/**
 * The barbarian player of `state`, or `undefined` for a state that has none (a
 * hand-built one). "There is one of them", so the first player of that kind is *the*
 * barbarian player — the same reading `hut.ts` takes with its own private copy of this
 * one-liner, because a hut band needs an owner and `state.players` is where an owner
 * comes from.
 */
export const barbarianPlayer = (state: GameState): PlayerState | undefined =>
  state.players.find((player) => player.kind === 'barbarian');

/**
 * Is `owner` a civilization in this state? A barbarian-owned city is not a target for
 * the barbarians (they do not raid themselves), and an owner id `state.players` does
 * not hold is *not* assumed to be a civilization — the honest answer for a city whose
 * owner the state cannot name is "no", the same reading `resources.ts` takes of a
 * player it cannot find.
 */
const isCivOwner = (state: GameState, owner: PlayerId): boolean =>
  state.players.some((player) => player.id === owner && player.kind === 'civ');

/** Tile indices in ascending order — the order every tie-break in this file uses. */
const ascendingTiles = (tiles: readonly TileIndex[]): readonly TileIndex[] =>
  [...tiles].sort((a, b) => Number(a) - Number(b));

/**
 * The civilization city a barbarian band on `from` sets out for: the **nearest** one by
 * the engine's own distance metric (`distance8`, Chebyshev), ties broken by **ascending
 * tile index**. `undefined` when the state holds no civilization city at all (or when
 * `from` is not a whole tile index).
 *
 * The comparison below is *total* — distance first, then tile index — so the answer is
 * a property of the set of cities and not of the order they are stored in. That is the
 * contract's "never by map iteration order" applied to the one place it could leak in:
 * a loop that kept the *first* city with the smallest distance would give a different
 * answer for the same world when `state.cities` came back in another order (the M5
 * finding about catalog row order, in its city-list form). Two distinct cities cannot
 * tie on both keys — a city's tile is its identity — so no third key is needed.
 */
export const nearestCivCityTile = (state: GameState, from: TileIndex): TileIndex | undefined => {
  const origin = Number(from);
  if (!Number.isInteger(origin)) return undefined;

  let best: number | undefined;
  let bestDistance = 0;

  for (const city of state.cities) {
    if (!isCivOwner(state, city.owner)) continue;

    const tile = Number(city.tile);
    if (!Number.isInteger(tile)) continue;

    const distance = distance8(state.map, origin, tile);
    if (
      best === undefined ||
      distance < bestDistance ||
      (distance === bestDistance && tile < best)
    ) {
      best = tile;
      bestDistance = distance;
    }
  }

  return best === undefined ? undefined : asTileIndex(best);
};

/**
 * The movement a barbarian unit may spend on **one step**: its type's `movement`, which
 * is exactly the budget the refill hands it every turn, and therefore the largest
 * single-tile cost it can ever pay.
 *
 * A type the ruleset cannot resolve (a hand-built or foreign state) falls back to the
 * unit's own `movementLeft`, then to zero: the same totality the refill and the work
 * step take, and for the same reason — there is no honest number for a type nothing
 * describes, so the step must degrade to "it cannot enter anything it could not
 * afford" rather than to a guess. It is *not* a restatement of movement legality
 * (`planMove` still decides that); it is the bound the route search may plan inside, so
 * that the route it finds is one the unit can actually walk.
 */
export const barbarianStepBudget = (ruleset: RulesetView, unit: Unit): number => {
  const declared = unitDef(ruleset, unit.type)?.movement;
  if (declared !== undefined && Number.isInteger(declared) && declared > 0) return declared;

  const left = unit.movementLeft;
  return Number.isInteger(left) && left > 0 ? left : 0;
};

/**
 * Could this unit enter `tile` at full movement? Terrain the ruleset does not describe,
 * impassable terrain, and terrain whose cost is above the unit's whole budget are all
 * "no" — the last one because a unit whose `movement` is 1 can never enter a cost-2
 * tile (the refill never gives it more), so a route over one is a route it cannot walk
 * and planning through it would wedge the band on it.
 *
 * A cost the catalog declares as anything but a whole non-negative number is refused
 * here rather than trusted: this reads a foreign view as well as the shipped catalog.
 */
const enterable = (
  state: GameState,
  ruleset: RulesetView,
  tile: number,
  budget: number,
): boolean => {
  const id = terrainAtIndex(state.map, tile);
  if (id === undefined) return false;

  const row = ruleset.terrains.find((terrain) => terrain.id === id);
  if (row === undefined || row.impassable) return false;

  return Number.isInteger(row.moveCost) && row.moveCost >= 0 && row.moveCost <= budget;
};

/**
 * How many **walkable** steps each tile is from `target`, for a unit standing on
 * `unit.tile`: a breadth-first distance field, 8-way, over the tiles the unit could
 * enter (`enterable`, at the budget `barbarianStepBudget` gives it).
 *
 * Two statements are worth making rather than leaving to the reader:
 *
 * - **The unit's own tile counts as walkable even when it is not.** A band may stand on
 *   a tile it could not re-enter — a goody hut's band is placed on standable land and a
 *   hill is standable, while a one-movement warrior can never pay a hill's cost of 2 —
 *   and "I may leave where I am" is a departure rule, not an entry rule. Without this
 *   clause such a band would find itself outside the field entirely and stand there
 *   forever, which is reachable from shipped content, not only from a hand-built state.
 * - **The city's own tile is the source whether or not it is enterable** (a city on
 *   hills is exactly that). Steps are only ever taken onto a tile with a *smaller*
 *   value, so the source's own cost never enters a decision.
 *
 * Neighbours are visited in ascending tile index order. BFS distances on an unweighted
 * graph do not depend on visit order, so this is a reading aid rather than a rule; the
 * rules that *do* depend on order — which city, which step — compare tile indices
 * explicitly.
 */
export const barbarianApproachField = (
  state: GameState,
  ruleset: RulesetView,
  unit: Unit,
  target: TileIndex,
): ReadonlyMap<number, number> => {
  const distance = new Map<number, number>();

  const source = Number(target);
  if (!Number.isInteger(source)) return distance;

  const standing = Number(unit.tile);
  const budget = barbarianStepBudget(ruleset, unit);

  distance.set(source, 0);
  const queue: number[] = [source];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;

    const reached = distance.get(current);
    if (reached === undefined) continue;

    for (const neighbour of ascendingTiles(neighbors8(state.map, current))) {
      const index = Number(neighbour);
      if (distance.has(index)) continue;
      if (index !== standing && !enterable(state, ruleset, index, budget)) continue;

      distance.set(index, reached + 1);
      queue.push(index);
    }
  }

  return distance;
};

/**
 * The tile a barbarian band on `unit.tile` steps onto this turn, on its way to
 * `target`: **the legal step with the smallest field value, ties broken by ascending
 * tile index** — and `undefined` when there is none, which is the honest answer for a
 * band that has arrived (its field value is 0... it is standing on the city, which only
 * a capture could produce), is walled off from the target (no walkable route exists), or
 * cannot pay for the step the route asks of it this turn.
 *
 * "Legal" is `planMove` — the same evaluator `applyCommand` refuses with, so a tile this
 * function returns is a tile the applier accepts, and the two cannot disagree about what
 * a step costs or where a unit may go. A candidate that is unaffordable *this turn* is
 * simply skipped in favour of the next-best one, so a band with movement to spare never
 * idles against a costlier tile it cannot pay for.
 *
 * The candidate walk is over `neighbors8` in ascending order, keeping a value only when
 * it is **strictly smaller** than the best so far: the first candidate at the minimum
 * value therefore wins, which is the ascending-index tie-break and not an accident of
 * the comparison.
 */
export const barbarianStepTile = (
  state: GameState,
  ruleset: RulesetView,
  unit: Unit,
  target: TileIndex,
): TileIndex | undefined => {
  const standing = Number(unit.tile);
  if (!Number.isInteger(standing)) return undefined;

  const field = barbarianApproachField(state, ruleset, unit, target);
  const here = field.get(standing);
  if (here === undefined) return undefined;

  let best: number | undefined;
  let bestValue = here;

  for (const neighbour of ascendingTiles(neighbors8(state.map, standing))) {
    const index = Number(neighbour);
    const value = field.get(index);
    if (value === undefined || value >= bestValue) continue;
    if (!planMove(state, ruleset, unit.owner, unit.id, neighbour).ok) continue;

    best = index;
    bestValue = value;
  }

  return best === undefined ? undefined : asTileIndex(best);
};

/**
 * The adjacent tile this barbarian attacks, or `undefined` when it has nothing to
 * attack: the first of the 8 neighbours, **in ascending tile index order**, that
 * `planAttackUnit` accepts.
 *
 * The evaluator is the applier's own, so "there is something to attack here" and "this
 * attack applies" are one rule asked once (M6's keystone invariant, eighth generator).
 * Order is tile index and nothing else — not `state.units` order, not the order enemies
 * happen to be stored in, and not catalog row order.
 */
export const barbarianAttackTarget = (
  state: GameState,
  ruleset: RulesetView,
  unit: Unit,
): TileIndex | undefined => {
  const standing = Number(unit.tile);
  if (!Number.isInteger(standing)) return undefined;

  for (const neighbour of ascendingTiles(neighbors8(state.map, standing))) {
    if (planAttackUnit(state, ruleset, unit.owner, unit.id, neighbour).ok) return neighbour;
  }

  return undefined;
};

/** What the barbarian step did: the world after it, and everything that happened. */
export interface BarbarianOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * Apply one engine-driven action through the command layer, and hand it back as a
 * **step** rather than as a command: the applier's own `revision` bump is put back, so
 * `advanceTurn` still never touches `revision` (see the module note).
 *
 * `undefined` means the applier refused — which, for a command this module built out of
 * the applier's own plan evaluators, cannot happen for a state the step just read. It is
 * still handled rather than thrown: a step of the turn pipeline has to be total, and a
 * refusal that somehow happened would leave the unit's turn simply unspent, not the
 * whole turn refused.
 */
const applyAsStep = (
  state: GameState,
  ruleset: RulesetView,
  actor: PlayerId,
  command: Command,
): BarbarianOutcome | undefined => {
  const outcome = applyCommand(state, actor, command, ruleset);
  if (!outcome.ok) return undefined;

  return {
    state: { ...outcome.value.state, revision: state.revision },
    events: outcome.value.events,
  };
};

/**
 * **The barbarian step of the turn pipeline**: every barbarian unit, in unit-id order,
 * attacks what it can and otherwise spends its movement stepping toward the nearest
 * civilization city. `turn.ts` calls this between the money loop and the movement
 * refill, and that position is contractual (see `turn.ts` for both halves of why).
 *
 * Reading the list once, up front, is the termination rule as well as the order rule: a
 * band a hut hands the barbarians *during* this step (a barbarian that walks onto a hut
 * resolves it like any other unit — `commands.ts` owns that, and no rule excludes
 * barbarians from it) is not in the list, so no unit acts twice and the step cannot run
 * away spawning more work for itself. Each unit is re-read from the world as it stands
 * before each of its own actions, so an earlier unit's battle cannot leave a later one
 * acting from a stale copy of itself.
 *
 * The per-unit loop is bounded by the unit's own step budget (`barbarianStepBudget`,
 * i.e. the movement the refill hands it): every step that matters in this engine costs
 * at least one point of it, so the bound is normally just "spend what you have" — and
 * it is what makes the loop *finite* on a foreign view that declares a free tile, where
 * "spend your movement" would otherwise mean "step forever".
 *
 * Nothing here is a policy: there is no decision to replace, and no RNG of the step's
 * own. The whole function is a pure function of `(state, ruleset)` — the same input
 * twice gives the same state and the same events, which is what makes a barbarian's
 * turn reproducible from the game seed.
 */
export const advanceBarbarians = (state: GameState, ruleset: RulesetView): BarbarianOutcome => {
  const barbarians = barbarianPlayer(state);
  if (barbarians === undefined) return { state, events: [] };

  // Unit-id order, sorted explicitly rather than trusting the array: `state.units` *is*
  // sorted by id on every state the engine built, and the contract's order has to hold
  // for a hand-built one too — exactly as `advanceWork` and `applyGrowth` sort.
  const inIdOrder = state.units
    .filter((unit) => unit.owner === barbarians.id)
    .map((unit) => unit.id)
    .sort((a, b) => Number(a) - Number(b));

  let current = state;
  const events: GameEvent[] = [];

  for (const unitId of inIdOrder) {
    const opening = unitById(current, unitId);
    if (opening === undefined) continue;

    let steps = barbarianStepBudget(ruleset, opening);

    while (steps > 0) {
      // Re-read the unit, and re-ask both rules, after every action: a step changes where
      // it stands and what is beside it, and a band that walks up to a city attacks it on
      // the same turn with the movement it has left — which is what "attacks ... when it
      // can" means for a unit that still has a turn to spend.
      const unit = unitById(current, unitId);
      if (unit === undefined) break;

      // Rule 1: attack what it can, where it can. An attack costs the rest of the unit's
      // movement (`AttackUnit`), so its turn is over either way.
      const attack = barbarianAttackTarget(current, ruleset, unit);
      if (attack !== undefined) {
        const applied = applyAsStep(current, ruleset, barbarians.id, {
          type: 'AttackUnit',
          unitId: unit.id,
          target: attack,
        });
        if (applied !== undefined) {
          current = applied.state;
          events.push(...applied.events);
        }
        break;
      }

      // Rule 2: otherwise one step toward the nearest civilization city.
      const target = nearestCivCityTile(current, unit.tile);
      if (target === undefined) break;

      const to = barbarianStepTile(current, ruleset, unit, target);
      if (to === undefined) break;

      const applied = applyAsStep(current, ruleset, barbarians.id, {
        type: 'MoveUnit',
        unitId: unit.id,
        to,
      });
      if (applied === undefined) break;

      current = applied.state;
      events.push(...applied.events);
      steps -= 1;
    }
  }

  return { state: current, events };
};
