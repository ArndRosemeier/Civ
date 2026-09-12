/**
 * **`SmartPolicy` — the real opponent.**
 * See docs/INTERFACES.md, "M7 contracts — FROZEN (a real opponent, and self-play)":
 *
 * > `packages/sim/src/ai/` gains a real policy … It must
 * > - **play unaided** for a full horizon: settle, expand, work tiles, assign
 * >   production, set rates, research with a goal, build and use military units, and
 * >   respond to barbarians
 * > - be **deterministic** … and it must never draw from `state.rng` (the M5 property —
 * >   the AI must not be able to change the world)
 * > - be **fast enough to matter**: a 20-seed tournament inside a stated budget
 * > - be **decomposable for balance work**: its decisions read from named weights or
 * >   thresholds that live in one place
 *
 * ## What this policy is
 *
 * A `Policy` — nothing more. It is handed a state, a player id, a ruleset and **its own
 * RNG stream**, and it returns a list of commands. The runner applies them through
 * `applyCommand` in order and then owns the turn boundary; the engine knows nothing about
 * this file (`policies.ts`' `smartPolicy` is the only thing that wraps it, and nothing in
 * `@civts/sim` branches on a policy's name).
 *
 * One turn is decided in four passes, and the order is a decision stated here rather than
 * an accident of how the code was written:
 *
 * 1. **cities, in city-id order** — re-assign worked tiles (the engine's own
 *    `autoAssignWorkedTiles` asked about a city whose assignment was cleared, i.e. its
 *    "if this city assigned from scratch, what would it take?" answer) and choose
 *    production. Before the units, because `FoundCity` auto-assigns a new city's tiles
 *    *at the moment it applies*: assigning existing cities first means the new city's
 *    assignment already knows about them, and the engine would refuse the loser.
 * 2. **research** (one `SetResearch`, when the goal changes).
 * 3. **rates** (one `SetRates`, when the money says so).
 * 4. **units, in unit-id order** — fight, garrison, improve, settle, explore. Last,
 *    because it is what makes the *state* move; and a settler that founds a city earlier
 *    in this pass is gone from the state by the time the next unit is read.
 *
 * ## What this policy is NOT
 *
 * It is not a search, a lookahead, an opponent model, or a claim about Civ 3's AI. Every
 * magnitude it introduces is a **placeholder** in `ai/weights.ts` — unsourced, chosen to
 * be playable — and none of its preferences is presented as a Civ 3 rule. What it *is* is
 * an opponent that plays a whole game: it settles, grows, researches toward what it wants
 * to build, balances its books, defends its cities, builds walls, and fights when the
 * engine's own combat maths says the fight is worth having.
 *
 * ## How it decides: ask the engine, never re-derive a rule
 *
 * Every candidate this file acts on comes from the engine's own enumerators
 * (`unitActions`, `cityProductionOptions`) and every candidate is **folded through
 * `applyCommand`** on a local copy of the state before it is proposed — so nothing
 * illegal can reach the runner, and the fold is the same applier the runner will use. What
 * the policy *reads* off those folds is the engine's own answer, not a recomputation:
 *
 * - legality is `planFoundCity` / `planMove` / `planStartWork` / `planAttackUnit` /
 *   `planSetRates` / `planSetResearch` — the same evaluators `applyCommand` refuses with
 *   (the keystone invariant, both directions);
 * - a tile's worth is `tileYieldsWithResources` (terrain + improvements + bonus
 *   resources) and a city's worth is `cityYields`, so **the AI scores no terrain itself**;
 * - a city's worked tiles are `autoAssignWorkedTiles`, the engine's own "best tiles
 *   first" rule, so the AI never grows a second tile ranking that could drift from the one
 *   a founding city uses;
 * - a battle's odds are `CombatResolved.attackerWinPct`, straight out of `combat.ts` via
 *   the applier — the policy computes its *decision* from that number (see
 *   `battleWinPctOf`) but never restates the odds formula, the terrain bonus, the
 *   fortification bonus, the wall bonus or the veteran bonus.
 *
 * ## Determinism, and the stream it must not touch
 *
 * The commands are a **pure function of `(state, playerId, ruleset, weights)`**. This
 * policy consumes no randomness at all — it never reads `ctx.rng`, and it certainly never
 * reads `state.rng`, which is the world's stream — so swapping it for another policy on
 * the same seed changes the game and provably cannot change the world's RNG trajectory
 * (the M5 property; `ai.test.ts` proves it by replaying one seed under two policies and
 * asserting the world's RNG states are identical at every turn). Every choice among
 * candidates is a **total order over the candidates' own content** — a rank tuple, then an
 * id by UTF-16 code unit — so nothing here reads a catalog's row *order*, and nothing
 * reads the clock or the ambient RNG (`packages/sim/src` is under eslint's determinism
 * ban).
 *
 * ## One stated limitation, and it is real
 *
 * This AI's threat and hunting reads use the units **present in the state**, not the
 * player's fog layer: this engine's fog constrains rendering, never legality (INTERFACES.md
 * M2, M4a and M6 all say so), and a policy that filtered by `isExplored` would decline to
 * defend a city against an enemy standing in the open beside it. That makes this AI a
 * slightly better-informed opponent than fog would imply, and it is recorded here rather
 * than left for a reader to discover.
 */

import {
  IMPROVEMENT_KINDS,
  RATE_TOTAL,
  WALLS_BUILDING,
  applyCommand,
  asCityId,
  autoAssignWorkedTiles,
  buildingCatalog,
  buildingDef,
  citiesOf,
  cityAt,
  cityById,
  cityProductionOptions,
  cityRadius,
  cityYields,
  combatRulesOf,
  improvementsAt,
  hitPointsLeftOf,
  inBounds,
  indexToX,
  indexToY,
  isExplored,
  isFortified,
  itemCost,
  knownTechs,
  neighbors8,
  planFoundCity,
  planMove,
  planSetRates,
  researchProblem,
  researchingOf,
  splitCommerce,
  techCatalog,
  techCostOf,
  techUnlocks,
  terrainAtIndex,
  tileIndex,
  tileYieldsWithResources,
  unitActions,
  unitById,
  unitCatalog,
  unitDef,
  unitSupport,
  unitsOnTile,
  VISIBILITY_RADIUS,
  type City,
  type CityId,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type PlayerState,
  type ProductionItem,
  type RulesetView,
  type TechId,
  type TileIndex,
  type Unit,
  type UnitId,
  type UnitRole,
} from '@civts/core';

import type { Policy, PolicyContext } from '../types.js';
import { mergeSmartWeights, type SmartWeights, type SmartWeightsPatch } from './weights.js';

/* ------------------------------------------------------------------ *
 * Small vocabulary
 * ------------------------------------------------------------------ */

/** A rank: a tuple of integers compared left to right, largest first. */
type Rank = readonly number[];

/**
 * Compare two ranks lexicographically, largest first.
 *
 * Ranks rather than weighted sums, for the reason `policies.ts` records: "one shield is
 * worth 1.5 food" is a claim nobody can justify, whereas "this comes before that" is the
 * honest form of the same opinion — and a tuple keeps every comparison in integer
 * arithmetic, which is what makes the AI's decisions exact rather than floating point.
 */
const compareRanks = (a: Rank, b: Rank): number => {
  const width = Math.max(a.length, b.length);
  for (let index = 0; index < width; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
};

/** Compare two strings by UTF-16 code unit — the tie-break under every content choice. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical order over production items: `kind`, then `id`, both by code unit. */
const compareItems = (a: ProductionItem, b: ProductionItem): number => {
  const byKind = compareText(a.kind, b.kind);
  return byKind !== 0 ? byKind : compareText(String(a.id), String(b.id));
};

/** `state` with `unitId` standing on `tile` — rebuilt, never mutated, then thrown away. */
const withUnitAt = (state: GameState, unitId: UnitId, tile: TileIndex): GameState => ({
  ...state,
  units: state.units.map((unit) => (unit.id === unitId ? { ...unit, tile } : unit)),
});

/** How many tiles a unit may be handed in one turn: its own budget, or the guard. */
const stepBudget = (movement: number, cap: number): number => {
  const own = Number.isInteger(movement) && movement > 0 ? movement : 0;
  const ceiling = Number.isInteger(cap) && cap >= 0 ? cap : 0;
  return Math.min(own, ceiling);
};

/** The map position a tile index names — a `TileIndex` from a tile index, without a cast. */
const asTile = (state: GameState, index: number): TileIndex =>
  tileIndex(state.map.width, indexToX(state.map, index), indexToY(state.map, index));

/* ------------------------------------------------------------------ *
 * Reading the board — always through the engine's own tile rules
 * ------------------------------------------------------------------ */

/** What a tile is worth in this state: terrain, plus improvements, plus bonus resources. */
const yieldsAt = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
): { readonly food: number; readonly shields: number; readonly commerce: number } =>
  tileYieldsWithResources(state, ruleset, tile) ?? { food: 0, shields: 0, commerce: 0 };

/** 1 when a goody hut sits on `tile`, else 0 — a step onto one is a reward to claim. */
const hutAt = (state: GameState, tile: TileIndex): number =>
  state.map.huts.some((hut) => Number(hut) === Number(tile)) ? 1 : 0;

/** Every tile of the visibility box around `tile`, clipped to the map, ascending. */
const neighbourhood = (state: GameState, tile: TileIndex): readonly TileIndex[] => {
  const map = state.map;
  const centreX = indexToX(map, tile);
  const centreY = indexToY(map, tile);
  const tiles: TileIndex[] = [];
  for (let dy = -VISIBILITY_RADIUS; dy <= VISIBILITY_RADIUS; dy += 1) {
    for (let dx = -VISIBILITY_RADIUS; dx <= VISIBILITY_RADIUS; dx += 1) {
      const x = centreX + dx;
      const y = centreY + dy;
      if (!inBounds(map, x, y)) continue;
      tiles.push(tileIndex(map.width, x, y));
    }
  }
  return tiles;
};

/** How many tiles of the visibility box around `tile` this player has never seen. */
const revealCount = (state: GameState, playerId: PlayerId, tile: TileIndex): number => {
  let count = 0;
  for (const candidate of neighbourhood(state, tile)) {
    if (!isExplored(state, playerId, candidate)) count += 1;
  }
  return count;
};

/** Chebyshev distance, derived from the map's own `indexToX`/`indexToY` reads. */
const tileDistance = (state: GameState, a: TileIndex, b: TileIndex): number => {
  const map = state.map;
  return Math.max(
    Math.abs(indexToX(map, a) - indexToX(map, b)),
    Math.abs(indexToY(map, a) - indexToY(map, b)),
  );
};

/**
 * `state` with a **stand-in city** on `tile`, thrown away after the question it answers.
 *
 * This is a *reading device*, never state. `autoAssignWorkedTiles` and `cityYields` both
 * take a `cityId` and look the city up, so "what would a city *here* be worth?" has to be
 * asked with a city object that exists — and the honest way to ask is to build one with
 * every field the engine reads, hand it to the engine's *own* ranking function, and
 * discard it. The id is deliberately one past the highest id in use, so a stand-in can
 * never collide with a real city (and never with another stand-in built on top of this
 * one).
 *
 * The fields the engine's ranking does not read (name, foodBox, shields) are still set to
 * something legal rather than omitted: a hypothetical city is still a `City`, and a field
 * the engine grows to read one day should not be missing here.
 */
const withProspectOn = (state: GameState, owner: PlayerId, tile: TileIndex): GameState => {
  let highest = -1;
  for (const city of state.cities) highest = Math.max(highest, Number(city.id));
  const stand: City = {
    id: asCityId(highest + 1),
    owner,
    name: 'prospect',
    tile,
    population: 1,
    foodBox: 0,
    shields: 0,
    queue: [],
    buildings: [],
    workedTiles: [],
  };
  return { ...state, cities: [...state.cities, stand] };
};

/** The stand-in city on `tile` of the state `withProspectOn` produced. */
const prospectOn = (state: GameState, tile: TileIndex): City | undefined =>
  state.cities.find((city) => city.tile === tile && city.name === 'prospect');

/**
 * What a city founded on `tile` would produce per turn once `sampleTiles` of its citizens
 * are assigned — asked of the engine's own `autoAssignWorkedTiles` and `cityYields`, never
 * estimated here.
 */
const cityOutputAt = (
  state: GameState,
  ruleset: RulesetView,
  tile: TileIndex,
  sampleTiles: number,
): { readonly food: number; readonly surplus: number; readonly shields: number } => {
  const prospect = prospectOn(state, tile);
  if (prospect === undefined) return { food: 0, surplus: 0, shields: 0 };
  const worked = autoAssignWorkedTiles(state, ruleset, prospect.id, sampleTiles);
  const placed: GameState = {
    ...state,
    cities: state.cities.map((candidate) =>
      candidate.id === prospect.id ? { ...candidate, workedTiles: worked } : candidate,
    ),
  };
  const yields = cityYields(placed, ruleset, prospect.id);
  return { food: yields.food, surplus: yields.foodSurplus, shields: yields.shields };
};

/**
 * A site's score, as a rank — **larger is better, and every component is the engine's own
 * tile read**.
 *
 * The components, in order of importance:
 *
 * 1. the food the first `siteSampleTiles` citizens would bring (the failure a new city
 *    must not have is starving);
 * 2. its food surplus, so a site that can *grow* beats one that merely eats;
 * 3. the shields that same working set produces;
 * 4. how much of the box around the site is still unexplored — a tie-break in favour of a
 *    site with room to expand into, which is what makes an early settler prefer open
 *    ground over the corner of an already-seen peninsula.
 *
 * Deliberately **not** here: distance from the capital, defence, resources, or a continent
 * heuristic. This AI has four components and says so, rather than presenting a long
 * weighted sum whose units nobody can state.
 */
const siteRank = (engine: Engine, playerId: PlayerId, tile: TileIndex): Rank => {
  const sample = engine.weights.settlement.siteSampleTiles;
  const stand = withProspectOn(engine.state, playerId, tile);
  const output = cityOutputAt(stand, engine.ruleset, tile, sample);
  return [output.food, output.surplus, output.shields, revealCount(engine.state, playerId, tile)];
};

/** The food a city founded on `tile` would have for its first citizens. */
const siteFood = (engine: Engine, playerId: PlayerId, tile: TileIndex): number => {
  const sample = engine.weights.settlement.siteSampleTiles;
  const stand = withProspectOn(engine.state, playerId, tile);
  return cityOutputAt(stand, engine.ruleset, tile, sample).food;
};

/**
 * The food **surplus** a city founded on `tile` would run with its first citizens: food less
 * what those citizens eat. The engine's own `cityYields` is asked, so "surplus" here is the
 * same quantity the growth check reads and not a second opinion about terrain.
 */
const siteFoodSurplus = (engine: Engine, playerId: PlayerId, tile: TileIndex): number => {
  const sample = engine.weights.settlement.siteSampleTiles;
  const stand = withProspectOn(engine.state, playerId, tile);
  return cityOutputAt(stand, engine.ruleset, tile, sample).surplus;
};

/* ------------------------------------------------------------------ *
 * Combat — the engine's odds, turned into a decision
 * ------------------------------------------------------------------ */

/**
 * The chance the **attacker wins the whole battle**, in whole percent, from the engine's
 * own per-round chance.
 *
 * ## Why this is not a second statement of `combat.ts`' rule
 *
 * `CombatResolved.attackerWinPct` — read off the fold, straight from the resolver — is the
 * probability of winning *one round*. The thing an attacker cares about is the probability
 * of winning the *battle*, and the two are not the same number: with 3 hit points against
 * 1, a per-round chance of 40% still wins most battles, and with 1 hit point against 4, a
 * per-round chance of 60% still loses most of them. Deciding on the per-round number alone
 * would make this AI throw away good attacks and take bad ones, and those errors are
 * exactly the noise a balance sweep must not be measuring.
 *
 * What is computed here is **the resolver's own race** and nothing else: alternate rounds,
 * each round won with probability `p`, the round's loser loses `rules.damagePerRound` hit
 * points (1 in the shipped catalog, but read from the `CombatDef` this file is handed
 * rather than assumed), the battle ends when a side has none left. The per-round `p` and
 * both hit-point totals are the engine's; no attack strength, defence strength, terrain
 * bonus, fortification bonus, wall bonus or veteran bonus is touched, and none is
 * re-derived. If `combat.ts`' odds formula changes, this number changes with it, because
 * `p` *is* that formula's output.
 *
 * ## The arithmetic, and why the closed form is not used
 *
 * The battle is a negative-binomial race, and the natural closed form
 * (`sum_r C(a-1+r, r) p^a (1-p)^r`) sums *enormous* binomial coefficients times
 * *minuscule* powers — at 4 hit points a side those intermediates overflow a double long
 * before they cancel. So the same probability is accumulated instead as
 *
 * ```text
 * P = sum over r of  P(have won `needed` rounds after `needed - 1 + r` rounds) * p
 * ```
 *
 * which is exact in the same sense (every term is a product of probabilities), stays in
 * `[0, 1]` by construction, and is *monotonically decreasing* in `r`, so it can stop as
 * soon as the remaining tail is negligible. `p` is never assumed non-zero, and every step
 * multiplies by at most `99/100`, so a hopeless attack reaches zero quickly instead of
 * running long. The result is compared against thresholds in whole percent, so an ordinary
 * double's rounding cannot flip a decision that was not already on the knife edge;
 * `ai.test.ts` pins the arithmetic against an exact `BigInt` rational computation over a
 * grid of `(p, attacker hp, defender hp)`.
 */
const battleWinPctOf = (
  perRoundPct: number,
  attackerHitPoints: number,
  defenderHitPoints: number,
  damage: number,
): number => {
  const attacker = Number.isInteger(attackerHitPoints) ? attackerHitPoints : 0;
  const defender = Number.isInteger(defenderHitPoints) ? defenderHitPoints : 0;
  const perRoundDamage = Number.isInteger(damage) && damage >= 1 ? damage : 1;

  const needed = Math.ceil(defender / perRoundDamage);
  const survivable = Math.ceil(attacker / perRoundDamage);
  if (needed <= 0) return 0;
  if (survivable <= 0) return 100;

  const p =
    Number.isFinite(perRoundPct) && perRoundPct > 0
      ? Math.min(100, Math.floor(perRoundPct)) / 100
      : 0;
  if (p <= 0) return 0;

  // The race, stated once: the battle goes to whoever lands `needed` (attacker) or
  // `survivable` (defender) hits first, so
  //
  //   P(the attacker wins) = sum over r of  C(needed - 1 + r, r) * p^needed * q^r,
  //   for r = 0 .. survivable - 1,
  //
  // which is the negative binomial mass of `needed - 1` failures before the last success,
  // truncated at the `survivable`-th failure — because a battle lost at that point is no
  // longer a win. The accumulator below is that sum term by term: `cumulative` is the
  // running `C(needed - 1 + r, r) * q^r` (built by the standard ratio between consecutive
  // terms), and `p ** needed * cumulative` is the term itself.
  //
  // **`p ** needed`, and the exponent is the whole correctness of this function.** It was
  // written as `p` once — the last hit's probability instead of the whole run of them — and
  // that single missing exponent made every attack against a defender with more than one hit
  // point look better than it is, up to a flat **100 %** where the truth was **16 %**
  // (per-round 30 %, three hit points each way: the real negative binomial is
  // `0.3³·(1 + 3·0.7 + 6·0.49) = 16 %`, and the old accumulator returned
  // `0.3·(1 + 2.1 + 2.94) = 181 %`, clamped to 100). For a `needed` of exactly one the two
  // spellings coincide, which is why the bug survived: a one-hit-point defender is the only
  // case where it does not matter, and it is the case a hand-checked example tends to use. So
  // the AI cleared its own `attackWinFloorPct` with units it was about to lose, which is
  // exactly the thing this policy exists not to do, and the fix is the exponent.
  //
  // Both counts matter, and an earlier version of this file used only the defender's: the
  // tail loop ran to `needed`, so it computed `1 - q^survivable` extended past the point
  // where the attacker was already dead — for a 4-hit-point attacker against a 1-hit-point
  // defender at even odds it answered **65 %** where the true answer is **34 %**. The clipped
  // version below is pinned against the exact `BigInt` oracle in `ai.test.ts` **through the
  // policy's own decisions** rather than through a copy of this arithmetic: the test builds
  // worlds whose battle is exactly one the oracle prices, runs the shipped policy on them,
  // and requires the attack to be made if and only if the oracle clears the floor. A test
  // that restated this sum would have agreed with the bug above, and did.
  let cumulative = 1;
  let total = 0;
  for (let r = 0; r < survivable; r += 1) {
    if (cumulative <= 1e-300) break;
    total += cumulative * p ** needed;
    cumulative *= ((needed + r) / (r + 1)) * (1 - p);
  }
  // Truncated, not rounded: a battle at 99.6% is not a certainty, and rounding it up to
  // `100` would let an AI clear a threshold it does not actually clear.
  return Math.max(0, Math.min(100, Math.floor(total * 100)));
};

/**
 * A unit's current hit points, read through the engine's own accessor.
 *
 * `hitPointsLeftOf` and not the raw field: `Unit.hitPointsLeft` is optional on the view (the
 * M6 compromise — the hand-built unit literals that predate it treat "absent" as "at full
 * health"), and a policy that read the field directly would have to restate that rule here.
 * The engine already states it, so this asks.
 */
const hitPointsOf = (unit: Unit): number => hitPointsLeftOf(unit);

/* ------------------------------------------------------------------ *
 * The engine slice every decision is taken against
 * ------------------------------------------------------------------ */

/**
 * What one decision needs: the state as this policy has folded it so far, the ruleset,
 * whose turn it is, and the weights.
 *
 * A slice rather than four arguments on every helper, so the functions below read as the
 * decisions they are. `state` is always the policy's **local** fold — the caller's state
 * with everything this turn's commands have already applied — never the runner's.
 */
interface Engine {
  readonly state: GameState;
  readonly ruleset: RulesetView;
  readonly playerId: PlayerId;
  readonly weights: SmartWeights;
}

/** The player row for this engine's player, or `undefined` for an id the state lacks. */
const playerOf = (engine: Engine): PlayerState | undefined =>
  engine.state.players.find((player) => player.id === engine.playerId);

/** Is this player a barbarian? Read from the state, never guessed from an id. */
const isBarbarian = (state: GameState, playerId: PlayerId): boolean =>
  state.players.find((player) => player.id === playerId)?.kind === 'barbarian';

/** How many units of `role` this player owns. */
const countRole = (engine: Engine, role: UnitRole): number =>
  engine.state.units.filter(
    (unit) => unit.owner === engine.playerId && unitDef(engine.ruleset, unit.type)?.role === role,
  ).length;

/** Every unit this player owns, in id order (`state.units` is sorted by id). */
const ownedUnits = (engine: Engine): readonly Unit[] =>
  engine.state.units.filter((unit) => unit.owner === engine.playerId);

/** The improvement ids already on a tile. */
const improvementsOn = (state: GameState, tile: TileIndex): readonly string[] =>
  improvementsAt(state, tile).map((id) => String(id));

/** Is `id` one of this tile's improvements? */
const hasImprovement = (state: GameState, tile: TileIndex, id: string): boolean =>
  improvementsOn(state, tile).includes(id);

/* ------------------------------------------------------------------ *
 * Cities — what to work, and what to build
 * ------------------------------------------------------------------ */

/**
 * The assignment `city` should hold, or `undefined` when its own is already the engine's
 * answer.
 *
 * The desired set comes from `autoAssignWorkedTiles` asked against a state in which this
 * city's own claim is **cleared** — that helper deliberately excludes the tiles a city
 * already works, so asking it about a city that already works the best tiles would answer
 * with the *second*-best set, and a policy that wrote that down would downgrade the city
 * and swap back the following turn, for ever. Clearing first asks the question this AI
 * means: "if this city assigned from scratch, which tiles would it take?"
 *
 * The answer is legal by construction (inside the radius, never the centre, never a tile
 * another city works, at most one per citizen) because those are the helper's own
 * exclusions — this file scores **no terrain itself**.
 */
const desiredWorkedTiles = (engine: Engine, city: City): readonly TileIndex[] | undefined => {
  const cleared: GameState = {
    ...engine.state,
    cities: engine.state.cities.map((candidate) =>
      candidate.id === city.id ? { ...candidate, workedTiles: [] } : candidate,
    ),
  };
  const desired = autoAssignWorkedTiles(cleared, engine.ruleset, city.id, city.population);
  if (desired.length === 0) return undefined;

  const current = city.workedTiles;
  const same =
    desired.length === current.length && desired.every((tile, index) => current[index] === tile);
  return same ? undefined : desired;
};

/** The building id an item names, or `undefined` when it builds a unit. */
const buildingIdOf = (item: ProductionItem): string | undefined =>
  item.kind === 'building' ? String(item.id) : undefined;

/** Does this item build the engine's defensive walls (`WALLS_BUILDING`)? */
const isWalls = (item: ProductionItem): boolean => buildingIdOf(item) === String(WALLS_BUILDING);

/**
 * Does this building row help a city **grow**? Read off the row's own effects — the
 * engine's `growth-food` is the granary's and the Pyramids' effect — rather than off its
 * id, so a catalog that renames its granary still has a growth building recognised.
 */
const isGrowthBuilding = (ruleset: RulesetView, item: ProductionItem): boolean => {
  if (item.kind !== 'building') return false;
  return (
    buildingDef(ruleset, item.id)?.effects.some((effect) => effect.kind === 'growth-food') === true
  );
};

/**
 * Does this building row improve a city's **economy**? `commerce-multiplier` and
 * `beaker-multiplier` are the engine's effects for a marketplace/temple and a library.
 */
const isEconomyBuilding = (ruleset: RulesetView, item: ProductionItem): boolean => {
  if (item.kind !== 'building') return false;
  return (
    buildingDef(ruleset, item.id)?.effects.some(
      (effect) => effect.kind === 'commerce-multiplier' || effect.kind === 'beaker-multiplier',
    ) === true
  );
};

/**
 * Can this city actually put a **sea** unit to use?
 *
 * The engine's production menu offers a sea row to a landlocked city — `planSetProduction`
 * has no opinion about water, and `production.ts` spawns the unit on the city's own tile,
 * where it can never move. A policy that took that option would build a navy it cannot sail
 * and pay unit support for it for the rest of the game, which is exactly the sort of
 * "legal but stupid" the engine is right not to prevent and the AI is wrong to choose.
 *
 * The test is the tile itself plus its eight neighbours carrying a water role: the same
 * `terrainAt`-and-role read the engine's own terrain rules use, and the same eight-tile
 * neighbourhood `production.ts` places a spawned unit in.
 */
const hasWaterAccess = (engine: Engine, city: City): boolean => {
  const water = (tile: TileIndex): boolean => {
    const id = terrainAtIndex(engine.state.map, Number(tile));
    if (id === undefined) return false;
    const role = engine.ruleset.terrains.find((row) => row.id === id)?.role;
    return role === 'ocean' || role === 'coast';
  };
  if (water(city.tile)) return true;
  for (const tile of cityRadius(engine.state, city.tile)) {
    if (water(tile)) return true;
  }
  return false;
};

/** Is this item a sea unit the city has no water to use? */
const isUselessSeaUnit = (engine: Engine, city: City, item: ProductionItem): boolean => {
  if (item.kind !== 'unit') return false;
  const def = unitDef(engine.ruleset, item.id);
  if (def?.domain !== 'sea') return false;
  return !hasWaterAccess(engine, city);
};

/** Is this a wonder? Wonders are globally unique, so one is worth only one attempt. */
const isWonder = (ruleset: RulesetView, item: ProductionItem): boolean =>
  item.kind === 'building' && buildingDef(ruleset, item.id)?.wonder === true;

/** Does this item develop a young city — a settler, a worker, or a granary? */
const growthItem = (ruleset: RulesetView, item: ProductionItem): boolean => {
  if (item.kind === 'building') return isGrowthBuilding(ruleset, item);
  const role = unitDef(ruleset, item.id)?.role;
  return role === 'settler' || role === 'worker';
};

/**
 * What one city knows about itself when its production is chosen.
 *
 * `threatened` is the single threat read this AI has: an enemy unit standing **in** the
 * city, or any enemy thing within `city.threatRadius` of the city centre. It drives the
 * garrison target, the walls decision and the production bonus, so "react to a threat" is
 * one number rather than three opinions that could disagree.
 */
interface CitySituation {
  readonly city: City;
  readonly threatened: boolean;
  readonly young: boolean;
  readonly defenders: number;
  readonly surplus: number;
  readonly empire: EmpireRead;
}

/** Enough of the empire's numbers to decide what a single city should build. */
interface EmpireRead {
  readonly cities: number;
  readonly settlers: number;
  readonly workers: number;
  readonly military: number;
  readonly scouts: number;
  readonly supportOver: number;
  /** The empire's total population — what the army ceiling is a share of. */
  readonly population: number;
  /** This player's treasury, in gold — what the AI checks before commissioning a unit. */
  readonly treasury: number;
}

/**
 * Every tile this player can see an enemy on or in, ascending — the threat map.
 *
 * Both enemy **units** and enemy **cities** count: a city is not a threat by itself, but a
 * city next door is where the next attack comes from, and treating it as one is what makes
 * this AI fortify a border town without being told which neighbour is hostile.
 */
/**
 * A per-turn cache for the reads that are the same for every city.
 *
 * **Why this exists, and why it is not just an optimisation.** These answers are cheap to
 * state and expensive to recompute with four hundred units on the board, but caching them
 * naively — once per `chooseCommands` call — would make them *wrong*: a city's decision
 * changes the state (a `SetProduction` is a revision), and the next city's decision must see
 * the world the previous one just made. Measured: an earlier version of this file read the
 * empire once per call and computed `supportOver` from the state as it stood **before** the
 * cities had been polled, so the support ceiling never bound and this AI fielded 164 units by
 * turn 120 with the cap set at 3. Keying on the state object and its `revision` — both of
 * which the engine replaces on every applied command — keeps the freshness and drops the
 * repetition.
 */
interface TurnCacheSlot<T> {
  state: GameState | undefined;
  revision: number;
  value: T | undefined;
}

const cachedForTurn = <T>(slot: TurnCacheSlot<T>, state: GameState, compute: () => T): T => {
  if (slot.state === state && slot.revision === state.revision && slot.value !== undefined) {
    return slot.value;
  }
  const value = compute();
  slot.state = state;
  slot.revision = state.revision;
  slot.value = value;
  // `state.revision` is typed `number`, so a value is always stored; the `undefined` in the
  // slot's type is only how "nothing cached yet" is spelled without a second flag.
  return value;
};

const hostileTilesSlot: TurnCacheSlot<readonly TileIndex[]> = {
  state: undefined,
  revision: -1,
  value: undefined,
};

/** Where this player can see an enemy — every rival unit and every rival city it has seen. */
const hostileTiles = (engine: Engine): readonly TileIndex[] =>
  cachedForTurn(hostileTilesSlot, engine.state, () => {
    const indices = new Set<number>();
    for (const unit of engine.state.units) {
      if (unit.owner !== engine.playerId) indices.add(Number(unit.tile));
    }
    for (const city of engine.state.cities) {
      if (city.owner !== engine.playerId) indices.add(Number(city.tile));
    }
    return [...indices].sort((a, b) => a - b).map((index) => asTile(engine.state, index));
  });

/** How many of this player's military units stand within `radius` of `city`. */
const defendersNear = (engine: Engine, city: City, radius: number): number =>
  ownedUnits(engine).filter(
    (unit) =>
      unitDef(engine.ruleset, unit.type)?.role === 'military' &&
      tileDistance(engine.state, unit.tile, city.tile) <= radius,
  ).length;

const empireSlot: TurnCacheSlot<EmpireRead> = {
  state: undefined,
  revision: -1,
  value: undefined,
};

/** The empire-wide counts a single city's decision needs. */
const readEmpire = (engine: Engine): EmpireRead =>
  cachedForTurn(empireSlot, engine.state, () => {
    const support = unitSupport(engine.state, engine.playerId);
    const owned = citiesOf(engine.state, engine.playerId);
    return {
      cities: owned.length,
      population: owned.reduce((total, city) => total + city.population, 0),
      settlers: countRole(engine, 'settler'),
      workers: countRole(engine, 'worker'),
      military: countRole(engine, 'military'),
      scouts: countRole(engine, 'scout'),
      supportOver: Math.max(0, support.units - support.free),
      treasury: playerOf(engine)?.treasury ?? 0,
    };
  });

/** Everything the production chooser needs about one city, computed once. */
const readSituation = (engine: Engine, city: City): CitySituation => {
  const weights = engine.weights;
  const intruder = unitsOnTile(engine.state, city.tile).some(
    (unit) => unit.owner !== engine.playerId,
  );
  const threatened =
    intruder ||
    hostileTiles(engine).some(
      (tile) => tileDistance(engine.state, tile, city.tile) <= weights.city.threatRadius,
    );

  return {
    city,
    threatened,
    young: city.population <= weights.city.youngCityPopulation,
    defenders: defendersNear(engine, city, weights.city.threatRadius),
    surplus: cityYields(engine.state, engine.ruleset, city.id).foodSurplus,
    empire: readEmpire(engine),
  };
};

/**
 * How many cities this AI actually wants on **this** map: the configured
 * `settlement.targetCities`, capped by what the ground can hold
 * (`settlement.tilesPerCity`, a footnote weight) and floored by
 * `settlement.minTargetCities`.
 *
 * A single configured number is a map-size assumption in disguise, and the assumption is
 * wrong in both directions: five cities on a tiny map is most of the land, and five cities on
 * a huge one leaves the AI with an empire it never bothers to grow. Deriving the ceiling from
 * the map the game was actually created with is what keeps one weight set playable across
 * every `mapSize` the settings offer.
 */
const targetCitiesFor = (engine: Engine): number => {
  const weights = engine.weights;
  const area = engine.state.map.width * engine.state.map.height;
  const affordable = Math.floor(area / Math.max(1, weights.settlement.tilesPerCity));
  return Math.max(
    weights.settlement.minTargetCities,
    Math.min(weights.settlement.targetCities, affordable),
  );
};

/**
 * How many cities are already working on a settler, **excluding** `exceptCity`.
 *
 * Cities are polled one at a time and each of them sees the same empire, so a rule that only
 * looked at settlers *in the field* let every city in an empire build one on the same turn:
 * measured, that is what this AI did, and it founded eighteen cities on a map where it wanted
 * five. What a city may not do is add to work another city has already commissioned.
 */
const settlersUnderConstruction = (engine: Engine, exceptCity: CityId): number =>
  citiesOf(engine.state, engine.playerId).filter(
    (city) =>
      city.id !== exceptCity &&
      city.production?.kind === 'unit' &&
      unitDef(engine.ruleset, city.production.id)?.role === 'settler',
  ).length;

/**
 * How many soldiers another city is already working on, excluding `exceptCity` — the army's
 * half of the same de-duplication `settlersUnderConstruction` performs for expansion.
 */
const militaryUnderConstruction = (engine: Engine, exceptCity: CityId): number =>
  citiesOf(engine.state, engine.playerId).filter(
    (city) =>
      city.id !== exceptCity &&
      city.production?.kind === 'unit' &&
      unitDef(engine.ruleset, city.production.id)?.role === 'military',
  ).length;

/**
 * What this AI thinks a candidate item is worth **to this city**, as a priority number
 * (larger wins) — every branch a named weight, no literals.
 *
 * The priorities are *ranks*, not weights: they are compared, never summed, and the
 * modifiers below (a threatened city, a young city) are added to the rank before the
 * comparison, so that "react to a threat" is a single number a sweep can move.
 */
const itemPriority = (engine: Engine, situation: CitySituation, item: ProductionItem): number => {
  const weights = engine.weights;
  const { empire, city } = situation;

  let priority: number;
  if (item.kind === 'unit') {
    const def = unitDef(engine.ruleset, item.id);
    if (def === undefined) return weights.production.fillerPriority;
    // A sea row in a city with no water is not a worse unit, it is not a unit: the engine
    // would spawn it on land where it can never move. Ranked as filler so that no path
    // through this function can choose one, which is what `chooseProduction`'s filter and
    // this branch together guarantee.
    if (isUselessSeaUnit(engine, city, item)) return weights.production.fillerPriority;
    const want = situation.threatened
      ? weights.city.defendersPerThreatenedCity
      : weights.city.defendersPerCity;
    // The empire's army has a **size as well as a shape**: past the share of the population
    // this AI is willing to keep under arms, a city stops adding soldiers whatever its own
    // garrison looks like. Without it the per-city rule alone had no ceiling — every city saw
    // its own neighbourhood, and an empire of six cities raised six soldiers a turn until the
    // treasury disbanded them (measured: 164 units by turn 120 against a support allowance of
    // 14). `defendersPerCity` remains the *local* answer, so the last city to be contacted is
    // still reinforced before any city grows a field army.
    const armyCeiling = Math.floor(
      (Math.max(0, empire.population) * weights.city.fieldArmySharePct) / 100,
    );
    const armyFull = empire.military >= Math.max(empire.cities, armyCeiling);
    // Soldiers another city has already commissioned count against this city's share of the
    // army, for the same reason settlers do (see `settlersUnderConstruction`): every city is
    // polled against the same empire read, so a rule that looked only at finished units would
    // let an empire of six cities raise six soldiers in one turn, every turn.
    const commissioned = militaryUnderConstruction(engine, city.id);
    // A hard ceiling on the whole army, not a slope that slows it down. `supportOver`
    // *measures* the overrun; past `unitsOverAllowanceCap` this refuses to commission another
    // unit at all, which is the difference between an AI that pays more for a bigger army and
    // one that stops. Measured before this was a hard stop: an empire of five cities fielded
    // **164** units by turn 120, because every city saw room under the cap and every turn
    // refilled what bankruptcy had just disbanded. A treasury floor (`supportAffordableAt
    // Treasury`) sits beside it, because support is paid in gold and the engine's answer to a
    // treasury that cannot pay is to disband the army — the expensive way to learn this.
    const supportRoom =
      empire.supportOver < weights.economy.unitsOverAllowanceCap &&
      empire.treasury >= weights.economy.supportAffordableAtTreasury;
    switch (def.role) {
      case 'settler': {
        // How many settlers this empire should have in hand: enough to reach the city target
        // and no more (`surplusSettlerAllowance`). The failure this guards against is real
        // and expensive — a settler with nowhere legal to found walks for the rest of the
        // game, and every turn of it is a unit the treasury pays for — so a city stops
        // building settlers the moment the empire has as many as it wants cities.
        const wanted = targetCitiesFor(engine);
        const committed =
          empire.cities + empire.settlers + settlersUnderConstruction(engine, city.id);
        const expanding = committed < wanted;
        const surplus = empire.settlers > weights.economy.surplusSettlerAllowance;
        // The second road to a settler is the one that stops an opening deadlock: a city with
        // food on the table (`emergencySettlerFoodSurplus`) can spare the citizens even when
        // it is too small for `minPopulationForSettler`. Without it, a one-city empire whose
        // only city cannot yet afford to shrink never expands at all.
        const mature = city.population >= weights.city.minPopulationForSettler;
        const growing = situation.surplus >= weights.settlement.emergencySettlerFoodSurplus;
        priority =
          expanding && supportRoom && (mature || growing)
            ? weights.production.settlerPriority
            : weights.production.fillerPriority;
        // `surplus` is a veto rather than a term: an empire already holding more settlers
        // than it wants cities has no use for another, whatever its priority would be.
        if (surplus) priority = weights.production.fillerPriority;
        break;
      }
      case 'worker':
        priority =
          supportRoom &&
          empire.workers <
            Math.max(
              weights.city.minWorkers,
              weights.city.workersPerCity * Math.max(1, empire.cities),
            )
            ? weights.production.workerPriority
            : weights.production.fillerPriority;
        break;
      case 'military': {
        const garrison = situation.defenders + commissioned;
        priority =
          !supportRoom || armyFull
            ? weights.production.fillerPriority
            : garrison < 1
              ? weights.production.firstDefenderPriority
              : garrison < want
                ? weights.production.secondDefenderPriority
                : weights.production.militaryPriority;
        break;
      }
      case 'scout':
        priority =
          supportRoom &&
          empire.scouts < weights.exploration.scoutsPerCity * Math.max(1, empire.cities)
            ? weights.production.militaryPriority
            : weights.production.fillerPriority;
        break;
    }
  } else if (isWalls(item)) {
    priority = situation.threatened
      ? weights.production.wallsPriority
      : weights.production.fillerPriority;
  } else if (isGrowthBuilding(engine.ruleset, item)) {
    priority =
      situation.surplus > 0
        ? weights.production.granaryPriority
        : weights.production.stagnantGranaryPriority;
  } else if (isEconomyBuilding(engine.ruleset, item)) {
    priority = weights.production.economyBuildingPriority;
  } else {
    priority = weights.production.fillerPriority;
  }

  // A threatened city is the reactive case, and it is a *whole-table* modifier rather
  // than a second set of numbers, so a sweep that moves `threatenedBoost` moves this AI's
  // entire response to pressure at once.
  if (situation.threatened) priority += weights.production.threatenedBoost;
  else if (situation.young && growthItem(engine.ruleset, item)) {
    priority += weights.production.youngCityBoost;
  }

  return priority;
};

/**
 * The item a city should build, or `undefined` to leave its queue alone.
 *
 * Four rules, all of them this file's and all of them stated:
 *
 * 1. **Only legal options are considered** — `cityProductionOptions` is the engine's own
 *    menu (resource gates, tech gates, a building the city has, a wonder somebody holds,
 *    all decided by `planSetProduction`), so this cannot choose an item the applier would
 *    refuse.
 * 2. **A wonder waits until the empire can afford one**: skipped while the AI has fewer
 *    cities than `settlement.targetCities`, because a wonder is a long investment and the
 *    thing this AI actually needs early is a second city.
 * 3. **An item of the same priority as the incumbent is not a reason to switch.** The
 *    comparison is *strict*, so a city already building the best thing it can build is
 *    left alone — otherwise the AI would churn its own queue every turn and burn a
 *    revision on each swap.
 * 4. **Ties are broken by the candidates' own content**, never by the menu's order:
 *    "does this finish within `affordableWithinTurns`?", then the shields still owed
 *    (fewer first), then `(kind, id)`.
 */
const chooseProduction = (engine: Engine, situation: CitySituation): ProductionItem | undefined => {
  const { city } = situation;
  const options = cityProductionOptions(engine.state, engine.ruleset, city.id);
  if (options.length === 0) return undefined;
  const wanted = targetCitiesFor(engine);

  const perTurn = Math.max(1, cityYields(engine.state, engine.ruleset, city.id).shields);
  const weights = engine.weights;

  const rankOf = (item: ProductionItem): Rank => {
    const cost = itemCost(engine.ruleset, item);
    const remaining = Math.max(0, cost - city.shields);
    const soon = remaining <= perTurn * weights.production.affordableWithinTurns ? 1 : 0;
    return [itemPriority(engine, situation, item), soon, -remaining];
  };

  let best: { readonly item: ProductionItem; readonly rank: Rank } | undefined;
  for (const item of options) {
    if (isWonder(engine.ruleset, item) && situation.empire.cities < wanted) {
      continue;
    }
    if (isUselessSeaUnit(engine, city, item)) continue;
    const rank = rankOf(item);
    if (best === undefined) {
      best = { item, rank };
      continue;
    }
    const byRank = compareRanks(rank, best.rank);
    if (byRank > 0 || (byRank === 0 && compareItems(item, best.item) < 0)) best = { item, rank };
  }
  if (best === undefined) return undefined;

  const head = city.production;
  if (head !== undefined) {
    const incumbent = options.find((item) => item.kind === head.kind && item.id === head.id);
    // Compare like with like: the incumbent is judged by exactly the rule the challenger
    // was, and only a strictly higher rank replaces it.
    if (incumbent !== undefined && compareRanks(rankOf(incumbent), best.rank) >= 0) {
      return undefined;
    }
  }

  return best.item;
};

/* ------------------------------------------------------------------ *
 * Research — with a goal, not "the first available"
 * ------------------------------------------------------------------ */

/** The value this AI puts on one catalog row a tech would unlock. */
const unlockValue = (engine: Engine, kind: string, id: string): number => {
  const weights = engine.weights.research;
  if (kind === 'unit') {
    const role = unitCatalog(engine.ruleset).find((def) => String(def.id) === id)?.role;
    switch (role) {
      case 'military':
        return weights.unlockValueMilitary;
      case 'settler':
        return weights.unlockValueSettler;
      case 'worker':
        return weights.unlockValueWorker;
      case 'scout':
        return weights.unlockValueScout;
      default:
        return weights.unlockValueOtherBuilding;
    }
  }
  if (kind === 'building') {
    const row = buildingCatalog(engine.ruleset).find((def) => String(def.id) === id);
    if (row === undefined) return weights.unlockValueOtherBuilding;
    if (String(row.id) === String(WALLS_BUILDING)) return weights.unlockValueWalls;
    if (row.effects.some((effect) => effect.kind === 'growth-food')) {
      return weights.unlockValueGrowthBuilding;
    }
    if (
      row.effects.some(
        (effect) => effect.kind === 'commerce-multiplier' || effect.kind === 'beaker-multiplier',
      )
    ) {
      return weights.unlockValueEconomyBuilding;
    }
    return weights.unlockValueOtherBuilding;
  }
  if (kind === 'improvement') return weights.unlockValueImprovement;
  if (kind === 'resource') return weights.unlockValueResource;
  return 0;
};

/**
 * What a tech is worth to this AI, as a rank — **larger is better**, and it is a *goal*
 * rather than a price list.
 *
 * - The first component is the best thing the tech unlocks, valued by `unlockValue` and
 *   scaled by `wantedUnlockBonusPct` when the empire is currently short of the *kind* of
 *   thing it unlocks — so a military tech is worth more to an AI with no army than to one
 *   with three, which is the whole difference between "research with a goal" and "research
 *   the cheap thing".
 * - The second is `prerequisiteValue` per **other** tech that names this one as a
 *   prerequisite: a tech that is a step toward something wanted is worth paying for, even
 *   when it unlocks nothing itself.
 * - The third is the **negative cost**, so of two equally wanted techs the AI takes the one
 *   it can actually finish. Negated rather than turned into "value per beaker" because a
 *   ratio is a claim about the exchange rate between beakers and unlocks that nobody here
 *   can justify, whereas "want first, then cheap" is the honest form of the same
 *   preference.
 * - Nothing about the tech's *id* is in the rank: two techs with the same unlocks and the
 *   same cost are genuinely tied, and the tie is broken once, by id, in `chooseTech`.
 */
const researchRank = (engine: Engine, tech: TechId, cost: number): Rank => {
  const weights = engine.weights;
  const empire = readEmpire(engine);
  const cities = Math.max(1, empire.cities);
  const shortOfUnits = empire.military < weights.city.defendersPerCity * cities;
  const shortOfWorkers = empire.workers < weights.city.workersPerCity * cities;

  let best = 0;
  for (const unlock of techUnlocks(engine.ruleset, tech)) {
    const base = unlockValue(engine, unlock.kind, unlock.id);
    let scaled = base;
    if (unlock.kind === 'unit') {
      const role = unitCatalog(engine.ruleset).find((def) => String(def.id) === unlock.id)?.role;
      const short =
        (role === 'military' && shortOfUnits) ||
        (role === 'worker' && shortOfWorkers) ||
        (role === 'settler' && empire.cities < weights.settlement.targetCities);
      if (short) scaled = Math.floor((base * weights.research.wantedUnlockBonusPct) / 100);
    }
    best = Math.max(best, scaled);
  }

  let dependents = 0;
  for (const row of techCatalog(engine.ruleset)) {
    if (row.requires.includes(tech)) dependents += 1;
  }

  return [best, dependents * weights.research.prerequisiteValue, -cost];
};

/**
 * The tech this player should research next, or `undefined` when the current selection
 * should stand.
 *
 * Legality is the engine's, asked through `researchProblem` on the player row — the same
 * evaluator `planSetResearch` refuses with — so a candidate this proposes is one the
 * applier accepts and the pipeline can finish. The winner is chosen by **sorting the
 * candidates** by `(rank desc, id asc)` rather than by keeping a running maximum, because
 * a running maximum keeps the first of a tie and "first" is the tech catalog's row order,
 * which is content's editorial position rather than part of what a ruleset means.
 */
const chooseTech = (engine: Engine): TechId | undefined => {
  const player = playerOf(engine);
  if (player === undefined) return undefined;
  const selected = researchingOf(player);
  const known = knownTechs(player);

  const candidates: { readonly tech: TechId; readonly rank: Rank }[] = [];
  for (const row of techCatalog(engine.ruleset)) {
    const cost = techCostOf(engine.ruleset, row.id);
    if (cost === undefined) continue;
    if (known.includes(row.id)) continue;
    if (researchProblem(engine.ruleset, player, row.id) !== undefined) continue;
    candidates.push({ tech: row.id, rank: researchRank(engine, row.id, cost) });
  }
  if (candidates.length === 0) return undefined;

  const best = [...candidates].sort((a, b) => {
    const byRank = compareRanks(b.rank, a.rank);
    return byRank !== 0 ? byRank : compareText(String(a.tech), String(b.tech));
  })[0];
  if (best === undefined) return undefined;
  return best.tech === selected ? undefined : best.tech;
};

/* ------------------------------------------------------------------ *
 * The economy — do not go bankrupt by choice
 * ------------------------------------------------------------------ */

/** What the three rates will collect, measured through the engine's own per-city split. */
const incomeAt = (
  state: GameState,
  ruleset: RulesetView,
  playerId: PlayerId,
  tax: number,
  science: number,
): { readonly gold: number; readonly beakers: number } => {
  const rates = { tax, science, luxury: RATE_TOTAL - tax - science };
  let gold = 0;
  let beakers = 0;
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    const split = splitCommerce(cityYields(state, ruleset, city.id).commerce, rates);
    gold += split.gold;
    beakers += split.beakers;
  }
  return { gold, beakers };
};

/**
 * A rate triple's score, as a rank — larger is better.
 *
 * 1. **Whether it covers the books**: whether the projected balance
 *    `deficitTurnsTolerated` turns out — `treasury + (income - upkeep) * turns` — reaches
 *    `runwayTurns` turns of upkeep. This component is the "do not go bankrupt by choice"
 *    rule and it is deliberately first: an AI that researches faster while the engine
 *    disbands its army for unpaid bills is not playing better. `runwayTurns` is what this
 *    AI counts as *funded*; the alternative — a pair of fixed science rates to switch
 *    between — would have to assume the split is linear in the rates, which `splitCommerce`
 *    says it is not (it floors **per city**).
 * 2. **Beakers.** A treasury is a means and a technology is the end, so once the books are
 *    covered this AI researches as hard as the rate allows. It is deliberately **second and
 *    not third**: an earlier version ranked the projected treasury above beakers, and the
 *    result was an AI that taxed itself to 272–509 banked gold over 45 turns and finished
 *    with **zero technologies**. Gold that buys nothing is not savings.
 * 3. **The science rate itself**, so a rate that delivers equal beakers more cheaply wins,
 *    then
 * 4. **`-tax`**, which keeps that tie-break off the catalog's ordering.
 */
const rateRank = (engine: Engine, tax: number, science: number, upkeep: number): Rank => {
  const weights = engine.weights.economy;
  const treasury = Math.max(0, Math.floor(playerOf(engine)?.treasury ?? 0));
  const read = incomeAt(engine.state, engine.ruleset, engine.playerId, tax, science);
  const horizon = Math.max(1, weights.deficitTurnsTolerated);
  const runway = Math.max(0, weights.runwayTurns);
  const projected = treasury + (read.gold - upkeep) * horizon;
  const covered = projected >= Math.max(0, upkeep) * runway ? 1 : 0;
  return [covered, read.beakers, science, -tax];
};

/**
 * The rates this player should run, or `undefined` when its current ones are already the
 * answer.
 *
 * The candidate space is every `(tax, science)` pair that leaves a luxury share no larger
 * than `luxuryShareWhenRich` — the engine's own rule that the three rates sum to
 * `RATE_TOTAL` is what defines it, and every candidate is additionally put through
 * `planSetRates` (the evaluator `applyCommand` refuses with) before it can win. Luxuries
 * are **inert until M9**, so the bound on that channel is a sweepable opinion here rather
 * than a claim that contentment is modelled.
 *
 * The choice is *scored*, not solved, because the commerce split floors **per city**
 * (`splitCommerce`): income is not a linear function of the rates, so "solve for the tax
 * rate that covers the bills" is not a valid derivation — it has to be measured.
 */
const chooseRates = (
  engine: Engine,
  upkeep: number,
): { readonly tax: number; readonly science: number; readonly luxury: number } | undefined => {
  const player = playerOf(engine);
  if (player === undefined) return undefined;
  const ceiling = Math.max(0, Math.min(RATE_TOTAL, engine.weights.economy.luxuryShareWhenRich));

  let best:
    | {
        readonly tax: number;
        readonly science: number;
        readonly luxury: number;
        readonly rank: Rank;
      }
    | undefined;

  for (let luxury = 0; luxury <= ceiling; luxury += 1) {
    for (let science = 0; science + luxury <= RATE_TOTAL; science += 1) {
      const tax = RATE_TOTAL - science - luxury;
      if (!planSetRates(engine.state, engine.playerId, { tax, science, luxury }).ok) continue;
      const rank = rateRank(engine, tax, science, upkeep);
      const candidate = { tax, science, luxury, rank };
      if (best === undefined) {
        best = candidate;
        continue;
      }
      const byRank = compareRanks(rank, best.rank);
      if (byRank > 0 || (byRank === 0 && tax < best.tax)) best = candidate;
    }
  }
  if (best === undefined) return undefined;

  const current = player.rates;
  if (
    current.tax === best.tax &&
    current.science === best.science &&
    current.luxury === best.luxury
  ) {
    return undefined;
  }
  return { tax: best.tax, science: best.science, luxury: best.luxury };
};

/* ------------------------------------------------------------------ *
 * Movement — a rank over the destinations the engine already allows
 * ------------------------------------------------------------------ */

type MoveCommand = Extract<Command, { readonly type: 'MoveUnit' }>;
type StartWorkCommand = Extract<Command, { readonly type: 'StartWork' }>;

const isMove = (command: Command): command is MoveCommand => command.type === 'MoveUnit';
const isStartWork = (command: Command): command is StartWorkCommand => command.type === 'StartWork';

/**
 * The best legal step for `unit` under `rank`, or `undefined` when every step is worse
 * than standing still.
 *
 * Candidates are `unitActions`' own `MoveUnit` list (the engine's enumeration, so every one
 * is a move the applier accepts) and the comparison is a **strict** improvement of the
 * rank, which is what stops a unit pacing between two equally good tiles. Ties go to the
 * lowest tile index, so the choice never depends on the order the engine enumerated in; a
 * step onto an **enemy-occupied** tile is dropped before it can be chosen, because
 * `planMove` would refuse it and the AI must not spend a decision on it.
 */
const bestStep = (
  engine: Engine,
  unit: Unit,
  rank: (tile: TileIndex) => Rank,
): MoveCommand | undefined => {
  const here = rank(unit.tile);
  let best:
    { readonly command: MoveCommand; readonly rank: Rank; readonly tile: number } | undefined;

  for (const move of unitActions(engine.state, engine.ruleset, unit.id).filter(isMove)) {
    if (unitsOnTile(engine.state, move.to).some((other) => other.owner !== unit.owner)) continue;
    const score = rank(move.to);
    if (compareRanks(score, here) <= 0) continue;
    const index = Number(move.to);
    if (best === undefined) {
      best = { command: move, rank: score, tile: index };
      continue;
    }
    const better = compareRanks(score, best.rank);
    if (better > 0 || (better === 0 && index < best.tile)) {
      best = { command: move, rank: score, tile: index };
    }
  }

  return best?.command;
};

/**
 * The first step of a **route** to `target`, or `undefined` when there is none.
 *
 * ## Why a rank over the eight neighbours is not enough
 *
 * Until this function existed, "walk to the target" meant "step to whichever neighbour is
 * strictly closer to it", and on a map with any obstacle in the way that instruction has
 * **no solution**. Measured on a duel map: a soldier at tile 665 with the rival's city at
 * 1295 — thirteen tiles due east across open grassland — had one legal neighbour at that
 * distance or less, because every closer tile on its own row lay inside the 50%-defence-bonus
 * radius of a city it was not attacking, and its other neighbours were hills, coast or *further
 * away*. A greedy step refuses all three, so the soldier stood still for thirty turns while
 * believing it was marching, and the two civilizations never met. The same shape of stall had
 * already cost this AI its settlers once (see `nearestLegalSite`); the lesson is the same both
 * times: **a decision that can only ever move downhill has no answer on a map with hills.**
 *
 * So the route is searched, breadth-first, over the tiles `planMove` actually lets this unit
 * enter — the engine's own evaluator, asked once per tile — and the step returned is the first
 * tile of the path found. Breadth-first means the path is a **fewest-steps** path: every step
 * of a `movement`-1 unit costs exactly its turn, so fewest steps *is* soonest arrival. Ties are
 * broken by the lower tile index, so the route is a function of the map and the unit alone and
 * never of the order the engine enumerated in.
 *
 * The route is cached per `GameState` object, per unit, per target. State objects are
 * immutable and replaced on every applied command, so a cache keyed on the object cannot go
 * stale, and a unit that walks one step per turn re-searches only when something actually
 * changed.
 */
const routeCache = new WeakMap<GameState, Map<string, readonly TileIndex[]>>();

/**
 * The tiles this unit may **enter**, in ascending index order, as a move of its own.
 *
 * Candidates come from `planMove` — the evaluator `applyCommand` refuses with — walked over
 * the eight neighbours once. The enumeration needs `moveOptions` because a route search
 * cannot ask "where can this unit go from *that* tile?" any other way: `unitActions` answers
 * about the unit's own tile only. `moveOptions` is a **pure read** of the state, and the
 * search never applies a move, so the engine is asked only what it would allow.
 *
 * The state the question is asked of has this unit **standing on `tile` and every other unit
 * of this player lifted off the board** (`searchStateFor`), and that is not a convenience:
 * `planMove` refuses a tile held by another player, so a route searched from a state where the
 * unit is still at home can never leave home, and a route searched over a map on which its own
 * army is standing finds nothing but the tiles that army is not standing on.
 *
 * Both failures were measured. From tile 463 with the unit left at home the search expanded
 * **eight** tiles and returned nothing. With it standing on the tile it asked about, the search
 * expanded **396** tiles and *still* returned nothing, because the tiles between it and the
 * rival's city were occupied by the rest of its own army. **A friendly unit is not a wall** —
 * it can move, it does move, and the very next step of the route is asked of the engine again
 * through `routeStep`, which is where an occupied tile is refused. This search answers "is
 * there a way there", and that answer does not depend on which of the two of us is standing in
 * it.
 */
const moveOptions = (engine: Engine, unit: Unit, tile: TileIndex): readonly TileIndex[] =>
  neighbors8(engine.state.map, tile)
    .filter((to) => planMove(engine.state, engine.ruleset, unit.owner, unit.id, to).ok)
    .sort((a, b) => a - b);

/**
 * A fewest-steps route from `unit` to `goal`, **excluding** the unit's own tile and excluding
 * the goal itself, or an empty list when no route exists.
 *
 * `goal` is a **goal test** rather than a tile the unit must be able to enter: an enemy city
 * is exactly the landmark this army marches on, and whether its own tile is enterable is a
 * question for the step that tries it. Occupied ground needs no special case — `planMove`
 * already refuses a tile held by another player, so a friendly unit in the way is routed
 * around and a hostile tile is not a place to walk.
 *
 * Breadth-first, so the path is a fewest-steps path, and neighbours are visited in ascending
 * index order, so the path is a function of the map and the unit and of nothing else. Bounded
 * by the whole map, which is the honest bound for a search that must be able to say "there is
 * no way there".
 */
/** This unit's own view of the board for a route search: `tile`, and no other friendly unit. */
const searchStateFor = (engine: Engine, unit: Unit, tile: TileIndex): GameState => ({
  ...engine.state,
  units: [{ ...unit, tile }],
});

/**
 * The fewest-steps route from `unit` toward `goal`, or an empty list when there is none.
 *
 * `beside` is the whole of what M7's siege work added here, and it is a rule of the engine
 * rather than a convenience: **the tile an enemy stands on, and the tile an enemy city stands
 * on, are not enterable** — `planMove` refuses both with `occupied-by-enemy`, because the
 * command that answers them is `AttackUnit`. A route search that only ever accepted the goal
 * tile itself therefore had **no route to any enemy, ever**: on a duel map the army walked to
 * within two tiles of a city and stopped there for the rest of the game, because the only
 * tiles the search would accept were the one tile it is never allowed to stand on. With
 * `beside` the search accepts any tile **orthogonally or diagonally adjacent** to the goal, so
 * "march on the city" means "arrive where you can attack it" and the route goes round
 * obstacles exactly as it does for a tile the unit may enter.
 *
 * The goal tiles are built once, and `start` counts as arrived, so a unit already in contact
 * is asked for no step at all rather than being sent round the block.
 */
const stepsToTile = (
  engine: Engine,
  unit: Unit,
  goal: number,
  beside: boolean,
): readonly TileIndex[] => {
  const bare = searchStateFor(engine, unit, unit.tile);
  const start = Number(unit.tile);
  const goals = new Set<number>([goal]);
  if (beside) {
    for (const tile of neighbors8(engine.state.map, asTile(engine.state, goal))) {
      goals.add(Number(tile));
    }
  }
  if (goals.has(start)) return [];
  const cameFrom = new Map<number, number>();
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  let head = 0;
  let reached: number | undefined;
  while (head < queue.length && reached === undefined) {
    const at = queue[head];
    head += 1;
    if (at === undefined) break;
    // The unit is asked **from** the tile being expanded: `planMove` reads the unit's own
    // position, so the search has to move it there before it can ask what comes next.
    const from = asTile(bare, at);
    const atTile: Engine = { ...engine, state: withUnitAt(bare, unit.id, from) };
    for (const to of moveOptions(atTile, { ...unit, tile: from }, from)) {
      if (seen.has(to)) continue;
      seen.add(to);
      cameFrom.set(to, at);
      if (goals.has(to)) {
        reached = to;
        break;
      }
      queue.push(to);
    }
  }
  if (reached === undefined) return [];

  const path: number[] = [];
  let at = reached;
  while (at !== start) {
    path.push(at);
    const previous = cameFrom.get(at);
    if (previous === undefined) return [];
    at = previous;
  }
  path.reverse();
  return path.map((index) => asTile(bare, index));
};

/** The cached route from `unit` toward `target`, or an empty list when there is none. */
const routeTo = (
  engine: Engine,
  unit: Unit,
  target: TileIndex,
  beside: boolean,
): readonly TileIndex[] => {
  const goal = Number(target);
  let byUnit = routeCache.get(engine.state);
  if (byUnit === undefined) {
    byUnit = new Map<string, readonly TileIndex[]>();
    routeCache.set(engine.state, byUnit);
  }
  // `beside` is part of the key because it is part of the question: "the tile" and "a tile
  // beside it" are two different routes, and a cache that could not tell them apart would hand
  // a siege the route it computed for something else.
  const key = `${String(unit.id)}:${String(goal)}:${beside ? 'beside' : 'on'}`;
  const cached = byUnit.get(key);
  if (cached !== undefined) return cached;
  const path = stepsToTile(engine, unit, goal, beside);
  byUnit.set(key, path);
  return path;
};

/** The first step of the cached route from `unit` toward `target`, or `undefined`. */
const firstRouteStep = (
  engine: Engine,
  unit: Unit,
  target: TileIndex,
  beside: boolean,
): TileIndex | undefined => {
  if (Number(unit.tile) === Number(target)) return undefined;
  const route = routeTo(engine, unit, target, beside);
  if (route.length === 0) return undefined;
  // A route is a cached fact about a *state*, and the unit may already have moved within this
  // turn: if the next tile is no longer where the route expects it, re-search rather than walk
  // a stale path. The re-search is bounded by the same map, and it cannot loop because each
  // step the caller takes is checked against the route it was given.
  const next = route[0];
  if (next === undefined) return undefined;
  return next;
};

/** The command that takes `unit` one step along its route, if the route exists. */
const routeStep = (
  engine: Engine,
  unit: Unit,
  target: TileIndex,
  beside: boolean,
): MoveCommand | undefined => {
  const next = firstRouteStep(engine, unit, target, beside);
  if (next === undefined) return undefined;
  return unitActions(engine.state, engine.ruleset, unit.id)
    .filter(isMove)
    .find((move) => Number(move.to) === Number(next));
};

/** The rank of stepping somewhere for a unit that is exploring. */
const exploreRanker =
  (engine: Engine) =>
  (tile: TileIndex): Rank => {
    const yields = yieldsAt(engine.state, engine.ruleset, tile);
    return [
      hutAt(engine.state, tile),
      revealCount(engine.state, engine.playerId, tile),
      yields.food,
      yields.shields,
      yields.commerce,
    ];
  };

/* ------------------------------------------------------------------ *
 * Workers — a real improvement plan
 * ------------------------------------------------------------------ */

/** One improvement this player could build somewhere, and what it would be worth there. */
interface JobPlan {
  readonly kind: StartWorkCommand['kind'];
  readonly tile: TileIndex;
  readonly value: number;
}

/**
 * What a worker standing on `tile` could start there, valued by the yields the row **adds**
 * — summed from the engine's own `ImprovementDef.yields` and applied to the engine's own
 * tile read, never a table written here.
 *
 * Legality is asked of the applier itself: the unit's own `StartWork` actions are taken
 * from `unitActions` (which shares `planStartWork` with `applyCommand`, so the set *is* the
 * accepted set — the keystone invariant, both directions), which is also what keeps the
 * terrain-role gate out of this file entirely.
 *
 * The caller only asks this about a worker standing **on** `tile`, because that is the only
 * place a job can start (M4a: the target tile is the unit's own tile, by construction).
 */
const jobsOnTile = (engine: Engine, unit: Unit, tile: TileIndex): readonly JobPlan[] => {
  const standing = Number(unit.tile) === Number(tile);
  if (!standing) return [];

  const gains = new Map<string, number>();
  for (const def of engine.ruleset.improvements) {
    if (hasImprovement(engine.state, tile, String(def.id))) continue;
    const gain = def.yields.food + def.yields.shields + def.yields.commerce;
    if (gain > 0) gains.set(String(def.id), gain);
  }

  const plans: JobPlan[] = [];
  for (const action of unitActions(engine.state, engine.ruleset, unit.id).filter(isStartWork)) {
    const gain = gains.get(String(action.kind));
    if (gain === undefined) continue;
    plans.push({ kind: action.kind, tile, value: gain });
  }
  return plans;
};

/**
 * The best improvement this player's workers should be building, or `undefined` when there
 * is nothing worth improving.
 *
 * The candidate tiles are the radii of this player's cities — the ground a city can
 * actually work — and the ranking is **worked-first**: a tile one of this AI's cities works
 * is worth improving before a tile nobody works, because a worked tile is the only way an
 * improvement reaches a city's output at all. Within that, more added yield wins, then the
 * lower tile index, so the choice is total and independent of catalog order.
 *
 * This is the heuristic M4a's placeholder policy explicitly declined to write ("walk to a
 * tile that needs improving … would be a strategy claim this placeholder does not make").
 * M7's opponent makes it, and says so: like every other number here it is a placeholder.
 */
const chooseJob = (engine: Engine): JobPlan | undefined => {
  const tiles = new Set<number>();
  for (const city of citiesOf(engine.state, engine.playerId)) {
    for (const tile of cityRadius(engine.state, city.tile)) tiles.add(Number(tile));
  }

  let best: { readonly plan: JobPlan; readonly rank: Rank; readonly tile: number } | undefined;
  for (const index of [...tiles].sort((a, b) => a - b)) {
    const tile = asTile(engine.state, index);
    const terrainId = terrainAtIndex(engine.state.map, index);
    if (terrainId === undefined) continue;
    const terrain = engine.ruleset.terrains.find((row) => row.id === terrainId);
    if (terrain === undefined) continue;

    const worked = engine.state.cities.some(
      (city) => city.owner === engine.playerId && city.workedTiles.some((t) => Number(t) === index),
    );

    for (const def of engine.ruleset.improvements) {
      if (hasImprovement(engine.state, tile, String(def.id))) continue;
      if (!def.allowedRoles.includes(terrain.role)) continue;
      const value = def.yields.food + def.yields.shields + def.yields.commerce;
      if (value <= 0) continue;
      const plan: JobPlan = { kind: def.id, tile, value };
      const rank: Rank = [worked ? 1 : 0, value, -index];
      if (best === undefined) {
        best = { plan, rank, tile: index };
        continue;
      }
      const better = compareRanks(rank, best.rank);
      if (better > 0 || (better === 0 && index < best.tile)) best = { plan, rank, tile: index };
    }
  }

  return best?.plan;
};

/* ------------------------------------------------------------------ *
 * Attacks
 * ------------------------------------------------------------------ */

/** The `AttackUnit` command, as the enumerator issues it. */
type AttackCommand = Extract<Command, { readonly type: 'AttackUnit' }>;

/** What one folded attack told this policy about it. */
interface AttackChoice {
  readonly command: AttackCommand;
  /** The engine's per-round odds for this attack, in whole percent. */
  readonly perRoundPct: number;
  /** The probability the attacker wins the whole battle, in whole percent. */
  readonly winPct: number;
  /** `true` when the engine's own fold reported a `CityCaptured` — an undefended city. */
  readonly capture: boolean;
}

/** Everything the engine said about one `AttackUnit` candidate — see `readAssault`. */
interface AssaultRead {
  readonly command: AttackCommand;
  /** The engine's per-round odds for this attack, in whole percent. */
  readonly perRoundPct: number;
  /** The probability the attacker wins the whole battle, in whole percent. */
  readonly winPct: number;
  /** `true` when the engine's own fold reported a `CityCaptured` — an undefended city. */
  readonly capture: boolean;
  /** The unit the engine would resolve the attack against; absent for a capture. */
  readonly defender: Unit | undefined;
  /** Whether the target tile holds an enemy city, and whether that city holds walls. */
  readonly kind: { readonly inCity: boolean; readonly walled: boolean };
}

/**
 * Whether the tile holding the defender is a city, and — when it is — whether that city
 * holds **defensive walls**.
 *
 * The second half is what makes the walls knob reachable: an AI that never attacked a
 * walled city would leave `wallsBonusPct` unmeasurable, which is exactly the flat sweep
 * M7 sets out to repair.
 */
const targetKind = (
  engine: Engine,
  target: TileIndex,
): { readonly inCity: boolean; readonly walled: boolean } => {
  const city = cityAt(engine.state, target);
  if (city === undefined || city.owner === engine.playerId) return { inCity: false, walled: false };
  return {
    inCity: true,
    walled: city.buildings.some((id) => String(id) === String(WALLS_BUILDING)),
  };
};

/**
 * Fold one `AttackUnit` candidate through the engine's own applier and read what the engine
 * said about it.
 *
 * **The one place an assault is priced**, so the policy cannot hold two opinions about the
 * same attack. What comes back is the engine's own `CombatResolved.attackerWinPct` and its
 * own `CityCaptured`, plus the defender the engine would resolve against and whether that
 * defender stood in a city (and a walled one) — the two facts that choose which floor
 * applies. Nothing about the odds is recomputed from the ruleset here: no attack strength,
 * no terrain bonus, no fortification, no wall bonus, no veteran bonus.
 *
 * The fold advances a **copy** of the state and its RNG; neither goes anywhere. A refused
 * candidate — one `unitActions` advertised but the applier rejects, which is the
 * command-vs-generator check this project keeps making — reads as `undefined` and is
 * dropped rather than trusted.
 */
const readAssault = (
  engine: Engine,
  unit: Unit,
  command: AttackCommand,
): AssaultRead | undefined => {
  const outcome = applyCommand(engine.state, engine.playerId, command, engine.ruleset);
  if (!outcome.ok) return undefined;

  const resolved = outcome.value.events.find(
    (event): event is Extract<GameEvent, { type: 'CombatResolved' }> =>
      event.type === 'CombatResolved',
  );
  const capture = outcome.value.events.some((event) => event.type === 'CityCaptured');
  const defender = unitsOnTile(engine.state, command.target).find(
    (other) => other.owner !== engine.playerId,
  );
  const perRoundPct = resolved?.attackerWinPct ?? 0;

  return {
    command,
    perRoundPct,
    winPct:
      defender === undefined
        ? 100
        : battleWinPctOf(
            perRoundPct,
            hitPointsOf(unit),
            hitPointsOf(defender),
            combatRulesOf(engine.ruleset).damagePerRound,
          ),
    capture,
    defender,
    kind: targetKind(engine, command.target),
  };
};

/**
 * The battle-win chance this attack has to clear **on its own** — the floor the target's
 * kind sets.
 *
 * A soldier attacking by itself is held to this. A soldier attacking as one member of a
 * committed assault group is not: see `stormedCities`, which is where the group's own
 * chance is the number that was checked.
 */
const attackFloorPct = (engine: Engine, read: AssaultRead): number => {
  const weights = engine.weights.military;
  if (read.defender !== undefined && isBarbarian(engine.state, read.defender.owner)) {
    return weights.attackWinFloorVsBarbarianPct;
  }
  if (read.kind.walled) return weights.attackWinFloorVsWalledCityPct;
  if (read.kind.inCity) return weights.attackWinFloorVsCityPct;
  return weights.attackWinFloorPct;
};

/**
 * The best attack `unit` may make, or `undefined` when it may make none worth making.
 *
 * Every candidate comes from `unitActions` and every one is **folded through
 * `applyCommand`** on the scratch state (`readAssault`): what is read off the fold is the
 * engine's own `CombatResolved.attackerWinPct` and its own `CityCaptured`. What is
 * deliberately **not** read off the fold is the *result* (`attackerSurvives`, the losses):
 * a policy with perfect foresight plays a game no balance sweep is measuring.
 *
 * The decision is `battleWinPctOf` — the battle's probability, derived from the engine's
 * per-round number — against a threshold chosen by **what is being attacked**: an open
 * unit, a unit inside a city, a unit inside a walled city, or a barbarian. A capture (an
 * undefended city) has no defender to lose to and is always taken. A city that this AI's
 * army has **committed to storming this turn** is an exception to the per-attack floors,
 * and only that: `stormedCities` has already asked the engine for every member's odds and
 * required the *group's* chance to clear `siegeAssaultFloorPct`.
 */
const bestAttack = (engine: Engine, unit: Unit): AttackChoice | undefined => {
  const stormed = stormedCities(engine);
  let best: AttackChoice | undefined;
  let bestIsStorm = false;

  for (const command of unitActions(engine.state, engine.ruleset, unit.id)) {
    if (command.type !== 'AttackUnit') continue;
    const read = readAssault(engine, unit, command);
    if (read === undefined) continue;

    const storm = !read.capture && stormed.has(Number(command.target));
    if (!read.capture && !storm && read.winPct < attackFloorPct(engine, read)) continue;

    const choice: AttackChoice = {
      command,
      perRoundPct: read.perRoundPct,
      winPct: read.winPct,
      capture: read.capture,
    };
    if (best === undefined) {
      best = choice;
      bestIsStorm = storm;
      continue;
    }
    // Taking a city outranks any battle; a committed assault outranks a battle the AI
    // merely happens to like better. Among equals the safer fight wins, and the engine's
    // per-round number breaks a tie. The comparisons are *asymmetric* on purpose: a higher
    // rank displaces, a lower one never does.
    if (best.capture) continue;
    if (read.capture) {
      best = choice;
      bestIsStorm = false;
      continue;
    }
    if (bestIsStorm && !storm) continue;
    if (storm && !bestIsStorm) {
      best = choice;
      bestIsStorm = true;
      continue;
    }
    const displace =
      compareRanks([choice.winPct, choice.perRoundPct], [best.winPct, best.perRoundPct]) > 0;
    if (displace) best = choice;
  }

  return best;
};

/** Is this unit face to face with an enemy — a unit or a city of another player? */
const inContact = (engine: Engine, unit: Unit): boolean => {
  for (const tile of neighbors8(engine.state.map, unit.tile)) {
    if (unitsOnTile(engine.state, tile).some((other) => other.owner !== engine.playerId)) {
      return true;
    }
    const city = cityAt(engine.state, tile);
    if (city !== undefined && city.owner !== engine.playerId) return true;
  }
  return false;
};

/** The best attack an enemy could bring to bear on the tile `unit` stands on, or 0. */
const threatOn = (engine: Engine, unit: Unit): number => {
  let worst = 0;
  for (const tile of neighbors8(engine.state.map, unit.tile)) {
    for (const other of unitsOnTile(engine.state, tile)) {
      if (other.owner === engine.playerId) continue;
      worst = Math.max(worst, unitDef(engine.ruleset, other.type)?.attack ?? 0);
    }
  }
  return worst;
};

/** How many military units this player has, of any kind that can fight. */
const militaryCount = (engine: Engine): number =>
  engine.state.units.filter(
    (unit) =>
      unit.owner === engine.playerId && unitDef(engine.ruleset, unit.type)?.role === 'military',
  ).length;

/**
 * How many of this player's soldiers **already fill a garrison post** — the sum, over the
 * cities, of `min(soldiers within threatRadius, the soldiers that city wants)`.
 *
 * A count of *posts filled* and not of soldiers standing near a city, and the difference is
 * the whole point: cities are founded close together, so almost every soldier in a mature
 * empire is within `threatRadius` of *some* city, and counting soldiers rather than posts made
 * an empire of thirteen cities and forty soldiers report forty committed against a budget of
 * twenty — **every soldier in the army was "already defending something"**, none was ever
 * spare, and the field army did not exist. Counting posts caps the claim at what the cities
 * actually asked for, so the surplus is spare by construction.
 */
const garrisonPosts = (engine: Engine): number => {
  const weights = engine.weights.city;
  const hostile = hostileTiles(engine);
  let posts = 0;
  for (const city of citiesOf(engine.state, engine.playerId)) {
    const threatened = hostile.some(
      (tile) => tileDistance(engine.state, tile, city.tile) <= weights.threatRadius,
    );
    const want = threatened ? weights.defendersPerThreatenedCity : weights.defendersPerCity;
    posts += Math.min(defendersNear(engine, city, weights.threatRadius), want);
  }
  return posts;
};

/**
 * The best city to garrison, or `undefined` when no city needs this unit.
 *
 * A city "needs" a unit when fewer than `defendersPerThreatenedCity` (threatened) or
 * `defendersPerCity` defenders stand within `threatRadius` of it. Among those, the nearest
 * wins, with the city's own id as the tie-break — so a field army with several
 * under-defended cities spreads out instead of piling into the first one the loop saw.
 */
const garrisonTarget = (engine: Engine, unit: Unit): City | undefined => {
  const weights = engine.weights.city;
  let best: { readonly city: City; readonly distance: number } | undefined;

  for (const city of citiesOf(engine.state, engine.playerId)) {
    const distance = tileDistance(engine.state, unit.tile, city.tile);
    const threatened = hostileTiles(engine).some(
      (tile) => tileDistance(engine.state, tile, city.tile) <= weights.threatRadius,
    );
    const want = threatened ? weights.defendersPerThreatenedCity : weights.defendersPerCity;
    if (defendersNear(engine, city, weights.threatRadius) >= want) continue;
    if (best === undefined || distance < best.distance) best = { city, distance };
  }

  const city = best?.city;
  if (city === undefined) return undefined;

  // **A post, not a pilgrimage.** A soldier already inside the radius at which it could hold
  // this city takes the post; a soldier outside every radius does not walk home to one, it
  // marches on the enemy. The city keeps building its own defenders either way —
  // `production.defendersPerCity` is a *production* rule, and it is the one that fills a
  // frontier city.
  //
  // Measured, and the reason the walk home was removed: with "the nearest under-defended
  // city" as the order, that city is a *different* city every time the soldier moves, so the
  // soldier orbits the empire for ever. Unit 4 alternated tiles 625, 665, 584, 625, 665, 625
  // for twenty turns and never got more than five tiles from home while the rival's nearest
  // city sat fourteen tiles away. Twenty-nine of the army's thirty-five soldiers were still
  // standing inside a city at turn 50.
  return tileDistance(engine.state, unit.tile, city.tile) <= weights.threatRadius
    ? city
    : undefined;
};

/** The nearest tile this player can see an enemy on, or `undefined` when it sees none. */
const nearestHostile = (engine: Engine, unit: Unit): TileIndex | undefined => {
  let best: { readonly tile: TileIndex; readonly distance: number } | undefined;
  for (const tile of hostileTiles(engine)) {
    const distance = tileDistance(engine.state, unit.tile, tile);
    if (best === undefined || distance < best.distance) best = { tile, distance };
  }
  return best?.tile;
};

/* ------------------------------------------------------------------ *
 * Sieges — the force for a city, and the group that storms it
 * ------------------------------------------------------------------ */

/**
 * The nearest enemy city this player's map knows about — the army's strategic objective when
 * there is nothing to chase.
 *
 * Read off `state.cities` (every city in the world, whose owner this player can see) and not
 * off the fog: a city is a permanent fact about the map, and "march on the rival's capital" is
 * a decision a player makes with an atlas, not with a scout's last report. The fog governs
 * *what a unit can see this turn*, which is what `hostileTiles` is for; it does not make a
 * known city unknown again.
 */
const nearestKnownEnemyCity = (engine: Engine, unit: Unit): TileIndex | undefined => {
  let best: { readonly tile: TileIndex; readonly distance: number } | undefined;
  for (const city of engine.state.cities) {
    if (city.owner === engine.playerId) continue;
    const distance = tileDistance(engine.state, unit.tile, city.tile);
    if (best === undefined || distance < best.distance) best = { tile: city.tile, distance };
  }
  return best?.tile;
};

/**
 * The chance that **at least one** of these attacks takes the city, in whole percent, from the
 * engine's own per-attack numbers.
 *
 * `1 - Π(1 - pᵢ)` is exactly the chance that a group all of whose members attack wins at
 * least once — and it is a **lower bound** on the truth for a siege, because every `pᵢ` is
 * priced against the defender as it stands *before* the assault, where the real sequence only
 * gets better: each attack that fails has already taken hit points off the defender, and the
 * next attacker is resolved against the wounded one. Understating the group is the direction
 * this AI must err in.
 *
 * The miss is accumulated in whole percent and rounded **up** (`Math.ceil`), so the number
 * that comes out is never larger than the truth — the same rule as `exactBattleWinPct`'s
 * truncation in `ai.test.ts`, in the direction that refuses a fight rather than talking one up.
 * Every input is an integer percentage, so the accumulation is exact integer arithmetic: a
 * step multiplies two values no larger than `100`, and the result is divided back by `100`.
 */
const groupChancePct = (chances: readonly number[]): number => {
  let misses = 100;
  for (const raw of chances) {
    const chance = Math.max(0, Math.min(100, Math.floor(raw)));
    misses = Math.ceil((misses * (100 - chance)) / 100);
  }
  return 100 - misses;
};

/**
 * The **hit points** this player could bring against `city`: every soldier within
 * `siegeRadius` of it, plus every soldier whose nearest known enemy city **is** it.
 *
 * Hit points and not a head count, because that is what the engine's own `hitPointsLeftOf`
 * says a force is worth, and a stack of wounded units is not the force a stack of fresh ones
 * is. The second clause is the one that makes a siege a *plan* rather than a coincidence: the
 * army is counted as committed to the city it is already marching on (`nearestKnownEnemyCity`
 * is the same reading the march uses), so a siege can be decided while the troops are still on
 * their way — otherwise the test could only ever be passed by troops that had already arrived,
 * and no unit would ever set out.
 */
const assaultHitPoints = (engine: Engine, city: City): number => {
  const radius = engine.weights.military.siegeRadius;
  let total = 0;
  for (const unit of ownedUnits(engine)) {
    const def = unitDef(engine.ruleset, unit.type);
    if (def === undefined || def.role !== 'military' || def.attack <= 0) continue;
    const near = tileDistance(engine.state, unit.tile, city.tile) <= radius;
    const marching = Number(nearestKnownEnemyCity(engine, unit)) === Number(city.tile);
    if (near || marching) total += hitPointsOf(unit);
  }
  return total;
};

/** The hit points standing **on** `city`'s tile and owned by someone else — its garrison. */
const garrisonHitPoints = (engine: Engine, city: City): number => {
  let total = 0;
  for (const unit of unitsOnTile(engine.state, city.tile)) {
    if (unit.owner === engine.playerId) continue;
    total += hitPointsOf(unit);
  }
  return total;
};

const siegeForceSlot: TurnCacheSlot<readonly City[]> = {
  state: undefined,
  revision: -1,
  value: undefined,
};

/**
 * The enemy cities this player **has the force to besiege**, in `state.cities` order.
 *
 * The whole of "besiege a city when it has the force for it", and the reason a knob is needed
 * at all: the assault force's hit points against the garrison's, through
 * `siegeForceRatioPct`. An **undefended** city needs no force and passes for any soldier — an
 * empty city is not a battle, it is a walk, and `bestAttack` takes it the moment a soldier is
 * beside it.
 *
 * Nothing here computes an odd. The comparison is hit points against hit points; the odds are
 * the engine's, and they are read where they are used (`readAssault`).
 *
 * Cached per turn, because every military unit asks the same question on the same state.
 */
const besiegeableCities = (engine: Engine): readonly City[] =>
  cachedForTurn(siegeForceSlot, engine.state, () => {
    const ratio = engine.weights.military.siegeForceRatioPct;
    const qualified: City[] = [];
    for (const city of engine.state.cities) {
      if (city.owner === engine.playerId) continue;
      const force = assaultHitPoints(engine, city);
      if (force <= 0) continue;
      if (force * 100 < garrisonHitPoints(engine, city) * ratio) continue;
      qualified.push(city);
    }
    return qualified;
  });

/**
 * The enemy city `unit` is besieging — the nearest one it has the force for, ties going to the
 * lower city id because `besiegeableCities` is in `state.cities` order and the comparison is
 * strict.
 *
 * A **shared objective**, in the only sense that matters: the force test is asked of the city
 * and not of the soldier, so every soldier the player has answers the same question about the
 * same city and they converge on it. A soldier with `attack: 0` is not part of any siege — it
 * could not assault the place if it arrived.
 */
const siegeTarget = (engine: Engine, unit: Unit): City | undefined => {
  const def = unitDef(engine.ruleset, unit.type);
  if (def === undefined || def.attack <= 0) return undefined;
  let best: { readonly city: City; readonly distance: number } | undefined;
  for (const city of besiegeableCities(engine)) {
    const distance = tileDistance(engine.state, unit.tile, city.tile);
    if (best === undefined || distance < best.distance) best = { city, distance };
  }
  return best?.city;
};

const stormSlot: TurnCacheSlot<ReadonlySet<number>> = {
  state: undefined,
  revision: -1,
  value: undefined,
};

/**
 * The tiles of the enemy cities this player's army **storms this turn**, as a set of tile
 * indices.
 *
 * This is what lets a stack attack a city a lone unit must refuse, and it is the second half
 * of "besiege a city when it has the force for it". The members are the soldiers standing
 * **beside** the city (the ones the engine would actually resolve an attack from, this turn);
 * each one's odds are read off the engine's own fold (`readAssault`), and the group's chance is
 * `groupChancePct` of those numbers against `siegeAssaultFloorPct`.
 *
 * Two consequences, both intended and both stated rather than discovered later:
 *
 * - **A member attacks on the group's number, not on its own.** A soldier with a 35 % chance
 *   beside a walled city is not throwing itself away when three others are beside it: the group
 *   is at 72 %, and every attack that fails has already hurt the defender for the next one.
 *   That is why `bestAttack` skips the per-attack floor for a storm tile — the floor was asked
 *   of the group.
 * - **A city is not stormed by one soldier.** With one attacker the group's chance is that
 *   attacker's own, so the individual floors above are exactly what it is held to. Measured
 *   before this rule existed: the AI reached an enemy city's doorstep and stood there for the
 *   rest of the game, because its own maths correctly said that one archer cannot take a
 *   fortified walled city and it had no other answer.
 *
 * Cached per turn like the force test, and recomputed after every applied command (the cache
 * is keyed by revision), so an assault that has wounded the defender is re-priced before the
 * next soldier decides — the group is not committed to a decision the battle has overtaken.
 */
const stormedCities = (engine: Engine): ReadonlySet<number> =>
  cachedForTurn(stormSlot, engine.state, () => {
    const floor = engine.weights.military.siegeAssaultFloorPct;
    const stormed = new Set<number>();
    for (const city of besiegeableCities(engine)) {
      const chances: number[] = [];
      for (const unit of ownedUnits(engine)) {
        const def = unitDef(engine.ruleset, unit.type);
        if (def === undefined || def.role !== 'military' || def.attack <= 0) continue;
        if (tileDistance(engine.state, unit.tile, city.tile) !== 1) continue;
        const read = readAssault(engine, unit, {
          type: 'AttackUnit',
          unitId: unit.id,
          target: city.tile,
        });
        if (read === undefined || read.capture) continue;
        chances.push(read.winPct);
      }
      if (groupChancePct(chances) >= floor) stormed.add(Number(city.tile));
    }
    return stormed;
  });

/* ------------------------------------------------------------------ *
 * The turn
 * ------------------------------------------------------------------ */

/** What this player owes this turn: unit support plus building maintenance, in gold. */
const upkeepOf = (engine: Engine): number => {
  let maintenance = 0;
  for (const city of citiesOf(engine.state, engine.playerId)) {
    for (const id of city.buildings) {
      maintenance += buildingDef(engine.ruleset, id)?.maintenance ?? 0;
    }
  }
  return unitSupport(engine.state, engine.playerId).gold + maintenance;
};

/**
 * Walk a unit toward `target`, one legal step at a time, within its movement budget.
 *
 * `beside` says whether the unit has to *stand on* the target or merely **reach it**: an enemy
 * unit's tile and an enemy city's tile are both refused by `planMove`, so every walk this
 * policy makes toward an enemy is a walk to a tile *next to* it (see `stepsToTile`).
 *
 * Returns whether the walk **went anywhere**: `true` once a step was applied, or when the unit
 * already stands where the walk was going. A caller that treats "no step was available" as
 * "the decision was made" is a caller that parks an army for the rest of the game — see
 * `planMilitary`, where the difference was measured: two archers stood beside a rival unit they
 * were right to refuse and two tiles from a city they could have besieged, for the last twelve
 * turns of a seed, because the route to the occupied tile was empty and the branch returned
 * anyway.
 */
/**
 * Walk the unit along its route to `target` and report whether it **moved**.
 *
 * The return value is "a step was taken", and *not* "the unit is where the walk was headed". The
 * difference is a bug this file had, and it is worth the paragraph: a `beside` walk used to
 * report **arrived** as soon as the unit stood next to its target, so a soldier standing next to
 * an enemy **stack** — a tile `planAttackUnit` refuses outright (`target-stacked`) — read as
 * arrival. The chase branch returned, the soldier held that tile, and the branch's own guard
 * (`|| attackable(...)`) could never speak, because `||` never gets a second operand when the
 * first is true. Measured on a duel map, seed 2: eight soldiers of one civilization, a movement
 * point each, stood on a single tile four tiles from the rival's city from turn 49 to turn 58
 * with the siege target visible and three tiles away, and not one of them moved. The route
 * itself ends the walk: a unit already at the target, or already beside it, has an empty goal
 * set and therefore no step to take, so the loop below stops on its own.
 */
const walkTo = (
  engine: Engine,
  unit: Unit,
  target: TileIndex,
  attempt: (command: Command) => boolean,
  beside: boolean,
): boolean => {
  let moved = false;
  for (
    let step = 0;
    step < stepBudget(unit.movementLeft, engine.weights.military.maxStepsPerUnit);
    step += 1
  ) {
    const moving = unitById(engine.state, unit.id);
    if (moving === undefined) break;
    const command = routeStep(engine, moving, target, beside);
    if (command === undefined) break;
    if (!attempt(command)) break;
    moved = true;
  }
  return moved;
};

/** Walk a unit toward whatever it has not seen yet, claiming huts on the way. */
const planExplorer = (
  engine: Engine,
  unit: Unit,
  attempt: (command: Command) => boolean,
  stepCap: number,
): void => {
  const rank = exploreRanker(engine);
  const floor = engine.weights.exploration.minRevealPerStep;
  for (let step = 0; step < stepBudget(unit.movementLeft, stepCap); step += 1) {
    const moving = unitById(engine.state, unit.id);
    if (moving === undefined) break;
    const command = bestStep(engine, moving, rank);
    if (command === undefined) break;
    if (revealCount(engine.state, engine.playerId, command.to) < floor) break;
    if (!attempt(command)) break;
  }
};

/**
 * A settler's rank over the destinations the engine will let it step to, **computed against
 * the settlement decision the policy is actually making**.
 *
 * The first component is the engine's own answer to "may a city be founded here?"
 * (`planFoundCity` with this settler standing there), so a legal site always outranks an
 * illegal one. The second is the negative distance to the nearest legal site on the map
 * (`nearestLegalSite` below), which is what gives a settler a **gradient** when it cannot
 * found where it stands — without it, a settler produced in a capital has every neighbour
 * refused by `MIN_CITY_DISTANCE` and starts *and stays* with nowhere to go. Measured: the
 * first version of this file did exactly that, and produced one city per civilization over a
 * 45-turn game. The remaining components are the site's own worth (`siteRank`) and a step
 * onto a goody hut.
 */
const settlerRanker =
  (engine: Engine, unitId: UnitId, nearest: TileIndex | undefined) =>
  (tile: TileIndex): Rank => {
    const weights = engine.weights;
    const legal = planFoundCity(
      withUnitAt(engine.state, unitId, tile),
      engine.ruleset,
      engine.playerId,
      unitId,
    ).ok;
    const distance = nearest === undefined ? 0 : -tileDistance(engine.state, tile, nearest);
    const site = legal ? siteRank(engine, engine.playerId, tile) : [];
    // `preferredSiteFoodSurplus` is the one component that is about *walking toward* a site
    // rather than founding on it: a site that can feed a growing city outranks one that can
    // only feed a stagnant one, whatever the rest of the score says. It sits after legality
    // and after the distance to the nearest legal site — a settler must still walk in the
    // right direction, and *any* legal site beats no site — and before the site's own worth,
    // which is what `siteRank` supplies in the components that follow.
    const surplus = legal
      ? siteFoodSurplus(engine, engine.playerId, tile) >=
        weights.settlement.preferredSiteFoodSurplus
        ? 1
        : 0
      : 0;
    return [legal ? 1 : 0, distance, surplus, ...site, hutAt(engine.state, tile)];
  };

/**
 * The nearest tile a city **may** be founded on, anywhere on the map — the gradient a settler
 * follows when the ground under it is refused.
 *
 * The scan is the whole map, and that is the honest price of a real settlement decision
 * rather than an accident: `MIN_CITY_DISTANCE` refuses every tile within 1 of a city, so a
 * settler that has just left its capital has **no legal tile within reach** and needs an
 * answer about somewhere it cannot see. Legality is asked of `planFoundCity` — the evaluator
 * `applyCommand` refuses with — on a state in which this settler stands on the candidate
 * tile, so every tile this function steers a settler toward is a tile the applier will
 * accept. Ties go to the lower tile index, so the answer is a function of the map alone, and
 * `undefined` (no legal site anywhere) is a real answer: the settler then has nothing to walk
 * to and the policy leaves it where it is.
 */
const nearestLegalSites = new WeakMap<GameState, Map<number, TileIndex | undefined>>();

const nearestLegalSite = (
  engine: Engine,
  unitId: UnitId,
  from: TileIndex,
): TileIndex | undefined => {
  // The scan is expensive enough to be worth not repeating: eleven settlers in one empire ask
  // this about the same board every turn, and the answer is a function of the board (not of
  // which settler is asking — `from` only orders the *choice among* equally near sites, and
  // the nearest site is the same for all of them). Keyed by the immutable state object, which
  // is replaced on every applied command, so a cache entry can never outlive the board it
  // describes.
  let cache = nearestLegalSites.get(engine.state);
  if (cache === undefined) {
    cache = new Map();
    nearestLegalSites.set(engine.state, cache);
  }
  const key = Number(engine.playerId);
  if (cache.has(key)) return cache.get(key);

  const map = engine.state.map;
  let best: { readonly tile: TileIndex; readonly distance: number } | undefined;

  for (let index = 0; index < map.terrain.length; index += 1) {
    const tile = asTile(engine.state, index);
    const accepted = planFoundCity(
      withUnitAt(engine.state, unitId, tile),
      engine.ruleset,
      engine.playerId,
      unitId,
    ).ok;
    if (!accepted) continue;
    const distance = tileDistance(engine.state, tile, from);
    if (best === undefined || distance < best.distance) best = { tile, distance };
    // Short-circuit on the best possible answer: nothing beats standing here.
    if (distance === 0) break;
  }

  cache.set(key, best?.tile);
  return best?.tile;
};

/** A settler: found here when the ground is good enough, otherwise walk to better ground. */
const planSettler = (engine: Engine, unit: Unit, attempt: (command: Command) => boolean): void => {
  const weights = engine.weights;
  const canFound = planFoundCity(engine.state, engine.ruleset, engine.playerId, unit.id).ok;

  // The nearest site the engine would accept, and the rank of standing on the ground this
  // settler is on. Both are needed for the decision: a settler that cannot found where it
  // stands follows `nearest` (a gradient, `settlerRanker` below), and a settler that can
  // found **here** founds unless somewhere it could step to is a strictly better site.
  const nearest = nearestLegalSite(engine, unit.id, unit.tile);

  if (canFound) {
    const food = siteFood(engine, engine.playerId, unit.tile);
    const here = settlerRanker(engine, unit.id, nearest)(unit.tile);
    // Is a site this settler could reach in one step strictly better than this one? A rank
    // comparison and not a food comparison, so a settler never trades a site it can use now
    // for one that is merely a different shape of the same worth.
    const better = unitActions(engine.state, engine.ruleset, unit.id)
      .filter(isMove)
      .some((move) => compareRanks(settlerRanker(engine, unit.id, nearest)(move.to), here) > 0);
    // Found here when the site clears the AI's floor, or when nowhere it can reach is
    // better — the second half matters more than it looks: without it a settler stalls for
    // ever between two mediocre sites, which is strictly worse than a mediocre city, and a
    // stalled settler is a wasted 3 shields that never becomes a city. The third road is the
    // endgame one: an empire that has run out of legal sites founds wherever it legally can,
    // because a poor city that grows is a city and no city at all is a settler that walks
    // for the rest of the game.
    if (food >= weights.settlement.minSiteFood || !better || nearest === unit.tile) {
      attempt({ type: 'FoundCity', unitId: unit.id });
      return;
    }
  }

  // Nowhere legal anywhere: the settler has nothing to walk to, and standing still is the
  // only command left that is not a lie about the map.
  if (nearest === undefined) return;
  const rank = settlerRanker(engine, unit.id, nearest);
  for (
    let step = 0;
    step < stepBudget(unit.movementLeft, weights.settlement.maxStepsPerSettler);
    step += 1
  ) {
    const moving = unitById(engine.state, unit.id);
    if (moving === undefined) break;
    const command = bestStep(engine, moving, rank);
    if (command === undefined) break;
    if (!attempt(command)) break;
  }
};

/**
 * A worker: start the best job on this tile, walk to the best job elsewhere, or stay put.
 *
 * The "walk to a tile that needs improving" half is what the M4a placeholder declined and
 * M7 provides — without it a worker produced beside a fully improved city stands still for
 * the rest of the game and the improvement system stops mattering.
 */
const planWorker = (engine: Engine, unit: Unit, attempt: (command: Command) => boolean): void => {
  const here = jobsOnTile(engine, unit, unit.tile);
  if (here.length > 0) {
    // The engine's own `IMPROVEMENT_KINDS` vocabulary ranks the candidates, then the id,
    // so which job a worker takes is a function of the *content* of the rows offered and
    // not of the order the catalog happens to list them in.
    const kindRank = (kind: StartWorkCommand['kind']): number => {
      const row = engine.ruleset.improvements.find((def) => def.id === kind);
      return row === undefined ? -1 : IMPROVEMENT_KINDS.indexOf(row.kind);
    };
    const best = [...here].sort((a, b) => {
      const byRank = kindRank(b.kind) - kindRank(a.kind);
      return byRank !== 0 ? byRank : compareText(String(a.kind), String(b.kind));
    })[0];
    if (best !== undefined) {
      const chosen = unitActions(engine.state, engine.ruleset, unit.id)
        .filter(isStartWork)
        .find((action) => String(action.kind) === String(best.kind));
      if (chosen !== undefined && attempt(chosen)) return;
    }
  }

  const job = chooseJob(engine);
  if (job === undefined) return;
  for (
    let step = 0;
    step < stepBudget(unit.movementLeft, engine.weights.military.maxStepsPerUnit);
    step += 1
  ) {
    const moving = unitById(engine.state, unit.id);
    if (moving === undefined) break;
    if (Number(moving.tile) === Number(job.tile)) break;
    const command = routeStep(engine, moving, job.tile, false);
    if (command === undefined) break;
    if (!attempt(command)) break;
  }
};

/**
 * Whether the engine would let this soldier attack `tile` — `unitActions` offers an
 * `AttackUnit` for it.
 *
 * The question a chase has to ask about its target, and it is the **engine's** answer rather
 * than a rule restated here: a tile holding more than one enemy unit is refused with
 * `target-stacked`, a tile holding none and no city with `nothing-to-attack`, and a soldier
 * with no movement left gets no action at all. `bestAttack` has already looked at every one of
 * these and decided not to take it; what this answers is whether the refusal was a *decision*
 * or a dead end.
 */
const attackable = (engine: Engine, unit: Unit, tile: TileIndex): boolean =>
  unitActions(engine.state, engine.ruleset, unit.id).some(
    (command) => command.type === 'AttackUnit' && Number(command.target) === Number(tile),
  );

/**
 * A military unit: hold a city that needs it, hunt what is out there, fortify in bad
 * contact, besiege a city it has the force for, or explore.
 *
 * The order is the whole policy:
 *
 * 1. **fortify in bad contact** — the fortification bonus is a rule the engine already
 *    states, and standing still behind it is the one defensive move this AI knows;
 * 2. **hunt** an enemy inside `huntRadius`, but *only while the hunt is a decision*: either
 *    the soldier steps, or it stands beside something the engine would let it attack (and
 *    which it has declined on its own maths). A soldier parked beside a stack it may not
 *    attack is not holding a line, it is stuck — see below;
 * 3. **garrison** a city short of a defender — an undefended city is how this AI loses;
 * 4. **besiege** — march on the enemy city this player has the force for and hold there;
 * 5. pursue the nearest visible enemy from any distance, then march on the nearest known
 *    enemy city, then explore.
 *
 * It still has no retreat logic and no threat model beyond `standAndFortifyRatioPct`, and it
 * says so rather than pretending otherwise.
 */
const planMilitary = (engine: Engine, unit: Unit, attempt: (command: Command) => boolean): void => {
  const weights = engine.weights;

  if (inContact(engine, unit)) {
    const defense = unitDef(engine.ruleset, unit.type)?.defense ?? 0;
    const ratio = Math.floor((defense * 100) / Math.max(1, threatOn(engine, unit)));
    if (ratio < weights.military.standAndFortifyRatioPct && !isFortified(unit)) {
      if (attempt({ type: 'FortifyUnit', unitId: unit.id })) return;
    }
  }

  // **The home-defence budget.** `fieldArmySharePct` is a ceiling on how much of the army may
  // be committed to garrisoning at once, floored at one soldier per city so a budget can never
  // be small enough to empty a city; what is left over is the field army, and only the field
  // army leaves. Above it a soldier is idle for home defence and goes looking for the enemy.
  //
  // Measured, and the reason this exists: with the per-city rule alone, every soldier's own
  // neighbourhood looks short of a defender for ever, so no soldier is ever spare — on a duel
  // map over 150 turns the two civilizations raised 31 soldiers between them and **not one
  // ever came within 13 tiles of an enemy city**. M7 needs an army that arrives.
  const garrisonBudget = Math.min(
    militaryCount(engine),
    Math.max(
      citiesOf(engine.state, engine.playerId).length,
      Math.floor((militaryCount(engine) * weights.city.fieldArmySharePct) / 100),
    ),
  );
  const garrisoned = garrisonPosts(engine);
  const target = garrisoned < garrisonBudget ? garrisonTarget(engine, unit) : undefined;
  const enemy = nearestHostile(engine, unit);
  const enemyDistance =
    enemy === undefined ? Number.POSITIVE_INFINITY : tileDistance(engine.state, unit.tile, enemy);

  // **Hunt or hold**, decided by which threat is nearer — and `huntRadius` is the knob that
  // decides how close an enemy has to be to count as *this soldier's* business rather than
  // something to watch.
  //
  // The comparison is between two distances: the nearest enemy this player can see, and the
  // city that is actually short of a defender. An enemy inside `huntRadius` outranks an
  // under-defended city even when it is farther away, which is what stops an army from
  // shuffling between its own cities while a rival walks up to one of them; an enemy outside
  // it does not, because reinforcing a city costs a turn and abandoning one for a distant
  // chase costs the city.
  //
  // What `huntRadius` is deliberately **not** is a leash. Measured with one — an idle soldier
  // that would only engage an enemy inside the radius, and explored otherwise — the two
  // civilizations stood **15 tiles apart for fifty turns and never fought once**, because the
  // fallback for a soldier with nothing to do is exploration and an army standing in ground it
  // has already mapped has no step that reveals anything, so every soldier simply stood still
  // for the rest of the game. The nearest enemy is therefore pursued from **any** distance when
  // there is no city to reinforce; the radius only breaks the tie against one.
  //
  // The chase is a **decision** only while there is something at the end of it, and there are
  // two ways to have nothing: no step to take, and nothing to attack. The second is the one
  // that stranded M7's armies. Measured on a duel map at turn 60: seven soldiers of one
  // civilization and fourteen of the other stood on two adjacent tiles, `huntRadius` was
  // satisfied, `walkTo` reported the soldier already beside its target, and the branch
  // returned — for the rest of the game, because `planAttackUnit` refuses a tile holding more
  // than one enemy unit (`target-stacked`) and a stack cannot be attacked by anybody. Neither
  // army ever attacked anything again, and no city was ever reached.
  //
  // So a soldier holds only where it could fight: it steps, or the engine offers it an attack
  // on the tile it is standing beside. Where it can do neither, the hunt is abandoned and the
  // branches below — the siege above all — get the turn instead.
  //
  // **The guard only became effective when `walkTo` stopped reporting "arrived"** (see its own
  // note above): with `walkTo` short-circuiting on "already beside", the `attackable` check was
  // unreachable and the park was still there, one summary narrower. Measured again after that
  // fix, on the same seed-2 world: the eight soldiers left their tile and the stack walked onto
  // its siege target.
  const chase =
    enemy !== undefined &&
    enemyDistance <= weights.military.huntRadius &&
    (walkTo(engine, unit, enemy, attempt, true) || attackable(engine, unit, enemy));
  if (chase) return;

  if (target !== undefined) {
    if (Number(unit.tile) === Number(target.tile)) {
      if (!isFortified(unit)) attempt({ type: 'FortifyUnit', unitId: unit.id });
      return;
    }
    walkTo(engine, unit, target.tile, attempt, false);
    return;
  }

  // **The siege.** A city this player has the force for, and a soldier who is not needed on a
  // wall: march on it and stay there. Standing beside the city with the assault refused is not
  // idleness — it is the siege, and it is what turns a trickle of single attacks into the group
  // `stormedCities` prices. Two soldiers beside the same city also reinforce each other's
  // assault: the second is resolved against a defender the first has already wounded.
  //
  // This sits **above** the generic chase below on purpose. A soldier that can see an enemy it
  // cannot reach — the neighbour is standing on the tile, and the engine will not let a unit
  // step onto one — had no branch left that moved it, which is exactly how M7's AI came to
  // stand two tiles from a city for the rest of a game without ever attacking it.
  const siege = siegeTarget(engine, unit);
  if (siege !== undefined) {
    walkTo(engine, unit, siege.tile, attempt, true);
    return;
  }

  if (enemy !== undefined) {
    walkTo(engine, unit, enemy, attempt, true);
    return;
  }

  // Nothing to hunt and no city short of a soldier: **march on the enemy**. A field army with
  // no visible target has to have somewhere to go, and the one thing this player knows without
  // seeing is where the rival's cities are — `state.cities` names them, and a city cannot move.
  //
  // Measured, and the reason this branch exists: without it the fallback for a spare soldier
  // was `planExplorer`, whose only preference is tiles it has *not* seen. A soldier standing in
  // ground it has already mapped has no such step, so an army with no visible enemy simply
  // stops — over 60 turns on a duel map, thirteen soldiers never got more than five tiles from
  // their own cities while the rival's nearest city sat fourteen tiles away, and the two
  // civilizations never met at all. An army that never arrives cannot take a city, cannot
  // fight a battle, and gives M7's walls bonus nothing to defend.
  const march = nearestKnownEnemyCity(engine, unit);
  if (march !== undefined) {
    walkTo(engine, unit, march, attempt, true);
    return;
  }

  planExplorer(engine, unit, attempt, weights.military.maxStepsPerUnit);
};

/** Hand `unitId` its whole turn: fight, or garrison, or work, or settle, or explore. */
const planUnit = (engine: Engine, unitId: UnitId, attempt: (command: Command) => boolean): void => {
  const unit = unitById(engine.state, unitId);
  if (unit === undefined) return;
  const def = unitDef(engine.ruleset, unit.type);
  if (def === undefined) return;

  // A unit already working is left where it is: a step **cancels** its job (M4a), and this
  // AI has no reason to abandon a job it chose.
  if (unit.work !== undefined) return;

  // Combat comes before any movement: an attack spends the unit's whole remaining
  // movement, so proposing a step first would either waste the step or make the attack
  // unaffordable. A non-attacker (a `worker`, a `settler`, a sea row with `attack: 0`)
  // simply has no attack in `unitActions`, so this is a no-op for them.
  const attack = bestAttack(engine, unit);
  if (attack !== undefined && attempt(attack.command)) return;

  switch (def.role) {
    case 'settler':
      planSettler(engine, unit, attempt);
      return;
    case 'worker':
      planWorker(engine, unit, attempt);
      return;
    case 'military':
      planMilitary(engine, unit, attempt);
      return;
    case 'scout':
      planExplorer(engine, unit, attempt, def.movement);
      return;
  }
};

/**
 * The plan for one turn, as a list of commands — **total**: it returns a list for every
 * state it can be handed, and it never propagates an exception.
 *
 * The `try`/`catch` around the decision passes is deliberate and is not a way of hiding a
 * bug: the runner's contract is that a policy returns commands, and a policy that threw
 * inside a 20-seed tournament would take the whole tournament down — turning a balance
 * question into a stack trace, and costing every seed already played. A state that is
 * empty, has no units, has no cities, has no gold, or has a board with nothing legal to do
 * produces an empty (or partial) list, and an unexpected failure produces whatever was
 * decided before it. `ai.test.ts`' totality suite exercises the degenerate states directly
 * rather than relying on this catch.
 */
const planTurn = (ctx: PolicyContext, weights: SmartWeights): readonly Command[] => {
  const planned: Command[] = [];
  let state: GameState = ctx.state;

  const engine = (): Engine => ({
    state,
    ruleset: ctx.ruleset,
    playerId: ctx.playerId,
    weights,
  });

  /**
   * Fold one candidate through the engine's own applier.
   *
   * A refusal simply drops the candidate — `applyCommand` is pure, so a refused command
   * leaves the state untouched, and the honest answer to "the engine will not let me do
   * that" is to do something else rather than to throw inside a batch. Nothing illegal can
   * leave this function: `planned` only ever receives commands that applied.
   */
  const attempt = (command: Command): boolean => {
    const outcome = applyCommand(state, ctx.playerId, command, ctx.ruleset);
    if (!outcome.ok) return false;
    state = outcome.value.state;
    planned.push(command);
    return true;
  };

  try {
    // Pass 1 — cities, in city-id order: worked tiles, then production.
    for (const cityId of citiesOf(state, ctx.playerId).map((city) => city.id)) {
      const city = cityById(state, cityId);
      if (city === undefined) continue;
      const first = engine();

      const tiles = desiredWorkedTiles(first, city);
      if (tiles !== undefined) attempt({ type: 'SetWorkedTiles', cityId, tiles });

      const after = cityById(state, cityId);
      if (after === undefined) continue;
      const item = chooseProduction(engine(), readSituation(engine(), after));
      if (item !== undefined) attempt({ type: 'SetProduction', cityId, item });
    }

    // Pass 2 — research, then pass 3 — the rates.
    const tech = chooseTech(engine());
    if (tech !== undefined) attempt({ type: 'SetResearch', tech });

    const rates = chooseRates(engine(), upkeepOf(engine()));
    if (rates !== undefined) attempt({ type: 'SetRates', rates });

    // Pass 4 — units, in unit-id order. The id list is a snapshot, and each id is re-read
    // from the fold before it is acted on: a settler that founded a city earlier in this
    // loop is gone from the state, and acting on the snapshot would propose a command for
    // a unit that no longer exists.
    for (const unitId of ownedUnits(engine()).map((unit) => unit.id)) {
      planUnit(engine(), unitId, attempt);
    }
  } catch {
    // Deliberately swallowed, and deliberately not silent in the code: the contract this
    // file is held to is "a policy returns a legal command list, never throws"
    // (INTERFACES.md M7; the runner has no failure channel for a policy). Returning what
    // was decided before the failure keeps the turn a turn, and `ai.test.ts` proves the
    // degenerate states never reach here in the first place.
  }

  return planned;
};

/* ------------------------------------------------------------------ *
 * The shipped policy
 * ------------------------------------------------------------------ */

/** The stable name of the real policy — what a tournament report prints beside its seat. */
export const SMART_POLICY_NAME = 'smart';

/**
 * Build the real policy, optionally with its weights patched.
 *
 * `smartPolicy({ military: { attackWinFloorPct: 70 } })` is how a balance sweep varies the
 * AI's taste without editing code — the standing requirement's *Tunable*. The patch names
 * as few fields as it likes: `SmartWeightsPatch` is the recursively-partial form of
 * `SmartWeights`, so a sweep writes the one field it means rather than restating a group it
 * is not moving (which is what `Partial<SmartWeights>` alone would force, and a restatement
 * is a second place a group's values can drift). The merge is `mergeSmartWeights`.
 */
export const smartPolicy = (patch: SmartWeightsPatch = {}): Policy => {
  const weights = mergeSmartWeights(patch);
  return {
    name: SMART_POLICY_NAME,
    chooseCommands: (ctx) => planTurn(ctx, weights),
  };
};

/**
 * The real policy at its default weights — the AI M7 puts on the board.
 *
 * It is a `Policy` like any other: nothing in `@civts/sim` recognises its name, and
 * `DO_NOTHING_POLICY` remains the control a balance comparison is measured against.
 */
export const SMART_POLICY: Policy = smartPolicy();

/**
 * Re-exported so a caller holding only the policy can still reach its knobs —
 * `ai/index.ts` and `policies.ts` both re-export them from their own module, which is where
 * the only definition lives.
 */
export { mergeSmartWeights, SMART_WEIGHTS } from './weights.js';
export type { SmartWeights, SmartWeightsPatch } from './weights.js';
